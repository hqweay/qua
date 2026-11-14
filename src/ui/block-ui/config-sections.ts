/**
 * **块配置的段**（身份与归属的编辑体）：一套内容、两个宿主。
 *
 * 判据：块只有一份配置模型；「块配置弹窗」与「属性面板」不是两种配置，是同一个
 * 配置体的两个壳（瞬态锚定 vs 常驻停靠）。段在这里只长**内容与交互**——
 * 不变量（在列表里 ⇒ 至少有一个名字）、判据（拖拽重排喂借形借色、摘标签连带
 * 收正文露面、chip 名字可点＝打开它）只写这一份；每个宿主自己包 chrome
 * （弹窗的小节标题／面板的行标签）与「写完谁重画」（`ctx` 的写操作里带）。
 *
 * ⚠️ 段不认识宿主，也不直接发命令：写能力由 ctx 注入，装配层把命令面接进来。
 * ⚠️ 每次写操作后 ctx 会重画宿主 ⇒ 段内不要再自己重画（旧引用作废，读一律现取）。
 */
import {
  addAlias,
  addList,
  addressesOf,
  aliasesOf,
  canRemoveAlias,
  clickModsOf,
  DISPLAY_PROP,
  displayNameOf,
  hasList,
  normalizeAlias,
  primaryAliasOf,
  prop,
  removeAlias,
  removeList,
  setPrimaryAlias,
  whereOf,
  type Block,
  type ClickMods,
  type Dangling,
} from '../../core/index.ts'
import type { KbClient } from '../../core/kb/types.ts'
import { t } from '../../core/infra/msg.ts'
import type { Layers } from '../overlay/layers.ts'

export interface ConfigSectionsCtx {
  /** 读门面：查重（这个地址现在归谁）按名现取 */
  kb: KbClient
  /** 当前块的活引用（每次现取；撤销/换库后旧引用可能已经不在森林里） */
  block: () => Block | undefined
  /** 一次直写（名字／露面／显示）：撤销、落盘、重画都在宿主那条路上 */
  write: (mutate: () => void) => void
  /** 冲突/拒绝的提示（缺省时静默，不抛） */
  toast?: (text: string, kind?: 'ok' | 'warn' | 'info') => void
  /** 短 id（悬空归属的显示） */
  shortId: (id: string) => string

  /* ---- 标签段：写走命令面，宿主接线（写完连重画一起） ---- */
  removeTag: (tagId: string) => void
  reorderTags: (orderedIds: string[]) => void
  /** 打开「选一个标签」浮层（可搜可新建）；缺省 ⇒ 「＋」不画 */
  pickTag?: (anchor: DOMRect, trigger: HTMLElement) => void

  /* ---- 归属段 ---- */
  removeBelong: (parentId: string) => void
  pruneBelongs: () => void
  /** 打开「选一个归属」浮层（候选＝页＋标签，只选已有）；缺省 ⇒ 「＋」不画 */
  pickBelong?: (anchor: DOMRect, trigger: HTMLElement) => void

  /* ---- 读（每次现取；归属随「父的露面」变，不能缓存） ---- */
  tags: () => readonly Block[]
  belongsTo: () => readonly Block[]
  belongsDangling: () => Dangling

  /** 打开一个指向某块的露面（chip 名字可点＝打开它，与正文 chip 同一契约） */
  openRef: (to: string, mods: ClickMods) => void

  /* ---- 脸（弹窗头部用；面板的脸行只作入口，走自己的路） ---- */
  /** 脸的写（命令面：撤销与落盘都在那条路上）；给了才画脸位 */
  setFace?: (patch: { icon?: string; color?: string }) => void
  /** 最近自定义色（设备态）——色行的快捷段（记账归 `setFace` 一侧） */
  recentColors?: () => readonly string[]
  /** 浮层装配（脸选择器内嵌用——弹窗已经占着 popover 位） */
  layers?: Layers
}

/** chip 尾上的删除粒：标签、归属两段同形，只有文案与动作不同（声明段也用它） */
export function chipDel(title: string, onClick: () => void): HTMLButtonElement {
  const del = document.createElement('button')
  del.type = 'button'
  del.className = 'props-tag-x'
  del.dataset.tip = title
  del.textContent = '×'
  del.addEventListener('click', onClick)
  return del
}

/**
 * **名字段内容**：别名行（主名星标／删除）＋ 添加表单。
 *
 * 判据：地址与描述是两件事——名字全局唯一、有顺序（首个是主名）；写入必须
 * 走与正文同一条路（撤销、落盘、重画都在 `ctx.write` 后面）。
 * `root` 是宿主里**跨重画存活**的祖先：重画后把焦点放回输入框要靠它现查。
 */
export function namesContent(ctx: ConfigSectionsCtx, root: HTMLElement): HTMLElement {
  const box = document.createElement('div')
  box.className = 'alias-section'
  const b = ctx.block()
  if (!b) return box
  const toast = (text: string, kind: 'ok' | 'warn' | 'info' = 'info'): void => ctx.toast?.(text, kind)
  const primary = primaryAliasOf(b)

  const list = document.createElement('div')
  list.className = 'alias-list'
  for (const name of aliasesOf(b)) {
    const row = document.createElement('div')
    row.className = 'alias-row ui-row'
    row.dataset.aliasName = name
    const isPrimary = name === primary
    if (isPrimary) row.dataset.primary = '1'

    const mark = document.createElement('button')
    mark.type = 'button'
    mark.className = 'alias-primary'
    mark.dataset.aliasPrimary = '1'
    mark.dataset.tip = t('ui.alias.primary')
    mark.textContent = isPrimary ? '★' : '☆'
    if (isPrimary) mark.dataset.active = '1'
    else {
      mark.addEventListener('click', () => ctx.write(() => setPrimaryAlias(b, name)))
    }
    row.appendChild(mark)

    const label = document.createElement('span')
    label.className = 'alias-label ui-ellipsis ui-ellipsis-grow'
    label.textContent = name
    row.appendChild(label)

    const removable = canRemoveAlias(b)
    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'alias-del'
    del.dataset.aliasRemove = '1'
    del.dataset.tip = removable ? t('ui.alias.remove') : t('ui.alias.needOne')
    del.textContent = '×'
    del.disabled = !removable
    del.addEventListener('click', () => {
      if (!canRemoveAlias(b)) {
        toast(t('ui.alias.needOne'), 'warn')
        return
      }
      ctx.write(() => removeAlias(b, name))
    })
    row.appendChild(del)
    list.appendChild(row)
  }
  box.appendChild(list)

  const form = document.createElement('form')
  form.className = 'alias-add'
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    const name = input.value.trim()
    if (name === '') {
      toast(t('ui.alias.emptyName'), 'warn')
      return
    }
    // 同一块上已经有这个地址：`claimAlias` 会排除自己，`addAlias` 只会静默去重；
    // 这里显式提示，避免用户以为「加了但没反应」。
    if (addressesOf(b).includes(normalizeAlias(name))) {
      toast(t('ui.alias.exists'), 'info')
      return
    }
    // 即将写进 `_aliases` ⇒ 一律按「要占地址」查重，不看它此刻有没有名字。
    // 判据与 `claimAlias` 同一份（`kb.resolveAlias` 就是「这个地址现在归谁」）
    const claim = ctx.kb.resolveAlias(name)
    if (claim && claim.id !== b.id) {
      toast(t('ui.toast.nameTaken', { name, where: whereOf(claim) }), 'warn')
      return
    }
    ctx.write(() => {
      addAlias(b, name)
      // 第一次得到名字 ⇒ 这一行默认显示名字（用户显式选过的显示模式不动）
      if (prop(b, DISPLAY_PROP) === undefined) {
        b.props = { ...(b.props ?? {}), [DISPLAY_PROP]: 'alias' }
      }
    })
    // 重画后把焦点放回输入框：连着加第二个名字时不用再点一次
    root.querySelector<HTMLInputElement>('.alias-input')?.focus()
  })
  const input = document.createElement('input')
  input.className = 'alias-input ui-field'
  input.placeholder = t('ui.alias.add')
  input.spellcheck = false
  const add = document.createElement('button')
  add.type = 'submit'
  add.className = 'alias-add-btn ui-btn'
  // 输入框的占位已经说了「添加别名」，按钮只留动作（界面少字）
  add.textContent = t('ui.alias.addShort')
  form.append(input, add)
  box.appendChild(form)
  return box
}

/** 名字段的重绘焦点回调（弹窗的 `autofocus` 用）：光标进「添加别名」输入框 */
export function focusNamesInput(root: HTMLElement): void {
  root.querySelector<HTMLInputElement>('.alias-input')?.focus()
}

/** **露面段内容**：page／tag 两个列表位的勾选。不变量：在列表里 ⇒ 至少有一个名字。 */
export function listsContent(ctx: ConfigSectionsCtx): HTMLElement {
  const box = document.createElement('div')
  box.className = 'alias-checks'
  const b = ctx.block()
  if (!b) return box
  for (const list of ['page', 'tag'] as const) {
    const label = document.createElement('label')
    label.className = 'alias-check'
    const box2 = document.createElement('input')
    box2.type = 'checkbox'
    box2.dataset.aliasList = list
    box2.checked = hasList(b, list)
    box2.addEventListener('change', () => {
      if (box2.checked && aliasesOf(b).length === 0) {
        // 不变量：在列表里 ⇒ 至少有一个名字。没有名字就拒绝进列表。
        box2.checked = false
        ctx.toast?.(t('ui.alias.needName'), 'warn')
        return
      }
      const turnOn = box2.checked
      ctx.write(() => {
        if (turnOn) addList(b, list)
        else removeList(b, list)
      })
    })
    const text = document.createElement('span')
    text.textContent = t(list === 'page' ? 'ui.alias.pageList' : 'ui.alias.tagList')
    label.append(box2, text)
    box.appendChild(label)
  }
  return box
}

/** **显示模式段内容**：这一行的头显示别名还是正文。有别名才画（宿主把关）。 */
export function displayContent(ctx: ConfigSectionsCtx): HTMLElement {
  const group = document.createElement('div')
  group.className = 'alias-display'
  const b = ctx.block()
  if (!b) return group
  const current = prop<string>(b, DISPLAY_PROP) === 'text' ? 'text' : 'alias'
  for (const mode of ['alias', 'text'] as const) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'ui-btn'
    btn.dataset.aliasDisplay = mode
    if (mode === current) btn.dataset.active = '1'
    btn.textContent = t(mode === 'alias' ? 'ui.alias.showAlias' : 'ui.alias.showText')
    btn.addEventListener('click', () => {
      if (mode === current) return
      ctx.write(() => {
        b.props = { ...(b.props ?? {}), [DISPLAY_PROP]: mode }
      })
    })
    group.appendChild(btn)
  }
  return group
}

/**
 * **标签段内容**：`_tags` 的 chips ＋ 添加。
 *
 * 只读归属：正文里敲 `#名` 是提及（不写归属）；两者唯一的交叠是显示。
 * 摘标签不只删这一行：正文里那枚 `#名` 也要收掉（`ctx.removeTag` 的宿主路负责）。
 */
export function tagsContent(ctx: ConfigSectionsCtx): HTMLElement {
  const value = document.createElement('span')
  value.className = 'prop-value props-tag-value'
  const b = ctx.block()
  if (!b) return value
  const tags = ctx.tags()
  /**
   * **拖拽重排**（≥2 枚才有意义）：HTML5 DnD，拖动中实时搬 DOM 预览落点，
   * 落下后按 DOM 序整笔写回（只许换序，集合不一致整笔拒绝）。
   *
   * 为什么顺序是数据不是装饰：块标的借形/借色取「第一个」，顺序就是
   * 「谁是主标签」——它必须可编辑，否则读路径依赖一个用户改不了的隐藏序。
   */
  const draggable = tags.length >= 2 && ctx.reorderTags !== undefined
  const draggingOf = (): HTMLElement | null => value.querySelector<HTMLElement>('.props-tag[data-dragging]')
  for (const tag of tags) {
    const chip = document.createElement('span')
    chip.className = 'props-tag'
    chip.dataset.panelTagId = tag.id
    if (draggable) {
      chip.draggable = true
      chip.addEventListener('dragstart', (e) => {
        chip.dataset.dragging = '1'
        // Electron 要 dataTransfer 里有非空数据才起拖（shape 无关，id 只是载体）
        e.dataTransfer?.setData('text/plain', tag.id)
        e.dataTransfer && (e.dataTransfer.effectAllowed = 'move')
      })
      chip.addEventListener('dragend', () => {
        delete chip.dataset.dragging
      })
      // 悬停在另一枚 chip 上 ⇒ 按指针在前半/后半决定预览落点（挪的是正在拖的那枚）
      chip.addEventListener('dragover', (e) => {
        e.preventDefault()
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
        const dragging = draggingOf()
        if (!dragging || dragging === chip) return
        const mid = chip.getBoundingClientRect().left + chip.offsetWidth / 2
        chip.parentNode?.insertBefore(dragging, e.clientX < mid ? chip : chip.nextSibling)
      })
    }
    const text = document.createElement('span')
    const name = displayNameOf(tag)
    text.textContent = `#${name}`
    /**
     * **只有名字可点**，`×` 不在里面：一枚 chip 上两个命中区会互相抢 ——
     * 点「摘掉」时顺手把标签页也打开了是最烦的一种。摘除仍只有 `×` 一个入口。
     * 契约与正文 chip 相同（`data-ref-to`），所以「点名字＝打开它」只有一句话。
     */
    text.dataset.refTo = tag.id
    text.className = 'props-tag-name'
    text.dataset.tip = t('ui.chip.tagTitle', { label: name })
    text.addEventListener('click', (e) => ctx.openRef(tag.id, clickModsOf(e)))
    const del = chipDel(t('ui.props.tagRemove'), () => ctx.removeTag(tag.id))
    chip.append(text, del)
    value.appendChild(chip)
  }
  // 落下＝按预览序整笔写回；写失败（集合不一致）由重画恢复模型序，不留假预览
  if (draggable) {
    value.addEventListener('dragover', (e) => e.preventDefault())
    value.addEventListener('drop', (e) => {
      e.preventDefault()
      const ids = [...value.querySelectorAll<HTMLElement>('.props-tag[data-panel-tag-id]')].map(
        (el) => el.dataset.panelTagId!,
      )
      ctx.reorderTags!(ids)
    })
  }
  // 与查询条件值位同一个手势：点开浮层选已有（可新建），而不是手打名字碰运气
  if (ctx.pickTag) {
    const add = document.createElement('button')
    add.type = 'button'
    add.className = 'ghost props-tag-add'
    add.textContent = t('ui.props.tagAdd')
    add.addEventListener('click', () => ctx.pickTag!(add.getBoundingClientRect(), add))
    value.appendChild(add)
  }
  return value
}

/**
 * **归属段内容**：`_belongsTo` 的 chips ＋ 悬空清理 ＋ 添加。
 *
 * 与标签不是一回事：标签是分类（instance-of），归属是 filed-under；
 * 跨类的那条边只在这里看得见（归属树按露面筛子项）。
 */
export function belongsContent(ctx: ConfigSectionsCtx): HTMLElement {
  const value = document.createElement('span')
  value.className = 'prop-value props-tag-value'
  const b = ctx.block()
  if (!b) return value

  const chip = (id: string, text: string, title: string, dangling?: 'revivable' | 'gone'): HTMLElement => {
    const el = document.createElement('span')
    el.className = 'props-tag'
    el.dataset.belongsId = id
    if (dangling) el.dataset.dangling = dangling
    const t0 = document.createElement('span')
    t0.textContent = text
    t0.dataset.tip = title
    // 在场的上级才可点（名字＝打开它，与标签 chip 同一契约）；悬空的打不开，给说明就够
    if (!dangling) {
      t0.dataset.refTo = id
      t0.className = 'props-tag-name'
      t0.addEventListener('click', (e) => ctx.openRef(id, clickModsOf(e)))
    }
    const del = chipDel(t('ui.belongs.remove'), () => ctx.removeBelong(id))
    el.append(t0, del)
    return el
  }

  for (const p of ctx.belongsTo()) {
    const n = displayNameOf(p).trim()
    value.appendChild(chip(p.id, n === '' ? ctx.shortId(p.id) : n, p.id))
  }
  const dangling = ctx.belongsDangling()
  for (const id of dangling.revivable) {
    value.appendChild(chip(id, `${ctx.shortId(id)}${t('ui.belongs.revivable')}`, t('ui.belongs.revivableHint'), 'revivable'))
  }
  for (const id of dangling.gone) {
    value.appendChild(chip(id, `${ctx.shortId(id)}${t('ui.belongs.deleted')}`, t('ui.belongs.deletedHint'), 'gone'))
  }
  if (dangling.gone.length > 0) {
    const prune = document.createElement('button')
    prune.type = 'button'
    prune.className = 'ghost'
    prune.dataset.pruneBelongs = '1'
    prune.textContent = t('ui.belongs.prune', { count: dangling.gone.length })
    prune.addEventListener('click', () => ctx.pruneBelongs())
    value.appendChild(prune)
  }

  if (ctx.pickBelong) {
    // 与查询条件值位同一个手势：点开浮层选已有，而不是手打名字碰运气
    const add = document.createElement('button')
    add.type = 'button'
    add.className = 'ghost props-belong-add'
    add.textContent = t('ui.belongs.add')
    add.addEventListener('click', () => ctx.pickBelong!(add.getBoundingClientRect(), add))
    value.appendChild(add)
  }
  return value
}
