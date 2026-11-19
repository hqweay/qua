/**
 * **地址的存储键**：`normalizeAlias(name)` 这一个纯函数，零依赖叶子。
 *
 * ## 为什么单独一个文件（而不住 `alias.ts`）
 *
 * 它是**存储键**，不是块语义：库里的 `BlockAlias.norm` 列（唯一性判断与按名查询的索引）
 * 与内存里的地址表用的是同一个派生函数，两边必须逐字同解。派生两进程共读的键就有两个
 * 消费者：渲染层（模型与地址表）与主进程（库迁移回填、按名查询计划）。
 * 放进 `alias.ts` 会把整个地址语义（块、props、树遍历）拖进主进程，所以这里只留函数。
 *
 * ## 口径
 *
 * 按 `/` 分段逐段 trim 并丢掉空段：`A / B` → `a/b`，`a//b` → `a/b`，大小写折叠。
 * 丢空段而不是保留，是因为空段在显示上不可见、在比较上却会分出一个新地址。
 * ⚠️ 归一化只影响**比较**，不写回：块上的 `_aliases` 保留用户的原样拼写。
 */
export function normalizeAlias(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .split('/')
    .map((seg) => seg.trim())
    .filter((seg) => seg !== '')
    .join('/')
}
