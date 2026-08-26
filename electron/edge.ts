import { BrowserWindow, screen } from 'electron'
import { loadStore } from './store'
import type { PetSettingsData } from '../shared/models'
import { animateWindowBounds, cursorDip, easeInOutCubic, moveWindowTo, workAreaOf } from './windows'

/**
 * 贴边收起/吸附服务（主进程）：对齐原 WPF EdgeHidingService + MainWindow 的
 * 吸附/禁区逻辑。球窗渲染进程只上报拖拽/单击事件，决策与动画都在主进程。
 *
 * 状态机：normal（自由移动）→ hidden（贴边收起只露 Peek）→ restored（滑出防抖）
 */
export class EdgeService {
  // ---- 常量（对齐 WPF 版） ----
  private static readonly EDGE_THRESHOLD = 20   // 距边缘 < 此值触发收起
  private static readonly PEEK = 50              // 收起时露出的窗口宽度（球 60px 内偏移 10px → 球露 40px ≈ 2/3）
  private static readonly HOVER_ZONE = 6         // 露出区外扩触发滑回
  private static readonly TOP_KEEPOUT = 120      // 上禁区（球中心）
  private static readonly BOTTOM_KEEPOUT = 30    // 下禁区
  private static readonly NEAR_EDGE = 20         // 已贴近边缘直接触发收起
  private static readonly EDGE_SLIDE_MS = 450  // 弹出/缩回动画时长（慢速顺滑）
  private static readonly SNAP_MS = 700         // 单击吸附动画时长（用户偏好干脆利落）
  private static readonly RESTORE_SETTLE_MS = 600 // 弹出动画完成后才允许缩回判定（> EDGE_SLIDE_MS + tick 余量）

  private readonly win: BrowserWindow
  private timer: NodeJS.Timeout | null = null
  private isHidden = false
  private suspendHide = false
  private snapPinned = false          // 单击吸附后锁定显示（不收起），拖拽才解除
  private armed = false               // 兜底轮询：鼠标先离开露出区才允许轮询弹出（mouseenter 事件主路径不受此限）
  private restoring = false           // 弹出动画进行中：期间禁止缩回判定（防窗口未就位时误判鼠标离开）
  private hiddenEdge: 'left' | 'right' | null = null
  private restoredAt = 0

  constructor(win: BrowserWindow) {
    this.win = win
  }

  get docked(): boolean {
    return this.isHidden
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), 150)
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  private tick(): void {
    if (this.win.isDestroyed()) return
    if (this.snapPinned) return   // 吸附锁定：球保持完整显示，拖拽后才恢复贴边检测
    if (this.isHidden) {
      // 兜底轮询（主路径是渲染层 mouseenter → onHoverEnter）：仅当鼠标先离开露出区后再进入才弹，
      // 避免吸附/收起后鼠标残留位置被轮询误判为悬停而立即弹出
      if (!this.armed && !this.cursorNearHiddenEdge()) this.armed = true
      if (this.armed && this.cursorNearHiddenEdge()) this.restore()
    } else if (this.suspendHide) {
      // 弹出动画进行中不缩回；动画完成且鼠标离开球体范围才恢复检测（随后自动缩回半隐藏）
      if (this.restoring) return
      if (Date.now() - this.restoredAt >= EdgeService.RESTORE_SETTLE_MS
        && !this.cursorOnBall()) {
        this.suspendHide = false   // 鼠标离开球体范围，恢复检测（球在边缘会重新收起）
      }
    } else {
      // 贴边收起开关（设置页「功能设置」）：显式 false 才关闭（旧配置缺字段时按默认 true）
      if (loadStore<PetSettingsData>('settings').edgeHideEnabled === false) return
      this.checkEdgeToHide()
    }
  }

  private checkEdgeToHide(): void {
    const wa = workAreaOf(this.win)
    const b = this.win.getBounds()
    if (b.x <= wa.x + EdgeService.EDGE_THRESHOLD) this.hide('left')
    else if (b.x + b.width >= wa.x + wa.width - EdgeService.EDGE_THRESHOLD) this.hide('right')
  }

  private hide(edge: 'left' | 'right'): void {
    this.isHidden = true
    this.hiddenEdge = edge
    this.armed = false   // 收起重置兜底轮询（mouseenter 事件不受影响）
    const wa = workAreaOf(this.win)
    const w = this.win.getBounds().width
    // 贴边只露 Peek：左 = wa.x - W + Peek；右 = wa.x + wa.width - Peek
    const targetX = edge === 'left' ? wa.x - w + EdgeService.PEEK : wa.x + wa.width - EdgeService.PEEK
    void this.animateX(targetX)
  }

  /** 滑出：到贴边完整可见位置（向内弹出，不回收起前位置——拖出屏幕外时原坐标不可见） */
  private restore(): void {
    this.isHidden = false
    this.suspendHide = true
    this.restoredAt = Date.now()
    this.restoring = true
    const wa = workAreaOf(this.win)
    const targetX = this.hiddenEdge === 'left'
      ? wa.x
      : wa.x + wa.width - this.win.getBounds().width
    void this.animateX(targetX).finally(() => { this.restoring = false })
  }

  private animateX(targetX: number): Promise<void> {
    const b = this.win.getBounds()
    return animateWindowBounds(this.win, { x: targetX, y: b.y }, EdgeService.EDGE_SLIDE_MS)
  }

  /** 光标是否在窗口（球）垂直范围内（含外扩容差）：防止同水平线任意高度误触发 */
  private cursorNearInY(): boolean {
    const b = this.win.getBounds()
    const c = cursorDip()
    return c.y >= b.y - EdgeService.HOVER_ZONE && c.y <= b.y + b.height + EdgeService.HOVER_ZONE
  }

  private cursorNearHiddenEdge(): boolean {
    const wa = workAreaOf(this.win)
    const b = this.win.getBounds()
    const c = cursorDip()
    if (!this.cursorNearInY()) return false
    if (this.hiddenEdge === 'left') return c.x <= wa.x + EdgeService.PEEK + EdgeService.HOVER_ZONE
    if (this.hiddenEdge === 'right') return c.x >= wa.x + wa.width - EdgeService.PEEK - EdgeService.HOVER_ZONE
    return false
  }

  /** 球完整显示（滑出状态）时，鼠标是否仍在球体范围附近（hover 保持弹出，离开后缩回） */
  private cursorOnBall(): boolean {
    const wa = workAreaOf(this.win)
    const b = this.win.getBounds()
    const c = cursorDip()
    if (!this.cursorNearInY()) return false
    // 贴左：球占 [wa.x, wa.x+W]；贴右：球占 [wa.x+wa.width-W, wa.x+wa.width]
    if (b.x <= wa.x + 1) return c.x <= b.x + b.width + EdgeService.HOVER_ZONE
    if (b.x + b.width >= wa.x + wa.width - 1) return c.x >= b.x - EdgeService.HOVER_ZONE
    return false
  }

  // ---- 供渲染进程/主进程调用 ----

  /** 立即执行一轮检测（吸附到位后调用） */
  checkNow(): void {
    this.tick()
  }

  /** 鼠标进入球体（渲染层 mouseenter）：半隐藏时立即弹出完整显示（真实悬停，不受防抖限制） */
  onHoverEnter(): void {
    if (this.isHidden) this.restore()
  }

  /** 鼠标离开球体（渲染层 mouseleave）：完整显示时立即缩回半隐藏（动画完成后才执行） */
  onHoverLeave(): void {
    if (this.restoring || this.isHidden || !this.suspendHide) return
    this.suspendHide = false
    this.checkEdgeToHide()   // 球在边缘 → 立即缩回半隐藏
  }

  /** 拖拽结束：清除吸附锁定/收起状态并恢复检测，随后检查上下禁区 */
  onDragEnd(x: number, y: number): void {
    this.snapPinned = false
    this.suspendHide = false
    this.isHidden = false
    this.hiddenEdge = null
    moveWindowTo(this.win, x, y)
    this.start()
    this.enforceVerticalKeepout()
  }

  /** 单击：若已收起则滑出查看；否则吸附到最近左右边缘并进入半隐藏停靠（球一半藏于屏外），
   *  之后鼠标悬浮到球上弹出完整显示、离开后缩回半隐藏。吸附开关显式关闭时不做吸附。 */
  onSingleClick(): void {
    if (loadStore<PetSettingsData>('settings').snapEnabled === false) {
      if (this.isHidden) this.restore()
      return
    }
    if (this.isHidden) {
      this.restore()
      return
    }
    const b = this.win.getBounds()
    const wa = workAreaOf(this.win)
    const cx = b.x + b.width / 2
    const toLeft = cx - wa.x <= wa.x + wa.width - cx
    const targetLeft = toLeft ? wa.x : wa.x + wa.width - b.width
    // 吸附：先滑到边缘，随后进入半隐藏停靠（hide 状态由 tick 的 hover 检测接管）。
    // 动画对齐 WPF：1400ms + 三次 EaseInOut（慢-快-慢：起步慢、中间快、收尾慢）
    this.stop()
    void animateWindowBounds(this.win, { x: targetLeft, y: b.y }, EdgeService.SNAP_MS, easeInOutCubic).then(() => {
      if (this.win.isDestroyed()) return
      this.hide(toLeft ? 'left' : 'right')
      this.start()
    })
  }

  /** 上下边缘禁区：球中心在禁区内平滑弹回（水平不变） */
  private enforceVerticalKeepout(): void {
    const b = this.win.getBounds()
    const wa = workAreaOf(this.win)
    const cy = b.y + b.height / 2
    let targetY = cy
    if (cy < wa.y + EdgeService.TOP_KEEPOUT) targetY = wa.y + EdgeService.TOP_KEEPOUT
    else if (cy > wa.y + wa.height - EdgeService.BOTTOM_KEEPOUT) {
      targetY = wa.y + wa.height - EdgeService.BOTTOM_KEEPOUT
    }
    if (Math.abs(targetY - cy) < 1) return
    this.stop()
    void animateWindowBounds(this.win, { x: b.x, y: targetY - b.height / 2 }, 400).then(() => {
      this.start()
    })
  }
}
