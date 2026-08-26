// Markdown ↔ Lexical EditorState JSON 双向转换（应用笔记事实源 = Markdown）。
// 本应用编辑器支持的节点类型（段落/标题/无序·有序·待办列表/引用/代码块/图片/行内加粗·斜体·删除线·行内代码）
// 在 md 中均可无损表达，故 content 直接存 Markdown 以大幅减小存储体积（尤其不再内嵌 dataURL 图片）。

// ================= Lexical → Markdown =================

type JNode = Record<string, unknown>
type JChildren = JNode[] | undefined

function childrenOf(n: JNode): JChildren {
  return Array.isArray(n.children) ? (n.children as JNode[]) : undefined
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 块内纯文本（无格式） */
export function collectText(n: JNode): string {
  if (n.type === 'text') return String(n.text ?? '')
  let out = ''
  for (const c of childrenOf(n) ?? []) out += collectText(c)
  return out
}

/** 行内文本 → Markdown（code/bold/italic/删除线） */
function inlineTextMd(n: JNode): string {
  if (n.type === 'text') {
    const text = String(n.text ?? '')
    const fmt = Number(n.format ?? 0)
    let t = text
    if (fmt & 8) t = `\`${t}\``
    if (fmt & 4) t = `~~${t}~~`
    if (fmt & 2) t = `*${t}*`
    if (fmt & 1) t = `**${t}**`
    return t
  }
  let out = ''
  for (const c of childrenOf(n) ?? []) out += inlineTextMd(c)
  return out
}

/** 列表 → Markdown 行（支持嵌套列表缩进与真实有序编号还原） */
function emitListMd(n: JNode, out: string[], imgRef: (src: string) => string, prefix = ''): void {
  const lt = String(n.listType ?? 'bullet')
  for (const li of childrenOf(n) ?? []) {
    const kids = childrenOf(li) ?? []
    // 该项正文 = 直接行内子节点；list 子节点是嵌套列表，单独递归加缩进
    const inline = kids.filter((k) => (k.type as string) !== 'list').map((k) => inlineTextMd(k)).join('')
    const marker = lt === 'check'
      ? `- ${li.checked === true ? '[x]' : '[ ]'} `
      : lt === 'bullet' ? '- '
        : `${Number(li.value ?? 1)}. `
    out.push(`${prefix}${marker}${inline.trimEnd()}`.trimEnd())
    for (const k of kids) {
      if ((k.type as string) === 'list') emitListMd(k, out, imgRef, `${prefix}  `)
    }
  }
}

function blockMd(n: JNode, out: string[], imgRef: (src: string) => string): boolean {
  const type = n.type as string
  const text = collectText(n)
  if (type === 'code') {
    const lang = String(n.language ?? '').trim()
    out.push('```' + lang, text, '```')
    return false
  }
  if (type === 'heading') {
    const tag = String(n.tag ?? 'H1').toUpperCase()
    out.push(`${'#'.repeat(tag === 'H1' ? 1 : tag === 'H2' ? 2 : 3)} ${inlineTextMd(n)}`.trimEnd())
    return false
  }
  if (type === 'list') {
    emitListMd(n, out, imgRef)
    return true
  }
  if (type === 'quote') {
    out.push(`> ${inlineTextMd(n)}`.trimEnd())
    return false
  }
  if (type === 'image') {
    out.push(imgRef(String(n.src ?? '')))
    return false
  }
  out.push(inlineTextMd(n).trimEnd())
  return false
}

/** Lexical EditorState JSON → Markdown 文本（相邻列表块间插空行防合并） */
export function lexicalToMd(content: string): string {
  try {
    const parsed = JSON.parse(content) as { root?: { children?: JNode[] } }
    const out: string[] = []
    let prevList = false
    for (const c of parsed.root?.children ?? []) {
      const isList = blockMd(c, out, (src) => (src ? `![图片](${src})` : '[图片]'))
      if (isList && prevList) out.push('')
      prevList = isList
    }
    return out
      .map((l) => l.trimEnd())
      .join('\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  } catch {
    return ''
  }
}

// ================= Markdown → Lexical =================

function textNode(text: string, format = 0): Record<string, unknown> {
  return { type: 'text', version: 1, text, format: format ? String(format) : '', style: '', mode: 'normal', detail: 0 }
}

function leafNode(type: string, children: Record<string, unknown>[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type, version: 1, ...extra, children }
}

/** 行内解析：**加粗** *斜体* ~~删除线~~ `代码` ![alt](src) → text/image 节点数组 */
function inlineLexical(text: string): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = []
  const re = /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(~~([^~]+)~~)|(`([^`]+)`)|(!\[([^\]]*)\]\(([^)\s]+)\))/g
  let last = 0
  for (const m of text.matchAll(re)) {
    if (m.index !== undefined && m.index > last) nodes.push(textNode(text.slice(last, m.index)))
    if (m[2] !== undefined) nodes.push(textNode(m[2], 1))
    else if (m[4] !== undefined) nodes.push(textNode(m[4], 2))
    else if (m[6] !== undefined) nodes.push(textNode(m[6], 4))
    else if (m[8] !== undefined) nodes.push(textNode(m[8], 8))
    else if (m[10] !== undefined) nodes.push({ type: 'image', version: 1, src: m[11], altText: m[10] || '' })
    last = (m.index ?? 0) + m[0].length
  }
  if (last < text.length) nodes.push(textNode(text.slice(last)))
  return nodes.length ? nodes : [textNode(text)]
}

/** Markdown 文本 → Lexical EditorState JSON 字符串（旧格式纯文本同样兼容：全按段落处理） */
export function mdToLexical(md: string): string {
  const children: Record<string, unknown>[] = []
  const lines = String(md ?? '').replace(/\r\n/g, '\n').split('\n')
  let para: string[] | null = null
  // 列表用缩进栈建模：栈顶为当前打开的列表（嵌套时逐层压栈，缩进回退时弹栈）
  let listStack: { lt: string; items: Record<string, unknown>[]; indent: number; node: Record<string, unknown> }[] = []
  let codeBuf: string[] | null = null
  let codeLang = ''

  /** 当前最内层打开列表 */
  const topList = () => (listStack.length ? listStack[listStack.length - 1] : null)
  /** 关闭缩进 ≥ 目标的所有打开列表（挂接已在 openList 时完成，这里仅弹栈） */
  const flushListTo = (indent: number) => {
    while (listStack.length && listStack[listStack.length - 1].indent >= indent) {
      listStack.pop()
    }
  }
  const openList = (lt: string, indent: number): { items: Record<string, unknown>[] } => {
    flushListTo(indent)
    const node: Record<string, unknown> = {
      type: 'list', version: 1,
      listType: lt, tag: lt === 'number' ? 'ol' : 'ul', start: 1,
      children: [],
    }
    const parent = topList()
    if (parent) {
      // Lexical 结构要求：嵌套列表必须挂在父列表最后一个 listitem 的 children 下
      const lastLi = parent.items[parent.items.length - 1] as { children?: unknown } | undefined
      if (lastLi && Array.isArray(lastLi.children)) {
        ;(lastLi.children as Record<string, unknown>[]).push(node)
      } else if (lastLi) {
        lastLi.children = [node]
      } else {
        parent.items.push(node)   // 兜底：父列表尚无任何 item（罕见），退化为平级
      }
    } else {
      children.push(node)
    }
    listStack.push({ lt, indent, items: node.children as Record<string, unknown>[], node })
    return { items: node.children as Record<string, unknown>[] }
  }

  const flushPara = () => {
    if (para && para.some((l) => l.trim() !== '')) {
      children.push(leafNode('paragraph', inlineLexical(para.join('\n'))))
    }
    para = null
  }
  const flushList = () => {
    flushListTo(0)
    listStack = []
  }

  const pushPara = (l: string) => { (para ??= []).push(l) }

  for (const raw of lines) {
    const line = raw.trimEnd()
    if (codeBuf !== null) {
      if (/^```/.test(line.trim())) {
        flushPara(); flushList()
        children.push({ type: 'code', version: 1, language: codeLang || null, children: [textNode(codeBuf.join('\n'))] })
        codeBuf = null
      } else {
        codeBuf.push(line)
      }
      continue
    }
    if (/^```/.test(line.trim())) {
      flushPara(); flushList()
      codeBuf = []
      codeLang = line.trim().slice(3).trim()
      continue
    }
    const mHead = /^(#{1,3})\s+(.*)$/.exec(line)
    if (mHead) {
      flushPara(); flushList()
      children.push(leafNode('heading', inlineLexical(mHead[2]), { tag: `H${mHead[1].length}` }))
      continue
    }
    // 缩进宽度：2 空格或 1 Tab 为一层
    const indentOf = (s: string) => {
      const m = /^[ \t]*/.exec(s)![0]
      let w = 0
      for (const ch of m) w += ch === '\t' ? 2 : 1
      return w
    }
    const mTask = /^(\s*)[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line)
    if (mTask && mTask[3].trim()) {
      flushPara()
      const ind = indentOf(mTask[1])
      const cur = topList()
      // 同类型同缩进 = 续接；其余（无栈顶/类型不同/缩进变化含更深缩进的嵌套）都经 openList 处理
      if (!cur || cur.lt !== 'check' || ind !== cur.indent) {
        const items = openList('check', ind).items
        items.push({ type: 'listitem', version: 1, value: 1, checked: mTask[2].toLowerCase() === 'x', children: inlineLexical(mTask[3]) })
      } else {
        cur.items.push({ type: 'listitem', version: 1, value: 1, checked: mTask[2].toLowerCase() === 'x', children: inlineLexical(mTask[3]) })
      }
      continue
    }
    const mBullet = /^(\s*)[-*]\s+(.*)$/.exec(line)
    if (mBullet && mBullet[2].trim()) {
      flushPara()
      const ind = indentOf(mBullet[1])
      const cur = topList()
      if (!cur || cur.lt !== 'bullet' || ind !== cur.indent) {
        const items = openList('bullet', ind).items
        items.push({ type: 'listitem', version: 1, value: 1, children: inlineLexical(mBullet[2]) })
      } else {
        cur.items.push({ type: 'listitem', version: 1, value: 1, children: inlineLexical(mBullet[2]) })
      }
      continue
    }
    const mNum = /^(\s*)(\d+)[.、]\s+(.*)$/.exec(line)
    if (mNum && mNum[3].trim()) {
      flushPara()
      const ind = indentOf(mNum[1])
      const cur = topList()
      if (!cur || cur.lt !== 'number' || ind !== cur.indent) {
        const items = openList('number', ind).items
        items.push({ type: 'listitem', version: 1, value: Number(mNum[2]), children: inlineLexical(mNum[3]) })
      } else {
        cur.items.push({ type: 'listitem', version: 1, value: Number(mNum[2]), children: inlineLexical(mNum[3]) })
      }
      continue
    }
    const mQuote = /^>\s?(.*)$/.exec(line)
    if (mQuote) {
      flushPara(); flushList()
      children.push(leafNode('quote', inlineLexical(mQuote[1])))
      continue
    }
    if (/^!\[[^\]]*\]\([^)\s]+\)\s*$/.test(line)) {
      flushPara(); flushList()
      const img = /^!\[([^\]]*)\]\(([^)\s]+)\)/.exec(line)!
      children.push({ type: 'image', version: 1, src: img[2], altText: img[1] || '' })
      continue
    }
    if (!line.trim()) { flushPara(); flushList(); continue }
    flushList()
    pushPara(line)
  }
  flushPara(); flushList()
  if (codeBuf !== null) {
    children.push({ type: 'code', version: 1, language: codeLang || null, children: [textNode(codeBuf.join('\n'))] })
  }
  return JSON.stringify({
    root: { children, direction: 'ltr', format: '', indent: 0, type: 'root', version: 1 },
  })
}

// ================= 工具 =================

/** 判断内容是否为 Lexical EditorState JSON（以 { 开头） */
export function isLexicalJson(content: string): boolean {
  return typeof content === 'string' && content.trim().startsWith('{')
}

/** 任意笔记内容 → Lexical EditorState JSON（Lexical JSON 原样；md/纯文本/旧块 JSON 转换） */
export function contentToLexicalJson(content: string): string {
  const t = (content ?? '').trim()
  if (t.startsWith('{')) return content
  if (t.startsWith('[')) {
    // 旧块数组 JSON：递归找文本块拼接为 md 后再解析
    try {
      const blocks = JSON.parse(t) as { type?: string; text?: string; src?: string }[]
      const md = blocks.map((b) => {
        if (b.type === 'image') return b.src ? `![图片](${b.src})` : ''
        return b.text ?? ''
      }).join('\n')
      return mdToLexical(md)
    } catch {
      return mdToLexical(content)
    }
  }
  return mdToLexical(content)
}

/** 任意笔记内容 → 纯文本（搜索/摘要/空检查用） */
export function noteToPlainText(content: string): string {
  const t = (content ?? '').trim()
  if (t.startsWith('{')) {
    try {
      const parsed = JSON.parse(content) as { root?: { children?: JNode[] } }
      const lines: string[] = []
      for (const c of parsed.root?.children ?? []) {
        const type = c.type as string
        if (type === 'image') { lines.push('[图片]'); continue }
        if (type === 'list') {
          for (const li of childrenOf(c) ?? []) lines.push(collectText(li))
          continue
        }
        lines.push(collectText(c))
      }
      return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
    } catch {
      return ''
    }
  }
  // Markdown / 纯文本：去标记取文本
  return t
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, '').trim())
    .replace(/!\[[^\]]*\]\([^)\s]+\)/g, '[图片]')
    .replace(/^\s{0,3}(#{1,6})\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^\s*\d+[.、]\s+/gm, '')
    .replace(/[*_~`#]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** HTML 转义（导出用） */
export { esc }
