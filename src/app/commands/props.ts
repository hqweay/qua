/**
 * 属性命令：值的读写、字段定义的声明与摘除。
 */
import {
  CHOICE_SCOPE_PROP,
  clearValue,
  declareField,
  declareOwnProp,
  declaredFieldIds,
  displayNameOf,
  mkBlock,
  mkPropDef,
  normalizeAlias,
  parseChoiceScope,
  propKindOf,
  propLabel,
  setValue,
  undeclareField,
  type Block,
} from '../../core/index.ts'
import { textRuns } from '../../core/runs.ts'
import { t } from '../../core/msg.ts'
import type { App, PropCreateMode, PropTarget } from '../../core/ports.ts'
import type { PropsDeps } from './types.ts'

export function propsCommands(
  d: PropsDeps,
): Pick<
  App,
  | 'setPropValue'
  | 'clearPropValue'
  | 'createPropDef'
  | 'addProp'
  | 'undeclareProp'
  | 'addChoice'
  | 'setChoiceLabel'
  | 'moveChoice'
  | 'setChoiceScope'
  | 'deleteChoice'
> {
  const find = (id: string): Block | undefined => d.kb.get(id)

  const addProp = (blockId: string, propId: string, target: PropTarget): void => {
    const b = find(blockId)
    if (!b) return
    // 两个去处写两个不同的槽，**不按块类型猜**：
    // 「自己的值」与「成员的声明」可以同时存在于同一个页/标签块上。
    if (target === 'declared') {
      // 声明必须有自动获得方（标签的成员、页的子块）—— 普通块没有，返回 false 不写
      d.write(blockId, () => void declareField(b, propId))
      return
    }
    d.write(blockId, () => declareOwnProp(b, propId))
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
     * `mode: 'new'` 是那条「错了好改」的退路：同名两义是合法的，各自一个 `propId`。
     * 定义清单与标签清单都是**命名的库读**（`kb.propDefs`／`kb.tags`），不扫森林。
     */
    createPropDef: (blockId, label, kind, target, mode: PropCreateMode = 'reuse') => {
      const name = label.trim()
      if (name === '') {
        d.toast(t('ui.props.needLabel'), 'warn')
        return ''
      }
      const k = kind.trim() === '' ? 'text' : kind.trim()
      const existing =
        mode === 'new'
          ? undefined
          : d.kb.propDefs().find(
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
        // 定义块与「挂到这一块」是**同一笔**：拆开就会留下「定义有了、没人用它」的半批。
        // 定义住**森林顶层**（不被任何标签子树带走）；结构写经 `tx.insert` 产 op，
        // 不再零 op 直写——换库之后这条定义才有行可落。
        d.run((tx) => {
          tx.insert(def, null, d.kb.roots().length)
          if (blockId) {
            const b = d.kb.get(blockId)
            if (b) {
              if (target === 'declared') tx.patch(blockId, (x) => void declareField(x, def.id))
              else tx.patch(blockId, (x) => declareOwnProp(x, def.id))
            }
          }
        })
        d.toast(t('ui.props.created', { label: name }))
      }
      if (blockId && existing) addProp(blockId, propId, target)
      return propId
    },

    addProp,

    undeclareProp: (blockId, propId) => {
      const b = find(blockId)
      if (!b) return
      d.write(blockId, () => undeclareField(b, propId))
    },

    /* ---------------------------------------------------------- 选项 */

    /**
     * 加一个选项 ＝ 在定义块下插一个**普通子块**。
     *
     * 没有 `_choiceOf`：父块是定义就是选项。值与顺序都不在这条路径上
     * （值是块上的 id、顺序是兄弟序），所以这里只做一次插入。
     */
    addChoice: (defId, label, scope) => {
      const name = label.trim()
      if (name === '') {
        d.toast(t('ui.props.needLabel'), 'warn')
        return ''
      }
      const def = find(defId)
      if (!def || propKindOf(def) !== 'select') return ''
      const parsed = scope === undefined ? { mode: 'all' as const } : parseChoiceScope(scope)
      // 形状不认识 ⇒ 不写：宁可保留上一个合法作用域，也不落一格读不回来的值
      if (!parsed) return ''
      const choice = mkBlock(name, parsed.mode === 'all' ? {} : { props: { [CHOICE_SCOPE_PROP]: parsed } })
      d.run((tx) => tx.insert(choice, defId, def.children.length))
      return choice.id
    },

    /** 改选项名：正文就是名字，值存的是 id ⇒ **零值迁移** */
    setChoiceLabel: (choiceId, label) => {
      const name = label.trim()
      if (name === '') return
      const choice = find(choiceId)
      if (!choice) return
      d.run((tx) =>
        tx.patch(choiceId, (b) => {
          b.content = textRuns(name)
          b.modified = Date.now()
        }),
      )
    },

    /**
     * 重排选项：`beforeId` 之前的那个位置就是**最终**下标。
     *
     * `tx.move` 的 `index` 是「摘掉之后再插的位置」，所以目标在当前位置之后时要减一
     * （否则同一个动作会多走一格 —— 而且只在「往下移」的方向上错）。
     */
    moveChoice: (defId, choiceId, beforeId) => {
      const def = find(defId)
      if (!def) return
      const from = def.children.findIndex((c) => c.id === choiceId)
      if (from < 0) return
      const before = beforeId === '' ? -1 : def.children.findIndex((c) => c.id === beforeId)
      if (before === from) return
      const index = before < 0 ? def.children.length - 1 : before > from ? before - 1 : before
      d.run((tx) => tx.move(choiceId, defId, index))
    },

    /** 写选项的可见范围（三态；形状不认识就不写，别落一格读不回来的值） */
    setChoiceScope: (choiceId, scope) => {
      const choice = find(choiceId)
      if (!choice) return
      const parsed = parseChoiceScope(scope)
      if (!parsed) {
        d.toast(t('ui.props.choice.scopeInvalid'), 'warn')
        return
      }
      // 显式改回全局时连槽一起摘掉：`{mode:'all'}` 与「没有这一格」是同一个答案，
      // 留一个空壳只会让快照比较多出一处噪声
      d.run((tx) =>
        tx.patch(choiceId, (b) => {
          if (parsed.mode === 'all') {
            const props = { ...(b.props ?? {}) }
            delete props[CHOICE_SCOPE_PROP]
            if (Object.keys(props).length === 0) delete b.props
            else b.props = props
          } else {
            b.props = { ...(b.props ?? {}), [CHOICE_SCOPE_PROP]: parsed }
          }
        }),
      )
    },

    /**
     * 删一个选项 ＝ **普通软删**。
     *
     * 值一个字节都不动：恢复选项后，所有还指着它的块自动解析回来。
     * 清值是不可逆的第二个动作，不该藏在「删选项」里。
     */
    deleteChoice: (choiceId) => {
      if (!find(choiceId)) return
      d.run((tx) => tx.remove(choiceId))
    },
  }
}
