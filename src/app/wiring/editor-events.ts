/**
 * **一台视图编辑器的完整事件表**（`viewEvents` 是唯一一份）＋ 它的接线器
 * （`wireViewEditor`：挂载区、查询结果、侧槽窗口都走它——按落点挑几支的接法漏接不报错，
 * 所以这里不存在「挑几支」的分支）。
 *
 * 装配层的行身体两台缓存（查询体／露面体）也住这里：它们是「一台编辑器一份」的实例态。
 * 本片闭包经 deps 注入——`setEd` 之所以存在：露面体里获得焦点的编辑器成为「活动编辑器」，
 * 这是装配层的单槽语义，不是本片的状态。
 */
import { createRowBodyCache } from '../../app/wiring/row-bodies.ts'
import { mountEmbedBody } from '../../ui/block-ui/embed-body.ts'
import type { BlockEditor, ViewEvents } from '../../view/editor/editor.ts'
import { assetViewOf } from '../../view/asset-views.ts'
import {
  belowFieldsRows,
  blockLabel,
  cardinalityOf,
  choiceDisplayLabel,
  choicesFor,
  embedBodyOf,
  iconOf,
  isDeleted,
  isPropDef,
  openAxisOf,
  readEmbed,
  resolveEmbed,
  singleValueOf,
  valueListOf,
  type BelowFields,
  type Block,
  type TriggerChar,
} from '../../core/index.ts'
import { t } from '../../core/infra/msg.ts'
import { takenWhere } from '../../app/commands-impl.ts'
import { openChoicePicker } from '../../app/choice-picker.ts'
import { renderPropsLine } from '../../ui/block-ui/props-line.ts'
import { createAutomationBody } from '../../ui/automation/automation-body.ts'
import { DefConfigSection } from '../../ui/block-ui/def-config-section.ts'
import { DeclaredFieldsSection } from '../../ui/block-ui/declared-fields-section.ts'
import { PropsDraftState } from '../../ui/block-ui/props-add-form.ts'
import { runTargetRows } from '../../app/retrieval/run-target-rows.ts'
import { readAutomation } from '../../core/automation/automation.ts'
import { type Registry, type MenuRequest } from '../../core/commands/index.ts'
import { Layers, type Row } from '../../ui/overlay/layers.ts'
import type { MemoryKb } from '../../core/kb/memory.ts'

export interface EditorEventsDeps {
  setEd: (e: BlockEditor) => void
  getRegistry: () => Registry
  layers: Layers
  blocks: import('../../core/model/store.ts').BlockStore
  run: <R>(fn: (tx: import('../../core/kb/types.ts').Tx) => R) => R
  kb: MemoryKb
  kbGet: (id: string) => Block | undefined
  assets: ReturnType<typeof import('../../app/wiring/assets.ts').setupAssets>
  clipboard: { readFlavors(): Promise<{ refs: unknown; text: string }>; readText(): Promise<string>; remember(c: { ids: string[]; text: string }): void }
  getPopovers: () => ReturnType<typeof import('../../app/wiring/atom-popovers.ts').setupAtomPopovers>
  refPeek: ReturnType<typeof import('../../ui/block-refs/popover.ts').createRefPeek>
  openTrigger: (ch: TriggerChar, query: string, anchor: DOMRect | null, title?: string) => void
  refreshSelectionBar: () => void
  showMenu: (req: MenuRequest) => void
  triggerState: import('../../app/wiring/retrieval.ts').TriggerState
  triggers: { get(ch: TriggerChar): { source(query: string): Row[]; title: string; emptyText: string } | undefined }
  openPropsLineMenu: (blockId: string, anchor: DOMRect) => void
  propsLineModeOf: (blockId: string) => { effective: 'summary' | 'list'; covered: boolean }
  refLabelOf: (targetId: string) => string
  repaintBlock: (blockId: string) => void
  viewMenus: {
    openEmbedViewMenu(host: Block): void
    openAutomationWhenBuilder(automationId: string): void
    openAutomationParentBuilder(automationId: string, triggerIndex: number): void
  }
  shortId: (id: string) => string
  /** 当前偏好（活引用；面板固定等库态格从这里读） */
  prefs: () => import('../../core/storage/prefs.ts').Prefs
  getPanels: () => Pick<ReturnType<typeof import('../../app/wiring/panels.ts').setupPanels>, 'mountBlockView' | 'mountEmbedView' | 'propDeps'>
  getApp: () => import('../../core/infra/ports.ts').App
  focusSourceInMain: (blockId: string) => void
  /** 打开/挂载一块前补子树（工作集：裸块的 children 还没读） */
  loadDocThen: (ids: readonly string[], then: () => void) => void
}

export function createEditorEvents(deps: EditorEventsDeps) {
  const { getRegistry, layers, blocks, run, getPanels, getApp, focusSourceInMain, kb, kbGet, assets, clipboard, showMenu, triggerState, openPropsLineMenu, propsLineModeOf, refLabelOf, repaintBlock, viewMenus, getPopovers, refPeek, shortId, prefs, setEd, openTrigger, refreshSelectionBar, triggers } = deps

/**
 * **一台视图编辑器的完整事件表**：正文、挂载区、查询结果**共用这一份**。
 *
 * 为什么收成一个函数：这些编辑器是同一种东西（`BlockEditor` ＋ 一份 roots），
 * 差别只在「装载谁」。三处各接一半 ⇒ 面板里点引用不跳、右键没有块菜单、「#」不弹补全，
 * 而这些漏接都不报错。改一处就该三处一起变。
 *
 * `change` 由调用方给：各自要刷的集合不同（正文还要刷空态提示与侧槽卡片）。
 * `editor` 传一个取值函数而不是实例：`ed` 是 `let`（焦点切走时会变）。
 */
function viewEvents(
  editor: () => BlockEditor,
  change: ViewEvents['change'],
  via: string,
  /** 这一面是不是「块的真实位置」（正文/侧槽窗口）：只有它把查询结果画在自己行下 */
  inlineViewBodies = false,
): ViewEvents {
  const active = () => editor()
  /**
   * **行身体的实例缓存**（一台编辑器一份）：外来编辑会让整屏行重建，
   * 行内查询体不能随之销毁重建 —— 冻结/stale/滚动都要跨重画活下来。
   * 判据与实现见 `app/wiring/row-bodies.ts`。
   */
  const viewBodies = createRowBodyCache((block, into) => {
    const vh = getPanels().mountBlockView(block, into, active, 'inline')
    return { root: vh.root, dispose: () => { vh.dispose(); vh.root.remove() } }
  })
  /**
   * **自动化身体的运行选择器**（运行按钮的落点）：打开的就是**「如果」的命中集**——
   * 有条件 ⇒ 第一行「全部运行 · N」（补收存量），下面列每一块命中（单跑其中一块）；
   * 没条件 ⇒ 每块都算数，全库可搜（同「关联到…」一族），没有「全部」（那是全库）。
   * 单跑与批跑从两颗按钮统一成一个面：规则的候选从来就是条件的命中。
   */
  const pickRunTarget = (automationId: string): void => {
    const block = kb.get(automationId)
    const def = block ? readAutomation(block) : null
    const runOne = (blockId: string): void => {
      void getRegistry().invoke('core.automation/run', { automationId, blockId }, 'ui')
    }
    if (def?.when === undefined) {
      const rows = runTargetRows({ kb, automationId })
      layers.openMenu({
        rows: rows(''),
        title: t('ui.automation.runPickTitle'),
        anchor: null,
        searchable: true,
        focusSearch: true,
        placeholder: t('ui.automation.runPickPlaceholder'),
        emptyText: t('ui.automation.runPickEmpty'),
        onQuery: (q) => layers.setRows(rows(q)),
        onPick: (row) => runOne(row.id),
      })
      return
    }
    const hits = kb.query({ where: def.when }, { excludeIds: [automationId] })
    const rows: Row[] = []
    if (hits.length > 0) {
      rows.push({
        id: 'run/all',
        label: t('ui.automation.runAllRow', { count: hits.length }),
        hint: t('ui.automation.runAllRowHint'),
        icon: 'lucide:zap',
        group: 'pick/0-all',
      })
    }
    for (const hit of hits) {
      const b = kb.get(hit.blockId)
      if (!b) continue
      const trail = kb
        .pathOf(hit.blockId)
        .slice(0, -1)
        .map((x) => blockLabel(x, kbGet))
        .filter((x) => x !== '')
      rows.push({
        id: hit.blockId,
        label: blockLabel(b, kbGet),
        hint: trail.length > 0 ? trail.join(' › ') : '',
        icon: iconOf(b) ?? '',
        group: 'pick/1-match',
      })
    }
    layers.openMenu({
      rows,
      title: t('ui.automation.runPickTitle'),
      anchor: null,
      searchable: false,
      focusSearch: false,
      emptyText: t('ui.automation.runPickNoMatch'),
      onPick: (row) => {
        if (row.id === 'run/all') {
          void getRegistry().invoke('core.automation/run-batch', { automationId }, 'ui')
          return
        }
        runOne(row.id)
      },
    })
  }
  /**
   * **自动化身体的实例缓存**（与查询体同一条判据）：定义编辑是**多次小写**，
   * 行重画（外来编辑/撤销）不能把它重建一次——输入焦点与展开的行内输入框都要活下来。
   */
  const automationBodies = createRowBodyCache((block, into) => {
    const body = createAutomationBody({
      blockId: block.id,
      getBlock: () => kb.get(block.id),
      kb,
      subscribe: (fn) => blocks.subscribe(fn),
      openMenu: (rows, onPick, title) => {
        layers.openMenu({ rows, title, onPick, anchor: null, searchable: false, focusSearch: false })
      },
      onRun: () => pickRunTarget(block.id),
      onToggle: (on) => {
        void getRegistry().invoke('core.automation/toggle-enabled', { automationId: block.id, on }, 'ui')
      },
      pinned: () => prefs().palettePins.includes(block.id),
      onPin: (on) => {
        void getRegistry().invoke('core.automation/pin', { automationId: block.id, on }, 'ui')
      },
      writeDef: (def) => {
        void getRegistry().invoke('core.automation/set-def', { automationId: block.id, def }, 'ui')
      },
      editWhen: () => viewMenus.openAutomationWhenBuilder(block.id),
      editParentFilter: (triggerIndex) => viewMenus.openAutomationParentBuilder(block.id, triggerIndex),
      pickBlock: (title, onPick) => {
        const rows = runTargetRows({ kb, automationId: block.id })
        layers.openMenu({
          rows: rows(''),
          title,
          anchor: null,
          searchable: true,
          focusSearch: true,
          placeholder: t('ui.automation.runPickPlaceholder'),
          emptyText: t('ui.automation.runPickEmpty'),
          onQuery: (q) => layers.setRows(rows(q)),
          onPick: (row) => onPick(row.id),
        })
      },
    })
    into.appendChild(body.root)
    return { root: body.root, dispose: () => body.dispose() }
  })
  /**
   * **定义块／标签的正文投影**（与查询体／自动化体同一条判据）：
   * 把「它是什么」的定义拿掉只剩名字 ⇒ 名字下面画定义——定义块挂值配置段
   * （格式／基数／候选域／选项），标签挂字段声明段（非空才画，行判据不画就没身体）。
   *
   * 身体是缓存实例（行重画搬家不重建），内容**每次模型变化后现画**：段组件的
   * render() 返回新鲜元素，与检视卡同一条新鲜度契约（面板也是每次 store 变化
   * 整卡重建）。订阅**不按 id 过滤**：段的内容读跨块派生（选项是定义块的子块、
   * chip 名字与选项名是别的块的投影），只认本块 id 会漏外部改动 ⇒ 防抖到与
   * 检视卡同一档（60ms）再画。能力包（picker／命令接线）与面板同源
   * （`panels.propDeps`），写完重画跟着身体自己的块走。
   */
  const defBodies = createRowBodyCache(
    (block, into) => {
      // 缓存键编形状（定义块／标签）：判据翻转 ⇒ 新键 ⇒ 拆旧挂新（露面体的镜像⇄投影同一条纪律）
      const caps = getPanels().propDeps(() => kb.get(block.id) ?? undefined)
      const holder = document.createElement('div')
      holder.className = 'blk-def-body'
      into.appendChild(holder)
      const section: { render(): HTMLElement | null } = isPropDef(block)
        ? new DefConfigSection({
            def: () => kb.get(block.id) ?? undefined,
            repaint: () => render(),
            choices: caps.choices,
            setFormat: caps.setFormat,
            setRefDomain: caps.setRefDomain,
            pickRefTag: caps.pickRefTag,
            pickRefAnchor: caps.pickRefAnchor,
            pickRefQuery: caps.pickRefQuery,
            blockById: (id) => kb.get(id),
            shortId: caps.shortId,
            openRef: caps.openRef,
            tags: () => [...kb.tags()],
            tagName: caps.tagName,
            pickIcon: caps.pickIcon,
          })
        : (() => {
            const declared = new DeclaredFieldsSection({
              owner: () => kb.get(block.id) ?? undefined,
              repaint: () => render(),
              // 投影宿主没有「这一块自己的值」段，草稿行互斥不存在 ⇒ 一具身体一份开合状态
              draft: new PropsDraftState(),
              declaredFields: caps.declaredFields,
              undeclareField: caps.undeclareField,
              declareProp: caps.declareProp,
              createDeclaredDef: caps.createDeclaredDef,
              form: {
                defs: caps.defs,
                rows: caps.rows,
                tags: caps.tags,
                fieldDeclarations: caps.fieldDeclarations,
                toast: caps.toast,
              },
              openRef: caps.openRef,
              choices: caps.choices,
              blockById: (id) => kb.get(id),
              tags: () => [...kb.tags()],
              tagName: caps.tagName,
              pickIcon: caps.pickIcon,
            })
            return { render: () => declared.render(caps.propLabels()) }
          })()
      const render = (): void => {
        const el = section.render()
        holder.replaceChildren()
        if (el) holder.appendChild(el)
        // 声明清空的一拍：身体还没被行重画摘掉，先藏自己（不留一个空壳）
        holder.hidden = el === null
      }
      let timer: number | null = null
      const off = blocks.subscribe(() => {
        if (timer !== null) window.clearTimeout(timer)
        timer = window.setTimeout(() => {
          timer = null
          render()
        }, 60)
      })
      render()
      return {
        root: holder,
        dispose: () => {
          off()
          if (timer !== null) window.clearTimeout(timer)
          timer = null
        },
      }
    },
    (b) => `${b.id}\u0000${isPropDef(b) ? 'def' : 'declared'}`,
  )
  /**
   * **露面身体的实例缓存**（与查询体同一条判据）：镜像的岛编辑器里住着这份装载
   * **自己的折叠表**（视图实例态），投影的 ViewHost 有订阅与冻结结果——
   * 行重画时重建一次就丢一次。缓存键是**「此刻该挂什么身体」的指纹**
   * （指针状态 ＋ 种类 ＋ 指针值）：行重画而判据没变 ⇒ 同一把钥匙 ⇒ 身体整棵搬过去；
   * 改指针、判据翻转（镜像 ⇄ 投影、跟随源换看法）、源被删（身体要换成一句实话）
   * ⇒ 新钥匙 ⇒ 按缓存的延后一拍语义拆旧挂新。
   */
  /** 已经为「这张露面 → 这个目标」请求过子树读（失败不重试；成功由标记判） */
  const embedSubtreeLoads = new Set<string>()
  const embedBodyCache = createRowBodyCache(
    (block, into) => {
      /**
       * **露面身体要的是目标的子树**：工作集下 `_embed` 目标常是按 id 预取进来的裸块，
       * 直接挂镜像就只剩根行。先补子树，装完重画这一行让身体按完整树重建。
       * 失败（目标读不到）不重试：否则每次重画都发一批同样的请求。
       */
      const pointer = readEmbed(block)
      const target = pointer ? blocks.find(pointer.block) : undefined
      const targetId = pointer?.block
      // 目标还不在内存（或只是裸块）⇒ 先补子树/补块；已删的目标不读
      if (targetId && !(target && isDeleted(target)) && (!target || !blocks.childrenKnown(targetId))) {
        const key = `${block.id}\u0000${targetId}`
        if (!embedSubtreeLoads.has(key)) {
          embedSubtreeLoads.add(key)
          deps.loadDocThen([targetId], () => {
            if (blocks.childrenKnown(targetId)) embedSubtreeLoads.delete(key)
            repaintBlock(block.id)
          })
        }
      }
      const holder = document.createElement('div')
      holder.className = 'blk-embed-holder'
      into.appendChild(holder)
      const dispose = mountEmbedBody(block, holder, {
        store: blocks,
        run,
        wire: (ed2, change2) => wireViewEditor(ed2, change2, via),
        onFocus: (next) => {
          setEd(next)
        },
        onChange: (kind) => change?.(kind as 'text' | 'struct' | 'view' | 'load'),
        // 投影＝同一台 ViewHost（surface 'embed'），绑定的是**这一次露面**
        mountView: (hostBlock, target, el, titleInto) => {
          const vh = getPanels().mountEmbedView(hostBlock, target, el, active, titleInto)
          return () => {
            vh.dispose()
            vh.root.remove()
          }
        },
        // 判据翻转（镜像 ⇄ 投影）只能靠重画那一行：身体是这一行的 DOM
        repaint: (id) => repaintBlock(id),
        invoke: (name, args, v) => void getRegistry().invoke(name, args, v ?? via),
      })
      return { root: holder, dispose }
    },
    (block) => {
      const find = (id: string) => blocks.find(id)
      const pointer = readEmbed(block)
      const target = pointer ? find(pointer.block) : undefined
      const status = resolveEmbed(block, find).status
      return [
        block.id,
        status,
        target && isDeleted(target) ? 'deleted' : '',
        embedBodyOf(block, find),
        pointer?.view ?? '',
        // 子树读全了没有：裸块挂出来的身体是「只有根行」的，装完必须换一把钥匙重建
        target ? (blocks.childrenKnown(target.id) ? 'k' : 'u') : 'm',
      ].join(':')
    },
  )
  return {
    change,
    /**
     * **编辑边界上撞名**：正文已经被编辑器回滚成改名前那个值，这里只负责说一句为什么。
     * 拒绝发生在用户离开这一行的那一刻，途中没有可以放确认框的位置 —— 提示是唯一的出口。
     */
    editRejected: (name, conflict) => {
      getApp().toast(t('ui.toast.nameTaken', { name, where: takenWhere(conflict) }), 'warn')
    },
    // 划选气泡（顶部工具栏作废后的落点）：选区一变就重算「该不该在、装哪几颗」
    selChange: () => {
      refreshSelectionBar()
    },
    /**
     * 编辑器报「此刻在敲什么」：同一个触发字符继续打字就只换行（浮层不重建、不抢焦点），
     * 换成另一个字符（或从关闭状态敲下）才重新打开。
     */
    triggerQuery: (hit, rect) => {
      // 第二段（成员搜索）开着：行由浮层自己的输入框驱动，编辑器这边的上报一律忽略
      //（此刻焦点在浮层，正文不该有输入；这条守卫防的是浮层被阶段一的状态机夺走）
      if (triggerState.stageTag) return
      if (hit === null) {
        // 触发词没了（删了／光标挪到没有触发词的地方）：否决记录随之失效——
        // 那次出现已经不存在，留着它反而会误伤「在同一位置重新敲触发字符」
        triggerState.lastHit = null
        triggerState.dismissed = null
        if (triggerState.triggerCh) {
          triggerState.triggerCh = null
          layers.closeMenu()
        }
        return
      }
      triggerState.lastHit = hit
      const d = triggerState.dismissed
      if (d && d.blockId === hit.blockId && d.ch === hit.ch && d.from === hit.from) {
        // 被否掉的这一次（Esc／点外关掉、字留着当纯文本）：继续打字不复活浮层
        if (triggerState.triggerCh) {
          triggerState.triggerCh = null
          layers.closeMenu()
        }
        return
      }
      // 另起了一次触发（不同块／不同字符／不同位置）：旧否决不再有效
      triggerState.dismissed = null
      const trigger = triggers.get(hit.ch)
      if (!trigger) return
      if (triggerState.triggerCh === hit.ch && layers.open) {
        if (hit.query !== triggerState.lastQuery) {
          triggerState.lastQuery = hit.query
          layers.setRows(trigger.source(hit.query))
        }
        return
      }
      openTrigger(hit.ch, hit.query, rect)
    },
    refClick: (ref, mods, el) => getPopovers().handleRefClick(ref, mods, el),
    refFields: (runId, el) => getPopovers().handleRefFields(runId, el),
    tagFields: (hostId, tagId, el) => getPopovers().handleTagFields(hostId, tagId, el),
    /** 行尾引用数徽标：不弹预览，zoom 到本体并打开底部反链栏（预览归 hover） */
    refCountClick: (id) => refPeek.openAtBar(id),
    /**
     * **资产此刻的样子**：所有编辑器实例共用这一个函数，于是同一张图在
     * 正文／挂载区／查询结果／侧槽里长得一样（同一份答案，不是四份实现）。
     * 字节缺失 ⇒ `missing`，资产库打不开 ⇒ `unavailable`；两者都不抛错、不空白。
     */
    assetView: assetViewOf,
    /**
     * 非引用的行内原子被点：图片默认开 lightbox，`⌥` 才看详情；
     * 缺失/不可用**不开空 lightbox**，直接给详情（那里面说清为什么没有图）。
     */
    onAtomClick: (atom, el, mods) => getPopovers().handleAtomClick(atom, el, mods, via),
    /** 右键一枚行内原子：引用改锚文本、标签摘归属、图看详情——三类身份三组动作 */
    atomMenu: (hit, el, rect) => getPopovers().handleAtomMenu(hit, el, rect),
    /** 右键被备注的文本：打开（浮窗）／侧栏／删除——「对这一处做什么」 */
    annoMenu: (hit, rect) => getPopovers().handleAnnoMenu(hit, rect),
    onCopy: (ids, text) => {
      clipboard.remember({ ids: [...ids], text })
    },
    /**
     * 粘贴图片：落点在事件里已经捕获，这里只管校验 → 入库 → 插 run。
     * 失败一律有文案（用户刚按了粘贴，「什么都没发生」是最糟的反馈）。
     */
    onPasteImage: async (file, point) => {
      await getApp().insertAssetBlob(file, file.name || t('ui.asset.pastedName'), point ?? undefined)
    },
    /** 拖入文件：v1 不做，但必须给一句明确的话（而不是「拖进来什么都没发生」） */
    onDropFilesRejected: () => getApp().toast(t('ui.asset.dropUnsupported'), 'warn'),
    /**
     * **正文里的露面身体**（镜像／投影）：同一套分派在正文、挂载区、侧槽里都走这里
     * （实例缓存见上方 `embedBodyCache`——身体跨行重画活下来）。
     *
     * 身体里是另一台编辑器或一张表 ⇒ 返回卸载函数（外层换 DOM 之前必须调用）。
     * `onFocus` 把「活动编辑器」切到里层：键位走命令层，认的是当前这一台。
     */
    embedBody: (block, into) => embedBodyCache(block, into),
    /**
     * **正文里的查询体**：与段尾宿主同一台 `ViewHost`，只是贴在查询块那一行下面。
     *
     * 只给「块的真实位置」这两种表面（正文、右槽窗口）：里层编辑器
     * （挂载区／露面的镜像／查询结果自己）不挂这条 —— 那一层画的是**结果行**，
     * 不是结果行自己的位置。深度 1 由**有没有这个回调**在构造上固定，
     * 不是运行时用 visited 集合拦。
     */
    ...(inlineViewBodies
      ? {
          viewBody: (block: Block, into: HTMLElement) => viewBodies(block, into),
          /** **自动化块的三段式身体**：与查询体同一扇门（只给「块的真实位置」），同一缓存纪律 */
          automationBody: (block: Block, into: HTMLElement) => automationBodies(block, into),
          /** **定义块／标签的正文投影**：与查询体同一扇门、同一缓存纪律（见上面 `defBodies`） */
          defBody: (block: Block, into: HTMLElement) => defBodies(block, into),
        }
      : {}),
    /**
     * **块下属性区**：值文本、密度与点击都在这一层（`view` 不 import `ui`）。
     *
     * 档位与「这块有没有就地展开」在这里现算（渲染器不认识偏好）：
     * 两者合成**这一块此刻的排布**，与虚拟化的估高（`propsRows`）吃同一份判据。
     * 点一项 ⇒ 打开属性面板并聚焦那一栏；点 `+N` ⇒ 就地展开；写入仍走同一条命令。
     */
    propsLine: (block: Block, data, into: HTMLElement) => {
      const mode = propsLineModeOf(block.id)
      renderPropsLine(block.id, data, into, {
        inspect: (id, propId) => getApp().openPropertiesDrawer(id, propId),
        refLabel: refLabelOf,
        openUrl: (url) => {
          assets.openExternalUrl(url)
        },
        density: mode.effective,
        onSetMode: (id, next) => getApp().setPropsLineMode(id, next),
        onMenu: (id, anchor) => openPropsLineMenu(id, anchor),
      })
    },
    /**
     * **块下属性区画几行**（虚拟化估高用）：与上面那次渲染同一个判据
     * （`belowFieldsRows`），所以「可见区」与「占位」不会各算一遍而漂。
     */
    propsRows: (id: string, data: BelowFields) => belowFieldsRows(data, propsLineModeOf(id).effective),
    // 复盘空天格子里落笔：中心＝物化并回到这一屏；Shift/⌘＝同一天开右槽/新 tab
    shellWrite: (date, place) => {
      if (place && place !== 'center') {
        void getApp().openJournal(date, place)
        const axis = openAxisOf(place)
        if (axis) getApp().axisTo(axis)
      } else void getApp().journalShellWrite(date)
    },
    // 剪切味的源块已都不在（已按正文降级粘贴）：给一句实话，不让 ⌘V 看起来没发生
    clipboardNotice: (kind) => {
      if (kind === 'move-source-gone') getApp().toast(t('ui.toast.moveSourceGone'), 'warn')
    },
    // **左键点块标 ＝ 聚焦/zoom**。与面包屑那一格同一条命令，
    // 所以「点块标进去」与「点面包屑出来」共用一套语义，没有第二种入口。
    focusBlock: (blockId) => void getRegistry().invoke('core.block/focus-block', { blockId }, via),
    /**
     * **gutter 上普通 select 的取值菜单**：贴着那枚图标弹出。
     *
     * 行由装配层现画（选项身份/作用域只有库读得准），选中后走
     * `core.props/set-value` —— 与属性面板、表格同一条写命令。
     */
    pickChoice: (blockId, propId, anchor) => {
      const block = kb.get(blockId)
      const def = kb.get(propId)
      if (!block || !def) return
      const current =
        cardinalityOf(def) === 'many'
          ? valueListOf(block.props?.[propId])
          : singleValueOf(block.props?.[propId])
      /**
       * **推迟到本轮事件之后开**：gutter 的入口走 `mousedown`（避免先挪光标），
       * 而浮层的「点别处关」监听也挂在 `document` 的 `mousedown` 上 —— 同步开会
       * 让同一个事件在冒泡到 `document` 时把刚开的菜单关掉（表现为「点了没反应」）。
       */
      queueMicrotask(() =>
        openChoicePicker({
          layers,
          def,
          choices: choicesFor(block, propId, kb.roots()),
          current,
          anchor,
          labelOf: (c) => {
            const tagName = (id: string): string => {
              const t2 = kb.get(id)
              return t2 ? blockLabel(t2, kbGet) : shortId(id)
            }
            return choiceDisplayLabel(c, def, tagName)
          },
          onPick: (next) => {
            void getRegistry().invoke('core.props/set-value', { blockId, propId, value: next }, via)
          },
        }),
      )
    },
    /**
     * 点导轨段不再走命令层：折叠表是**每台编辑器一份**的视图实例态，
     * 镜像岛与源同屏时走「活动编辑器」就会点了镜像的线、折了源——
     * 编辑器桥直调行所属的那一台（见 `editor.ts` 的桥注释）。
     * `core.editor/toggle-children-collapse` 仍是命令面（面板／键位），作用于聚焦编辑器。
     */
    // 块标／面包屑的打开：落点（Shift＝右槽，⌘/Ctrl＝新 tab，普通＝中心）由唯一路由分流
    openBlock: (blockId, place) => getApp().openBlock(blockId, place),
    // 结构动作后光标不可见的兜底：所有编辑器共用同一份实现（判据在 focusSourceInMain）
    focusSource: (blockId) => focusSourceInMain(blockId),
    blockMenu: (blockId, rect, appearanceHost, trigger) => {
      const ed = active()
      // 命中**已选中的块**（且多块）⇒ 多块菜单；否则清块选区，走原单块菜单
      if (ed.bsel.inBlockSelection(blockId) && ed.bsel.blockSelectionCount() > 1) {
        showMenu({ kind: 'menu', prefix: 'blockSel/', anchor: rect, title: t('menu.title.blockSel') })
        return
      }
      ed.bsel.clearBlockSelection()
      /**
       * **真光标放进目标块**，而不是只把模型选区指过去：块菜单的命令落点是
       * 「当前光标块」（`curBlock` ⇒ `caretBlock()` ⇒ `sel.aBlock`），而菜单关闭时
       * 焦点归还会把打开前快照的 DOM 选区还原回来、选区同步跟着把 `sel` 冲回
       * 原光标块 —— 只写模型的那次赋值活不到命令执行。光标真的落在目标块上，
       * 快照与归还就都围着它转，菜单项无论怎么触发都打在同一块上。
       */
      ed.placeCaret(blockId, ed.sel?.aBlock === blockId ? (ed.sel?.aOff ?? 0) : 0)
      showMenu({
        kind: 'menu',
        prefix: 'block/',
        anchor: rect,
        // 目标进请求：命令拿到显式 blockId，不再靠「活动编辑器的光标」猜；
        // 编辑器面的 ctx 仍是这一台（右键前光标已落进目标块）。
        target: { blockId, surface: 'editor' },
        // 同一处再右键一次＝收起（toggle）；触发元素随行重渲染换掉时退回先关再开
        ...(trigger ? { trigger } : {}),
        title: t('menu.title.block'),
        // 右键落在露面行上（投影行的绑源块标／镜像岛里的源行）：菜单开在源上，
        // 附**这一次露面自己的两件事**——露面块 id 只有打开这一刻才知道，走现算追加项。
        // 「看法」必须有：镜像行没有任何别的路径够到指针菜单（跟随源／固定大纲／命名视图），
        // 而菜单里那个「视图…」是**源块**的视图菜单——从镜像行切它改的是源，不是这一次露面。
        // 两条都显式给 group：看法是配置（归视图组），移除是删除（归删除组）——
        // 无 group 的尾随行会继承上一组标题，正是「看法掉进删除组」的成因。
        // 删除块行在露面面收起：它会删源；删除只留命名准确的「移除这次露面」。
        ...(appearanceHost
          ? {
              omitCommands: ['core.block/delete'],
              extraRows: [
                {
                  id: 'appearance-views',
                  label: t('ui.embed.viewMenuRow'),
                  hint: t('ui.embed.viewChoiceHint'),
                  group: 'block/5-view',
                },
                {
                  id: 'appearance-remove',
                  label: t('ui.embed.remove'),
                  hint: t('ui.embed.removeHint'),
                  group: 'block/6-delete',
                  command: 'core.embed/remove',
                  args: { blockId: appearanceHost },
                },
              ],
            }
          : {}),
        onPick: (row) => {
          if (row.id === 'appearance-views') {
            const embed = appearanceHost ? blocks.find(appearanceHost) : undefined
            if (embed) viewMenus.openEmbedViewMenu(embed)
            return
          }
          if (!row.command) return
          const args = (row.args as Record<string, unknown> | undefined) ?? {}
          void getRegistry().invoke(row.command, args, 'menu')
        },
      })
    },
  }
}

/**
 * **给任何一台视图编辑器接上与正文同一套事件**（`viewEvents` 是唯一一份）。
 *
 * 挂载区、查询结果、侧槽窗口都走它——事件表按落点挑几支的接法漏接不报错
 * （右键没菜单、`#` 不弹补全、撞名没提示），所以这里不存在「挑几支」的分支。
 */
function wireViewEditor(
  editor: BlockEditor,
  change: ViewEvents['change'],
  via: string,
  /** 这个表面是不是「正文」：只有正文与右槽窗口渲染块的行内结果 */
  inlineViewBodies = false,
): void {
  editor.events = viewEvents(() => editor, change, via, inlineViewBodies)
}


  return { viewEvents, wireViewEditor }
}
