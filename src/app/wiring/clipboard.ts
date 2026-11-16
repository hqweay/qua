/**
 * **剪贴板五件**（copy／copyFlavors／confirmGrab／readFlavors／readText）＋
 * 「同会话里刚才复制的是哪一块」的会话账。
 *
 * 为什么会话账不放剪贴板：自定义 MIME 在 Chromium 的 copy 事件里写不进去（实测读回只有
 * text/plain + text/html）；改纯文本又会让外部应用看到协议串。文本对得上才用，
 * 对不上就退回纯文本——宁可给一句实话，也不插错块。
 * 块复制（⌘C／⌘X）的正式通道是 `text/html` 尾部的载荷注释（跨窗口、跨应用都在），
 * 这份会话账是 clipboard.read() 不可用时的兜底对账。
 */
import { refsFromHtml } from '../../view/editor/clipboard-flavor.ts'
import { t } from '../../core/infra/msg.ts'
import type { App } from '../../core/infra/ports.ts'

export interface ClipboardDeps {
  /** 用户可见提示（App 门面的 toast） */
  toast: App['toast']
  /** 活动编辑器（确认抓取的行抖走它） */
  getEd: () => import('../../view/editor/editor.ts').BlockEditor
}

export function setupClipboard(deps: ClipboardDeps): Pick<
  App,
  'copy' | 'copyFlavors' | 'confirmGrab' | 'readFlavors' | 'readText'
> & {
  /** 块选区路径直接记会话账（⌘C 走命令层，块选区的复制从事件表来） */
  remember: (c: { ids: string[]; text: string; move?: boolean; anchor?: string }) => void
} {
  let copiedClip: { ids: string[]; text: string; move?: boolean; anchor?: string } | null = null

  const clipToRefs = (c: NonNullable<typeof copiedClip>): { ids: string[]; move?: boolean; anchor?: string } => ({
    ids: [...c.ids],
    ...(c.move ? { move: true } : {}),
    ...(c.anchor ? { anchor: c.anchor } : {}),
  })

  return {
    copy: (text, label) => {
      void navigator.clipboard?.writeText(text).then(
        () => deps.toast(label ?? t('ui.toast.copied')),
        () => deps.toast(t('err.clipboardFailed'), 'warn'),
      )
    },
    /**
     * 多味载体：`text` 给外部应用，`html` 尾部的注释载荷给本应用；`clip` 同时更新会话账
     * （「粘贴为…」的对账仍然成立）。`ClipboardItem` 不可用 ⇒ 退回纯文本——
     * 软内软外都拿到正文，只损失引用味，不损失数据。
     */
    copyFlavors: (f, label) => {
      if (f.clip) copiedClip = { ids: [...f.clip.ids], text: f.text, ...(f.clip.move ? { move: true } : {}), ...(f.clip.anchor ? { anchor: f.clip.anchor } : {}) }
      const write = typeof ClipboardItem !== 'undefined' && f.html ? navigator.clipboard?.write?.([new ClipboardItem({
        'text/plain': new Blob([f.text], { type: 'text/plain' }),
        'text/html': new Blob([f.html], { type: 'text/html' }),
      })]) : undefined
      const done = () => {
        // label 为 null ⇒ 调用方已另给画面反馈（如剪切抖动），不叠一句重复的话
        if (label !== null) deps.toast(label ?? t('ui.toast.copied'))
      }
      if (!write) {
        void navigator.clipboard?.writeText(f.text).then(done, () => deps.toast(t('err.clipboardFailed'), 'warn'))
        return
      }
      void write.then(done, () => deps.toast(t('err.clipboardFailed'), 'warn'))
    },
    confirmGrab: (ids, label) => {
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
        deps.toast(label)
        return
      }
      deps.getEd().pulseBlocks(ids)
    },
    /**
     * 读剪贴板的引用味＋正文味（块选区态的 ⌘V：那边没有 paste 事件可读）。
     * 解析链与 paste 事件同序：HTML 注释载荷 → 会话对账 →（都没有就）纯文本。
     * `clipboard.read()` 不可用（权限／旧 webview）⇒ 退回 readText 那条会话对账。
     */
    readFlavors: async () => {
      let refs: { ids: string[]; move?: boolean; anchor?: string } | null = null
      let text = ''
      let got = false
      try {
        const item = (await navigator.clipboard?.read?.())?.[0]
        if (item) {
          got = true
          if (item.types.includes('text/html')) refs = refsFromHtml(await (await item.getType('text/html')).text())
          if (item.types.includes('text/plain')) text = await (await item.getType('text/plain')).text()
        }
      } catch {
        got = false
      }
      if (!got) text = (await navigator.clipboard?.readText?.().catch(() => '')) ?? ''
      if (!refs && copiedClip && copiedClip.text === text) refs = clipToRefs(copiedClip)
      return { refs, text }
    },
    /**
     * 读剪贴板文本：命令层不直接碰浏览器全局（与 `copy` 对称）。
     *
     * **同会话里复制过一块时**，把那段文本对一遍：对得上就补回 `((id))`，
     * 「粘贴为…」不必要求用户先点「复制为块引用」。对不上（在别处复制过）就只给纯文本，
     * 命令层会给一句「剪贴板里没有这一库的块」——不猜、不插错块。
     */
    readText: async () => {
      const text = (await navigator.clipboard?.readText?.().catch(() => '')) ?? ''
      if (text === '') return ''
      if (copiedClip && copiedClip.text === text) return copiedClip.ids.map((id) => `((${id}))`).join('\n')
      return text
    },
    remember: (c) => {
      copiedClip = { ids: [...c.ids], text: c.text, ...(c.move ? { move: true } : {}), ...(c.anchor ? { anchor: c.anchor } : {}) }
    },
  }
}
