/**
 * handler 的共享小工具。
 *
 * ⚠️ 不在这里 re-export `HANDLERS`：`scripts/arch-check.mjs` 的 §18（handler 不得碰 DOM）
 *   通过扫描 `handlers.ts` 里**对象字面量**的属性来定位每个 handler。转口若也写成对象字面量，
 *   88 个 handler 会被数两遍。合并只留 `handlers.ts` 一处。
 */
import type { App } from '../../core/ports.ts'
import type { MountHost, ViewOwnerRef } from '../../core/index.ts'

export const S = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d)

/** 当前块（没有就退回第一块；空库返回 null） */
export function curBlock(app: App): string | null {
  return app.ed.caretBlock() ?? app.ed.rows()[0]?.block.id ?? null
}

/**
 * 命令参数里的**拥有者**（`owner`）。
 *
 * 两种形状，判据只有它自己声明的 `kind`：
 *   · `{kind:'block', blockId}` —— 块（内容对象）；
 *   · `{kind:'tab', host, tabId}` —— local tab（面板局部，不是块）。
 *
 * ⚠️ 形状不对 ⇒ `null`（不猜）：猜出来的拥有者会把一次「改这一栏」写成
 *    「改另一个块」，而那是不报错的。
 */
export function ownerArg(v: unknown): ViewOwnerRef | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as { kind?: unknown }
  if (o.kind === 'block') {
    const blockId = S((v as { blockId?: unknown }).blockId)
    return blockId === '' ? null : { kind: 'block', blockId }
  }
  if (o.kind === 'tab') {
    const host = hostArg((v as { host?: unknown }).host)
    const tabId = S((v as { tabId?: unknown }).tabId)
    if (!host || tabId === '') return null
    return { kind: 'tab', host, tabId }
  }
  return null
}

/** 命令参数里的**挂载宿主**（`host`） */
export function hostArg(v: unknown): MountHost | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const h = v as { kind?: unknown }
  if (h.kind === 'journal') return { kind: 'journal' }
  if (h.kind === 'block') {
    const blockId = S((v as { blockId?: unknown }).blockId)
    return blockId === '' ? null : { kind: 'block', blockId }
  }
  return null
}

/** 缺省拥有者：光标所在那一块（菜单类命令常常不带参数） */
export function ownerOrCur(a: Record<string, unknown>, app: App): ViewOwnerRef | null {
  const owner = ownerArg(a.owner)
  if (owner) return owner
  const id = S(a.blockId) || curBlock(app) || ''
  return id === '' ? null : { kind: 'block', blockId: id }
}
