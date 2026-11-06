/**
 * 工具面的 id 空间与**闭集目录**。
 *
 * 工具面是应用自带的系统级表面（搜索、设置…）：不是块（不可寻址、不进回收站），
 * 也不是派生卡（没有拥有者、没有条件）——它是「这台应用自带的一个面」。
 *
 * 收成目录的判据与派生卡同一条：打开入口、去重、tab 固定名、渲染分支穷举，
 * 都从这一份来；加一行＝编译期全红，而不是「点了没反应」。
 * ⚠️ 单独成叶而不是住在 surface.ts：槽（`DockEntry`）也要按它解析与渲染，
 *    而那边已经 import 了本包的派生卡目录——目录住叶子，两边各自引，不成环。
 */
import type { MsgId } from '../infra/msg.ts'

export type UtilityFaceId = 'search' | 'settings'

export interface UtilityFaceDecl {
  id: UtilityFaceId
  /** 打开入口与 tab 条的图标（`lucide:<name>`，与派生卡目录同一套解析） */
  icon: string
  /** tab 条的固定名（字典 id；UI 调 `t()` 取字） */
  label: MsgId
  /** 能不能钉进槽（有槽卡身）。没有卡身的面只住中心——画廊不给「添加到槽」的行 */
  slot?: boolean
}

/**
 * 工具面目录：**表面目录唯一一份**。行与它的渲染分支一起加（渲染穷举会红）。
 */
export const UTILITY_FACES: readonly UtilityFaceDecl[] = [
  { id: 'search', icon: 'lucide:search', label: 'ui.surface.search', slot: true },
  { id: 'settings', icon: 'lucide:settings', label: 'ui.surface.settings' },
]

export function isUtilityFaceId(v: unknown): v is UtilityFaceId {
  return typeof v === 'string' && UTILITY_FACES.some((d) => d.id === v)
}
