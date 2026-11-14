/**
 * **行尾引用数徽标的 hover 浮层** —— `ui/surface` 的第一个消费者（预设：hover 反链）。
 *
 * 内容仍然是第三个 `MountSurface`（同一台 `MountArea`，可编辑的反链块列）；
 * 本文件不再自己实现生命周期，只负责**发意图**：
 *   · 指针在徽标上 / 在浮层里 ⇒ `pointer` 持有者；
 *   · 浮层拿到键盘焦点 ⇒ 由 Surface 自己发 `focus`；
 *   · 拖动把手 ⇒ 由 Surface 自己发 `gesture`；
 *   · 锚点（徽标矩形）⇒ 一条 `anchor` 约束；拖过之后 ⇒ 一条更强的 `at`。
 *
 * 于是上一版那套 `peek / pinned / dismiss` 三段状态机整个消失了：它本来只是
 * 「持有者集合里有几个人」。锚点消失也不再特判 —— 约束集空了 `solve` 返回 null，
 * Surface 自己退场；用户拖过则 `at` 还在，浮面留在原地。
 *
 * ⚠️ `area` 持久，浮层壳可以反复建：内容是**借**给 Surface 的，退场原样归还，
 *    撤销栈／编辑期／焦点不会因为换了一个壳而丢。
 */
import { t } from '../../core/infra/msg.ts'
import { createSurface } from '../surface/surface.ts'
import type { Constraint, Surface } from '../surface/types.ts'
import type { MountArea } from '../chrome/mount-area.ts'
import { liveRefBadgeOf } from '../../view/editor/block-dom.ts'

/** 悬停意图延迟：防扫过误触 */
const SHOW_DELAY = 150
/** 指针离开后的宽限：容许穿过徽标与浮层之间的空隙 */
const HIDE_GRACE = 240

export interface RefPeekDeps {
  /** 第三个表面（装配层给）；返回值的生命周期由本组件持有 */
  createArea: (target: () => string) => MountArea
  /** 点徽标：zoom 到宿主并激活底部反链栏（本组件只负责先把浮面收掉） */
  openAtBar: (hostId: string) => void
}

export interface RefPeek {
  /** 事件层点徽标时调：收浮面 → 交给装配层去底部反链 */
  openAtBar: (hostId: string) => void
  close: () => void
  dispose: () => void
}

export function createRefPeek(deps: RefPeekDeps): RefPeek {
  let area: MountArea | null = null
  let surface: Surface | null = null
  let loadedHost = ''
  let hostId = ''
  let anchorEl: HTMLElement | null = null
  /** 拖过的落点：跨 hover 记住，下次开还是那个位置（工作区级 pin 的前身） */
  let movedAt: { x: number; y: number } | null = null
  let showTimer = 0
  let hideTimer = 0

  const areaOf = (): MountArea => {
    area ??= deps.createArea(() => loadedHost)
    return area
  }

  /** 约束是**每次现取快照**：锚点会动、会被重画、会消失 */
  const constraints = (): readonly Constraint[] => {
    const live = anchorEl ? liveRefBadgeOf(anchorEl, hostId) : null
    const list: Constraint[] = []
    if (live?.isConnected) {
      const r = live.getBoundingClientRect()
      list.push({ kind: 'anchor', rect: { x: r.left, y: r.top, w: r.width, h: r.height }, prefer: 'below', flip: true })
    }
    if (movedAt) list.push({ kind: 'at', x: movedAt.x, y: movedAt.y })
    return list
  }

  const open = (): void => {
    if (!hostId) return
    const a = areaOf()
    if (loadedHost !== hostId) {
      loadedHost = hostId
      a.render()
    }
    a.activateTab('d-refs')
    if (surface?.el.isConnected) {
      surface.reflow()
      surface.holders.set('chip', 'pointer')
      return
    }

    surface = createSurface({
      content: a.root,
      constraints,
      elevation: 1,
      focus: 'stack',
      draggable: true,
      title: t('ui.mount.refs'),
      foot: t('ui.refs.peekFoot'),
      onMoved: (x, y) => {
        movedAt = { x, y }
      },
      onDismiss: () => {
        surface = null
      },
    })
    surface.el.classList.add('ref-peek')
    // 打开那一刻指针就在徽标上 ⇒ 至少有一枚持有者，浮面才不会「没人要它」
    surface.holders.set('chip', 'pointer')
    surface.el.addEventListener('pointerenter', () => {
      clearTimeout(hideTimer)
      surface?.holders.set('surface', 'pointer')
    })
    surface.el.addEventListener('pointerleave', () => {
      surface?.holders.release('surface')
    })
  }

  /** 全局委托，不逐枚 chip 绑事件：徽标随块行重画是常态，逐绑必漏 */
  const onOver = (e: MouseEvent): void => {
    const el = (e.target as Element | null)?.closest?.('[data-ref-count-for]')
    if (!(el instanceof HTMLElement)) return
    const id = el.dataset.refCountFor ?? ''
    if (id === '') return
    clearTimeout(hideTimer)
    if (surface?.el.isConnected && id === hostId) return
    clearTimeout(showTimer)
    hostId = id
    anchorEl = el
    // 浮面已经开着时沿一列块扫过去：立即换宿主，别等延迟（否则短暂显示旧块的反链）
    if (surface?.el.isConnected) open()
    else showTimer = window.setTimeout(open, SHOW_DELAY)
  }

  const onOut = (e: MouseEvent): void => {
    const el = (e.target as Element | null)?.closest?.('[data-ref-count-for]')
    if (!(el instanceof HTMLElement)) return
    const next = e.relatedTarget
    if (next instanceof Node && (el.contains(next) || surface?.el.contains(next))) return
    clearTimeout(showTimer)
    clearTimeout(hideTimer)
    hideTimer = window.setTimeout(() => surface?.holders.release('chip'), HIDE_GRACE)
  }

  document.addEventListener('mouseover', onOver)
  document.addEventListener('mouseout', onOut)

  const close = (): void => {
    clearTimeout(showTimer)
    clearTimeout(hideTimer)
    surface?.dismiss()
  }

  return {
    openAtBar: (id: string): void => {
      close()
      deps.openAtBar(id)
    },
    close,
    dispose: (): void => {
      close()
      document.removeEventListener('mouseover', onOver)
      document.removeEventListener('mouseout', onOut)
    },
  }
}
