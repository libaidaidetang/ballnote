import { useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { BookStore, Note, NoteDraftsData } from '../../shared/models'
import RichTextEditor from '../components/editor/RichTextEditor'
import { noteTitleFromContent } from '../lib/lexical'
import { contentToLexicalJson, lexicalToMd, noteToPlainText } from '../lib/mdLexical'
import { exportNoteFile, shareNoteFile, type NoteExportKind } from '../lib/noteExport'
import { nextId } from '../lib/ids'
import Icon from '../components/ui/Icon'
import ExportFormatMenu from '../components/ui/ExportFormatMenu'
import { saveStore } from '../lib/storeSave'
import { useToast } from '../lib/ui'

/**
 * 笔记编辑视图（图书馆 tabs 内嵌）：
 * - Lexical 富文本编辑器（工具栏/多光标/智能复制）
 * - 会话自动保存：内容变更防抖写入 note-drafts 草稿，关闭软件不提醒、重开恢复内容与光标位置
 * - 「创建/保存」写入正式 books.json 并清除草稿；预览/分享/删除适配新格式
 */
/** 供图书馆页（关闭确认）调用的命令句柄 */
export interface NoteEditorHandle {
  /** 保存（可带关闭：保存并关闭标签） */
  saveNow: (closeAfter?: boolean) => void
  /** 舍弃改动（清除草稿）并关闭标签 */
  discardNow: () => void
  /** 立即 flush 编辑器并写草稿（窗口关闭前调用；Promise 供批量 await） */
  flushDraft: () => Promise<void>
}

export default function NoteEditorView({ bookId, noteId, chapter, onClose, onDirtyChange, ref, draftKey }: {
  bookId: number
  /** 编辑的笔记 id；null 表示新建 */
  noteId: number | null
  chapter: string
  onClose: () => void
  /** 未保存改动状态上报（驱动标签 × 变圆圈与关闭确认） */
  onDirtyChange?: (dirty: boolean) => void
  ref?: React.Ref<NoteEditorHandle>
  /** 草稿 key 覆盖（图书馆页传入标签唯一 key）：新建笔记草稿按标签隔离，
   *  避免同书多个"新建笔记"标签共用 bookId:new 互踩覆盖 */
  draftKey?: string
}) {
  const [note, setNote] = useState<Note | null>(null)
  const [isNew, setIsNew] = useState(true)
  const [title, setTitle] = useState('')
  const [chapterName, setChapterName] = useState(chapter || '未分类')
  const [initialJson, setInitialJson] = useState('')
  const [restoreSel, setRestoreSel] = useState<string | null>(null)
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const [moreOpen, setMoreOpen] = useState(false)
  /** 导出浮层（图片/纯文本/word/markdown/html） */
  const [exportOpen, setExportOpen] = useState(false)
  /** 分享浮层（与导出同格式，走系统共享） */
  const [shareOpen, setShareOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // toast 状态由 useToast Hook 管理（新 toast 先清旧 timer，卸载自动清理）
  const { toast, showToast } = useToast(2200)

  // ---- 笔记标签（随正式保存写入；数组顺序 = 添加顺序，展示时反转 = 最新在前） ----
  const [tags, setTags] = useState<string[]>([])
  const [tagPanelOpen, setTagPanelOpen] = useState(false)
  const [addingTag, setAddingTag] = useState(false)
  const [tagInput, setTagInput] = useState('')
  const [tagExpanded, setTagExpanded] = useState(false)
  const [tagOverflow, setTagOverflow] = useState(false)
  const tagPanelRef = useRef<HTMLDivElement>(null)
  const chipsRef = useRef<HTMLDivElement>(null)
  /** 更多菜单容器（点击外部关闭） */
  const moreRef = useRef<HTMLDivElement>(null)
  const loaded = useRef(false)
  /** 新建笔记保存后的正式 id（保存后转预览继续编辑，再保存走更新路径） */
  const [savedNoteId, setSavedNoteId] = useState<number | null>(null)
  /** 是否有未保存改动（上报给图书馆页驱动标签圆圈与关闭确认） */
  const dirtyRef = useRef(false)
  const onDirtyRef = useRef(onDirtyChange)
  onDirtyRef.current = onDirtyChange
  const notifyDirty = (d: boolean) => { dirtyRef.current = d; onDirtyRef.current?.(d) }

  // 草稿存储 key：保存后沿用正式 id（bookId:noteId）；未保存新建用标签唯一 draftKey，
  // 缺省回退 bookId:new（兼容旧版本写下的草稿）
  const baseId = savedNoteId ?? noteId
  const draftStoreKey = baseId != null ? `${bookId}:${baseId}` : (draftKey ?? `${bookId}:new`)

  const latest = useRef({ json: '', sel: '' })
  const draftTimer = useRef<number | null>(null)
  /** 上次序列化的内容（真实内容变化检测；选区/聚焦变化不触发 dirty） */
  const prevJsonRef = useRef('')
  /** 舍弃/保存并关闭时置 true：卸载不再 flush 草稿（否则已舍弃/已保存的内容被写回） */
  const suppressFlush = useRef(false)
  /** 保存进行中守卫：防止双击/并发触发两次 save() 各自走新建路径产生重复笔记 */
  const savingRef = useRef(false)
  /** 最新版 saveDraftNow（卸载 flush 用）：避免空依赖闭包捕获旧 draftStoreKey，
   *  导致新建笔记保存后再编辑、关闭时草稿写回错误的 key */
  const saveDraftNowRef = useRef<() => void>(() => {})
  /** 富文本编辑器句柄：保存/分享前 flush() 立即序列化，保证读到最新输入（节流窗口内不丢内容） */
  const editorRef = useRef<import('../components/editor/RichTextEditor').RichTextEditorHandle>(null)

  // ---- 初始加载：优先草稿（会话恢复），否则正式内容（旧块 JSON 自动迁移） ----
  useEffect(() => {
    void (async () => {
      const bookStore = await window.api.store.load<BookStore>('books')
      const b = bookStore.books.find((x) => x.id === bookId)
      if (b && noteId != null) {
        const n = b.notes.find((x) => x.id === noteId)
        if (n) {
          setNote(n)
          setIsNew(false)
          setTitle(n.title)
          setChapterName(n.chapter)
          setTags(n.tags ?? [])
        }
      }
      // 草稿优先
      const drafts = await window.api.store.load<NoteDraftsData>('note-drafts')
      const draft = drafts.drafts[draftStoreKey]
      if (draft) {
        // 仅当草稿与正式内容确实不同（上次确有无保存改动、被自动保存）才提示恢复；
        // 相同（保存后残留的无意义草稿）则清理且不提示（草稿存 Lexical JSON，正式内容为 md，需转换比较）
        const formalContent = b?.notes.find((x) => x.id === noteId)?.content
        const isDifferent = lexicalToMd(draft.content) !== formalContent
        if (isDifferent) {
          showToast('已恢复未保存的修改')
        } else {
          void clearDraft()
        }
        setInitialJson(draft.content || '')
        setRestoreSel(draft.selection)
        latest.current = { json: draft.content || '', sel: draft.selection ?? '' }
        prevJsonRef.current = draft.content || ''
        // 加载草稿不算"本次改动"：不置 dirty（圆圈仅在用户编辑后出现）
      } else if (b && noteId != null) {
        const n = b.notes.find((x) => x.id === noteId)
        if (n) {
          // 正式内容为 Markdown（或旧 Lexical/块 JSON）→ 统一转为 Lexical 编辑器初始态
          const initial = contentToLexicalJson(n.content)
          setInitialJson(initial)
          prevJsonRef.current = initial
        }
      }
      loaded.current = true
    })()
  }, [bookId, noteId])

  // ---- 内容变化：防抖自动保存草稿（仅在用户改动后触发；正常关闭无改动不写草稿） ----
  const saveDraftNow = async () => {
    try {
      if (!dirtyRef.current || !latest.current.json) return   // 无未保存改动则无草稿
      // 笔记/书籍已被删除：不再写草稿——否则残留草稿会在 id 复用时把已删内容"复活"到新笔记
      const baseIdNow = savedNoteId ?? noteId
      const bs = await window.api.store.load<BookStore>('books')
      const b = bs.books.find((x) => x.id === bookId)
      if (!b) return
      if (baseIdNow != null && !b.notes.some((n) => n.id === baseIdNow)) return
      const data = await window.api.store.load<NoteDraftsData>('note-drafts')
      data.drafts[draftStoreKey] = { content: latest.current.json, selection: latest.current.sel || null, updatedAt: Date.now() }
      await saveStore('note-drafts', data)
    } catch { /* 草稿保存失败忽略（下次再试） */ }
  }
  saveDraftNowRef.current = saveDraftNow

  /** 用户实际编辑（输入/工具栏）：立即置 dirty + 防抖自动保存草稿（异常关闭兜底） */
  const handleUserEdit = () => {
    notifyDirty(true)
    if (draftTimer.current) window.clearTimeout(draftTimer.current)
    draftTimer.current = window.setTimeout(() => {
      draftTimer.current = null
      void saveDraftNow()
    }, 800)
  }

  /** 首次 onChange 只校准基准（编辑器实际初始状态），不判 dirty */
  const calibratedRef = useRef(false)

  const onChange = (json: string, selJson: string | null) => {
    latest.current = { json, sel: selJson ?? '' }
    if (!calibratedRef.current) {
      calibratedRef.current = true
      prevJsonRef.current = json   // 以编辑器实际内容为基准（如新建的空段落结构）
      return
    }
    // 内容序列化对比：真实内容变化（工具栏/程序改动等非 beforeinput 路径）也置 dirty；
    // 选区/聚焦变化（json 不变）不置 dirty
    if (json !== prevJsonRef.current) {
      prevJsonRef.current = json
      notifyDirty(true)
      if (draftTimer.current) window.clearTimeout(draftTimer.current)
      draftTimer.current = window.setTimeout(() => {
        draftTimer.current = null
        void saveDraftNow()
      }, 800)
    }
  }

  /** 清除草稿（保存/删除成功后） */
  const clearDraft = async () => {
    try {
      const data = await window.api.store.load<NoteDraftsData>('note-drafts')
      delete data.drafts[draftStoreKey]
      await saveStore('note-drafts', data)
    } catch { /* 忽略 */ }
  }

  // ---- 标签操作 ----
  const addTag = (t: string) => {
    const name = t.trim()
    if (!name || tags.includes(name)) return
    setTags((ts) => [...ts, name])   // 追加到末尾；展示时反转 → 最新在前
    handleUserEdit()
  }
  const removeTag = (t: string) => {
    setTags((ts) => ts.filter((x) => x !== t))
    handleUserEdit()
  }

  // 标签溢出检测：chips 容器内容超宽 → 显示展开箭头
  useEffect(() => {
    const el = chipsRef.current
    if (!el) return
    setTagOverflow(el.scrollWidth > el.clientWidth + 2)
  }, [tags, tagPanelOpen, addingTag])

  // 标签面板点击外部关闭（标签按钮本身用 data-tag-toggle 排除）
  useEffect(() => {
    if (!tagPanelOpen) return
    const h = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (!t.closest('[data-tag-toggle]') && !tagPanelRef.current?.contains(t)) {
        setTagPanelOpen(false); setTagExpanded(false); setAddingTag(false); setTagInput('')
      }
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [tagPanelOpen])

  // 更多菜单 / 导出 / 分享浮层：点击外部关闭
  useEffect(() => {
    if (!moreOpen && !exportOpen && !shareOpen) return
    const h = (e: MouseEvent) => {
      if (!moreRef.current?.contains(e.target as HTMLElement)) { setMoreOpen(false); setExportOpen(false); setShareOpen(false) }
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [moreOpen, exportOpen, shareOpen])

  // 关闭标签/卸载前：有未保存改动才 flush 草稿（异常关闭兜底）；
  // 舍弃/保存并关闭时跳过（suppressFlush），避免已舍弃/已保存内容被写回；无改动不产生草稿。
  // 先 flush 编辑器再写草稿：保证草稿内容 = 编辑器最新状态（不依赖 React 卸载清理顺序）
  useEffect(() => () => {
    if (draftTimer.current) window.clearTimeout(draftTimer.current)
    if (dirtyRef.current && !suppressFlush.current) {
      try { editorRef.current?.flush() } catch { /* 忽略 */ }
      void saveDraftNowRef.current()
    }
  }, [])

  // showToast 由 useToast Hook 提供

  // ---- 保存（写入正式数据并清除草稿；空笔记不可保存；默认转预览不退出，closeAfter 时保存并关闭） ----
  const save = async (closeAfter = false) => {
    if (savingRef.current) return
    savingRef.current = true
    try {
      const data = await window.api.store.load<BookStore>('books')
      const target = data.books.find((x) => x.id === bookId)
      if (!target) { suppressFlush.current = false; showToast('书籍已删除或不存在'); return }
      // 先 flush 编辑器：立即序列化当前内容，避免读到 250ms 节流窗口内的旧内容
      // （否则"刚输入就点关闭→保存"会误判内容为空或把正文存成旧版）
      try { editorRef.current?.flush() } catch { /* 忽略 */ }
      const content = latest.current.json || initialJson
      // 事实源为 Markdown：Lexical 编辑器状态 → md 后落盘（体积小，图片为文件引用）
      const contentMd = lexicalToMd(content)
      // 无标题时用正文开头一小段作标题（与闪念收入笔记等其他保存路径共用同一规则）
      const finalTitle = title.trim() || noteTitleFromContent(contentMd || content)
      const finalChapter = chapterName.trim() || '未分类'
      // 空笔记（无标题且无正文）不可保存
      if (!finalTitle && !noteToPlainText(contentMd || content).trim()) {
        // 保存失败：撤销"保存并关闭"置上的 suppressFlush，避免后续关闭漏写草稿导致改动丢失
        suppressFlush.current = false
        showToast('内容为空，无法保存')
        return
      }
      const realTitle = finalTitle || '未命名笔记'
      if (savedNoteId != null) {
        const n = target.notes.find((x) => x.id === savedNoteId)
        if (n) {
          n.title = realTitle
          n.content = contentMd
          n.chapter = finalChapter
          n.tags = tags
        }
      } else if (isNew) {
        const id = nextId(target.notes)
        const newNote: Note = {
          id, title: realTitle, content: contentMd, chapter: finalChapter,
          tags, createdAt: new Date().toISOString(),
        }
        target.notes.push(newNote)
        setNote(newNote)
        setSavedNoteId(id)
        setIsNew(false)
      } else if (note) {
        const n = target.notes.find((x) => x.id === note.id)
        if (n) {
          n.title = realTitle
          n.content = contentMd
          n.chapter = finalChapter
          n.tags = tags
        }
      }
      const ok = await saveStore('books', data)
      if (!ok) { suppressFlush.current = false; showToast('保存失败，请重试'); return }
      await clearDraft()
      notifyDirty(false)
      showToast(isNew ? '笔记已创建' : '笔记已保存')
      if (closeAfter) {
        onClose()
        return
      }
      // 保存后转为预览模式（不退出标签），可切回编辑继续修改
      setMode('preview')
    } finally {
      savingRef.current = false
    }
  }

  // ---- 删除 ----
  const remove = async () => {
    const targetId = note?.id ?? savedNoteId
    if (targetId == null) return
    const data = await window.api.store.load<BookStore>('books')
    const target = data.books.find((x) => x.id === bookId)
    if (!target) { showToast('书籍已删除或不存在'); return }
    target.notes = target.notes.filter((n) => n.id !== targetId)
    const ok = await saveStore('books', data)
    if (!ok) return
    await clearDraft()
    onClose()
  }

  /** 分享（按格式：文本类走系统共享面板，文件类导出临时文件并在资源管理器选中） */
  const share = async (kind: NoteExportKind) => {
    try { editorRef.current?.flush() } catch { /* 忽略 */ }
    const json = latest.current.json || initialJson
    const exportTitle = title.trim() || noteTitleFromContent(json)
    setShareOpen(false)
    setMoreOpen(false)
    if (kind !== 'png' && !noteToPlainText(json).trim()) { showToast('内容为空，无法分享'); return }
    try {
      const res = await shareNoteFile({ title: exportTitle, content: json }, kind)
      if (res.ok) showToast(res.notice ?? '已分享')
      else showToast(res.error ?? '分享失败')
    } catch {
      // PNG 含外链图片污染 canvas 等异常兜底：不能让 unhandled rejection 无声失败
      showToast('分享失败，请重试')
    }
  }

  // ---- 导出（图片 / 纯文本 / word / markdown / html；文件名 = 标题，默认存到系统"文档"文件夹） ----
  const exportNote = async (kind: NoteExportKind) => {
    try { editorRef.current?.flush() } catch { /* 忽略 */ }
    const json = latest.current.json || initialJson
    const exportTitle = title.trim() || noteTitleFromContent(json)
    setExportOpen(false)
    setMoreOpen(false)
    if (kind !== 'png' && !noteToPlainText(json).trim()) { showToast('内容为空，无法导出'); return }
    try {
      const res = await exportNoteFile({ title: exportTitle, content: json }, kind)
      if (res.ok) showToast(`已导出：${res.path}`)
      else if (!res.canceled) showToast(res.error ?? '导出失败，请重试')
    } catch {
      // 同上：导出链路异常兜底（如 canvas 被外链图片污染），给出可见提示
      showToast('导出失败，请重试')
    }
  }

  // 供图书馆页关闭确认调用：保存并关闭 / 舍弃（清草稿）并关闭；flushDraft 供窗口关闭前批量写草稿
  useImperativeHandle(ref, () => ({
    saveNow: (closeAfter) => {
      if (closeAfter) suppressFlush.current = true
      void save(closeAfter).catch((err) => console.error('[note] 保存失败', err))
    },
    discardNow: () => { suppressFlush.current = true; void clearDraft(); onClose() },
    /** 窗口即将关闭：立即 flush 编辑器并写草稿（返回 Promise 供批量 await 后 ack） */
    flushDraft: (): Promise<void> => {
      if (!dirtyRef.current) return Promise.resolve()
      try { editorRef.current?.flush() } catch { /* 忽略 */ }
      return saveDraftNow()
    },
  }))

  return (
    <div className="w-full h-full flex flex-col overflow-hidden relative">
      {/* ===== 标题栏（编辑/预览 + 标签 + 保存 + 更多） ===== */}
      <div className="h-11 shrink-0 flex items-center px-3 gap-1 border-b border-slate-100 relative">
        <div className="flex items-center gap-0.5 rounded-lg bg-slate-100 p-0.5">
          <button
            className={`h-7 px-3 rounded-md text-[12px] transition-colors ${mode === 'edit' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
            onClick={() => setMode('edit')}
          >编辑</button>
          <button
            className={`h-7 px-3 rounded-md text-[12px] transition-colors ${mode === 'preview' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
            onClick={() => setMode('preview')}
          >预览</button>
        </div>

        {/* 标签按钮（点击向右滑出标签面板，再点缩回） */}
        <button
          data-tag-toggle
          className={`h-7 px-2.5 rounded-lg text-[12px] flex items-center gap-1 transition-colors ${tagPanelOpen ? 'bg-blue-500/10 text-blue-600' : 'text-slate-600 hover:bg-slate-100'}`}
          onClick={() => {
            if (tagPanelOpen) { setTagExpanded(false); setAddingTag(false); setTagInput('') }
            setTagPanelOpen(!tagPanelOpen)
          }}
        >
          <Icon name="tag" size={13} />
          标签
          {tags.length > 0 && <span className="text-[10px] text-slate-400">({tags.length})</span>}
        </button>

        {/* 标签面板：从按钮向右滑出；溢出时右侧箭头 → 下拉展示全部 */}
        {tagPanelOpen && (
          <div className="relative ml-0.5" ref={tagPanelRef}>
            <div className="flex items-center gap-1.5 pl-2 pr-1 h-9 rounded-lg bg-slate-50 border border-slate-100"
              style={{ maxWidth: 360 }}>
              {/* 加号：点击显示输入框 */}
              <button className="w-6 h-6 shrink-0 flex items-center justify-center rounded-md text-slate-500 hover:bg-slate-200/70"
                onClick={() => { setAddingTag(!addingTag); if (!addingTag) setTagInput('') }}
                data-tip="添加标签">
                <Icon name="add" size={13} />
              </button>
              {addingTag && (
                <input
                  autoFocus
                  className="w-28 h-6 shrink-0 rounded-md border border-blue-300 bg-white px-2 text-[12px] outline-none"
                  placeholder="按下enter添加"
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                      const t = tagInput.trim()
                      if (t) { addTag(t); setTagInput('') }
                    } else if (e.key === 'Escape') { setAddingTag(false); setTagInput('') }
                  }}
                  onBlur={() => { if (!tagInput.trim()) setAddingTag(false) }}
                />
              )}
              {/* 已添加标签 chips（最新在前） */}
              <div ref={chipsRef} className="flex items-center gap-1.5 overflow-hidden flex-1 min-w-0">
                {[...tags].reverse().map((t) => (
                  <span key={t}
                    className="h-6 px-2 rounded-md bg-white border border-slate-200 text-[12px] text-slate-600 flex items-center gap-1 shrink-0">
                    {t}
                    <button className="text-slate-400 hover:text-red-500" onClick={() => removeTag(t)} data-tip="删除标签">
                      <Icon name="close" size={11} />
                    </button>
                  </span>
                ))}
                {tags.length === 0 && !addingTag && (
                  <span className="text-[11px] text-slate-400">暂无标签</span>
                )}
              </div>
              {/* 溢出箭头：左 → 点击展开（图标变下箭头）/ 再点收起 */}
              {tagOverflow && (
                <button className="w-6 h-6 shrink-0 flex items-center justify-center rounded-md text-slate-500 hover:bg-slate-200/70"
                  onClick={() => setTagExpanded(!tagExpanded)}
                  data-tip={tagExpanded ? '收起全部标签' : '展开全部标签'}>
                  <Icon name={tagExpanded ? 'arrow-down' : 'arrow-left'} size={13} />
                </button>
              )}
            </div>
            {/* 展开：下拉浮层显示全部标签 */}
            {tagExpanded && (
              <div className="absolute top-10 left-0 z-40 glass-card rounded-xl p-2.5 w-72">
                <p className="text-[11px] text-slate-400 mb-1.5">全部标签（{tags.length}）</p>
                <div className="flex flex-wrap gap-1.5 max-h-44 overflow-y-auto">
                  {[...tags].reverse().map((t) => (
                    <span key={t}
                      className="h-7 px-2.5 rounded-md bg-white border border-slate-200 text-[12px] text-slate-600 flex items-center gap-1.5">
                      {t}
                      <button className="text-slate-400 hover:text-red-500" onClick={() => removeTag(t)} data-tip="删除标签">
                        <Icon name="close" size={11} />
                      </button>
                    </span>
                  ))}
                  {tags.length === 0 && <p className="text-[12px] text-slate-400 py-2">暂无标签，点击「+」添加</p>}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="flex-1" />

        {/* 保存（图标 + tooltip，位于更多按钮左边；预览模式禁用） */}
        <button
          className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          disabled={mode === 'preview'}
          data-tip={isNew ? '创建笔记' : '保存笔记'}
          onClick={() => void save().catch((err) => console.error('[note] 保存失败', err))}
        >
          <Icon name="save" size={15} />
        </button>

        <div className="relative" ref={moreRef}>
          <button
            className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
            onClick={() => { setMoreOpen(!moreOpen); setExportOpen(false); setShareOpen(false) }}
            data-tip="更多"
          >
            <Icon name="more" size={15} />
          </button>
          {moreOpen && (
            <div className="absolute right-0 top-9 z-30 w-28 bg-white rounded-xl shadow-lg border border-slate-100 p-1">
              <button className="w-full h-8 rounded-lg px-3 text-left text-[13px] text-slate-700 hover:bg-slate-50"
                onClick={() => { setMoreOpen(false); setShareOpen(true) }}>
                分享
              </button>
              <button className="w-full h-8 rounded-lg px-3 text-left text-[13px] text-slate-700 hover:bg-slate-50"
                onClick={() => { setMoreOpen(false); setExportOpen(true) }}>
                导出
              </button>
              {!isNew && (
                <button className="w-full h-8 rounded-lg px-3 text-left text-[13px] text-red-500 hover:bg-red-50"
                  onClick={() => { setMoreOpen(false); setConfirmDelete(true) }}>
                  删除
                </button>
              )}
            </div>
          )}
          {/* 分享/导出浮层：公共组件（此前为两份复制的 JSX） */}
          {shareOpen && (
            <ExportFormatMenu mode="share" className="absolute right-0 top-9 z-40"
              onSelect={(kind) => void share(kind)} />
          )}
          {exportOpen && (
            <ExportFormatMenu mode="export" className="absolute right-0 top-9 z-40"
              onSelect={(kind) => void exportNote(kind)} />
          )}
        </div>
      </div>

      {/* ===== 标题输入 ===== */}
      <div className="shrink-0 px-8 pt-3 pb-1">
        <input
          className="w-full text-[20px] font-medium text-slate-800 outline-none placeholder:text-slate-300 bg-transparent"
          placeholder="请输入标题"
          value={title}
          disabled={mode === 'preview'}
          onChange={(e) => { setTitle(e.target.value); handleUserEdit() }}
        />
      </div>

      {/* ===== 富文本编辑器（Lexical） ===== */}
      <div className="flex-1 min-h-0">
        {loaded.current || initialJson !== '' ? (
          <RichTextEditor
            initialJson={initialJson}
            restoreSelection={restoreSel}
            readOnly={mode === 'preview'}
            onChange={onChange}
            onUserEdit={handleUserEdit}
            editorRef={editorRef}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-slate-400 text-sm">加载中…</div>
        )}
      </div>

      {/* Toast */}
      {toast && (
        <div className="absolute top-14 left-1/2 -translate-x-1/2 z-40 glass-card rounded-full px-4 py-2"
          style={{ animation: 'toast-in 220ms ease-out' }}>
          <span className="text-[13px] text-slate-700">{toast.msg}</span>
        </div>
      )}

      {/* 删除确认 */}
      {confirmDelete && (
        <div className="absolute inset-0 bg-black/40 flex items-center justify-center z-40"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setConfirmDelete(false) }}>
          <div className="bg-white rounded-2xl w-72 p-5 shadow-xl">
            <p className="text-[15px] font-medium text-slate-800">删除笔记</p>
            <p className="text-[13px] text-slate-500 mt-2">删除后不可恢复，确定删除「{title}」吗？</p>
            <div className="flex justify-end gap-2 mt-4">
              <button className="h-8 px-4 rounded-lg text-[13px] text-slate-600 hover:bg-slate-50"
                onClick={() => setConfirmDelete(false)}>取消</button>
              <button className="h-8 px-4 rounded-lg bg-red-500 text-white text-[13px] hover:bg-red-600"
                onClick={() => void remove()}>删除</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
