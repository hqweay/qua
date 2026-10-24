/**
 * 属性命令：值的读写、字段定义的声明与摘除。
 */
import {
  clearValue,
  declareField,
  declareOwnProp,
  declaredFieldIds,
  displayNameOf,
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
  const find = (id: string): Block | undefined => d.kb.get(id)

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
     * 定义清单与标签清单都是**命名的库读**（`kb.propDefs`／`kb.tags`），不扫森林。
     */
    createPropDef: (blockId, label, kind) => {
      const name = label.trim()
      if (name === '') {
        d.toast(t('ui.props.needLabel'), 'warn')
        return ''
      }
      const k = kind.trim() === '' ? 'text' : kind.trim()
      const existing = d.kb.propDefs().find(
        (def) => normalizeAlias(propLabel(def)) === normalizeAlias(name) && propKindOf(def) === k,
      )
      let propId = ''
      if (existing) {
        propId = existing.id
        const from = d.kb
          .tags()
          .filter((tag) => declaredFieldIds(tag).includes(propId))
          .map((tag) => `#${displayNameOf(tag)}`)
          .join('、')
        d.toast(t('ui.props.reused', { source: from === '' ? t('ui.props.own') : from }), 'info')
      } else {
        const def = mkPropDef(name, k === 'text' || k === 'number' || k === 'date' || k === 'checkbox' || k === 'select' || k === 'ref' || k === 'url' ? k : 'text')
        propId = def.id
        // 定义块与「声明到这一块」是**同一笔**：拆开就会留下「定义有了、没人声明」的半批。
        // 定义住**森林顶层**（不被任何标签子树带走）；结构写经 `tx.insert` 产 op，
        // 不再零 op 直写——换库之后这条定义才有行可落。
        d.run((tx) => {
          tx.insert(def, null, d.kb.roots().length)
          if (blockId) {
            const b = d.kb.get(blockId)
            if (b) {
              if (hasList(b, 'page') || hasList(b, 'tag')) tx.patch(blockId, (x) => declareField(x, def.id))
              else tx.patch(blockId, (x) => declareOwnProp(x, def.id))
            }
          }
        })
        d.toast(t('ui.props.created', { label: name }))
      }
      if (blockId && existing) addProp(blockId, propId)
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
