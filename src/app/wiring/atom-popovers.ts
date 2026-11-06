/**
 * 浮层家族：**行内原子的详情浮层与右键菜单、露面点击的唯一口径**。
 *
 * 此前散在装配入口中段，与面板依赖互相咬合；收进这里后咬合成显式 deps 清单。
 * 装配层传进来的都是活引用（活动编辑器、库、registry 一律现取，不传值），
 * `objFieldDeps` 尤其特殊：它晚于 `setupPanels` 才赋值（值写记录块要等
 * `pickRef` 就位），所以收的是 getter 不是值。
 */
import {
  canWriteText,
  findInForest,
  hasTag,
  openPlaceOf,
  refTitle,
  tagIdsOf,
  trashOf,
  type Block,
  type CtxKeys,
  type OpenPlace,
  type ClickMods,
} from '../../core/index.ts'
import { t } from '../../core/infra/msg.ts'
import type { Workspace } from '../../core/infra/workspace.ts'
import { assetMetaOf, assetViewOf } from '../../view/asset-views.ts'
import type { AssetView } from '../../core/infra/assets.ts'
import type { BlockEditor } from '../../view/editor/editor.ts'
import type { AtomMenuHit, RefClickHit, RefClickMods } from '../../view/editor/editor-events.ts'
import type { RunWithId } from '../../core/model/runs.ts'
import { openImageLightbox } from '../../ui/overlay/lightbox.ts'
import { openDrawerFor as panelDrawer, showAtomPopover as panelPopover, type ObjFieldDeps, type PanelDeps } from '../../ui/overlay/panels.ts'
import type { Layers, Row } from '../../ui/overlay/layers.ts'
import type { MenuRequest, PanelKind } from '../../core/infra/ports.ts'
import type { Registry } from '../../core/commands/index.ts'

export interface AtomPopoverDeps {
  /* —— panelDeps 的形状（唯一把 ws/ed/registry 交给 UI 组件的地方）—— */
  uiCtx: () => CtxKeys
  isMac: () => boolean
  shortId: (id: string) => string
  getRegistry: () => Registry
  getActiveBlock: () => Block
  getMainEd: () => BlockEditor
  getWs: () => Workspace
  /** 打开一块的唯一路由（中心 zoom／右槽／新 tab）——只在 `App.openBlock` 一份 */
  openBlockRoute: (id: string, place?: OpenPlace) => void
  layers: Layers

  /* —— 其余函数需要的活引用 —— */
  getEd: () => BlockEditor
  toast: (msg: string, kind?: 'ok' | 'warn' | 'info') => void
  /** 触发段（仍在装配入口）的菜单入口：右键菜单经它上屏 */
  showMenu: (req: MenuRequest) => void
  /** 实例字段卡读写能力，晚于 setupPanels 才有 ⇒ getter */
  objFieldDeps: () => ObjFieldDeps | undefined
}

export function setupAtomPopovers(deps: AtomPopoverDeps) {
  /**
   * 面板依赖：这里是**唯一**把 `ws`/`ed`/`registry` 交给 UI 组件的地方。
   * ⚠️ 这样 UI 组件不需要认识这些具体对象，装配层也不必知道面板里画什么。
   */
  const panelDeps: PanelDeps = {
    ctx: () => deps.uiCtx(),
    isMac: deps.isMac,
    shortId: deps.shortId,
    decl: (name) => deps.getRegistry().decl(name),
    page: () => deps.getActiveBlock(),
    roots: () => deps.getMainEd().doc.roots,
    // ⚠️ 必须查**整片森林**：引用的目标可能是嵌套块，只查顶层会让「打开目标」凭空消失
    findBlock: (id) => findInForest(deps.getWs().blocks, id),
    // 引用目标可以是任意深度的块 ⇒ 落点交给唯一路由（中心 zoom／右槽／新 tab）
    openBlock: (id, place) => deps.openBlockRoute(id, place),
    /**
     * **锚文本**：写进这一枚 run（一条事务 ⇒ 一次撤销）。
     * 走命令而不是直接调编辑器，是为了让 HTTP／CLI 面也能改它，且撤销与落盘照旧。
     */
    setAnchor: (runId, text) => void deps.getRegistry().invoke('core.editor/set-anchor', { atomId: runId, text }, 'popover'),
    /** 外链的显示文字与地址一起写（一条命令、一条事务、一次撤销） */
    setLink: (runId, text, url) => void deps.getRegistry().invoke('core.editor/set-link', { atomId: runId, text, url }, 'popover'),
    /**
     * **打开外链**：与点正文里那一枚走**同一条命令**（`core.link/open`）。
     * 两处入口不会分叉成「一个能开、一个不能开」。
     */
    openLink: (id) => void deps.getRegistry().invoke('core.link/open', { atomId: id }, 'popover'),
    removeAtom: (id) => void deps.getRegistry().invoke('core.editor/remove-atom', { atomId: id }, 'popover'),
    // 把这一枚引用摊开成块：与「粘贴为镜像／表格」同一条命令（看法写在露面块自己身上）
    embedAtom: (atomId, view) => void deps.getRegistry().invoke('core.embed/from-atom', { atomId, view }, 'popover'),
    closePopover: () => deps.layers.closePopover(),
    openPopover: (render, anchor) => deps.layers.openPopover(render, anchor),
    openDrawer: (title, render) => deps.layers.openDrawer(title, render),
  }

  /**
   * 浮层的锚点：**取矩形的函数**，不是快照。
   *
   * 为什么：浮层要跟着锚点走。桌面端拖窗口边、滚动正文都是日常动作，而一个矩形快照
   * 记不住自己指向谁 —— 滚动 300px 之后锚点早已跑开、浮层留在原地（实测相距 308px），
   * 且不报错。传函数则每次重算都对着当前那处。
   *
   * `el.isConnected === false` ⇒ 返回 `null`，浮层自己会关掉（指向不存在的东西比没有更糟）。
   */
  const anchorOf = (el: HTMLElement) => () => {
    /**
     * 锚点元素可能已经被**重画**摘掉（改锚文本／改链接都会 `renderBlock`，原子是重建的）。
     * 此时按 atom id 找**当前那一枚**：同一个浮层还在改，不该因为一次写回就自己关掉。
     * 找不到才返回 `null`（目标真的没了 —— 那时关掉浮层是对的）。
     */
    const live =
      el.isConnected || !el.dataset.atomId
        ? el
        : document.querySelector<HTMLElement>(`[data-atom-id="${el.dataset.atomId}"]`)
    return live?.isConnected ? live.getBoundingClientRect() : null
  }

  const showAtomPopover = (
    a: RunWithId,
    anchor: DOMRect | null | (() => DOMRect | null),
    opts?: { focus?: 'anchor' | 'link' },
  ): void => panelPopover(panelDeps, a, anchor, deps.objFieldDeps(), opts)

  /**
   * 一枚 run 的**当前模型对象**（点击时 DOM 上只有 id，载荷要现查）。
   *
   * 为什么不从 DOM 反推：DOM 上只有显示用的快照（hash、label），
   * 而「删这一枚」需要 run id 与它所在块的模型对象；查不到就说明它已经被删了。
   */
  const findRunOrNull = (runId: string): RunWithId | null => deps.getEd().findRun(runId)?.run ?? null

  /**
   * **资产详情浮层**（`⌥` 点击 / 缺失与不可用时的默认动作）。
   *
   * 与图片 lightbox 分开：lightbox 只回答「这张图长什么样」，
   * 这里回答「这份字节是什么、在不在、能不能删掉这一枚」。
   * 两者都会出现在同一枚原子上，但**不该合成一个**：缺失的图没有大图可看。
   */
  const showAssetDetails = (runId: string, _hash: string, el: HTMLElement): void => {
    const run = findRunOrNull(runId)
    if (run?.t === 'asset') {
      showAtomPopover(run, anchorOf(el))
      return
    }
    // 模型里已经没有了（刚被删）：不弹一个操作不了的空浮层
    deps.toast(t('ui.asset.runGone'), 'warn')
  }

  /**
   * 打开 lightbox。副标题是「尺寸 · 字节 · hash 短码」——
   * 三样都能帮人确认「这是我以为的那张图」。
   */
  const openLightbox = (hash: string, view: AssetView, el: HTMLElement): void => {
    const run = findRunOrNull(el.dataset.atomId ?? '')
    const meta = assetMetaOf(hash)
    const label = (run?.t === 'asset' ? run.label : undefined) ?? t('ui.asset.unnamed')
    const dims = view.w && view.h ? `${view.w}×${view.h}` : meta?.w && meta.h ? `${meta.w}×${meta.h}` : ''
    const size = meta ? formatBytes(meta.size) : ''
    const parts = [dims, size, hash.slice(0, 8)].filter((x) => x !== '')
    openImageLightbox({ url: view.url ?? '', label, subtitle: parts.join(' · ') })
  }

  /** 字节数的人话形式（详情浮层与 lightbox 共用一份，免得两处各算一套） */
  const formatBytes = (n: number): string => {
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    return `${(n / (1024 * 1024)).toFixed(1)} MB`
  }

  /**
   * **点一枚非引用的行内原子**（图片 / 外链）：默认动作 or `⌥` 详情。
   *
   * 正文、挂载区、查询结果、表格标题格**共用这一份**：分开写就会出现
   * 「正文里点图能开、表里点图没反应」这种只在某处复现的差别。
   */
  const handleAtomClick = (
    atom: { runId: string; kind: string; hash?: string },
    el: HTMLElement,
    mods: ClickMods,
    via: string,
  ): void => {
    if (atom.kind === 'link') {
      // 外链：**左键＝打开**，⌥ ＝ 看详情（与图片同款分工：默认动作 / 详情）
      if (!mods.altKey) {
        void deps.getRegistry().invoke('core.link/open', { atomId: atom.runId }, via)
        return
      }
      showAtomPopover(findRunOrNull(atom.runId) ?? ({ id: atom.runId, t: 'ref' } as RunWithId), anchorOf(el))
      return
    }
    if (atom.kind !== 'asset' || !atom.hash) {
      // 将来别的行内原子：先给详情（它们的「打开」还没做，别假装做了）
      if (atom.runId) showAtomPopover(findRunOrNull(atom.runId) ?? ({ id: atom.runId, t: 'ref' } as RunWithId), anchorOf(el))
      return
    }
    const view = assetViewOf(atom.hash)
    if (!mods.altKey && view.state === 'ready' && (view.mime ?? '').startsWith('image/')) {
      openLightbox(atom.hash, view, el)
      return
    }
    showAssetDetails(atom.runId, atom.hash, el)
  }

  /**
   * **「指向某块的露面」被点**的唯一口径（正文 / 反链 footer / 查询结果 / 标签成员 /
   * 侧槽窗口 / 属性区，全部共用）。
   *
   * · 左键 ⇒ 打开目标块（`focus-block`，嵌套块也能进）；
   * · **Shift+左键** ⇒ 同一个「打开」，换到右槽（一张窗口）；中心不换、历史不记；
   * · `⌥` 点击 ⇒ 弹详情浮层（诊断信息、删除引用都还在那里）；
   * · 图片 / 外链 / dangling / 目标缺失 ⇒ 只弹浮层，**不静默失败**。
   *
   * ⚠️ 判据是 `ref.run` 有没有，不是「这是不是原子」：详情浮层要一枚 run 才有内容可看可删。
   *    块级标签 chip 与属性区的标签名只有归属、没有 run —— 对它们 `⌥` 不构成第二件事，
   *    所以退回左键那一种（而不是「按了没反应」）。
   * ⚠️ 判断「目标可解析」用 `findInForest`，不是看解析状态：状态是快照，
   *    目标可能在这之后被删掉。
   * ⚠️ `el` 只是浮层的**锚点**，可省：没有 run 的露面（chip／属性区）永远不弹浮层。
   */
  const handleRefClick = (ref: RefClickHit, mods: RefClickMods, el?: HTMLElement): void => {
    const target = ref.to !== '' && findInForest(deps.getWs().blocks, ref.to) ? ref.to : undefined
    if (target && (!mods.altKey || !ref.run)) {
      deps.openBlockRoute(target, openPlaceOf(mods))
      return
    }
    if (ref.run && el) showAtomPopover(ref.run, anchorOf(el))
    /**
     * 剩下的两种情形都不做事，且都不假装成功：
     *   · 没有 run（chip／属性区）且目标不在了 ⇒ 没有可弹的内容；
     *   · 有 run 但没给锚点 ⇒ 调用方明确表示不弹浮层。
     */
  }
  const openDrawerFor = (kind: PanelKind): void => panelDrawer(panelDeps, kind)

  /**
   * 行内原子右键菜单里那两条**不是命令**的行。
   *
   * 判据：它们打开的是 UI 面（锚文本浮层、资产详情），不写模型 ⇒ 不发明一条
   * 「命令里弹浮层」的命令（命令层不该知道浮层长什么样，`arch [18]` 只管 DOM，
   * 但「命令只回答模型动作」这条是同一件事的边界）。写动作仍然全部走命令。
   */
  const ATOM_ROW_EDIT_ANCHOR = 'atom/edit-anchor'
  const ATOM_ROW_EDIT_LINK = 'atom/edit-link'
  const ATOM_ROW_FIELDS = 'atom/fields'
  const ATOM_ROW_DETAILS = 'atom/details'

  /**
   * **右键一枚行内原子**：按它的身份现算一组动作。
   *
   * 三类身份各有一条不许合并的差别（见 `AtomMenuHit`）：
   *   · `tagId`＝块级标签 chip，它是**归属**（`props._tags`）⇒ 摘掉的是归属；
   *   · `flavor:'#'` 的 ref＝正文里的**提及** ⇒ 删掉的只是这次提及，归属不动；
   *   · 普通 ref／link／asset＝行内原子本身 ⇒ 删的是这一枚。
   * 这三件事在界面上必须是**三个不同的词**；用一个「移除标签」同时兜住，
   * 用户会以为删字摘了标签（模型里没有），或者摘了归属却发现正文里还留着。
   */
  const handleAtomMenu = (hit: AtomMenuHit, el: HTMLElement, rect: DOMRect): void => {
    const host = findInForest(deps.getWs().blocks, hit.blockId)
    const writable = host !== undefined && canWriteText(host)
    const run = hit.runId ? findRunOrNull(hit.runId) : null
    const target = hit.to !== undefined && hit.to !== '' && findInForest(deps.getWs().blocks, hit.to) ? hit.to : undefined
    const rows: Row[] = []
    const add = (id: string, label: string, command: string, args: Record<string, unknown>, icon: string): void => {
      rows.push({ id, label, command, args, icon })
    }

    if (hit.tagId) {
      // chip ＝ 归属：打开标签 / 从本块摘掉这一格归属（摘归属不删正文里的任何字）
      if (target) add('atom/open-tag', t('ui.popover.openPage'), 'core.block/focus-block', { blockId: target }, 'lucide:arrow-up-right')
      if (writable) add('atom/remove-tag', t('ui.atomMenu.removeTag'), 'core.tags/remove', { blockId: hit.blockId, tagId: hit.tagId }, 'lucide:x')
    } else if (run?.t === 'ref') {
      const isMention = run.flavor === '#'
      const targetBlock = target ? findInForest(deps.getWs().blocks, target) : undefined
      /** 目标是一条实例记录（带归属）⇒ 它的字段可以在这张卡里就地改（102） */
      const isObj = targetBlock !== undefined && tagIdsOf(targetBlock).length > 0
      if (target) {
        add('atom/open', t('ui.popover.openPage'), 'core.block/focus-block', { blockId: target }, 'lucide:arrow-up-right')
        add('atom/open-dock', t('cmd.dock.open-block'), 'core.dock/open-block', { blockId: target, side: 'right' }, 'lucide:panel-right')
      }
      /**
       * **dangling ⇒ 一句话修好**（引用按 id 指人，所以先恢复、后重建）：
       *  · 目标在回收站 ⇒ 恢复同一块：所有指向它的引用一起复原，内容也回来；
       *  · 真没了 ⇒ 按可见名建一块，并把**这一枚**的 `to` 指过去。
       * 两条的判据都在 `BlockEditor.repairRef`，这里只决定显示哪一句文案。
       */
      if (!target && writable) {
        const tomb = run.to !== undefined && run.to !== '' ? trashOf(deps.getWs().blocks).find((b) => b.id === run.to) : undefined
        const label = (run.anchor ?? run.label ?? '').trim() || (tomb ? refTitle(tomb) : '')
        if (label !== '') {
          if (tomb) add('atom/repair', t('ui.atomMenu.restoreTarget', { name: label }), 'core.editor/repair-ref', { atomId: run.id }, 'lucide:rotate-ccw')
          else add('atom/repair', t('ui.atomMenu.rebuildTarget', { name: label }), 'core.editor/repair-ref', { atomId: run.id }, 'lucide:plus')
        }
      }
      if (isObj) rows.push({ id: ATOM_ROW_FIELDS, label: t('ui.atomMenu.fields'), icon: 'lucide:list' })
      if (!isMention && !isObj && writable) {
        rows.push({ id: ATOM_ROW_EDIT_ANCHOR, label: t('ui.atomMenu.editAnchor'), icon: 'lucide:pencil' })
        if (run.anchor !== undefined) {
          add('atom/clear-anchor', t('ui.atomMenu.clearAnchor'), 'core.editor/set-anchor', { atomId: run.id, text: '' }, 'lucide:rotate-ccw')
        }
      }
      // 行内 # 是**提及**：只有当这块本来就有这份归属时，才多给一条「摘归属」
      if (isMention && writable && target && host && hasTag(host, target)) {
        add('atom/remove-tag-inline', t('ui.atomMenu.removeTag'), 'core.tags/remove', { blockId: hit.blockId, tagId: target }, 'lucide:tag')
      }
      if (writable) {
        add('atom/to-text', t('ui.atomMenu.toText'), 'core.editor/atom-to-text', { atomId: run.id }, 'lucide:type')
        const label = isMention ? t('ui.atomMenu.removeMention') : t('ui.atomMenu.removeRef')
        add('atom/remove', label, 'core.editor/remove-atom', { atomId: run.id }, 'lucide:trash-2')
      }
    } else if (run?.t === 'link') {
      add('atom/open-link', t('ui.atomMenu.openLink'), 'core.link/open', { atomId: run.id }, 'lucide:external-link')
      if (writable) {
        rows.push({ id: ATOM_ROW_EDIT_LINK, label: t('ui.atomMenu.editLink'), icon: 'lucide:pencil' })
        add('atom/to-text', t('ui.atomMenu.toText'), 'core.editor/atom-to-text', { atomId: run.id }, 'lucide:type')
        add('atom/remove', t('ui.atomMenu.removeAtom'), 'core.editor/remove-atom', { atomId: run.id }, 'lucide:trash-2')
      }
    } else if (run?.t === 'asset') {
      rows.push({ id: ATOM_ROW_DETAILS, label: t('ui.atomMenu.details'), icon: 'lucide:info' })
      if (writable) add('atom/remove', t('ui.atomMenu.removeAtom'), 'core.editor/remove-atom', { atomId: run.id }, 'lucide:trash-2')
    }

    if (rows.length === 0) return
    deps.showMenu({
      kind: 'menu',
      prefix: 'atom/',
      anchor: rect,
      title: t('menu.title.atom'),
      extraRows: rows,
      onPick: (row) => {
        if (row.id === ATOM_ROW_EDIT_ANCHOR) {
          if (run?.t !== 'ref') return
          // 与 ⌥ 点击开的是**同一个浮层**（锚文本只有一个写入口）；焦点直接落在输入框
          showAtomPopover(run, anchorOf(el), { focus: 'anchor' })
          return
        }
        if (row.id === ATOM_ROW_EDIT_LINK) {
          if (run?.t !== 'link') return
          // 同一个详情浮层（编辑行就在里面）；焦点落在显示文字那一格
          showAtomPopover(run, anchorOf(el), { focus: 'link' })
          return
        }
        if (row.id === ATOM_ROW_FIELDS) {
          if (run?.t !== 'ref') return
          // 记录字段卡：与 ⌥ 点击实例是同一个浮层；值仍写记录块，不写宿主/run（102）
          showAtomPopover(run, anchorOf(el))
          return
        }
        if (row.id === ATOM_ROW_DETAILS) {
          if (run?.t !== 'asset') return
          showAssetDetails(run.id, run.asset, el)
          return
        }
        if (row.command) void deps.getRegistry().invoke(row.command, (row.args as Record<string, unknown>) ?? {}, 'menu')
      },
    })
  }

  return { showAtomPopover, findRunOrNull, showAssetDetails, openLightbox, handleAtomClick, handleRefClick, openDrawerFor, handleAtomMenu, anchorOf }
}
