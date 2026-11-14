/**
 * 属性命令：值的读写、字段定义的声明与摘除。
 */
import {
  CARDINALITY_PROP,
  CHECK_PROP,
  FORMAT_PROP,
  PROP_KIND_SPECS,
  CHILD_PROPS_PROP,
  UI_POSITION_PROP,
  USE_PROP,
  allChoicesOf,
  allowsMany,
  cardinalityOf,
  checkOf,
  childDisplayProps,
  flatten,
  formatOf,
  hasList,
  isAssetRef,
  isCurrentPropKind,
  parseCheckSpec,
  useOf,
  valueListOf,
  clearKeepsField,
  clearValue,
  declareField,
  declareOwnProp,
  declaredFieldIds,
  displayNameOf,
  membersOf,
  mkPropDef,
  newChoiceId,
  normalizeAlias,
  parseChoiceScope,
  patchChoice,
  propKindOf,
  propLabel,
  setChoices,
  setValue,
  textFormatOk,
  undeclareField,
  valuesOk,
  type Block,
  type Cardinality,
  type UiPosition,
} from '../../core/index.ts'
import { t } from '../../core/infra/msg.ts'
import type { App, PropCreateMode, PropTarget } from '../../core/infra/ports.ts'
import type { PropsDeps } from './types.ts'

/** 文本格式的显示名（`ui.props.format.*` 的一张小表；缺省按纯文本） */
function textFormatLabel(format: string | undefined): string {
  if (format === 'url') return t('ui.props.format.url')
  if (format === 'email') return t('ui.props.format.email')
  if (format === 'phone') return t('ui.props.format.phone')
  return t('ui.props.format.plain')
}

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
  | 'restoreChoice'
  | 'setPropFormat'
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

  /**
   * 选项 id → 宿主定义块。
   *
   * **记录不在森林里**，没有 `store.find` 可走，而端口签名只给 `choiceId`
   * （面板/编辑器手里只有「我改的是哪一条」）。反查走命名库读 `kb.propDefs()`
   * ——定义数量级、且不在打字路径上，可以接受。
   * 返回 undefined ＝ 这条记录真没了（另一个库／定义被删）：命令静默 no-op。
   */
  const defOfChoice = (choiceId: string): Block | undefined =>
    d.kb.propDefs().find((def) => allChoicesOf(def).some((c) => c.id === choiceId))

  return {
    /**
     * 写一格值：**按定义声明的 kind／format 校验**，不合就不写。
     *
     * 为什么校验放在命令这一侧、而不是控件里：值的形状是**模型**的事
     * （查询算子全靠它正确），控件只是入口之一；只在校验控件里做，
     * 换一个入口（表格、命令面、将来的同步）就能落进坏值。
     * 拒写时不静默：给一句提示，用户知道刚才那次没生效。
     */
    setPropValue: (blockId, propId, value) => {
      const b = find(blockId)
      if (!b) return
      const def = d.kb.propDefs().find((x) => x.id === propId)
      if (def && value !== undefined && value !== null) {
        const kind = propKindOf(def)
        if (!valuesOk(kind, value)) {
          d.toast(t('ui.props.valueShapeInvalid', { kind: t(`ui.props.kind.${kind}`) }), 'warn')
          return
        }
        const list = Array.isArray(value) ? value : [value]
        if (kind === 'text') {
          const fmt = formatOf(def)
          if (!list.every((v) => typeof v === 'string' && textFormatOk(fmt, v))) {
            d.toast(t('ui.props.formatInvalid', { format: textFormatLabel(fmt) }), 'warn')
            return
          }
        }
        if (kind === 'asset' && !list.every((v) => isAssetRef(v))) {
          d.toast(t('ui.props.assetInvalid'), 'warn')
          return
        }
      }
      d.write(blockId, () => setValue(b, propId, value))
    },

    clearPropValue: (blockId, propId, opts) => {
      const b = find(blockId)
      if (!b) return
      const def = d.kb.propDefs().find((x) => x.id === propId)
      /**
       * 两条语义：
       *   · 值控件清空（不传 `drop`）：定义给了缺省值的字段停在「待填」，行不摘 ——
       *     「未填」是定义支持的读侧状态；
       *   · 「删掉这一栏」（`drop`）：值连自有槽一起走。对自有行这就是行消失；
       *     对标签声明来的行只是清值（声明在标签上，行该留着）——那是正确结果。
       */
      const keepField = opts?.drop === true ? false : clearKeepsField(def)
      d.write(blockId, () => clearValue(b, propId, { keepField }))
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
        const def = mkPropDef(name, isCurrentPropKind(k) ? k : 'text')
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
     * 加一个选项 ＝ 往定义块的 `_choices` 追加一条记录。
     *
     * 值与顺序都不在这条路径上（值是块上的记录 id、顺序是数组序），
     * 所以这里只做一次属性写 —— **不再插子块**。
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
      const id = newChoiceId()
      d.run((tx) =>
        tx.patch(defId, (b) =>
          setChoices(b, [
            ...allChoicesOf(b),
            { id, label: name, ...(parsed.mode === 'all' ? {} : { scope: parsed }) },
          ]),
        ),
      )
      return id
    },

    /** 改选项名：名字就是记录里的 `label`，值存的是 id ⇒ **零值迁移** */
    setChoiceLabel: (choiceId, label) => {
      const name = label.trim()
      if (name === '') return
      const def = defOfChoice(choiceId)
      if (!def) return
      d.run((tx) =>
        tx.patch(def.id, (b) => setChoices(b, patchChoice(allChoicesOf(b), choiceId, (c) => ({ ...c, label: name })))),
      )
    },

    /**
     * 重排选项：`beforeId` **之前**的那个位置就是最终下标。
     *
     * 数组重排＝先把这一条摘出来，再插到目标之前（目标在它后面时，摘出后下标自然前移）。
     * `beforeId` 为空 ⇒ 末尾。
     */
    moveChoice: (defId, choiceId, beforeId) => {
      const def = find(defId)
      if (!def) return
      const list = allChoicesOf(def)
      const from = list.findIndex((c) => c.id === choiceId)
      if (from < 0) return
      if (choiceId === beforeId) return
      const moved = list[from]!
      const rest = list.filter((c) => c.id !== choiceId)
      const before = beforeId === '' ? -1 : rest.findIndex((c) => c.id === beforeId)
      const index = before < 0 ? rest.length : before
      const next = [...rest.slice(0, index), moved, ...rest.slice(index)]
      d.run((tx) => tx.patch(defId, (b) => setChoices(b, next)))
    },

    /** 写选项的可见范围（三态；形状不认识就不写，别落一格读不回来的值） */
    setChoiceScope: (choiceId, scope) => {
      const def = defOfChoice(choiceId)
      if (!def) return
      const parsed = parseChoiceScope(scope)
      if (!parsed) {
        d.toast(t('ui.props.choice.scopeInvalid'), 'warn')
        return
      }
      d.run((tx) =>
        tx.patch(def.id, (b) =>
          setChoices(
            b,
            patchChoice(allChoicesOf(b), choiceId, (c) => {
              // 显式改回全局时连字段一起摘掉：`{mode:'all'}` 与「没有这一格」是同一个答案
              if (parsed.mode === 'all') {
                const { scope: _drop, ...rest } = c
                return rest
              }
              return { ...c, scope: parsed }
            }),
          ),
        ),
      )
    },

    /** 写选项图标：空串 ＝ 摘掉这一格（无图标，回落定义块的图标） */
    setChoiceIcon: (choiceId, icon) => {
      const def = defOfChoice(choiceId)
      if (!def) return
      const value = icon.trim()
      d.run((tx) =>
        tx.patch(def.id, (b) =>
          setChoices(
            b,
            patchChoice(allChoicesOf(b), choiceId, (c) => {
              const { icon: _drop, ...rest } = c
              return value === '' ? rest : { ...rest, icon: value }
            }),
          ),
        ),
      )
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
      if (!def) return
      const kind = propKindOf(def)
      // 基数轴已从 select 推广到全 kind，但**允许集按 kind 收**：
      // date 先只 one、checkbox 永不 many —— 注册表 `many` 是唯一判据
      if (cardinality === 'many' && !allowsMany(kind)) {
        d.toast(t('ui.props.cardinality.notAllowed', { kind: t(`ui.props.kind.${kind}`) }), 'warn')
        return
      }
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

    /**
     * 写/摘定义的**格式**（同值形状内的约束与画法）。
     *
     * 没有格式轴的 kind（checkbox／select／ref）拒绝写入 —— 写进去也没人读，
     * 而「读不出来」会让人以为格式坏了。
     * `plain` 与「没有这一格」是同一个答案：摘键，不留空壳。
     */
    setPropFormat: (defId, format) => {
      const def = find(defId)
      if (!def) return
      const kind = propKindOf(def)
      const spec = PROP_KIND_SPECS[kind]
      if (spec.formats.length === 0) {
        d.toast(t('ui.props.formatNotAllowed', { kind: t(`ui.props.kind.${kind}`) }), 'warn')
        return
      }
      const next = format.trim()
      if (next !== '' && next !== 'plain' && !spec.formats.includes(next)) {
        d.toast(t('ui.props.formatUnknown', { format: next }), 'warn')
        return
      }
      d.run((tx) => tx.patch(defId, (b) => patchProp(b, FORMAT_PROP, next === '' || next === 'plain' ? undefined : next)))
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
     * 删一个选项 ＝ **给记录立墓碑**。
     *
     * 值一个字节都不动：记录仍在数组原位、仍读得出名字，控件显示「已删除」。
     * 恢复选项＝撤掉墓碑（入口随选项编辑器排轮）；清值是不可逆的第二个动作，
     * 不该藏在「删选项」里 —— 同类工具的数据库版「删选项连值一起删」正是这条的反面。
     */
    deleteChoice: (choiceId) => {
      const def = defOfChoice(choiceId)
      if (!def) return
      d.run((tx) =>
        tx.patch(def.id, (b) =>
          setChoices(b, patchChoice(allChoicesOf(b), choiceId, (c) => ({ ...c, deleted: true as const }))),
        ),
      )
    },

    /** 撤墓碑：记录回到候选，所有还指着它的块当场解析回旧名（值一个字节不动） */
    restoreChoice: (choiceId) => {
      const def = defOfChoice(choiceId)
      if (!def) return
      d.run((tx) =>
        tx.patch(def.id, (b) =>
          setChoices(
            b,
            patchChoice(allChoicesOf(b), choiceId, (c) => {
              const { deleted: _drop, ...rest } = c
              return rest
            }),
          ),
        ),
      )
    },
  }
}
