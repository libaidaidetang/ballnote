/**
 * 联网校时（对齐 WPF TimeSync）：异步获取北京时间（Asia/Shanghai）用于日历"今天"判定。
 * 获取失败回退本地系统时间；跨天（缓存落后本地今天）自动作废缓存并重新校时。
 */
let beijingToday: string | null = null   // 'yyyy-MM-dd'
let inFlight = false
/** 上次校时失败时刻：失败后进入冷却期，避免断网挂机时每次调用都发注定失败的请求 */
let lastFailAt = 0
const FAIL_COOLDOWN_MS = 5 * 60_000

function localKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 当前"今天"（优先网络北京时间，否则本地时间；跨天自动重取）。
 *  重试受冷却期约束：无缓存/缓存作废时仅在距上次失败超过 FAIL_COOLDOWN_MS 才发起，
 *  断网恢复后最迟一个冷却期内自动重新校时。 */
export function getTodayKey(): string {
  const local = localKey(new Date())
  if (beijingToday && beijingToday < local) {
    // 缓存落后本地今天（应用挂机跨过 0 点）：作废并按冷却期重试，期间先回退本地日期
    beijingToday = null
  }
  if (!beijingToday && !inFlight && Date.now() - lastFailAt >= FAIL_COOLDOWN_MS) {
    void sync()
  }
  return beijingToday ?? local
}

/** 校时：返回 true 表示"今天"已变化（主进程据此广播刷新日历）；失败进入冷却期 */
export async function sync(): Promise<boolean> {
  if (inFlight) return false
  inFlight = true
  try {
    const resp = await fetch('https://quan.suning.com/getSysTime.do', { signal: AbortSignal.timeout(3000) })
    if (!resp.ok) { lastFailAt = Date.now(); return false }
    const json = await resp.json() as { sysTime2?: string }
    const t = json.sysTime2
    if (!t || t.length < 10) { lastFailAt = Date.now(); return false }
    const [y, m, d] = t.slice(0, 10).split('-').map(Number)
    if (y > 0 && m > 0 && d > 0) {
      const key = `${String(y).padStart(2, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
      if (key !== beijingToday) {
        beijingToday = key
        return true
      }
      return false
    }
    lastFailAt = Date.now()
    return false
  } catch {
    // 网络不可用：保持本地时间，进入冷却期
    lastFailAt = Date.now()
    return false
  } finally {
    inFlight = false
  }
}
