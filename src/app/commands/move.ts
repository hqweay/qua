/**
 * 「移动到…」：把一个块（连子树）搬到另一个容器下。
 *
 * 判据：这是**显式点名**的移动——用户先指块、再选目标。
 * 它与「Enter / 反缩进不跨 section」正交：那条是**防误走**（编辑动作不该悄悄换容器），
 * 这条是「我知道我要去哪」。
 *
 * 三条口径：
 *   · **一条事务一条 op**：`tx.move` 一次，⌘Z 一步回来；不拆成「先删后插」；
 *   · **引用不受影响**：边按 id 记，块搬家不会让任何指向它的引用失效；
 *   · **自环要在命令层先判**：`tx.move` 遇到「移进自己的子树」会抛错，
 *     而那会把整笔事务回滚并把异常冒到 UI —— 用户看到的是「报错了」，不是「不行」。
 *     ⇒ 先判，给一句人话；判据与 core 那份一致（`pathOf` 含目标即自环）。
 *
 * ⚠️ **target 只有「页」与「标签块」**：「根」没有视口（它也不该有——
 *    见 D2），「journal 天」是「改这件事发生在哪天」——那是另一件事，语义另议。
 *    把它们放进 target 会让「移动到…」变成两个动词混在一个入口里。
 */
import { displayNameOf, hasList, isJournal, type Block } from '../../core/index.ts'
import { t } from '../../core/msg.ts'
import type { App } from '../../core/ports.ts'
import type { Row } from '../../ui/layers.ts'
import type { PageDeps } from './types.ts'

export function moveCommands(d: PageDeps): Pick<App, 'showMovePicker' | 'moveBlockTo'> {
  /**
   * 一个块**能不能**被搬进 `target`。
   *
   * 返回 `null` ＝ 可以；返回一句人话 ＝ 不行（**说清为什么**，别静默）。
   * 三种拒绝各有不同的话：自环、原地不动、目标是自己的子树。
   */
  const refuse = (blockId: string, targetId: string): string | null => {
    if (blockId === targetId) return t('ui.move.refuseSelf')
    // 目标在自己的子树里 ⇒ 自环（判据与 core 那份一致：祖先链含目标）
    if (d.kb.pathOf(targetId).some((p) => p.id === blockId)) return t('ui.move.refuseCycle')
    // 已经在目标下 ⇒ 这一下没有可做的事
    if (d.kb.parentOf(blockId)?.id === targetId) return t('ui.move.refuseSame')
    return null
  }

  /** 可作 target 的容器：页 ＋ 标签块（按身份找，不看位置） */
  const targets = (): Block[] => [...d.kb.pages(), ...d.kb.tags()]

  const rowsFor = (blockId: string): Row[] =>
    targets().map((c) => {
      const bad = refuse(blockId, c.id)
      return {
        id: `move/${c.id}`,
        label: hasList(c, 'tag') ? `#${displayNameOf(c)}` : d.pageTitle(c).trim() === '' ? t('ui.page.untitled') : d.pageTitle(c),
        // 不能去的地方**留在列表里并说明原因**（灰掉比「不出现」好：
        // 用户找得到它、也知道为什么不行，而不是以为这个目标不存在）
        hint: bad ?? '',
        disabled: bad !== null,
        icon: hasList(c, 'tag') ? 'lucide:hash' : d.pageIcon(c),
        group: hasList(c, 'tag') ? 'pick/2' : 'pick/1',
      }
    })

  /** 真正搬（两个入口共用这一份：picker 与「直接点名目标」） */
  const doMove = (blockId: string, targetId: string): void => {
    const bad = refuse(blockId, targetId)
    if (bad) {
      d.toast(bad, 'warn')
      return
    }
    const target = d.kb.get(targetId)
    if (!target) return
    /**
     * 落点是目标容器的**末尾**（v1）：`tx.move` 的 `index` 是最终位置，
     * 越界会夹取——所以这里不需要先数一遍再减一。
     */
    d.moveBlock(blockId, targetId, target.children.length)
    const name = hasList(target, 'tag') ? `#${displayNameOf(target)}` : d.pageTitle(target)
    // 提示要说清「去了哪」——用户下一步可能想跳过去看看
    d.toast(t('ui.move.moved', { name }), 'ok')
  }

  return {
    showMovePicker: (blockId) => {
      const b = d.kb.get(blockId)
      if (!b) return
      // 身份块不参与组织（位置对它们不承载信息）⇒ 搬它们没有意义，直接说清
      if (isJournal(b)) {
        d.toast(t('ui.move.refuseJournal'), 'warn')
        return
      }
      d.openRefPicker(rowsFor(blockId), (row) => doMove(blockId, row.id.replace(/^move\//, '')))
    },

    moveBlockTo: (blockId, targetId) => doMove(blockId, targetId),
  }
}
