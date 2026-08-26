import { useEffect, useRef, useState } from 'react'
import type { PetSettingsData } from '../../shared/models'
import { BuiltinEmoji } from '../components/Emoji'

type BubbleContent =
  | { type: 'text'; text: string }
  | { type: 'emoji'; key: string; image?: string }

/**
 * 抚摸气泡窗口：显示在球旁（主进程定位），内容为文字/内置表情/图片表情。
 * 淡入上浮 → 停留 1.5s → 淡出 → 通知主进程隐藏。
 */
export default function BubbleWindow() {
  const [content, setContent] = useState<BubbleContent | null>(null)
  const [toRight, setToRight] = useState(true)
  const [fading, setFading] = useState(false)
  const [seq, setSeq] = useState(0)
  const [imageUrl, setImageUrl] = useState<string | null>(null)

  const durationRef = useRef(1500)
  const fadeTimer = useRef<number | null>(null)
  const hideTimer = useRef<number | null>(null)

  useEffect(() => {
    // 气泡显示时长（设置页「功能设置」可调）
    void window.api.store.load<PetSettingsData>('settings').then((s) => {
      durationRef.current = s.bubbleDurationMs ?? 1500
    })
    return window.api.bubble.onShow(({ content, toRight }) => {
      // 清理上一次的停留/淡出 timer：连续抚摸时旧 timer 会提前隐藏新气泡（刚弹出即消失）
      if (fadeTimer.current) clearTimeout(fadeTimer.current)
      if (hideTimer.current) clearTimeout(hideTimer.current)
      setContent(content)
      setToRight(toRight)
      setFading(false)
      setSeq((s) => s + 1)
      if (content.type === 'emoji' && content.image) {
        void window.api.assetUrl(content.image).then((u) => setImageUrl(u))
      }
      // 停留设置时长后淡出并隐藏窗口
      fadeTimer.current = window.setTimeout(() => {
        setFading(true)
        hideTimer.current = window.setTimeout(() => window.api.bubble.hide(), 300)
      }, durationRef.current)
    })
  }, [])

  const align = toRight ? 'justify-start' : 'justify-end'

  return (
    <div
      className={`w-full h-full flex items-center px-2 select-none pointer-events-none ${align}`}
    >
      <div
        key={seq}
        className="relative max-w-[280px]"
        style={{
          animation: fading ? 'bubble-out 300ms ease-in forwards' : 'bubble-in 200ms ease-out',
        }}
      >
        {/* 卡片（对齐 WPF：95% 白、圆角 8、Padding 9×4.5、描边 8% 黑、柔和投影） */}
        <div
          className="bg-white/95 rounded-lg p-[9px_4.5px] border border-black/[0.08]"
          style={{ boxShadow: '0 2px 12px rgba(0,0,0,0.10)' }}
        >
          {content?.type === 'text' ? (
            <span className="text-[12px] font-semibold" style={{ fontFamily: 'YouYuan, "Microsoft YaHei UI", sans-serif', color: '#4A4A4A' }}>
              {content.text}
            </span>
          ) : content?.type === 'emoji' ? (
            content.image && imageUrl
              ? (
                <span
                  className="inline-block rounded-full overflow-hidden bg-cover"
                  style={{ width: 22, height: 22, backgroundImage: `url(${imageUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }}
                />
              )
              : <BuiltinEmoji type={content.key} size={22} />
          ) : null}
        </div>
        {/* 小尾巴：指向球的一侧 */}
        <div
          className="absolute top-1/2 -translate-y-1/2 w-2 h-2 bg-white/95 rotate-45 border-black/5"
          style={{
            [toRight ? 'left' : 'right']: -4,
            borderLeftWidth: toRight ? 0 : 1,
            borderBottomWidth: toRight ? 0 : 1,
            borderRightWidth: toRight ? 1 : 0,
            borderTopWidth: toRight ? 1 : 0,
          }}
        />
      </div>
    </div>
  )
}
