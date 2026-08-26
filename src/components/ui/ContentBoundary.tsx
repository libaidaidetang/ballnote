import { Component } from 'react'
import type { ReactNode } from 'react'

/**
 * 内容区渲染错误兜底：子组件（Lexical 编辑器等）渲染/卸载抛错时，
 * 只显示错误提示与重试按钮，避免整个页面崩溃导致窗口透明。
 */
export default class ContentBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error): void {
    console.error('[ContentBoundary]', error)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="w-full h-full flex flex-col items-center justify-center gap-3 text-slate-500 text-sm">
          内容渲染出错，请重试
          <button
            className="h-8 px-4 rounded-lg bg-blue-500 text-white text-[12px] hover:bg-blue-600"
            onClick={() => this.setState({ error: null })}
          >
            重试
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
