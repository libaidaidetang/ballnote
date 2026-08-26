import { useEffect, useRef } from 'react'

export interface TabItem {
  key: string
  label: string
  /** 可关闭（动态文档标签，如书籍详情/笔记编辑）；固定视图标签不设此标志 */
  closable?: boolean
  /** 分组子级标签（如书籍标签下的笔记标签）：未选中灰底；所属组整圈蓝色分组边框 */
  indent?: boolean
  /** 有未保存改动：关闭按钮显示为圆圈（●），关闭时由父组件弹确认 */
  dirty?: boolean
}

/**
 * 顶部标签页（vscode/edge editor tab strip 风格）：
 * - 纯文字、不截断（whitespace-nowrap）、px-3 h-9 足够点击面积
 * - 选中 tab 底边与内容区无缝连体（版面延伸）
 * - 选中态：主色 + 粗体对比，互斥切换由父组件控制
 * - 分组：普通标签 + 其后连续 indent 标签构成一组，整组外圈蓝色圆角边框
 *   （浏览器标签分组效果；选中标签处底边断开保持与内容区连体）
 * - closable 标签显示 hover ×（点击关闭不触发切换）
 */
export default function Tabs({ items, value, onChange, onClose, embedded }: {
  items: TabItem[]
  value: string
  onChange: (key: string) => void
  onClose?: (key: string) => void
  /** 内嵌标题栏模式：透明背景、垂直居中、圆角矩形选中态（不占用单独一行） */
  embedded?: boolean
}) {
  // 分组：以非 indent 标签开头，其后连续 indent 标签归入同组（组成一个整体）
  const groups: { items: TabItem[] }[] = []
  for (const t of items) {
    const last = groups[groups.length - 1]
    if (t.indent && last && last.items.length >= 1 && !last.items[0].indent) {
      last.items.push(t)
    } else {
      groups.push({ items: [t] })
    }
  }

  /** 活动标签自动滚入可视区（快捷键/追加标签切换后，标签条滚动让高亮标签可见） */
  const stripRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    const active = strip.querySelector<HTMLElement>(`[data-tab-key="${CSS.escape(value)}"]`)
    active?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  }, [value, items])

  const renderTab = (t: TabItem, inGroup: boolean) => {
    const active = t.key === value
    const closeIcon = t.dirty ? '●' : '×'
    if (embedded) {
      return (
        <div
          key={t.key}
          data-tab-key={t.key}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          className={`flex items-center h-9 px-3 gap-1.5 text-[13px] whitespace-nowrap shrink-0 rounded-lg transition-colors select-none cursor-pointer
            ${active
              ? 'bg-blue-500/10 text-blue-600 font-semibold'
              : (t.indent
                ? 'bg-slate-100 text-slate-500 hover:bg-slate-200/80 hover:text-slate-700'
                : 'text-slate-500 hover:bg-black/5 hover:text-slate-700')}`}
          onClick={() => onChange(t.key)}
        >
          <span className="min-w-0">{t.label}</span>
          {t.closable && onClose && (
            <button
              className={`w-4 h-4 shrink-0 rounded flex items-center justify-center text-[11px] leading-none transition-colors
                ${active ? 'text-blue-400 hover:text-red-500 hover:bg-red-100' : 'text-slate-300 hover:text-red-500 hover:bg-red-50'}`}
              onClick={(e) => { e.stopPropagation(); onClose(t.key) }}
              data-tip="关闭"
            >
              {closeIcon}
            </button>
          )}
        </div>
      )
    }
    // 独立行模式：顶部圆角连体样式
    const mb = active ? (inGroup ? '-mb-0.5' : '-mb-px') : ''
    return (
      <div
        key={t.key}
        data-tab-key={t.key}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        className={`flex items-center h-9 pl-3 pr-2 gap-1.5 text-[13px] whitespace-nowrap shrink-0 rounded-t-lg transition-colors select-none border cursor-pointer
          ${active
            ? (t.indent
              ? `bg-slate-100 text-blue-600 font-semibold border-black/10 border-b-slate-100 ${mb} shadow-[0_-2px_8px_rgba(0,0,0,0.04)]`
              : `bg-white text-blue-600 font-semibold border-black/10 border-b-white ${mb} shadow-[0_-2px_8px_rgba(0,0,0,0.04)]`)
            : (t.indent
              ? 'bg-slate-100 text-slate-500 hover:bg-slate-200/80 hover:text-slate-700 border-transparent'
              : 'text-slate-500 hover:text-slate-700 hover:bg-black/[0.04] border-transparent')}`}
        onClick={() => onChange(t.key)}
      >
        <span className="min-w-0">{t.label}</span>
        {t.closable && onClose && (
          <button
            className={`w-4 h-4 shrink-0 rounded flex items-center justify-center text-[11px] leading-none transition-colors
              ${active
                ? 'text-blue-400 hover:text-red-500 hover:bg-red-50'
                : 'text-slate-300 hover:text-red-500 hover:bg-red-50'}`}
            onClick={(e) => { e.stopPropagation(); onClose(t.key) }}
            data-tip="关闭"
          >
            ×
          </button>
        )}
      </div>
    )
  }

  if (embedded) {
    return (
      <div ref={stripRef} className="flex items-center gap-0.5 shrink-0 overflow-x-auto">
        {groups.map((g) => {
          const grouped = g.items.length > 1 && !g.items[0].indent
          return grouped ? (
            <div key={g.items[0].key} className="flex items-center border border-blue-400/60 rounded-lg mr-1">
              {g.items.map((t) => renderTab(t, true))}
            </div>
          ) : (
            <div key={g.items[0].key} className="flex items-center">
              {g.items.map((t) => renderTab(t, false))}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div ref={stripRef} className="flex items-end gap-0.5 px-3 pt-1.5 pb-0 bg-white border-b border-black/5 shrink-0 overflow-x-auto">
      {groups.map((g) => {
        const grouped = g.items.length > 1 && !g.items[0].indent
        return grouped ? (
          <div key={g.items[0].key} className="flex items-end border-2 border-blue-400/60 rounded-t-[8px]">
            {g.items.map((t) => renderTab(t, true))}
          </div>
        ) : (
          <div key={g.items[0].key} className="flex items-end">
            {g.items.map((t) => renderTab(t, false))}
          </div>
        )
      })}
      <div className="flex-1" />
    </div>
  )
}
