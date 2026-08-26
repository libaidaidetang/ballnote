import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, screen, shell, Tray } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { EdgeService } from './edge'
import { aiChat, aiReview } from './ai'
import { loadStore, loadWindowSizes, saveStore, saveWindowSize } from './store'
import { onResizePointer } from './resize'
import { getTodayKey, sync as syncTime } from './timesync'
import {
  checkForUpdate, downloadUpdate, getUpdateState, installUpdate,
  onUpdateStatus, startAutoCheck,
} from './updater'
import { searchDouban, searchWeread, fetchDoubanChapters } from './booksearch'
import { buildDocx } from './docx'
import { syncBookTree, packBook, packBooks, findBookDir, migrateBookStore } from './bookshelf'
import {
  SIZES, createBallWindow, createBubbleWindow,
  createMenuWindow, createPageWindow, createStickyWindow,
  cursorDip, entranceAnimation, entryUrl, moveWindowTo, workArea, workAreaOf,
} from './windows'
import type { PageKind, StoreKey, WindowKind } from '../shared/models'

// ===================== 用户数据根目录（跨版本稳定） =====================
// 绝不能跟随 productName（BallWork → BallNote）变化：否则安装更新后 Electron 会创建新的
// %APPDATA%/BallNote 空目录，用户会误以为书籍/笔记丢失。固定沿用历史数据目录 %APPDATA%/ball-re。
// 必须在 app.whenReady() 前调用，随后所有 store/covers/note-images/books 都读取同一根目录。
app.setPath('userData', path.join(app.getPath('appData'), 'ball-re'))

// ===================== 单实例 =====================
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showBallWindow()
  })
  app.whenReady().then(() => {
    init()
  }).catch((err) => {
    // 初始化失败（窗口/托盘/IPC 注册抛错）不能静默成无托盘僵尸进程：弹窗告知后退出
    console.error('[main] init failed', err)
    try { dialog.showErrorBox('BallWork 启动失败', String(err instanceof Error ? err.stack ?? err.message : err)) } catch { /* 忽略 */ }
    app.exit(1)
  })
}

// 渲染进程 console 错误转发到主进程 stdout（便于排查崩溃/白屏）
app.on('web-contents-created', (_e, contents) => {
  contents.on('console-message', (_ev, level, message) => {
    if (level >= 2) console.log('[renderer]', message)
  })
})

// 所有窗口统一导航加固（deny window.open / will-navigate 白名单），含未来新增的 webContents
app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() === 'window') {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const selfOriginPrefix = process.env.VITE_DEV_SERVER_URL
      ?? pathToFileURL(path.join(app.getAppPath(), 'dist', 'index.html')).toString().split('#')[0]
    contents.on('will-navigate', (e, url) => {
      if (url.startsWith(selfOriginPrefix)) return
      e.preventDefault()
    })
  }
})

// ===================== 全局窗口引用 =====================
let ballWin: BrowserWindow | null = null
let menuWin: BrowserWindow | null = null
let bubbleWin: BrowserWindow | null = null
let edge: EdgeService | null = null
let tray: Tray | null = null

// 页面窗口按 kind 缓存（多页面并存，单 kind 单窗）
const pageWins = new Map<PageKind, BrowserWindow>()

// 球窗拖动状态（渲染层上报指针事件，主进程维护跟手移动）
interface DragState { cursor: { x: number; y: number }; bounds: Electron.Rectangle; dragging: boolean }
let downState: DragState | null = null

// 书籍目录树同步队列（串行，避免并发写 tmp 目录冲突；失败仅记录，不阻塞保存）
let treeSyncChain: Promise<void> = Promise.resolve()
function queueTreeSync(books: import('../shared/models').BookStore, folders?: import('../shared/models').FolderStoreData): void {
  treeSyncChain = treeSyncChain
    .then(() => syncBookTree(books, folders))
    .catch((err) => console.error('[bookshelf] 目录树同步失败', err))
}

function showBallWindow(): void {
  if (ballWin && !ballWin.isDestroyed()) {
    ballWin.show()
    ballWin.focus()
    tray?.displayBalloon({ title: 'BallWork', content: 'BallWork 已在运行' })
  }
}

// ===================== 托盘 =====================
function createTray(): void {
  const iconPath = path.join(app.getAppPath(), 'assets', 'faya.png')
  const icon = nativeImage.createFromPath(iconPath)
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }))
  const menu = Menu.buildFromTemplate([
    { label: '显示悬浮球', click: () => showBallWindow() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ])
  tray.setToolTip('BallWork 悬浮球')
  tray.setContextMenu(menu)
  tray.on('double-click', () => showBallWindow())
}

// ===================== 菜单窗定位 =====================
// 菜单圆心精确对齐球主体中心（球 60×60 位于窗口内 (10,10)，中心 (40,40)）
function positionMenuWindow(): void {
  if (!ballWin || !menuWin || ballWin.isDestroyed() || menuWin.isDestroyed()) return
  const b = ballWin.getBounds()
  const cx = b.x + 40
  const cy = b.y + 40
  const wa = workAreaOf(ballWin)
  const toRight = cx < wa.x + wa.width / 2
  const centerX = toRight ? 20 : 145
  menuWin.setPosition(Math.round(cx - centerX), Math.round(cy - SIZES.MENU_H / 2))
}

/**
 * 向窗口发送 IPC 消息；若页面仍在加载（监听器未注册）则等 did-finish-load 后再发，
 * 避免启动后首次触发（菜单/气泡）消息丢失。
 */
function sendWhenReady(win: BrowserWindow, channel: string, payload: unknown): void {
  const wc = win.webContents
  if (!wc.isLoading()) {
    wc.send(channel, payload)
    return
  }
  wc.once('did-finish-load', () => {
    if (!win.isDestroyed()) wc.send(channel, payload)
  })
}

function showMenu(): void {
  if (!ballWin || !menuWin || ballWin.isDestroyed() || menuWin.isDestroyed()) return
  const wa = workAreaOf(ballWin)
  const b = ballWin.getBounds()
  const cx = b.x + b.width / 2
  const toRight = cx < wa.x + wa.width / 2
  // 每次展开重新读取菜单配置（设置页保存后天然热重载）
  const menus = loadStore<{ items: { title: string; action: string }[] }>('menus')
  sendWhenReady(menuWin, 'menu:set-items', { items: menus.items, toRight })
  positionMenuWindow()
  menuWin.show()
}

function hideMenu(): void {
  if (menuWin && !menuWin.isDestroyed()) menuWin.hide()
}

// ===================== 页面窗口 =====================

/** 图书馆窗口关闭前：通知渲染层 flush 全部脏笔记草稿（直接关窗/退出/重启不丢未保存改动）。
 *  渲染层完成（page:flush-done ack）或 1.5s 超时兜底后才 destroy 窗口，避免卡住关闭。 */
function hookDraftFlush(win: BrowserWindow): void {
  let finished = false
  let closing = false   // 防重入：close 可被 preventDefault 后再次触发，不重复挂监听器
  const onFlushDone = (ev: Electron.IpcMainEvent): void => {
    if (ev.sender === win.webContents) finish()
  }
  const finish = (): void => {
    if (finished) return
    finished = true
    ipcMain.removeListener('page:flush-done', onFlushDone)
    if (!win.isDestroyed()) win.destroy()
  }
  win.on('close', (e) => {
    if (finished || closing || win.isDestroyed() || win.webContents.isDestroyed()) return
    e.preventDefault()
    closing = true
    try { win.webContents.send('page:flush-drafts') } catch { /* 渲染层异常：走超时兜底 */ }
    ipcMain.on('page:flush-done', onFlushDone)
    setTimeout(finish, 1500)
  })
}

function openPage(kind: PageKind): void {
  const existing = pageWins.get(kind)
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    return
  }
  const saved = loadWindowSizes()['page:' + kind]
  const win = createPageWindow(kind, saved)
  pageWins.set(kind, win)
  win.on('closed', () => pageWins.delete(kind))
  // 图书馆窗口承载笔记编辑：关闭前先让渲染层 flush 草稿
  if (kind === 'library') hookDraftFlush(win)
  // 渲染进程异常（崩溃/挂起）自动重新加载，避免窗口透明无响应；
  // 连续崩溃限速：10s 内超过 3 次停止自动重启（防 OOM 等场景无限重启循环）
  const crashTimes: number[] = []
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return
    const now = Date.now()
    while (crashTimes.length && now - crashTimes[0] > 10000) crashTimes.shift()
    crashTimes.push(now)
    if (crashTimes.length <= 3) win.webContents.reload()
    else console.error('[main] render process crashed repeatedly, auto-reload stopped', details.reason)
  })
  // 最大化/还原：走系统 maximize（无边框窗口同样可靠），并广播状态给渲染层，
  // 使"按钮点击"与"Win11 拖到顶部贴靠"两种来源统一——渲染层据此去掉圆角/边距占满屏幕
  win.on('maximize', () => {
    if (!win.isDestroyed()) win.webContents.send('page:maximized', true)
  })
  win.on('unmaximize', () => {
    if (!win.isDestroyed()) win.webContents.send('page:maximized', false)
  })
  // 先置透明再显示 + 入场动画：避免"白屏显示 → 突然透明 → 淡入"的闪烁（窗口 show:false 创建）
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return
    win.setOpacity(0)
    win.show()
    void entranceAnimation(win)
  })
}

// ===================== IPC 注册 =====================
// registerIpc 按域拆分为多个注册函数（ball/menu/page/sticky/note/file/store/app），
// 共享主进程模块级状态（ballWin/menuWin/bubbleWin/edge/pageWins 等），行为与原单函数版完全一致。

function registerBallIpc(): void {
  // ---- 悬浮球：拖动状态机（渲染层上报指针事件，主进程跟手移动窗口） ----
  // 位移用主进程 screen.getCursorScreenPoint()（DIP）计算：渲染层 screenX/screenY 已是
  // DIP，若再除 scaleFactor 会在高 DPI 下位移缩水、跟手错位。
  ipcMain.handle('ball:pointer', (_e, msg: { type: 'down' | 'move' | 'up'; screenX: number; screenY: number } | null) => {
    const { type } = msg ?? {} as { type?: string }
    if (!type) return { moved: false }
    if (!ballWin || ballWin.isDestroyed()) return { moved: false }
    if (type === 'down') {
      const c = screen.getCursorScreenPoint()
      downState = { cursor: { x: c.x, y: c.y }, bounds: ballWin.getBounds(), dragging: false }
      edge?.stop()
      return { moved: false }
    }
    if (type === 'move') {
      if (!downState) return { moved: false }
      const c = screen.getCursorScreenPoint()
      const dx = c.x - downState.cursor.x
      const dy = c.y - downState.cursor.y
      if (!downState.dragging && (Math.abs(dx) > 6 || Math.abs(dy) > 6)) {
        downState.dragging = true
        if (menuWin?.isVisible()) hideMenu()     // 拖拽开始：隐藏展开中的菜单
        if (bubbleWin?.isVisible()) bubbleWin.hide()  // 拖拽开始：隐藏抚摸气泡（气泡窗不跟随）
      }
      if (downState.dragging) {
        moveWindowTo(ballWin, downState.bounds.x + dx, downState.bounds.y + dy)
      }
      return { moved: downState.dragging }
    }
    if (type === 'up') {
      const moved = downState?.dragging ?? false
      if (downState) {
        if (moved) {
          const b = ballWin.getBounds()
          edge?.onDragEnd(b.x, b.y)   // 拖拽结束：恢复贴边检测 + 禁区弹回
        } else {
          edge?.start()               // 未拖动：恢复贴边检测（长按/单击候选）
        }
      }
      downState = null
      return { moved }
    }
    return { moved: false }
  })
  ipcMain.on('ball:single-click', () => {
    edge?.onSingleClick()
  })
  ipcMain.on('ball:hover', (_e, state: string) => {
    if (state === 'enter') edge?.onHoverEnter()
    else edge?.onHoverLeave()
  })
  ipcMain.on('ball:toggle-menu', () => {
    if (menuWin && menuWin.isVisible()) hideMenu()
    else showMenu()
  })
  ipcMain.handle('ball:work-area', () => workArea())
  ipcMain.handle('ball:cursor', () => cursorDip())
  ipcMain.handle('ball:bounds', () => ballWin?.getBounds() ?? null)

  // ---- 菜单 ----
  ipcMain.on('menu:item-click', (_e, action: string) => {
    hideMenu()
    if (action === 'settings') openPage('settings')
    else if (action === 'library') openPage('library')
    else if (action === 'sketch') openPage('sketch')
    else if (action === 'ai') openPage('ai')
    // 无效 action：静默忽略（菜单已关闭，保持与 WPF 行为一致）
  })

  // ---- 抚摸气泡 ----
  ipcMain.on('ball:bubble', (_e, payload: { content: unknown; toRight: boolean }) => {
    showBubble(payload.content, payload.toRight)
  })
  ipcMain.on('bubble:hide', () => {
    if (bubbleWin && !bubbleWin.isDestroyed()) bubbleWin.hide()
  })
}

function registerPageIpc(): void {
  // ---- 页面窗口 ----
  ipcMain.on('page:minimize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    win?.minimize()
  })
  // 最大化/还原（系统级：无边框透明窗口同样触发 maximize/unmaximize 事件，
  // 渲染层收到 page:maximized 后去掉圆角与透明边距占满屏幕；Win11 拖到顶部贴靠走同一路径）
  ipcMain.on('page:maximize-toggle', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on('page:close', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.close()
  })
  // 自绘 resize 热点（8 方向）；松手时持久化页面窗口尺寸
  ipcMain.on('page:resize-pointer', (e, msg: { type: 'down' | 'move' | 'up'; screenX: number; screenY: number; dir: import('../shared/models').ResizeDir }) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    onResizePointer(win, msg)
    if (msg.type === 'up') {
      const entry = [...pageWins.entries()].find(([, w]) => w === win)
      if (entry) {
        const b = win.getBounds()
        saveWindowSize('page:' + entry[0], b.width, b.height)
      }
    }
  })

  // ---- 便利贴 / 书籍详情 ----
  ipcMain.on('sticky:open', () => openSticky())
  ipcMain.on('sticky:edit', (_e, id: number) => openSticky(id))
  ipcMain.handle('sticky:count', () => stickyCount())
  ipcMain.on('sticky:set-pinned', (e, pinned: boolean) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    win?.setAlwaysOnTop(Boolean(pinned))
  })

  // ---- 书籍详情 / 笔记编辑已整合为图书馆内 tabs（不再开独立窗口） ----
  // 注：原 createBookDetailWindow / createNoteEditorWindow 窗口工厂已随死代码清理移除，
  // 如需恢复独立窗口可参考版本历史或重新实现（hash 入口 book-detail / note-editor 仍在 WindowKind 中）。
}

function registerNoteIpc(): void {
  ipcMain.handle('note:copy', (_e, text: string) => {
    clipboard.writeText(String(text ?? ''))
    return true
  })

  // ---- 笔记导出（图片/纯文本/word/markdown）：保存对话框默认进"文档"文件夹，文件名 = 标题 ----
  ipcMain.handle('note:export-file', async (e, req: {
    title: string
    format: 'png' | 'txt' | 'docx' | 'md' | 'html'
    text: string       // 纯文本内容（txt / docx 用）
    markdown?: string  // markdown 内容（md 用；其中 dataURL 图片会提取为同目录文件）
    html?: string      // 完整 HTML 文档（html 用）
    pngDataUrl?: string // PNG dataURL（png 用，渲染层生成）
    lines?: import('../shared/models').NoteExportLinePayload[]  // 结构化行（docx 用，含图片）
  }) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const safeTitle = String(req.title ?? '').replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名笔记'
    const ext = req.format === 'png' ? '.png' : req.format === 'txt' ? '.txt' : req.format === 'docx' ? '.docx' : req.format === 'html' ? '.html' : '.md'
    const filterName = req.format === 'png' ? 'PNG 图片' : req.format === 'txt' ? '纯文本' : req.format === 'docx' ? 'Word 文档' : req.format === 'html' ? 'HTML 文件' : 'Markdown'
    const res = win
      ? await dialog.showSaveDialog(win, {
          title: '导出笔记',
          defaultPath: path.join(app.getPath('documents'), safeTitle + ext),   // 默认进系统"文档"文件夹
          filters: [{ name: filterName, extensions: [ext.slice(1)] }],
        })
      : { canceled: true, filePath: '' }
    if (res.canceled || !res.filePath) return { ok: false as const, canceled: true as const }
    try {
      let buf: Buffer
      if (req.format === 'png') {
        const m = /^data:image\/png;base64,(.+)$/.exec(String(req.pngDataUrl ?? ''))
        if (!m) return { ok: false as const, canceled: false as const, error: '图片生成失败' }
        buf = Buffer.from(m[1], 'base64')
      } else if (req.format === 'docx') {
        buf = await buildDocx(req.lines ?? [])
      } else if (req.format === 'md') {
        // dataURL 图片提取为同目录图片文件，markdown 内改为相对路径引用（任意阅读器都能正常显示）
        let md = String(req.markdown ?? '')
        const base = path.basename(res.filePath, '.md')
        const imgDir = path.dirname(res.filePath)
        let n = 0
        // 注意回调签名：正则共 4 个捕获组 → (match, alt, 完整dataURL, 扩展名kind, base64数据)。
        // 之前误写为 3 参导致 kind/base64 错位，导出的图片全部损坏（解码的是 "png" 字面量）
        md = md.replace(/!\[([^\]]*)\]\((data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=]+))\)/g, (_m, alt, _t, kind, b64) => {
          n++
          const name = `${base}_img${n}.${kind === 'jpeg' ? 'jpg' : 'png'}`
          fs.writeFileSync(path.join(imgDir, name), Buffer.from(b64, 'base64'))
          return `![${alt}](<${name}>)`
        })
        buf = Buffer.from(md, 'utf-8')
      } else if (req.format === 'html') {
        buf = Buffer.from(String(req.html ?? ''), 'utf-8')
      } else {
        buf = Buffer.from(String(req.text ?? ''), 'utf-8')
      }
      fs.writeFileSync(res.filePath, buf)
      return { ok: true as const, path: res.filePath }
    } catch (err) {
      return { ok: false as const, canceled: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // ---- 分享支持：导出到临时文件夹（无对话框）/ 资源管理器选中文件（系统"共享"回退入口） ----
  ipcMain.handle('note:export-temp', async (_e, req: {
    title: string
    format: 'png' | 'txt' | 'docx' | 'md' | 'html'
    pngDataUrl?: string
    text?: string
    markdown?: string
    html?: string
    lines?: import('../shared/models').NoteExportLinePayload[]
  }) => {
    try {
      const dir = path.join(app.getPath('temp'), 'ballwork-share')
      fs.mkdirSync(dir, { recursive: true })
      const safeTitle = String(req.title ?? '').replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名笔记'
      const ext = req.format === 'png' ? '.png' : req.format === 'docx' ? '.docx' : req.format === 'md' ? '.md' : req.format === 'html' ? '.html' : '.txt'
      const file = path.join(dir, `${safeTitle}-${Date.now()}${ext}`)
      if (req.format === 'png') {
        const m = /^data:image\/png;base64,(.+)$/.exec(String(req.pngDataUrl ?? ''))
        if (!m) return { ok: false as const, error: '图片生成失败' }
        fs.writeFileSync(file, Buffer.from(m[1], 'base64'))
      } else if (req.format === 'docx') {
        fs.writeFileSync(file, await buildDocx(req.lines ?? []))
      } else if (req.format === 'md') {
        fs.writeFileSync(file, String(req.markdown ?? ''), 'utf-8')
      } else if (req.format === 'html') {
        fs.writeFileSync(file, String(req.html ?? ''), 'utf-8')
      } else {
        fs.writeFileSync(file, String(req.text ?? ''), 'utf-8')
      }
      return { ok: true as const, path: file }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('note:show-in-folder', (_e, p: string) => {
    try { shell.showItemInFolder(String(p)); return true } catch { return false }
  })

  // ---- 书籍打包（导出 ZIP/RAR / 分享压缩包） ----
  ipcMain.handle('book:pack', async (e, req: { bookId: number; format: 'zip' | 'rar' }) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const bdir = findBookDir(req.bookId)
    let title = '书籍'
    if (bdir) {
      try { title = (JSON.parse(fs.readFileSync(path.join(bdir, 'book.json'), 'utf-8')) as { title?: string }).title ?? '书籍' } catch { /* 忽略 */ }
    }
    const safeTitle = String(title).replace(/[\\/:*?"<>|]/g, '_').trim() || '书籍'
    const ext = req.format === 'rar' ? '.rar' : '.zip'
    const res = win
      ? await dialog.showSaveDialog(win, {
          title: '导出书籍',
          defaultPath: path.join(app.getPath('documents'), `note${safeTitle}${ext}`),   // 压缩包名 = "note" + 书名
          filters: [{ name: req.format === 'rar' ? 'RAR 压缩包' : 'ZIP 压缩包', extensions: [req.format] }],
        })
      : { canceled: true, filePath: '' }
    if (res.canceled || !res.filePath) return { ok: false as const, canceled: true as const }
    const packed = await packBook(req.bookId, res.filePath, req.format)
    return { ...packed, canceled: false as const }
  })

  // 分享压缩包：打包到临时目录（无对话框）
  ipcMain.handle('book:pack-temp', async (_e, req: { bookId: number; format: 'zip' | 'rar' }) => {
    try {
      const dir = path.join(app.getPath('temp'), 'ballwork-share')
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `note${req.bookId}-${Date.now()}.${req.format === 'rar' ? 'rar' : 'zip'}`)
      return await packBook(req.bookId, file, req.format)
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // ---- 多选管理：多本打包（导出/分享） ----
  ipcMain.handle('book:pack-multi', async (e, req: { bookIds: number[]; format: 'zip' | 'rar' }) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const count = (req.bookIds ?? []).length
    const ext = req.format === 'rar' ? '.rar' : '.zip'
    const res = win
      ? await dialog.showSaveDialog(win, {
          title: '导出书籍',
          defaultPath: path.join(app.getPath('documents'), `note多本-${count}本${ext}`),
          filters: [{ name: req.format === 'rar' ? 'RAR 压缩包' : 'ZIP 压缩包', extensions: [req.format] }],
        })
      : { canceled: true, filePath: '' }
    if (res.canceled || !res.filePath) return { ok: false as const, canceled: true as const }
    const packed = await packBooks(req.bookIds, res.filePath, req.format)
    return { ...packed, canceled: false as const }
  })

  ipcMain.handle('book:pack-multi-temp', async (_e, req: { bookIds: number[]; format: 'zip' | 'rar' }) => {
    try {
      const dir = path.join(app.getPath('temp'), 'ballwork-share')
      fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `note多本-${(req.bookIds ?? []).length}本-${Date.now()}.${req.format === 'rar' ? 'rar' : 'zip'}`)
      return await packBooks(req.bookIds, file, req.format)
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })
}

function registerStoreIpc(): void {
  // ---- 数据存储 ----
  ipcMain.handle('store:load', (_e, key: StoreKey) => loadStore(key))
  ipcMain.handle('store:save', async (_e, key: StoreKey, data: unknown) => {
    try {
      await saveStore(key, data)
      broadcast('store:changed', key)
      if (key === 'settings') {
        // 桌宠类型切换：通知球窗即时更换外观
        broadcast('pet-type-changed', (data as { petType?: string }).petType ?? '')
      }
      if (key === 'books' || key === 'folders') {
        // 书籍/文件夹保存后同步目录树镜像（后台串行执行，不阻塞保存返回；封面复用避免重复下载）
        queueTreeSync(
          loadStore<import('../shared/models').BookStore>('books'),
          loadStore<import('../shared/models').FolderStoreData>('folders'),
        )
      }
      return { ok: true as const, data }
    } catch (err) {
      // 写盘失败：返回错误而非静默吞掉，渲染层据此提示用户
      return { ok: false as const, error: err instanceof Error ? err.message : String(err), data }
    }
  })

  // ---- AI（主进程代理，绕开 CORS） ----
  ipcMain.handle('ai:chat', (_e, input: string) => aiChat(input))
  ipcMain.handle('ai:review', (_e, notes: { title: string; content: string; createdAt: string }[]) => aiReview(notes))

  // ---- 联网校时（北京时间） ----
  ipcMain.handle('time:get-today', () => getTodayKey())
  ipcMain.handle('time:sync', async () => {
    const changed = await syncTime()
    if (changed) broadcast('time:synced')
    return getTodayKey()
  })

  // ---- 书籍搜索（豆瓣：主进程代理，网页解析易被反爬，尽力而为） ----
  ipcMain.handle('book:search-douban', (_e, keyword: string) => searchDouban(keyword))
  ipcMain.handle('book:search-weread', (_e, keyword: string) => searchWeread(keyword))
  // 豆瓣详情页目录（导入章节信息用；无目录返回空数组）
  ipcMain.handle('book:fetch-chapters', (_e, url: string) => fetchDoubanChapters(String(url ?? '')))
}

function registerFileIpc(): void {
  // ---- 资源文件（相对 userData 的图片路径 → file:// URL） ----
  // 安全：仅允许解析「userData 内、且不在 config/ 下」的相对路径——防止被攻破的渲染层
  // 借本通道读取 config/ai.json（含 API Key）等任意 userData 文件；绝对路径/越界路径一律拒绝。
  ipcMain.handle('asset:url', (_e, rel: string) => {
    try {
      const root = app.getPath('userData')
      const p = path.resolve(root, String(rel ?? ''))
      const relPath = path.relative(root, p)
      if (!relPath || relPath.startsWith('..') || path.isAbsolute(relPath)) return null
      const lower = relPath.toLowerCase()
      if (lower === 'config' || lower.startsWith('config' + path.sep)) return null
      if (!fs.existsSync(p)) return null
      return pathToFileURL(p).toString()
    } catch {
      return null
    }
  })

  // ---- 封面上传：渲染层传 dataURL，主进程写入 userData/covers/ ----
  ipcMain.handle('file:save-cover', (_e, dataUrl: string, ext: string) => {
    try {
      const m = /^data:image\/\w+;base64,(.+)$/.exec(dataUrl)
      if (!m) return null
      const buf = Buffer.from(m[1], 'base64')
      const dir = path.join(app.getPath('userData'), 'covers')
      fs.mkdirSync(dir, { recursive: true })
      // ext 白名单清洗（对齐 file:save-note-image）：渲染层传值不可信，防 "..\\..\\evil.dll" 类路径穿越写盘
      const extMap: Record<string, string> = { png: 'png', jpg: 'jpg', jpeg: 'jpg', webp: 'webp', gif: 'gif' }
      const realExt = extMap[String(ext || 'png').replace('.', '').toLowerCase()] ?? 'png'
      const name = `cover_${Date.now()}.${realExt}`
      fs.writeFileSync(path.join(dir, name), buf)
      return `covers/${name}`
    } catch {
      return null
    }
  })

  // ---- 笔记图片落盘（应用笔记事实源为 Markdown，图片不再内嵌 dataURL） ----
  // 内容寻址命名：MD5 哈希作文件名，相同图片自动去重复用，不再按时间戳产生冗余副本
  ipcMain.handle('file:save-note-image', (_e, dataUrl: string, ext: string) => {
    try {
      const m = /^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/.exec(dataUrl)
      if (!m) return null
      const buf = Buffer.from(m[2], 'base64')
      const dir = path.join(app.getPath('userData'), 'note-images')
      fs.mkdirSync(dir, { recursive: true })
      const extMap: Record<string, string> = { png: 'png', jpg: 'jpg', jpeg: 'jpg', gif: 'gif', webp: 'webp' }
      const realExt = extMap[String(ext).replace('.', '')] ?? 'png'
      const hash = crypto.createHash('md5').update(buf).digest('hex')
      const name = `img_${hash}.${realExt}`
      const target = path.join(dir, name)
      if (!fs.existsSync(target)) fs.writeFileSync(target, buf)
      return `note-images/${name}`
    } catch {
      return null
    }
  })

  // ---- 应用 ----
  ipcMain.on('app:restart', () => {
    app.relaunch()
    // 用 quit 而非 exit：exit 直接终止进程不触发窗口 close，会丢未保存的笔记草稿
    app.quit()
  })
  ipcMain.on('app:quit', () => app.quit())

  // ---- 软件更新（GitHub Releases 源） ----
  ipcMain.handle('update:get-state', () => getUpdateState())
  ipcMain.handle('update:check', () => checkForUpdate())
  ipcMain.handle('update:download', () => downloadUpdate())
  ipcMain.handle('update:install', () => installUpdate())
}

/** 注册全部 IPC 通道（按域拆分的注册函数依次调用） */
function registerIpc(): void {
  registerBallIpc()
  registerPageIpc()
  registerNoteIpc()
  registerFileIpc()
  registerStoreIpc()
}

/** 便利贴窗口：支持多开。新建（无 id）每次开新窗；编辑时复用同 id 窗口（无则新建）。 */
const stickyWins = new Map<number | string, BrowserWindow>()
let stickySeq = 0

function openSticky(editId?: number): void {
  if (editId != null) {
    const exist = stickyWins.get(editId)
    if (exist && !exist.isDestroyed()) {
      exist.webContents.send('sticky:edit-id', editId)
      exist.show()
      exist.focus()
      return
    }
  }
  const key = editId != null ? editId : `new-${++stickySeq}`
  const win = createStickyWindow(editId)
  stickyWins.set(key, win)
  win.on('closed', () => { if (stickyWins.get(key) === win) stickyWins.delete(key) })
}

/** 当前存活的便利贴窗口数（提醒「当前有 n 个闪念进程」） */
function stickyCount(): number {
  let n = 0
  for (const w of stickyWins.values()) if (!w.isDestroyed()) n++
  return n
}

/** 抚摸气泡：复用气泡窗，贴球主体（60×60 位于窗口内 (10,10)）左右两侧随机出现；
 *  目标侧空间不足时自动翻转到另一侧，并钳制在工作区内（不伸出屏幕） */
function showBubble(content: unknown, toRight: boolean): void {
  if (!ballWin || ballWin.isDestroyed()) return
  if (!bubbleWin || bubbleWin.isDestroyed()) bubbleWin = createBubbleWindow()
  const b = ballWin.getBounds()
  const wa = workAreaOf(ballWin)
  const BUBBLE_W = 320   // 与 createBubbleWindow 尺寸一致
  const BUBBLE_H = 140
  // 球主体：窗口内 (10,10)-(70,70)，中心 (40,40)
  const ballLeft = b.x + 10
  const ballTop = b.y + 10
  let x = toRight
    ? ballLeft + 60 + 4            // 球主体右缘 + 4
    : ballLeft - BUBBLE_W - 4      // 窗右缘 = 球主体左缘 - 4
  // 目标侧放不下：翻转到另一侧（尾巴/对齐方向随 toRight 同步变更）
  if (toRight && x + BUBBLE_W > wa.x + wa.width) {
    toRight = false
    x = ballLeft - BUBBLE_W - 4
  } else if (!toRight && x < wa.x) {
    toRight = true
    x = ballLeft + 60 + 4
  }
  // 钳制：任何情况下不伸出工作区（贴屏边时避免部分在屏幕外）
  x = Math.min(Math.max(x, wa.x), wa.x + wa.width - BUBBLE_W)
  const y = Math.min(Math.max(Math.round(ballTop + 30 - BUBBLE_H / 2), wa.y), wa.y + wa.height - BUBBLE_H)
  bubbleWin.setPosition(Math.round(x), y)
  sendWhenReady(bubbleWin, 'bubble:show', { content, toRight })
  bubbleWin.show()
}

/** 广播给所有窗口（含页面/球/菜单/便利贴） */
function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

// ===================== 初始化 =====================
function init(): void {
  // 资源目录（开发模式从项目根 assets/ 加载）
  ballWin = createBallWindow()
  edge = new EdgeService(ballWin)
  menuWin = createMenuWindow()
  menuWin.on('blur', () => {
    // 菜单窗失焦（点别处）关闭菜单；球窗右键再开
    if (menuWin && menuWin.isVisible()) hideMenu()
  })

  ballWin.on('ready-to-show', () => {
    ballWin?.show()
    edge?.start()
    positionBallAtBottomRight()
  })
  ballWin.on('closed', () => { ballWin = null })

  createTray()
  registerIpc()
  // 软件更新状态变化广播到所有窗口（设置页更新栏目实时反映进度）；后台自动检查调度
  onUpdateStatus((s) => broadcast('update:status', s))
  startAutoCheck()
  // 启动校时（北京时间）：成功且"今天"变化时广播刷新各日历
  void syncTime().then((changed) => {
    if (changed) broadcast('time:synced')
  })
  // 启动：迁移笔记事实源（旧 Lexical JSON → Markdown + dataURL 图片落盘），
  // 有变更则保存并重建目录树；随后同步一次书籍目录树（保证打包/分享随时可用）
  const syncFolders = () => loadStore<import('../shared/models').FolderStoreData>('folders')
  void (async () => {
    try {
      const books = loadStore<import('../shared/models').BookStore>('books')
      const changed = await migrateBookStore(books)
      if (changed) {
        await saveStore('books', books)
        queueTreeSync(books, syncFolders())
        broadcast('store:changed', 'books')
      } else {
        queueTreeSync(books, syncFolders())
      }
    } catch (err) {
      console.error('[bookshelf] 启动迁移失败', err)
      queueTreeSync(loadStore<import('../shared/models').BookStore>('books'), syncFolders())
    }
  })()
}

/** 初始定位到屏幕右下角（任务栏上方，留 25px 边距） */
function positionBallAtBottomRight(): void {
  if (!ballWin) return
  const wa = workAreaOf(ballWin)
  moveWindowTo(ballWin, wa.x + wa.width - SIZES.BALL - 25, wa.y + wa.height - SIZES.BALL - 25)
}

// 退出前清理临时产物：分享导出（ballwork-share）与书籍打包中间目录（ballwork-pack-*），防磁盘膨胀
app.on('before-quit', () => {
  try {
    const tmp = app.getPath('temp')
    const shareDir = path.join(tmp, 'ballwork-share')
    if (fs.existsSync(shareDir)) fs.rmSync(shareDir, { recursive: true, force: true })
    for (const ent of fs.readdirSync(tmp)) {
      if (ent.startsWith('ballwork-pack-')) fs.rmSync(path.join(tmp, ent), { recursive: true, force: true })
    }
  } catch { /* 清理失败不阻塞退出 */ }
})

app.on('window-all-closed', () => {
  // 悬浮球常驻：所有窗口关闭不退出（托盘仍在）；显式退出走托盘/设置
  // 仅当球窗也关闭（异常）时退出
  if (!ballWin) app.quit()
})
