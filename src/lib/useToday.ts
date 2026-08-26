import { useEffect, useState } from 'react'

function localKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * 日历"今天"（yyyy-MM-dd）：优先主进程联网校时的北京时间，否则本地时间。
 * 订阅 time:synced 刷新（校时成功/跨天重取）；每 60s 轮询一次兜底跨天。
 */
export function useToday(): string {
  const [today, setToday] = useState<string>(() => localKey(new Date()))

  useEffect(() => {
    const refresh = () => {
      void window.api.time.getToday().then((k) => setToday(k))
    }
    refresh()
    const un = window.api.time.onSynced(refresh)
    const timer = window.setInterval(refresh, 60_000)
    return () => { un(); clearInterval(timer) }
  }, [])

  return today
}
