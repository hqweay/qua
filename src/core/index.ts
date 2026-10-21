/**
 * **模型内核**的公开面：唯一桶出口。
 * 外部只从 `./core/index.ts`（或 `../core/index.ts`）import 块模型，不深入子模块 ——
 * 这样内部怎么拆都不会漏到调用方。`core/` 下的机制模块（bindings、dispatch…）按需直连。
 */
export * from './ids.ts'
export * from './model.ts'
export * from './alias.ts'
export * from './journal.ts'
export * from './tree.ts'
export * from './favorites.ts'
export * from './text.ts'
export * from './annotations.ts'
export * from './selection.ts'
export * from './undo.ts'
export * from './store.ts'
export * from './backrefs.ts'
export * from './ref.ts'
export * from './tags.ts'
export * from './props.ts'
export * from './index-port.ts'
export * from './query.ts'
export * from './query-view.ts'
