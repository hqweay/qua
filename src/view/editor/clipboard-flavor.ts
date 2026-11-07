/**
 * 块复制的剪贴板多味载体。
 *
 * 为什么块复制的载荷住在 `text/html` 的注释里而不是自定义 MIME：Chromium 在 `copy` 事件里
 * `setData` 的自定义类型不会出现在读回的剪贴板里（实测只有 text/plain + text/html），
 * 写了等于没写；而 `text/html` 两端都活着，注释对外部应用不可见。
 * ⇒ 一份载荷、两个读者：本应用读到引用/移动意图，外部应用只看到正文。
 *
 * 纯函数：编解码不碰 DOM，事件的读写都发生在调用方（editor-events / 装配层）。
 */

/** 一次块复制随身携带的引用载荷（`text/plain` 永远只是正文，外部应用读到的是它） */
export interface ClipboardRefs {
  /** 复制的块 id，按选区顺序；重复去重由复制端负责 */
  ids: string[]
  /** 剪切（⌘X）＝粘贴时把这一组块**移动**到落点（id 不变，可反复贴、反复移） */
  move?: boolean
  /** 这一次粘贴显示的锚文本（划选 ⌘⇧C：划选文本）；只是这一处的显示名，不改源 */
  anchor?: string
}

const MARK = 'qua:refs:'

/**
 * 编码成注释。载荷经 `encodeURIComponent`——它不产 `-`，注释结构不会被
 * 正文内容撞破（锚文本是用户输入，可能含任何字符）。
 */
export function refsToComment(refs: ClipboardRefs): string {
  return `<!--${MARK}${encodeURIComponent(JSON.stringify(refs))}-->`
}

/** 读回载荷；不是本应用的 HTML（或载荷损坏）⇒ null，调用方落回纯文本路径 */
export function refsFromHtml(html: string | null | undefined): ClipboardRefs | null {
  if (!html) return null
  const at = html.indexOf(`<!--${MARK}`)
  if (at < 0) return null
  const start = at + MARK.length + 4
  const end = html.indexOf('-->', start)
  if (end < 0) return null
  try {
    const raw = JSON.parse(decodeURIComponent(html.slice(start, end))) as unknown
    if (typeof raw !== 'object' || raw === null) return null
    const ids = (raw as { ids?: unknown }).ids
    if (!Array.isArray(ids) || ids.length === 0) return null
    if (!ids.every((x) => typeof x === 'string' && x.length >= 1 && x.length <= 128 && !/\s/.test(x))) return null
    const refs: ClipboardRefs = { ids: ids as string[] }
    if ((raw as { move?: unknown }).move === true) refs.move = true
    const anchor = (raw as { anchor?: unknown }).anchor
    if (typeof anchor === 'string' && anchor !== '') refs.anchor = anchor
    return refs
  } catch {
    return null
  }
}

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * 复制端要写的完整 `text/html`：正文按行分 `<div>`（外部应用贴出的是普通富文本），
 * 尾部追加载荷注释。
 */
export function buildCopyHtml(text: string, refs: ClipboardRefs): string {
  const body = text
    .split('\n')
    .map((line) => `<div>${line === '' ? '<br>' : escapeHtml(line)}</div>`)
    .join('')
  return body + refsToComment(refs)
}
