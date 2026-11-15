/**
 * **属性值的人话投影（唯一判据）**：哪些 kind 的值是「id 而不是字面量」、要翻成什么。
 *
 * 为什么单独一份：值存 id、显示现解析是模型的前提，但「要不要翻」曾经散在各显示面
 * 各写各的——条件 chip 只认 select、分组列头自己判 ref、卡片兜底把 id 切一段当名字，
 * 每加一个显示面就复发一次「32 位 hex 摆给用户」。这里只答一次：
 *   · `select` 的值是选项块 id → 查选项表（含墓碑，值指向已删选项时名字仍读得出）；
 *   · `ref` 的值是任意块 id → 走调用方给的显示名链（目标没了由它兜「已删除」）；
 *   · 其余 kind 的值是字面量（text／number／date…），翻不动 → `undefined`，
 *     调用方保留原样——**数据不静默消失**，字面量原样显示是它的真值。
 *
 * 判据按字段的 **kind**，不猜值的形状：select 与 ref 的值都是 id，只有 kind 知道
 * 该用哪张表。多值（`cardinality:'many'`）不在这里处理——分桶在分组层已 fan-out
 * 成单值，属性行用 `valueListOf` 逐项问，这里只答「一个值怎么读」。
 */
import type { PropKind } from './props.ts'

export interface ValueDisplayDeps {
  /** `select` 的值域（含墓碑）：选项块 id → 显示名 */
  choices?: (propId: string) => readonly { id: string; label: string }[]
  /** 值是块 id 的 kind（`ref`）：目标 id → 显示名（目标没了给「已删除」，不给裸 id） */
  refLabel?: (id: string) => string
}

/**
 * 一个属性值 → 人话；翻不动返回 `undefined`（兜底归调用方：原样或「已删除」）。
 *
 * `field.kind` 缺省（定义已删、JSON 手写条件这类）⇒ 无法判断值是不是 id，
 * 恒返回 `undefined`——不猜着翻，翻错了比不翻更难查。
 */
export function propValueText(
  field: { id: string; kind?: PropKind },
  value: unknown,
  deps: ValueDisplayDeps,
): string | undefined {
  if (value === undefined || value === null || value === '' || Array.isArray(value)) return undefined
  if (typeof value !== 'string') return undefined
  if (field.kind === 'select') {
    return deps.choices?.(field.id).find((c) => c.id === value)?.label
  }
  if (field.kind === 'ref') return deps.refLabel?.(value)
  return undefined
}
