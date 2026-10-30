# muse_galaxy

**muse_vtuber 的采集器**（DSH 的输入侧）。

一句话：把「本地视频/音频文件、网络资源、直播流」解码成 **JPEG 帧 + 16k PCM**，推给
[muse_vtuber](../muse_vtuber) 的采集口。**取帧策略、断句阈值、识别、限流、插话全在 vtuber**，
这里只负责取流与搬运。

```
galaxy_path / galaxy_rtsp …           ← 工具（本插件）
   ↓ yt-dlp（要的话）→ ffmpeg 解码
   ↓ POST /vtuber/api/capture/frame   （JPEG 帧，按 vtuber 给的 want.fps / want.width）
   ↓ POST /vtuber/api/capture/pcm     （16k 单声道 PCM，200ms 一块）
muse_vtuber：MJPEG 面板 + vision.autoIntervalMs 自动识图 + mic.vad 断句 → ASR → 插话进会话
```

和旧实现（`muse_galaxy_watch` / `muse_galaxy_bili_live` + galaxy 云网关 + mediamtx + websockets）
**不兼容**，旧代码已删除：消费者只有 muse_vtuber 一个，本机 RTSP 汇聚和云端识图都不再需要。

## 工具

| 工具 | 说明 | 状态 |
|---|---|---|
| `galaxy_path` | 一次性资源：本地文件 / 直链 / 视频站点 URL（先过 yt-dlp）。**播完即停，不循环** | ✅ P0 |
| `galaxy_rtsp` | 直播流：`rtsp://` / `rtmp://` / `m3u8` / `flv`，采到源断或 `galaxy_stop` | ✅ P0 |
| `galaxy_path_bilibili` | B 站视频（BV/av/URL），复用 `mira_bilibili` 登录态 | ✅ P1 |
| `galaxy_rtsp_bilibili` | B 站直播（短号/房间号/URL），**断流自动换节点重连** | ✅ P2 |
| `galaxy_status` | 当前/最近任务：帧数、丢帧、音频块、错误、用时 | ✅ |
| `galaxy_stop` | 停止一路（不传 `streamId` = 全部） | ✅ |

调用 `galaxy_path` 立即返回 `streamId`（不阻塞播放），画面在「形象」页签的「视频」卡片里，
识别结果由 vtuber 决定（`vision.autoIntervalMs` 自动识图、`mic.vad` 断句后自动插话）。

## B 站（P1 / P2）怎么取流

两台机器的分工是**把后台和流分开**：

```
mira_bilibili  → 登录态 / 私信 / 弹幕 / 直播事件（后台）
muse_galaxy    → 视频 URL、直播间号 → ffmpeg 能吃的直链（流）
muse_vtuber    → 取帧识别 / 断句识别 / 说话（感知与表达）
```

### 视频（P1）

`galaxy_path_bilibili BV1xx411c7mD`：

1. 读 `~/.dsh/mira_config/mira_account/creds/<accountId>.json` 的 `fields.{SESSDATA,bili_jct,buvid3,buvid4}`；
2. 写成 Netscape `cookies.txt`（**临时文件、权限 600、解析完立刻删**）；
3. `yt-dlp -g -f bv*/b` 和 `-f ba/b` 分别拿音视频直链（DASH 是两条），交给两个 ffmpeg。

### 直播（P2）

`galaxy_rtsp_bilibili 12345678`：

1. `room_init` 拿真实 room_id + `live_status`（短号/URL 都行）；
2. `getRoomPlayInfo` 拿候选流地址；**avc 优先、hevc 垫底**（实测 hevc 节点要么 403 要么 I/O error）；
3. **开播前预探测**：按真实解码管线各试 2.5 秒，挑到能出帧的节点再开（B 站 CDN 随机 403，实测 5 个里 4 个坏）；
4. 断流 → 退避 0.8s×n 换下一个候选；候选用完就重新解析一批，最多 `bili.maxReconnects` 次。

> **两个踩过的坑（都是实测）**
> 1. 直播流的 Referer 必须是 `https://live.bilibili.com/<房间号>`（房间号从流地址的 `cid=` 取）。
>    只给域名时节点能出几秒画面然后 403；给 `www.bilibili.com` 则一帧都没有。
> 2. 探测必须走**和真实解码一样的管线**（同组 headers / `-vf` / mjpeg 输出）：
>    `-f null` 那种"能解 1.5 秒"的探测会把坏节点判成好的。

### 与弹幕/私信的关系

本插件**不碰**弹幕和私信——那是 `mira_bilibili` 的账。两边共享同一份 `mira_account` 凭据，
所以「看直播画面」和「回弹幕/私信」是两个独立通道，互不阻塞。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉后不注册任何工具 |
| `vtuber.baseUrl` | `http://127.0.0.1:3080` | muse_vtuber 所在宿主 |
| `vtuber.tokenFile` | `""` | 留空 = `$DSH_HOME/mira_config/muse_vtuber/capture.json`（**由 vtuber 生成**，600） |
| `bili.accountId` | `bili-main` | 用哪个账号的凭据（读 `mira_account/creds/<id>.json`） |
| `bili.credsFile` | `""` | 留空 = 按 `accountId` 拼；也可以直接指一个文件 |
| `bili.maxReconnects` | `8` | 直播断流最多重连几次（用尽收尾） |
| `bili.reconnectDelayMs` | `800` | 重连退避基数（第 n 次等 n×这个值，封顶 3 倍、上限 30s） |
| `bili.probeCandidates` | `6` | 开播前探测几个候选节点 |
| `vtuber.timeoutMs` | `20000` | 单次 HTTP 超时 |
| `media.ffmpeg` | `ffmpeg` | 可执行文件名或绝对路径 |
| `media.ytdlp` | `yt-dlp` | 同上，也接受带参数的形式（如 `python -m yt_dlp`）；直链/本地文件不需要它 |
| `media.sampleRate` | `16000` | 送 vtuber 的 PCM 采样率（与它的 `mic.sampleRate` 一致） |
| `media.chunkMs` | `200` | PCM 分块大小 |
| `maxSeconds` | `3600` | 单路硬上限（防直播忘关；path 播完不受影响） |

## 依赖

- Node 内置模块（零 npm 依赖）
- 本机 `ffmpeg`（必需）、`yt-dlp`（解析视频站点页面 URL 用；本机走 `python -m pip install yt-dlp`）

## 站点视频（DASH）怎么处理

B 站/YouTube 是 DASH：**音视频分开**成两条地址。本插件的流水线本来就是「画面一个 ffmpeg、
声音一个 ffmpeg」，所以 `resolveSource()` 调 **两次** yt-dlp：

```
video ← yt-dlp -g -f 'bv*'（退 'b'）
audio ← yt-dlp -g -f 'ba'（退 'b'）
```

只取一次 `-g` 的第一行会拿到**没有声音的视频轨**（真实踩过：B 站第一行是 video-only）。

B 站 CDN（`bilivideo` / `mcdn`）会校验 Referer/UA，不带就 403，所以对这类地址自动加
`-user_agent` 与 `Referer: https://www.bilibili.com/`（见 `httpHeadersFor()`）。

## 前置：muse_vtuber 必须支持采集口

`GET /vtuber/api/health` 里 `features.capture` 齐全（`open/frame/pcm/close/ping/stream`）才行。
令牌文件由 vtuber 生成；它没有该文件时会自动创建。

## 前置：调用者要有「观众权限」

vtuber 是个有主人的账号（见 [muse_vtuber README §4.1](../muse_vtuber/README.md)）：
`capture/open` 属于**接收**，要求调用会话是 `observer` 或 `taker`。

- 从**会话里**调 `galaxy_path` / `galaxy_rtsp` 会自动带上 `sessionId`；
  第一次"看/听"时 vtuber 会把它自动登记成 `observer`（`security.autoObserve`）。
- 用 curl / 脚本直接调 `capture/open` 而**不带 `sessionId`** → `403 authz/no-session`
  （令牌只证明"能进这个口"，不证明"有资格用形象"）。

## 自检

```bash
# 对**正在运行的** dsh web 跑一遍真解码（会现造一段「彩条 + 人声」mp4）
# --session 是必须的：capture/open 属于「接收」，要 observer/taker 权限；
# 不带会话身份会被 vtuber 403 authz/no-session 拒掉（实测踩过）。
# 给个不存在的会话 id 也行：autoObserve 会把它登记成 observer，插话不打扰你自己的会话。
node test/live-path.mjs --session session-galaxy-selftest
# 只测采集口往返延迟
node test/latency.mjs            # 会话身份用环境变量 DSH_SESSION_ID
```

注意：这两个脚本会让 ffmpeg 走管道（stdio: pipe），在**受限沙箱**里跑会 `spawn EPERM`
（宿主不允许子进程开命名管道）；脚本本身没问题，换个不受限的 shell 或放宽沙箱即可。

`live-path.mjs` 会打印：`galaxy_status` 的推帧/丢帧/音频块，和 vtuber 侧看到的
`frames / pcmChunks / audioChunks(断句) / lastPercept(识别文本)`。

## 已知取舍

1. **画面与声音各起一个 ffmpeg**：实现简单、互不拖累，代价是解码两次（1–2 核占用）。
2. **帧是"尽量新"**：队列串行送（深度 32 帧），队列满丢最旧的 —— 面板要的是最新画面，
   不是补帧。深度必须按帧率给：8fps 时 8 帧只有 1 秒缓冲，成簇一冲就丢（实测 51 帧丢 9）；
   加到 32 帧后 8fps/720 实测 **51 帧丢 0**。
3. **不做识别/抽帧判断**：这些策略属于 vtuber（`vision.autoIntervalMs`、`mic.vad`），
   采集器只有 `open` 返回的 `want`。
4. **通用 `galaxy_rtsp` 不做重连**：给的地址断了就结束。断流重连只给 `galaxy_rtsp_bilibili`
   开（它能重新解析候选节点）；想让普通 rtsp 也重连，可以后续加一个"同一地址重试"的开关。
5. **`galaxy_path_bilibili` 的 cookies 是临时文件**：解析完立刻删；只有 `yt-dlp` 那一瞬间能看到，
   解码阶段用的是直链（B 站直链带签名，不再需要 cookie）。
