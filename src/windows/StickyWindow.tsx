import { useEffect, useRef, useState } from 'react'
import type { ThoughtStoreData } from '../../shared/models'
import Icon from '../components/ui/Icon'
import RichTextEditor, { type RichTextEditorHandle } from '../components/editor/RichTextEditor'
import { EMPTY_LEXICAL_STATE } from '../lib/ui'
import { saveStore } from '../lib/storeSave'
import { contentToLexicalJson } from '../lib/mdLexical'
import { lexicalJsonToMarkdown } from '../lib/noteExport'
import { nextId } from '../lib/ids'

/**
 * 闪念便利贴窗口（Lexical 版）：复用 RichTextEditor 提供完整工具栏（加粗/斜体/标题/列表/引用/图片），
 * 事实源 = Lexical EditorState JSON（与 Note 一致），保存后写入 ThoughtStore 并关闭。
 *
 * 与旧版区别：textarea + 「/」菜单 → 完整富文本编辑器；闪念 content 字段不再限于纯文本。
 */

/** 空 Lexical EditorState：公共常量见 lib/ui.ts（与渲染端同源结构） */
const EMPTY_STATE = EMPTY_LEXICAL_STATE

export default function StickyWindow({ editId }: { editId: number | null }) {
  const [pinned, setPinned] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(editId)
  const [initialJson, setInitialJson] = useState<string>(EMPTY_STATE)
  const editorRef = useRef<RichTextEditorHandle>(null)

  // 编辑模式：加载闪念内容（已是 Lexical JSON）
  useEffect(() => {
    const target = editingId
    if (target == null) { setInitialJson(EMPTY_STATE); return }
    void window.api.store.load<ThoughtStoreData>('thoughts').then((data) => {
      const t = data.thoughts.find((x) => x.id === target)
      // 兼容三种事实源：Lexical JSON（启动迁移未跑）、Markdown（主流程）、纯文本/空（兜底）
      // 用 contentToLexicalJson 统一转 Lexical 初始态
      const c = String(t?.content ?? '')
      setInitialJson(contentToLexicalJson(c))
    })
  }, [editingId])

  // 主进程切换编辑目标（单实例复用）
  useEffect(() => {
    return window.api.sticky.onEditId((id) => {
      setEditingId(id)
      setInitialJson(EMPTY_STATE)
    })
  }, [])

  const save = () => {
    // flush 立即序列化当前编辑器状态（避免 250ms 节流窗口内的旧内容）
    editorRef.current?.flush()
    void (async () => {
      // 直接从 latest 状态取：RichTextEditor 每次 onChange 都会更新
      const json = latestJsonRef.current || EMPTY_STATE
      // 空内容直接跳过（与旧版 save() 一致：trim 后空不保存）
      if (isLexicalEmpty(json)) return
      // 闪念事实源 = Markdown（与 Note.content 同源）：Lexical JSON → Markdown 转换后落库
      const mdContent = lexicalJsonToMarkdown(json) || ''
      if (editingId != null) {
        const data = await window.api.store.load<ThoughtStoreData>('thoughts')
        const t = data.thoughts.find((x) => x.id === editingId)
        if (t) {
          t.content = mdContent
          const ok = await saveStore('thoughts', data)
          if (!ok) return
        }
      } else {
        const data = await window.api.store.load<ThoughtStoreData>('thoughts')
        const id = nextId(data.thoughts)
        data.thoughts.unshift({ id, content: mdContent, createdAt: new Date().toISOString() })
        const ok = await saveStore('thoughts', data)
        if (!ok) return
      }
      window.api.page.close()
    })()
  }

  // onChange 把最新 JSON 写到 ref，供 save() 使用
  const latestJsonRef = useRef<string>(EMPTY_STATE)
  const onChange = (json: string) => { latestJsonRef.current = json }

  // Ctrl+Enter 提交（与旧版一致）
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); save() }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [editingId])

  const barH = Math.round(70 / window.devicePixelRatio)   // 非编辑区栏高按物理像素 70px

  return (
    <div className="w-full h-full p-2">
      <div className="w-full h-full bg-white flex flex-col overflow-hidden rounded-[6px]">
        {/* 标题栏（可拖拽，无分隔线；物理高 80px） */}
        <div
          className="shrink-0 flex items-center px-4 gap-1"
          style={{ WebkitAppRegion: 'drag', height: barH } as React.CSSProperties}
        >
          <span className="text-lg font-bold text-slate-700">{editingId != null ? '编辑闪念' : '闪念'}</span>
          <div className="flex-1" />
          <button
            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-black/5"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            onClick={() => {
              const next = !pinned
              setPinned(next)
              // 图钉置顶：通过主进程切换 Topmost
              window.api.sticky.setPinned(next)
            }}
            data-tip="置顶"
          >
            <Icon name="pin" size={15} className={pinned ? 'text-blue-500' : 'text-slate-500'} />
          </button>
          <button
            className="w-7 h-7 flex items-center justify-center rounded-lg text-slate-500 hover:bg-red-50 hover:text-red-500"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            onClick={() => window.api.page.close()}
            data-tip="关闭"
          >
            <Icon name="close" size={14} />
          </button>
        </div>
        {/* 编辑区：复用 RichTextEditor（带工具栏 + Lexical 编辑器 + 图片插入） */}
        <div className="flex-1 min-h-0 relative">
          <RichTextEditor
            initialJson={initialJson}
            hideToolbar
            slashMenu
            onChange={onChange}
            editorRef={editorRef}
          />
        </div>
        {/* 底部创建栏：横向胶囊按钮（物理高 70px） */}
        <div className="shrink-0 flex items-center justify-end px-6" style={{ height: barH }}>
          <button
            className="h-9 px-5 rounded-full text-white flex items-center justify-center gap-1.5
                       bg-blue-500 hover:bg-blue-600 active:scale-95 transition"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            onClick={save}
            data-tip={editingId != null ? '保存' : '创建'}
          >
            <Icon name="send" size={15} />
          </button>
        </div>
      </div>
    </div>
  )
}

/** 检测 Lexical EditorState 是否为空（仅含空段落，无文本/无图片） */
function isLexicalEmpty(json: string): boolean {
  try {
    const root = (JSON.parse(json) as { root?: { children?: { type?: string; children?: { text?: string }[] }[] } }).root
    const children = root?.children ?? []
    if (children.length === 0) return true
    // 单段落 + 空文本 → 空
    if (children.length === 1) {
      const c = children[0]
      if (c.type === 'paragraph') {
        const ch = c.children ?? []
        if (ch.length === 0) return true
        if (ch.every((t) => !t.text)) return true
      }
    }
    return false
  } catch {
    // 解析失败：当作非空（保守）
    return false
  }
}
