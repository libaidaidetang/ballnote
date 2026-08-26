// 笔记分享/导出格式浮层（5 格式纵列 + 灰虚线分隔）。
// 此前该 JSX 在 NoteEditorView 与 BookDetailView 中共四份复制粘贴，新增格式需改四处。

import type { NoteExportKind } from '../../lib/noteExport'

const FORMATS: { kind: NoteExportKind; share: string; export: string }[] = [
  { kind: 'png', share: '分享为图片', export: '导出为图片' },
  { kind: 'txt', share: '分享为纯文本', export: '导出为纯文本' },
  { kind: 'docx', share: '分享为word', export: '导出为word' },
  { kind: 'md', share: '分享为markdown', export: '导出为markdown' },
  { kind: 'html', share: '分享为HTML', export: '导出为HTML' },
]

/** mode：share = 分享文案；export = 导出文案。className 提供定位与层级（如 absolute right-0 top-9 z-40）。 */
export default function ExportFormatMenu({ mode, className, onSelect }: {
  mode: 'share' | 'export'
  className?: string
  onSelect: (kind: NoteExportKind) => void
}) {
  return (
    <div className={`${className ?? ''} w-44 bg-white rounded-xl shadow-lg border border-slate-100 py-1`}>
      {FORMATS.map((f, i) => (
        <div key={f.kind}>
          {i > 0 && <div className="border-t border-dashed border-slate-300" />}
          <button className="w-full h-9 px-3 text-left text-[13px] text-slate-700 hover:bg-slate-100 transition-colors"
            onClick={() => onSelect(f.kind)}>
            {mode === 'share' ? f.share : f.export}
          </button>
        </div>
      ))}
    </div>
  )
}
