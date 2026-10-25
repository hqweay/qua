/**
 * 一个块在提示里怎么称呼自己（撞名 / 冲突提示共用）。
 *
 * 判据：**露面是集合**，不是单值。兼位的块必须把两个都读出来 —— 只说「页」
 * 会让人以为「取消页标记」就能腾出这个名字，而名字属于块本身，不随露面走。
 * 一个列表都不进时，它就是「块」。
 *
 * ⚠️ 这句话有两处要拼（编辑边界撞名、别名编辑器撞名）。两处各写一份，
 *    措辞就会分叉；这里只留一份，调用方只负责套模板。
 */
import { hasList, type Block } from './model.ts'
import { t } from './msg.ts'

export function whereOf(b: Block): string {
  const lists: string[] = []
  if (hasList(b, 'page')) lists.push(t('ui.where.page'))
  if (hasList(b, 'tag')) lists.push(t('ui.where.tag'))
  return lists.length === 0 ? t('ui.where.block') : lists.join(t('ui.where.sep'))
}
