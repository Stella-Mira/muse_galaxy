/** 测 capture/frame 的单次往返耗时（判断是链路慢还是我这边发送节奏的问题） */
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'

const ORIGIN = 'http://127.0.0.1:3080'
const token = JSON.parse(readFileSync(join(homedir(), '.dsh', 'mira_config', 'muse_vtuber', 'capture.json'), 'utf8')).token
const auth = { authorization: 'Bearer ' + token, 'content-type': 'application/json' }
// capture/open 属于「接收」：observer/taker 才行。不给会话身份会 403 authz/no-session。
const sessionId = String(process.env.DSH_SESSION_ID || process.env.MUSE_GALAXY_SESSION || '').trim()
if (sessionId === '') {
  console.log('  [warn] 没给会话身份：设 DSH_SESSION_ID=<会话id>，否则 capture/open 会被 403 拒掉')
}

const out = join(tmpdir(), 'lat-frame.jpg')
await new Promise((resolve) => {
  const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=480x270:rate=1', '-frames:v', '1', '-q:v', '6', out], { stdio: 'ignore' })
  p.on('exit', resolve)
})
const jpeg = readFileSync(out)
console.log('jpeg:', Math.round(jpeg.length / 1024) + 'KB', '→ base64', Math.round(jpeg.length * 4 / 3 / 1024) + 'KB')

const api = async (sub, body) => {
  const r = await fetch(ORIGIN + '/vtuber/api/' + sub, {
    method: 'POST', headers: auth, body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
  })
  return r.json()
}
const opened = await api('capture/open', { label: '延迟测量', source: 'latency-test', sessionId })
if (!opened.ok) {
  console.log('capture/open 失败：', JSON.stringify(opened.error || {}).slice(0, 300))
  process.exit(1)
}
const id = opened.captureId
const dataUrl = 'data:image/jpeg;base64,' + jpeg.toString('base64')

const times = []
for (let i = 0; i < 20; i += 1) {
  const t0 = performance.now()
  const r = await api('capture/frame', { captureId: id, jpeg: dataUrl })
  const dt = performance.now() - t0
  if (!r.ok) { console.log('失败：', JSON.stringify(r).slice(0, 160)); break }
  times.push(dt)
}
times.sort((a, b) => a - b)
console.log('往返毫秒: 最小', times[0].toFixed(1), '中位', times[Math.floor(times.length / 2)].toFixed(1),
  'P90', times[Math.floor(times.length * 0.9)].toFixed(1), '最大', times[times.length - 1].toFixed(1),
  '| 均值', (times.reduce((a, b) => a + b, 0) / times.length).toFixed(1))

// 顺带测 PCM
const pcm = Buffer.alloc(16000 * 2 * 0.2).toString('base64')
const pt = []
for (let i = 0; i < 20; i += 1) {
  const t0 = performance.now()
  const r = await api('capture/pcm', { captureId: id, pcm, sampleRate: 16000 })
  const dt = performance.now() - t0
  if (!r.ok) { console.log('pcm 失败：', JSON.stringify(r).slice(0, 160)); break }
  pt.push(dt)
}
pt.sort((a, b) => a - b)
console.log('PCM 往返毫秒: 中位', pt[Math.floor(pt.length / 2)].toFixed(1), '最大', pt[pt.length - 1].toFixed(1))
await api('capture/close', { captureId: id, reason: 'latency-done' })
