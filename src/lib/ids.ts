// 通用 id 分配助手：max+1 并在当前集合内保证唯一。
// 防御：并发保存（多标签同时写）读到同一 max 产生重复 id、或删除最大 id 后复用导致数据串位。
export function nextId(items: { id: number }[]): number {
  let id = items.length === 0 ? 1 : Math.max(...items.map((x) => x.id)) + 1
  while (items.some((x) => x.id === id)) id++
  return id
}
