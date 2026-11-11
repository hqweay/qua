/**
 * **抬头里的常驻单块编辑器**：把「一块的名字」直接画成一行可编辑正文。
 *
 * 为什么不是「点一下才开」（表格标题格那台 `SurfaceEditor`）：投影的抬头是露面里
 * 名字**唯一**的落点，改个名不该先点一下、再等输入框出现。表格里按需开是对的 ——
 * 那里一屏有 5k 行，一台编辑器跟着焦点走；抬头一屏只有几处，值得常驻。
 *
 * 三条口径，每一条都对应一种会静默出错的做法：
 *   · **装载只有这一块，且它的子块不归这里画**（`viewRootId`）：抬头是一行名字，
 *     不是「这一块的地盘」。查询块真的可以有子块（块尾 ↵ 会建首个子块），
 *     不摘掉的话它们会缩进着长进抬头里。
 *   · **↵ 是「敲完了」，不是「拆一块」**：命令层的 `split-block` 落在身份块的装载根上
 *     会走「建一个空的首个子块」那一支，而那是个看不见的块。所以 capture 拦下它 ——
 *     与表格标题格那条判据同源（那里的 ↵ 也是「提交并收起」）。
 *   · **空名字的占位由调用方给**：正文空块不挂占位（空行就是空行），但抬头空着时
 *     该说这一格是什么。占位只在**没有字**时出现，所以它同时回答了「名字空不空」。
 *
 * 断链、重载节奏、焦点与事件表都在 `EditableBlock` 里（见那个组件的文件头）；
 * 这里只补上面三条。装载走 `loadPage` 而不是 `reloadFromStore`：后者会按
 * 「有没有激活视图」重算 `viewRootId`，而抬头**永远**不画子块 —— 判据不随看法变。
 */
import type { Block, BlockStore } from '../../core/index.ts'
import type { BlockEditor, Run } from '../../view/editor/editor.ts'
import { EditableBlock } from './editable-block.ts'

export interface TitleEditorDeps {
  /** 装进哪（抬头那一格） */
  into: HTMLElement
  store: BlockStore
  /** 写入事务入口（撤销条目与落盘归装配层） */
  write: Run
  /** 与正文**同一份**事件表（引用跳转、右键菜单、`#` 补全都在里面） */
  wire: (ed: BlockEditor, change: (kind: string) => void) => void
  onFocus: (ed: BlockEditor) => void
  onChange: (kind: string) => void
  /** 这一块（每次现取：撤销／换库之后旧引用可能已经不在森林里） */
  block: () => Block | undefined
  /** 名字为空时的占位（走字典，不在这里写字面量） */
  placeholder: string
}

export interface TitleEditor {
  /** 岛根（`display:contents`，不产生盒子） */
  root: HTMLElement
  /** 当前编辑器（懒建时可能还没建） */
  editor: () => BlockEditor | null
  dispose: () => void
}

export function mountTitleEditor(deps: TitleEditorDeps): TitleEditor {
  const first = deps.block()
  const host = document.createElement('div')
  host.className = 'title-editor'
  const island = new EditableBlock({
    host,
    store: deps.store,
    write: deps.write,
    initialRoots: first ? [first] : [],
    /**
     * ⚠️ **构造时就要给 `viewRootId`**：`initialRoots` 只给根，不给「子块归谁画」。
     *    漏了它，首帧会把源块的子树整棵画进抬头（名字格子里冒出「子一子二」）——
     *    而 `load` 要等第一次外部变化才跑，那时已经晚了。
     */
    ...(first ? { viewRootId: first.id } : {}),
    // 这一格是派生的位置：行首退格不并、缩进/换位/复制都不出这一格
    structuralScope: 'roots',
    // 深度 1：抬头里再出现露面块也只画占位
    embedBodies: false,
    emptyPlaceholder: deps.placeholder,
    load: (ed, ids) => {
      if (!ed) return
      const b = deps.block()
      /**
       * **与己无关的变化不重装**：这一格只装一块，别处敲字不该重排它
       * （重排会把正在打的字所在的 DOM 换掉）。拿不到 ids（结构操作）就照旧装。
       */
      if (b && ids && ids.length > 0 && !ids.includes(b.id)) return
      ed.loadPage({
        roots: b ? [b] : [],
        folded: ed.doc.folded,
        ...(b ? { viewRootId: b.id } : {}),
      })
    },
    wire: deps.wire,
    onFocus: deps.onFocus,
    onChange: deps.onChange,
    // 冻结范围＝这一格：焦点在抬头里时不重装（否则打一个字编辑器就被换掉）
    area: deps.into,
  })

  island.root.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Enter') return
      // 组合期的 ↵ 是输入法的「选词」，不是敲完
      if (e.isComposing || island.ed?.probe.isComposing === true) return
      e.preventDefault()
      e.stopPropagation()
      const id = island.ed?.sel?.aBlock ?? deps.block()?.id ?? ''
      if (id !== '') island.ed?.commitEdit(id)
    },
    true,
  )

  // 先接进文档再建编辑器：编辑器构造时会量 DOM
  deps.into.appendChild(island.root)
  island.ensureEditor()

  return {
    root: island.root,
    editor: () => island.ed,
    dispose: () => {
      island.dispose()
      island.root.remove()
    },
  }
}
