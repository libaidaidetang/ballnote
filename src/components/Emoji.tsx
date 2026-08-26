/**
 * 内置矢量表情（对齐 WPF PetAnimator 的画法：wink/heart/blush/cool）。
 * 用 SVG 实现，避免彩色 emoji 字体渲染问题。
 */

export function EmojiWink({ size = 24 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size}>
      <circle cx="12" cy="12" r="12" fill="#FFD700" />
      <ellipse cx="5" cy="15.5" rx="2.6" ry="1.5" fill="#FF8A8A" opacity="0.7" />
      <ellipse cx="19" cy="15.5" rx="2.6" ry="1.5" fill="#FF8A8A" opacity="0.7" />
      <circle cx="9" cy="10.5" r="2.2" fill="#000" />
      <circle cx="9.7" cy="9.8" r="0.9" fill="#fff" />
      <path d="M 13.5 10.5 Q 15 8.8 16.5 10.5" stroke="#000" strokeWidth="1.4" fill="none"
        strokeLinecap="round" />
      <path d="M 8.5 15.5 Q 12 19 15.5 15.5" stroke="#000" strokeWidth="1.4" fill="none"
        strokeLinecap="round" />
    </svg>
  )
}

export function EmojiHeart({ size = 22 }: { size?: number }) {
  return (
    <svg viewBox="0 0 22 20" width={size} height={size}>
      <path
        d="M 16 28 C 16 28 2 18 2 10 C 2 5 6 2 10 2 C 13 2 16 5 16 8 C 16 5 19 2 22 2 C 26 2 30 5 30 10 C 30 18 16 28 16 28 Z"
        fill="#FF6B9D" transform="translate(-2 -2) scale(0.83)"
      />
      <ellipse cx="6.5" cy="7" rx="2.2" ry="1.7" fill="#FFFFFF" opacity="0.8" />
    </svg>
  )
}

export function EmojiBlush({ size = 24 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size}>
      <circle cx="12" cy="12" r="12" fill="#FFF3DC" stroke="#FF8A8A" strokeOpacity="0.4" />
      <path d="M 6 10.5 Q 8 8.2 10 10.5" stroke="#000" strokeWidth="1.4" fill="none" strokeLinecap="round" />
      <path d="M 14 10.5 Q 16 8.2 18 10.5" stroke="#000" strokeWidth="1.4" fill="none" strokeLinecap="round" />
      <ellipse cx="5" cy="16" rx="2.8" ry="1.8" fill="#FF8A8A" opacity="0.72" />
      <ellipse cx="19" cy="16" rx="2.8" ry="1.8" fill="#FF8A8A" opacity="0.72" />
      <path d="M 9.5 16 Q 12 18.5 14.5 16" stroke="#000" strokeWidth="1.4" fill="none" strokeLinecap="round" />
    </svg>
  )
}

export function EmojiCool({ size = 24 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size}>
      <circle cx="12" cy="12" r="12" fill="#FFD700" />
      <rect x="3.5" y="8.5" width="8" height="5.5" rx="2.5" fill="#2B2B2B" />
      <rect x="12.5" y="8.5" width="8" height="5.5" rx="2.5" fill="#2B2B2B" />
      <path d="M 11.5 9.5 L 12.5 9.5" stroke="#2B2B2B" strokeWidth="2" strokeLinecap="round" />
      <path d="M 3.5 10 L 1 8.5 M 20.5 10 L 23 8.5" stroke="#2B2B2B" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M 8.5 16.5 Q 12 19 15.5 16" stroke="#000" strokeWidth="1.4" fill="none" strokeLinecap="round" />
    </svg>
  )
}

/** 内置矢量表情按 key 渲染（注意：不能用 prop 名 key——React 保留 prop，传给组件的是 undefined） */
export function BuiltinEmoji({ type, size = 24 }: { type: string; size?: number }) {
  switch (type) {
    case 'wink': return <EmojiWink size={size} />
    case 'heart': return <EmojiHeart size={size} />
    case 'blush': return <EmojiBlush size={size} />
    case 'cool': return <EmojiCool size={size} />
    default: return null
  }
}
