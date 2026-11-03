/**
 * **输入会话**：此刻谁拥有输入（编辑器、光标所在的那棵 DOM、组合态）。
 *
 * 为什么它是一个全局单例，而不是每台编辑器各判各的：
 * 焦点在 DOM 里只有一个，但「谁在输入」曾被多个表面各用 `contains(activeElement)`
 * 猜过一次——挂在 `document.body` 上的编辑浮层不在任何编辑器容器里，父编辑器就以为
 * 没人输入，于是整片重排把浮层依附的那一行换掉（打一个字浮层就关）。
 *
 * 会话只回答三件事：
 *   · **谁是输入 owner**（命令层与重画判断的同一个答案）；
 *   · **它的锚点在哪**（编辑器容器，或浮层覆盖的那一格/那一行）——锚点所在的行不许被换；
 *   · **有没有组合中的预编辑串**——组合期换 DOM 会把预编辑冻成正文。
 *
 * 「谁在输入」只有一个写者：所有入口都走 `start`／`end`，不要在别处再猜焦点。
 */
import type { BlockEditor } from './editor.ts'

class InputSession {
  private owner: BlockEditor | null = null
  private anchor: HTMLElement | null = null
  /**
   * **浮层锚点**：浮层挂在 body 上，它的根不在编辑器容器里；真正不能被换掉的是
   * 它覆盖的那一格/那一行。打开浮层时设，关闭时清。
   */
  private overlayAnchor: HTMLElement | null = null
  private composing = false

  /** 焦点进入一台编辑器（或浮层）：记下 owner 与锚点 */
  start(editor: BlockEditor, anchor?: HTMLElement): void {
    if (this.overlayAnchor !== null && !this.overlayAnchor.isConnected) this.overlayAnchor = null
    this.owner = editor
    this.anchor = this.overlayAnchor ?? anchor ?? editor.container
  }

  /** 焦点离开：只由当前 owner 的离开来结束（别的编辑器的 focusout 不能清掉它） */
  end(editor?: BlockEditor): void {
    if (editor !== undefined && this.owner !== editor) return
    this.owner = null
    this.anchor = null
    this.composing = false
  }

  setOverlayAnchor(el: HTMLElement): void {
    this.overlayAnchor = el
    if (this.owner !== null) this.anchor = el
  }

  clearOverlayAnchor(el?: HTMLElement): void {
    if (el !== undefined && this.overlayAnchor !== el) return
    this.overlayAnchor = null
    if (this.owner !== null) this.anchor = this.owner.container
  }

  /** 组合期是**全局事实**：外层编辑器不知道里层在组合，就容易在打字途中换 DOM */
  noteComposition(editor: BlockEditor, on: boolean): void {
    if (this.owner !== editor) return
    this.composing = on
  }

  get editor(): BlockEditor | null {
    return this.owner
  }

  /**
   * 锚点元素（只读）。重画路径用它向上找「要保住的那一行」；别的判据
   * （在不在这片容器里、覆不盖某节点）已有 `isAnchorInside`／`pinsNode`，不要绕过它们。
   */
  get anchorEl(): HTMLElement | null {
    return this.anchor
  }

  get isComposing(): boolean {
    return this.composing
  }

  /** 这个容器里有没有「正在输入的那棵 DOM」（含挂在 body 上的浮层锚点） */
  isAnchorInside(container: HTMLElement): boolean {
    return this.anchor !== null && container.contains(this.anchor)
  }

  /** 这次重画要换的节点是不是锚点所在的那一棵（行级 pin 用） */
  pinsNode(node: HTMLElement): boolean {
    return this.anchor !== null && (node === this.anchor || node.contains(this.anchor))
  }
}

export const inputSession = new InputSession()
