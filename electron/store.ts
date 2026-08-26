import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type {
  AIConfig, BookStore, BubbleConfig, CalendarData, FolderStoreData, LibrarySettingsData,
  MenuConfig, NoteDraftsData, PetCatalogData, PetSettingsData, StoreKey, ThoughtStoreData,
} from '../shared/models'

// ===== 数据目录：userData/config/*.json（全新数据，格式与 WPF 兼容） =====
// 不读取 WPF 旧版运行目录数据，避免混用。

const configDir = () => path.join(app.getPath('userData'), 'config')

/** IPC 通道传来的 key 是运行时不可信字符串：白名单校验，拒绝 "../" 等路径穿越 */
function assertValidKey(key: StoreKey): void {
  if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
    throw new Error(`非法的存储 key: ${String(key)}`)
  }
}

function fileOf(key: StoreKey): string {
  assertValidKey(key)
  return path.join(configDir(), `${key}.json`)
}

function read<T>(key: StoreKey, fallback: T): T {
  try {
    const p = fileOf(key)
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf-8')
      if (raw.trim()) return JSON.parse(raw) as T
    }
  } catch {
    // 配置损坏：先把坏文件改名留档（供人工恢复），再回退默认值。
    // 否则界面显示空数据后，下一次保存会用默认值永久覆盖原文件，数据丢失被放大。
    try {
      const p = fileOf(key)
      fs.renameSync(p, `${p}.corrupt-${Date.now()}`)
    } catch { /* 留档失败不影响回退 */ }
  }
  return fallback
}

// ===== 串行写队列：同一文件写操作排队，避免并发覆盖（后写覆盖先写导致丢数据） =====
let writeChain: Promise<void> = Promise.resolve()

function write(key: StoreKey, data: unknown): Promise<void> {
  const p = fileOf(key)
  const tmp = `${p}.tmp`
  // catch 上一次失败：写失败抛错给本次调用方，但不阻断后续排队写入
  return writeChain = writeChain.catch(() => {}).then(() => {
    fs.mkdirSync(configDir(), { recursive: true })
    // 原子写：先写临时文件再 rename（同目录 rename 原子），避免写一半崩溃损坏配置
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
    fs.renameSync(tmp, p)
  })
}

// ===== 默认值（与 WPF 版 DefaultItems/DefaultData 一致） =====

const defaultMenus: MenuConfig = {
  items: [
    { title: '图书馆', action: 'library' },
    { title: '智能勾画', action: 'sketch' },
    { title: 'AI辅助', action: 'ai' },
    { title: '设置', action: 'settings' },
  ],
}

const defaultPetTypes: PetCatalogData = {
  types: [
    { key: 'glass', name: '玻璃球', image: '' },
    { key: 'black', name: '小黑球', image: 'assets/blackball.png', zoom: 0.7 },
    { key: 'logo', name: 'logo球', image: 'assets/faya.png' },
  ],
  forms: [
    { key: 'ball', name: '悬浮球' },
    { key: 'animal', name: '小动物' },
    { key: 'character', name: 'Q版人物' },
  ],
}

const defaultBubbles: BubbleConfig = {
  texts: ['喵~', '嘿~', '呼噜~', '舒服~', '(*￣ω￣)', '(≧▽≦)', '(●´ω｀●)', 'ヾ(≧▽≦*)o'],
  emojis: [
    { key: 'wink', name: '眨眼' },
    { key: 'heart', name: '爱心' },
    { key: 'blush', name: '害羞' },
    { key: 'cool', name: '墨镜' },
  ],
}

const defaultAi: AIConfig = {
  enabled: true,
  baseUrl: 'https://api.deepseek.com',
  apiKey: '', // 密钥由用户自填（勿内置）
  model: 'deepseek-v4-flash',
}

const defaultSettings: PetSettingsData = {
  petType: 'glass', mistEffect: 'none',
  accentColor: '#3388FF', edgeHideEnabled: true, snapEnabled: true, bubbleDurationMs: 1500,
}
const defaultLibrary: LibrarySettingsData = { sortOrder: 'newest', cardWidth: 140, tabSwitchMode: 'loop' }

const DEFAULTS: Record<StoreKey, unknown> = {
  menus: defaultMenus,
  petTypes: defaultPetTypes,
  bubbles: defaultBubbles,
  ai: defaultAi,
  settings: defaultSettings,
  books: (): BookStore => ({ books: [] }),
  thoughts: (): ThoughtStoreData => ({ thoughts: [] }),
  calendar: (): CalendarData => ({ firstMonday: '', startDate: '', days: {} }),
  library: defaultLibrary,
  'note-drafts': (): NoteDraftsData => ({ drafts: {} }),
  folders: (): FolderStoreData => ({ folders: [] }),
}

/** 读取配置（文件缺失/损坏回退默认）。petTypes 运行时不变，直接缓存。 */
export function loadStore<T>(key: StoreKey): T {
  assertValidKey(key)
  const def = DEFAULTS[key]
  const fallback = (typeof def === 'function' ? (def as () => unknown)() : def) as T
  return read(key, fallback)
}

/** 保存配置（串行原子写）并返回完整数据（供广播）；写失败抛错由调用方处理。 */
export async function saveStore<T>(key: StoreKey, data: T): Promise<T> {
  assertValidKey(key)
  await write(key, data)
  return data
}

// ===== 窗口尺寸持久化（windows.json，按页面 kind 存） =====
const winSizesFile = () => path.join(app.getPath('userData'), 'windows.json')

export function loadWindowSizes(): Record<string, { width: number; height: number }> {
  try {
    const p = winSizesFile()
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch {
    // 损坏忽略
  }
  return {}
}

export function saveWindowSize(kind: string, width: number, height: number): void {
  try {
    const all = loadWindowSizes()
    all[kind] = { width, height }
    fs.mkdirSync(path.dirname(winSizesFile()), { recursive: true })
    fs.writeFileSync(winSizesFile(), JSON.stringify(all, null, 2), 'utf-8')
  } catch {
    // 写失败静默（本次会话不影响）
  }
}

export { configDir }
