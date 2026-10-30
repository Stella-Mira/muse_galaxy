/**
 * muse_galaxy / media.js —— 把"某个源"变成采集输出（JPEG 帧 + 16k PCM）
 *
 * 两种源：
 *   path  一次性资源（本地文件 / 网络直链 / 视频站点 URL）：播完就停，**不循环**
 *   rtsp  长连接直播流（rtsp:// / http-flv / m3u8 都由 ffmpeg 自己处理）
 *
 * 为什么用管道而不是落地临时文件：帧率低（2–5fps）、两端都在本机，
 * 管道省磁盘也省一次轮询；ffmpeg 的输出按 JPEG 的 SOI/EOI 切帧。
 */
import { spawn } from 'node:child_process'

/** JPEG 帧切分：SOI = FFD8FF，EOI = FFD9。 */
export const SOI = Buffer.from([0xff, 0xd8, 0xff])
export const EOI = Buffer.from([0xff, 0xd9])

/**
 * 起一路"画面"解码：ffmpeg → MJPEG → 逐帧回调。
 * @param {object} options
 * @param {string} options.source        文件路径 / http(s) / rtsp
 * @param {number} [options.fps]         期望帧率（vtuber 的 want.fps）
 * @param {number} [options.width]       期望宽度（高度按比例）
 * @param {boolean} [options.realtime]   true = -re（按源的自然速度，直播/演示用）
 * @param {string} [options.ffmpeg]      ffmpeg 可执行文件
 * @param {(jpeg:Buffer)=>void} options.onFrame
 * @param {(line:string)=>void} [options.onLog]
 */
export function startVideo({ source, fps = 4, width = 480, realtime = false, ffmpeg = 'ffmpeg', httpHeaders = '', userAgent = '', onFrame, onLog }) {
  const args = ['-hide_banner', '-loglevel', 'error']
  if (realtime) args.push('-re')
  // 直播流走 TCP（UDP 在丢包时画面会花）
  if (/^rtsp:/i.test(String(source))) args.push('-rtsp_transport', 'tcp')
  // 有些 CDN（B 站 bilivideo/mcdn）校验 Referer/UA，不带就 403
  if (userAgent) args.push('-user_agent', userAgent)
  if (httpHeaders) args.push('-headers', httpHeaders)
  args.push('-i', String(source))
  args.push('-an', '-vf', 'fps=' + Math.max(1, Math.min(30, fps)) + ',scale=' + Math.max(160, Math.min(1920, width)) + ':-2')
  args.push('-f', 'mjpeg', '-q:v', '6', 'pipe:1')

  const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  let carry = Buffer.alloc(0)
  let frames = 0
  proc.stdout.on('data', (chunk) => {
    carry = Buffer.concat([carry, chunk])
    for (;;) {
      const start = carry.indexOf(SOI)
      if (start < 0) { carry = Buffer.alloc(0); return }
      const end = carry.indexOf(EOI, start + 3)
      if (end < 0) { carry = carry.slice(start); return }
      const jpeg = carry.slice(start, end + 2)
      carry = carry.slice(end + 2)
      frames += 1
      try { onFrame(jpeg) } catch { /* 回调自己的错误不该打死解码 */ }
    }
  })
  let stderr = ''
  proc.stderr.on('data', (d) => {
    const line = String(d).trim()
    stderr = (stderr + ' ' + line).slice(-800)
    if (line) onLog?.(line)
  })
  const done = new Promise((resolve) => {
    proc.on('exit', (code, signal) => resolve({ code, signal, frames, stderr: stderr.trim() }))
    proc.on('error', (error) => resolve({ code: -1, signal: null, frames, stderr: String(error && error.message ? error.message : error) }))
  })
  return {
    proc,
    done,
    get frames() { return frames },
    stop() { try { proc.kill('SIGTERM') } catch { /* 忽略 */ } },
  }
}

/**
 * 起一路"声音"解码：ffmpeg → 16bit 单声道 PCM → 按 chunkMs 切块回调。
 * 采样率默认 16000（与 vtuber 的 mic.sampleRate 一致；vtuber 侧按 mic.vad 断句）。
 */
export function startAudio({ source, sampleRate = 16000, chunkMs = 200, realtime = false, ffmpeg = 'ffmpeg', httpHeaders = '', userAgent = '', onChunk, onLog }) {
  const rate = Math.max(8000, Math.min(48000, Number(sampleRate) || 16000))
  const args = ['-hide_banner', '-loglevel', 'error']
  if (realtime) args.push('-re')
  if (/^rtsp:/i.test(String(source))) args.push('-rtsp_transport', 'tcp')
  if (userAgent) args.push('-user_agent', userAgent)
  if (httpHeaders) args.push('-headers', httpHeaders)
  args.push('-i', String(source))
  args.push('-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', 'pipe:1')

  const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  const chunkBytes = Math.max(2, Math.floor((rate * 2 * chunkMs) / 1000))
  let carry = Buffer.alloc(0)
  let chunks = 0
  proc.stdout.on('data', (data) => {
    carry = Buffer.concat([carry, data])
    while (carry.length >= chunkBytes) {
      const chunk = carry.slice(0, chunkBytes)
      carry = carry.slice(chunkBytes)
      chunks += 1
      try { onChunk(chunk) } catch { /* 同上 */ }
    }
  })
  let stderr = ''
  proc.stderr.on('data', (d) => {
    const line = String(d).trim()
    stderr = (stderr + ' ' + line).slice(-800)
    if (line) onLog?.(line)
  })
  const done = new Promise((resolve) => {
    proc.on('exit', (code, signal) => {
      // 尾巴（不足一块）也送出去，别丢最后几个字
      if (carry.length >= 2) {
        chunks += 1
        try { onChunk(carry) } catch { /* 忽略 */ }
      }
      resolve({ code, signal, chunks, stderr: stderr.trim() })
    })
    proc.on('error', (error) => resolve({ code: -1, signal: null, chunks, stderr: String(error && error.message ? error.message : error) }))
  })
  return { proc, done, get chunks() { return chunks }, stop() { try { proc.kill('SIGTERM') } catch { /* 忽略 */ } } }
}

/** 跑一次 yt-dlp 拿直链（只取 stdout 第一行）。ytdlp 允许写成 "exe 参数" 形式（如 `python -m yt_dlp`）。 */
function runYtdlp(ytdlp, args, timeoutMs) {
  const parts = String(ytdlp || 'yt-dlp').match(/"[^"]+"|\S+/g) || ['yt-dlp']
  const command = parts[0].replace(/^"|"$/g, '')
  const prefix = parts.slice(1).map((s) => s.replace(/^"|"$/g, ''))
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let proc
    try {
      proc = spawn(command, [...prefix, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ code: -1, first: '', stderr: String((error && error.message) || error) })
      return
    }
    const timer = setTimeout(() => { try { proc.kill('SIGTERM') } catch { /* 忽略 */ } }, Math.max(5000, timeoutMs))
    proc.stdout.on('data', (d) => { stdout += String(d) })
    proc.stderr.on('data', (d) => { stderr = (stderr + String(d)).slice(-600) })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, first: String(stdout || '').trim().split(/\r?\n/).filter(Boolean)[0] || '', stderr })
    })
    proc.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, first: '', stderr: String((error && error.message) || error) })
    })
  })
}

/**
 * 网络资源先过 yt-dlp 拿直链（视频站点/需要 cookie 的都靠它）。
 * 失败就把原地址交回去 —— 让 ffmpeg 自己试（直链/本地文件很常见）。
 *
 * **为什么要两次调用**：B 站/YouTube 这类是 DASH，音视频**分开**成两条地址。
 * 我们的流水线本来就是"画面一个 ffmpeg、声音一个 ffmpeg"，所以分别取：
 *   video ← 格式 `bv*`（优先纯视频轨），没有就退到 `b`（合并轨）
 *   audio ← 格式 `ba`（优先纯音频轨），没有就退到 `b`
 * 只取一次 `-g` 的第一行会拿到**没有声音的视频轨**（真实踩过）。
 * 注意：注释里不能出现 `星号 + 斜杠` 连写，会提前结束块注释（这个坑真踩了）。
 *
 * @returns {Promise<{ video:string, audio:string, viaYtdlp:boolean, split:boolean, note?:string }>}
 */
export async function resolveSource(source, { ytdlp = 'yt-dlp', cookies = '', timeoutMs = 30000 } = {}) {
  const raw = String(source || '').trim()
  if (raw === '') throw new Error('源是空的')
  // 本地文件、rtsp、明显是直链的媒体扩展名：不折腾 yt-dlp
  if (!/^https?:/i.test(raw)) return { video: raw, audio: raw, viaYtdlp: false, split: false }
  if (/\.(mp4|m4v|webm|mkv|mov|flv|m3u8|mp3|m4a|wav|aac|opus|ogg|ts)(\?|$)/i.test(raw)) {
    return { video: raw, audio: raw, viaYtdlp: false, split: false }
  }

  const base = ['-g', '--no-playlist', '--no-warnings']
  if (cookies) base.push('--cookies', cookies)
  const [videoOut, audioOut] = await Promise.all([
    runYtdlp(ytdlp, [...base, '-f', 'bv*/b', raw], timeoutMs),
    runYtdlp(ytdlp, [...base, '-f', 'ba/b', raw], timeoutMs),
  ])

  if (videoOut.code === 0 && videoOut.first !== '') {
    const audio = audioOut.code === 0 && audioOut.first !== '' ? audioOut.first : videoOut.first
    return { video: videoOut.first, audio, viaYtdlp: true, split: audio !== videoOut.first }
  }
  // yt-dlp 拿不到：把原地址交回 ffmpeg 再试一次（很多直链其实没问题）
  return {
    video: raw,
    audio: raw,
    viaYtdlp: false,
    split: false,
    note: 'yt-dlp 没给出直链：' + String(videoOut.stderr || '').trim().split('\n').slice(-1)[0],
  }
}

/**
 * 预探测一个直播流地址能不能**真的出画面**。
 * B 站 CDN 节点会随机 403（实测同房间 cand0 403、cand1 能出 21 帧），
 * 所以探测必须走和真实解码一样的管线（同组 -headers / -vf / mjpeg 输出）：
 * 只判「能解 1.5 秒不报错」不够 —— `-f null` 能过，真出帧未必能过。
 * @returns {Promise<boolean>} 预算内有没有拿到至少一帧
 */
export function probeLiveUrl(url, { ffmpeg = 'ffmpeg', timeoutMs = 2500 } = {}) {
  return new Promise((resolve) => {
    let frames = 0
    let decoder = null
    try {
      decoder = startVideo({
        source: url,
        fps: 2,
        width: 320,
        realtime: true,
        ffmpeg,
        ...httpHeadersFor(url),
        onFrame: () => { frames += 1 },
      })
    } catch {
      resolve(false)
      return
    }
    const timer = setTimeout(() => { try { decoder.stop() } catch { /* 忽略 */ } }, Math.max(1200, timeoutMs))
    decoder.done.then(() => { clearTimeout(timer); resolve(frames > 0) })
  })
}

/** 判断一个源更像"直播"还是"一次性资源"（给 rtsp 模式做提示用）。 */
export function looksLive(source) {
  return /^(rtsp|rtmp|rtsps):/i.test(String(source || '')) || /\.(m3u8|flv)(\?|$)/i.test(String(source || ''))
}

/**
 * 有些站点的 CDN 直链要求 Referer/UA，否则 403/exit 8（B 站 bilivideo/mcdn 就是）。
 * 返回 ffmpeg 用的 `-headers` 值与 UA；不需要时返回空串。
 *
 * **直播与点播的 Referer 不同**（2026-10-30 实测）：
 *   · 直播流（`/live-bvc/`）必须用 `https://live.bilibili.com/<房间号>`；
 *     光给 `https://live.bilibili.com/` 时节点能出几秒画面然后 403（跑不满一次直播）；
 *     给 `https://www.bilibili.com/` 则直接 exit 8、一帧都没有。
 *   · 房间号从流地址的 `cid=` 参数取（B 站 getRoomPlayInfo 给的地址里就带）。
 */
export function httpHeadersFor(url) {
  const text = String(url || '')
  if (/live-bvc|live\.bilibili\.com|\/live\//i.test(text)) {
    const roomId = (text.match(/[?&]cid=(\d+)/) || [])[1] || ''
    return {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      headers: 'Referer: https://live.bilibili.com/' + roomId + '\r\nOrigin: https://live.bilibili.com\r\n',
    }
  }
  if (/bilivideo|bilibili|hdslb|mcdn/i.test(text)) {
    return {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      headers: 'Referer: https://www.bilibili.com/\r\nOrigin: https://www.bilibili.com\r\n',
    }
  }
  return { userAgent: '', headers: '' }
}
