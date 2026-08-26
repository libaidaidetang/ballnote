import type { StoreKey } from '../../shared/models'

/**
 * 保存 store 数据（主进程串行原子写）。
 * 失败时 console.error 并返回 false，调用方据此提示用户，避免静默丢数据。
 */
export async function saveStore<T>(key: StoreKey, data: T): Promise<boolean> {
  try {
    const res = await window.api.store.save(key, data)
    if (!res.ok) {
      console.error('[store] 保存失败:', key, res.error)
      return false
    }
    return true
  } catch (err) {
    console.error('[store] 保存异常:', key, err)
    return false
  }
}

/**
 * 读-改-写封装：加载最新快照 → mutator 原地修改 → 保存。
 * 收敛各组件重复的样板；mutator 返回 false 时中止保存（目标不存在等场景）。
 * 注意：跨窗口并发写仍为 last-write-wins（根治需主进程实体粒度 API），本封装只消除样板与漏 await。
 */
export async function updateStore<T>(key: StoreKey, mutator: (data: T) => boolean | void): Promise<boolean> {
  try {
    const data = await window.api.store.load<T>(key)
    if (mutator(data) === false) return false
    return await saveStore(key, data)
  } catch (err) {
    console.error('[store] 更新失败:', key, err)
    return false
  }
}
