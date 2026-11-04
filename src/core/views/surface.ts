/**
 * 中心表面：一切占中心的东西都是 tab —— 内容从「块」扩成 `{block | derived | utility}`。
 *
 * · **块 tab**：一份保存的视图（已有机制，不在这里）；
 * · **派生面**：宿主现算的卡（目录＝`DERIVED_CARDS`）在中心的一次露面；
 * · **工具面**：应用自带的系统级表面（搜索、设置…），**闭集目录**在本文件。
 *
 * 工具面为什么收成目录（与派生卡目录同一条判据）：打开入口、按 kind 去重、tab 固定名、
 * 渲染分支穷举，都从这一份来；加一行＝编译期全红，而不是「点了没反应」。
 * 工具面不是块（不可寻址、不进回收站），也不是派生卡（没有拥有者、没有条件）——
 * 它是「这台应用自带的一个面」。
 *
 * 去重口径：块 tab 按视图（装载层已有）；派生/工具面**按 kind**——同一张面全局只有一张 tab，
 * 再开＝切过去（⌘-点击既有 tab 的语义由目录承担，不各写一遍）。
 */
import type { MsgId } from '../infra/msg.ts'
import { DERIVED_CARDS, isDerivedCardId, type DerivedCardId } from './dock.ts'

/**
 * 工具面的 id 空间（闭集）。⚠️ 目录（`UTILITY_FACES`）里**还没有行**：
 * 行与它的图标/固定名/渲染分支在这个面自己落地时一起加——入口守卫看目录不看类型，
 * 所以空目录期间这里的名义成员不可达（打不开、也画不出来）。
 */
export type UtilityFaceId = 'search'

export interface UtilityFaceDecl {
  id: UtilityFaceId
  /** 打开入口与 tab 条的图标（`lucide:<name>`，与派生卡目录同一套解析） */
  icon: string
  /** tab 条的固定名（字典 id；UI 调 `t()` 取字） */
  label: MsgId
}

/**
 * 工具面目录：**表面目录唯一一份**。行与它的渲染分支一起加（渲染穷举会红）。
 */
export const UTILITY_FACES: readonly UtilityFaceDecl[] = [
  { id: 'search', icon: 'lucide:search', label: 'ui.surface.search' },
]

export function isUtilityFaceId(v: unknown): v is UtilityFaceId {
  return typeof v === 'string' && UTILITY_FACES.some((d) => d.id === v)
}

/** 一张表面 tab 的身份（tab 状态里只存这一份；块 tab 不用它） */
export type SurfaceRef =
  | { kind: 'derived'; card: DerivedCardId }
  | { kind: 'utility'; face: UtilityFaceId }

/**
 * 一张表面 tab 的**去重键**：派生/工具按 kind——同一张面全局只有一张 tab，
 * 再开＝切过去。判据只答「同 kind 同 id 是同一张」；「这个 id 存不存在」归
 * 两张目录各自的守卫（入口先过守卫才到这里）。
 */
export function surfaceRefKey(ref: SurfaceRef): string {
  return ref.kind === 'derived' ? `derived:${ref.card}` : `utility:${ref.face}`
}

/**
 * 中心能直接接住的**派生卡**：身体是纯派生 DOM（每次现造、无槽绑定）。
 * 检视卡与反链卡的身体是绑在槽上的持久实例（表单/编辑器），把它们搬进中心
 * 要么搬走槽里的 DOM、要么造第二份——它们进中心等各自的中心身体立项。
 */
export const CENTER_DERIVED_CARDS: readonly DerivedCardId[] = ['trash']

/** 这个派生卡 id 能不能作为中心 tab 打开（目录成员 ∧ 中心接得住） */
export function centerDerivedOpenable(card: string): card is DerivedCardId {
  return isDerivedCardId(card) && CENTER_DERIVED_CARDS.includes(card)
}

/**
 * 一张表面引用过不过守卫（打开入口的唯一放行判据；未知 id 与坏形状都在这里挡下，不到渲染）。
 *
 * 入口线上传的是**宽形状**（`{kind, id}`，命令参数与门面签名共用），这里返回**规范形态**
 * （派生＝`card`、工具＝`face`）——守卫不但说「过不过」，还把形状换好，调用方不再各判一遍。
 */
export function validSurfaceRef(ref: unknown): SurfaceRef | null {
  if (!ref || typeof ref !== 'object') return null
  const o = ref as Record<string, unknown>
  if (typeof o.id !== 'string') return null
  if (o.kind === 'derived') return centerDerivedOpenable(o.id) ? { kind: 'derived', card: o.id } : null
  if (o.kind === 'utility') return isUtilityFaceId(o.id) ? { kind: 'utility', face: o.id } : null
  return null
}

/** 表面 tab 的固定名（派生取派生卡目录、工具取工具面目录；不认识的 id 返回 null） */
export function surfaceTitleOf(ref: SurfaceRef): MsgId | null {
  if (ref.kind === 'derived') {
    return DERIVED_CARDS.find((d) => d.id === ref.card)?.label ?? null
  }
  return UTILITY_FACES.find((d) => d.id === ref.face)?.label ?? null
}
