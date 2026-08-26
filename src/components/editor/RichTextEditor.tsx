import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import {
  $createParagraphNode, $createRangeSelection, $getRoot, $getSelection,
  $isRangeSelection, $isTextNode, $setSelection, DecoratorNode,
  FORMAT_TEXT_COMMAND, LexicalEditor, RangeSelection, SerializedLexicalNode,
} from 'lexical'
import { $createHeadingNode, $isHeadingNode, HeadingNode, QuoteNode } from '@lexical/rich-text'
import { $createListItemNode, $createListNode, $isListItemNode, $isListNode, ListItemNode, ListNode } from '@lexical/list'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import { ListPlugin } from '@lexical/react/LexicalListPlugin'
import { CheckListPlugin } from '@lexical/react/LexicalCheckListPlugin'
import { CodeHighlightNode, CodeNode, registerCodeHighlighting } from '@lexical/code'
import { useLexicalEditable } from '@lexical/react/useLexicalEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { trimCopyText } from '../../lib/lexical'

interface SerializedImageNode extends SerializedLexicalNode {
  src: string
  altText: string
}

// ===================== 自定义图片节点 =====================

/** 图片显示组件：相对路径（note-images/...）经主进程转 file:// URL；dataURL/http 直接显示 */
function NoteImage({ src, onZoom }: { src: string; onZoom: (url: string) => void }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    if (src.startsWith('data:') || src.startsWith('http')) { setUrl(src); return }
    void window.api.assetUrl(src).then((u) => { if (active) setUrl(u) })
    return () => { active = false }
  }, [src])
  if (!url) return null
  return (
    <img
      src={url}
      alt=""
      className="max-w-[80%] max-h-64 rounded-lg border border-black/5 my-1 cursor-zoom-in"
      draggable={false}
      onDoubleClick={() => onZoom(url)}
    />
  )
}

export class ImageNode extends DecoratorNode<JSX.Element> {
  __src: string

  static getType(): string { return 'image' }
  static clone(node: ImageNode): ImageNode { return new ImageNode(node.__src, node.__key) }
  constructor(src: string, key?: string) { super(key); this.__src = src }
  createDOM(): HTMLElement { return document.createElement('div') }
  updateDOM(): boolean { return false }
  isInline(): boolean { return false }
  decorate(): JSX.Element {
    return (
      <NoteImage
        src={this.__src}
        onZoom={(url) => window.dispatchEvent(new CustomEvent('ball-note-image-zoom', { detail: url }))}
      />
    )
  }
  exportJSON(): SerializedImageNode {
    return { type: 'image', version: 1, src: this.__src, altText: '' }
  }
  static importJSON(data: Record<string, unknown>): ImageNode { return new ImageNode(String(data.src ?? '')) }
}

function $createImageNode(src: string): ImageNode { return new ImageNode(src) }

// ===================== 编辑器主题 =====================

export const theme = {
  root: 'outline-none',
  paragraph: 'm-0 leading-6 text-[14px] text-slate-800',
  text: {
    bold: 'font-bold',
    italic: 'italic',
    strikethrough: 'line-through',
    code: 'bg-slate-100 rounded px-1 font-mono text-[12.5px]',
  },
  heading: {
    h1: 'm-0 text-xl font-bold text-slate-900 leading-7',
    h2: 'm-0 text-lg font-semibold text-slate-900 leading-7',
    h3: 'm-0 text-[15px] font-medium text-slate-900 leading-6',
  },
  list: {
    check: 'lexical-check-list',
    ol: 'm-0 pl-6 list-decimal text-[14px] text-slate-800',
    ul: 'm-0 pl-6 list-disc text-[14px] text-slate-800',
    listitem: 'leading-6',
  },
  quote: 'm-0 pl-3 border-l-4 border-slate-300 text-slate-600 italic leading-6',
  code: 'm-0 p-3 rounded-lg bg-slate-100 font-mono text-[13px] leading-6 block whitespace-pre',
  codeHighlight: {},
}

// ===================== 选区序列化（草稿恢复光标用；原多光标功能已移除，仅保留序列化） =====================


interface SelJson { a: string; ao: number; at: string; f: string; fo: number; ft: string; b: boolean }

function serializeSel(sel: RangeSelection): SelJson {
  return {
    a: sel.anchor.key, ao: sel.anchor.offset, at: sel.anchor.type,
    f: sel.focus.key, fo: sel.focus.offset, ft: sel.focus.type, b: sel.isBackward(),
  }
}


// ===================== 工具栏状态 =====================

interface ToolState { bold: boolean; italic: boolean; strike: boolean; h: string; list: string }

function useToolbar(editor: LexicalEditor) {
  const [state, setState] = useState<ToolState>({ bold: false, italic: false, strike: false, h: '', list: '' })

  useEffect(() => {
    return editor.registerUpdateListener(() => {
      const s = editor.getEditorState().read(() => $getSelection())
      if (!$isRangeSelection(s)) {
        setState({ bold: false, italic: false, strike: false, h: '', list: '' })
        return
      }
      const anchor = s.anchor.getNode()
      const element = anchor.getTopLevelElement()
      setState({
        bold: s.hasFormat('bold'),
        italic: s.hasFormat('italic'),
        strike: s.hasFormat('strikethrough'),
        h: element && $isHeadingNode(element) ? element.getTag() : '',
        list: element && $isListNode(element) ? element.getListType() : '',
      })
    })
  }, [editor])

  /** 光标所在块（段落/标题/列表项等顶层元素） */
  const topElement = (): import('lexical').ElementNode | null => {
    const sel = $getSelection()
    if (!$isRangeSelection(sel)) return null
    return sel.anchor.getNode().getTopLevelElement()
  }

  const toggleHeading = (tag: 'h1' | 'h2' | 'h3') => {
    editor.update(() => {
      const element = topElement()
      if (!element) return
      if ($isHeadingNode(element)) {
        if (element.getTag() === tag) {
          // 同级别 → 转回正文（保留子节点）
          const p = $createParagraphNode()
          element.replace(p, true)
          p.select()
        } else {
          element.setTag(tag)   // 标题层级切换：直接改 tag，内容不动
        }
      } else {
        const h = $createHeadingNode(tag)
        element.replace(h, true)
        h.select()
      }
    })
  }

  const toggleList = (listType: 'bullet' | 'number' | 'check') => {
    editor.update(() => {
      const sel = $getSelection()
      if (!$isRangeSelection(sel)) return
      const anchorNode = sel.anchor.getNode()
      const element = anchorNode.getTopLevelElement()
      if (!element) return
      // 光标在列表内（顶层元素是 ListNode，而非单个 li）：转换整个列表类型
      if ($isListNode(element)) {
        // 定位光标所在列表项
        let li: import('lexical').LexicalNode | null = anchorNode
        while (li && !$isListItemNode(li)) li = li.getParent()
        if (element.getListType() === listType) {
          // 同类型 → 仅将该行拆出为段落（内容保留）
          if ($isListItemNode(li)) {
            const p = $createParagraphNode()
            for (const c of [...li.getChildren()]) p.append(c)
            li.replace(p)
            p.select()
          }
        } else {
          element.setListType(listType)   // 整表转换，各行内容与结构保留
        }
        return
      }
      // 普通块 → 新列表：list 取代原块，原块 children 移入首个列表项
      const list = $createListNode(listType)
      const item = $createListItemNode()
      const children = [...element.getChildren()]
      element.replace(list)
      list.append(item)
      for (const c of children) item.append(c)
      item.select()
    })
  }

  const toggleQuote = () => {
    editor.update(() => {
      const element = topElement()
      if (!element) return
      if (element instanceof QuoteNode) {
        const p = $createParagraphNode()
        element.replace(p, true)
        p.select()
      } else {
        const q = new QuoteNode()
        element.replace(q, true)
        q.select()
      }
    })
  }

  const insertImage = (src: string) => {
    editor.update(() => {
      const node = $createImageNode(src)
      const element = topElement()
      if (element) element.insertAfter(node)   // 在光标所在块之后插入图片块（稳定）
      else $getRoot().append(node)
    })
  }

  return { state, toggleHeading, toggleList, toggleQuote, insertImage }
}

interface SlashCommand {
  key: 'bullet' | 'number' | 'check' | 'bold' | 'image'
  label: string
  icon: string
}

const SLASH_COMMANDS: SlashCommand[] = [
  { key: 'bullet', label: '无序列表', icon: '•' },
  { key: 'number', label: '有序列表', icon: '1.' },
  { key: 'check', label: '待办列表', icon: '☑' },
  { key: 'bold', label: '加粗', icon: 'B' },
  { key: 'image', label: '插入图片', icon: '🖼' },
]

/**
 * Lexical 原生 slash 菜单：检测当前文本节点中光标前的 /query，
 * 执行时先删除触发串，再调用与工具栏完全相同的 Lexical 操作。
 */
function SlashMenu({
  editor,
  toggleList,
  insertImage,
}: {
  editor: LexicalEditor
  toggleList: (type: 'bullet' | 'number' | 'check') => void
  insertImage: (src: string) => void
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [index, setIndex] = useState(0)
  const fileRef = useRef<HTMLInputElement>(null)
  const commands = SLASH_COMMANDS.filter((x) => !query || x.label.includes(query))

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const sel = $getSelection()
        if (!$isRangeSelection(sel) || !sel.isCollapsed()) { setOpen(false); return }
        const node = sel.anchor.getNode()
        if (!$isTextNode(node)) { setOpen(false); return }
        const before = node.getTextContent().slice(0, sel.anchor.offset)
        const m = /\/([^\s/]*)$/.exec(before)
        if (!m) { setOpen(false); return }
        setQuery(m[1])
        setIndex(0)
        setOpen(true)
      })
    })
  }, [editor])

  const removeTrigger = () => {
    editor.update(() => {
      const sel = $getSelection()
      if (!$isRangeSelection(sel) || !sel.isCollapsed()) return
      const node = sel.anchor.getNode()
      if (!$isTextNode(node)) return
      const offset = sel.anchor.offset
      const text = node.getTextContent()
      const m = /\/([^\s/]*)$/.exec(text.slice(0, offset))
      if (!m) return
      const start = offset - m[0].length
      node.setTextContent(text.slice(0, start) + text.slice(offset))
      sel.anchor.set(node.getKey(), start, 'text')
      sel.focus.set(node.getKey(), start, 'text')
    })
  }

  const apply = (command: SlashCommand) => {
    setOpen(false)
    removeTrigger()
    // 删除触发串的 editor.update 完成后，再执行格式命令，保证选区已稳定
    requestAnimationFrame(() => {
      if (command.key === 'bold') {
        editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold')
      } else if (command.key === 'bullet' || command.key === 'number' || command.key === 'check') {
        toggleList(command.key)
      } else if (command.key === 'image') {
        fileRef.current?.click()
      }
    })
  }

  useEffect(() => {
    const root = editor.getRootElement()
    if (!root) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (!open || commands.length === 0) return
      if (event.key === 'ArrowDown') { event.preventDefault(); setIndex((i) => (i + 1) % commands.length) }
      else if (event.key === 'ArrowUp') { event.preventDefault(); setIndex((i) => (i - 1 + commands.length) % commands.length) }
      else if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); apply(commands[index]) }
      else if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
    }
    root.addEventListener('keydown', onKeyDown)
    return () => root.removeEventListener('keydown', onKeyDown)
  }, [editor, open, commands, index])

  if (!open || commands.length === 0) {
    return <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => onImageFile(e, insertImage)} />
  }
  return (
    <>
      <div className="absolute left-4 bottom-3 z-20 w-36 rounded-xl border border-slate-100 bg-white p-1 shadow-xl">
        {commands.map((command, i) => (
          <button
            key={command.key}
            className={`flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[12px] ${i === index ? 'bg-blue-50 text-blue-600' : 'text-slate-700 hover:bg-slate-50'}`}
            onMouseDown={(e) => { e.preventDefault(); apply(command) }}
          >
            <span className="w-5 text-center font-medium">{command.icon}</span>
            {command.label}
          </button>
        ))}
      </div>
      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => onImageFile(e, insertImage)} />
    </>
  )
}

function onImageFile(e: React.ChangeEvent<HTMLInputElement>, insertImage: (src: string) => void): void {
  const file = e.target.files?.[0]
  e.target.value = ''
  if (!file || !file.type.startsWith('image/')) return
  const reader = new FileReader()
  reader.onload = () => {
    const ext = file.name.includes('.') ? `.${file.name.split('.').pop()}` : '.png'
    void window.api.files.saveNoteImage(String(reader.result), ext).then((rel) => insertImage(rel || String(reader.result)))
  }
  reader.readAsDataURL(file)
}

// ===================== 编辑器主体 =====================

/** 编辑器命令式句柄：父组件在保存/分享前调用 flush() 立即同步序列化，避免读到节流窗口内的旧内容 */
export interface RichTextEditorHandle {
  flush: () => void
}

export interface RichTextEditorProps {
  /** Lexical EditorState JSON 字符串；空 → 默认空段落 */
  initialJson: string
  /** 恢复的选区序列化（会话恢复） */
  restoreSelection?: string | null
  readOnly?: boolean
  /** 隐藏顶部工具栏；仍保留编辑器本体 */
  hideToolbar?: boolean
  /** 在编辑器内启用 Lexical slash 菜单（直接执行格式命令，不插入 Markdown 源码） */
  slashMenu?: boolean
  /** 内容或选区变化（草稿自动保存用） */
  onChange: (json: string, selectionJson: string | null) => void
  /** 用户实际编辑（输入/工具栏操作）的即时通知——驱动标签圆圈与草稿自动保存（不等 250ms 防抖序列化） */
  onUserEdit?: () => void
  /** 编辑器句柄（flush 立即序列化；React 19 ref-as-prop） */
  editorRef?: React.Ref<RichTextEditorHandle>
}

/** 空 Lexical EditorState（预览组件等外部复用） */
export const EMPTY_STATE = '{"root":{"children":[{"type":"paragraph","version":1,"children":[]}],"direction":"ltr","format":"","indent":0,"type":"root","version":1}}'

export default function RichTextEditor({ initialJson, restoreSelection, readOnly, hideToolbar, slashMenu, onChange, onUserEdit, editorRef }: RichTextEditorProps) {
  const initialConfig = {
    namespace: 'note-editor',
    theme,
    nodes: [ImageNode, HeadingNode, QuoteNode, ListNode, ListItemNode, CodeNode, CodeHighlightNode],
    onError: (e: Error) => console.error(e),
  }

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <EditorBody initialJson={initialJson} restoreSelection={restoreSelection} readOnly={readOnly} hideToolbar={hideToolbar} slashMenu={slashMenu} onChange={onChange} onUserEdit={onUserEdit} editorRef={editorRef} />
    </LexicalComposer>
  )
}

function EditorBody({ initialJson, restoreSelection, readOnly, hideToolbar, slashMenu, onChange, onUserEdit, editorRef }: RichTextEditorProps) {
  const [editor] = useLexicalComposerContext()
  const isEditable = useLexicalEditable()
  const initialized = useRef(false)
  const { state, toggleHeading, toggleList, toggleQuote, insertImage } = useToolbar(editor)
  const fileRef = useRef<HTMLInputElement>(null)
  const [zoomSrc, setZoomSrc] = useState<string | null>(null)
  // onChange 用 ref：父组件每次渲染传入新函数，但不重建编辑器监听（避免关闭标签时 effect 反复重建与卸载竞态）
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onUserEditRef = useRef(onUserEdit)
  onUserEditRef.current = onUserEdit
  /** 节流定时器（250ms）：移到组件级，flush() 可取消并立即序列化 */
  const throttleRef = useRef({ timer: 0 })

  /** 立即序列化当前编辑器状态并上报（保存/分享前调用，确保读到最新内容） */
  const flushNow = () => {
    try {
      if (!initialized.current || editor.getRootElement() === null) return
      if (throttleRef.current.timer) {
        window.clearTimeout(throttleRef.current.timer)
        throttleRef.current.timer = 0
      }
      const json = JSON.stringify(editor.getEditorState().toJSON())
      let selJson: string | null = null
      editor.getEditorState().read(() => {
        const sel = $getSelection()
        if ($isRangeSelection(sel)) selJson = JSON.stringify(serializeSel(sel))
      })
      onChangeRef.current(json, selJson)
    } catch { /* 编辑器未就绪/已卸载：跳过 */ }
  }
  useImperativeHandle(editorRef, () => ({ flush: flushNow }), [editor])

  // 卸载时：先上报最新内容（编辑器仍挂载可访问），再解除编辑器挂载。
  // 必须用 useLayoutEffect：同步执行，且先上报后解绑——
  // 若先 setRootElement(null)，后续 getEditorState 会抛错误 195（窗口透明），
  // 且 passive cleanup 里 getRootElement() 已为 null 导致上报被跳过（草稿不写入、恢复无效）。
  useLayoutEffect(() => () => {
    try {
      if (initialized.current) {
        const json = JSON.stringify(editor.getEditorState().toJSON())
        let selJson: string | null = null
        editor.getEditorState().read(() => {
          const sel = $getSelection()
          if ($isRangeSelection(sel)) selJson = JSON.stringify(serializeSel(sel))
        })
        onChangeRef.current(json, selJson)
      }
    } catch { /* 忽略 */ }
    try { editor.setRootElement(null) } catch { /* 忽略 */ }
  }, [editor])

  // 图片双击放大（编辑与预览模式均可交互）
  useEffect(() => {
    const onZoom = (e: Event) => setZoomSrc(String((e as CustomEvent).detail ?? ''))
    window.addEventListener('ball-note-image-zoom', onZoom)
    return () => { try { window.removeEventListener('ball-note-image-zoom', onZoom) } catch { /* 忽略 */ } }
  }, [])

  // 初始加载：设置内容 + 恢复选区。
  // 加载期间（loadingRef=true）抑制 onChange 上报——否则 setEditorState 触发的
  // update listener 会把"程序加载的草稿/正式内容"误报为本次改动（标签圆圈、恢复提示误判）
  const loadingRef = useRef(true)
  useEffect(() => {
    loadingRef.current = true
    try {
      const st = editor.parseEditorState(initialJson || EMPTY_STATE)
      editor.setEditorState(st)
      if (restoreSelection) {
        const r = JSON.parse(restoreSelection) as SelJson
        editor.update(() => {
          const sel = $createRangeSelection()
          sel.anchor.set(r.a, r.ao, r.at as RangeSelection['anchor']['type'])
          sel.focus.set(r.f, r.fo, r.ft as RangeSelection['focus']['type'])
          $setSelection(sel)
        })
      }
    } catch { /* 解析失败忽略 */ }
    initialized.current = true
    // setEditorState 触发的 update 异步处理完后再恢复上报
    const t = window.setTimeout(() => { loadingRef.current = false }, 100)
    return () => window.clearTimeout(t)
  }, [editor, initialJson, restoreSelection])

  // 只读态同步到编辑器本体：setEditable(false) 才会把 DOM 的 contenteditable 置为 false，
  // 彻底禁止聚焦/输入（仅传 ContentEditable readOnly 不改 DOM 属性，点击仍会出现光标）
  useEffect(() => {
    editor.setEditable(!readOnly)
  }, [editor, readOnly])

  // 内容/选区变化上报（草稿自动保存）；只注册一次，onChange 经 ref 取最新
  useEffect(() => {
    const unsub = editor.registerUpdateListener(() => {
      if (!initialized.current || loadingRef.current) return   // 加载期间不上报（避免误判为本次改动）
      // 节流：停止输入 250ms 后才序列化（大内容含图片 dataURL 时避免每次按键全量序列化卡顿）
      if (throttleRef.current.timer) return
      throttleRef.current.timer = window.setTimeout(() => {
        throttleRef.current.timer = 0
        // 编辑器可能已卸载（关闭标签）：卸载后操作会抛 Lexical 错误 195
        try {
          if (editor.getRootElement() === null) return
          const json = JSON.stringify(editor.getEditorState().toJSON())
          let selJson: string | null = null
          editor.getEditorState().read(() => {
            const sel = $getSelection()
            if ($isRangeSelection(sel)) selJson = JSON.stringify(serializeSel(sel))
          })
          onChangeRef.current(json, selJson)
        } catch { /* 编辑器已卸载：跳过本次上报 */ }
      }, 250)
    })
    return () => {
      // 卸载清理：全部 try/catch，避免清理阶段抛错导致 React 整树卸载（窗口透明）
      try {
        if (throttleRef.current.timer) {
          window.clearTimeout(throttleRef.current.timer)
          throttleRef.current.timer = 0
          // 卸载前立即序列化并上报最新内容（否则输入后 250ms 内关闭标签，onChange 从未触发 → 内容丢失）
          if (initialized.current && editor.getRootElement() !== null) {
            const json = JSON.stringify(editor.getEditorState().toJSON())
            let selJson: string | null = null
            editor.getEditorState().read(() => {
              const sel = $getSelection()
              if ($isRangeSelection(sel)) selJson = JSON.stringify(serializeSel(sel))
            })
            onChangeRef.current(json, selJson)
          }
        }
      } catch { /* 忽略 */ }
      try { unsub() } catch { /* 忽略 */ }
    }
  }, [editor])

  // 智能复制：裁剪选区首尾空白
  useEffect(() => {
    const el = editor.getRootElement()
    if (!el) return
    const onCopy = (e: ClipboardEvent) => {
      const text = window.getSelection()?.toString()
      if (text) {
        e.preventDefault()
        e.clipboardData?.setData('text/plain', trimCopyText(text))
      }
    }
    el.addEventListener('copy', onCopy)
    return () => { try { el.removeEventListener('copy', onCopy) } catch { /* 忽略 */ } }
  }, [editor])

  // 用户输入（beforeinput：打字/删除/粘贴等）→ 立即通知父组件（dirty 圆圈、草稿自动保存）
  useEffect(() => {
    const el = editor.getRootElement()
    if (!el) return
    const onInput = () => onUserEditRef.current?.()
    el.addEventListener('beforeinput', onInput)
    return () => { try { el.removeEventListener('beforeinput', onInput) } catch { /* 忽略 */ } }
  }, [editor])

  // 代码高亮
  useEffect(() => {
    if (!isEditable) return
    const unsub = registerCodeHighlighting(editor)
    return () => { try { unsub?.() } catch { /* 忽略 */ } }
  }, [editor, isEditable])

  const ToolBtn = ({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: React.ReactNode }) => (
    <button
      className={`w-8 h-8 flex items-center justify-center rounded-lg transition-colors ${active ? 'bg-blue-500/10 text-blue-600' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => { onClick(); onUserEditRef.current?.() }}   // 工具栏操作同样视为用户改动
      data-tip={label}
    >{children}</button>
  )

  const pickImage = () => fileRef.current?.click()

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f || !f.type.startsWith('image/')) return
    const reader = new FileReader()
    reader.onload = () => {
      // 图片落盘为文件（note-images/... 相对路径），避免超大 dataURL 内嵌进笔记内容
      const ext = f.name.includes('.') ? `.${f.name.split('.').pop()}` : '.png'
      void window.api.files.saveNoteImage(String(reader.result), ext).then((rel) => {
        insertImage(rel || String(reader.result))   // 落盘失败回退 dataURL（保持可用）
      })
    }
    reader.readAsDataURL(f)
  }

  return (
    <div className="relative w-full h-full flex flex-col">
      {/* 工具栏（只读隐藏；撤销/重做走 Ctrl+Z/Ctrl+Shift+Z 快捷键） */}
      {!readOnly && !hideToolbar && (
        <div className="h-10 shrink-0 flex items-center gap-0.5 px-2 border-b border-slate-100"
          onMouseDown={(e) => e.preventDefault()}>
          <ToolBtn label="加粗" active={state.bold} onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold')}><b className="text-[13px]">B</b></ToolBtn>
          <ToolBtn label="斜体" active={state.italic} onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'italic')}><i className="text-[13px]">I</i></ToolBtn>
          <ToolBtn label="删除线" active={state.strike} onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'strikethrough')}><s className="text-[13px]">S</s></ToolBtn>
          <ToolBtn label="行内代码" onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'code')}><code className="text-[12px]">{'</>'}</code></ToolBtn>
          <div className="w-px h-5 bg-slate-200 mx-1" />
          <ToolBtn label="标题层级" onClick={() => { const next = state.h === 'h1' ? 'h2' : state.h === 'h2' ? 'h3' : state.h === 'h3' ? '' : 'h1'; if (next) toggleHeading(next as 'h1' | 'h2' | 'h3') }}>
            <span className="text-[13px] font-bold">H</span>
          </ToolBtn>
          <ToolBtn label="无序列表" active={state.list === 'bullet'} onClick={() => toggleList('bullet')}>•</ToolBtn>
          <ToolBtn label="有序列表" active={state.list === 'number'} onClick={() => toggleList('number')}><span className="text-[12px] font-semibold">1.</span></ToolBtn>
          <ToolBtn label="待办事项" active={state.list === 'check'} onClick={() => toggleList('check')}>☑</ToolBtn>
          <ToolBtn label="引用" onClick={toggleQuote}>❝</ToolBtn>
          <ToolBtn label="代码块" onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'code')}><code className="text-[12px]">{'</>'}</code></ToolBtn>
          <ToolBtn label="插入图片" onClick={pickImage}>🖼</ToolBtn>
        </div>
      )}

      {/* 编辑区 */}
      <div className="flex-1 min-h-0 relative">
        <RichTextPlugin
          contentEditable={
            <ContentEditable
              readOnly={readOnly}
              className={`w-full h-full outline-none overflow-y-auto px-6 py-4 ${readOnly ? 'cursor-default' : ''}`}
              style={{ caretColor: readOnly ? 'transparent' : '#2563EB' }}
            />
          }
          placeholder={
            <div className="absolute top-4 left-6 text-slate-300 text-[14px] pointer-events-none select-none">
              开始输入正文内容…
            </div>
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        {!readOnly && slashMenu && (
          <SlashMenu editor={editor} toggleList={toggleList} insertImage={insertImage} />
        )}
      </div>

      <HistoryPlugin />
      <ListPlugin />
      <CheckListPlugin />

      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFile} />

      {/* 图片双击放大查看（fixed 全屏，点击/滚轮关闭） */}
      {zoomSrc && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center cursor-zoom-out"
          onClick={() => setZoomSrc(null)}
          onDoubleClick={() => setZoomSrc(null)}
        >
          <img src={zoomSrc} alt="" className="max-w-[85%] max-h-[85%] rounded-lg shadow-2xl" draggable={false} />
        </div>
      )}
    </div>
  )
}
