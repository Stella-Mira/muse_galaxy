/**
 * muse_galaxy / vtuber.js —— 跟 muse_vtuber 的采集口说话（本插件唯一的消费者）
 *
 * 分工（任务书 muse_galaxy 一节）：采集器只负责"取到画面和声音"，取帧策略、断句阈值、
 * 识别、限流、插话全在 vtuber。这里只做四件事：注册一路采集 → 推帧 → 推 PCM → 关闭。
 *
 * 鉴权：vtuber 只接受本机回环 + capture.json 里的令牌（600，由 vtuber 生成）。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_BASE = 'http://127.0.0.1:3080'
export const TOKEN_REL = join('mira_config', 'muse_vtuber', 'capture.json')

export function dshHome(env = process.env) {
  const fromEnv = String(env.DSH_HOME || '').trim()
  return fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

/** 读 vtuber 生成的采集令牌；读不到给出可执行的提示。 */
export function readToken(file, env = process.env) {
  const path = String(file || '').trim() || join(dshHome(env), TOKEN_REL)
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    const token = raw && typeof raw.token === 'string' ? raw.token.trim() : ''
    if (token === '') {
      return { ok: false, error: { code: 'vtuber/unauthorized', message: '采集令牌文件里没有 token：' + path, hint: '重启 muse_vtuber 让它重新生成；文件权限应为 600' } }
    }
    return { ok: true, token, file: path }
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'vtuber/unauthorized',
        message: '读不到 muse_vtuber 的采集令牌：' + path + '（' + (error && error.message ? error.message : error) + '）',
        hint: '先确认 muse_vtuber 已加载（GET ' + DEFAULT_BASE + '/vtuber/api/health 有 features.capture），它会生成该文件',
      },
    }
  }
}

class VtuberError extends Error {
  constructor(code, message, hint) {
    super(message)
    this.name = 'VtuberError'
    this.code = code
    this.hint = hint
  }
}

export class VtuberCapture {
  /**
   * @param {object} options
   * @param {string} [options.baseUrl]
   * @param {string} [options.tokenFile]
   * @param {number} [options.timeoutMs]
   * @param {object} [options.logger]
   */
  constructor({ baseUrl = DEFAULT_BASE, tokenFile = '', timeoutMs = 20000, logger = null } = {}) {
    this.baseUrl = String(baseUrl || DEFAULT_BASE).replace(/\/+$/, '')
    this.tokenFile = tokenFile
    this.timeoutMs = Math.max(1000, Number(timeoutMs) || 20000)
    this.logger = logger
    this.token = ''
    this.captureId = ''
  }

  headers() {
    if (this.token === '') {
      const read = readToken(this.tokenFile)
      if (!read.ok) throw new VtuberError(read.error.code, read.error.message, read.error.hint)
      this.token = read.token
    }
    return { Authorization: 'Bearer ' + this.token, 'Content-Type': 'application/json' }
  }

  async #call(method, sub, body) {
    const url = this.baseUrl + '/vtuber/api/' + sub
    let response
    try {
      response = await fetch(url, {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      const cause = error && error.cause ? '（' + (error.cause.code || error.cause.message) + '）' : ''
      throw new VtuberError('vtuber/absent',
        '连不上 muse_vtuber：' + url + cause,
        '确认 dsh web 在跑、muse_vtuber 已启用（GET ' + this.baseUrl + '/vtuber/api/health）')
    }
    const text = await response.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { json = null }
    if (!response.ok || (json && json.ok === false)) {
      const error = (json && json.error) || {}
      const code = error.code || (response.status === 401 ? 'vtuber/unauthorized' : 'vtuber/failed')
      throw new VtuberError(code,
        error.message || ('muse_vtuber 返回 ' + response.status + '：' + String(text).slice(0, 200)),
        error.hint || '看 vtuber 的日志与 health')
    }
    return json || {}
  }

  /** 探测 vtuber 是否实现了采集口（health.features.capture）。 */
  async probe() {
    let response
    try {
      response = await fetch(this.baseUrl + '/vtuber/api/health', { signal: AbortSignal.timeout(this.timeoutMs) })
    } catch (error) {
      const cause = error && error.cause ? '（' + (error.cause.code || error.cause.message) + '）' : ''
      throw new VtuberError('vtuber/absent', '连不上 muse_vtuber：' + this.baseUrl + cause,
        '确认 dsh web 在跑、muse_vtuber 已启用')
    }
    const json = await response.json().catch(() => null)
    const features = json && json.features ? json.features.capture : null
    if (!features || features.enabled === false) {
      throw new VtuberError('vtuber/absent',
        'muse_vtuber 没有可用的采集口（features.capture 缺失或已关闭）',
        '升级 muse_vtuber（需要 capture/open|frame|pcm|close），或在它的配置里打开 capture.enabled')
    }
    return features
  }

  /** 注册一路采集。返回 { captureId, want, cameraUrl, reused, selected }。 */
  async open({ label, source, sessionId = '', fps, width, audio } = {}) {
    await this.probe()
    const out = await this.#call('POST', 'capture/open', {
      label: String(label || source || 'galaxy'),
      source: String(source || ''),
      sessionId,
      ...(fps ? { fps } : {}),
      ...(width ? { width } : {}),
      ...(audio === undefined ? {} : { audio }),
    })
    this.captureId = String(out.captureId || '')
    return out
  }

  /** 推一帧（jpeg Buffer）。太快时按 429 自适应降频由调用方决定，这里只把错误抛清楚。 */
  async frame(jpeg) {
    if (this.captureId === '') throw new VtuberError('capture/not-found', '还没 open 就推帧', '先调 capture/open')
    const dataUrl = 'data:image/jpeg;base64,' + Buffer.from(jpeg).toString('base64')
    const out = await this.#call('POST', 'capture/frame', { captureId: this.captureId, jpeg: dataUrl })
    return out
  }

  /** 推一块 16bit 单声道 PCM（vtuber 侧按 mic.vad 断句）。 */
  async pcm(chunk, sampleRate) {
    if (this.captureId === '') throw new VtuberError('capture/not-found', '还没 open 就推音频', '先调 capture/open')
    const out = await this.#call('POST', 'capture/pcm', {
      captureId: this.captureId,
      pcm: Buffer.from(chunk).toString('base64'),
      sampleRate: Number(sampleRate) || 16000,
    })
    return out
  }

  /** 纯音频流的心跳（没有帧可推时用，否则会被判 stalled/lost）。 */
  async ping() {
    if (this.captureId === '') return null
    return this.#call('POST', 'capture/ping', { captureId: this.captureId })
  }

  /** 撤销这路采集。哪怕失败也只记日志，不再抛（收尾不该把工具调用拖挂）。 */
  async close(reason = 'closed') {
    if (this.captureId === '') return null
    const id = this.captureId
    this.captureId = ''
    try {
      return await this.#call('POST', 'capture/close', { captureId: id, reason })
    } catch (error) {
      this.logger?.warn?.('[muse_galaxy] 关闭采集失败（' + id + '）：' + (error && error.message ? error.message : error))
      return null
    }
  }
}
