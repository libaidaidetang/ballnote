import { useEffect, useState } from 'react'
import Icon, { type IconName } from '../components/ui/Icon'

// 面板常量（对齐 WPF FanMenuView）
const PANEL_W = 165
const PANEL_H = 300
const INNER_R = 70
const OUTER_R = 125
const ITEM = 40
const MAX_INNER = 4
const MAX_OUTER = 5
const CENTER_X_RIGHT = 20
const CENTER_X_LEFT = 145

// 角度（度）：向右 -78°→42°；向左 -102°→-222°
const ANGLE_RIGHT = { start: -78, end: 42 }
const ANGLE_LEFT = { start: -102, end: -222 }

// action → 图标（对应 WPF PageRegistry 的 Segoe 码点）
const ACTION_ICON: Record<string, IconName> = {
  library: 'library',
  settings: 'settings',
  sketch: 'pen',
  ai: 'chat',
}
const FALLBACK_ICON: IconName = 'more'

/**
 * 扇形菜单窗口（165×300 透明，主进程定位到球旁）。
 * 双层弧线：内圈最多 4 项（步长 40°）、外圈最多 5 项（步长 30°），
 * 固定步长居中（不满项向中点聚拢）。方向 toRight 由主进程按球位置决定。
 */
export default function MenuWindow() {
  const [items, setItems] = useState<{ title: string; action: string }[]>([])
  const [toRight, setToRight] = useState(true)
  const [seq, setSeq] = useState(0)   // 内容代次：每次 set-items 自增，重放淡入

  useEffect(() => {
    return window.api.menu.onSetItems(({ items, toRight }) => {
      setItems(items)
      setToRight(toRight)
      setSeq((s) => s + 1)
    })
  }, [])

  const inner = items.slice(0, MAX_INNER)
  const outer = items.slice(MAX_INNER, MAX_INNER + MAX_OUTER)
  const angle = toRight ? ANGLE_RIGHT : ANGLE_LEFT
  const innerStep = (angle.end - angle.start) / (MAX_INNER - 1)
  const outerStep = (angle.end - angle.start) / (MAX_OUTER - 1)
  const centerX = toRight ? CENTER_X_RIGHT : CENTER_X_LEFT
  const centerY = PANEL_H / 2
  const mid = (angle.start + angle.end) / 2

  interface Placed { x: number; y: number; item: { title: string; action: string }; idx: number }
  const placed: Placed[] = []
  const place = (list: typeof inner, radius: number, step: number) => {
    const n = list.length
    for (let i = 0; i < n; i++) {
      const deg = mid + (i - (n - 1) / 2) * step
      const rad = (deg * Math.PI) / 180
      placed.push({
        x: centerX + Math.cos(rad) * radius,
        y: centerY + Math.sin(rad) * radius,
        item: list[i],
        idx: placed.length,
      })
    }
  }
  place(inner, INNER_R, innerStep)
  place(outer, OUTER_R, outerStep)

  return (
    <div className="w-full h-full relative select-none" style={{ width: PANEL_W, height: PANEL_H }}>
      {placed.map(({ x, y, item, idx }) => (
        <button
          key={`${seq}-${item.action}-${idx}`}
          className="absolute rounded-full flex items-center justify-center text-slate-800
                     shadow-[0_2px_10px_rgba(0,0,0,0.18)] bg-white hover:bg-slate-50
                     active:scale-95 transition-transform"
          style={{
            left: x - ITEM / 2,
            top: y - ITEM / 2,
            width: ITEM,
            height: ITEM,
            cursor: 'pointer',
            animation: `menu-item-in 200ms ${idx * 80}ms ease-out backwards`,
          }}
          data-tip={item.title}
          onClick={() => window.api.menu.clickItem(item.action)}
        >
          <Icon name={ACTION_ICON[item.action] ?? FALLBACK_ICON} size={18} />
        </button>
      ))}
    </div>
  )
}
