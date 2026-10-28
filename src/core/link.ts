/**
 * **外链的打开判据**：只有 `http:`／`https:` 能被打开，其余协议一律拒绝。
 *
 * 为什么单开一个文件而不是塞进 `runs.ts`：`LinkRun` 的形状回答的是「落盘什么」，
 * 而「能不能拿它去交给系统浏览器」是**另一条判据**（安全边界），两者的改因不同源。
 * 挤在一个文件里，下一次改形状就会顺手把安全判据也改一遍，而没有注意到它变了。
 *
 * 为什么是白名单而不是黑名单：打开外链接的接口吃**任意协议的 URL**——
 * `file:` 读本地文件、`javascript:` 在宿主上下文里求值——而「危险协议」清单列不全，
 * 漏一个就是一道敞开的门。反过来，允许的集合小到可以逐条念出来。
 *
 * ⚠️ renderer 侧这道检查负责**给用户一句文案**（拒了要说为什么拒）；
 *    真正的信任边界在 Electron 主进程：`electron/main.ts` 的 `setWindowOpenHandler`
 *    与 `will-navigate` 再判一次同样的两个协议，命中才 `shell.openExternal`，
 *    其余一律 deny。两处的**取值必须一致**——分叉的表现是「界面上看着能开、
 *    点下去毫无反应」，而它不报错。
 */
import { t, type MsgId } from './msg.ts'

/** 允许外出的协议（**白名单**：不在这个集合里的一律不许） */
export const EXTERNAL_URL_SCHEMES: readonly string[] = ['http:', 'https:']

/** 拒绝的种类：调用方据此给用户一句话（这是 UI 反馈的唯一依据） */
export type UrlRejectKind = 'empty' | 'malformed' | 'scheme'

/** 拒绝种类 → 文案键（映射只有这一份，两处调用者说话才不会各说一套） */
export const URL_REJECT_MSG: Record<UrlRejectKind, MsgId> = {
  empty: 'ui.link.rejectEmpty',
  malformed: 'ui.link.rejectMalformed',
  scheme: 'ui.link.rejectScheme',
}

/** `https:` ⇒ `https`（给用户看的那个词；没写协议 ⇒ 空串） */
export function schemeLabelOf(raw: string): string {
  const i = raw.indexOf(':')
  return i > 0 ? raw.slice(0, i).toLowerCase() : ''
}

export type UrlCheck = { ok: true; url: string } | { ok: false; kind: UrlRejectKind; scheme: string }

/**
 * 「这个 URL 能不能拿去打开」的唯一答案。
 *
 * @returns `ok` ⇒ 带上**规范化之后**的 url（`new URL` 补协议、转小写主机名等，
 *          把它交给打开接口而不是原串，避免「手写的同一个地址有两种写法」）；
 *          否则给拒绝种类与协议名（协议名为空串 ⇒ 当时连协议都取不出来）
 */
export function checkExternalUrl(raw: string): UrlCheck {
  const s = raw.trim()
  if (s === '') return { ok: false, kind: 'empty', scheme: '' }
  let u: URL
  try {
    u = new URL(s)
  } catch {
    // 没写协议（「qua.leay.net」）也走这一支：那是输入不完整，不是「协议不被允许」
    return { ok: false, kind: 'malformed', scheme: '' }
  }
  if (!EXTERNAL_URL_SCHEMES.includes(u.protocol)) {
    return { ok: false, kind: 'scheme', scheme: schemeLabelOf(u.protocol) }
  }
  return { ok: true, url: u.toString() }
}

/**
 * 被拒时**那句话**（插入与打开两处共用）。
 *
 * 为什么连取词都放在这里：种类 → 文案的映射与白名单是同一份判断的两半，
 * 分开摆就会出现「同一个协议在两句话里叫两个名字」。
 */
export function rejectText(r: { kind: UrlRejectKind; scheme: string }): string {
  return t(URL_REJECT_MSG[r.kind], r.scheme === '' ? undefined : { scheme: r.scheme })
}
