/**
 * 浮层的内容（气泡与诊断抽屉）：**这些是 UI，不是装配**。
 *
 * 原先长在 `main.ts` 里（约 200 行），是那个文件降不下来的主因——
 * 装配层应当只做 wiring，而「气泡里列哪些字段」「诊断抽屉画哪张表」是**组件自己的知识**。
 *
 * ⚠️ 组件自持 DOM：这里不 `getElementById`，所有元素都建在传进来的 `host` 上。
 * ⚠️ 分层：本文件在 `ui` 层，只依赖 core 的类型与函数，**不 import view/装配层**。
 */
import type { Block, CtxKeys, FieldRow } from '../core/index.ts'
import type { RunWithId } from '../core/runs.ts'
import { resolveRef } from '../core/ref.ts'
import { checkExternalUrl, rejectText } from '../core/link.ts'
import { plainText } from '../core/runs.ts'
import { COMMANDS } from '../core/commands/index.ts'
import { BINDINGS, keyLabel, keymapRows, referencedKeys } from '../core/bindings.ts'
import { assetMetaOf, assetViewOf } from '../view/asset-views.ts'
import { t } from '../core/msg.ts'
import type { CommandDecl, PanelKind } from '../core/ports.ts'
import { makeFieldRow, type FieldRowDeps } from './properties.ts'

/** 面板要用到的宿主能力（装配层注入；本文件不认识 `ws`/`ed`/`registry` 这些具体对象） */
export interface PanelDeps {
  ctx: () => CtxKeys
  isMac: () => boolean
  shortId: (id: string) => string
  decl: (name: string) => CommandDecl | undefined
  /** 当前对象（页块）与它的子树 */
  page: () => Block
  roots: () => Block[]
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
  /** Shift+点「打开目标」：在右槽打开（中心不换） */
  openInDock: (id: string) => void
  /**
   * **改一枚引用的锚文本**（这一处显示什么）。
   *
   * ⚠️ 浮层自己**不碰模型**：怎么写由装配层给（它知道走哪条事务、算不算一次撤销），
   *    本文件只负责把「用户想让这一处叫什么」交出去。
   */
  setAnchor: (runId: string, text: string) => void
  /**
   * **打开一枚外链**（被点/按了「打开」）。由装配层走同一个命令 ⇒
   * 点 atomic 与点这个按钮是同一条路径，不会有一个能开另一个不开。
   */
  openLink: (runId: string) => void
  removeAtom: (id: string) => void
  /**
   * **把这一枚引用展开成露面块**（镜像／投影）。
   *
   * 浮层不碰结构：它只说「哪一枚、要哪一种看法」，摘原子与插块由命令层一笔事务做完。
   */
  embedAtom: (atomId: string, view: 'mirror' | 'table') => void
  closePopover: () => void
  /**
   * @param anchor 锚点：可以直接给矩形，也可以给**取矩形的函数**。
   *   后者才是桌面端该用的形态——浮层要跟着锚点走（拖窗口、滚动正文），
   *   而一个矩形快照记不住自己指向谁。见 `ui/layers.ts` 的 `openPopover`。
   */
  openPopover: (render: (host: HTMLElement) => void, anchor: DOMRect | null | (() => DOMRect | null)) => void
  openDrawer: (title: string, render: (host: HTMLElement) => void) => void
}

/**
 * **实例字段浮层的读写能力**（由装配层注入）。
 *
 * 判据：值属于记录块，不属于那枚 run ⇒ 这里的 `setValue`／`clearValue` 只收
 * **记录块 id**，浮层拿不到宿主块，也就写不到宿主上。
 */
export interface ObjFieldDeps {
  rows: (recordId: string) => readonly FieldRow[]
  setValue: (recordId: string, propId: string, value: unknown) => void
  clearValue: (recordId: string, propId: string) => void
  pickRef: FieldRowDeps['pickRef']
  refLabel: FieldRowDeps['refLabel']
  /** 标签名解析（选项显示名的 `#名`）；省略时显示短 id */
  tagName?: FieldRowDeps['tagName']
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

/**
 * **实例的字段卡**：锚在行内实例上的属性区。
 *
 * 它和右侧属性区共用 `makeFieldRow`——同一行渲染、同一组读写回调；
 * 差别只在「画给谁」：这里的目标永远是那枚露面指向的**记录块**。
 * 所以浮层里没有标签行、归属行、系统信息，只有值。
 */
function renderObjFields(
  host: HTMLElement,
  target: Block,
  fields: ObjFieldDeps,
  label: string,
  atomId: string,
  shortId: (id: string) => string,
  deps: PanelDeps,
): void {
  const draw = (): void => {
    host.replaceChildren()
    host.classList.add('popover-obj')
    const h = document.createElement('h4')
    h.textContent = t('ui.popover.objTitle', { label })
    const body = document.createElement('div')
    body.className = 'popover-fields'
    // 诊断/冒烟面：这一段画的是哪条记录的字段（不是宿主块）
    body.dataset.objFieldsOf = target.id

    const rows = fields.rows(target.id)
    if (rows.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'popover-note'
      empty.textContent = t('ui.popover.objNoFields')
      body.appendChild(empty)
    } else {
      const labelCount = new Map<string, number>()
      for (const r of rows) labelCount.set(r.label, (labelCount.get(r.label) ?? 0) + 1)
      const rowDeps: FieldRowDeps = {
        shortId,
        setValue: (b, propId, value) => {
          fields.setValue(b.id, propId, value)
          draw()
        },
        clearValue: (b, propId) => {
          fields.clearValue(b.id, propId)
          draw()
        },
        pickRef: fields.pickRef,
        refLabel: fields.refLabel,
        ...(fields.tagName ? { tagName: fields.tagName } : {}),
      }
      for (const row of rows) {
        body.appendChild(
          makeFieldRow(row, target, rowDeps, {
            labelCount,
            // 单标签时不重复写「来自 #X」；多标签才需要说清值是哪条归属的字段
            showSource: row.sources.length > 1,
          }),
        )
      }
    }
    host.appendChild(h)
    host.appendChild(body)

    const note = document.createElement('div')
    note.className = 'popover-note'
    note.textContent = t('ui.popover.objNote')
    host.appendChild(note)

    const actions = document.createElement('div')
    actions.className = 'row'
    const open = document.createElement('button')
    open.type = 'button'
    open.textContent = t('ui.popover.openObject')
    open.addEventListener('click', () => {
      deps.closePopover()
      deps.openBlock(target.id)
    })
    const del = document.createElement('button')
    del.type = 'button'
    del.textContent = t('ui.popover.deleteRef')
    del.addEventListener('click', () => {
      deps.closePopover()
      deps.removeAtom(atomId)
    })
    actions.append(open, del)
    host.appendChild(actions)
  }
  draw()
}

/**
 * **插入外链的输入框**（`core.editor/insert-link` 不带 `url` 时的那条路）。
 *
 * 为什么它是一枚浮层而不是「先插一个空链接再就地打字」：外链是**不可分的行内对象**，
 * 正文流里没有给它打字的位点（原子占 1 格的契约）。所以先问、后插，一次成形。
 *
 * ⚠️ 校验用 `core/link.ts` 的 `checkExternalUrl`（与插入/打开同一份判据），
 *    不合格就留在浮层里说一句为什么 —— 关掉浮层再弹一条 toast 等于让用户猜刚才是哪一步错了。
 */
export function renderLinkComposer(host: HTMLElement, deps: LinkComposerDeps): void {
  host.replaceChildren()
  const h = document.createElement('h4')
  h.textContent = t('ui.link.composerTitle')
  const form = document.createElement('form')
  form.className = 'popover-anchor'
  const url = document.createElement('input')
  url.className = 'popover-anchor-input ui-field'
  url.dataset.linkUrl = '1'
  url.type = 'text'
  url.placeholder = t('ui.link.urlPlaceholder')
  url.spellcheck = false
  const text = document.createElement('input')
  text.className = 'popover-anchor-input ui-field'
  text.dataset.linkText = '1'
  text.type = 'text'
  text.placeholder = t('ui.link.textPlaceholder')
  const submit = document.createElement('button')
  submit.type = 'submit'
  submit.className = 'ui-btn'
  submit.textContent = t('ui.link.insert')
  const note = document.createElement('div')
  note.className = 'popover-note'
  note.textContent = t('ui.link.composerNote')
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    const chk = checkExternalUrl(url.value)
    if (!chk.ok) {
      deps.toast?.(rejectText(chk), 'warn')
      url.focus()
      return
    }
    deps.insert(chk.url, text.value)
  })
  form.append(url, text, submit, note)
  host.append(h, form)
  // 浮层是「先 render 再 append」⇒ 此刻还没进文档，focus 要等挂载（与别名编辑器同一条理由）
  queueMicrotask(() => {
    if (url.isConnected) url.focus()
  })
}

/**
 * 锚文本那一行：**输入框 ＋ 一句说明**。
 *
 * `placeholder` 给的是目标此刻的名字（现算），不是 run 上的快照——
 * 「留空就显示现算名」这句话要能被看见，否则用户不知道空着意味着什么。
 *
 * 提交时机：回车（表单 submit）与失焦后值变了（change）。改一次是**一轮撤销**，
 * 所以不按每一次键入都写——那样撤销栈会被一次命名填成十几层。
 */
function anchorRow(a: { id: string; anchor?: string }, resolvedLabel: string, deps: PanelDeps): HTMLElement {
  const box = document.createElement('form')
  box.className = 'popover-anchor'
  box.dataset.anchorFor = a.id
  const input = document.createElement('input')
  input.className = 'popover-anchor-input ui-field'
  input.dataset.anchorInput = a.id
  input.type = 'text'
  input.value = a.anchor ?? ''
  input.placeholder = resolvedLabel
  input.spellcheck = false
  input.title = t('ui.popover.anchorHint')
  const hint = document.createElement('div')
  hint.className = 'popover-note'
  hint.textContent = t('ui.popover.anchorNote')
  const submit = document.createElement('button')
  submit.type = 'submit'
  submit.className = 'ui-btn'
  submit.textContent = t('ui.popover.anchorApply')
  const commit = (): void => {
    deps.setAnchor(a.id, input.value)
    // 写回之后把自己的值调成真正的形态（空串 ⇒ 键被删掉，输入框跟着空）
    input.value = input.value.trim()
  }
  box.addEventListener('submit', (e) => {
    e.preventDefault()
    commit()
  })
  input.addEventListener('change', commit)
  box.append(input, submit, hint)
  return box
}

/** 外链输入框的宿主能力（装配层注入；本文件不认识「怎么写进正文」） */
export interface LinkComposerDeps {
  /** 真的写进去（校验已过）；由装配层走命令，浮层自己不碰模型 */
  insert: (url: string, text: string) => void
  /** 校验没过的那句话（缺省则静默） */
  toast?: (text: string, kind?: 'ok' | 'warn' | 'info') => void
}

export function showAtomPopover(deps: PanelDeps, a: RunWithId, rect: DOMRect | null | (() => DOMRect | null), fields?: ObjFieldDeps): void {
  deps.openPopover((host) => {
    if (a.t === 'ref') {
      const target = a.to ? deps.findBlock(a.to) : undefined
      // 显示名与状态**现算**（`core/ref.ts`）：run 上的名字快照只是 fallback，
      // popover 上写旧名字等于给用户一份过期的真相。
      const view = resolveRef((id) => deps.findBlock(id), a)
      /**
       * 实例的 `⌥` 浮层 = **这条记录的字段卡**；标签类/普通引用仍走下面的详情。
       *
       * 判据是**目标当前身份**（`view.kind`），不是 run 上存了什么：
       * 记录被改成别的东西之后，浮层自然换回详情，不留一个指向旧语义的编辑面。
       */
      if (view.kind === 'obj' && target && fields) {
        renderObjFields(host, target, fields, view.label, a.id, deps.shortId, deps)
        return
      }
      const h = document.createElement('h4')
      h.textContent = t('ui.popover.refTitle', { label: view.label })
      const dl = document.createElement('dl')
      const rows: [string, string][] = [
        [t('ui.popover.atomId'), a.id],
        [
          t('ui.popover.target'),
          a.to ? (target ? a.to : `${a.to} ${t('ui.popover.targetMissing')}`) : t('ui.common.none'),
        ],
        [t('ui.popover.state'), view.state],
        [t('ui.popover.flavor'), a.flavor ?? t('ui.common.none')],
      ]
      if (a.marks?.length) rows.push([t('ui.popover.marks'), a.marks.join('+')])
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
      note.textContent = view.state === 'dangling' ? t('ui.popover.danglingNote') : t('ui.popover.refNote')
      /**
       * **锚文本输入框**：这一处显示什么（留空 ＝ 用目标现在的名字）。
       *
       * ⚠️ `flavor:'#'` 的一枚**不给**这个入口：它的语义是「提及这个标签」，
       *    显示成 `#自定义` 就成了一句谎话——先不放宽，口子留给真实需求。
       * ⚠️ 它是锚文本的**唯一**入口：正文流里的原子不可编辑（不可分契约），
       *    就地打字改不动它，也不该改得动。
       */
      const anchorBox = a.flavor === '#' ? null : anchorRow(a, view.label, deps)
      const row = document.createElement('div')
      row.className = 'row'
      if (target) {
        const open = document.createElement('button')
        open.type = 'button'
        open.textContent = t('ui.popover.openPage')
        open.addEventListener('click', (e) => {
          deps.closePopover()
          if (e.shiftKey) deps.openInDock(target.id)
          else deps.openBlock(target.id)
        })
        row.appendChild(open)
      }
      /**
       * **展开成一块**：镜像与大纲表格是同一个动作的两种看法（见 `core/embed.ts`）。
       *
       * 为什么放在引用浮层：用户此刻指着的就是「这一处引用」，摊开它是最少移动的一步。
       * 浮层只报「哪一枚、哪种看法」；摘原子与插块由命令层一笔事务做完。
       */
      if (target && a.to) {
        const mirror = document.createElement('button')
        mirror.type = 'button'
        mirror.textContent = t('ui.embed.asMirror')
        mirror.addEventListener('click', () => {
          deps.closePopover()
          deps.embedAtom(a.id, 'mirror')
        })
        const table = document.createElement('button')
        table.type = 'button'
        table.textContent = t('ui.embed.asTable')
        table.addEventListener('click', () => {
          deps.closePopover()
          deps.embedAtom(a.id, 'table')
        })
        row.append(mirror, table)
      }
      const del = document.createElement('button')
      del.type = 'button'
      del.textContent = t('ui.popover.deleteRef')
      del.addEventListener('click', () => {
        deps.closePopover()
        deps.removeAtom(a.id)
      })
      row.appendChild(del)
      if (anchorBox) host.append(h, dl, anchorBox, note, row)
      else host.append(h, dl, note, row)
      return
    }
    if (a.t === 'link') {
      const h = document.createElement('h4')
      h.textContent = t('ui.popover.linkTitle', { label: a.v })
      const dl = document.createElement('dl')
      const rows: [string, string][] = [
        [t('ui.popover.atomId'), a.id],
        [t('ui.popover.url'), a.url],
      ]
      if (a.marks?.length) rows.push([t('ui.popover.marks'), a.marks.join('+')])
      for (const [k, v] of rows) {
        const dt = document.createElement('dt')
        dt.textContent = k
        const dd = document.createElement('dd')
        dd.textContent = v
        dl.append(dt, dd)
      }
      const row = document.createElement('div')
      row.className = 'row'
      /**
       * **「打开」**：与点正文里那一枚走**同一条命令**（`core.link/open`），
       * 所以「点链接」和「点这个按钮」不会有能开/不能开的分叉；
       * 非 http(s) 的协议由那一条链路拦下并给文案，浮层也照做（关闭后提示）。
       */
      const open = document.createElement('button')
      open.type = 'button'
      open.dataset.linkOpen = a.id
      open.textContent = t('ui.popover.openLink')
      open.addEventListener('click', () => {
        deps.closePopover()
        deps.openLink(a.id)
      })
      const del = document.createElement('button')
      del.type = 'button'
      del.textContent = t('ui.popover.deleteRef')
      del.addEventListener('click', () => {
        deps.closePopover()
        deps.removeAtom(a.id)
      })
      row.append(open, del)
      host.append(h, dl, row)
      return
    }
    const h = document.createElement('h4')
    h.textContent = t('ui.popover.imageTitle', { label: a.label ?? a.asset.slice(0, 8) })
    /**
     * 详情浮层里的字段**全是现算**的：hash 是 run 上唯一落盘的东西，
     * `mime/size/state` 归资产库（`AssetMeta`／`AssetView`），不在正文里存第二份。
     * 库打不开 ⇒ 那几格显示「不可用」，而不是让整个浮层失败。
     */
    const meta = assetMetaOf(a.asset)
    const view = assetViewOf(a.asset)
    const dl = document.createElement('dl')
    const rows: [string, string][] = [
      [t('ui.popover.assetHash'), a.asset],
      [t('ui.popover.state'), view.state],
      [t('ui.popover.size'), `${view.w ?? meta?.w ?? '?'}×${view.h ?? meta?.h ?? '?'}`],
      [
        t('ui.popover.mimeBytes'),
        meta ? `${meta.mime} / ${meta.size}` : t('ui.popover.assetNoMeta'),
      ],
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
    note.textContent =
      view.state === 'missing'
        ? t('ui.popover.assetMissingNote')
        : view.state === 'unavailable'
          ? t('ui.popover.assetUnavailableNote')
          : t('ui.popover.assetNote')
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
      intro.style.color = 'var(--ui-text-tertiary)'
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
      intro.style.color = 'var(--ui-text-tertiary)'
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
            `<td>${escapeHtml(decl?.title ?? b.command)}<br><span class="mono" style="color:var(--ui-text-tertiary)">${escapeHtml(b.command)}</span></td>` +
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
      p.style.color = 'var(--ui-text-tertiary)'
      p.textContent = t('ui.drawer.shortcutsNote2')
      host.appendChild(p)
    })
    return
  }
  deps.openDrawer(t('ui.drawer.modelTitle'), (host) => {
    const p = document.createElement('p')
    p.style.color = 'var(--ui-text-tertiary)'
    p.textContent = t('ui.drawer.modelNote')
    host.appendChild(p)
    const pre = document.createElement('pre')
    pre.textContent = JSON.stringify(
      { page: { id: deps.page().id, title: plainText(deps.page().content) }, roots: deps.roots() },
      null,
      2,
    ).slice(0, 20000)
    host.appendChild(pre)
  })
}

