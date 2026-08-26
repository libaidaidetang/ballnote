import type { CSSProperties } from 'react'
import type { ResizeDir } from '../../../shared/models'

const HANDLES: { dir: ResizeDir; cursor: string; style: CSSProperties }[] = [
  { dir: 'n', cursor: 'ns-resize', style: { top: 0, left: 14, right: 14, height: 5 } },
  { dir: 's', cursor: 'ns-resize', style: { bottom: 0, left: 14, right: 14, height: 5 } },
  { dir: 'e', cursor: 'ew-resize', style: { right: 0, top: 14, bottom: 14, width: 5 } },
  { dir: 'w', cursor: 'ew-resize', style: { left: 0, top: 14, bottom: 14, width: 5 } },
  { dir: 'ne', cursor: 'nesw-resize', style: { top: 0, right: 0, width: 14, height: 14 } },
  { dir: 'nw', cursor: 'nwse-resize', style: { top: 0, left: 0, width: 14, height: 14 } },
  { dir: 'se', cursor: 'nwse-resize', style: { bottom: 0, right: 0, width: 14, height: 14 } },
  { dir: 'sw', cursor: 'nesw-resize', style: { bottom: 0, left: 0, width: 14, height: 14 } },
]

/**
 * 窗口 8 方向 resize 热点（自绘，对齐 WPF PageWindow 的 resize Thumb）。
 * 指针事件经 IPC 上报主进程，由主进程计算并 setBounds（含最小尺寸约束）。
 */
export default function ResizeHandles() {
  const start = (e: React.PointerEvent, dir: ResizeDir) => {
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    window.api.page.resize('down', e.screenX, e.screenY, dir)
  }

  return (
    <>
      {HANDLES.map((h) => (
        <div
          key={h.dir}
          className="fixed z-50"
          style={{ ...h.style, cursor: h.cursor }}
          onPointerDown={(e) => start(e, h.dir)}
          onPointerMove={(e) => window.api.page.resize('move', e.screenX, e.screenY, h.dir)}
          onPointerUp={(e) => window.api.page.resize('up', e.screenX, e.screenY, h.dir)}
        />
      ))}
    </>
  )
}
