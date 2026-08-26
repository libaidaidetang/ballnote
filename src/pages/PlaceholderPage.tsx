import PageShell from '../components/ui/PageShell'
import Icon, { type IconName } from '../components/ui/Icon'

const PAGE_META: Record<string, { title: string; icon: IconName }> = {
  sketch: { title: '智能勾画', icon: 'pen' },
  ai: { title: 'AI辅助', icon: 'chat' },
}

/** 占位功能页（勾画/AI 等未实现页面） */
export default function PlaceholderPage({ kind }: { kind: string }) {
  const meta = PAGE_META[kind] ?? { title: '功能', icon: 'more' as IconName }
  return (
    <PageShell title={meta.title}>
      <div className="w-full h-full flex flex-col items-center justify-center gap-3 text-slate-400">
        <Icon name={meta.icon} size={40} />
        <span className="text-[13px]">功能建设中，敬请期待</span>
      </div>
    </PageShell>
  )
}
