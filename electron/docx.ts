// 最小 .docx 生成（无第三方依赖）：OOXML + ZIP（复用 electron/zip.ts 的 store 打包）。
// 支持：文本行段落、待办行（☐/☑）、内嵌图片（dataURL 直接解码 / http(s) 下载后嵌入）。
// Word/WPS 可直接打开。

import type { NoteExportLinePayload } from '../shared/models'
import { zipFiles } from './zip'

function xmlEsc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ===== 图片尺寸解析（PNG/JPEG，仅头部，无需解码） =====
function pngSize(buf: Buffer): { w: number; h: number } {
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

function jpegSize(buf: Buffer): { w: number; h: number } | null {
  let i = 2
  while (i < buf.length - 8) {
    if (buf[i] !== 0xff) { i++; continue }
    const marker = buf[i + 1]
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue }
    if (marker === 0xda) break
    const len = (buf[i + 2] << 8) | buf[i + 3]
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return { w: (buf[i + 7] << 8) | buf[i + 8], h: (buf[i + 5] << 8) | buf[i + 6] }
    }
    i += 2 + len
  }
  return null
}

/** 图片源 → { buf, ext, w, h }（dataURL 直接解码；http(s) 下载；失败返回 null） */
async function resolveImage(src: string): Promise<{ buf: Buffer; ext: string; w: number; h: number } | null> {
  try {
    let buf: Buffer
    let ext: string
    if (src.startsWith('data:')) {
      const m = /^data:image\/(png|jpeg|jpg);base64,([A-Za-z0-9+/=]+)$/.exec(src)
      if (!m) return null
      ext = m[1] === 'jpeg' || m[1] === 'jpg' ? 'jpg' : 'png'
      buf = Buffer.from(m[2], 'base64')
    } else if (/^https?:/i.test(src)) {
      const resp = await fetch(src, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'Mozilla/5.0' } })
      if (!resp.ok) return null
      const raw = Buffer.from(await resp.arrayBuffer())
      const ct = resp.headers.get('content-type') ?? ''
      if (ct.includes('png')) ext = 'png'
      else if (ct.includes('jpeg') || ct.includes('jpg')) ext = 'jpg'
      else {
        const m = /\.(png|jpe?g)$/i.exec(src)
        ext = m ? (m[1] === 'jpeg' || m[1] === 'jpg' ? 'jpg' : 'png') : 'png'
      }
      buf = raw
    } else {
      return null
    }
    if (buf.length < 24) return null
    let size: { w: number; h: number } | null = null
    if (ext === 'png' && buf.readUInt32BE(0) === 0x89504e47) size = pngSize(buf)
    else if (ext === 'jpg') size = jpegSize(buf)
    if (!size || size.w <= 0 || size.h <= 0) size = { w: 480, h: 640 }
    return { buf, ext, w: size.w, h: size.h }
  } catch {
    return null
  }
}

/** 待办行 → Word 段落（☐/☑ + 文本；用 Unicode 方块字符，Word 原生显示为方框） */
function taskParagraph(checked: boolean, text: string): string {
  return `<w:p><w:r><w:t xml:space="preserve">${checked ? '\u2611' : '\u2610'} ${xmlEsc(text)}</w:t></w:r></w:p>`
}

/**
 * 结构化行 → .docx Buffer。
 * 每行：text 段落 / checked 待办（☐☑）/ image 内嵌图片（dataURL 或 http，宽 480px 等比缩放）。
 * http(s) 图片下载失败或图片无法解码时，该行输出「[图片]」占位文本。
 */
export async function buildDocx(lines: NoteExportLinePayload[]): Promise<Buffer> {
  const media: { name: string; data: Buffer }[] = []
  const paragraphs: string[] = []
  let imgIdx = 0

  for (const line of lines) {
    if (line.image) {
      const img = await resolveImage(line.image)
      if (!img) { paragraphs.push('<w:p><w:r><w:t>[图片]</w:t></w:r></w:p>'); continue }
      imgIdx++
      const name = `word/media/image${imgIdx}.${img.ext}`
      media.push({ name, data: img.buf })
      const rId = `rIdImg${imgIdx}`
      const EMU = 9525
      const W = 480 * EMU
      const H = Math.round(W * (img.h / img.w))
      paragraphs.push(
        '<w:p><w:r>' +
        `<w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0">` +
        `<wp:extent cx="${W}" cy="${H}"/><wp:docPr id="${imgIdx}" name="图片${imgIdx}"/>` +
        `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
        `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
        `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
        `<pic:nvPicPr><pic:cNvPr id="${imgIdx}" name="图片${imgIdx}"/><pic:cNvPicPr/></pic:nvPicPr>` +
        `<pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
        `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${W}" cy="${H}"/></a:xfrm>` +
        `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>` +
        '</wp:inline></w:drawing></w:r></w:p>',
      )
      continue
    }
    if (line.checked != null) {
      paragraphs.push(taskParagraph(line.checked, line.text))
      continue
    }
    const t = xmlEsc(line.text ?? '')
    paragraphs.push(t ? `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>` : '<w:p/>')
  }

  const relsItems = media.map((m, i) =>
    `<Relationship Id="rIdImg${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.name.split('/').pop()}"/>`,
  ).join('')

  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<w:body>' + paragraphs.join('') +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>' +
    '</w:body></w:document>'

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/>' +
    '<Default Extension="jpg" ContentType="image/jpeg"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>'

  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    relsItems +
    '</Relationships>'

  const documentRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    media.map((m, i) =>
      `<Relationship Id="rIdImg${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.name.split('/').pop()}"/>`,
    ).join('') +
    '</Relationships>'

  return zipFiles([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf-8') },
    { name: '_rels/.rels', data: Buffer.from(rels, 'utf-8') },
    { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf-8') },
    { name: 'word/_rels/document.xml.rels', data: Buffer.from(documentRels, 'utf-8') },
    ...media.map((m) => ({ name: m.name, data: m.data })),
  ])
}
