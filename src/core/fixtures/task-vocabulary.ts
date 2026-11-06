/**
 * 「任务状态」词汇的构造器：定义块 ＋ 四个选项（select 的值域＝直接子块）。
 *
 * 为什么住 fixtures：这些名字是**数据**（定义块/选项块的正文），不是界面文案——
 * 它们会进库、会跟着导出、用户也能改，值认的是选项 id。数据内容与其它种子内容
 * 同一类，与 `seed.ts` ／ `bootstrap.ts`（冷启动真在用这份目录）同住。
 *
 * 为什么只有一个构造器：这份词汇有两个使用者——满态种子（随库种下）与
 * **写路径的按需物化**（库清空过、或定义块被清掉时，落值之前先补上）。
 * 两个使用者各造一份形状就会漂移：种子有的选项、按需物化的没有，查询就分叉。
 *
 * 时刻用当下（`mkBlock`/`mkPropDef` 的默认）：按需物化发生在「正在编辑」那一刻，
 * 它就是那次编辑的时刻；种子拿到后自己重盖统一时刻。
 */
import { ICON_PROP, mkBlock, type Block } from '../model/model.ts'
import {
  CHECK_PROP,
  DEFAULT_PROP,
  mkPropDef,
  TASK_STATUS_ABANDONED_ID,
  TASK_STATUS_DONE_ID,
  TASK_STATUS_DOING_ID,
  TASK_STATUS_PROP_ID,
  TASK_STATUS_TODO_ID,
  UI_POSITION_PROP,
  USE_PROP,
} from '../props/props.ts'

/** 显示名是**种子内容**：改显示名不动任何值，值认选项 id */
export const TASK_STATUS_LABEL = '任务状态'
export const TASK_TODO_LABEL = '待办'
export const TASK_DOING_LABEL = '进行中'
export const TASK_DONE_LABEL = '完成'
export const TASK_ABANDONED_LABEL = '放弃'

/**
 * 四个选项块（id 是核心词汇的确定性 id）。
 *
 * 每个值带一枚 `_icon`：它画在块标与正文之间，所以「待办／进行中／完成／放弃」
 * 在行上是一个形状而不是一段字。哪个值是「完成」由定义块的 `_check` 决定
 * （on = 完成、off = 待办），不靠选项上的私有标记。
 */
export function taskStatusChoices(): Block[] {
  const icon = (name: string): { props: Record<string, unknown> } => ({
    props: { [ICON_PROP]: `lucide:${name}` },
  })
  return [
    { ...mkBlock(TASK_TODO_LABEL, icon('square')), id: TASK_STATUS_TODO_ID },
    { ...mkBlock(TASK_DOING_LABEL, icon('square-dashed')), id: TASK_STATUS_DOING_ID },
    { ...mkBlock(TASK_DONE_LABEL, icon('square-check')), id: TASK_STATUS_DONE_ID },
    { ...mkBlock(TASK_ABANDONED_LABEL, icon('square-x')), id: TASK_STATUS_ABANDONED_ID },
  ]
}

/**
 * 造一份「任务状态」词汇：定义块（选项已挂为子块）＋ 缺省「待办」＋ gutter 快捷位。
 *
 * `_use: 'status'` 是语义（唯一一条任务状态），`_check` 是显示/编辑映射
 * （勾选＝完成、取消＝待办）。两者分开：没有 `_use` 的 `_check` 只是一个普通勾选框。
 */
export function taskStatusVocabulary(): Block {
  const def = mkPropDef(
    TASK_STATUS_LABEL,
    'select',
    {
      [UI_POSITION_PROP]: 'block-left',
      [DEFAULT_PROP]: TASK_STATUS_TODO_ID,
      [USE_PROP]: 'status',
      [CHECK_PROP]: { on: TASK_STATUS_DONE_ID, off: TASK_STATUS_TODO_ID },
      // 未填时 gutter 上画定义块自己的图标（与「待办」同形），入口不会因没有值而消失
      [ICON_PROP]: 'lucide:square',
    },
    TASK_STATUS_PROP_ID,
  )
  def.children = taskStatusChoices()
  return def
}
