/**
 * 右下角状态角标 ＋ 诊断面板。
 *
 * **组件自持 DOM**：角标与面板这两个元素只有它知道，装配层只调 `update()` / `toggle()`。
 *
 * ⚠️ 这是**诊断面**，不是产品面：它存在的理由是「虚拟化、composing、undo 深度这些看不见的东西
 * 需要一个可读出口」。将来应当整体降级成一个可关的诊断插件。
 */
import { flatten, type CtxKeys } from '../core/index.ts'
import { t } from '../core/msg.ts'
import type { MsgId } from '../core/msg.ts'

export interface BadgeSnapshot {
  /** 模型里的块数 */
  blocks: number
  /** DOM 里挂着的 .blk 数（虚拟化证据） */
  domBlocks: number
  /** DOM 节点总数 */
  domNodes: number
  mounted: number
  virtualize: boolean
  radius: number
  theme: string
  composing: boolean
  compositionSeq: string[]
  selection: { aBlock: string; aOff: number; hBlock: string; hOff: number } | null
  /** 块选区：跨块拖拽时选中整块 */
  blockSelection: boolean
  blockSelectionCount: number
  marks: number
  atoms: number
  undoDepth: number
  redoDepth: number
  lastCommand: { name: string; via: string } | null
  pageTitle: string
  pageCount: number
  /** 持久化体积（KB）与保存时间 */
  storageKB: number
  savedAt: number
  ctx: CtxKeys
  keyTrace: { key: string; hit: string; when: string; ok: boolean }[]
}

export interface BadgeHost {
  snapshot: () => BadgeSnapshot
  /** 短 id（面板里只显示尾部随机段） */
  shortId: (id: string) => string
}

export interface Badge {
  /** 下一帧刷新（同一帧内多次调用只刷一次） */
  schedule: () => void
  /** 立即刷新 */
  update: () => void
  /** 展开 / 收起诊断面板；不传参 ＝ 切换 */
  toggle: (open?: boolean) => void
  /** 面板当前是否展开 */
  isOpen: () => boolean
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)
}

/** 32 位十六进制 id 在面板里只显示尾部随机段（前缀是时间戳，显示它没有信息量） */
function fmtVal(shortId: (id: string) => string, k: string, v: unknown): string {
  const str = String(v)
  if (/^[0-9a-f]{32}$/.test(str)) return `…${shortId(str)}`
  if (k === 'blockId' && str) return `…${shortId(str)}`
  return str
}

export function createBadge(host: BadgeHost): Badge {
  const el = document.getElementById('badge')
  const panel = document.getElementById('badge-panel')
  if (!el || !panel) throw new Error('badge: missing #badge / #badge-panel')
  const badgeEl: HTMLElement = el
  const panelEl: HTMLElement = panel
  let raf = 0

  function renderPanel(): void {
    const s = host.snapshot()
    const kv: [string, string][] = [
      [t('ui.panel.blocks'), String(s.blocks)],
      [t('ui.panel.dom'), `${s.domBlocks} / ${s.domNodes}`],
      [
        t('ui.panel.virtualize'),
        (s.virtualize ? t('ui.panel.virtualizeOn', { radius: s.radius }) : t('ui.panel.virtualizeOff')) +
          t('ui.panel.mountedSuffix', { mounted: s.mounted }),
      ],
      [t('ui.panel.theme'), `${s.theme}`],
      [t('ui.panel.composing'), String(s.composing)],
      [t('ui.panel.compositionSeq'), s.compositionSeq.slice(-8).join('→') || t('ui.common.none')],
      [
        t('ui.panel.selection'),
        s.selection
          ? `${host.shortId(s.selection.aBlock)}@${s.selection.aOff} → ${host.shortId(s.selection.hBlock)}@${s.selection.hOff}`
          : t('ui.common.nothing'),
      ],
      [t('ui.panel.marks'), `${s.marks}${t('ui.panel.atomsSuffix', { atoms: s.atoms })}`],
      [t('ui.panel.undoDepth'), `${s.undoDepth} / ${s.redoDepth}`],
      [
        t('ui.panel.lastCommand'),
        s.lastCommand ? t('ui.panel.lastCommandValue', { name: s.lastCommand.name, via: s.lastCommand.via }) : t('ui.common.none'),
      ],
      [t('ui.panel.page'), t('ui.panel.pageValue', { title: s.pageTitle || t('ui.page.untitled'), count: s.pageCount })],
      ['localStorage', `${s.storageKB.toFixed(1)} KB @ ${new Date(s.savedAt).toLocaleTimeString()}`],
    ]
    const trace = s.keyTrace.slice(-6).reverse()
    const stateRows = kv.map(([k, v]) => `<span class="k">${k}</span><span>${escapeHtml(v)}</span>`).join('')
    const ctxRows = Object.entries(s.ctx)
      .map(([k, v]) => `<span class="k">${k}</span><span>${escapeHtml(fmtVal(host.shortId, k, v))}</span>`)
      .join('')
    panelEl.innerHTML =
      t('ui.panel.sectionState', { rows: stateRows }) +
      t('ui.panel.sectionCtx', { rows: ctxRows }) +
      t('ui.panel.sectionTrace') +
      (trace.length
        ? trace
            .map(
              (tr) =>
                `<div class="hit">${escapeHtml(tr.key)} ⇒ ${tr.hit ? escapeHtml(tr.hit) : t('ui.panel.traceMiss')}${tr.when ? `<br>when: ${escapeHtml(tr.when)}` : ''}</div>`,
            )
            .join('')
        : t('ui.panel.traceEmpty'))
  }

  function update(): void {
    raf = 0
    const s = host.snapshot()
    badgeEl.dataset.composing = s.composing ? '1' : '0'
    badgeEl.innerHTML =
      `<span class="dot"></span>` +
      t('ui.badge.blocks', { blocks: s.blocks }) +
      t('ui.badge.dom', { dom: s.domNodes }) +
      t('ui.badge.theme', { theme: s.theme }) +
      t('ui.badge.composing', { composing: s.composing ? 'on' : 'off' })
    badgeEl.title = t('ui.badge.title', {
      blocks: s.blocks,
      domBlocks: s.domBlocks,
      domNodes: s.domNodes,
      mounted: s.mounted,
      virtualize: s.virtualize ? 'on' : 'off',
    })
    if (!panelEl.hidden) renderPanel()
  }

  function schedule(): void {
    if (raf) return
    raf = requestAnimationFrame(update)
  }

  function toggle(open?: boolean): void {
    panelEl.hidden = open === undefined ? !panelEl.hidden : !open
    if (!panelEl.hidden) renderPanel()
  }

  badgeEl.addEventListener('click', () => toggle())

  return { schedule, update, toggle, isOpen: () => !panelEl.hidden }
}

/** 面板里用到的文案 id（类型检查用，防止 `t()` 传错 key） */
export type BadgeMsgId = MsgId
export { flatten }
