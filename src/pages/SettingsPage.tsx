import { useEffect, useState } from 'react'
import type {
  AIConfig, BookStore, BubbleConfig, BubbleEmojiItem, CalendarData, MenuItemModel,
  PetCatalogData, PetSettingsData, ThoughtStoreData, UpdateState,
} from '../../shared/models'
import PageShell from '../components/ui/PageShell'
import { DayDot, dateKey, dayTooltip, mondayOf, toDate, workCount } from '../components/Calendar'
import { BuiltinEmoji } from '../components/Emoji'
import { useToday } from '../lib/useToday'
import { saveStore } from '../lib/storeSave'
import { BUILTIN_EMOJI_KEYS, useToast } from '../lib/ui'

type Category = 'appearance' | 'function' | 'interaction' | 'ai' | 'help' | 'system' | 'calendar'

const CATEGORIES: { key: Category; label: string }[] = [
  { key: 'appearance', label: '外观设置' },
  { key: 'function', label: '功能设置' },
  { key: 'interaction', label: '互动设置' },
  { key: 'ai', label: 'AI 设置' },
  { key: 'help', label: '操作说明' },
  { key: 'system', label: '系统设置' },
  { key: 'calendar', label: '日历' },
]

const DEFAULT_SETTINGS: PetSettingsData = {
  petType: 'glass', mistEffect: 'none',
  accentColor: '#3388FF', edgeHideEnabled: true, snapEnabled: true, bubbleDurationMs: 1500,
}

/** 光晕主题色预设 */
const ACCENT_COLORS = ['#3388FF', '#10B981', '#8B5CF6', '#EC4899', '#F59E0B', '#EF4444']

/** 页面注册（功能下拉来源，对齐 WPF PageRegistry.MenuAddable） */
const PAGE_ACTIONS = [
  { key: 'library', title: '图书馆' },
  { key: 'sketch', title: '智能勾画' },
  { key: 'ai', title: 'AI辅助' },
  { key: 'settings', title: '设置' },
]

export default function SettingsPage() {
  const [category, setCategory] = useState<Category>('appearance')
  const [petTypes, setPetTypes] = useState<PetCatalogData | null>(null)
  const [settings, setSettings] = useState<PetSettingsData | null>(null)

  const [menus, setMenus] = useState<MenuItemModel[]>([])
  const [menuTitle, setMenuTitle] = useState('')
  const [menuAction, setMenuAction] = useState('library')
  const [selectedMenu, setSelectedMenu] = useState<number | null>(null)

  const [bubbleDialog, setBubbleDialog] = useState(false)
  const [editTexts, setEditTexts] = useState<string[]>([])
  const [editEmojis, setEditEmojis] = useState<BubbleEmojiItem[]>([])
  const [newText, setNewText] = useState('')
  const [newEmoji, setNewEmoji] = useState('wink')
  const [newEmojiName, setNewEmojiName] = useState('')
  const [newEmojiImage, setNewEmojiImage] = useState('')

  const [dialog, setDialog] = useState<{ title: string; msg: string; onOk: () => void } | null>(null)
  const { toast, showToast } = useToast(2400)

  // AI 配置（ai.json：启用/接口/密钥/模型）
  const [aiConfig, setAiConfig] = useState<AIConfig | null>(null)
  const [showKey, setShowKey] = useState(false)

  const [calBooks, setCalBooks] = useState<BookStore | null>(null)
  const [calThoughts, setCalThoughts] = useState<ThoughtStoreData | null>(null)
  const [calData, setCalData] = useState<CalendarData | null>(null)

  useEffect(() => {
    void (async () => {
      setPetTypes(await window.api.store.load<PetCatalogData>('petTypes'))
      setSettings(await window.api.store.load<PetSettingsData>('settings'))
      setMenus((await window.api.store.load<{ items: MenuItemModel[] }>('menus')).items)
      setAiConfig(await window.api.store.load<AIConfig>('ai'))
    })()
    const un = window.api.store.onChanged('settings', () => {
      void window.api.store.load<PetSettingsData>('settings').then(setSettings)
    })
    return un
  }, [])

  // ---- 外观 ----
  const changePetType = async (petType: string) => {
    const next = { ...(settings ?? DEFAULT_SETTINGS), petType }
    await saveStore('settings', next)
  }
  const changeMist = async (mistEffect: string) => {
    const next = { ...(settings ?? DEFAULT_SETTINGS), mistEffect }
    await saveStore('settings', next)
    showToast('拖拽雾效已切换（当前仅 none 可用，雾效已归档暂停）')
  }

  // ---- 功能设置：保存单字段补丁（即时生效） ----
  const saveSettings = async (patch: Partial<PetSettingsData>) => {
    const next = { ...(settings ?? DEFAULT_SETTINGS), ...patch }
    await saveStore('settings', next)
  }

  // ---- AI 配置 ----
  const saveAi = async () => {
    if (!aiConfig) return
    await saveStore('ai', {
      ...aiConfig,
      baseUrl: aiConfig.baseUrl.trim().replace(/\/+$/, ''),
    })
    showToast('AI 配置已保存（对话/回顾即时生效）')
  }

  // ---- 菜单管理 ----
  const addMenu = () => {
    const title = menuTitle.trim()
    if (!title) return
    if (menus.length >= 9) { showToast('菜单项最多 9 个', true); return }
    setMenus([...menus, { title, action: menuAction }])
    setMenuTitle('')
  }
  const deleteMenu = () => {
    if (selectedMenu == null) { showToast('请先选中要删除的项', true); return }
    setMenus(menus.filter((_, i) => i !== selectedMenu))
    setSelectedMenu(null)
  }
  const saveMenus = async () => {
    await saveStore('menus', { items: menus })
    showToast('菜单已保存并即时生效')
  }

  // ---- 气泡 ----
  const openBubbleDialog = async () => {
    const data = await window.api.store.load<BubbleConfig>('bubbles')
    setEditTexts([...data.texts])
    setEditEmojis(data.emojis.map((e) => ({ ...e })))
    setBubbleDialog(true)
  }
  const addText = () => {
    const t = newText.trim()
    if (!t) return
    setEditTexts([...editTexts, t])
    setNewText('')
  }
  const addEmoji = () => {
    if (editEmojis.some((e) => e.key === newEmoji && !e.image)) return
    const builtin = (BUILTIN_EMOJI_KEYS as readonly string[]).includes(newEmoji)
    if (builtin) setEditEmojis([...editEmojis, { key: newEmoji, name: newEmoji }])
  }
  const addImageEmoji = () => {
    const img = newEmojiImage.trim()
    if (!img) { showToast('请填写图片路径', true); return }
    if (editEmojis.some((e) => e.image === img)) return
    setEditEmojis([...editEmojis, { key: img, name: newEmojiName.trim() || '图片表情', image: img }])
    setNewEmojiName(''); setNewEmojiImage('')
  }
  const deleteBubble = (idx: number) => {
    if (idx < editTexts.length) {
      setEditTexts(editTexts.filter((_, i) => i !== idx))
    } else {
      setEditEmojis(editEmojis.filter((_, i) => i !== idx - editTexts.length))
    }
  }
  const saveBubbles = async () => {
    await saveStore('bubbles', { texts: editTexts, emojis: editEmojis })
    setBubbleDialog(false)
    showToast('气泡内容已保存并即时生效')
  }

  // ---- 日历 ----
  const loadCalendar = async () => {
    setCalBooks(await window.api.store.load<BookStore>('books'))
    setCalThoughts(await window.api.store.load<ThoughtStoreData>('thoughts'))
    setCalData(await window.api.store.load<CalendarData>('calendar'))
  }
  useEffect(() => {
    // 不按 category 条件跳过：useCalendarRanges 需要真实日历数据判断"是否首次运行"，
    // 挂载时若不加载（cal 恒 null）会被误判为无数据；每次分类切换顺带刷新
    void loadCalendar()
  }, [category])

  const todayKey = useToday()
  const calRanges = useCalendarRanges(calData, todayKey)

  return (
    <PageShell title="设置">
      <div className="flex h-full">
        {/* 左侧分类 */}
        <div className="w-36 shrink-0 border-r border-black/5 p-2 space-y-1">
          {CATEGORIES.map((c) => (
            <button
              key={c.key}
              className={`w-full h-9 rounded-lg text-[13px] text-left px-3 transition-colors
                ${category === c.key ? 'bg-blue-500/10 text-blue-600 font-medium' : 'text-slate-600 hover:bg-black/5'}`}
              onClick={() => setCategory(c.key)}
            >
              {c.label}
            </button>
          ))}
        </div>

        {/* 右侧内容 */}
        <div className="flex-1 overflow-y-auto p-5">
          {category === 'appearance' && (
            <div className="space-y-4">
              <Section title="桌宠">
                <div className="flex items-center gap-3">
                  <span className="text-[13px] text-slate-500 w-20">桌宠类型</span>
                  <select
                    className="h-9 flex-1 rounded-lg border border-black/10 bg-white/90 px-2 text-[13px] outline-none"
                    value={settings?.petType ?? 'glass'}
                    onChange={(e) => void changePetType(e.target.value)}
                  >
                    {petTypes?.types.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}
                  </select>
                </div>
                <div className="flex items-center gap-3 mt-3">
                  <span className="text-[13px] text-slate-500 w-20">桌宠形态</span>
                  <select className="h-9 flex-1 rounded-lg border border-black/10 bg-white/90 px-2 text-[13px] outline-none"
                    defaultValue="ball">
                    {petTypes?.forms.map((f) => <option key={f.key} value={f.key}>{f.name}</option>)}
                  </select>
                </div>
                <div className="flex items-center gap-3 mt-3">
                  <span className="text-[13px] text-slate-500 w-20">拖拽雾效</span>
                  <select
                    className="h-9 flex-1 rounded-lg border border-black/10 bg-white/90 px-2 text-[13px] outline-none"
                    value={settings?.mistEffect ?? 'none'}
                    onChange={(e) => void changeMist(e.target.value)}
                  >
                    <option value="none">无（默认）</option>
                    <option value="gradient" disabled>渐变雾（已归档暂停）</option>
                    <option value="particle" disabled>粒子雾（已归档暂停）</option>
                  </select>
                </div>
                {/* 光晕主题色（补充设置项） */}
                <div className="flex items-center gap-3 mt-3">
                  <span className="text-[13px] text-slate-500 w-20">光晕颜色</span>
                  <div className="flex gap-2">
                    {ACCENT_COLORS.map((c) => (
                      <button
                        key={c}
                        className={`w-7 h-7 rounded-full transition-transform ${(settings?.accentColor ?? '#3388FF') === c ? 'ring-2 ring-slate-400 scale-110' : 'hover:scale-110'}`}
                        style={{ background: c }}
                        data-tip={c}
                        onClick={() => void saveSettings({ accentColor: c })}
                      />
                    ))}
                  </div>
                </div>
              </Section>
            </div>
          )}

          {category === 'function' && (
            <div className="space-y-4">
              <Section title="悬浮球行为">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-[13px] text-slate-700">贴边收起</p>
                    <p className="text-[11px] text-slate-400">拖到屏幕边缘后自动收起、鼠标靠近滑回</p>
                  </div>
                  <Toggle checked={settings?.edgeHideEnabled ?? true}
                    onChange={(v) => void saveSettings({ edgeHideEnabled: v })} />
                </div>
                <div className="flex items-center justify-between mt-4">
                  <div>
                    <p className="text-[13px] text-slate-700">单击吸附</p>
                    <p className="text-[11px] text-slate-400">单击悬浮球吸附到最近的屏幕左右边缘</p>
                  </div>
                  <Toggle checked={settings?.snapEnabled ?? true}
                    onChange={(v) => void saveSettings({ snapEnabled: v })} />
                </div>
                <div className="flex items-center justify-between mt-4">
                  <div>
                    <p className="text-[13px] text-slate-700">气泡显示时长</p>
                    <p className="text-[11px] text-slate-400">双击抚摸时气泡停留的时间</p>
                  </div>
                  <select
                    className="h-9 w-28 rounded-lg border border-black/10 bg-white/90 px-2 text-[13px] outline-none"
                    value={settings?.bubbleDurationMs ?? 1500}
                    onChange={(e) => void saveSettings({ bubbleDurationMs: Number(e.target.value) })}
                  >
                    <option value={1000}>1 秒</option>
                    <option value={1500}>1.5 秒</option>
                    <option value={2000}>2 秒</option>
                    <option value={3000}>3 秒</option>
                  </select>
                </div>
              </Section>
            </div>
          )}

          {category === 'interaction' && (
            <div className="space-y-4">
              <Section title="菜单项管理">
                <div className="flex gap-2">
                  <input
                    className="h-9 flex-1 rounded-lg border border-black/10 bg-white/90 px-2 text-[13px] outline-none"
                    placeholder="菜单标题"
                    value={menuTitle}
                    onChange={(e) => setMenuTitle(e.target.value)}
                  />
                  <select className="h-9 w-28 rounded-lg border border-black/10 bg-white/90 px-2 text-[13px] outline-none"
                    value={menuAction} onChange={(e) => setMenuAction(e.target.value)}>
                    {PAGE_ACTIONS.map((p) => <option key={p.key} value={p.key}>{p.title}</option>)}
                  </select>
                  <button className="h-9 px-4 rounded-lg bg-blue-500 text-white text-[13px] hover:bg-blue-600 active:scale-95 transition"
                    onClick={addMenu}>添加</button>
                </div>
                <div className="mt-3 space-y-1">
                  {menus.map((m, i) => (
                    <div key={i}
                      className={`flex items-center justify-between h-9 px-3 rounded-lg text-[13px] cursor-pointer
                        ${selectedMenu === i ? 'bg-blue-500/10 text-blue-600' : 'hover:bg-black/5'}`}
                      onClick={() => setSelectedMenu(i)}>
                      <span>{m.title}</span>
                      <span className="text-[11px] text-slate-400">{m.action}</span>
                    </div>
                  ))}
                  {menus.length === 0 && <p className="text-[12px] text-slate-400 text-center py-3">暂无菜单项</p>}
                </div>
                <div className="flex gap-2 mt-3">
                  <button className="h-8 px-4 rounded-lg text-[13px] text-red-500 hover:bg-red-50"
                    onClick={deleteMenu}>删除选中</button>
                  <button className="h-8 px-4 rounded-lg bg-blue-500 text-white text-[13px] hover:bg-blue-600 active:scale-95 transition"
                    onClick={() => void saveMenus()}>保存（即时生效）</button>
                </div>
              </Section>

              <Section title="气泡内容">
                <p className="text-[12px] text-slate-400">双击悬浮球弹出的文字与表情，保存后即时生效。</p>
                <button className="mt-2 h-9 px-4 rounded-lg bg-blue-500 text-white text-[13px] hover:bg-blue-600 active:scale-95 transition"
                  onClick={() => void openBubbleDialog()}>
                  自定义气泡内容…
                </button>
              </Section>
            </div>
          )}

          {category === 'ai' && aiConfig && (
            <Section title="AI 服务">
              <p className="text-[12px] text-slate-400 mb-3">
                开启后填 API Key 走远程模型（OpenAI 兼容协议：DeepSeek/OpenAI/通义/Moonshot 等）；未填 Key 时自动使用本地规则模拟。
              </p>
              <label className="flex items-center gap-2 text-[13px] text-slate-600">
                <input type="checkbox" className="w-4 h-4"
                  checked={aiConfig.enabled}
                  onChange={(e) => setAiConfig({ ...aiConfig, enabled: e.target.checked })} />
                启用远程 API
              </label>
              <div className="flex items-center gap-3 mt-3">
                <span className="text-[13px] text-slate-500 w-20 shrink-0">接口地址</span>
                <input className="h-9 flex-1 rounded-lg border border-black/10 bg-white/70 px-2 text-[13px] outline-none"
                  value={aiConfig.baseUrl}
                  onChange={(e) => setAiConfig({ ...aiConfig, baseUrl: e.target.value })}
                  placeholder="https://api.deepseek.com" />
              </div>
              <div className="flex items-center gap-3 mt-3">
                <span className="text-[13px] text-slate-500 w-20 shrink-0">API Key</span>
                <input
                  className="h-9 flex-1 rounded-lg border border-black/10 bg-white/70 px-2 text-[13px] outline-none"
                  type={showKey ? 'text' : 'password'}
                  value={aiConfig.apiKey}
                  onChange={(e) => setAiConfig({ ...aiConfig, apiKey: e.target.value })}
                  placeholder="sk-…（留空则本地模拟）" />
                <button className="h-9 px-3 rounded-lg border border-black/10 text-[12px] text-slate-600 hover:bg-black/5"
                  onClick={() => setShowKey(!showKey)}>
                  {showKey ? '隐藏' : '显示'}
                </button>
              </div>
              <div className="flex items-center gap-3 mt-3">
                <span className="text-[13px] text-slate-500 w-20 shrink-0">模型名</span>
                <input className="h-9 flex-1 rounded-lg border border-black/10 bg-white/70 px-2 text-[13px] outline-none"
                  value={aiConfig.model}
                  onChange={(e) => setAiConfig({ ...aiConfig, model: e.target.value })}
                  placeholder="deepseek-v4-flash" />
              </div>
              <div className="flex justify-end mt-4">
                <button className="h-9 px-5 rounded-lg bg-blue-500 text-white text-[13px] hover:bg-blue-600 active:scale-95 transition"
                  onClick={() => void saveAi()}>
                  保存
                </button>
              </div>
            </Section>
          )}

          {category === 'help' && (
            <Section title="操作说明">
              <ul className="text-[13px] text-slate-600 space-y-2 leading-relaxed">
                <li>· 拖拽：按住悬浮球拖动到任意位置</li>
                <li>· 单击：吸附到最近的屏幕左右边缘</li>
                <li>· 双击：抚摸（抖动 + 气泡）</li>
                <li>· 右键：展开/收起扇形菜单</li>
                <li>· 贴边收起：拖到屏幕边缘后自动只露一小边，鼠标靠近滑回</li>
                <li>· 托盘：右下角通知区域图标可显示悬浮球/退出</li>
              </ul>
            </Section>
          )}

          {category === 'system' && (
            <>
              <Section title="应用">
                <div className="flex gap-3">
                  <button className="h-9 px-5 rounded-lg border border-black/10 text-[13px] text-slate-700 hover:bg-black/5"
                    onClick={() => setDialog({ title: '确认重启', msg: '重启后使设置生效，确定要重启应用吗？', onOk: () => window.api.app.restart() })}>
                    重启应用
                  </button>
                  <button className="h-9 px-5 rounded-lg bg-red-500 text-white text-[13px] hover:bg-red-600 active:scale-95 transition"
                    onClick={() => setDialog({ title: '确认关闭', msg: '确定要关闭软件吗？', onOk: () => window.api.app.quit() })}>
                    关闭软件
                  </button>
                </div>
              </Section>
              <UpdaterPanel settings={settings} saveSettings={saveSettings} showToast={showToast} />
            </>
          )}

          {category === 'calendar' && calData && (
            <Section title="完整日历">
              <CalendarGrid
                ranges={calRanges}
                books={calBooks}
                thoughts={calThoughts}
                cal={calData}
                todayKey={todayKey}
              />
            </Section>
          )}
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 glass-card rounded-full px-4 py-2"
          style={{ animation: 'toast-in 220ms ease-out' }}>
          <span className={`w-4 h-4 rounded-full flex items-center justify-center text-white text-[10px] ${toast.error ? 'bg-red-400' : 'bg-green-400'}`}>
            {toast.error ? '!' : '✓'}
          </span>
          <span className="text-[13px] text-slate-700">{toast.msg}</span>
        </div>
      )}

      {/* 模态确认框 */}
      {dialog && (
        <div className="absolute inset-0 bg-black/40 flex items-center justify-center z-40"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setDialog(null) }}>
          <div className="glass-card rounded-2xl w-80 p-5">
            <p className="text-[15px] font-medium text-slate-800">{dialog.title}</p>
            <p className="text-[13px] text-slate-500 mt-2">{dialog.msg}</p>
            <div className="flex justify-end gap-2 mt-4">
              <button className="h-8 px-4 rounded-lg text-[13px] text-slate-600 hover:bg-black/5"
                onClick={() => setDialog(null)}>取消</button>
              <button className="h-8 px-4 rounded-lg bg-blue-500 text-white text-[13px] hover:bg-blue-600"
                onClick={() => { const ok = dialog.onOk; setDialog(null); ok() }}>确定</button>
            </div>
          </div>
        </div>
      )}

      {/* 气泡编辑弹窗 */}
      {bubbleDialog && (
        <div className="absolute inset-0 bg-black/40 flex items-center justify-center z-40"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setBubbleDialog(false) }}>
          <div className="glass-card rounded-2xl w-[560px] max-h-[80%] flex flex-col p-5">
            <p className="text-[15px] font-medium text-slate-800">自定义气泡内容</p>

            <p className="text-[12px] text-slate-500 mt-4 mb-1">文字 / 颜文字</p>
            <div className="flex gap-2">
              <input className="h-8 flex-1 rounded-lg border border-black/10 bg-white/90 px-2 text-[13px] outline-none"
                value={newText} onChange={(e) => setNewText(e.target.value)} placeholder="如：喵~" />
              <button className="h-8 px-3 rounded-lg bg-blue-500 text-white text-[12px] hover:bg-blue-600"
                onClick={addText}>添加</button>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {editTexts.map((t, i) => (
                <span key={i} className="inline-flex items-center gap-1 bg-white/90 rounded-full px-2.5 py-1 text-[12px] text-slate-700 border border-black/5">
                  {t}
                  <button className="text-slate-400 hover:text-red-500" onClick={() => deleteBubble(i)}>×</button>
                </span>
              ))}
            </div>

            <p className="text-[12px] text-slate-500 mt-4 mb-1">内置表情</p>
            <div className="flex gap-2">
              <select className="h-8 w-32 rounded-lg border border-black/10 bg-white/90 px-2 text-[13px] outline-none"
                value={newEmoji} onChange={(e) => setNewEmoji(e.target.value)}>
                {BUILTIN_EMOJI_KEYS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
              <button className="h-8 px-3 rounded-lg bg-blue-500 text-white text-[12px] hover:bg-blue-600"
                onClick={addEmoji}>添加</button>
            </div>

            <p className="text-[12px] text-slate-500 mt-4 mb-1">自定义图片表情（相对 userData 路径，如 assets/xx.png）</p>
            <div className="flex gap-2">
              <input className="h-8 flex-1 rounded-lg border border-black/10 bg-white/90 px-2 text-[13px] outline-none"
                value={newEmojiImage} onChange={(e) => setNewEmojiImage(e.target.value)} placeholder="图片路径" />
              <input className="h-8 w-28 rounded-lg border border-black/10 bg-white/90 px-2 text-[13px] outline-none"
                value={newEmojiName} onChange={(e) => setNewEmojiName(e.target.value)} placeholder="名称" />
              <button className="h-8 px-3 rounded-lg bg-blue-500 text-white text-[12px] hover:bg-blue-600"
                onClick={addImageEmoji}>添加</button>
            </div>

            <div className="mt-3 flex flex-wrap gap-2 items-center">
              {editEmojis.map((e, i) => (
                <span key={i} className="inline-flex items-center gap-1 bg-white/90 rounded-full px-2.5 py-1 text-[12px] text-slate-700 border border-black/5">
                  {e.image ? '🖼' : <BuiltinEmoji type={e.key} size={14} />}
                  {e.name}
                  <button className="text-slate-400 hover:text-red-500" onClick={() => deleteBubble(editTexts.length + i)}>×</button>
                </span>
              ))}
            </div>

            <div className="flex justify-end gap-2 mt-5">
              <button className="h-8 px-4 rounded-lg text-[13px] text-slate-600 hover:bg-black/5"
                onClick={() => setBubbleDialog(false)}>取消</button>
              <button className="h-8 px-4 rounded-lg bg-blue-500 text-white text-[13px] hover:bg-blue-600"
                onClick={() => void saveBubbles()}>保存</button>
            </div>
          </div>
        </div>
      )}
    </PageShell>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="glass-card rounded-2xl p-4">
      <p className="text-[14px] font-medium text-slate-800 mb-3">{title}</p>
      {children}
    </div>
  )
}

/** 软件更新面板（GitHub Releases 源）：当前版本 / 自动检查开关 / 手动检查 / 下载安装 */
function UpdaterPanel({ settings, saveSettings, showToast }: {
  settings: PetSettingsData | null
  saveSettings: (patch: Partial<PetSettingsData>) => Promise<void>
  showToast: (msg: string, error?: boolean) => void
}) {
  const [state, setState] = useState<UpdateState | null>(null)

  useEffect(() => {
    // 初始拉取状态 + 订阅主进程推送（检查中/可更新/下载进度/就绪/错误）
    void window.api.update.getState().then(setState)
    const un = window.api.update.onStatus(setState)
    return un
  }, [])

  const phase = state?.phase ?? 'idle'
  const busy = phase === 'checking' || phase === 'downloading'

  const checkNow = async () => {
    const s = await window.api.update.check()
    if (s.phase === 'up-to-date') showToast(`已是最新版本（${s.currentVersion}）`)
    else if (s.phase === 'available') showToast(`发现新版本 ${s.latestVersion}`)
    // error 状态经 onStatus 推送展示，无需重复 toast
  }
  const download = async () => {
    const s = await window.api.update.download()
    if (s.phase === 'ready-to-install') showToast('更新包已下载，可安装')
  }

  return (
    <Section title="软件更新">
      {/* 当前版本与远端版本 */}
      <div className="flex items-center gap-4 text-[13px] text-slate-600">
        <span>当前版本 <b className="text-slate-800">{state?.currentVersion ?? '…'}</b></span>
        {(phase === 'available' || phase === 'downloading' || phase === 'ready-to-install') && (
          <span>最新版本 <b className="text-blue-600">{state?.latestVersion}</b></span>
        )}
        {phase === 'up-to-date' && <span className="text-green-600">已是最新</span>}
      </div>

      {/* 自动检查开关 */}
      <label className="flex items-center gap-2 text-[13px] text-slate-600 mt-3">
        <input type="checkbox" className="w-4 h-4"
          checked={settings?.autoCheckEnabled === true}
          onChange={(e) => void saveSettings({ autoCheckEnabled: e.target.checked })} />
        后台自动检查更新（每 24 小时一次）
      </label>

      {/* 更新源说明（定向到官方仓库，不可配置） */}
      <p className="text-[12px] text-slate-400 mt-3">
        更新源：github.com/libaidaidetang/ballnote
      </p>

      {/* 操作区：检查 / 下载 / 安装 + 进度与错误 */}
      <div className="flex items-center gap-3 mt-4">
        <button className="h-9 px-5 rounded-lg bg-blue-500 text-white text-[13px] hover:bg-blue-600 active:scale-95 transition disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={busy}
          onClick={() => void checkNow()}>
          {phase === 'checking' ? '检查中…' : '检查更新'}
        </button>
        {(phase === 'available' || phase === 'error' && !!state?.filePath) && (
          <button className="h-9 px-5 rounded-lg bg-blue-500 text-white text-[13px] hover:bg-blue-600 active:scale-95 transition disabled:opacity-50"
            disabled={busy}
            onClick={() => void download()}>
            下载更新
          </button>
        )}
        {phase === 'downloading' && (
          <span className="text-[12px] text-slate-500">
            下载中 {state?.progressPercent != null ? `${state.progressPercent}%` : ''}
          </span>
        )}
        {phase === 'ready-to-install' && (
          <div className="flex items-center gap-2">
            <button className="h-9 px-5 rounded-lg bg-green-500 text-white text-[13px] hover:bg-green-600 active:scale-95 transition"
              onClick={() => void window.api.update.install()}>
              安装并重启
            </button>
            <span className="text-[11px] text-slate-400">安装前会自动备份笔记数据</span>
          </div>
        )}
        {phase === 'error' && (
          <span className="text-[12px] text-red-500 truncate max-w-[320px]" title={state?.error}>
            {state?.error ?? '检查失败'}
          </span>
        )}
      </div>

      {/* release 说明（可展开滚动） */}
      {state?.releaseNotes && (phase === 'available' || phase === 'ready-to-install') && (
        <details className="mt-3">
          <summary className="text-[12px] text-slate-500 cursor-pointer select-none">更新说明</summary>
          <pre className="text-[12px] text-slate-600 whitespace-pre-wrap break-words max-h-40 overflow-y-auto mt-1">{state.releaseNotes}</pre>
        </details>
      )}
      {state?.releaseUrl && (
        <p className="text-[11px] text-slate-400 mt-2">
          发布页：{state.releaseUrl}（浏览器打开后可手动下载）
        </p>
      )}
    </Section>
  )
}

/** 开关（补充设置项用） */
function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      className={`w-10 h-6 rounded-full transition-colors relative ${checked ? 'bg-blue-500' : 'bg-slate-300'}`}
      onClick={() => onChange(!checked)}
    >
      <span
        className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`}
      />
    </button>
  )
}

/** 完整日历（自首周周一到今天；行 = 周，列 = 周一到周日） */
function CalendarGrid({
  ranges, books, thoughts, cal, todayKey,
}: {
  ranges: { first: Date; weeks: number }
  books: BookStore | null
  thoughts: ThoughtStoreData | null
  cal: CalendarData
  todayKey: string
}) {
  const weekNames = ['一', '二', '三', '四', '五', '六', '日']
  const today = toDate(todayKey)
  const cells: { day: Date; key: string }[] = []
  for (let w = 0; w < ranges.weeks; w++) {
    for (let d = 0; d < 7; d++) {
      const day = new Date(ranges.first)
      day.setDate(ranges.first.getDate() + w * 7 + d)
      if (day > today) continue
      cells.push({ day, key: dateKey(day) })
    }
  }
  return (
    <div className="overflow-x-auto">
      <table className="border-separate" style={{ borderSpacing: 3 }}>
        <thead>
          <tr>
            <th className="w-9 text-[11px] text-slate-400 font-normal" />
            {weekNames.map((w) => <th key={w} className="w-5 text-[11px] text-slate-400 font-normal">{w}</th>)}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: ranges.weeks }).map((_, w) => {
            const rowStart = new Date(ranges.first)
            rowStart.setDate(ranges.first.getDate() + w * 7)
            const prev = new Date(rowStart)
            prev.setDate(rowStart.getDate() - 1)
            const month = w === 0 || rowStart.getMonth() !== prev.getMonth() ? `${rowStart.getMonth() + 1}月` : ''
            return (
              <tr key={w}>
                <td className="text-[11px] text-slate-400 text-center">{month}</td>
                {weekNames.map((_, d) => {
                  const day = new Date(rowStart)
                  day.setDate(rowStart.getDate() + d)
                  if (day > today) return <td key={d} />
                  const key = dateKey(day)
                  return (
                    <td key={d} className="p-0">
                      <DayDot day={day} work={workCount(key, books, thoughts, cal)} isToday={key === todayKey}
                        tooltip={dayTooltip(key, books, thoughts, cal)} />
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** 计算日历范围：首周周一到今天（对齐 WPF BuildFullCalendar） */
function useCalendarRanges(cal: CalendarData | null, todayKey: string): { first: Date; weeks: number } {
  const [range, setRange] = useState({ first: mondayOf(new Date()), weeks: 1 })
  useEffect(() => {
    if (!cal?.firstMonday) {
      // 首次运行：初始化前必须先确认磁盘上确实没有日历数据——组件刚挂载时 calData
      // 还没异步加载完（state 必为 null），若此时无条件覆盖写入会把已有 days 统计整包清空
      void (async () => {
        const disk = await window.api.store.load<CalendarData>('calendar')
        if (disk?.firstMonday) return   // 磁盘有真实数据：不初始化，等 state 同步后走下方正常分支
        const today = toDate(todayKey)
        const first = mondayOf(today)
        await saveStore('calendar', {
          firstMonday: dateKey(first),
          startDate: todayKey,
          days: {},
        })
        setRange({ first, weeks: 1 })
      })()
      return
    }
    const first = toDate(cal.firstMonday)
    const today = toDate(todayKey)
    const diffDays = Math.floor((today.getTime() - first.getTime()) / 86400000)
    setRange({ first, weeks: Math.max(1, Math.floor(diffDays / 7) + 1) })
  }, [cal, todayKey])
  return range
}
