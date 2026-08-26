# BallWork（Electron 重写版）

桌面悬浮球工作站的 Electron + React 19 + TypeScript + Vite + TailwindCSS 重写版（`ball_re/`），
原 WPF 版（`BallWork/`）保持不变。数据**全新独立**（存于 userData，不读 WPF 旧数据），JSON 格式与 WPF 版兼容。

## 运行

```bash
npm install          # 首次安装（electron 二进制下载失败时：
                     #   set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ && node node_modules/electron/install.js）
npm run dev          # 开发模式（vite dev server + electron 热载入）
npm run build        # 生产构建（tsc 类型检查 + vite build + esbuild 主进程）
npm start            # 构建后启动
npm run dist         # 本地打包 Windows NSIS 安装包（输出 release/；通常由 GitHub Actions 完成）
```

## 发布与自动更新（GitHub Releases）

正式发布不需要在本地上传安装包。详细的更新机制、数据保护/恢复和 GitHub Actions 发版步骤见：[更新与发布说明](docs/更新与发布说明.md)。推送匹配 `v*.*.*` 的 tag（例如 `v0.1.0`）会触发
`.github/workflows/release-windows.yml`：GitHub Actions 在 `windows-latest` 上执行构建、生成 NSIS
安装包、`latest.yml` 和 `.blockmap`，并自动创建/更新 GitHub Release、上传全部更新资产。

```bash
# 先把 package.json 的 version 改为 0.1.1，并提交代码
# 然后创建与 version 完全一致的 tag（v 前缀）并推送：
git tag v0.1.1
git push origin v0.1.1
```

应用内使用 `electron-updater` 的 GitHub provider 查询
`libaidaidetang/ballnote`。策略为：后台自动检查（用户在设置中启用）+ 用户手动下载和确认安装；
`latest.yml/.blockmap` 提供文件校验和差分下载，下载后由 NSIS 标准替换流程安装。Release 必须是正式
Release（非 Draft、非 Pre-release），且 tag 必须与 package.json 的 version 一致。

## 目录结构

```
ball_re/
├── electron/            # 主进程
│   ├── main.ts          # 入口：单实例/托盘/窗口管理/IPC 注册
│   ├── windows.ts       # 窗口工厂 + 窗口动画（贴边/吸附/入场）
│   ├── edge.ts          # 贴边收起/吸附/禁区状态机
│   ├── store.ts         # JSON 配置读写（userData/config/*.json）
│   ├── ai.ts            # AI 服务（主进程代理，远程 OpenAI 兼容 / 本地规则模拟）
│   └── preload.ts       # contextBridge 安全通道（window.api）
├── src/                 # 渲染进程（React）
│   ├── windows/         # 按窗口分发：Ball / Menu / Bubble / Sticky / BookDetail
│   ├── pages/           # 功能页：Library / Settings / Placeholder
│   ├── components/      # 共享组件（PageShell/Icon/Emoji/Calendar）
│   └── lib/             # 工具（markdown 渲染）
├── shared/models.ts     # 主/渲染共享数据模型（JSON 结构 = WPF 兼容）
└── assets/              # 桌宠图片（faya.png / blackball.png，从原项目复制）
```

## 窗口架构（对齐 WPF PageWindow 多窗口方案）

| 窗口 | 说明 |
|---|---|
| BallWindow | 80×80 透明无边框置顶；拖拽/单击吸附/双击抚摸/右键菜单 |
| MenuWindow | 165×300 透明扇形菜单（双层弧线，方向自适应，每次展开重读 menus.json 热重载） |
| PageWindow | 功能页 1200×800（library/settings/sketch/ai 占位），多页面并存 |
| StickyWindow | 闪念便利贴小窗（图钉置顶 / Ctrl+Enter 保存） |
| BubbleWindow | 抚摸气泡（文字/内置矢量表情/图片表情） |
| BookDetailWindow | 书籍详情（详情 ↔ 章节笔记、Markdown 预览、近 7 日趋势） |

数据变更经主进程 `store:changed` 广播，所有窗口自动刷新（如便利贴新建 → 图书馆闪念列表即时更新）。

## 数据位置

- 用户数据根目录（**跨更新、跨 productName 固定不变**）：`%APPDATA%/ball-re/`
- 配置：`%APPDATA%/ball-re/config/*.json`（menus/petTypes/bubbles/ai/settings/books/thoughts/calendar/library）
- 更新前自动备份：`%APPDATA%/ball-re/backups/pre-update-时间戳/config/`（每次点击「安装并重启」前创建，最近保留 2 份；备份失败则取消安装）
- 上传封面：`%APPDATA%/ball-re/covers/`
- 自定义图片（桌宠/图片表情）：`%APPDATA%/ball-re/assets/`（在 petTypes.json/bubbles.json 填相对路径）
- AI 密钥：编辑 `ai.json` 填 `apiKey`（勿提交仓库）

## 与 WPF 版的功能对应与已知差异

已实现：悬浮球全套（呼吸/漂浮/光晕脉动/悬停鼓起/拖拽果冻/双击抚摸/单击吸附/贴边收起/上下禁区）、
扇形菜单、设置页（桌宠/形态/雾效开关/菜单管理/气泡编辑/操作说明/系统操作/完整日历）、
图书馆（书籍→章节→笔记、搜索/标签/日期筛选、卡片大小与排序、书籍详情窗、选书导入豆瓣读书、
封面上传、闪念便利贴、活跃日历、每日回顾、AI 助手）、托盘、单实例。

按确认的决策，以下为有意差异（后续可迭代）：

1. **拖拽雾效**：仅保留 `none` 开关，渐变雾/粒子雾不重写（原 WPF 已归档暂停）
2. **AI 本地模拟**：保留（同 WPF LocalAIService 规则），填 API Key 后自动走远程模型
3. **选书源**：微信读书为主源（经主进程代理解析），豆瓣读书保留作补全（解析网页，尽力而为，易受反爬影响）

已补齐的迭代项：

- **页面窗口 resize 热点**：8 方向自绘缩放手柄（页窗与书籍详情窗），尺寸按页面 kind 持久化到 `windows.json`，重开恢复
- **联网校时（北京时间）**：主进程启动时同步（苏宁时间接口，失败回退本地），跨天自动重取并广播刷新日历
- **豆瓣选书源**：选书对话框使用豆瓣读书（经主进程代理解析网页，尽力而为，易受反爬影响）；微信读书为主源
- **书籍删除**：书库卡片 hover 显示删除按钮（二次确认，连同全部笔记）
- **笔记删除**：书籍详情窗章节笔记卡片右上角删除（二次确认）
- **AI 配置界面**：设置页「AI 设置」卡片（启用开关 / 接口地址 / API Key 可显隐 / 模型名），保存即生效，不再需要手改 ai.json
- **侧栏统计第三项**：实现真实「连续天数」（今天或昨天起连续有活动——笔记/闪念/回顾——的天数），修正原 WPF 该字段实为书籍数的语义问题
