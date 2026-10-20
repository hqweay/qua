/**
 * 浮层的内容（气泡与诊断抽屉）：**这些是 UI，不是装配**。
 *
 * 原先长在 `main.ts` 里（约 200 行），是那个文件降不下来的主因——
 * 装配层应当只做 wiring，而「气泡里列哪些字段」「诊断抽屉画哪张表」是**组件自己的知识**。
 *
 * ⚠️ 组件自持 DOM：这里不 `getElementById`，所有元素都建在传进来的 `host` 上。
 * ⚠️ 分层：本文件在 `ui` 层，只依赖 core 的类型与函数，**不 import view/装配层**。
 */
import type { Atom, Block, CtxKeys } from '../core/index.ts'
import { COMMANDS } from '../core/commands/index.ts'
import { BINDINGS, keyLabel, keymapRows, referencedKeys } from '../core/bindings.ts'
import { t } from '../core/msg.ts'
import type { CommandDecl, PanelKind } from '../core/ports.ts'

/** 面板要用到的宿主能力（装配层注入；本文件不认识 `ws`/`ed`/`registry` 这些具体对象） */
export interface PanelDeps {
  ctx: () => CtxKeys
  isMac: () => boolean
  shortId: (id: string) => string
  decl: (name: string) => CommandDecl | undefined
  /** 当前对象（页块）与它的子树 */
  page: () => Block
  roots: () => Block[]
  marks: () => unknown[]
  atoms: () => unknown[]
  /**
   * 按 id 在**整片森林**里找块。
   *
   * ⚠️ 不能只看顶层：页面引用的目标可能是任意深度的块，只查 `ws.blocks` 会让
   *    「打开目标」在嵌套目标上整颗按钮消失（看起来像引用失效）。
   */
  findBlock: (id: string) => Block | undefined
  /**
   * 打开目标块（走 `core.block/focus-block`）。
   *
   * ⚠️ 与 `core.page/open` 的区别：后者只认顶层页，而引用可以指向嵌套块。
   */
  openBlock: (id: string) => void
  removeAtom: (id: string) => void
  closePopover: () => void
  openPopover: (render: (host: HTMLElement) => void, anchor: DOMRect | null) => void
  openDrawer: (title: string, render: (host: HTMLElement) => void) => void
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)
}

/** 32 位十六进制 id 只显示尾部随机段（前缀是时间戳，没有信息量） */
function fmtVal(shortId: (id: string) => string, k: string, v: unknown): string {
  const str = String(v)
  if (/^[0-9a-f]{32}$/.test(str)) return `…${shortId(str)}`
  if (k === 'blockId' && str) return `…${shortId(str)}`
  return str
}

export function showAtomPopover(deps: PanelDeps, a: Atom, rect: DOMRect): void {
  deps.openPopover((host) => {
    if (a.kind === 'page') {
      const target = deps.findBlock(a.target?.id ?? '')
      const h = document.createElement('h4')
      h.textContent = t('ui.popover.refTitle', { label: a.label })
      const dl = document.createElement('dl')
      const rows: [string, string][] = [
        [t('ui.popover.atomId'), a.id],
        [
          t('ui.popover.target'),
          a.target
            ? `${a.target.kind}:${a.target.id === `missing:${a.label}` ? t('ui.popover.targetMissing') : a.target.id}`
            : t('ui.common.none'),
        ],
        [t('ui.popover.state'), a.state ?? 'resolved'],
        [t('ui.popover.position'), `${deps.shortId(a.blockId)} @ [${a.start}, ${a.end})`],
        [t('ui.popover.quote'), a.quote ? `exact=${JSON.stringify(a.quote.exact)}` : t('ui.common.none')],
      ]
      if (a.quote) {
        rows.push(['prefix / suffix', `${JSON.stringify(a.quote.prefix)} / ${JSON.stringify(a.quote.suffix)}`])
      }
      for (const [k, v] of rows) {
        const dt = document.createElement('dt')
        dt.textContent = k
        const dd = document.createElement('dd')
        dd.textContent = v
        dl.append(dt, dd)
      }
      const note = document.createElement('div')
      // 间距/颜色走类与 token（原来这里是两条内联 style，字面量散在 TS 里）
      note.className = 'popover-note'
      note.textContent = a.state === 'dangling' ? t('ui.popover.danglingNote') : t('ui.popover.refNote')
      const row = document.createElement('div')
      row.className = 'row'
      if (target) {
        const open = document.createElement('button')
        open.type = 'button'
        open.textContent = t('ui.popover.openPage')
        open.addEventListener('click', () => {
          deps.closePopover()
          deps.openBlock(target.id)
        })
        row.appendChild(open)
      }
      const del = document.createElement('button')
      del.type = 'button'
      del.textContent = t('ui.popover.deleteRef')
      del.addEventListener('click', () => {
        deps.closePopover()
        deps.removeAtom(a.id)
      })
      row.appendChild(del)
      host.append(h, dl, note, row)
      return
    }
    const h = document.createElement('h4')
    h.textContent = t('ui.popover.imageTitle', { label: a.label })
    const dl = document.createElement('dl')
    const rows: [string, string][] = [
      [t('ui.popover.assetHash'), a.asset?.hash ?? t('ui.common.none')],
      [t('ui.popover.mimeBytes'), `${a.asset?.mime ?? '?'} / ${(a.asset?.bytes ?? 0).toLocaleString()} B`],
      [t('ui.popover.size'), `${a.asset?.w ?? '?'}×${a.asset?.h ?? '?'}`],
      [t('ui.popover.state'), a.asset?.state ?? 'ready'],
      [t('ui.popover.position'), `${deps.shortId(a.blockId)} @ [${a.start}, ${a.end})`],
    ]
    for (const [k, v] of rows) {
      const dt = document.createElement('dt')
      dt.textContent = k
      const dd = document.createElement('dd')
      dd.textContent = v
      dl.append(dt, dd)
    }
    const note = document.createElement('div')
    note.className = 'popover-note'
    note.textContent = a.asset?.state === 'missing' ? t('ui.popover.assetMissingNote') : t('ui.popover.assetNote')
    const row = document.createElement('div')
    row.className = 'row'
    const del = document.createElement('button')
    del.type = 'button'
    del.textContent = t('ui.popover.deleteImage')
    del.addEventListener('click', () => {
      deps.closePopover()
      deps.removeAtom(a.id)
    })
    row.appendChild(del)
    host.append(h, dl, note, row)
  }, rect)
}

export function openDrawerFor(deps: PanelDeps, kind: PanelKind): void {
  if (kind === 'context') {
    const ctx = deps.ctx()
    const refd = new Set(referencedKeys())
    const usedBy = new Map<string, string[]>()
    for (const b of BINDINGS) {
      if (!b.when) continue
      for (const m of b.when.matchAll(/[A-Za-z_$][A-Za-z0-9_$.]*/g)) {
        const w = m[0]
        if (['true', 'false', 'null', 'undefined', 'in', 'not'].includes(w)) continue
        const arr = usedBy.get(w) ?? []
        arr.push(`${b.kind}:${b.key ?? b.command}`)
        usedBy.set(w, arr)
      }
    }
    deps.openDrawer(t('ui.drawer.contextTitle'), (host) => {
      const intro = document.createElement('p')
      intro.style.color = 'var(--fg-mute)'
      intro.textContent = t('ui.drawer.contextIntro')
      host.appendChild(intro)
      const table = document.createElement('table')
      table.innerHTML = t('ui.drawer.contextTableHead')
      for (const [k, v] of Object.entries(ctx).sort((a, b) => a[0].localeCompare(b[0]))) {
        const tr = document.createElement('tr')
        tr.innerHTML =
          `<td class="mono">${refd.has(k) ? '◆ ' : ''}${escapeHtml(k)}</td>` +
          `<td class="mono">${escapeHtml(fmtVal(deps.shortId, k, v))}</td>` +
          `<td class="mono">${escapeHtml((usedBy.get(k) ?? []).join(', '))}</td>`
        table.appendChild(tr)
      }
      host.appendChild(table)
      const h = document.createElement('h5')
      h.textContent = t('ui.drawer.contextSnapshot', { commands: COMMANDS.length, bindings: BINDINGS.length })
      host.appendChild(h)
      const pre = document.createElement('pre')
      pre.textContent = JSON.stringify(ctx, null, 2)
      host.appendChild(pre)
    })
    return
  }
  if (kind === 'bindings') {
    deps.openDrawer(t('ui.drawer.bindingsTitle'), (host) => {
      const intro = document.createElement('p')
      intro.style.color = 'var(--fg-mute)'
      intro.textContent =
        t('ui.drawer.bindingsIntro1', { commands: COMMANDS.length, bindings: BINDINGS.length }) + t('ui.drawer.bindingsIntro2')
      host.appendChild(intro)
      for (const kind of ['keymap', 'menu', 'slash', 'selection', 'palette'] as const) {
        const rows = BINDINGS.filter((b) => b.kind === kind)
        const h = document.createElement('h5')
        h.textContent = `${kind}（${rows.length}）`
        host.appendChild(h)
        const table = document.createElement('table')
        table.innerHTML = t('ui.drawer.bindingsTableHead')
        for (const b of rows) {
          const decl = deps.decl(b.command)
          const tr = document.createElement('tr')
          tr.innerHTML =
            `<td class="mono">${escapeHtml(b.key ? keyLabel(b.key, deps.isMac()) : (b.group ?? ''))}</td>` +
            `<td>${escapeHtml(decl?.title ?? b.command)}<br><span class="mono" style="color:var(--fg-mute)">${escapeHtml(b.command)}</span></td>` +
            `<td class="mono">${escapeHtml(b.when ?? t('ui.common.always'))}</td>` +
            `<td class="mono">${b.layer}</td>`
          table.appendChild(tr)
        }
        host.appendChild(table)
      }
    })
    return
  }
  if (kind === 'shortcuts') {
    deps.openDrawer(t('ui.drawer.shortcutsTitle'), (host) => {
      const rows = keymapRows()
      const table = document.createElement('table')
      table.innerHTML = t('ui.drawer.shortcutsTableHead')
      for (const r of rows) {
        const decl = deps.decl(r.command)
        const tr = document.createElement('tr')
        tr.innerHTML =
          `<td class="mono">${escapeHtml(keyLabel(r.key, deps.isMac()))}</td>` +
          `<td>${escapeHtml(decl?.title ?? r.command)}</td>` +
          `<td class="mono">${escapeHtml(r.when || t('ui.common.always'))}</td>`
        table.appendChild(tr)
      }
      host.appendChild(table)
      const h = document.createElement('h5')
      h.textContent = t('ui.drawer.shortcutsNote1')
      host.appendChild(h)
      const p = document.createElement('p')
      p.style.color = 'var(--fg-mute)'
      p.textContent = t('ui.drawer.shortcutsNote2')
      host.appendChild(p)
    })
    return
  }
  deps.openDrawer(t('ui.drawer.modelTitle'), (host) => {
    const p = document.createElement('p')
    p.style.color = 'var(--fg-mute)'
    p.textContent = t('ui.drawer.modelNote')
    host.appendChild(p)
    const pre = document.createElement('pre')
    pre.textContent = JSON.stringify(
      { page: { id: deps.page().id, title: deps.page().text }, roots: deps.roots(), marks: deps.marks(), atoms: deps.atoms() },
      null,
      2,
    ).slice(0, 20000)
    host.appendChild(pre)
  })
}

