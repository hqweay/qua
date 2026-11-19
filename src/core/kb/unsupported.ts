/**
 * **这个名字此刻不能拿来新建**：创建路径的显式拒绝。
 *
 * `#名字`／`[[名字]]` 在本地工作集里解析不到时，有两种「不是『库里没有』」的情形：
 * 目标在库里但**未装载**，或者**还没去库里问过**（部分装载下归属是异步答案）。
 * 两种都必须拒绝新建——新建就是第二个同名身份，而地址空间全局唯一。
 *
 * 调用方接住这一格：先装载／先核定再继续，或把这次转换留成纯文本并提示。
 * 判据在 `BlockStore.aliasState`（三态）与创建入口的 `prepareAlias`。
 */
export class AliasClaimError extends Error {
  readonly aliasName: string

  constructor(aliasName: string, detail: string) {
    super(`alias "${aliasName}" ${detail}`)
    this.name = 'AliasClaimError'
    this.aliasName = aliasName
  }
}

/** 名字在库里、归一个未装载的块：先装它再重放，别新建 */
export class UnloadedAliasError extends AliasClaimError {
  readonly targetId: string

  constructor(aliasName: string, targetId: string) {
    super(aliasName, `belongs to an unloaded block (${targetId}); load it before creating`)
    this.name = 'UnloadedAliasError'
    this.targetId = targetId
  }
}

/** 归属还没核定（入口忘了 `prepareAlias`）：先问一次库再建 */
export class AliasUncheckedError extends AliasClaimError {
  constructor(aliasName: string) {
    super(aliasName, 'has not been looked up yet; prime it before creating')
    this.name = 'AliasUncheckedError'
  }
}
