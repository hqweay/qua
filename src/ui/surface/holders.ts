/**
 * **存活 = 意图持有者集合**。
 *
 * 一个浮面为什么还在？因为还有人需要它。hover 指针、键盘焦点、拖动手势、
 * 显式 pin、锚点存活，各发一枚 token；`alive = size > 0`，全释放才退场。
 *
 * 这条把「peek → pinned → dismiss」三段状态机整个消掉了：那三段本来只是
 * 同一个集合的三种人数。拖动自动拿 `gesture` token（拖过边界不会把自己关掉），
 * pin 只是把 token 的 scope 从 `session` 换成 `workspace`，多实例只是集合里
 * 多几个浮面 —— 都不再是特殊分支。
 *
 * ⚠️ 纯 TS，不碰 DOM，可脱离浏览器单测。
 */
import type { HolderKind, HolderScope, Holders } from './types.ts'

interface Token {
  kind: HolderKind
  scope: HolderScope
}

export class HolderSet implements Holders {
  private readonly tokens = new Map<string, Token>()
  private readonly listeners = new Set<() => void>()

  set(key: string, kind: HolderKind, scope: HolderScope = 'session'): void {
    const prev = this.tokens.get(key)
    if (prev && prev.kind === kind && prev.scope === scope) return
    this.tokens.set(key, { kind, scope })
    this.notify()
  }

  acquire(key: string, kind: HolderKind, scope: HolderScope = 'session'): () => void {
    this.set(key, kind, scope)
    return () => this.release(key)
  }

  release(key: string): void {
    if (this.tokens.delete(key)) this.notify()
  }

  get alive(): boolean {
    return this.tokens.size > 0
  }

  get kinds(): readonly HolderKind[] {
    return [...new Set([...this.tokens.values()].map((t) => t.kind))]
  }

  /** 工作区级的 token 是「跨会话」的意图，供装配层决定要不要写盘 */
  get scopes(): readonly HolderScope[] {
    return [...new Set([...this.tokens.values()].map((t) => t.scope))]
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  clear(): void {
    if (this.tokens.size === 0) return
    this.tokens.clear()
    this.notify()
  }

  private notify(): void {
    for (const cb of this.listeners) cb()
  }
}
