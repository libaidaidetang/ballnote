// 软件更新（GitHub Releases 源）：
// - 检查更新：GET api.github.com/repos/{owner}/{repo}/releases/latest，比较 tag_name 与当前版本
// - 下载更新：取 release 资产中的 Windows 安装包（.exe），流式下载到 temp 并广播进度
// - 安装更新：启动安装程序后退出应用（NSIS /S 静默参数经 settings.updateSilent 配置）
// 说明：仓库尚未创建时检查会返回 404/网络错误，属预期——功能先行，仓库就绪即生效。
// 更新源默认值在 DEFAULT_REPO 常量，仓库确定后在设置页填 owner/repo 即可。

import { app, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { loadStore } from './store'
import type { UpdateState } from '../shared/models'

/** 默认 GitHub 仓库（owner/repo）：仓库上传后可在设置页覆盖 */
const DEFAULT_REPO = 'your-name/ballwork'

export interface UpdateSettings {
  /** 是否自动检查更新（后台运行时） */
  autoCheckEnabled?: boolean
  /** GitHub 仓库（owner/repo），空则用 DEFAULT_REPO */
  updateRepo?: string
  /** 下载完成安装时静默执行（NSIS /S），默认交互式 */
  updateSilent?: boolean
}

/** 更新状态机（广播给渲染层展示进度与按钮态）；类型定义见 shared/models.ts */
export type { UpdateState } from '../shared/models'

let state: UpdateState = { phase: 'idle', currentVersion: app.getVersion() }
let statusListener: ((s: UpdateState) => void) | null = null
let downloading = false   // 防重复下载
let checking = false      // 防重复检查
/** available 状态下记录的下载目标（asset 元数据） */
let pendingAsset: { url: string; name: string; size?: number } | null = null

function setState(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch }
  try { statusListener?.(state) } catch { /* 监听方异常不影响主流程 */ }
}

export function getUpdateState(): UpdateState {
  return state
}

export function onUpdateStatus(cb: (s: UpdateState) => void): void {
  statusListener = cb
}

function cfg(): UpdateSettings {
  return loadStore<Record<string, unknown>>('settings') as UpdateSettings
}

function repoOf(): string {
  const r = String(cfg().updateRepo ?? '').trim()
  return /^[\w.-]+\/[\w.-]+$/.test(r) ? r : DEFAULT_REPO
}

/** 宽松 semver 比较：返回 1(a>b) / 0(相等) / -1(a<b)；忽略 v 前缀，非数字段按 0 处理 */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split(/[.+-]/).map((x) => parseInt(x, 10) || 0)
  const pb = b.replace(/^v/i, '').split(/[.+-]/).map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0) ? 1 : -1
  }
  return 0
}

/** 检查更新：有新版本置 available（不自动下载），无新版本置 up-to-date */
export async function checkForUpdate(): Promise<UpdateState> {
  if (checking) return state
  checking = true
  setState({ phase: 'checking', error: undefined })
  try {
    const resp = await fetch(`https://api.github.com/repos/${repoOf()}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'BallWork-Updater' },
      signal: AbortSignal.timeout(15000),
    })
    if (resp.status === 404) {
      setState({ phase: 'error', error: '仓库尚无 release（请确认已创建并发布版本）' })
      return state
    }
    if (!resp.ok) {
      setState({ phase: 'error', error: `检查失败：GitHub 返回 ${resp.status}` })
      return state
    }
    const rel = await resp.json() as {
      tag_name?: string
      body?: string
      html_url?: string
      assets?: { name?: string; browser_download_url?: string; size?: number }[]
    }
    const latest = String(rel.tag_name ?? '').trim()
    if (!latest) {
      setState({ phase: 'error', error: 'release 数据缺少 tag_name' })
      return state
    }
    // Windows 安装包资产：优先 .exe；无 .exe 时仅提示可去 release 页手动下载
    const asset = (rel.assets ?? []).find((a) => /\.exe$/i.test(String(a.name ?? '')))
    const common: Partial<UpdateState> = {
      latestVersion: latest,
      releaseNotes: String(rel.body ?? '').slice(0, 2000),
      releaseUrl: String(rel.html_url ?? ''),
    }
    if (compareVersions(latest, state.currentVersion) > 0) {
      pendingAsset = asset?.browser_download_url
        ? { url: asset.browser_download_url, name: String(asset.name ?? 'setup.exe'), size: asset.size }
        : null
      setState({ ...common, phase: 'available' })
    } else {
      pendingAsset = null
      setState({ ...common, phase: 'up-to-date' })
    }
    return state
  } catch (err) {
    const msg = err instanceof Error && err.name === 'TimeoutError'
      ? '检查超时，请检查网络'
      : `检查失败：${err instanceof Error ? err.message : String(err)}`
    setState({ phase: 'error', error: msg })
    return state
  } finally {
    checking = false
  }
}

/** 下载更新安装包到 temp：流式写盘 + 进度节流广播；完成后置 ready-to-install */
export async function downloadUpdate(win?: BrowserWindow | null): Promise<UpdateState> {
  if (downloading) return state
  if (!pendingAsset?.url) {
    setState({ phase: 'error', error: '没有可下载的更新包（release 缺少 .exe 资产）' })
    return state
  }
  downloading = true
  const dir = path.join(app.getPath('temp'), 'ballwork-update')
  const file = path.join(dir, pendingAsset.name)
  let lastBroadcast = 0
  try {
    fs.mkdirSync(dir, { recursive: true })
    setState({ phase: 'downloading', progressPercent: 0, downloadedBytes: 0, totalBytes: pendingAsset.size, filePath: file, error: undefined })
    const resp = await fetch(pendingAsset.url, {
      headers: { 'User-Agent': 'BallWork-Updater' },
      signal: AbortSignal.timeout(10 * 60_000),
    })
    if (!resp.ok || !resp.body) throw new Error(`下载失败：HTTP ${resp.status}`)
    const total = Number(resp.headers.get('content-length') ?? '') || (pendingAsset.size ?? 0)
    let received = 0
    const chunks: Buffer[] = []
    const reader = resp.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(Buffer.from(value))
      received += value.byteLength
      const now = Date.now()
      if (now - lastBroadcast > 300) {   // 进度广播节流 300ms
        lastBroadcast = now
        setState({
          phase: 'downloading',
          downloadedBytes: received,
          totalBytes: total || undefined,
          progressPercent: total ? Math.min(100, Math.round((received / total) * 100)) : undefined,
        })
      }
    }
    fs.writeFileSync(file, Buffer.concat(chunks))
    setState({ phase: 'ready-to-install', progressPercent: 100, filePath: file })
    return state
  } catch (err) {
    try { if (fs.existsSync(file)) fs.rmSync(file, { force: true }) } catch { /* 清理失败忽略 */ }
    downloading = false
    setState({ phase: 'error', error: `下载失败：${err instanceof Error ? err.message : String(err)}` })
    return state
  } finally {
    downloading = false
  }
}

/** 安装更新：启动下载好的安装程序（可选 NSIS 静默 /S）后退出应用 */
export function installUpdate(): boolean {
  if (state.phase !== 'ready-to-install' || !state.filePath || !fs.existsSync(state.filePath)) {
    setState({ phase: 'error', error: '没有待安装的更新包' })
    return false
  }
  const args = cfg().updateSilent === true ? ['/S'] : []
  try {
    spawn(state.filePath, args, { detached: true, stdio: 'ignore' }).unref()
    app.quit()   // 让出安装程序；未保存笔记由既有 close flush 流程兜底
    return true
  } catch (err) {
    setState({ phase: 'error', error: `启动安装程序失败：${err instanceof Error ? err.message : String(err)}` })
    return false
  }
}

/** 后台自动检查：启动 30s 后首查，之后每 24h 一次；仅打包版启用（开发模式避免无谓请求）。
 *  每次读取设置页开关（autoCheckEnabled === true 才查）。 */
export function startAutoCheck(): void {
  if (!app.isPackaged) return
  const tick = () => {
    void (async () => {
      if (cfg().autoCheckEnabled === true) await checkForUpdate()
    })()
  }
  setTimeout(tick, 30_000)
  setInterval(tick, 24 * 60 * 60 * 1000)
}
