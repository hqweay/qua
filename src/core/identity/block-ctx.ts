/**
 * **块级上下文键**：一条「对某块做什么」的判据需要的事实。
 *
 * 住在 core 的理由：它只读模型。编辑器面与记录面（查询结果／派生栏／投影）必须
 * 给出同一份答案——任何一面自己算都会漂。旧实现里这份推导只活在
 * `BlockEditor.ctxKeys()`，记录面要接菜单时只能再抄一遍。
 *
 * ⚠️ 这里只给**块自己的**键：光标、选区、折叠、组合期属于「哪个表面在看它」，
 * 由调用方补（编辑器补它那一份；记录面补空选区）。
 */
import type { Block } from '../model/model.ts'
import { canDeleteBlock, hasList, hasLiveChildren, isPropDefBlock, isQueryBlock } from '../model/model.ts'
import { typeDeclOf } from '../model/types.ts'
import type { CtxKeys } from '../model/undo.ts'
import { isJournal, journalDate, todayISO } from './journal.ts'
import { isEmbedBlock } from '../views/embed.ts'
import { activeView } from '../views/view.ts'
import { closureOf, fieldTableOf, type FieldTable } from '../props/props.ts'

export interface BlockMenuCtxOpts {
  /** 这一块是不是当前装载树的根（编辑器面）；记录面没有装载树 ⇒ false */
  isDocRoot: boolean
  /** 森林顶层（`store.blocks` 里直接就是它） */
  isForestRoot: boolean
  /** 字段表：编辑器传自己的缓存；省略 ⇒ 从森林现算（菜单打开是低频路径） */
  fields?: FieldTable
}

export function blockMenuCtxOf(
  b: Block,
  forest: readonly Block[],
  opts: BlockMenuCtxOpts,
): CtxKeys {
  const table = opts.fields ?? fieldTableOf(forest)
  const page = hasList(b, 'page')
  const tag = hasList(b, 'tag')
  return {
    /**
     * 「这一次菜单有目标块」——块菜单行的 `when` 读它。
     *
     * 不用 `blockFocused`：那个键的意思是「活动编辑器的光标在这块」，
     * 记录面没有光标，借它会变成一句谎话。
     */
    blockMenuTarget: true,
    blockId: b.id,
    blockIsRoot: opts.isDocRoot,
    blockIsForestRoot: opts.isForestRoot,
    /**
     * 删除入口的准入：判据在 model（`canDeleteBlock`）——菜单行与编辑器守卫同一份，
     * 两个答案分叉过一次（守卫放行了自动化块、行还被旧谓词藏着）。
     */
    blockCanDelete: canDeleteBlock(b),
    blockCanDeleteJournal: isJournal(b) && journalDate(b) !== todayISO(),
    blockCanExtractPage:
      !opts.isForestRoot &&
      !isJournal(b) &&
      !(tag && !page) &&
      !isPropDefBlock(b) &&
      !isQueryBlock(b),
    blockCanHaveView: Boolean(
      isQueryBlock(b) || isEmbedBlock(b) || hasLiveChildren(b) || activeView(b) !== null,
    ),
    /** 「往这块下面新建子块」的准入：问类型声明（与插入落点判据同源），不问有没有 children 数组 */
    blockCanTakeChildren: typeDeclOf(b).children !== 'none',
    blockHasPageRole: page,
    blockHasTagRole: tag,
    blockType: closureOf(b, table) ? 'closure' : 'paragraph',
  }
}
