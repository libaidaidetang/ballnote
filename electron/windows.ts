import { BrowserWindow, screen } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PageKind, WindowKind } from '../shared/models'

// ===== 尺寸常量（对齐原 WPF DesignTokens / FanMenuView） =====
export const SIZES = {
  BALL: 80,          // 球窗边长
  MENU_W: 165,
  MENU_H: 300,
  PAGE_W: 1200,
  PAGE_H: 800,
  STICKY_W: 600,
  STICKY_H: 600,
} as const

/** 窗口类型 → 浏览器入口（hash 路由区分） */
export function entryUrl(kind: WindowKind, query = ''): string {
  const dev = process.env.VITE_DEV_SERVER_URL
  const hash = `#/window/${kind}${query}`
  if (dev) return `${dev}${hash}`
  // pathToFileURL 编码：安装路径含空格/# 等字符时手拼 file:// 会 loadURL 失败白屏
  return pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).toString() + hash
}

const TRANSPARENT_OPTS = {
  transparent: true,
  frame: false,
  backgroundColor: '#00000000',
} as const

// ===== 窗口工厂 =====

/** 悬浮球主窗口：80×80 透明无边框置顶，不占任务栏 */
export function createBallWindow(): BrowserWindow {
  const win = new BrowserWindow({
    ...TRANSPARENT_OPTS,
    width: SIZES.BALL,
    height: SIZES.BALL,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: { preload: preloadPath() },
  })
  win.setMenu(null)
  win.loadURL(entryUrl('ball'))
  return win
}

/** 扇形菜单窗：165×300 透明无边框，不置顶（被球窗盖住，球窗透明区域透出菜单） */
export function createMenuWindow(): BrowserWindow {
  const win = new BrowserWindow({
    ...TRANSPARENT_OPTS,
    width: SIZES.MENU_W,
    height: SIZES.MENU_H,
    resizable: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: false,
    hasShadow: false,
    webPreferences: { preload: preloadPath() },
  })
  win.setMenu(null)
  win.loadURL(entryUrl('menu'))
  return win
}

/**
 * 功能页窗口：不透明无边框，任务栏可见，屏幕居中（多页面并存）；支持恢复上次尺寸与 8 方向自绘 resize。
 * 注意：必须「不透明」——transparent 窗口在 Windows 上走 DWM 特殊合成路径，
 * 系统 maximize 只拉大 bounds 不进真正最大化态（isMaximized() 恒 false → 恢复失效、边缘仍可 resize），
 * 且 Win11 拖到顶部的贴靠布局预览不生效。不透明后系统最大化/恢复/贴靠全部原生，圆角由 Win11 DWM 提供。
 */
export function createPageWindow(kind: PageKind, size?: { width: number; height: number }): BrowserWindow {
  const win = new BrowserWindow({
    frame: false,
    backgroundColor: '#FFFFFF',
    width: size?.width ?? SIZES.PAGE_W,
    height: size?.height ?? SIZES.PAGE_H,
    resizable: true,
    minWidth: 800,
    minHeight: 560,
    skipTaskbar: false,
    show: false,   // 先隐藏：内容加载完成（ready-to-show）后再由主进程置透明显示 + 入场动画，避免白屏闪烁
    webPreferences: { preload: preloadPath() },
  })
  win.setMenu(null)
  win.loadURL(entryUrl('page', `?kind=${kind}`))
  return win
}

/** 闪念便利贴窗：可多开（主进程 Set 跟踪），任务栏可见。
 *  尺寸按物理像素换算（600×600 为用户屏幕感知尺寸；150% 缩放下 DIP=400 → 物理 600）。 */
export function createStickyWindow(editId?: number): BrowserWindow {
  const sf = screen.getPrimaryDisplay().scaleFactor
  const win = new BrowserWindow({
    ...TRANSPARENT_OPTS,
    width: Math.round(SIZES.STICKY_W / sf),
    height: Math.round(SIZES.STICKY_H / sf),
    resizable: false,
    skipTaskbar: false,
    alwaysOnTop: false,
    hasShadow: false,
    webPreferences: { preload: preloadPath() },
  })
  win.setMenu(null)
  win.loadURL(entryUrl('sticky', editId ? `?id=${editId}` : ''))
  return win
}

/** 抚摸气泡窗：透明小窗，显示在球旁（内容超出球窗 80×80 的裁切，故用独立窗） */
export function createBubbleWindow(): BrowserWindow {
  const win = new BrowserWindow({
    ...TRANSPARENT_OPTS,
    width: 320,
    height: 140,
    resizable: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    hasShadow: false,
    webPreferences: { preload: preloadPath() },
  })
  win.setMenu(null)
  win.loadURL(entryUrl('bubble'))
  return win
}

function preloadPath(): string {
  return path.join(__dirname, 'preload.js')
}

// ===== 导航安全（纵深防御）=====
// 渲染层目前无 window.open/外链需求（grep 确认）：一律拒绝弹新窗；
// 页面内导航仅放行应用自身入口（dev server / 打包后的 file:// index.html），防脚本劫持导航到钓鱼页。
export function hardenWindow(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const selfOriginPrefix = process.env.VITE_DEV_SERVER_URL
    ?? pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).toString().split('#')[0]
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(selfOriginPrefix)) return
    e.preventDefault()
  })
}
void hardenWindow

// ===== 屏幕工具 =====

/** 主显示器工作区（DIP） */
export function workArea() {
  return screen.getPrimaryDisplay().workArea
}

/** 窗口所在显示器的工作区（DIP）：多显示器下按窗口当前位置取最近屏，
 *  避免球拖到副屏后贴边/吸附/禁区仍按主屏计算把球瞬移回主屏 */
export function workAreaOf(win?: BrowserWindow | null): Electron.Rectangle {
  try {
    if (win && !win.isDestroyed()) {
      return screen.getDisplayNearestPoint(win.getBounds()).workArea
    }
  } catch { /* 屏幕查询失败回退主屏 */ }
  return screen.getPrimaryDisplay().workArea
}

/** 光标位置（DIP）：screen API 返回的即为 DIP，与 workArea/getBounds 同坐标系，
 *  不可再除 scaleFactor（否则高 DPI 下坐标偏小，贴边/吸附的命中判定错乱） */
export function cursorDip() {
  const p = screen.getCursorScreenPoint()
  return { x: p.x, y: p.y }
}

// ===== 窗口动画工具（主进程逐帧推进，替代 WPF 的 DoubleAnimation） =====

type Easing = (t: number) => number

const easeOutCubic: Easing = (t) => 1 - Math.pow(1 - t, 3)
/** 三次 EaseInOut：慢-快-慢（对齐 WPF PowerEase{Power=3, EaseInOut} 单击吸附曲线，末尾统一导出） */
const easeInOutCubic: Easing = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

/**
 * 平滑动画窗口位置/尺寸（setInterval 10ms ≈ 100fps 计算帧，60Hz 显示下每帧 2 次插值更顺滑）。
 * 仅用于贴边/吸附/最大化等需要平滑移动的场合；结束固化终值（避免漂移）。
 * 代际 token 取消机制：同窗口启动新动画会使旧动画链立即失效，杜绝两条 setTimeout 链互拉 bounds。
 */
export function animateWindowBounds(
  win: BrowserWindow,
  target: { x: number; y: number; width?: number; height?: number },
  durationMs: number,
  easing: Easing = easeOutCubic,
): Promise<void> {
  const gen = (animGen.get(win) ?? 0) + 1
  animGen.set(win, gen)
  return new Promise((resolve) => {
    if (win.isDestroyed()) { resolve(); return }
    const b = win.getBounds()
    const from = { x: b.x, y: b.y, width: b.width, height: b.height }
    const to = {
      x: target.x, y: target.y,
      width: target.width ?? b.width,
      height: target.height ?? b.height,
    }
    const start = Date.now()
    const tick = () => {
      if (win.isDestroyed() || animGen.get(win) !== gen) { resolve(); return }   // 已被新动画取代或窗口销毁
      const t = Math.min(1, (Date.now() - start) / durationMs)
      const e = easing(t)
      win.setBounds({
        x: Math.round(from.x + (to.x - from.x) * e),
        y: Math.round(from.y + (to.y - from.y) * e),
        width: Math.round(from.width + (to.width - from.width) * e),
        height: Math.round(from.height + (to.height - from.height) * e),
      })
      if (t < 1) {
        setTimeout(tick, 10)
      } else {
        win.setBounds({ x: to.x, y: to.y, width: to.width, height: to.height })
        resolve()
      }
    }
    tick()
  })
}

/** 动画代际表：同窗口新动画开始时递增代数，旧链检测到代数不符自动退出 */
const animGen = new WeakMap<BrowserWindow, number>()

/** 立即设置位置（拖拽跟手用）。
 * 用 setBounds 显式强制固定尺寸：Electron 透明窗口在高 DPI 下高频 setPosition
 * 会把窗口逐帧撑大（实测拖拽中 82×82 → 100×94，右下方出现透明长条区域），
 * 显式 w/h 每帧拉回，杜绝膨胀。 */
export function moveWindowTo(win: BrowserWindow, x: number, y: number): void {
  if (win.isDestroyed()) return
  win.setBounds({ x: Math.round(x), y: Math.round(y), width: SIZES.BALL, height: SIZES.BALL })
}

/** 窗口出现动画：淡入 + 轻微上浮（先置透明+偏移，再动画到原位） */
export async function entranceAnimation(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed()) return
  const b = win.getBounds()
  win.setOpacity(0)
  win.setPosition(b.x, b.y + 12)
  const start = Date.now()
  const dur = 220
  const tick = () => {
    if (win.isDestroyed()) return
    const t = Math.min(1, (Date.now() - start) / dur)
    const e = easeOutCubic(t)
    win.setOpacity(e)
    win.setPosition(Math.round(b.x), Math.round(b.y + 12 * (1 - e)))
    if (t < 1) setTimeout(tick, 16)
  }
  tick()
}

export { easeOutCubic, easeInOutCubic }
