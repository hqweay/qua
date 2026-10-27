/**
 * 集合组件的写路径：新建一个集合块，或往/从 `_items` 里加/摘一条引用。
 *
 * 三件事都只写**一格属性**（或一次建块）；不搬块、不删块、不改树。
 * 这就是「收藏」与「移动」的分界：收藏只加一条引用，块的真实位置不动。
 */
import {
  collectionItems,
  isCollectionBlock,
  mkCollectionBlock,
  moveCollectionItem as moveItemInList,
  setCollectionItems,
} from '../../core/index.ts'
import { t } from '../../core/msg.ts'
import type { App } from '../../core/ports.ts'
import type { CollectionDeps } from './types.ts'

export function collectionCommands(
  d: CollectionDeps,
): Pick<App, 'createCollection' | 'addCollectionItem' | 'removeCollectionItem' | 'moveCollectionItem'> {
  return {
    createCollection: (name) => {
      const title = (name ?? '').trim() || t('ui.widget.collection')
      const r = d.run((tx) => {
        const block = mkCollectionBlock(title)
        tx.insert(block, null, d.kb.roots().length)
        return block.id
      })
      return r.result
    },

    addCollectionItem: (collectionId, blockId) => {
      const collection = d.kb.get(collectionId)
      if (!collection || !isCollectionBlock(collection)) return false
      if (blockId === collectionId || !d.kb.get(blockId)) return false
      const items = collectionItems(collection)
      if (items.includes(blockId)) return false
      d.write(collectionId, () => setCollectionItems(collection, [...items, blockId]))
      return true
    },

    removeCollectionItem: (collectionId, blockId) => {
      const collection = d.kb.get(collectionId)
      if (!collection || !isCollectionBlock(collection)) return false
      const items = collectionItems(collection)
      const next = items.filter((id) => id !== blockId)
      if (next.length === items.length) return false
      d.write(collectionId, () => setCollectionItems(collection, next))
      return true
    },

    moveCollectionItem: (collectionId, blockId, to) => {
      const collection = d.kb.get(collectionId)
      if (!collection || !isCollectionBlock(collection)) return false
      if (!Number.isInteger(to)) return false
      const next = moveItemInList(collectionItems(collection), blockId, to)
      if (!next) return false
      d.write(collectionId, () => setCollectionItems(collection, next))
      return true
    },
  }
}
