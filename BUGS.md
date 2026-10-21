# Bugs

精简记录。字段：**编号 / 日期 / 现象 / 复现 / 状态**。

- 状态取值：`open` · `fixing` · `fixed` · `wontfix` · `need-info`
- 编号从 `QB-001` 起，新增接着排。
- 复现尽量写成「可执行的步骤」，方便日后补断言或回归测试。

---

## QB-001

- **日期**：2026-10-22
- **现象**：聚焦根块时，块标菜单里仍有「删除块」。点击后块在当前会话里当场消失，但刷新（重载 workspace）后又重新出现——根块实际上不应被删除，删除操作没有真正生效，只是 UI 层面的临时隐藏。
- **复现**：1) 聚焦一个根块（forest 顶层块）；2) 打开块标菜单；3) 点「删除块」；4) 块从视图消失；5) 刷新应用 → 该块又回来。
- **状态**：open（已定位根因，待修）
- **根因分析**（已查代码，未改）：
  - 菜单项 `core.editor/delete-block` 的可见条件是 `when: 'blockFocused'`（`src/core/bindings.ts:103`），根块聚焦时该条件仍为 true，所以**菜单项照常出现**——缺一个「且不是根块」的 `when`。
  - 主编辑器 `mainEd`（`src/main.ts:1135`）构造时**没有**传 `allowRootRemove`，按 `src/view/editor.ts:214` 默认 `= true`。
  - `BlockEditor.remove(id)`（`src/view/editor.ts:1206`）守卫为
    `if (loc.parent === null && (!this.allowRootRemove || this.doc.roots.length > 1)) return`。
    对根块且 `allowRootRemove=true` 且 `roots.length===1` 时**守卫放行**，根块被 splice，UI 消失。
  - 注意 `editor.ts:1209-1210` 注释**已经预警**过这个坑：段根（页/天/zoom 根）不该从编辑器删，否则「写回跳过它、库里还在，刷新又回来」。本 bug 正是同一机制作用在普通根块上。
  - 对比 `deletePage`（`src/app/commands-impl.ts:216`）对根级页有「至少留一页」保护并显式 `saveNow`；编辑器内 `remove` 对根块既无菜单级拦截、也无落盘级保护。
  - **修复方向（供确认）**：① 在绑定层给 `delete-block` 的 menu/slash 加 `when: 'blockFocused && !blockIsRoot'`（需在上下文键里补 `blockIsRoot`）；② 或把 `remove` 的守卫收紧为「根块一律 return」，并补一个回归断言（聚焦根块时菜单不出现删除 / 删除被拒）。优先 ①，因为它直接反映「根块不支持删除」的语义。

---

## QB-003

- **日期**：2026-10-22
- **现象**（改进 / 待定）：点击编辑器底部空白处就会新建一个空块，体验不合适。当前逻辑：在 `#scroll` 空白区、且 `clientY` 在最后一行可见块底边之下时，向「最后一段」（日记流里是最早的一天）追加一个空子块（`src/view/editor.ts:1494 clickEmptyArea`，由 `src/view/editor-events.ts:283` 的 click 空白判据触发）。主编辑器 `allowBlankCreate` 默认 `true`（dock/反链/查询视图为 `false`）。
- **复现**：1) 在正文区滚动到底部；2) 点击最后一块之下的空白区域；3) 自动出现一个空块（挂在最后一段末尾）。
- **状态**：fixed（已在 `src/view/editor.ts` `clickEmptyArea` 落地去重逻辑）
- **已定口径**（你拍板）：点底部空白时——若最后一段（最后一行所在段）末尾已有一个空块（`text===''` 且 `children.length===0`），**直接聚焦该空块，不新建**；否则才新建一个空块并聚焦。这样「点底部」永远最多一个空块，不无中生有堆空块，也保留了「点底部快速记一笔」的顺手感。
- **改动**：`src/view/editor.ts:1494` `clickEmptyArea` 在 push 前先查 `root.children` 末元素是否为空块，是则复用、否则新建。
- **根因分析**（已查代码，未改）：
  - dailynotes 是一个**多根视图**：`rootsForMany(feed)` 装「今日＋更早存在的天」（`src/main.ts:1062-1064`、`src/app/commands-impl.ts:196-201` 的 `openPage`）。但 `ws.activeId` 只存**一个**块 id（`journalId(today)`），历史栈 `nav.back` 记录/回放的也是**单个块 id**（`src/main.ts:679-681`）。
  - 历史回放走 `historyGo`（`src/main.ts:745`）→ `core.block/focus-block` → `zoomTo` → `open(id)`（`src/app/commands-impl.ts:398`）。`open()` 里只有 `loadPage(rootsFor(b), …)`（单块/单天），**没有**「若 activeId 是今天的 journal 则展开成多天 feed」的分支。
  - 这个「展开成 feed」的分支**只存在于 `openPage`**（`commands-impl.ts:196-206`，注释明确写了「回今日日记流；只装这一天会把日记流收成一段」）。`historyGo` 绕过了 `openPage`，直接走 zoom 路径，于是不重建 feed。
  - 两层丢失：① 在 feed 里 zoom 子块后，`activeId` 变成普通子块，feed 上下文彻底丢失；② 即便后退到 `journalId(today)`，`open()` 也只会 `rootsFor` 单天，而非 `rootsForMany(feed)`。
  - 结论：**历史栈以「块 id」为粒度，但 dailynotes 的「当前对象」不是一块而是一棵 feed 树（由 activeId 的角色 + 今天这个特殊入口推导）。** zoom 子块 / 回放都没有还原这个推导。
  - 代码内已有两条注释预警此分歧：`openPage` 的「只装这一天会把日记流收成一段」（`commands-impl.ts:191-194`），以及 `// 左槽只有「今天」这一个入口`（`commands-impl.ts:194`）。
  - **修复方向（供确认）**：让历史回放复用 `openPage` 的「journal→feed 展开」逻辑，而不是裸 `zoomTo`——即在 `open()` / `zoomTo` 里：当目标 id 是今天的 journal 块时，改用 `rootsForMany(journalFeedDays(…))` 装载，与 `openPage` 同一条规则；更彻底的做法是把「feed 视图状态」也纳入历史栈（记录当前是不是 feed、滚动位置），但这超出单块粒度。优先前者（与现有 `openPage` 归一）。
