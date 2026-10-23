/**
 * 三个演示状态：**空态** / **稀疏态**（只有 1 个块）/ **降级态**（超长块・全英文・超长标题・无标题）。
 *
 * 它们与满态种子（`seed.ts`）分开：这三种态是**验收用的极端形状**，
 * 定义的是「一屏看完时必须不出什么事」，改动它们不该被当成改种子内容。
 */
import type { Workspace } from '../workspace.ts'
import { forest, longParagraph, LONG_EN, mkPage, resolveRefs } from './build.ts'

/**
 * 空态：一个页块、**零子块**（「只能写第一行＝页名」，不做插画）。
 *
 * ⚠️ 2026-10-20 修：原来是 `mkPage('', …, [{ text: '' }])` ⇒ 页块 ＋ 一个空子块 ＝ **两行空白**。
 *   旧代码之所以只显示一行，是因为它错把 `children` 当 roots 装；修好装载口径之后这里就露出来了。
 */
export function emptyWorkspace(): Workspace {
  return forest([mkPage('', 'lucide:file', []).page], [])
}

/** 稀疏态：只有 1 个块、1 个页面（**比满态更容易做砸**） */
export function sparseWorkspace(): Workspace {
  const b = mkPage('唯一一页', 'lucide:file', [{ text: '这一页只有一个块。' }])
  return forest([b.page], [b])
}

/** 降级态：超长块 / 全英文 / 超长标题 / 无标题 / 缺失资产，一屏看完 */
export function degradedWorkspace(): Workspace {
  const long = mkPage('超长标题 · A Very Long Page Title That Keeps Going And Going Until Both The Rail And The Breadcrumb Have To Truncate It', 'lucide:triangle-alert', [
    { text: '超长块（' + longParagraph().length + ' 字，单块）：' + longParagraph() },
    { text: '全英文无空格断点：' + LONG_EN },
    { text: '超长标题的页面在左栏里也要能活：' + 'A Very Long Page Title That Keeps Going And Going '.repeat(3) },
    { text: '缺失资产（**资产不可用是状态不是错误**）：![[丢失的截图.png]]' },
    { text: '空块（既无文字也无子块）——上面这行下面还有一个：' },
    { text: '' },
    { text: '只有标点的一行：？？？！！！……' },
  ])
  const noTitle = mkPage('', 'lucide:file', [{ text: '无标题页里的内容' }])
  const built = [long, noTitle]
  const blocks = built.map((b) => b.page)
  resolveRefs(blocks, built)
  return forest(blocks, built)
}
