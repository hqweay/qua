/**
 * **卡片的两个内部原语**：一列块（`cardList`）与一句话空态（`cardNote`）。
 *
 * 为什么这两个值得抽，而卡片外壳（`buildDockCard`）不值得再拆：
 * 外壳已经有唯一产地（`ui/dock.ts`），而**卡里的内容**此前是各处手写 DOM：
 * 四种派生卡（今日／反链／回收站／归属树）＋ 组件卡 ＋ 窗口卡各拼一遍
 * `document.createElement('div'); className = 'block-list'`。
 *
 * 重复的代价不是那几行代码，而是**「卡里的一列块」这个形状没有名字**：
 * 于是新加一张卡的人只会照着旁边那张写一遍，漏掉 `block-list` 就得到一列没有行距的块
 * ——而「行距不对」在短列表上看不出来（通常只有两三行）。
 *
 * 三条口径：
 *   1. **列表只排块，不排 chrome**（抬头／折叠／单卡归卡壳）；
 *   2. **空态是一句话，不是一张空列表**：空列表会让「没有内容」和「没加载出来」
 *      看起来一样；
 *   3. 两者都**不认** `ws`／`registry`，只吃调用方给的字符串与元素。
 */

/**
 * 卡里的一列块。
 *
 * @param extra 额外的类名（例如集合卡的 `collection-list` 带拖放落点样式）
 */
export function cardList(extra = ''): HTMLElement {
  const el = document.createElement('div')
  el.className = extra === '' ? 'block-list' : `block-list ${extra}`
  return el
}

/**
 * 卡里的一句话（空态／提示／兜底）。
 *
 * ⚠️ 它**不是**「空列表」：一张卡没有内容时，用户需要知道**为什么**没有，
 *    而不是看到一个什么都没有的框。
 */
export function cardNote(text: string): HTMLElement {
  const p = document.createElement('p')
  p.className = 'dock-empty'
  p.textContent = text
  return p
}

/**
 * 一个空的列表：**列表 ＋ 一句为什么是空的**。
 *
 * 这是「空态」的完整形状，所以它比 `cardList` ＋ `cardNote` 更常用：
 * 绝大多数卡在没内容时都要说一句。分开调用容易只写一半（只建列表、忘了那句话）。
 */
export function emptyCardList(text: string): HTMLElement {
  const list = cardList()
  list.appendChild(cardNote(text))
  return list
}
