// 标准 GitHub Releases 更新器（electron-updater）：
// 使用 electron-builder 生成的 latest.yml / .blockmap / NSIS 安装包，不再手写下载 .exe 和覆盖安装。
// 策略：后台自动检查；发现新版后用户手动下载、手动确认安装，不自动重启或打断未保存内容。

import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { autoUpdater, type UpdateInfo } from 'electron-updater'
import { loadStore } from './store'
import type { UpdateState } from '../shared/models'

const OWNER = 'libaidaidetang'
const REPO = 'ballnote'

interface UpdateSettings {
  autoCheckEnabled?: boolean
}

let state: UpdateState = { phase: 'idle', currentVersion: app.getVersion() }
let statusListener: ((s: UpdateState) => void) | null = null
let configured = false
let checking = false
let downloading = false

function setState(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch }
  try { statusListener?.(state) } catch { /* 状态监听异常不影响更新流程 */ }
}

function releaseNotesOf(info: UpdateInfo): string | undefined {
  const notes = info.releaseNotes
  if (typeof notes === 'string') return notes.slice(0, 2000)
  if (Array.isArray(notes)) return notes.map((n) => n.note).filter(Boolean).join('\n').slice(0, 2000)
  return undefined
}

/** electron-updater 只在打包安装版有完整的 app-update.yml；开发模式保留友好错误而不访问 GitHub。 */
function ensureConfigured(): boolean {
  if (!app.isPackaged) {
    setState({ phase: 'error', error: '开发模式不检查更新；请运行已安装的正式版测试更新功能' })
    return false
  }
  if (configured) return true
  configured = true
  autoUpdater.autoDownload = false          // 用户选择“手动下载/安装”
  autoUpdater.autoInstallOnAppQuit = false  // 用户明确点击“安装并重启”才安装
  autoUpdater.autoRunAppAfterInstall = true
  autoUpdater.setFeedURL({ provider: 'github', owner: OWNER, repo: REPO, private: false })

  autoUpdater.on('checking-for-update', () => setState({ phase: 'checking', error: undefined }))
  autoUpdater.on('update-available', (info) => setState({
    phase: 'available', latestVersion: info.version,
    releaseNotes: releaseNotesOf(info), releaseUrl: info.releaseName ?? undefined,
    error: undefined,
  }))
  autoUpdater.on('update-not-available', (info) => setState({
    phase: 'up-to-date', latestVersion: info.version,
    releaseNotes: releaseNotesOf(info), error: undefined,
  }))
  autoUpdater.on('download-progress', (p) => setState({
    phase: 'downloading', progressPercent: Math.round(p.percent),
    downloadedBytes: p.transferred, totalBytes: p.total,
  }))
  autoUpdater.on('update-downloaded', (info) => setState({
    phase: 'ready-to-install', latestVersion: info.version,
    releaseNotes: releaseNotesOf(info), progressPercent: 100,
  }))
  autoUpdater.on('error', (err) => setState({
    phase: 'error', error: `更新失败：${err.message}`,
  }))
  return true
}

export function getUpdateState(): UpdateState {
  return state
}

export function onUpdateStatus(cb: (s: UpdateState) => void): void {
  statusListener = cb
}

/** 手动或后台检查：只检查，不自动下载。 */
export async function checkForUpdate(): Promise<UpdateState> {
  if (checking || !ensureConfigured()) return state
  checking = true
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    setState({ phase: 'error', error: `检查失败：${err instanceof Error ? err.message : String(err)}` })
  } finally {
    checking = false
  }
  return state
}

/** 用户确认后下载：electron-updater 会读取 latest.yml、校验文件并利用 blockmap 增量下载。 */
export async function downloadUpdate(): Promise<UpdateState> {
  if (downloading || !ensureConfigured()) return state
  if (state.phase !== 'available') {
    setState({ phase: 'error', error: '没有待下载的更新' })
    return state
  }
  downloading = true
  setState({ phase: 'downloading', progressPercent: 0, downloadedBytes: 0, error: undefined })
  try {
    await autoUpdater.downloadUpdate()
  } catch (err) {
    setState({ phase: 'error', error: `下载失败：${err instanceof Error ? err.message : String(err)}` })
  } finally {
    downloading = false
  }
  return state
}

/** 安装前快照：只备份用户可编辑配置（笔记/书库/闪念/日历/草稿/AI 设置），
 *  不备份可由 config 重建的 books/ 目录树与封面/图片资产，避免每次更新复制大量文件。
 *  最近保留 2 份。备份失败时拒绝开始安装，宁可不更新也不削弱恢复能力。 */
function backupBeforeInstall(): string {
  const root = app.getPath('userData')
  const source = path.join(root, 'config')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = path.join(root, 'backups', `pre-update-${stamp}`, 'config')
  if (!fs.existsSync(source)) return ''   // 首次运行尚无任何数据，无需创建空备份
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: true })

  // 备份目录按名称（ISO 时间）排序，删旧留新，避免长期积累占空间
  const backups = path.join(root, 'backups')
  const old = fs.readdirSync(backups, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('pre-update-'))
    .map((e) => e.name)
    .sort()
  for (const name of old.slice(0, Math.max(0, old.length - 2))) {
    fs.rmSync(path.join(backups, name), { recursive: true, force: true })
  }
  return path.dirname(target)
}

/** 用户明确确认后安装并重启：先完成可恢复数据快照，再走 electron-updater 的 NSIS 标准替换流程。 */
export function installUpdate(): boolean {
  if (state.phase !== 'ready-to-install') {
    setState({ phase: 'error', error: '没有已下载的更新' })
    return false
  }
  try {
    const backupPath = backupBeforeInstall()
    if (backupPath) console.info('[updater] pre-update backup created:', backupPath)
  } catch (err) {
    setState({ phase: 'error', error: `更新前备份失败，已取消安装：${err instanceof Error ? err.message : String(err)}` })
    return false
  }
  autoUpdater.quitAndInstall(false, true)
  return true
}

/** 打包版启动 30 秒后、此后每 24h 自动检查；严格尊重设置页开关。 */
export function startAutoCheck(): void {
  if (!app.isPackaged) return
  const tick = () => {
    const settings = loadStore<UpdateSettings>('settings')
    if (settings.autoCheckEnabled === true) void checkForUpdate()
  }
  setTimeout(tick, 30_000)
  setInterval(tick, 24 * 60 * 60 * 1000)
}
