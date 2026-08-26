// 共享数据模型：与 WPF 版 JSON 格式保持兼容（camelCase 字段名）

export interface Note {
  id: number
  title: string
  content: string
  /** 所属章节名（默认"未分类"） */
  chapter: string
  tags: string[]
  createdAt: string
}

export interface Book {
  id: number
  title: string
  author: string
  /** 出版社（选书导入补充） */
  publisher?: string
  /** 版本/版次（如"第 3 版"；选书导入补充） */
  edition?: string
  description: string
  /** 封面占位主题色 #RRGGBB */
  coverColor: string
  /** 封面图片（本地路径或远程 URL，空则渐变占位） */
  cover: string | null
  tags: string[]
  createdAt: string
  notes: Note[]
  /** 用户自建章节（含无笔记的空白章节）；笔记的 chapter 字段引用同名章节 */
  chapters?: string[]
  /** 收藏标记；旧数据缺省 = 未收藏 */
  starred?: boolean
  /** 置顶标记；所有视图生效，置顶 > 收藏 > 时间倒序 */
  pinned?: boolean
}

export interface BookStore {
  books: Book[]
}

export interface Thought {
  id: number
  content: string
  createdAt: string
  /** 收藏标记；旧数据缺省 = 未收藏 */
  starred?: boolean
  /** 置顶标记；置顶排前，置顶 > 收藏 > 时间倒序 */
  pinned?: boolean
}

export interface ThoughtStoreData {
  thoughts: Thought[]
}

export interface DayActivity {
  thoughts: number
  thoughtsProcessed: number
  reviews: number
  reviewsUpdated: number
}

export interface CalendarData {
  firstMonday: string
  startDate: string
  /** key = yyyy-MM-dd */
  days: Record<string, DayActivity>
}

export interface MenuItemModel {
  title: string
  action: string
}

export interface MenuConfig {
  items: MenuItemModel[]
}

export interface PetCatalogItem {
  key: string
  name: string
  /** 相对 userData 的图片路径；缺省表示默认玻璃球 */
  image?: string
  /** 中心裁剪比例（0.7 = 中心 70%），默认 1 整图 */
  zoom?: number
}

export interface PetCatalogData {
  types: PetCatalogItem[]
  forms: PetCatalogItem[]
}

export interface BubbleEmojiItem {
  key: string
  name: string
  /** 自定义图片表情路径；空表示内置矢量表情（key 引用） */
  image?: string
}

export interface BubbleConfig {
  texts: string[]
  emojis: BubbleEmojiItem[]
}

export interface AIConfig {
  enabled: boolean
  baseUrl: string
  apiKey: string
  model: string
}

/** 软件更新状态机（主进程 updater 模块维护，经 IPC 广播给渲染层） */
export interface UpdateState {
  phase: 'idle' | 'checking' | 'available' | 'up-to-date' | 'downloading' | 'ready-to-install' | 'error'
  /** 当前安装的版本（app.getVersion()） */
  currentVersion: string
  /** 远端最新版本（release tag_name） */
  latestVersion?: string
  /** release 说明（Markdown 文本，截断至 2000 字符） */
  releaseNotes?: string
  /** release 页面链接 */
  releaseUrl?: string
  progressPercent?: number
  downloadedBytes?: number
  totalBytes?: number
  /** 已下载的安装包路径（ready-to-install 阶段有效） */
  filePath?: string
  error?: string
}

export interface PetSettingsData {
  petType: string
  mistEffect: string
  /** 光晕主题色 #RRGGBB（外观设置） */
  accentColor?: string
  /** 贴边收起开关（功能设置） */
  edgeHideEnabled?: boolean
  /** 单击吸附开关（功能设置） */
  snapEnabled?: boolean
  /** 抚摸气泡显示时长 ms（功能设置） */
  bubbleDurationMs?: number
  /** 软件更新：后台自动检查开关（默认关） */
  autoCheckEnabled?: boolean
  /** 软件更新：GitHub 仓库 owner/repo，空用内置默认值 */
  updateRepo?: string
  /** 软件更新：安装时静默执行（NSIS /S），默认交互式 */
  updateSilent?: boolean
}

export interface LibrarySettingsData {
  sortOrder: 'newest' | 'oldest'
  cardWidth: number
  /** 标签页切换模式：loop 循环（首尾相接）/ fixed 固定（边界不可切换） */
  tabSwitchMode?: 'loop' | 'fixed'
}

/** 笔记草稿（会话自动保存：关闭软件不提醒，重开恢复内容与光标位置） */
export interface NoteDraft {
  /** 内容：Lexical EditorState JSON 字符串 */
  content: string
  /** 光标/选区位置（编辑器恢复用，序列化的 RangeSelection） */
  selection: string | null
  /** 更新时间戳 */
  updatedAt: number
}

/** 草稿存储（Config/note-drafts.json），key = `${bookId}:${noteId | 'new'}` */
export interface NoteDraftsData {
  drafts: Record<string, NoteDraft>
}

/** 商店可读写的配置键 */
export type StoreKey =
  | 'menus' | 'petTypes' | 'bubbles' | 'ai' | 'settings'
  | 'books' | 'thoughts' | 'calendar' | 'library' | 'note-drafts' | 'folders'

/** 功能页类型（对应 PageRegistry 的 key） */
export type PageKind = 'library' | 'sketch' | 'ai' | 'settings'

/** 窗口类型（hash 路由用） */
export type WindowKind = 'ball' | 'menu' | 'page' | 'sticky' | 'book-detail' | 'bubble' | 'note-editor'

/** 窗口 8 方向 resize 方向 */
export type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/** 书籍搜索结果（选书导入） */
export interface BookSearchResult {
  title: string
  author: string
  /** 出版社（微信读书等源提供） */
  publisher?: string
  /** 版本/版次（部分源含在斜杠合并字段中） */
  edition?: string
  description: string
  coverUrl: string
  /** 详情页链接（豆瓣；用于抓取章节信息） */
  url?: string
}

/** 笔记导出用结构化行（渲染层 → 主进程 docx 生成；image 为 dataURL 或 http URL） */
export interface NoteExportLinePayload {
  text: string
  image: string | null
  checked: boolean | null
}

/** 书籍文件夹（手机桌面式分组；一本书仅属于一个文件夹） */
export interface FolderData {
  id: number
  name: string
  /** 文件夹内书籍 id 列表 */
  bookIds: number[]
  createdAt: string
}

export interface FolderStoreData {
  folders: FolderData[]
}
