// 笔记导出工具（渲染层）：
// - lexicalJsonToMarkdown：Lexical EditorState JSON → Markdown 文本（委托 mdLexical 的唯一实现，
//   此前与 mdLexical 各有一套转换导致行为漂移：闪念存 HTML checkbox 而笔记存 [x]，勾选状态在"收入笔记"时丢失）
// - lexicalJsonToHtml：Lexical EditorState JSON → HTML（导出图片时用于渲染）
// - noteToPngDataUrl：将笔记内容渲染为 PNG（SVG foreignObject → Canvas），返回 dataURL
// - exportNoteFile / shareNoteFile：与主进程 IPC 协作完成导出/系统共享
// 内容为空时各转换函数返回 ''（调用方提示）。
// 注意：笔记事实源为 Markdown（或旧 Lexical JSON），所有导出前先 contentToLexicalJson 归一化。

import { contentToLexicalJson, lexicalToMd } from './mdLexical'
import { esc } from './mdLexical'

type JNode = Record<string, unknown>
type JChildren = JNode[] | undefined

function childrenOf(n: JNode): JChildren {
  return Array.isArray(n.children) ? (n.children as JNode[]) : undefined
}

/** 收集块内全部文本（含列表项前缀），返回行数组（对齐 lexicalJsonToText 的行语义） */
function collectText(n: JNode): string {
  const type = n.type as string
  if (type === 'text') return String(n.text ?? '')
  let out = ''
  for (const c of childrenOf(n) ?? []) out += collectText(c)
  return out
}

/** 行内文本 → Markdown 已迁移至 mdLexical（inlineTextMd 为其内部实现） */

/** 文本节点 → 内联 HTML（按 format 位：1 加粗 / 2 斜体 / 4 删除线 / 8 行内代码） */
function textToHtml(n: JNode): string {
  const text = esc(String(n.text ?? ''))
  const fmt = Number(n.format ?? 0)
  let h = text
  if (fmt & 8) h = `<code>${h}</code>`
  if (fmt & 4) h = `<s>${h}</s>`
  if (fmt & 2) h = `<em>${h}</em>`
  if (fmt & 1) h = `<strong>${h}</strong>`
  return h
}

function blockHtml(n: JNode): string {
  const type = n.type as string
  const kids = childrenOf(n) ?? []
  if (type === 'code') {
    return `<pre><code>${esc(collectText(n))}</code></pre>`
  }
  if (type === 'heading') {
    const tag = String(n.tag ?? 'H1').toUpperCase()
    const lv = tag === 'H1' ? 1 : tag === 'H2' ? 2 : 3
    const inner = kids.map((c) => (c.type === 'text' ? textToHtml(c) : collectText(c))).join('')
    return `<h${lv}>${inner}</h${lv}>`
  }
  if (type === 'list') {
    const listType = String(n.listType ?? 'bullet')
    const tag = listType === 'number' ? 'ol' : 'ul'
    const items = kids.map((li) => {
      const inner = (childrenOf(li) ?? []).map((c) => (c.type === 'text' ? textToHtml(c) : blockHtml(c))).join('')
      return `<li>${inner}</li>`
    }).join('')
    return `<${tag}>${items}</${tag}>`
  }
  if (type === 'quote') {
    const inner = kids.map((c) => (c.type === 'text' ? textToHtml(c) : collectText(c))).join('')
    return `<blockquote>${inner}</blockquote>`
  }
  if (type === 'image') {
    const src = esc(String(n.src ?? ''))
    return src ? `<img src="${src}" alt="" style="max-width:80%;border-radius:8px;margin:6px 0"/>` : ''
  }
  const inner = kids.map((c) => (c.type === 'text' ? textToHtml(c) : collectText(c))).join('')
  return `<p>${inner}</p>`
}

/** 导出用结构化行：text 文本 / image 图片源（dataURL 或 http）/ checked 待办勾选状态 */
export interface NoteExportLine {
  text?: string
  image?: string
  checked?: boolean
}

/** 顶层块 → 行结构（图片块独立成行；待办列表项带 checked；无序/有序列表项带前缀） */
export function lexicalJsonToLines(content: string): NoteExportLine[] {
  try {
    const parsed = JSON.parse(content) as { root?: { children?: JNode[] } }
    const out: NoteExportLine[] = []
    for (const c of parsed.root?.children ?? []) {
      const type = c.type as string
      if (type === 'image') { out.push({ image: String(c.src ?? '') }); continue }
      if (type === 'list') {
        const listType = String(c.listType ?? 'bullet')
        for (const li of childrenOf(c) ?? []) {
          const text = collectText(li)
          if (listType === 'check') {
            out.push({ text, checked: li.checked === true })
          } else {
            out.push({ text: (listType === 'bullet' ? '• ' : '1. ') + text })
          }
        }
        continue
      }
      out.push({ text: collectText(c) })
    }
    return out
  } catch {
    return []
  }
}

/** Lexical EditorState JSON → Markdown 文本（唯一实现见 mdLexical.lexicalToMd） */
export function lexicalJsonToMarkdown(content: string): string {
  return lexicalToMd(content)
}

/** Lexical EditorState JSON → HTML（含内联基础样式，供导出图片渲染） */
export function lexicalJsonToHtml(content: string): string {
  try {
    const parsed = JSON.parse(content) as { root?: { children?: JNode[] } }
    return (parsed.root?.children ?? []).map(blockHtml).join('\n')
  } catch {
    return ''
  }
}

const EXPORT_CSS = `body{margin:0}*{box-sizing:border-box}h1{font-size:22px;font-weight:700;margin:0 0 8px}h2{font-size:18px;font-weight:600;margin:0 0 6px}h3{font-size:15px;font-weight:500;margin:0 0 4px}p{margin:0 0 6px}blockquote{margin:4px 0;padding-left:12px;border-left:3px solid #cbd5e1;color:#64748b;font-style:italic}ul,ol{margin:2px 0;padding-left:24px}li{margin:2px 0}input[type=checkbox]{margin-right:6px;accent-color:#3b82f6}code{background:#f1f5f9;border-radius:4px;padding:1px 4px;font-size:12.5px;font-family:Consolas,Menlo,monospace}pre{background:#0f172a;color:#e2e8f0;border-radius:8px;padding:12px 14px;font-family:Consolas,Menlo,monospace;font-size:12.5px;line-height:1.6;overflow-x:auto;margin:6px 0;white-space:pre-wrap;word-break:break-all}pre code{background:none;padding:0;color:inherit;font-size:inherit}strong{font-weight:700}em{font-style:italic}s{text-decoration:line-through}`

/**
 * 笔记内容 → PNG dataURL。
 * 流程：测量内容高度 → SVG foreignObject 渲染（内联样式保证外观）→ Image → Canvas → toDataURL。
 * 注意：内容中的 http(s) 图片可能因跨域污染 canvas 导致失败（dataURL 图片无此问题）。
 */
export async function noteToPngDataUrl(content: string): Promise<string> {
  const html = lexicalJsonToHtml(content)
  if (!html.trim()) throw new Error('empty')
  const W = 780
  const PAD = 28
  const measure = document.createElement('div')
  measure.style.cssText = `position:fixed;left:-9999px;top:0;width:${W}px;padding:${PAD}px;background:#fff;color:#111827;font:14px/1.75 "Microsoft YaHei UI","PingFang SC",system-ui,sans-serif;white-space:normal;`
  measure.innerHTML = `<style>${EXPORT_CSS}</style>${html}`
  document.body.appendChild(measure)
  const H = Math.max(120, measure.scrollHeight)
  document.body.removeChild(measure)
  const wrapped = `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${W}px;padding:${PAD}px;background:#fff;color:#111827;font:14px/1.75 'Microsoft YaHei UI','PingFang SC',system-ui,sans-serif;white-space:normal;">` +
    `<style>${EXPORT_CSS}</style>${html}</div>`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W + PAD * 2}" height="${H}">` +
    `<foreignObject width="100%" height="100%">${wrapped}</foreignObject></svg>`
  const img = new Image()
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('render'))
    setTimeout(() => reject(new Error('timeout')), 8000)
  })
  const canvas = document.createElement('canvas')
  canvas.width = W + PAD * 2
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, 0, 0)
  return canvas.toDataURL('image/png')
}

/** dataURL → Blob（Web Share API 需要 File/Blob） */
export function dataUrlToBlob(dataUrl: string): Blob {
  const [head, b64] = dataUrl.split(',')
  const mime = /^data:(.*?);base64$/.exec(head)?.[1] ?? 'application/octet-stream'
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return new Blob([arr], { type: mime })
}

export type NoteExportKind = 'png' | 'txt' | 'docx' | 'md' | 'html'

/** 旧格式（非 Lexical JSON）兜底：按纯文本分行 */
function getEffectiveLines(json: string): NoteExportLine[] {
  const lines = lexicalJsonToLines(json)
  return lines.length > 0 || !json.trim().startsWith('{')
    ? lines
    : json.split('\n').map((l) => ({ text: l }))
}

/** 笔记 → 纯文本（图片行为占位） */
function linesToText(json: string): string {
  return getEffectiveLines(json).map((l) => l.image ? '[图片]' : (l.text ?? '')).join('\n')
}

/** 完整 HTML 文档（自包含内联样式，双击即可在浏览器打开） */
export function buildHtmlDocument(title: string, content: string): string {
  const body = lexicalJsonToHtml(content)
  return '<!DOCTYPE html>\n' +
    '<html lang="zh-CN">\n<head>\n<meta charset="utf-8"/>\n<meta name="viewport" content="width=device-width, initial-scale=1"/>\n' +
    `<title>${esc(title)}</title>\n` +
    `<style>${EXPORT_CSS}body{background:#f1f5f9;padding:24px}.note{max-width:820px;margin:0 auto;background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.08);padding:32px 40px}</style>\n` +
    '</head>\n<body>\n<div class="note">\n' + body + '\n</div>\n</body>\n</html>'
}

/**
 * 分享用 markdown：dataURL 图片替换为友好占位（分享给聊天/应用时避免整段 base64 巨串）；
 * http(s) 图片保留。
 */
function markdownForShare(json: string): string {
  return lexicalJsonToMarkdown(json)
    .replace(/!\[([^\]]*)\]\((data:image\/[^)\s]+)\)/g, (_m, alt: string) => `[图片已省略：${alt || '原笔记中的图片'}，如需完整内容请使用「导出」]`)
}

/** 笔记内容（Lexical JSON 或旧格式）→ 各格式导出所需的 IPC 请求体 */
async function buildExportRequest(
  note: { title: string; content: string },
  kind: NoteExportKind,
): Promise<{ title: string; format: NoteExportKind; text: string; markdown?: string; html?: string; pngDataUrl?: string; lines?: import('../../shared/models').NoteExportLinePayload[] }> {
  const json = contentToLexicalJson(note.content)
  const text = kind === 'png' ? '' : linesToText(json)
  const req: { title: string; format: NoteExportKind; text: string; markdown?: string; html?: string; pngDataUrl?: string; lines?: import('../../shared/models').NoteExportLinePayload[] } = {
    title: note.title, format: kind, text,
  }
  if (kind === 'md') req.markdown = lexicalJsonToMarkdown(json)
  if (kind === 'html') req.html = buildHtmlDocument(note.title, json)
  if (kind === 'png') req.pngDataUrl = await noteToPngDataUrl(json)
  if (kind === 'docx') req.lines = getEffectiveLines(json).map((l) => ({ text: l.text ?? '', image: l.image ?? null, checked: l.checked ?? null }))
  return req
}

/** 导出笔记（文件保存对话框，默认进系统"文档"文件夹，文件名 = 标题）。返回 { ok, path | canceled | error } */
export async function exportNoteFile(
  note: { title: string; content: string },
  kind: NoteExportKind,
): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> {
  const req = await buildExportRequest(note, kind)
  return window.api.note.exportFile(req)
}

/**
 * 分享笔记（按格式）：
 * - 文本类（txt / md / html）：走 Web Share API 文本分享（Electron Windows 支持，弹系统共享面板）；
 *   不可用时回退为"导出临时文件 + 资源管理器选中"。
 * - 文件类（png / docx）：Windows Web Share 不支持文件分享，直接回退"导出临时文件 + 资源管理器选中"。
 * 返回 { ok, error?, notice? }，notice 用于向用户说明共享方式。
 */
export async function shareNoteFile(
  note: { title: string; content: string },
  kind: NoteExportKind,
): Promise<{ ok: boolean; error?: string; notice?: string }> {
  const json = contentToLexicalJson(note.content)
  const safeTitle = note.title.replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名笔记'
  try {
    // ---- 文件类（png / docx）：Web Share 不支持 files，导出临时文件 + 资源管理器选中 ----
    if (kind === 'png' || kind === 'docx') {
      const pngDataUrl = kind === 'png' ? await noteToPngDataUrl(json) : undefined
      const lines = kind === 'docx' ? getEffectiveLines(json).map((l) => ({ text: l.text ?? '', image: l.image ?? null, checked: l.checked ?? null })) : undefined
      const res = await window.api.note.exportTemp({ title: safeTitle, format: kind, pngDataUrl, lines })
      if (res.ok && res.path) {
        await window.api.note.showInFolder(res.path)
        return { ok: true, notice: '系统共享不支持文件，已导出并在资源管理器中选中，可右键「共享」' }
      }
      return { ok: false, error: res.error ?? '分享失败' }
    }

    // ---- 文本类（txt / md / html）：Web Share 文本分享（Electron Windows 弹出系统共享面板） ----
    const text = kind === 'md' ? markdownForShare(json)
      : kind === 'html' ? buildHtmlDocument(note.title, json)
        : linesToText(json)
    if (navigator.share) {
      try {
        await navigator.share({ title: note.title, text })
        return { ok: true, notice: '已通过系统共享面板分享' }
      } catch (err) {
        if ((err as Error).name === 'AbortError') return { ok: true }   // 用户主动取消：不算失败
      }
    }
    // 回退：导出临时文件 + 资源管理器选中
    const res = await window.api.note.exportTemp({
      title: safeTitle, format: kind,
      text, markdown: kind === 'md' ? text : undefined, html: kind === 'html' ? text : undefined,
    })
    if (res.ok && res.path) {
      await window.api.note.showInFolder(res.path)
      return { ok: true, notice: '系统共享不可用，已导出并在资源管理器中选中，可右键「共享」' }
    }
    return { ok: false, error: res.error ?? '分享失败' }
  } catch (err) {
    console.error('[note] 分享失败', err)
    return { ok: false, error: '分享失败（内容可能含无法渲染的图片）' }
  }
}
