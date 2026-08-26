import { useEffect, useState } from 'react'

/**
 * 封面图片（书籍卡片 / 详情页 / 新建弹窗预览共用）。
 * - 本地相对路径经主进程转 file:// URL
 * - 远程封面自动尝试高清变体：豆瓣 m→l（中图→大图）、微信读书 myqcloud s_→b_（小图→大图）
 * - 高清变体加载失败自动回退原图；原图也失败则隐藏（由外层渐变占位兜底）
 */
function hiResCover(cover: string): string {
  try {
    if (cover.includes('doubanio.com')) {
      return cover.replace(/\/view\/([^/]+)\/m\/public\//, '/view/$1/l/public/')
    }
    if (cover.includes('wfqqreader-1252317822.image.myqcloud.com')) {
      return cover.replace(/\/s_([^/]+)$/, '/b_$1')
    }
  } catch { /* 忽略 */ }
  return cover
}

export default function BookCover({ cover, className, alt = '' }: {
  cover: string
  className?: string
  alt?: string
}) {
  const [url, setUrl] = useState<string | null>(null)
  /** 高清变体失败 → 回退原始封面 */
  const [fallback, setFallback] = useState(false)

  useEffect(() => {
    let active = true
    setFallback(false)
    if (cover.startsWith('http')) {
      if (active) setUrl(hiResCover(cover))
      return () => { active = false }
    }
    void window.api.assetUrl(cover).then((u) => { if (active) setUrl(u) })
    return () => { active = false }
  }, [cover])

  if (!url) return null
  return (
    <img
      src={fallback ? cover : url}
      alt={alt}
      className={className}
      draggable={false}
      onError={() => {
        if (!cover.startsWith('http')) { setUrl(null); return }   // 本地图失败：隐藏，外层占位兜底
        if (!fallback && url !== cover) setFallback(true)          // 高清失败：回退原图
        else setUrl(null)                                          // 原图也失败：隐藏
      }}
    />
  )
}
