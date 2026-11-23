/**
 * 命令注册表：唯一调用入口 + 诊断日志。
 * **不 import handlers** —— 处理器由装配层注入，core 只认 `Handler` 端口。
 */
import type { CtxKeys } from '../model/undo.ts'
import { t } from '../infra/msg.ts'
import type { App, CommandDecl, Handler } from '../infra/ports.ts'
import { COMMANDS } from './decls.ts'

/* ------------------------------------------------------------ 注册表 */

export interface InvokeResult {
  ok: boolean
  /** false ＝ 未处理，交给浏览器默认（未绑定的键 ⇒ 文本输入） */
  handled: boolean
  error?: string
}

export class Registry {
  private decls = new Map<string, CommandDecl>()
  private handlers = new Map<string, Handler>()
  /** 最近一次调用（诊断面板 / 角标用它证明「确实走命令面」） */
  last: { name: string; via: string; at: number; handled: boolean } | null = null
  log: { name: string; via: string; at: number }[] = []

  private app: App

  /**
   * handlers 由装配层注入：**core 不认识 app 实现**，只认识 `Handler` 这个端口。
   *
   * `decls` 缺省是整张声明表；装配层可以传一份**被裁过的**表（例如产品构建剔掉
   * 开发命令）—— 这样「不注册」发生在唯一一张表里，而不是在每个调用点各判一次。
   *
   * ⚠️ 构造参数不用 parameter property：`node --test` 的 strip-only 模式不支持它，
   *    而这张表（参数契约）必须能单独拉起来测。
   */
  constructor(app: App, handlers: Record<string, Handler>, decls: readonly CommandDecl[] = COMMANDS) {
    this.app = app
    for (const d of decls) this.decls.set(d.name, d)
    for (const [n, h] of Object.entries(handlers)) this.handlers.set(n, h)
  }

  list(): CommandDecl[] {
    return [...this.decls.values()]
  }
  decl(name: string): CommandDecl | undefined {
    return this.decls.get(name)
  }

  /**
   * 调用唯一入口。`via` 是**自由诊断标签**，不是枚举：主值与绑定面同形
   * （'keymap' | 'menu' | 'slash' | 'selection'），另有 'chrome' / 'api' 与
   * 各装配点的细分标签（'dock' / 'ui' / 'popover' / …）；可带后缀表拦截，
   * 如 'keymap(blocked:composing)'。
   * **组合期（composing）⇒ 键位来源的调用零触发**（组合期守卫）。
   */
  invoke(name: string, args: Record<string, unknown> = {}, via = 'api', ctx?: CtxKeys): InvokeResult {
    const h = this.handlers.get(name)
    // **没有声明也算没注册**：装配传来的声明表就是「这次构建有哪些命令」的唯一
    // 口径（产品构建里 dev.* 连声明带处理器都不在），调用面以它为准，
    // 否则「只从菜单里藏起来」会被一次 invoke 绕过。
    if (!h || !this.decls.has(name)) return { ok: false, handled: false, error: t('err.cmd.notRegistered', { name }) }
    if (via === 'keymap' && ctx?.composing) {
      this.log.push({ name, via: 'keymap(blocked:composing)', at: Date.now() })
      this.app.ed.probe.compositionSeq.push('blocked')
      return { ok: true, handled: false }
    }
    /**
     * **声明为必需的参数缺了 ⇒ 这一条根本没法跑，必须响。**
     *
     * 不拦的话，handler 里的 `S(a.x, '')` + `if (!x) return false` 会把
     * 「调用方键名传错」读成「没有目标」——零写入、零 toast（用户看到的是「点了没反应」）。
     * 空串与缺键同义：handler 的宽容读法就是这么判的。静态那一半在 `arch-check [40]`。
     */
    const decl = this.decls.get(name)!
    const required = decl.args?.required
    const missing = Array.isArray(required)
      ? required.filter(
          (k): k is string =>
            typeof k === 'string' && (args[k] === undefined || args[k] === null || args[k] === ''),
        )
      : []
    if (missing.length > 0) {
      const msg = t('err.cmd.missingArgs', { name, args: missing.join(', ') })
      this.app.toast(msg, 'warn')
      this.last = { name, via, at: Date.now(), handled: false }
      this.log.push({ name, via, at: Date.now() })
      return { ok: false, handled: false, error: msg }
    }
    let handled = true
    try {
      const r = h(args, this.app)
      if (r === false) handled = false
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.app.toast(t('err.cmd.failed', { name, message: msg }), 'warn')
      this.last = { name, via, at: Date.now(), handled: false }
      return { ok: false, handled: false, error: msg }
    }
    this.last = { name, via, at: Date.now(), handled }
    this.log.push({ name, via, at: Date.now() })
    this.app.ed.probe.lastCommand = { name, at: Date.now(), via }
    return { ok: true, handled }
  }

  /**
   * **一组命令共用一个撤销条目**（命令分组 API 的历史语义，不是事务回滚）。
   *
   * 准入：每条命令都必须已声明、有 handler、且 `undoable`。一条不合格就整组拒绝，
   * 不做「执行一半再报错」。组内命令必须**同步**——异步命令（选图、剪贴板、浮层）
   * 的后续写入发生在 `runGroup` 关袋之后，分组对它没有意义。
   *
   * 语义边界：失败时**已经执行的那几条写入仍会收进同一个撤销条目**（可一次 ⌘Z 撤回），
   * 但不会自动把前几条回滚。要「要么全成要么全败」请让命令内部用一笔 `tx`。
   */
  invokeGroup(
    cmds: readonly { name: string; args?: Record<string, unknown> }[],
    via = 'api',
    ctx?: CtxKeys,
  ): InvokeResult[] {
    if (cmds.length === 0) return []
    const bad = cmds.find((c) => {
      const decl = this.decls.get(c.name)
      return !decl || !decl.undoable || !this.handlers.has(c.name)
    })
    if (bad) return [{ ok: false, handled: false, error: t('err.cmd.notGroupable', { name: bad.name }) }]
    return this.app.runGroup(() => {
      const out: InvokeResult[] = []
      for (const c of cmds) {
        const r = this.invoke(c.name, c.args ?? {}, via, ctx)
        out.push(r)
        if (!r.ok) break
      }
      return out
    })
  }
}
