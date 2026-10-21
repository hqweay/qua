# TODO

统一记录：未完成的 bug / 改进（编号 QB-xxx），以及顺带理清的概念澄清。

- 状态取值：`open` · `fixing` · `fixed` · `wontfix` · `need-info`
- 编号从 `QB-001` 起，新增接着排。
- 复现尽量写成「可执行的步骤」，方便日后补断言或回归测试。
- 概念澄清部分来自代码事实（可 grep 验证），不构成 bug、也不进设计主档。

---

## QB-001

- **日期**：2026-10-22
- **现象**：聚焦根块时，块标菜单里仍有「删除块」。点击后块在当前会话里当场消失，但刷新（重载 workspace）后又重新出现——根块实际上不应被删除，删除操作没有真正生效，只是 UI 层面的临时隐藏。
- **复现**：1) 聚焦一个根块（forest 顶层块）；2) 打开块标菜单；3) 点「删除块」；4) 块从视图消失；5) 刷新应用 → 该块又回来。
- **状态**：**fixed**（`227f864`）；断言 **T56**（聚焦根块时菜单无删除项、直接 invoke 也被拒）
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

## QB-002

- **日期**：2026-10-22
- **现象**：前进/后退（历史导航）没有跟踪每次跳转。例如：在 dailynotes（日记流）里聚焦（zoom）一个块，再点「返回」时，没有回到 dailynotes 视图，而是落在别的地方 / 没反应。
- **复现**：1) 在日记流页面（Daily note 入口，多天 feed）；2) 对某块执行「聚焦到此块」(focus-block / zoom)；3) 打开历史「返回」；4) 预期回到 dailynotes 那棵多天树，实际回到的是某一天 / 某个孤立块，feed 消失。
- **状态**：**fixed**（`227f864`）；断言 **T57**（日记流 zoom 后再后退仍回到 feed）
- **根因分析**（已查代码，未改）：
  - dailynotes 是一个**多根视图**：`rootsForMany(feed)` 装「今日＋更早存在的天」（`src/main.ts:1062-1064`、`src/app/commands-impl.ts:196-201` 的 `openPage`）。但 `ws.activeId` 只存**一个**块 id（`journalId(today)`），历史栈 `nav.back` 记录/回放的也是**单个块 id**（`src/main.ts:679-681`）。
  - 历史回放走 `historyGo`（`src/main.ts:745`）→ `core.block/focus-block` → `zoomTo` → `open(id)`（`src/app/commands-impl.ts:398`）。`open()` 里只有 `loadPage(rootsFor(b), …)`（单块/单天），**没有**「若 activeId 是今天的 journal 则展开成多天 feed」的分支。
  - 这个「展开成 feed」的分支**只存在于 `openPage`**（`commands-impl.ts:196-206`，注释明确写了「回今日日记流；只装这一天会把日记流收成一段」）。`historyGo` 绕过了 `openPage`，直接走 zoom 路径，于是不重建 feed。
  - 两层丢失：① 在 feed 里 zoom 子块后，`activeId` 变成普通子块，feed 上下文彻底丢失；② 即便后退到 `journalId(today)`，`open()` 也只会 `rootsFor` 单天，而非 `rootsForMany(feed)`。
  - 结论：**历史栈以「块 id」为粒度，但 dailynotes 的「当前对象」不是一块而是一棵 feed 树（由 activeId 的角色 + 今天这个特殊入口推导）。** zoom 子块 / 回放都没有还原这个推导。
  - 代码内已有两条注释预警此分歧：`openPage` 的「只装这一天会把日记流收成一段」（`commands-impl.ts:191-194`），以及 `// 左槽只有「今天」这一个入口`（`commands-impl.ts:194`）。
  - **修复方向（供确认）**：让历史回放复用 `openPage` 的「journal→feed 展开」逻辑，而不是裸 `zoomTo`——即在 `open()` / `zoomTo` 里：当目标 id 是今天的 journal 块时，改用 `rootsForMany(journalFeedDays(…))` 装载，与 `openPage` 同一条规则；更彻底的做法是把「feed 视图状态」也纳入历史栈（记录当前是不是 feed、滚动位置），但这超出单块粒度。优先前者（与现有 `openPage` 归一）。

---

## QB-003

- **日期**：2026-10-22
- **现象**（改进 / 已修）：点击编辑器底部空白处就会新建一个空块，体验不合适。当前逻辑：在 `#scroll` 空白区、且 `clientY` 在最后一行可见块底边之下时，向「最后一段」（日记流里是最早的一天）追加一个空子块（`src/view/editor.ts:1494 clickEmptyArea`，由 `src/view/editor-events.ts:283` 的 click 空白判据触发）。主编辑器 `allowBlankCreate` 默认 `true`（dock/反链/查询视图为 `false`）。
- **复现**：1) 在正文区滚动到底部；2) 点击最后一块之下的空白区域；3) 自动出现一个空块（挂在最后一段末尾）。
- **状态**：fixed（已在 `src/view/editor.ts` `clickEmptyArea` 落地去重逻辑）
- **已定口径**（你拍板）：点底部空白时——若最后一段（最后一行所在段）末尾已有一个空块（`text===''` 且 `children.length===0`），**直接聚焦该空块，不新建**；否则才新建一个空块并聚焦。这样「点底部」永远最多一个空块，不无中生有堆空块，也保留了「点底部快速记一笔」的顺手感。
- **改动**：`src/view/editor.ts:1494` `clickEmptyArea` 在 push 前先查 `root.children` 末元素是否为空块，是则复用、否则新建。

---

## 概念澄清

### 角色 `backref` 是做什么的

- 它是 `Role` 联合类型的一个值（`src/core/model.ts`），与 `page`／`journal`／`tag` 同级的**纯声明**，不携带任何专属数据字段。
- 只在**右槽反链面板**（`src/ui/dock-content.ts` 的 `renderBackrefsInto`）里被用上：查出「谁引用了当前块」后，把每条结果**临时构造成一个块**渲染：
  ```ts
  const row: Block = { id: s.pageId, text: s.text, children: [], roles: ['backref'] }
  ```
- 作用只有一个：**标记「这一行是反链结果，不是真块」**，让渲染层（`src/ui/block-renderers.ts` 的 `backRefRenderer`）用「带箭头的一行 / `page-item backref-item`」样式画它，而不是当成可编辑内容块。
- 这些 `backref` 块是每次渲染时现造的，**从不写进 `workspace.blocks`**、不进持久化；刷新即消失、再查再生成。

一句话：`backref` 是反链面板里那一行引用来源的**展示标记角色**，本身不携带数据、不入库，纯粹是查询结果的展示外壳。

### 底部反链 footer 与右槽反链面板的区别（两套实现）

底部那个反链 panel 是 `src/ui/backlinks.ts` 的 `BacklinksView`，当前放在正文区下方当 footer。它和右侧槽的反链面板（上一节那个）是**两套机制**：

| | 右槽反链面板 | 底部反链 footer |
|---|---|---|
| 实现 | `renderBackrefsInto`（`dock-content.ts`） | `BacklinksView`（`backlinks.ts`） |
| 数据来源 | `backrefsOf` → 现造的临时块，带 `roles:['backref']` | `backrefBlocks` → **库里真实的源块**（活引用，不拷贝） |
| 用 `backref` 角色吗 | 用 | **不用**，直接 `loadPage` 真实块 |
| 能否编辑 | 不能（只读的一行链接） | **能原地编辑**，写回共享 store |
| 编辑后同步 | 纯展示 | 别的视图收 `touch` 同步 |

- 底部 footer **不使用 `backref` 角色**：它用 `backrefBlocks` 查出「引用了当前块的真实源块」，去掉「祖先也在结果里」的重复项（`backlinks.ts` 的 `findPath` 去重），再 `loadPage({ roots }, …)` 装进一个**普通 `BlockEditor` 实例**渲染。
- 该 footer 编辑器构造时关掉了「点空白建块」和「删段根」（`allowBlankCreate:false, allowRootRemove:false`），因为它只是受控视图。
- `backlinks.ts` 顶注预告了下一步：底部 footer 与将来右槽会**共用同一个 `BacklinksView`**，靠槽来排布；右槽届时也会变成「可编辑的真实源块」，而非现在那种「`backref` 角色的只读行」。

一句话：底部反链 footer = 把引用源的真实块装进普通编辑器、可原地编辑的视图；它不用 `backref` 角色（那是右槽只读面板的展示标记）。
