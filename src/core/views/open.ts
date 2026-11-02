/**
 * **打开一块的落点**：修饰键只回答「去哪」，不回答「打开什么」。
 *
 * 为什么把它收成一份纯函数：同一个动作在正文块标、面包屑、行内引用、属性区、
 * 左槽行、查询的六种看法、日历格里各写一遍 if/else，必然有两处漂移
 * （实测：槽里的行认 Shift 不认 ⌘，而文档头面包屑正好相反）。
 * 事件层只把鼠标上的三个键位交进来，落点由装配层按这唯一一份判据分流。
 *
 * ⚠️ **`⌥` 不参与**：它是「看详情／lightbox」，不是另一个落点。
 * ⚠️ **Shift 优先于 ⌘/Ctrl**：Shift+⌘ 仍按右槽处理，不让组合键产生第三种语义。
 */
export type OpenPlace = 'center' | 'dock' | 'tab'

export interface OpenMods {
  shiftKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
}

export function openPlaceOf(mods: OpenMods = {}): OpenPlace {
  if (mods.shiftKey) return 'dock'
  if (mods.metaKey || mods.ctrlKey) return 'tab'
  return 'center'
}

/**
 * 中心落点的**语义**：内容面「聚焦到这一块」；导航面（左槽行、面包屑返回）
 * 只换当前对象、不抢焦点。两者本来就有差异，统一入口时不要把它们悄悄合并。
 */
export interface OpenOpts {
  center?: 'focus' | 'keep'
  feed?: boolean
  restore?: 'saved' | 'none'
}
