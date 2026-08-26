// 闪念预览（轻量静态渲染）：把内容转为纯文本行展示，不再为每张卡片实例化完整 Lexical 编辑器。
// 此前每条闪念都挂一个 RichTextEditor（Composer + 全套 plugin + 监听器），几十条闪念时内存与
// 重渲染开销大；预览场景只需只读文本，lexicalJsonToText 足够。

import { useMemo } from 'react'
import { lexicalJsonToText } from '../lib/lexical'

/** 只读闪念预览：Lexical JSON → 纯文本行；旧格式纯文本原样展示 */
export default function NotePreview({ content, className }: { content: string; className?: string }) {
  const text = useMemo(() => {
    const raw = String(content ?? '')
    if (!raw.trim()) return ''
    // Lexical JSON → 纯文本；否则按纯文本/Markdown 原样展示
    return raw.trim().startsWith('{') ? lexicalJsonToText(raw) : raw
  }, [content])
  return (
    <div className={`${className ?? ''} whitespace-pre-wrap break-words`}>
      {text}
    </div>
  )
}
