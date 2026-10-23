/**
 * handler 的共享小工具。
 *
 * ⚠️ 不在这里 re-export `HANDLERS`：`scripts/arch-check.mjs` 的 §18（handler 不得碰 DOM）
 *   通过扫描 `handlers.ts` 里**对象字面量**的属性来定位每个 handler。转口若也写成对象字面量，
 *   88 个 handler 会被数两遍。合并只留 `handlers.ts` 一处。
 */
import type { App } from '../../core/ports.ts'

export const S = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d)

/** 当前块（没有就退回第一块；空库返回 null） */
export function curBlock(app: App): string | null {
  return app.ed.caretBlock() ?? app.ed.rows()[0]?.block.id ?? null
}
