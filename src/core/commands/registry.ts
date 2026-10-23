/**
 * 命令注册表：唯一调用入口 + 诊断日志。
 * **不 import handlers** —— 处理器由装配层注入，core 只认 `Handler` 端口。
 */
import type { CtxKeys } from '../undo.ts'
import { t } from '../msg.ts'
import type { App, CommandDecl, Handler } from '../ports.ts'
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

  /**
   * handlers 由装配层注入：**core 不认识 app 实现**，只认识 `Handler` 这个端口。
   *
   * `decls` 缺省是整张声明表；装配层可以传一份**被裁过的**表（例如产品构建剔掉
   * 开发命令）—— 这样「不注册」发生在唯一一张表里，而不是在每个调用点各判一次。
   */
  constructor(
    private app: App,
    handlers: Record<string, Handler>,
    decls: readonly CommandDecl[] = COMMANDS,
  ) {
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
   * 调用唯一入口。`via` 只用于诊断（'keymap' | 'menu' | 'slash' | 'selection' | 'palette' | 'chrome' | 'api'）。
   * **组合期（composing）⇒ 键位来源的调用零触发**（组合期守卫）。
   */
  invoke(name: string, args: Record<string, unknown> = {}, via = 'api', ctx?: CtxKeys): InvokeResult {
    const h = this.handlers.get(name)
    // **没有声明也算没注册**：产品构建会裁掉 `dev.*` 声明；处理器表仍注入，
    // 但调用面必须以声明表为准，否则「只从菜单里藏起来」会被一次 invoke 绕过。
    if (!h || !this.decls.has(name)) return { ok: false, handled: false, error: t('err.cmd.notRegistered', { name }) }
    if (via === 'keymap' && ctx?.composing) {
      this.log.push({ name, via: 'keymap(blocked:composing)', at: Date.now() })
      this.app.ed.probe.compositionSeq.push('blocked')
      return { ok: true, handled: false }
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
}
