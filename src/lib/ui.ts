// 渲染层共享 UI 工具：toast、颜色工具、内置表情 key、空编辑器状态。
// 收敛此前散落各组件的重复定义（showToast×4 / shade×2 / EMPTY_STATE×2 / 表情 key×3）。

import { useEffect, useRef, useState } from 'react'

export interface ToastPayload { msg: string; error?: boolean }

/** Toast 提示 Hook（各页面通用）：新提示先清旧定时器，避免连续提示被上一个未触发的隐藏提前清掉；卸载时清理定时器。 */
export function useToast(durationMs = 2400): {
  toast: ToastPayload | null
  showToast: (msg: string, error?: boolean) => void
} {
  const [toast, setToast] = useState<ToastPayload | null>(null)
  const timer = useRef<number | null>(null)
  const showToast = (msg: string, error = false) => {
    setToast({ msg, error })
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      timer.current = null
      setToast(null)
    }, durationMs)
  }
  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current)
  }, [])
  return { toast, showToast }
}

/** 颜色加深 */
export function shade(hex: string, factor: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '')
  if (!m) return '#6366F1'
  const n = parseInt(m[1], 16)
  const r = Math.round(((n >> 16) & 0xff) * factor)
  const g = Math.round(((n >> 8) & 0xff) * factor)
  const b = Math.round((n & 0xff) * factor)
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`
}

/** 封面占位色（确定性选取） */
const COVER_PALETTE = ['#6366F1', '#0EA5E9', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899']
export function pickCoverColor(id: number): string {
  return COVER_PALETTE[id % COVER_PALETTE.length]
}

/** 内置矢量表情 key 列表（与 Emoji.tsx 的 BuiltinEmoji 支持的 type 一致） */
export const BUILTIN_EMOJI_KEYS = ['wink', 'heart', 'blush', 'cool'] as const

/** 空 Lexical EditorState JSON（富文本编辑器/便利贴共用的初始态） */
export const EMPTY_LEXICAL_STATE = '{"root":{"children":[{"type":"paragraph","version":1,"children":[]}],"direction":"ltr","format":"","indent":0,"type":"root","version":1}}'
