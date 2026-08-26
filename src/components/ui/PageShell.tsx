import { useEffect, useState, type ReactNode } from 'react'
import Icon from './Icon'
import ResizeHandles from './ResizeHandles'

/**
 * 功能页统一外壳：玻璃边框 + 顶栏（标题 + 最小化/最大化/关闭）。
 * 顶栏可拖拽窗口（app-region: drag，Win11 拖到顶部可贴靠最大化），按钮区 no-drag。
 */
export default function PageShell({
  title,
  children,
  onBack,
  headerExtra,
}: {
  title: string
  children: ReactNode
  onBack?: () => void
  headerExtra?: ReactNode
}) {
  const [maximized, setMaximized] = useState(false)
  // 最大化状态跟随系统（按钮点击 / 拖到顶部贴靠）——去掉圆角与透明边距占满屏幕
  useEffect(() => window.api.page.onMaximized(setMaximized), [])

  return (
    <div className="w-full h-full">
      {!maximized && <ResizeHandles />}
      <div className="w-full h-full flex flex-col overflow-hidden">
        {/* 顶栏 */}
        <div
          className="h-12 shrink-0 flex items-center px-4 gap-2 border-b border-black/5"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          {onBack && (
            <button
              className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-600 hover:bg-black/5"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              onClick={onBack}
              data-tip="返回"
            >
              <Icon name="back" size={18} />
            </button>
          )}
          <span className="text-[15px] font-medium text-slate-800">{title}</span>
          <div className="flex-1" />
          {headerExtra}
          {/* 窗口按钮 */}
          <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
            <button
              className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-600 hover:bg-black/5"
              onClick={() => window.api.page.minimize()}
              data-tip="最小化"
            >
              <Icon name="minimize" size={15} />
            </button>
            <button
              className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-600 hover:bg-black/5"
              onClick={() => window.api.page.maximizeToggle()}
              data-tip={maximized ? '恢复' : '最大化'}
            >
              <Icon name={maximized ? 'restore' : 'maximize'} size={13} />
            </button>
            <button
              className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-600 hover:bg-red-50 hover:text-red-500"
              onClick={() => window.api.page.close()}
              data-tip="关闭"
            >
              <Icon name="close" size={15} />
            </button>
          </div>
        </div>
        {/* 内容区 */}
        <div className="flex-1 overflow-hidden">{children}</div>
      </div>
    </div>
  )
}
