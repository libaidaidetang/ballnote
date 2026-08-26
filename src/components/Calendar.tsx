import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { BookStore, CalendarData, ThoughtStoreData } from '../../shared/models'

/** 指定日期的工作量（笔记 + 闪念 + 回顾；颜色深浅依据） */
export function workCount(
  day: string,
  books: BookStore | null,
  thoughts: ThoughtStoreData | null,
  cal: CalendarData | null,
): number {
  let notes = 0
  for (const b of books?.books ?? []) {
    for (const n of b.notes) {
      if (dateKey(new Date(n.createdAt)) === day) notes++
    }
  }
  const thoughtCount = (thoughts?.thoughts ?? []).filter((t) => dateKey(new Date(t.createdAt)) === day).length
  const reviews = cal?.days[day]?.reviews ?? 0
  return notes + thoughtCount + reviews
}

/** 工作量 → 圆点颜色（对齐 WPF CalendarVisuals.WorkBrush） */
export function workBrush(work: number): string {
  if (work <= 0) return '#E5E7EB'
  if (work <= 2) return '#A5B4FC'
  if (work <= 5) return '#6366F1'
  return '#4338CA'
}

/** yyyy-MM-dd */
export function dateKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function toDate(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** 周一为一周起点 */
export function mondayOf(d: Date): Date {
  const t = new Date(d)
  t.setHours(0, 0, 0, 0)
  const dow = (t.getDay() + 6) % 7
  t.setDate(t.getDate() - dow)
  return t
}

/** 单日 tooltip 统计（活跃日历/完整日历悬停展示） */
export interface DayTooltip {
  date: string
  noteCount: number
  thoughtCount: number
  thoughtProcessed: number
  reviewCount: number
  reviewUpdated: number
}

/** 构造某日 tooltip 数据（笔记 / 闪念 / 每日回顾 三行统计） */
export function dayTooltip(
  key: string,
  books: BookStore | null,
  thoughts: ThoughtStoreData | null,
  cal: CalendarData | null,
): DayTooltip {
  let noteCount = 0
  for (const b of books?.books ?? []) {
    for (const n of b.notes) {
      if (dateKey(new Date(n.createdAt)) === key) noteCount++
    }
  }
  const t = (thoughts?.thoughts ?? []).filter((x) => dateKey(new Date(x.createdAt)) === key)
  const d = cal?.days[key]
  return {
    date: `${key.slice(5, 7)}月${key.slice(8, 10)}日`,
    noteCount,
    thoughtCount: t.length,
    thoughtProcessed: d?.thoughtsProcessed ?? 0,
    reviewCount: d?.reviews ?? 0,
    reviewUpdated: d?.reviewsUpdated ?? 0,
  }
}

/** 单日圆点（含选中/今天状态圈 + 自定义悬停 tooltip） */
export function DayDot({
  day, work, isToday, selected, onClick, tooltip,
}: {
  day: Date
  work: number
  isToday: boolean
  selected?: boolean
  onClick?: (day: Date) => void
  tooltip?: DayTooltip | null
}) {
  const size = 14
  const [hover, setHover] = useState(false)
  // tooltip 定位：显示前用 getBoundingClientRect 计算方向（上方不足则向下）与位置
  // 注意 fixed 定位的 top/bottom 百分比是相对视口（不是元素自身），必须用像素坐标
  const dotRef = useRef<HTMLDivElement>(null)
  const showTimer = useRef<number | null>(null)
  const [tipLeft, setTipLeft] = useState(0)
  const [tipTop, setTipTop] = useState(0)
  const TIP_H = 92    // tooltip 估算高度（三行统计 + 日期 + padding）
  const SHOW_DELAY = 300   // hover 停留该时长后才显示（避免划过即弹）
  const scheduleShow = () => {
    if (showTimer.current != null) window.clearTimeout(showTimer.current)
    showTimer.current = window.setTimeout(() => {
      showTimer.current = null
      const el = dotRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const up = r.top > TIP_H + 8             // 上方放不下则向下弹
      setTipTop(up ? r.top - TIP_H - 6 : r.bottom + 6)
      const tipW = 200
      const cx = r.left + r.width / 2          // 水平居中，左右越界时向窗口内收
      setTipLeft(Math.min(Math.max(cx, tipW / 2 + 6), window.innerWidth - tipW / 2 - 6))
      setHover(true)
    }, SHOW_DELAY)
  }
  // 卸载清理：挂起中的 tooltip 显示定时器不再触发（翻月/切换筛选后不残留对已卸载组件的 setState）
  useEffect(() => () => {
    if (showTimer.current != null) window.clearTimeout(showTimer.current)
  }, [])

  return (
    <div
      ref={dotRef}
      className="relative flex items-center justify-center"
      style={{ width: size, height: size, cursor: onClick ? 'pointer' : 'default' }}
      onClick={onClick ? () => onClick(day) : undefined}
      onMouseEnter={scheduleShow}
      onMouseLeave={() => {
        if (showTimer.current != null) { window.clearTimeout(showTimer.current); showTimer.current = null }
        setHover(false)
      }}
    >
      {/* 状态圈：今天深蓝实线 / 选中灰虚线 */}
      {(isToday || selected) && (
        <div
          className="absolute rounded-full"
          style={{
            width: size, height: size,
            border: `1px ${selected ? 'dashed #9CA3AF' : 'solid #4338CA'}`,
            pointerEvents: 'none',
          }}
        />
      )}
      <div className="rounded-full" style={{ width: 8, height: 8, background: workBrush(work) }} />
      {/* 自定义 tooltip：createPortal 渲染到 body，fixed 定位用像素坐标（相对视口） */}
      {hover && tooltip && createPortal(
        <div
          className="fixed z-[100] whitespace-nowrap rounded-lg bg-white/95 backdrop-blur shadow-lg border border-black/10 px-3 py-2 text-left"
          style={{
            left: tipLeft,
            top: tipTop,
            transform: 'translateX(-50%)',
          }}
        >
          <p className="text-[11px] text-slate-400">{tooltip.date}</p>
          <p className="text-[12px] text-slate-700 mt-1">笔记　记录{tooltip.noteCount}项</p>
          <p className="text-[12px] text-slate-700">闪念　记录{tooltip.thoughtCount}条，处理{tooltip.thoughtProcessed}条</p>
          <p className="text-[12px] text-slate-700">每日回顾　回顾{tooltip.reviewCount}条，更新{tooltip.reviewUpdated}条</p>
        </div>,
        document.body,
      )}
    </div>
  )
}
