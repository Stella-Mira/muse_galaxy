/**
 * 对**正在运行的** dsh web 验 galaxy_path（真 ffmpeg 解码 → 推 vtuber 采集口）。
 *
 * 用法：
 *   node test\live-path.mjs [媒体文件] [秒数] [--session <会话id>] [--also-rtsp]
 * 不给文件时会用 ffmpeg 现造一段「彩条 + 人声」的 mp4（人声来自 vtuber 的 TTS）。
 *
 * **--session 是必需的**（除非 vtuber 的 security.mode=off）：capture/open 属于「接收」，
 * 要 observer 或 taker 权限；不带会话身份会被 403 authz/no-session 拒掉（实测踩过）。
 * 也可以设环境变量 DSH_SESSION_ID。随便一个不存在的会话 id 也行：vtuber 的
 * security.autoObserve 会把它登记成 observer，插话就投给那个会话，不会打扰你自己的会话。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const VALUE_FLAGS = new Set(['--session'])
const positional = []
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]
  if (arg.startsWith('--')) {
    if (VALUE_FLAGS.has(arg)) i += 1
    continue
  }
  positional.push(arg)
}
const sessionId = (() => {
  const at = argv.indexOf('--session')
  const fromArg = at >= 0 ? String(argv[at + 1] || '').trim() : ''
  return fromArg || String(process.env.DSH_SESSION_ID || process.env.MUSE_GALAXY_SESSION || '').trim()
})()
if (sessionId === '') {
  console.log('  [warn] 没给会话身份：加 --session <会话id> 或设 DSH_SESSION_ID，'
    + '否则 vtuber 会以 403 authz/no-session 拒绝 capture/open')
}

const target = positional[0] || ''
const sample = positional[1] || ''

const galaxy = await import('../lib/index.js')
const { VtuberCapture } = await import('../lib/vtuber.js')

const registered = new Map()
const ctx = {
  logger: { info: (m) => console.log('  [log]', m), warn: (m) => console.log('  [warn]', m), debug: () => {} },
  tools: { register: (definition) => { registered.set(definition.name, definition); return () => registered.delete(definition.name) } },
  effect: (fn) => { fn(); return () => {} },
}

const applied = galaxy.apply(ctx, {})
console.log('apply:', JSON.stringify(applied))

const info = await new VtuberCapture({ baseUrl: 'http://127.0.0.1:3080' }).probe()
console.log('vtuber 采集口:', JSON.stringify(info))

// 现造素材：testsrc2 画面 + 人声（TTS 偶尔连不上，就退回正弦音：音频通路照样验，只是没有词）
let media = target
let scratch = ''
async function fetchTtsWav(text) {
  const token = (await import('node:fs')).readFileSync(join(homedir(), '.dsh', 'mira_config', 'muse_vtuber', 'capture.json'), 'utf8')
  const auth = { authorization: 'Bearer ' + JSON.parse(token).token, 'content-type': 'application/json' }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const say = await fetch('http://127.0.0.1:3080/vtuber/api/say', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ text }),
    }).then((r) => r.json()).catch(() => ({ ok: false }))
    if (say.ok) {
      return {
        ok: true,
        wav: Buffer.from(await (await fetch('http://127.0.0.1:3080' + say.url, { headers: auth })).arrayBuffer()),
      }
    }
    console.log('  TTS 第 ' + attempt + ' 次失败：' + JSON.stringify(say.error || {}).slice(0, 120))
    await new Promise((r) => setTimeout(r, 1500))
  }
  return { ok: false }
}

async function makeSample() {
  const { mkdtempSync: mk, writeFileSync } = await import('node:fs')
  scratch = mkdtempSync(join(tmpdir(), 'galaxy-sample-'))
  const tts = await fetchTtsWav('这是星系播放的视频，画面在动，声音也在走，播完就停不循环。')
  const audioArgs = []
  if (tts.ok) {
    const wavPath = join(scratch, 'voice.wav')
    writeFileSync(wavPath, tts.wav)
    audioArgs.push('-i', wavPath)
  } else {
    console.log('  TTS 不可用 → 退回 440Hz 正弦音（音频通路仍会验，只是识别不出词）')
    audioArgs.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000:duration=6')
  }
  const out = join(scratch, 'sample.mp4')
  const code = await new Promise((resolve) => {
    const proc = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=8',
      ...audioArgs,
      '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', out,
    ], { stdio: 'ignore' })
    proc.on('exit', resolve)
  })
  if (code !== 0) throw new Error('ffmpeg 造样例失败 exit=' + code)
  console.log('样例:', out, Math.round(statSync(out).size / 1024) + 'KB', tts.ok ? '（含人声）' : '（含正弦音）')
  return out
}

if (media === '') media = await makeSample()

const tool = registered.get('galaxy_path')
const runTool = async (name, args) => {
  const out = await registered.get(name).execute(args, { agent: { session: { id: sessionId } } })
  return typeof out === 'string' ? JSON.parse(out) : out
}
console.log('galaxy_path 开始：', media, '（会话身份：' + (sessionId || '无') + '）')
const started = await runTool('galaxy_path', { source: media, label: '样例视频' })
console.log('返回：', JSON.stringify({ ok: started.ok, streamId: started.streamId, captureId: started.captureId, want: started.want, status: started.status }))
if (!started.ok) {
  console.log('失败：', JSON.stringify(started.error))
  process.exit(1)
}

const deadline = Date.now() + Math.min(180, Number(sample) || 90) * 1000
const token = (await import('node:fs')).readFileSync(join(homedir(), '.dsh', 'mira_config', 'muse_vtuber', 'capture.json'), 'utf8')
const auth = { authorization: 'Bearer ' + JSON.parse(token).token }
const vtuberHealth = async () => fetch('http://127.0.0.1:3080/vtuber/api/health', { headers: auth }).then((r) => r.json())

let last = ''
let ended = false
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000))
  const status = await runTool('galaxy_status', {})
  const row = (status.streams || [])[0] || {}
  // 收尾之后 vtuber 会把这一路源删掉，就别再查它了（否则打印一串 undefined）
  const h = row.status === 'ended' ? null : await vtuberHealth()
  const src = ((h && h.capture.sources) || []).find((s) => s.captureId === row.captureId) || {}
  const line = `状态=${row.status} 推帧=${row.stats?.framesSent} 丢=${row.stats?.framesDropped} 音频块=${row.stats?.pcmChunks}`
    + (h ? ` | vtuber: 帧=${src.frames} pcm=${src.pcmChunks} 断句=${src.audioChunks} 插话=${src.audioSteered} state=${src.state}` : '')
    + ` | 用时=${Math.round((row.elapsedMs || 0) / 1000)}s`
  if (line !== last) { console.log('  ' + line); last = line }
  if (row.status === 'ended') {
    console.log('结束原因:', row.endReason, '| 错误:', JSON.stringify(row.stats?.lastError))
    ended = true
    break
  }
}
if (!ended) console.log('（超过观察时长，仍在跑）')

// ── 可选：顺带验 galaxy_rtsp（用本地 HLS 播放列表冒充直播源，走的是同一条 rtsp 分支）──
if (process.argv.includes('--also-rtsp')) {
  console.log('\n=== galaxy_rtsp（本地 HLS 冒充直播）===')
  const { mkdtempSync: mk, rmSync: rm } = await import('node:fs')
  const hlsDir = mk(join(tmpdir(), 'galaxy-hls-'))
  const playlist = join(hlsDir, 'live.m3u8')
  const code = await new Promise((resolve) => {
    const proc = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=8',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=24000:duration=8',
      '-t', '8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      '-f', 'hls', '-hls_time', '1', '-hls_list_size', '0', '-hls_flags', 'independent_segments', playlist,
    ], { stdio: 'ignore' })
    proc.on('exit', resolve)
  })
  console.log('HLS 播放列表:', playlist, 'exit=' + code)
    const startedRtsp = await runTool('galaxy_rtsp', { source: playlist, label: 'HLS 样例' })
  console.log('galaxy_rtsp 返回:', JSON.stringify({ ok: startedRtsp.ok, streamId: startedRtsp.streamId, want: startedRtsp.want }))
  if (startedRtsp.ok) {
    const deadline2 = Date.now() + 60000
    while (Date.now() < deadline2) {
      await new Promise((r) => setTimeout(r, 2000))
      const st = await runTool('galaxy_status', {})
      const row = (st.streams || []).find((s) => s.streamId === startedRtsp.streamId) || {}
      console.log(`  rtsp: 状态=${row.status} 推帧=${row.stats?.framesSent} 丢=${row.stats?.framesDropped} 音频块=${row.stats?.pcmChunks} 用时=${Math.round((row.elapsedMs || 0) / 1000)}s`)
      if (row.status === 'ended') { console.log('  rtsp 结束原因:', row.endReason); break }
    }
  }
  rm(hlsDir, { recursive: true, force: true })
}

// 结束之后再等一会儿：断句/识别是异步的，lastPercept 可能晚一两秒才刷新
await new Promise((r) => setTimeout(r, 4000))
const health = await vtuberHealth()
console.log('vtuber.capture:', JSON.stringify({
  subscribers: health.capture.subscribers,
  sources: (health.capture.sources || []).map((s) => ({ label: s.label, frames: s.frames, pcm: s.pcmChunks, audio: s.audioChunks, steered: s.audioSteered, state: s.state })),
  lastPercept: health.capture.lastPercept,
}, null, 2))

if (scratch) rmSync(scratch, { recursive: true, force: true })
