/**
 * 命令处理器 —— **app 层**（命令不知道 UI）：handler 只经 `App` 门面改状态，不碰 DOM。
 *
 * 原先与命令表、Registry 挤在同一个文件里 ⇒ core 文件不得不认识 app 实现。
 * 拆开后依赖方向恢复单向：core（表/注册表）← app（handler）← main（装配）。
 *
 * Handler 本体按「它动的是什么」分在 `handlers/` 下（块结构／页／日记／属性／角色与标签／
 * 视图浮层／演示）。本文件只做**合并**。
 *
 * ⚠️ 合并写成对象字面量、不带 `...spread` 的只有分域文件；`scripts/arch-check.mjs` 的 §18
 *    **扫的是 `handlers/*.ts` 的对象字面量属性**（排除 `shared.ts`），不是这个合并面。
 *    所以域文件里每个 handler 必须保持 `'core.x/y': (args, app) => …` 的字面量形状；
 *    改成变量再 spread 会让断言数不到（数到 0 也照样报过 —— 断言空转比红更危险）。
 */
import type { Handler } from '../core/ports.ts'
import { COLLECTION_HANDLERS } from './handlers/collection.ts'
import { STRUCT_HANDLERS } from './handlers/block.ts'
import { DEV_HANDLERS } from './handlers/dev.ts'
import { JOURNAL_HANDLERS } from './handlers/journal.ts'
import { MOUNT_HANDLERS } from './handlers/mount.ts'
import { PAGE_HANDLERS } from './handlers/page.ts'
import { PROPS_HANDLERS } from './handlers/props.ts'
import { TAGS_HANDLERS } from './handlers/tags.ts'
import { VIEW_HANDLERS } from './handlers/view.ts'

/* ------------------------------------------------------------ 处理器 */

export const HANDLERS: Record<string, Handler> = {
  ...STRUCT_HANDLERS,
  ...PROPS_HANDLERS,
  ...MOUNT_HANDLERS,
  ...COLLECTION_HANDLERS,
  ...TAGS_HANDLERS,
  ...PAGE_HANDLERS,
  ...JOURNAL_HANDLERS,
  ...VIEW_HANDLERS,
  ...DEV_HANDLERS,
}
