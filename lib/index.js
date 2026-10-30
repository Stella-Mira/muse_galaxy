/**
 * muse_galaxy —— muse_vtuber 的采集器（DSH 的输入侧）
 *
 * 一句话：把「视频/音频文件、网络资源、直播流」解码成 JPEG 帧与 16k PCM，推给 muse_vtuber 的
 * 采集口；取帧策略、断句阈值、识别、限流、插话**全在 vtuber**，这里只负责取流与搬运。
 *
 * 为什么是这个形状（任务书 muse_galaxy 一节）：
 *   · 消费者只有 muse_vtuber 一个 → 不需要 mediamtx 做本机 RTSP 汇聚，也不需要 websockets；
 *   · 旧实现（muse_galaxy_watch / muse_galaxy_bili_live + galaxy 云网关）已删除，改为适配器模型：
 *       galaxy_<mode>[_<platform>]，mode = path（一次性资源，播完即停、不循环）| rtsp（长连接直播）。
 *
 * 平台分工（2026-10-30 交接文档）：
 *   · mira_bilibili 管后台：登录态、私信、弹幕、直播事件；
 *   · muse_galaxy（本插件）管流：视频 URL / 直播间号 → ffmpeg 能吃的直链；
 *   · muse_vtuber 管感知与表达：看到什么、听到什么、说出来。
 *
 * 只依赖 node: 内置模块 + 本机 ffmpeg / yt-dlp 可执行文件。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import {
  getLiveStreamUrls,
  normalizeVideoInput,
  readCredentials,
  removeCookiesFile,
  resolveRoom,
  writeNetscapeCookies,
} from './bilibili.js'
import { httpHeadersFor, probeLiveUrl, resolveSource, startAudio, startVideo } from './media.js'
import { VtuberCapture, dshHome } from './vtuber.js'

export const name = 'muse_galaxy'
export const inject = ['tools']

const DEFAULTS = {
  enabled: true,
  // 采集口地址与令牌（令牌由 muse_vtuber 生成）
  vtuber: {
    baseUrl: 'http://127.0.0.1:3080',
    tokenFile: '',
    timeoutMs: 20000,
  },
  media: {
    ffmpeg: 'ffmpeg',
    ytdlp: 'yt-dlp',
    // 送 vtuber 的音频采样率（它默认 mic.sampleRate=16000）
    sampleRate: 16000,
    chunkMs: 200,
  },
  // B 站（P1/P2）用的登录态：直接读 mira_account 的凭据文件，不复制、不缓存
  bili: {
    accountId: 'bili-main',
    credsFile: '', // 留空 = $DSH_HOME/mira_config/mira_account/creds/<accountId>.json
    maxReconnects: 8, // 直播断流最多重连几次（用尽就收尾）
    reconnectDelayMs: 800, // 退避基数：第 n 次等 n * 这个值（封顶 3 倍，上限 30s）
    probeCandidates: 6, // 开播前探测几个候选节点（B 站 CDN 随机 403，挑到能出帧的再开）
  },
  // 单路采集的硬上限（秒）：path 播完会自己停，这个只防直播忘关
  maxSeconds: 3600,
}

let cfg = structuredClone(DEFAULTS)
let loggerRef = null

/* ── 采集任务表 ───────────────────────────────────────────── */

const streams = new Map() // streamId -> stream
let seq = 0

function nextId(prefix) {
  seq += 1
  return prefix + '-' + Date.now().toString(36) + '-' + seq
}

function log(msg) {
  loggerRef?.info?.('[muse_galaxy] ' + msg)
}

/* ── 工具注册的小工具 ─────────────────────────────────────── */

function textTool(name, description, parameters, execute) {
  return {
    name,
    description,
    parameters,
    // 输出是 JSON **文本**：schema 声明 string，execute 里统一 stringify
    // （照 muse_vtuber 的 kit.textTool/runTool 做法；直接返回对象会被宿主的 schema 校验打回）
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
    },
    async execute(args, exec) {
      try {
        const value = await execute(args ?? {}, exec)
        return typeof value === 'string' ? value : JSON.stringify(value ?? { ok: true }, null, 2)
      } catch (error) {
        return JSON.stringify({
          ok: false,
          error: {
            code: (error && error.code) || 'galaxy/failed',
            message: error && error.message ? error.message : String(error),
            hint: (error && error.hint) || '看 dsh 日志里 [muse_galaxy] 开头的行',
          },
        }, null, 2)
      }
    },
  }
}

const obj = (properties, required = []) => ({ type: 'object', properties, required })
const str = (description) => ({ type: 'string', description })
const num = (description) => ({ type: 'number', description })
const bool = (description) => ({ type: 'boolean', description })

function sessionIdOf(exec) {
  const agent = exec && exec.agent
  return agent && agent.session && agent.session.id ? String(agent.session.id) : ''
}

/* ── B 站凭据（只读 mira_account 的，不复制） ───────────────── */

function biliCredentials() {
  const accountId = String((cfg.bili && cfg.bili.accountId) || 'bili-main')
  const file = String((cfg.bili && cfg.bili.credsFile) || '').trim()
    || join(dshHome(), 'mira_config', 'mira_account', 'creds', accountId + '.json')
  return readCredentials(file)
}

/** 把凭据转成 yt-dlp 的 cookies 文件；读不到就返回空串（退回匿名，调用方自己提示）。 */
function biliCookiesFile(tag) {
  const creds = biliCredentials()
  if (!creds.ok) return { file: '', note: '未读到 B 站登录态（' + creds.error + '），按匿名播' }
  try {
    return { file: writeNetscapeCookies(creds.cookies, tag), note: '已用 mira_account 的登录态' }
  } catch (error) {
    return { file: '', note: 'cookie 文件写不出来（' + (error && error.message) + '），按匿名播' }
  }
}

/* ── 一路采集的核心流程 ───────────────────────────────────── */

/**
 * 起一路采集。
 * @param {object} options
 * @param {'path'|'rtsp'} options.mode
 * @param {string} options.source
 * @param {string} [options.label]
 * @param {unknown} options.exec
 * @param {boolean} [options.audio]
 * @param {number} [options.fps]
 * @param {number} [options.width]
 * @param {string} [options.cookies]         yt-dlp --cookies 用的临时文件（path 模式）
 * @param {boolean} [options.reconnect]      断流时重连（直播用）
 * @param {() => Promise<{videoSource:string, audioSource?:string}>} [options.reconnectResolver]
 * @param {object} [options.extra]           附加信息（candidates / bili 元数据）
 */
async function startCapture({ mode, source, label, exec, audio, fps, width, cookies, reconnect, reconnectResolver, extra }) {
  const raw = String(source || '').trim()
  if (raw === '') {
    throw Object.assign(new Error('source 不能为空'), {
      code: 'payload/invalid',
      hint: '给本地文件绝对路径 / http(s) 链接 / 直播流地址',
    })
  }

  const modeName = mode === 'rtsp' ? 'rtsp' : 'path'
  const stream = {
    id: nextId('galaxy'),
    mode: modeName,
    source: raw,
    label: String(label || '').trim(),
    sessionId: sessionIdOf(exec),
    startedAt: Date.now(),
    endedAt: 0,
    status: 'starting',
    endReason: '',
    capture: new VtuberCapture({
      baseUrl: cfg.vtuber.baseUrl,
      tokenFile: cfg.vtuber.tokenFile,
      timeoutMs: cfg.vtuber.timeoutMs,
      logger: loggerRef,
    }),
    stats: { framesSent: 0, framesDropped: 0, pcmChunks: 0, lastError: null },
    video: null,
    audio: null,
    want: null,
    reconnects: 0,
    reconnect: reconnect === true && typeof reconnectResolver === 'function',
    reconnectResolver: typeof reconnectResolver === 'function' ? reconnectResolver : null,
    candidates: extra && Array.isArray(extra.candidates) ? extra.candidates.slice() : null,
    bili: (extra && extra.bili) || null,
  }
  streams.set(stream.id, stream)

  // 1) 一次性资源先过 yt-dlp 拿直链（直播流交给 ffmpeg 自己处理）。
  //    DASH 站点的音视频是两条地址，所以分别取：video 给画面解码器、audio 给声音解码器。
  let videoSource = raw
  let audioSource = raw
  if (modeName === 'path') {
    const out = await resolveSource(raw, { ytdlp: cfg.media.ytdlp, cookies })
    videoSource = out.video || raw
    audioSource = out.audio || videoSource
    stream.viaYtdlp = out.viaYtdlp === true
    stream.splitSource = out.split === true
    if (out.note) log('yt-dlp 未给出直链，直接交给 ffmpeg：' + out.note)
  }
  stream.resolved = videoSource

  // 2) 注册到 vtuber 采集口（want 由它给：帧率 / 宽度 / 要不要音频）
  const opened = await stream.capture.open({
    label: stream.label || raw,
    source: modeName + ':' + raw,
    sessionId: stream.sessionId,
    ...(fps ? { fps } : {}),
    ...(width ? { width } : {}),
    ...(audio === undefined ? {} : { audio }),
  })
  const want = opened.want || { fps: 4, width: 480, audio: true }
  stream.captureId = opened.captureId
  stream.want = want
  stream.status = 'running'

  attachDecoders(stream, { videoSource, audioSource })

  // 5) 超时保护（直播忘关）
  const limitMs = Math.max(10, Number(cfg.maxSeconds) || 3600) * 1000
  stream.timer = setTimeout(() => stopStream(stream, 'max-seconds'), limitMs)
  stream.timer.unref?.()

  log('开始采集 ' + stream.id + '（' + modeName + '，' + raw + '，' + want.fps + 'fps/' + want.width + 'px，音频'
    + (want.audio === false ? '关' : '开') + (stream.reconnect ? '，断流重连开' : '') + '）')
  return stream
}

/**
 * 挂上解码器（画面 + 声音），并处理「结束」：直播且开了重连时先重连，否则收尾。
 * 重连时**不关闭 vtuber 采集口**，所以会话里的采集态是连续的。
 */
function attachDecoders(stream, { videoSource, audioSource }) {
  const want = stream.want || { fps: 4, width: 480, audio: true }

  // 画面：JPEG → capture/frame。
  // ffmpeg 往管道里写帧是**成簇**的（同一次 data 事件里可能带好几帧），
  // 所以这里用队列串行送，只在队列真满时丢最旧的。
  // 队列深度按帧率给：8fps 时 8 帧只有 1 秒缓冲，成簇一冲就丢（实测 51 帧丢 9）；
  // 给到 32 帧（8fps 约 4 秒）后基本不丢。
  const maxQueue = 32
  const queue = []
  let pushing = false
  const pump = async () => {
    if (pushing) return
    pushing = true
    try {
      while (queue.length) {
        // 已经收尾（播完/被停/出错）就别再推了：此时 captureId 已清空，
        // 硬推只会得到 "还没 open 就推帧" 的假错误，把 status 弄脏。
        if (stream.status !== 'running') { queue.length = 0; return }
        const jpeg = queue.shift()
        try {
          await stream.capture.frame(jpeg)
          stream.stats.framesSent += 1
        } catch (error) {
          const code = (error && error.code) || 'galaxy/failed'
          if (code !== 'capture/not-found') {
            stream.stats.lastError = { code, message: error && error.message, at: Date.now() }
          }
          if (isFatal(error)) {
            stopStream(stream, 'capture-error')
            return
          }
        }
      }
    } finally {
      pushing = false
    }
  }

  stream.video = startVideo({
    source: videoSource,
    fps: want.fps,
    width: want.width,
    realtime: true, // 按源的自然速度播放：path 播完即停、rtsp 本来就是直播
    ffmpeg: cfg.media.ffmpeg,
    ...httpHeadersFor(videoSource),
    onFrame: (jpeg) => {
      if (queue.length >= maxQueue) {
        queue.shift()
        stream.stats.framesDropped += 1
      }
      queue.push(jpeg)
      void pump()
    },
    onLog: (line) => loggerRef?.debug?.('[muse_galaxy] ffmpeg(video): ' + line),
  })

  // 声音：16k PCM → capture/pcm（断句在 vtuber）
  stream.audio = null
  if (want.audio !== false) {
    stream.audio = startAudio({
      source: audioSource,
      sampleRate: Number(cfg.media.sampleRate) || 16000,
      chunkMs: Number(cfg.media.chunkMs) || 200,
      realtime: true,
      ffmpeg: cfg.media.ffmpeg,
      ...httpHeadersFor(audioSource),
      onChunk: (chunk) => {
        if (stream.status !== 'running') return // 收尾之后不再推（同上，避免假错误）
        stream.capture.pcm(chunk, cfg.media.sampleRate).then(
          () => { stream.stats.pcmChunks += 1 },
          (error) => {
            const code = (error && error.code) || 'galaxy/failed'
            if (code !== 'capture/not-found') {
              stream.stats.lastError = { code, message: error && error.message, at: Date.now() }
            }
            if (isFatal(error)) stopStream(stream, 'capture-error')
          },
        )
      },
      onLog: (line) => loggerRef?.debug?.('[muse_galaxy] ffmpeg(audio): ' + line),
    })
  }

  // 解码器都结束 → 直播先试重连，否则收尾
  const finishes = [stream.video.done]
  if (stream.audio) finishes.push(stream.audio.done)
  void Promise.all(finishes).then(async (results) => {
    const videoRes = results[0]
    const audioRes = results[1]
    // 只有**画面**解码失败才算整路失败。没有音轨/音频解码失败只降级成"没声音"，
    // 否则一个静音视频会一开就停（真机上就是这么被发现的）。
    // 注意：被我们 kill 掉的进程 code 是 null（不是非 0），那不算失败。
    const exitedBadly = (r) => !!r && typeof r.code === 'number' && r.code !== 0
    if (exitedBadly(audioRes)) {
      stream.stats.audioError = String(audioRes.stderr || ('音频解码退出 ' + audioRes.code)).slice(-300)
      log('音频解码失败（按"没有声音"继续）：' + stream.stats.audioError)
    }
    const videoBad = exitedBadly(videoRes)
    if (videoBad && stream.status === 'running') {
      stream.stats.lastError = {
        code: 'stream/exited',
        message: String(videoRes.stderr || ('ffmpeg 退出码 ' + videoRes.code)).slice(0, 300),
        at: Date.now(),
      }
    }
    const reason = videoBad ? 'stream-error' : 'source-ended'
    if (stream.reconnect && stream.reconnectResolver && stream.status === 'running') {
      return scheduleReconnect(stream, reason)
    }
    await finish(stream, reason)
  })
}

/** 直播断流：退避后重新解析地址并重新挂解码器；次数用尽或用户主动停才收尾。 */
async function scheduleReconnect(stream, reason) {
  if (!stream || stream.endedAt || stream.status !== 'running') return
  const max = Math.max(1, Number(cfg.bili.maxReconnects) || 8)
  if (stream.reconnects >= max) {
    log('重连次数用尽（' + max + ' 次），收尾')
    return finish(stream, 'stream-lost')
  }
  stream.reconnects += 1
  stream.status = 'reconnecting'
  stream.lastReconnect = { at: Date.now(), reason, attempt: stream.reconnects, of: max }
  const wait = Math.min(30000, Math.max(500, Number(cfg.bili.reconnectDelayMs) || 800) * Math.min(stream.reconnects, 3))
  log('第 ' + stream.reconnects + '/' + max + ' 次重连（' + reason + '），' + wait + 'ms 后重试')
  await new Promise((resolve) => { const t = setTimeout(resolve, wait); t.unref?.() })
  if (stream.status !== 'reconnecting') return // 期间被 galaxy_stop 停了

  let next
  try {
    next = await stream.reconnectResolver()
  } catch (error) {
    log('重连解析失败：' + (error && error.message ? error.message : String(error)))
    stream.status = 'running' // 回到 running 才能再走一轮 scheduleReconnect
    return scheduleReconnect(stream, 'reconnect-failed')
  }
  if (!next || !next.videoSource) {
    stream.status = 'running'
    return scheduleReconnect(stream, 'reconnect-empty')
  }
  stream.resolved = next.videoSource
  stream.status = 'running'
  log('重连成功，换源：' + String(next.videoSource).slice(0, 120))
  attachDecoders(stream, {
    videoSource: next.videoSource,
    audioSource: next.audioSource || next.videoSource,
  })
}

function isFatal(error) {
  const code = error && error.code ? String(error.code) : ''
  return code === 'capture/not-found' || code === 'capture/closed'
    || code === 'vtuber/absent' || code === 'vtuber/unauthorized'
}

function stopStream(stream, reason) {
  if (!stream) return
  if (stream.status === 'reconnecting') {
    // 重连等待中：直接收尾（重连循环会看到 status 变化后自行退出）
    stream.status = 'stopping'
    stream.endReason = reason
    void finish(stream, reason)
    return
  }
  if (stream.status !== 'running') return
  stream.status = 'stopping'
  stream.endReason = reason
  try { stream.video?.stop?.() } catch { /* 忽略 */ }
  try { stream.audio?.stop?.() } catch { /* 忽略 */ }
}

async function finish(stream, reason) {
  if (!stream || stream.endedAt) return
  stream.status = 'ended'
  stream.endReason = stream.endReason || reason
  stream.endedAt = Date.now()
  if (stream.timer) clearTimeout(stream.timer)
  try { stream.video?.stop?.() } catch { /* 忽略 */ }
  try { stream.audio?.stop?.() } catch { /* 忽略 */ }
  await stream.capture.close(stream.endReason)
  log('采集结束 ' + stream.id + '（' + stream.endReason + '）：帧 ' + stream.stats.framesSent
    + '，丢帧 ' + stream.stats.framesDropped + '，音频块 ' + stream.stats.pcmChunks
    + '，重连 ' + stream.reconnects + ' 次'
    + '，用时 ' + Math.round((stream.endedAt - stream.startedAt) / 1000) + 's')
  // 结束的留 5 分钟供 status 查，之后清掉
  const timer = setTimeout(() => streams.delete(stream.id), 5 * 60 * 1000)
  timer.unref?.()
}

function view(stream) {
  return {
    streamId: stream.id,
    mode: stream.mode,
    source: stream.source,
    resolved: stream.resolved || '',
    label: stream.label,
    captureId: stream.captureId || '',
    want: stream.want || null,
    status: stream.status,
    endReason: stream.endReason || '',
    elapsedMs: (stream.endedAt || Date.now()) - stream.startedAt,
    viaYtdlp: stream.viaYtdlp === true,
    reconnects: stream.reconnects,
    lastReconnect: stream.lastReconnect || null,
    bili: stream.bili,
    candidates: stream.candidates ? stream.candidates.length : 0,
    stats: stream.stats,
    vtuber: stream.capture.baseUrl,
  }
}

/* ── 工具 ─────────────────────────────────────────────────── */

function registerTools(ctx) {
  const disposers = []

  disposers.push(ctx.tools.register(textTool(
    'galaxy_path',
    '让形象「看/听」一个一次性资源：本地视频/音频文件或网络直链（视频站点 URL 会先过 yt-dlp 拿直链）。'
      + '画面与声音解码后推给 muse_vtuber 的采集口，由它按自己的策略取帧识别、断句识别。'
      + '**只播放一次，播完即停**（不循环）。',
    obj({
      source: str('本地文件绝对路径，或 http(s) 链接；视频站点页面 URL 也可以（会尝试 yt-dlp）'),
      label: str('可选：来源名（会出现在 vtuber 的识别文本与面板上），默认用 source'),
      audio: bool('可选：false = 只要画面不要声音（默认听 vtuber 的 capture.audio）'),
      fps: num('可选：画面上限帧率（默认听 vtuber 的 capture.fps）'),
      width: num('可选：画面宽度（默认听 vtuber 的 capture.width）'),
    }, ['source']),
    async (args, exec) => {
      const stream = await startCapture({
        mode: 'path',
        source: args.source,
        label: args.label,
        exec,
        audio: args.audio,
        fps: args.fps,
        width: args.width,
      })
      return {
        ok: true,
        ...view(stream),
        note: '已在后台开始播放（播完自动停）。画面看「形象」页签，进度用 galaxy_status。',
      }
    },
  )))

  disposers.push(ctx.tools.register(textTool(
    'galaxy_rtsp',
    '让形象「看/听」一路直播流（rtsp:// / rtmp:// / m3u8 / flv）。与 galaxy_path 的唯一区别：'
      + '按直播处理（不做 yt-dlp 解析），一直采到源断或 galaxy_stop。',
    obj({
      source: str('直播流地址（rtsp://... / http(s)://...m3u8 或 .flv）'),
      label: str('可选：来源名'),
      audio: bool('可选：false = 只要画面'),
    }, ['source']),
    async (args, exec) => {
      const stream = await startCapture({ mode: 'rtsp', source: args.source, label: args.label, exec, audio: args.audio })
      return { ok: true, ...view(stream), note: '直播采集已开始；用 galaxy_stop 停止。' }
    },
  )))

  disposers.push(ctx.tools.register(textTool(
    'galaxy_path_bilibili',
    '让形象「看/听」一个 B 站视频（复用 mira_bilibili 的登录态）：BV 号 / av 号 / 完整 URL 都行。'
      + '会把 mira_account 里的 bili cookie 转成 yt-dlp 的 cookies.txt（临时文件 600，解析完即删），'
      + '因此能拿到高码率 / 大会员 / 付费内容。**播完即停，不循环。**',
    obj({
      source: str('B 站视频：BV 号（BV1xx411c7mD）、av 号，或完整 URL'),
      label: str('可选：来源名'),
      audio: bool('可选：false = 只要画面'),
      fps: num('可选：画面上限帧率'),
      width: num('可选：画面宽度'),
    }, ['source']),
    async (args, exec) => {
      const url = normalizeVideoInput(args.source)
      const prepared = biliCookiesFile('galaxy-bili')
      let stream
      try {
        stream = await startCapture({
          mode: 'path',
          source: url,
          label: args.label || url,
          exec,
          audio: args.audio,
          fps: args.fps,
          width: args.width,
          cookies: prepared.file,
        })
      } finally {
        removeCookiesFile(prepared.file)
      }
      return {
        ok: true,
        ...view(stream),
        cookies: prepared.note,
        note: '已在后台开始播放（播完自动停）。画面看「形象」页签。',
      }
    },
  )))

  disposers.push(ctx.tools.register(textTool(
    'galaxy_rtsp_bilibili',
    '让形象「看/听」一个 B 站直播间（短号 / 房间号 / 完整 URL 都行）。'
      + '用 B 站直播 REST 解析真实流地址（优先 FLV），**断流会自动按候选 CDN 重连**（次数可配）。'
      + '一直采到 galaxy_stop 或重连次数用尽。',
    obj({
      room: str('直播间短号或房间号（如 12345678）'),
      label: str('可选：来源名'),
      audio: bool('可选：false = 只要画面'),
    }, ['room']),
    async (args, exec) => {
      const creds = biliCredentials()
      const info = await resolveRoom(args.room, { cookies: creds.cookies })
      if (!info.roomId) {
        throw Object.assign(new Error('解析不到直播间：' + args.room), { code: 'bili/room-not-found' })
      }
      if (!info.liveStatus) {
        throw Object.assign(new Error('直播间 ' + info.roomId + ' 当前未开播（live_status=0）'), {
          code: 'bili/offline',
          hint: '等开播再试；或先用 galaxy_rtsp 手动喂流地址',
        })
      }
      const urls = await getLiveStreamUrls(info.roomId, { cookies: creds.cookies })
      if (urls.length === 0) {
        throw Object.assign(new Error('直播间 ' + info.roomId + ' 没有可用流地址'), { code: 'bili/no-stream' })
      }
      // 预探测：B 站 CDN 节点会随机拒绝（实测 5 个里 4 个坏），先把能出帧的挑出来排第一，
      // 否则第一路必然要撞几次墙才会落到好节点上。
      let ordered = urls
      let probed = -1
      for (let i = 0; i < Math.min(Math.max(1, Number(cfg.bili.probeCandidates) || 6), urls.length); i += 1) {
        if (await probeLiveUrl(urls[i], { ffmpeg: cfg.media.ffmpeg })) { probed = i; break }
      }
      if (probed > 0) {
        ordered = [urls[probed], ...urls.filter((_, i) => i !== probed)]
        log('预探测：跳过前 ' + probed + ' 个失效节点，用第 ' + (probed + 1) + ' 个')
      } else if (probed === 0) {
        log('预探测：第一个候选即可用')
      } else {
        log('预探测：前 4 个候选都没通过（回退到第一个，交给断流重连继续试）')
      }
      let cursor = 0
      const resolver = async () => {
        cursor += 1
        if (cursor >= ordered.length) {
          // 候选都试过了：重新解析一次（换一批 CDN 节点与签名）
          const fresh = await getLiveStreamUrls(info.roomId, { cookies: creds.cookies })
          if (fresh.length > 0) ordered.splice(0, ordered.length, ...fresh)
          cursor = 0
        }
        return { videoSource: ordered[cursor], audioSource: ordered[cursor] }
      }
      const stream = await startCapture({
        mode: 'rtsp',
        source: ordered[0],
        label: args.label || ('B站直播 ' + info.roomId),
        exec,
        audio: args.audio,
        reconnect: true,
        reconnectResolver: resolver,
        extra: { candidates: ordered, bili: { roomId: info.roomId, uid: info.uid, probed: probed + 1 } },
      })
      return {
        ok: true,
        ...view(stream),
        room: { roomId: info.roomId, uid: info.uid, candidates: ordered.length, probed: probed + 1 },
        cookies: creds.ok ? '已用 mira_account 的登录态' : '未读到登录态（' + creds.error + '）',
        note: '直播采集已开始；断流会自动重连，用 galaxy_stop 停止。',
      }
    },
  )))

  disposers.push(ctx.tools.register(textTool(
    'galaxy_status',
    '看当前/最近的采集任务（帧数、丢帧、音频块、重连次数、错误、跑了多久）。',
    obj({}),
    async () => {
      const list = [...streams.values()].map(view)
      return list.length
        ? { ok: true, vtuber: cfg.vtuber.baseUrl, streams: list }
        : { ok: true, vtuber: cfg.vtuber.baseUrl, streams: [], note: '当前没有采集任务' }
    },
  )))

  disposers.push(ctx.tools.register(textTool(
    'galaxy_stop',
    '停止一路采集（不传 streamId = 停全部）。',
    obj({ streamId: str('可选：galaxy_status 里的 streamId；不传=全部') }),
    async (args) => {
      const wanted = String(args?.streamId || '').trim()
      const targets = wanted === ''
        ? [...streams.values()].filter((s) => s.status === 'running' || s.status === 'stopping' || s.status === 'reconnecting')
        : [streams.get(wanted)].filter(Boolean)
      if (targets.length === 0) {
        return {
          ok: false,
          error: {
            code: 'capture/not-found',
            message: '没有可停止的采集：' + (wanted || '(全部)'),
            hint: '先 galaxy_status 看有哪些任务',
          },
        }
      }
      for (const stream of targets) stopStream(stream, 'stopped')
      // 等真的收尾（最长 5 秒），这样调用方拿到的是结束态
      const deadline = Date.now() + 5000
      while (Date.now() < deadline && targets.some((s) => s.status !== 'ended')) {
        await new Promise((r) => setTimeout(r, 100))
      }
      return {
        ok: true,
        stopped: targets.map((s) => ({ streamId: s.id, status: s.status, endReason: s.endReason, stats: s.stats })),
      }
    },
  )))

  return () => disposers.forEach((dispose) => { try { dispose?.() } catch { /* 忽略 */ } })
}

/* ── 装配 ─────────────────────────────────────────────────── */

export function apply(ctx, config) {
  const given = config && typeof config === 'object' ? config : {}
  cfg = {
    ...structuredClone(DEFAULTS),
    ...given,
    vtuber: { ...DEFAULTS.vtuber, ...(given.vtuber || {}) },
    media: { ...DEFAULTS.media, ...(given.media || {}) },
    bili: { ...DEFAULTS.bili, ...(given.bili || {}) },
  }
  loggerRef = ctx.logger || null
  if (cfg.enabled === false) return { ok: true, enabled: false }

  const disposeTools = registerTools(ctx)
  ctx.effect(() => () => {
    try { disposeTools?.() } catch { /* 忽略 */ }
    for (const stream of streams.values()) {
      try { stream.video?.stop?.() } catch { /* 忽略 */ }
      try { stream.audio?.stop?.() } catch { /* 忽略 */ }
      try { stream.capture.close('plugin-dispose') } catch { /* 忽略 */ }
    }
    streams.clear()
  })

  const tokenFile = String(cfg.vtuber.tokenFile || '').trim()
    || join(dshHome(), 'mira_config', 'muse_vtuber', 'capture.json')
  const tokenReady = existsSync(tokenFile)
  const bili = biliCredentials()
  log('已加载：采集口 ' + cfg.vtuber.baseUrl + '，令牌 ' + tokenFile
    + (tokenReady ? '（已就绪）' : '（还没有：先让 muse_vtuber 生成）')
    + '，ffmpeg ' + cfg.media.ffmpeg + '，yt-dlp ' + cfg.media.ytdlp
    + '，B站登录态 ' + (bili.ok ? '就绪' : '缺失（' + (bili.error || '') + '）'))
  return { ok: true, tools: 6, vtuber: cfg.vtuber.baseUrl, tokenFile, tokenReady, biliLoggedIn: bili.ok }
}

export const __testing = { DEFAULTS, startCapture, stopStream, view, streams, biliCredentials }
