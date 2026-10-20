/**
 * **引用解析**（`RefResolver` 接缝）：行内原子显示什么，由**目标当前的状态**决定。
 *
 * 为什么它必须存在：引用如果显示插入时的快照，目标一改名，链接上挂的就是过期的字——
 * 双链里「改名要能传播」这件事只能靠**渲染时解析**，不能靠「改名时批量回去改一遍原子」
 * （后者一有第二处写入路径就会漏，而且撤销时还要反向再改一遍）。
 *
 * ⇒ `Atom.label` 降级为 **fallback**：只有目标找不到时才用它（那时它是用户最后见过的信息）。
 * ⇒ `state` 是**派生**、不落盘：能不能解析到由「此刻森林里有没有这块」决定，
 *    存一份下来只会得到一个可能与事实不符的第二份真相。
 *
 * ⚠️ 「按 id 找块」由调用方注入（`find`）：本文件零 DOM，也**不持有森林**
 *    —— 编辑器、popover、测试各自把「怎么找块」递进来，解析逻辑只有一份。
 */
import type { Atom } from './annotations.ts'
import { journalDate, journalDateLabel, isJournal } from './journal.ts'
import type { Block } from './model.ts'
import { t } from './msg.ts'

/** 解析结果：**显示名 ＋ 还能不能解析到**（`dangling` 不是错误，是状态） */
export interface RefView {
  label: string
  state: 'resolved' | 'dangling'
}

/** 按 id 找块（整片森林；zoom 后引用目标可能在任意深度） */
export type FindBlock = (id: string) => Block | undefined

/**
 * 一个块**被引用时**的显示名。
 *
 * ⚠️ 与「页名」是同一件事的两处用法，但有一条特例：journal 的 `text` 恒为空
 *    （日期在 `_date` 里）⇒ 直接取正文会得到「无标题」。日期是它的可读投影，
 *    引用到某一天就该显示那一天（这也是「日期可引用」的第一个落点）。
 */
export function refTitle(b: Block): string {
  if (isJournal(b)) {
    const d = journalDate(b)
    if (d !== '') return journalDateLabel(d)
  }
  const s = b.text.trim()
  return s === '' ? t('ui.page.untitled') : s
}

/**
 * 解析一个行内引用。
 *
 * `a` 只取 `label` 与 `target` ⇒ popover 与测试可以不造完整 `Atom`。
 *
 * ⚠️ 没有 `target` 的原子（seed 的悬空样本、落盘前就指不到东西的老数据）
 *    一律 `dangling` ＋ 沿用 `label`：指不到就是指不到，不假装解析成功。
 *
 * ⚠️ **fallback 是「插入时的快照」，不是「用户最后见过的名字」——这是刻意的取舍**：
 *    要让兜底名跟着改名走，就得在**渲染时回写 `atom.label`**，而那会让一次纯渲染产生副作用
 *    （弄脏快照、连带触发落盘）。「改名靠解析传播、不回头改原子」是本文件的前提，二者不可兼得。
 *    ⇒ dangling 是**少数派状态**（目标被删），给它一个稳定的旧名字，好过让渲染变得不纯。
 */
export function resolveRef(find: FindBlock, a: Pick<Atom, 'label' | 'target'>): RefView {
  const target = a.target
  if (!target) return { label: a.label, state: 'dangling' }
  const b = find(target.id)
  if (!b) return { label: a.label, state: 'dangling' }
  return { label: refTitle(b), state: 'resolved' }
}

/**
 * 一次解析多个（`fillBlockText` 用）：省掉「逐格调 `find`」的重复查找。
 *
 * 返回的是 `atomId → RefView`，按 id 取而不是按位置取 —— 原子与占位符的对应关系
 * 由 `atomId` 钉死，不会因为数组顺序变化而张冠李戴。
 */
export function resolveRefs(find: FindBlock, atoms: readonly Atom[]): Map<string, RefView> {
  const out = new Map<string, RefView>()
  for (const a of atoms) out.set(a.id, resolveRef(find, a))
  return out
}

/** 找不到原子时的兜底视图（占位符还在、原子记录没了 ⇒ 看得见的 dangling） */
export function danglingView(label: string): RefView {
  return { label, state: 'dangling' }
}
