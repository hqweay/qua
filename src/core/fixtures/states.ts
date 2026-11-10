/**
 * 三个演示状态：**空态** / **稀疏态**（只有 1 个块）/ **降级态**（超长块・全英文・超长标题・无标题）。
 *
 * 它们与满态种子（`seed.ts`）分开：这三种态是**验收用的极端形状**，
 * 定义的是「一屏看完时必须不出什么事」，改动它们不该被当成改种子内容。
 */
import { todayISO } from '../index.ts'
import type { Workspace } from '../infra/workspace.ts'
import { forest, longParagraph, LONG_EN, mkJournal, mkPage, resolveRefs } from './build.ts'

/**
 * 空态：一个页块、**零子块**（「只能写第一行＝页名」，不做插画）。
 *
 * ⚠️ 2026-10-20 修：原来是 `mkPage('', …, [{ text: '' }])` ⇒ 页块 ＋ 一个空子块 ＝ **两行空白**。
 *   旧代码之所以只显示一行，是因为它错把 `children` 当 roots 装；修好装载口径之后这里就露出来了。
 */
export function emptyWorkspace(): Workspace {
  return forest([mkPage('', 'lucide:file', []).page], [])
}

/**
 * 真空库：**只有今天一天、一行空块**，没有演示内容，也没有页/标签。
 *
 * 与 `emptyWorkspace()`（一个无标题页、零子块）是两件事：那一份是「一屏极简形状」的
 * 验收样张，落在页上；这一份回答的是「刚装好、还没写过东西时打开看到什么」——
 * 落在今天，且必须有一个可写的子块（日记行本身只读，没有子块就没有落点可打字）。
 *
 * 它只被「恢复空库」这条显式动作使用，不进 `FixtureName`：演示状态是换一份样张，
 * 而这一份是把库真的清空（落盘走整份替换，旧 id 全部作废）。
 */
export function blankWorkspace(): Workspace {
  const today = mkJournal(todayISO(), [{ text: '' }])
  return forest([today.page], [today])
}

/** 稀疏态：只有 1 个块、1 个页面（**比满态更容易做砸**） */
export function sparseWorkspace(): Workspace {
  const b = mkPage('唯一一页', 'lucide:file', [{ text: '这一页只有一个块。' }])
  return forest([b.page], [b])
}

/** 降级态：超长块 / 全英文 / 超长标题 / 无标题 / 缺失资产 / 纯原子行，一屏看完 */
export function degradedWorkspace(): Workspace {
  const long = mkPage('超长标题 · A Very Long Page Title That Keeps Going And Going Until Both The Rail And The Breadcrumb Have To Truncate It', 'lucide:triangle-alert', [
    { text: '超长块（' + longParagraph().length + ' 字，单块）：' + longParagraph() },
    { text: '全英文无空格断点：' + LONG_EN },
    { text: '超长标题的页面在左槽里也要能活：' + 'A Very Long Page Title That Keeps Going And Going '.repeat(3) },
    { text: '缺失资产（**资产不可用是状态不是错误**）：![[丢失的截图.png]]' },
    { text: '空块（既无文字也无子块）——上面这行下面还有一个：' },
    { text: '' },
    { text: '只有标点的一行：？？？！！！……' },
    // 纯原子行（**祖先链的极端形状**）：整行只有一个引用/一张图时，面包屑、反链、
    // 回收站读它靠的是呈现摘要（引用读目标名、图片读文件名），读不出字不等于「无标题」。
    { text: '[[设计原则]]' },
    { text: '![[丢失的截图.png]]' },
  ])
  const noTitle = mkPage('', 'lucide:file', [{ text: '无标题页里的内容' }])
  const principles = mkPage('设计原则', 'lucide:file', [{ text: '一切皆块。' }])
  const built = [long, noTitle, principles]
  const blocks = built.map((b) => b.page)
  resolveRefs(blocks, built)
  return forest(blocks, built)
}
