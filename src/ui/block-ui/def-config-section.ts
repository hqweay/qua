/**
 * **定义值配置段**（一条属性的值怎么装）：格式、基数、`ref` 候选域、select 的选项编辑器。
 *
 * 判据：这三件事都是「这条属性的值」的配置，散着画就是三段断片（空属性段 → 一行格式 →
 * 裸标题「选项」），读者拼不出它们的归属。归组后「选项」降为组内的一个名字，
 * 组头说明这组配置管的是**成员块的值**。select 的选项编辑器是既有组件
 * （`choices-editor.ts`），这里只是把它挂进组里——全量视角（`focusTag` 为空）。
 *
 * 段不认识宿主，可被多个壳挂载（抽屉／将来的就地投影）：
 * 写能力由 deps 注入（命令面），「写完谁重画」由 `repaint` 带；撤销粒度归宿主的写路径。
 * 主体把关在段内：`def()` 不是属性定义块 ⇒ 不画，宿主不必重复判。
 *
 * 只有有格式轴的 kind 才有格式段（select 的配置是选项编辑器；checkbox/ref 没有格式）；
 * 格式改动**不动任何值**：值仍是同一个字符串，只是校验与输入框类型变了。
 */
import type { Block, ClickMods } from '../../core/index.ts'
import {
  allowsMany,
  blockLabel,
  cardinalityOf,
  clickModsOf,
  formatOf,
  isPropDef,
  PROP_KIND_SPECS,
  propKindOf,
  refDomainOf,
  type RefDomain,
  type RefDomainMode,
} from '../../core/index.ts'
import { t } from '../../core/infra/msg.ts'
import { sectionInfo } from '../../view/info.ts'
import { chipDel } from './config-sections.ts'
import { stackedRow, sectionHead } from './props-chrome.ts'
import { ChoicesEditor, type ChoiceActions } from './choices-editor.ts'

/** 格式的显示名（一张小表：格式是封闭集，翻不出去） */
function formatLabelOf(format: string): string {
  if (format === 'url') return t('ui.props.format.url')
  if (format === 'email') return t('ui.props.format.email')
  if (format === 'phone') return t('ui.props.format.phone')
  if (format === 'date') return t('ui.props.format.date')
  if (format === 'datetime') return t('ui.props.format.datetime')
  if (format === 'image') return t('ui.props.format.image')
  if (format === 'file') return t('ui.props.format.file')
  if (format === 'any') return t('ui.props.format.any')
  return t('ui.props.format.plain')
}

export interface DefConfigSectionDeps {
  /** 主体块活引用（每次现取：撤销/换库后旧引用可能已经不在森林里） */
  def: () => Block | undefined
  /** 写完谁重画（ctx 带）：宿主接自己的重画（抽屉＝整面板重画） */
  repaint: () => void
  /** 基数与选项的写入口（命令面；撤销/落盘都在宿主那条路上） */
  choices: ChoiceActions
  /** 定义格式的写入口（同值形状内的约束与画法；`plain` ＝ 摘键） */
  setFormat: (defId: string, format: string) => void
  /** 写候选域（`null` ＝ 不限，摘键） */
  setRefDomain: (defId: string, domain: RefDomain | null) => void
  /**
   * **`ref` 定义的候选域**（`_refDomain` 软约束）的三个入口：标签、指定块、查询。
   *
   * 选择器必须经装配层开（浮层不归段）；标签这一档收已有清单当排除项——
   * 第二次为同一个标签点「＋」不该再多给一条同样的 chip。
   */
  pickRefTag: (exclude: readonly string[], onPick: (tagId: string) => void, anchor: DOMRect) => void
  pickRefAnchor: (exclude: readonly string[], onPick: (blockId: string) => void, anchor: DOMRect) => void
  pickRefQuery: (onPick: (queryId: string) => void, anchor: DOMRect) => void
  /** 按 id 读块（候选域 chip 的悬空判定与显示名） */
  blockById: (id: string) => Block | undefined
  /** 短 id（悬空候选的显示） */
  shortId: (id: string) => string
  /** chip 名字可点＝打开它（与正文 chip 同一契约） */
  openRef: (to: string, mods: ClickMods) => void
  /* ---- 选项编辑器（select 定义）的读与浮层 ---- */
  /** 全库标签（选项作用域的勾选候选） */
  tags: () => readonly Block[]
  /** 标签块的显示名（作用域徽标里的 `#名`） */
  tagName: (id: string) => string
  /** 给选项选一个图标（装配层开浮层；未接 ⇒ 图标只读） */
  pickIcon?: (
    anchor: DOMRect,
    current: string,
    onPick: (icon: string) => void,
    trigger?: HTMLElement,
    face?: { color: string; onColor: (color: string) => void; recentColors: () => readonly string[] },
  ) => void
  /** 最近自定义色（设备态），与块脸选择器共用 */
  recentColors?: () => readonly string[]
}

export class DefConfigSection {
  private readonly deps: DefConfigSectionDeps
  /** select 定义的选项编辑器（全量视角；作用域面板的开合随实例跨重绘保留） */
  private readonly choicesFull: ChoicesEditor

  constructor(deps: DefConfigSectionDeps) {
    this.deps = deps
    this.choicesFull = new ChoicesEditor({
      def: () => deps.def(),
      tagById: deps.blockById,
      tags: deps.tags,
      write: deps.choices,
      tagName: deps.tagName,
      pickIcon: (anchor, current, onPick, trigger, face) =>
        deps.pickIcon?.(anchor, current, onPick, trigger, face),
      recentColors: deps.recentColors,
      focusTag: () => '',
    })
  }

  /** 主体不是属性定义块 ⇒ 不画（返回 null，宿主不挂） */
  render(): HTMLElement | null {
    const def = this.deps.def()
    if (!def || !isPropDef(def)) return null

    const config = document.createElement('section')
    config.className = 'props-section prop-def-config'
    const head = sectionHead('lucide:sliders-horizontal', t('ui.props.defValuesTitle'))
    // 同标签属性段：说明退成段头 ⓘ（解释没有操作权，不占正文宽度）
    head.appendChild(sectionInfo(t('ui.props.defValuesHint')))
    config.appendChild(head)

    const card = this.buildDefCardinality(def)
    if (card) config.appendChild(card)
    const fmt = this.buildDefFormat(def)
    if (fmt) config.appendChild(fmt)
    // `ref` 的候选域：只对 ref 定义出现（别的 kind 没有「候选」这回事）
    const refDomain = this.buildRefDomain(def)
    if (refDomain) config.appendChild(refDomain)
    // 选项编辑器：这条属性「能选什么」就是它自己的子块，改完立刻看得到
    if (propKindOf(def) === 'select') {
      this.choicesFull.render()
      config.appendChild(this.choicesFull.root)
    }
    return config
  }

  /**
   * **基数**（`_cardinality`）：一条属性在**一个块上**能有几个值。
   *
   * 它原来只在 `ChoicesEditor` 里（"允许多个值"），于是只有 `select` 定义做得到——
   * 而基数轴早就推广到全 kind（`PROP_KIND_SPECS[kind].many`：text／number／select／ref／asset，
   * date 先 one、checkbox 永不 many）。同一件事只有一类属性做得到，用户会以为
   * 「引用不能是列表」；真相是**界面没给入口**。
   *
   * 判据与写路径同一份：显隐读 `allowsMany(propKindOf(def))`，闸门在
   * `core.props/set-choice-cardinality`（切回 `one` 时挡住「库里仍有 >1 个值」）。
   * 命令拒绝时把控件重画回模型里的那个值——复选框不能停在用户点出来的状态上。
   */
  private buildDefCardinality(def: Block): HTMLElement | null {
    const kind = propKindOf(def)
    if (!allowsMany(kind)) return null
    const row = document.createElement('div')
    row.className = 'prop-row prop-def-multi prop-hug ui-row'
    const label = document.createElement('label')
    label.className = 'prop-label'
    const name = document.createElement('span')
    name.className = 'prop-name'
    name.textContent = t('ui.props.cardinality.label')
    label.append(name)
    const value = document.createElement('span')
    value.className = 'prop-value'
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'prop-check'
    box.dataset.defMulti = '1'
    box.checked = cardinalityOf(def) === 'many'
    box.addEventListener('change', () => {
      this.deps.choices.setCardinality(def.id, box.checked ? 'many' : 'one')
      this.deps.repaint()
    })
    const hint = document.createElement('span')
    hint.className = 'prop-source'
    hint.textContent = t('ui.props.cardinality.hint')
    value.append(box, hint)
    row.append(label, value)
    return row
  }

  /** 定义格式的一段（没有格式轴的 kind 返回 null：不给一个点了没用的下拉） */
  private buildDefFormat(def: Block): HTMLElement | null {
    const kind = propKindOf(def)
    const spec = PROP_KIND_SPECS[kind]
    if (spec.formats.length === 0) return null
    const row = document.createElement('div')
    row.className = 'prop-row prop-def-format ui-row'
    const label = document.createElement('label')
    label.className = 'prop-label'
    const name = document.createElement('span')
    name.className = 'prop-name'
    name.textContent = t('ui.props.format.label')
    label.append(name)
    const sel = document.createElement('select')
    sel.className = 'prop-input'
    sel.dataset.defFormat = '1'
    for (const f of spec.formats) {
      const o = document.createElement('option')
      o.value = f
      o.textContent = formatLabelOf(f)
      sel.appendChild(o)
    }
    // 没写过 `_format` 时显示该 kind 的第一个格式（text 的 plain／asset 的 image）
    sel.value = formatOf(def) ?? spec.formats[0] ?? ''
    sel.addEventListener('change', () => this.deps.setFormat(def.id, sel.value))
    row.append(label, sel)
    return row
  }

  /**
   * **`ref` 定义的候选域**（`_refDomain`）：候选从哪儿来。
   *
   * 四档同一根轴：**不限**（键缺席）／标签成员（含下级标签闭包）／手选块清单／查询块结果。
   * 它在定义页，不在值行上：域是**这条属性**的性质（谁可以被引用），不是某一格值的性质；
   * 值行只画「现在指向谁」——一个字节都不动。
   *
   * 两个判据：
   *   · **控件不许比存储先说**：切到某一档时先还原 `<select>` 的显示值，等「选中目标」
   *     那一步真的写进库、宿主重画，档位才变。取消选择 ⇒ 一切照旧（不丢原有配置）。
   *   · **悬空不静默**：手选的块/查询被删了仍画出来并标「已删除」，摘掉它就是回到不限。
   */
  private buildRefDomain(def: Block): HTMLElement | null {
    if (propKindOf(def) !== 'ref') return null
    const domain = refDomainOf(def)
    const mode: RefDomainMode = domain?.kind ?? 'any'

    const value = document.createElement('div')
    value.className = 'prop-value prop-ref-domain'
    value.dataset.refDomain = '1'

    const sel = document.createElement('select')
    sel.className = 'prop-input prop-ref-mode'
    sel.dataset.refDomainMode = '1'
    const modes = [
      ['any', 'ui.props.refDomain.any'],
      ['tags', 'ui.props.refDomain.mode.tags'],
      ['blocks', 'ui.props.refDomain.mode.blocks'],
      ['query', 'ui.props.refDomain.mode.query'],
    ] as const
    for (const [m, key] of modes) {
      const o = document.createElement('option')
      o.value = m
      o.textContent = t(key)
      sel.appendChild(o)
    }
    sel.value = mode
    sel.dataset.tip = t(
      mode === 'tags'
        ? 'ui.props.refDomain.hint.tags'
        : mode === 'blocks'
          ? 'ui.props.refDomain.hint.blocks'
          : mode === 'query'
            ? 'ui.props.refDomain.hint.query'
            : 'ui.props.refDomain.any',
    )
    sel.addEventListener('change', () => {
      const next = sel.value as RefDomainMode
      // 存储没变之前控件不许先说（取消选择时这里就是全部的回滚）
      sel.value = mode
      const rect = sel.getBoundingClientRect()
      if (next === 'any') {
        this.deps.setRefDomain(def.id, null)
        return
      }
      if (next === 'tags') {
        const ids = domain?.kind === 'tags' ? [...domain.ids] : []
        this.deps.pickRefTag(
          [],
          (tagId) => {
            if (!ids.includes(tagId)) this.deps.setRefDomain(def.id, { kind: 'tags', ids: [...ids, tagId] })
          },
          rect,
        )
        return
      }
      if (next === 'blocks') {
        const ids = domain?.kind === 'blocks' ? [...domain.ids] : []
        this.deps.pickRefAnchor(
          ids,
          (id) => {
            if (!ids.includes(id)) this.deps.setRefDomain(def.id, { kind: 'blocks', ids: [...ids, id] })
          },
          rect,
        )
        return
      }
      this.deps.pickRefQuery((id) => this.deps.setRefDomain(def.id, { kind: 'query', id }), rect)
    })
    value.appendChild(sel)

    /**
     * **「这一块叫什么」只有一个答案**：`blockLabel`（`relations/ref.ts` 的呈现兜底）。
     * 不要在这里写 `displayNameOf(...) || shortId` —— 日记块与空块没有别名，
     * `displayNameOf` 给空串，一兜就露出裸 id（用户认不出这是哪一块）。
     */
    const labelOf = (id: string): string => {
      const b = this.deps.blockById(id)
      return b
        ? blockLabel(b, (x) => this.deps.blockById(x))
        : t('ui.props.refMissing', { id: this.deps.shortId(id) })
    }
    /** 一枚约束 chip：点名字打开它；× 摘掉它（最后一个摘掉＝回到不限） */
    const domainChip = (id: string, onRemove: () => void): HTMLElement => {
      const live = this.deps.blockById(id)
      const chip = document.createElement('span')
      chip.className = 'props-tag'
      chip.dataset.refDomainTarget = id
      const name = document.createElement('span')
      name.className = 'props-tag-name'
      name.textContent = labelOf(id)
      if (live) {
        name.dataset.refTo = id
        name.dataset.tip = t('ui.props.openRef')
        name.addEventListener('click', (e) => this.deps.openRef(id, clickModsOf(e)))
      }
      chip.append(name, chipDel(t('ui.props.refDomain.remove'), onRemove))
      return chip
    }
    /** 「＋」：往清单里补一个（标签与指定块是追加；查询是换一个） */
    const addButton = (tip: string, onclick: (rect: DOMRect) => void): HTMLElement => {
      const add = document.createElement('button')
      add.type = 'button'
      add.className = 'prop-ref-add'
      add.dataset.refDomainAdd = '1'
      add.dataset.tip = tip
      add.textContent = '+'
      add.addEventListener('click', () => onclick(add.getBoundingClientRect()))
      return add
    }

    if (domain?.kind === 'tags') {
      for (const id of domain.ids) {
        const tag = this.deps.blockById(id)
        /**
         * 悬空标签（删了/换库了）仍画出来并标短 id：约束的失效是状态，
         * 静默少一枚 chip 会让用户以为约束本来就是这些。
         */
        const chip = document.createElement('span')
        chip.className = 'props-tag'
        chip.dataset.refTag = id
        const name = document.createElement('span')
        name.className = 'props-tag-name'
        name.textContent = tag ? `#${blockLabel(tag, (x) => this.deps.blockById(x))}` : `#${this.deps.shortId(id)}`
        if (tag) {
          name.dataset.refTo = id
          name.dataset.tip = t('ui.props.openTag')
          name.addEventListener('click', (e) => this.deps.openRef(id, clickModsOf(e)))
        }
        chip.append(
          name,
          chipDel(t('ui.props.refDomain.remove'), () =>
            this.deps.setRefDomain(def.id, { kind: 'tags', ids: domain.ids.filter((x) => x !== id) }),
          ),
        )
        value.appendChild(chip)
      }
      value.appendChild(
        addButton(t('ui.props.refDomain.hint.tags'), (rect) =>
          this.deps.pickRefTag(
            domain.ids,
            (tagId) => this.deps.setRefDomain(def.id, { kind: 'tags', ids: [...domain.ids, tagId] }),
            rect,
          ),
        ),
      )
    } else if (domain?.kind === 'blocks') {
      for (const id of domain.ids) {
        const rest = domain.ids.filter((x) => x !== id)
        value.appendChild(
          domainChip(id, () =>
            this.deps.setRefDomain(def.id, rest.length > 0 ? { kind: 'blocks', ids: rest } : null),
          ),
        )
      }
      value.appendChild(
        addButton(t('ui.props.refDomain.pickBlock'), (rect) =>
          this.deps.pickRefAnchor(
            domain.ids,
            (id) => {
              if (!domain.ids.includes(id)) {
                this.deps.setRefDomain(def.id, { kind: 'blocks', ids: [...domain.ids, id] })
              }
            },
            rect,
          ),
        ),
      )
    } else if (domain?.kind === 'query') {
      value.appendChild(domainChip(domain.id, () => this.deps.setRefDomain(def.id, null)))
      value.appendChild(
        addButton(t('ui.props.refDomain.pickQuery'), (rect) =>
          this.deps.pickRefQuery((id) => this.deps.setRefDomain(def.id, { kind: 'query', id }), rect),
        ),
      )
    }
    return stackedRow('prop-ref-domain-row', t('ui.props.refDomain.label'), value)
  }
}
