import { useEffect, useRef, useState } from 'react'
import type { BubbleConfig, PetCatalogData, PetSettingsData } from '../../shared/models'
import { BUILTIN_EMOJI_KEYS } from '../lib/ui'
const WARM = '#FF9AC1'

/**
 * 悬浮球主窗口（80×80 透明置顶）。
 * 交互：拖拽（主进程跟手移动）、右键扇形菜单、单击吸附、双击抚摸（抖动+气泡）。
 * 拖拽决策在渲染层（位移阈值区分单击/双击/拖拽），窗口移动在主进程。
 */
export default function BallWindow() {
  const [petType, setPetType] = useState('glass')
  const [petTypes, setPetTypes] = useState<PetCatalogData | null>(null)
  const [bubbles, setBubbles] = useState<BubbleConfig | null>(null)
  const [accent, setAccent] = useState('#3388FF')   // 光晕主题色（设置页可改）
  const [warming, setWarming] = useState(false)   // 抚摸光晕变暖
  const [shaking, setShaking] = useState(false)   // 抚摸抖动
  const [hover, setHover] = useState(false)       // 悬停鼓起
  const [dragging, setDragging] = useState(false) // 拖拽果冻拉伸
  const [imageUrl, setImageUrl] = useState<string | null>(null)

  const downRef = useRef<{ x: number; y: number; t: number } | null>(null)
  const movedRef = useRef(false)
  const singleTimer = useRef<number | null>(null)
  const warmTimer = useRef<number | null>(null)
  const shakeTimer = useRef<number | null>(null)

  // ---- 配置加载与订阅 ----
  useEffect(() => {
    void (async () => {
      const settings = await window.api.store.load<PetSettingsData>('settings')
      const types = await window.api.store.load<PetCatalogData>('petTypes')
      const bubblesData = await window.api.store.load<BubbleConfig>('bubbles')
      setPetType(settings.petType)
      setAccent(settings.accentColor ?? '#3388FF')
      setPetTypes(types)
      setBubbles(bubblesData)
    })()
    const unSub = window.api.ball.onPetTypeChanged((t) => setPetType(t))
    const unStore = window.api.store.onChanged('settings', () => {
      void window.api.store.load<PetSettingsData>('settings').then((s) => {
        setPetType(s.petType)
        setAccent(s.accentColor ?? '#3388FF')
      })
    })
    return () => { unSub(); unStore() }
  }, [])

  // 桌宠图片：相对 userData 的路径经主进程转 file:// URL（zoom 中心裁剪：scale = 1/zoom）
  const petItem = petTypes?.types.find((t) => t.key === petType)
  useEffect(() => {
    const item = petTypes?.types.find((t) => t.key === petType)
    if (item?.image) {
      void window.api.assetUrl(item.image).then((u) => setImageUrl(u))
    } else {
      setImageUrl(null)
    }
  }, [petType, petTypes])

  // ---- 抚摸：抖动 + 光晕变暖 + 随机气泡 ----
  const pet = () => {
    setShaking(true)
    setWarming(true)
    if (shakeTimer.current) clearTimeout(shakeTimer.current)
    if (warmTimer.current) clearTimeout(warmTimer.current)
    shakeTimer.current = window.setTimeout(() => setShaking(false), 500)
    warmTimer.current = window.setTimeout(() => setWarming(false), 1000)

    if (!bubbles) return
    const { texts, emojis } = bubbles
    if (texts.length === 0 && emojis.length === 0) return
    const showEmoji = emojis.length > 0 && (texts.length === 0 || Math.random() < 0.5)
    const toRight = Math.random() < 0.5
    if (showEmoji) {
      const emoji = emojis[Math.floor(Math.random() * emojis.length)]
      // 无效表情（非内置 key 且无图片）：跳过本次气泡（对齐 WPF BuildEmojiItem 返回 null 的行为）
      const builtin: readonly string[] = BUILTIN_EMOJI_KEYS
      if (!emoji.image && !builtin.includes(emoji.key)) return
      window.api.bubble.show(
        emoji.image ? { type: 'emoji', key: emoji.key, image: emoji.image } : { type: 'emoji', key: emoji.key },
        toRight,
      )
    } else {
      window.api.bubble.show({ type: 'text', text: texts[Math.floor(Math.random() * texts.length)] }, toRight)
    }
  }

  // ---- 指针事件（拖拽跟手由主进程完成，这里只上报） ----
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    // 双击等待窗口内的第二击 = 抚摸
    if (singleTimer.current !== null) {
      clearTimeout(singleTimer.current)
      singleTimer.current = null
      pet()
      return
    }
    downRef.current = { x: e.screenX, y: e.screenY, t: performance.now() }
    movedRef.current = false
    // 捕获指针：球窗仅 80×80，按住后鼠标移出窗口边界仍能持续收到 move/up
    // （否则移出 1px 拖拽即中断）
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* 已释放/无效 */ }
    window.api.ball.pointer('down', e.screenX, e.screenY)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!downRef.current) return
    // 位移超过 6px 判定拖拽（渲染层本地判断，主进程也判定 moved 用于 up 返回）
    if (!movedRef.current
      && (Math.abs(e.screenX - downRef.current.x) > 6 || Math.abs(e.screenY - downRef.current.y) > 6)) {
      movedRef.current = true
      setDragging(true)
    }
    window.api.ball.pointer('move', e.screenX, e.screenY)
  }

  const onPointerUp = async (e: React.PointerEvent) => {
    if (!downRef.current) return
    const down = downRef.current
    downRef.current = null
    try {
      const { moved } = await window.api.ball.pointer('up', e.screenX, e.screenY)
      setDragging(false)
      if (moved || movedRef.current) return   // 拖拽过：吸附/贴边由主进程 dragEnd 处理

      // 单击候选：短按开启双击等待窗口，无第二击则吸附
      const holdMs = performance.now() - down.t
      if (holdMs < 250) {
        singleTimer.current = window.setTimeout(() => {
          singleTimer.current = null
          window.api.ball.singleClick()
        }, 280)
      }
      // 长按：不吸附（主进程已在 up 时恢复贴边检测）
    } catch {
      // IPC 失败也要复位拖拽态，否则球动画全停卡死在"拖拽中"
      setDragging(false)
    }
  }

  /** 指针捕获被系统取消（如窗口失焦）：按抬起处理，防拖动状态卡死 */
  const onPointerCancel = (e: React.PointerEvent) => {
    if (!downRef.current) return
    downRef.current = null
    void window.api.ball.pointer('up', e.screenX, e.screenY).then(() => setDragging(false))
  }

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    window.api.ball.toggleMenu()
  }

  // 桌宠图片（zoom 中心裁剪：scale = 1/zoom 放大中心区域）
  // 根容器强制单一合成层（translateZ(0)）；拖拽时暂停全部动画：
  // 透明窗口移动时若元素各自是合成层，部分重绘会导致光晕/球体/气泡错位"散架"，
  // 暂停动画后三层合并为一张静态位图整体移动。
  return (
    <div
      className="w-full h-full relative select-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onContextMenu={onContextMenu}
      onMouseEnter={() => { setHover(true); window.api.ball.hover('enter') }}
      onMouseLeave={() => { setHover(false); window.api.ball.hover('leave') }}
      style={{ cursor: 'grab', willChange: 'transform', transform: 'translateZ(0)' }}
    >
      {/* 球体 + 光晕：显式像素定位（80-60)/2=10，不依赖 translate/百分比——
          此前 Tailwind translate 类在 Electron 透明窗口中定位不可靠，球偏右下。
          动画层（呼吸/漂浮）在内层，scale/translateY 不会影响定位。
          光晕与球同层：随球一起呼吸缩放 + 上下漂浮（对齐 WPF BallRoot 结构） */}
      <div
        className="absolute"
        style={{ left: 10, top: 10, width: 60, height: 60, pointerEvents: 'none' }}
      >
        {/* 呼吸层：scale（相对元素中心，不影响定位） */}
        <div style={{ animation: dragging ? 'none' : 'ball-breathe 3s ease-in-out infinite' }}>
          {/* 漂浮层：translateY（光晕与球同在此层，一起上下飘动） */}
          <div style={{ position: 'relative', width: 60, height: 60, animation: dragging ? 'none' : 'ball-float 4s ease-in-out infinite' }}>
            {/* 光晕：径向渐变圆环（对齐 WPF BallHalo：0→80% 透明、88% 处峰值、88→100% 淡出）。
                显式 36px 半径（= 元素半径，对齐 WPF RadialGradientBrush 默认渐变范围）；
                峰值 20% 透明度（对齐 WPF GlowPeak #333388FF） */}
            <div
              className="absolute rounded-full transition-opacity duration-200"
              style={{
                width: 72, height: 72, left: -6, top: -6,
                background: `radial-gradient(circle 36px at 50% 50%, ${warming ? WARM : accent}00 0%, ${warming ? WARM : accent}00 80%, ${warming ? WARM : accent}33 88%, ${warming ? WARM : accent}00 100%)`,
                opacity: hover ? 1 : 0.85,
                animation: dragging ? 'none' : 'halo-pulse 4s ease-in-out infinite',
              }}
            />
            <div
              className="rounded-full overflow-hidden"
              style={{
                width: 60, height: 60,
                // 勾边 1.5px 20% 黑（对齐 WPF Stroke #33000000 + BallBorderThickness）
                border: '1.5px solid rgba(0,0,0,0.2)',
                // 球体渐变对齐 WPF：Center 0.4,0.4、Radius 0.75（60*0.75=45px）、三色 stop
                background: 'radial-gradient(circle 45px at 40% 40%, #FFFFFF 0%, #F0F2F5 65%, #D8DCE2 100%)',
                // 悬停鼓起（BackEase 果冻感）：球体本身无 translate，scale 不产生位移
                animation: dragging
                  ? undefined
                  : hover ? 'ball-hover-in 260ms ease-out forwards' : 'ball-hover-out 220ms ease-in forwards',
              }}
            >
              {imageUrl ? (
                <img
                  src={imageUrl}
                  alt=""
                  draggable={false}
                  className="w-full h-full select-none"
                  style={{
                    objectFit: 'cover',
                    transform: petItem?.zoom && petItem.zoom < 1 ? `scale(${1 / petItem.zoom})` : undefined,
                  }}
                />
              ) : null}
            </div>
          </div>
        </div>
      </div>
      {/* 抖动容器：抚摸时左右晃 */}
      <div
        className="absolute inset-0"
        style={{
          animation: shaking ? 'ball-shake 500ms linear' : undefined,
          pointerEvents: 'none',
        }}
      />
    </div>
  )
}
