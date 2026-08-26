import { loadStore } from './store'
import type { AIConfig } from '../shared/models'

/**
 * AI 服务（主进程代理，绕开浏览器 CORS）：读 ai.json——
 * 启用且已填 API Key 时走远程 OpenAI 兼容协议，否则本地规则模拟（对齐 WPF LocalAIService）。
 */

interface ReviewNote { title: string; content: string; createdAt: string }

function cfg(): AIConfig {
  return loadStore<AIConfig>('ai')
}

async function callRemote(messages: { role: string; content: string }[]): Promise<string> {
  const c = cfg()
  try {
    // baseUrl 来自可写存储：仅允许 https（防被诱导把 Bearer apiKey 发往任意 http/内网地址）
    if (!/^https:\/\//i.test(c.baseUrl.trim())) {
      return '（接口地址必须为 https://，请在设置中修正）'
    }
    const resp = await fetch(`${c.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${c.apiKey}`,
      },
      body: JSON.stringify({ model: c.model, messages, stream: false }),
      signal: AbortSignal.timeout(30000),
    })
    if (!resp.ok) {
      return `（模型服务返回错误：${resp.status}，请检查 API Key 与模型名）`
    }
    const json = await resp.json() as { choices?: { message?: { content?: string } }[] }
    return json.choices?.[0]?.message?.content?.trim() || '（模型无回复）'
  } catch (e) {
    if ((e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError') {
      return '（请求超时：请检查网络连接后重试）'
    }
    return '（无法连接模型服务：请检查网络与配置）'
  }
}

/** 本地规则模拟（对齐 WPF LocalAIService.ChatAsync） */
function localChat(input: string): string {
  const text = input.trim()
  if (!text) return '请输入内容后与我对话。'
  if (text.includes('你好') || text.toLowerCase().includes('hi')) {
    return '你好！我是你的本地 AI 助手，可以帮你梳理笔记、生成回顾。'
  }
  if (text.includes('回顾') || text.includes('总结')) {
    return '我可以用「每日回顾」帮你总结笔记——到侧边栏「每日回顾」页面点击生成即可。'
  }
  if (text.includes('笔记') || text.includes('记录')) {
    return '点击右下角 + 可快速新增笔记；支持标签与搜索，方便日后回顾。'
  }
  return `已收到你的想法：「${text}」。当前为本地模拟模式，接入真实模型后将给出更智能的回答。`
}

/** 本地规则生成每日回顾（对齐 WPF LocalAIService.GenerateReviewAsync） */
function localReview(list: ReviewNote[]): string {
  if (list.length === 0) return '今天还没有记录任何笔记。试着点击右下角 + 记下第一个想法吧。'
  const out: string[] = []
  out.push(`📊 今日总结：共记录了 ${list.length} 条笔记。`)
  const recent = [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 3)
  out.push('', '🕐 最近记录：')
  for (const n of recent) {
    out.push(`  · ${n.title}（${new Date(n.createdAt).toLocaleString('zh-CN')}）`)
  }
  const words = list
    .flatMap((n) => `${n.title} ${n.content}`.split(/[\s，。、,.:：（）()\n\r]/))
    .filter((w) => w.length >= 2)
    .reduce<Record<string, number>>((acc, w) => { acc[w] = (acc[w] ?? 0) + 1; return acc }, {})
  const top = Object.entries(words).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([w]) => w)
  if (top.length > 0) out.push('', '🔑 关键词：' + top.join(' / '))
  return out.join('\n')
}

export async function aiChat(input: string): Promise<string> {
  const c = cfg()
  if (c.enabled && c.apiKey.trim()) {
    return callRemote([
      { role: 'system', content: '你是 BallWork 桌宠的 AI 助手，回答简洁、有帮助、使用中文。' },
      { role: 'user', content: input.trim() },
    ])
  }
  return localChat(input)
}

export async function aiReview(notes: ReviewNote[]): Promise<string> {
  const c = cfg()
  if (c.enabled && c.apiKey.trim()) {
    const brief = notes.length === 0
      ? '今天没有任何笔记。'
      : notes.map((n) => `- ${n.title}（${new Date(n.createdAt).toLocaleString('zh-CN')}）：${truncate(n.content, 80)}`).join('\n')
    return callRemote([
      { role: 'system', content: '你是用户的笔记助手，生成简洁、有条理的每日回顾。' },
      { role: 'user', content: `以下是用户今日的笔记：\n${brief}\n\n请生成一份「每日回顾」：总结今日重点、提炼关键词，语气温和鼓励，使用中文。` },
    ])
  }
  return localReview(notes)
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '…'
}
