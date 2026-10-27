/**
 * 集合组件 handler：只做参数收形，写路径交给门面。
 *
 * 新建后**显式打开到指定槽**：集合是「看得见的组件」，建完落在库里却不在槽里
 * 会让用户以为没建成功。
 */
import type { Handler } from '../../core/ports.ts'
import { S } from './shared.ts'

export const COLLECTION_HANDLERS: Record<string, Handler> = {
  'core.collection/create': (a, app) => {
    const id = app.createCollection(S(a.name))
    if (!id) return false
    app.openInDock(id, a.side === 'left' ? 'left' : 'right')
    return true
  },
  'core.collection/add': (a, app) => {
    const collectionId = S(a.collectionId)
    const blockId = S(a.blockId)
    if (!collectionId || !blockId) return false
    return app.addCollectionItem(collectionId, blockId)
  },
  'core.collection/remove': (a, app) => {
    const collectionId = S(a.collectionId)
    const blockId = S(a.blockId)
    if (!collectionId || !blockId) return false
    return app.removeCollectionItem(collectionId, blockId)
  },
  'core.collection/move': (a, app) => {
    const collectionId = S(a.collectionId)
    const blockId = S(a.blockId)
    const to = typeof a.to === 'number' ? a.to : Number(a.to)
    if (!collectionId || !blockId || !Number.isInteger(to)) return false
    return app.moveCollectionItem(collectionId, blockId, to)
  },
}
