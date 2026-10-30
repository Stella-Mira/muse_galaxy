/**
 * muse_galaxy / bilibili.js —— B 站专属的取流辅助（P1 / P2）
 *
 * 职责边界（任务书）：
 *   · mira_bilibili 管**后台**：登录态、私信、弹幕、直播事件的轮询；
 *   · muse_galaxy 管**流**：把「视频 URL / 直播间」变成 ffmpeg 能吃的直链；
 *   · muse_vtuber 管**感知与表达**：取帧识别、断句识别、说话。
 *
 * 所以这里**只做两件事**：
 *   1) 把 mira_account 里的 bili cookie 转成 yt-dlp 认的 Netscape cookies.txt（临时文件，600）；
 *   2) 调 B 站直播 REST 拿候选流地址（room_init + getRoomPlayInfo）。
 *
 * 刻意**不**在这里重写 wbi 签名/风控退避：那些是 mira_bilibili 的账，
 * 这里只做「无签名也够用」的两个公开接口。拿不到就明确报错，让调用方回退到 galaxy_path / galaxy_rtsp。
 */
import { chmodSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const LIVE_REFERER = 'https://live.bilibili.com/'
const VIDEO_REFERER = 'https://www.bilibili.com/'

/** bili cookie 需要的字段（mira_account 的 creds 里就是这个形状）。 */
export const COOKIE_FIELDS = ['SESSDATA', 'bili_jct', 'buvid3', 'buvid4']

/**
 * 读 mira_account 的 bili 凭据。
 * @param {string} file 形如 ~/.dsh/mira_config/mira_account/creds/bili-main.json
 * @returns {{ok:boolean, file:string, cookies:Record<string,string>, error?:string}}
 */
export function readCredentials(file) {
  const path = String(file || '')
  if (path === '') return { ok: false, file: path, cookies: {}, error: '没有配置凭据文件路径' }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return { ok: false, file: path, cookies: {}, error: '读不到凭据：' + (error && error.message ? error.message : String(error)) }
  }
  const flat = parsed && typeof parsed === 'object' ? parsed : {}
  // mira_account 的凭据是封装格式：{schemaVersion, platform, kind, fields:{SESSDATA,...}}
  // 也兼容直接把 cookie 平铺在顶层的写法。
  const source = (flat.fields && typeof flat.fields === 'object') ? flat.fields : flat
  const cookies = {}
  for (const field of COOKIE_FIELDS) {
    if (typeof source[field] === 'string' && source[field].trim() !== '') cookies[field] = source[field].trim()
  }
  if (!cookies.SESSDATA) return { ok: false, file: path, cookies, error: '凭据里没有 SESSDATA（登录态无效）' }
  return { ok: true, file: path, cookies }
}

/**
 * 把 cookie 写成 Netscape cookies.txt（yt-dlp --cookies 认这个格式）。
 * 文件权限 600，且只落在系统临时目录；调用方用完必须删。
 * @returns {string} 文件路径
 */
export function writeNetscapeCookies(cookies, tag = 'galaxy') {
  const entries = Object.entries(cookies || {}).filter(([k, v]) => k && v)
  if (entries.length === 0) throw new Error('没有可写的 cookie')
  const expiry = Math.floor(Date.now() / 1000) + 7 * 24 * 3600
  const lines = ['# Netscape HTTP Cookie File', '# 由 muse_galaxy 临时生成，用完即删', '']
  for (const [name, value] of entries) {
    // domain  TRUE  path  secure  expiry  name  value
    lines.push(['.bilibili.com', 'TRUE', '/', 'FALSE', String(expiry), name, value].join('\t'))
  }
  const file = join(tmpdir(), tag + '-cookies-' + process.pid + '-' + Date.now() + '.txt')
  writeFileSync(file, lines.join('\n') + '\n', { mode: 0o600 })
  try { chmodSync(file, 0o600) } catch { /* Windows 上没有 POSIX 权限位，忽略 */ }
  return file
}

/** 删临时 cookie 文件（幂等）。 */
export function removeCookiesFile(file) {
  if (!file) return
  try { unlinkSync(file) } catch { /* 已经没了就算了 */ }
}

/** `BV1xx411c7mD` / `av170001` / 完整 URL / 带 ?p=2 的都归一成可播地址。 */
export function normalizeVideoInput(raw) {
  const text = String(raw || '').trim()
  if (text === '') throw new Error('source 不能为空')
  if (/^https?:\/\//i.test(text)) return text
  const bv = text.match(/^BV[0-9A-Za-z]{8,}$/)
  if (bv) return 'https://www.bilibili.com/video/' + bv[0]
  const av = text.match(/^av(\d+)$/i)
  if (av) return 'https://www.bilibili.com/video/av' + av[1]
  // 其它形如 170001 的纯数字：按 av 号兜底
  if (/^\d+$/.test(text)) return 'https://www.bilibili.com/video/av' + text
  throw new Error('看不懂的 B 站视频标识：' + text + '（给 BV 号、av 号或完整 URL）')
}

/** 带 cookie + 正确 Referer 的 GET JSON。 */
async function fetchJson(url, { cookies = {}, referer = VIDEO_REFERER, timeoutMs = 15000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(3000, timeoutMs))
  try {
    const headers = {
      'User-Agent': UA,
      Referer: referer,
      Origin: referer.replace(/\/$/, ''),
      'Accept-Language': 'zh-CN,zh;q=0.9',
    }
    const pairs = Object.entries(cookies || {}).filter(([k, v]) => k && v)
    if (pairs.length) headers.Cookie = pairs.map(([k, v]) => k + '=' + v).join('; ')
    const response = await fetch(url, { headers, signal: controller.signal })
    if (!response.ok) throw new Error('HTTP ' + response.status)
    const data = await response.json()
    if (data && typeof data.code === 'number' && data.code !== 0) {
      throw new Error('B 站返回 code=' + data.code + (data.message ? '（' + data.message + '）' : ''))
    }
    return data
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 直播间号 → 真实 room_id + 状态。room 支持短号/长号/完整 URL。
 * @returns {Promise<{roomId:number, shortId:number, uid:number, liveStatus:number}>}
 */
export async function resolveRoom(room, { cookies = {}, timeoutMs = 15000 } = {}) {
  const text = String(room || '').trim()
  if (text === '') throw new Error('room 不能为空')
  const fromUrl = text.match(/live\.bilibili\.com\/(?:h5\/)?(\d+)/i)
  const id = fromUrl ? fromUrl[1] : text.replace(/[^\d]/g, '')
  if (!id) throw new Error('看不懂的直播间号：' + text + '（给短号/房间号/完整 URL）')
  const data = await fetchJson(
    'https://api.live.bilibili.com/room/v1/Room/room_init?id=' + encodeURIComponent(id),
    { cookies, referer: LIVE_REFERER, timeoutMs },
  )
  const info = (data && data.data) || {}
  if (!info.room_id) throw new Error('房间不存在或接口被风控：' + text)
  return {
    roomId: Number(info.room_id),
    shortId: Number(info.short_id || 0),
    uid: Number(info.uid || 0),
    liveStatus: Number(info.live_status || 0),
  }
}

/**
 * 拿直播流候选地址（按 qn 从高到低、flv 优先，去重）。
 * 实测：B 站 CDN 部分节点会随机 403（和拉流方 IP 绑定），所以返回**全部**候选，
 * 由 startCapture 在失败时换下一个节点。
 * @returns {Promise<string[]>}
 */
export async function getLiveStreamUrls(roomId, { cookies = {}, timeoutMs = 15000 } = {}) {
  const query = new URLSearchParams({
    room_id: String(roomId),
    protocol: '0,1',
    format: '0,1,2',
    codec: '0,1',
    qn: '10000',
    platform: 'web',
    ptype: '8',
  })
  const data = await fetchJson(
    'https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?' + query.toString(),
    { cookies, referer: LIVE_REFERER, timeoutMs },
  )
  const payload = (data && data.data) || {}
  const playurl = payload.playurl_info && payload.playurl_info.playurl
  const streams = playurl && Array.isArray(playurl.stream) ? playurl.stream : []
  if (streams.length === 0) {
    const why = Number(payload.live_status) === 0 ? '房间未开播' : '接口没给 playurl（可能被风控）'
    throw new Error('拿不到直播流地址（room ' + roomId + '）：' + why)
  }
  const formatRank = { flv: 0, fmp4: 1, ts: 2 }
  const candidates = []
  for (const stream of streams) {
    const formats = Array.isArray(stream && stream.format) ? stream.format : []
    for (const format of formats) {
      const rank = formatRank[format.format_name] !== undefined ? formatRank[format.format_name] : 9
      const codecs = Array.isArray(format && format.codec) ? format.codec : []
      for (const codec of codecs) {
        const baseUrl = (codec && codec.base_url) || ''
        if (!baseUrl) continue
        const codecName = String((codec && codec.codec_name) || '').toLowerCase()
        const urlInfos = Array.isArray(codec.url_info) ? codec.url_info : []
        for (const urlInfo of urlInfos) {
          if (!urlInfo || !urlInfo.host) continue
          const qn = Number(codec.accept_qn || stream.qn || codec.current_qn || 0)
          candidates.push({ url: urlInfo.host + baseUrl + (urlInfo.extra || ''), qn, rank, codecName })
        }
      }
    }
  }
  if (candidates.length === 0) throw new Error('直播流地址解析失败（room ' + roomId + '）')
  // avc 优先、hevc 垫底：实测 hevc 节点要么 403、要么 Input/output error，
  // 而 avc 节点（同样的 Referer）能稳定跑满整场。qn 与容器格式只在同一 codec 内比较。
  const codecRank = (candidate) => (candidate.codecName === 'hevc' ? 1 : 0)
  candidates.sort((a, b) => (codecRank(a) - codecRank(b)) || (b.qn - a.qn) || (a.rank - b.rank))
  const seen = new Set()
  const urls = []
  for (const candidate of candidates) {
    if (seen.has(candidate.url)) continue
    seen.add(candidate.url)
    urls.push(candidate.url)
  }
  return urls
}

export const __testing = { normalizeVideoInput, writeNetscapeCookies, readCredentials, fetchJson }
