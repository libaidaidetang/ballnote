import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { StoreKey, WindowKind } from '../shared/models'

type Unsub = () => void

function on<T>(channel: string, cb: (payload: T) => void): Unsub {
  const l = (_e: IpcRendererEvent, p: T) => cb(p)
  ipcRenderer.on(channel, l)
  return () => { ipcRenderer.removeListener(channel, l) }
}

const api = {
  windowKind: (): WindowKind => {
    // \w+ 不匹配连字符：book-detail 会被截成 book 导致路由落到默认悬浮球，
    // 故用 [\w-]+ 允许窗口类型含连字符
    const m = location.hash.match(/window\/([\w-]+)/)
    return (m?.[1] as WindowKind) ?? 'ball'
  },

  store: {
    load: <T>(key: StoreKey): Promise<T> => ipcRenderer.invoke('store:load', key) as Promise<T>,
    save: <T>(key: StoreKey, data: T): Promise<{ ok: boolean; error?: string; data: T }> =>
      ipcRenderer.invoke('store:save', key, data) as Promise<{ ok: boolean; error?: string; data: T }>,
    onChanged: (key: StoreKey, cb: () => void): Unsub =>
      on<string>('store:changed', (k) => { if (k === key) cb() }),
  },

  ball: {
    pointer: (type: 'down' | 'move' | 'up', screenX: number, screenY: number): Promise<{ moved: boolean }> =>
      ipcRenderer.invoke('ball:pointer', { type, screenX, screenY }),
    singleClick: (): void => ipcRenderer.send('ball:single-click'),
    hover: (state: 'enter' | 'leave'): void => ipcRenderer.send('ball:hover', state),
    toggleMenu: (): void => ipcRenderer.send('ball:toggle-menu'),
    getWorkArea: (): Promise<Electron.Rectangle> => ipcRenderer.invoke('ball:work-area'),
    getBounds: (): Promise<Electron.Rectangle> => ipcRenderer.invoke('ball:bounds'),
    onPetTypeChanged: (cb: (t: string) => void): Unsub => on<string>('pet-type-changed', cb),
  },

  menu: {
    clickItem: (action: string): void => ipcRenderer.send('menu:item-click', action),
    onSetItems: (cb: (data: { items: { title: string; action: string }[]; toRight: boolean }) => void): Unsub =>
      on('menu:set-items', cb),
  },

  page: {
    minimize: (): void => ipcRenderer.send('page:minimize'),
    maximizeToggle: (): void => ipcRenderer.send('page:maximize-toggle'),
    close: (): void => ipcRenderer.send('page:close'),
    resize: (type: 'down' | 'move' | 'up', screenX: number, screenY: number, dir: import('../shared/models').ResizeDir): void =>
      ipcRenderer.send('page:resize-pointer', { type, screenX, screenY, dir }),
    /** 窗口即将关闭：主进程要求渲染层 flush 全部脏笔记草稿 */
    onFlushDrafts: (cb: () => void): Unsub => on('page:flush-drafts', cb),
    /** 草稿 flush 完成，通知主进程可以真正关闭窗口 */
    flushDone: (): void => ipcRenderer.send('page:flush-done'),
    /** 最大化状态变化（系统 maximize/unmaximize 事件：按钮点击与拖到顶部贴靠都会触发） */
    onMaximized: (cb: (m: boolean) => void): Unsub => on<boolean>('page:maximized', cb),
  },

  sticky: {
    open: (): void => ipcRenderer.send('sticky:open'),
    edit: (id: number): void => ipcRenderer.send('sticky:edit', id),
    count: (): Promise<number> => ipcRenderer.invoke('sticky:count'),
    setPinned: (pinned: boolean): void => ipcRenderer.send('sticky:set-pinned', pinned),
    onEditId: (cb: (id: number | null) => void): Unsub => on<number | null>('sticky:edit-id', cb),
  },

  note: {
    copy: (text: string): Promise<boolean> => ipcRenderer.invoke('note:copy', text),
    /** 导出笔记：保存对话框默认进"文档"文件夹，文件名 = 标题；返回 { ok, path | canceled | error } */
    exportFile: (req: {
      title: string
      format: 'png' | 'txt' | 'docx' | 'md' | 'html'
      text: string
      markdown?: string
      html?: string
      pngDataUrl?: string
      lines?: import('../shared/models').NoteExportLinePayload[]
    }): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }> =>
      ipcRenderer.invoke('note:export-file', req),
    /** 导出到临时文件夹（无对话框，供系统共享回退使用） */
    exportTemp: (req: {
      title: string
      format: 'png' | 'txt' | 'docx' | 'md' | 'html'
      pngDataUrl?: string
      text?: string
      markdown?: string
      html?: string
      lines?: import('../shared/models').NoteExportLinePayload[]
    }): Promise<{ ok: boolean; path?: string; error?: string }> => ipcRenderer.invoke('note:export-temp', req),
    /** 在资源管理器中选中文件（Windows"共享"回退入口） */
    showInFolder: (p: string): Promise<boolean> => ipcRenderer.invoke('note:show-in-folder', p),
  },

  bubble: {
    show: (content: { type: 'text'; text: string } | { type: 'emoji'; key: string; image?: string }, toRight: boolean): void =>
      ipcRenderer.send('ball:bubble', { content, toRight }),
    hide: (): void => ipcRenderer.send('bubble:hide'),
    onShow: (cb: (data: { content: { type: 'text'; text: string } | { type: 'emoji'; key: string; image?: string }; toRight: boolean }) => void): Unsub =>
      on('bubble:show', cb),
  },

  assetUrl: (relPath: string): Promise<string> => ipcRenderer.invoke('asset:url', relPath),

  books: {
    searchDouban: (keyword: string): Promise<import('../shared/models').BookSearchResult[]> =>
      ipcRenderer.invoke('book:search-douban', keyword),
    searchWeread: (keyword: string): Promise<import('../shared/models').BookSearchResult[]> =>
      ipcRenderer.invoke('book:search-weread', keyword),
    /** 抓取豆瓣详情页目录（章节信息；无目录返回空数组） */
    fetchChapters: (url: string): Promise<string[]> => ipcRenderer.invoke('book:fetch-chapters', url),
    /** 打包书籍（保存对话框，默认进"文档"）；RAR 未装时自动回退 ZIP */
    pack: (bookId: number, format: 'zip' | 'rar'): Promise<{ ok: boolean; path?: string; canceled?: boolean; rarMissing?: boolean; usedRar?: boolean; error?: string }> =>
      ipcRenderer.invoke('book:pack', { bookId, format }),
    /** 打包书籍到临时目录（分享用） */
    packTemp: (bookId: number, format: 'zip' | 'rar'): Promise<{ ok: boolean; path?: string; rarMissing?: boolean; usedRar?: boolean; error?: string }> =>
      ipcRenderer.invoke('book:pack-temp', { bookId, format }),
    /** 多本打包（多选管理导出） */
    packMulti: (bookIds: number[], format: 'zip' | 'rar'): Promise<{ ok: boolean; path?: string; canceled?: boolean; rarMissing?: boolean; usedRar?: boolean; error?: string }> =>
      ipcRenderer.invoke('book:pack-multi', { bookIds, format }),
    /** 多本打包到临时目录（多选管理分享） */
    packMultiTemp: (bookIds: number[], format: 'zip' | 'rar'): Promise<{ ok: boolean; path?: string; rarMissing?: boolean; usedRar?: boolean; error?: string }> =>
      ipcRenderer.invoke('book:pack-multi-temp', { bookIds, format }),
  },

  time: {
    getToday: (): Promise<string> => ipcRenderer.invoke('time:get-today'),
    onSynced: (cb: () => void): Unsub => on('time:synced', cb),
  },

  files: {
    saveCover: (dataUrl: string, ext: string): Promise<string | null> =>
      ipcRenderer.invoke('file:save-cover', dataUrl, ext),
    /** 笔记图片落盘（返回 userData 相对路径，避免 dataURL 内嵌进笔记内容） */
    saveNoteImage: (dataUrl: string, ext: string): Promise<string | null> =>
      ipcRenderer.invoke('file:save-note-image', dataUrl, ext),
  },

  ai: {
    chat: (input: string): Promise<string> => ipcRenderer.invoke('ai:chat', input),
    review: (notes: { title: string; content: string; createdAt: string }[]): Promise<string> =>
      ipcRenderer.invoke('ai:review', notes),
  },

  app: {
    restart: (): void => ipcRenderer.send('app:restart'),
    quit: (): void => ipcRenderer.send('app:quit'),
  },

  update: {
    getState: (): Promise<import('../shared/models').UpdateState> => ipcRenderer.invoke('update:get-state'),
    check: (): Promise<import('../shared/models').UpdateState> => ipcRenderer.invoke('update:check'),
    download: (): Promise<import('../shared/models').UpdateState> => ipcRenderer.invoke('update:download'),
    install: (): Promise<boolean> => ipcRenderer.invoke('update:install'),
    /** 状态变化推送（检查中/可更新/下载进度/就绪/错误） */
    onStatus: (cb: (s: import('../shared/models').UpdateState) => void): Unsub =>
      on<import('../shared/models').UpdateState>('update:status', cb),
  },
}

contextBridge.exposeInMainWorld('api', api)
export type BallApi = typeof api
