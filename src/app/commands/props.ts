/**
 * 属性命令：值的读写、字段定义的声明与摘除。
 */
import {
  CARDINALITY_PROP,
  CHECK_PROP,
  CHILD_PROPS_PROP,
  CHOICE_SCOPE_PROP,
  ICON_PROP,
  UI_POSITION_PROP,
  USE_PROP,
  cardinalityOf,
  checkOf,
  childDisplayProps,
  flatten,
  hasList,
  parseCheckSpec,
  useOf,
  valueListOf,
  clearKeepsField,
  clearValue,
  declareField,
  declareOwnProp,
  declaredFieldIds,
  displayNameOf,
  mkBlock,
  membersOf,
  mkPropDef,
  normalizeAlias,
  parseChoiceScope,
  propKindOf,
  propLabel,
  setValue,
  undeclareField,
  type Block,
  type Cardinality,
  type UiPosition,
} from '../../core/index.ts'
import { textRuns } from '../../core/model/runs.ts'
import { t } from '../../core/infra/msg.ts'
import type { App, PropCreateMode, PropTarget } from '../../core/infra/ports.ts'
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
  | 'setChoiceIcon'
  | 'setChoiceCheck'
  | 'setChoiceCardinality'
  | 'setUiPosition'
  | 'setChildProps'
  | 'deleteChoice'
> {
  const find = (id: string): Block | undefined => d.kb.get(id)

  /**
   * 写/摘一个系统键，并保持「属性袋不留空壳」的既有形状（`{}` 与「没有属性」是两件事）。
   * `value === undefined` ⇒ 删键。
   */
  const patchProp = (b: Block, key: string, value: unknown): void => {
    const props = { ...(b.props ?? {}) }
    if (value === undefined) delete props[key]
    else props[key] = value
    if (Object.keys(props).length === 0) delete b.props
    else b.props = props
  }

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
      // 定义给了缺省值的字段（如任务状态）：清空停在「待填」，行不摘 ——
      // 「未填」是定义支持的读侧状态；摘栏走这类字段专属的命令（取消待办）
      const def = d.kb.propDefs().find((x) => x.id === propId)
      d.write(blockId, () => clearValue(b, propId, { keepField: clearKeepsField(def) }))
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

    /** 写选项图标：空串 ＝ 摘掉这一格（无图标） */
    setChoiceIcon: (choiceId, icon) => {
      if (!find(choiceId)) return
      const value = icon.trim()
      d.run((tx) => tx.patch(choiceId, (b) => patchProp(b, ICON_PROP, value === '' ? undefined : value)))
    },

    /**
     * 写/摘勾选框映射（`_check {on, off}`），可选把它标成任务状态（`_use: 'status'`）。
     *
     * - `spec === null` ⇒ 摘掉 `_check` 与 `_use`；
     * - `status: true` ⇒ 库级唯一：已有另一条任务状态属性就拒绝，不静默换主；
     * - 多值属性不能有勾选框（单值才能「勾一个」）。
     */
    setChoiceCheck: (defId, spec) => {
      const def = find(defId)
      if (!def || propKindOf(def) !== 'select') return
      if (spec === null) {
        d.run((tx) =>
          tx.patch(defId, (b) => {
            patchProp(b, CHECK_PROP, undefined)
            if (useOf(b) === 'status') patchProp(b, USE_PROP, undefined)
          }),
        )
        return
      }
      const parsed = parseCheckSpec(spec)
      if (!parsed) {
        d.toast(t('ui.props.choice.checkInvalid'), 'warn')
        return
      }
      if (cardinalityOf(def) === 'many') {
        d.toast(t('ui.props.choice.checkMultiBlocked'), 'warn')
        return
      }
      if (spec.status) {
        const other = d.kb.propDefs().find((x) => x.id !== defId && useOf(x) === 'status')
        if (other) {
          d.toast(t('ui.props.choice.statusTaken', { label: propLabel(other) }), 'warn')
          return
        }
      }
      d.run((tx) =>
        tx.patch(defId, (b) => {
          patchProp(b, CHECK_PROP, parsed)
          patchProp(b, USE_PROP, spec.status ? 'status' : undefined)
        }),
      )
    },

    /**
     * 切换单值/多值。
     *
     * 切到多值不需要迁移旧值：读路径把单值当作「只有一个」（`valueListOf`），
     * 下一次写值自然归一成数组。切回单值要**挡住仍有 >1 个值的库**——
     * 否则那些值会在界面上静默变成「只显示第一个」，而数据还在。
     * 这是一次罕见动作，扫一遍森林可以接受；不在打字路径上。
     */
    setChoiceCardinality: (defId, cardinality: Cardinality) => {
      const def = find(defId)
      if (!def || propKindOf(def) !== 'select') return
      // 多值不能是勾选框/任务状态：先摘掉映射，别留下一个读出来无效的 `_check`
      if (cardinality === 'many' && checkOf(def) !== undefined) {
        d.toast(t('ui.props.choice.checkMultiBlocked'), 'warn')
        return
      }
      if (cardinality === 'one') {
        const hasMulti = flatten({ roots: [...d.kb.roots()] }).some((b) => valueListOf(b.props?.[defId]).length > 1)
        if (hasMulti) {
          d.toast(t('ui.props.choice.multiBlocked'), 'warn')
          return
        }
      }
      d.run((tx) =>
        tx.patch(defId, (b) => patchProp(b, CARDINALITY_PROP, cardinality === 'many' ? 'many' : undefined)),
      )
    },

    /** 写定义块的快捷入口位置（`panel` ＝ 摘键，回到缺省） */
    setUiPosition: (defId, position: UiPosition) => {
      if (!find(defId)) return
      d.run((tx) =>
        tx.patch(defId, (b) => patchProp(b, UI_POSITION_PROP, position === 'panel' ? undefined : position)),
      )
    },

    /**
     * 写/摘「子块行内属性显示」声明（`_childProps`）：`on` 加一格、`off` 摘一格，
     * 清空＝摘键（「没有声明」与「空声明」是两件事）。
     */
    setChildProps: (blockId, propId, on: boolean) => {
      const parent = find(blockId)
      if (!parent) return
      d.run((tx) =>
        tx.patch(blockId, (b) => {
          const next = childDisplayProps(b).filter((id) => id !== propId)
          if (on) next.push(propId)
          patchProp(b, CHILD_PROPS_PROP, next.length > 0 ? next : undefined)
        }),
      )
      // 声明写在父块，显示变在**子块的行**——写回调只重画父块，受影响的行在这里列出来：
      // 普通块 ⇒ 它的孩子；**标签块** ⇒ 全体成员的孩子（解析链含标签声明，成员的子块都显示）
      const affected = hasList(parent, 'tag')
        ? [...membersOf(blockId, d.kb.roots())].flatMap((mid) => d.kb.get(mid)?.children.map((c) => c.id) ?? [])
        : parent.children.map((c) => c.id)
      d.repaintBlocks([blockId, ...affected])
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
