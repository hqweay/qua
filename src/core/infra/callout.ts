/**
 * 引述块的变体表：引述/信息/警告/错误/提示/重要/注意。
 *
 * **一个类型 + 一个系统属性**，不是七个类型：变体是「这一块是什么语气」的值，
 * 不是骨架（同一条判据把代码语言做成 `_lang` 而不是几十个 `core/code-<lang>`）。
 * 这样「所有警告」是一条 `eq` 条件，不是七个类型的 OR。
 *
 * 表是菜单顺序、图标、文案与取色的**唯一来源**：徽章、切换菜单、查询字段标签
 * 都从这里读；加一种变体只改这一张表与对应的 CSS 取色那一行。
 */
import { t } from './msg.ts'

export type CalloutVariant = 'quote' | 'info' | 'warning' | 'error' | 'tip' | 'important' | 'note'

interface VariantRow {
  /** 规范名＝落盘值（`_callout`） */
  readonly id: CalloutVariant
  /** 徽章与菜单上的字（走文案表，随语言切换） */
  readonly label: string
  /** Lucide 图形名（catalog 里已登记） */
  readonly icon: string
  /** 取色槽名：CSS 侧写 `.blk[data-callout='x'] { --callout-c: var(--ui-ink-…) }` */
  readonly tone: string
}

const VARIANT_TABLE = [
  { id: 'quote', label: t('ui.callout.quote'), icon: 'quote', tone: 'cyan' },
  { id: 'info', label: t('ui.callout.info'), icon: 'info', tone: 'blue' },
  { id: 'warning', label: t('ui.callout.warning'), icon: 'triangle-alert', tone: 'yellow' },
  { id: 'error', label: t('ui.callout.error'), icon: 'circle-alert', tone: 'red' },
  { id: 'tip', label: t('ui.callout.tip'), icon: 'lightbulb', tone: 'green' },
  { id: 'important', label: t('ui.callout.important'), icon: 'octagon-alert', tone: 'violet' },
  { id: 'note', label: t('ui.callout.note'), icon: 'sticky-note', tone: 'gray' },
] as const satisfies readonly VariantRow[]

export const CALLOUT_VARIANTS: readonly (VariantRow & { readonly id: CalloutVariant })[] = VARIANT_TABLE
export const CALLOUT_IDS: readonly CalloutVariant[] = VARIANT_TABLE.map((v) => v.id)

/** 缺省变体：没写 `_callout` 的引述块就是普通引述（`_lang` 缺省 plain 同款读法） */
export const DEFAULT_CALLOUT: CalloutVariant = 'quote'

/** 未认识的值按缺省画；这不是把盘上的值改掉，只决定「长什么样」 */
export function canonicalCallout(raw?: string): CalloutVariant {
  return CALLOUT_IDS.includes(raw as CalloutVariant) ? (raw as CalloutVariant) : DEFAULT_CALLOUT
}

export function calloutDecl(raw?: string): (typeof VARIANT_TABLE)[number] {
  const id = canonicalCallout(raw)
  return VARIANT_TABLE.find((v) => v.id === id) ?? VARIANT_TABLE[0]!
}

export function calloutLabel(raw?: string): string {
  return calloutDecl(raw).label
}
