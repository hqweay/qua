/**
 * `StoragePort` 的替身 —— **只用于单测**，不进打包产物。
 *
 * 为什么值得写：`LocalStorageAdapter` 自己要证明的三件事（队列串行、失败如实返回、
 * 信封能往返）都不需要浏览器。用内存表当后端，就能在 `node --test` 里跑真实现，
 * 而不是给适配器写一堆 mock。
 */

const store = new Map<string, string>()

/** 一个最小的 localStorage 替身：只为在 Node 里跑同一个适配器 */
export function installMemoryLocalStorage(opts: { failSet?: boolean } = {}): void {
  const api = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (opts.failSet) throw new DOMException('QuotaExceededError')
      store.set(k, String(v))
    },
    removeItem: (k: string) => void store.delete(k),
    clear: () => void store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size
    },
  }
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = api
}

export function resetMemoryLocalStorage(): void {
  store.clear()
}

export function peekMemoryLocalStorage(key: string): string | null {
  return store.get(key) ?? null
}
