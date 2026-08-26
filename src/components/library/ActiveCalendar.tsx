// 图书馆活跃日历（自 LibraryPage 拆出，行为不变）：
// ActiveCalendar 12 周网格 + useActivityCalendar 范围/点击桥接 Hook

import { useEffect, useState } from 'react'
import type { BookStore, CalendarData, ThoughtStoreData } from '../../../shared/models'
import { DayDot, dateKey, dayTooltip, mondayOf, toDate, workCount } from '../Calendar'

/** 活跃日历：固定 12 周（从首周起向后 12 周，未来空周也显示；使用超 12 周后滚动含本周） */
export function ActiveCalendar({ ranges, selectedDate, books, thoughts, cal, todayKey }: {
  ranges: { first: Date; weeks: number }
  selectedDate: string | null
  books: BookStore | null
  thoughts: ThoughtStoreData | null
  cal: CalendarData | null
  todayKey: string
}) {
  const weekNames = ['一', '二', '三', '四', '五', '六', '日']
  const today = todayKey
  const cols = 12
  const start = new Date(ranges.first)
  start.setDate(ranges.first.getDate() + Math.max(0, ranges.weeks - 12) * 7)
  // 月份标签：该周（列）包含某月 1 号时，在对应列下方显示「n月」
  // 标签层脱离表格布局（绝对定位），避免撑宽列导致网格裂开
  const COL_W = 14   // DayDot 尺寸
  const COL_GAP = 2  // borderSpacing
  const monthTags: { col: number; label: string }[] = []
  for (let c = 0; c < cols; c++) {
    const weekStart = new Date(start)
    weekStart.setDate(start.getDate() + c * 7)
    for (let r = 0; r < 7; r++) {
      const d = new Date(weekStart)
      d.setDate(weekStart.getDate() + r)
      if (d.getDate() === 1) { monthTags.push({ col: c, label: `${d.getMonth() + 1}月` }); break }
    }
  }
  return (
    <div>
      <table className="border-separate" style={{ borderSpacing: 2 }}>
        <tbody>
          {weekNames.map((_, r) => (
            <tr key={r}>
              {Array.from({ length: cols }).map((_, c) => {
                const day = new Date(start)
                day.setDate(start.getDate() + c * 7 + r)
                const key = dateKey(day)
                return (
                  <td key={c} className="p-0">
                    <DayDot
                      day={day}
                      work={workCount(key, books, thoughts, cal)}
                      isToday={key === today}
                      selected={key === selectedDate}
                      onClick={() => window.dispatchEvent(new CustomEvent('cal-day-click', { detail: key }))}
                      tooltip={dayTooltip(key, books, thoughts, cal)}
                    />
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {/* 月份标签行：普通流式占位（不撑表格列宽），紧贴日历（5px 间隔），下方无距离 */}
      <div className="flex" style={{ paddingTop: 5 }}>
        {Array.from({ length: cols }).map((_, c) => {
          const tag = monthTags.find((t) => t.col === c)
          return (
            <div key={c} style={{ width: COL_W, marginRight: COL_GAP, position: 'relative' }}>
              {tag && (
                <span className="absolute left-0 text-[10px] text-slate-500 whitespace-nowrap">
                  {tag.label}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** 活跃日历：固定 12 周窗口，仅当今天超出窗口末尾时才推进（不是每周滑动） */
const CAL_WINDOW_WEEKS = 12
const CAL_RANGE_KEY = 'ballwork.calRangeStart'

/** 日历范围 + 点击事件桥接（点击通过全局事件传回 LibraryPage） */
export function useActivityCalendar(
  cal: CalendarData | null,
  onSelect: (d: string) => void,
): { first: Date; weeks: number } {
  useEffect(() => {
    const h = (e: Event) => onSelect((e as CustomEvent<string>).detail)
    window.addEventListener('cal-day-click', h)
    return () => window.removeEventListener('cal-day-click', h)
  }, [onSelect])

  // 窗口起点（周一）持久化：首次取开始使用那周，之后仅在超出窗口末尾时推进
  const [startKey, setStartKey] = useState<string>(() => localStorage.getItem(CAL_RANGE_KEY) ?? '')

  // 初始化：无持久化起点时取 cal.firstMonday（开始使用那周）；等待 cal 加载完成再定
  useEffect(() => {
    if (startKey) return
    if (!cal) return   // cal 尚未加载完成，等待
    const k = cal.firstMonday ?? dateKey(mondayOf(new Date()))
    localStorage.setItem(CAL_RANGE_KEY, k)
    setStartKey(k)
  }, [cal, startKey])

  // 超出窗口末尾（起点 + 12 周的最后一天）时推进：以今天所在周为新的最后一周
  useEffect(() => {
    if (!startKey) return
    const first = toDate(startKey)
    const end = new Date(first)
    end.setDate(end.getDate() + CAL_WINDOW_WEEKS * 7 - 1)
    if (dateKey(new Date()) > dateKey(end)) {
      const m = mondayOf(new Date())
      m.setDate(m.getDate() - (CAL_WINDOW_WEEKS - 1) * 7)
      const next = dateKey(m)
      localStorage.setItem(CAL_RANGE_KEY, next)
      setStartKey(next)
    }
  }, [startKey])

  return startKey
    ? { first: toDate(startKey), weeks: CAL_WINDOW_WEEKS }
    : { first: mondayOf(new Date()), weeks: 1 }
}
