import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Book, BookStore, Note, NoteDraftsData } from '../../shared/models'
import { noteToPlainText } from '../lib/mdLexical'
import { exportNoteFile, shareNoteFile, type NoteExportKind } from '../lib/noteExport'
import { dateKey } from './Calendar'
import Icon from '../components/ui/Icon'
import BookCover from '../components/BookCover'
import ExportFormatMenu from '../components/ui/ExportFormatMenu'
import { saveStore } from '../lib/storeSave'
import { shade, useToast } from '../lib/ui'

/**
 * 书籍详情视图（图书馆 tabs 内嵌，组件化自原独立窗口）：
 * 详情视图 ↔ 章节笔记视图；章节树（展开/收起），新建章节、双击编辑笔记、右键分享/删除；
 * 数据经 store:changed 自动刷新。本标签固定为打开时的书籍（无切书，上/下方向键由图书馆页切换标签页）。
 */
export default function BookDetailView({ bookId, onEditNote, onClose, onDeleteBook, globalDate }: {
  bookId: number
  /** 打开笔记编辑 tab：noteId 为 null 表示新建（带章节）；titleHint 用于标签标题 */
  onEditNote: (bookId: number, noteId: number | null, chapter: string, titleHint?: string) => void
  onClose: () => void
  /** 删除书籍（图书馆页负责删除数据 + 关闭标签，本组件只弹确认） */
  onDeleteBook?: (id: number) => void
  /** 左侧栏日历选中的全局日期（yyyy-MM-dd 或空）；选中时本章节视图同步按当天筛选 */
  globalDate?: string | null
}) {
  const [book, setBook] = useState<Book | null>(null)
  const [view, setView] = useState<'detail' | 'chapters'>('detail')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [chapterDialog, setChapterDialog] = useState(false)
  const [newChapterName, setNewChapterName] = useState('')
  const [ctx, setCtx] = useState<{ x: number; y: number; note: Note } | null>(null)
  /** 右键菜单内"导出"子浮层开关 */
  const [ctxExportOpen, setCtxExportOpen] = useState(false)
  /** 右键菜单内"分享"子浮层开关 */
  const [ctxShareOpen, setCtxShareOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<Note | null>(null)
  // toast 状态由 useToast Hook 管理（见 lib/ui.ts）
  /** 组件根节点（右键菜单坐标换算为容器相对坐标，避免偏移） */
  const rootRef = useRef<HTMLDivElement>(null)

  // ---- 右上角更多菜单（分享/删除书籍） ----
  const [moreOpen, setMoreOpen] = useState(false)
  const [bookDelete, setBookDelete] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)      // 详情视图 ⋯
  const moreRefCh = useRef<HTMLDivElement>(null)    // 章节视图 ⋯

  // ---- 章节笔记筛选（#6 时间+标签；#7 趋势点击 = 指定日期） ----
  const [filterOpen, setFilterOpen] = useState(false)
  const [dateFilter, setDateFilter] = useState<string>('all')   // 'all' | 'today' | '7d' | '30d' | 'yyyy-MM-dd'
  const [tagFilter, setTagFilter] = useState('')                // '' = 全部
  const filterRef = useRef<HTMLDivElement>(null)

  // 全局日历日期联动：左侧栏选中日期 → 章节视图同步按当天筛选；清除时恢复全部
  const lastGlobalDate = useRef<string | null>(null)
  useEffect(() => {
    const g = globalDate ?? null
    if (g) {
      lastGlobalDate.current = g
      setDateFilter(g)
      setTagFilter('')
    } else if (lastGlobalDate.current) {
      lastGlobalDate.current = null
      setDateFilter('all')
    }
  }, [globalDate])

  // 当前书籍 id（固定为本标签的 bookId）；loadSeq 防快速切换时旧数据覆盖新数据
  const loadSeq = useRef(0)

  const loadBook = useCallback((id: number) => {
    const seq = ++loadSeq.current
    void window.api.store.load<BookStore>('books').then((data) => {
      if (seq !== loadSeq.current) return   // 已有更新的加载请求，丢弃过期结果
      const b = data.books.find((x) => x.id === id) ?? null
      setBook(b)
      setExpanded(new Set())   // 章节树默认收起（不自动展开）
    })
  }, [])

  useEffect(() => { loadBook(bookId) }, [bookId, loadBook])

  // 数据变更（新建/编辑/删除笔记、新建章节等）自动刷新——创建笔记后立即可见
  useEffect(() => window.api.store.onChanged('books', () => loadBook(bookId)), [bookId, loadBook])

  // 快捷键：←/→ 切换 详情↔章节（上/下方向键由图书馆页用于切换标签页）
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (e.key === 'ArrowLeft') { e.preventDefault(); setView('detail') }
      else if (e.key === 'ArrowRight') { e.preventDefault(); setView('chapters') }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  // 更多菜单 / 筛选面板：点击外部关闭
  useEffect(() => {
    const h = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (moreOpen && !moreRef.current?.contains(t) && !moreRefCh.current?.contains(t)) setMoreOpen(false)
      if (filterOpen && !filterRef.current?.contains(t)) setFilterOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [moreOpen, filterOpen])

  const persist = async (next: Book) => {
    const data = await window.api.store.load<BookStore>('books')
    const idx = data.books.findIndex((x) => x.id === next.id)
    if (idx >= 0) data.books[idx] = next
    else data.books.push(next)
    const ok = await saveStore('books', data)
    if (!ok) { showToast('保存失败，请重试', true); return }
  }

  const { toast, showToast } = useToast(2200)

  // ---- 章节列表：笔记派生章节 + 自建章节（含空白），按最早笔记时间排序，空章节排最后。
  //      历史笔记可能 chapter 为空字符串：归入「未分类」展示，避免"笔记存在但章节树找不到" ----
  const chapters = useMemo(() => {
    if (!book) return [] as string[]
    const set = new Set<string>(book.chapters ?? [])
    for (const n of book.notes) set.add(n.chapter || '未分类')
    const earliest = (c: string) => {
      const times = book.notes.filter((n) => (n.chapter || '未分类') === c).map((n) => n.createdAt)
      return times.length ? times.sort()[0] : '9999-99-99'
    }
    return [...set].sort((a, b) => earliest(a).localeCompare(earliest(b)))
  }, [book])

  const notesOf = (chapter: string): Note[] =>
    (book?.notes ?? []).filter((n) => (n.chapter || '未分类') === chapter)
      .slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  // ---- 章节笔记筛选（#6：时间 + 标签；#7 趋势点击 = 指定日期） ----
  const isFiltering = dateFilter !== 'all' || tagFilter !== ''
  const matchesFilter = (n: Note): boolean => {
    if (tagFilter && !n.tags.includes(tagFilter)) return false
    if (dateFilter === 'all') return true
    const day = dateKey(new Date(n.createdAt))
    if (dateFilter === 'today') return day === dateKey(new Date())
    if (dateFilter === '7d' || dateFilter === '30d') {
      const days = dateFilter === '7d' ? 6 : 29
      const d = new Date(); d.setHours(0, 0, 0, 0)
      const t = new Date(n.createdAt).getTime()
      const start = d.getTime() - days * 86400000
      return t >= start && t <= d.getTime() + 86400000
    }
    return day === dateFilter   // 指定日期
  }
  const visibleChapters = isFiltering
    ? chapters.filter((ch) => notesOf(ch).some(matchesFilter))
    : chapters
  const notesOfFiltered = (ch: string): Note[] =>
    isFiltering ? notesOf(ch).filter(matchesFilter) : notesOf(ch)
  /** 该书全部笔记标签（筛选面板用） */
  const allNoteTags = useMemo(() => {
    const set = new Set<string>()
    for (const n of book?.notes ?? []) n.tags.forEach((t) => set.add(t))
    return [...set].sort()
  }, [book])
  const resetFilter = () => { setDateFilter('all'); setTagFilter('') }
  /** 筛选后的笔记总数（未筛选 = 全部） */
  const filteredNoteCount = isFiltering
    ? visibleChapters.reduce((s, ch) => s + notesOfFiltered(ch).length, 0)
    : book?.notes.length ?? 0

  /** 趋势点击：跳转章节视图并按当天筛选（#7） */
  const jumpToDay = (i: number) => {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (6 - i))
    setDateFilter(dateKey(d))
    setTagFilter('')
    setView('chapters')
  }

  // ---- 更多菜单（分享/导出压缩包 + 删除） ----
  const [bookShareOpen, setBookShareOpen] = useState(false)
  const [bookExportOpen, setBookExportOpen] = useState(false)

  /** 导出书籍压缩包（保存对话框，默认进"文档"；RAR 未装自动回退 ZIP） */
  const bookExport = async (format: 'zip' | 'rar') => {
    if (!book) return
    setBookExportOpen(false)
    setMoreOpen(false)
    const res = await window.api.books.pack(book.id, format)
    if (res.ok) {
      if (res.rarMissing) showToast(`未检测到 WinRAR，已改用 ZIP 导出：${res.path}`)
      else showToast(`已导出：${res.path}`)
    } else if (!res.canceled) showToast(res.error ?? '导出失败', true)
  }

  /** 分享书籍压缩包（打包临时文件 + 系统共享流程：资源管理器选中 + 提醒） */
  const bookShare = async (format: 'zip' | 'rar') => {
    if (!book) return
    setBookShareOpen(false)
    setMoreOpen(false)
    const res = await window.api.books.packTemp(book.id, format)
    if (res.ok && res.path) {
      await window.api.note.showInFolder(res.path)
      const name = res.rarMissing ? 'ZIP' : format === 'rar' ? 'RAR' : 'ZIP'
      showToast(`系统共享不支持文件，已导出${name}压缩包并在资源管理器中选中，可右键「共享」`)
    } else {
      showToast(res.error ?? '分享失败', true)
    }
  }

  /** 更多菜单（详情/章节两处共用；绝对定位相对各自按钮容器；分享/导出为格式子浮层） */
  const moreMenu = moreOpen && book ? (
    <div className="absolute right-0 top-9 z-30 w-28 bg-white rounded-xl shadow-lg border border-slate-100 p-1">
      <button className="w-full h-8 rounded-lg px-3 text-left text-[13px] text-slate-700 hover:bg-slate-50"
        onClick={() => { setBookShareOpen(!bookShareOpen); setBookExportOpen(false) }}>
        分享
      </button>
      <button className="w-full h-8 rounded-lg px-3 text-left text-[13px] text-slate-700 hover:bg-slate-50"
        onClick={() => { setBookExportOpen(!bookExportOpen); setBookShareOpen(false) }}>
        导出
      </button>
      <button className="w-full h-8 rounded-lg px-3 text-left text-[13px] text-red-500 hover:bg-red-50"
        onClick={() => { setMoreOpen(false); setBookDelete(true) }}>
        删除
      </button>
      {/* 分享子浮层（ZIP/RAR） */}
      {bookShareOpen && (
        <div className="absolute right-full top-0 mr-1 z-50 w-36 bg-white rounded-xl shadow-lg border border-slate-100 py-1">
          <button className="w-full h-9 px-3 text-left text-[13px] text-slate-700 hover:bg-slate-100 transition-colors"
            onClick={() => void bookShare('zip')}>
            分享为ZIP
          </button>
          <div className="border-t border-dashed border-slate-300" />
          <button className="w-full h-9 px-3 text-left text-[13px] text-slate-700 hover:bg-slate-100 transition-colors"
            onClick={() => void bookShare('rar')}>
            分享为RAR
          </button>
        </div>
      )}
      {/* 导出子浮层（ZIP/RAR） */}
      {bookExportOpen && (
        <div className="absolute right-full top-0 mr-1 z-50 w-36 bg-white rounded-xl shadow-lg border border-slate-100 py-1">
          <button className="w-full h-9 px-3 text-left text-[13px] text-slate-700 hover:bg-slate-100 transition-colors"
            onClick={() => void bookExport('zip')}>
            导出为ZIP
          </button>
          <div className="border-t border-dashed border-slate-300" />
          <button className="w-full h-9 px-3 text-left text-[13px] text-slate-700 hover:bg-slate-100 transition-colors"
            onClick={() => void bookExport('rar')}>
            导出为RAR
          </button>
        </div>
      )}
    </div>
  ) : null

  // ---- 新建章节 ----
  const createChapter = async () => {
    const name = newChapterName.trim()
    if (!name) { showToast('请输入章节名称', true); return }
    if (!book) return
    const next: Book = { ...book, chapters: [...(book.chapters ?? []), name] }
    setBook(next)
    await persist(next)
    setChapterDialog(false)
    setNewChapterName('')
    setExpanded((s) => new Set(s).add(name))   // 新章节默认展开
    showToast('章节已创建')
  }

  // ---- 右键菜单 ----
  const onNoteContextMenu = (e: React.MouseEvent, note: Note) => {
    e.preventDefault()
    e.stopPropagation()
    // 菜单用容器相对坐标定位（clientX/Y 是视口坐标，直接当容器坐标会整体偏移）
    const r = rootRef.current?.getBoundingClientRect()
    const MENU_W = 112
    const MENU_H = 76
    let x = r ? e.clientX - r.left : e.clientX
    let y = r ? e.clientY - r.top : e.clientY
    if (r) {
      x = Math.min(Math.max(x, 4), r.width - MENU_W - 4)
      y = Math.min(Math.max(y, 4), r.height - MENU_H - 4)
    }
    setCtx({ x, y, note })
  }
  const closeCtx = () => setCtx(null)

  /** 分享（按格式：文本类走系统共享面板，文件类导出临时文件并在资源管理器选中；原"复制到剪贴板"被完全替代） */
  const shareNote = async (note: Note, kind: NoteExportKind) => {
    setCtxShareOpen(false)
    closeCtx()
    if (kind !== 'png' && !noteToPlainText(note.content).trim()) { showToast('内容为空，无法分享', true); return }
    const res = await shareNoteFile({ title: note.title, content: note.content }, kind)
    if (res.ok) showToast(res.notice ?? '已分享')
    else showToast(res.error ?? '分享失败', true)
  }

  /** 导出（与笔记编辑页同源：图片/纯文本/word/markdown/html，文件名 = 标题，默认进"文档"文件夹） */
  const exportNote = async (note: Note, kind: NoteExportKind) => {
    setCtxExportOpen(false)
    closeCtx()
    if (kind !== 'png' && !noteToPlainText(note.content).trim()) { showToast('内容为空，无法导出', true); return }
    const res = await exportNoteFile({ title: note.title, content: note.content }, kind)
    if (res.ok) showToast(`已导出：${res.path}`)
    else if (!res.canceled) showToast(res.error ?? '导出失败，请重试', true)
  }
  const doDelete = async (note: Note) => {
    if (!book) return
    const next: Book = { ...book, notes: book.notes.filter((n) => n.id !== note.id) }
    setBook(next)
    await persist(next)
    setConfirmDelete(null)
    closeCtx()
    // 清除该笔记草稿：否则残留草稿会在新笔记复用同 id 时把已删内容"复活"
    try {
      const drafts = await window.api.store.load<NoteDraftsData>('note-drafts')
      if (drafts.drafts[`${book.id}:${note.id}`]) {
        delete drafts.drafts[`${book.id}:${note.id}`]
        await saveStore('note-drafts', drafts)
      }
    } catch { /* 草稿清理失败不阻塞删除 */ }
    showToast('笔记已删除')
  }

  // ---- 详情视图数据 ----
  const trend = useMemo(() => {
    const counts = new Array(7).fill(0)
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    for (const n of book?.notes ?? []) {
      const d = new Date(n.createdAt)
      d.setHours(0, 0, 0, 0)
      const diff = Math.round((today.getTime() - d.getTime()) / 86400000)
      if (diff >= 0 && diff < 7) counts[6 - diff]++
    }
    const max = Math.max(...counts, 1)
    return counts.map((c) => Math.max(6, c * 56 / max))
  }, [book])

  if (!book) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center gap-3 text-slate-400 text-sm">
        书籍不存在或已删除
        <button className="h-8 px-4 rounded-lg bg-blue-500 text-white text-[12px] hover:bg-blue-600"
          onClick={onClose}>关闭标签页</button>
      </div>
    )
  }

  return (
    <div ref={rootRef} className="w-full h-full flex flex-col overflow-hidden relative">
      {/* 内容 */}
      <div className="flex-1 overflow-hidden flex">
        {view === 'detail' ? (
          <div className="flex-1 relative min-w-0">
            {/* 右上角更多（分享/删除书籍） */}
            <div className="absolute top-3 right-3 z-20" ref={moreRef}>
              <button
                className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
                onClick={() => setMoreOpen(!moreOpen)}
                data-tip="更多"
              >
                <Icon name="more" size={16} />
              </button>
              {moreMenu}
            </div>
            <div className="h-full overflow-y-auto p-6">
              <div className="flex gap-5">
                {/* 封面：有图显示真实封面，无图渐变占位 */}
                <div className="w-28 h-36 rounded-xl overflow-hidden shrink-0 relative shadow-sm">
                  {book.cover ? (
                    <BookCover cover={book.cover} className="w-full h-full object-cover" />
                  ) : (
                    <div
                      className="w-full h-full flex items-center justify-center text-4xl font-semibold text-white"
                      style={{ background: `linear-gradient(135deg, ${book.coverColor}, ${shade(book.coverColor, 0.72)})` }}
                    >
                      {book.title.charAt(0) || '书'}
                    </div>
                  )}
                </div>
                <div className="flex flex-col justify-center gap-1.5 min-w-0">
                  <h1 className="text-xl font-semibold text-slate-800">{book.title}</h1>
                  <p className="text-[13px] text-slate-400">{book.author || '未知作者'}{book.publisher ? ` · ${book.publisher}` : ''}{book.edition ? ` · ${book.edition}` : ''}</p>
                  {book.tags.length > 0 && (
                    <p className="text-[12px] text-blue-500">{book.tags.map((t) => `#${t}`).join('  ')}</p>
                  )}
                  <p className="text-[12px] text-slate-500 mt-1">{book.description || '暂无简介'}</p>
                </div>
              </div>
              <div className="flex gap-4 mt-6">
                <Stat label="笔记" value={book.notes.length} />
                <Stat label="章节" value={chapters.length} />
                <Stat label="创建" value={new Date(book.createdAt).toLocaleDateString('zh-CN')} />
              </div>
              <div className="mt-5">
                <p className="text-[12px] text-slate-400 mb-2">近 7 日笔记趋势（点击柱子查看当天笔记）</p>
                <div className="flex items-end gap-1.5 h-16">
                  {trend.map((h, i) => {
                    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (6 - i))
                    return (
                      <button key={i}
                        className="flex-1 rounded-t bg-blue-400/70 hover:bg-blue-500 active:scale-y-95 transition-all cursor-pointer"
                        style={{ height: h }}
                        data-tip={`${d.toLocaleDateString('zh-CN')} · ${trend[i]} 条`}
                        onClick={() => jumpToDay(i)}
                      />
                    )
                  })}
                </div>
              </div>
              <button
                className="mt-6 h-9 px-5 rounded-lg bg-blue-500 text-white text-[13px] hover:bg-blue-600 active:scale-95 transition"
                onClick={() => setView('chapters')}
              >
                查看章节笔记
              </button>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* 顶部工具行：返回详情 + 统计（含筛选计数） + 筛选 + 更多 + 新建章节 */}
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-black/5 shrink-0">
              <button
                className="w-8 h-8 shrink-0 flex items-center justify-center rounded-lg text-slate-600 hover:bg-black/5"
                onClick={() => setView('detail')}
                data-tip="返回详情"
              >
                <Icon name="back" size={18} />
              </button>
              <span className="text-[13px] text-slate-600">
                章节：{visibleChapters.length}章　笔记：{filteredNoteCount}条
                {isFiltering && <span className="text-blue-500 ml-1.5">（已筛选）</span>}
              </span>
              <div className="flex-1" />
              {/* 筛选按钮 */}
              <div className="relative" ref={filterRef}>
                <button
                  className={`w-8 h-8 flex items-center justify-center rounded-lg hover:bg-black/5 ${isFiltering ? 'text-blue-500' : 'text-slate-600'}`}
                  onClick={() => setFilterOpen(!filterOpen)}
                  data-tip="筛选笔记"
                >
                  <Icon name="filter" size={15} />
                  {isFiltering && <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-blue-500" />}
                </button>
                {filterOpen && (
                  <div className="absolute right-0 top-9 z-30 glass-card rounded-xl p-3 w-64">
                    <p className="text-[11px] text-slate-400 mb-1.5">按时间</p>
                    <div className="flex flex-wrap gap-1">
                      {([['all', '全部'], ['today', '今天'], ['7d', '近7天'], ['30d', '近30天']] as const).map(([v, label]) => (
                        <button key={v}
                          className={`h-7 px-2.5 rounded-full text-[12px] transition-colors ${dateFilter === v ? 'bg-blue-500 text-white' : 'bg-black/5 text-slate-600 hover:bg-black/10'}`}
                          onClick={() => setDateFilter(v)}>
                          {label}
                        </button>
                      ))}
                      {dateFilter !== 'all' && dateFilter !== 'today' && dateFilter !== '7d' && dateFilter !== '30d' && (
                        <span className="h-7 px-2.5 rounded-full text-[12px] bg-blue-500 text-white flex items-center gap-1">
                          {dateFilter.slice(5)}
                          <button className="hover:text-white/70" onClick={() => setDateFilter('all')}>×</button>
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-slate-400 mt-2 mb-1.5">按标签</p>
                    <div className="flex flex-wrap gap-1 max-h-28 overflow-y-auto">
                      <button
                        className={`h-7 px-2.5 rounded-full text-[12px] transition-colors ${tagFilter === '' ? 'bg-blue-500 text-white' : 'bg-black/5 text-slate-600 hover:bg-black/10'}`}
                        onClick={() => setTagFilter('')}>
                        全部
                      </button>
                      {allNoteTags.map((t) => (
                        <button key={t}
                          className={`h-7 px-2.5 rounded-full text-[12px] transition-colors ${tagFilter === t ? 'bg-blue-500 text-white' : 'bg-black/5 text-slate-600 hover:bg-black/10'}`}
                          onClick={() => setTagFilter(tagFilter === t ? '' : t)}>
                          {t}
                        </button>
                      ))}
                    </div>
                    {isFiltering && (
                      <button className="w-full mt-2 h-7 rounded-lg text-[12px] text-blue-500 hover:bg-blue-50" onClick={resetFilter}>
                        清除筛选
                      </button>
                    )}
                  </div>
                )}
              </div>
              {/* 更多（分享/删除书籍） */}
              <div className="relative" ref={moreRefCh}>
                <button
                  className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
                  onClick={() => setMoreOpen(!moreOpen)}
                  data-tip="更多"
                >
                  <Icon name="more" size={16} />
                </button>
                {moreMenu}
              </div>
              <button
                className="h-8 px-3 rounded-lg bg-blue-500 text-white text-[12px] hover:bg-blue-600 active:scale-95 transition"
                onClick={() => { setNewChapterName(''); setChapterDialog(true) }}
              >
                + 新建章节
              </button>
            </div>
            {/* 章节树（按筛选结果渲染） */}
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {isFiltering && visibleChapters.length === 0 && (
                <p className="text-center text-slate-400 text-[13px] py-10">没有符合条件的笔记</p>
              )}
              {visibleChapters.map((ch, i) => {
                const notes = notesOfFiltered(ch)
                const isOpen = expanded.has(ch)
                return (
                  <div key={ch} className="space-y-1.5">
                    {/* 章节模块 */}
                    <div
                      className="flex items-center gap-2 rounded-xl bg-white shadow-sm border border-black/5 px-3 h-11 cursor-pointer hover:shadow-md transition-shadow"
                      onClick={() => {
                        const next = new Set(expanded)
                        if (next.has(ch)) next.delete(ch)
                        else next.add(ch)
                        setExpanded(next)
                      }}
                    >
                      <Icon
                        name="chevron"
                        size={14}
                        className={`text-slate-400 transition-transform duration-200 ${isOpen ? 'rotate-90' : ''}`}
                      />
                      <span className="text-[14px] font-medium text-slate-800">
                        第{i + 1}章　{ch}
                      </span>
                      {/* 该章笔记总数（灰字；不随筛选变化，始终反映章节真实笔记量） */}
                      <span className="text-[12px] text-slate-400">
                        {notesOf(ch).length} 篇
                      </span>
                      <div className="flex-1" />
                      {/* 展开后右侧：创建笔记按钮 */}
                      {isOpen && (
                        <button
                          className="h-7 px-2.5 rounded-lg bg-slate-200/80 hover:bg-slate-300/80 text-[12px] text-slate-600 flex items-center gap-1 transition-colors"
                          onClick={(e) => {
                            e.stopPropagation()
                            onEditNote(bookId, null, ch)
                          }}
                        >
                          <Icon name="add" size={12} />
                          创建笔记
                        </button>
                      )}
                    </div>
                    {/* 展开的笔记列表（grid-template-rows 高度过渡动画） */}
                    <div className="grid transition-[grid-template-rows] duration-200 ease-out"
                      style={{ gridTemplateRows: isOpen ? '1fr' : '0fr' }}>
                      <div className="overflow-hidden min-h-0">
                        <div className="ml-7 space-y-1.5 pl-2 border-l-2 border-slate-100 pt-1">
                          {notes.map((n) => (
                            <div
                              key={n.id}
                              className="rounded-lg bg-slate-100 px-3 py-2.5 cursor-pointer hover:bg-slate-200/70 transition-colors"
                              onDoubleClick={() => onEditNote(bookId, n.id, n.chapter, n.title)}
                              onContextMenu={(e) => onNoteContextMenu(e, n)}
                              data-tip="双击进入笔记 · 右键更多操作"
                            >
                              <div className="flex items-center gap-2">
                                <span className="text-[13px] font-medium text-slate-800 truncate">{n.title}</span>
                                <span className="text-[11px] text-slate-400 shrink-0">
                                  {new Date(n.createdAt).toLocaleString('zh-CN')}
                                </span>
                              </div>
                              <p className="text-[12px] text-slate-500 mt-0.5 line-clamp-1">
                                {noteToPlainText(n.content).replace(/\n/g, ' ')}
                              </p>
                            </div>
                          ))}
                          {notes.length === 0 && (
                            <p className="text-[12px] text-slate-400 py-2 pl-1">该章节暂无笔记</p>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* 右键菜单（分享/导出/删除；分享与导出均为 5 格式子浮层） */}
      {ctx && (
        <div
          className="absolute z-40 w-28 bg-white rounded-xl shadow-lg border border-slate-100 p-1"
          style={{ left: ctx.x, top: ctx.y }}
        >
          <button className="w-full h-8 rounded-lg px-3 text-left text-[13px] text-slate-700 hover:bg-slate-50"
            onClick={() => { setCtxShareOpen(!ctxShareOpen); setCtxExportOpen(false) }}>
            分享
          </button>
          <button className="w-full h-8 rounded-lg px-3 text-left text-[13px] text-slate-700 hover:bg-slate-50"
            onClick={() => { setCtxExportOpen(!ctxExportOpen); setCtxShareOpen(false) }}>
            导出
          </button>
          <button className="w-full h-8 rounded-lg px-3 text-left text-[13px] text-red-500 hover:bg-red-50"
            onClick={() => { setConfirmDelete(ctx.note); setCtx(null) }}>
            删除
          </button>
          {/* 分享/导出子浮层：公共组件 */}
          {ctxShareOpen && (
            <ExportFormatMenu mode="share" className="absolute left-full top-0 ml-1 z-50"
              onSelect={(kind) => void shareNote(ctx.note, kind)} />
          )}
          {ctxExportOpen && (
            <ExportFormatMenu mode="export" className="absolute left-full top-0 ml-1 z-50"
              onSelect={(kind) => void exportNote(ctx.note, kind)} />
          )}
        </div>
      )}
      {/* 点击空白关闭右键菜单 */}
      {ctx && (
        <div className="absolute inset-0 z-30" onClick={closeCtx} onContextMenu={(e) => { e.preventDefault(); closeCtx() }} />
      )}

      {/* 新建章节弹窗（长条白底） */}
      {chapterDialog && (
        <div className="absolute inset-0 bg-black/30 flex items-center justify-center z-40"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setChapterDialog(false) }}>
          <div className="w-[440px] bg-white rounded-2xl p-5 shadow-xl">
            <p className="text-[15px] font-medium text-slate-800">新建章节</p>
            <div className="flex items-center gap-2 mt-4">
              <input
                autoFocus
                className="flex-1 h-9 rounded-lg border border-black/10 px-3 text-[13px] outline-none placeholder:text-slate-300"
                placeholder="新建章节"
                value={newChapterName}
                onChange={(e) => setNewChapterName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void createChapter() }}
              />
              <button
                className="h-9 px-5 rounded-lg bg-blue-500 text-white text-[13px] hover:bg-blue-600 active:scale-95 transition"
                onClick={() => void createChapter()}
              >
                创建
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除书籍确认（右上角更多 → 删除） */}
      {bookDelete && (
        <div className="absolute inset-0 bg-black/40 flex items-center justify-center z-40"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setBookDelete(false) }}>
          <div className="bg-white rounded-2xl w-72 p-5 shadow-xl">
            <p className="text-[15px] font-medium text-slate-800">删除书籍</p>
            <p className="text-[13px] text-slate-500 mt-2">删除后连同其下全部笔记均不可恢复，确定删除「{book?.title}」吗？</p>
            <div className="flex justify-end gap-2 mt-4">
              <button className="h-8 px-4 rounded-lg text-[13px] text-slate-600 hover:bg-slate-50"
                onClick={() => setBookDelete(false)}>取消</button>
              <button className="h-8 px-4 rounded-lg bg-red-500 text-white text-[13px] hover:bg-red-600"
                onClick={() => { setBookDelete(false); if (book) onDeleteBook?.(book.id) }}>删除</button>
            </div>
          </div>
        </div>
      )}

      {/* 删除确认 */}
      {confirmDelete && (
        <div className="absolute inset-0 bg-black/40 flex items-center justify-center z-40"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setConfirmDelete(null) }}>
          <div className="bg-white rounded-2xl w-72 p-5 shadow-xl">
            <p className="text-[15px] font-medium text-slate-800">删除笔记</p>
            <p className="text-[13px] text-slate-500 mt-2">删除后不可恢复，确定删除「{confirmDelete.title}」吗？</p>
            <div className="flex justify-end gap-2 mt-4">
              <button className="h-8 px-4 rounded-lg text-[13px] text-slate-600 hover:bg-slate-50"
                onClick={() => setConfirmDelete(null)}>取消</button>
              <button className="h-8 px-4 rounded-lg bg-red-500 text-white text-[13px] hover:bg-red-600"
                onClick={() => void doDelete(confirmDelete)}>删除</button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 glass-card rounded-full px-4 py-2"
          style={{ animation: 'toast-in 220ms ease-out' }}>
          <span className={`w-4 h-4 rounded-full flex items-center justify-center text-white text-[10px] ${toast.error ? 'bg-red-400' : 'bg-green-400'}`}>
            {toast.error ? '!' : '✓'}
          </span>
          <span className="text-[13px] text-slate-700">{toast.msg}</span>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="glass-card rounded-xl px-4 py-2.5 text-center">
      <div className="text-[16px] font-semibold text-slate-800">{value}</div>
      <div className="text-[11px] text-slate-400">{label}</div>
    </div>
  )
}

// shade 已迁移至 lib/ui.ts（与 LibraryPage 共用同一实现）
