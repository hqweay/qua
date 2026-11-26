/**
 * handler 的共享小工具。
 *
 * ⚠️ 不在这里 re-export `HANDLERS`：`scripts/arch-check.mjs` 的 [18]（handler 不得碰 DOM）
 *   通过扫描 `handlers.ts` 里**对象字面量**的属性来定位每个 handler。转口若也写成对象字面量，
 *   88 个 handler 会被数两遍。合并只留 `handlers.ts` 一处。
 */
import type { App } from '../../core/infra/ports.ts'
import type { MountHost, ViewOwnerRef } from '../../core/index.ts'

export const S = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d)

/** 当前块（没有就退回第一块；空库返回 null） */
export function curBlock(app: App): string | null {
  return app.ed.caretBlock() ?? app.ed.rows()[0]?.block.id ?? null
}

/**
 * **这一条命令作用于哪一块**：显式参数优先，没有才退光标。
 *
 * 判据只有这一条，所有「位置类」命令（新建／移动／缩进／折叠／删除／复制）都吃它。
 * 为什么不各写一遍：显式目标不是可选的修饰，而是**同一件事的另一种来源**——
 * 菜单会把被右键的那一块灌进每一行的 `blockId`（`stampTarget`），自动化步骤也带 id；
 * 一半命令认它、一半只认光标时，差别只在「那一块能不能落光标」上暴露：
 * 露面块的正文槽是 `display:none`（名字由身体首行承担），光标进不去 ⇒
 * 右键它的菜单里「新建块／上移」全部静默早退，而「删除」因为单独写了一条分支却是好的。
 * 那种一半好一半坏的菜单，用户只会读成「这个菜单坏了」。
 *
 * ⚠️ **退光标那一档保留**：键位入口没有显式目标，光标就是它唯一的意图来源。
 */
export function targetBlock(a: Record<string, unknown>, app: App): string | null {
  return S(a.blockId) || curBlock(app)
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
