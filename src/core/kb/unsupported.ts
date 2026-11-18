/**
 * **名字被一个未装载的块占着**：创建路径的显式拒绝。
 *
 * `#名字`／`[[名字]]` 在本地工作集里解析不到时，可能只是「目标还没装载」，
 * 不是「库里没有」。catalog 的全量地址表回答「这个名字归谁」；命中但目标
 * 未装载 ⇒ **不新建**（新建就是第二个同名身份，而地址空间全局唯一）。
 * 调用方接住这一格：要么先装载目标再继续，要么把这次转换留成纯文本并提示。
 */
export class UnloadedAliasError extends Error {
  readonly aliasName: string
  readonly targetId: string

  constructor(aliasName: string, targetId: string) {
    super(`alias "${aliasName}" belongs to an unloaded block (${targetId}); load it before creating`)
    this.name = 'UnloadedAliasError'
    this.aliasName = aliasName
    this.targetId = targetId
  }
}
