// 图书馆页共享卡片与弹窗外壳（自 LibraryPage 拆出，行为不变）：
// Modal / StatBox / BookCard / FolderCard / FolderView / filteredThoughts

import type { Book, FolderData, Thought, ThoughtStoreData } from '../../../shared/models'
import BookCover from '../BookCover'
import Icon from '../ui/Icon'
import { shade } from '../../lib/ui'
import { dateKey } from '../Calendar'

export function Modal({ children, onClose, width = 520 }: { children: React.ReactNode; onClose: () => void; width?: number }) {
  return (
    <div className="absolute inset-0 bg-black/40 flex items-center justify-center z-40"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="glass-card rounded-2xl max-h-[80%] overflow-y-auto p-5"
        style={{ width }}>{children}</div>
    </div>
  )
}

export function StatBox({ label, value }: { label: string; value: number }) {
  return (
    <div className="text-center">
      <div className="text-[16px] font-semibold text-slate-800">{value}</div>
      <div className="text-[10px] text-slate-400">{label}</div>
    </div>
  )
}

export function BookCard({ book, createdToday, onClick, multi, selected, onSelect, onContextMenu, onToggleStar, onTogglePin }: {
  book: Book
  /** 日期筛选时该书当日创建的笔记数（退出筛选不传则不显示） */
  createdToday?: number
  onClick: () => void
  /** 多选管理模式 */
  multi?: boolean
  selected?: boolean
  onSelect?: () => void
  onContextMenu?: (e: React.MouseEvent) => void
  /** 收藏/置顶切换回调（不传则按钮隐藏） */
  onToggleStar?: () => void
  onTogglePin?: () => void
}) {
  return (
    <div
      className={`cursor-pointer group relative ${selected ? 'ring-2 ring-blue-500 rounded-xl' : ''}`}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      {/* 封面：不再叠文字（文字移到卡片下方） */}
      <div className="aspect-[3/4] rounded-xl overflow-hidden relative shadow-sm group-hover:shadow-lg transition-shadow">
        {book.cover ? (
          <BookCover cover={book.cover} className="absolute inset-0 w-full h-full object-cover" />
        ) : (
          <div
            className="w-full h-full flex items-center justify-center text-white text-[26px] font-semibold"
            style={{ background: `linear-gradient(135deg, ${book.coverColor}, ${shade(book.coverColor, 0.72)})` }}
          >
            {book.title.charAt(0) || '书'}
          </div>
        )}
        {/* 多选勾选框 */}
        {multi && (
          <div
            className={`absolute top-2 left-2 w-5 h-5 rounded-md flex items-center justify-center text-[12px] text-white transition-colors cursor-pointer shadow
              ${selected ? 'bg-blue-500' : 'bg-black/40 hover:bg-black/60'}`}
            onClick={(e) => { e.stopPropagation(); onSelect?.() }}
          >
            {selected && '✓'}
          </div>
        )}
        {/* 收藏/置顶按钮：hover 卡片浮现；常显已标记状态 */}
        {!multi && (onToggleStar || onTogglePin) && (
          <div className="absolute top-2 right-2 flex flex-col gap-1.5 transition-opacity">
            {onTogglePin && (
              <button
                className={`w-6 h-6 rounded-md flex items-center justify-center shadow transition-opacity ${book.pinned ? 'text-blue-500 bg-white/90 opacity-100' : 'text-slate-600 bg-white/90 opacity-0 group-hover:opacity-100 hover:text-blue-500'}`}
                onClick={(e) => { e.stopPropagation(); onTogglePin() }}
                data-tip={book.pinned ? '取消置顶' : '置顶'}
              >
                <Icon name="pin" size={13} />
              </button>
            )}
            {onToggleStar && (
              <button
                className={`w-6 h-6 rounded-md flex items-center justify-center shadow transition-opacity ${book.starred ? 'text-amber-500 bg-white/90 opacity-100' : 'text-slate-600 bg-white/90 opacity-0 group-hover:opacity-100 hover:text-amber-500'}`}
                onClick={(e) => { e.stopPropagation(); onToggleStar() }}
                data-tip={book.starred ? '取消收藏' : '收藏'}
              >
                <Icon name="star" size={13} />
              </button>
            )}
          </div>
        )}
      </div>
      {/* 文字区：两行紧凑（书名 + 作者·笔记数），不占地方也不拥挤 */}
      <div className="pt-2 px-0.5">
        {/* 外层 span 承载统一 tooltip（truncate 的 overflow 会裁掉 ::after 气泡，故不能直接放 p 上） */}
        <span data-tip={book.title} className="block">
          <p className="text-[13px] font-medium text-slate-800 leading-snug truncate">{book.title}</p>
        </span>
        <p className="text-[10px] text-slate-400 mt-0.5 truncate">
          {book.author || '未知作者'}
          {book.notes.length > 0 ? ` · ${book.notes.length} 条笔记` : ''}
          {createdToday ? ` · 当日 ${createdToday}` : ''}
        </p>
      </div>
    </div>
  )
}

/** 书籍文件夹卡片：液态玻璃背景 + 2×2 固定格位缩略书（超出显示 +N 角标） */
export function FolderCard({ folder, books, onClick }: {
  folder: FolderData
  books: Book[]
  onClick: () => void
}) {
  const thumbs = books.slice(0, 4)
  return (
    <div className="cursor-pointer group" onClick={onClick}>
      <div
        className="aspect-[3/4] rounded-xl overflow-hidden relative shadow-sm group-hover:shadow-lg transition-shadow"
        style={{
          background: 'linear-gradient(145deg, rgba(255,255,255,0.55), rgba(255,255,255,0.18))',
          backdropFilter: 'blur(14px) saturate(1.2)',
          WebkitBackdropFilter: 'blur(14px) saturate(1.2)',
          border: '1px solid rgba(255,255,255,0.65)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.6), 0 4px 16px rgba(99,102,241,0.12)',
        }}
      >
        {/* 液态玻璃内缩略书（固定格位，不随数量缩放） */}
        <div className="grid grid-cols-2 grid-rows-2 gap-1.5 p-3 w-full h-full">
          {thumbs.map((b) => (
            <div key={b.id} className="rounded-md overflow-hidden relative min-h-0">
              {b.cover ? (
                <BookCover cover={b.cover} className="absolute inset-0 w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-white text-[14px] font-semibold"
                  style={{ background: `linear-gradient(135deg, ${b.coverColor}, ${shade(b.coverColor, 0.72)})` }}>
                  {b.title.charAt(0) || '书'}
                </div>
              )}
            </div>
          ))}
          {Array.from({ length: Math.max(0, 4 - thumbs.length) }).map((_, i) => (
            <div key={`e${i}`} className="rounded-md bg-white/50 border border-white/50 min-h-0" />
          ))}
        </div>
        {/* 超出角标 */}
        {books.length > 4 && (
          <span className="absolute bottom-2 right-2 h-5 px-2 rounded-full bg-blue-500/90 text-white text-[11px] flex items-center shadow">
            +{books.length - 4}
          </span>
        )}
        <div className="absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-white/40 to-transparent pointer-events-none" />
      </div>
      {/* 文字区 */}
      <div className="pt-2 px-0.5">
        <span data-tip={folder.name} className="block">
          <p className="text-[13px] font-medium text-slate-800 leading-snug truncate">{folder.name}</p>
        </span>
        <p className="text-[10px] text-slate-400 mt-0.5 truncate">{books.length} 本书</p>
      </div>
    </div>
  )
}

/** 文件夹标签页内容：仅显示文件夹内的书；右键书籍进入多选管理（菜单含"移出分组/取消该分组"） */
export function FolderView({ folder, books, onOpenBook, multi, selectedSet, onToggle, onContextMenu, onStar, onPin }: {
  folder: FolderData | null
  books: Book[]
  onOpenBook: (id: number, title: string) => void
  /** 多选模式（书架多选联动：勾选/单击切换） */
  multi?: boolean
  selectedSet?: Set<number>
  onToggle?: (id: number) => void
  onContextMenu?: (e: React.MouseEvent, bookId: number) => void
  /** 收藏/置顶回调（不传则 BookCard 隐藏对应按钮） */
  onStar?: (id: number) => void
  onPin?: (id: number) => void
}) {
  if (!folder) {
    return (
      <div className="w-full h-full flex items-center justify-center text-slate-400 text-sm">
        文件夹不存在或已删除
      </div>
    )
  }
  return (
    <div className="w-full h-full flex flex-col">
      <div className="shrink-0 flex items-center gap-2 px-5 pt-4 pb-1">
        <span className="text-[15px] font-semibold text-slate-800">{folder.name}</span>
        <span className="text-[12px] text-slate-400">{books.length} 本书</span>
        <div className="flex-1" />
        <span className="text-[11px] text-slate-400">右键书籍进入多选管理（移出分组 / 取消该分组）</span>
      </div>
      <div className="flex-1 overflow-y-auto p-5">
        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, 140px)', justifyContent: 'start' }}>
          {books.map((b) => (
            <BookCard key={b.id} book={b}
              multi={multi}
              selected={selectedSet?.has(b.id)}
              onSelect={() => onToggle?.(b.id)}
              onClick={() => { if (multi) onToggle?.(b.id); else onOpenBook(b.id, b.title) }}
              onContextMenu={(e) => onContextMenu?.(e, b.id)}
              onToggleStar={onStar ? () => onStar(b.id) : undefined}
              onTogglePin={onPin ? () => onPin(b.id) : undefined}
            />
          ))}
        </div>
        {books.length === 0 && (
          <p className="text-center text-slate-400 text-[13px] py-12">文件夹是空的，可从书架多选书籍后「分组」移入</p>
        )}
      </div>
    </div>
  )
}

/** 闪念过滤+排序：置顶排前（收藏仅作标记不改序）> 时间倒序；与「只看收藏/置顶」「按日期」筛选叠加 */
export function filteredThoughts(thoughts: ThoughtStoreData | null, selectedDate: string | null, starOnly = false, pinOnly = false): Thought[] {
  let list = thoughts?.thoughts ?? []
  if (starOnly) list = list.filter((t) => t.starred === true)
  if (pinOnly) list = list.filter((t) => t.pinned === true)
  const filtered = selectedDate
    ? list.filter((t) => dateKey(new Date(t.createdAt)) === selectedDate)
    : list
  return [...filtered].sort((a, b) => {
    const pa = a.pinned ? 1 : 0, pb = b.pinned ? 1 : 0
    if (pa !== pb) return pb - pa
    return b.createdAt.localeCompare(a.createdAt)
  })
}
