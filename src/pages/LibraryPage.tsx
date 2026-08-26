import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Book, BookStore, CalendarData, FolderStoreData, LibrarySettingsData,
  NoteDraftsData, Thought, ThoughtStoreData,
} from '../../shared/models'
import type { BookSearchResult } from '../../shared/models'
import Icon from '../components/ui/Icon'
import NotePreview from '../components/NotePreview'
import ResizeHandles from '../components/ui/ResizeHandles'
import Tabs from '../components/ui/Tabs'
import ContentBoundary from '../components/ui/ContentBoundary'
import BookDetailView from '../components/BookDetailView'
import NoteEditorView from '../components/NoteEditorView'
import BookCover from '../components/BookCover'
import { dateKey, workCount } from '../components/Calendar'
import { useToday } from '../lib/useToday'
import { saveStore, updateStore } from '../lib/storeSave'
import { pickCoverColor, useToast } from '../lib/ui'
import { noteToPlainText } from '../lib/mdLexical'
import { noteTitleFromContent } from '../lib/lexical'
import { lexicalJsonToMarkdown } from '../lib/noteExport'
import { nextId } from '../lib/ids'
import { Modal, StatBox, BookCard, FolderCard, FolderView, filteredThoughts } from '../components/library/LibraryCards'
import { ActiveCalendar, useActivityCalendar } from '../components/library/ActiveCalendar'

type View = 'notes' | 'thoughts' | 'review' | 'ai'

/** 动态标签页：视图 / 书籍详情 / 笔记编辑 / 书籍文件夹（vscode 文档式，均可关闭，点击菜单/书卡等追加） */
type DocTab =
  | { key: string; kind: 'view'; view: View; title: string }
  | { key: string; kind: 'book'; bookId: number; title: string }
  | { key: string; kind: 'folder'; folderId: number; parentKey: string; title: string }
  | { key: string; kind: 'note'; bookId: number; noteId: number | null; chapter: string; parentKey: string; title: string; draftKey: string }

interface ChatMsg { text: string; isUser: boolean }

/**
 * 图书馆页：书籍→章节→笔记三级 + 闪念 + 每日回顾 + AI 助手 + 活跃日历。
 * 侧栏宽/窄切换；数据全部经 store IPC（books/thoughts/calendar/library）。
 */
export default function LibraryPage() {
  const [books, setBooks] = useState<BookStore | null>(null)
  const [thoughts, setThoughts] = useState<ThoughtStoreData | null>(null)
  const [cal, setCal] = useState<CalendarData | null>(null)
  const [lib, setLib] = useState<LibrarySettingsData | null>(null)
  const [folders, setFolders] = useState<FolderStoreData | null>(null)
  const [view, setView] = useState<View>('notes')
  const [narrow, setNarrow] = useState(false)
  // 闪念视图布局：list=整体 / grid=卡片（默认）；切换状态记忆于 localStorage
  const [thoughtLayout, setThoughtLayout] = useState<'list' | 'grid'>(() =>
    (localStorage.getItem('ballwork.thoughtsLayout') as 'list' | 'grid') || 'grid')
  // 只看收藏：true 时闪念列表仅显示已收藏条目（与日期筛选叠加）
  const [starFilter, setStarFilter] = useState(false)
  // 只看置顶：true 时闪念列表仅显示已置顶条目
  const [pinFilter, setPinFilter] = useState(false)
  // 卡片「更多」菜单：记录展开中的闪念 id（null = 全部关闭；单开互斥）
  const [thoughtMenuId, setThoughtMenuId] = useState<number | null>(null)
  const thoughtsScrollRef = useRef<HTMLDivElement>(null)
  const [maximized, setMaximized] = useState(false)
  const [gridCols, setGridCols] = useState(4)
  const gridRef = useRef<HTMLDivElement>(null)
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const [tagFilter, setTagFilter] = useState('')
  /** 顶部标签筛选下拉开关（默认收起，点击标签按钮展开） */
  const [tagFilterOpen, setTagFilterOpen] = useState(false)

  const [chat, setChat] = useState<ChatMsg[]>([])
  const [chatInput, setChatInput] = useState('')
  const [reviewText, setReviewText] = useState('')
  const [reviewing, setReviewing] = useState(false)

  // 弹窗状态
  const [bookDialog, setBookDialog] = useState(false)
  /** 新增书籍弹窗模式：search 搜索选书 / manual 手动填写 */
  const [bookMode, setBookMode] = useState<'search' | 'manual'>('search')
  /** 书名为空校验高亮 */
  const [titleError, setTitleError] = useState(false)
  /** 是否导入来源章节信息（默认勾选） */
  const [importChapters, setImportChapters] = useState(true)
  const [bookForm, setBookForm] = useState<{
    title: string; author: string; publisher: string; edition: string; desc: string; tags: string
    cover: string | null; chapters: string[]
  }>({
    title: '', author: '', publisher: '', edition: '', desc: '', tags: '', cover: null, chapters: [],
  })
  const [searchSource, setSearchSource] = useState<'weread' | 'douban'>('weread')
  const [searchKw, setSearchKw] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchResults, setSearchResults] = useState<BookSearchResult[]>([])
  const [selectedResult, setSelectedResult] = useState<BookSearchResult | null>(null)
  const [noteDialog, setNoteDialog] = useState<{ thought: Thought; bookId: number | null; chapter: string } | null>(null)
  const [libDialog, setLibDialog] = useState(false)

  const fileRef = useRef<HTMLInputElement>(null)

  // ---- tabs 文档标签（视图/书籍详情/笔记编辑，点击菜单或卡片打开，可关闭） ----
  // 初始默认打开「阅读笔记」标签页（第一个菜单项 = 最高频，进入即见）
  const [docs, setDocs] = useState<DocTab[]>([{ key: 'view-notes', kind: 'view', view: 'notes', title: '阅读笔记' }])
  const [activeDoc, setActiveDoc] = useState<string | null>('view-notes')
  const newNoteSeq = useRef(0)

  // ---- 返回上一级（Ctrl+Backspace）：标签导航历史栈，最多保留 5 步 ----
  const navStack = useRef<string[]>([])
  const activeRef = useRef<string | null>(null)
  activeRef.current = activeDoc   // 每次渲染同步（open 类函数内读取的是最近一次渲染的当前标签）
  /** 记录"当前标签"为上一级（用户主动打开/切换标签前调用；自动去重、栈上限 5） */
  const recordNav = () => {
    const cur = activeRef.current
    if (cur) navStack.current = [...navStack.current.filter((k) => k !== cur), cur].slice(-5)
  }
  /** Ctrl+Backspace：返回上一级（输入框/编辑器内不拦截，保留删除词行为） */
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (e.ctrlKey && e.key === 'Backspace') {
        e.preventDefault()
        const prev = navStack.current.pop()
        if (prev) setActiveDoc(prev)
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  const VIEW_LABELS: Record<View, string> = { notes: '阅读笔记', thoughts: '闪念', review: '每日回顾', ai: 'AI 助手' }

  /** 打开视图标签页：同视图复用，否则追加并激活（左侧栏菜单点击触发） */
  const openViewTab = (v: View) => {
    setView(v)
    const key = `view-${v}`
    recordNav()
    setDocs((ds) => (ds.some((d) => d.key === key) ? ds : [...ds, { key, kind: 'view', view: v, title: VIEW_LABELS[v] }]))
    setActiveDoc(key)
  }

  /** 打开书籍详情标签：同书复用，否则追加并激活（标签标题带书名号） */
  const openBookTab = (bookId: number, title: string) => {
    const key = `book-${bookId}`
    const tabTitle = title.includes('《') ? title : `《${title}》`
    recordNav()
    setDocs((ds) => (ds.some((d) => d.key === key) ? ds : [...ds, { key, kind: 'book', bookId, title: tabTitle }]))
    setActiveDoc(key)
  }

  /** 打开书籍文件夹标签：同文件夹复用；否则插入到「阅读笔记」标签组末尾（紧贴组内最后一个标签之后，同笔记标签机制） */
  const openFolderTab = (folderId: number, name: string) => {
    const key = `folder-${folderId}`
    const tabTitle = name.includes('「') ? name : `「${name}」`
    const parentKey = 'view-notes'
    recordNav()
    setDocs((ds) => {
      if (ds.some((d) => d.key === key)) return ds
      const tab: DocTab = { key, kind: 'folder', folderId, parentKey, title: tabTitle }
      const parentIdx = ds.findIndex((d) => d.key === parentKey)
      if (parentIdx < 0) return [...ds, tab]   // 阅读笔记标签不存在（防御）：追加末尾
      let insertAt = parentIdx + 1
      while (insertAt < ds.length
        && (ds[insertAt].kind === 'note' || ds[insertAt].kind === 'folder')
        && (ds[insertAt] as { parentKey?: string }).parentKey === parentKey) insertAt++
      const next = [...ds]
      next.splice(insertAt, 0, tab)
      return next
    })
    setActiveDoc(key)
  }

  /** 打开笔记编辑标签：同笔记复用（新建用自增 key），否则插入到所属书籍标签组末尾（浏览器分组式）。
   *  注意：笔记 id 是每本书内部分配的，key 必须带 bookId，否则不同书籍的同 id 笔记会串标签。 */
  const openNoteTab = (bookId: number, noteId: number | null, chapter: string, titleHint?: string) => {
    const key = noteId != null ? `note-${bookId}-${noteId}` : `note-new-${++newNoteSeq.current}`
    const parentKey = `book-${bookId}`
    recordNav()
    setDocs((ds) => {
      if (ds.some((d) => d.key === key)) return ds
      const tab: DocTab = {
        key, kind: 'note', bookId, noteId, chapter, parentKey,
        title: titleHint || (noteId != null ? '笔记' : '新笔记'),
        // 草稿 key：正式笔记 bookId:noteId；新建笔记用标签唯一 key（同书多新笔记不互踩）
        draftKey: noteId != null ? `${bookId}:${noteId}` : `${bookId}:new:${key}`,
      }
      const parentIdx = ds.findIndex((d) => d.key === parentKey)
      if (parentIdx < 0) return [...ds, tab]   // 书籍标签不存在（防御）：追加末尾
      // 插入到该书籍标签组末尾（紧贴组内最后一个标签之后）
      let insertAt = parentIdx + 1
      while (insertAt < ds.length && ds[insertAt].kind === 'note' && (ds[insertAt] as { parentKey?: string }).parentKey === parentKey) insertAt++
      const next = [...ds]
      next.splice(insertAt, 0, tab)
      return next
    })
    setActiveDoc(key)
  }

  /** 有未保存改动的笔记标签（驱动标签 × 变圆圈 + 关闭确认） */
  const [dirtyKeys, setDirtyKeys] = useState<Set<string>>(new Set())
  /** 笔记编辑器句柄（关闭确认时调用保存/舍弃） */
  const noteEditorRefs = useRef<Record<string, import('../components/NoteEditorView').NoteEditorHandle>>({})
  /** 待确认关闭的笔记标签 key */
  const [confirmClose, setConfirmClose] = useState<string | null>(null)

  /** 关闭入口：有未保存改动的笔记标签先弹保存确认，否则直接关闭 */
  const closeDoc = (key: string) => {
    const doc = docs.find((d) => d.key === key)
    if (doc?.kind === 'note' && dirtyKeys.has(key)) {
      setConfirmClose(key)
      return
    }
    doCloseDoc(key)
  }

  /** 实际关闭（绕过 dirty 检查） */
  const doCloseDoc = (key: string) => {
    const i = docs.findIndex((d) => d.key === key)
    if (i < 0) return
    const removed = new Set<string>([key])
    const doc = docs[i]
    if (doc.kind === 'book') {
      // 书籍标签关闭：其下全部笔记标签一并关闭
      for (const d of docs) if (d.kind === 'note' && d.parentKey === key) removed.add(d.key)
    }
    const next = docs.filter((d) => !removed.has(d.key))
    setDocs(next)
    // 清理已关闭标签的 dirty 状态（避免残留脏 key）
    setDirtyKeys((s) => {
      if (!removed.size) return s
      const ns = new Set(s)
      removed.forEach((k) => ns.delete(k))
      return ns.size === s.size ? s : ns
    })
    if (activeDoc && removed.has(activeDoc)) {
      const fallback = next[Math.min(i, next.length - 1)]
      if (fallback) {
        setActiveDoc(fallback.key)
        if (fallback.kind === 'view') setView(fallback.view)
      } else {
        setActiveDoc(null)
      }
    }
  }

  /** 上/下方向键切换标签页（上=前一个/左，下=后一个/右）：
   *  loop 循环——首尾相接；fixed 固定——边界不可切换（由设置决定） */
  const switchTab = (offset: number) => {
    if (docs.length === 0) return
    const idx = docs.findIndex((d) => d.key === activeDoc)
    if (idx < 0) return
    const mode = lib?.tabSwitchMode ?? 'loop'
    const target = mode === 'fixed'
      ? idx + offset
      : (idx + offset + docs.length) % docs.length
    if (target < 0 || target >= docs.length) return   // 固定模式：边界不可切换
    const doc = docs[target]
    recordNav()
    setActiveDoc(doc.key)
    if (doc.kind === 'view') setView(doc.view)
  }

  /** 长按方向键节流：首按立即切换，按住重复触发时约 0.2s 切一个标签（避免 OS 连发过快） */
  const lastTabSwitchAt = useRef(0)
  const switchTabThrottled = (offset: number, isRepeat: boolean) => {
    const now = Date.now()
    if (isRepeat && now - lastTabSwitchAt.current < 200) return
    lastTabSwitchAt.current = now
    switchTab(offset)
  }

  // 方向键快捷切换标签页（输入框/编辑器内不拦截；长按重复触发 0.2s 节流）
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (e.key === 'ArrowUp') { e.preventDefault(); switchTabThrottled(-1, e.repeat) }
      else if (e.key === 'ArrowDown') { e.preventDefault(); switchTabThrottled(1, e.repeat) }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [docs, activeDoc, lib?.tabSwitchMode])

  /** 最大化状态跟随系统（按钮点击 / Win11 拖到顶部贴靠）——用于去掉圆角与透明边距占满屏幕 */
  useEffect(() => window.api.page.onMaximized(setMaximized), [])

  /** 窗口即将关闭（主进程 close 钩子触发）：批量 flush 全部脏笔记草稿，完成后 ack 让窗口真正关闭。
   *  直接关窗时 React 卸载清理不会执行，必须在此主动写盘，否则未保存改动丢失。
   *  docs 走 ref：订阅只注册一次，避免开/关标签反复退订重订造成 flush 事件错过窗口。 */
  const docsRef = useRef(docs)
  docsRef.current = docs
  useEffect(() => {
    return window.api.page.onFlushDrafts(() => {
      const jobs = docsRef.current
        .filter((d) => d.kind === 'note')
        .map((d) => noteEditorRefs.current[d.key]?.flushDraft())
        .filter(Boolean) as Promise<void>[]
      void Promise.allSettled(jobs).then(() => window.api.page.flushDone())
    })
  }, [])

  /** 新增书籍弹窗：Esc 关闭 */
  useEffect(() => {
    if (!bookDialog) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setBookDialog(false) }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [bookDialog])

  /** 顶部标签筛选下拉：点击外部关闭 */
  useEffect(() => {
    if (!tagFilterOpen) return
    const h = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (!t.closest('[data-tag-filter-toggle]') && !t.closest('[data-tag-filter-panel]')) setTagFilterOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [tagFilterOpen])

  /** 闪念卡片「更多」菜单：点击外部关闭 */
  useEffect(() => {
    if (thoughtMenuId == null) return
    const h = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (!t.closest('[data-thought-menu-toggle]') && !t.closest('[data-thought-menu-panel]')) setThoughtMenuId(null)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [thoughtMenuId])

  // ---- 多选管理（阅读笔记页右键进入；multiFolderId 非空 = 文件夹页内多选） ----
  const [multiMode, setMultiMode] = useState(false)
  const [multiFolderId, setMultiFolderId] = useState<number | null>(null)
  const [selectedSet, setSelectedSet] = useState<Set<number>>(new Set())
  const [multiExportOpen, setMultiExportOpen] = useState(false)
  const [multiShareOpen, setMultiShareOpen] = useState(false)
  /** 多选浮层（导出/分享/分组）视口锚点坐标：菜单条外层 overflow-hidden 会裁掉 absolute 浮层，故用 fixed */
  const [multiMenuPos, setMultiMenuPos] = useState<{ x: number; y: number } | null>(null)
  const openMultiMenu = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect()
    setMultiMenuPos({ x: r.left, y: r.bottom + 4 })
  }
  /** 分组浮层 */
  const [groupOpen, setGroupOpen] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  /** "取消该分组"确认 */
  const [folderDeleteConfirm, setFolderDeleteConfirm] = useState(false)
  const multiRef = useRef<HTMLDivElement>(null)

  const toggleSelect = (id: number) => {
    setSelectedSet((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const exitMulti = () => {
    setMultiMode(false)
    setMultiFolderId(null)
    setSelectedSet(new Set())
    setMultiExportOpen(false)
    setMultiShareOpen(false)
    setGroupOpen(false)
    setMultiMenuPos(null)
  }
  /** 书卡右键：多选模式中再右键 → 退出；否则进入多选并选中该书（folderId 非空 = 文件夹页） */
  const onBookContextMenu = (e: React.MouseEvent, id: number, folderId: number | null = null) => {
    e.preventDefault()
    if (multiMode) { exitMulti(); return }
    setMultiMode(true)
    setMultiFolderId(folderId)
    setSelectedSet(new Set([id]))
  }
  // 多选模式：Esc 退出 / 菜单条点击外部关闭子浮层
  useEffect(() => {
    if (!multiMode) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') exitMulti() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [multiMode])
  useEffect(() => {
    if (!multiMode) return
    const h = (e: MouseEvent) => {
      if (!multiRef.current?.contains(e.target as HTMLElement)) { setMultiExportOpen(false); setMultiShareOpen(false); setGroupOpen(false); setMultiMenuPos(null) }
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [multiMode])

  /** 批量删除勾选书籍（连同笔记草稿、文件夹引用） */
  const multiDelete = async () => {
    const ids = [...selectedSet]
    if (ids.length === 0) return
    const data = await window.api.store.load<BookStore>('books')
    data.books = data.books.filter((b) => !ids.includes(b.id))
    const ok = await saveStore('books', data)
    if (!ok) { showToast('保存失败，请重试', true); return }
    try {
      const drafts = await window.api.store.load<NoteDraftsData>('note-drafts')
      let changed = false
      for (const id of ids) {
        for (const k of Object.keys(drafts.drafts)) {
          if (k.startsWith(`${id}:`)) { delete drafts.drafts[k]; changed = true }
        }
      }
      if (changed) await saveStore('note-drafts', drafts)
    } catch { /* 草稿清理失败不阻塞 */ }
    await saveStore('folders', {
      folders: (folders?.folders ?? []).map((f) => ({ ...f, bookIds: f.bookIds.filter((x) => !ids.includes(x)) })),
    })
    exitMulti()
    showToast(`已删除 ${ids.length} 本书`)
  }

  /** 批量导出（保存对话框，ZIP/RAR） */
  const multiExport = async (format: 'zip' | 'rar') => {
    const ids = [...selectedSet]
    setMultiExportOpen(false)
    if (ids.length === 0) return
    const res = await window.api.books.packMulti(ids, format)
    if (res.ok) {
      if (res.rarMissing) showToast(`未检测到 WinRAR，已改用 ZIP 导出：${res.path}`)
      else showToast(`已导出：${res.path}`)
    } else if (!res.canceled) showToast(res.error ?? '导出失败', true)
  }

  /** 批量分享（打包临时文件 + 资源管理器选中 + 提醒） */
  const multiShare = async (format: 'zip' | 'rar') => {
    const ids = [...selectedSet]
    setMultiShareOpen(false)
    if (ids.length === 0) return
    const res = await window.api.books.packMultiTemp(ids, format)
    if (res.ok && res.path) {
      await window.api.note.showInFolder(res.path)
      showToast('系统共享不支持文件，已导出压缩包并在资源管理器中选中，可右键「共享」')
    } else {
      showToast(res.error ?? '分享失败', true)
    }
  }

  // ---- 书籍文件夹（分组） ----
  /** 主列表书籍过滤：已放入文件夹的书不在书架主列表显示 */
  const folderBookIds = useMemo(() => new Set((folders?.folders ?? []).flatMap((f) => f.bookIds)), [folders])
  /** 移动勾选书籍到文件夹（自动从其它文件夹移出） */
  const moveToFolder = async (folderId: number) => {
    const ids = [...selectedSet]
    if (ids.length === 0) return
    const data = await window.api.store.load<FolderStoreData>('folders')
    const next = data.folders.map((f) => ({
      ...f,
      bookIds: f.id === folderId ? [...new Set([...f.bookIds, ...ids])] : f.bookIds.filter((x) => !ids.includes(x)),
    }))
    await saveStore('folders', { folders: next })
    setGroupOpen(false)
    exitMulti()
    showToast(`已将 ${ids.length} 本书移入文件夹`)
  }
  /** 新建文件夹并移入勾选书籍 */
  const createFolder = async () => {
    const name = newFolderName.trim()
    if (!name) { showToast('请输入文件夹名称', true); return }
    const data = await window.api.store.load<FolderStoreData>('folders')
    const id = nextId(data.folders)
    data.folders.push({ id, name, bookIds: [...selectedSet], createdAt: new Date().toISOString() })
    await saveStore('folders', data)
    setGroupOpen(false)
    setNewFolderName('')
    exitMulti()
    showToast('文件夹已创建')
  }
  /** 删除文件夹（其中书籍回到主列表） */
  const deleteFolder = async (id: number) => {
    const data = await window.api.store.load<FolderStoreData>('folders')
    data.folders = data.folders.filter((f) => f.id !== id)
    await saveStore('folders', data)
    showToast('文件夹已删除')
  }
  /** 从文件夹移出单本书：已并入多选"移出分组"流程 */

  /** 数据变更后清理失效文档标签（书籍/笔记被删除时联动关闭） */
  useEffect(() => window.api.store.onChanged('books', () => {
    void window.api.store.load<BookStore>('books').then((data) => {
      setDocs((ds) => {
        const next = ds.filter((d) => {
          if (d.kind === 'view') return true   // 视图标签始终保留
          if (d.kind === 'folder') return true   // 文件夹标签由 folders 变更处理
          const b = data.books.find((x) => x.id === d.bookId)
          if (!b) return false
          if (d.kind === 'note' && d.noteId != null) return b.notes.some((n) => n.id === d.noteId)
          return true
        })
        if (next.length === ds.length) return ds
        setActiveDoc((cur) => (cur && next.some((d) => d.key === cur)) ? cur : null)
        return next
      })
    })
  }), [])

  const reload = useCallback(async () => {
    // 并行加载 store，减少串行等待
    const [b, t, c, l, f] = await Promise.all([
      window.api.store.load<BookStore>('books'),
      window.api.store.load<ThoughtStoreData>('thoughts'),
      window.api.store.load<CalendarData>('calendar'),
      window.api.store.load<LibrarySettingsData>('library'),
      window.api.store.load<FolderStoreData>('folders'),
    ])
    setBooks(b)
    setThoughts(t)
    setCal(c)
    setLib(l)
    setFolders(f)
  }, [])

  useEffect(() => {
    void reload()
    // 跨窗口数据变更（便利贴/详情窗保存等）自动刷新
    const unsubs = [
      window.api.store.onChanged('books', () => void reload()),
      window.api.store.onChanged('thoughts', () => void reload()),
      window.api.store.onChanged('calendar', () => void reload()),
      window.api.store.onChanged('folders', () => void reload()),
    ]
    setChat([{ text: '你好！我是你的本地 AI 助手。可以帮你梳理笔记、生成回顾，或回答关于使用的问题。', isUser: false }])
    return () => unsubs.forEach((u) => u())
  }, [reload])

  const { toast, showToast } = useToast(2400)

  // ---- 筛选书库 ----
  /** 是否有搜索/标签/日期筛选（筛选时：文件夹内书籍也参与筛选并直接显示，文件夹卡片隐藏） */
  const filtering = !!search.trim() || !!tagFilter || !!selectedDate
  /** 只看收藏 / 只看置顶：与现有搜索/标签筛选叠加 */
  const [bookStarFilter, setBookStarFilter] = useState(false)
  const [bookPinFilter, setBookPinFilter] = useState(false)
  const filteredBooks = useMemo(() => {
    // 无筛选时主列表不显示已放入文件夹的书；有筛选时文件夹内书也参与筛选
    let q = (books?.books ?? []).filter((b) => filtering || !folderBookIds.has(b.id))
    if (bookStarFilter) q = q.filter((b) => b.starred === true)
    if (bookPinFilter) q = q.filter((b) => b.pinned === true)
    const kw = search.trim()
    if (kw) q = q.filter((b) =>
      b.title.includes(kw) || b.author.includes(kw) || b.description.includes(kw)
      || b.tags.some((t) => t.includes(kw))
      || b.notes.some((n) => n.title.includes(kw) || noteToPlainText(n.content).includes(kw)))
    if (tagFilter) q = q.filter((b) => b.tags.includes(tagFilter) || b.notes.some((n) => n.tags.includes(tagFilter)))
    if (selectedDate) {
      // 日期筛选：该日创建过笔记的书籍按当日笔记数降序在前，该日创建的书籍（无当日笔记）排后
      const withNotes: [Book, number][] = []
      const createdOn: Book[] = []
      for (const b of q) {
        const cnt = b.notes.filter((n) => dateKey(new Date(n.createdAt)) === selectedDate).length
        if (cnt > 0) withNotes.push([b, cnt])
        else if (dateKey(new Date(b.createdAt)) === selectedDate) createdOn.push(b)
      }
      withNotes.sort((x, y) => y[1] - x[1])
      return [...withNotes.map(([b]) => b), ...createdOn]
    }
    // 排序：置顶排前（收藏仅作标记不改序）> 用户偏好（newest/oldest）
    const sorted = [...q].sort((a, b) => {
      const pa = a.pinned ? 1 : 0, pb = b.pinned ? 1 : 0
      if (pa !== pb) return pb - pa
      return lib?.sortOrder === 'oldest'
        ? a.createdAt.localeCompare(b.createdAt)
        : b.createdAt.localeCompare(a.createdAt)
    })
    return sorted
  }, [books, search, tagFilter, selectedDate, lib, folderBookIds, filtering, bookStarFilter, bookPinFilter])

  /** 当前多选上下文可见书籍（书架 = 当前筛选结果；文件夹 = 文件夹内书籍） */
  const multiVisibleBooks = useMemo(() => {
    if (multiFolderId != null) {
      return (books?.books ?? []).filter((b) => folders?.folders.find((f) => f.id === multiFolderId)?.bookIds.includes(b.id))
    }
    return filteredBooks
  }, [multiFolderId, books, folders, filteredBooks])
  const allSelected = multiVisibleBooks.length > 0 && multiVisibleBooks.every((b) => selectedSet.has(b.id))
  /** 全选 / 取消全选（图标随之切换） */
  const toggleSelectAll = () => {
    if (allSelected) setSelectedSet(new Set())
    else setSelectedSet(new Set(multiVisibleBooks.map((b) => b.id)))
  }
  /** 文件夹页：批量移出勾选书籍（文件夹移空后自动删除） */
  const multiRemoveFromFolder = async () => {
    const ids = [...selectedSet]
    if (multiFolderId == null || ids.length === 0) return
    const data = await window.api.store.load<FolderStoreData>('folders')
    data.folders = data.folders
      .map((f) => (f.id === multiFolderId ? { ...f, bookIds: f.bookIds.filter((x) => !ids.includes(x)) } : f))
      .filter((f) => f.bookIds.length > 0)   // 空文件夹自动删除
    await saveStore('folders', data)
    const removedName = folders?.folders.find((f) => f.id === multiFolderId)?.name
    exitMulti()
    showToast(removedName && (data.folders.findIndex((f) => f.id === multiFolderId) < 0)
      ? `已移出 ${ids.length} 本书，文件夹「${removedName}」已清空并删除`
      : `已移出 ${ids.length} 本书`)
  }
  /** 文件夹页：取消该分组（删除整个文件夹，书回到书架） */
  const cancelFolder = async () => {
    if (multiFolderId == null) return
    await deleteFolder(multiFolderId)
    setFolderDeleteConfirm(false)
    exitMulti()
  }

  const allTags = useMemo(() => {
    const set = new Set<string>()
    for (const b of books?.books ?? []) {
      b.tags.forEach((t) => set.add(t))
      b.notes.forEach((n) => n.tags.forEach((t) => set.add(t)))
    }
    return [...set].sort()
  }, [books])

  const stats = useMemo(() => {
    const allNotes = (books?.books ?? []).flatMap((b) => b.notes)
    // 连续活跃天数：从今天（或昨天，若今天尚无活动）起向前连续有工作量（笔记/闪念/回顾）的天数
    let streak = 0
    if (books && thoughts && cal) {
      const cursor = new Date()
      if (workCount(dateKey(cursor), books, thoughts, cal) === 0) cursor.setDate(cursor.getDate() - 1)
      while (streak < 3650 && workCount(dateKey(cursor), books, thoughts, cal) > 0) {
        streak++
        cursor.setDate(cursor.getDate() - 1)
      }
    }
    return {
      notes: allNotes.length,
      reviews: allNotes.filter((n) => n.tags.includes('回顾')).length,
      streak,
    }
  }, [books, thoughts, cal])

  // ---- 新增书籍 ----
  const openNewBook = () => {
    setBookForm({ title: '', author: '', publisher: '', edition: '', desc: '', tags: '', cover: null, chapters: [] })
    setBookMode('search')
    setImportChapters(true)
    setTitleError(false)
    setSearchResults([])
    setSelectedResult(null)
    setSearchKw('')
    setBookDialog(true)
  }
  const saveBook = async () => {
    const title = bookForm.title.trim()
    if (!title) { setTitleError(true); showToast('请输入书名', true); return }
    const tags = bookForm.tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean)
    // 勾选"导入章节信息"且尚未抓到时，保存前兜底抓取（豆瓣详情页目录）
    let chapters = bookForm.chapters
    if (importChapters && (!chapters || chapters.length === 0) && selectedResult?.url) {
      chapters = await window.api.books.fetchChapters(selectedResult.url)
    }
    const data = await window.api.store.load<BookStore>('books')
    const id = nextId(data.books)
    data.books.push({
      id, title,
      author: bookForm.author.trim(),
      publisher: bookForm.publisher.trim(),
      edition: bookForm.edition.trim() || undefined,
      description: bookForm.desc.trim(),
      coverColor: pickCoverColor(id),
      cover: bookForm.cover || null,
      tags, createdAt: new Date().toISOString(),
      notes: [],
      chapters: chapters && chapters.length > 0 ? chapters : undefined,
    })
    const ok = await saveStore('books', data)
    if (!ok) { showToast('保存失败，请重试', true); return }
    setBookDialog(false)
    showToast('书籍已添加')
  }

  /** 删除书籍（连同其下全部笔记）；同时清除该书全部笔记草稿（避免 id 复用时复活已删内容） */
  const deleteBook = async (id: number) => {
    const data = await window.api.store.load<BookStore>('books')
    data.books = data.books.filter((b) => b.id !== id)
    const ok = await saveStore('books', data)
    if (!ok) { showToast('保存失败，请重试', true); return }
    try {
      const drafts = await window.api.store.load<NoteDraftsData>('note-drafts')
      let changed = false
      for (const k of Object.keys(drafts.drafts)) {
        if (k.startsWith(`${id}:`)) { delete drafts.drafts[k]; changed = true }
      }
      if (changed) await saveStore('note-drafts', drafts)
    } catch { /* 草稿清理失败不阻塞删除 */ }
    showToast('书籍已删除')
  }
  /** 收藏/取消收藏：切换 starred 后保存广播 */
  const toggleBookStar = async (id: number) => {
    await updateStore<BookStore>('books', (data) => {
      const b = data.books.find((x) => x.id === id)
      if (!b) return false
      b.starred = !b.starred
    })
  }
  /** 置顶/取消置顶：所有视图生效，置顶 > 收藏 > 时间序 */
  const toggleBookPin = async (id: number) => {
    await updateStore<BookStore>('books', (data) => {
      const b = data.books.find((x) => x.id === id)
      if (!b) return false
      b.pinned = !b.pinned
    })
  }

  const uploadCover = async (file: File) => {
    if (!file.type.startsWith('image/')) return
    const reader = new FileReader()
    reader.onload = async () => {
      const ext = file.name.includes('.') ? `.${file.name.split('.').pop()}` : '.png'
      const rel = await window.api.files.saveCover(String(reader.result), ext)
      if (rel) setBookForm((f) => ({ ...f, cover: rel }))
    }
    reader.readAsDataURL(file)
  }

  // ---- 选书导入（微信读书主源经主进程代理；豆瓣保留作补全） ----
  const doSearch = async () => {
    const kw = searchKw.trim()
    if (!kw) return
    setSearching(true)
    setSearchResults([])
    setSelectedResult(null)
    try {
      const res = searchSource === 'weread'
        ? await window.api.books.searchWeread(kw)
        : await window.api.books.searchDouban(kw)
      setSearchResults(res)
    } catch {
      setSearchResults([])
    }
    setSearching(false)
  }

  /** 点选结果：分词回填表单（实时预览），可继续搜索其他结果覆盖；
   *  勾选"导入章节信息"且来源为豆瓣时，异步抓取详情页目录回填章节 */
  const pickSearchResult = (r: BookSearchResult) => {
    setSelectedResult(r)
    const { author, publisher, edition } = splitBookInfo(r)
    setBookForm((f) => ({
      ...f, title: r.title, author, publisher, edition, desc: r.description, cover: r.coverUrl || f.cover,
    }))
    setTitleError(false)
    if (importChapters && r.url) {
      void window.api.books.fetchChapters(r.url).then((chs) => {
        if (chs && chs.length > 0) {
          setBookForm((f) => (f.title === r.title ? { ...f, chapters: chs } : f))
          showToast(`已导入 ${chs.length} 个章节`)
        }
      })
    }
    // 微信读书 cdn.weread 封面仅有 70×100 小图（无更高清版本），导入前提醒
    if (isSmallCoverUrl(r.coverUrl)) {
      showToast('该来源封面为小图，建议改用豆瓣源或手动上传高清封面', true)
    }
  }

  /** cdn.weread.qq.com 封面只有 70×100 小图（实测无更大版本）；myqcloud 域名 s_→b_ 已有高清升级 */
  const isSmallCoverUrl = (u: string) => u.includes('cdn.weread.qq.com')

  /** 斜杠分词：部分源把 作者/出版社/版本 合并为一个字段，用 / 或 ／ 分隔，导入时拆开 */
  const splitBookInfo = (r: BookSearchResult) => {
    let author = r.author ?? ''
    let publisher = r.publisher ?? ''
    let edition = ''
    const assign = (p: string) => {
      if (/版|印次|edition/i.test(p)) edition = edition ? `${edition} ${p}` : p
      else publisher = publisher ? `${publisher} ${p}` : p
    }
    // author 内拆分（作者 / 出版社 / 版本）
    const aParts = author.split(/[/／]/).map((s) => s.trim()).filter(Boolean)
    if (aParts.length > 1) {
      author = aParts[0]
      aParts.slice(1).forEach(assign)
    }
    // publisher 内拆分（出版社 / 版本）
    const pParts = publisher.split(/[/／]/).map((s) => s.trim()).filter(Boolean)
    if (pParts.length > 1) {
      publisher = pParts[0]
      pParts.slice(1).forEach(assign)
    }
    return { author, publisher, edition }
  }

  // ---- 闪念 ----
  /** 创建/编辑闪念前提醒当前存活的便利贴进程数（仅提醒，不干涉操作） */
  const remindStickyCount = async () => {
    const n = await window.api.sticky.count()
    if (n > 0) showToast(`当前有 ${n} 个闪念进程`)
  }
  const openStickyNew = async () => {
    await remindStickyCount()
    window.api.sticky.open()
  }
  const editThought = async (t: Thought) => {
    await remindStickyCount()
    window.api.sticky.edit(t.id)
  }

  /** 闪念布局切换：记录当前滚动比例，切换后按比例恢复浏览位置（不刷新页面） */
  const switchThoughtLayout = (l: 'list' | 'grid') => {
    const el = thoughtsScrollRef.current
    const ratio = el && el.scrollHeight > el.clientHeight
      ? el.scrollTop / (el.scrollHeight - el.clientHeight) : 0
    setThoughtLayout(l)
    localStorage.setItem('ballwork.thoughtsLayout', l)
    requestAnimationFrame(() => {
      const el2 = thoughtsScrollRef.current
      if (el2 && el2.scrollHeight > el2.clientHeight) {
        el2.scrollTop = ratio * (el2.scrollHeight - el2.clientHeight)
      }
    })
  }
  const duplicateThought = async (t: Thought) => {
    const data = await window.api.store.load<ThoughtStoreData>('thoughts')
    const id = nextId(data.thoughts)
    data.thoughts.unshift({ id, content: t.content, createdAt: new Date().toISOString() })
    await saveStore('thoughts', data)
  }
  const deleteThought = async (t: Thought) => {
    await updateStore<ThoughtStoreData>('thoughts', (data) => {
      data.thoughts = data.thoughts.filter((x) => x.id !== t.id)
    })
  }
  /** 收藏/取消收藏：切换 starred 后走 store 保存广播，各窗口自动同步 */
  const toggleThoughtStar = async (t: Thought) => {
    await updateStore<ThoughtStoreData>('thoughts', (data) => {
      const target = data.thoughts.find((x) => x.id === t.id)
      if (!target) return false
      target.starred = !target.starred
    })
  }
  /** 置顶/取消置顶：切换 pinned 后走 store 保存广播 */
  const toggleThoughtPin = async (t: Thought) => {
    await updateStore<ThoughtStoreData>('thoughts', (data) => {
      const target = data.thoughts.find((x) => x.id === t.id)
      if (!target) return false
      target.pinned = !target.pinned
    })
  }

  // ---- 收入笔记 ----
  const openToNote = (t: Thought) => {
    setNoteDialog({ thought: t, bookId: books?.books[0]?.id ?? null, chapter: '未分类' })
  }
  const confirmToNote = async () => {
    if (!noteDialog || !books) return
    if (noteDialog.bookId == null) { showToast('请先创建一本书', true); return }
    // 按稳定 id 定位目标书：对话框打开期间书库刷新/重排不会错位到别的书
    const data = await window.api.store.load<BookStore>('books')
    const target = data.books.find((b) => b.id === noteDialog.bookId)
    if (!target) { showToast('书籍已删除或不存在', true); return }
    // 闪念事实源 = Lexical EditorState JSON；note 事实源 = Markdown。这里做一次性转换：
    // Lexical 解析失败（极老数据/迁移未跑）回退原文，保证收入笔记不丢数据。
    const rawContent = String(noteDialog.thought.content ?? '')
    const mdContent = rawContent.trim().startsWith('{')
      ? lexicalJsonToMarkdown(rawContent)
      : rawContent
    // 无标题时取正文开头一小段作标题（noteTitleFromContent 同时支持 Lexical JSON 与 Markdown）
    const title = noteTitleFromContent(mdContent)
    const noteId = nextId(target.notes)
    target.notes.push({
      id: noteId, title: title || '未命名笔记', content: mdContent,
      tags: [], chapter: noteDialog.chapter.trim() || '未分类',
      createdAt: new Date().toISOString(),
    })
    const ok = await saveStore('books', data)
    if (!ok) { showToast('保存失败，请重试', true); return }
    setNoteDialog(null)
  }

  // ---- 每日回顾 ----
  const generateReview = async () => {
    setReviewing(true)
    setReviewText('正在生成今日回顾…')
    try {
      const todayNotes = (books?.books ?? []).flatMap((b) => b.notes)
        .filter((n) => dateKey(new Date(n.createdAt)) === dateKey(new Date()))
        .map((n) => ({ title: n.title, content: noteToPlainText(n.content), createdAt: n.createdAt }))
      const result = await window.api.ai.review(todayNotes)
      setReviewText(result)
      // 记录回顾活动（当日日历圆点）：仅在成功时计数，失败不计
      const calData = await window.api.store.load<CalendarData>('calendar')
      const today = dateKey(new Date())
      const d = calData.days[today] ?? { thoughts: 0, thoughtsProcessed: 0, reviews: 0, reviewsUpdated: 0 }
      d.reviews++
      if (d.reviews > 1) d.reviewsUpdated++
      calData.days[today] = d
      await saveStore('calendar', calData)
    } catch {
      // AI 请求失败（网络/密钥/服务不可用）：恢复按钮并给出可见提示，不留下永久"生成中"
      setReviewText('回顾生成失败，请检查 AI 设置（接口地址 / API Key / 网络）后重试')
      showToast('回顾生成失败', true)
    } finally {
      setReviewing(false)
    }
  }

  // ---- AI 助手 ----
  const sendChat = async () => {
    const text = chatInput.trim()
    if (!text) return
    setChatInput('')
    setChat((c) => [...c, { text, isUser: true }])
    try {
      const reply = await window.api.ai.chat(text)
      setChat((c) => [...c, { text: reply, isUser: false }])
    } catch {
      // 失败也要给用户一条可见反馈，避免发出消息后石沉大海
      setChat((c) => [...c, { text: 'AI 请求失败，请检查 AI 设置（接口地址 / API Key / 网络）后重试', isUser: false }])
    }
  }

  // ---- 图书馆设置 ----
  const saveLibSettings = async (sort: LibrarySettingsData['sortOrder'], cardWidth: number, tabSwitchMode: 'loop' | 'fixed') => {
    await saveStore('library', { sortOrder: sort, cardWidth, tabSwitchMode })
    setLibDialog(false)
  }

  const navItem = (v: View, label: string, icon: 'note' | 'pin' | 'review' | 'chat', tip: string) => (
    <button
      className={`w-full h-9 rounded-lg flex items-center gap-2 px-3 text-[13px] transition-colors
        ${narrow ? 'justify-center px-0' : ''}
        ${view === v ? 'bg-blue-500/10 text-blue-600 font-medium' : 'text-slate-600 hover:bg-black/5'}`}
      onClick={() => openViewTab(v)}
      data-tip={tip}
    >
      <Icon name={icon} size={15} />
      {!narrow && <span className="truncate">{label}</span>}
    </button>
  )

  // 活跃日历（12 周列）
  const todayKey = useToday()
  const calRanges = useActivityCalendar(cal, (d) => {
    setSelectedDate(selectedDate === d ? null : d)
  })

  // 网格列数：固定卡片尺寸，按容器宽度整数除法（窗口缩放时卡片不拉伸、不跳位）
  useEffect(() => {
    const el = gridRef.current
    if (!el) return
    const update = () => {
      const w = el.clientWidth
      if (w <= 0) return   // 容器不可见/销毁中：不更新列数（避免切回时误算成 1 列排版）
      const card = lib?.cardWidth ?? 140
      const gap = 16
      setGridCols(Math.max(1, Math.floor((w + gap) / (card + gap))))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [lib?.cardWidth, view, activeDoc])

  return (
    <div className="w-full h-full relative">
      {!maximized && <ResizeHandles />}
      <div className="w-full h-full flex overflow-hidden">
        {/* ===== 左部分：侧栏（通顶，无独立标题栏） ===== */}
        <div
          className={`shrink-0 border-r border-black/5 flex flex-col transition-[width] duration-260 ${narrow ? 'w-16' : 'w-56'}`}
        >
          {/* 顶部：logo（图书馆）+ 侧栏切换；整行可拖拽移动窗口（按钮区 no-drag） */}
          <div
            className="h-12 flex items-center justify-between px-3 border-b border-black/5"
            style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
          >
            {!narrow && <span className="text-[15px] font-semibold text-slate-800">图书馆</span>}
            <button className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-500 hover:bg-black/5"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              onClick={() => setNarrow(!narrow)} data-tip="切换左侧栏">
              <Icon name="more" size={16} />
            </button>
          </div>

          {!narrow && (
            <>
              {/* 统计 */}
              <div className="grid grid-cols-3 gap-1 p-3 border-b border-black/5">
                <StatBox label="笔记" value={stats.notes} />
                <StatBox label="回顾" value={stats.reviews} />
                <StatBox label="连续天数" value={stats.streak} />
              </div>
              {/* 活跃日历 */}
              <div className="p-3 border-b border-black/5">
                <p className="text-[11px] text-slate-400 mb-2">活跃日历（点击筛选）</p>
                <ActiveCalendar ranges={calRanges} selectedDate={selectedDate} books={books} thoughts={thoughts} cal={cal} todayKey={todayKey} />
              </div>
            </>
          )}

          {/* 导航 */}
          <div className="flex-1 p-2 space-y-1">
            {navItem('notes', '阅读笔记', 'note', '阅读笔记')}
            {navItem('thoughts', '闪念', 'pin', '闪念')}
            {navItem('review', '每日回顾', 'review', '每日回顾')}
            {navItem('ai', 'AI 助手', 'chat', 'AI 助手')}
          </div>

          {/* 底部：图书馆设置 */}
          <div className="p-2 border-t border-black/5">
            <button className="w-full h-9 rounded-lg flex items-center gap-2 px-3 text-[13px] text-slate-600 hover:bg-black/5"
              onClick={() => setLibDialog(true)}>
              <Icon name="settings" size={15} />
              {!narrow && <span>图书馆设置</span>}
            </button>
          </div>
        </div>

        {/* ===== 右部分：标题栏 + 内容 ===== */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* 标题栏（整合标签页 + 视图部件 + 窗口按钮） */}
          <div
            className="h-12 shrink-0 flex items-center px-3 gap-2 border-b border-black/5"
            style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
          >
            {/* 标签页（内嵌标题栏，节省一行空间；flex-1 占主空间）。
                容器不设 no-drag（继承标题栏 drag）：标签两侧空白、间隙均可拖动窗口；
                标签项本身在 Tabs 内设为 no-drag，保证点击切换/关闭正常 */}
            <div className="flex-1 min-w-0">
              <Tabs
                embedded
                items={docs.map((d) => ({
                  key: d.key,
                  label: d.title,
                  closable: true,
                  indent: d.kind === 'note' || d.kind === 'folder',   // 笔记归入书籍组；文件夹归入阅读笔记组
                  dirty: d.kind === 'note' && dirtyKeys.has(d.key),   // 未保存改动 → 关闭按钮变圆圈
                }))}
                value={activeDoc ?? ''}
                onChange={(k) => {
                  const doc = docs.find((d) => d.key === k)
                  recordNav()
                  setActiveDoc(k)
                  if (doc?.kind === 'view') setView(doc.view)   // 切回视图标签时同步视图状态
                }}
                onClose={(k) => closeDoc(k)}
              />
            </div>
            {/* 日期筛选提示（视图名由标签页表达） */}
            {selectedDate && (
              <span className="text-[13px] text-slate-400 shrink-0">已按 {selectedDate.slice(5)} 筛选</span>
            )}
            {/* 闪念布局切换：胶囊开关（整体/卡片），记忆选择；旁为只看收藏/置顶筛选 */}
            {activeDoc === 'view-thoughts' && (
              <>
                <div className="flex items-center rounded-full bg-black/5 p-0.5"
                  style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
                  <button
                    className={`h-6 px-3 rounded-full text-[12px] transition-colors ${thoughtLayout === 'list' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                    onClick={() => switchThoughtLayout('list')}
                  >整体</button>
                  <button
                    className={`h-6 px-3 rounded-full text-[12px] transition-colors ${thoughtLayout === 'grid' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                    onClick={() => switchThoughtLayout('grid')}
                  >卡片</button>
                </div>
                <button
                  className={`w-8 h-8 flex items-center justify-center rounded-lg transition-colors ${pinFilter ? 'text-blue-500 bg-black/5' : 'text-slate-500 hover:bg-black/5'}`}
                  style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                  onClick={() => setPinFilter(!pinFilter)}
                  data-tip="只看置顶"
                >
                  <Icon name="pin" size={15} />
                </button>
                <button
                  className={`w-8 h-8 flex items-center justify-center rounded-lg transition-colors ${starFilter ? 'text-amber-500 bg-black/5' : 'text-slate-500 hover:bg-black/5'}`}
                  style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                  onClick={() => setStarFilter(!starFilter)}
                  data-tip="只看收藏"
                >
                  <Icon name="star" size={15} />
                </button>
              </>
            )}
            {/* 搜索/标签（notes 视图；窗口按钮组左侧） */}
            {activeDoc === 'view-notes' && (
              <>
                <button className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-500 hover:bg-black/5"
                  style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                  onClick={() => setShowSearch(!showSearch)} data-tip="搜索">
                  <Icon name="search" size={15} />
                </button>
                <div className="relative" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
                  <button
                    data-tag-filter-toggle
                    className={`w-8 h-8 flex items-center justify-center rounded-lg hover:bg-black/5 ${tagFilterOpen || tagFilter ? 'text-blue-500' : 'text-slate-500'}`}
                    onClick={() => setTagFilterOpen(!tagFilterOpen)}
                    data-tip="按标签筛选"
                  >
                    <Icon name="tag" size={15} />
                    {tagFilter && <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-blue-500" />}
                  </button>
                  {tagFilterOpen && allTags.length > 0 && (
                    <div data-tag-filter-panel className="absolute right-0 top-9 z-30 glass-card rounded-xl p-1.5 min-w-32 max-h-64 overflow-y-auto">
                      <button className="w-full h-7 rounded-lg px-2 text-left text-[12px] hover:bg-black/5"
                        onClick={() => setTagFilter('')}>
                        全部标签 {tagFilter === '' && '✓'}
                      </button>
                      {allTags.map((t) => (
                        <button key={t} className="w-full h-7 rounded-lg px-2 text-left text-[12px] hover:bg-black/5"
                          onClick={() => setTagFilter(tagFilter === t ? '' : t)}>
                          {t} {tagFilter === t && '✓'}
                        </button>
                      ))}
                      <div className="h-px bg-black/5 my-1" />
                      <button className="w-full h-7 rounded-lg px-2 text-left text-[12px] text-blue-500 hover:bg-blue-50"
                        onClick={() => setTagFilterOpen(false)}>
                        完成
                      </button>
                    </div>
                  )}
                </div>
                {/* 只看收藏 / 只看置顶：与搜索/标签筛选叠加 */}
                <button className={`w-8 h-8 flex items-center justify-center rounded-lg transition-colors ${bookPinFilter ? 'text-blue-500 bg-black/5' : 'text-slate-500 hover:bg-black/5'}`}
                  style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                  onClick={() => setBookPinFilter(!bookPinFilter)} data-tip="只看置顶">
                  <Icon name="pin" size={15} />
                </button>
                <button className={`w-8 h-8 flex items-center justify-center rounded-lg transition-colors ${bookStarFilter ? 'text-amber-500 bg-black/5' : 'text-slate-500 hover:bg-black/5'}`}
                  style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                  onClick={() => setBookStarFilter(!bookStarFilter)} data-tip="只看收藏">
                  <Icon name="star" size={15} />
                </button>
              </>
            )}
            {/* 窗口按钮组 */}
            <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
              <button className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-600 hover:bg-black/5"
                onClick={() => window.api.page.minimize()} data-tip="最小化">
                <Icon name="minimize" size={15} />
              </button>
              <button className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-600 hover:bg-black/5"
                onClick={() => window.api.page.maximizeToggle()} data-tip={maximized ? '恢复' : '最大化'}>
                <Icon name={maximized ? 'restore' : 'maximize'} size={13} />
              </button>
              <button className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-600 hover:bg-red-50 hover:text-red-500"
                onClick={() => window.api.page.close()} data-tip="关闭">
                <Icon name="close" size={15} />
              </button>
            </div>
          </div>

          {/* 搜索条 */}
          {showSearch && activeDoc === 'view-notes' && (
            <div className="px-4 py-2 border-b border-black/5">
              <input
                autoFocus
                className="w-full h-9 rounded-lg border border-black/10 bg-white/90 px-3 text-[13px] outline-none"
                placeholder="搜索书名 / 作者 / 简介 / 笔记内容…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onBlur={() => setShowSearch(false)}
              />
            </div>
          )}

          {/* 多选管理菜单条（标签栏下方；grid-rows 过渡动画：出现/退出时把下方内容推挤下去） */}
          <div className="grid transition-[grid-template-rows] duration-200 ease-out shrink-0"
            style={{ gridTemplateRows: multiMode ? '1fr' : '0fr' }}>
            <div className="overflow-hidden min-h-0">
              <div ref={multiRef}
                className="h-12 flex items-center gap-2 px-4 border-b border-black/5 bg-blue-50/60">
                <span className="text-[13px] text-slate-600 shrink-0">已选 <b className="text-blue-600">{selectedSet.size}</b> 本</span>
                <div className="w-px h-5 bg-black/10 mx-1" />
                {/* 全选 / 取消全选（图标随状态切换） */}
                <button
                  className={`h-8 px-3 rounded-lg text-[13px] flex items-center gap-1 transition-colors ${allSelected ? 'text-blue-600 bg-blue-100' : 'text-slate-700 hover:bg-black/5'}`}
                  onClick={toggleSelectAll}>
                  <Icon name={allSelected ? 'close' : 'add'} size={13} />
                  {allSelected ? '取消全选' : '全选'}
                </button>
                {multiFolderId != null ? (
                  /* ---- 文件夹页多选：移出分组 / 取消该分组 ---- */
                  <>
                    <button
                      className={`h-8 px-3 rounded-lg text-[13px] transition-colors ${selectedSet.size === 0 ? 'text-slate-300' : 'text-slate-700 hover:bg-black/5'}`}
                      onClick={() => { if (selectedSet.size === 0) { showToast('请先勾选书籍', true); return } void multiRemoveFromFolder() }}>
                      移出分组
                    </button>
                    <button
                      className={`h-8 px-3 rounded-lg text-[13px] transition-colors ${selectedSet.size === 0 ? 'text-slate-300' : 'text-red-500 hover:bg-red-50'}`}
                      onClick={() => { if (selectedSet.size === 0) { showToast('请先勾选书籍', true); return } setFolderDeleteConfirm(true) }}>
                      取消该分组
                    </button>
                  </>
                ) : (
                  /* ---- 书架多选：删除 / 分组 ---- */
                  <>
                    <button
                      className={`h-8 px-3 rounded-lg text-[13px] transition-colors ${selectedSet.size === 0 ? 'text-slate-300' : 'text-red-500 hover:bg-red-50'}`}
                      onClick={() => { if (selectedSet.size === 0) { showToast('请先勾选书籍', true); return } void multiDelete() }}>
                      删除
                    </button>
                    <div className="relative">
                      <button
                        className={`h-8 px-3 rounded-lg text-[13px] transition-colors ${selectedSet.size === 0 ? 'text-slate-300' : 'text-slate-700 hover:bg-black/5'}`}
                        onClick={(e) => { if (selectedSet.size === 0) { showToast('请先勾选书籍', true); return } openMultiMenu(e); setGroupOpen(!groupOpen); setMultiExportOpen(false); setMultiShareOpen(false) }}>分组</button>
                      {/* 分组浮层（fixed 锚定按钮；外层 overflow-hidden 不会裁剪 fixed 元素） */}
                      {groupOpen && multiMenuPos && (
                        <div className="fixed z-50 w-80 bg-white rounded-xl shadow-lg border border-slate-100 p-3"
                          style={{ left: multiMenuPos.x, top: multiMenuPos.y }}>
                          <p className="text-[13px] font-medium text-slate-800">分组到文件夹</p>
                          <p className="text-[11px] text-slate-400 mt-0.5 mb-2">已选 {selectedSet.size} 本 · 点击文件夹卡片移入（一本书仅属一个文件夹）</p>
                          <div className="grid grid-cols-2 gap-2 max-h-52 overflow-y-auto">
                            {(folders?.folders ?? []).map((f) => (
                              <button key={f.id}
                                className="relative rounded-xl bg-slate-50 hover:bg-slate-100 border border-black/5 p-2.5 text-left transition-colors"
                                onClick={() => void moveToFolder(f.id)}>
                                <span className="block text-[12px] font-medium text-slate-800 truncate">{f.name}</span>
                                <span className="block text-[10px] text-slate-400 mt-0.5">{f.bookIds.length} 本</span>
                                <span
                                  className="absolute top-1.5 right-1.5 w-5 h-5 flex items-center justify-center rounded-full text-slate-400 hover:text-red-500 hover:bg-red-50"
                                  data-tip="删除文件夹（书回到书架）"
                                  onClick={(e) => { e.stopPropagation(); void deleteFolder(f.id) }}>
                                  <Icon name="close" size={11} />
                                </span>
                              </button>
                            ))}
                            {(folders?.folders.length ?? 0) === 0 && (
                              <p className="col-span-2 text-center text-slate-400 text-[12px] py-3">暂无文件夹，可在下方新建</p>
                            )}
                          </div>
                          <div className="flex items-center gap-2 mt-2">
                            <input
                              className="flex-1 h-8 rounded-lg border border-black/10 px-2.5 text-[12px] outline-none placeholder:text-slate-300"
                              placeholder="新建文件夹名称"
                              value={newFolderName}
                              onChange={(e) => setNewFolderName(e.target.value)}
                              onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void createFolder() }}
                            />
                            <button className="h-8 px-3 rounded-lg bg-blue-500 text-white text-[12px] hover:bg-blue-600 active:scale-95 transition"
                              onClick={() => void createFolder()}>创建</button>
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}
                {/* 导出 / 分享（书架与文件夹页通用） */}
                <div className="relative">
                  <button
                    className={`h-8 px-3 rounded-lg text-[13px] transition-colors ${selectedSet.size === 0 ? 'text-slate-300' : 'text-slate-700 hover:bg-black/5'}`}
                    onClick={(e) => { if (selectedSet.size === 0) { showToast('请先勾选书籍', true); return } openMultiMenu(e); setMultiExportOpen(!multiExportOpen); setMultiShareOpen(false); setGroupOpen(false) }}>导出</button>
                  {multiExportOpen && multiMenuPos && (
                    <div className="fixed z-50 w-32 bg-white rounded-xl shadow-lg border border-slate-100 py-1"
                      style={{ left: multiMenuPos.x, top: multiMenuPos.y }}>
                      <button className="w-full h-8 px-3 text-left text-[13px] text-slate-700 hover:bg-slate-100" onClick={() => void multiExport('zip')}>导出为ZIP</button>
                      <div className="border-t border-dashed border-slate-300" />
                      <button className="w-full h-8 px-3 text-left text-[13px] text-slate-700 hover:bg-slate-100" onClick={() => void multiExport('rar')}>导出为RAR</button>
                    </div>
                  )}
                </div>
                <div className="relative">
                  <button
                    className={`h-8 px-3 rounded-lg text-[13px] transition-colors ${selectedSet.size === 0 ? 'text-slate-300' : 'text-slate-700 hover:bg-black/5'}`}
                    onClick={(e) => { if (selectedSet.size === 0) { showToast('请先勾选书籍', true); return } openMultiMenu(e); setMultiShareOpen(!multiShareOpen); setMultiExportOpen(false); setGroupOpen(false) }}>分享</button>
                  {multiShareOpen && multiMenuPos && (
                    <div className="fixed z-50 w-32 bg-white rounded-xl shadow-lg border border-slate-100 py-1"
                      style={{ left: multiMenuPos.x, top: multiMenuPos.y }}>
                      <button className="w-full h-8 px-3 text-left text-[13px] text-slate-700 hover:bg-slate-100" onClick={() => void multiShare('zip')}>分享为ZIP</button>
                      <div className="border-t border-dashed border-slate-300" />
                      <button className="w-full h-8 px-3 text-left text-[13px] text-slate-700 hover:bg-slate-100" onClick={() => void multiShare('rar')}>分享为RAR</button>
                    </div>
                  )}
                </div>
                <div className="flex-1" />
                <button className="h-8 px-4 rounded-lg bg-blue-500 text-white text-[13px] hover:bg-blue-600 active:scale-95 transition"
                  onClick={exitMulti}>完成</button>
              </div>
            </div>
          </div>

          {/* 内容面板：打开过的标签常驻挂载（切走隐藏、切回保留视图状态，vscode 式；每标签独立错误兜底） */}
          <div className="flex-1 overflow-y-auto relative">
            {docs.map((doc) => {
              const isActive = doc.key === activeDoc
              if (doc.kind === 'folder') {
                return (
                  <ContentBoundary key={doc.key}>
                  <div className={isActive ? 'h-full doc-in' : 'hidden'}>
                    <FolderView
                      folder={folders?.folders.find((f) => f.id === doc.folderId) ?? null}
                      books={(books?.books ?? []).filter((b) => folders?.folders.find((f) => f.id === doc.folderId)?.bookIds.includes(b.id))}
                      onOpenBook={openBookTab}
                      multi={multiMode}
                      selectedSet={selectedSet}
                      onToggle={(id) => toggleSelect(id)}
                      onContextMenu={(e, bid) => onBookContextMenu(e, bid, doc.folderId)}
                      onStar={(id) => void toggleBookStar(id)}
                      onPin={(id) => void toggleBookPin(id)}
                    />
                  </div>
                  </ContentBoundary>
                )
              }
              if (doc.kind === 'book') {
                return (
                  <ContentBoundary key={doc.key}>
                  <div className={isActive ? 'h-full doc-in' : 'hidden'}>
                    <BookDetailView
                      bookId={doc.bookId}
                      globalDate={selectedDate}
                      onEditNote={(bid, nid, ch, title) => openNoteTab(bid, nid, ch, title)}
                      onClose={() => closeDoc(doc.key)}
                      onDeleteBook={(id) => { void deleteBook(id); doCloseDoc(doc.key) }}
                    />
                  </div>
                  </ContentBoundary>
                )
              }
              if (doc.kind === 'note') {
                return (
                  <ContentBoundary key={doc.key}>
                  <div className={isActive ? 'h-full doc-in' : 'hidden'}>
                    <NoteEditorView
                      bookId={doc.bookId}
                      noteId={doc.noteId}
                      chapter={doc.chapter}
                      draftKey={doc.draftKey}
                      onClose={() => doCloseDoc(doc.key)}
                      onDirtyChange={(d) => setDirtyKeys((s) => {
                        const next = new Set(s)
                        if (d) next.add(doc.key); else next.delete(doc.key)
                        return next
                      })}
                      ref={(el) => {
                        if (el) noteEditorRefs.current[doc.key] = el
                        else delete noteEditorRefs.current[doc.key]
                      }}
                    />
                  </div>
                  </ContentBoundary>
                )
              }
              return (
                <ContentBoundary key={doc.key}>
                <div className={isActive ? 'doc-in' : 'hidden'}>
                  <>
            {/* FAB：新建书籍/闪念（固定在内容区右下角，滚动时保持） */}
            {(doc.view === 'notes' || doc.view === 'thoughts') && (
              <button
                className="absolute bottom-6 right-6 w-11 h-11 rounded-full bg-blue-500 text-white flex items-center justify-center
                           hover:bg-blue-600 active:scale-95 transition shadow-lg z-20"
                onClick={doc.view === 'thoughts' ? openStickyNew : openNewBook}
                data-tip={doc.view === 'thoughts' ? '新建闪念' : '新增书籍'}
              >
                <Icon name="add" size={20} />
              </button>
            )}
            {doc.view === 'notes' && (
              <div className="p-5">
                <div
                  ref={gridRef}
                  className="grid gap-4"
                  style={{ gridTemplateColumns: `repeat(${gridCols}, ${lib?.cardWidth ?? 140}px)`, justifyContent: 'start' }}
                >
                  {/* 书籍文件夹卡片（液态玻璃；有筛选时不显示，此时直接展示筛选出的书籍卡片） */}
                  {!filtering && (folders?.folders ?? []).map((f) => (
                    <FolderCard key={f.id} folder={f}
                      books={(books?.books ?? []).filter((b) => f.bookIds.includes(b.id))}
                      onClick={() => openFolderTab(f.id, f.name)}
                    />
                  ))}
                  {filteredBooks.map((b) => (
                    <BookCard key={b.id} book={b}
                      createdToday={selectedDate ? b.notes.filter((n) => dateKey(new Date(n.createdAt)) === selectedDate).length : undefined}
                      multi={multiMode}
                      selected={selectedSet.has(b.id)}
                      onSelect={() => toggleSelect(b.id)}
                      onContextMenu={(e) => onBookContextMenu(e, b.id)}
                      onClick={() => { if (multiMode) toggleSelect(b.id); else openBookTab(b.id, b.title) }}
                      onToggleStar={() => void toggleBookStar(b.id)}
                      onTogglePin={() => void toggleBookPin(b.id)}
                    />
                  ))}
                </div>
                {filteredBooks.length === 0 && (folders?.folders.length ?? 0) === 0 && (
                  <p className="text-center text-slate-400 text-[13px] py-12">
                    {books?.books.length === 0 ? '暂无书籍，点击右下角 + 新增' : '没有符合筛选条件的书籍'}
                  </p>
                )}
              </div>
            )}

            {doc.view === 'thoughts' && (
              <div className="h-full flex flex-col">
                <div ref={thoughtsScrollRef} className="flex-1 overflow-y-auto">
                  {thoughtLayout === 'list' ? (
                    /* 整体布局：每条占满整行 */
                    <div className="p-5 space-y-2">
                      {filteredThoughts(thoughts, selectedDate, starFilter, pinFilter).map((t) => (
                        <div key={t.id}
                          className="glass-card rounded-xl p-3 cursor-pointer hover:shadow-md transition-shadow"
                          onDoubleClick={() => editThought(t)}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-1.5 min-w-0">
                              {t.pinned && <Icon name="pin" size={11} className="text-blue-500 shrink-0" data-tip="置顶" />}
                              <span className="text-[12px] text-slate-400">{new Date(t.createdAt).toLocaleString('zh-CN')}</span>
                            </div>
                            <div className="flex gap-1">
                              <button className={`text-[12px] px-1 ${t.pinned ? 'text-blue-500' : 'text-slate-400 hover:text-blue-500'}`}
                                onClick={() => void toggleThoughtPin(t)} data-tip={t.pinned ? '取消置顶' : '置顶'}>
                                {t.pinned ? '已置顶' : '置顶'}
                              </button>
                              <button className={`text-[12px] px-1 ${t.starred ? 'text-amber-500' : 'text-slate-400 hover:text-blue-500'}`}
                                onClick={() => void toggleThoughtStar(t)} data-tip={t.starred ? '取消收藏' : '收藏'}>
                                {t.starred ? '已收藏' : '收藏'}
                              </button>
                              <button className="text-slate-400 hover:text-blue-500 text-[12px] px-1"
                                onClick={() => openToNote(t)}>收入笔记</button>
                              <button className="text-slate-400 hover:text-blue-500 text-[12px] px-1"
                                onClick={() => void duplicateThought(t)}>复制</button>
                              <button className="text-slate-400 hover:text-red-500 text-[12px] px-1"
                                onClick={() => void deleteThought(t)}>删除</button>
                            </div>
                          </div>
                          <NotePreview content={t.content} className="text-[13px] text-slate-700 mt-1 line-clamp-6 overflow-hidden" />
                          <p className="text-[11px] text-slate-400 mt-1">双击编辑</p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    /* 卡片布局：固定 280×190 宽矩形卡片（约两个书籍卡大小），内容溢出截断 */
                    <div className="p-5 grid gap-4"
                      style={{ gridTemplateColumns: 'repeat(auto-fill, 280px)', justifyContent: 'start' }}>
                      {filteredThoughts(thoughts, selectedDate, starFilter, pinFilter).map((t) => (
                        <div key={t.id}
                          className="glass-card rounded-xl p-3 cursor-pointer hover:shadow-md transition-shadow w-[280px] h-[190px] flex flex-col group"
                          onDoubleClick={() => editThought(t)}
                        >
                          <div className="flex items-center justify-between gap-2 shrink-0">
                            <div className="flex items-center gap-1 min-w-0">
                              {t.pinned && <Icon name="pin" size={11} className="text-blue-500 shrink-0" data-tip="置顶" />}
                              <span className="text-[11px] text-slate-400 truncate">{new Date(t.createdAt).toLocaleString('zh-CN')}</span>
                            </div>
                            <div className="flex gap-0.5 shrink-0 items-center">
                              {/* 星标：已收藏金色常显；未收藏 hover 卡片浮现 */}
                              <button
                                className={`transition-opacity ${t.starred ? 'text-amber-500' : 'text-slate-400 opacity-0 group-hover:opacity-100 hover:text-amber-500'}`}
                                onClick={() => void toggleThoughtStar(t)}
                                data-tip={t.starred ? '取消收藏' : '收藏'}
                              >
                                <Icon name="star" size={13} />
                              </button>
                              {/* 图钉：已置顶蓝色常显；未置顶 hover 卡片浮现 */}
                              <button
                                className={`transition-opacity ${t.pinned ? 'text-blue-500' : 'text-slate-400 opacity-0 group-hover:opacity-100 hover:text-blue-500'}`}
                                onClick={() => void toggleThoughtPin(t)}
                                data-tip={t.pinned ? '取消置顶' : '置顶'}
                              >
                                <Icon name="pin" size={13} />
                              </button>
                              {/* 更多菜单：收入/复制/删除收进三点按钮 */}
                              <div className="relative">
                                <button
                                  data-thought-menu-toggle
                                  className={`w-6 h-6 flex items-center justify-center rounded-lg transition-opacity ${thoughtMenuId === t.id ? 'text-slate-700 bg-black/5 opacity-100' : 'text-slate-400 opacity-0 group-hover:opacity-100 hover:bg-black/5'}`}
                                  onClick={() => setThoughtMenuId(thoughtMenuId === t.id ? null : t.id)}
                                  data-tip="更多"
                                >
                                  <Icon name="more" size={14} />
                                </button>
                                {thoughtMenuId === t.id && (
                                  <div data-thought-menu-panel className="absolute right-0 top-7 z-30 glass-card rounded-xl p-1.5 min-w-[88px]">
                                    <button className="w-full h-8 rounded-lg px-2.5 text-left text-[12px] text-slate-700 hover:bg-black/5 whitespace-nowrap"
                                      onClick={() => { setThoughtMenuId(null); openToNote(t) }}>
                                      收入笔记
                                    </button>
                                    <button className="w-full h-8 rounded-lg px-2.5 text-left text-[12px] text-slate-700 hover:bg-black/5 whitespace-nowrap"
                                      onClick={() => { setThoughtMenuId(null); void duplicateThought(t) }}>
                                      复制
                                    </button>
                                    <button className="w-full h-8 rounded-lg px-2.5 text-left text-[12px] text-red-500 hover:bg-red-50 whitespace-nowrap"
                                      onClick={() => { setThoughtMenuId(null); void deleteThought(t) }}>
                                      删除
                                    </button>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                          <NotePreview content={t.content} className="text-[12px] text-slate-700 mt-1.5 line-clamp-6 flex-1 overflow-hidden" />
                          <p className="text-[10px] text-slate-400 mt-1 shrink-0">双击编辑</p>
                        </div>
                      ))}
                    </div>
                  )}
                  {(thoughts?.thoughts.length ?? 0) === 0 && (
                    <p className="text-center text-slate-400 text-[13px] py-12">暂无闪念，点击右上角 + 新建</p>
                  )}
                  {starFilter && (thoughts?.thoughts.length ?? 0) > 0
                    && filteredThoughts(thoughts, selectedDate, true, pinFilter).length === 0 && (
                    <p className="text-center text-slate-400 text-[13px] py-12">暂无收藏的闪念</p>
                  )}
                  {pinFilter && (thoughts?.thoughts.length ?? 0) > 0
                    && filteredThoughts(thoughts, selectedDate, starFilter, true).length === 0 && (
                    <p className="text-center text-slate-400 text-[13px] py-12">暂无置顶的闪念</p>
                  )}
                </div>
              </div>
            )}

            {doc.view === 'review' && (
              <div className="p-6 max-w-3xl">
                <p className="text-[12px] text-slate-400">基于今日笔记的 AI 总结（本地模拟或远程模型）</p>
                <button
                  className="mt-3 h-9 px-5 rounded-lg bg-blue-500 text-white text-[13px] hover:bg-blue-600 active:scale-95 transition disabled:opacity-50"
                  disabled={reviewing}
                  onClick={() => void generateReview()}
                >
                  {reviewing ? '生成中…' : '生成今日回顾'}
                </button>
                <div className="mt-4 glass-card rounded-xl p-4 text-[13px] text-slate-700 whitespace-pre-wrap leading-relaxed min-h-32">
                  {reviewText || (selectedDate
                    ? `日历统计：回顾 ${cal?.days[selectedDate]?.reviews ?? 0} 条，更新 ${cal?.days[selectedDate]?.reviewsUpdated ?? 0} 条`
                    : '点击下方按钮，基于当前笔记生成今日回顾。')}
                </div>
              </div>
            )}

            {doc.view === 'ai' && (
              <div className="flex flex-col h-full">
                <div className="flex-1 overflow-y-auto p-4 space-y-2">
                  {chat.map((m, i) => (
                    <div key={i} className={`flex ${m.isUser ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[75%] rounded-2xl px-3.5 py-2 text-[13px] leading-relaxed
                        ${m.isUser ? 'bg-blue-500/90 text-white' : 'bg-white/95 text-slate-700 border border-black/5'}`}>
                        {m.text}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="shrink-0 p-3 border-t border-black/5 flex gap-2">
                  <input
                    className="flex-1 h-10 rounded-lg border border-black/10 bg-white/90 px-3 text-[13px] outline-none"
                    placeholder="与 AI 助手对话（Enter 发送）"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void sendChat() }}
                  />
                  <button className="h-10 px-4 rounded-lg bg-blue-500 text-white text-[13px] hover:bg-blue-600 active:scale-95 transition"
                    onClick={() => void sendChat()}>
                    发送
                  </button>
                </div>
              </div>
            )}
                  </>
                </div>
                </ContentBoundary>
              )
            })}
            {docs.length === 0 && (
              <div className="w-full h-full flex items-center justify-center text-slate-400 text-sm">
                从左侧选择视图或点击书籍卡片开始
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ===== 新增书籍弹窗（搜索选书 / 手动填写 + 封面预览） ===== */}
      {bookDialog && (
        <Modal onClose={() => setBookDialog(false)} width={720}>
          {/* 头部：标题 + 模式切换 */}
          <div className="flex items-center gap-3">
            <p className="text-[15px] font-medium text-slate-800 shrink-0">新增书籍</p>
            <div className="flex-1" />
            <div className="flex items-center rounded-full bg-black/5 p-0.5">
              <button
                className={`h-7 px-3 rounded-full text-[12px] transition-colors ${bookMode === 'search' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                onClick={() => setBookMode('search')}
              >搜索选书</button>
              <button
                className={`h-7 px-3 rounded-full text-[12px] transition-colors ${bookMode === 'manual' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                onClick={() => setBookMode('manual')}
              >手动填写</button>
            </div>
          </div>

          {/* 搜索模式：来源分段 + 搜索框 + 结果列表 */}
          {bookMode === 'search' && (
            <div className="mt-4">
              <div className="flex items-center gap-2">
                <div className="flex items-center rounded-full bg-black/5 p-0.5 shrink-0">
                  {(['weread', 'douban'] as const).map((src) => (
                    <button key={src}
                      className={`h-7 px-3 rounded-full text-[12px] transition-colors ${searchSource === src ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                      onClick={() => { setSearchSource(src); setSearchResults([]); setSelectedResult(null) }}>
                      {src === 'weread' ? '微信读书' : '豆瓣读书'}
                    </button>
                  ))}
                </div>
                <div className="relative flex-1 min-w-0">
                  <input
                    className="w-full h-9 rounded-lg border border-black/10 bg-white/90 pl-3 pr-8 text-[13px] outline-none focus:border-blue-400 transition-colors"
                    placeholder="搜索书名 / 作者，回车搜索"
                    value={searchKw}
                    onChange={(e) => setSearchKw(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void doSearch() }}
                  />
                  {searchKw && (
                    <button
                      className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded-full text-slate-400 hover:text-slate-600 hover:bg-black/5 text-[12px]"
                      onClick={() => { setSearchKw(''); setSearchResults([]); setSelectedResult(null) }}
                      data-tip="清空"
                    >×</button>
                  )}
                </div>
                <button className="h-9 px-4 rounded-lg bg-blue-500 text-white text-[13px] hover:bg-blue-600 active:scale-95 transition disabled:opacity-50 shrink-0"
                  disabled={searching} onClick={() => void doSearch()}>
                  {searching ? '搜索中…' : '搜索'}
                </button>
              </div>

              {/* 结果列表 */}
              <div className="mt-3 space-y-1.5 max-h-48 overflow-y-auto rounded-xl border border-black/5 bg-black/[0.02] p-2">
                {searchResults.map((r, i) => {
                  const sel = selectedResult === r
                  return (
                    <div key={i}
                      className={`flex items-center gap-3 rounded-lg p-2 cursor-pointer border transition-colors ${sel ? 'border-blue-400 bg-blue-50' : 'border-transparent hover:bg-black/5'}`}
                      onClick={() => pickSearchResult(r)}>
                      <div className="w-9 h-12 rounded-md bg-gradient-to-br from-slate-100 to-slate-200 flex items-center justify-center text-slate-400 text-[10px] overflow-hidden shrink-0 shadow-sm">
                        {r.coverUrl
                          ? <BookCover cover={r.coverUrl} className="w-full h-full object-cover" />
                          : <span>{r.title.charAt(0) || '书'}</span>}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-medium text-slate-800 truncate">{r.title}</p>
                        <p className="text-[11px] text-slate-400 truncate">
                          {r.author || '未知作者'}{r.publisher ? ` · ${r.publisher}` : ''}{r.edition ? ` · ${r.edition}` : ''}
                        </p>
                      </div>
                      {isSmallCoverUrl(r.coverUrl) && (
                        <span className="shrink-0 h-5 px-1.5 rounded bg-amber-100 text-amber-600 text-[10px] flex items-center" data-tip="该来源封面仅有小图">小图</span>
                      )}
                      {sel && (
                        <span className="shrink-0 h-5 px-2 rounded-full bg-blue-500 text-white text-[10px] flex items-center">已选</span>
                      )}
                    </div>
                  )
                })}
                {searching && <p className="text-center text-slate-400 text-[12px] py-4 animate-pulse">搜索中…</p>}
                {!searching && searchResults.length === 0 && (
                  <p className="text-center text-slate-400 text-[12px] py-4">
                    {searchKw.trim() ? '没有找到相关书籍，试试其他关键词或来源' : '输入关键词，回车或点击「搜索」'}
                  </p>
                )}
              </div>
              {searchResults.length > 0 && (
                <p className="text-[11px] text-slate-400 mt-1.5">共 {searchResults.length} 条结果 · 点击结果自动填入下方表单</p>
              )}
            </div>
          )}

          {/* 表单（始终可编辑；封面预览区 + 字段区） */}
          <div className="mt-4 flex gap-4">
            {/* 封面区 */}
            <div className="shrink-0 flex flex-col items-center">
              <div className="w-20 h-28 rounded-lg overflow-hidden shadow-sm border border-black/5 relative">
                {bookForm.cover ? (
                  <BookCover cover={bookForm.cover} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-white text-3xl font-semibold"
                    style={{ background: 'linear-gradient(135deg, #6366F1, #4338CA)' }}>
                    {bookForm.title.trim().charAt(0) || '书'}
                  </div>
                )}
              </div>
              <div className="flex gap-1.5 mt-2">
                <button className="h-7 px-2.5 rounded-lg border border-black/10 text-[11px] text-slate-600 hover:bg-black/5"
                  onClick={() => fileRef.current?.click()}>
                  上传
                </button>
                {bookForm.cover && (
                  <button className="h-7 px-2.5 rounded-lg border border-black/10 text-[11px] text-red-500 hover:bg-red-50"
                    onClick={() => setBookForm((f) => ({ ...f, cover: null }))}>
                    移除
                  </button>
                )}
              </div>
              <input ref={fileRef} type="file" accept="image/*" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadCover(f) }} />
            </div>

            {/* 字段区 */}
            <div className="flex-1 min-w-0 grid grid-cols-2 gap-3">
              {/* 基本选项：导入章节信息（始终可见，与搜索/手动模式无关） */}
              <label className="col-span-2 flex items-center gap-1.5 text-[12px] text-slate-600 cursor-pointer select-none">
                <input type="checkbox" checked={importChapters}
                  onChange={(e) => setImportChapters(e.target.checked)}
                  className="accent-blue-500 w-3.5 h-3.5" />
                导入章节信息（豆瓣来源，勾选后保存时同步章节目录）
              </label>
              <label className="text-[12px] text-slate-500 col-span-2">书名 *
                <input
                  className={`mt-1 w-full h-9 rounded-lg border px-3 text-[13px] outline-none transition-colors ${titleError ? 'border-red-400 bg-red-50/50' : 'border-black/10 bg-white/90 focus:border-blue-400'}`}
                  value={bookForm.title}
                  placeholder="必填"
                  onChange={(e) => { setBookForm({ ...bookForm, title: e.target.value }); if (titleError && e.target.value.trim()) setTitleError(false) }}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void saveBook() }}
                />
              </label>
              <label className="text-[12px] text-slate-500">作者
                <input className="mt-1 w-full h-9 rounded-lg border border-black/10 bg-white/90 px-3 text-[13px] outline-none focus:border-blue-400 transition-colors"
                  value={bookForm.author}
                  onChange={(e) => setBookForm({ ...bookForm, author: e.target.value })} />
              </label>
              <label className="text-[12px] text-slate-500">出版社
                <input className="mt-1 w-full h-9 rounded-lg border border-black/10 bg-white/90 px-3 text-[13px] outline-none focus:border-blue-400 transition-colors"
                  value={bookForm.publisher}
                  onChange={(e) => setBookForm({ ...bookForm, publisher: e.target.value })} />
              </label>
              <label className="text-[12px] text-slate-500">版本
                <input className="mt-1 w-full h-9 rounded-lg border border-black/10 bg-white/90 px-3 text-[13px] outline-none focus:border-blue-400 transition-colors"
                  value={bookForm.edition} placeholder="如：第 3 版"
                  onChange={(e) => setBookForm({ ...bookForm, edition: e.target.value })} />
              </label>
              <label className="text-[12px] text-slate-500">标签（逗号分隔）
                <input className="mt-1 w-full h-9 rounded-lg border border-black/10 bg-white/90 px-3 text-[13px] outline-none focus:border-blue-400 transition-colors"
                  value={bookForm.tags}
                  onChange={(e) => setBookForm({ ...bookForm, tags: e.target.value })} />
              </label>
              <label className="text-[12px] text-slate-500 col-span-2">简介
                <textarea className="mt-1 w-full h-16 rounded-lg border border-black/10 bg-white/90 p-3 text-[13px] outline-none resize-none focus:border-blue-400 transition-colors"
                  value={bookForm.desc}
                  onChange={(e) => setBookForm({ ...bookForm, desc: e.target.value })} />
              </label>
            </div>
          </div>

          {/* 底部 */}
          <div className="flex justify-end gap-2 mt-5">
            <button className="h-9 px-4 rounded-lg text-[13px] text-slate-600 hover:bg-black/5"
              onClick={() => setBookDialog(false)}>取消</button>
            <button className="h-9 px-5 rounded-lg bg-blue-500 text-white text-[13px] hover:bg-blue-600 active:scale-95 transition"
              onClick={() => void saveBook()}>保存</button>
          </div>
        </Modal>
      )}

      {/* ===== 选书搜索（豆瓣读书） ===== */}
      {/* ===== 收入笔记 ===== */}
      {noteDialog && books && (
        <Modal onClose={() => setNoteDialog(null)}>
          <p className="text-[15px] font-medium text-slate-800">收入笔记</p>
          <p className="text-[12px] text-slate-500 mt-1">选择放入哪一本书（闪念本身保留）</p>
          <label className="text-[12px] text-slate-500 block mt-4">书籍
            <select className="mt-1 w-full h-8 rounded-lg border border-black/10 bg-white/90 px-2 text-[13px] outline-none"
              value={noteDialog.bookId ?? ''}
              onChange={(e) => setNoteDialog({ ...noteDialog, bookId: Number(e.target.value) })}>
              {books.books.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
            </select>
          </label>
          <label className="text-[12px] text-slate-500 block mt-3">章节
            <input className="mt-1 w-full h-8 rounded-lg border border-black/10 bg-white/90 px-2 text-[13px] outline-none"
              value={noteDialog.chapter} onChange={(e) => setNoteDialog({ ...noteDialog, chapter: e.target.value })} />
          </label>
          <div className="flex justify-end gap-2 mt-5">
            <button className="h-8 px-4 rounded-lg text-[13px] text-slate-600 hover:bg-black/5"
              onClick={() => setNoteDialog(null)}>取消</button>
            <button className="h-8 px-4 rounded-lg bg-blue-500 text-white text-[13px] hover:bg-blue-600"
              onClick={() => void confirmToNote()}>确认</button>
          </div>
        </Modal>
      )}

      {/* ===== 图书馆设置 ===== */}
      {libDialog && (
        <Modal onClose={() => setLibDialog(false)}>
          <p className="text-[15px] font-medium text-slate-800">图书馆设置</p>
          <label className="text-[12px] text-slate-500 block mt-4">笔记排序
            <select className="mt-1 w-full h-8 rounded-lg border border-black/10 bg-white/90 px-2 text-[13px] outline-none"
              value={lib?.sortOrder ?? 'newest'}
              onChange={(e) => { if (lib) setLib({ ...lib, sortOrder: e.target.value as LibrarySettingsData['sortOrder'] }) }}>
              <option value="newest">最新优先</option>
              <option value="oldest">最早优先</option>
            </select>
          </label>
          <label className="text-[12px] text-slate-500 block mt-3">卡片大小
            <select className="mt-1 w-full h-8 rounded-lg border border-black/10 bg-white/90 px-2 text-[13px] outline-none"
              value={lib?.cardWidth ?? 140}
              onChange={(e) => { if (lib) setLib({ ...lib, cardWidth: Number(e.target.value) }) }}>
              <option value={130}>紧凑 130</option>
              <option value={140}>标准 140</option>
              <option value={160}>宽松 160</option>
            </select>
          </label>
          <label className="text-[12px] text-slate-500 block mt-3">标签页切换
            <select className="mt-1 w-full h-8 rounded-lg border border-black/10 bg-white/90 px-2 text-[13px] outline-none"
              value={lib?.tabSwitchMode ?? 'loop'}
              onChange={(e) => { if (lib) setLib({ ...lib, tabSwitchMode: e.target.value as 'loop' | 'fixed' }) }}>
              <option value="loop">循环切换</option>
              <option value="fixed">固定切换</option>
            </select>
          </label>
          <p className="text-[11px] text-slate-400 mt-1.5 leading-relaxed">
            使用上/下方向键可快捷切换标签页（上=左侧标签，下=右侧标签）。
            循环切换：在第一个标签页按上方向键跳转到最后一个标签页，反之亦然，标签页循环滚动；
            固定切换：在第一个标签页按上方向键无效（不存在上一个标签页时不切换），在最后一个标签页按下方向键同理。
          </p>
          <div className="flex justify-end gap-2 mt-5">
            <button className="h-8 px-4 rounded-lg text-[13px] text-slate-600 hover:bg-black/5"
              onClick={() => setLibDialog(false)}>取消</button>
            <button className="h-8 px-4 rounded-lg bg-blue-500 text-white text-[13px] hover:bg-blue-600"
              onClick={() => { if (lib) void saveLibSettings(lib.sortOrder, lib.cardWidth, lib.tabSwitchMode ?? 'loop') }}>保存</button>
          </div>
        </Modal>
      )}

      {/* 关闭确认：有未保存改动的笔记标签 */}
      {confirmClose && (
        <div className="absolute inset-0 bg-black/40 flex items-center justify-center z-50"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setConfirmClose(null) }}>
          <div className="bg-white rounded-2xl w-80 p-5 shadow-xl">
            <p className="text-[15px] font-medium text-slate-800">页面已修改，是否保存？</p>
            <p className="text-[13px] text-slate-500 mt-2">关闭前保存更改，否则将舍弃未保存的修改。</p>
            <div className="flex justify-end gap-2 mt-4">
              <button className="h-8 px-4 rounded-lg text-[13px] text-slate-600 hover:bg-slate-50"
                onClick={() => setConfirmClose(null)}>取消</button>
              <button className="h-8 px-4 rounded-lg bg-red-500 text-white text-[13px] hover:bg-red-600"
                onClick={() => {
                  const h = noteEditorRefs.current[confirmClose]
                  h?.discardNow()
                  setConfirmClose(null)
                }}>舍弃</button>
              <button className="h-8 px-4 rounded-lg bg-blue-500 text-white text-[13px] hover:bg-blue-600"
                onClick={() => {
                  const h = noteEditorRefs.current[confirmClose]
                  h?.saveNow(true)
                  setConfirmClose(null)
                }}>保存</button>
            </div>
          </div>
        </div>
      )}

      {/* "取消该分组"确认（文件夹页多选） */}
      {folderDeleteConfirm && (
        <div className="absolute inset-0 bg-black/40 flex items-center justify-center z-50"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setFolderDeleteConfirm(false) }}>
          <div className="bg-white rounded-2xl w-80 p-5 shadow-xl">
            <p className="text-[15px] font-medium text-slate-800">取消该分组</p>
            <p className="text-[13px] text-slate-500 mt-2">
              将删除文件夹「{folders?.folders.find((f) => f.id === multiFolderId)?.name ?? ''}」，
              其中 {folders?.folders.find((f) => f.id === multiFolderId)?.bookIds.length ?? 0} 本书回到书架。确定吗？
            </p>
            <div className="flex justify-end gap-2 mt-4">
              <button className="h-8 px-4 rounded-lg text-[13px] text-slate-600 hover:bg-slate-50"
                onClick={() => setFolderDeleteConfirm(false)}>取消</button>
              <button className="h-8 px-4 rounded-lg bg-red-500 text-white text-[13px] hover:bg-red-600"
                onClick={() => void cancelFolder()}>删除分组</button>
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

