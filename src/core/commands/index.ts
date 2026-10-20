/**
 * `core/commands` 的公开面：命令表（契约）＋ 注册表（设施）。
 * 处理器在 `app/handlers.ts`，**不从这里导出**。
 */
export * from './decls.ts'
export * from './registry.ts'
export type { App, Capability, CommandDecl, DemoState, Handler, MenuRow, MenuRequest, PanelKind } from '../ports.ts'
