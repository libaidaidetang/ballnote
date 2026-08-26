// 书籍目录树（镜像）：
// books/
//   <书名>/            （名称命名，冲突追加序号，改名随全量重建自动更新）
//     book.json        （书籍基本信息；cover = 本地封面文件名，coverFallback = 原始引用）
//     cover-<id>.png|jpg
//     chapters/
//       <章节名>/
//         chapter.json （{ name }）
//         <笔记标题>.json  （内容 = 原 Note 对象）
// books.json 仍为应用内部数据源；每次保存书籍后全量重建此目录树（临时目录 + 原子替换）。
// 封面文件按 bookId 命名以便重建时复用旧文件（避免每次保存都重新下载 http 封面）。

import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import type { BookStore, FolderStoreData, Note } from '../shared/models'
import { zipDirectory } from './zip'

export function booksDir(): string {
  return path.join(app.getPath('userData'), 'books')
}

/** 清洗为合法文件名/目录名：去非法字符与控制字符、首尾空格点，截断 80 字符 */
export function cleanName(name: string, fallback = '未命名'): string {
  let s = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .trim()
  if (!s) s = fallback
  if (s.length > 80) s = s.slice(0, 80)
  return s
}

/** 冲突追加序号：used 已有 → name(2)、name(3)… */
function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) { used.add(base); return base }
  let i = 2
  while (used.has(`${base}(${i})`)) i++
  const name = `${base}(${i})`
  used.add(name)
  return name
}

/** 封面源 → { ext, buf }（dataURL / http 下载 / userData 相对路径；失败 null） */
async function resolveCover(cover: string | null): Promise<{ ext: string; buf: Buffer } | null> {
  if (!cover) return null
  try {
    if (cover.startsWith('data:')) {
      const m = /^data:image\/(png|jpe?g|jpg);base64,(.+)$/.exec(cover)
      if (!m) return null
      return { ext: m[1] === 'png' ? 'png' : 'jpg', buf: Buffer.from(m[2], 'base64') }
    }
    if (/^https?:/i.test(cover)) {
      const resp = await fetch(cover, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Mozilla/5.0' } })
      if (!resp.ok) return null
      const buf = Buffer.from(await resp.arrayBuffer())
      const ct = resp.headers.get('content-type') ?? ''
      const ext = ct.includes('png') ? 'png' : (ct.includes('jpeg') || ct.includes('jpg')) ? 'jpg' : 'png'
      return { ext, buf }
    }
    const p = path.join(app.getPath('userData'), cover)   // 本地相对路径（如 covers/xxx.png）
    if (!fs.existsSync(p)) return null
    const buf = fs.readFileSync(p)
    const e = path.extname(p).toLowerCase()
    return { ext: e === '.jpg' || e === '.jpeg' ? 'jpg' : 'png', buf }
  } catch {
    return null
  }
}

/** 章节集合：自建章节 + 笔记派生章节（空章节归"未分类"），
 *  按最早笔记时间排序、空章节排最后（与界面章节树顺序一致，用于"第N章"编号） */
function chaptersOf(book: { chapters?: string[]; notes: Note[] }): string[] {
  const set = new Set<string>()
  for (const c of book.chapters ?? []) set.add(c || '未分类')
  for (const n of book.notes) set.add(n.chapter || '未分类')
  const earliest = (c: string) => {
    const times = book.notes.filter((n) => (n.chapter || '未分类') === c).map((n) => n.createdAt)
    return times.length ? times.sort()[0] : '9999-99-99'
  }
  return [...set].sort((a, b) => earliest(a).localeCompare(earliest(b)))
}

/** 去除章节名开头的"第…章"前缀（避免目录名变成"第1章 第一章"）；去除后为空则保留原名 */
function stripChapterPrefix(name: string): string {
  const stripped = String(name ?? '').replace(/^\s*第\s*\S*?\s*章\s*/u, '').trim()
  return stripped || name || '未分类'
}

/** YAML 字符串值：含特殊字符时用 JSON 双引号包裹 */
function yamlStr(s: string): string {
  const str = String(s ?? '')
  return /[:#\[\]{}&*!|>'"%@`,]|^\s|\s$/.test(str) ? JSON.stringify(str) : str
}

/** 递归收集文本（主进程版，无 DOM 依赖） */
function collectTextMain(n: Record<string, unknown>): string {
  if (n.type === 'text') return String(n.text ?? '')
  let out = ''
  for (const c of (n.children as Record<string, unknown>[] | undefined) ?? []) out += collectTextMain(c)
  return out
}

/**
 * Lexical JSON → Markdown（主进程版）：代码块围栏、列表前缀、待办、引用、标题；
 * 图片经 imgRef 回调生成引用（dataURL 图片由调用方提取为文件）。
 */
function lexToMd(content: string, imgRef: (src: string) => string): string {
  try {
    const parsed = JSON.parse(content) as { root?: { children?: Record<string, unknown>[] } }
    const out: string[] = []
    let prevList = false
    for (const c of parsed.root?.children ?? []) {
      const type = c.type as string
      const text = collectTextMain(c)
      let isList = false
      if (type === 'code') {
        const lang = String(c.language ?? '').trim()
        out.push('```' + lang, text, '```')
      } else if (type === 'heading') {
        const tag = String(c.tag ?? 'H1').toUpperCase()
        out.push(`${'#'.repeat(tag === 'H1' ? 1 : tag === 'H2' ? 2 : 3)} ${text}`.trimEnd())
      } else if (type === 'list') {
        const lt = String(c.listType ?? 'bullet')
        for (const li of (c.children as Record<string, unknown>[] | undefined) ?? []) {
          const t = collectTextMain(li)
          out.push(lt === 'bullet' ? `- ${t}`.trimEnd()
            : lt === 'check' ? `- ${li.checked === true ? '[x]' : '[ ]'} ${t}`.trimEnd()
              : `1. ${t}`.trimEnd())
        }
        isList = true
      } else if (type === 'quote') {
        out.push(`> ${text}`.trimEnd())
      } else if (type === 'image') {
        out.push(imgRef(String(c.src ?? '')))
      } else {
        out.push(text.trimEnd())
      }
      if (isList && prevList) out.push('')
      prevList = isList
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  } catch {
    return String(content ?? '').trim()   // 旧格式（纯文本/块 JSON）：原样输出
  }
}

/** dataURL 图片落盘到 userData/note-images/，返回相对路径（失败 null） */
function saveNoteImage(dataUrl: string): string | null {
  try {
    const m = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
    if (!m) return null
    const dir = path.join(app.getPath('userData'), 'note-images')
    fs.mkdirSync(dir, { recursive: true })
    const ext = m[1] === 'png' ? 'png' : 'jpg'
    const name = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`
    fs.writeFileSync(path.join(dir, name), Buffer.from(m[2], 'base64'))
    return `note-images/${name}`
  } catch {
    return null
  }
}

/**
 * 笔记 → Markdown 文件（YAML frontmatter 元数据 + 正文）及其附属图片文件。
 * - 正文已是 Markdown：直接使用；图片（note-images/ 引用或 dataURL）复制/解码到笔记同目录（文件名带笔记 id）。
 * - 正文仍是旧 Lexical JSON：经 lexToMd 转换并提取 dataURL 图片。
 */
function noteToMarkdownFiles(n: Note): { md: string; files: { name: string; data: Buffer }[] } {
  const files: { name: string; data: Buffer }[] = []
  let imgNo = 0
  const copyImg = (src: string): string => {
    if (src.startsWith('data:')) {
      const m = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=]+)$/.exec(src)
      if (m) {
        imgNo++
        const ext = m[1] === 'png' ? 'png' : 'jpg'
        files.push({ name: `n${n.id}_img${imgNo}.${ext}`, data: Buffer.from(m[2], 'base64') })
        return `n${n.id}_img${imgNo}.${ext}`
      }
      return ''
    }
    if (src.startsWith('note-images/')) {
      const root = app.getPath('userData')
      const p = path.resolve(root, src)
      // 防穿越：拒绝离开 note-images/ 的路径（如 note-images/../../config/ai.json），防密钥等文件被打进分享包
      const imgRoot = path.join(root, 'note-images')
      if (path.relative(imgRoot, p).startsWith('..') || path.isAbsolute(path.relative(imgRoot, p))) return ''
      if (fs.existsSync(p)) {
        imgNo++
        const ext = path.extname(p).toLowerCase().replace('.', '') || 'png'
        files.push({ name: `n${n.id}_img${imgNo}.${ext}`, data: fs.readFileSync(p) })
        return `n${n.id}_img${imgNo}.${ext}`
      }
      return ''
    }
    return src   // http(s)：保留原 URL
  }

  let md: string
  if (String(n.content ?? '').trim().startsWith('{')) {
    // 旧 Lexical JSON（未迁移）
    md = lexToMd(n.content, (src) => {
      const f = copyImg(src)
      return f ? `![图片](${f})` : '[图片]'
    })
  } else {
    // 已是 Markdown：提取图片引用为同目录文件
    md = String(n.content ?? '').replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt: string, src: string) => {
      const f = copyImg(src)
      return f ? `![${alt || '图片'}](${f})` : m
    })
  }

  const fm = [
    '---',
    `id: ${n.id}`,
    `title: ${yamlStr(n.title)}`,
    `chapter: ${yamlStr(n.chapter)}`,
    `tags: [${n.tags.map((t) => yamlStr(t)).join(', ')}]`,
    `createdAt: "${n.createdAt}"`,
    '---',
    '',
  ].join('\n')
  return { md: fm + md + (md ? '\n' : ''), files }
}

/**
 * 迁移笔记事实源（启动时执行）：旧 Lexical JSON → Markdown + dataURL 图片落盘为 note-images 文件。
 * 返回是否发生变更（变更后由调用方保存 books.json 并重建目录树）。
 */
export async function migrateBookStore(books: BookStore): Promise<boolean> {
  let changed = false
  for (const b of books.books) {
    for (const n of b.notes) {
      const t = String(n.content ?? '').trim()
      if (t.startsWith('{')) {
        // Lexical JSON：dataURL 图片落盘 → 转 md
        try {
          const parsed = JSON.parse(n.content) as { root?: { children?: Record<string, unknown>[] } }
          const walk = (nodes: Record<string, unknown>[] | undefined) => {
            for (const node of nodes ?? []) {
              if (node.type === 'image' && typeof node.src === 'string' && node.src.startsWith('data:')) {
                const rel = saveNoteImage(node.src)
                if (rel) node.src = rel
              }
              walk(node.children as Record<string, unknown>[] | undefined)
            }
          }
          walk(parsed.root?.children)
          n.content = lexToMd(JSON.stringify(parsed), (src) => (src ? `![图片](${src})` : '[图片]'))
          changed = true
        } catch { /* 解析失败：跳过 */ }
      } else if (t.startsWith('[')) {
        // 旧块数组 JSON（WPF/块编辑器时代）：转 Markdown（图片 dataURL 一并落盘）
        try {
          const blocks = JSON.parse(n.content) as { type?: string; text?: string; src?: string; checked?: boolean }[]
          const lines: string[] = []
          for (const b of blocks) {
            if (b.type === 'image') {
              let src = b.src ?? ''
              if (src.startsWith('data:')) src = saveNoteImage(src) ?? src
              lines.push(src ? `![图片](${src})` : '')
              continue
            }
            const prefix = b.type === 'h1' ? '# ' : b.type === 'h2' ? '## ' : b.type === 'h3' ? '### '
              : b.type === 'bullet' ? '- ' : b.type === 'ordered' ? '1. ' : b.type === 'todo' ? `- ${b.checked ? '[x]' : '[ ]'} ` : b.type === 'quote' ? '> ' : ''
            lines.push(prefix + (b.text ?? ''))
          }
          n.content = lines.join('\n')
          changed = true
        } catch { /* 解析失败：跳过 */ }
      } else if (/data:image\/(png|jpe?g);base64,[A-Za-z0-9+/=]+/.test(t)) {
        // Markdown 但含 dataURL 图片：落盘并替换
        n.content = t.replace(/!\[([^\]]*)\]\((data:image\/(?:png|jpe?g);base64,[A-Za-z0-9+/=]+)\)/g, (_m, alt: string, dataUrl: string) => {
          const rel = saveNoteImage(dataUrl)
          return rel ? `![${alt || '图片'}](${rel})` : _m
        })
        changed = true
      }
    }
  }
  return changed
}

/**
 * 全量重建目录树：写临时目录 → 删除旧树 → 原子替换。
 * 封面按 bookId 复用旧文件（存在则直接复制，避免重复下载 http 封面）。
 */
export async function syncBookTree(books: BookStore, folders?: FolderStoreData): Promise<void> {
  const root = booksDir()
  const tmp = `${root}.tmp`
  fs.rmSync(tmp, { recursive: true, force: true })
  fs.mkdirSync(tmp, { recursive: true })

  // 旧树封面索引：cover-<id>.* → 文件路径
  const oldCovers = new Map<number, string>()
  if (fs.existsSync(root)) {
    const walk = (d: string) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name)
        if (ent.isDirectory()) walk(p)
        else {
          const m = /^cover-(\d+)\.(png|jpg)$/.exec(ent.name)
          if (m) oldCovers.set(Number(m[1]), p)
        }
      }
    }
    walk(root)
  }

  const usedBookDirs = new Set<string>()
  for (const book of books.books) {
    const bdir = path.join(tmp, uniqueName(cleanName(book.title), usedBookDirs))
    fs.mkdirSync(path.join(bdir, 'chapters'), { recursive: true })

    // ---- 封面：复用旧文件，否则从数据源落盘 ----
    let coverFile: string | null = null
    const old = oldCovers.get(book.id)
    if (old && fs.existsSync(old)) {
      coverFile = path.basename(old)
      fs.copyFileSync(old, path.join(bdir, coverFile))
    } else {
      const img = await resolveCover(book.cover ?? null)
      if (img) {
        coverFile = `cover-${book.id}.${img.ext}`
        fs.writeFileSync(path.join(bdir, coverFile), img.buf)
      }
    }

    fs.writeFileSync(path.join(bdir, 'book.json'), JSON.stringify({
      id: book.id,
      title: book.title,
      author: book.author,
      publisher: book.publisher ?? '',
      edition: book.edition ?? '',
      description: book.description,
      coverColor: book.coverColor,
      cover: coverFile,
      coverFallback: book.cover ?? null,   // 原始引用（本地相对路径 / URL），封面落盘失败时渲染层可回退
      tags: book.tags,
      createdAt: book.createdAt,
      chapters: book.chapters ?? [],
    }, null, 2), 'utf-8')

    // ---- 章节文件夹（目录名 = "第N章 章节名"，N 按界面排序；笔记存 Markdown） ----
    const usedChDirs = new Set<string>()
    chaptersOf(book).forEach((ch, idx) => {
      const base = `第${idx + 1}章 ${stripChapterPrefix(ch)}`
      const chDir = path.join(bdir, 'chapters', uniqueName(cleanName(base, '未分类'), usedChDirs))
      fs.mkdirSync(chDir, { recursive: true })
      fs.writeFileSync(path.join(chDir, 'chapter.json'), JSON.stringify({ name: ch }, null, 2), 'utf-8')
      const notes = book.notes.filter((n) => (n.chapter || '未分类') === ch)
      const usedNoteNames = new Set<string>()
      for (const n of notes) {
        const { md, files } = noteToMarkdownFiles(n)
        const mdName = uniqueName(cleanName(n.title, '未命名笔记') + '.md', usedNoteNames)
        fs.writeFileSync(path.join(chDir, mdName), md, 'utf-8')
        for (const f of files) {
          fs.writeFileSync(path.join(chDir, f.name), f.data)
        }
      }
    })
  }

  // 书籍文件夹信息（与书目录同级；zipDirectory 打包书目录时不含此文件）
  fs.writeFileSync(path.join(tmp, 'folders.json'), JSON.stringify(folders?.folders ?? [], null, 2), 'utf-8')

  fs.rmSync(root, { recursive: true, force: true })
  // 先把旧树改名让位再换入新树：Windows 上 rm 后 rename 可能因目录被占用（资源管理器/杀软扫描）失败，
  // 直接 rename 会抛错且旧树已删 → 整棵镜像消失。bak 方案保证失败时旧树仍在。
  const bak = `${root}.bak-${Date.now()}`
  let renamedOld = false
  try {
    if (fs.existsSync(root)) {
      fs.renameSync(root, bak)
      renamedOld = true
    }
    fs.renameSync(tmp, root)
  } catch (err) {
    // 换入失败：尽力回滚旧树，保持镜像可用（哪怕内容稍旧）
    if (renamedOld && !fs.existsSync(root)) {
      try { fs.renameSync(bak, root) } catch { /* 回滚也失败时保留 bak 目录供人工恢复 */ }
    }
    throw err
  } finally {
    if (renamedOld && fs.existsSync(root)) {
      try { fs.rmSync(bak, { recursive: true, force: true }) } catch { /* 清理失败不影响本次同步结果 */ }
    }
  }
}

/** 在目录树中按书籍 id 查找书目录（读 book.json 匹配） */
export function findBookDir(bookId: number): string | null {
  const root = booksDir()
  if (!fs.existsSync(root)) return null
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue
    const p = path.join(root, ent.name)
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(p, 'book.json'), 'utf-8')) as { id?: number }
      if (meta.id === bookId) return p
    } catch { /* 非书目录，跳过 */ }
  }
  return null
}

/** 探测 WinRAR/RAR 命令行路径 */
function findRarExe(): string | null {
  const candidates = [
    'C:\\Program Files\\WinRAR\\Rar.exe',
    'C:\\Program Files (x86)\\WinRAR\\Rar.exe',
    'C:\\Program Files\\WinRAR\\WinRAR.exe',
    'C:\\Program Files (x86)\\WinRAR\\WinRAR.exe',
    'C:\\Program Files\\WinRAR\\UnRAR.exe',
  ]
  for (const c of candidates) if (fs.existsSync(c)) return c
  return null
}

/** 压缩包说明.txt 内容：解释压缩包内各文件/文件夹的作用 */
function buildReadme(title: string): string {
  return [
    '========================================',
    '  BallWork 书籍导出说明',
    '========================================',
    '',
    `本压缩包为《${title}》的完整导出，目录结构如下：`,
    '',
    'book.json',
    '  书籍基本信息：id、名称、作者、出版社、版本、简介、封面颜色、',
    '  封面文件引用、标签、创建时间、章节列表。',
    '',
    'cover-<id>.jpg / cover-<id>.png',
    '  书籍封面图片（已下载到本地）。',
    '',
    'chapters/',
    '  本书所有章节，每章一个文件夹（文件夹名 = 第N章 + 章节名）。',
    '',
    'chapters/<章节文件夹>/chapter.json',
    '  该章节的信息：章节名称。',
    '',
    'chapters/<章节文件夹>/<笔记标题>.md',
    '  该章节下的笔记（Markdown 格式）。',
    '  文件头部的 --- 区域为元数据（笔记 id、标题、所属章节、标签、创建时间），',
    '  下方为笔记正文；笔记中的图片以同目录 n<id>_img*.png/jpg 文件保存，',
    '  并在正文中通过相对路径引用。可用任意支持 Markdown 的编辑器',
    '  （Typora / VS Code / Obsidian 等）直接打开阅读。',
    '',
    '说明.txt',
    '  本文件（即当前说明）。',
    '',
    '注：书籍数据以应用内为准，本压缩包为可读的导出快照。',
    '',
  ].join('\n')
}

/** 归档目录为 ZIP / RAR 到 targetPath（RAR 依赖 WinRAR；未安装自动回退 ZIP） */
async function archiveDir(
  dir: string,
  targetPath: string,
  format: 'zip' | 'rar',
): Promise<{ ok: boolean; path?: string; rarMissing?: boolean; usedRar?: boolean; error?: string }> {
  try {
    if (format === 'rar') {
      const rarExe = findRarExe()
      if (!rarExe) {
        const zipPath = targetPath.replace(/\.rar$/i, '.zip')
        fs.writeFileSync(zipPath, zipDirectory(dir))
        return { ok: true, path: zipPath, rarMissing: true, usedRar: false }
      }
      await new Promise<void>((resolve, reject) => {
        execFile(rarExe, ['a', '-r', '-ep1', '-y', targetPath, `${dir}${path.sep}*`], { timeout: 60000 }, (err) => {
          if (err) reject(err)
          else resolve()
        })
      })
      return { ok: true, path: targetPath, usedRar: true }
    }
    fs.writeFileSync(targetPath, zipDirectory(dir))
    return { ok: true, path: targetPath, usedRar: false }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 打包某本书的目录为 ZIP / RAR 到 targetPath。
 * 打包前复制到临时副本并写入「说明.txt」（不污染真实目录树）。
 */
export async function packBook(
  bookId: number,
  targetPath: string,
  format: 'zip' | 'rar',
): Promise<{ ok: boolean; path?: string; rarMissing?: boolean; usedRar?: boolean; error?: string }> {
  const bdir = findBookDir(bookId)
  if (!bdir) return { ok: false, error: '书籍目录不存在（可能尚未同步）' }
  const tmpCopy = path.join(app.getPath('temp'), `ballwork-pack-${bookId}-${Date.now()}`)
  try {
    fs.cpSync(bdir, tmpCopy, { recursive: true })
    let title = '书籍'
    try { title = (JSON.parse(fs.readFileSync(path.join(bdir, 'book.json'), 'utf-8')) as { title?: string }).title ?? '书籍' } catch { /* 忽略 */ }
    fs.writeFileSync(path.join(tmpCopy, '说明.txt'), buildReadme(title), 'utf-8')
    return await archiveDir(tmpCopy, targetPath, format)
  } finally {
    fs.rmSync(tmpCopy, { recursive: true, force: true })
  }
}

/**
 * 多本打包：勾选的书聚合为一个压缩包（第一级 = 各书文件夹，重名自动加序号），
 * 根目录写「说明.txt」；RAR 未安装自动回退 ZIP。
 */
export async function packBooks(
  bookIds: number[],
  targetPath: string,
  format: 'zip' | 'rar',
): Promise<{ ok: boolean; path?: string; rarMissing?: boolean; usedRar?: boolean; error?: string }> {
  const tmpDir = path.join(app.getPath('temp'), `ballwork-pack-multi-${Date.now()}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  try {
    const used = new Set<string>()
    const names: string[] = []
    for (const id of bookIds) {
      const bdir = findBookDir(id)
      if (!bdir) continue
      const dirName = uniqueName(path.basename(bdir), used)
      fs.cpSync(bdir, path.join(tmpDir, dirName), { recursive: true })
      names.push(dirName)
    }
    if (names.length === 0) return { ok: false, error: '未找到可导出的书籍（目录树可能尚未同步）' }
    fs.writeFileSync(path.join(tmpDir, '说明.txt'), [
      '========================================',
      '  BallWork 多本导出说明',
      '========================================',
      '',
      `本压缩包包含 ${names.length} 本书：`,
      ...names.map((n) => `  - ${n}`),
      '',
      '每本书为一个文件夹，内部结构（book.json / cover-*.jpg / chapters/ 等）',
      '与单本导出一致，详见各书目录内说明。',
      '',
    ].join('\n'), 'utf-8')
    return await archiveDir(tmpDir, targetPath, format)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}
