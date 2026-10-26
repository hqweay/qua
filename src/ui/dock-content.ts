/**
 * 两个侧槽的**派生卡**：左槽＝今日，右槽＝反链。
 *
 * 这里只产「一张卡的内容」，不负责排槽、不负责卡片的头/折叠/单卡——
 * 那些是 `ui/dock.ts` 的事。原先这两个函数各自排一整槽，导致槽的顺序只能写死在
 * 两个函数里；拆成「产卡」之后，装配层才能按 `cards` 列表把窗口与派生卡混排。
 *
 * ⚠️ 这里**不认 `ws`／`ed`／`registry`**，只认下面这个 `DockContentDeps`。
 * ⚠️ 渲染一律走 `renderBlock`：槽只排一列，块由类型决定长相（角色只叠 chrome）。
 */
import { todayISO, type Block } from '../core/index.ts'
import { textRuns } from '../core/runs.ts'
import type { KbClient } from '../core/kb/types.ts'
import { t } from '../core/msg.ts'
import { renderBlock, type BlockRenderCtx } from './block-renderers.ts'
import type { DockCard } from './dock.ts'

export interface DockContentDeps {
  /** 读门面：今日块、反链源根都按 id／按名取数 */
  kb: KbClient
  activeId: () => string
  /** 打开某个根（页/天/被 zoom 的根；反链项给的是来源根 id）——中心槽 */
  openPage: (id: string) => void
  /** 在右槽打开某个块（Shift+点行／块标） */
  openInDock: (id: string) => void
}

function ctx(deps: DockContentDeps): BlockRenderCtx {
  return {
    isActive: (id) => id === deps.activeId(),
    onActivate: (b) => deps.openPage(b.id),
    onOpenInDock: (b) => deps.openInDock(b.id),
    untitledLabel: t('ui.page.untitled'),
  }
}

/**
 * 左槽：**今日**（journal 块）。
 *
 * ⚠️ 这里没有「我选的一组块」这种卡片：那个概念（用户自己命名的分组）还没有载体。
 *    曾用「普通块 ＋ 一个专用角色 ＋ 内部一列块 id」冒充它 —— 但冒充出来的东西会被读成
 *    产品概念，还白占一个角色值；等真概念从模型里长出来时再进左槽。
 */
export function todayCard(deps: DockContentDeps): DockCard | null {
  // Daily note：在库里找今天的 journal 块（冷启动时它一定已经物化，见 seed／装配层）
  const today = deps.kb.journalDay(todayISO())
  if (!today) return null
  const body = document.createElement('div')
  body.id = 'journal-today'
  body.className = 'block-list'
  body.appendChild(renderBlock(today, ctx(deps)))
  return { id: 'journal', title: t('ui.dock.today'), body }
}

/** 右槽：反链卡（结果总是存在，空时给一句空文案） */
export function backrefsCard(deps: DockContentDeps): DockCard {
  const target = deps.activeId()
  const sources = deps.kb.backlinksOf(target)

  const list = document.createElement('div')
  list.className = 'block-list'
  if (sources.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'dock-empty'
    empty.textContent = t('ui.dock.noBackRefs')
    list.appendChild(empty)
  }
  // 反链项**不是库里的块**，是查询结果：现造一行出来，靠 `props._icon` 拿箭头（大纲行已经读它）。
  // 不给它挂角色 —— 角色说的是「这块在系统里担任什么机制位」，而它没有库身份，从不落盘。
  // 时间戳只是为了让形状成立（`Block` 的必填字段）：这一行没有生命周期，现造现丢，
  // 所以不去装成「它刚被创建」——给它一个固定的零值，一眼看出它不是库里的块。
  for (const s of sources) {
    const row: Block = {
      id: s.rootId,
      content: textRuns(s.text),
      children: [],
      created: 0,
      modified: 0,
      props: { _icon: 'lucide:corner-up-left' },
    }
    list.appendChild(renderBlock(row, ctx(deps)))
  }

  return { id: 'backrefs', title: t('ui.dock.backRefs'), body: list }
}
