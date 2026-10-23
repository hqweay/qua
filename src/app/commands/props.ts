/**
 * 属性命令：值的读写、字段定义的声明与摘除。
 */
import {
  allPropDefs,
  allTags,
  clearValue,
  declareField,
  declareOwnProp,
  declaredFieldIds,
  displayNameOf,
  findInForest,
  hasList,
  mkPropDef,
  normalizeAlias,
  propKindOf,
  propLabel,
  setValue,
  undeclareField,
  type Block,
} from '../../core/index.ts'
import { t } from '../../core/msg.ts'
import type { App } from '../../core/ports.ts'
import type { PropsDeps } from './types.ts'

export function propsCommands(
  d: PropsDeps,
): Pick<App, 'setPropValue' | 'clearPropValue' | 'createPropDef' | 'addProp' | 'undeclareProp'> {
  const find = (id: string): Block | undefined => findInForest(d.blocks(), id)

  const addProp = (blockId: string, propId: string): void => {
    const b = find(blockId)
    if (!b) return
    // 页/标签声明它（成员／子块可用）；普通块没有消费者，只登记「这一块有它」
    if (hasList(b, 'page') || hasList(b, 'tag')) d.write(blockId, () => declareField(b, propId))
    else d.write(blockId, () => declareOwnProp(b, propId))
  }

  return {
    setPropValue: (blockId, propId, value) => {
      const b = find(blockId)
      if (!b) return
      d.write(blockId, () => setValue(b, propId, value))
    },

    clearPropValue: (blockId, propId) => {
      const b = find(blockId)
      if (!b) return
      d.write(blockId, () => clearValue(b, propId))
    },

    /**
     * 新建字段定义。
     *
     * **默认复用**：已有**同名同 kind** 的定义 ⇒ 指向同一个 `propId`，
     * 并显示来源（「已有同名定义（来自 #书）」）；kind 不同或显式新建 ⇒ 新定义。
     * 误复用可改回、误分槽要迁数据 ⇒ 默认选「错了好改」的那一边。
     */
    createPropDef: (blockId, label, kind) => {
      const name = label.trim()
      if (name === '') {
        d.toast(t('ui.props.needLabel'), 'warn')
        return ''
      }
      const k = kind.trim() === '' ? 'text' : kind.trim()
      const existing = allPropDefs(d.blocks()).find(
        (def) => normalizeAlias(propLabel(def)) === normalizeAlias(name) && propKindOf(def) === k,
      )
      let propId = ''
      if (existing) {
        propId = existing.id
        const from = allTags(d.blocks())
          .filter((tag) => declaredFieldIds(tag).includes(propId))
          .map((tag) => `#${displayNameOf(tag)}`)
          .join('、')
        d.toast(t('ui.props.reused', { source: from === '' ? t('ui.props.own') : from }), 'info')
      } else {
        const def = mkPropDef(name, k === 'text' || k === 'number' || k === 'date' || k === 'checkbox' || k === 'select' || k === 'ref' || k === 'url' ? k : 'text')
        d.write(undefined, () => {
          // 定义住在**森林顶层**：不被任何标签子树带走
          d.blocks().push(def)
        })
        propId = def.id
        d.toast(t('ui.props.created', { label: name }))
      }
      if (blockId) addProp(blockId, propId)
      return propId
    },

    addProp,

    undeclareProp: (blockId, propId) => {
      const b = find(blockId)
      if (!b) return
      d.write(blockId, () => undeclareField(b, propId))
    },
  }
}
