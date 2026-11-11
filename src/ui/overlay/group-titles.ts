/**
 * 菜单分组标题：**分组 id 不是用户语言**，渲染前必须过这张表。
 *
 * 单独成文件的原因：它是纯数据（只依赖词典），测试要直接 import 它来断言
 * 「每个用到的分组都有标题」——而浮层本体带 DOM，进不了 node 测试。
 */
import { t } from '../../core/infra/msg.ts'

const GROUP_TITLES: Record<string, string> = {
  'block/1-basic': t('menu.group.basic'),
  'block/2-structure': t('menu.group.structure'),
  'block/3-role': t('menu.group.identity'),
  'block/4-inline': t('menu.group.inline'),
  'block/5-view': t('menu.group.viewNav'),
  'block/6-delete': t('menu.group.delete'),
  // 多选菜单的删除组：与单块菜单同一条判据——危险动作压轴、带标题分节（复用同一个词典键）
  'blockSel/2-delete': t('menu.group.delete'),
  'blockCopy/1': t('menu.group.copy'),
  'blockInsert/1': t('menu.group.insert'),
  'slash/1-structure': t('menu.group.structure'),
  'slash/2-inline': t('menu.group.inlineAtom'),
  'sel/1-mark': t('menu.group.mark'),
  'sel/2-ref': t('menu.group.ref'),
  'pick/1': t('menu.group.pickPage'),
  'pick/2': t('menu.group.pickTag'),
  // 块选择器的两组：分组 id 不是用户语言，别把 `ref/1-page` 露到浮层里
  'ref/1-page': t('menu.group.pickPage'),
  'ref/2-block': t('menu.group.block'),
  // 检索浮层（`#` 标签源 / `@` 页块源）：分组是「结果从哪儿来」，不是命令分类
  'retrieval/1-instance': t('menu.group.instance'),
  'retrieval/2-tag': t('menu.group.pickTag'),
  'retrieval/3-new': t('menu.group.new'),
  'retrieval/1-page': t('menu.group.pickPage'),
  'retrieval/2-block': t('menu.group.block'),
  'dbg/1-look': t('menu.group.debugLook'),
  'dbg/2-theme': t('menu.group.debugTheme'),
  'dbg/3-state': t('menu.group.debugState'),
  'view/7-manage': t('menu.group.viewManage'),
  'view/8-sort': t('menu.group.viewSort'),
  'view/9-add': t('menu.group.viewAdd'),
}

export function groupTitle(g: string | undefined): string {
  if (!g) return ''
  // 命令面板的分组就是命令自己的 category，别把 `palette/` 前缀露给用户
  if (g.startsWith('palette/')) return g.slice('palette/'.length)
  return GROUP_TITLES[g] ?? g
}
