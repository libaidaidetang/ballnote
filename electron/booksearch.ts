import type { BookSearchResult } from '../shared/models'

/**
 * 微信读书搜索（主进程代理，免注册 JSON API）。
 * 返回 书名/作者/出版社/简介/封面/评分；过滤未出版网文噪声（无出版社的跳过）。
 */
const WEREAD_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 封面高清化：豆瓣 m→l（中图→大图）；微信读书 myqcloud s_→b_（小图→大图）。
 *  高清变体若 404，渲染层 BookCover 会自动回退原图，不会显示破图。 */
function hiResCover(url: string): string {
  if (!url) return url
  if (url.includes('doubanio.com')) return url.replace(/\/view\/([^/]+)\/m\/public\//, '/view/$1/l/public/')
  if (url.includes('wfqqreader-1252317822.image.myqcloud.com')) return url.replace(/\/s_([^/]+)$/, '/b_$1')
  return url
}

export async function searchWeread(keyword: string): Promise<BookSearchResult[]> {
  try {
    const resp = await fetch(
      `https://weread.qq.com/web/search/global?keyword=${encodeURIComponent(keyword)}&maxIdx=0&count=12`,
      {
        headers: { 'User-Agent': WEREAD_UA, Referer: 'https://weread.qq.com/' },
        signal: AbortSignal.timeout(12000),
      },
    )
    if (!resp.ok) return []
    const json = await resp.json() as {
      books?: {
        bookInfo?: {
          title?: string; author?: string; publisher?: string; intro?: string
          cover?: string; newRating?: number
        }
      }[]
    }
    const out: BookSearchResult[] = []
    for (const it of json.books ?? []) {
      const b = it.bookInfo
      if (!b?.title) continue
      if (!b.publisher || !b.publisher.trim()) continue   // 过滤未出版网文
      out.push({
        title: b.title.trim(),
        author: b.author ?? '',
        publisher: b.publisher?.trim() ?? '',
        description: b.intro ?? '',
        coverUrl: hiResCover(b.cover ?? ''),
      })
    }
    return out.slice(0, 12)
  } catch {
    return []
  }
}

/**
 * 豆瓣读书搜索（主进程代理：网页解析，尽力而为，对齐 WPF BookSearchService）。
 * 页面内嵌 window.__DATA__ JSON：items[] 每项含
 *   title 书名 / cover_url 封面 / abstract="作者 / 译者 / 出版社 / 出版年 / 价格" / abstract_2 简介。
 * 任何失败都返回空列表（UI 提示），不抛异常。
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

export async function searchDouban(keyword: string): Promise<BookSearchResult[]> {
  try {
    const resp = await fetch(
      `https://search.douban.com/book/subject_search?search_text=${encodeURIComponent(keyword)}`,
      { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000) },
    )
    if (!resp.ok) return []
    const html = await resp.text()
    const marker = 'window.__DATA__ = '
    const start = html.indexOf(marker)
    if (start < 0) return []
    const s = start + marker.length
    // JSON 字符串内部可能含 ';'（简介/更多字段）：从第一个 ';' 起逐个尝试解析，
    // 避免按第一个分号截断导致解析失败（表现为"不稳定/有时空结果"）
    let doc: unknown = null
    let pos = html.indexOf(';', s)
    while (pos > 0 && pos < s + 300000) {
      try {
        doc = JSON.parse(html.slice(s, pos).trim())
        break
      } catch {
        pos = html.indexOf(';', pos + 1)
      }
    }
    if (!doc) return []
    return parseDoubanItems(doc)
  } catch {
    return []
  }
}

/** 直接解析 __DATA__.items（不再盲目递归整棵对象树——旧实现会抓到缺封面的嵌套同名对象、且作者/出版社取不到） */
function parseDoubanItems(doc: unknown): BookSearchResult[] {
  const items = (doc as { items?: unknown[] } | null)?.items
  if (!Array.isArray(items)) return []
  const out = new Map<string, BookSearchResult>()
  for (const it of items) {
    if (!it || typeof it !== 'object') continue
    const rec = it as Record<string, unknown>
    const title = typeof rec.title === 'string' ? rec.title.trim() : ''
    if (!title || out.has(title)) continue
    const cover = typeof rec.cover_url === 'string' ? rec.cover_url : ''
    const intro = typeof rec.abstract_2 === 'string' ? rec.abstract_2.trim() : ''
    const abstract = typeof rec.abstract === 'string' ? rec.abstract : ''
    const { author, publisher, edition, description } = splitDoubanAbstract(abstract, intro)
    out.set(title, {
      title, author, publisher, edition, description,
      coverUrl: cover,   // 保留豆瓣原图（m 尺寸，稳定可显示）；渲染层 BookCover 显示时自动升级 l 并带失败回退
      url: typeof rec.url === 'string' ? rec.url : undefined,   // 详情页链接（导入章节信息用）
    })
  }
  return [...out.values()].slice(0, 12)
}

/** 抓取豆瓣详情页"目录"区（dir_<id>_short div），解析为章节列表；无目录/失败返回 [] */
export async function fetchDoubanChapters(subjectUrl: string): Promise<string[]> {
  try {
    // SSRF 防护：仅允许 https 的豆瓣域名（渲染层传入的 URL 不可信，防探测内网/localhost）
    const u = new URL(String(subjectUrl ?? ''))
    if (u.protocol !== 'https:' || !/(^|\.)douban\.com$/.test(u.hostname)) return []
    const resp = await fetch(u, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) })
    if (!resp.ok) return []
    const html = await resp.text()
    const m = /id="dir_\d+_short"([\s\S]*?)<\/div>/.exec(html)
    if (!m) return []
    const raw = m[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
    return raw
      .split('\n')
      .map((s) => s.replace(/&nbsp;/g, ' ').trim())
      .filter((s) => s && !/^[·…\s]+$/.test(s) && !/收起|展开|印本/.test(s) && s.length < 120)
  } catch {
    return []
  }
}

/** 拆分豆瓣 abstract 信息串（固定顺序）："[哥伦比亚] 加西亚·马尔克斯 / 范晔 / 南海出版公司 / 2011-6 / 39.50元" */
function splitDoubanAbstract(abstract: string, intro: string): { author: string; publisher: string; edition: string; description: string } {
  const parts = abstract.split(/[/／]/).map((p) => p.trim()).filter(Boolean)
  let author = ''
  let publisher = ''
  let edition = ''
  const rest: string[] = []
  parts.forEach((p, i) => {
    if (i === 0) { author = p; return }                                          // 第 1 位 = 作者
    if (/^\d{4}(?:[-/]\d{1,2})?$/.test(p)) { edition = edition || p; return }    // 出版年 → 版本
    if (/^[\d.]+\s*元/.test(p)) return                                           // 价格：丢弃
    if (/出版社|出版公司|书局|书店|文库|集团|社$/.test(p)) { if (!publisher) publisher = p; return }
    if (i === 1) return                                                          // 第 2 位 = 译者（人名，不展示）
    if (/译/.test(p) && p.length <= 14) return                                   // 含"译"的译者描述
    rest.push(p)
  })
  return { author, publisher, edition, description: [intro, ...rest].filter(Boolean).join(' ') }
}
