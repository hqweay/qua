/**
 * 角色与归属边 handler。
 *
 * 「这块是什么」用角色（`as-page` / `as-tag`），「这一块归在谁下面」用归属边
 * （`core.belongs-to/*`）——两件事，两个区段。
 */
import type { Handler } from '../../core/ports.ts'
import { curBlock, S } from './shared.ts'

export const TAGS_HANDLERS: Record<string, Handler> = {
  /* ---- 角色 ---- */
  'core.block/as-page': (a, app) => {
    const id = S(a.blockId) || curBlock(app)
    return id ? app.addBlockRole(id, 'page') : false
  },
  'core.block/unpage': (a, app) => {
    const id = S(a.blockId) || curBlock(app)
    return id ? app.removeBlockRole(id, 'page') : false
  },
  /**
   * 提取为页：标记 ＋ 搬到森林顶层 ＋ 原位置留下引用。
   * 三个前提（森林根／身份块／撞名）由门面先判，handler 只报「这块」。
   */
  'core.block/extract-to-page': (a, app) => {
    const id = S(a.blockId) || curBlock(app)
    return id ? app.extractToPage(id) : false
  },
  'core.block/as-tag': (a, app) => {
    const id = S(a.blockId) || curBlock(app)
    return id ? app.addBlockRole(id, 'tag') : false
  },
  'core.block/untag': (a, app) => {
    const id = S(a.blockId) || curBlock(app)
    return id ? app.removeBlockRole(id, 'tag') : false
  },
  'core.block/edit-aliases': (a, app) => {
    const id = S(a.blockId) || curBlock(app)
    if (!id) return false
    app.openAliasEditor(id)
    return true
  },
  'core.block/edit-fields': (a, app) => {
    const id = S(a.blockId) || curBlock(app)
    if (!id) return false
    app.openFieldsEditor(id)
    return true
  },
  'core.block/set-type': (a, app) => {
    const id = S(a.blockId) || curBlock(app)
    const type = S(a.type)
    if (!id || !type) return false
    return app.setBlockType(id, type)
  },
  /**
   * **块级标签的两个入口**（属性面板用）。
   *
   * 只写归属：与正文里敲 `#名`（那是提及，不写 `_tags`）是两件事，不会互相代替。
   * 撤销由编辑器记（一次挂/摘＝一笔撤销），所以这里不再包一层事务。
   */
  'core.tags/add': (a, app) => {
    const blockId = S(a.blockId, '')
    const name = S(a.name, '').trim()
    if (blockId === '' || name === '') return false
    return app.ed.addTag(blockId, name)
  },
  'core.tags/remove': (a, app) => {
    const blockId = S(a.blockId, '')
    const tagId = S(a.tagId, '')
    if (blockId === '' || tagId === '') return false
    return app.ed.removeTag(blockId, tagId)
  },

  /* ---- 归属边 ---- */
  'core.belongs-to/add': (a, app) => {
    const childId = S(a.childId)
    const parentId = S(a.parentId)
    if (!childId || !parentId) return false
    return app.addBelongsTo(childId, parentId)
  },
  'core.belongs-to/remove': (a, app) => {
    const childId = S(a.childId)
    const parentId = S(a.parentId)
    if (!childId || !parentId) return false
    app.removeBelongsTo(childId, parentId)
    return true
  },
  'core.belongs-to/prune': (a, app) => {
    const childId = S(a.childId)
    if (!childId) return false
    app.pruneBelongs(childId)
    return true
  },
  'core.editor/pick-tag': (_a, app) => {
    app.showTagPicker()
    return true
  },
}
