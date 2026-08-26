// Lexical 编辑器数据工具：Lexical JSON → 纯文本（搜索/摘要/分享）、复制裁剪。
// Lexical EditorState JSON 结构：{ root: { children: [...], direction, format, indent, type, version } }

/** 递归收集节点文本（含列表前缀），返回行数组 */
function collectLines(node: Record<string, unknown>, lines: string[]): void {
  const type = node.type as string
  const childNodes = (node.children as Record<string, unknown>[] | undefined) ?? []
  if (type === 'text') {
    const text = String(node.text ?? '')
    if (text) lines[lines.length - 1] = (lines[lines.length - 1] ?? '') + text
    return
  }
  if (type === 'paragraph' || type === 'heading' || type === 'quote') {
    if (lines.length && lines[lines.length - 1] !== '') lines.push('')
    lines.push('')
    for (const c of childNodes) collectLines(c, lines)
    return
  }
  if (type === 'list') {
    const listType = node.listType as string
    let idx = 0
    for (const item of childNodes) {
      idx++
      const p = listType === 'bullet' ? '• ' : listType === 'check'
        ? (item.checked === true ? '[x] ' : '[ ] ') : `${idx}. `
      lines.push(p)
      for (const c of (item.children as Record<string, unknown>[] | undefined) ?? []) collectLines(c, lines)
    }
    return
  }
  if (type === 'image') {
    if (lines.length && lines[lines.length - 1] !== '') lines.push('')
    lines.push('[图片]')
    return
  }
  // 其他（link 等）：递归取文本
  for (const c of childNodes) collectLines(c, lines)
}

/** Lexical EditorState JSON → 纯文本（搜索/摘要/分享；图片输出占位） */
export function lexicalJsonToText(content: string): string {
  try {
    const parsed = JSON.parse(content) as { root?: { children?: Record<string, unknown>[] } }
    const lines: string[] = ['']
    for (const c of parsed.root?.children ?? []) collectLines(c, lines)
    return lines
      .map((l) => l.trimEnd())
      .join('\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  } catch {
    return ''
  }
}

/** 智能复制：裁剪选中文字首尾的空格/制表符/空白行 */
export function trimCopyText(text: string): string {
  return text.replace(/^[\s\u00A0\t]+/, '').replace(/[\s\u00A0\t]+$/, '')
}

/**
 * 笔记默认标题：正文开头的一小段内容（首个非空行，超 20 字截断）。
 * 兼容 Lexical JSON 与旧版纯文本/Markdown 内容；空内容返回 ''。
 * 所有"创建笔记"路径（编辑器保存 / 闪念收入笔记）统一走此函数，保证无标题时行为一致。
 */
export function noteTitleFromContent(content: string): string {
  if (!content) return ''
  const text = content.trim().startsWith('{')
    ? lexicalJsonToText(content)   // Lexical EditorState JSON
    : content                      // 旧版纯文本 / Markdown / 块 JSON
  const line = text.split('\n').find((l) => l.trim()) ?? ''
  const t = line.trim()
  return t.length > 20 ? t.slice(0, 20) : t
}
