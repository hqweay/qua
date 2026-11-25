/**
 * **块的角色与属性写入**：一次「改块自己的属性」＝写模型＋重画这一行（`writeProps`）、
 * 行重画（`repaintBlock`）、显示名（`blockName`）、页/标签四件（加列表／设色／设脸／摘列表）、
 * 类型写入，以及块下属性行的「这一块怎么排」三态（`propsLineModeOf`／`openPropsLineMenu`）。
 *
 * 为什么「写」与「重画」必须同住：属性里有一族是**外观的输入**（`_aliases`/`_lists`/`_type`/
 * gutter 标记），而 `tx` 的发起者收不到自己的通知——只写不重画，屏幕就停在旧样子。
 *
 * `scheduleProperties` 由装配层注入（面板晚于本片装配，闭包现取）；
 * `getEd`/`getMainEd`/三个 app 委托同为闭包——运行期才会调。
 */
import {
  blockLabel,
  blockTypeOf,
  canConvertBlockType,
  CODE_TYPE,
  CODE_TEXT_PROP,
  codeTextOf,
  claimAlias,
  declaredFieldIds,
  DISPLAY_PROP,
  findInForest,
  hasList,
  ICON_PROP,
  LANG_PROP,
  isColorValue,
  primaryAliasOf,
  prop,
  setBlockType,
  writeBlockContent,
  tagMemberIds,
  COLOR_PROP,
  addAlias,
  addList,
  removeList,
  plainText,
  textRuns,
  type Block,
} from '../../core/index.ts'
import { takenWhere } from '../../app/commands-impl.ts'
import { t } from '../../core/infra/msg.ts'
import type { App } from '../../core/infra/ports.ts'
import { Layers, type Row } from '../../ui/overlay/layers.ts'
import type { BlockStore } from '../../core/model/store.ts'
import type { BlockEditor } from '../../view/editor/editor.ts'
import type { MemoryKb } from '../../core/kb/memory.ts'
import type { Prefs, Workspace } from '../../core/infra/workspace.ts'
import type { Tx as KbTx, Op, Change } from '../../core/kb/types.ts'
import type { UndoCapture } from '../../core/kb/scoped.ts'

export interface BlockPropsDeps {
  ws: Workspace
  blocks: BlockStore
  kb: MemoryKb
  kbGet: (id: string) => Block | undefined
  /** 命令层事务入口（持久化片的那个：带撤销捕获与变更清单；直接传值） */
  txRun: <R>(
    fn: (tx: KbTx) => R,
    source?: unknown,
    opts?: { capture?: (undo: UndoCapture) => void },
  ) => { ops: Op[]; changes: Change[]; result: R; undo: UndoCapture }
  scheduleSave: () => void
  scheduleBadge: () => void
  /** 属性面板的重画排队（面板晚于本片装配 ⇒ 装配层给闭包） */
  scheduleProperties: () => void
  openMenu: Layers['openMenu']
  prefs: () => Prefs
  getEd: () => BlockEditor
  getMainEd: () => BlockEditor
  toast: App['toast']
  openBlockConfig: App['openBlockConfig']
  setPropsLineMode: App['setPropsLineMode']
  /** 短 id（uuidv7 尾段）：装配层唯一一份，显示兜底共用 */
  shortId: (id: string) => string
}

export function setupBlockProps(deps: BlockPropsDeps) {
  const { ws, blocks, kb, kbGet, txRun, scheduleSave, scheduleBadge, scheduleProperties, openMenu, prefs, getEd, getMainEd, toast, openBlockConfig, setPropsLineMode, shortId } = deps

/* ------------------------------------------------------------ 属性写入 / 摘标签提示 */

/**
 * 一次「改块自己的属性」，**连带重画这一行**。
 *
 * 为什么重画是它的一部分，而不是调用方各自记得：这块的属性里有一族是**外观的输入** ——
 * `_aliases` / `_lists`（别名头与身份图标）、`_type`（类型外观）、
 * 以及 gutter 标记（待办方框、标签身份）所用的那些 prop。写完之后那一行的 DOM
 * 就已经过期了，而 `mainEd` 是 `tx` 的发起者、**收不到自己的通知**
 * （`store.touch(source)` 不回调发起者）—— 所以「写模型」与「重画这一行」
 * 必须同时发生，否则屏幕上留着一个旧样子，直到别的动作把那一行重画。
 *
 * ⚠️ 早先这里只有写、重画靠调用方各自补：`writeBlockProps` 补了，
 *    而属性命令那条路径（面板「添加块属性」）没补 —— 于是给块挂上「任务状态」之后，
 *    模型里已经有了、右侧卡里也有了，**块左边的待办方框却不出现**。
 *    加属性看似「只是一条数据的改动」，但它同时是这一行外观的输入。
 */
function writeProps(blockId: string, mutate: () => void): void {
  const sel = getEd().sel
  const r = txRun((tx) => tx.patch(blockId, mutate), getMainEd())
  blocks.record(r.undo, sel, 'other', Date.now())
  // 行自己：别名头 / 身份图标 / 类型外观 / gutter 标记都在这一行的 DOM 里
  repaintBlock(blockId)
  // 右槽的检视卡：属性行与「来源」都变了
  scheduleProperties()
  scheduleSave()
  scheduleBadge()
}

/**
 * 重画一个块所在的行（当前活动编辑器里的；不在视图里的块是 no-op）。
 *
 * ⚠️ 别名头、标签 chip、显示模式都在这行自己的 DOM 里 —— 少了这一步，
 *    改完要等下一次整页重渲染才看得见（用户读到的是「点了没反应」）。
 * 调用方：`writeProps`（每次写属性之后）与命令层的事务收尾（`PageDeps.run`／`PropsDeps.run`）。
 */
function repaintBlock(blockId: string): void {
  getMainEd().renderBlock(blockId)
  // 名字/显示模式变了 ⇒ 本视图里引用它的 chip（在**别的块**的 `.tx` 里）也要换字
  getMainEd().renderRefSources(blockId)
  if (getEd() !== getMainEd()) {
    getEd().renderBlock(blockId)
    getEd().renderRefSources(blockId)
  }
}

/**
 * 名称保留的理由（供日后 grep 到这里的调用方）：**不再有**「只写、不重画」的变体。
 *
 * 曾经有两个名字：`writeProps`（只写）与 `writeBlockProps`（写 ＋ 重画）。
 * 两次名字并存，第一次就选错了 —— 属性命令那条路径注入的是前者，
 * 于是「加属性」不刷新那一行。现在只有一个名字，且它**必然重画**：
 * 「改这一块的属性」与「这一行的样子变了」是同一件事的两面。
 */

/** 显示名：呈现摘要（日记日期 > 主名 > 逐 run 可读），兜底只有「无标题」（core 里唯一一份） */
function blockName(b: Block): string {
  return blockLabel(b, kbGet)
}

/**
 * 把一个块加进某个列表（页 / 标签）。
 *
 * 判据：列表是**露面**，不是「在两种东西之间转换」——所以这里只 append，
 * 不抹任何数据。页与标签可兼位：同一个块可以既是页、又能被 `#` 指向。
 *
 * ⚠️ **不变量：在列表里 ⇒ 至少有一个名字。** 加列表前没有地址时必须先补一个：
 *    · 正文非空 ⇒ 用它当主名（正文此刻还是用户写下的描述，语义上就是他想叫的名字）；
 *    · 正文为空 ⇒ 页生成 `未命名-<shortid>`；标签拒绝（没有名字的标签没有身份）。
 * ⚠️ **补名字就是占地址**，所以先查重：页与标签共用同一个地址空间，
 *    两个块共用一个地址 ⇒ 永远只能找到一个，另一个再也引用不到。
 *    撞车时**拒绝，一个字节都不写**——与改名同一套口径，只是入口不同。
 */
function addBlockRole(blockId: string, role: 'page' | 'tag'): boolean {
  const b = findInForest(ws.blocks, blockId)
  if (!b || hasList(b, role)) return false
  let name = primaryAliasOf(b).trim()
  if (name === '') {
    const text = plainText(b.content).trim()
    if (text !== '') {
      name = text
    } else if (role === 'tag') {
      // 标签的价值就是名字（`#未命名-abc` 没有意义），但拒绝不该是死路：
      // 起名是下一步，所以直接把别名编辑器打开、把光标放进输入框。
      toast(t('ui.toast.roleNeedName'), 'warn')
      openBlockConfig(b.id, { autofocus: true })
      return false
    } else {
      name = t('ui.page.untitledAlias', { id: b.id.slice(-6) })
    }
    const claim = claimAlias(ws.blocks, b, name, true)
    if (!claim.ok) {
      toast(t('ui.toast.nameTaken', { name, where: takenWhere(claim.conflict) }), 'warn')
      return false
    }
  }
  writeProps(blockId, () => {
    if (primaryAliasOf(b).trim() === '') addAlias(b, name)
    addList(b, role)
    // 第一次获得身份 ⇒ 行头默认显示名字；用户显式设过的显示模式不动
    if (prop(b, DISPLAY_PROP) === undefined) b.props = { ...(b.props ?? {}), [DISPLAY_PROP]: 'alias' }
  })
  toast(t(role === 'page' ? 'ui.toast.pageRoleAdded' : 'ui.toast.tagRoleAdded', { name: blockName(b) }))
  return true
}

/**
 * **设身份色**（`_color`，色板封闭集）：空串/`null` ＝ 摘色——「无颜色」是合法态，
 * 摘色回落中性，不是错误。色板外的值不写（值域由判据登记表把守）。
 */
function setBlockColor(blockId: string, color: string | null): boolean {
  const b = findInForest(ws.blocks, blockId)
  if (!b) return false
  const value = color?.trim() ?? ''
  if (value !== '' && !isColorValue(value)) return false
  writeProps(blockId, () => {
    const props = { ...(b.props ?? {}) }
    if (value === '') delete props[COLOR_PROP]
    else props[COLOR_PROP] = value
    // 属性袋不留空壳（与摘标签同一口径）
    if (Object.keys(props).length === 0) delete b.props
    else b.props = props
  })
  return true
}

/** 设脸（`_icon`）：空串/`null` ＝ 摘（回落角色默认）；值域宽松（lucide 名或字面文本） */
function setBlockIcon(blockId: string, icon: string | null): boolean {
  const b = findInForest(ws.blocks, blockId)
  if (!b) return false
  const value = icon?.trim() ?? ''
  writeProps(blockId, () => {
    const props = { ...(b.props ?? {}) }
    if (value === '') delete props[ICON_PROP]
    else props[ICON_PROP] = value
    if (Object.keys(props).length === 0) delete b.props
    else b.props = props
  })
  return true
}

/**
 * 把一个块从某个列表里摘掉。
 *
 * 摘 `tag` 时**提示不阻止**（与删标签同一套形状）：成员与声明会失效，但**值一个字节不动**
 * （落回「本块自有」），重新加进 `tag` 列表后声明与成员关系自动恢复。
 * ⚠️ 名字不跟着删：地址是身份，去掉露面不等于抹掉它是谁（要删名字走别名编辑器）。
 */
function removeBlockRole(blockId: string, role: 'page' | 'tag'): boolean {
  const b = findInForest(ws.blocks, blockId)
  if (!b || !hasList(b, role)) return false
  const drop = (): void => {
    writeProps(blockId, () => removeList(b, role))
    toast(
      t(role === 'page' ? 'ui.toast.pageRoleRemoved' : 'ui.toast.tagRoleRemoved', { name: blockName(b) }),
      'info',
    )
  }
  if (role === 'tag') {
    const members = tagMemberIds(b.id, ws.blocks).size
    const declarations = declaredFieldIds(b).length
    if (members > 0 || declarations > 0) {
      openMenu({
        title: t('ui.role.removeTagTitle', { tag: blockName(b), members }),
        rows: [
          {
            id: 'role/remove',
            label: t('ui.role.removeTagContinue'),
            hint: declarations > 0 ? t('ui.role.declarations', { count: declarations }) : '',
            group: 'role/1',
          },
          { id: 'role/cancel', label: t('ui.role.cancel'), group: 'role/2' },
        ],
        anchor: getEd().caretRect(),
        searchable: false,
        focusSearch: false,
        onPick: (row) => {
          if (row.id === 'role/remove') drop()
        },
      })
      return true
    }
  }
  drop()
  return true
}

/**
 * 写块的类型（`_type`）。
 *
 * 一次属性写入就够：类型值住在块的属性袋里，撤销、落盘、重画都走同一条路。
 * 幂等检查放在写之前 —— 否则「设成它已经是的东西」也会占掉一格撤销。
 */
function applyBlockType(blockId: string, typeId: string, lang?: string): boolean {
  const b = findInForest(ws.blocks, blockId)
  if (!b || !canConvertBlockType(b)) return false
  const nextLang = typeId === CODE_TYPE && lang ? lang.trim() : undefined
  if (blockTypeOf(b) === typeId && prop<string>(b, LANG_PROP) === nextLang) return false
  const wasCode = blockTypeOf(b) === CODE_TYPE
  const willCode = typeId === CODE_TYPE
  writeProps(blockId, () => {
    /**
     * **行文本与代码文档换家**（判定见 `CODE_TEXT_PROP`）：转成代码 ⇒ 这一行的字
     * 变成代码文档、标题留空；转回普通骨架 ⇒ 代码文档回到行上。
     * 不搬的话，两个方向各丢一次用户的字（正文留在被隐藏的槽里 / 文档留在没人读的属性里）。
     */
    if (!wasCode && willCode) {
      const line = plainText(b.content)
      setBlockType(b, typeId)
      if (line !== '') {
        writeBlockContent(b, [])
        b.props = { ...(b.props ?? {}), [CODE_TEXT_PROP]: line }
      }
    } else if (wasCode && !willCode) {
      const code = codeTextOf(b)
      setBlockType(b, typeId)
      if (code !== '') writeBlockContent(b, textRuns(code))
    } else {
      setBlockType(b, typeId)
    }
    if (nextLang) b.props = { ...(b.props ?? {}), [LANG_PROP]: nextLang }
  })
  return true
}

/**
 * `ref` 值的显示名（块下属性行用）。与属性面板同一条兜底：
 * 目标没了就说「已删除」，不把 32 位 id 露给用户。
 */
const refLabelOf = (targetId: string): string => {
  const b = kb.get(targetId)
  return b ? blockLabel(b, kbGet) : t('ui.props.refMissing', { id: shortId(targetId) })
}

/**
 * **这一块的属性区用哪一档**：单块覆盖优先，没有覆盖才跟随默认档。
 *
 * 判据只有这一处——渲染、估高、菜单勾选态都问它。三处各算一遍的典型症状是
 * 「菜单里勾着『一栏一行』、正文却画成摘要」。
 */
const propsLineModeOf = (blockId: string): { effective: 'summary' | 'list'; covered: boolean } => {
  const override = prefs().propsLineMode[blockId]
  return { effective: override ?? prefs().propsDensity, covered: override !== undefined }
}

/**
 * **「这一块怎么排」的三态菜单**（行尾 `⋯` 的落点；将来右键同一份）。
 *
 * 三态而不是两态切换：覆盖必须**可清除**（回到跟随默认），否则用户在某块上试过
 * 一次 `list` 之后，默认档再改也管不到它——一块永远回不去的脏状态。
 * 浮层归装配层（命令层不碰 DOM），勾选态用 `propsLineModeOf` 那一份判据。
 */
const openPropsLineMenu = (blockId: string, anchor: DOMRect): void => {
  const mode = propsLineModeOf(blockId)
  const row = (id: string, label: string, on: boolean): Row => ({
    id,
    label,
    icon: on ? 'lucide:check' : 'lucide:minus',
  })
  openMenu({
    rows: [
      row('mode/follow', t('ui.props.lineMode.follow'), !mode.covered),
      row('mode/summary', t('ui.props.lineMode.summary'), mode.effective === 'summary'),
      row('mode/list', t('ui.props.lineMode.list'), mode.effective === 'list'),
    ],
    anchor,
    title: t('ui.props.lineMode'),
    onPick: (r) => {
      const pick = String(r.id).slice('mode/'.length)
      setPropsLineMode(blockId, pick === 'follow' ? '' : (pick as 'summary' | 'list'))
    },
  })
}


  return {
    writeProps,
    repaintBlock,
    blockName,
    addBlockRole,
    setBlockColor,
    setBlockIcon,
    removeBlockRole,
    applyBlockType,
    refLabelOf,
    propsLineModeOf,
    openPropsLineMenu,
  }
}
