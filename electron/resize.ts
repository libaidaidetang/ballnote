import { BrowserWindow } from 'electron'
import type { ResizeDir } from '../shared/models'

/**
 * 页面窗口自绘 resize 状态机（对齐 WPF PageWindow 的 8 个 resize Thumb）。
 * 渲染层上报指针事件（down/move/up + 方向），主进程计算并 setBounds。
 * 状态按窗口隔离（WeakMap）：多页面窗口并发 resize 互不踩踏；
 * 最小尺寸与 createPageWindow 的 minWidth/minHeight 保持一致（640×480 → 800×560）。
 */
const MIN_W = 800
const MIN_H = 560

interface ResizeState {
  dir: ResizeDir
  px: { x: number; y: number }
  bounds: Electron.Rectangle
}

const states = new WeakMap<BrowserWindow, ResizeState>()

export function onResizePointer(
  win: BrowserWindow,
  msg: { type: 'down' | 'move' | 'up'; screenX: number; screenY: number; dir: ResizeDir },
): void {
  if (win.isDestroyed()) return

  if (msg.type === 'down') {
    if (win.isMaximized()) win.unmaximize()
    states.set(win, { dir: msg.dir, px: { x: msg.screenX, y: msg.screenY }, bounds: win.getBounds() })
    return
  }

  if (msg.type === 'move') {
    const state = states.get(win)
    if (!state) return
    // 渲染层 screenX/screenY 已是 DIP，直接求差值即可（与 ball:pointer 一致，
    // 再除 scaleFactor 会在高 DPI 下位移缩水、跟手错位）。
    const dx = msg.screenX - state.px.x
    const dy = msg.screenY - state.px.y
    const { bounds, dir } = state
    let { x, y, width, height } = bounds

    const clampW = (w: number) => Math.max(MIN_W, Math.round(w))
    const clampH = (h: number) => Math.max(MIN_H, Math.round(h))

    if (dir.includes('e')) width = clampW(bounds.width + dx)
    if (dir.includes('s')) height = clampH(bounds.height + dy)
    if (dir.includes('w')) {
      const w = clampW(bounds.width - dx)
      x = bounds.x + (bounds.width - w)
      width = w
    }
    if (dir.includes('n')) {
      const h = clampH(bounds.height - dy)
      y = bounds.y + (bounds.height - h)
      height = h
    }
    win.setBounds({ x, y, width, height })
    return
  }

  if (msg.type === 'up') {
    states.delete(win)
  }
}
