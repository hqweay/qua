/**
 * **系统属性值的判据登记表**：`_` 前缀保留区里每一个键，「什么值算合法」只有这一个答案。
 *
 * 三个消费者吃同一张表（「什么算坏只能有一个答案」——`storage/shape.ts` 的既有纪律，
 * 从「7 个键各自内联」收成「每个键一份判据、三处共用」）：
 *
 *   · **op 产出**（`kb/diff.ts` 的 `propOps`）：tx 里的任何属性写——`setProp`、各专用方法、
 *     `patch` 的就地改——最终都从这里变成 op。在发看点判，非法值当场抛、事务逆序回滚，
 *     坏值进不了内存，更进不了日志；
 *   · **op 收端**（`kb/validate.ts`）：撤销/回放的日志与将来的远端 op 流，先验再吃；
 *   · **落盘校验**（`storage/shape.ts`）：冷启动读盘，坏形状判 corrupt（不是所有键都上落盘闸，
 *     见下）。同一份判据保证「写不进的读不出、读得出的写得过」，不会出现两档严格度。
 *
 * 判据本体住在各领域模块（alias/model/tags/hierarchy/journal/props/query/view/mount/embed）——
 * 本文件**只做表**，不写第二份判据。
 *
 * ## 刻意不上落盘闸的两个键
 *
 *   · `_query`：条件形状会演进，旧条件读不出来是**已设计的降级态**（读侧显式提示，
 *     照 `_views` 逐项宽容的先例）；写侧照 `isQuerySpec` 拒，读侧不判 corrupt。
 *   · `_type`：写侧接受未知 id 是设计（读侧降级成默认类型画，`types.ts` 的 `typeDeclOf`）。
 *     校验它等于假装认识所有类型——登记为「开放」，检查恒真。
 *
 * ⚠️ 本文件零 DOM、零持久化、零 store：纯表 ＋ 一个纯函数，能直接单测。
 */
import {
  ACTIVE_VIEW_PROP,
  ALIASES_PROP,
  DELETED_AT_PROP,
  DISPLAY_PROP,
  ICON_PROP,
  LISTS_PROP,
  VIEWS_PROP,
} from '../model/model.ts'
import { isAliasesValue } from '../identity/alias.ts'
import { isDisplayValue, isIconValue, isListsValue } from '../model/model.ts'
import { TAGS_PROP, isTagRefList } from '../identity/tags.ts'
import { BELONGS_TO_PROP, isBelongsToRefs } from '../relations/hierarchy.ts'
import { isJournalDate } from '../identity/journal.ts'
import {
  CHOICE_SCOPE_PROP,
  FIELD_DEFS_PROP,
  OWN_PROPS_PROP,
  UI_POSITION_PROP,
  isFieldDefRefs,
  isOwnPropSlots,
  isPropKind,
  isUiPositionValue,
  parseChoiceScope,
} from './props.ts'
import { isQuerySpec } from '../query/query.ts'
import { isActiveViewValue, isViewsValue } from '../views/view.ts'
import { MOUNTS_PROP, isMountsValue } from '../views/mount.ts'
import { EMBED_PROP, canonicalViewRef } from '../views/embed.ts'

/**
 * 键 → 值判据。**这张表就是「系统键总清单」的运行时权威**（与 `model.ts` 的
 * `SystemPropId` 一一对应，`arch-check` 钉住两边不漂）；
 * 不在表里的 `_` 键一律拒绝写入——新键必须先来这里登记，没有「顺手写一个」这回事。
 */
export const SYSTEM_PROP_CHECKS: Readonly<Record<string, (value: unknown) => boolean>> = {
  // 结构槽（model.ts）
  _type: () => true, // 开放：未知 id 读侧降级，写侧不假装认识
  [ICON_PROP]: isIconValue,
  _date: isJournalDate,
  [ALIASES_PROP]: isAliasesValue,
  [LISTS_PROP]: isListsValue,
  [DISPLAY_PROP]: isDisplayValue,
  _query: isQuerySpec,
  [VIEWS_PROP]: isViewsValue,
  [ACTIVE_VIEW_PROP]: isActiveViewValue,
  [EMBED_PROP]: (v) => canonicalViewRef(v) !== null,
  // 字段定义（props.ts）
  _kind: isPropKind,
  [FIELD_DEFS_PROP]: isFieldDefRefs,
  [CHOICE_SCOPE_PROP]: (v) => parseChoiceScope(v) !== null,
  [OWN_PROPS_PROP]: isOwnPropSlots,
  [UI_POSITION_PROP]: isUiPositionValue,
  // 归属与标签
  [BELONGS_TO_PROP]: isBelongsToRefs,
  [TAGS_PROP]: isTagRefList,
  [MOUNTS_PROP]: isMountsValue,
  // 删除标记：正常只经 `block.exist` 走（`isPropCell` 把它挡在 prop op 外），
  // 登记在这里是收端的完整性——真有人把它当 prop.set 送来，值必须是毫秒数
  [DELETED_AT_PROP]: (v) => typeof v === 'number',
}

/**
 * 系统键判据的统一入口：`null` ＝ 合法；否则给一句英文理由（开发者日志与断言用，
 * 不是用户文案）。**未登记的 `_` 键也算非法**——保留区里没有「临时随便放一个」的格子。
 */
export function systemPropViolation(name: string, value: unknown): string | null {
  if (!name.startsWith('_')) return null
  const check = SYSTEM_PROP_CHECKS[name]
  if (!check) return `unregistered system prop "${name}" — add it to core/system-props.ts`
  if (!check(value)) return `invalid value for system prop "${name}"`
  return null
}
