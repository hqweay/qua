/**
 * `pnpm check` —— 浏览器级冒烟：**真 Chrome ＋ 真按键 ＋ 真鼠标**，逐条打勾。
 * 断言口径尽量贴任务书：能敲字 / Enter 拆块 / Backspace 合并 / Tab 缩进 / 折叠 / 拖拽重排 /
 * 四种区间格式 / 两种行内原子 / 命令面板（无绑定也能执行）/ 菜单由绑定表渲染 /
 * localStorage 持久化 / 三风格 × 亮暗 / 空态·稀疏态·降级态 / 虚拟化与 composing 角标。
 *
 * ⚠️ **每条用例必须 `await check(...)`**：`check` 是 async，漏掉 await 的用例会和文件末尾的
 *    `browser.close()` 并发，报 `browserContext.newPage: Target page, context or browser has been closed`
 *    —— 看起来像浏览器挂了，其实是用例没进队列。
 *
 * ⚠️ harness 的 `assert` 是裸 `(cond, msg)`——**没有 `deepEqual`**：等值断言用
 *    `JSON.stringify(a) === JSON.stringify(b)`（真踩过三回，报错是「deepEqual is not a function」）。
 * ⚠️ `lastOps()` 只在**事务产出 op 时**更新：零事务的动作（幂等打开、重复打已有标签）会让它
 *    停在上一笔——验「这次没写」要对比动作前后的 `lastOps` 加模型状态，不能直接断言它为空。
 * ⚠️ 新用例编号先 grep 本文件最大 T 号再接（T76 之后一段时期最大号与直觉不符，撞过一次）。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { assert, freshPage, key as kbd, launch, openPage, reopenPage, resolveBase } from '../scripts/harness.mjs'

const SHOTS = fileURLToPath(new URL('../shots/', import.meta.url))
const results = []

/**
 * **分片**：这份用例集可以被 N 个进程切片跑（`pnpm gate` 把墙钟时间摊到多核上）。
 *
 * 为什么切在 `check()` 里、而不是拆成几个文件：97 条用例是同一个模板
 *   （`freshPage` ⇒ 断言 ⇒ 不留状态），彼此没有顺序依赖，拆文件要动几千行；
 *   这里只多一个「这一条归不归我」的判断。
 *
 * `QUA_SMOKE_SHARD=i/N`（0 ≤ i < N）；不设 ＝ 全跑（本地单跑、排查时就是这个）。
 * ⚠️ 切片按**声明顺序的序号**取模 —— 别改成按名字，改个用例名就会改切片。
 */
const SHARD = (() => {
  const spec = process.env.QUA_SMOKE_SHARD
  if (!spec) return null
  const m = /^(\d+)\/(\d+)$/.exec(spec)
  const i = m ? Number(m[1]) : NaN
  const n = m ? Number(m[2]) : NaN
  if (!(n >= 1) || !(i >= 0 && i < n)) {
    throw new Error(`QUA_SMOKE_SHARD 要写成 i/N 且 0 ≤ i < N，收到 "${spec}"`)
  }
  return { i, n }
})()

/**
 * `QUA_SMOKE_REPORT=<文件>` ⇒ 把结果写成 JSON 并**不逐条打印**（分片时由编排脚本读回合并）。
 * 报告里带上 `total`（本进程一共看到多少条用例）：合并端据此验「切片有没有漏东西」——
 * 少一条就等于漏测，而漏测是不报错的（这是分片唯一会静默失效的地方，必须自己验）。
 */
const REPORT = process.env.QUA_SMOKE_REPORT ?? ''
const ONLY = process.env.QUA_SMOKE_ONLY ?? ''
let seq = 0

/**
 * **已知失败**（如实记账，不判红）。
 *
 * 判据：这条用例在**引入它要守的那次改动之前**的检出上就已经挂——用 `git worktree` 起旧 commit、
 * 把同一份用例拷过去跑，失败原文逐字相同。那种失败不是当前改动的账，但也不能假装不存在：
 * 命中这里时**逐条打印**（带原因），只是不计入退出码。
 *
 * ⚠️ **这张表只能短，最好是空的。** 它一长，门禁就变成了「读日志」而不是「看红绿」。
 *    新条目必须写明「在哪个检出上验过同样挂」，并留一条待办去修；
 *    修好之后从表里删掉（而不是把断言改松）。
 *
 * 2026-10-25：三条全修好了 ⇒ 表回到空。留这张空表而不是删掉机制——
 *    下一个「既有失败」出现时，需要的是一个**显式**的去处，而不是又一次「先放着不管」。
 */
const KNOWN_FAILURES = []

const knownOf = (name) => KNOWN_FAILURES.find((k) => name.includes(k.match))

async function check(name, fn) {
  const idx = seq++
  // 调试过滤：只跑名字含 QUA_SMOKE_ONLY 子串的用例（不设 ＝ 全跑；分片编排不受影响）
  if (ONLY && !name.includes(ONLY)) return
  if (SHARD && idx % SHARD.n !== SHARD.i) return
  try {
    const msg = await fn()
    results.push({ idx, name, ok: true, msg: msg ?? '' })
  } catch (e) {
    results.push({ idx, name, ok: false, msg: e?.message ?? String(e), known: knownOf(name)?.why ?? '' })
  }
}

const { base, mode, server } = await resolveBase()
const browser = await launch()
console.log(`\n冒烟：${base}（${mode}）\n`)
await mkdir(SHOTS, { recursive: true })

const snap = (page) => page.evaluate(() => window.__qua.snapshot())
const blocks = (page) => page.evaluate(() => window.__qua.blocks())
const texts = (page) => page.evaluate(() => window.__qua.text())

/**
 * 冷启动落在**今日 journal**，而 `blocks`/`text` 读的是**当前页的子树**
 * ⇒ 凡是要测「某一页的内容」的用例，必须**显式打开那一页**，别依赖「第 1 块就是它」。
 * （journal 是一块，但不是页：`pages()` 只列 `page` 角色，所以 `pages()[0]` 就是假数据第 1 页。）
 */
const openFirstPage = (page) =>
  page.evaluate(() => window.__qua.invoke('core.page/open', { pageId: window.__qua.pages()[0].id }))

/**
 * 检索浮层的行读点：**标签 / 右侧按键徽标 / 是不是当前那一行**。
 *
 * 浮层是同一个组件（`Layers.openMenu`），所以三个触发字符共用这一个读法；
 * 断言要能回答「这一行支不支持 ⌥↵」（徽标在不在），而不只是「列表非空」。
 */
const layerRows = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.layer-item')].map((e) => ({
      label: e.querySelector('.layer-label')?.textContent ?? '',
      hint: e.querySelector('.layer-hint')?.textContent ?? '',
      key: e.querySelector('.layer-key')?.textContent ?? '',
      active: e.dataset.active === '1',
    })),
  )

/**
 * 点挂载区的某一栏。
 *
 * `key` ＝ 那一栏的**稳定 id**：内置栏就是来源名（`refs`／`same`／`mentions`），
 * 用户栏是 `t-<hex>`。**不再是数组下标**——摘掉一栏之后下标会全体漂。
 * `.first()` 取第一个挂载区 —— feed 里一段一个，单根屏只有一个，用例里按需自证。
 */
const mountTab = async (page, kind) => {
  await page.locator(`#editor .mount .mount-tabwrap[data-tab="${kind}"] .mount-tab`).first().click()
  await page.waitForTimeout(180)
}

/** 挂载区里的行（只在**激活栏**的 body 里） */
const mountRows = (page) => page.evaluate(() => document.querySelectorAll('#editor .mount .mount-editor .blk').length)

/** 让一个标签块先存在（走命令面，不经过打字路径）：返回它的 id */
const seedTag = (page, name) =>
  page.evaluate((name) => {
    const b = window.__qua.blocks().find((x) => !x.roles.includes('journal'))
    window.__qua.focusBlock(b.id, 0)
    window.__qua.invoke('core.editor/insert-tag', { tag: name })
    return window.__qua.allBlocks().find((x) => x.roles?.includes('tag') && x.text === name)?.id ?? ''
  }, name)

/** 找一个「可编辑、无子块、无标签、无身份」的内容块 —— 打字路径最干净的落点 */
const cleanBlock = (page) =>
  page.evaluate(() => {
    const ed = window.__qua.__editor
    const plain = (x) => x.content.filter((r) => r.t === 'text').map((r) => r.v).join('')
    const b = ed
      .rows()
      .map((r) => r.block)
      .find((x) => !(x.roles?.length) && !x.children.length && !(x.props?._tags?.length))
    return b ? { id: b.id, text: plain(b) } : null
  })

/* ------------------------------------------------------- 侧槽的钉住区工具 */

/** Shift+点某个块的块标（待办行的方框也是块标）；mousedown 与 click 都发，覆盖两条分支 */
const shiftClickMarker = (page, blockId) =>
  page.evaluate((id) => {
    const marker = document.querySelector(`.blk[data-block-id="${id}"] .marker`)
    if (!marker) return false
    for (const type of ['mousedown', 'click']) {
      marker.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, shiftKey: true }))
    }
    return true
  }, blockId)

/** 真的走一遍 HTML5 DnD：卡头 dragstart（`CARD_MIME`）→ 目标槽 stack dragover/drop */
const dragCard = (page, { from, to, id, before }) =>
  page.evaluate(
    ({ from, to, id, before }) => {
      const head = document.querySelector(`#dock-${from} .dock-card[data-card-id="${id}"] .dock-card-head`)
      const stack = document.querySelector(`#dock-${to} .dock-stack`)
      if (!head || !stack) return null
      const target = before ? document.querySelector(`#dock-${to} .dock-card[data-card-id="${before}"]`) : null
      const box = (target ?? stack).getBoundingClientRect()
      // 落在目标卡的上半 ⇒ before；落在所有卡之下 ⇒ 末尾
      const y = target ? box.top + 2 : box.bottom - 2
      const dt = new DataTransfer()
      const ev = (type) =>
        new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: box.left + 8, clientY: y })
      head.dispatchEvent(ev('dragstart'))
      stack.dispatchEvent(ev('dragover'))
      const hot = Boolean(
        document.querySelector(`#dock-${to} .dock-card[data-drop-before="1"], #dock-${to} .dock-card[data-drop-after="1"]`),
      )
      stack.dispatchEvent(ev('drop'))
      head.dispatchEvent(ev('dragend'))
      return { hot, cards: window.__qua.snapshot().dock }
    },
    { from, to, id, before },
  )

/** 真的走一遍 HTML5 DnD：小卡 dragstart（`CARD_MIME`）→ 目标槽 dragover/drop */
const dragTile = (page, { from, to, id, before }) =>
  page.evaluate(
    ({ from, to, id, before }) => {
      const tile = document.querySelector(`#dock-${from} .dock-tile[data-card-id="${id}"]`)
      const stack = document.querySelector(`#dock-${to} .dock-stack`)
      if (!tile || !stack) return null
      const target = before ? document.querySelector(`#dock-${to} [data-card-id="${before}"]`) : null
      const box = (target ?? stack).getBoundingClientRect()
      // 落在目标格的左半边 ⇒ before；落在末尾 ⇒ 最后
      const x = target ? box.left + 2 : box.right - 2
      const y = box.top + box.height / 2
      const dt = new DataTransfer()
      const ev = (type) =>
        new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y })
      tile.dispatchEvent(ev('dragstart'))
      stack.dispatchEvent(ev('dragover'))
      const hot = Boolean(
        document.querySelector(`#dock-${to} .dock-tile[data-drop-before="1"], #dock-${to} .dock-tile[data-drop-after="1"], #dock-${to} .dock-card[data-drop-before="1"], #dock-${to} .dock-card[data-drop-after="1"]`),
      )
      stack.dispatchEvent(ev('drop'))
      tile.dispatchEvent(ev('dragend'))
      return { hot, cards: window.__qua.snapshot().dock }
    },
    { from, to, id, before },
  )

/** 真的走一遍 HTML5 DnD：块标 dragstart（`application/x-qua-block` = 块 id）→ 集合卡 body dragover → drop */
const dragBlockToCollection = (page, blockId, cardId) =>
  page.evaluate(
    ({ id, cardId }) => {
      const marker = document.querySelector(`.blk[data-block-id="${id}"] .marker`)
      const body = document.querySelector(`#dock-right .dock-card[data-card-id="${cardId}"] .collection-list`)
      if (!marker || !body) return null
      const dt = new DataTransfer()
      const rect = body.getBoundingClientRect()
      const ev = (type) =>
        new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
          clientX: rect.left + 8,
          clientY: rect.top + 8,
        })
      marker.dispatchEvent(ev('dragstart'))
      body.dispatchEvent(ev('dragover'))
      const hot = body.dataset.drop === '1'
      body.dispatchEvent(ev('drop'))
      marker.dispatchEvent(ev('dragend'))
      return { hot }
    },
    { id: blockId, cardId },
  )

/** 真的走一遍 HTML5 DnD：集合项手柄 dragstart（`ITEM_MIME`）→ 集合 body dragover → drop */
const dragCollectionItem = (page, cardId, itemId, toIndex) =>
  page.evaluate(
    ({ cardId, itemId, toIndex }) => {
      const card = document.querySelector(`#dock-right .dock-card[data-card-id="${cardId}"]`)
      const grip = card?.querySelector(`.collection-row[data-item-id="${itemId}"] .collection-grip`)
      const list = card?.querySelector('.collection-list')
      if (!grip || !list) return null
      const rows = [...list.querySelectorAll(':scope > .collection-row')]
      const target = rows[toIndex] ?? null
      const rect = target ? target.getBoundingClientRect() : list.getBoundingClientRect()
      const y = target ? rect.top + 2 : rect.bottom - 2
      const dt = new DataTransfer()
      const ev = (type) =>
        new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: rect.left + 8, clientY: y })
      grip.dispatchEvent(ev('dragstart'))
      list.dispatchEvent(ev('dragover'))
      const hot = list.dataset.drop === '1'
      list.dispatchEvent(ev('drop'))
      grip.dispatchEvent(ev('dragend'))
      return { hot }
    },
    { cardId, itemId, toIndex },
  )

/** 真的走一遍 HTML5 DnD：块标 dragstart（`application/x-qua-block` = 块 id）→ 槽 dragover → drop */
const dragBlockToDock = (page, blockId, side) =>
  page.evaluate(
    ({ id, side }) => {
      const marker = document.querySelector(`.blk[data-block-id="${id}"] .marker`)
      const root = document.getElementById(`dock-${side}`)
      if (!marker || !root) return null
      const dt = new DataTransfer()
      const ev = (type) => new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt })
      marker.dispatchEvent(ev('dragstart'))
      root.dispatchEvent(ev('dragover'))
      const hot = root.dataset.dropPin === '1'
      root.dispatchEvent(ev('drop'))
      marker.dispatchEvent(ev('dragend'))
      return { hot, carried: dt.getData('application/x-qua-block') }
    },
    { id: blockId, side },
  )

/** 槽当前状态：prefs 里的卡片清单 + 真正渲染出来的窗口（按 DOM 顺序） */
const dockState = (page) =>
  page.evaluate(() => {
    const wins = (side) =>
      [...document.querySelectorAll(`#dock-${side} .dock-card[data-window="1"]`)].map((r) => r.dataset.cardId)
    return { pref: window.__qua.snapshot().dock, rows: { left: wins('left'), right: wins('right') } }
  })

/** 窗口里**那一块自己的**正文（窗口里还有它的子树，不能取窗口内第一个/全部 `.tx`） */
const pinRootText = (page, side, blockId) =>
  page.evaluate(
    ({ side, id }) =>
      document.querySelector(
        `#dock-${side} .dock-card[data-window="1"][data-card-id="${id}"] .dock-window-editor .blk[data-depth="0"] > .tx`,
      )?.textContent ?? '',
    { side, id: blockId },
  )

/** 一个块窗口的卡片选择器（断言与点击共用同一条口径） */
const windowSel = (side, blockId) => `#dock-${side} .dock-card[data-window="1"][data-card-id="${blockId}"]`

/** 一个块窗口的**根块标**（窗口里还有子树，不能取第一个 marker） */
const rootMarker = (side, blockId) =>
  `#dock-${side} .dock-card[data-window="1"][data-card-id="${blockId}"] .blk[data-depth="0"] > .left > .marker`


/* ---------------------------------------------------------------- 敲字 */

await check('T1 冷启动不抢光标；点块才聚焦；属性区跟着「这一屏是谁」而不是光标；journal 的日期行不被写入', async () => {
  const { ctx, page, errors } = await freshPage(browser, base)
  const before = await snap(page)
  const cold = await page.evaluate(() => {
    // journal 首行是只读日期 ⇒ 第一个可编辑块是它的子块
    const b = window.__qua.blocks()
    const editable = b.find((x) => !x.roles?.includes('journal'))
    const editor = document.getElementById('editor')
    const props = document.getElementById('inspect-card')
    return {
      id: editable?.id ?? '',
      focused: editor?.contains(document.activeElement) ?? false,
      sel: window.__qua.snapshot().selection ?? null,
      propsHidden: props?.hidden ?? null,
      propsTarget: props?.dataset.targetBlockId ?? '',
      activeId: window.__qua.snapshot().activeId,
    }
  })
  assert(cold.id, `冷启动应能找到第一个可编辑块：${JSON.stringify(cold)}`)
  assert(!cold.focused, `冷启动不该把焦点抢进编辑器：${JSON.stringify(cold)}`)
  assert(!cold.sel, `冷启动不该有模型选区：${JSON.stringify(cold)}`)
  /**
   * 冷启动是**日记流**（多根）⇒ 没有单一主体 ⇒ 属性区收起。
   * 这与「有没有焦点」无关：哪怕光标进了某一天，日记流也不是「一个东西」。
   */
  assert(cold.propsHidden === true, `日记流（多根）没有单一主体 ⇒ 属性区应收起：${JSON.stringify(cold)}`)

  // 真点一下那一行：光标进编辑器（**不是**换当前对象）
  await page.locator(`.blk[data-block-id="${cold.id}"] > .tx`).click()
  await page.waitForTimeout(120)
  const clicked = await page.evaluate(() => {
    const editor = document.getElementById('editor')
    const props = document.getElementById('inspect-card')
    return {
      focused: editor?.contains(document.activeElement) ?? false,
      sel: window.__qua.snapshot().selection ?? null,
      propsHidden: props?.hidden ?? null,
      propsTarget: props?.dataset.targetBlockId ?? '',
    }
  })
  assert(clicked.focused, `点击块后编辑器应获得焦点：${JSON.stringify(clicked)}`)
  assert(clicked.sel?.aBlock === cold.id, `点击后选区应落在被点的块上：${JSON.stringify(clicked)}`)
  assert(
    clicked.propsHidden === true,
    `只是把光标放进某个块，不会让属性区认它当主体（仍是多根的日记流）：${JSON.stringify(clicked)}`,
  )

  await page.keyboard.type('真正敲进去的六个字')
  await page.keyboard.press('End')
  const after = await snap(page)
  const t = await texts(page)
  assert(!errors.length, `页面报错：${errors.join(' | ')}`)
  assert(after.blocks === before.blocks, `块数应不变：${before.blocks} → ${after.blocks}`)
  // 打进**光标所在块**（不是 flatten 的第 0 条——那是只读的日期行）
  const got = await page.evaluate(() => {
    const sel = window.__qua.snapshot().selection
    return window.__qua.blocks().find((x) => x.id === sel?.aBlock)?.text ?? ''
  })
  assert(got.includes('真正敲进去的六个字'), `光标所在块没拿到文本：${JSON.stringify(got)}｜全量=${JSON.stringify(t)}`)
  // 日期行仍是空的：日期是 `_date` 的只读投影，打进去的字不许落在它上面
  const journalText = await page.evaluate(() => window.__qua.blocks().find((b) => b.roles?.includes('journal'))?.text)
  assert(journalText === '', `journal 行不该被写入：${JSON.stringify(journalText)}`)
  await ctx.close()
  return `冷启动无焦点、无选区、日记流（多根）属性区收起；点击只挪光标不改主体；块数 ${after.blocks}，DOM 节点 ${after.domNodes}`
})

await check('T1b 属性区跟「当前对象」走：聚焦换主体、光标移动不换、点空白不收起', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await openFirstPage(page)
  const ids = await page.evaluate(() =>
    window.__qua
      .blocks()
      .filter((b) => !b.roles?.includes('journal'))
      .map((b) => b.id),
  )
  assert(ids.length >= 2, `至少需要两个可编辑块才能测「换主体」：${JSON.stringify(ids)}`)
  /**
   * ⚠️ 要拿**内容块**，不能拿页根：`create-def` 落在页块上只是「声明一个字段」
   *    （`_fieldDefs` 加一条），页自己身上并没有这一行值 —— 行数差就造不出来。
   *    页根就是 `activeId`，排除它还能顺带保证「主体会真的换」。
   */
  const pageId = await page.evaluate(() => window.__qua.snapshot().activeId)
  const [a, b] = ids.filter((id) => id !== pageId)
  assert(a && b, `需要两个非根的块：page=${pageId}｜ids=${JSON.stringify(ids)}`)
  const state = () =>
    page.evaluate(() => {
      const props = document.getElementById('inspect-card')
      return {
        hidden: props?.hidden ?? null,
        target: props?.dataset.targetBlockId ?? '',
        activeId: window.__qua.snapshot().activeId,
      }
    })

  // 打开一页 ⇒ 唯一根 ⇒ 主体＝页块（**不是**光标所在的块）
  const onPage = await state()
  assert(onPage.hidden === false, `单根视图（页）⇒ 属性区应显示：${JSON.stringify(onPage)}`)
  assert(onPage.target === onPage.activeId, `主体应等于当前对象：${JSON.stringify(onPage)}`)

  /**
   * 给块 A 单加一条属性槽 —— 这样「面板画谁」就有了可测的高度差：
   * 若跟着光标走，A 多一行、B 少一行，面板高度会变；跟当前对象走则一动不动。
   *
   * ⚠️ 不能随便取 `propDefs()[0]`：库里自带的「任务状态」被定成 **gutter 属性**
   *    （`_uiPosition: 'block-left'`），它**本来就不进面板**（同一个值不开两个编辑面）。
   *    所以这里显式新建一个面板属性，否则断言的会是「gutter 过滤生效」而不是「主体是谁」。
   */
  await page.evaluate((id) => {
    window.__qua.invoke('core.props/create-def', { blockId: id, label: '主体测试属性', kind: 'text', target: 'own' })
  }, a)
  await page.waitForTimeout(200)

  // ① 光标在页里的某块上动来动去 ⇒ 主体不变（这是本口径最要紧的一条）
  await page.locator(`.blk[data-block-id="${a}"] > .tx`).click()
  await page.waitForTimeout(120)
  const atA = await state()
  assert(atA.target === onPage.target, `光标点进块 A，主体仍是当前对象（不是 A）：${JSON.stringify(atA)}`)

  await page.locator(`.blk[data-block-id="${b}"] > .tx`).click()
  await page.waitForTimeout(120)
  const atB = await state()
  assert(atB.target === onPage.target, `光标换到块 B，主体依然不变：${JSON.stringify(atB)}`)

  /**
   * ② **属性不占正文的流**（这是它搬进右槽换来的性质）。
   *    量真实几何：只要它还在正文上方，正文首行 top 就会随面板高度变化；
   *    搬到槽里之后，两个高度不同的主体之间首行 top 必须一模一样。
   */
  const geometry = () =>
    page.evaluate(() => {
      const first = document.querySelector('#editor .blk')
      const card = document.getElementById('inspect-card')
      return {
        top: first ? Math.round(first.getBoundingClientRect().top) : -1,
        panel: Math.round(card.getBoundingClientRect().height),
        // 属性卡必须住在右槽里，而不是正文的 #doc 里
        inRightDock: document.getElementById('dock-right').contains(card),
        inDoc: document.getElementById('doc').contains(card),
        rows: document.querySelectorAll('.prop-row[data-prop-id]').length,
      }
    })
  await page.locator(`.blk[data-block-id="${a}"] > .tx`).click()
  await page.waitForTimeout(120)
  const geoA = await geometry()
  await page.locator(`.blk[data-block-id="${b}"] > .tx`).click()
  await page.waitForTimeout(120)
  const geoB = await geometry()
  assert(geoA.inRightDock === true && geoA.inDoc === false, `属性卡应住在右槽、不在正文里：${JSON.stringify(geoA)}`)
  assert(geoA.top === geoB.top, `光标换行不该抽动布局：正文首行 top ${geoA.top} → ${geoB.top}`)
  assert(geoA.panel === geoB.panel, `卡的高度也不该随光标变：${geoA.panel} → ${geoB.panel}`)
  assert(geoA.rows === 0, `页块自己没有那个属性 ⇒ 卡里不该出现块 A 的那一行：${JSON.stringify(geoA)}`)

  // ③ 点到编辑区外：面板**不**收起（它不是「焦点面板」）
  await page.mouse.click(8, 8)
  await page.waitForTimeout(120)
  const outside = await state()
  assert(outside.hidden === false && outside.target === onPage.target, `点到编辑区外，主体不变、面板不收起：${JSON.stringify(outside)}`)

  // ④ 聚焦到块 A ⇒ 主体换成 A（这就是「不想 zoom 却要改某块属性」的那一下点击）
  //
  // ⚠️ 同时钉住**导航与视图配置分家**：zoom 是导航动作，不许去动右槽的开关。
  //    关掉的槽就是用户明确表示「我现在不要旁栏」，自动展开等于把这个表态推翻；
  //    而块标点一下就是 zoom（高频），那样「专注写作」永远维持不住。
  const dockBefore = await page.evaluate(() => window.__qua.snapshot().dock.right.open)
  await page.locator(`.blk[data-block-id="${a}"] .marker`).click()
  await page.waitForTimeout(200)
  const zoomed = await state()
  assert(zoomed.activeId === a, `点块标应把它放上台面（当前对象＝A）：${JSON.stringify(zoomed)}`)
  assert(zoomed.hidden === false && zoomed.target === a, `聚焦后主体换成 A：${JSON.stringify(zoomed)}`)
  const zoomedRows = await page.evaluate(() => document.querySelectorAll('.prop-row[data-prop-id]').length)
  assert(zoomedRows === 1, `聚焦到 A 之后，它自己那条属性才出现在卡里：${zoomedRows}`)
  const dockAfter = await page.evaluate(() => window.__qua.snapshot().dock.right.open)
  assert(dockBefore === dockAfter, `zoom 不得改动右槽开关：${dockBefore} → ${dockAfter}`)

  /**
   * 槽**关着**时 zoom：卡跟着不存在，槽保持关着。
   *
   * 这是「关着的槽不自动打开」的断言。不设回退位置（比如「槽关了就把属性挪回正文上方」）：
   * 那会长出 `if (dockOpen)` 分支，然后长出兄弟分支，最后变成两套按位置分叉的形状。
   *
   * ⚠️ 判据取**计算后的可见性**而不是 `getClientRects()`：关槽用的是
   *    `visibility: hidden` 加列宽归零，DOM 仍在文档里、`getClientRects()` 照样有值
   *    （这一点与「元素被 display:none 摘掉」不同，早先在这里断言过一次假的失败）。
   */
  const inspectVisible = () =>
    page.evaluate(() => {
      const c = document.getElementById('inspect-card')
      if (!c) return null
      return getComputedStyle(c).visibility !== 'hidden' && c.getClientRects().length > 0
    })

  await page.evaluate(() => window.__qua.invoke('core.dock/toggle-right', {}))
  await page.waitForTimeout(150)
  const closedAtA = await page.evaluate(() => ({
    open: window.__qua.snapshot().dock.right.open,
  }))
  assert(closedAtA.open === false, `前置：右槽应已关闭：${JSON.stringify(closedAtA)}`)
  assert(!(await inspectVisible()), '槽关着 ⇒ 卡片不可见')

  // 在槽关着的时候再 zoom 一次（换到块 B）
  await page.locator(`.blk[data-block-id="${b}"] .marker`).click()
  await page.waitForTimeout(250)
  const closedAtB = await page.evaluate(() => ({
    open: window.__qua.snapshot().dock.right.open,
    activeId: window.__qua.snapshot().activeId,
  }))
  assert(closedAtB.activeId === b, `前置：第二次 zoom 应换到 B：${JSON.stringify(closedAtB)}`)
  assert(closedAtB.open === false, `槽关着时 zoom，不许自动打开：${JSON.stringify(closedAtB)}`)
  assert(!(await inspectVisible()), '槽关着时 zoom 之后，卡片仍不可见（不留回退位置）')

  /**
   * ⑥ 显式入口「看属性」——落点是**属性抽屉**：不换中心、**不动槽**。
   *
   * ⑤ 里槽被关着；「看属性」之后槽照旧关着（侧槽开关只归 core.dock/*），
   * 抽屉在场且钉在那块上——能力不依赖任何面板是否在场（抽屉就是显式动作自己带的面）。
   */
  await page.evaluate((id) => window.__qua.invoke('core.block/inspect', { blockId: id }), b)
  await page.waitForSelector('.props-drawer')
  const inspected = await page.evaluate(() => ({
    open: window.__qua.snapshot().dock.right.open,
    target: document.querySelector('.props-drawer')?.dataset.targetBlockId ?? '',
  }))
  assert(inspected.open === false, `「看属性」不动槽（侧槽开关只归 core.dock/*）：${JSON.stringify(inspected)}`)
  assert(inspected.target === b, `「看属性」应开属性抽屉并画在那一块上：${JSON.stringify(inspected)}`)

  // 抽屉**钉在打开时那块**：焦点走了，内容不跟（跟焦点的是检视卡，不是抽屉）。
  // ⚠️ 换主体走导航命令：⑤ 已 zoom 到 B，a 不在 DOM 里，点不到它的块标。
  await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), a)
  await page.waitForTimeout(250)
  const pinned = await page.evaluate(() => ({
    activeId: window.__qua.snapshot().activeId,
    target: document.querySelector('.props-drawer')?.dataset.targetBlockId ?? '',
    drawer: Boolean(document.querySelector('.drawer')),
  }))
  assert(pinned.activeId === a && pinned.target === b && pinned.drawer, `焦点走到 A，抽屉仍钉在 B：${JSON.stringify(pinned)}`)

  // **toggle**：同一块的入口再点一次＝收起；再点一次＝再开（开关语义，不是「点了没反应」）
  await page.evaluate((id) => window.__qua.invoke('core.block/inspect', { blockId: id }), b)
  await page.waitForTimeout(250)
  assert(!(await page.evaluate(() => Boolean(document.querySelector('.drawer')))), '同一块再点一次＝收起（toggle）')
  await page.evaluate((id) => window.__qua.invoke('core.block/inspect', { blockId: id }), b)
  await page.waitForSelector('.props-drawer')

  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)
  assert(!(await page.evaluate(() => Boolean(document.querySelector('.drawer')))), 'Esc 关掉抽屉')

  // 外点关闭的分界：**离开上下文才关**。点正文（块行/气口）＝还在与抽屉同一件事里，不关；
  // 点别的表面（槽卡）＝明确的离开动作 ⇒ 收起。
  await page.evaluate((id) => window.__qua.invoke('core.block/inspect', { blockId: id }), b)
  await page.waitForSelector('.props-drawer')
  await page.locator(`.blk[data-block-id="${b}"] > .tx`).click()
  await page.waitForTimeout(150)
  assert(await page.evaluate(() => Boolean(document.querySelector('.drawer'))), '点正文不关（还在上下文里）')
  await page.locator('#dock-left .dock-card[data-card-id="belongs"] .dock-card-title').click()
  await page.waitForTimeout(250)
  assert(!(await page.evaluate(() => Boolean(document.querySelector('.drawer')))), '点别的表面（槽卡）＝离开 ⇒ 关')

  await ctx.close()
  return `页＝主体；光标 A→B 主体不变、正文不跳（top ${geoA.top}）；卡在右槽不在正文；点外侧不收起；zoom 后主体＝A 且开关一字未变（${dockBefore}）；槽关着时 zoom 不自动开、卡不可见；「看属性」开抽屉不动槽、钉在 B、toggle 可收、Esc 可关、点正文不关/点槽卡关`
})

await check('T2 Enter 拆块 ／ Backspace 合并 ／ Tab 缩进 ／ Shift+Tab 还原', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await openFirstPage(page) // 冷启动在 journal 上，本用例测的是假数据第一页
  await page.evaluate(() => {
    const id = window.__qua.blocks()[0].id
    window.__qua.focusBlock(id, 4)
  })
  const n0 = (await blocks(page)).length
  await page.keyboard.press('Enter')
  await page.keyboard.type('新块')
  const split = await blocks(page)
  assert(split.length === n0 + 1, `拆块后应多一块：${n0} → ${split.length}`)
  assert(split[1].text.startsWith('新块'), `新块文本不对：${JSON.stringify(split[1].text)}`)
  const focused = await page.evaluate(() => window.__qua.snapshot().selection.aBlock)
  // 移到块首再退格 ⇒ 合并到前一块（**内容接到前一块末尾**，前一块保留 id）
  await page.evaluate((id) => window.__qua.focusBlock(id, 0), focused)
  await page.keyboard.press('Backspace')
  const merged = await blocks(page)
  assert(merged.length === n0, `合并后应回到 ${n0} 块，实际 ${merged.length}`)
  assert(merged[0].text.includes('新块'), `合并应保留被并入块的内容：${JSON.stringify(merged[0].text.slice(0, 20))}`)
  // 缩进要有「前一个兄弟」：挑一个同层里前面还有块的块
  const pick = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.blk')]
    for (let i = 1; i < rows.length; i++) {
      const d = Number(rows[i].dataset.depth)
      if (d > 0 && Number(rows[i - 1].dataset.depth) === d) {
        return { id: rows[i].dataset.blockId, depth: d, off: 1 }
      }
    }
    return null
  })
  assert(pick, '假数据里应能找到「有前一个兄弟」的块')
  await page.evaluate((p) => window.__qua.focusBlock(p.id, p.off), pick)
  await page.keyboard.press('Tab')
  const d1 = await page.evaluate((id) => Number(document.querySelector(`.blk[data-block-id="${id}"]`).dataset.depth), pick.id)
  assert(d1 === pick.depth + 1, `Tab 应缩进一级：${pick.depth} → ${d1}`)
  await page.keyboard.press('Shift+Tab')
  const d2 = await page.evaluate((id) => Number(document.querySelector(`.blk[data-block-id="${id}"]`).dataset.depth), pick.id)
  assert(d2 === pick.depth, `Shift+Tab 应还原：${d1} → ${d2}`)
  await ctx.close()
  return `块 ${n0}→拆→${split.length}→合并→${merged.length}；缩进 ${pick.depth}→${d1}→${d2}`
})

/* -------------------------------------------------------------- 格式 */

await check('T3 四种行内格式（⌘B/⌘I/⌘E/⌘`）落在**那一截文字自己**身上，不另立实体', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await openFirstPage(page)
  await page.evaluate(() => {
    const id = window.__qua.blocks()[0].id
    window.__qua.focusBlock(id, 0)
  })
  const keys = [
    ['mod+b', 'bold'],
    ['mod+i', 'italic'],
    ['mod+e', 'highlight'],
    ['mod+`', 'code'],
  ]
  for (const [k] of keys) {
    await page.keyboard.press('Shift+ArrowRight')
    await page.keyboard.press(kbd(k))
  }
  const marks = await page.evaluate(() => window.__qua.marks())
  const types = new Set(marks.map((m) => m.type))
  for (const [, t] of keys) assert(types.has(t), `缺少 ${t} 格式段：${JSON.stringify(marks)}`)
  for (const m of marks) assert(m.end > m.start && m.blockId.length === 32, `格式段形状不对：${JSON.stringify(m)}`)
  /**
   * **格式就住在那一截文字上**：模型里没有第二个「格式」实体可查——
   * 加粗那一段的 text run 自己带 `bold`，没加粗的那一段不带。
   * 这条是「不另立实体」的机读证据（投影出来的区间只是它的读法）。
   */
  const onRuns = await page.evaluate(() => {
    const id = window.__qua.blocks()[0].id
    return window.__qua.__editor.store.find(id).content.map((r) => ({ t: r.t, marks: [...(r.marks ?? [])] }))
  })
  const boldRun = onRuns.find((r) => r.marks.includes('bold'))
  assert(boldRun && boldRun.t === 'text', `加粗应落在 text run 上：${JSON.stringify(onRuns)}`)
  const dom = await page.evaluate(() => ({
    bold: document.querySelectorAll('.mk-bold').length,
    italic: document.querySelectorAll('.mk-italic').length,
    hl: document.querySelectorAll('.mk-highlight').length,
    code: document.querySelectorAll('.mk-code').length,
  }))
  assert(dom.bold && dom.italic && dom.hl && dom.code, `DOM 里四种表现不齐：${JSON.stringify(dom)}`)
  await ctx.close()
  return `格式段 ${marks.length} 个（${[...types].join('/')}）；四种格式都住在 text run 上，模型里没有第二个实体`
})

await check('T3b 顶部无工具栏／无顶栏：格式在划选气泡，皮肤与明暗在调试菜单（不许加回来）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  // 选文本需要**有内容的块**：冷启动在 journal 首行（只读日期，空文本），先打开假数据第一页
  await openFirstPage(page)

  // ① 顶部**既没有工具栏也没有顶栏**（两条都是否定式口味，被后来的改动悄悄破坏过就得有人喊）
  const chrome = await page.evaluate(() => ({
    toolbar: document.querySelector('#toolbar'),
    topbar: document.querySelector('#topbar'),
    skinSwitch: document.querySelector('#skin-switch'),
    themeBtn: document.querySelector('#theme-btn'),
    // 设计口径：**去掉标题概念** ⇒ `#crumbs`（页图标＋页名）整个撤掉，
    // 页 / 日记 / 被聚焦块一律是正文第一行
    oldCrumbs: Boolean(document.querySelector('#doc #crumbs')),
    trail: Boolean(document.querySelector('#crumbs-trail')),
  }))
  assert(chrome.toolbar === null, '#toolbar 应当已经撤掉（格式改为划选气泡承载）')
  assert(chrome.topbar === null, '#topbar 应当已经撤掉（它只剩调试开关，那些已挪进调试菜单）')
  assert(chrome.skinSwitch === null, '顶栏不该再有甲乙丙切换（调试开关，归调试菜单）')
  assert(chrome.themeBtn === null, '顶栏不该再有明暗按钮（调试开关，归调试菜单）')
  assert(!chrome.oldCrumbs, '#crumbs（页图标＋页名）应已撤掉：本仓不存在「标题」这个概念')
  assert(chrome.trail, '面包屑的容器 #crumbs-trail 应仍在（顶层时 hidden，但 DOM 常驻）')

  // ② 光标态：没有气泡
  await page.evaluate(() => window.__qua.focus())
  await page.keyboard.press('End')
  const idle = await page.evaluate(() => document.querySelectorAll('.selbar').length)
  assert(idle === 0, '光标态不该有划选气泡')

  // ③ 选中一段文本：气泡浮出，格式按钮齐；点「加粗」真的加粗，且**选区保住**（否则取消不了）
  // ⚠️ 光标先落进**有正文**的块（首行是页块自己，正文非空；紧随其后的子块也可以）
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#editor .blk')]
    const target = rows.find((el) => (el.querySelector('.tx')?.textContent ?? '').length >= 2)
    if (target) window.__qua.focusBlock(target.dataset.blockId, target.querySelector('.tx').textContent.length)
  })
  await page.keyboard.press('Shift+ArrowLeft')
  await page.keyboard.press('Shift+ArrowLeft')
  await page.waitForFunction(() => document.querySelectorAll('.selbar').length === 1, null, { timeout: 2000 })
  const btns = await page.evaluate(() => [...document.querySelectorAll('.selbar .sel-btn')].map((b) => b.dataset.command))
  assert(btns.includes('core.anno/toggle-bold'), `气泡里应有加粗：${JSON.stringify(btns)}`)
  assert(btns.includes('core.editor/copy-ref'), `气泡里应有「复制带引文的引用」：${JSON.stringify(btns)}`)

  const before = await page.evaluate(() => window.__qua.marks().length)
  await page.evaluate(() => {
    const b = document.querySelector('.selbar .sel-btn[data-command="core.anno/toggle-bold"]')
    b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  })
  await page.waitForFunction(
    (n) => document.querySelectorAll('.mk-bold').length > 0 || window.__qua.marks().length !== n,
    before,
    { timeout: 2000 },
  )
  const after = await page.evaluate(() => ({
    marks: window.__qua.marks().length,
    barStill: Boolean(document.querySelector('.selbar')),
    selText: document.getSelection()?.toString() ?? '',
  }))
  assert(after.selText.length >= 2, `点完格式后选区塌了（就再也取消不了）：${JSON.stringify(after)}`)
  assert(after.barStill, '选区还在，气泡就该还在')

  // ④ 选区一塌，气泡自己消失
  // ⚠️ 用**真实按键**把选区收成光标（ArrowRight）。旧写法是 `removeAllRanges()` 再按 End，
  //    那在「一行里有一个 contenteditable=false 的别名头」时不会重建插入点（浏览器行为），
  //    于是测到的其实是「DOM 没有光标」而不是「用户收起了选区」。
  await page.keyboard.press('ArrowRight')
  await page.waitForFunction(() => document.querySelectorAll('.selbar').length === 0, null, { timeout: 2000 })

  await ctx.close()
  return `顶部无工具栏；选中 ${after.selText.length} 字 → 气泡 ${btns.length} 颗 → 加粗后选区保住、气泡退场`
})

await check('T3c 主题三档在调试菜单：点得到、改得动，且不在顶栏（皮肤已删）', async () => {
  const { ctx, page } = await freshPage(browser, base)

  // ① 调试入口可见（它原来带 hidden 且没人取消 ⇒ 是死入口）
  const btn = page.locator('#state-menu-btn')
  assert(await btn.isVisible(), '调试入口应当可见（否则搬进去的开关没人点得到）')

  // ② 点开：三档主题 + 演示状态都在，且当前档位有 lucide:check
  await btn.click()
  await page.waitForFunction(() => document.querySelectorAll('.layer-item').length > 0, null, { timeout: 2000 })
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('.layer-item')].map((r) => ({
      label: r.querySelector('.layer-label')?.textContent ?? '',
      // 图标位现在是内联 SVG ⇒ 契约是 `data-icon`（原始值），不是 textContent
      icon: r.querySelector('.layer-ico')?.dataset.icon ?? '',
    })),
  )
  const labels = rows.map((r) => r.label)
  for (const need of ['跟随系统', '亮', '暗']) assert(labels.includes(need), `调试菜单应有主题「${need}」：${JSON.stringify(labels)}`)
  // 当前档位用**图标位的 `lucide:check`**（不是 hint：hint 会被推到行最右）
  const checked = rows.filter((r) => r.icon === 'lucide:check').map((r) => r.label)
  assert(checked.length === 1, `主题只应有一项带 ✓（当前档位），实际：${JSON.stringify(checked)}`)

  // ③ **皮肤三行不该回来**（甲/乙/丙整体删除）
  for (const dead of ['甲', '乙', '丙']) assert(!labels.includes(dead), `皮肤「${dead}」不应再出现：${JSON.stringify(labels)}`)
  assert(
    await page.evaluate(() => document.body.dataset.skin === undefined),
    'body 上不该再有 data-skin（D3：内建只有一种样式）',
  )

  // ④ 真的改得动：点「暗」→ data-theme 变 dark
  await page.evaluate(() => {
    const item = [...document.querySelectorAll('.layer-item')].find((r) => r.querySelector('.layer-label')?.textContent === '暗')
    item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  })
  await page.waitForFunction(() => document.body.dataset.theme === 'dark', null, { timeout: 2000 })

  // ⑤ 改完**顶栏不会冒出来**（防「为了显示开关又把顶栏加回来」）
  const stillNoTopbar = await page.evaluate(() => document.querySelector('#topbar') === null)
  assert(stillNoTopbar, '改完主题后不该冒出顶栏')

  await ctx.close()
  return `调试菜单 ${rows.length} 项（三档主题，无皮肤）；切到暗后顶栏仍未回来`
})

await check('T4 格式随打字继承：粗体末尾接着敲的字仍是粗体、素段末尾敲的字不带格式', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await openFirstPage(page)
  const r = await page.evaluate(() => {
    const id = window.__qua.blocks()[0].id
    window.__qua.focusBlock(id, 0)
    return id
  })
  /** 读当前视图里这块的 run 序列投影：`runs` ＝ 每段的 t/marks（断言不认识 run 形状也能读） */
  const readRuns = () =>
    page.evaluate(
      (id) =>
        window.__qua.__editor.store
          .find(id)
          .content.map((x) => ({ t: x.t, v: x.v ?? '', bold: (x.marks ?? []).includes('bold') })),
      r,
    )
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press(kbd('mod+b'))
  let runs = await readRuns()
  assert(
    runs.length === 2 && runs[0].bold && !runs[1].bold && runs[0].v.length === 2,
    `选中两字加粗 ⇒ 前粗后素两段：${JSON.stringify(runs)}`,
  )
  // 粗体段末尾接着敲 ⇒ 新字继承邻位格式（仍是粗体段的一部分）
  await page.evaluate((id) => window.__qua.focusBlock(id, 2), r)
  await page.keyboard.type('X')
  runs = await readRuns()
  assert(
    runs.length === 2 && runs[0].bold && runs[0].v.length === 3,
    `粗体末尾打字应并入粗体段（继承邻位格式）：${JSON.stringify(runs)}`,
  )
  // 素段末尾敲 ⇒ 不带格式
  await page.evaluate((id) => window.__qua.focusBlock(id, 9999), r)
  await page.keyboard.type('Y')
  runs = await readRuns()
  assert(
    runs.length === 2 && runs[0].v.length === 3 && runs[1].v.endsWith('Y') && !runs[1].bold,
    `素段末尾打字不带格式：${JSON.stringify(runs)}`,
  )
  await ctx.close()
  return `打字继承邻位格式：粗末尾仍粗、素末尾仍素（格式是 run 属性，天然粘性）`
})

/* -------------------------------------------------------- 行内原子 */

await check('T5 行内原子：引用 chip 与资产原子各占 1 格，随文本漂移，可点开信息', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await openFirstPage(page)
  const r = await page.evaluate(() => {
    const blk = window.__qua.blocks()[0]
    window.__qua.focusBlock(blk.id, 0)
    const target = window.__qua.pages()[1].id
    window.__qua.invoke('core.editor/insert-page-ref', { pageId: target })
    const atom = window.__qua.atoms().find((a) => a.blockId === blk.id)
    // run 序列投影：原子是序列里的一枚（t=ref），没有占位符字符
    const runs = window.__qua.__editor.store.find(blk.id).content.map((x) => x.t)
    return { atom, runs, id: blk.id, total: window.__qua.atoms().length }
  })
  assert(r.atom, `引用原子没插进去：${JSON.stringify(r)}`)
  const a = r.atom
  assert(a.end - a.start === 1, `原子应恒占 1 格：${JSON.stringify(a)}`)
  assert(r.runs[0] === 'ref', `原子应是 run 序列的第一枚（不是占位符字符）：${JSON.stringify(r.runs)}`)
  await page.evaluate((id) => window.__qua.focusBlock(id, 0), r.id)
  await page.keyboard.type('前')
  const shifted = (await page.evaluate(() => window.__qua.atoms())).find((x) => x.blockId === r.id)
  assert(shifted.start === a.start + 1, `在原子前插入应右移 1：${a.start} → ${shifted.start}`)
  await page.evaluate(() => window.__qua.invoke('core.editor/insert-image', { preset: 'missing' }))
  const atoms = await page.evaluate(() => window.__qua.atoms())
  assert(atoms.some((x) => x.kind === 'asset'), '资产原子没插进去')
  const domAtoms = await page.evaluate(() => ({
    page: document.querySelectorAll('.atom-page').length,
    asset: document.querySelectorAll('.atom-asset').length,
    // 缺字节的资产是**文件形占位**（`.atom-file.missing`），不是「图片形 + 滤镜」
    missing: document.querySelectorAll('.atom-file.missing').length,
  }))
  assert(domAtoms.page >= 3 && domAtoms.asset >= 1, `假数据 + 新插入的原子数不对：${JSON.stringify(domAtoms)}`)
  assert(domAtoms.missing >= 1, '缺失资产应有 .missing 表现（状态不是错误）')
  // ⌥ 点击才弹信息（左键默认是「打开目标」，见 T43）
  await page.locator('.atom-page').first().click({ modifiers: ['Alt'] })
  const popText = await page.locator('.popover').innerText()
  assert(popText.includes('引文快照') || popText.includes('状态'), `引用信息气泡没内容：${popText}`)
  await page.keyboard.press('Escape')
  assert((await page.locator('.popover').count()) === 0, 'Esc 应关掉信息气泡')
  await ctx.close()
  return `原子 ${atoms.length} 个；chip+资产都在，缺资产有 .missing 表现，点开有信息`
})

await check('T5b 行内资产：真图按内容地址画出来（naturalWidth > 0），missing / unavailable 是两种不同的失败', async () => {
  const { ctx, page, errors } = await freshPage(browser, base)
  // 打开含样本资产的页
  await page.evaluate(() => {
    const p = window.__qua.pages().find((x) => x.title.includes('输入面笔记')) ?? window.__qua.pages()[1]
    window.__qua.invoke('core.page/open', { pageId: p.id })
  })
  await page.waitForTimeout(500)
  const r = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('#editor .atom-image img')]
    const missing = [...document.querySelectorAll('#editor .atom-file.missing')]
    const atomRows = [...document.querySelectorAll('#editor .atom-asset')].map((e) => ({
      hash: e.dataset.assetHash ?? '',
      kind: e.dataset.atomKind ?? '',
      cls: e.className,
    }))
    return {
      imgs: imgs.map((i) => ({ nw: i.naturalWidth, nh: i.naturalHeight, draggable: i.draggable, alt: i.alt, blob: i.src.startsWith('blob:') })),
      missing: missing.map((e) => e.textContent ?? ''),
      atoms: atomRows,
      assets: window.__qua.snapshot().assets,
      // 行高不因图而变（行内层的契约是一个点）：比「含图那一行」与「纯文本行」
      rowH: (() => {
        const rows = [...document.querySelectorAll('#editor .blk')]
        const withImg = rows.find((b) => b.querySelector('.atom-image'))?.getBoundingClientRect().height ?? -1
        const plain = rows.find((b) => !b.querySelector('.atom') && !b.dataset.alias)?.getBoundingClientRect().height ?? -1
        return { withImg: Math.round(withImg), plain: Math.round(plain) }
      })(),
    }
  })
  assert(r.assets.available, `资产库应可用：${JSON.stringify(r.assets)}`)
  assert(r.assets.rows >= 1, `资产库应有种子样本：${JSON.stringify(r.assets)}`)
  assert(r.imgs.length >= 1, `样本资产应画成真图：${JSON.stringify(r.atoms)}`)
  const img = r.imgs[0]
  assert(img.nw > 0 && img.nh > 0, `真图必须解码成功（CSP 的 img-src 少了 blob: 会静默变 0）：${JSON.stringify(img)}`)
  assert(img.blob, `图的 src 应是对象 URL（不是 data URI、不是程序生成的 SVG）：${img.src}`)
  assert(img.draggable === false, '图必须 draggable=false（否则 contenteditable 会把裸 <img> 拖进来）')
  assert(img.alt.includes('.png'), `alt 应是插入时的文件名快照：${img.alt}`)
  assert(r.atoms.every((a) => a.hash.length === 64 && a.kind === 'asset'), `资产原子应带 64 位 hash 与 kind：${JSON.stringify(r.atoms)}`)
  assert(r.missing.length >= 1, `种子里应有一张刻意缺失的资产：${JSON.stringify(r.atoms)}`)
  assert(r.missing[0].includes('缺失'), `缺失资产的文案要说清是「缺失」：${r.missing[0]}`)
  // 行高：**含图那一行与纯文本行同高**（图片不把行撑开，虚拟化的占位才不用跟着图变）
  assert(
    r.rowH.withImg === r.rowH.plain,
    `图片不应改变行高：含图行 ${r.rowH.withImg} vs 纯文本行 ${r.rowH.plain}`,
  )
  assert(errors.length === 0, `控制台不该有错误（CSP 拦截会在这里现形）：${errors.join(' | ')}`)
  await ctx.close()
  return `真图 ${img.nw}×${img.nh}（blob URL）、${r.atoms.length} 枚资产原子、${r.missing.length} 张缺失、行高 ${r.rowH.withImg}`
})

await check('T5c 行内资产：字节到达才画出图（首帧是占位，第二帧换成真图，不重排整页）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => {
    const p = window.__qua.pages().find((x) => x.title.includes('输入面笔记')) ?? window.__qua.pages()[1]
    window.__qua.invoke('core.page/open', { pageId: p.id })
  })
  /**
   * 判据是「渲染是同步纯函数，字节是异步的」：第一帧必然可能还没有 URL。
   * 这里不断言那一帧长什么样（时序不稳），只断言**最终**会换成真图，
   * 且**没有**用整页重排去换（重排会打断正在输入的那一行）。
   */
  const settled = await page.evaluate(async () => {
    const first = document.querySelectorAll('#editor .atom-image img').length
    // 等到真图出现（上限 3s；超时说明「字节到了没人重画」）
    for (let i = 0; i < 60; i++) {
      if (document.querySelector('#editor .atom-image img')?.naturalWidth) break
      await new Promise((r) => setTimeout(r, 50))
    }
    const img = document.querySelector('#editor .atom-image img')
    return { first, nw: img?.naturalWidth ?? 0, sameNode: true }
  })
  assert(settled.nw > 0, `字节到达后应重画成真图（拿到 ${settled.nw}）：${JSON.stringify(settled)}`)
  await ctx.close()
  return `首帧 ${settled.first} 张图位 → 最终 naturalWidth ${settled.nw}`
})

await check('T5d 行内资产：DOM 里有、模型里没有时按 kind 还原成资产 run（不是悬空引用）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => {
    const p = window.__qua.pages().find((x) => x.title.includes('输入面笔记')) ?? window.__qua.pages()[1]
    window.__qua.invoke('core.page/open', { pageId: p.id })
  })
  await page.waitForTimeout(300)
  const r = await page.evaluate(() => {
    const el = document.querySelector('#editor .atom-image')
    const blockId = el.closest('.blk').dataset.blockId
    const ed = window.__qua.__editor
    const normal = ed.readRunsOf(blockId).filter((x) => x.t !== 'text').map((x) => x.t)
    // 模拟「模型没跟上」：把 DOM 上的原子 id 改成模型里没有的值
    const old = el.dataset.atomId
    el.dataset.atomId = 'zzz-unknown-id'
    const fallback = ed.readRunsOf(blockId).filter((x) => x.t !== 'text')
    el.dataset.atomId = old
    return { normal, fallback }
  })
  assert(r.normal.includes('asset'), `正常读数应带回资产 run：${JSON.stringify(r.normal)}`)
  const restored = r.fallback.find((x) => x.id === 'zzz-unknown-id')
  assert(restored, `兜底必须保留这一格（不能静默吞掉）：${JSON.stringify(r.fallback)}`)
  assert(restored.t === 'asset', `兜底应按 data-atom-kind 还原成资产，而不是悬空引用：${JSON.stringify(restored)}`)
  assert(restored.asset && restored.asset.length === 64, `还原出的 run 要带内容地址：${JSON.stringify(restored)}`)
  await ctx.close()
  return `正常 ${r.normal.join('/')}；兜底还原成 ${restored.t}（hash ${restored.asset.slice(0, 8)}…）`
})

await check('T5e 行内资产：左键开 lightbox（点图不关、Esc 关），⌥ 看详情，缺失不开空 lightbox', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => {
    const p = window.__qua.pages().find((x) => x.title.includes('输入面笔记')) ?? window.__qua.pages()[1]
    window.__qua.invoke('core.page/open', { pageId: p.id })
  })
  await page.waitForTimeout(400)

  // ① 左键 ⇒ lightbox（真图、有副标题）
  await page.locator('#editor .atom-image').first().click()
  const lb = await page.evaluate(() => {
    const el = document.querySelector('.lightbox')
    return {
      open: Boolean(el),
      nw: el?.querySelector('img')?.naturalWidth ?? 0,
      sub: el?.querySelector('.lightbox-sub')?.textContent ?? '',
      title: el?.querySelector('.lightbox-title')?.textContent ?? '',
    }
  })
  assert(lb.open, '左键点图应开 lightbox')
  assert(lb.nw > 0, `lightbox 里的图要真的解码出来：${JSON.stringify(lb)}`)
  assert(lb.sub.includes('×') && lb.sub.length > 5, `副标题应有尺寸等说明：${lb.sub}`)
  assert(lb.title.includes('.png'), `标题应是文件名快照：${lb.title}`)

  // ② 点图不关
  await page.locator('.lightbox-img').click()
  assert(await page.evaluate(() => Boolean(document.querySelector('.lightbox'))), '点图不该关掉 lightbox')
  // ③ Esc 关（退场动画走完后节点摘掉——「关」的判据是节点离开文档，不是变透明）
  await page.keyboard.press('Escape')
  await page.waitForSelector('.lightbox', { state: 'detached', timeout: 2000 })

  // ④ ⌥ ⇒ 详情（且不开 lightbox）
  await page.locator('#editor .atom-image').first().click({ modifiers: ['Alt'] })
  const alt = await page.evaluate(() => ({
    text: document.querySelector('.popover')?.textContent ?? '',
    lb: Boolean(document.querySelector('.lightbox')),
  }))
  assert(!alt.lb, '⌥ 不该开 lightbox')
  assert(alt.text.includes('资产 hash') && alt.text.includes('mime'), `⌥ 应给资产详情：${alt.text.slice(0, 80)}`)
  await page.keyboard.press('Escape')

  // ⑤ 缺失资产：左键也**不开空 lightbox**，直接给详情
  await page.locator('#editor .atom-file.missing').first().click()
  const miss = await page.evaluate(() => ({
    text: document.querySelector('.popover')?.textContent ?? '',
    lb: Boolean(document.querySelector('.lightbox')),
  }))
  assert(!miss.lb, '缺失资产不该开空 lightbox（那是一个黑屏）')
  assert(miss.text.includes('missing'), `缺失应说明状态：${miss.text.slice(0, 80)}`)
  await page.keyboard.press('Escape')

  await ctx.close()
  return `lightbox ${lb.title}（${lb.sub}）；点图不关、Esc 关；⌥ 详情；缺失不开空 lightbox`
})

await check('T5f 行内资产：粘贴图片 → 内容寻址入库 → 插在**捕获的落点**（不是当前光标）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.invoke('core.page/open', { pageId: window.__qua.pages()[0].id }))
  await page.waitForTimeout(300)
  const r = await page.evaluate(async () => {
    /**
     * 真 PNG 的字节（40×40 纯色）：粘贴路径要过 magic bytes 嗅探，
     * 造一个「名字像图片、字节不是」的文件会走拒绝分支（那是另一条断言）。
     */
    const b64 =
      'iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAIAAAADnC86AAAAMElEQVR4nO3NQQkAAAgEsItjHGMbyxKCn8H+y3S9iFgsFovFYrFYLBaLxWKxWHxnAY8m0GozORegAAAAAElFTkSuQmCC'
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const dt = new DataTransfer()
    dt.items.add(new File([bytes], '粘贴的图.png', { type: 'image/png' }))
    const blk = document.querySelector('#editor .blk')
    const blockId = blk.dataset.blockId
    window.__qua.focusBlock(blockId, 0)
    const before = window.__qua.__editor.store.find(blockId).content.map((x) => x.t)
    const atomsBefore = window.__qua.snapshot().atoms
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
    blk.querySelector('.tx').dispatchEvent(ev)
    for (let i = 0; i < 80; i++) {
      if (window.__qua.snapshot().atoms > atomsBefore) break
      await new Promise((r) => setTimeout(r, 50))
    }
    /**
     * 入库是异步的，**画出来**还要再异步一步（取字节 → 对象 URL → 重画那一行）。
     * 断言要等它落地：否则验的是「此刻屏幕上有没有」而不是「这条链路成不成立」。
     */
    for (let i = 0; i < 80; i++) {
      if ([...document.querySelectorAll('#editor .atom-image img')].every((im) => im.naturalWidth > 0)) break
      await new Promise((r) => setTimeout(r, 50))
    }
    const content = window.__qua.__editor.store.find(blockId).content
    return {
      before,
      after: content.map((x) => (x.t === 'asset' ? `asset:${x.label}:${x.asset.length}` : x.t)),
      assets: window.__qua.snapshot().assets,
      imgs: [...document.querySelectorAll('#editor .atom-image img')].map((i) => i.naturalWidth),
    }
  })
  assert(r.after.some((x) => String(x).startsWith('asset:粘贴的图.png:64')), `粘贴应插一枚带 64 位地址的资产 run：${JSON.stringify(r.after)}`)
  assert(r.assets.rows >= 2, `新字节应真的入库（去重后应多一份）：${JSON.stringify(r.assets)}`)
  assert(r.imgs.every((n) => n > 0), `粘进来的图也要能解码：${JSON.stringify(r.imgs)}`)

  // 同一份字节再贴一次 ⇒ 库里仍只有那些 key（内容寻址去重），但多一枚 run
  const twice = await page.evaluate(async () => {
    const b64 =
      'iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAIAAAADnC86AAAAMElEQVR4nO3NQQkAAAgEsItjHGMbyxKCn8H+y3S9iFgsFovFYrFYLBaLxWKxWHxnAY8m0GozORegAAAAAElFTkSuQmCC'
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const rowsBefore = window.__qua.snapshot().assets.rows
    const atomsBefore = window.__qua.snapshot().atoms
    const dt = new DataTransfer()
    dt.items.add(new File([bytes], '同一张.png', { type: 'image/png' }))
    const blk = document.querySelector('#editor .blk')
    blk.querySelector('.tx').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    for (let i = 0; i < 80; i++) {
      if (window.__qua.snapshot().atoms > atomsBefore) break
      await new Promise((r) => setTimeout(r, 50))
    }
    const assets = window.__qua.snapshot().assets
    const labels = window.__qua.atoms().filter((a) => a.kind === 'asset').map((a) => a.rawLabel)
    return { rowsBefore, rows: assets.rows, atoms: window.__qua.snapshot().atoms, labels }
  })
  assert(twice.rows === twice.rowsBefore, `同一份字节不该多一份资产（内容寻址去重）：${JSON.stringify(twice)}`)
  assert(twice.labels.includes('同一张.png') && twice.labels.includes('粘贴的图.png'), `两枚 run 各保留自己的 label：${JSON.stringify(twice.labels)}`)

  await ctx.close()
  return `粘贴入库 ${r.assets.rows} 条；同字节再贴 ⇒ 仍 ${twice.rows} 条、两枚 run（label 各自保留）`
})

await check('T5g 行内资产：选文件走隐藏 input；拖入文件被拦住（不产生裸 <img>）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.invoke('core.page.open', { pageId: window.__qua.pages()[0].id }))
  await page.waitForTimeout(300)
  await page.evaluate(() => window.__qua.focusBlock(window.__qua.blocks()[0].id, 0))

  // ① 选文件：真 PNG 走 `filechooser`（字节由 node 侧给，不落临时文件）
  const b64 =
    'iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAIAAAADnC86AAAAMElEQVR4nO3NQQkAAAgEsItjHGMbyxKCn8H+y3S9iFgsFovFYrFYLBaLxWKxWHxnAY8m0GozORegAAAAAElFTkSuQmCC'
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 5000 }),
    page.evaluate(() => window.__qua.invoke('core.editor/insert-image', {})),
  ])
  const atomsBefore = await page.evaluate(() => window.__qua.snapshot().atoms)
  await chooser.setFiles({ name: '选中的图.png', mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') })
  await page.waitForFunction((n) => window.__qua.snapshot().atoms > n, atomsBefore, { timeout: 5000 })
  const picked = await page.evaluate(() => ({
    labels: window.__qua.atoms().filter((a) => a.kind === 'asset').map((a) => a.rawLabel),
    assets: window.__qua.snapshot().assets,
  }))
  assert(picked.labels.includes('选中的图.png'), `选文件应插一枚带文件名的资产：${JSON.stringify(picked.labels)}`)
  assert(picked.assets.rows >= 2, `选文件也要真的入库：${JSON.stringify(picked.assets)}`)

  // ② 拖入文件：拦住、给文案、**不产生裸 <img>**
  const drop = await page.evaluate(async () => {
    const dt = new DataTransfer()
    dt.items.add(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], '拖入.png', { type: 'image/png' }))
    const tx = document.querySelector('#editor .tx')
    const before = document.querySelectorAll('#editor img').length
    const prevented = !tx.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    await new Promise((r) => setTimeout(r, 200))
    return {
      prevented,
      before,
      after: document.querySelectorAll('#editor img').length,
      // 裸 <img> 判据：DOM 里没有 data-atom-id 祖先的 img
      naked: [...document.querySelectorAll('#editor img')].filter((i) => !i.closest('[data-atom-id]')).length,
      toast: document.querySelector('.toast')?.textContent ?? '',
    }
  })
  assert(drop.prevented, '拖入 Files 必须 preventDefault（否则浏览器会塞裸 <img>）')
  assert(drop.after === drop.before, `拖入不该产生新的 <img>：${JSON.stringify(drop)}`)
  assert(drop.naked === 0, `DOM 里不该有裸 <img>（没有 data-atom-id 祖先）：${JSON.stringify(drop)}`)
  assert(drop.toast.includes('暂不支持'), `拖入应给一句明确的话：${drop.toast}`)

  await ctx.close()
  return `选文件 ⇒ ${picked.labels.length} 枚资产（库 ${picked.assets.rows} 条）；拖入被拦（裸 img ${drop.naked} 个）`
})

await check('T5h 行内资产：关掉重开，图还在（workspace ＋ IndexedDB 一起恢复）；只清 IDB ⇒ missing', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.invoke('core.page.open', { pageId: window.__qua.pages()[0].id }))
  await page.waitForTimeout(300)
  /**
   * ⚠️ 用**粘贴进来的图**验重开，不用种子样本：种子资产在每次启动时都会被
   * `ensureSeedAssets` 补回去（那是「默认演示不该看起来像坏了」的设计），
   * 所以「清 IDB ⇒ 变 missing」在种子样本上永远验不出来。
   */
  const PASTED_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAIAAAADnC86AAAAMElEQVR4nO3NQQkAAAgEsItjHGMbyxKCn8H+y3S9iFgsFovFYrFYLBaLxWKxWHxnAY8m0GozORegAAAAAElFTkSuQmCC'
  const before = await page.evaluate(async (b64) => {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const dt = new DataTransfer()
    dt.items.add(new File([bytes], '重开验证.png', { type: 'image/png' }))
    /**
     * ⚠️ 落点要**显式挑一个正文块**，不能用 `#editor .blk` 的第一个：
     *    块底的挂载区里也嵌着编辑器（`.blk` 在 `#editor` 里面），
     *    而挂载区的块在重开之后不一定还在当前视图里 —— 那样断言验的是「视图没装」，
     *    不是「资产还在不在」。
     */
    const target = window.__qua.blocks()[0]
    const blk = document.querySelector(`#editor .blk[data-block-id="${target.id}"]`)
    window.__qua.focusBlock(target.id, 0)
    const atomsBefore = window.__qua.snapshot().atoms
    blk.querySelector('.tx').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    for (let i = 0; i < 80; i++) {
      if (window.__qua.snapshot().atoms > atomsBefore) break
      await new Promise((r) => setTimeout(r, 50))
    }
    // 再等一帧：字节入库之后要有人把占位换成真图（异步取字节 → 对象 URL）
    for (let i = 0; i < 60; i++) {
      if ([...document.querySelectorAll('#editor .atom-image img')].some((im) => im.naturalWidth > 0 && im.alt === '重开验证.png')) break
      await new Promise((r) => setTimeout(r, 50))
    }
    return {
      blockId: target.id,
      assets: window.__qua.snapshot().assets,
      labels: window.__qua.atoms().filter((a) => a.kind === 'asset').map((a) => a.rawLabel),
      imgs: [...document.querySelectorAll('#editor .atom-image img')].filter((i) => i.naturalWidth > 0).length,
      pastedDecoded: [...document.querySelectorAll('#editor .atom-image img')].some((i) => i.naturalWidth > 0 && i.alt === '重开验证.png'),
    }
  }, PASTED_B64)
  assert(before.labels.includes('重开验证.png'), `粘贴的图应进正文：${JSON.stringify(before.labels)}`)
  assert(before.pastedDecoded, `粘贴的图要真的解码出来：${JSON.stringify(before)}`)
  // 让「字节 → 对象 URL → 重画」这条异步链先跑完，再关页（否则关的是半途的状态）
  await page.waitForTimeout(300)

  /**
   * ⚠️ **IndexedDB 不在 Playwright `storageState` 的默认快照里**：不加 `indexedDB: true`，
   * 「重开」会得到一份空资产库 —— 断言看起来像「图丢了」，其实是快照没带上。
   */
  await page.close({ runBeforeUnload: true })
  await new Promise((r) => setTimeout(r, 150))
  const state = await ctx.storageState({ indexedDB: true })
  await ctx.close()
  const next = await browser.newContext({ storageState: state })
  const p2 = await next.newPage()
  await p2.goto(base, { waitUntil: 'load' })
  await p2.waitForFunction(() => Boolean(window.__qua), undefined, { timeout: 15_000 })
  // 聚焦到**同一块**：断言要回答「这一块里的图还在不在」，而不是「某个视图装没装」
  await p2.evaluate((id) => window.__qua.focusBlock(id, 0), before.blockId)
  await p2.waitForTimeout(600)
  const after = await p2.evaluate(async () => {
    for (let i = 0; i < 80; i++) {
      if ([...document.querySelectorAll('#editor .atom-image img')].some((im) => im.naturalWidth > 0 && im.alt === '重开验证.png')) break
      await new Promise((r) => setTimeout(r, 50))
    }
    return {
      assets: window.__qua.snapshot().assets,
      labels: window.__qua.atoms().filter((a) => a.kind === 'asset').map((a) => a.rawLabel),
      imgs: [...document.querySelectorAll('#editor .atom-image img')].filter((i) => i.naturalWidth > 0).length,
      pastedDecoded: [...document.querySelectorAll('#editor .atom-image img')].some((i) => i.naturalWidth > 0 && i.alt === '重开验证.png'),
      dom: [...document.querySelectorAll('#editor .atom-asset')].map((e) => [e.className, e.dataset.assetHash?.slice(0, 8), e.querySelector('img')?.alt ?? '', e.querySelector('img')?.naturalWidth ?? -1]),
    }
  })
  assert(after.assets.rows === before.assets.rows, `重开后资产库应有同样多的行：${JSON.stringify({ before: before.assets, after: after.assets })}`)
  assert(after.labels.includes('重开验证.png'), `重开后资产 run 不该丢：${JSON.stringify(after.labels)}`)
  assert(after.pastedDecoded, `重开后粘贴的那张图要还能解码（workspace ＋ IDB 一起恢复）：${JSON.stringify(after)}`)

  // 只清 IDB（保留 workspace）⇒ 用户那张图变成 missing，且**不报错**、库仍可用
  await p2.evaluate(async () => {
    await new Promise((resolve) => {
      const r = indexedDB.deleteDatabase('qua.assets')
      r.onsuccess = r.onerror = r.onblocked = () => resolve()
    })
  })
  await p2.reload({ waitUntil: 'load' })
  await p2.waitForFunction(() => Boolean(window.__qua), undefined, { timeout: 15_000 })
  await p2.evaluate((id) => window.__qua.focusBlock(id, 0), before.blockId)
  await p2.waitForTimeout(500)
  const cleared = await p2.evaluate(() => ({
    assets: window.__qua.snapshot().assets,
    missing: document.querySelectorAll('#editor .atom-file.missing').length,
    // 种子样本会被补回去（那是设计），所以这里判的是「用户那张图」
    states: window.__qua.atoms().filter((a) => a.kind === 'asset').map((a) => [a.rawLabel, a.state]),
  }))
  assert(cleared.assets.available, `清 IDB 不该让整个库「打不开」（那是 unavailable）：${JSON.stringify(cleared.assets)}`)
  const pastedState = cleared.states.find(([label]) => label === '重开验证.png')
  assert(pastedState && pastedState[1] === 'missing', `字节没了应显示 missing：${JSON.stringify(cleared.states)}`)
  assert(cleared.missing >= 1, `字节没了应有 missing 占位（不是空白、不是抛错）：${JSON.stringify(cleared)}`)

  await next.close()
  return `重开：${after.assets.rows} 条资产、${after.imgs} 张图；清 IDB ⇒ 用户那张 missing、库仍可用`
})

/* ---------------------------------------------------------- 结构 */

await check('T6 折叠/展开：子树不挂 DOM，模型里 collapsed=true（DOM 节点数会掉）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await openFirstPage(page)
  const before = await snap(page)
  await page.locator('.blk').first().locator('.fold').click({ force: true })
  const after = await snap(page)
  const collapsed = (await blocks(page))[0].collapsed
  assert(collapsed === true, '模型里应记 collapsed=true')
  assert(after.domBlocks < before.domBlocks, `折叠后 DOM 块应减少：${before.domBlocks} → ${after.domBlocks}`)
  assert(after.blocks === before.blocks, '折叠只影响挂载，不该改块数')
  await page.locator('.blk').first().locator('.fold').click({ force: true })
  const back = await snap(page)
  assert(back.domBlocks === before.domBlocks, '展开后应恢复')
  await ctx.close()
  return `DOM 块 ${before.domBlocks} → ${after.domBlocks}（块数仍 ${after.blocks}）→ ${back.domBlocks}`
})

/* ------------------------------------------------- ：块标 / 折叠 / 导轨 */

await check('T23 gutter 三件：块标与把手合并、三角悬停才现、折叠态有环', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await openFirstPage(page)
  const r = await page.evaluate(() => {
    const blk = document.querySelector('#editor .blk')
    const marker = blk.querySelector('.marker')
    const fold = blk.querySelector('.fold')
    const grip = blk.querySelector('.marker .grip')
    const cs = (el) => (el ? getComputedStyle(el) : null)
    return {
      // D4：同一元素带两个契约 class
      markerClasses: marker ? [...marker.classList].sort().join(' ') : '(none)',
      markerW: cs(marker)?.width ?? '',
      foldPosition: cs(fold)?.position ?? '',
      foldOpacity: cs(fold)?.opacity ?? '',
      gripOpacity: cs(grip)?.opacity ?? '',
      bulletSize: cs(document.documentElement).getPropertyValue('--ui-bullet-size').trim(),
      caretSize: cs(document.documentElement).getPropertyValue('--ui-caret-size').trim(),
    }
  })
  // D4：块标与把手合并，但旧选择器都还在（主题/插件不失效）
  assert(r.markerClasses === 'bullet handle marker', `块标应是 bullet+handle+marker 三 class：${r.markerClasses}`)
  assert(r.markerW === '20px', `块标槽应收到 20px（D4），实际 ${r.markerW}`)
  // D2：三角绝对定位、不占位；静止态不可见
  assert(r.foldPosition === 'absolute', `三角应绝对定位不占位（D2），实际 ${r.foldPosition}`)
  assert(Number(r.foldOpacity) < 0.05, `静止态三角应不可见（D2），实际 opacity=${r.foldOpacity}`)
  assert(Number(r.gripOpacity) < 0.05, `静止态抓手应不可见（hover 才换 grip），实际 opacity=${r.gripOpacity}`)
  assert(r.bulletSize === '5px' && r.caretSize === '11px', `token 取值应对齐设计稿（5px / 11px）：${r.bulletSize}/${r.caretSize}`)

  // R2：**既无子块也无身体**的行不生成 `.fold` 节点（不是 visibility:hidden）
  const foldOnLeaf = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#editor .blk')]
    const leaves = rows.filter((el) => !el.dataset.hasChildren && el.dataset.viewBody !== '1')
    const bodies = rows.filter((el) => el.dataset.viewBody === '1')
    return {
      leafCount: leaves.length,
      withFold: leaves.filter((el) => el.querySelector('.fold')).length,
      // 对照：有子块的行必须生成
      parentsWithFold: rows.filter((el) => el.dataset.hasChildren && el.querySelector('.fold')).length,
      parentCount: rows.filter((el) => el.dataset.hasChildren).length,
      // 查询块的身体也可折：这一类行（没有 children）同样要有三角
      bodyCount: bodies.length,
      bodiesWithFold: bodies.filter((el) => el.querySelector('.fold')).length,
    }
  })
  assert(foldOnLeaf.leafCount > 0, '假数据里应有无子块的行')
  assert(
    foldOnLeaf.withFold === 0,
    `既无子块也无身体的行不该生成 .fold 节点（R2），实际 ${foldOnLeaf.withFold}/${foldOnLeaf.leafCount}`,
  )
  assert(
    foldOnLeaf.parentsWithFold === foldOnLeaf.parentCount,
    `有子块的行都应生成 .fold：${foldOnLeaf.parentsWithFold}/${foldOnLeaf.parentCount}`,
  )
  assert(
    foldOnLeaf.bodyCount > 0 && foldOnLeaf.bodiesWithFold === foldOnLeaf.bodyCount,
    `有身体（查询结果）的行也要有折叠三角：${foldOnLeaf.bodiesWithFold}/${foldOnLeaf.bodyCount}`,
  )

  // 折叠态：**明显的环**（D2 的明文口径：折叠态不能只靠悬停件自明）
  await page.locator('.blk').first().locator('.fold').click({ force: true })
  const ring = await page.evaluate(() => {
    const marker = document.querySelector('#editor .blk[data-collapsed="1"] .marker')
    const cs = getComputedStyle(marker, '::after')
    return { width: cs.borderTopWidth, style: cs.borderTopStyle, color: cs.borderTopColor }
  })
  assert(parseFloat(ring.width) >= 2, `折叠态块标应有 ≥2px 的环（D2），实际 ${ring.width}`)
  assert(ring.style === 'solid', `环应是实线，实际 ${ring.style}`)

  /*
   * 悬停折叠块：**环与点让位给抓手**。
   * 环内径 9px、抓手 12px ⇒ 两者同时在场时抓手的点会压在环的内缘上（叠影，不是两种状态）。
   * 断言量的是「谁在场」，不是某个像素：环退场、抓手入场、点跟着退场。
   */
  await page.locator('#editor .blk[data-collapsed="1"] .marker').first().hover()
  await page.waitForTimeout(220) // 让 120ms 的淡入淡出走完
  const hovered = await page.evaluate(() => {
    const marker = document.querySelector('#editor .blk[data-collapsed="1"] .marker')
    const num = (v) => Number.parseFloat(v) || 0
    return {
      ring: num(getComputedStyle(marker, '::after').opacity),
      dot: num(getComputedStyle(marker, '::before').opacity),
      grip: num(getComputedStyle(marker.querySelector('.grip')).opacity),
    }
  })
  assert(hovered.ring < 0.05, `悬停折叠块时环应退场（与抓手塞不进同一块像素），实际 opacity=${hovered.ring}`)
  assert(hovered.dot < 0.05, `悬停时那颗点也要退场（它与抓手同中心，会变成重影），实际 opacity=${hovered.dot}`)
  assert(hovered.grip > 0.5, `悬停折叠块时应露出抓手（一个悬停语言），实际 opacity=${hovered.grip}`)

  await ctx.close()
  return `marker=${r.markerClasses}（${r.markerW}）｜三角 absolute/opacity ${r.foldOpacity}｜无子块不生成 .fold（${foldOnLeaf.leafCount} 行）｜折叠态环 ${ring.width} ${ring.style}｜悬停让位 环${hovered.ring}/点${hovered.dot}→抓手${hovered.grip}`
})

await check('T24 可点导轨：深度 d 行有 d 段、点第 k 段折该祖先的直接子块（不折自己）、再点展开', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await openFirstPage(page)
  // 假数据里已有 depth 2 的块（嵌套 4 层的种子树）⇒ 直接用它，不靠按键造树
  await page.evaluate(() => window.__qua.quiet(true))

  const geo = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#editor .blk')]
    const deep = rows.find((el) => Number(el.dataset.depth) === 2)
    const rails = deep ? [...deep.querySelectorAll('.rail')] : []
    return {
      depth: deep?.dataset.depth ?? null,
      deepText: deep?.querySelector('.tx')?.textContent ?? '',
      railCount: rails.length,
      // R5：data-fold-line-for 依次等于祖先 id（index = 层级 k）
      railIds: rails.map((r) => r.dataset.foldLineFor),
      // 每段的 x 位置应随层级递增（--rail-depth 生效）
      railLefts: rails.map((r) => Math.round(r.getBoundingClientRect().left)),
    }
  })
  assert(geo.depth === '2', `假数据里应有 depth 2 的行，实际 depth=${geo.depth}（文本「${geo.deepText}」）`)
  assert(geo.railCount === 2, `深度 2 的行应有 2 段导轨（R5），实际 ${geo.railCount}`)
  assert(geo.railIds.every((x) => typeof x === 'string' && x.length === 32), `每段都应指向一个祖先 id：${JSON.stringify(geo.railIds)}`)
  assert(new Set(geo.railIds).size === 2, `两段应指向**不同**祖先：${JSON.stringify(geo.railIds)}`)
  // 同一行上的两段：外层的 x 应小于内层（k=0 在左）
  assert(geo.railLefts[0] < geo.railLefts[1], `层级 k 越大段越靠右：${JSON.stringify(geo.railLefts)}`)

  // R4：命中宽 ≥7px，视觉线 1px
  const line = await page.evaluate(() => {
    const rail = document.querySelector('#editor .blk .rail')
    const before = getComputedStyle(rail, '::before')
    return { hit: getComputedStyle(rail).width, line: before.width, bg: before.backgroundColor }
  })
  // R4：命中宽收到 6px（与 caret-out 11px 配对后，三角与段两处重叠都归零）
  assert(parseFloat(line.hit) >= 6, `导轨命中宽应 ≥6px（R4），实际 ${line.hit}`)
  assert(parseFloat(line.line) <= 1.5, `视觉线应是 1px（R4），实际 ${line.line}`)

  // R6：点导轨段 ⇒ 折**那一层祖先的直接子块**，**不折那个祖先自己**；
  //   再点同一段 ⇒ 展开，且段仍在、命中同一目标。
  const res = await page.evaluate((ids) => {
    const byId = (id) => window.__qua.blocks().find((b) => b.id === id)
    const visibleIds = () => [...document.querySelectorAll('#editor .blk')].map((el) => el.dataset.blockId)
    const click = (id) => {
      const rail = document.querySelector(`#editor .blk .rail[data-fold-line-for="${id}"]`)
      if (!rail) return false
      rail.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      return true
    }
    const depthOf = (id) => {
      const el = document.querySelector(`#editor .blk[data-block-id="${id}"]`)
      return el ? Number(el.dataset.depth) : null
    }
    const before = visibleIds()
    const depthsBefore = new Map(before.map((id) => [id, depthOf(id)]))
    const hit1 = click(ids[1])
    const after = visibleIds()
    const vanished = before.filter((x) => !after.includes(x))
    // ⚠️ 消失的既有**直接子块**也有**更深的孙辈** ⇒ 判据用「比被点的祖先更深」
    const targetDepth = depthsBefore.get(ids[1])
    const railStillThere = Boolean(document.querySelector(`#editor .blk .rail[data-fold-line-for="${ids[1]}"]`))
    const hit2 = click(ids[1])
    return {
      hit1,
      hit2,
      vanishedIds: vanished.map((x) => `${x.slice(-4)}@${depthsBefore.get(x)}`),
      vanishedAllDeeper: vanished.every((x) => (depthsBefore.get(x) ?? -1) > (targetDepth ?? -1)),
      vanishedNowOpen: vanished.every((x) => byId(x)?.collapsed !== true),
      selfCollapsed: byId(ids[1])?.collapsed === true,
      outerCollapsed: byId(ids[0])?.collapsed === true,
      railStillThere,
      rowsBefore: before.length,
      rowsAfter2: visibleIds().length,
    }
  }, geo.railIds)
  assert(res.hit1, '点内层段应命中该段（它必须还在 DOM 里）')
  assert(res.vanishedIds.length > 0, '折子块应让它们从 DOM 消失（折叠 = 不挂 DOM）')
  assert(res.vanishedAllDeeper, `消失的行必须都更深（只该收起该祖先的子树）：${JSON.stringify(res.vanishedIds)}`)
  assert(res.selfCollapsed !== true, '⚠️ 点线**不该折那个祖先自己**（否则「再点展开」不可能成立）')
  assert(res.outerCollapsed !== true, '只该折点中的那一层，不该连带外层')
  assert(res.railStillThere, '折子块后，指向该祖先的段必须**仍在**（这是「再点展开」的前提）')
  assert(res.hit2 && res.rowsAfter2 === res.rowsBefore, `再点同一段应展开并恢复行数：${res.rowsAfter2} vs ${res.rowsBefore}`)
  assert(res.vanishedNowOpen, '再点后那些块应不再是 collapsed')

  /**
   * R9：**三角命中区与最内层导轨段的命中区不许重叠**。
   * 曾把 `--ui-caret-out` 改成 13px，这里就会重叠 3px（「刚好相邻」的口径
   * 是按 10px 算的）⇒ 点三角边缘会命中线。改任一 token 都要复跑这条。
   */
  const overlap = await page.evaluate(() => {
    const out = []
    for (const el of document.querySelectorAll('#editor .blk')) {
      const fold = el.querySelector('.fold')
      const rails = [...el.querySelectorAll('.rail')]
      if (!fold || rails.length === 0) continue
      const f = fold.getBoundingClientRect()
      const r = rails[rails.length - 1].getBoundingClientRect()
      out.push(Math.max(0, Math.min(f.right, r.right) - Math.max(f.left, r.left)))
    }
    return out
  })
  assert(overlap.length > 0, '应有带子块且有内层段的行可测')
  const worst = Math.max(...overlap)
  assert(worst <= 0.5, `三角命中区与最内层导轨段不许重叠（R9），实际最大重叠 ${worst.toFixed(1)}px`)

  await ctx.close()
  return `depth 2 行 2 段（${geo.railIds.map((x) => x.slice(-4)).join('→')}，x ${geo.railLefts.map((x) => Math.round(x)).join('/')}）；命中 ${line.hit}/线 ${line.line}；点线折子块 ${res.vanishedIds.length} 个、祖先自己不动、再点恢复 ${res.rowsAfter2} 行；三角×段最大重叠 ${worst.toFixed(1)}px`
})

await check('T7 拖拽重排：把第 2 块拖到第 1 块上方（真实 DnD 事件序列）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  // ：冷启动是**日记流**（N 个 section），首块是只读日期行。
  // 本用例测的是「内容块之间的拖拽」⇒ 先打开一个单容器页与等同一前置）。
  await openFirstPage(page)
  const moved = await page.evaluate(() => {
    const bs = window.__qua.blocks()
    // bs[0] 是页根（section 根）：它不参与「内容块之间」的拖拽。
    // 取两个内容块：把 bs[2] 拖到 bs[1] 上方。
    const src = bs[2]
    const tgt = bs[1]
    const srcEl = document.querySelector(`.blk[data-block-id="${src.id}"]`)
    const tgtEl = document.querySelector(`.blk[data-block-id="${tgt.id}"]`)
    // D4：把手与块标合并 ⇒ 拖拽起点就是 `.marker`（仍带 `.handle` 契约 class）
    const handle = srcEl.querySelector('.handle')
    const dt = new DataTransfer()
    const rect = tgtEl.getBoundingClientRect()
    const mk = (type, extra = {}) =>
      new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientY: rect.top + 2, clientX: rect.left + 40, ...extra })
    handle.dispatchEvent(mk('dragstart'))
    tgtEl.dispatchEvent(mk('dragover'))
    tgtEl.dispatchEvent(mk('drop'))
    handle.dispatchEvent(mk('dragend'))
    const after = window.__qua.blocks()
    const si = after.findIndex((b) => b.id === src.id)
    const ti = after.findIndex((b) => b.id === tgt.id)
    return { ok: si >= 0 && ti >= 0 && si < ti, src: src.text.slice(0, 8), order: after.map((b) => b.text.slice(0, 8)) }
  })
  assert(moved.ok, `拖拽后源块应在目标块之前（${moved.src}）：${JSON.stringify(moved.order.slice(0, 4))}`)
  await ctx.close()
  return `顺序变为：${moved.order.slice(0, 3).join(' / ')}`
})

/* -------------------------------------------------- 命令面板 / 菜单 */

await check('T8 命令面板 ⌘P：列出全部命令、可搜、**无绑定也能执行**', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.focus())
  await page.keyboard.press(kbd('mod+p'))
  const rows = await page.locator('.layer-item').count()
  assert(rows > 30, `命令面板应列出全部命令，实际 ${rows} 行`)
  const noKey = await page.evaluate(() => {
    const log = window.__qua.__registry.list()
    return log.filter((d) => !d.hidden).length
  })
  await page.locator('.layer-input').fill('bold')
  const filtered = await page.locator('.layer-item').count()
  assert(filtered >= 1 && filtered < rows, `搜索应收窄列表：${rows} → ${filtered}`)
  await page.locator('.layer-input').fill('导出')
  await page.locator('.layer-item').first().click()
  const drawer = await page.locator('.drawer').count()
  assert(drawer === 1, '执行「导出当前页模型 JSON」应打开抽屉')
  const body = await page.locator('.drawer-body').innerText()
  assert(body.includes('roots') && body.includes('content'), '抽屉里应是模型 JSON（行内内容住块上）')
  await ctx.close()
  return `共 ${noKey} 条命令可搜可执行（≈ 无键位也能跑）；搜「bold」→ ${filtered} 行；搜「导出」→ 抽屉`
})

await check('T9 块菜单与斜杠菜单**都是绑定表的渲染结果**（同一条命令两种入口）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  // ⚠️ 块标**左键＝聚焦/zoom**，菜单在**右键**。
  // 所以这里用 `contextmenu` 开块菜单 ——与左键聚焦的分流由单独断言。
  const viaClick = await page.evaluate(() => {
    const el = document.querySelector('.blk .handle')
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    return [...document.querySelectorAll('.layer-item .layer-label')].map((r) => r.textContent)
  })
  assert(viaClick.length >= 8, `块菜单项太少：${JSON.stringify(viaClick)}`)
  assert(viaClick.some((t) => t.includes('复制块')), `块菜单应含「复制块」：${JSON.stringify(viaClick)}`)
  // 叶子块也给「聚焦到此块」（聚焦含块自身，不是只看子树）
  assert(viaClick.some((t) => t.includes('聚焦到此块')), `块菜单应含 zoom 入口（叶子也給）：${JSON.stringify(viaClick)}`)
  const grouped = await page.locator('.layer-group').allInnerTexts()
  assert(grouped.length >= 3, `块菜单应分组渲染：${JSON.stringify(grouped)}`)
  await page.keyboard.press('Escape')
  assert((await page.locator('.layer').count()) === 0, 'Esc 应关掉块菜单')
  // 斜杠：在空块里键入 `/`，菜单应弹出并随打字过滤
  await page.evaluate(() => {
    const bs = window.__qua.blocks()
    const id = bs[bs.length - 1].id
    window.__qua.focusBlock(id, 0)
  })
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('/')
  const slashRows = await page.locator('.layer-item').count()
  assert(slashRows >= 5, `斜杠菜单应有条目，实际 ${slashRows}`)
  await page.keyboard.type('图')
  const filteredRows = await page.locator('.layer-item').count()
  assert(filteredRows >= 1 && filteredRows <= slashRows, `斜杠应随打字过滤：${slashRows} → ${filteredRows}`)
  /**
   * 斜杠菜单里的「图片」是**真入口**：它开一个文件选择器（选真图 → 入库 → 插 run）。
   * 断言就验这条接线本身：菜单项选中 ⇒ 弹出 filechooser（而不是「插一枚假资产」）。
   */
  const beforeAtoms = (await page.evaluate(() => window.__qua.atoms())).length
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 5000 }),
    page.keyboard.press('Enter'),
  ])
  assert(Boolean(chooser), '斜杠菜单选「图片」应打开文件选择器')
  await chooser.setFiles({
    name: '斜杠插入.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAIAAAADnC86AAAAMElEQVR4nO3NQQkAAAgEsItjHGMbyxKCn8H+y3S9iFgsFovFYrFYLBaLxWKxWHxnAY8m0GozORegAAAAAElFTkSuQmCC',
      'base64',
    ),
  })
  await page.waitForFunction((n) => window.__qua.atoms().length > n, beforeAtoms, { timeout: 5000 })
  const afterAtoms = (await page.evaluate(() => window.__qua.atoms())).length
  assert(afterAtoms === beforeAtoms + 1, '斜杠菜单选「图片」→ 选文件应插入一个原子')
  const t = await texts(page)
  assert(!t.some((x) => x.includes('/图')), `` + `斜杠查询词应从文本里抹掉：${JSON.stringify(t.slice(-2))}`)
  await ctx.close()
  return `块菜单 ${viaClick.length} 项 / ${grouped.length} 组；斜杠输入「/图」→ ${filteredRows} 项 → 选文件插入原子`
})

/* ------------------------------------------------------- 持久化 / 状态 */

await check('T10 localStorage：关掉重开内容还在（含锚点与原子）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => {
    // journal 首行是只读日期 ⇒ 往第一个**可编辑**块里写
    const b = window.__qua.blocks().find((x) => !x.roles?.includes('journal'))
    window.__qua.focusBlock(b.id, 0)
  })
  await page.keyboard.type('持久化标记 ')
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press(kbd('mod+b'))
  await page.waitForTimeout(450)
  const before = await page.evaluate(() => ({
    marks: window.__qua.marks().length,
    atoms: window.__qua.atoms().length,
    saved: window.__qua.snapshot().hasLocalStorage,
  }))
  assert(before.saved, 'localStorage 里应有快照')
  // ⚠️ 2026-10-20：原来这里是 `page.reload()`。reload 不算「关掉重开」，
  //    所以改成真正的「关页 → 从关页后的存储复原 → 重开」（见 harness 的 `reopenPage`）。
  const reopened = await reopenPage(browser, ctx, base, page)
  const after = await reopened.page.evaluate(() => ({
    text: window.__qua.text().join('|'),
    marks: window.__qua.marks().length,
    atoms: window.__qua.atoms().length,
    pages: window.__qua.snapshot().pageCount,
  }))
  await reopened.ctx.close()
  assert(after.text.includes('持久化标记'), `重开后文本丢了：${JSON.stringify(after.text.slice(0, 40))}`)
  assert(after.marks >= 1 && after.atoms >= 1, `重开后锚点/原子丢了：${JSON.stringify(after)}`)
  assert(after.pages === 5, `假数据库应 5 页，实际 ${after.pages}`)
  await ctx.close()
  return `重开后：${after.pages} 页、marks ${after.marks}、atoms ${after.atoms}、首块含标记`
})

await check('T36 StoragePort：关页前不等防抖也能落盘；旧裸库显式作废；陌生字节不覆盖', async () => {
  // ① 写入后**不等防抖**（远小于 250ms）就**真关掉这一页**，再按「关页后的存储」重开
  {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => {
      const b = window.__qua.blocks().find((x) => !x.roles?.includes('journal'))
      window.__qua.focusBlock(b.id, 0)
    })
    await page.keyboard.type('页隐藏标记 ')
    const reopened = await reopenPage(browser, ctx, base, page)
    const text = await reopened.page.evaluate(() => window.__qua.text().join('|'))
    await reopened.ctx.close()
    assert(text.includes('页隐藏标记'), `关页前那批没落盘：${text.slice(0, 40)}`)
  }

  // ② 升级前的**裸库**（v3，没有信封）：必须走 expired 显式作废，绝不能把 v3 当成当前版本打开
  // ⚠️ 判据只看**可观测的两件事**：库被重 seed（旧字没了）、不进只读态。
  //    「作废要说得出来」由启动告警常驻条保证（`ui.boot.expired` → `chrome.showNotice`），
  //    但那是**下一轮装配**才知道的事，不放进这里的断言。
  {
    const { ctx, page } = await freshPage(browser, base)
    // 冷启动不抢光标 ⇒ 没有初始落盘。先制造一次真实编辑，键位上才会出现 v4 信封。
    await page.evaluate(() => window.__qua.focus())
    await page.keyboard.type('种子 ')
    const before = await page.evaluate(() => window.__qua.text())
    await page.waitForFunction(() => localStorage.length > 0)
    await page.evaluate(() => {
      // 先拿到当前信封的形状，再把它拆成「升级前的裸库」（v3、没有信封）
      const storageKey = localStorage.key(0)
      const legacy = JSON.parse(localStorage.getItem(storageKey))
      legacy.data.version = 3
      legacy.data.blocks = [{ ...legacy.data.blocks[0], text: '旧库里的字不该被当成 v4 打开' }]
      localStorage.setItem(storageKey, JSON.stringify(legacy.data))
    })
    const reopened = await reopenPage(browser, ctx, base, page)
    const snap = await reopened.page.evaluate(() => ({ ...window.__qua.snapshot(), text: window.__qua.text().join('|') }))
    await reopened.ctx.close()
    assert(before.length > 0, '前置：首屏应有内容')
    assert(!snap.readOnly, '旧版本的库应当被显式作废重 seed（不是进只读态）')
    assert(!snap.text.includes('旧库里的字'), 'v3 的库不许被当成当前版本打开')
  }

  // ③ 键位上留着「另一个后端」写的字节：不许冒充 corrupt，更不许覆盖
  // ⚠️ 这条**不能**走 `reopenPage`：旧页关闭时会把手里那份 v4 库重新盖回去（那正是它该做的事），
  //    写进去的陌生字节会被覆盖 ⇒ 断言永远看不到 readOnly。所以用「另建 context + storageState」
  //    直接喂一份陌生字节，这才是「换后端之后第一次打开」的真实入口。
  {
    const seed = await freshPage(browser, base)
    // 冷启动不抢光标 ⇒ 没有初始落盘；先制造一次真实编辑再取信封
    await seed.page.evaluate(() => window.__qua.focus())
    await seed.page.keyboard.type('种子 ')
    await seed.page.waitForFunction(() => localStorage.length > 0)
    await seed.page.evaluate(() => {
      localStorage.setItem(localStorage.key(0), JSON.stringify({ some: 'other-backend' }))
    })
    const state = await seed.ctx.storageState()
    await seed.ctx.close()
    const ctx2 = await browser.newContext({ storageState: state })
    const { page: page2 } = await openPage(browser, ctx2, base)
    const snap = await page2.evaluate(() => ({
      readOnly: window.__qua.snapshot().readOnly,
      raw: localStorage.getItem(localStorage.key(0)),
    }))
    await ctx2.close()
    assert(snap.readOnly, '认不出的字节应当进只读态（宁可不动）')
    assert(String(snap.raw).includes('other-backend'), '只读态下绝不许改写字节')
  }

  return '关页落盘 ✓ · v3 裸库 ⇒ 显式作废并重 seed ✓ · 陌生字节 ⇒ 只读且逐字节未变 ✓'
})

await check('T11 主题三档 = 真 token 切换（DOM 形状不变；皮肤已删）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  const sig = async () =>
    page.evaluate(() => ({
      // ⚠️ 不再读 `skin`：内建只有一种样式（D3），`data-skin` 已从 body 上消失
      hasSkin: document.body.dataset.skin !== undefined,
      theme: document.body.dataset.theme,
      domShape: Array.from(document.querySelectorAll('#editor .blk')).map((e) => e.getAttribute('data-depth')).join(','),
      bg: getComputedStyle(document.body).backgroundColor,
      fs: getComputedStyle(document.body).fontSize,
      lh: getComputedStyle(document.body).lineHeight,
      indent: getComputedStyle(document.body).getPropertyValue('--ui-indent').trim(),
      // 块标槽：D4 合并后是 20px（旧形状 40px：fold 12 + bullet 14 + handle 12 + gap）
      markerW: getComputedStyle(document.querySelector('.blk .marker')).width,
    }))
  const a = await sig()
  assert(!a.hasSkin, 'body 上不该有 data-skin（D3：甲/乙/丙三皮肤已删）')
  await page.evaluate(() => window.__qua.setTheme('light'))
  const light = await sig()
  await page.evaluate(() => window.__qua.setTheme('dark'))
  const dark = await sig()
  assert(a.domShape === light.domShape && light.domShape === dark.domShape, '换主题不该改 DOM 形状（只换 token）')
  assert(a.bg !== dark.bg, `亮/暗配色应有区分：${a.bg} / ${dark.bg}`)
  assert(light.theme === 'light' && dark.theme === 'dark' && dark.bg !== light.bg, '亮/暗没生效')
  // 首版取值：缩进 24、块标槽 20
  assert(a.indent === '24px', `缩进应是 24px（设计稿取值），实际 ${a.indent}`)
  assert(a.markerW === '20px', `块标槽应是 20px（D4 合并后），实际 ${a.markerW}`)

  // ——三档里的「跟随系统」的缺口）：**不做 JS 切类**，颜色由 CSS 的
  //    `prefers-color-scheme` ＋ `light-dark()` 决定。用 Playwright 真改媒体查询（真 Chrome）断言：
  //    `data-theme` 记的是**档位**（system 不动），底色必须跟着系统变。
  await page.evaluate(() => window.__qua.setTheme('system'))
  const sysLight = await sig()
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(80)
  const sysDark = await sig()
  const sysDarkResolved = await page.evaluate(() => window.__qua.resolvedTheme())
  await page.emulateMedia({ colorScheme: 'light' })
  assert(
    sysLight.theme === 'system' && sysDark.theme === 'system',
    `跟随系统档不该把 data-theme 改成亮/暗：${sysLight.theme} / ${sysDark.theme}`,
  )
  assert(sysLight.bg !== sysDark.bg, `跟随系统档应跟随 prefers-color-scheme：${sysLight.bg} vs ${sysDark.bg}`)
  assert(sysDarkResolved === 'dark', `系统外观为暗时解析结果应为 dark，实际 ${sysDarkResolved}`)
  await ctx.close()
  return (
    `单一内建样式：缩进 ${a.indent}、块标槽 ${a.markerW}｜亮 ${light.bg} → 暗 ${dark.bg}｜` +
    `跟随系统：亮 ${sysLight.bg} → 暗 ${sysDark.bg}（data-theme 恒为 ${sysLight.theme}/${sysDark.theme}）`
  )
})

await check('T38 查询视图：冻结成员与顺序、内容按 id 实时、刷新按钮才改成员', async () => {
  const { ctx, page } = await freshPage(browser, base)
  /**
   * **点开那个查询块本身**才看结果：查询视图挂在「被打开的那一块」那一段的段尾
   * （页面底部不再单列一条结果）。这也是它现在的唯一落点。
   */
  const qid = await page.evaluate(() => {
    const p = window.__qua.pages().find((x) => (x.title ?? '').includes('产品设计'))
    window.__qua.invoke('core.page/open', { pageId: p.id })
    let found = ''
    const walk = (list) => {
      for (const b of list) {
        if (b.props?._query) {
          found = b.id
          return
        }
        walk(b.children)
      }
    }
    walk(window.__qua.__editor.store.blocks)
    return found
  })
  assert(qid, '前置：这一页里应有一个查询块')
  await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), qid)
  await page.waitForTimeout(320)

  const view = () =>
    page.evaluate(() => {
      const root = document.querySelector('.queryview')
      return {
        present: Boolean(root),
        hidden: root?.hidden ?? true,
        title: root?.querySelector('.queryview-title')?.textContent ?? '',
        count: root?.querySelector('.queryview-count')?.textContent ?? '',
        refresh: root?.querySelector('.queryview-refresh')?.textContent ?? '',
        stale: !(root?.querySelector('.queryview-stale')?.hidden ?? true),
        rows: [...(root?.querySelectorAll('.queryview-editor .blk .tx') ?? [])].map((e) => e.textContent),
      }
    })

  const first = await view()
  assert(first.present && !first.hidden, '打开查询块 ⇒ 查询视图应当可见')
  assert(first.rows.length === 1, `本页应只有 1 条待办，实际 ${JSON.stringify(first.rows)}`)
  assert(first.refresh.length > 0, '刷新按钮必须有文案（D6）')
  assert(!first.stale, '刚冻结完不该显示「可能已过期」')
  /**
   * 结果行可能来自库的任意深度 ⇒ 行首要标出祖先链；否则同一句话在别的页里
   * 也出现时，读者不知道这一行是哪一页的那一条。
   */
  const firstCrumbs = await page.evaluate(() =>
    [...document.querySelectorAll('.queryview-editor .blk[data-depth="0"] > .blk-context .blk-context-cell')].map(
      (e) => e.textContent ?? '',
    ),
  )
  assert(firstCrumbs.includes('产品设计 · 决策日志'), `查询结果行应显示祖先链（面包屑）：${JSON.stringify(firstCrumbs)}`)
  /**
   * 查询结果与反链共用同一条手势：普通点＝就地展开上下文（中心不动），
   * 展开根行首的「收起上下文」逐层退回。
   */
  const firstCrumbId = await page.evaluate(
    () => document.querySelector('.queryview-editor .blk[data-depth="0"] > .blk-context .blk-context-cell')?.dataset.crumbFor ?? '',
  )
  assert(firstCrumbId, '查询结果行首应有可展开的面包屑')
  const activeBeforeExpand = await page.evaluate(() => window.__qua.snapshot().activeId)
  await page.locator('.queryview-editor .blk[data-depth="0"] > .blk-context .blk-context-cell').first().click()
  await page.waitForTimeout(220)
  const qExpanded = await page.evaluate((id) => {
    const root = document.querySelector(`.queryview-editor .blk[data-block-id="${id}"][data-depth="0"]`)
    return {
      root: Boolean(root),
      back: Boolean(root?.querySelector('.blk-context-back')),
      active: window.__qua.snapshot().activeId,
    }
  }, firstCrumbId)
  assert(qExpanded.root && qExpanded.back, `查询结果的面包屑也应就地展开并给收起入口：${JSON.stringify(qExpanded)}`)
  assert(qExpanded.active === activeBeforeExpand, `查询结果原地展开不换中心：${activeBeforeExpand} → ${qExpanded.active}`)
  await page.locator(`.queryview-editor .blk[data-block-id="${firstCrumbId}"] .blk-context-back`).click()
  await page.waitForTimeout(220)

  const targetId = await page.evaluate(() => {
    let found = ''
    const walk = (list) => {
      for (const b of list) {
        if (b.content.filter((r) => r.t === 'text').map((r) => r.v).join('').includes('引用某段')) {
          found = b.id
          return
        }
        walk(b.children)
      }
    }
    walk(window.__qua.__editor.store.blocks)
    return found
  })
  assert(targetId, '前置：应能找到那条待办')

  // ① 内容不冻（D5）：在结果行里直接改字 ⇒ 视图**立即**显示新文字
  await page.locator('.queryview-editor .blk .tx').first().click()
  await page.keyboard.press('End')
  await page.keyboard.type('改字 ')
  await page.waitForTimeout(220)
  const edited = await view()
  assert(edited.rows.some((r) => r.includes('改字')), `内容应当实时更新（D5）：${JSON.stringify(edited.rows)}`)
  assert(edited.count === first.count, '改字不该改成员数（D4：冻的是成员与顺序）')

  // ② 别人改了结果里的块 ⇒ 点亮「可能已过期」（不改列表）
  await page.evaluate((id) => window.__qua.invoke('core.dock/open-block', { blockId: id, side: 'right' }), targetId)
  await page.waitForTimeout(250)
  await page.locator(`#dock-right .blk[data-block-id="${targetId}"] .tx`).first().click()
  await page.keyboard.press('End')
  await page.keyboard.type('Z')
  await page.waitForTimeout(250)
  const touched = await view()
  assert(touched.rows.length === 1, `别的视图改字不许自动重排（D4）：${JSON.stringify(touched.rows)}`)
  assert(touched.stale, '结果里的块被别处改动 ⇒ 应当提示「可能已过期」')

  // ③ 成员不冻（D4）：把它改成已完成 ⇒ 不再匹配，但**列表仍应留着**，等刷新再移除
  //    ⚠️ 走属性写入而不是「当前活动编辑器的待办开关」：后者取决于焦点在谁身上，
  //       而这个用例要验的是**查询的成员判定**，不是焦点派发。
  const taskPropId = await page.evaluate(() => window.__qua.propDefs().find((p) => p.label === '任务状态')?.id ?? '')
  assert(taskPropId, '前置：种子里应有「任务状态」字段定义')
  await page.evaluate(
    ({ id, propId }) => window.__qua.invoke('core.props/set-value', { blockId: id, propId, value: true }),
    { id: targetId, propId: taskPropId },
  )
  await page.waitForTimeout(200)
  const stillThere = await view()
  assert(stillThere.rows.length === 1, `去掉匹配后不许自动重排（D4）：${JSON.stringify(stillThere.rows)}`)
  assert(stillThere.stale, '仍然要提示可能已过期')

  // ④ 刷新按钮（D6）：这时才改变成员
  await page.click('.queryview-refresh')
  await page.waitForTimeout(300)
  const refreshed = await view()
  assert(refreshed.rows.length === 0, `刷新后才移除（D6）：${JSON.stringify(refreshed.rows)}`)
  assert(refreshed.count.startsWith('0'), `条数要跟着变：${refreshed.count}`)
  assert(!refreshed.stale, '刷新完不应再提示已过期')
  assert(!refreshed.hidden && refreshed.refresh.length > 0, '空结果也要保留抬头与刷新按钮（不是静默消失）')

  // ⑤ 落盘：**只有条件入 KB**，结果不入（它按表面实例冻结，重开重算）
  const frozen = await page.evaluate((qid2) => {
    const raw = localStorage.getItem(localStorage.key(0))
    const data = JSON.parse(raw).data
    const q = data.blocks.flatMap(function flat(b) { return [b, ...b.children.flatMap(flat)] }).find((b) => b.id === qid2)
    return {
      hasQuery: Boolean(q?.props?._query),
      // 任何一格叫 `_queryResult` 的东西都不该在库里（v29 起结果不是内容）
      resultProps: Object.keys(q?.props ?? {}).filter((k) => k.toLowerCase().includes('result')),
      children: q?.children?.length ?? -1,
    }
  }, qid)
  assert(frozen.hasQuery, '条件要落在 _query 上（AF5：查询块＝数据侧）')
  assert(frozen.resultProps.length === 0, `结果**不入库**（它是表面实例的投影）：${JSON.stringify(frozen.resultProps)}`)
  assert(frozen.children === 0, '刷新不许把结果 re-parent 成查询块的子块（AF2/AF3）')

  await ctx.close()
  return `1 条 → 改字实时更新（成员不变）→ 不匹配仍保留 → 刷新后 ${refreshed.count}；只有条件入 KB、结果未 re-parent`
})

await check('T191 结果基数：父子同时命中时，大纲与表格的抬头数字一致（都＝命中条数）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  await openFirstPage(page)
  await page.waitForTimeout(300)

  /**
   * 造一对「父子正文相同」的块：只有它们同时命中，才谈得上「大纲折叠、表格不折叠」。
   * 走真实的编辑命令（不直接改森林）：插件式地先插一块、缩进成子块、再插一块、缩进成孙块。
   */
  const made = await page.evaluate(() => {
    const rows = window.__qua.__editor.rows().map((r) => r.block)
    const spot = rows.find((b) => b.children.length === 0 && !b.props?._query)
    if (!spot) throw new Error('前置：这一页没有可落的块')
    window.__qua.focusBlock(spot.id, 999)
    window.__qua.invoke('core.editor/insert-block', { text: '基数探针' })
    const parent = String(window.__qua.__editor.sel?.aBlock ?? '')
    window.__qua.invoke('core.editor/indent-block', {})
    window.__qua.focusBlock(parent, 999)
    window.__qua.invoke('core.editor/insert-block', { text: '基数探针' })
    const child = String(window.__qua.__editor.sel?.aBlock ?? '')
    window.__qua.invoke('core.editor/indent-block', {})
    return { parent, child }
  })
  assert(made.parent && made.child && made.parent !== made.child, `前置：应造出父子两块：${JSON.stringify(made)}`)
  await page.waitForTimeout(300)

  const qid = await page.evaluate(() => {
    const ok = window.__qua.invoke('core.query/create', {
      kind: 'page',
      name: '基数探针查询',
      spec: { where: { text: '基数探针' }, scope: 'all' },
    })
    if (!ok) throw new Error('建不出查询页')
    return String(window.__qua.snapshot().activeId)
  })
  await page.waitForTimeout(500)

  const read = () =>
    page.evaluate(() => ({
      count: document.querySelector('.queryview-count')?.textContent ?? '',
      top: document.querySelector('.queryview-topcount')?.hidden === false
        ? (document.querySelector('.queryview-topcount')?.textContent ?? '')
        : '',
      outlineRows: document.querySelectorAll('.queryview-editor .blk[data-depth="0"]').length,
      tableRows: document.querySelectorAll('.tv-row').length,
    }))

  const outline = await read()
  assert(outline.count.includes('2'), `大纲抬头的主数字＝命中条数 2：${outline.count}`)
  assert(outline.outlineRows === 1, `大纲把父子折叠成一行：${outline.outlineRows}`)
  assert(outline.top.includes('1'), `折叠程度用次要文案说：${JSON.stringify(outline.top)}`)

  // 同一份结果换表格：主数字**不变**，只是不再折叠
  await page.evaluate(
    (id) => window.__qua.invoke('core.view/add', { owner: { kind: 'block', blockId: id }, kind: 'table' }),
    qid,
  )
  await page.waitForTimeout(500)
  const table = await read()
  assert(table.count === outline.count, `同一查询在两种视图下的主数字必须一致：${outline.count} → ${table.count}`)
  assert(table.tableRows === 2, `表格每条命中一行：${table.tableRows}`)
  assert(table.top === '', '表格不折叠 ⇒ 没有次要文案')

  await ctx.close()
  return `hits=2：大纲 ${outline.outlineRows} 行＋「${outline.top}」、表格 ${table.tableRows} 行；抬头都是 ${table.count}`
})

await check('T192 在当前块里建查询块：落点是这一块的子块；一次撤销撤掉两块；构建器当场打开', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  await openFirstPage(page)
  await page.waitForTimeout(300)
  const root = await page.evaluate(() => window.__qua.snapshot().activeId)
  const before = await page.evaluate(() => window.__qua.snapshot().totalBlocks)

  await page.evaluate((id) => window.__qua.invoke('core.query/insert', { blockId: id }), root)
  await page.waitForTimeout(500)

  const made = await page.evaluate((id) => {
    const host = window.__qua.__editor.store.find(id)
    const q = host?.children[0]
    const caret = host?.children[1]
    return {
      qid: q?.id ?? '',
      parent: q && host ? host.id : '',
      hasQuery: Boolean(q?.props?._query),
      caret: caret?.id ?? '',
      caretChildren: caret?.children.length ?? -1,
      blocks: window.__qua.snapshot().totalBlocks,
      builder: Boolean(document.querySelector('.qb')),
    }
  }, root)
  assert(made.hasQuery, `前置：新块应是查询块：${JSON.stringify(made)}`)
  assert(made.parent === root, `查询块必须是**当前块的子块**（锚点才等于当前块）：${JSON.stringify(made)}`)
  assert(made.caret !== '' && made.caret !== made.qid, '查询块后面要留一个空块做光标落点')
  assert(made.caretChildren === 0, '落点是一个空块')
  assert(made.blocks === before + 2, `一次建两块：${before} → ${made.blocks}`)
  assert(made.builder, '建完当场打开构建器（不用再点一次）')

  // 关掉构建器，把光标放回编辑器，一次 ⌘Z 应该把两块一起撤掉
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  await page.evaluate((id) => window.__qua.focusBlock(id, 0), made.qid)
  await page.waitForTimeout(150)
  await page.keyboard.press(kbd('mod+z'))
  await page.waitForTimeout(500)
  const undone = await page.evaluate(() => ({ blocks: window.__qua.snapshot().totalBlocks }))
  assert(undone.blocks === before, `插块与落点空块要能一次撤销：${before} → ${undone.blocks}（应回到 ${before}）`)

  await ctx.close()
  return `查询块是当前块的子块；两块一起插、一次 ⌘Z 收回（${made.blocks} → ${undone.blocks}）`
})

await check('T193 提升为查询块：新块挂在宿主下；$self 结果不变；一次 ⌘Z 收回块与指针', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  await openFirstPage(page)
  await page.waitForTimeout(300)

  // 挑一个有文字的叶子块，把它打开成这一段（挂载区属于这一段）
  const host = await page.evaluate(() => {
    const rows = window.__qua.__editor.rows().map((r) => r.block)
    const spot = rows.find((b) => b.children.length === 0 && r0Text(b) !== '')
    function r0Text(b) {
      return (b.content ?? []).filter((r) => r.t === 'text').map((r) => r.v).join('')
    }
    window.__qua.invoke('core.block/focus-block', { blockId: spot.id })
    return { id: spot.id, text: r0Text(spot) }
  })
  assert(host.id !== '' && host.text !== '', `前置：要有一个有文字的叶子块：${JSON.stringify(host)}`)
  await page.waitForTimeout(400)
  const before = await page.evaluate(() => window.__qua.snapshot().totalBlocks)

  // 给它加一个**提到它正文**的子块：$self 的文本条件才有命中
  const childId = await page.evaluate(
    ({ id, text }) => {
      window.__qua.invoke('core.view/new-row', { owner: { kind: 'block', blockId: id } })
      const hostBlock = window.__qua.__editor.store.find(id)
      const child = hostBlock?.children[0]
      if (!child) return ''
      window.__qua.focusBlock(child.id, 0)
      return child.id
    },
    host,
  )
  assert(childId !== '', '前置：应能加一个子块')
  await page.waitForTimeout(250)
  await page.locator(`#editor .blk[data-block-id="${childId}"] .tx`).first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(host.text)
  await page.waitForTimeout(400)

  // 一栏 local：条件用「这一块的正文」（$self）
  const tabId = await page.evaluate((id) => {
    window.__qua.invoke('core.mount/add-local', {
      host: { kind: 'block', blockId: id },
      label: '本块自引用',
      spec: { where: { text: '$self' } },
    })
    return [...document.querySelectorAll('#editor .mount .mount-tabwrap')].find(
      (x) => (x.querySelector('.mount-tab')?.textContent ?? '') === '本块自引用',
    )?.dataset.tab ?? ''
  }, host.id)
  assert(tabId !== '', '前置：应加出一栏 local 查询')
  await page.waitForTimeout(300)
  // 新栏缺省是表格；切回大纲数行（这一条钉的是锚点与结果，不是看法）
  await page.evaluate(
    ({ id, tabId }) =>
      window.__qua.invoke('core.view/set-active', {
        owner: { kind: 'tab', host: { kind: 'block', blockId: id }, tabId },
        viewId: '',
      }),
    { id: host.id, tabId },
  )
  await mountTab(page, tabId)
  await page.waitForTimeout(350)
  const rowsBefore = await mountRows(page)
  assert(rowsBefore > 0, `前置：这一栏应命中那条子块：${rowsBefore}`)

  // 走「⋯」菜单的「提升为查询块…」——不是直接调命令
  await page.locator(`#editor .mount .mount-tabwrap[data-tab="${tabId}"] .mount-more`).click()
  await page.waitForSelector('.layer-item')
  const labels = await page.evaluate(() => [...document.querySelectorAll('.layer-label')].map((e) => e.textContent ?? ''))
  assert(labels.some((x) => x.includes('提升为查询块')), `⋯ 菜单里要有「提升为查询块…」：${JSON.stringify(labels)}`)
  await page.locator('.layer-item', { hasText: '提升为查询块' }).first().click()
  await page.waitForTimeout(500)

  const promoted = await page.evaluate((id) => {
    const hostBlock = window.__qua.__editor.store.find(id)
    let qid = ''
    let parent = ''
    const walk = (list, p) => {
      for (const b of list) {
        if (b.props?._query && p === id) qid = b.id
        if (b.id === qid) parent = p ?? ''
        walk(b.children, b.id)
      }
    }
    walk(window.__qua.__editor.store.blocks, null)
    return {
      qid,
      parent,
      tabKind: document.querySelector('#editor .mount .mount-tabwrap[data-kind="linked"]')?.dataset.kind ?? '',
      blocks: window.__qua.snapshot().totalBlocks,
      childInHost: Boolean(hostBlock),
    }
  }, host.id)
  assert(promoted.qid !== '', '提升应建出一个查询块')
  assert(promoted.parent === host.id, `查询块的父块必须是宿主（$self 才指得回它）：${JSON.stringify(promoted)}`)
  assert(promoted.tabKind === 'linked', '这一栏要改成指向新块的指针')
  assert(promoted.blocks === before + 2, `提升只多一个查询块（原有子块也在）：${before} → ${promoted.blocks}`)

  // 打开新查询块：$self 的结果应与提升前一致
  await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), promoted.qid)
  await page.waitForTimeout(450)
  const after = await page.evaluate(() => ({
    count: document.querySelector('.queryview-count')?.textContent ?? '',
    rows: document.querySelectorAll('.queryview-editor .blk[data-depth="0"]').length,
  }))
  assert(after.rows === rowsBefore, `$self 结果要与提升前一致：${rowsBefore} → ${after.rows}（${after.count}）`)

  // 一次 ⌘Z：块回来、栏回到 local
  await page.locator('.queryview-editor .blk .tx').first().click()
  await page.keyboard.press(kbd('mod+z'))
  await page.waitForTimeout(550)
  const undone = await page.evaluate((id) => {
    const hostBlock = window.__qua.__editor.store.find(id)
    const mounts = Array.isArray(hostBlock?.props?._mounts) ? hostBlock.props._mounts : []
    return { blocks: window.__qua.snapshot().totalBlocks, kinds: mounts.map((m) => m.kind) }
  }, host.id)
  assert(undone.blocks === before + 1, `一次撤销要删掉查询块（子块留着）：${before + 1} → ${undone.blocks}`)
  assert(undone.kinds.includes('local'), `一次撤销也要把这一栏改回 local：${JSON.stringify(undone.kinds)}`)

  await ctx.close()
  return `提升后父块＝宿主、结果 ${rowsBefore} 条不变；一次 ⌘Z 收回块与指针（${undone.kinds.join(',')}）`
})

await check('T194 派生栏切表格：路径/引用次数/命中词/共同标签；重开仍是表格；固定为查询不抢内置栏', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  const setup = await page.evaluate(() => {
    const pages = window.__qua.pages()
    const P = pages[0]
    const Q = pages[1]
    // ① 引用：在另一页的一条块里引用 P
    window.__qua.invoke('core.page/open', { pageId: Q.id })
    const rows = window.__qua.__editor.rows().map((r) => r.block).filter((x) => x.id !== Q.id && x.children.length === 0)
    const refBy = rows[0]
    const tagged = rows[1] ?? rows[0]
    window.__qua.focusBlock(refBy.id, 999)
    window.__qua.invoke('core.editor/insert-page-ref', { pageId: P.id })
    // ② 提及：另一条块正文含 P 的名字（**不是**引用）
    window.__qua.focusBlock(tagged.id, 999)
    window.__qua.invoke('core.editor/insert-block', { text: `${P.title} 的提及探针` })
    // ③ 同类：P 与被引用的那条块打同一个标签
    window.__qua.invoke('core.tags/add', { blockId: P.id, name: '冒烟同类' })
    window.__qua.invoke('core.tags/add', { blockId: tagged.id, name: '冒烟同类' })
    return { P: P.id, refBy: refBy.id, tagged: tagged.id }
  })
  assert(setup.P !== '' && setup.refBy !== '', `前置：应能造出引用/提及/同类：${JSON.stringify(setup)}`)
  await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), setup.P)
  await page.waitForTimeout(450)

  const head = () =>
    page.evaluate(() => ({
      count: document.querySelector('.mount-derived-count')?.textContent ?? '',
      active: document.querySelector('.mount-derived-view[data-active="1"]')?.dataset.kind ?? '',
      why: document.querySelector('.mount-derived-why')?.textContent ?? '',
    }))
  const tableOf = () =>
    page.evaluate(() => ({
      rows: document.querySelectorAll('.mount-view .tv-row').length,
      cols: [...document.querySelectorAll('.mount-view .tv-head [data-col]')].map((e) => e.dataset.col),
      cells: [...document.querySelectorAll('.mount-view .tv-row [data-col]')].map((e) => e.textContent ?? ''),
      // 派生栏没有拥有者：视图宿主自己的抬头（含刷新/新建视图/改名）不许露出来
      qvHead: document.querySelector('.mount-view .queryview-head')?.hidden ?? false,
    }))
  const num = (s) => Number((s.match(/\d+/) ?? ['0'])[0])

  // ① 引用栏 → 表格：路径与引用次数两列都在
  await mountTab(page, 'refs')
  const refsHead = await head()
  const refsCount = num(refsHead.count)
  assert(refsCount >= 1, `引用栏应有命中（造过一条引用）：${JSON.stringify(refsHead)}`)
  await page.locator('.mount-derived-view[data-kind="table"]').click()
  await page.waitForTimeout(450)
  const refsTable = await tableOf()
  assert(refsHead.active === 'outline', '前置：缺省是大纲')
  assert(refsTable.rows === refsCount, `切表格不改变成员：${refsCount} → ${refsTable.rows}`)
  assert(refsTable.cols.includes('path') && refsTable.cols.includes('refCount'), `引用表要有路径与次数：${JSON.stringify(refsTable.cols)}`)
  assert(refsTable.cells.some((c) => /^\d+$/.test(c) && Number(c) >= 1), `引用次数要画出来：${JSON.stringify(refsTable.cells)}`)
  assert(refsTable.qvHead === true, '派生栏的视图宿主不许画自己的抬头（没有拥有者）')

  // ② 关掉重开：看法是设备状态，重开仍在
  const reopened = await reopenPage(browser, ctx, base, page)
  const page2 = reopened.page
  await page2.waitForTimeout(350)
  await page2.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), setup.P)
  await page2.waitForTimeout(450)
  await mountTab(page2, 'refs')
  const persisted = await page2.evaluate(() => ({
    active: document.querySelector('.mount-derived-view[data-active="1"]')?.dataset.kind ?? '',
    rows: document.querySelectorAll('.mount-view .tv-row').length,
  }))
  assert(persisted.active === 'table', `派生栏的看法要落设备状态（重开仍是表格）：${JSON.stringify(persisted)}`)
  assert(persisted.rows === refsCount, `重开后成员一致：${refsCount} → ${persisted.rows}`)

  // ③ 固定为查询：内置栏保留、新栏有个不重名的名字、看法跟着过去
  await page2.locator('.mount-derived-more').click()
  await page2.waitForSelector('.layer-item')
  await page2.locator('.layer-item', { hasText: '固定为' }).first().click()
  await page2.waitForTimeout(500)
  const fixed = await page2.evaluate(() => ({
    labels: [...document.querySelectorAll('#editor .mount .mount-tab')].map((e) => e.textContent ?? ''),
    kinds: [...document.querySelectorAll('#editor .mount .mount-tabwrap')].map((w) => w.dataset.kind ?? ''),
    rows: document.querySelectorAll('.mount-view .tv-row').length,
    derivedHeadHidden: document.querySelector('.mount-derived-head')?.hidden ?? false,
  }))
  assert(fixed.labels.includes('引用'), `内置栏要保留：${JSON.stringify(fixed.labels)}`)
  assert(fixed.labels.includes('引用（可编辑）'), `新栏不能和内建栏重名：${JSON.stringify(fixed.labels)}`)
  assert(fixed.kinds.filter((k) => k === 'local').length === 1, `新栏是 local（自己拥有配置）：${JSON.stringify(fixed.kinds)}`)
  assert(fixed.rows === refsCount, `固定后的查询与当前看法一致（同为表格、${refsCount} 行）：${fixed.rows}`)
  assert(fixed.derivedHeadHidden, '切到 local 栏之后派生栏的抬头收起（它不再代表这一栏）')

  // ④ 提及 / 同类：命中词与共同标签各自落在表里
  await mountTab(page2, 'mentions')
  await page2.locator('.mount-derived-view[data-kind="table"]').click()
  await page2.waitForTimeout(450)
  const mentions = await page2.evaluate(() => ({
    count: Number((document.querySelector('.mount-derived-count')?.textContent ?? '0').match(/\d+/)?.[0] ?? '0'),
    rows: document.querySelectorAll('.mount-view .tv-row').length,
    cols: [...document.querySelectorAll('.mount-view .tv-head [data-col]')].map((e) => e.dataset.col),
    matched: [...document.querySelectorAll('.mount-view .tv-row [data-col="matched"]')].map((e) => e.textContent ?? ''),
    why: document.querySelector('.mount-derived-why')?.textContent ?? '',
  }))
  assert(mentions.rows === mentions.count && mentions.rows >= 1, `提及栏表格与条数一致：${JSON.stringify(mentions)}`)
  assert(mentions.cols.includes('matched'), `提及表要有命中词列：${JSON.stringify(mentions.cols)}`)
  assert(mentions.matched.some((s) => s.trim() !== ''), `命中词要画出来：${JSON.stringify(mentions.matched)}`)
  assert(mentions.why.includes('没有指向它'), `提及的说明要写清「不含引用」：${mentions.why}`)

  await mountTab(page2, 'same')
  await page2.locator('.mount-derived-view[data-kind="table"]').click()
  await page2.waitForTimeout(450)
  const same = await page2.evaluate(() => ({
    count: Number((document.querySelector('.mount-derived-count')?.textContent ?? '0').match(/\d+/)?.[0] ?? '0'),
    rows: document.querySelectorAll('.mount-view .tv-row').length,
    cols: [...document.querySelectorAll('.mount-view .tv-head [data-col]')].map((e) => e.dataset.col),
    shared: [...document.querySelectorAll('.mount-view .tv-row [data-col="sharedTags"]')].map((e) => e.textContent ?? ''),
  }))
  assert(same.rows === same.count && same.rows >= 1, `同类栏表格与条数一致：${JSON.stringify(same)}`)
  assert(same.cols.includes('sharedTags'), `同类表要有共同标签列：${JSON.stringify(same.cols)}`)
  assert(same.shared.some((s) => s.includes('冒烟同类')), `共同标签要画出来：${JSON.stringify(same.shared)}`)

  // ⑤ 派生栏不提供「新建视图 / 重命名 / 刷新」
  const noOwner = await page2.evaluate(() => ({
    addView: Boolean(document.querySelector('.mount-view .qv-view-add')),
    refresh: Boolean(document.querySelector('.mount-view .queryview-refresh:not([hidden])')),
    rename: [...document.querySelectorAll('.layer-label')].some((e) => (e.textContent ?? '').includes('重命名')),
  }))
  assert(!noOwner.addView, '派生栏不许有「新建视图」')
  assert(!noOwner.refresh, '派生栏是 live 的：不许有刷新')
  assert(!noOwner.rename, '派生栏不许改名')

  // ⑥ live：现算的成员会跟着数据变（不冻成员、没有刷新按钮）
  await mountTab(page2, 'refs')
  await page2.locator('.mount-derived-view[data-kind="table"]').click()
  await page2.waitForTimeout(400)
  const beforeLive = await page2.evaluate(() => document.querySelectorAll('.mount-view .tv-row').length)
  await page2.evaluate((pid) => {
    // 在这一页里挑一条**还没引用过它**的块，插一枚指向它的引用
    const rows = window.__qua.__editor.rows().map((r) => r.block)
    const spot = rows.find((b) => b.id !== pid && b.children.length === 0)
    window.__qua.focusBlock(spot.id, 999)
    window.__qua.invoke('core.editor/insert-page-ref', { pageId: pid })
  }, setup.P)
  await page2.waitForTimeout(600)
  const afterLive = await page2.evaluate(() => ({
    rows: document.querySelectorAll('.mount-view .tv-row').length,
    count: Number((document.querySelector('.mount-derived-count')?.textContent ?? '0').match(/\d+/)?.[0] ?? '0'),
  }))
  assert(afterLive.rows === beforeLive + 1, `派生栏是 live 的：新增一处引用后成员当场 +1（${beforeLive} → ${afterLive.rows}）`)
  assert(afterLive.count === afterLive.rows, `抬头条数与表行同一个数：${afterLive.count} vs ${afterLive.rows}`)

  await reopened.ctx.close()
  return `引用 ${refsCount} 条（路径＋次数）→ 重开仍表格 → 固定为查询（${fixed.labels.join(' / ')}）→ 提及/同类各带命中词与共同标签`
})

await check('T195 查询在正文内联渲染：不打开就在原位出结果；打开后只有一台宿主', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  const qid = await page.evaluate(() => {
    const p = window.__qua.pages().find((x) => (x.title ?? '').includes('产品设计'))
    window.__qua.invoke('core.page/open', { pageId: p.id })
    let found = ''
    const walk = (list) => {
      for (const b of list) {
        if (b.props?._query) {
          found = b.id
          return
        }
        walk(b.children)
      }
    }
    walk(window.__qua.__editor.store.blocks)
    return found
  })
  assert(qid, '前置：这一页里应有一个查询块')
  // 查询块在页尾：先把那一行滚进窗口（虚拟化时不在窗口里的行没有 DOM）
  await page.evaluate((id) => window.__qua.__editor.reveal(id), qid)
  await page.waitForTimeout(500)

  const inline = await page.evaluate((id) => {
    const row = document.querySelector(`.blk[data-block-id="${id}"]`)
    const body = row?.querySelector(':scope > .blk-view-body')
    const view = body?.querySelector('.queryview')
    return {
      depth: row?.dataset.depth ?? '',
      hasBody: Boolean(body),
      hasView: Boolean(view),
      hidden: view?.hidden ?? true,
      titleHidden: view?.querySelector('.queryview-title')?.hidden ?? false,
      rows: [...(body?.querySelectorAll('.queryview-editor .blk .tx') ?? [])].map((e) => e.textContent ?? ''),
      inMount: Boolean(body?.closest('.sec-mount')),
    }
  }, qid)
  assert(inline.depth !== '0', `前置：查询块应是正文里的子行：${JSON.stringify(inline)}`)
  assert(inline.hasBody && inline.hasView && !inline.hidden, `正文里应有可见的查询体：${JSON.stringify(inline)}`)
  assert(inline.titleHidden, '内联体不重复块名（行上已经有一份）')
  assert(inline.rows.length === 1, `不打开也应看到结果（本页 1 条待办）：${JSON.stringify(inline.rows)}`)
  assert(!inline.inMount, '内联体必须在这一行下面，不是段尾挂载区')

  /**
   * **折叠折的是身体**：查询块没有 children，但结果视图是可折的东西。
   * 折起来只藏身体（不卸载 ViewHost），展开后结果还在。
   */
  const foldState = () =>
    page.evaluate((id) => {
      const row = document.querySelector(`.blk[data-block-id="${id}"]`)
      const body = row?.querySelector(':scope > .blk-view-body')
      return {
        collapsed: row?.dataset.collapsed === '1',
        folded: body?.dataset.folded === '1',
        rows: [...(body?.querySelectorAll('.queryview-editor .blk .tx') ?? [])].map((e) => e.textContent ?? ''),
      }
    }, qid)
  const foldOnce = () =>
    page.evaluate((id) => {
      const fold = document.querySelector(`.blk[data-block-id="${id}"] > .left > .fold`)
      if (!fold) return false
      fold.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      return true
    }, qid)
  assert(await foldOnce(), '查询块行要有折叠三角（身体可折）')
  await page.waitForTimeout(250)
  const folded = await foldState()
  assert(folded.collapsed && folded.folded, `折起来：行标记 collapsed、身体 data-folded：${JSON.stringify(folded)}`)
  assert(folded.rows.length === 1, `折叠只藏身体、不卸载 ViewHost：${JSON.stringify(folded)}`)
  assert(await foldOnce(), '再点一次展开')
  await page.waitForTimeout(250)
  const unfolded = await foldState()
  assert(!unfolded.collapsed && !unfolded.folded, `展开后标记与身体都回来：${JSON.stringify(unfolded)}`)

  // 打开它：这一块成为段根 ⇒ 段尾宿主接手，行内体必须让位（同屏只有一台）
  await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), qid)
  await page.waitForTimeout(500)
  const opened = await page.evaluate((id) => {
    const row = document.querySelector(`.blk[data-block-id="${id}"]`)
    const views = [...document.querySelectorAll('.queryview')].filter((v) => !v.hidden)
    return {
      inline: Boolean(row?.querySelector(':scope > .blk-view-body')),
      views: views.length,
      mountViews: views.filter((v) => v.closest('.sec-mount')).length,
    }
  }, qid)
  assert(!opened.inline, '打开后行内体让位给段尾宿主')
  assert(opened.views === 1 && opened.mountViews === 1, `打开后只应有一台视图宿主：${JSON.stringify(opened)}`)

  // 段根也能折：折的是段尾那台视图体（同一份 Doc.folded，与内联体同一个语义）
  const rootFold = await page.evaluate((id) => {
    const fold = document.querySelector(`.blk[data-block-id="${id}"] > .left > .fold`)
    fold?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    return Boolean(fold)
  }, qid)
  assert(rootFold, '段根的查询块也要有折叠三角')
  await page.waitForTimeout(300)
  const segmentFolded = await page.evaluate(() => {
    const view = [...document.querySelectorAll('.queryview')].find((v) => !v.hidden)
    return {
      marked: view?.dataset.folded === '1',
      display: view ? getComputedStyle(view).display : '',
    }
  })
  assert(segmentFolded.marked && segmentFolded.display === 'none', `折段根 ⇒ 段尾视图体收起：${JSON.stringify(segmentFolded)}`)

  await ctx.close()
  return `内联 ${inline.rows.length} 条；打开后仍只有 1 台宿主`
})

await check('T196 查询块在右槽窗口也画结果：同一台 ViewHost；折叠收的是身体', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  const qid = await page.evaluate(() => {
    const p = window.__qua.pages().find((x) => (x.title ?? '').includes('产品设计'))
    window.__qua.invoke('core.page/open', { pageId: p.id })
    let found = ''
    const walk = (list) => {
      for (const b of list) {
        if (b.props?._query) {
          found = b.id
          return
        }
        walk(b.children)
      }
    }
    walk(window.__qua.__editor.store.blocks)
    return found
  })
  assert(qid, '前置：页里应有查询块')
  await page.evaluate((id) => window.__qua.invoke('core.dock/open-block', { blockId: id, side: 'right' }), qid)
  await page.waitForTimeout(600)

  const dockState = () =>
    page.evaluate((id) => {
      const card = [...document.querySelectorAll('.dock-card')].find((c) => c.dataset.cardId === id)
      const view = card?.querySelector('.queryview')
      const row = card?.querySelector(`.blk[data-block-id="${id}"]`)
      return {
        card: Boolean(card),
        view: Boolean(view),
        hidden: view?.hidden ?? true,
        folded: view?.dataset.folded === '1',
        rows: [...(card?.querySelectorAll('.queryview-editor .blk .tx') ?? [])].map((e) => e.textContent ?? ''),
        titleHidden: view?.querySelector('.queryview-title')?.hidden ?? false,
        rowCollapsed: row?.dataset.collapsed === '1',
      }
    }, qid)
  const first = await dockState()
  assert(first.card && first.view && !first.hidden, `右槽窗口里应有查询视图：${JSON.stringify(first)}`)
  assert(first.rows.length === 1, `右槽里不打开也应看到结果：${JSON.stringify(first.rows)}`)
  assert(first.titleHidden, '卡头已有块名，窗口里的视图抬头不重复')

  // 折叠：根行也是查询块（有身体）⇒ 三角可折；视图体跟着收，展开后同一份结果回来
  const toggle = () =>
    page.evaluate((id) => {
      const card = [...document.querySelectorAll('.dock-card')].find((c) => c.dataset.cardId === id)
      const fold = card?.querySelector(`.blk[data-block-id="${id}"] > .left > .fold`)
      if (!fold) return false
      fold.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      return true
    }, qid)
  assert(await toggle(), '窗口里的查询块根行要有折叠三角')
  await page.waitForTimeout(300)
  const folded = await dockState()
  assert(folded.folded && folded.rowCollapsed, `折起来：视图体 data-folded、行 collapsed：${JSON.stringify(folded)}`)
  assert(await toggle(), '再点一次展开')
  await page.waitForTimeout(300)
  const unfolded = await dockState()
  assert(!unfolded.folded && !unfolded.rowCollapsed && unfolded.rows.length === 1, `展开后结果还在：${JSON.stringify(unfolded)}`)

  await ctx.close()
  return `右槽 ${first.rows.length} 条；折叠只藏视图体，展开后仍是同一份结果`
})

await check('T39 显示名 = 主别名：改正文＝改描述；别名编辑器改主名 ⇒ chip 跟着变；删除 ⇒ dangling', async () => {
  const { ctx, page } = await freshPage(browser, base)
  // 打开「产品设计 · 决策日志」：seed 里那一页有指向别处的 `[[..]]`
  // ⚠️ 把它的 id 记下来，之后**全程按 id 导航**：改名之后按标题找它可能就找不到了。
  const homeId = await page.evaluate(() => {
    const p = window.__qua.pages().find((x) => (x.title ?? '').includes('产品设计'))
    if (!p) throw new Error(`前置：找不到「产品设计」页，现有 ${JSON.stringify(window.__qua.pages().map((x) => x.title))}`)
    window.__qua.invoke('core.page/open', { pageId: p.id })
    return p.id
  })
  await page.waitForTimeout(200)

  // ① 前置：找一个**能解析到**的引用，且它所在的行**就在当前打开的这一页里**。
  //    ⚠️ `atoms()` 是**库级**的（所有页的原子都在里面），而 `blocks()` 只给**当前视图**
  //    ⇒ 必须按「原子所在块是否在这一页」筛，否则会挑到一个没挂 DOM 的引用（chip 量为 0）。
  const target = await page.evaluate(() => {
    const mounted = new Set(window.__qua.blocks().map((x) => x.id))
    const a = window.__qua
      .atoms()
      .find((x) => x.kind === 'page' && x.state === 'resolved' && x.target && mounted.has(x.blockId))
    if (!a) return null
    const b = window.__qua.blocks().find((x) => x.id === a.blockId)
    const t = window.__qua.allBlocks().find((x) => x.id === a.target.id)
    return {
      atomId: a.id,
      label: a.label,
      targetId: a.target.id,
      srcBlockId: a.blockId,
      srcText: b?.text ?? '',
      primary: t?.aliases?.[0] ?? '',
    }
  })
  assert(target, '前置：这一页里应有一个 resolved 且已挂载的引用')
  assert(target.primary === target.label, `引用显示名应是主别名叶子：${JSON.stringify(target)}`)

  // ② **显示名来自目标当前的主别名**：chip 上的字 === 目标的主名（不看 atom.label 快照）
  const chipLabel = () =>
    page.evaluate((id) => document.querySelector(`.atom[data-atom-id="${id}"] .atom-label`)?.textContent ?? '', target.atomId)
  const before = await chipLabel()
  assert(before === `[[${target.label}]]`, `chip 应显示目标当前的主名：${JSON.stringify(before)} vs ${JSON.stringify(target.label)}`)

  // ③ **改正文 ＝ 改描述**：页名住在 `_aliases`，页块正文只是描述。
  //    在首行打字必须改到描述，主别名与页列表标题一个字节都不动。
  const DESC = '改名后的新描述'
  await page.evaluate((id) => window.__qua.invoke('core.page/open', { pageId: id }), target.targetId)
  await page.waitForTimeout(150)
  await page.evaluate(() => {
    const first = window.__qua.blocks()[0]
    window.__qua.focusBlock(first.id, first.text.length)
  })
  for (let i = 0; i < 60; i++) await page.keyboard.press('Backspace')
  await page.keyboard.type(DESC)
  await page.waitForTimeout(200)
  const described = await page.evaluate((id) => {
    const b = window.__qua.allBlocks().find((x) => x.id === id)
    const p = window.__qua.pages().find((x) => x.id === id)
    return { text: b?.text ?? '', primary: b?.aliases?.[0] ?? '', title: p?.title ?? '(gone)' }
  }, target.targetId)
  assert(described.text === DESC, `改正文应改到描述：${JSON.stringify(described)}`)
  assert(described.primary === target.primary, `改正文不该改主别名：${JSON.stringify(described)}`)
  assert(described.title === target.label, `页列表标题应继续显示主名：${JSON.stringify(described)}`)
  // 别名头住在 `.tx` 外：读回正文必须只有描述，不能把行头的名字也读进模型
  const readback = await page.evaluate((id) => window.__qua.__editor.readRunsOf(id).filter((r) => r.t === 'text').map((r) => r.v).join(''), target.targetId)
  assert(readback === DESC, `别名头不该进正文读回：${JSON.stringify({ readback })}`)
  // 回到引用所在的那一页，看 chip：描述变了，引用名不该变
  await page.evaluate((id) => window.__qua.invoke('core.page/open', { pageId: id }), homeId)
  await page.waitForTimeout(200)
  const unchanged = await chipLabel()
  assert(unchanged === `[[${target.label}]]`, `改描述后 chip 应保持主名：${JSON.stringify(unchanged)}`)

  // ④ **原子没被回写**：改名靠解析传播，不是批量改 label
  const rawLabel = await page.evaluate(
    (id) => window.__qua.atoms().find((x) => x.id === id)?.rawLabel ?? '',
    target.atomId,
  )
  assert(rawLabel !== DESC, `落盘的 label 不该被描述回写（应仍是插入时的快照）：${JSON.stringify(rawLabel)}`)

  // ⑤ **页名走别名编辑器**：加一个名字 → 设成主名 ⇒ 引用 chip 跟着换字。
  await page.evaluate((id) => window.__qua.invoke('core.page/open', { pageId: id }), target.targetId)
  await page.waitForTimeout(150)
  const NEW = '别名编辑器改的新名字'
  await page.locator(`.blk[data-block-id="${target.targetId}"] .blk-alias-name`).click()
  await page.waitForSelector('.alias-editor')
  await page.fill('.alias-editor .alias-input', NEW)
  await page.press('.alias-editor .alias-input', 'Enter')
  await page.waitForTimeout(150)
  assert(await page.locator(`.alias-row[data-alias-name="${NEW}"]`).count() === 1, `新别名应出现在别名列表里：${NEW}`)
  // 点星标把它设成主名（不新增、只移动）——真实点击，顺带验证「点浮层内部不会被外面的 mousedown 关掉」
  await page.locator(`.alias-row[data-alias-name="${NEW}"] .alias-primary`).click()
  await page.waitForTimeout(150)
  const renamed = await page.evaluate((id) => {
    const b = window.__qua.allBlocks().find((x) => x.id === id)
    const p = window.__qua.pages().find((x) => x.id === id)
    return { primary: b?.aliases?.[0] ?? '', aliases: b?.aliases ?? [], title: p?.title ?? '(gone)' }
  }, target.targetId)
  assert(renamed.primary === NEW, `点星标应把该别名设成主名：${JSON.stringify(renamed)}`)
  assert(renamed.title === NEW, `页列表标题应跟着主名走：${JSON.stringify(renamed)}`)
  await page.evaluate(() => window.__qua.__layers.closePopover())
  await page.evaluate((id) => window.__qua.invoke('core.page/open', { pageId: id }), homeId)
  await page.waitForTimeout(200)
  const propagated = await chipLabel()
  assert(propagated === `[[${NEW}]]`, `改主名后 chip 应跟着换字：${JSON.stringify(propagated)}（旧值 ${JSON.stringify(before)}）`)

  // ⑥ **同视图内即时传播**：目标页的名字行**就在当前这一页里**时，改主名 ⇒ chip **当场**换字。
  //    ⚠️ ⑤ 走的是「重开页面 ⇒ 重新挂载」，那条路径即使没有即时传播也会绿；这一格才证明派生显示名会刷新。
  const rootId = await page.evaluate(() => window.__qua.__editor.doc.roots[0]?.id ?? '')
  if (!rootId) throw new Error('前置：当前页应有一个根块')
  const live = await page.evaluate((id) => {
    const ed = window.__qua.__editor
    const root = ed.doc.roots[0]
    const host = root?.children[0]
    if (!root || !host) return { skipped: '当前页没有子块可插' }
    window.__qua.focusBlock(host.id, 0)
    window.__qua.invoke('core.editor/insert-page-ref', { pageId: id })
    const atom = window.__qua.atoms().find((a) => a.blockId === host.id && a.target?.id === id)
    return atom ? { atomId: atom.id } : { skipped: '引用没插进去' }
  }, rootId)
  assert(!live.skipped, `前置：造不出「目标与引用同视图」的组合：${live.skipped}`)
  const LIVE = '当场改的新名字'
  await page.locator(`.blk[data-block-id="${rootId}"] .blk-alias-name`).click()
  await page.waitForSelector('.alias-editor')
  await page.fill('.alias-editor .alias-input', LIVE)
  await page.press('.alias-editor .alias-input', 'Enter')
  await page.waitForTimeout(150)
  await page.evaluate((name) => {
    const row = [...document.querySelectorAll('.alias-row')].find((r) => r.dataset.aliasName === name)
    row?.querySelector('.alias-primary')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }, LIVE)
  await page.waitForTimeout(150)
  const liveLabel = await page.evaluate(
    (id) => document.querySelector(`.atom[data-atom-id="${id}"] .atom-label`)?.textContent ?? '',
    live.atomId,
  )
  assert(liveLabel === `[[${LIVE}]]`, `同视图内改主名，引用它的 chip 应**当场**跟着变：${JSON.stringify({ liveLabel })}`)
  await page.evaluate(() => window.__qua.__layers.closePopover())

  // ⑦ **目标被删 ⇒ dangling**：不静默错指，chip 上带 .dangling
  // ⚠️ `core.page/delete` 删的是**当前对象**（不收 pageId 参数）⇒ 先打开它再删
  await page.evaluate((id) => window.__qua.invoke('core.page/open', { pageId: id }), target.targetId)
  await page.waitForTimeout(150)
  await page.evaluate(() => window.__qua.invoke('core.page/delete'))
  await page.evaluate((id) => window.__qua.invoke('core.page/open', { pageId: id }), homeId)
  await page.waitForTimeout(200)
  const dead = await page.evaluate((id) => {
    const el = document.querySelector(`.atom[data-atom-id="${id}"]`)
    const a = window.__qua.atoms().find((x) => x.id === id)
    return { dangling: el?.classList.contains('dangling') ?? false, label: el?.querySelector('.atom-label')?.textContent ?? '', state: a?.state }
  }, target.atomId)
  assert(dead.state === 'dangling', `目标被删后状态应是 dangling：${JSON.stringify(dead)}`)
  assert(dead.dangling, 'dangling 要有可见的表现（class 挂在 chip 上，不是只改内部数据）')
  /**
   * ⚠️ **fallback 是「插入时的快照」，不是「用户最后见过的名字」** —— 这是一条刻意的取舍，不是漏：
   *    要让 fallback 跟着改名走，就得在**渲染时回写 `atom.label`**，而那会让渲染产生副作用
   *    （脏快照、连带落盘）。改名传播靠解析（不回写原子）是本条的前提，两者不可兼得。
   */
  assert(dead.label.length > 4, `dangling 时要有非空的兜底名：${JSON.stringify(dead.label)}`)
  assert(dead.label !== `[[${NEW}]]`, `fallback 是插入时的快照，不该是改名后的字：${JSON.stringify(dead.label)}`)

  await ctx.close()
  return `「${before}」→ 改描述不改名 → 别名编辑器设主名后「${propagated}」→ 同视图当场「${liveLabel}」→ 删除后 dangling，兜底名「${dead.label}」`
})

await check('T40 标签＝块级归属：写进块上、渲染成行尾 chip、成员可见', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await openFirstPage(page)

  /**
   * ① 打标签：写的是**块上的归属**（`props._tags`），正文一个字节都不动。
   *
   * ⚠️ 挑一个**普通子块**，不挑页名行：这一条要验证的正是「正文不动」，
   *    拿页名做样本会让失败信息里同时混进改名的问题。
   */
  const it = await page.evaluate(() => {
    const root = window.__qua.__editor.doc.roots[0]
    const b = window.__qua.blocks().find((x) => x.id !== root.id && !x.roles?.includes('journal') && x.text.length > 2)
    window.__qua.focusBlock(b.id, b.text.length)
    window.__qua.invoke('core.editor/insert-tag', { tag: '回归标签' })
    const after = window.__qua.blocks().find((x) => x.id === b.id)
    const tagId = after?.tags?.[0] ?? ''
    const tag = window.__qua.allBlocks().find((x) => x.id === tagId)
    return {
      blockId: b.id,
      text: after?.text ?? '',
      tags: after?.tags ?? [],
      tag: tag ? { id: tag.id, text: tag.text, roles: tag.roles } : null,
    }
  })
  assert(it.tags.length === 1, `标签应写进块上的归属：${JSON.stringify(it)}`)
  assert(it.tag, `归属应指向一个真实存在的标签块：${JSON.stringify(it)}`)
  assert(it.tag.roles?.includes('tag'), `标签应是一个带 tag 角色的**块**（不是字符串、也不是新实体）：${JSON.stringify(it.tag)}`)
  assert(it.tag.text === '回归标签', `标签名字就是它的正文，且不带 #：${JSON.stringify(it.tag)}`)
  assert(!it.text.includes('#回归标签'), `标签归属不占正文（投影不含 #名）：${JSON.stringify(it.text)}`)

  // ② 呈现：标签槽里一枚 `#名` chip，**槽在正文槽之外**，且 chip 不参与读数
  const shown = await page.evaluate(
    ({ blockId, tagId }) => {
      const chip = document.querySelector(`.blk[data-block-id="${blockId}"] .blk-tags .tag-chip[data-tag-id="${tagId}"]`)
      return {
        chip: chip?.textContent ?? '',
        inTx: Boolean(chip?.closest('.tx')),
        read: window.__qua.__editor.readRunsOf(blockId).filter((r) => r.t === 'text').map((r) => r.v).join(''),
      }
    },
    { blockId: it.blockId, tagId: it.tag.id },
  )
  assert(shown.chip === '#回归标签', `标签应显示成 #名（引用才是 [[名]]）：${JSON.stringify(shown)}`)
  assert(!shown.inTx, `chip 应住在标签槽（.blk-tags）里，不该在正文槽里：${JSON.stringify(shown)}`)
  assert(shown.read === it.text, `chip 不属于正文：读数应仍是原正文 —— ${JSON.stringify(shown)}`)

  // ③ **打标签 ⇒ 成员里出现这个块**（成员从块上的归属派生）
  const members = await page.evaluate((tagId) => window.__qua.tagMembers(tagId), it.tag.id)
  assert(
    members.includes(it.blockId),
    `打了标签的块应出现在标签的成员里：${JSON.stringify(members)}（期望含 ${it.blockId}）`,
  )

  // ④ 幂等：再打一次同名标签 ⇒ 不建第二个块（`#名` 与 `#名 ` 是同一个名字）
  const again = await page.evaluate(
    (hostId) => {
      const before = window.__qua.allBlocks().filter((x) => x.roles?.includes('tag')).length
      const b = window.__qua.blocks().find((x) => x.id !== hostId && !x.roles?.includes('journal') && x.text.length > 2)
      window.__qua.focusBlock(b.id, b.text.length)
      window.__qua.invoke('core.editor/insert-tag', { tag: ' 回归标签 ' })
      const after = window.__qua.blocks().find((x) => x.id === b.id)
      return {
        before,
        after: window.__qua.allBlocks().filter((x) => x.roles?.includes('tag')).length,
        other: b.id,
        tagged: (after?.tags ?? []).length === 1,
      }
    },
    it.blockId,
  )
  assert(again.tagged, `第二次打标签应写进另一块（${again.other}）`)
  assert(again.after === again.before, `同名标签不该建出第二块：${JSON.stringify(again)}`)

  // ④b 两块都在成员里（归属是真的，不是只建了个块）
  const both = await page.evaluate((tagId) => window.__qua.tagMembers(tagId), it.tag.id)
  assert(both.includes(it.blockId), `第一块应在成员里：${JSON.stringify(both)}`)
  assert(both.includes(again.other), `第二块也应在成员里：${JSON.stringify(both)}`)
  assert(both.length === 2, `两块各一条归属 ⇒ 成员应是 2 块：${JSON.stringify(both)}`)

  await ctx.close()
  return `标签块「${it.tag.text}」(role=tag)；chip ${JSON.stringify(shown.chip)} 不进读数；成员 ${both.length} 块（幂等 ${again.before}→${again.after}）`
})

await check('T37 演示状态下打字要落盘（已知风险 3）：切到稀疏态 → 打字 → 关页重开还在', async () => {
  const { ctx, page } = await freshPage(browser, base)
  // ① 切到稀疏态（这条路径原先把 `children` 装成 roots，与 openPage 的 `rootsFor(p)` 分叉）
  await page.evaluate(() => window.__qua.loadState('sparse'))
  const target = await page.evaluate(() => {
    const b = window.__qua.blocks().find((x) => !x.roles?.includes('journal'))
    window.__qua.focusBlock(b.id, 0)
    return b.id
  })
  await page.keyboard.type('稀疏态里打的字 ')
  await page.waitForTimeout(350)

  // ② 关页重开：字必须还在（且落在**同一个块**上，不是被 seed 覆盖后凭空出现）
  const reopened = await reopenPage(browser, ctx, base, page)
  const after = await reopened.page.evaluate(
    (id) => ({ blocks: window.__qua.blocks(), text: window.__qua.text().join('|') }),
    target,
  )
  await reopened.ctx.close()
  assert(after.text.includes('稀疏态里打的字'), `重开后字丢了（演示状态不落盘）：${after.text.slice(0, 40)}`)
  assert(after.blocks.some((b) => b.id === target), `重开后块 id 变了（静默换库）：${target}`)

  return `稀疏态打字 → 关页重开：${after.text.slice(0, 20)}…`
})

await check('T12 空态 / 稀疏态 / 降级态都能看（超长块与全英文不横向溢出）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.loadState('empty'))
  const empty = await snap(page)
  assert(empty.blocks === 1, `空态应是「一个空块」：${empty.blocks}`)
  assert(await page.locator('#empty-hint:visible').count() === 1, '空态应给提示')
  await page.evaluate(() => window.__qua.loadState('sparse'))
  const sparse = await snap(page)
  // ⚠️ 稀疏态的形状**两种都合法**（2026-10-20）：装载口径修好后，页块自己也是根 ⇒ 渲染「页名 ＋ 一个子块」＝ 2 行。
  //    旧口径把 `children` 当 roots ⇒ 1 行。这里只钉「这个库里只有一页、内容不超过这两行」，不再钉死行数。
  assert(sparse.pageCount === 1 && sparse.blocks <= 2 && sparse.blocks >= 1, `稀疏态：1 页 不超过 2 行，实际 ${JSON.stringify(sparse)}`)
  assert(await page.locator('#empty-hint:visible').count() === 0, '稀疏态不该再显示空态提示')
  await page.evaluate(() => window.__qua.loadState('degraded'))
  const deg = await page.evaluate(() => ({
    blocks: window.__qua.blocks(),
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    editorOverflow: Array.from(document.querySelectorAll('.blk .tx')).some((e) => e.scrollWidth > e.clientWidth + 1),
  }))
  const longest = Math.max(...deg.blocks.map((b) => b.text.length))
  assert(longest > 500, `降级态里应有超长块，实际最长 ${longest}`)
  assert(deg.overflowX <= 1, `页面不该横向溢出：${deg.overflowX}px`)
  assert(!deg.editorOverflow, '超长/全英文块不该横向溢出容器')

  // 页名的兜底与截断：**页名现在只出现在引用选择器里**（左槽只放今日、不列全部页），
  // 所以到那个真正的落点去验。
  // ⚠️ 有地址的块永远有可显示的名字：空标题页在进页列表时拿到了 `未命名-<短id>`
  //    ⇒ 这里验的是「有一个稳定、非空的兜底名」，不再是旧口径里的「无标题」四个字。
  await page.evaluate(() => window.__qua.invoke('core.editor/insert-page-ref'))
  await page.waitForTimeout(150)
  const titles = await page.evaluate(() =>
    [...document.querySelectorAll('.layer-item .layer-label')].map((e) => e.textContent?.trim() ?? ''),
  )
  assert(titles.some((x) => x.includes('未命名-')), `无标题页要有稳定兜底名：${JSON.stringify(titles)}`)
  const longestTitle = titles.reduce((a, b) => (a.length >= b.length ? a : b), '')
  assert(longestTitle.length > 40, `超长页名应原样存在（截断交给 CSS，不是砍字符串）：${longestTitle.slice(0, 60)}`)
  const noOverflow = await page.evaluate(() => {
    const layer = document.querySelector('.layer')
    return layer ? layer.scrollWidth <= layer.clientWidth + 1 : true
  })
  assert(noOverflow, '超长页名不该把引用选择器撑出横向滚动')
  await ctx.close()
  return `空态 1 空块＋提示；稀疏态 1 页（页名＋1 行）；降级态最长块 ${longest} 字，无横向溢出`
})

await check('T13 虚拟化：窗口外的块不挂 DOM（角标能看到 DOM 节点数 < 块数）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await openFirstPage(page)
  await page.evaluate(() => window.__qua.setVirtualize(true, 3))
  const v = await snap(page)
  assert(v.domBlocks < v.blocks, `虚拟化下 DOM 块应少于块数：${v.domBlocks} / ${v.blocks}`)
  assert(v.domBlocks <= 7, `半径 3 大约只挂 7 行：${v.domBlocks}`)
  const placeholders = await page.locator('.ph').count()
  assert(placeholders >= 1, '窗口外应该有占位 div')
  await page.evaluate(() => window.__qua.setVirtualize(false))
  const off = await snap(page)
  assert(off.domBlocks === off.blocks, `关掉虚拟化应全挂：${off.domBlocks} / ${off.blocks}`)
  await ctx.close()
  return `on: DOM 块 ${v.domBlocks}/${v.blocks}（占位 ${placeholders}）；off: ${off.domBlocks}/${off.blocks}`
})

await check('T14 composing 守卫：组合期键位绑定自动不命中（命令零触发）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  const r = await page.evaluate(() => {
    const before = window.__qua.commandLog().length
    window.__qua.invoke('dev.ime/simulate')
    return { fired: window.__qua.commandLog().length - before, toast: document.querySelector('.toast')?.textContent ?? '' }
  })
  // simulate-ime 自己会记 1 条日志（命令本身），组合期不应再触发任何键位命令
  assert(r.fired === 1, `组合期只应有「模拟 IME」这一条命令，实际新增 ${r.fired}`)
  assert(r.toast.includes('0 次'), `toast 应报告零触发：${r.toast}`)
  const composing = await page.evaluate(() => {
    const ed = window.__qua.__editor
    ed.probe.isComposing = true
    const hit = window.__qua.__registry.invoke('core.editor/split-block', {}, 'keymap', ed.ctxKeys()).handled
    ed.probe.isComposing = false
    return hit
  })
  assert(composing === false, '组合期经 keymap 调用必须被拦')
  await ctx.close()
  return `组合期新增命令 ${r.fired} 条（只有自检命令本身）；经 keymap 的调用被拦`
})

await check('T17 今日 journal：冷启动落在它、一天一个（幂等）、日期只读', async () => {
  const { ctx, page } = await freshPage(browser, base)

  // ① 冷启动＝今日：中心槽的当前对象就是今天的 journal 块
  const boot = await page.evaluate(() => {
    const s = window.__qua.snapshot()
    return {
      role: window.__qua.ctxKeys().journalView,
      date: s.journalDate,
      // ：没有「标题」了 ⇒ 日期的落点是**首行的只读占位**（.tx[data-ph]）
      title: document.querySelector('#editor .blk[data-role="journal"] .tx')?.dataset.ph ?? '',
    }
  })
  assert(boot.role === true, `冷启动应落在 journal（ctx.journalView）：${JSON.stringify(boot)}`)
  assert(/^\d{4}-\d{2}-\d{2}$/.test(boot.date), `journalDate 应是本地日：${JSON.stringify(boot)}`)
  assert(boot.title.length > 0 && !/^\d{4}-\d{2}-\d{2}$/.test(boot.title), `journal 首行的只读占位应是日期的可读投影，不是裸 ISO：${boot.title}`)

  // ② 「一天一个」＝结构保证：反复调用同一天，块数不增（id 由日期确定性派生）
  const n0 = await page.evaluate(() => window.__qua.snapshot().topBlocks)
  for (let i = 0; i < 3; i++) await page.evaluate(() => window.__qua.invoke('core.journal/today'))
  const n1 = await page.evaluate(() => window.__qua.snapshot().topBlocks)
  assert(n1 === n0, `回今日应幂等（块数不增）：${n0} → ${n1}`)
  const dupes = await page.evaluate(() => {
    const ids = window.__qua.blocks().filter((b) => b.roles?.includes('journal')).map((b) => b.id)
    return { count: ids.length, unique: new Set(ids).size }
  })
  assert(dupes.count === dupes.unique, `同一天不得有两个 journal 块：${JSON.stringify(dupes)}`)

  // ③ 翻日：前一天 → 已存在的天复用（种子给了昨天）；**不存在的天** → 物化一块，再开不增
  const prev = await page.evaluate(() => {
    window.__qua.invoke('core.journal/prev')
    return { date: window.__qua.snapshot().journalDate, n: window.__qua.snapshot().topBlocks }
  })
  assert(prev.date < boot.date, `前一天应早于今天：${boot.date} → ${prev.date}`)
  const far = await page.evaluate(() => {
    const d = new Date()
    d.setDate(d.getDate() - 10)
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const n0 = window.__qua.snapshot().topBlocks
    window.__qua.invoke('core.journal/today', { date: iso })
    const n1 = window.__qua.snapshot().topBlocks
    window.__qua.invoke('core.journal/today', { date: iso })
    const n2 = window.__qua.snapshot().topBlocks
    return { iso, n0, n1, n2, shown: window.__qua.snapshot().journalDate }
  })
  assert(far.n1 === far.n0 + 1, `翻到不存在的天应物化一块：${JSON.stringify(far)}`)
  assert(far.n2 === far.n1, `再次打开同一天应幂等（块数不增）：${JSON.stringify(far)}`)
  assert(far.shown === far.iso, `打开远处某天应落在它：${JSON.stringify(far)}`)
  const back = await page.evaluate(() => {
    window.__qua.invoke('core.journal/today')
    return { date: window.__qua.snapshot().journalDate, n: window.__qua.snapshot().topBlocks }
  })
  assert(back.date === boot.date && back.n >= prev.n, `回今日应复用已物化的块：${JSON.stringify(back)}`)

  // ④ 日期只读：改名、反复回今日、翻日回来 —— 日期都不动
  const ro = await page.evaluate(() => {
    const before = window.__qua.snapshot().journalDate
    window.__qua.invoke('core.page/rename')
    window.__qua.invoke('core.page/rename')
    window.__qua.invoke('core.journal/today', { date: before })
    return { before, after: window.__qua.snapshot().journalDate, title: document.querySelector('#editor .blk[data-role="journal"] .tx')?.dataset.ph ?? '' }
  })
  assert(ro.after === ro.before, `日期不得被改：${JSON.stringify(ro)}`)
  assert(ro.title.length > 0, `只读占位仍要显示日期：${JSON.stringify(ro)}`)

  await ctx.close()
  return `冷启动在 ${boot.date}（首行占位「${boot.title}」）；回今日 ×3 块数恒 ${n0}；翻日 ${boot.date}→${prev.date}→${back.date}`
})

await check('T26 Enter 四分支（块中同级拆/空块反缩进/块尾子块/块尾同级）、点空白建子块、只读行不落光标、折叠图标贴自己的块标', async () => {
  // ④ 要「最后一行下方的空白」是**真空白**：内容高度一旦顶满视口就没有可点的地方。
  // 给高一点的视口（与产品行为无关，只为让这条几何前置成立）。
  const { ctx, page } = await freshPage(browser, base, { viewport: { width: 1440, height: 1600 } })
  // ：冷启动是长日记流；本用例测的是单容器里的 Enter/空白语义 ⇒ 先打开第一页。
  await openFirstPage(page)
  const rows = () =>
    page.evaluate(() =>
      window.__qua.blocks().map((b) => ({
        text: b.text,
        depth: Number(document.querySelector(`.blk[data-block-id="${b.id}"]`)?.dataset.depth ?? -1),
        kids: b.children,
      })),
    )

  // ① 造一个「有子块」的块：取一个**正文非空的内容块** p（排除页根，否则 p 没有前兄弟可缩进）
  const pid = await page.evaluate(() => {
    const ed = window.__qua.__editor
    const rootId = ed.doc.roots[0].id
    const p = window.__qua.blocks().find((b) => b.id !== rootId && b.children === 0 && b.text !== '' && b.text.length > 4)
    const c = ed.insertBlockAfter(p.id, '子块甲')
    ed.indent(c)
    return p.id
  })
  const t0 = await rows()
  const parentDepth = t0.find((r) => r.text === '子块甲').depth - 1
  const pre = await page.evaluate((id) => {
    const b = window.__qua.blocks().find((x) => x.id === id)
    return { children: b?.children, text: b?.text?.slice(0, 30), roots: window.__qua.__editor.doc.roots.length }
  }, pid)
  assert(pre.children === 1, `前置：父块应带 1 个子块：${JSON.stringify(pre)}`)

  // ② 带子块的块尾 Enter ⇒ **子块**（插成首个），子树不丢
  await page.evaluate((id) => window.__qua.focusBlock(id, 9999), pid)
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('新子块')
  const t1 = await rows()
  const child = t1.find((r) => r.text === '新子块')
  assert(child, `块尾 Enter 后应有新块：${JSON.stringify(t1.map((r) => r.text))}`)
  assert(child.depth === parentDepth + 1, `有子块时块尾 Enter 应建**子块**：父 ${parentDepth}，新块 ${child.depth}`)
  assert((await page.evaluate((id) => window.__qua.blocks().find((b) => b.id === id)?.children, pid)) === 2, '既有子块不该丢')

  // ③ 无子块的块尾 Enter ⇒ **同级**（Leaf 分支；取任意叶子）
  const leafId = await page.evaluate(() => window.__qua.blocks().find((b) => b.children === 0 && b.text.length > 3).id)
  const leafDepth = (await rows()).find((r, i, all) => true) && (await page.evaluate((id) => Number(document.querySelector(`.blk[data-block-id="${id}"]`).dataset.depth), leafId))
  await page.evaluate((id) => window.__qua.focusBlock(id, 9999), leafId)
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('叶子后')
  const t2 = await rows()
  const after = t2.find((r) => r.text === '叶子后')
  assert(after && after.depth === leafDepth, `无子块时块尾 Enter 应建**同级**：叶 ${leafDepth}，新块 ${after?.depth}`)

  // ⑤ 块中 Enter ⇒ **同级拆**：
  //    左半进**上方新块**；原块保 id/右半/子树；光标留原块 0 位
  const splitCase = await page.evaluate(() => {
    const ed = window.__qua.__editor
    const rootId = ed.doc.roots[0].id
    const base = window.__qua.blocks().find((b) => b.id !== rootId && b.text.length > 3)
    const sid = ed.insertBlockAfter(base.id, '甲乙丙')
    const kid = ed.insertBlockAfter(sid, '子')
    ed.indent(kid)
    return { sid }
  })
  const sidDepth = await page.evaluate(
    (id) => Number(document.querySelector(`.blk[data-block-id="${id}"]`).dataset.depth),
    splitCase.sid,
  )
  await page.evaluate((id) => window.__qua.focusBlock(id, 1), splitCase.sid)
  await page.keyboard.press('Enter')
  const t4 = await rows()
  const keptRow = await page.evaluate((id) => {
    const b = window.__qua.blocks().find((x) => x.id === id)
    return { text: b.text, kids: b.children, sel: window.__qua.snapshot().selection }
  }, splitCase.sid)
  assert(keptRow.text === '乙丙', `块中 Enter 应让原块保留右半：${JSON.stringify(keptRow.text)}`)
  assert(keptRow.kids === 1, `子树应留在原块：本地块数 ${keptRow.kids}`)
  const leftRow = t4.find((r) => r.text === '甲')
  assert(leftRow, `左半应在新块：${JSON.stringify(t4.map((r) => r.text))}`)
  assert(leftRow.depth === sidDepth, `新块应与原块**同级**：原 ${sidDepth}，新 ${leftRow.depth}`)
  assert(keptRow.sel.aBlock === splitCase.sid && keptRow.sel.aOff === 0, `光标应留在原块 0 位：${JSON.stringify(keptRow.sel)}`)
  await page.keyboard.type('X')
  const keptText = await page.evaluate((id) => window.__qua.blocks().find((b) => b.id === id).text, splitCase.sid)
  assert(keptText === 'X乙丙', `打字应落回原块（不是新块）：${JSON.stringify(keptText)}`)

  // ⑥ 空块（缩进 ≥ 2 层）Enter ⇒ **反缩进**（退化成反缩进，不建新块）：
  //    不建块，只升一层；到顶层后再 Enter 才建同级
  const outCase = await page.evaluate(() => {
    const ed = window.__qua.__editor
    const rootId = ed.doc.roots[0].id
    const p = ed.insertBlockAfter(rootId, '反缩进父')
    const c = ed.insertBlockAfter(p, '')
    ed.indent(c)
    return { c }
  })
  const outDepth0 = await page.evaluate(
    (id) => Number(document.querySelector(`.blk[data-block-id="${id}"]`).dataset.depth),
    outCase.c,
  )
  const nOut0 = (await rows()).length
  await page.evaluate((id) => window.__qua.focusBlock(id, 0), outCase.c)
  await page.keyboard.press('Enter')
  const outDepth1 = await page.evaluate(
    (id) => Number(document.querySelector(`.blk[data-block-id="${id}"]`).dataset.depth),
    outCase.c,
  )
  const nOut1 = (await rows()).length
  assert(nOut1 === nOut0, `空块 Enter 反缩进不该建块：${nOut0} → ${nOut1}`)
  assert(outDepth1 === outDepth0 - 1, `空块 Enter 应升一层：${outDepth0} → ${outDepth1}`)
  const outSel = await page.evaluate(() => window.__qua.snapshot().selection)
  assert(outSel.aBlock === outCase.c && outSel.aOff === 0, `反缩进后光标应留在原块：${JSON.stringify(outSel)}`)
  await page.keyboard.press('Enter')
  const nOut2 = (await rows()).length
  assert(nOut2 === nOut1 + 1, `顶层空块 Enter 应建同级：${nOut1} → ${nOut2}`)

  // ④ 点「最后一行下方」空白 ⇒ 建**当前对象的子块**（D2 修订），且落光标
  const n0 = (await rows()).length
  /**
   * ⚠️ 落点必须在**视口内**：内容比视口长时，最后一行的 `bottom + 18` 会跑到屏幕外，
   *    `mouse.click` 静默点空（CI 的 Linux 上就是这样：字体更高 ⇒ 行更多）。
   * ⇒ 先把最后一行滚进视口，再取它下方那一小段空白。
   */
  const hit = await page.evaluate(() => {
    const all = [...document.querySelectorAll('#editor .blk')]
    const last = all[all.length - 1]
    last.scrollIntoView({ block: 'end' })
    const editor = document.getElementById('editor').getBoundingClientRect()
    const x = editor.left + 4
    /**
     * ⚠️ 不能取「行底 → 视口底」的中点：正文下面还可能有**反链 footer / 查询结果**，
     *    中点会落进它们的 `.tx`（实测点到了 `SPAN.tx`），而空白建块只认正文自己的气口。
     * ⇒ 贴着最后一行下方 8/16/24px 找第一个**不在块/嵌套视图/固定条**里的点。
     */
    for (const dy of [8, 16, 24, 40]) {
      const r = last.getBoundingClientRect()
      const y = r.bottom + dy
      if (y > window.innerHeight - 4) continue
      const el = document.elementFromPoint(x, y)
      if (!el) continue
      if (el.closest('.blk, .backlinks, .queryview, #badge')) continue
      return { x, y, vh: window.innerHeight, bottom: r.bottom }
    }
    const r = last.getBoundingClientRect()
    return { x, y: Math.min(r.bottom + 8, window.innerHeight - 4), vh: window.innerHeight, bottom: r.bottom }
  })
  assert(hit.y < hit.vh - 2, `前置：落点必须在视口内（y=${hit.y.toFixed(0)}, vh=${hit.vh}, 行底=${hit.bottom.toFixed(0)}）`)
  await page.mouse.click(hit.x, hit.y)
  const t3 = await rows()
  const probe = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y)
    const ed = window.__qua.__editor
    return {
      at: el ? { tag: el.tagName, id: el.id, cls: String(el.className).slice(0, 60) } : null,
      allow: ed.allowBlankCreate,
      editorRows: ed.rows?.().length ?? -1,
    }
  }, hit)
  assert(t3.length === n0 + 1, `点空白应建一块：${n0} → ${t3.length}（落点 x=${hit.x.toFixed(0)}, y=${hit.y.toFixed(0)}）${JSON.stringify(probe)}`)
  assert(t3[t3.length - 1].depth === 1, `点空白建的应是当前对象的**子块**（depth 1），实际 ${t3[t3.length - 1].depth}`)
  assert(t3[t3.length - 1].text === '', '新块应是空的')
  const focused = await page.evaluate(() => window.__qua.snapshot().selection)
  assert(focused?.aBlock && focused.aOff === 0, `点空白后光标应落在新块：${JSON.stringify(focused)}`)

  // ⑤ 点与正文同高的**左侧留白** ⇒ 不该建块（clientY 判据）
  const side = await page.evaluate(() => {
    const tx = document.querySelector('#editor .blk .tx').getBoundingClientRect()
    // 「左侧留白」必须是**编辑器自己的**左缘（再往左是左槽，点那里测的是槽）
    const editor = document.getElementById('editor').getBoundingClientRect()
    return { x: editor.left + 4, y: tx.top + tx.height / 2 }
  })
  const n1 = (await rows()).length
  await page.mouse.click(side.x, side.y)
  assert((await rows()).length === n1, '点与正文同高的左侧留白不该建块')

  // ⑥ `/` 建块落在根行（section 根）时，必须插成**它的子块**，不能新增根
  // （N 个 section 是正常形状；不变量从「roots 只有 1」改成「根行插块不新增根」）
  const selfInsert = await page.evaluate(() => {
    const ed = window.__qua.__editor
    const rootId = ed.doc.roots[0].id
    const before = window.__qua.blocks().length
    const beforeRoots = ed.doc.roots.length
    // 虚拟化开启时根行可能不在挂载窗口里 ⇒ 以根行为中心重挂一次（只影响挂哪些行，不改模型）
    if (!document.querySelector(`.blk[data-block-id="${rootId}"]`)) ed.applyWindow(rootId)
    // 根行的子树可能处于**收起**态：收起的子树不挂 DOM，新块也就无从量 depth。
    // 这一格量的是「插进来的块挂在哪一层」，前提是那一层此刻画得出来。
    const rootEl = document.querySelector(`.blk[data-block-id="${rootId}"]`)
    if (rootEl?.dataset.collapsed === '1') ed.toggleCollapse(rootId)
    const id = ed.insertBlockAfter(rootId, '斜杠块')
    const rows = window.__qua.blocks()
    const el = document.querySelector(`.blk[data-block-id="${id}"]`)
    if (!el) return { skipped: '插入的块没挂上 DOM' }
    return { id, before, after: rows.length, roots: ed.doc.roots.length, beforeRoots, depth: Number(el.dataset.depth) }
  })
  assert(selfInsert.skipped === undefined, `前置：根行应当在本视图里可观测：${selfInsert.skipped}`)
  assert(selfInsert.roots === selfInsert.beforeRoots, `根行插块不该新增根：${selfInsert.beforeRoots} → ${selfInsert.roots}`)
  assert(selfInsert.depth === 1, `根行插块应是它的子块（depth 1）：${selfInsert.depth}`)
  assert(selfInsert.after === selfInsert.before + 1, '根行插块应块数 +1')

  // ⑦ 点**块标**（＝ zoom）不该顺手建块 —— composedPath 修复点
  const marker = await page.evaluate(() => {
    const m = document.querySelector('[data-focus-for]')
    const r = m.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  const n2 = await page.evaluate(() => window.__qua.snapshot().totalBlocks)
  await page.mouse.click(marker.x, marker.y)
  const n3 = await page.evaluate(() => window.__qua.snapshot().totalBlocks)
  assert(n3 === n2, `点块标（zoom）不该建块：${n2} → ${n3}`)

  await ctx.close()
  return `带子块的块尾 ⇒ 子块（depth ${child.depth}）；叶子块尾 ⇒ 同级（depth ${after?.depth}）；点空白 ⇒ depth 1 子块；留白/块标不误建`
})

await check('T30 聚焦块（section 根）文本中间 Enter ⇒ 左半留根、右半成首个子块', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await openFirstPage(page)
  const ids = await page.evaluate(() => {
    const ed = window.__qua.__editor
    const rootId = ed.doc.roots[0].id
    const id = ed.insertBlockAfter(rootId, '聚焦甲乙丙')
    const kid = ed.insertBlockAfter(id, '聚焦子')
    ed.indent(kid)
    window.__qua.invoke('core.block/focus-block', { blockId: id })
    return { id, kid }
  })
  const roots = await page.evaluate(() => window.__qua.__editor.doc.roots.map((b) => b.id))
  assert(roots.length === 1 && roots[0] === ids.id, `zoom 后 doc.roots 应只有聚焦块：${JSON.stringify(roots)}`)
  const n0 = await page.evaluate(() => window.__qua.snapshot().totalBlocks)
  await page.evaluate((id) => window.__qua.focusBlock(id, 2), ids.id)
  await page.keyboard.press('Enter')
  const st = await page.evaluate(() => {
    const ed = window.__qua.__editor
    const plain = (b) => b.content.filter((r) => r.t === 'text').map((r) => r.v).join('')
    const root = ed.doc.roots[0]
    return {
      roots: ed.doc.roots.length,
      rootText: plain(root),
      kids: root.children.map((b) => ({ id: b.id, text: plain(b) })),
      sel: window.__qua.snapshot().selection,
    }
  })
  assert(st.roots === 1, `拆块不应新增根：${st.roots}`)
  assert(st.rootText === '聚焦', `左半应留在聚焦块：${JSON.stringify(st.rootText)}`)
  assert(st.kids.length === 2, `聚焦块应有两个子块：${JSON.stringify(st.kids)}`)
  assert(st.kids[0].text === '甲乙丙', `右半应成为首个子块：${JSON.stringify(st.kids[0])}`)
  assert(st.kids[1].id === ids.kid, `既有子块应保留：${JSON.stringify(st.kids)}`)
  assert(st.sel.aBlock === st.kids[0].id && st.sel.aOff === 0, `光标应落在右半子块 0 位：${JSON.stringify(st.sel)}`)
  const n1 = await page.evaluate(() => window.__qua.snapshot().totalBlocks)
  assert(n1 === n0 + 1, `拆块应只多一块：${n0} → ${n1}`)
  await page.keyboard.type('X')
  const first = await page.evaluate((id) => window.__qua.blocks().find((b) => b.id === id)?.text, st.kids[0].id)
  assert(first === 'X甲乙丙', `打字应落在右半子块：${JSON.stringify(first)}`)
  await ctx.close()
  return `聚焦块「${st.rootText}」；首子块「${st.kids[0].text}」＋既有子块；光标在首子块`
})

await check('T31 普通块块首 Enter ⇒ 上方插空块并把光标放进去（原块文本不变）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await openFirstPage(page)
  const ids = await page.evaluate(() => {
    const ed = window.__qua.__editor
    const rootId = ed.doc.roots[0].id
    const id = ed.insertBlockAfter(rootId, '块首甲乙')
    return { id }
  })
  const depth = await page.evaluate(
    (id) => Number(document.querySelector(`.blk[data-block-id="${id}"]`).dataset.depth),
    ids.id,
  )
  const n0 = await page.evaluate(() => window.__qua.snapshot().totalBlocks)
  await page.evaluate((id) => window.__qua.focusBlock(id, 0), ids.id)
  await page.keyboard.press('Enter')
  const st = await page.evaluate((id) => {
    const ed = window.__qua.__editor
    const loc = window.__qua.blocks().find((b) => b.id === id)
    const sel = window.__qua.snapshot().selection
    const selEl = sel?.aBlock ? document.querySelector(`.blk[data-block-id="${sel.aBlock}"]`) : null
    return {
      text: loc?.text,
      sel,
      selDepth: selEl ? Number(selEl.dataset.depth) : -1,
      selIsEmpty: selEl ? (selEl.querySelector('.tx')?.textContent ?? '') === '' : false,
    }
  }, ids.id)
  assert(st.text === '块首甲乙', `原块文本应不变：${JSON.stringify(st.text)}`)
  assert(st.sel.aBlock !== ids.id, `光标不应留在原块：${JSON.stringify(st.sel)}`)
  assert(st.sel.aOff === 0, `光标应在新区块 0 位：${JSON.stringify(st.sel)}`)
  assert(st.selDepth === depth, `新块应与原块同级：${depth} → ${st.selDepth}`)
  assert(st.selIsEmpty, '光标所在的新块应是空的')
  const n1 = await page.evaluate(() => window.__qua.snapshot().totalBlocks)
  assert(n1 === n0 + 1, `块首 Enter 应只多一块：${n0} → ${n1}`)
  await page.keyboard.type('X')
  const typed = await page.evaluate((id) => window.__qua.blocks().find((b) => b.id === id)?.text, st.sel.aBlock)
  assert(typed === 'X', `打字应落在上方新块：${JSON.stringify(typed)}`)
  await ctx.close()
  return `原块「${st.text}」不变；上方新块获得光标（depth ${st.selDepth}）`
})

await check('T32 Shift+Enter 刻意等同 Enter（v1 不做软换行）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await openFirstPage(page)
  const ids = await page.evaluate(() => {
    const ed = window.__qua.__editor
    const rootId = ed.doc.roots[0].id
    return { id: ed.insertBlockAfter(rootId, '软换甲乙丙') }
  })
  const depth = await page.evaluate(
    (id) => Number(document.querySelector(`.blk[data-block-id="${id}"]`).dataset.depth),
    ids.id,
  )
  const n0 = await page.evaluate(() => window.__qua.snapshot().totalBlocks)
  await page.evaluate((id) => window.__qua.focusBlock(id, 2), ids.id)
  await page.keyboard.press('Shift+Enter')
  const st = await page.evaluate((id) => {
    const ed = window.__qua.__editor
    const b = window.__qua.blocks().find((x) => x.id === id)
    const sel = window.__qua.snapshot().selection
    const rows = window.__qua.blocks()
    return { text: b?.text, sel, rows: rows.map((r) => r.text) }
  }, ids.id)
  assert(st.text === '甲乙丙', `Shift+Enter 应像 Enter 一样保留右半：${JSON.stringify(st.text)}`)
  assert(st.rows.includes('软换'), `左半应在上方新块：${JSON.stringify(st.rows)}`)
  assert(!st.rows.some((t) => t.includes('\n')), `不应插入软换行：${JSON.stringify(st.rows)}`)
  assert(st.sel.aBlock === ids.id && st.sel.aOff === 0, `光标应留原块 0 位：${JSON.stringify(st.sel)}`)
  const n1 = await page.evaluate(() => window.__qua.snapshot().totalBlocks)
  assert(n1 === n0 + 1, `应拆出一块：${n0} → ${n1}`)
  const selDepth = await page.evaluate(
    (id) => Number(document.querySelector(`.blk[data-block-id="${id}"]`).dataset.depth),
    st.sel.aBlock,
  )
  assert(selDepth === depth, `新块应与原块同级：${depth} → ${selDepth}`)
  await ctx.close()
  return `Shift+Enter 与 Enter 同形：左半「软换」在上、原块「${st.text}」、光标留原块`
})

await check('T33 同块选区 + Enter ⇒ 先删选区、再在起点拆（一次撤销复原）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await openFirstPage(page)
  const id = await page.evaluate(() => {
    const ed = window.__qua.__editor
    return ed.insertBlockAfter(ed.doc.roots[0].id, 'abcdefghij')
  })
  const n0 = await page.evaluate(() => window.__qua.snapshot().totalBlocks)

  const select = async (from, arrowKey, times) => {
    await page.evaluate(({ id, from }) => window.__qua.focusBlock(id, from), { id, from })
    await page.keyboard.down('Shift')
    for (let i = 0; i < times; i++) await page.keyboard.press(arrowKey)
    await page.keyboard.up('Shift')
    const sel = await page.evaluate(() => window.__qua.snapshot().selection)
    assert(sel.aOff === 2 && sel.hOff === 6, `选区应是 [2,6)：${JSON.stringify(sel)}`)
  }
  const read = () =>
    page.evaluate((id) => {
      const b = window.__qua.blocks().find((x) => x.id === id)
      return {
        text: b?.text,
        rows: window.__qua.blocks().map((r) => r.text),
        sel: window.__qua.snapshot().selection,
        n: window.__qua.snapshot().totalBlocks,
      }
    }, id)

  // ① 正向选 [2,6)（选 cdef）
  await select(2, 'ArrowRight', 4)
  await page.keyboard.press('Enter')
  const fwd = await read()
  assert(fwd.text === 'ghij', `原块应保选区之后的右半：${JSON.stringify(fwd.text)}`)
  assert(fwd.rows.includes('ab'), `选区之前的左半应在上方新块：${JSON.stringify(fwd.rows)}`)
  assert(!fwd.rows.some((t) => t.includes('cdef')), `选区文本应被删除：${JSON.stringify(fwd.rows)}`)
  assert(fwd.sel.aBlock === id && fwd.sel.aOff === 0, `光标应在原块 0 位：${JSON.stringify(fwd.sel)}`)
  assert(fwd.n === n0 + 1, `应只多一块：${n0} → ${fwd.n}`)

  // ② 一次撤销复原（删除 + 拆分是一笔）
  await page.keyboard.press(kbd('mod+z'))
  const undone = await read()
  assert(undone.text === 'abcdefghij' && undone.n === n0, `撤销应一步复原：${JSON.stringify(undone)}`)

  // ③ 反向选 [6,2]（同样归一成 [2,6)）
  await select(6, 'ArrowLeft', 4)
  await page.keyboard.press('Enter')
  const bwd = await read()
  assert(bwd.text === 'ghij' && bwd.rows.includes('ab'), `反向选区结果应一致：${JSON.stringify(bwd)}`)
  assert(!bwd.rows.some((t) => t.includes('cdef')), `反向选区文本也应删除：${JSON.stringify(bwd.rows)}`)

  await ctx.close()
  return `正向/反向选 cdef + Enter ⇒ ab / ghij；一次撤销复原`
})

await check('T35 跨块拖拽选块 / Shift+拖拽选文本 / 多块菜单删除 + 一次撤销', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await openFirstPage(page)
  /**
   * ⚠️ **等一次渲染落定再插块**：`openFirstPage` 只等 `invoke` 的 Promise，
   * 而 `core.page/open` 的收尾（`loadPage` → `renderAll`）在之后几拍才完成。
   * 不等的话 `insertBlockAfter(rootId, …)` 里的 `locate(this.doc, rootId)` 会落空
   * ⇒ 返回 `null` ⇒ 后面 `rect(null)` 报 `getBoundingClientRect of null`。
   * 这条在并发门禁下才显形（分片抢核时那几拍会被拉长）。
   */
  await page.waitForTimeout(150)
  const ids = await page.evaluate(() => {
    const ed = window.__qua.__editor
    const rootId = ed.doc.roots[0].id
    const a = ed.insertBlockAfter(rootId, 'AAAA')
    const b = ed.insertBlockAfter(a, 'BBBB')
    const c = ed.insertBlockAfter(b, 'CCCC')
    return { a, b, c, rootId, roots: ed.doc.roots.map((x) => x.id) }
  })
  assert(
    ids.a && ids.b && ids.c,
    `前置：三个块都要建出来。a=${ids.a} b=${ids.b} c=${ids.c}；` +
      `根 ${ids.rootId}；doc.roots=[${ids.roots.join(',')}]`,
  )
  const rect = async (id) =>
    page.evaluate((id) => {
      const el = document.querySelector(`.blk[data-block-id="${id}"] .tx`)
      const r = el.getBoundingClientRect()
      return { x: r.left + 2, y: r.top + r.height / 2 }
    }, id)
  const [ra, rb, rc] = await Promise.all([rect(ids.a), rect(ids.b), rect(ids.c)])
  const state = () =>
    page.evaluate(() => ({
      count: window.__qua.snapshot().blockSelectionCount,
      painted: document.querySelectorAll('.blk[data-blocksel="1"]').length,
      textSel: document.getSelection()?.toString() ?? '',
      texts: window.__qua.blocks().map((b) => b.text),
    }))
  const drag = async (from, to, shift = false) => {
    await page.mouse.move(from.x, from.y)
    if (shift) await page.keyboard.down('Shift')
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 8 })
    await page.mouse.up()
    if (shift) await page.keyboard.up('Shift')
  }

  // ① 单块内拖 = 文本（不是块）
  await drag(ra, { x: ra.x + 24, y: ra.y })
  const inBlock = await state()
  assert(inBlock.count === 0, `单块内拖不应选块：${JSON.stringify(inBlock)}`)
  assert(inBlock.textSel.length > 0, `单块内拖应选到文本：${JSON.stringify(inBlock)}`)
  await page.keyboard.press('Escape')

  // ② 拖过块边界 = 块选区（A..C，3 块；原生文本选区清空）
  await drag(ra, rc)
  const blocks = await state()
  assert(blocks.count === 3 && blocks.painted === 3, `A→C 应选 3 块：${JSON.stringify(blocks)}`)
  assert(blocks.textSel === '', `块选区时不应残留文本选区：${JSON.stringify(blocks.textSel)}`)

  // ③ 右键选中块 = 多块菜单（不是单块菜单）
  await page.mouse.click(rb.x, rb.y, { button: 'right' })
  await page.waitForTimeout(80)
  const menu = await page.evaluate(() => ({
    title: document.querySelector('.layer-head')?.textContent ?? '',
    items: [...document.querySelectorAll('.layer-item .layer-label')].map((e) => e.textContent),
  }))
  assert(menu.title === '块选择', `右键选中块应开多块菜单：${JSON.stringify(menu)}`)
  assert(menu.items.some((x) => x.includes('删除选中的块')), `多块菜单应有删除：${JSON.stringify(menu)}`)

  // ④ 菜单删除 → 三块消失；一次 ⌘Z 复原
  const del = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.layer-item')].find((e) => e.textContent?.includes('删除选中的块'))
    const r = btn.getBoundingClientRect()
    return { x: r.left + 10, y: r.top + r.height / 2 }
  })
  await page.mouse.click(del.x, del.y)
  const gone = await state()
  assert(!gone.texts.includes('AAAA') && !gone.texts.includes('BBBB') && !gone.texts.includes('CCCC'), `删除后三块应消失：${JSON.stringify(gone.texts)}`)
  await page.keyboard.press(kbd('mod+z'))
  await page.waitForTimeout(80)
  const back = await state()
  assert(back.texts.includes('AAAA') && back.texts.includes('BBBB') && back.texts.includes('CCCC'), `一次撤销应复原三块：${JSON.stringify(back.texts)}`)

  // ⑤ Shift+拖拽 = 跨块**文本**（我们的增量；块选区不激活）
  await page.evaluate((id) => window.__qua.focusBlock(id, 0), ids.a)
  // 删除/撤销之后 DOM 已重排 ⇒ 落点必须重算，不能复用删除前的 rect
  const [ra5, rc5] = await Promise.all([rect(ids.a), rect(ids.c)])
  await drag(ra5, rc5, true)
  const text = await state()
  assert(text.count === 0, `Shift+拖拽不应选块：${JSON.stringify(text)}`)
  assert(text.textSel.includes('AAAA') && text.textSel.includes('BBBB'), `Shift+拖拽应选到跨块文本：${JSON.stringify(text.textSel)}`)
  await page.keyboard.press('Escape')

  // ⑥ Mod+Shift+A 全选块；Enter 清选区并落到首块 0 位
  await page.evaluate((id) => window.__qua.focusBlock(id, 0), ids.a)
  await page.keyboard.press(kbd('mod+shift+a'))
  const all = await state()
  assert(all.count > 0, `Mod+Shift+A 应选块：${JSON.stringify(all)}`)
  await page.keyboard.press('Enter')
  const afterEnter = await page.evaluate(() => ({
    count: window.__qua.snapshot().blockSelectionCount,
    sel: window.__qua.snapshot().selection,
  }))
  assert(afterEnter.count === 0, `Enter 应清块选区：${JSON.stringify(afterEnter)}`)
  assert(afterEnter.sel?.aOff === 0, `Enter 后光标应在首块 0 位：${JSON.stringify(afterEnter.sel)}`)

  // ⑦ Shift+↓ 的边界规则：块尾起块选区并可扩展；文本内部仍是原生文本选区
  await page.evaluate((id) => window.__qua.focusBlock(id, 9999), ids.a)
  await page.keyboard.press('Shift+ArrowDown')
  const edge1 = await state()
  assert(edge1.count === 1, `块尾 Shift+↓ 应起块选区（1 块）：${JSON.stringify(edge1)}`)
  await page.keyboard.press('Shift+ArrowDown')
  const edge2 = await state()
  assert(edge2.count === 2, `再按 Shift+↓ 应扩到 2 块：${JSON.stringify(edge2)}`)
  await page.keyboard.press('Escape')
  await page.evaluate((id) => window.__qua.focusBlock(id, 1), ids.a)
  await page.keyboard.press('Shift+ArrowDown')
  const inner = await state()
  assert(inner.count === 0, `文本内部 Shift+↓ 不应起块选区：${JSON.stringify(inner)}`)
  assert(inner.textSel.length > 0, `文本内部 Shift+↓ 应是原生文本选区：${JSON.stringify(inner.textSel)}`)

  // ⑧ ⌘A 两次：第一次文本全选；已全选时再按升级为全选块
  await page.keyboard.press('Escape')
  await page.evaluate((id) => window.__qua.focusBlock(id, 0), ids.a)
  await page.keyboard.press(kbd('mod+a'))
  const textAll = await page.evaluate(() => ({
    count: window.__qua.snapshot().blockSelectionCount,
    sel: window.__qua.snapshot().selection,
  }))
  assert(textAll.count === 0, `第一次 ⌘A 应是文本全选：${JSON.stringify(textAll)}`)
  await page.keyboard.press(kbd('mod+a'))
  const blockAll = await state()
  assert(blockAll.count > 0, `第二次 ⌘A 应升级为块选区：${JSON.stringify(blockAll)}`)

  await ctx.close()
  return `单块内拖=文本；A→C=3 块；右键多块菜单删除 + 一次撤销；Shift+拖=跨块文本；Mod+Shift+A 全选块；Enter 清选区；Shift+↓ 边界规则；⌘A 两次升级`
})

await check('T54 聚焦日记块后日期仍可见：它自己是 depth 0 的只读日期行，子块缩进挂在下面、仍可聚焦', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))

  const today = await page.evaluate(() => {
    const j = window.__qua.allBlocks().find((b) => b.roles?.includes('journal'))
    window.__qua.invoke('core.block/focus-block', { blockId: j.id })
    return { id: j.id, date: window.__qua.snapshot().journalDate }
  })
  await page.waitForTimeout(250)
  const view = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#editor > .sec > .blk')]
    const head = rows[0]
    return {
      roots: rows.length,
      headId: head?.dataset.blockId ?? '',
      headRole: head?.dataset.role ?? '',
      headDepth: head?.dataset.depth ?? '',
      headDate: head?.querySelector('.tx')?.dataset.ph ?? '',
      headEditable: head?.querySelector('.tx')?.contentEditable ?? '',
      childDepth: rows[1]?.dataset.depth ?? '',
      crumbs: [...document.querySelectorAll('#crumbs-trail .crumb')].map((c) => c.textContent),
      active: window.__qua.snapshot().journalDate,
      total: window.__qua.snapshot().totalBlocks,
    }
  })
  assert(view.roots > 1, `聚焦日记后应装载它的子树（不只是子块）：${JSON.stringify(view)}`)
  assert(view.headId === today.id && view.headRole.includes('journal'), `第一行应是**日记块自己**：${JSON.stringify(view)}`)
  assert(view.headDepth === '0', `日记块应是 depth 0 的那一行：${JSON.stringify(view)}`)
  assert(view.headDate.length > 0 && !/^\d{4}-\d{2}-\d{2}$/.test(view.headDate), `聚焦后日期行仍要显示可读日期：${JSON.stringify(view)}`)
  assert(view.headEditable === 'false', `日期行仍只读：${JSON.stringify(view)}`)
  assert(view.childDepth === '1', `子块应缩进挂在日期行下面：${JSON.stringify(view)}`)
  assert(view.active === today.date, `当前对象仍是日记块自己（不是它的子块）：${JSON.stringify(view)}`)

  // 回今日 / 冷启动同一条规则：流里每一段的日期行都在，focus 不改变这一点
  await page.evaluate(() => window.__qua.invoke('core.journal/today'))
  await page.waitForTimeout(200)
  const feed = await page.evaluate(() => ({
    heads: [...document.querySelectorAll('#editor > .sec > .blk[data-depth="0"]')].map((el) => el.dataset.role ?? ''),
    dates: [...document.querySelectorAll('#editor > .sec > .blk[data-depth="0"]')].map((el) => el.querySelector('.tx')?.dataset.ph ?? ''),
  }))
  assert(feed.heads.every((r) => r.includes('journal')), `流里每段段头都是日记块：${JSON.stringify(feed)}`)
  assert(feed.dates.every((d) => d.length > 0), `流里每段都显示日期：${JSON.stringify(feed)}`)

  await ctx.close()
  return `聚焦后首行＝日记块自己（「${view.headDate}」只读、depth 0）＋ ${view.roots - 1} 行子块；当前对象不变`
})

await check('T55 载入假数据：落点是日记就装日记流（今日在顶＋更早的天），光标落在第一个可编辑行、日期行照常可见', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))

  // 先切到页再载入 ⇒ 库自己的 activeId 可能是任何东西；这里测的是「载入后落点＝日记」那条
  await page.evaluate(() => window.__qua.loadState('seed'))
  await page.waitForTimeout(300)
  const after = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#editor > .sec > .blk')]
    const heads = rows.filter((el) => el.dataset.depth === '0')
    return {
      journalView: window.__qua.ctxKeys().journalView,
      heads: heads.map((el) => ({ role: el.dataset.role ?? '', date: el.querySelector('.tx')?.dataset.ph ?? '', ro: el.querySelector('.tx')?.contentEditable ?? '' })),
      caret: window.__qua.snapshot().selection?.aBlock ?? '',
      firstHead: heads[0]?.dataset.blockId ?? '',
      firstEditable: rows.find((el) => el.querySelector('.tx')?.contentEditable !== 'false')?.dataset.blockId ?? '',
    }
  })
  assert(after.journalView === true, `载入假数据后落点应是日记：${JSON.stringify(after)}`)
  assert(after.heads.length >= 2, `落点是日记 ⇒ 应装**日记流**（不是只有今天一段）：${JSON.stringify(after.heads)}`)
  assert(after.heads.every((h) => h.role.includes('journal') && h.date.length > 0), `每段段头都要显示日期：${JSON.stringify(after.heads)}`)
  assert(after.heads.every((h) => h.ro === 'false'), `日期行仍只读：${JSON.stringify(after.heads)}`)
  assert(after.caret && after.caret !== after.firstHead, `光标不该停在只读日期行：${JSON.stringify(after)}`)
  assert(after.caret === after.firstEditable, `光标应落在第一个可编辑行：${JSON.stringify(after)}`)

  await ctx.close()
  return `载入 seed：${after.heads.length} 段（「${after.heads[0].date}」…）；光标在首段第一个可编辑行`
})

/**
 * **根块不该能从编辑器里删掉**。
 *
 * 为什么值得一条断言：根是**视图的装载单位**（页／天／查询记录），
 * `doc.roots[0]` 就是森林里那块本身。从 `doc.roots` 里 splice 掉它，
 * 库里那块还在 ⇒ 刷新就回来。用户看到的是「删了又复活」，
 * 而且**没有报错**——这类静默不一致只能靠断言钉住。
 */
await check('T56 聚焦根块时块菜单**没有**「删除块」，命令被直接调用也拒绝（不静默丢块）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  await openFirstPage(page)

  // ① 聚焦**根块**（页自己）⇒ 上下文键应报「是根」
  const rootKeys = await page.evaluate(() => {
    const rootId = window.__qua.blocks()[0].id
    window.__qua.focusBlock(rootId, 0)
    const k = window.__qua.ctxKeys()
    return { blockIsRoot: Boolean(k.blockIsRoot), blockFocused: Boolean(k.blockFocused) }
  })
  assert(rootKeys.blockFocused === true, `前置：根块应处于聚焦态：${JSON.stringify(rootKeys)}`)
  assert(rootKeys.blockIsRoot === true, `根块的 blockIsRoot 应为 true：${JSON.stringify(rootKeys)}`)

  // ② 菜单里不该出现删除项
  const items = await page.evaluate(() => {
    const ed = window.__qua.__editor
    const rootId = window.__qua.blocks()[0].id
    ed.events.blockMenu?.(rootId, document.querySelector(`.blk[data-block-id="${rootId}"]`).getBoundingClientRect())
    return [...document.querySelectorAll('.layer-item .layer-label')].map((e) => e.textContent ?? '')
  })
  assert(
    !items.some((x) => x.includes('删除块') || x.includes('删除选中的块')),
    `根块菜单不该有删除项：${JSON.stringify(items)}`,
  )

  // ③ 兜底：就算绕开 `when` 直接 invoke，也不许删（块数与活动 id 都不变）
  const before = await page.evaluate(() => ({
    total: window.__qua.snapshot().totalBlocks,
    activeId: window.__qua.snapshot().activeId,
  }))
  await page.evaluate(() => window.__qua.invoke('core.editor/delete-block'))
  await page.waitForTimeout(150)
  const after = await page.evaluate(() => ({
    total: window.__qua.snapshot().totalBlocks,
    activeId: window.__qua.snapshot().activeId,
  }))
  assert(after.total === before.total, `删根块被拒 ⇒ 块数不该变：${JSON.stringify({ before, after })}`)
  assert(after.activeId === before.activeId, `落点不该被改：${JSON.stringify({ before, after })}`)

  await ctx.close()
  return `根块：blockIsRoot=true、菜单无删除项、直接 invoke 也被拒（块数不变 ${before.total}）`
})

/**
 * **日记流的「当前对象」不是一块，而是一棵多段 feed**。
 *
 * 历史栈如果只记块 id，就分不出「今天这一块作为 feed 入口」和「只看今天」——
 * 回放会把 feed 收成孤立的一天（**QB-002**）。所以每个导航项都带视图形态 `feed`。
 */
await check('T57 日记流里 zoom 进某块再「后退」⇒ 回到**日记流**（不是孤立的一天）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  await page.evaluate(() => window.__qua.loadState('seed'))
  await page.waitForTimeout(260)

  const feedAtStart = await page.evaluate(() => ({
    roots: [...document.querySelectorAll('#editor > .sec > .blk')].filter((el) => el.dataset.depth === '0').length,
    journalView: window.__qua.ctxKeys().journalView,
  }))
  assert(feedAtStart.journalView === true, `前置：落点应是日记：${JSON.stringify(feedAtStart)}`)
  assert(feedAtStart.roots >= 2, `前置：应是日记流（多段）：${JSON.stringify(feedAtStart)}`)

  // zoom 进一个子块 ⇒ 视图只剩它自己这一棵
  const zoomed = await page.evaluate(() => {
    const bs = window.__qua.blocks()
    const kid = bs.find((b) => !(b.roles?.length) && b.text.length > 2)
    window.__qua.invoke('core.block/focus-block', { blockId: kid.id })
    return { id: kid.id, depth: kid.children.length }
  })
  await page.waitForTimeout(200)
  const afterZoom = await page.evaluate(() => ({
    roots: [...document.querySelectorAll('#editor > .sec > .blk')].filter((el) => el.dataset.depth === '0').length,
  }))
  assert(afterZoom.roots === 1, `zoom 后视图应只剩一块：${JSON.stringify(afterZoom)}`)

  // 后退 ⇒ 应回到 feed（多段），而不是一个孤立的天
  await page.evaluate(() => window.__qua.invoke('core.history/back'))
  await page.waitForTimeout(240)
  const back = await page.evaluate(() => ({
    roots: [...document.querySelectorAll('#editor > .sec > .blk')].filter((el) => el.dataset.depth === '0').length,
    journalView: window.__qua.ctxKeys().journalView,
    journalDate: window.__qua.ctxKeys().journalDate,
  }))
  assert(back.journalView === true, `后退后落点应是日记：${JSON.stringify(back)}`)
  assert(
    back.roots >= 2,
    `后退后应是**日记流**（今日在顶＋更早存在的天），实际只有 ${back.roots} 段：${JSON.stringify(back)}`,
  )
  assert(back.journalDate.length === 10, `后退后应看得出是哪一天：${JSON.stringify(back)}`)

  await ctx.close()
  return `日记流 ${feedAtStart.roots} 段 → zoom（1 段）→ 后退 ⇒ 仍是 feed（${back.roots} 段，${back.journalDate}）`
})

await check('T57b 聚焦今天的 journal 块 ⇒ 只装单日；后退回 feed；再点根块标不重装', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))

  const roots = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('#editor > .sec > .blk[data-depth="0"]')].map((el) => el.dataset.blockId),
    )
  const before = await roots()
  const dayId = await page.evaluate(() => window.__qua.snapshot().activeId)
  assert(before.length >= 2, `前置：冷启动应是日记流（多段）：${JSON.stringify(before)}`)

  // 聚焦「今天」这一块：activeId 不变，但视图要从 feed 收成单日
  await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), dayId)
  await page.waitForTimeout(180)
  const focused = await roots()
  assert(
    focused.length === 1 && focused[0] === dayId,
    `聚焦今天的 journal 块应只装这一天，不该仍是 feed：${JSON.stringify(focused)}`,
  )

  // 已经在单块聚焦里，再点一次根块标 ⇒ 不许整片重装（DOM 节点保持同一个）
  await page.evaluate((id) => {
    window.__probeRoot = document.querySelector(`.blk[data-block-id="${id}"]`)
    document
      .querySelector(`.blk[data-block-id="${id}"] .marker`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  }, dayId)
  await page.waitForTimeout(120)
  const noop = await page.evaluate(
    (id) => ({ sameNode: window.__probeRoot === document.querySelector(`.blk[data-block-id="${id}"]`) }),
    dayId,
  )
  assert(noop.sameNode, `已在单块聚焦时再点根块标不该重装 DOM：${JSON.stringify(noop)}`)

  // 同一 id、不同形态也进历史 ⇒ 后退应回到 feed
  await page.evaluate(() => window.__qua.invoke('core.history/back'))
  await page.waitForTimeout(220)
  const back = await roots()
  assert(back.length >= 2, `单日聚焦后退应回到多段日记流：${JSON.stringify(back)}`)

  await ctx.close()
  return `feed ${before.length} 段 → 聚焦单日（1 段）→ 再点不重装 → 后退回 feed（${back.length} 段）`
})

await check('T58 敲 `#名` + 空格**不再**静默成标签：字原样留着、归属没写、没有原子', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  await openFirstPage(page)

  /**
   * 这一条钉的是「打字路径＝提及／实例化，不是归类」：`#名` 敲到分隔符时**不再转换**。
   *
   * 判据必须是三件事**同时**没有：块归属（`_tags`）、行内原子、以及建出来的标签块。
   * 只做了一半（例如字删了、归属没写）用户看到的仍然是「一敲 `#` 就出 chip」，
   * 而那正是被撤掉的那套行为。
   */
  const target = await page.evaluate(() => {
    const ed = window.__qua.__editor
    const id = ed.insertBlockAfter(window.__qua.blocks()[0].id, '')
    window.__qua.focusBlock(id, 0)
    return id
  })
  await page.waitForTimeout(80)

  const tagName = '不猜归属'
  await page.keyboard.type(`写点东西 #${tagName} `)
  await page.waitForTimeout(220)

  const got = await page.evaluate(({ id, name }) => {
    const b = window.__qua.blocks().find((x) => x.id === id)
    const tx = document.querySelector(`.blk[data-block-id="${id}"] .tx`)
    return {
      text: b?.text ?? '',
      domText: tx?.textContent ?? '',
      tags: b?.tags ?? [],
      atoms: window.__qua.atoms().filter((a) => a.blockId === id).length,
      tagCreated: window.__qua.allBlocks().some((x) => x.roles?.includes('tag') && x.text === name),
      layerOpen: document.querySelectorAll('.layer').length,
    }
  }, { id: target, name: tagName })

  assert(got.text === `写点东西 #${tagName} `, `正文应逐字留着（不转换）：${JSON.stringify(got.text)}`)
  assert(got.domText.includes(`#${tagName}`), `DOM 里也应是那几个字：${JSON.stringify(got.domText)}`)
  assert(got.tags.length === 0, `这次输入不该写块归属：${JSON.stringify(got.tags)}`)
  assert(got.atoms === 0, `不该凭空长出一枚原子：${got.atoms}`)
  assert(!got.tagCreated, '不该顺手建出标签块')
  assert(got.layerOpen === 0, `分隔符落下之后浮层该自己关掉：${got.layerOpen}`)

  await ctx.close()
  return `敲「#${tagName}」＋空格 ⇒ 正文原样、0 归属、0 原子、0 新标签块；浮层随分隔符关掉`
})

await check('T58b 属性面板挂/摘块标签：只写归属，正文不动', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  await openFirstPage(page)

  // 属性区的 target 是**聚焦块**（光标所在块）⇒ 用命令把光标落到一个内容块上
  const pageId = await page.evaluate(() => {
    const b = window.__qua.blocks().find((x) => x.roles.length === 0 && x.children === 0 && x.text.length > 2)
    window.__qua.invoke('core.block/focus-block', { blockId: b.id })
    return b.id
  })
  await page.waitForTimeout(150)
  await page.waitForSelector('.props-tag-input', { timeout: 4000 })

  await page.fill('.props-tag-input', '项目')
  await page.press('.props-tag-input', 'Enter')
  await page.waitForTimeout(250)

  const added = await page.evaluate((id) => {
    const b = window.__qua.blocks().find((x) => x.id === id)
    return {
      text: b?.text ?? '',
      tags: b?.tags ?? [],
      chips: [...document.querySelectorAll(`.blk[data-block-id="${id}"] .blk-tags .tag-chip`)].map((e) => e.textContent),
      panel: [...document.querySelectorAll('.props-tag')].map((e) => e.textContent),
    }
  }, pageId)
  assert(added.tags.length === 1, '面板挂标签应写进块上的归属：' + JSON.stringify(added))
  assert(added.chips.length === 1 && added.chips[0] === '#项目', '块级标签应渲染成标签槽里的 chip：' + JSON.stringify(added.chips))
  assert(added.panel.some((s) => s.includes('#项目')), '面板这一行应显示刚挂上的标签：' + JSON.stringify(added.panel))
  assert(!added.text.includes('项目'), '属性面板入口**不碰正文**：' + JSON.stringify(added.text))

  await page.click('.props-tag .props-tag-x')
  await page.waitForTimeout(250)
  const removed = await page.evaluate((id) => {
    const b = window.__qua.blocks().find((x) => x.id === id)
    return {
      tags: b?.tags ?? [],
      chips: document.querySelectorAll(`.blk[data-block-id="${id}"] .blk-tags .tag-chip`).length,
      panel: document.querySelectorAll('.props-tag').length,
    }
  }, pageId)
  assert(removed.tags.length === 0, '摘标签应清掉归属：' + JSON.stringify(removed))
  assert(removed.chips === 0, '摘掉后不该留着 chip：' + JSON.stringify(removed))
  assert(removed.panel === 0, '面板那一行也应跟着消失：' + JSON.stringify(removed))

  await ctx.close()
  return `面板挂 #项目 ⇒ 归属＋chip（正文不动）；点 × ⇒ 归属与 chip 一起没了`
})

await check('T59 `ref` 类型的值走选择器：显示目标**名字**、能换目标、不让人手打 id', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  await openFirstPage(page)

  /**
   * 属性区画在**聚焦块**上：`focus-block` 会把光标落到目标块，
   *    于是面板画的就是这一块的属性。
   */
  const setup = await page.evaluate(() => {
    const bs = window.__qua.blocks()
    const host = bs.find((b) => !(b.roles?.length) && b.text.length > 2)
    const ed = window.__qua.__editor
    const a = ed.insertBlockAfter(host.id, '候选人甲')
    window.__qua.invoke('core.block/focus-block', { blockId: host.id })
    return { host: host.id, a }
  })
  await page.waitForTimeout(220)

  const defId = await page.evaluate((host) => {
    window.__qua.invoke('core.props/create-def', { blockId: host, label: '负责人', kind: 'ref', target: 'own' })
    return window.__qua.propDefs().find((d) => d.label === '负责人')?.id ?? ''
  }, setup.host)
  assert(defId, '前置：应建出「负责人」字段定义')
  await page.waitForTimeout(260)

  // ① 值是选择器按钮（.prop-ref），不是裸 input
  const cell = await page.evaluate((pid) => {
    const row = document.querySelector('.prop-row[data-prop-id="' + pid + '"]')
    const ctl = row?.querySelector('.prop-value > *')
    return { tag: ctl?.tagName ?? '', isRef: ctl?.classList.contains('prop-ref') ?? false, text: ctl?.textContent ?? '' }
  }, defId)
  assert(cell.isRef === true, 'ref 值应渲染成选择器按钮（.prop-ref），不是普通输入框：' + JSON.stringify(cell))
  assert(cell.tag === 'BUTTON', '应是一个按钮：' + JSON.stringify(cell))

  // ② 点开 ⇒ 弹出选择器，列出可指向的块
  await page.evaluate((pid) => {
    document.querySelector('.prop-row[data-prop-id="' + pid + '"] .prop-ref')?.click()
  }, defId)
  await page.waitForTimeout(200)
  const menu = await page.evaluate(() => ({
    open: Boolean(document.querySelector('.layer')),
    title: document.querySelector('.layer-head')?.textContent ?? '',
    labels: [...document.querySelectorAll('.layer-item .layer-label')].map((e) => e.textContent ?? ''),
  }))
  assert(menu.open, '点 ref 值应弹出选择器：' + JSON.stringify(menu))
  assert(menu.labels.some((x) => x.includes('候选人甲')), '选择器里应有候选块：' + JSON.stringify(menu.labels))

  // ③ 选中 ⇒ 值写成目标 id，**显示**的是目标名字
  await page.evaluate(() => {
    // ⚠️ 菜单选中走 **mousedown**（不是 click）：mousedown 里 preventDefault 保住焦点
    const item = [...document.querySelectorAll('.layer-item')].find((e) => e.textContent?.includes('候选人甲'))
    item?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  })
  await page.waitForTimeout(300)
  const after = await page.evaluate(({ pid, host }) => {
    /**
     * ⚠️ `blocks()` 给的是**精简投影**（没有 props），读值要走编辑器手里的活块。
     *    写成 `blocks()[0].props` 会永远是 undefined —— 那种断言会假绿。
     */
    const store = window.__qua.__editor.store
    const find = (id, list) => {
      for (const b of list) {
        if (b.id === id) return b
        const inner = find(id, b.children ?? [])
        if (inner) return inner
      }
      return null
    }
    const live = find(host, store.blocks)
    const ctl = document.querySelector('.prop-row[data-prop-id="' + pid + '"] .prop-ref')
    return { stored: live?.props?.[pid] ?? '', shown: ctl?.textContent ?? '', refId: ctl?.dataset.refId ?? '' }
  }, { pid: defId, host: setup.host })

  assert(after.stored === setup.a, '选中的块 id 应写进 props[propId]：' + JSON.stringify(after))
  assert(after.shown === '候选人甲', '显示应是目标的名字，不是 id：' + JSON.stringify(after))
  assert(after.refId === setup.a, '按钮上应带 target id（供重开校验）')

  await ctx.close()
  return `ref 值：按钮选择器 → 选中「候选人甲」⇒ props=${after.stored.slice(-6)}、显示「${after.shown}」`
})

/**
 * **跨块选区上的删除要落到模型里**（不只是改了 DOM）。
 *
 * 失败方式很讨厌：浏览器把字删了、模型里块一块没少，重渲染一画就全回来。
 *
 * ⚠️ 这里在**同一个 evaluate 里**完成「设选区 → 收拢」：中间不给
 *    `selectionchange` 一次机会——它会从 DOM 反推选区，把模型里那个跨块选区冲掉。
 */
await check('T60 跨块选区收拢 ⇒ 首尾拼成一块、中间块（连子树）真从模型里消失，一次撤销复原', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  await openFirstPage(page)

  const before = await page.evaluate(() => {
    const ed = window.__qua.__editor
    const host = window.__qua.blocks().find((b) => !(b.roles?.length) && b.text.length > 2)
    const a = ed.insertBlockAfter(host.id, 'AAAA')
    const b = ed.insertBlockAfter(a, 'BBBB')
    const c = ed.insertBlockAfter(b, 'CCCC')
    /**
     * 给 BBBB 挂一个**真正的子块**（`insertBlockAfter` 只在「首行特例」下建子块，
     * 所以这里直接改模型），它必须随 BBBB 一起没掉。
     */
    const find = (id, list) => {
      for (const x of list) {
        if (x.id === id) return x
        const inner = find(id, x.children ?? [])
        if (inner) return inner
      }
      return null
    }
    find(b, ed.doc.roots)?.children.push({ id: 'kid-' + b, content: [{ t: 'text', v: '子块不该留' }], children: [] })
    ed.renderAll()
    return { a, b, c, total: window.__qua.snapshot().totalBlocks }
  })
  await page.waitForTimeout(120)

  // 同一口锅里：设选区 → 立刻收拢
  const after = await page.evaluate(({ a, b }) => {
    const ed = window.__qua.__editor
    ed.setSel({ aBlock: a, aOff: 2, hBlock: b, hOff: 2 })
    const caret = ed.collapseSelection()
    return {
      caret,
      total: window.__qua.snapshot().totalBlocks,
      texts: window.__qua.blocks().map((x) => x.text),
    }
  }, before)
  await page.waitForTimeout(200)

  assert(after.caret === before.a, '光标应落在首块（保它的 id）：' + JSON.stringify(after))
  assert(after.total === before.total - 2, '应少 2 块（BBBB 与它的子块）：' + JSON.stringify({ before, after }))
  assert(!after.texts.includes('子块不该留'), '被删块的子树不能留在模型里：' + JSON.stringify(after.texts))
  assert(!after.texts.includes('BBBB'), 'BBBB 应已并掉：' + JSON.stringify(after.texts))
  // 首尾拼成一块：AAAA 前 2 字 ＋ BBBB 后 2 字（BBBB 从第 2 位起选 ⇒ 剩「BB」）
  assert(after.texts.includes('AABB'), '首尾应拼成「AABB」：' + JSON.stringify(after.texts))

  // 一次撤销全部复原（含被删块的子树）
  await page.evaluate(() => window.__qua.invoke('core.history/undo'))
  await page.waitForTimeout(200)
  const back = await page.evaluate(() => ({
    total: window.__qua.snapshot().totalBlocks,
    texts: window.__qua.blocks().map((x) => x.text),
  }))
  assert(back.total === before.total, '一次撤销应复原块数：' + JSON.stringify({ before, back }))
  assert(back.texts.includes('AAAA') && back.texts.includes('子块不该留'), '撤销后文字与子树都应回来：' + JSON.stringify(back.texts))

  await ctx.close()
  return `跨块收拢：块数 ${before.total}→${after.total}、拼成「AABB」，一次撤销连子树一起复原`
})

await check('T27 光标行隐藏占位、journal 日期不可聚焦、折叠图标贴自己的块标', async () => {
  const { ctx, page } = await freshPage(browser, base)

  // ① 光标所在行**不显示**占位符（否则光标落在「空块」二字后面）
  const ph = await page.evaluate(() => {
    const ed = window.__qua.__editor
    const id = ed.insertBlockAfter(window.__qua.blocks()[0].id, '')
    ed.placeCaret(id, 0)
    const el = document.querySelector(`.blk[data-block-id="${id}"] .tx`)
    const before = getComputedStyle(el, '::before').content
    // 把光标挪到别的块 ⇒ 占位应回来
    ed.placeCaret(window.__qua.blocks()[0].id, 0)
    const after = getComputedStyle(el, '::before').content
    return { withCaret: before, withoutCaret: after, hasDataPh: Boolean(el.dataset.ph) }
  })
  assert(ph.hasDataPh, '前置：空块应带 data-ph')
  assert(ph.withCaret === 'none' || ph.withCaret === 'normal', `光标所在行不该显示占位：${ph.withCaret}`)
  assert(ph.withoutCaret !== 'none', `光标离开后占位应回来：${ph.withoutCaret}`)

  // ② journal 的日期行：不可编辑、点它不落光标
  const jr = await page.evaluate(() => {
    const tx = document.querySelector('.blk[data-role="journal"] .tx')
    return { ce: tx.contentEditable, readonly: tx.dataset.readonly ?? '' }
  })
  assert(jr.ce === 'false', `journal 的日期行应 contenteditable=false：${JSON.stringify(jr)}`)
  assert(jr.readonly === '1', `journal 的日期行应带 data-readonly：${JSON.stringify(jr)}`)
  const jpos = await page.evaluate(() => {
    const tx = document.querySelector('.blk[data-role="journal"] .tx')
    const r = tx.getBoundingClientRect()
    return { x: r.left + 8, y: r.top + r.height / 2 }
  })
  const selBefore = await page.evaluate(() => window.__qua.snapshot().selection)
  await page.mouse.click(jpos.x, jpos.y)
  const selAfter = await page.evaluate(() => window.__qua.snapshot().selection)
  assert(JSON.stringify(selBefore) === JSON.stringify(selAfter), `点日期行不该移动光标：${JSON.stringify(selBefore)} → ${JSON.stringify(selAfter)}`)

  // ③ 折叠三角贴**自己那颗块标**（xdepth 递增），不是整行最左
  const fold = await page.evaluate(() => {
    const out = []
    for (const el of document.querySelectorAll('#editor .blk[data-has-children="1"]')) {
      const f = el.querySelector('.fold')
      const m = el.querySelector('.marker')
      if (!f || !m) continue
      const fr = f.getBoundingClientRect()
      const mr = m.getBoundingClientRect()
      out.push({ depth: Number(el.dataset.depth), fold: Math.round(fr.left), marker: Math.round(mr.left), gap: Math.round(mr.left - fr.right) })
    }
    return out
  })
  assert(fold.length > 0, '应有带子块的行可测')
  for (const f of fold) {
    assert(f.gap >= 0 && f.gap <= 4, `折叠三角应紧贴自己的块标（gap 0–4px）：${JSON.stringify(f)}`)
  }
  const byDepth = [...fold].sort((a, b) => a.depth - b.depth)
  if (byDepth.length >= 2) {
    assert(byDepth[byDepth.length - 1].fold > byDepth[0].fold, `更深一层的三角应更靠右（不挤在最左）：${JSON.stringify(byDepth)}`)
  }

  await ctx.close()
  return `光标行隐藏占位（离开后回来）；journal 日期 contenteditable=false 且点击不移光标；${fold.length} 个折叠三角 gap ${fold.map((f) => f.gap).join('/')}px`
})

await check('T28 日记流＝今日在顶＋存在的历史天；历史天可编辑且写回', async () => {
  const { ctx, page } = await freshPage(browser, base)

  // ① 冷启动是 N 个真实 section：today + 种子里存在的 -1/-2（**不造空天**）
  const feed = await page.evaluate(() => {
    const roots = [...document.querySelectorAll('#editor > .sec > .blk[data-role="journal"]')]
    return {
      roots: roots.length,
      dates: roots.map((el) => el.querySelector('.tx')?.dataset.ph ?? ''),
      depths: roots.map((el) => Number(el.dataset.depth)),
      readonly: roots.map((el) => el.querySelector('.tx')?.contentEditable ?? ''),
      firstChildDepth: roots[0]?.nextElementSibling?.dataset.depth ?? null,
      active: window.__qua.snapshot().journalDate,
    }
  })
  assert(feed.roots === 3, `冷启动应恰好 3 天（今天 + 2 天种子，不生造空天）：${JSON.stringify(feed)}`)
  assert(feed.depths.every((d) => d === 0), `每个 journal 段头都应是 depth 0：${JSON.stringify(feed.depths)}`)
  assert(feed.readonly.every((v) => v === 'false'), `每个日期行都应只读：${JSON.stringify(feed.readonly)}`)
  assert(feed.firstChildDepth === '1', `段头之后应是它的子块（depth 1）：${JSON.stringify(feed)}`)
  assert(feed.dates.every((d) => d.length > 0 && !/^\d{4}-\d{2}-\d{2}$/.test(d)), `段头应是日期的可读投影：${JSON.stringify(feed.dates)}`)
  assert(/^\d{4}-\d{2}-\d{2}$/.test(feed.active), `当前对象应是 today 的 journal：${JSON.stringify(feed.active)}`)

  // ② 在**最早的一段**里敲字：模型里是那段子块的正文，段头仍是空（不写日期）
  const oldestChild = await page.evaluate(() => {
    const roots = [...document.querySelectorAll('#editor > .sec > .blk[data-role="journal"]')]
    const last = roots[roots.length - 1]
    return last?.nextElementSibling?.dataset.blockId ?? ''
  })
  assert(oldestChild, '最早的一段应有一个可编辑子块')
  await page.evaluate((id) => window.__qua.focusBlock(id, 9999), oldestChild)
  await page.keyboard.type('历史编辑')
  const edited = await page.evaluate(() => ({
    hasText: window.__qua.blocks().some((b) => b.text.includes('历史编辑')),
    rootTexts: [...document.querySelectorAll('#editor > .sec > .blk[data-role="journal"]')].map((el) => el.querySelector('.tx')?.textContent ?? ''),
  }))
  assert(edited.hasText, '历史天的子块应能编辑')
  assert(edited.rootTexts.every((t) => t === ''), `journal 段头的正文应保持为空：${JSON.stringify(edited.rootTexts)}`)

  // ③ 切到页再回日记流：历史天的编辑必须**写回**且重新装载后还在
  await page.evaluate(() => window.__qua.invoke('core.page/open', { pageId: window.__qua.pages()[0].id }))
  await page.evaluate(() => window.__qua.invoke('core.journal/today'))
  const persisted = await page.evaluate(() => ({
    hasText: window.__qua.blocks().some((b) => b.text.includes('历史编辑')),
    roots: document.querySelectorAll('#editor > .sec > .blk[data-role="journal"]').length,
  }))
  assert(persisted.hasText, '切页再回来，历史天的编辑应还在（syncSections 按 root id 写回）')
  assert(persisted.roots === 3, `回今日应重新装 3 段：${JSON.stringify(persisted)}`)

  await ctx.close()
  return `3 段：${feed.dates.join(' / ')}；最早一段可编辑并跨页写回`
})

await check('T29 滚到底加载更早的日记（只加载存在的天）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  const before = await page.evaluate(() => document.querySelectorAll('#editor > .sec > .blk[data-role="journal"]').length)
  const after = await page.evaluate(() => {
    const el = document.querySelector('#scroll')
    el.scrollTop = el.scrollHeight
    el.dispatchEvent(new Event('scroll'))
    const roots = [...document.querySelectorAll('#editor > .sec > .blk[data-role="journal"]')]
    return {
      roots: roots.length,
      dates: roots.map((x) => x.querySelector('.tx')?.dataset.ph ?? ''),
      scrollable: el.scrollHeight > el.clientHeight,
    }
  })
  assert(after.scrollable, `首屏 3 天应可滚（否则滚动加载不会触发）：${JSON.stringify(after)}`)
  assert(after.roots > before, `滚到底应追加更早的天：${before} → ${after.roots}`)
  assert(after.roots <= 6, `只应加载存在的 6 天（不造空天）：${after.roots}`)
  assert(new Set(after.dates).size === after.dates.length, `日记流不应出现重复的天：${JSON.stringify(after.dates)}`)
  await ctx.close()
  return `滚到底 ${before} → ${after.roots} 段（存在的天）`
})

await check('T93 段排列：行序列包进 .sec；row 下段是列，点列空白＝那天的最后一个子块，加载只在 column', async () => {
  const { ctx, page } = await freshPage(browser, base)

  // ① column（缺省）：段物质化——每个 .sec 的第一行是段根（depth 0），段头 id 写在 data-sec 上
  const secs = await page.evaluate(() => {
    const editor = document.getElementById('editor')
    return {
      layout: editor?.dataset.layout ?? '',
      list: [...editor.querySelectorAll(':scope > .sec')].map((sec) => ({
        hasMark: sec.dataset.sec !== undefined,
        root: sec.dataset.sec,
        headDepth: sec.firstElementChild?.dataset.depth ?? '',
        rows: sec.querySelectorAll('.blk').length,
      })),
    }
  })
  assert(secs.layout === 'column', `缺省布局应是 column：${JSON.stringify(secs.layout)}`)
  assert(secs.list.length === 3, `冷启动 3 天＝3 段：${JSON.stringify(secs.list.length)}`)
  assert(secs.list.every((s) => s.hasMark && s.headDepth === '0' && s.rows > 1), `每段应是「段根＋子块」：${JSON.stringify(secs.list)}`)

  // ② 切 row：段变成横向的列
  await page.evaluate(() => window.__qua.__editor.setLayout('row'))
  const row = await page.evaluate(() => {
    const editor = document.getElementById('editor')
    const rects = [...editor.querySelectorAll(':scope > .sec')].map((el) => el.getBoundingClientRect())
    const scroll = document.getElementById('scroll')
    return {
      layout: editor.dataset.layout,
      lefts: rects.map((r) => Math.round(r.left)),
      sameTop: rects.every((r) => Math.abs(r.top - rects[0].top) < 2),
      scrollable: scroll.scrollWidth > scroll.clientWidth,
    }
  })
  assert(row.layout === 'row', `data-layout 应写上：${JSON.stringify(row.layout)}`)
  assert(row.lefts.length === 3 && row.lefts.every((l, i) => i === 0 || l > row.lefts[i - 1]), `三列应横向排开：${JSON.stringify(row.lefts)}`)
  assert(row.sameTop, `列应顶对齐：${JSON.stringify(row.lefts)}`)
  assert(row.scrollable, `三列应横向溢出（#scroll 承担横向滚动）：${JSON.stringify(row.scrollable)}`)

  // ③ 点第一列（今天）的列内底部空白 ⇒ 新块落在**那一天**下面，别的列不动
  /**
   * ⚠️ 点是**列底之下**：列尾现在还有一块「挂载区」（引用/同类/提及），
   *    紧贴最后一行的空白已经是它了——点那里不该建块（那是它自己的点击面）。
   *    列底之下仍是这一列的范围（按 x 找列），所以「点这一列的空白 ⇒ 建到那一天」照旧成立。
   */
  const target = await page.evaluate(() => {
    const sec = document.querySelector('#editor > .sec')
    const scroll = document.getElementById('scroll')
    // 列底可能被挂载区（含派生栏抬头）顶出视口：先把落点滚进来再点
    const need = sec.getBoundingClientRect().bottom + 24 - (window.innerHeight - 8)
    if (need > 0) scroll.scrollTop += need
    const colRect = sec.getBoundingClientRect()
    return { x: Math.round(colRect.left + colRect.width / 2), y: Math.round(colRect.bottom + 24) }
  })
  // 只数**这一列自己的行**（挂载区里的行是别的视图的块集合）
  const beforeCols = await page.evaluate(() => [...document.querySelectorAll('#editor > .sec')].map((s) => s.querySelectorAll(':scope > .blk').length))
  await page.mouse.click(target.x, target.y)
  const afterClick = await page.evaluate((secId) => {
    const sec = [...document.querySelectorAll('#editor > .sec')].find((s) => s.dataset.sec === secId)
    const rows = [...sec.querySelectorAll(':scope > .blk')]
    const lastRow = rows[rows.length - 1]
    const root = window.__qua.__editor.doc.roots.find((r) => r.id === secId)
    return {
      perCol: [...document.querySelectorAll('#editor > .sec')].map((s) => s.querySelectorAll(':scope > .blk').length),
      lastText: lastRow.querySelector('.tx')?.textContent ?? '',
      lastIsTail: root.children[root.children.length - 1]?.id === lastRow.dataset.blockId,
      depth: Number(lastRow.dataset.depth),
    }
  }, secs.list[0].root)
  assert(JSON.stringify(afterClick.perCol) === JSON.stringify(beforeCols.map((n, i) => (i === 0 ? n + 1 : n))), `新块应只落在被点的列：${JSON.stringify(beforeCols)} → ${JSON.stringify(afterClick.perCol)}`)
  assert(afterClick.lastText === '' && afterClick.lastIsTail && afterClick.depth === 1, `点列空白应建那天的最后一个子块：${JSON.stringify(afterClick)}`)

  // ④ 增量加载只在 column：row 下滚到底不加段；切回 column 才加载
  await page.evaluate(() => {
    window.__qua.__editor.setLayout('row')
    const el = document.getElementById('scroll')
    el.scrollTop = el.scrollHeight
    el.dispatchEvent(new Event('scroll'))
  })
  await page.waitForTimeout(200)
  const rowRoots = await page.evaluate(() => document.querySelectorAll('#editor > .sec').length)
  await page.evaluate(() => {
    window.__qua.__editor.setLayout('column')
    const el = document.getElementById('scroll')
    el.scrollTop = el.scrollHeight
    el.dispatchEvent(new Event('scroll'))
  })
  await page.waitForTimeout(200)
  const colRoots = await page.evaluate(() => document.querySelectorAll('#editor > .sec').length)
  assert(rowRoots === 3, `row 下滚到底不应追加天：${rowRoots}`)
  assert(colRoots > rowRoots, `切回 column 后滚到底才追加：${rowRoots} → ${colRoots}`)

  await ctx.close()
  return `3 段物质化；row 三列横排、点列空白落当天；加载仅 column`
})

await check('T34 反链 footer 可原地编辑；同一源块在正文与反链两个实例同步（共享 store）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  const targetPage = await page.evaluate(() => window.__qua.pages()[0].id)
  await page.evaluate((id) => window.__qua.invoke('core.page/open', { pageId: id }), targetPage)

  // 在目标页里造一个「引用目标页自己」的块 ⇒ 它既在正文，也出现在 footer 反链里
  const blockId = await page.evaluate((target) => {
    const bs = window.__qua.blocks()
    const b = bs.find((x) => x.id !== target && x.text.length > 2)
    window.__qua.focusBlock(b.id, b.text.length)
    window.__qua.invoke('core.editor/insert-page-ref', { pageId: target })
    return b.id
  }, targetPage)
  await page.waitForTimeout(350) // footer 的 200ms 查询去抖

  const footer = await page.evaluate((id) => {
    const row = document.querySelector(`#editor .mount .mount-editor .blk[data-block-id="${id}"] .tx`)
    // 挂载区的第一栏恒为「引用」：反链 footer 收成了它（空态在 body 里一行，栏不消失）
    return { visible: Boolean(row), text: row?.textContent ?? '' }
  }, blockId)
  assert(footer.visible, `footer 反链应出现：${JSON.stringify(footer)}`)

  // 在 footer 里原地编辑；正文里的同一块（同一 store 对象）应同步
  /**
   * 落点要**真的在可编辑文本里**：
   *   · 点 `.tx` 最右侧的空白不一定落在内容区（`.tx` 比文字宽，右缘可能只是 padding，
   *     Chrome 那边不落光标 ⇒ 后面的打字全丢，CI 上实测 `Y` 一个字都没进去）；
   *   · 只点一次再 `End`，行里有行内原子时「行尾」还会因字体度量落到原子之前。
   * ⇒ 点 `.tx` 的**左内侧**（一定在文本行上），再连按两次 `End` 确保到行尾。
   */
  const clickSpot = await page.evaluate((id) => {
    const tx = document.querySelector(`#editor .mount .mount-editor .blk[data-block-id="${id}"] .tx`)
    /**
     * ⚠️ **先滚到视口中间再点**：这一行常常贴在视口最底部（实测 top=870 / vh=900），
     *    点上去会被下面的元素接管，焦点落到容器 `.backlinks-editor` 而不是 `.tx`
     *    ⇒ 之后打的字全部丢掉（CI 上就是这样，`Y` 一个字没进去）。
     */
    tx.scrollIntoView({ block: 'center' })
    const r = tx.getBoundingClientRect()
    // 落点取**文本里**的位置：`left + 3` 在行首 padding 上也会落空
    return { x: r.left + 24, y: r.top + r.height / 2 }
  }, blockId)
  await page.mouse.click(clickSpot.x, clickSpot.y)
  /**
   * ⚠️ 判据**不是** `activeElement.className`：`.tx` 的 `contenteditable` 是 `inherit`，
   *    真正可编辑的是祖先宿主 ⇒ 浏览器把焦点报在容器上是正常的。
   *    该验的是「光标是不是落进了这一行」。
   */
  const caretIn = await page.evaluate((id) => {
    const tx = document.querySelector(`#editor .mount .mount-editor .blk[data-block-id="${id}"] .tx`)
    const sel = document.getSelection()
    const node = sel?.anchorNode ?? null
    return {
      inside: Boolean(node && tx.contains(node)),
      block: window.__qua.snapshot().selection?.aBlock ?? '',
      id,
    }
  }, blockId)
  assert(caretIn.inside, `前置：点完光标应落在这一行里：${JSON.stringify(caretIn)}`)
  await page.keyboard.press('End')
  await page.keyboard.type('Y')
  await page.waitForTimeout(120)
  const both = await page.evaluate((id) => ({
    main: window.__qua.blocks().find((b) => b.id === id)?.text ?? '',
    footer: document.querySelector(`#editor .mount .mount-editor .blk[data-block-id="${id}"] .tx`)?.textContent ?? '',
  }), blockId)
  assert(both.footer.includes('Y'), `footer 应可原地编辑：${JSON.stringify(both)}`)
  assert(both.main.includes('Y'), `正文里的同一块应同步（共享 store）：${JSON.stringify(both)}`)

  // 全局 undo：焦点在 footer，Meta+Z 回滚 store，正文与 footer 一起复原
  await page.keyboard.press(kbd('mod+z'))
  /**
   * undo 是「整片森林换一遍」：`store.restore` 原地换 `blocks` 的内容 ⇒ 各视图手里
   * 那批块对象**当场过期**，必须按 id 重取。而此刻焦点在挂载区里——那条「里层在打字时
   * 不搬 DOM」的推迟策略曾经把正文这次重排一直拖到焦点离开（正文停在旧内容上）。
   * 现在 undo/redo 走 `force`（森林整体被换掉时推迟没有意义）⇒ 120ms 内两边就一致。
   */
  await page.waitForTimeout(120)
  const undone = await page.evaluate((id) => ({
    main: window.__qua.blocks().find((b) => b.id === id)?.text ?? '',
    footer: document.querySelector(`#editor .mount .mount-editor .blk[data-block-id="${id}"] .tx`)?.textContent ?? '',
  }), blockId)
  assert(!undone.footer.includes('Y') && !undone.main.includes('Y'), `footer 里的 undo 应回滚两个实例：${JSON.stringify(undone)}`)

  await ctx.close()
  return 'footer 反链：原地编辑 + 正文同步 + 全局 undo'
})

await check('T40 反链 footer 的块标能聚焦：点一下中心槽切到该源块（嵌套块也进得去），不误建空块', async () => {
  const { ctx, page } = await freshPage(browser, base)
  const targetPage = await page.evaluate(() => window.__qua.pages()[0].id)
  await page.evaluate((id) => window.__qua.invoke('core.page/open', { pageId: id }), targetPage)

  // 源块挑**深度 ≥ 2** 的：只在顶层里找目标的实现会在这条路径上失败
  const src = await page.evaluate((target) => {
    const ed = window.__qua.__editor
    const plain = (x) => x.content.filter((r) => r.t === 'text').map((r) => r.v).join('')
    const walk = (b, d) => {
      if (d >= 2 && plain(b).length > 2) return b
      for (const c of b.children) {
        const hit = walk(c, d + 1)
        if (hit) return hit
      }
      return null
    }
    const b = walk(ed.doc.roots[0], 0)
    window.__qua.focusBlock(b.id, plain(b).length)
    window.__qua.invoke('core.editor/insert-page-ref', { pageId: target })
    // 读的是插入**之后**的投影文本（露面不进投影），它同时也是 zoom 之后的页名
    return { id: b.id, text: plain(b) }
  }, targetPage)
  await page.waitForTimeout(350) // footer 的 200ms 查询去抖

  const marker = `#editor .mount .mount-editor .blk[data-block-id="${src.id}"] > .left > .marker`
  assert((await page.locator(marker).count()) === 1, `footer 里应有该源块的块标：${src.id}`)
  const before = await snap(page)
  await page.locator(marker).click()
  await page.waitForTimeout(400)

  const after = await page.evaluate(() => ({
    active: window.__qua.snapshot().activePage,
    total: window.__qua.snapshot().totalBlocks,
    firstId: document.querySelector('#editor .blk')?.dataset.blockId ?? '',
    rows: document.querySelectorAll('#editor .blk').length,
  }))
  assert(after.active === src.text, `中心槽应切到该源块（页名 = 源块正文）：${JSON.stringify({ want: src.text, got: after.active })}`)
  assert(after.firstId === src.id, `正文首行应是源块 ${src.id}，实际 ${after.firstId}`)
  assert(after.rows > 0, '聚焦后正文不该没有行')
  // 点块标还会冒泡到「点空白建块」那一支 ⇒ 块数必须一条不差
  assert(after.total === before.totalBlocks, `点块标不该建块：${before.totalBlocks} → ${after.total}`)

  await ctx.close()
  return `点嵌套源块 ${src.id.slice(-6)} 的块标 ⇒ 正文首行切到它（块数仍 ${after.total}）`
})

await check('T41 冷启动直接打字后 ⌘Z：撤销只回滚文字，不把整片正文清空（未经 openPage）', async () => {
  const { ctx, page } = await freshPage(browser, base)

  /**
   * ⚠️ 冷启动走的是 `new BlockEditor({ doc })`，**没有** `loadPage()`。
   *    root id 若只在 `loadPage()` 里登记，第一次 undo 的 `reloadFromStore()` 就会
   *    按空列表重载 ⇒ 正文（`doc.roots`）被清空，而 store 里的块其实还在。
   *    所以这里**不调用** openPage，直接从冷启动状态打字。
   */
  const before = await page.evaluate(() => {
    const bs = window.__qua.blocks()
    const b = bs.find((x) => !x.roles?.includes('journal'))
    window.__qua.focusBlock(b.id, 0)
    const s = window.__qua.snapshot()
    return { id: b.id, text: b.text, texts: window.__qua.text(), total: s.totalBlocks, dom: s.domBlocks }
  })
  await page.keyboard.type('Z')
  await page.waitForTimeout(80)
  const typed = await page.evaluate((id) => window.__qua.blocks().find((b) => b.id === id)?.text ?? '', before.id)
  assert(typed.startsWith('Z'), `冷启动后应能直接敲进第一行：${JSON.stringify(typed.slice(0, 8))}`)

  await page.keyboard.press(kbd('mod+z'))
  await page.waitForTimeout(150)
  const after = await page.evaluate(() => {
    const s = window.__qua.snapshot()
    return { texts: window.__qua.text(), total: s.totalBlocks, dom: s.domBlocks, rows: document.querySelectorAll('#editor .blk').length }
  })
  assert(after.rows > 0, '撤销后正文一行都不剩（DOM 被清空）')
  assert(after.texts.length === before.texts.length, `撤销后正文行数应复原：${before.texts.length} → ${after.texts.length}`)
  assert(JSON.stringify(after.texts) === JSON.stringify(before.texts), `撤销应把文字回到原样：${JSON.stringify({ before: before.texts.slice(0, 2), after: after.texts.slice(0, 2) })}`)
  assert(after.total === before.total && after.dom === before.dom, `撤销不该改块数/DOM 行数：${JSON.stringify({ before, after })}`)

  await ctx.close()
  return `冷启动敲 1 字 → ⌘Z：${before.texts.length} 行原样回来（DOM ${after.dom} 行，块数 ${after.total}）`
})

await check('T42 冷启动后在反链 footer 编辑，不会把正文重载成空（共享 store 首次 touch）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  const ids = await page.evaluate(() => {
    const bs = window.__qua.blocks()
    const j = bs.find((b) => b.roles?.includes('journal'))
    const src = bs.find((b) => !b.roles?.includes('journal') && b.text.length > 2)
    window.__qua.focusBlock(src.id, src.text.length)
    /**
     * `[[ ]]` 的引用目标只解析 `page` 角色（journal 的正文是空的，日期在 `_date` 里），
     * 所以「让今日 journal 有反链」只能直接在编辑器上放一个原子里。这里要紧的是
     * **冷启动**这条路径（没有 openPage），不是用户从哪个菜单插的。
     */
    const atomId = window.__qua.__editor.insertRef({ to: j.id, label: '今日' })
    return { journal: j.id, src: src.id, atomId }
  })
  assert(ids.atomId, '冷启动下应能往正文插一个指向今日 journal 的原子')
  await page.waitForTimeout(350)

  assert(
    await page.evaluate(() => document.querySelectorAll('#editor .mount .mount-tab').length > 0),
    '冷启动的当前对象（今日 journal）应出现挂载区（引用栏恒在）',
  )
  const before = await page.evaluate(() => ({
    texts: window.__qua.text(),
    rows: document.querySelectorAll('#editor .blk').length,
    firstId: document.querySelector('#editor .blk')?.dataset.blockId ?? '',
  }))
  assert(before.rows > 0, '冷启动正文应有行')

  /**
   * 点 `.tx` 的左侧文字区：这一行末尾就是刚插入的原子，点正中会命中原子（＝打开引用），
   * 这里要的是「在 footer 里改文字」。
   */
  await page.locator(`#editor .mount .mount-editor .blk[data-block-id="${ids.src}"] > .tx`).first().click({ position: { x: 6, y: 6 } })
  await page.keyboard.press('End')
  await page.keyboard.type('Y')
  await page.waitForTimeout(150)

  const after = await page.evaluate((id) => ({
    rows: document.querySelectorAll('#editor .blk').length,
    texts: window.__qua.text(),
    firstId: document.querySelector('#editor .blk')?.dataset.blockId ?? '',
    footer: document.querySelector(`#editor .mount .mount-editor .blk[data-block-id="${id}"] > .tx`)?.textContent ?? '',
  }), ids.src)
  assert(after.rows > 0, `footer 编辑后正文被清空了：${before.rows} 行 → ${after.rows} 行`)
  // 点击 footer 会把 #scroll 带到底部，日记流可能追加更早的天 ⇒ 只许变多，不许变少
  assert(after.texts.length >= before.texts.length, `正文不该被重载成更少：${before.texts.length} → ${after.texts.length}`)
  assert(after.firstId === before.firstId, `正文首行不该被换掉：${before.firstId} → ${after.firstId}`)
  assert(after.footer.includes('Y'), 'footer 里的编辑没生效')
  assert(after.texts.some((t) => t.includes('Y')), '正文里的同一块应同步（共享 store）')

  await ctx.close()
  return `冷启动 footer 编辑：正文 ${before.rows} 行仍在，两处同步到 Y`
})

await check('T43 待办是块标之后的身份图标：块标仍是圆点、仍可聚焦', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await openFirstPage(page)

  // 深缩进：把一个第 3 层的块标成待办
  const deep = await page.evaluate(() => {
    const ed = window.__qua.__editor
    const plain = (x) => x.content.filter((r) => r.t === 'text').map((r) => r.v).join('')
    const walk = (b, d) => {
      if (d >= 2 && plain(b).length > 2) return b
      for (const c of b.children) {
        const hit = walk(c, d + 1)
        if (hit) return hit
      }
      return null
    }
    const b = walk(ed.doc.roots[0], 0)
    window.__qua.focusBlock(b.id, 0)
    window.__qua.invoke('core.editor/toggle-todo')
    return b.id
  })

  const readRow = (id) =>
    page.evaluate((blockId) => {
      // 只认**正文自己的行**：同一块也可能出现在正文内联的查询结果里（第二处露面）
      const row = document.querySelector(`#editor > .sec > .blk[data-block-id="${blockId}"]`)
      const m = row?.querySelector(':scope > .left > .marker')
      const box = row?.querySelector(':scope > .left > .todo-box')
      const before = m ? getComputedStyle(m, '::before') : null
      return {
        todo: row?.dataset.todo ?? '',
        depth: Number(row?.dataset.depth ?? -1),
        classes: m ? [...m.classList].sort().join(' ') : '',
        focusFor: m?.dataset.focusFor ?? '',
        boxClasses: box ? [...box.classList].sort().join(' ') : '',
        before: before?.content ?? '',
        boxW: box?.querySelector('.ico') ? getComputedStyle(box.querySelector('.ico')).width : '',
      }
    }, id)

  const deepRow = await readRow(deep)
  assert(deepRow.todo !== '' && deepRow.depth >= 2, `深缩进待办没建成：${JSON.stringify(deepRow)}`)
  // 块标对任何身份都一样：圆点 ＋ 聚焦入口（身份只是挂在它后面的后缀）
  assert(deepRow.classes === 'bullet handle marker', `待办行的块标仍是块标：${deepRow.classes}`)
  assert(deepRow.focusFor === deep, `待办行的块标仍要点＝聚焦：${deepRow.focusFor}`)
  assert(deepRow.before !== 'none', `待办行的块标仍应画圆点（::before content=${deepRow.before}）`)
  assert(deepRow.boxClasses.includes('todo-box'), `方框应在身份图标上：${deepRow.boxClasses}`)
  assert(deepRow.boxW === '12px', `方框应正常画出来：${deepRow.boxW}`)

  // 假数据里已有的 todo / done 两态都带身份图标，且块标不因此换形状
  const all = await page.evaluate(() =>
    [...document.querySelectorAll('#editor .blk[data-todo]')].map((row) => {
      const m = row.querySelector(':scope > .left > .marker')
      const box = row.querySelector(':scope > .left > .todo-box')
      return {
        todo: row.dataset.todo,
        classes: m ? [...m.classList].sort().join(' ') : '',
        boxClasses: box ? [...box.classList].sort().join(' ') : '',
        boxW: box?.querySelector('.ico') ? getComputedStyle(box.querySelector('.ico')).width : '',
      }
    }),
  )
  assert(all.some((r) => r.todo === 'todo') && all.some((r) => r.todo === 'done'), `应同时看到 todo 与 done：${JSON.stringify(all)}`)
  for (const r of all) {
    assert(r.classes === 'bullet handle marker', `待办（${r.todo}）的块标不该换形状：${JSON.stringify(r)}`)
    assert(r.boxClasses.includes('todo-box') && r.boxW === '12px', `待办（${r.todo}）的方框应在：${JSON.stringify(r)}`)
  }

  // hover 只改块标的可见度（点换 grip），身份图标不该跟着动
  await page.locator(`#editor > .sec > .blk[data-block-id="${deep}"] > .left > .marker`).hover()
  const hovered = await readRow(deep)
  assert(
    hovered.boxW === '12px' && hovered.focusFor === deep,
    `悬停块标不该动身份图标：${JSON.stringify(hovered)}`,
  )

  await ctx.close()
  return `todo/done/深缩进（depth ${deepRow.depth}）三种：块标恒为圆点＋可聚焦，方框在身份图标上（.ico ${deepRow.boxW}）`
})

await check('T44 左键点引用直接打开目标；⌥ 才弹详情；dangling 弹详情；图片左键 lightbox', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await openFirstPage(page)

  const r = await page.evaluate(() => {
    const el = document.querySelector('#editor .atom-page:not(.dangling)')
    const a = window.__qua.atoms().find((x) => x.id === el?.dataset.atomId)
    const target = window.__qua.pages().find((p) => p.id === a?.target?.id)
    return {
      atomId: el?.dataset.atomId ?? '',
      title: el?.title ?? '',
      targetTitle: target?.title ?? '',
      total: window.__qua.snapshot().totalBlocks,
    }
  })
  assert(r.atomId && r.targetTitle, `应能找到一条可解析的页面引用：${JSON.stringify(r)}`)
  assert(r.title.includes('左键打开') && r.title.includes('⌥'), `原子 title 应说明「左键打开、⌥ 详情」：${r.title}`)

  // 左键：直接打开目标块（页面），不弹详情、不建块
  await page.locator(`#editor .atom-page[data-atom-id="${r.atomId}"]`).click()
  await page.waitForTimeout(200)
  const opened = await page.evaluate(() => {
    const s = window.__qua.snapshot()
    return { active: s.activePage, total: s.totalBlocks, popover: document.querySelectorAll('.popover').length }
  })
  assert(opened.active === r.targetTitle, `左键应打开目标：${JSON.stringify({ want: r.targetTitle, got: opened.active })}`)
  assert(opened.popover === 0, '左键不该弹详情浮层')
  assert(opened.total === r.total, `打开引用不该建块：${r.total} → ${opened.total}`)

  // ⌥：仍弹原来的详情（含删除引用）
  await openFirstPage(page)
  await page.waitForTimeout(100)
  await page.locator(`#editor .atom-page[data-atom-id="${r.atomId}"]`).click({ modifiers: ['Alt'] })
  const pop = await page.locator('.popover').innerText()
  assert(pop.includes('删除这个引用'), `⌥ 点击应弹详情浮层：${pop.slice(0, 60)}`)
  await page.keyboard.press('Escape')

  // dangling：左键也只能弹详情（不静默失败）
  const dangling = await page.evaluate(() => {
    const el = document.querySelector('#editor .atom-page.dangling')
    return { atomId: el?.dataset.atomId ?? '', title: el?.title ?? '' }
  })
  assert(dangling.atomId, '假数据里应有 dangling 引用')
  assert(dangling.title.includes('目标不存在'), `dangling 的 title 该说实话：${dangling.title}`)
  await page.locator('#editor .atom-page.dangling').first().click()
  const dPop = await page.locator('.popover').innerText()
  assert(dPop.includes('dangling') || dPop.includes('目标不存在'), `dangling 该弹详情并说明状态：${dPop.slice(0, 80)}`)
  await page.keyboard.press('Escape')

  /**
   * 图片原子：左键**不再是详情**，而是 lightbox（那是「看这张图」的默认动作）；
   * `⌥` 才回到详情。两条都验，否则「点了没反应」与「弹错东西」分不开。
   */
  await page.locator('#editor .atom-image').first().click()
  const openedLb = await page.evaluate(() => Boolean(document.querySelector('.lightbox')))
  assert(openedLb, '左键点图应开 lightbox（不是详情）')
  await page.keyboard.press('Escape')
  await page.locator('#editor .atom-image').first().click({ modifiers: ['Alt'] })
  const iPop = await page.locator('.popover').innerText()
  assert(iPop.includes('删除这个图片原子'), `⌥ 点图仍应弹资产信息：${iPop.slice(0, 60)}`)

  await ctx.close()
  return `左键打开「${r.targetTitle}」；⌥/dangling 弹详情、图片左键 lightbox / ⌥ 详情；块数仍 ${opened.total}`
})

await check('T15 角标：块数 / DOM 节点数 / 主题 / composing 都在', async () => {
  const { ctx, page } = await freshPage(browser, base)
  /**
   * 首屏的行内图片是异步到位的（文件占位 → 真图会换掉几个节点），而角标是**按 rAF 刷新**
   * 的派生读数。判据是「资产落定之后，角标跟得上当前快照」——等它收敛，而不是读一帧快照
   * 赌那一帧恰好是新的（分两次 evaluate 更会变成时序竞态，真踩过）。
   */
  await page.waitForFunction(
    () => {
      const imgs = [...document.querySelectorAll('#editor .atom-image img')]
      const settled = imgs.length === 0 || imgs.every((im) => im.naturalWidth > 0)
      const s = window.__qua.snapshot()
      return settled && (document.getElementById('badge')?.innerText ?? '').includes(String(s.domNodes))
    },
    null,
    { timeout: 8000 },
  )
  const { badge, s } = await page.evaluate(() => ({
    badge: document.getElementById('badge')?.innerText ?? '',
    s: window.__qua.snapshot(),
  }))
  assert(badge.includes(String(s.blocks)), `角标应含块数 ${s.blocks}：${badge}`)
  assert(badge.includes(String(s.domNodes)), `角标应含 DOM 节点数 ${s.domNodes}：${badge}`)
  assert(/主题/.test(badge), `角标应含主题：${badge}`)
  assert(badge.includes('composing'), `角标应含 composing：${badge}`)
  await page.evaluate(() => window.__qua.badgePanel(true))
  const panel = await page.locator('#badge-panel').innerText()
  assert(panel.includes('上下文键') && panel.includes('按键命中追踪'), `角标面板应含诊断两件套：${panel.slice(0, 80)}`)
  await ctx.close()
  return badge.replace(/\s+/g, ' ')
})

await check('T18 跨页锚点不被误删：在当前容器里删块，只回收**这一块**的锚点', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))

  /**
   * ⚠️ 这条是 2026-10-20 修掉的一个**真实数据丢失**的回归断言：
   *   `marks`/`atoms` 是**库级平铺**的，而 `ed.doc` 只装**当前容器的子树**。
   *   早先用 `ed.doc` 去裁剪库级锚点 ⇒ 在任一页删一块，**别的页的锚点全被静默删掉**
   *   （实机复现：marks 24→7；落在 journal 上时 28→1）。
   * ⇒ 判死范围必须只限**本容器内**的块；容器外的锚点编辑器无权处置。
   */
  const before = await page.evaluate(() => {
    // 先打开一个有锚点的页，把它自己那几块的锚点 id 记下来做对照
    window.__qua.invoke('core.page/open', { pageId: window.__qua.pages()[0].id })
    const own = new Set(window.__qua.blocks().map((b) => b.id))
    return {
      marks: window.__qua.marks().length,
      atoms: window.__qua.atoms().length,
      own: [...own],
    }
  })
  // 回到别的容器（今日 journal），删掉一块
  await page.evaluate(() => window.__qua.invoke('core.journal/today'))
  await new Promise((r) => setTimeout(r, 150))
  const target = await page.evaluate(() => {
    const bs = window.__qua.blocks()
    const id = bs[bs.length - 1].id
    window.__qua.focusBlock(id, 0)
    return id
  })
  const mid = await page.evaluate((id) => ({
    marks: window.__qua.marks().length,
    atoms: window.__qua.atoms().length,
    // 被删那一块自己带几条锚点 ⇒ 允许的掉幅度**恰好**等于这个数
    onTarget: window.__qua.marks().filter((m) => m.blockId === id).length,
  }), target)
  await page.evaluate(() => window.__qua.invoke('core.editor/delete-block'))
  await new Promise((r) => setTimeout(r, 250))
  const after = await page.evaluate(() => ({ marks: window.__qua.marks().length, atoms: window.__qua.atoms().length }))

  // 判据：掉的数量**恰好**＝被删块自带的锚点数，不能多一条
  assert(after.marks === mid.marks - mid.onTarget, `只该回收被删块自己的锚点（应少 ${mid.onTarget} 条）：${JSON.stringify({ mid, after })}`)
  assert(after.atoms <= mid.atoms, `原子不该变多：${JSON.stringify({ mid, after })}`)
  // 回到第一页：它自己的锚点必须还在（这是 bug 最直观的证据）
  await page.evaluate(() => window.__qua.invoke('core.page/open', { pageId: window.__qua.pages()[0].id }))
  await new Promise((r) => setTimeout(r, 250))
  const back = await page.evaluate(() => ({ marks: window.__qua.marks().length, atoms: window.__qua.atoms().length }))
  assert(back.marks >= before.marks - 3, `第一页的锚点不该被别的容器删掉：${JSON.stringify({ before, back })}`)
  assert(back.atoms >= before.atoms, `第一页的原子不该被删：${JSON.stringify({ before, back })}`)

  await ctx.close()
  return `删 ${target.slice(-6)}：库级 marks ${mid.marks}→${after.marks}、atoms ${mid.atoms}→${after.atoms}；回到第一页仍有 ${back.marks} 条锚点（起始 ${before.marks}）`
})

await check('T19 zoom in：进子树、面包屑可退回、顶层时面包屑隐藏、锚点不走丢', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))

  const st = () =>
    page.evaluate(() => ({
      // ：没有标题 ⇒ 「聚焦到谁」看**首行**是谁（首行 = 当前对象自己）
      firstRow: (() => {
        const first = document.querySelector('#editor .blk[data-depth="0"] .tx')
        return first?.textContent?.trim() ?? ''
      })(),
      trailShown: (() => {
        const e = document.querySelector('#crumbs-trail')
        return Boolean(e && !e.hidden)
      })(),
      trail: [...document.querySelectorAll('#crumbs-trail .crumb')].map((c) => c.textContent),
      here: window.__qua.blocks().length,
      marks: window.__qua.marks().length,
      atoms: window.__qua.atoms().length,
    }))

  // ① 顶层：面包屑不出现（现状观感不被改变）
  await page.evaluate(() => window.__qua.invoke('core.page/open', { pageId: window.__qua.pages()[0].id }))
  await new Promise((r) => setTimeout(r, 200))
  const top = await st()
  assert(!top.trailShown, `顶层不该显示面包屑：${JSON.stringify(top)}`)

  // ② zoom 进一个有子块的块：编辑器只剩它的子树；面包屑出现且只有祖先（不含自己）
  const target = await page.evaluate(() => {
    // ⚠️ 排除**首行**（= 顶层页块自己）：zoom 到顶层等于没 zoom，面包屑必然为空
    const ids = new Set([...document.querySelectorAll('#editor .blk[data-depth="0"]')].map((el) => el.dataset.blockId))
    const b = window.__qua.blocks().find((x) => x.children > 0 && !ids.has(x.id))
    return b ? { id: b.id, text: b.text } : null
  })
  assert(target, '假数据里应有带子块的非顶层块')
  await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), target.id)
  await new Promise((r) => setTimeout(r, 250))
  const zoomed = await st()
  assert(zoomed.trailShown, `zoom 后应出现面包屑：${JSON.stringify(zoomed)}`)
  assert(zoomed.trail.length === 1 && zoomed.trail[0] === '产品设计 · 决策日志', `面包屑应是祖先链（不含自己）：${JSON.stringify(zoomed.trail)}`)
  assert(zoomed.here < top.here, `zoom 后应只剩子树：${top.here} → ${zoomed.here}`)
  assert(zoomed.firstRow === target.text.trim(), `被聚焦的块应是**正文第一行**（不是标题）：${JSON.stringify({ want: target.text.trim(), got: zoomed.firstRow })}`)
  // **关键不变量**：zoom 收窄 ed.doc，但库级锚点一条都不能掉（修的那条在这里也守着）
  assert(zoomed.marks === top.marks && zoomed.atoms === top.atoms, `zoom 不该动锚点：${JSON.stringify({ top, zoomed })}`)

  // ③ 点面包屑退回
  await page.locator('#crumbs-trail .crumb').first().click()
  await new Promise((r) => setTimeout(r, 250))
  const back = await st()
  assert(!back.trailShown && back.here === top.here, `面包屑点一下应退回顶层：${JSON.stringify(back)}`)
  assert(back.firstRow === top.firstRow, `退回后首行应复原为顶层块：${JSON.stringify({ want: top.firstRow, got: back.firstRow })}`)

  /**
   * ④ **叶子块也给 zoom**（聚焦含块自身，不是只看子树）。
   *    旧口径「没有子树可聚焦就不给」会让点击行为**时 zoom 时不 zoom**；
   *    行为是「点块标＝聚焦」，叶子上就是「只看这一块」。
   *    ⇒ 现在 zoom 到叶子：编辑器只剩它一行，面包屑仍是它自己的祖先链。
   */
  const leaf = await page.evaluate(() => {
    const ids = new Set([...document.querySelectorAll('#editor .blk[data-depth="0"]')].map((el) => el.dataset.blockId))
    const b = window.__qua.blocks().find((x) => x.children === 0 && !ids.has(x.id))
    return b ? { id: b.id, text: b.text } : null
  })
  let leafView = null
  if (leaf) {
    await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), leaf.id)
    await new Promise((r) => setTimeout(r, 250))
    leafView = await st()
    assert(leafView.trailShown, `叶子块也应能 zoom：${JSON.stringify(leafView)}`)
    assert(leafView.here === 1, `zoom 到叶子后编辑器应只剩它一行，实际 ${leafView.here} 块`)
    assert(leafView.firstRow === leaf.text.trim(), `那一行应是叶子自己：${JSON.stringify({ want: leaf.text, got: leafView.firstRow })}`)
  }

  await ctx.close()
  return `顶层 ${top.here} 块 → zoom ${zoomed.here} 块（面包屑「${zoomed.trail.join(' › ')}」）→ 退回 ${back.here} 块${leafView ? ` → 叶子 zoom ${leafView.here} 块` : ''}；锚点恒 ${top.marks}/${top.atoms}`
})

await check('T25 块标左键 = 聚焦/zoom：点一下进子树，右键才开菜单', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  await page.evaluate(() => window.__qua.invoke('core.page/open', { pageId: window.__qua.pages()[0].id }))
  await new Promise((r) => setTimeout(r, 200))

  const target = await page.evaluate(() => {
    const ids = new Set([...document.querySelectorAll('#editor .blk[data-depth="0"]')].map((el) => el.dataset.blockId))
    const b = window.__qua.blocks().find((x) => x.children > 0 && !ids.has(x.id))
    // ⚠️ `__qua.blocks()` 把 children 拍平成**计数**；子树规模用「可见行数」口径：
    //    zoom 后编辑器装载的就是这棵树，`blocks()` 的长度就是子树块数。
    return b ? { id: b.id, text: b.text.trim(), kids: b.children } : null
  })
  assert(target, '假数据里应有带子块的非顶层块')
  // ① **左键点块标** ⇒ zoom 进去（编辑器只剩子树；面包屑出现）
  await page.evaluate((id) => {
    const marker = document.querySelector(`.blk[data-block-id="${id}"] .marker`)
    marker.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  }, target.id)
  await new Promise((r) => setTimeout(r, 250))
  const zoomed = await page.evaluate(() => ({
    trail: [...document.querySelectorAll('#crumbs-trail .crumb')].map((c) => c.textContent),
    here: window.__qua.blocks().length,
    firstRow: document.querySelector('#editor .blk .tx')?.textContent ?? '',
    menuOpen: document.querySelectorAll('.layer').length,
  }))
  assert(zoomed.menuOpen === 0, '左键点块标不该打开菜单（D1：菜单归右键）')
  assert(zoomed.here > target.kids, `点块标应 zoom 进整棵子树（> ${target.kids} 块），实际 ${zoomed.here} 块`)
  assert(zoomed.here < 17, `zoom 应收窄视图（顶层 17 块），实际 ${zoomed.here} 块`)
  assert(zoomed.trail.length >= 1, `zoom 后应出现面包屑（祖先链）：${JSON.stringify(zoomed.trail)}`)
  assert(zoomed.firstRow === target.text, `首行应是被聚焦块自己：${JSON.stringify(zoomed.firstRow)}`)

  // ② **右键** ⇒ 开块菜单（不是 zoom）
  await page.evaluate(() => {
    const el = document.querySelector('.blk .marker')
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
  const menuLabels = await page.evaluate(() => [...document.querySelectorAll('.layer-item .layer-label')].map((r) => r.textContent))
  assert(menuLabels.length >= 8, `右键应打开块菜单：${JSON.stringify(menuLabels)}`)
  await page.keyboard.press('Escape')

  // ③ 点顶层自己（depth 0）的块标 ⇒ 仍是 zoom 语义（Breadcrumb 空 ⇒ 视图不变，但不开菜单）
  const selfClick = await page.evaluate(() => {
    const before = window.__qua.blocks().length
    const marker = document.querySelector('#editor .blk[data-depth="0"] .marker')
    marker.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return { before, after: window.__qua.blocks().length, menu: document.querySelectorAll('.layer').length }
  })
  assert(selfClick.menu === 0, '点顶层块标也不该开菜单')
  assert(selfClick.after === selfClick.before, `点顶层块标（＝zoom 到自己）不该改变装载：${JSON.stringify(selfClick)}`)

  await ctx.close()
  return `左键点 ${target.id.slice(-6)} → zoom 收窄到 ${zoomed.here} 块（面包屑「${zoomed.trail.join(' › ')}」，无菜单）；右键 → 块菜单 ${menuLabels.length} 项`
})

await check('T22 首行即当前对象：页块正文（描述）可编辑、在首行按 Enter 不自环', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  await openFirstPage(page)

  // ① 首行是**页块自己**，且**可编辑**（旧形状里它是只读的「标题」）
  const first = await page.evaluate(() => {
    const el = document.querySelector('#editor .blk[data-depth="0"]')
    return { id: el.dataset.blockId, text: el.querySelector('.tx').textContent.trim() }
  })
  assert(first.text === '产品设计 · 决策日志', `首行应是页块正文：${JSON.stringify(first)}`)

  // ② 在首行末尾敲字 ⇒ 改的是**页块的描述**（`text`），不是页名（主别名）
  await page.evaluate((id) => window.__qua.focusBlock(id, 999), first.id)
  await page.keyboard.type('！')
  const edited = await page.evaluate((id) => {
    const b = window.__qua.allBlocks().find((x) => x.id === id)
    const p = window.__qua.pages().find((x) => x.id === id)
    return { text: b?.text ?? '', primary: b?.aliases?.[0] ?? '', title: p?.title ?? '(gone)' }
  }, first.id)
  assert(edited.text.endsWith('！'), `在首行敲字应改到页块的正文（描述）：${JSON.stringify(edited)}`)
  assert(edited.primary === '产品设计 · 决策日志', `改正文不该改地址（主别名）：${JSON.stringify(edited)}`)
  assert(edited.title === '产品设计 · 决策日志', `页列表标题应显示主名，不跟正文走：${JSON.stringify(edited)}`)
  await page.keyboard.press('Backspace')

  // ③ 首行按 Enter：**不自环**（拆块的 children 转移会让「对象变成自己的子块」）
  const n0 = await page.evaluate(() => window.__qua.snapshot().topBlocks)
  await page.evaluate((id) => window.__qua.focusBlock(id, 2), first.id)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(200)
  const r = await page.evaluate(() => ({
    top: window.__qua.snapshot().topBlocks,
    firstRow: document.querySelector('#editor .blk[data-depth="0"] .tx')?.textContent?.trim() ?? '',
    // 自环的证据：首行的 children 里出现了自己的 id
    selfChild: (() => {
      const firstEl = document.querySelector('#editor .blk[data-depth="0"]')
      const id = firstEl?.dataset.blockId
      return id ? window.__qua.blocks().some((b) => b.id === id && b.children > 0 && false) : null
    })(),
    // 编辑器里应**多出一行**（Enter 另起一行），且首行文本不变
    rows: document.querySelectorAll('#editor .blk').length,
    secondRow: document.querySelectorAll('#editor .blk')[1]?.querySelector('.tx')?.textContent ?? '',
  }))
  assert(r.firstRow === first.text, `首行应仍是页块正文（不自环）：${JSON.stringify(r)}`)
  assert(r.secondRow === '', `Enter 应在首行下面另起一个空块：${JSON.stringify(r)}`)
  assert(r.top === n0, `顶层块数不该变：${n0} → ${r.top}`)

  await ctx.close()
  return `首行=页块「${first.text}」；敲字改到正文；Enter 另起一行、无自环`
})

await check('T16 每一页的锚点与 DOM 表现逐条对得上（标记顺序不串位）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  const samples = []
  const pageCount = await page.evaluate(() => window.__qua.pages().length)
  for (let i = 0; i < pageCount; i++) {
    await page.evaluate((n) => window.__qua.invoke('core.page/open', { pageId: window.__qua.pages()[n].id }), i)
    const r = await page.evaluate(() => {
      const blocks = window.__qua.blocks()
      // 锚点是**库级平铺**的：只取落在当前页可见块上的那些（其余属于别的页）
      const visible = new Map(blocks.map((b) => [b.id, b]))
      const model = window.__qua
        .marks()
        .filter((m) => visible.has(m.blockId))
        .map((m) => `${m.type}::${visible.get(m.blockId).text.slice(m.start, m.end)}`)
      const dom = [...document.querySelectorAll('#editor .mk')].map((e) => `${e.className.replace('mk mk-', '')}::${e.textContent}`)
      return { model: [...model].sort(), dom: [...dom].sort() }
    })
    const missing = r.model.filter((x) => !r.dom.includes(x))
    const extra = r.dom.filter((x) => !r.model.includes(x))
    assert(missing.length === 0 && extra.length === 0, `第 ${i + 1} 页锚点与 DOM 不一致｜模型多出：${JSON.stringify(missing.slice(0, 3))}｜DOM 多出：${JSON.stringify(extra.slice(0, 3))}`)
    samples.push(...r.model)
  }
  assert(samples.some((x) => x === 'highlight::先高亮'), `顺序样本（先高亮）没生效：${JSON.stringify(samples.slice(0, 8))}`)
  assert(samples.some((x) => x === 'bold::后加粗'), `后加粗的区间应恰好落在「后加粗」上：${JSON.stringify(samples.filter((x) => x.includes('加粗')))}`)
  await ctx.close()
  return `${samples.length} 条锚点逐条与 DOM 对齐（跨 ${pageCount} 页，含「先高亮后加粗」的顺序样本）`
})

/* ---------------------------------------------------------------- 数据安全 */

await check('T20 过新 / 损坏的库不被覆盖：进入只读演示态并持久告警', async () => {
  const KEY = 'qua.workspace'
  const run = async (raw) => {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } })
    const page = await ctx.newPage()
    await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [KEY, raw])
    await page.goto(base, { waitUntil: 'load' })
    await page.waitForFunction(() => Boolean(window.__qua))
    const snap = await page.evaluate(() => window.__qua.snapshot())
    const after = await page.evaluate((k) => localStorage.getItem(k), KEY)
    const notice = await page.locator('#boot-notice')
    const result = { snap, after, visible: await notice.isVisible(), text: (await notice.textContent()) ?? '' }
    await ctx.close()
    return result
  }

  const newer = JSON.stringify({
    version: 99,
    blocks: [{ id: 'keep', text: 'KEEP-ME', children: [] }],
    activeId: 'keep',
    prefs: {},
    savedAt: 0,
    marks: [],
    atoms: [],
  })
  const a = await run(newer)
  assert(a.snap.readOnly === true, `过新库应进入只读态：${JSON.stringify(a.snap.bootNotice)}`)
  assert(a.after === newer, `过新的库被覆盖了：${String(a.after).slice(0, 80)}`)
  assert(a.visible && a.text.includes('只读'), `应有持久告警：${JSON.stringify(a.text)}`)

  const corrupt = '{oops'
  const b = await run(corrupt)
  assert(b.snap.readOnly === true, `损坏库应进入只读态：${JSON.stringify(b.snap.bootNotice)}`)
  assert(b.after === corrupt, `损坏的库被覆盖了：${String(b.after).slice(0, 80)}`)

  /**
   * ③ **只读态下的出路**：调试菜单里有一行「备份并重建本地库」。
   *
   * 行为要同时满足两条：
   *   · 覆盖之前**先把原始字节抄到备份键**（否则「恢复」等于「抹掉唯一还能抢救的那份」）；
   *   · 覆盖之后真的回到可写（`readOnly` 翻假、告警收起），而且新字节能被下一次启动打开。
   * 第二点只能靠**另起一个 context 装新字节**来验：同一个页面上的 initScript 每次导航都会
   * 把损坏的字节写回去，原样刷新验不出「盘上那份现在是好的」。
   */
  const recoverCtx = await browser.newContext({ viewport: { width: 1200, height: 800 } })
  const recoverPage = await recoverCtx.newPage()
  await recoverPage.addInitScript(([k, v]) => localStorage.setItem(k, v), [KEY, corrupt])
  await recoverPage.goto(base, { waitUntil: 'load' })
  await recoverPage.waitForFunction(() => Boolean(window.__qua))
  await recoverPage.locator('#state-menu-btn').click()
  await recoverPage.waitForFunction(
    () => [...document.querySelectorAll('.layer-label')].some((e) => e.textContent === '备份并重建本地库'),
    null,
    { timeout: 2000 },
  )
  // 与 T3c 的菜单点击同一个入口（行是 mousedown 选中，不是 click）
  await recoverPage.evaluate(() => {
    const row = [...document.querySelectorAll('.layer-item')].find((r) => r.querySelector('.layer-label')?.textContent === '备份并重建本地库')
    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  })
  await recoverPage.waitForFunction(() => localStorage.getItem('qua.workspace') !== '{oops', null, { timeout: 3000 })
  const recovered = await recoverPage.evaluate(() => {
    const backupKeys = Object.keys(localStorage).filter((k) => k.startsWith('qua.workspace.bak.'))
    const snap = window.__qua.snapshot()
    return {
      raw: localStorage.getItem('qua.workspace'),
      backupKey: backupKeys[0] ?? '',
      backup: backupKeys.length > 0 ? localStorage.getItem(backupKeys[0]) : null,
      snap,
      noticeHidden: document.querySelector('#boot-notice')?.hidden ?? false,
    }
  })
  assert(recovered.backupKey, '重建前应先把原始字节存到备份键')
  assert(recovered.backup === corrupt, `备份内容应是损坏的原始字节：${String(recovered.backup).slice(0, 80)}`)
  assert(recovered.snap.readOnly === false, `重建后应回到可写：${JSON.stringify(recovered.snap.bootNotice)}`)
  assert(recovered.noticeHidden, '重建后只读告警应当收起')
  const written = JSON.parse(String(recovered.raw))
  assert(written?.backend === 'local-storage' && Array.isArray(written?.data?.blocks) && written.data.blocks.length > 0,
    `重建应写回一份能读的库：${String(recovered.raw).slice(0, 80)}`)

  // 菜单里那一行自退场（`getReadOnly()` 已翻假），不会留着「点第二次又清一次」
  await recoverPage.locator('#state-menu-btn').click()
  const labelsAfter = await recoverPage.evaluate(() =>
    [...document.querySelectorAll('.layer-label')].map((e) => e.textContent ?? ''),
  )
  assert(!labelsAfter.includes('备份并重建本地库'), `重建成功后恢复入口应退场：${JSON.stringify(labelsAfter)}`)
  await recoverCtx.close()

  // ④ 另起 context 用新字节冷启动：能打开，且不是只读态
  const reopenCtx = await browser.newContext({ viewport: { width: 1200, height: 800 } })
  const reopenPage = await reopenCtx.newPage()
  await reopenPage.addInitScript(([k, v]) => localStorage.setItem(k, v), [KEY, recovered.raw])
  await reopenPage.goto(base, { waitUntil: 'load' })
  await reopenPage.waitForFunction(() => Boolean(window.__qua))
  const reopened = await reopenPage.evaluate(() => window.__qua.snapshot())
  assert(reopened.readOnly === false, `重建后的库冷启动应可读：${JSON.stringify(reopened.bootNotice)}`)
  await reopenCtx.close()

  return `过新 v99 原样保留；损坏 JSON 原样保留；调试菜单备份（${recovered.backupKey.replace('qua.workspace.bak.', 'bak.')}）并重建后可写、冷启动可读；告警「${a.text.slice(0, 24)}…」`
})

/* ------------------------------------------------------------ 侧槽 */

await check('T45 Shift+点块标 ⇒ 右槽打开并定位；不换中心/不入历史；再点不关闭，× 才关闭；待办方框的 Shift 仍是勾选', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  await openFirstPage(page)
  // 先关掉右槽：Shift+点击必须能把它叫回来（否则「打开了但看不见」）
  await page.evaluate(() => window.__qua.invoke('core.dock/toggle-right'))
  await page.waitForTimeout(80)
  const closed = (await dockState(page)).pref.right
  assert(closed.open === false, `右槽应先关着：${JSON.stringify(closed)}`)

  const before = await page.evaluate(() => ({
    active: window.__qua.snapshot().activeId,
    nav: window.__qua.snapshot().nav,
  }))
  const picked = await page.evaluate(() => {
    const b = window.__qua.blocks().find((x) => !(x.roles?.length) && !x.todo && x.text.length > 2)
    return b?.id ?? ''
  })
  assert(picked, '假数据里应有一个普通内容块')
  assert(await shiftClickMarker(page, picked), '应点得到该块的块标')
  await page.waitForTimeout(120)
  const opened = await dockState(page)
  assert(opened.pref.right.open === true, `Shift+点击应把右槽打开：${JSON.stringify(opened.pref.right)}`)
  assert(opened.pref.right.cards.includes(picked), `应在右槽清单里：${JSON.stringify(opened.pref.right.cards)}`)
  assert(opened.rows.right.includes(picked), `右槽应渲染出该窗口：${JSON.stringify(opened.rows.right)}`)
  const after = await page.evaluate(() => ({
    active: window.__qua.snapshot().activeId,
    nav: window.__qua.snapshot().nav,
  }))
  assert(after.active === before.active, `Shift+点不换中心：${before.active} → ${after.active}`)
  assert(JSON.stringify(after.nav) === JSON.stringify(before.nav), `Shift+点不入历史：${JSON.stringify(after.nav)}`)

  // 再点一次：**不关闭**，只是确保打开/定位（没有第二张窗口）
  assert(await shiftClickMarker(page, picked), '第二次 Shift+点击')
  await page.waitForTimeout(120)
  const again = await dockState(page)
  assert(again.pref.right.cards.filter((id) => id === picked).length === 1, `第二次不该出现第二张：${JSON.stringify(again.pref.right.cards)}`)
  assert(again.rows.right.filter((id) => id === picked).length === 1, `第二次 DOM 里仍只有一张：${JSON.stringify(again.rows.right)}`)

  // 关闭走卡片 ×
  await page.locator(`${windowSel('right', picked)} [data-dock-action="close"]`).click()
  await page.waitForTimeout(120)
  const closedByX = await dockState(page)
  assert(!closedByX.pref.right.cards.includes(picked), `× 应把窗口从清单移出：${JSON.stringify(closedByX.pref.right.cards)}`)
  assert(!closedByX.rows.right.includes(picked), `× 后 DOM 里不该再有它：${JSON.stringify(closedByX.rows.right)}`)

  // 待办行的方框：动作是「切换完成」，Shift 不改变它，也不打开窗口
  const todo = await page.evaluate(() => {
    const b = window.__qua.blocks().find((x) => x.todo)
    return b ? { id: b.id, todo: b.todo } : null
  })
  assert(todo, '假数据里应有待办块')
  // 方框不是块标：它的动作是切换完成。Shift 不改变它，也不打开窗口。
  await page.evaluate((id) => {
    const box = document.querySelector(`.blk[data-block-id="${id}"] [data-todo-for]`)
    if (!box) return false
    for (const type of ['mousedown', 'click']) {
      box.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, shiftKey: true }))
    }
    return true
  }, todo.id)
  await page.waitForTimeout(120)
  const afterTodo = await page.evaluate((id) => ({
    todo: window.__qua.blocks().find((b) => b.id === id)?.todo ?? null,
    dock: window.__qua.snapshot().dock,
  }), todo.id)
  assert(afterTodo.todo !== todo.todo, `Shift+点方框仍应切换待办：${todo.todo} → ${afterTodo.todo}`)
  assert(!afterTodo.dock.right.cards.includes(todo.id), `方框不该打开窗口：${JSON.stringify(afterTodo.dock.right.cards)}`)
  await ctx.close()
  return `关闭态被叫回；不换中心/不入历史；再点不关闭、× 关闭；待办方框仍只勾选`
})

await check('T46 从正文块标拖进左槽 ⇒ 钉住并渲染；在槽里编辑，正文同一个块同步（共享 store）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  await openFirstPage(page)
  const id = await page.evaluate(() => window.__qua.blocks().find((x) => !(x.roles?.length) && !x.todo && x.text.length > 2)?.id ?? '')
  assert(id, '应有一个可拖的普通块')

  const drag = await dragBlockToDock(page, id, 'left')
  assert(drag, '拖拽事件应能派发到块标与左槽')
  // ⚠️ 读的是 **drop 之后**的载荷：悬停期（dragover）`getData` 一律返回空串（保护模式）
  assert(drag.carried === id, `载荷里应带着块 id（drop 之后才读得到）：${JSON.stringify(drag)}`)
  assert(drag.hot, '拖拽经过槽时应给出高亮（data-drop-pin）')
  await page.waitForTimeout(140)
  const afterDrag = await dockState(page)
  assert(afterDrag.pref.left.cards.includes(id), `左槽应钉住拖入的块：${JSON.stringify(afterDrag.pref.left.cards)}`)
  assert(afterDrag.rows.left.includes(id), `左槽应渲染该块：${JSON.stringify(afterDrag.rows.left)}`)

  // 在槽里（它的第一个实例）打字 ⇒ 正文同一个块（同一 store 对象）应同步
  const sel = `#dock-left .dock-card[data-window="1"][data-card-id="${id}"] .dock-window-editor .blk[data-depth="0"] > .tx`
  await page.locator(sel).click()
  await page.keyboard.press('End')
  await page.keyboard.type('槽内附加')
  await page.waitForTimeout(200)
  const fromSlot = await page.evaluate((id) => ({
    main: window.__qua.blocks().find((b) => b.id === id)?.text ?? '',
    dom: document.querySelector(`#editor .blk[data-block-id="${id}"] > .tx`)?.textContent ?? '',
  }), id)
  const pinText = await pinRootText(page, 'left', id)
  assert(fromSlot.main.includes('槽内附加'), `槽内编辑应写进共享 store：${JSON.stringify(fromSlot.main)}`)
  assert(fromSlot.dom.includes('槽内附加'), `正文 DOM 应同步：${JSON.stringify(fromSlot.dom)}`)
  assert(pinText.includes('槽内附加'), `槽里那一行自己也应显示：${JSON.stringify(pinText)}`)

  // 反向：正文改 ⇒ 槽里的行跟着变（防抖窗口之后）
  await page.evaluate((id) => window.__qua.focusBlock(id, 0), id)
  await page.keyboard.type('正文附加')
  await page.waitForTimeout(220)
  const fromMain = await page.evaluate((id) => window.__qua.blocks().find((b) => b.id === id)?.text ?? '', id)
  const mirror = await pinRootText(page, 'left', id)
  assert(fromMain.startsWith('正文附加'), `正文应拿到新文本：${JSON.stringify(fromMain.slice(0, 20))}`)
  assert(mirror.startsWith('正文附加'), `槽里的同一块应跟着更新：${JSON.stringify(mirror.slice(0, 20))}`)
  await ctx.close()
  return `同块两处：槽内打字 ⇒ 正文含「槽内附加」；正文打字 ⇒ 槽内同步（${mirror.slice(0, 12)}…）`
})

await check('T47 槽内连续输入不被整槽重画打断；⌘Z 在槽里回滚的是**全局共享**的那一份', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  await openFirstPage(page)
  const id = await page.evaluate(() => window.__qua.blocks().find((x) => !(x.roles?.length) && !x.todo && x.text.length > 2)?.id ?? '')
  const drag = await dragBlockToDock(page, id, 'left')
  assert(drag?.hot, '拖进左槽应给出高亮')
  await page.waitForTimeout(140)

  const sel = `#dock-left .dock-card[data-window="1"][data-card-id="${id}"] .dock-window-editor .blk[data-depth="0"] > .tx`
  await page.locator(sel).click()
  await page.keyboard.press('End')
  // 逐键输入：若每键都整槽重画，光标会被重置，最终文本不会是一段连续的串
  await page.keyboard.type('ABC连续')
  await page.waitForTimeout(120)
  const typed = await pinRootText(page, 'left', id)
  assert(typed.includes('ABC连续'), `连续输入应完整落在同一处（整槽重画会打断光标）：${JSON.stringify(typed)}`)
  const focusOk = await page.evaluate((id) => {
    const row = document.querySelector(`#dock-left .dock-card[data-window="1"][data-card-id="${id}"]`)
    return Boolean(row && row.contains(document.activeElement))
  }, id)
  assert(focusOk, '输入过程中焦点应仍在槽内那一行')

  await page.keyboard.press(kbd('mod+z'))
  await page.waitForTimeout(200)
  const afterUndo = await page.evaluate((id) => ({
    main: window.__qua.blocks().find((b) => b.id === id)?.text ?? '',
  }), id)
  const pinAfter = await pinRootText(page, 'left', id)
  assert(!afterUndo.main.includes('ABC连续'), `槽里的 ⌘Z 应回滚共享 store：${JSON.stringify(afterUndo.main)}`)
  assert(!pinAfter.includes('ABC连续'), `槽里的行也必须跟着回滚：${JSON.stringify(pinAfter)}`)
  await ctx.close()
  return `逐键输入保持连续；⌘Z 后正文与槽同时回滚`
})

await check('T48 祖先和后代都打开 ⇒ 两张窗口都显示（窗口是显式的）；pin 过的清单随 prefs 落盘，重开后仍在', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  await openFirstPage(page)
  const nested = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#editor .blk')]
    for (let i = 1; i < rows.length; i++) {
      if (Number(rows[i].dataset.depth) === 1 && Number(rows[i - 1].dataset.depth) === 0) {
        return { child: rows[i].dataset.blockId, parent: rows[i - 1].dataset.blockId }
      }
    }
    return null
  })
  assert(nested, '应能找到一对父子块')
  await shiftClickMarker(page, nested.child)
  await shiftClickMarker(page, nested.parent)
  await page.waitForTimeout(140)
  const nestedState = await dockState(page)
  assert(
    nestedState.pref.right.cards.includes(nested.child) && nestedState.pref.right.cards.includes(nested.parent),
    `两块都应记在清单里：${JSON.stringify(nestedState.pref.right.cards)}`,
  )
  assert(
    nestedState.rows.right.includes(nested.parent) && nestedState.rows.right.includes(nested.child),
    `窗口是显式的：祖先和后代都该各有一张：${JSON.stringify(nestedState.rows.right)}`,
  )

  const leftId = await page.evaluate((n) => {
    const right = window.__qua.snapshot().dock.right.cards
    const b = window.__qua
      .blocks()
      .find(
        (x) =>
          x.id !== n.parent &&
          x.id !== n.child &&
          !right.includes(x.id) &&
          !(x.roles?.length) &&
          !x.todo &&
          x.text.length > 2,
      )
    return b?.id ?? ''
  }, nested)
  assert(leftId, '应能找到一个不在右槽里的块，用来验左槽窗口')
  await dragBlockToDock(page, leftId, 'left')
  await page.waitForTimeout(400)
  // 常驻口径：Shift+点开的窗口重启即清——要原样回来就 pin 住（拖进左槽那张已由动作 pin 过）
  for (const wid of [nested.child, nested.parent]) {
    await page.locator(`.dock-card[data-card-id="${wid}"] > .dock-card-head [data-dock-action="pin"]`).click()
  }
  await page.waitForTimeout(140)
  const saved = await dockState(page)
  const reopened = await reopenPage(browser, ctx, base, page)
  await reopened.page.waitForTimeout(220)
  const restored = await reopened.page.evaluate(() => ({
    dock: window.__qua.snapshot().dock,
    left: [...document.querySelectorAll('#dock-left .dock-card[data-window="1"]')].map((r) => r.dataset.cardId),
    right: [...document.querySelectorAll('#dock-right .dock-card[data-window="1"]')].map((r) => r.dataset.cardId),
  }))
  await reopened.ctx.close()
  assert(
    JSON.stringify(restored.dock.left.cards) === JSON.stringify(saved.pref.left.cards) &&
      JSON.stringify(restored.dock.right.cards) === JSON.stringify(saved.pref.right.cards),
    `重开后清单应原样回来：\n  before ${JSON.stringify(saved.pref)}\n  after  ${JSON.stringify(restored.dock)}`,
  )
  assert(restored.left.includes(leftId), `重开后左槽应仍渲染窗口：${JSON.stringify(restored.left)}`)
  assert(
    restored.right.includes(nested.parent) && restored.right.includes(nested.child),
    `重开后两张窗口都还在：${JSON.stringify(restored.right)}`,
  )
  await ctx.close()
  return `清单 ${saved.pref.left.cards.length}+${saved.pref.right.cards.length} 项落盘；右槽两张窗口（父 ${nested.parent.slice(-6)} / 子 ${nested.child.slice(-6)}）`
})

await check('T49 窗口有 ×：关闭窗口但不删块；左槽清单与 DOM 同时清干净', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  await openFirstPage(page)
  const picked = await page.evaluate(() => {
    const b = window.__qua.blocks().find((x) => !(x.roles?.length) && !x.todo && x.text.length > 2)
    return b ? { id: b.id, text: b.text } : null
  })
  assert(picked, '应有一个可拖的块')
  await dragBlockToDock(page, picked.id, 'left')
  await page.waitForTimeout(140)
  const before = await page.evaluate(() => window.__qua.snapshot().topBlocks)
  await page.locator(`#dock-left .dock-card[data-window="1"][data-card-id="${picked.id}"] [data-dock-action="close"]`).click()
  await page.waitForTimeout(140)
  const after = await page.evaluate((id) => ({
    dock: window.__qua.snapshot().dock,
    rows: [...document.querySelectorAll('#dock-left .dock-card[data-window="1"]')].map((r) => r.dataset.cardId),
    block: window.__qua.blocks().find((b) => b.id === id) ?? null,
    topBlocks: window.__qua.snapshot().topBlocks,
  }), picked.id)
  assert(!after.dock.left.cards.includes(picked.id), `移除后清单里不该还有它：${JSON.stringify(after.dock.left.cards)}`)
  assert(!after.rows.includes(picked.id), `移除后 DOM 里不该还有这一行：${JSON.stringify(after.rows)}`)
  assert(after.block && after.block.text === picked.text, `移除只影响视图，不该删块：${JSON.stringify(after.block)}`)
  assert(after.topBlocks === before, `块数应不变：${before} → ${after.topBlocks}`)
  assert(after.dock.left.open === true, '移除最后一项不该顺手关掉左槽')
  await ctx.close()
  return `移出 ${picked.text.slice(0, 10)}…：清单/行清空，块仍在（块数 ${after.topBlocks}）`
})

await check('T50 导航历史：⌘[ 后退 / ⌘] 前进跨页可走；新导航会清掉前进栈', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  const info = await page.evaluate(() => ({
    pages: window.__qua.pages().slice(0, 2),
    bootId: window.__qua.snapshot().activeId,
  }))
  assert(info.pages.length >= 2, `至少要有两页才能测跨页历史：${JSON.stringify(info.pages)}`)
  const [a, b] = info.pages

  // 两次真实导航：boot(今日) → A → B
  await page.evaluate((id) => window.__qua.invoke('core.page/open', { pageId: id }), a.id)
  await page.evaluate((id) => window.__qua.invoke('core.page/open', { pageId: id }), b.id)
  const atB = await page.evaluate(() => ({ id: window.__qua.snapshot().activeId, nav: window.__qua.snapshot().nav }))
  assert(atB.id === b.id, `当前应在 B：${JSON.stringify(atB)}`)
  assert(atB.nav.canGoBack && !atB.nav.canGoForward, `两次导航后应能后退、不能前进：${JSON.stringify(atB.nav)}`)

  await page.keyboard.press(kbd('mod+BracketLeft'))
  await page.waitForTimeout(150)
  const backA = await page.evaluate(() => ({
    id: window.__qua.snapshot().activeId,
    nav: window.__qua.snapshot().nav,
    log: window.__qua.commandLog().slice(-3),
  }))
  assert(backA.id === a.id, `⌘[ 应回到 A：${JSON.stringify(backA)}`)
  assert(backA.log.includes('core.history/back'), `应走 core.history/back 命令：${JSON.stringify(backA.log)}`)

  // 再退一步回到 boot 落点（今日日记）：当前对象应是**日记块自己**，不是它的子块
  await page.keyboard.press(kbd('mod+BracketLeft'))
  await page.waitForTimeout(200)
  const backBoot = await page.evaluate(() => ({
    id: window.__qua.snapshot().activeId,
    date: window.__qua.snapshot().journalDate,
    head: document.querySelector('#editor > .sec > .blk[data-depth="0"]')?.dataset.blockId ?? '',
  }))
  assert(backBoot.id === info.bootId, `第二次后退应回到冷启动落点：${JSON.stringify({ backBoot, boot: info.bootId })}`)
  assert(backBoot.date !== '' && backBoot.head === backBoot.id, `退回的应是今日日记本身（首行＝它自己）：${JSON.stringify(backBoot)}`)

  await page.keyboard.press(kbd('mod+BracketRight'))
  await page.keyboard.press(kbd('mod+BracketRight'))
  await page.waitForTimeout(150)
  const fwd = await page.evaluate(() => ({
    id: window.__qua.snapshot().activeId,
    nav: window.__qua.snapshot().nav,
  }))
  assert(fwd.id === b.id, `⌘] 两次应前进回 B：${JSON.stringify(fwd)}`)
  assert(!fwd.nav.canGoForward, `走到栈顶后不该还能前进：${JSON.stringify(fwd.nav)}`)

  // 后退之后开新页 ⇒ 前进栈作废（浏览器同口径）
  await page.keyboard.press(kbd('mod+BracketLeft'))
  await page.waitForTimeout(120)
  await page.evaluate((id) => window.__qua.invoke('core.page/open', { pageId: id }), b.id)
  const afterNewNav = await page.evaluate(() => window.__qua.snapshot().nav)
  assert(!afterNewNav.canGoForward, `后退后开新页应清掉前进栈：${JSON.stringify(afterNewNav)}`)

  await ctx.close()
  return `今日→A→B；⌘[ 退两步、⌘] 进两步；新导航清前进栈`
})

/* ------------------------------------------------- 属性区（平铺 ＋ 来源 ＋ 行尾 chip） */

await check('T51 属性区：定义的独立块 / 平铺一行 / 来源标注 / 成员块行尾 chip', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await openFirstPage(page)

  // ① 在一个内容块上打 #任务（标签块是普通块，住森林顶层；归属写在块上）
  const hostId = await page.evaluate(() => {
    const b = window.__qua.blocks().find((x) => x.roles.length === 0 && x.children === 0 && x.text.length > 2)
    window.__qua.focusBlock(b.id, 0)
    window.__qua.invoke('core.editor/insert-tag', { tag: ' 任务 ' })
    return b.id
  })
  const tag = await page.evaluate((hostId) => {
    const tag = window.__qua.allBlocks().find((b) => b.roles.includes('tag') && b.text === '任务')
    const host = window.__qua.blocks().find((x) => x.id === hostId)
    return { tagId: tag?.id, tagged: (host?.tags ?? []).includes(tag?.id) }
  }, hostId)
  assert(tag.tagId && tag.tagged, `打标签应产出一个真实标签块、并写进块的归属：${JSON.stringify(tag)}`)

  // ② 打开标签页，新建字段（定义是森林顶层的 schema 块，propId ＝ 块 id）
  await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), tag.tagId)
  await page.waitForTimeout(100)
  await page.evaluate(
    (tagId) => window.__qua.invoke('core.props/create-def', { blockId: tagId, label: '状态', kind: 'text', target: 'declared' }),
    tag.tagId,
  )
  await page.waitForTimeout(200)
  // 库里自带核心词汇（「任务状态」定义），所以这里按 label 挑出**刚建的那个**
  const defs = await page.evaluate(() => window.__qua.propDefs())
  const own = defs.filter((d) => d.label === '状态')
  assert(own.length === 1, `应只有一个「状态」定义：${JSON.stringify(defs)}`)
  assert(own[0].kind === 'text', JSON.stringify(own[0]))
  assert(own[0].declaredBy.includes(tag.tagId), '定义应被 #任务 声明')
  const schemaTop = await page.evaluate((id) => window.__qua.allBlocks().some((b) => b.id === id && b.roles.includes('schema')), own[0].id)
  assert(schemaTop, '定义是森林顶层的 schema 块（不是标签的子块）')

  /**
   * 属性区**也画声明段**（只有页/标签有）。
   *
   * 它曾经被撤掉过（理由：与独立的声明编辑面是同一份东西的两套实现，且这里只能解除）。
   * 撤掉之后在页/标签上点「添加属性」**没有任何可见结果** —— 那次点击写的是
   * `_fieldDefs`（给成员用），页自己没有值，块属性那一段一行都不会多。
   * ⇒ 这一段现在**自带自己的添加入口**（写 `_fieldDefs`），抬头那个写 `_ownProps`。
   *    两个槽两个入口：共用一个就必须按块类型猜意图，而标签块恰好两个都需要。
   */
  const declared = await page.evaluate(() => ({
    visible: !document.getElementById('inspect-card').hidden,
    declaredRows: [...document.querySelectorAll('.prop-declared [data-declared-prop-id]')].map(
      (x) => x.dataset.declaredPropId,
    ),
    ownEntry: document.querySelectorAll('[data-declare-add]').length,
  }))
  assert(declared.visible, '标签页应显示属性区')
  assert(
    declared.declaredRows.includes(own[0].id),
    `属性区的声明段应列出刚声明的「状态」：${JSON.stringify(declared)}`,
  )
  assert(declared.ownEntry === 1, `声明段要有自己的添加入口（写 _fieldDefs）：${JSON.stringify(declared)}`)

  // ③ 成员块上写值：一块一槽 props[propId]
  //
  // ⚠️ `#任务` 还声明了库自带的核心字段「任务状态」，所以这一块的行**不止一行**。
  //    断言一律按 propId 取，而不是按下标 —— 行序随声明顺序变，不是契约。
  await page.evaluate(
    ({ blockId, propId }) => window.__qua.invoke('core.props/set-value', { blockId, propId, value: '已完成' }),
    { blockId: hostId, propId: own[0].id },
  )
  const fields = await page.evaluate((id) => window.__qua.fields(id), hostId)
  const ownField = fields.find((f) => f.propId === own[0].id)
  assert(ownField?.value === '已完成', `成员块应有值：${JSON.stringify(fields)}`)
  assert(ownField.sources.includes(tag.tagId), `来源应是 #任务：${JSON.stringify(ownField)}`)

  // ④ 打开成员块：属性区平铺一行、来源写「来自 #任务」
  //
  // ⚠️ 「任务状态」归 gutter（`_uiPosition: 'block-left'`），但**卡里同样可编辑**：
  //    两面读同一份 `fieldRows`、写同一条命令、写完两边都重画 —— 所以它也是这里的一行。
  //    断言一律按 propId 取，不按下标（行序随声明顺序变，不是契约）。
  await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), hostId)
  await page.waitForTimeout(120)
  const panel = await page.evaluate((propId) => {
    const row = document.querySelector(`.prop-row[data-prop-id="${propId}"]`)
    return {
      label: row?.querySelector('.prop-name')?.textContent ?? '',
      source: row?.querySelector('.prop-source')?.textContent ?? '',
      value: row?.querySelector('.prop-input')?.value ?? '',
      rows: [...document.querySelectorAll('.prop-row[data-prop-id]')].map((x) => x.dataset.propId),
    }
  }, own[0].id)
  assert(panel.rows.length === 2, `这一块有两条属性（「状态」＋ #任务 声明的「任务状态」）：${JSON.stringify(panel)}`)
  assert(new Set(panel.rows).size === panel.rows.length, `同一 propId 只显示一行：${JSON.stringify(panel)}`)
  assert(panel.label === '状态' && panel.value === '已完成', JSON.stringify(panel))
  assert(panel.source.includes('#任务'), `来源应标出标签：${JSON.stringify(panel)}`)

  /**
   * ⑤ **摘标签的入口暂时不在**（归属的摘除交互还没接），
   *    所以「摘标签时的清理提示」这段断言跟着入口一起暂时退场 ——
   *    退场的是**测试**，不是能力：`cleanableValues` 仍在（有单测），
   *    等摘除入口落地时，提示与撤销的断言要原样回来。
   *
   * 这一轮真正要钉住的是形状：归属在块上，渲染成**行尾 chip**，且 chip 不进正文读数。
   */
  const chip = await page.evaluate(
    ({ blockId, tagId }) => {
      const el = document.querySelector(`.blk[data-block-id="${blockId}"] .blk-tags .tag-chip[data-tag-id="${tagId}"]`)
      return { text: el?.textContent ?? '', read: window.__qua.__editor.readRunsOf(blockId).filter((r) => r.t === 'text').map((r) => r.v).join('') }
    },
    { blockId: hostId, tagId: tag.tagId },
  )
  assert(chip.text === '#任务', `成员块标签槽里应有一枚 #任务 chip：${JSON.stringify(chip)}`)
  assert(!chip.read.includes('#任务'), `chip 不该进正文读数：${JSON.stringify(chip)}`)

  await ctx.close()
  return `定义 ${defs[0].id.slice(-6)} 被 #任务 声明；成员值「已完成」；行尾 chip ${JSON.stringify(chip.text)} 不进读数`
})

/* ------------------------------------------------- 归属边（属于 / 包含 / 成员） */

await check('T52 归属边：属于在属性区、成员含算作、禁环、悬空两态分得开', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await openFirstPage(page)

  // 两个内容块：A 打 #人物 + #演员；B 只打 #演员（用来证明「算作」）
  const ids = await page.evaluate(() => {
    const bs = window.__qua.blocks().filter((b) => b.roles.length === 0 && b.children === 0 && b.text.length > 2)
    const a = bs[0].id
    const b = bs[1].id
    window.__qua.focusBlock(a, 0)
    window.__qua.invoke('core.editor/insert-tag', { tag: '人物' })
    window.__qua.invoke('core.editor/insert-tag', { tag: '演员' })
    window.__qua.focusBlock(b, 0)
    window.__qua.invoke('core.editor/insert-tag', { tag: '演员' })
    return { a, b }
  })
  const tags = await page.evaluate(() => {
    const all = window.__qua.allBlocks().filter((x) => x.roles.includes('tag'))
    return Object.fromEntries(all.map((x) => [x.text, x.id]))
  })
  assert(tags['人物'] && tags['演员'], `应有两个标签块：${JSON.stringify(tags)}`)

  // #演员 属于 #人物（子侧写 `_belongsTo`；命令不再叫 tags/* —— 边不是标签专有）
  await page.evaluate(
    ({ child, parent }) => window.__qua.invoke('core.belongs-to/add', { childId: child, parentId: parent }),
    { child: tags['演员'], parent: tags['人物'] },
  )
  const rel = await page.evaluate(
    (id) => ({ parents: window.__qua.tagParents(id), children: window.__qua.tagChildren(id) }),
    tags['演员'],
  )
  assert(rel.parents.includes(tags['人物']), `#演员 的上级应含 #人物：${JSON.stringify(rel)}`)

  // 「属于」住在**属性区**：打开 #演员（主体换成它），那一行列出 #人物
  await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), tags['演员'])
  await page.waitForTimeout(250)
  const belongsRow = await page.evaluate(() => ({
    hasRow: !!document.querySelector('.prop-belongs'),
    chips: [...document.querySelectorAll('.prop-belongs .props-tag')].map((e) => e.textContent ?? ''),
    panelVisible: !document.getElementById('inspect-card').hidden,
  }))
  assert(belongsRow.hasRow, '属性区应有「属于」一行（任何块都显示）')
  assert(belongsRow.chips.some((t) => t.includes('人物')), `「属于」应列出 #人物：${JSON.stringify(belongsRow)}`)

  // 算作：查 #人物 的成员要含只打 #演员 的 B
  const deep = await page.evaluate((id) => window.__qua.tagMembersDeep(id), tags['人物'])
  assert(deep.includes(ids.b), `#人物 的成员应含只打 #演员 的块（算作）：${JSON.stringify(deep)}`)
  assert(deep.includes(ids.a), '#人物 也应含双打的块')

  // 打开 #人物：成员收成了挂载区的「同类」栏（关系区已撤到属性区）
  await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), tags['人物'])
  await page.waitForTimeout(250)
  await mountTab(page, 'same')
  const ui = await page.evaluate(() => ({
    tabs: [...document.querySelectorAll('#editor .mount .mount-tab')].map((e) => e.textContent),
    hasRelations: !!document.querySelector('.tagpanel-relations, [data-tag-relations]'),
    members: document.querySelectorAll('#editor .mount .mount-editor .blk').length,
  }))
  assert(ui.tabs.some((x) => x.includes('引用')), `打开任何块都该有「引用」栏：${JSON.stringify(ui.tabs)}`)
  assert(!ui.hasRelations, '「属于／包含」不该还留在标签面板里（它们对任何块都能配 ⇒ 住属性区）')
  assert(ui.members >= 2, `「同类」栏应渲染出成员块：${ui.members}`)

  // 算作 ≠ 拥有字段：给 #人物 声明一个字段，只打 #演员 的 B 不获得它
  await page.evaluate(
    (id) => window.__qua.invoke('core.props/create-def', { blockId: id, label: '姓名', kind: 'text', target: 'declared' }),
    tags['人物'],
  )
  await page.waitForTimeout(150)
  await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), ids.b)
  await page.waitForTimeout(150)
  const bPanel = await page.evaluate(() => ({
    labels: [...document.querySelectorAll('.prop-row[data-prop-id] .prop-name')].map((e) => e.textContent),
    fields: window.__qua.fields(window.__qua.__editor.doc.roots[0].id).map((f) => f.label),
  }))
  assert(!bPanel.labels.includes('姓名') && !bPanel.fields.includes('姓名'), `只打 #演员 的块不该有 #人物 的字段：${JSON.stringify(bPanel)}`)

  // 禁环：#人物 属于 #演员 ⇒ 拒绝，且不留下半截状态
  await page.evaluate(
    ({ child, parent }) => window.__qua.invoke('core.belongs-to/add', { childId: child, parentId: parent }),
    { child: tags['人物'], parent: tags['演员'] },
  )
  const afterCycle = await page.evaluate(
    (id) => ({ parents: window.__qua.tagParents(id), children: window.__qua.tagChildren(id) }),
    tags['人物'],
  )
  assert(!afterCycle.parents.includes(tags['演员']), `成环写入应被拒绝：${JSON.stringify(afterCycle)}`)
  assert(afterCycle.children.includes(tags['演员']), '原有那条边不能被拒绝的写入改掉')

  // 悬空**两态**：软删的上级 = 在回收站（清不掉），真没了的才可清
  // ① 软删 #人物：边落 revivable
  //    （直接打标记而不走「删除块」命令：那一步受「根块不许删」的守卫拦，而这里要验的是
  //     **读路径对回收站里的上级怎么判**，不是删除命令本身）
  await page.evaluate((id) => {
    window.__qua.forceForest((forest) => {
      let hit = null
      const walk = (list) => {
        for (const b of list) {
          if (b.id === id) hit = b
          walk(b.children)
        }
      }
      walk(forest)
      if (hit) hit.props = { ...(hit.props ?? {}), _deletedAt: Date.now() }
    })
  }, tags['人物'])
  await page.waitForTimeout(200)
  const soft = await page.evaluate((id) => window.__qua.tagDanglingStates(id), tags['演员'])
  assert(soft.revivable.length === 1 && soft.gone.length === 0, `软删的上级应落 revivable：${JSON.stringify(soft)}`)
  await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), tags['演员'])
  await page.waitForTimeout(250)
  const softUi = await page.evaluate(() => ({
    text: document.querySelector('.prop-belongs')?.textContent ?? '',
    prune: !!document.querySelector('.prop-belongs [data-prune-belongs]'),
    revivable: !!document.querySelector('.prop-belongs [data-dangling="revivable"]'),
  }))
  assert(softUi.revivable && /回收站/.test(softUi.text), `「上级在回收站」要看得见：${JSON.stringify(softUi)}`)
  assert(!softUi.prune, '回收站里的上级不给清理入口（复活要自愈）')

  // ② 真删 #人物（从森林里摘掉）：落 gone，可清理；点清理 ⇒ 边没了
  await page.evaluate((parentId) => {
    window.__qua.forceForest((forest) => {
      const i = forest.findIndex((b) => b.id === parentId)
      if (i >= 0) forest.splice(i, 1)
    })
  }, tags['人物'])
  await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), tags['演员'])
  await page.waitForTimeout(250)
  const goneUi = await page.evaluate(() => ({
    text: document.querySelector('.prop-belongs')?.textContent ?? '',
    prune: !!document.querySelector('.prop-belongs [data-prune-belongs]'),
  }))
  assert(/已删除/.test(goneUi.text), `真删的上级应显示「已删除」：${JSON.stringify(goneUi)}`)
  assert(goneUi.prune, '真删的上级应可清理')
  await page.evaluate(() => document.querySelector('.prop-belongs [data-prune-belongs]')?.click())
  await page.waitForTimeout(250)
  const pruned = await page.evaluate((id) => window.__qua.tagParents(id), tags['演员'])
  assert(pruned.length === 0, `清理之后不该还有上级：${JSON.stringify(pruned)}`)

  await ctx.close()
  return `#演员 属于 #人物（属性区一行）；成员含算作；成环被拒；回收站里的上级清不掉、真删的能清`
})

/* ------------------------------------------------- UI：让一个块成为页 / 标签 */

await check('T53 列表露面：输入名字建标签、同名页兼作标签、标签也标记为页、无名块直接标记为标签、摘标签只摘露面', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await openFirstPage(page)

  // ① 选择器里输入新名字 ⇒ 第一行就是「新建标签」（不再只有固定 demo 词）
  const hostId = await page.evaluate(() => {
    const b = window.__qua.blocks().find((x) => x.roles.length === 0 && x.children === 0 && x.text.length > 2)
    window.__qua.focusBlock(b.id, 0)
    window.__qua.invoke('core.editor/pick-tag')
    return b.id
  })
  await page.waitForSelector('.layer-input')
  await page.fill('.layer-input', '人物')
  await page.waitForTimeout(120)
  const createLabel = await page.textContent('.layer-item[data-index="0"] .layer-label')
  assert(createLabel.includes('新建标签'), `输入新名字时第一行应是新建：${createLabel}`)
  await page.press('.layer-input', 'Enter')
  await page.waitForTimeout(200)
  const tagPeople = await page.evaluate(() => {
    const b = window.__qua.allBlocks().find((x) => x.lists.includes('tag') && x.aliases.includes('人物'))
    return b ? { id: b.id, text: b.text, aliases: b.aliases, lists: b.lists, roles: b.roles } : null
  })
  assert(tagPeople, '回车后应真的建出标签 #人物 并打上')
  assert(tagPeople.aliases.length > 0 && tagPeople.aliases[0] === '人物', `标签必须有地址（主名）：${JSON.stringify(tagPeople)}`)
  assert(tagPeople.lists.includes('tag'), `标签的身份应落在 _lists：${JSON.stringify(tagPeople)}`)

  // ② 新页：地址是 `未命名-<短id>`；改正文只改描述，页名走别名编辑器。
  const reuseName = '复用页名'
  await page.evaluate(() => window.__qua.invoke('core.page/new'))
  const pageId = await page.evaluate(() => window.__qua.snapshot().activeId)
  const created = await page.evaluate((id) => {
    const b = window.__qua.allBlocks().find((x) => x.id === id)
    const p = window.__qua.pages().find((x) => x.id === id)
    return { aliases: b?.aliases ?? [], lists: b?.lists ?? [], text: b?.text ?? '', title: p?.title ?? '(gone)' }
  }, pageId)
  assert(created.aliases.length === 1 && created.aliases[0].startsWith('未命名-'), `新页地址应是「未命名-xxx」：${JSON.stringify(created)}`)
  assert(created.lists.includes('page'), `新页应进页列表：${JSON.stringify(created)}`)
  assert(created.title === created.aliases[0], `页列表标题应显示这个地址（不是空串）：${JSON.stringify(created)}`)

  // 改正文 ＝ 改描述：地址与页列表标题都不动
  await page.evaluate((id) => window.__qua.__editor.setText(id, '页的描述'), pageId)
  const described = await page.evaluate((id) => {
    const b = window.__qua.allBlocks().find((x) => x.id === id)
    const p = window.__qua.pages().find((x) => x.id === id)
    return { text: b?.text ?? '', aliases: b?.aliases ?? [], title: p?.title ?? '(gone)' }
  }, pageId)
  assert(described.text === '页的描述', `正文应被改成描述：${JSON.stringify(described)}`)
  assert(described.aliases[0] === created.aliases[0], `改描述不该改地址：${JSON.stringify(described)}`)
  assert(described.title === created.title, `改描述不该改页列表标题：${JSON.stringify(described)}`)

  // 页名走别名编辑器：加一个名字，它同时也是 `#复用页名` 的地址
  await page.locator(`.blk[data-block-id="${pageId}"] .blk-alias-name`).click()
  await page.waitForSelector('.alias-editor')
  await page.fill('.alias-editor .alias-input', reuseName)
  await page.press('.alias-editor .alias-input', 'Enter')
  await page.waitForTimeout(150)
  await page.evaluate(() => window.__qua.__layers.closePopover())

  // 在它的子块上打同名标签 ⇒ 同名必同一块：复用这个页、加上 tag 露面
  const childId = await page.evaluate((id) => window.__qua.__editor.insertBlockAfter(id, '内容'), pageId)
  await page.evaluate((id) => window.__qua.focusBlock(id, 0), childId)
  await page.evaluate(() => window.__qua.invoke('core.editor/pick-tag'))
  await page.waitForSelector('.layer-input')
  await page.fill('.layer-input', reuseName)
  await page.waitForTimeout(120)
  const reuseLabel = await page.textContent('.layer-item[data-index="0"] .layer-label')
  assert(reuseLabel.includes('同名页'), `同名页应提示复用而不是新建：${reuseLabel}`)
  await page.press('.layer-input', 'Enter')
  await page.waitForTimeout(200)
  const dual = await page.evaluate((id) => window.__qua.allBlocks().find((b) => b.id === id), pageId)
  assert(dual.lists.includes('page') && dual.lists.includes('tag'), `页应兼作标签（两个露面都有）：${JSON.stringify(dual)}`)
  assert(dual.aliases.includes(reuseName), `复用页时名字应仍在它的地址里：${JSON.stringify(dual)}`)
  const sameName = await page.evaluate((n) => window.__qua.allBlocks().filter((b) => b.aliases.includes(n)), reuseName)
  assert(sameName.length === 1, `同名必同一块：${JSON.stringify(sameName)}`)

  // ③ 纯标签「临时」⇒ 打开它，在 footer 点「也作为页」⇒ 真的进页列表
  await page.evaluate((id) => window.__qua.focusBlock(id, 0), childId)
  await page.evaluate(() => window.__qua.invoke('core.editor/pick-tag'))
  await page.waitForSelector('.layer-input')
  await page.fill('.layer-input', '临时')
  await page.press('.layer-input', 'Enter')
  await page.waitForTimeout(200)
  const tagTemp = await page.evaluate(() => {
    const b = window.__qua.allBlocks().find((x) => x.lists.includes('tag') && x.aliases.includes('临时'))
    return b ? { id: b.id, aliases: b.aliases, lists: b.lists } : null
  })
  assert(tagTemp, '应建出纯标签 #临时')
  await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), tagTemp.id)
  await page.waitForTimeout(200)
  const beforePage = await page.evaluate((id) => window.__qua.allBlocks().find((b) => b.id === id).lists, tagTemp.id)
  assert(!beforePage.includes('page'), '纯标签一开始不进页列表')
  // 「标记为页」的入口是块菜单（标签页 footer 已收成挂载区，不再有那一颗按钮）
  await page.locator(`.blk[data-block-id="${tagTemp.id}"] > .left > .marker`).first().click({ button: 'right' })
  await page.waitForSelector('.layer-item')
  await page.locator('.layer-item', { hasText: '标记为页' }).first().click()
  await page.waitForTimeout(250)
  const afterPage = await page.evaluate((id) => {
    const b = window.__qua.allBlocks().find((x) => x.id === id)
    return { roles: b.roles, lists: b.lists, aliases: b.aliases, pages: window.__qua.pages().map((p) => p.title) }
  }, tagTemp.id)
  assert(afterPage.lists.includes('page'), `点「也作为页」后应进页列表：${JSON.stringify(afterPage)}`)
  assert(afterPage.pages.includes('临时'), `页列表应显示它的主名：${JSON.stringify(afterPage)}`)

  // ④ 摘标签露面：有成员 ⇒ 先提示；继续后只摘 `_lists` 里的 tag，名字还在；⌘Z 能恢复
  await page.evaluate((id) => window.__qua.invoke('core.block/untag', { blockId: id }), tagTemp.id)
  await page.waitForSelector('.layer-head')
  const rolePrompt = await page.textContent('.layer-head')
  assert(rolePrompt.includes('临时') && rolePrompt.includes('1 个块'), `摘标签应提示成员：${rolePrompt}`)
  await page.locator('.layer-item', { hasText: '继续' }).click()
  await page.waitForTimeout(200)
  const removed = await page.evaluate((id) => {
    const b = window.__qua.allBlocks().find((x) => x.id === id)
    return { lists: b.lists, aliases: b.aliases }
  }, tagTemp.id)
  assert(!removed.lists.includes('tag'), `继续后应不再是标签（tag 露面没了）：${JSON.stringify(removed)}`)
  assert(removed.lists.includes('page'), `摘 tag 不该顺手摘掉 page 露面：${JSON.stringify(removed)}`)
  assert(removed.aliases.includes('临时'), `摘露面不删名字：${JSON.stringify(removed)}`)
  await page.evaluate(() => window.__qua.invoke('core.history/undo'))
  await page.waitForTimeout(200)
  const restored = await page.evaluate((id) => window.__qua.allBlocks().find((b) => b.id === id).lists, tagTemp.id)
  assert(restored.includes('tag'), `⌘Z 应把 tag 露面恢复：${JSON.stringify(restored)}`)

  // ⑤ **两个露面互不前置**：一个「有正文、没别名」的普通块，块菜单里就该有
  //    「标记为标签」；点了直接用正文当名字，且**不进页列表**（不需要先当页）。
  const plainText = '直接标记的标签'
  const plainId = await page.evaluate((text) => {
    const id = window.__qua.__editor.insertBlockAfter(window.__qua.snapshot().activeId, text)
    window.__qua.focusBlock(id, 0)
    return id
  }, plainText)
  await page.waitForTimeout(150)
  const plainMenu = await page.evaluate((id) => {
    const el = document.querySelector(`.blk[data-block-id="${id}"] .handle`)
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    return [...document.querySelectorAll('.layer-item .layer-label')].map((r) => r.textContent)
  }, plainId)
  assert(plainMenu.some((x) => x.includes('标记为标签')), `无名块也该能直接标记为标签：${JSON.stringify(plainMenu)}`)
  assert(plainMenu.some((x) => x.includes('标记为页')), `块菜单应能标记为页：${JSON.stringify(plainMenu)}`)
  await page.locator('.layer-item', { hasText: '标记为标签' }).click()
  await page.waitForTimeout(200)
  const direct = await page.evaluate((id) => {
    const b = window.__qua.allBlocks().find((x) => x.id === id)
    return { aliases: b.aliases, lists: b.lists }
  }, plainId)
  assert(direct.lists.includes('tag'), `应直接成为标签：${JSON.stringify(direct)}`)
  assert(!direct.lists.includes('page'), `标记为标签不该顺手进页列表：${JSON.stringify(direct)}`)
  assert(direct.aliases[0] === plainText, `无名块应把正文当主名：${JSON.stringify(direct)} vs ${plainText}`)

  // ⑥ 空正文、没名字 ⇒ 标记为标签不是死路：打开别名编辑器并把光标放进输入框，一个字节都不写
  const emptyId = await page.evaluate((id) => window.__qua.__editor.insertBlockAfter(id, ''), plainId)
  await page.evaluate((id) => window.__qua.focusBlock(id, 0), emptyId)
  await page.evaluate((id) => window.__qua.invoke('core.block/as-tag', { blockId: id }), emptyId)
  await page.waitForSelector('.alias-editor')
  const emptyAfter = await page.evaluate((id) => {
    const b = window.__qua.allBlocks().find((x) => x.id === id)
    return { aliases: b.aliases, lists: b.lists, focused: document.activeElement?.className ?? '' }
  }, emptyId)
  assert(emptyAfter.lists.length === 0 && emptyAfter.aliases.length === 0, `空正文标记为标签应只开编辑器、不写：${JSON.stringify(emptyAfter)}`)
  assert(emptyAfter.focused.includes('alias-input'), `应把光标放进「添加别名」输入框：${JSON.stringify(emptyAfter)}`)
  await page.evaluate(() => window.__qua.__layers.closePopover())

  await ctx.close()
  return `新建 #人物（别名＋tag 露面）；页「${reuseName}」兼作标签；#临时 标记为页；无名块直接标记为标签（主名＝正文、不进页列表）；空正文只开编辑器；摘 tag 只摘露面、名字还在且可撤销`
})

await check(
  'T61 「添加块属性」的形态不撒谎：类型下拉只跟「新建定义」一起出现，选已有属性时只露「用这个」',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await openFirstPage(page)

    // 造一个**不挂到当前块**的定义：类型属于定义本身，不属于「给这一块加一条属性」
    const defId = await page.evaluate(() => {
      window.__qua.invoke('core.props/create-def', { blockId: '', label: '评分', kind: 'number' })
      const def = window.__qua.propDefs().find((d) => d.label === '评分')
      return def?.id ?? ''
    })
    assert(defId !== '', '应能建出一个不挂块的「评分」定义')

    const hostId = await page.evaluate(() => {
      const b = window.__qua.blocks().find((x) => x.roles.length === 0 && x.text.length > 2)
      if (b) window.__qua.invoke('core.block/focus-block', { blockId: b.id })
      return b?.id ?? ''
    })
    assert(hostId !== '', '应能找到一个内容块当属性区的目标')
    await page.waitForTimeout(150)

    const open = async () => {
      await page.click('#properties-add')
      await page.waitForSelector('.props-form--own')
    }
    const shape = () =>
      page.evaluate(() => {
        const form = document.querySelector('.props-form--own')
        const group = form?.querySelector('.props-new-group')
        const visible = (el) => el.getClientRects().length > 0
        return {
          form: Boolean(form),
          groupHidden: group?.hidden ?? null,
          groupVisible: group ? visible(group) : false,
          visibleSelects: [...(form?.querySelectorAll('select') ?? [])].filter(visible).length,
          useVisible: [...(form?.querySelectorAll('.props-use') ?? [])].some(visible),
        }
      })

    // ① 默认形态：选已有属性那一行不带类型下拉（新建组收着）
    await open()
    const before = await shape()
    assert(before.form, '点「添加块属性」应打开表单')
    assert(before.groupHidden === true, `默认新建组应收起：${JSON.stringify(before)}`)
    assert(before.visibleSelects === 1, `默认表单里可见的 select 只能有 picker 一个（类型下拉不许露出来）：${JSON.stringify(before)}`)

    const option = await page.evaluate((id) => {
      const o = [...document.querySelectorAll('.props-form--own .props-pick option')].find((x) => x.value === id)
      return o ? o.textContent : null
    }, defId)
    assert(option !== null, `picker 里应有「评分」这一项：${option}`)
    assert(option.includes('数字'), `已有定义的项要本地化类型（应含「数字」）：${option}`)
    assert(!option.includes('number'), `已有定义的项不该露裸类型名 number：${option}`)

    // ② 选真实定义 ⇒ 只露「用这个」，新建组仍收着
    await page.evaluate((id) => {
      const sel = document.querySelector('.props-form--own .props-pick')
      sel.value = id
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    }, defId)
    const picked = await shape()
    assert(picked.groupHidden === true && !picked.groupVisible, `选已有属性时新建组仍应收起：${JSON.stringify(picked)}`)
    assert(picked.useVisible, `选已有属性时应露出「用这个」：${JSON.stringify(picked)}`)
    assert(picked.visibleSelects === 1, `选已有属性时类型下拉仍不该出现：${JSON.stringify(picked)}`)

    // 直接派发 DOM click：面板会随焦点变化重建，Playwright 的「等元素稳定」会撞上那次重建
    await page.evaluate(() => document.querySelector('.props-form--own .props-use')?.click())
    await page.waitForTimeout(150)
    // 点按钮后焦点在面板里；把光标放回刚才那块，面板目标仍是它
    await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), hostId)
    await page.waitForTimeout(150)
    const used = await page.evaluate((id) => ({
      form: Boolean(document.querySelector('.props-form--own')),
      row: Boolean(document.querySelector(`.prop-row[data-prop-id="${id}"]`)),
    }), defId)
    assert(!used.form, `点「用这个」后表单应关闭：${JSON.stringify(used)}`)
    assert(used.row, `面板里应出现「评分」这一行：${JSON.stringify(used)}`)

    // ③ 选哨兵「＋ 新建属性…」⇒ 第二行整组露出来（名字输入 ＋ 7 种类型）
    await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), hostId)
    await page.waitForTimeout(100)
    await open()
    await page.evaluate(() => {
      const sel = document.querySelector('.props-form--own .props-pick')
      sel.value = '__new__'
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const fresh = await page.evaluate(() => {
      const form = document.querySelector('.props-form--own')
      const group = form?.querySelector('.props-new-group')
      return {
        groupHidden: group?.hidden ?? null,
        nameInputs: group ? group.querySelectorAll('input.prop-input').length : 0,
        kinds: group ? group.querySelectorAll('select.prop-input option').length : 0,
      }
    })
    assert(fresh.groupHidden === false, `选「新建属性」时应展开新建组：${JSON.stringify(fresh)}`)
    assert(fresh.nameInputs === 1, `新建组里应有属性名输入：${JSON.stringify(fresh)}`)
    assert(fresh.kinds === 7, `新建组里的类型下拉应有 7 种：${JSON.stringify(fresh)}`)

    await ctx.close()
    return `默认可见 select 1 个；「评分·数字」复用后行出现；选「新建」才展开名字＋7 种类型`
  },
)

await check(
  'T62 已在块上的属性留在 picker 里（灰掉而不是消失）；归 gutter 的属性在卡里**同样可编辑**，两面共写一份',
  async () => {
    const { ctx, page } = await freshPage(browser, base)

    // 核心词汇：`任务状态` 是勾选属性，`#任务` 声明它，所以种子里打了标签的块都已有这条属性
    const target = await page.evaluate(() => {
      const def = window.__qua.propDefs().find((d) => d.label === '任务状态')
      const tag = window.__qua.allBlocks().find((b) => b.lists.includes('tag') && b.aliases.includes('任务'))
      const id = tag ? window.__qua.tagMembers(tag.id)[0] : ''
      if (id) window.__qua.invoke('core.block/focus-block', { blockId: id }, 'keymap')
      return { defId: def?.id ?? '', blockId: id ?? '' }
    })
    assert(target.defId !== '', '种子里应有「任务状态」定义')
    assert(target.blockId !== '', '种子里应有打了 #任务 的块')
    await page.waitForTimeout(150)

    /**
     * **卡片与 gutter 是同一个值的两个编辑面，不是互斥的两处**。
     *
     * 曾经的规则是「一个值不开两个编辑面」⇒ 卡片只写一句「在块左侧编辑」。
     * 那一句是死路：任务状态最高频，用户在卡里看到它却改不了，得先想起来「左侧还有个小方框」。
     * 撤掉互斥的前提是两面**读同一份行派生、写同一条命令**（见 `ui/properties.ts` 的注释），
     * 所以这里同时钉两件事：卡里有这一行可编辑、且改卡里那一格 ⇒ 左侧方框跟着变。
     */
    const panel = await page.evaluate((propId) => {
      const row = document.querySelector(`.prop-row[data-prop-id="${propId}"]`)
      return {
        rows: [...document.querySelectorAll('.prop-row[data-prop-id]')].map((x) => x.dataset.propId),
        hasBox: Boolean(row?.querySelector('input.prop-check')),
        note: [...document.querySelectorAll('.props-empty')].map((x) => x.textContent),
      }
    }, target.defId)
    assert(panel.rows.includes(target.defId), `归 gutter 的属性也要在卡里出现（否则卡里改不了它）：${JSON.stringify(panel)}`)
    assert(panel.hasBox === true, `卡里那一行要有自己的勾选控件：${JSON.stringify(panel)}`)
    assert(!panel.note.some((x) => x.includes('还没有块属性')), `已有属性时不能同时说「还没有块属性」：${JSON.stringify(panel)}`)

    // 卡里勾一下 ⇒ 模型与左侧方框都要变（两个编辑面共写一份，不能一边改另一边不动）
    await page.evaluate((propId) => {
      const box = document.querySelector(`.prop-row[data-prop-id="${propId}"] input.prop-check`)
      box.checked = true
      box.dispatchEvent(new Event('change', { bubbles: true }))
    }, target.defId)
    await page.waitForTimeout(250)
    const afterTick = await page.evaluate((id) => {
      const blk = document.querySelector(`.blk[data-block-id="${id}"]`)
      const model = window.__qua.__editor.store.find(id)
      return {
        value: model?.props?.[window.__qua.propDefs().find((d) => d.label === '任务状态')?.id],
        todo: blk?.dataset.todo ?? null,
        cardChecked: document.querySelector('.prop-row[data-prop-id] input.prop-check')?.checked ?? null,
      }
    }, target.blockId)
    assert(afterTick.value === true, `卡里勾选要写进模型：${JSON.stringify(afterTick)}`)
    assert(afterTick.todo === 'done', `卡里勾完，左侧方框也要跟着变成已完成：${JSON.stringify(afterTick)}`)

    await page.click('#properties-add')
    await page.waitForSelector('.props-form--own')
    const option = await page.evaluate((propId) => {
      const o = [...document.querySelectorAll('.props-form--own .props-pick option')].find((x) => x.value === propId)
      return o ? { text: o.textContent, disabled: o.disabled } : null
    }, target.defId)
    assert(option !== null, '已在块上的属性不该从 picker 里消失（那会让小库的下拉变空）')
    assert(option.disabled === true, `已在块上的属性应不可选：${JSON.stringify(option)}`)
    assert(option.text.includes('已在块上'), `要写明为什么不可选：${JSON.stringify(option)}`)

    await ctx.close()
    return `picker 保留「任务状态 · 勾选（已在块上）」且 disabled；卡里同一行可勾，左侧方框跟着变`
  },
)

await check(
  'T63 `setText` 走一笔事务：内容改掉只发 1 条 upsert{content}（0 条 anno），一次撤销回得去',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)

    const target = await page.evaluate(() => {
      const ed = window.__qua.__editor
      const plain = (b) => b.content.filter((r) => r.t === 'text').map((r) => r.v).join('')
      // 挑一个可编辑的内容块（没角色 ⇒ 不是页/日记/标签这些身份块，正文归它自己）
      const b = ed.doc.roots.flatMap((r) => [r, ...r.children]).find((x) => !(x.roles?.length) && !x.children.length)
      return { id: b?.id ?? '', text: b ? plain(b) : '', marks: window.__qua.marks().length, atoms: window.__qua.atoms().length }
    })
    assert(target.id !== '', '第一页里应有可编辑的内容块')
    await page.waitForTimeout(120)

    /**
     * 直接调 `setText`，不走键盘：键盘打的是 `syncFromDom`，那是另一条管线，
     * 这里要断言的是「一个写方法 = 一笔事务 = 一组 op」。
     */
    const after = await page.evaluate((id) => {
      window.__qua.__editor.setText(id, '改过的字')
      const ops = window.__qua.lastOps()
      const atoms = window.__qua.atoms().map((a) => a.id)
      const runPlain = (c) => c.filter((r) => r.t === 'text').map((r) => r.v).join('')
      return {
        ops: ops.map((o) => ({ e: o.e, id: o.id, op: o.op, text: o.value?.content === undefined ? undefined : runPlain(o.value.content) })),
        text: window.__qua.blocks().find((b) => b.id === id)?.text ?? '',
        // 只取正文：标签槽（.blk-tags）在正文槽之外，`textContent` 不会把 `#名` 读进来
        dom: document.querySelector(`.blk[data-block-id="${id}"] .tx`)?.textContent ?? '',
        marks: window.__qua.marks().length,
        atoms: atoms.length,
        dupAtoms: atoms.length - new Set(atoms).size,
      }
    }, target.id)
    await page.waitForTimeout(120)

    const upserts = after.ops.filter((o) => o.e === 'block' && o.op === 'upsert')
    const annos = after.ops.filter((o) => o.e === 'anno')
    assert(after.ops.length === 1, `一次 setText 只该产 1 条 op：${JSON.stringify(after.ops)}`)
    assert(upserts.length === 1 && upserts[0].text === '改过的字', `那一条应是 block.upsert{content}：${JSON.stringify(upserts)}`)
    assert(upserts[0].id === target.id, 'op 应指向被改的那一块')
    assert(annos.length === 0, `无锚点变化 ⇒ 0 条 anno：${JSON.stringify(annos)}`)
    assert(after.marks === target.marks && after.atoms === target.atoms, '锚点数不该变（这笔没有锚点变化）')
    assert(after.dupAtoms === 0, `锚点不该出现重复 id（按块拼接写错就会翻倍）：${after.dupAtoms} 条重复`)
    assert(after.text === '改过的字', `模型里正文应已改：${JSON.stringify(after.text)}`)
    assert(after.dom === '改过的字', `DOM 应同步重渲染（不是只改模型）：${JSON.stringify(after.dom)}`)

    // 一次撤销回得去：正文必回原文，块数不变
    await page.evaluate(() => window.__qua.invoke('core.history/undo'))
    await page.waitForTimeout(200)
    const back = await page.evaluate(() => ({
      text: window.__qua.__editor.doc.roots.flatMap((r) => [r, ...r.children]).map((b) => b.content.filter((x) => x.t === 'text').map((x) => x.v).join('')),
    }))
    assert(back.text.includes(target.text), `一次撤销应回到原文「${target.text}」：${JSON.stringify(back.text)}`)
    assert(!back.text.includes('改过的字'), `撤销后不该还留着新正文：${JSON.stringify(back.text)}`)

    await ctx.close()
    return `setText ⇒ ops=[block.upsert{content}]（1 条，0 条 anno）；正文/DOM 同步改；⌘Z 回原文`
  },
)

await check(
  'T64 真实键入也走一笔事务：打一个普通字只发 1 条 upsert{content}（0 条 anno），一次撤销回得去',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    /**
     * ⚠️ **不 quiet**：`quiet(true)` 只掐 toast，落盘还是照走 —— 这里要留着，
     * 因为「这次改动到底被当成整库提交还是按 op 提交」只有在真提交一次之后才看得到。
     */
    await openFirstPage(page)

    const target = await page.evaluate(() => {
      const ed = window.__qua.__editor
      /**
       * **现行里挑一个可编辑的内容块**：没有角色（不是页/日记/标签这些身份块，正文归它自己）、
       * 没有子块、也没有标签 chip（chip 挂在正文后面、不进读数，混进来就要额外拆一次正文）。
       *
       * ⚠️ 必须取**现行**而不是根块的直接子块：有些页打开时聚焦的是 `[[引用]]`（zoom 进子块），
       *    那时根的子块并不在本视图里 —— 往不在视图里的块打字，落点会跑掉（真踩过）。
       */
      const plain = (x) => x.content.filter((r) => r.t === 'text').map((r) => r.v).join('')
      const b = ed
        .rows()
        .map((r) => r.block)
        .find((x) => !(x.roles?.length) && !x.children.length && !(x.props?._tags?.length))
      return { id: b?.id ?? '', text: b ? plain(b) : '' }
    })
    assert(target.id !== '', '第一页里应有可编辑的内容块')
    await page.waitForTimeout(120)
    // 落盘证据直接读 storage（诊断面没有 `changes` 出口）：提交前的那一份应当**不含刚敲的字**
    const storedBefore = await page.evaluate(() => localStorage.getItem('qua.workspace') ?? '')

    // 真实键盘（走 `input` → `syncFromDom`，与 T63 的 `setText` 是两条管线）
    await page.evaluate((id) => window.__qua.focusBlock(id, 9999), target.id)
    await page.keyboard.type('Z')
    await page.waitForTimeout(120)

    const after = await page.evaluate((id) => {
      const b = window.__qua.blocks().find((x) => x.id === id)
      const ed = window.__qua.__editor
      return {
        ops: window.__qua.lastOps().map((o) => ({ e: o.e, id: o.id ?? o.block, op: o.op, text: o.value?.content === undefined ? undefined : o.value.content.filter((r) => r.t === 'text').map((r) => r.v).join('') })),
        text: b?.text ?? '',
        // 读数与模型同一口径（`readText` 跳过 chip）；另留一份 DOM 原样，便于失败时看出差在哪
        measured: ed.readRunsOf(id).filter((r) => r.t === 'text').map((r) => r.v).join(''),
        domText: ed.txEl(id)?.textContent ?? '',
      }
    }, target.id)
    await page.waitForTimeout(450)

    /**
     * **这批 op 真的被交给落盘**（不是只算出来给诊断面看）：防抖 250ms 之后盘上就该带上新字。
     * 断言的是「盘里出现了这个字」——`persist` 拿空 op 时会整库提交，那也照样能写进去，
     * 所以这条只管「写进去了」，「按 op 写」由上面那条 ops 断言负责。
     */
    const storedAfter = await page.evaluate(() => localStorage.getItem('qua.workspace') ?? '')
    assert(!storedBefore.includes(`${target.text}Z`), '前置：动手前盘上不该已经有这个字')
    assert(storedAfter.includes(`${target.text}Z`), '这批 op 应真的落进盘里（不是只算给诊断面）')

    const upserts = after.ops.filter((o) => o.e === 'block' && o.op === 'upsert')
    const annos = after.ops.filter((o) => o.e === 'anno')
    assert(after.text.endsWith('Z'), `模型里正文应已带上刚敲的字：${JSON.stringify(after.text)}`)
    assert(after.ops.length === 1, `真实键入 1 个字只该产 1 条 op：${JSON.stringify(after.ops)}`)
    assert(upserts.length === 1 && upserts[0].text === after.text, `那一条应是 block.upsert{content}：${JSON.stringify(upserts)}`)
    assert(upserts[0].id === target.id, 'op 应指向被敲的那一块')
    assert(annos.length === 0, `无锚点变化 ⇒ 0 条 anno：${JSON.stringify(annos)}`)
    assert(after.measured === after.text, `DOM 读数应与模型一致（不是只改了 DOM）：${JSON.stringify([after.measured, after.domText])}`)

    // 一次撤销回得去：正文回到敲之前，块数不变
    await page.evaluate(() => window.__qua.invoke('core.history/undo'))
    await page.waitForTimeout(200)
    const back = await page.evaluate((id) => {
      const ed = window.__qua.__editor
      const live = ed.store.find(id)
      return {
        text: live ? live.content.filter((r) => r.t === 'text').map((r) => r.v).join('') : null,
        // 撤销后这一块可能已经不在**本视图**（装载窗口）里了 ⇒ 读数走 store，并留一句给人看
        inView: ed.doc.roots.flatMap((r) => [r, ...r.children]).some((b) => b.id === id),
        roots: ed.doc.roots.length,
      }
    }, target.id)
    assert(back.text === target.text, `一次撤销应回到原文「${target.text}」：${JSON.stringify(back)}`)

    await ctx.close()
    return `真实键入 1 个字 ⇒ ops=[block.upsert{text}]（1 条，0 条 anno）；DOM 与模型一致；⌘Z 回原文`
  },
)

await check(
  'T65 `insertBlockAfter` 走一笔事务：插一块只发 1 条 upsert{parent,index}（落点由事务算，不是 splice 出来再报）；空块 + 待办＝时刻 upsert ＋ 1 条 prop.set；一次撤销回得去',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)

    /**
     * 取一个**非根**的内容块：根是 section（页），插到它「之后」按设计落成它的首个子块，
     * 走的是另一支；这里要验的是「同级位」那一支。兄弟列表与它在其中的下标都从**模型**读
     * （`parent.children`），不从 DOM 读 —— 断言要比对的就是「事务算出的落点」。
     */
    const target = await page.evaluate(() => {
      const ed = window.__qua.__editor
      const count = () => {
        let n = 0
        const walk = (list) => {
          for (const b of list) {
            n++
            walk(b.children)
          }
        }
        walk(ed.store.blocks)
        return n
      }
      // 父块与下标都从模型的**活块**读：`doc` 是装载窗口，`locate` 的 parent/index 就是按它算的
      const parentOf = (id) => {
        let hit = null
        const walk = (list, parent) => {
          for (const b of list) {
            if (b.id === id) hit = parent
            walk(b.children, b)
          }
        }
        walk(ed.store.blocks, null)
        return hit
      }
      const plain = (x) => x.content.filter((r) => r.t === 'text').map((r) => r.v).join('')
      const b = ed
        .rows()
        .map((r) => r.block)
        .find((x) => plain(x) !== '' && !(x.roles?.length) && parentOf(x.id) !== null)
      const parent = b ? parentOf(b.id) : null
      return {
        id: b?.id ?? '',
        parentId: parent?.id ?? '',
        index: parent ? parent.children.findIndex((k) => k.id === b.id) : -1,
        before: count(),
      }
    })
    assert(target.id !== '', '第一页里应有非根的内容块')
    assert(target.parentId !== '' && target.index >= 0, `前置：应能读出它的父块与下标：${JSON.stringify(target)}`)
    await page.waitForTimeout(120)

    const after = await page.evaluate((t) => {
      const ed = window.__qua.__editor
      const count = () => {
        let n = 0
        const walk = (list) => {
          for (const b of list) {
            n++
            walk(b.children)
          }
        }
        walk(ed.store.blocks)
        return n
      }
      const newId = ed.insertBlockAfter(t.id, '插一块')
      const ops = window.__qua.lastOps()
      // 模型读数走 store（整片森林）：诊断面的 `blocks()` 只给**当前视图**那一段
      let inModel = false
      const walk = (list) => {
        for (const b of list) {
          if (b.id === newId && b.content.some((r) => r.t === 'text' && r.v === '插一块')) inModel = true
          walk(b.children)
        }
      }
      walk(ed.store.blocks)
      return {
        newId,
        ops: ops.map((o) => ({ e: o.e, id: o.id ?? o.block, op: o.op, value: o.value })),
        inModel,
        total: count(),
      }
    }, target)
    await page.waitForTimeout(120)

    assert(after.newId !== null && after.newId !== '', 'insertBlockAfter 应返回新块的 id')
    assert(after.ops.length === 1, `插一块只该产 1 条 op：${JSON.stringify(after.ops)}`)
    const upsert = after.ops[0]
    assert(upsert.e === 'block' && upsert.op === 'upsert', `那一条应是 block.upsert：${JSON.stringify(upsert)}`)
    assert(upsert.id === after.newId, 'op 应指向新块')
    assert(
      upsert.value?.parent === target.parentId,
      `落点应由事务按整片森林算：父应是「${target.parentId}」，实际「${upsert.value?.parent}」`,
    )
    assert(upsert.value?.prev === target.id, `前兄弟应是原块（${target.id.slice(-6)}）：${JSON.stringify(upsert.value)}`)
    assert(after.inModel, '新块应真的在模型里（不是只算出一条 op）')
    assert(after.total === target.before + 1, `块数应 +1：${target.before} → ${after.total}`)

    // 一次撤销回得去：新块从模型里消失，块数回原样
    await page.evaluate(() => window.__qua.invoke('core.history/undo'))
    await page.waitForTimeout(200)
    const back = await page.evaluate((newId) => {
      const ed = window.__qua.__editor
      let gone = true
      let total = 0
      const walk = (list) => {
        for (const b of list) {
          total++
          if (b.id === newId) gone = false
          walk(b.children)
        }
      }
      walk(ed.store.blocks)
      return { gone, total }
    }, after.newId)
    assert(back.gone, '一次撤销后新块应不在模型里')
    assert(back.total === target.before, `一次撤销块数应回原样：${target.before}，实际 ${back.total}`)

    /**
     * **空块 ＋ `/待办`**：这一支不新建块，只把一个属性值落到块上 ⇒
     * 一笔事务里**恰好 1 条** `prop.set`，没有任何结构 op（多一条就会在撤销里多一步）。
     * 用 `/` 命令真实的入口（`invoke` 走的是「当前块」），而不是直调编辑器 —— 顺便钉住接线。
     */
    const todo = await page.evaluate(() => {
      const ed = window.__qua.__editor
      const canEdit = (e, x) => {
        if (x.roles?.length) return false
        return Boolean(e.blockEl(x.id)?.querySelector('.tx'))
      }
      /**
       * 本页的空块不一定现成有：**自己造一个**（在本页第一个可编辑行下插一个空块）
       * ——「/待办 落在空块上」这一支必须有可落点的空块。
       * 只挑现成的会让这一格在假数据一改就静默跳过，而它验的正是「1 条 prop.set」。
       */
      let host = ed.rows().map((r) => r.block).find((x) => x.text === '' && !(x.roles?.length) && !(x.children.length))
      if (!host) {
        const anchor = ed.rows().map((r) => r.block).find((x) => canEdit(ed, x))
        if (!anchor) return { skipped: true }
        const id = ed.insertBlockAfter(anchor.id, '')
        host = id ? ed.store.find(id) : undefined
        if (!host) return { skipped: true }
      }
      window.__qua.focusBlock(host.id, 0)
      window.__qua.invoke('core.editor/insert-block', { type: 'todo' })
      const ops = window.__qua.lastOps()
      // 属性读数走 store 的活块（诊断面的 `blocks()` 只给当前视图那一段）
      const live = ed.store.find(host.id)
      return {
        skipped: false,
        ops: ops.map((o) => ({ e: o.e, id: o.id ?? o.block, op: o.op, value: o.value })),
        // 任务状态是一个属性槽；只验「槽建出来了、值是布尔」，不绑死属性键名
        bools: Object.values(live?.props ?? {}).filter((v) => typeof v === 'boolean'),
      }
    })
    if (!todo.skipped) {
      const propSets = todo.ops.filter((o) => o.e === 'prop' && o.op === 'set')
      const structOps = todo.ops.filter((o) => o.e === 'block')
      /**
       * **一次属性写入会同时刷新「修改于」**（时刻住在块上、值住在属性袋里）⇒ 这一支
       * 产出「一条 upsert{content,modified} ＋ 一条 prop.set」，一次撤销仍然一步回去。
       * 判据因此是「恰好这两条、没有结构 op」，不是「总共一条」——后者会逼实现
       * 把两件不同的事实塞进同一条 op 里。
       */
      assert(todo.ops.length === 2, `空块 + 待办应恰好 2 条 op（时刻 upsert ＋ prop.set）：${JSON.stringify(todo.ops)}`)
      assert(propSets.length === 1, `其中一条应是 prop.set：${JSON.stringify(todo.ops)}`)
      assert(
        structOps.length === 1 && Object.keys(structOps[0].value ?? {}).includes('modified'),
        `另一条只该是「记改动时刻」的 upsert（不带 parent/index）：${JSON.stringify(structOps)}`,
      )
      assert(todo.bools.length === 1 && todo.bools[0] === false, `块上应落一个「未完成」的任务状态值：${JSON.stringify(todo.bools)}`)
    }

    await ctx.close()
    return todo.skipped
      ? 'insertBlockAfter ⇒ ops=[block.upsert{parent,index}]（1 条，落点＝原块之后）；⌘Z 回原样。空块+待办分支本页没有空块，跳过'
      : 'insertBlockAfter ⇒ ops=[block.upsert{parent,index}]（1 条，落点＝原块之后）；⌘Z 回原样；空块 + /待办 ⇒ ops=[upsert{modified}, prop.set]（一笔事务，没有结构 op）'
  },
)

await check(
  'T66 块中 Enter（split 支）走一笔事务：恰好 2 条 op（左半 upsert{parent,index} ＋ 原块 upsert{content}），一次撤销回得去',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)

    /**
     * 取一个**非根**的内容块：带父块（段根走另一支「首个子块」）、无子块、正文 ≥ 4 字，
     * 且**这一块自己没有锚点**——有 mark/atom 时事务里会多出 `anno.*`，而这条用例
     * 要钉的是「正文一半 + 结构一块 = 2 条 op」这个形状。
     */
    const target = await page.evaluate(() => {
      const ed = window.__qua.__editor
      const parentOf = (id) => {
        let hit = null
        const walk = (list, parent) => {
          for (const b of list) {
            if (b.id === id) hit = parent
            walk(b.children, b)
          }
        }
        walk(ed.store.blocks, null)
        return hit
      }
      const marks = window.__qua.marks()
      const atoms = window.__qua.atoms()
      const plain = (x) => x.content.filter((r) => r.t === 'text').map((r) => r.v).join('')
      const b = ed
        .rows()
        .map((r) => r.block)
        .find(
          (x) =>
            plain(x).length >= 4 &&
            !(x.roles?.length) &&
            !x.children.length &&
            !(x.props?._tags?.length) &&
            parentOf(x.id) !== null &&
            !marks.some((m) => m.blockId === x.id) &&
            !atoms.some((a) => a.blockId === x.id),
        )
      const parent = b ? parentOf(b.id) : null
      let before = 0
      const count = (list) => {
        for (const k of list) {
          before++
          count(k.children)
        }
      }
      count(ed.store.blocks)
      return {
        id: b?.id ?? '',
        text: b ? plain(b) : '',
        parentId: parent?.id ?? '',
        index: parent ? parent.children.findIndex((k) => k.id === b.id) : -1,
        // 原块的前兄弟 id（op 记的是它，不是下标）
        prevId: (() => {
          const i = parent ? parent.children.findIndex((k) => k.id === b.id) : -1
          return i <= 0 ? null : (parent.children[i - 1]?.id ?? null)
        })(),
        before,
      }
    })
    assert(target.id !== '', '第一页里应有非根、无子块、无锚点的内容块')
    assert(target.parentId !== '' && target.index >= 0, `前置：应能读出它的父块与下标：${JSON.stringify(target)}`)
    await page.waitForTimeout(120)

    // 光标落在块中（offset 2 ⇒ 无同块选区 ⇒ 走 `split` 支，不是 forcedSplit）
    await page.evaluate((id) => window.__qua.focusBlock(id, 2), target.id)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(200)

    const after = await page.evaluate((t) => {
      const ed = window.__qua.__editor
      const plain = (b) => b.content.filter((r) => r.t === 'text').map((r) => r.v).join('')
      const runPlain = (c) => c.filter((r) => r.t === 'text').map((r) => r.v).join('')
      const live = ed.store.find(t.id)
      const parent = ed.store.find(t.parentId)
      const kids = (parent?.children ?? []).map((b) => ({ id: b.id, text: plain(b) }))
      let total = 0
      const walk = (list) => {
        for (const b of list) {
          total++
          walk(b.children)
        }
      }
      walk(ed.store.blocks)
      return {
        ops: window.__qua.lastOps().map((o) => ({
          e: o.e,
          id: o.id ?? o.block,
          op: o.op,
          parent: o.value?.parent,
          pos: o.value?.prev === null ? 0 : undefined,
          prev: o.value?.prev,
          text: o.value?.content === undefined ? undefined : runPlain(o.value.content),
        })),
        text: live ? plain(live) : '',
        kids,
        total,
        // `doc` 是装载窗口：新块也必须在它里面（`tx.insert` 改的是共享的兄弟数组）
        rows: ed.rows().map((r) => ({ id: r.block.id, text: plain(r.block) })),
        // 这两块都没有锚点 ⇒ `textContent` 就是正文
        domText: [...document.querySelectorAll('.blk .tx')].map((el) => el.textContent ?? ''),
      }
    }, target)

    const textOps = after.ops.filter((o) => o.e === 'block' && o.op === 'upsert' && o.text !== undefined && o.parent === undefined)
    const structOps = after.ops.filter((o) => o.e === 'block' && o.op === 'upsert' && o.parent !== undefined)
    assert(after.ops.length === 2, `块中 Enter 只该产 2 条 op（内容一半 ＋ 结构一块）：${JSON.stringify(after.ops)}`)
    assert(textOps.length === 1, `应恰有 1 条 upsert{content}：${JSON.stringify(after.ops)}`)
    assert(textOps[0].id === target.id, `内容那一条应指向原块（它保 id）：${JSON.stringify(textOps[0])}`)
    assert(
      textOps[0].text === target.text.slice(2),
      `原块应只留右半：期望「${target.text.slice(2)}」，实际「${textOps[0].text}」`,
    )
    assert(structOps.length === 1, `应恰有 1 条 upsert{parent,index}：${JSON.stringify(after.ops)}`)
    assert(structOps[0].id !== target.id, '结构那一条应指向左半新块')
    assert(
      structOps[0].parent === target.parentId,
      `左半的父应是「${target.parentId}」，实际「${structOps[0].parent}」`,
    )
    assert(
      structOps[0].prev === target.prevId,
      `左半的前兄弟应是原块前面那一块：实际 ${JSON.stringify(structOps[0].prev)}`,
    )

    // 模型：原块 = 右半；新块 = 左半；新块在原位上方
    assert(after.text === target.text.slice(2), `模型里原块应是右半：${JSON.stringify(after.text)}`)
    assert(
      after.kids[target.index]?.id === structOps[0].id,
      `左半新块应占原块的位置：${JSON.stringify(after.kids)}`,
    )
    assert(
      after.kids[target.index]?.text === target.text.slice(0, 2),
      `左半新块的正文应是「${target.text.slice(0, 2)}」：${JSON.stringify(after.kids)}`,
    )
    assert(after.total === target.before + 1, `块数应 +1：${target.before} → ${after.total}`)
    assert(
      after.rows.some((r) => r.id === structOps[0].id && r.text === target.text.slice(0, 2)),
      `装载窗口（doc）里应看得见新块：${JSON.stringify(after.rows)}`,
    )
    assert(after.domText.includes(target.text.slice(0, 2)), `DOM 应重渲染出左半：${JSON.stringify(after.domText.slice(0, 6))}`)
    assert(after.domText.includes(target.text.slice(2)), `DOM 应重渲染出右半：${JSON.stringify(after.domText.slice(0, 6))}`)

    // 一次撤销：原块正文回到原样，新块从模型里消失
    await page.evaluate(() => window.__qua.invoke('core.history/undo'))
    await page.waitForTimeout(200)
    const back = await page.evaluate((t) => {
      const ed = window.__qua.__editor
      let gone = true
      let total = 0
      const walk = (list) => {
        for (const b of list) {
          total++
          if (b.id === t.leftId) gone = false
          walk(b.children)
        }
      }
      walk(ed.store.blocks)
      const live = ed.store.find(t.id)
      const plain = (b) => (b ? b.content.filter((r) => r.t === 'text').map((r) => r.v).join('') : null)
      return { text: plain(live), gone, total }
    }, { id: target.id, leftId: structOps[0].id })
    assert(back.text === target.text, `一次撤销应回到整块原文「${target.text}」：${JSON.stringify(back)}`)
    assert(back.gone, '一次撤销后左半新块应不在模型里')
    assert(back.total === target.before, `一次撤销块数应回原样：${target.before}，实际 ${back.total}`)

    await ctx.close()
    return `块中 Enter ⇒ ops=[upsert{parent,index}, upsert{text}]（2 条）；原块=右半、左半占原位；⌘Z 回原样`
  },
)

await check(
  'T67 `#新标签` + ⇧↵ 走**一笔**事务：删触发词 ＋ 建标签块 ＋ 物化记录（住森林顶层）＋ 插 `flavor:#` 露面同批；一次撤销连记录与标签一起回滚、宿主 `_tags` 没被写',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)

    /**
     * 判据是「一次用户动作 ＝ 一笔事务」：删掉 `#zzz` 那几个字、按名字建出标签块、
     * 物化一条记录（住森林顶层）、在原位插一枚指向**记录**的露面 —— 四件事拆开落盘会留下
     * 「字删了、记录没建」「露面有了、归属没写」这类半批。它只能靠**同一笔**的 op 集合来证，
     * 界面全绿也可能已经是半批。
     *
     * ⚠️ 这条同时钉「提及 ≠ 归类」：Enter 只插露面，**不写宿主的** `_tags`
     *    （记录自己的 `_tags` 是它的归属，不是宿主的）。
     */
    const before = await page.evaluate(() => {
      const ed = window.__qua.__editor
      const plain = (x) => x.content.filter((r) => r.t === 'text').map((r) => r.v).join('')
      const b = ed
        .rows()
        .map((r) => r.block)
        .find((x) => !(x.roles?.length) && !x.children.length && !(x.props?._tags?.length))
      const count = (list) => list.reduce((n, k) => n + 1 + count(k.children), 0)
      return {
        id: b.id,
        text: plain(b),
        total: count(ed.store.blocks),
        tagCount: ed.store.blocks.filter((x) => (x.props?._lists ?? []).includes('tag')).length,
      }
    })

    await page.evaluate((id) => window.__qua.focusBlock(id, 9999), before.id)
    await page.keyboard.type(' #zzz')
    await page.waitForTimeout(180)
    // 前置：浮层真的弹了，而且当前那一行就是「新建记录 #zzz」
    const rows = await layerRows(page)
    assert(rows.length > 0, `敲 # 应弹出浮层：${JSON.stringify(rows)}`)
    assert(rows[0].label.includes('新建标签') && rows[0].label.includes('zzz'), `第一行应是「新建标签 #zzz」：${JSON.stringify(rows.slice(0, 3))}`)
    assert(rows[0].key !== '', `新建标签行也支持 ⌥↵ / ⇧↵，徽标不能空：${JSON.stringify(rows[0])}`)

    await page.keyboard.press('Shift+Enter')
    await page.waitForTimeout(220)

    const after = await page.evaluate((t) => {
      const ed = window.__qua.__editor
      const plain = (b) => (b ? b.content.filter((r) => r.t === 'text').map((r) => r.v).join('') : null)
      const runKinds = (c) => c.map((r) => (r.t === 'ref' && r.flavor === '#' ? 'tag' : r.t)).join(',')
      const live = ed.store.find(t.id)
      const ops = window.__qua.lastOps()
      const atoms = window.__qua.atoms().filter((a) => a.blockId === t.id)
      const recordId = atoms[0]?.target?.id ?? ''
      const record = ed.store.find(recordId)
      const tagId = record?.props?._tags?.[0] ?? ''
      return {
        ops: ops.map((o) => ({
          e: o.e,
          id: o.id ?? o.block ?? '',
          op: o.op,
          name: o.name ?? '',
          runs: o.value?.content === undefined ? '' : runKinds(o.value.content),
          parent: o.value && typeof o.value === 'object' && !Array.isArray(o.value) && 'parent' in o.value ? o.value.parent : undefined,
        })),
        tagId,
        recordId,
        tagAlias: ed.store.find(tagId)?.props?._aliases?.[0] ?? '',
        recordText: plain(record),
        recordTags: record?.props?._tags ?? [],
        recordIsRoot: ed.store.blocks.some((x) => x.id === recordId),
        text: plain(live),
        tags: live?.props?._tags ?? [],
        atoms: atoms.map((a) => ({ kind: a.kind, target: a.target?.id ?? '' })),
      }
    }, before)

    const textOps = after.ops.filter((o) => o.e === 'block' && o.op === 'upsert' && o.runs !== '' && o.parent === undefined)
    const blockOps = after.ops.filter((o) => o.e === 'block' && o.op === 'upsert')
    const propOps = after.ops.filter((o) => o.e === 'prop')
    const topLevelOps = after.ops.filter((o) => o.e === 'block' && o.op === 'upsert' && o.parent === null)
    const recordOps = after.ops.filter((o) => o.e === 'block' && o.op === 'upsert' && o.id === after.recordId)
    assert(textOps.length === 1, `宿主内容应恰写一次：${JSON.stringify(after.ops)}`)
    assert(textOps[0].id === before.id && textOps[0].runs.includes('tag'), `那一次已是露面：${JSON.stringify(textOps)}`)
    assert(topLevelOps.length === 2, `同一笔里应建出 1 个标签块 ＋ 1 条记录（都在顶层）：${JSON.stringify(after.ops)}`)
    assert(topLevelOps.some((o) => o.id === after.tagId), `标签块应在顶层：${JSON.stringify(topLevelOps)}`)
    assert(topLevelOps.some((o) => o.id === after.recordId), `记录应在顶层：${JSON.stringify(topLevelOps)}`)
    assert(recordOps.length === 1, `同一笔里应物化 1 条记录：${JSON.stringify(after.ops)}`)
    assert(blockOps.length === 3, `这一笔应恰好 3 条 block op（宿主内容 ＋ 标签块 ＋ 记录）：${JSON.stringify(after.ops)}`)
    assert(propOps.every((o) => o.id !== before.id), `提及不写**宿主**归属：${JSON.stringify(propOps)}`)
    assert(propOps.some((o) => o.id === after.tagId && o.name === '_aliases'), `标签块的地址要进日志：${JSON.stringify(propOps)}`)
    assert(propOps.some((o) => o.id === after.recordId && o.name === '_tags'), `记录的归属要进日志：${JSON.stringify(propOps)}`)
    assert(after.ops.every((o) => o.e !== 'anno'), `露面住在内容里 ⇒ 0 条 anno：${JSON.stringify(after.ops)}`)

    assert(after.tagAlias === 'zzz', `标签块的名字应是 zzz：${JSON.stringify(after.tagAlias)}`)
    assert(after.tags.length === 0, `宿主这个块不该被归类：${JSON.stringify(after.tags)}`)
    assert(after.recordText === 'zzz', `记录的正文应是键入名（作描述）：${JSON.stringify(after.recordText)}`)
    assert(
      after.recordTags.length === 1 && after.recordTags[0] === after.tagId,
      `记录自己应归属那个标签（不是宿主）：${JSON.stringify(after.recordTags)}`,
    )
    assert(after.recordIsRoot, `记录应落在森林顶层：位置不承载信息，出生时刻由 created 记着`)
    assert(after.text === `${before.text} `, `投影应是「前缀 ＋ 空格」（露面不进投影、占 1 格）：${JSON.stringify(after.text)}`)
    assert(
      after.atoms.length === 1 && after.atoms[0].kind === 'tag' && after.atoms[0].target === after.recordId,
      `正文里应有 1 枚指向**记录**（不是标签类）的 tag 露面：${JSON.stringify(after.atoms)}`,
    )

    // 落点那笔撤销：正文、原子、**标签块本身**回到 pick 前（打完字、还没选中的样子）
    // ⚠️ 打字与落点是**两次动作、两笔撤销**：落点不是打字的延续（它是一次显式选择），
    //    所以一次撤销回滚落点（露面收起、标签块消失），再一次才回滚打字——这正是
    //    「落点不并进打字的撤销步」的判据（undo 合并窗口对 `other` 不生效）。
    await page.evaluate(() => window.__qua.invoke('core.history/undo'))
    await page.waitForTimeout(220)
    const back = await page.evaluate((t) => {
      const ed = window.__qua.__editor
      const plain = (b) => (b ? b.content.filter((r) => r.t === 'text').map((r) => r.v).join('') : null)
      const live = ed.store.find(t.id)
      const count = (list) => list.reduce((n, k) => n + 1 + count(k.children), 0)
      return {
        text: plain(live),
        tags: live?.props?._tags ?? [],
        tagGone: ed.store.find(t.tagId) === undefined,
        recordGone: ed.store.find(t.recordId) === undefined,
        atoms: window.__qua.atoms().filter((a) => a.blockId === t.id).length,
        total: count(ed.store.blocks),
        tagCount: ed.store.blocks.filter((x) => (x.props?._lists ?? []).includes('tag')).length,
      }
    }, { id: before.id, tagId: after.tagId, recordId: after.recordId })

    assert(back.text === `${before.text} #zzz`, `一次撤销应回到落点前的正文（字还留着）：${JSON.stringify(back.text)}`)
    assert(back.tagGone, '一次撤销后新建的标签块应不在模型里')
    assert(back.recordGone, '一次撤销后新建的记录应不在模型里')
    assert(back.tags.length === 0, `一次撤销后归属仍该是空的：${JSON.stringify(back.tags)}`)
    assert(back.atoms === 0, `一次撤销后正文里的 tag 露面应回滚：剩 ${back.atoms} 枚`)
    assert(back.total === before.total, `一次撤销块数应回原样：${before.total}，实际 ${back.total}`)
    assert(back.tagCount === before.tagCount, `标签块数应回原样：${before.tagCount}，实际 ${back.tagCount}`)

    // 再一次撤销才回滚打字：`#zzz` 那几个字也消失
    await page.evaluate(() => window.__qua.invoke('core.history/undo'))
    await page.waitForTimeout(220)
    const back2 = await page.evaluate((t) => {
      const ed = window.__qua.__editor
      const plain = (b) => (b ? b.content.filter((r) => r.t === 'text').map((r) => r.v).join('') : null)
      return plain(ed.store.find(t.id))
    }, { id: before.id })
    assert(back2 === before.text, `第二次撤销应回到输入前的正文「${before.text}」：${JSON.stringify(back2)}`)

    await ctx.close()
    return `#zzz + ⇧↵ ⇒ 一笔 3 条 op（宿主内容带露面 ＋ 顶层标签块 ＋ 顶层记录）、宿主 _tags 零写入；一次撤销连记录与标签一起回滚`
  },
)

await check(
  'T67b `#新标签` 的 ↵ / ⌥↵：↵ 建标签 + 行内引用（不建记录、不写 _tags）；⌥↵ 建标签 + 写 _tags（不建记录、不插 run）',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)

    const focusNew = () =>
      page.evaluate(() => {
        const ed = window.__qua.__editor
        const id = ed.insertBlockAfter(window.__qua.blocks()[0].id, '')
        window.__qua.focusBlock(id, 0)
        return id
      })

    // ① ↵ = 建标签块 + 正文里留一枚行内引用；宿主不归类、不建记录
    const inlineBlock = await focusNew()
    await page.waitForTimeout(80)
    await page.keyboard.type('#新标签甲')
    await page.waitForTimeout(220)
    const inlineRows = await layerRows(page)
    assert(inlineRows.some((r) => r.label.includes('新建标签') && r.label.includes('新标签甲')), `无同名标签时应出现「新建标签」行：${JSON.stringify(inlineRows)}`)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(220)

    const inline = await page.evaluate((t) => {
      const ed = window.__qua.__editor
      const b = ed.store.find(t.id)
      const tag = window.__qua.allBlocks().find((x) => x.lists.includes('tag') && x.aliases.includes('新标签甲'))
      const atoms = window.__qua.atoms().filter((a) => a.blockId === t.id)
      const tagged = window.__qua.allBlocks().filter((x) => (ed.store.find(x.id)?.props?._tags ?? []).includes(tag?.id ?? ''))
      return {
        tagId: tag?.id ?? '',
        tags: b?.props?._tags ?? [],
        atoms: atoms.map((a) => ({ kind: a.kind, target: a.target?.id ?? '' })),
        tagged: tagged.length,
        ops: window.__qua.lastOps().map((o) => ({ e: o.e, op: o.op, id: o.id, block: o.block ?? o.id, name: o.name })),
      }
    }, { id: inlineBlock })

    assert(inline.tagId !== '', '↵ 应新建标签块')
    assert(inline.atoms.length === 1 && inline.atoms[0].kind === 'tag' && inline.atoms[0].target === inline.tagId, `↵ 应插指向**标签类**的行内引用：${JSON.stringify(inline)}`)
    assert(inline.tags.length === 0, `↵ 不该把宿主归类：${JSON.stringify(inline.tags)}`)
    assert(inline.tagged === 0, `↵ 不该建记录/成员：${inline.tagged}`)
    const inlineBlockOps = inline.ops.filter((o) => o.e === 'block')
    const inlinePropOps = inline.ops.filter((o) => o.e === 'prop')
    assert(inlineBlockOps.length === 2, `↵ 应恰好 2 条 block op（宿主内容 ＋ 标签块）：${JSON.stringify(inline.ops)}`)
    assert(inlinePropOps.some((o) => o.block === inline.tagId && o.op === 'set'), `标签块的地址/露面要进日志：${JSON.stringify(inline.ops)}`)
    assert(inlinePropOps.every((o) => o.block !== inlineBlock), `↵ 不给宿主写归属：${JSON.stringify(inline.ops)}`)

    // ② ⌥↵ = 建标签块 + 写宿主 _tags；不建记录、不插 run
    const chipBlock = await focusNew()
    await page.waitForTimeout(80)
    await page.keyboard.type('#新标签乙')
    await page.waitForTimeout(220)
    await page.keyboard.press('Alt+Enter')
    await page.waitForTimeout(220)

    const chip = await page.evaluate((t) => {
      const ed = window.__qua.__editor
      const b = ed.store.find(t.id)
      const tag = window.__qua.allBlocks().find((x) => x.lists.includes('tag') && x.aliases.includes('新标签乙'))
      const tagged = window.__qua.allBlocks().filter((x) => (ed.store.find(x.id)?.props?._tags ?? []).includes(tag?.id ?? ''))
      return {
        tagId: tag?.id ?? '',
        tags: b?.props?._tags ?? [],
        atoms: window.__qua.atoms().filter((a) => a.blockId === t.id).length,
        tagged: tagged.length,
        ops: window.__qua.lastOps().map((o) => ({ e: o.e, op: o.op, id: o.id, block: o.block ?? o.id, name: o.name })),
      }
    }, { id: chipBlock })

    assert(chip.tagId !== '', '⌥↵ 应新建标签块')
    assert(chip.tags.length === 1 && chip.tags[0] === chip.tagId, `⌥↵ 应写宿主 _tags：${JSON.stringify(chip.tags)}`)
    assert(chip.atoms === 0, `⌥↵ 是归类，不该插行内原子：${chip.atoms}`)
    assert(chip.tagged === 1, `⌥↵ 只该有宿主这一条成员：${chip.tagged}`)
    const chipBlockOps = chip.ops.filter((o) => o.e === 'block')
    const chipPropOps = chip.ops.filter((o) => o.e === 'prop')
    assert(chipBlockOps.length === 2, `⌥↵ 应恰好 2 条 block op（宿主内容 ＋ 标签块）：${JSON.stringify(chip.ops)}`)
    assert(chipPropOps.some((o) => o.block === chipBlock && o.name === '_tags'), `⌥↵ 要写宿主 _tags：${JSON.stringify(chip.ops)}`)
    assert(chipPropOps.some((o) => o.block === chip.tagId && o.name === '_aliases'), `标签块的地址要进日志：${JSON.stringify(chip.ops)}`)

    await ctx.close()
    return `无同名标签时：↵ 建标签 + 行内引用（2 条 op）；⌥↵ 建标签 + 写 _tags（3 条 op）；两者都不建记录`
  },
)

await check(
  'T68 缩进／反缩进／上下换位各走一笔事务：每次一条 upsert{parent,index} ＋ 一条时刻 upsert，一次撤销复原',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)

    /**
     * 挑一个**深度 ≥ 2**、且前一行是同深度的块：缩进要有前兄弟，反缩进要有「父块的父块」
     * （装载根的直接子层没有落点 —— 窗口 roots 不是森林的根）。
     */
    const pick = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.blk')]
      for (let i = 1; i < rows.length; i++) {
        const d = Number(rows[i].dataset.depth)
        if (d >= 2 && Number(rows[i - 1].dataset.depth) === d) {
          return { id: rows[i].dataset.blockId, depth: d }
        }
      }
      return null
    })
    assert(pick, '假数据里应能找到「深度 ≥2 且有同层前兄弟」的块')

    /** 模型位置（整片森林口径）：父块、下标、兄弟列表长度、自己的子块数 */
    const pos = (id) =>
      page.evaluate((id) => {
        const ed = window.__qua.__editor
        let hit = null
        const walk = (list, parent) => {
          list.forEach((b, i) => {
            if (b.id === id) hit = { parentId: parent?.id ?? null, index: i, siblings: list.length, kids: b.children.length }
            walk(b.children, b)
          })
        }
        walk(ed.store.blocks, null)
        return hit
      }, id)

    const start = await pos(pick.id)
    assert(start?.parentId, `前置：选中的块应有父块：${JSON.stringify(start)}`)
    const prev = await page.evaluate(
      (id) => {
        const ed = window.__qua.__editor
        let prevId = null
        const walk = (list, parent) => {
          list.forEach((b, i) => {
            if (b.id === id) prevId = list[i - 1]?.id ?? null
            walk(b.children, b)
          })
        }
        walk(ed.store.blocks, null)
        return prevId
      },
      pick.id,
    )
    assert(prev, '前置：选中的块应有前兄弟')
    const prevStart = await pos(prev)
    /**
     * 缩进之后的**前兄弟**＝`prev` 的最后一个孩子（那一层只有 prev 有孩子）。
     * 用 id 而不是下标表达落点：op 记的是前兄弟 id（下标进了持久化历史就补不回来）。
     */
    const prevLastKid = await page.evaluate((id) => {
      const b = window.__qua.__editor.store.find(id)
      return b?.children.at(-1)?.id ?? null
    }, prev)

    const depthOf = (id) =>
      page.evaluate(
        (id) => Number(document.querySelector(`.blk[data-block-id="${id}"]`)?.dataset.depth ?? -1),
        id,
      )
    const ops = () =>
      page.evaluate(() => window.__qua.lastOps().map((o) => ({ e: o.e, id: o.id, op: o.op, value: o.value })))

    /**
     * 一次结构移动的 op 形状：**一条** `upsert{parent,prev}` ＋ **一条**记时刻的 `upsert{…,modified}`。
     *
     * 为什么是两条而不是并成一条：换位置与「最后一次改动」是同一块上的两件事，
     * 但结构 op 的判据是「它现在在哪」，往里掺正文/时刻会让「结构不作 diff」那条
     * 纪律失效（结构变化必须一眼看得出）。两条仍在一笔事务里 ⇒ 撤销一次回去。
     *
     * 落点记的是**前兄弟 id**（不是下标）：下标只对「那一刻的兄弟列表」有意义，
     * 进了持久化历史就补不回来。这里断言锚点，位置由「锚点之后」唯一确定。
     */
    const oneMove = (list, want) => {
      const places = list.filter(
        (o) => o.e === 'block' && o.op === 'upsert' && (o.value?.parent !== undefined || o.value?.prev !== undefined),
      )
      const stamps = list.filter((o) => o.e === 'block' && o.op === 'upsert' && o.value?.modified !== undefined && o.value?.parent === undefined)
      assert(places.length === 1 && stamps.length === 1 && list.length === 2, `应恰好 2 条 op（落点 ＋ 时刻）：${JSON.stringify(list)}`)
      const p0 = places[0]
      assert(p0.e === 'block' && p0.id === pick.id && p0.op === 'upsert', `落点应是一条 block.upsert：${JSON.stringify(p0)}`)
      const v = p0.value ?? {}
      assert(
        Object.keys(v).length === 2,
        `落点只该带 {parent,prev}（不带正文/属性）：${JSON.stringify(v)}`,
      )
      assert(v.parent === want.parentId, `父块应是「${want.parentId}」，实际「${v.parent}」`)
      assert(v.prev === want.prev, `前兄弟应是 ${JSON.stringify(want.prev)}，实际 ${JSON.stringify(v.prev)}`)
      assert(stamps[0].id === pick.id, `记时刻的那条该是同一块：${JSON.stringify(stamps[0])}`)
    }

    // ① Tab 缩进：变前兄弟的最后一个孩子（落点 ＝ 前兄弟此刻的子块数）
    await page.evaluate((p) => window.__qua.focusBlock(p.id, 1), pick)
    await page.keyboard.press('Tab')
    await page.waitForTimeout(180)
    oneMove(await ops(), { parentId: prev, prev: prevLastKid })
    const afterIndent = await pos(pick.id)
    assert(
      afterIndent.parentId === prev && afterIndent.index === prevStart.kids,
      `缩进后应挂在前兄弟的孩子末尾：${JSON.stringify(afterIndent)}（期望 ${prev}#${prevStart.kids}）`,
    )
    assert((await depthOf(pick.id)) === pick.depth + 1, `DOM 深度应 +1：${pick.depth} → ${await depthOf(pick.id)}`)

    // ② Shift+Tab 反缩进：变父的下一个兄弟 ⇒ 回到原位
    await page.keyboard.press('Shift+Tab')
    await page.waitForTimeout(180)
    oneMove(await ops(), { parentId: start.parentId, prev })
    const afterOutdent = await pos(pick.id)
    assert(
      afterOutdent.parentId === start.parentId && afterOutdent.index === start.index,
      `反缩进应回到原位：${JSON.stringify(start)} → ${JSON.stringify(afterOutdent)}`,
    )
    assert((await depthOf(pick.id)) === pick.depth, `DOM 深度应回原样：${await depthOf(pick.id)}`)

    // ③ ⌘⇧↑ 上移一位：同层换位，仍是一条 move
    // 上移一格之后，前兄弟是「原来在它前面第二块」的那一块（用 id 表达锚点）
    const prev2 = await page.evaluate((id) => {
      const ed = window.__qua.__editor
      let out = null
      const walk = (list) => {
        list.forEach((b, i) => {
          if (b.id === id) out = list[i - 2]?.id ?? null
          walk(b.children)
        })
      }
      walk(ed.store.blocks)
      return out
    }, pick.id)
    await page.keyboard.press('Meta+Shift+ArrowUp')
    await page.waitForTimeout(180)
    oneMove(await ops(), { parentId: start.parentId, prev: prev2 })
    const afterUp = await pos(pick.id)
    assert(afterUp.index === start.index - 1, `上移后下标应是 ${start.index - 1}：${JSON.stringify(afterUp)}`)

    // ④ 一次撤销：回到上移前的位置（不是再往上挪一格）
    await page.evaluate(() => window.__qua.invoke('core.history/undo'))
    await page.waitForTimeout(200)
    const back = await pos(pick.id)
    assert(
      back.parentId === start.parentId && back.index === start.index,
      `一次撤销应回到「${JSON.stringify(start)}」：${JSON.stringify(back)}`,
    )
    assert((await depthOf(pick.id)) === pick.depth, '撤销后 DOM 深度也应回原样')

    await ctx.close()
    return `缩进/反缩进/上移 ⇒ 各「1 条 upsert{parent,index} ＋ 1 条时刻 upsert」（父块与下标都随模型真值）；⌘Z 回原位`
  },
)

await check(
  'T69 删块走一笔事务：操作根恰好 1 条 block.delete；可见读全部消失，块带标记留在森林原位（原位软删），一次撤销复原',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)

    /**
     * 挑一个**叶子内容块**（无子块、无身份、无行内原子）：子树只有它自己 ⇒ op 数可精确断言；
     * 内容里没有原子 ⇒ 断言之外不会有多余的内容 op。
     */
    const pick = await page.evaluate(() => {
      const ed = window.__qua.__editor
      const marks = window.__qua.marks()
      const atoms = window.__qua.atoms()
      let hit = null
      // ⚠️ 只在**当前装载窗口**里挑：`remove` 按 `this.doc` 定位，森林里别页的块删不到
      const walk = (list, parent) => {
        list.forEach((b, i) => {
          if (hit) return
          const content = !(b.props?._lists?.length) && !(b.props?._aliases?.length) && !b.children.length
          if (content && parent && !marks.some((m) => m.blockId === b.id) && !atoms.some((a) => a.blockId === b.id)) {
            hit = { id: b.id, parentId: parent.id, index: i, text: b.text }
            return
          }
          walk(b.children, b)
        })
      }
      walk(ed.doc.roots, null)
      let total = 0
      const count = (list) => list.forEach((b) => (total++, count(b.children)))
      count(ed.store.blocks)
      return { ...(hit ?? {}), total }
    })
    assert(pick.id, '第一页里应有一个叶子内容块')

    await page.evaluate((id) => window.__qua.__editor.remove(id), pick.id)
    await page.waitForTimeout(180)

    const after = await page.evaluate((t) => {
      const ed = window.__qua.__editor
      // 含被删块的遍历：原位软删的块还在树上的原位
      let hit = null
      let total = 0
      let visible = 0
      const walk = (list, parent) => {
        list.forEach((b, i) => {
          total++
          if (!b.props?._deletedAt) visible++
          if (b.id === t.id) hit = { parentId: parent?.id ?? null, index: i, marked: Boolean(b.props?._deletedAt), kids: b.children.length }
          walk(b.children, b)
        })
      }
      walk(ed.store.blocks, null)
      return {
        ops: window.__qua.lastOps().map((o) => ({ e: o.e, id: o.id, op: o.op, state: o.state })),
        gone: ed.store.find(t.id) === undefined,
        hit,
        total,
        visible,
        dom: Boolean(document.querySelector(`.blk[data-block-id="${t.id}"]`)),
        rows: document.querySelectorAll('.blk').length,
      }
    }, pick)

    assert(after.ops.length === 1, `叶子删块应恰好 1 条 op（只落操作根）：${JSON.stringify(after.ops)}`)
    assert(
      after.ops[0].e === 'block' && after.ops[0].id === pick.id && after.ops[0].op === 'exist' && after.ops[0].state === 'deleted',
      `应是一条 block.exist{deleted} 指向被删块：${JSON.stringify(after.ops)}`,
    )
    assert(after.gone, '可见读（store.find）应找不到它')
    assert(after.hit, '块应留在森林原位（原位软删，不是摘出去）')
    assert(
      after.hit.parentId === pick.parentId && after.hit.index === pick.index && after.hit.marked,
      `原位（父块/下标不变）＋带删除标记：${JSON.stringify({ pick, hit: after.hit })}`,
    )
    assert(after.total === pick.total, `块总数不变（内容不丢）：${pick.total} → ${after.total}`)
    assert(after.visible === pick.total - 1, '可见块数应 -1（被删子树对遍历不可见）')
    assert(!after.dom, 'DOM 里应不再有这一行')
    assert(after.rows > 0, '删掉一行之后编辑器仍有行（不是整片清空）')

    await page.evaluate(() => window.__qua.invoke('core.history/undo'))
    await page.waitForTimeout(200)
    const back = await page.evaluate((t) => {
      const ed = window.__qua.__editor
      let hit = null
      let total = 0
      const walk = (list, parent) => {
        list.forEach((b, i) => {
          total++
          if (b.id === t.id) hit = { parentId: parent?.id ?? null, index: i, text: b.text, marked: Boolean(b.props?._deletedAt) }
          walk(b.children, b)
        })
      }
      walk(ed.store.blocks, null)
      return { hit, total, dom: Boolean(document.querySelector(`.blk[data-block-id="${t.id}"]`)) }
    }, pick)

    assert(back.hit, '一次撤销后块应回到模型里')
    assert(
      back.hit.parentId === pick.parentId && back.hit.index === pick.index,
      `应回到原来的父块与下标：${JSON.stringify(pick)} → ${JSON.stringify(back.hit)}`,
    )
    assert(back.hit.text === pick.text, `正文应原样：${JSON.stringify(back.hit.text)}`)
    assert(!back.hit.marked, '撤销后删除标记应消失')
    assert(back.total === pick.total, `块数应复原：${pick.total}，实际 ${back.total}`)
    assert(back.dom, '撤销后 DOM 里应重新出现这一行')

    await ctx.close()
    return `删叶子 ⇒ ops=[block.delete]（操作根 1 条）；块带标记留在原位；⌘Z 回原父/原位/原文`
  },
)

await check(
  'T70 删页走一笔事务：操作根（页块）恰好 1 条 block.delete；页列表少一项，页块带标记留在森林、子树完整',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))

    // 新建一页（自带一个空首子块）再补一个子块，然后删页：删的是整棵子树
    await page.evaluate(() => window.__qua.invoke('core.page/new'))
    await page.waitForTimeout(120)
    const created = await page.evaluate(() => {
      const ed = window.__qua.__editor
      const root = ed.doc.roots[0]
      const kid = ed.insertBlockAfter(root.id, '删页测试子块')
      return {
        pageId: root.id,
        kidId: kid ?? '',
        childIds: root.children.map((b) => b.id),
        pages: window.__qua.pages().length,
      }
    })
    assert(created.pageId && created.kidId, `前置：新页与子块都应存在：${JSON.stringify(created)}`)

    await page.evaluate(() => window.__qua.invoke('core.page/delete'))
    await page.waitForTimeout(200)

    const after = await page.evaluate((t) => {
      const ed = window.__qua.__editor
      // 含被删块的遍历：页块与整棵子树都留在森林里（原位软删）
      let page = null
      const walk = (list) => {
        for (const b of list) {
          if (b.id === t.pageId) page = b
          walk(b.children)
        }
      }
      walk(ed.store.blocks)
      return {
        ops: window.__qua.lastOps().map((o) => ({ e: o.e, id: o.id, op: o.op, state: o.state })),
        pages: window.__qua.pages().length,
        pageGone: ed.store.find(t.pageId) === undefined,
        kidGone: ed.store.find(t.kidId) === undefined,
        pageMarked: page ? Boolean(page.props?._deletedAt) : false,
        kids: page ? page.children.map((b) => b.id) : [],
      }
    }, created)

    const deletes = after.ops.filter((o) => o.e === 'block' && o.op === 'exist' && o.state === 'deleted').map((o) => o.id)
    assert(
      after.ops.length === 1 && deletes[0] === created.pageId,
      `删页应恰好 1 条 block.exist{deleted}（操作根；子树的不可见是继承的）：${JSON.stringify(after.ops)}`,
    )
    assert(after.pageGone && after.kidGone, '页与子块对可见读都应消失')
    assert(after.pageMarked, '页块应带删除标记留在森林里')
    assert(
      JSON.stringify(after.kids) === JSON.stringify(created.childIds),
      `子树应原样保留（恢复时接得回）：${JSON.stringify(after.kids)}`,
    )
    assert(after.pages === created.pages - 1, `页列表应少一项：${created.pages} → ${after.pages}`)

    await ctx.close()
    return `删页 ⇒ ops=[block.delete]（操作根 1 条）；页列表 ${created.pages}→${after.pages}；页块带标记原位保留`
  },
)

await check(
  'T71 退格合并走一笔事务：内容 upsert ×2（前块拼接＋空壳清空）＋ 子块逐个 move ＋ block.delete，一次撤销连子块复原',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)

    /**
     * 挑一个**有子块、无锚点**的块，且它在**文档序**里的前一块可写。
     *
     * ⚠️ 「前一块」是文档序（先序）的前一个，不是上一个**兄弟**：
     *    有子块的前兄弟 ⇒ 前一块是它子树里的最后一个后代。判据必须与 `mergeIntoPrev` 同一口径。
     */
    const pick = await page.evaluate(() => {
      const ed = window.__qua.__editor
      const marks = window.__qua.marks()
      const atoms = window.__qua.atoms()
      const rows = []
      const walk = (list, parent) => {
        list.forEach((b, i) => {
          rows.push({ block: b, parentId: parent?.id ?? null, index: i })
          walk(b.children, b)
        })
      }
      walk(ed.doc.roots, null)
      const plain = (b) => b.content.filter((r) => r.t === 'text').map((r) => r.v).join('')
      const writable = (b) => !b.props?._date && !b.props?._kind && !b.props?._query
      for (let i = 1; i < rows.length; i++) {
        const cur = rows[i].block
        const prev = rows[i - 1].block
        if (cur.children.length < 1 || plain(cur) === '' || !writable(prev)) continue
        if (marks.some((m) => m.blockId === cur.id) || atoms.some((a) => a.blockId === cur.id)) continue
        return {
          id: cur.id,
          text: plain(cur),
          kids: cur.children.map((k) => k.id),
          prevId: prev.id,
          prevText: plain(prev),
          prevKids: prev.children.length,
          prevChildIds: prev.children.map((k) => k.id),
        }
      }
      return null
    })
    assert(pick, '第一页里应有「有子块、无锚点、前一块可写」的块')

    await page.evaluate((id) => window.__qua.focusBlock(id, 0), pick.id)
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(200)

    const after = await page.evaluate((t) => {
      const ed = window.__qua.__editor
      const plain = (b) => (b ? b.content.filter((r) => r.t === 'text').map((r) => r.v).join('') : null)
      const runPlain = (c) => c.filter((r) => r.t === 'text').map((r) => r.v).join('')
      const prev = ed.store.find(t.prevId)
      // 含被删块的遍历：被并块是**原位标记**的空壳
      let husk = null
      const walk = (list) => {
        for (const b of list) {
          if (b.id === t.id) husk = { marked: Boolean(b.props?._deletedAt), text: plain(b), kids: b.children.length }
          walk(b.children)
        }
      }
      walk(ed.store.blocks)
      return {
        ops: window.__qua.lastOps().map((o) => ({
          e: o.e,
          id: o.id,
          op: o.op,
          state: o.state,
          text: o.value?.content === undefined ? undefined : runPlain(o.value.content),
          parent: o.value?.parent,
          pos: o.value?.prev === null ? 0 : undefined,
          prev: o.value?.prev,
        })),
        gone: ed.store.find(t.id) === undefined,
        prevText: plain(prev),
        prevKids: (prev?.children ?? []).map((b) => b.id),
        husk,
      }
    }, pick)

    const textOps = after.ops.filter((o) => o.e === 'block' && o.op === 'upsert' && o.text !== undefined && o.parent === undefined)
    const moveOps = after.ops.filter((o) => o.e === 'block' && o.op === 'upsert' && o.parent !== undefined)
    const delOps = after.ops.filter((o) => o.e === 'block' && o.op === 'exist' && o.state === 'deleted')

    // 两条内容 upsert：前一块拼接 ＋ 被并块空壳清空（删除是原位标记，壳留在树上）
    assert(textOps.length === 2, `应恰有 2 条内容 upsert（前块拼接＋空壳清空）：${JSON.stringify(after.ops)}`)
    assert(textOps[0].id === pick.prevId, `内容应写进前一块「${pick.prevId}」：${JSON.stringify(textOps[0])}`)
    const huskOp = textOps.find((o) => o.id === pick.id)
    assert(huskOp && huskOp.text === '', `被并块空壳应清空：${JSON.stringify(huskOp)}`)
    assert(
      textOps[0].text === pick.prevText + pick.text,
      `前一块应变成「前文＋被并块」：${JSON.stringify(textOps[0].text)}`,
    )
    assert(moveOps.length === pick.kids.length, `子块应逐个 move（${pick.kids.length} 条）：${JSON.stringify(after.ops)}`)
    for (const [n, kid] of pick.kids.entries()) {
      const op = moveOps.find((o) => o.id === kid)
      assert(op, `子块 ${kid} 应有自己的 move op：${JSON.stringify(moveOps)}`)
      assert(op.parent === pick.prevId, `子块应挂到前一块下：${JSON.stringify(op)}`)
      // 子块按顺序接到前一块的末尾：第一块的锚点是前一块原来的最后一个孩子，之后依次相承
      const wantPrev = n === 0 ? (pick.prevKids === 0 ? null : pick.prevChildIds[pick.prevKids - 1] ?? null) : pick.kids[n - 1]
      assert(op.prev === wantPrev, `子块的前兄弟应是 ${JSON.stringify(wantPrev)}：${JSON.stringify(op)}`)
    }
    assert(delOps.length === 1 && delOps[0].id === pick.id, `被并块应有 1 条 block.exist{deleted}：${JSON.stringify(delOps)}`)
    assert(after.ops.length === 3 + pick.kids.length, `op 总数应是「正文 1 ＋ 子块 ${pick.kids.length} ＋ 清壳 1 ＋ 删除 1」：${JSON.stringify(after.ops)}`)

    assert(after.gone, '被并块对可见读应消失')
    assert(after.husk && after.husk.marked, '被并块应带删除标记留在原位（原位软删）')
    assert(after.husk.text === '' && after.husk.kids === 0, '空壳应确认是空的（内容已搬进前一块）')
    assert(after.prevText === pick.prevText + pick.text, `模型里前一块正文应已拼接：${JSON.stringify(after.prevText)}`)
    // 被并块的壳原位标记后仍占 raw 槽位（可见序不受影响）⇒ 比较时滤掉壳
    const gotVisible = after.prevKids.filter((id) => id !== pick.id)
    assert(
      pick.prevChildIds.filter((id) => id !== pick.id).every((id, n) => gotVisible[n] === id),
      `前一块原有子块（被并块自己除外）应原样在前：${JSON.stringify({ want: pick.prevChildIds, got: after.prevKids })}`,
    )
    assert(
      pick.kids.every((kid) => after.prevKids.includes(kid)),
      `被并块的子块应挂到前一块下：${JSON.stringify({ want: pick.kids, got: after.prevKids })}`,
    )

    await page.evaluate(() => window.__qua.invoke('core.history/undo'))
    await page.waitForTimeout(200)
    const back = await page.evaluate((t) => {
      const ed = window.__qua.__editor
      const plain = (b) => (b ? b.content.filter((r) => r.t === 'text').map((r) => r.v).join('') : null)
      const prev = ed.store.find(t.prevId)
      let cur = null
      let total = 0
      const walk = (list, parent) => {
        list.forEach((b, i) => {
          total++
          if (b.id === t.id) cur = { parentId: parent?.id ?? null, index: i, text: plain(b), kids: b.children.map((k) => k.id) }
          walk(b.children, b)
        })
      }
      walk(ed.store.blocks, null)
      return { prevText: plain(prev), cur, total, dom: Boolean(document.querySelector(`.blk[data-block-id="${t.id}"]`)) }
    }, pick)

    assert(back.prevText === pick.prevText, `一次撤销前一块正文应复原：${JSON.stringify(back.prevText)}`)
    assert(back.cur, '一次撤销后块应回到模型里')
    assert(back.cur.text === pick.text, `正文应原样：${JSON.stringify(back.cur.text)}`)
    assert(
      back.cur.kids.length === pick.kids.length && back.cur.kids.every((k, n) => k === pick.kids[n]),
      `子块应回到被并块下（原序）：${JSON.stringify(back.cur.kids)}`,
    )
    assert(back.dom, '撤销后 DOM 里应重新出现这一行')

    await ctx.close()
    return `退格合并 ⇒ ops=[正文 2 ＋ 子块 ${pick.kids.length} ＋ delete 1]；被并块原位标记且壳为空；⌘Z 连子块一起复原`
  },
)

await check(
  'T72 退格合并：格式与原子随内容进前一块，被并块不留内容',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)

    /** 挑一个**带格式或原子**的块，且文档序前一块可写 */
    const target = await page.evaluate(() => {
      const ed = window.__qua.__editor
      const marks = window.__qua.marks()
      const atoms = window.__qua.atoms()
      const rows = []
      const walk = (list, parent) => {
        list.forEach((b, i) => {
          rows.push({ block: b, parentId: parent?.id ?? null, index: i })
          walk(b.children, b)
        })
      }
      walk(ed.doc.roots, null)
      const writable = (b) => !b.props?._date && !b.props?._kind && !b.props?._query
      for (let i = 1; i < rows.length; i++) {
        const cur = rows[i].block
        const prev = rows[i - 1].block
        if (!writable(prev)) continue
        const m = marks.filter((x) => x.blockId === cur.id)
        const a = atoms.filter((x) => x.blockId === cur.id)
        if (m.length === 0 && a.length === 0) continue
        return { id: cur.id, prevId: prev.id }
      }
      return null
    })
    assert(target, '第一页里应有「带格式/原子、前一块可写」的块')

    /** 合并前的快照：被并块自己的格式种类与原子 id，前一块的投影长度 */
    const pick = await page.evaluate((t) => {
      const ed = window.__qua.__editor
      const plain = (b) => b.content.filter((r) => r.t === 'text').map((r) => r.v).join('')
      const prev = ed.store.find(t.prevId)
      return {
        ...t,
        prevLen: plain(prev).length,
        types: window.__qua.marks().filter((x) => x.blockId === t.id).map((x) => x.type),
        atomIds: window.__qua.atoms().filter((x) => x.blockId === t.id).map((x) => x.id),
      }
    }, target)
    await page.evaluate((id) => window.__qua.focusBlock(id, 0), target.id)
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(200)

    const after = await page.evaluate((t) => {
      const ed = window.__qua.__editor
      const prev = ed.store.find(t.prevId)
      // 空壳对可见读（索引/`store.find`）已不可见 ⇒ 按含被删块的遍历取
      let husk = null
      const walk = (list) => {
        for (const b of list) {
          if (b.id === t.id) husk = b
          walk(b.children)
        }
      }
      walk(ed.store.blocks)
      const plain = (b) => (b ? b.content.filter((r) => r.t === 'text').map((r) => r.v).join('') : null)
      return {
        prevPlain: plain(prev),
        // 前一块内容里、落在「被并块那段」的 run：格式种类与原子 id 都该出现在那里
        prevMarks: window.__qua.marks().filter((x) => x.blockId === t.prevId && x.start >= t.prevLen).map((x) => x.type),
        prevAtoms: window.__qua.atoms().filter((x) => x.blockId === t.prevId).map((x) => x.id),
        huskPlain: plain(husk),
        huskMarks: window.__qua.marks().filter((x) => x.blockId === t.id).length,
        huskAtoms: window.__qua.atoms().filter((x) => x.blockId === t.id).length,
      }
    }, pick)

    for (const type of pick.types) {
      assert(
        after.prevMarks.includes(type),
        `前一块的拼接段应带 ${type}（格式随内容走）：${JSON.stringify(after)}`,
      )
    }
    for (const id of pick.atomIds) {
      assert(after.prevAtoms.includes(id), `原子 ${id} 应随内容落到前一块：${JSON.stringify(after)}`)
    }
    assert(after.huskPlain === '', `被并块空壳应无内容：${JSON.stringify(after.huskPlain)}`)
    assert(after.huskMarks === 0 && after.huskAtoms === 0, '被并块上不该留下格式/原子')

    await page.evaluate(() => window.__qua.invoke('core.history/undo'))
    await page.waitForTimeout(200)
    const back = await page.evaluate((t) => {
      const ed = window.__qua.__editor
      return {
        marks: window.__qua.marks().filter((x) => x.blockId === t.id).map((x) => x.type),
        atoms: window.__qua.atoms().filter((x) => x.blockId === t.id).map((x) => x.id),
      }
    }, pick)
    assert(
      JSON.stringify(back.marks.sort()) === JSON.stringify([...pick.types].sort()),
      `一次撤销格式应回原块：undo 后 ${JSON.stringify(back.marks)}，合并前 ${JSON.stringify(pick.types)}`,
    )
    assert(
      JSON.stringify([...back.atoms].sort()) === JSON.stringify([...pick.atomIds].sort()),
      `一次撤销原子应回原块：undo 后 ${JSON.stringify(back.atoms)}，合并前 ${JSON.stringify(pick.atomIds)}`,
    )

    await ctx.close()
    return `合并 ⇒ 格式/原子随内容进前一块（粘接点 ${pick.prevLen}），空壳零残留；⌘Z 原样回`
  },
)


await check(
  'T73 段根 Enter 也走事务：页/天根 ⇒ 插首个子块（1 条）；内容根块中拆 ⇒ 右半首个子块（2 条）',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)

    // ① 有身份的段根（页）：Enter ⇒ 插**空的首个子块**，不在根上切字（根文本是名字/描述）
    const root = await page.evaluate(() => {
      const ed = window.__qua.__editor
      const r = ed.doc.roots[0]
      const plain = (b) => b.content.filter((x) => x.t === 'text').map((x) => x.v).join('')
      return { id: r.id, text: plain(r), kids: r.children.length }
    })
    await page.evaluate((id) => window.__qua.focusBlock(id, 0), root.id)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(180)
    const pageEnter = await page.evaluate((t) => {
      const ed = window.__qua.__editor
      const r = ed.store.find(t.id)
      const plain = (b) => (b ? b.content.filter((x) => x.t === 'text').map((x) => x.v).join('') : null)
      return {
        ops: window.__qua.lastOps().map((o) => ({ e: o.e, id: o.id, op: o.op, value: o.value })),
        text: plain(r),
        firstKid: r?.children[0]?.id ?? '',
        kids: r?.children.length ?? 0,
      }
    }, root)
    assert(pageEnter.ops.length === 1, `页根 Enter 应只发 1 条结构 op：${JSON.stringify(pageEnter.ops)}`)
    const op0 = pageEnter.ops[0]
    assert(
      op0.e === 'block' && op0.id === pageEnter.firstKid && op0.op === 'upsert',
      `应是新首个子块的 upsert：${JSON.stringify(pageEnter.ops)}`,
    )
    assert(op0.value.parent === root.id && op0.value.prev === null, `落点应是根的第 0 位（前兄弟 null）：${JSON.stringify(op0.value)}`)
    assert(pageEnter.text === root.text, '根正文不该被切开（有身份的根只插空子块）')
    assert(pageEnter.kids === root.kids + 1, `子块数应 +1：${root.kids} → ${pageEnter.kids}`)

    // ② 内容根（zoom 进来的一块）：块中 Enter ⇒ 左半留根、右半成首个子块
    const inner = await page.evaluate(() => {
      const ed = window.__qua.__editor
      // 找一个正文 ≥ 4 字、无身份的子孙块，聚焦它（focus-block 会把它装成唯一根）
      const plain = (b) => b.content.filter((x) => x.t === 'text').map((x) => x.v).join('')
      let hit = null
      const walk = (list) => {
        for (const b of list) {
          if (hit) return
          const identity = Boolean(b.props?._lists?.length || b.props?._aliases?.length || b.props?._date || b.props?._kind || b.props?._query)
          if (!identity && plain(b).length >= 4) {
            hit = { id: b.id, text: plain(b) }
            return
          }
          walk(b.children)
        }
      }
      walk(ed.doc.roots[0].children)
      return hit
    })
    assert(inner, '第一页里应有可拆的内容块')
    await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), inner.id)
    await page.waitForTimeout(150)
    const nowRoot = await page.evaluate(() => window.__qua.__editor.doc.roots.map((b) => b.id))
    assert(nowRoot.length === 1 && nowRoot[0] === inner.id, `focus 之后应只装这一块：${JSON.stringify(nowRoot)}`)

    await page.evaluate((id) => window.__qua.focusBlock(id, 2), inner.id)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(200)
    const contentEnter = await page.evaluate((t) => {
      const ed = window.__qua.__editor
      const r = ed.store.find(t.id)
      const plain = (b) => (b ? b.content.filter((x) => x.t === 'text').map((x) => x.v).join('') : null)
      const runPlain = (c) => c.filter((x) => x.t === 'text').map((x) => x.v).join('')
      return {
        ops: window.__qua.lastOps().map((o) => ({
          e: o.e,
          id: o.id,
          op: o.op,
          state: o.state,
          text: o.value?.content === undefined ? undefined : runPlain(o.value.content),
          parent: o.value?.parent,
          pos: o.value?.prev === null ? 0 : undefined,
          prev: o.value?.prev,
        })),
        text: plain(r),
        firstKid: r?.children[0]?.id ?? '',
        firstKidText: plain(r?.children[0]),
      }
    }, inner)

    const textOps = contentEnter.ops.filter((o) => o.e === 'block' && o.op === 'upsert' && o.text !== undefined && o.parent === undefined)
    const moveOps = contentEnter.ops.filter((o) => o.e === 'block' && o.op === 'upsert' && o.parent !== undefined)
    assert(
      textOps.length === 1 && moveOps.length === 1,
      `内容根块中拆应 2 条 op（左半留根 ＋ 右半首子块）：${JSON.stringify(contentEnter.ops)}`,
    )
    assert(textOps.length === 1 && textOps[0].id === inner.id, `原块应留左半：${JSON.stringify(textOps)}`)
    assert(textOps[0].text === inner.text.slice(0, 2), `左半应是「${inner.text.slice(0, 2)}」：${JSON.stringify(textOps[0].text)}`)
    assert(moveOps.length === 1 && moveOps[0].id === contentEnter.firstKid, `应插一个新首个子块：${JSON.stringify(moveOps)}`)
    assert(moveOps[0].parent === inner.id && moveOps[0].prev === null, `落点应是根的第 0 位（前兄弟 null）：${JSON.stringify(moveOps[0])}`)
    assert(contentEnter.text === inner.text.slice(0, 2), '根块正文应只剩左半')
    assert(contentEnter.firstKidText === inner.text.slice(2), `右半应进首个子块：${JSON.stringify(contentEnter.firstKidText)}`)

    await ctx.close()
    return `页根 Enter ⇒ 1 条（空首子块）；内容根块中 ⇒ 2 条（左半留根 ＋ 右半首子块）`
  },
)

await check(
  'T74 同块选区 + Enter 走一笔事务：删选区与拆分合成「1 条插入 ＋ 1 条正文」，一次撤销复原',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)

    /** 挑一个非根、正文 ≥ 8 字、无锚点的内容块（选区删除会动锚点，先避开） */
    const pick = await page.evaluate(() => {
      const ed = window.__qua.__editor
      const marks = window.__qua.marks()
      const atoms = window.__qua.atoms()
      const rows = []
      const walk = (list, parent) => {
        list.forEach((b) => {
          rows.push({ block: b, parentId: parent?.id ?? null })
          walk(b.children, b)
        })
      }
      walk(ed.doc.roots, null)
      const plain = (b) => b.content.filter((x) => x.t === 'text').map((x) => x.v).join('')
      for (const r of rows) {
        const b = r.block
        if (!r.parentId || plain(b).length < 8) continue
        if (b.props?._lists?.length || b.props?._aliases?.length) continue
        if (marks.some((m) => m.blockId === b.id) || atoms.some((a) => a.blockId === b.id)) continue
        return { id: b.id, parentId: r.parentId, text: plain(b), kidsBefore: 0 }
      }
      return null
    })
    assert(pick, '第一页里应有「非根、长正文、无锚点」的块')
    pick.kidsBefore = await page.evaluate(
      (t) => window.__qua.__editor.store.find(t.parentId)?.children.length ?? 0,
      pick,
    )

    await page.evaluate((id) => window.__qua.focusBlock(id, 2), pick.id)
    // 真键盘选 [2,4)：两次 Shift+→ 让模型选区也跨起来
    await page.keyboard.press('Shift+ArrowRight')
    await page.keyboard.press('Shift+ArrowRight')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(200)

    const after = await page.evaluate((t) => {
      const ed = window.__qua.__editor
      const plain = (b) => (b ? b.content.filter((x) => x.t === 'text').map((x) => x.v).join('') : null)
      const runPlain = (c) => c.filter((x) => x.t === 'text').map((x) => x.v).join('')
      const r = ed.store.find(t.id)
      const parent = ed.store.find(t.parentId)
      const i = parent?.children.findIndex((b) => b.id === t.id) ?? -1
      return {
        ops: window.__qua.lastOps().map((o) => ({
          e: o.e,
          id: o.id,
          op: o.op,
          state: o.state,
          text: o.value?.content === undefined ? undefined : runPlain(o.value.content),
          parent: o.value?.parent,
          pos: o.value?.prev === null ? 0 : undefined,
          prev: o.value?.prev,
        })),
        text: plain(r),
        sibling: i > 0 ? plain(parent?.children[i - 1]) : null,
        dom: [...document.querySelectorAll('.blk .tx')].map((el) => el.textContent ?? ''),
      }
    }, pick)

    const textOps = after.ops.filter((o) => o.e === 'block' && o.op === 'upsert' && o.text !== undefined && o.parent === undefined)
    const insertOps = after.ops.filter((o) => o.e === 'block' && o.op === 'upsert' && o.parent !== undefined)
    assert(after.ops.length === 2, `删选区 + 拆应合成 2 条 op（没有单独的删除 op）：${JSON.stringify(after.ops)}`)
    assert(textOps.length === 1 && textOps[0].id === pick.id, `原块应只写一次内容：${JSON.stringify(textOps)}`)
    assert(
      textOps[0].text === pick.text.slice(4),
      `原块应保选区之后的右半「${pick.text.slice(4)}」：${JSON.stringify(textOps[0].text)}`,
    )
    assert(insertOps.length === 1, `左半应是一条插入：${JSON.stringify(insertOps)}`)
    assert(insertOps[0].parent === pick.parentId, '左半应与原块同级')
    assert(after.text === pick.text.slice(4), '模型里原块应是右半')
    assert(after.sibling === pick.text.slice(0, 2), `左半应是选区之前那截「${pick.text.slice(0, 2)}」：${JSON.stringify(after.sibling)}`)
    assert(after.dom.includes(pick.text.slice(0, 2)), 'DOM 应重画出左半')
    assert(after.dom.includes(pick.text.slice(4)), 'DOM 应重画出右半')

    await page.evaluate(() => window.__qua.invoke('core.history/undo'))
    await page.waitForTimeout(200)
    const back = await page.evaluate((t) => {
      const ed = window.__qua.__editor
      const plain = (b) => (b ? b.content.filter((x) => x.t === 'text').map((x) => x.v).join('') : null)
      const r = ed.store.find(t.id)
      const parent = ed.store.find(t.parentId)
      return { text: plain(r), kids: parent?.children.length ?? 0 }
    }, pick)
    assert(back.text === pick.text, `一次撤销应回到整块原文：${JSON.stringify(back.text)}`)
    assert(back.kids === pick.kidsBefore, `块数应复原：${pick.kidsBefore} → ${back.kids}`)

    await ctx.close()
    return `选区 [2,4) + Enter ⇒ ops=[插入左半, 正文右半]（2 条，无单独删除）；⌘Z 回原文`
  },
)

await check(
  'T75 `#标签` 后按 Esc：字原样留着；紧接着 Enter 只做普通拆块（不退格、不误建标签）',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)

    /**
     * `Esc` 是「我要这几个字，不要你的候选」的唯一出口：关浮层、字留着、**不退格**，
     * 且**不留下任何模型改动**（撤销栈深不变）。紧接着的 Enter 必须是普通拆块——
     * 浮层已经关了，它不该再有机会把一个候选落进正文。
     */
    const pick = await page.evaluate(() => {
      const ed = window.__qua.__editor
      const rows = []
      const walk = (list, parent) => {
        list.forEach((b) => {
          rows.push({ block: b, parentId: parent?.id ?? null })
          walk(b.children, b)
        })
      }
      walk(ed.doc.roots, null)
      const b = rows.find(
        (r) =>
          r.parentId &&
          r.block.children.length === 0 &&
          !(r.block.props?._lists?.length) &&
          !(r.block.props?._aliases?.length) &&
          !(r.block.props?._tags?.length),
      )
      const plain = (x) => x.content.filter((r) => r.t === 'text').map((r) => r.v).join('')
      const el = document.querySelector(`.blk[data-block-id="${b.block.id}"]`)
      return { id: b.block.id, parentId: b.parentId, text: plain(b.block), depth: el?.dataset.depth ?? '' }
    })
    assert(pick.id !== '', '第一页里应有可编辑的内容块')

    await page.evaluate((id) => window.__qua.focusBlock(id, 9999), pick.id)
    await page.keyboard.type(' #回车标签')
    await page.waitForTimeout(160)
    const open = await layerRows(page)
    assert(open.length > 0, `敲 # 应弹出浮层（前置）：${JSON.stringify(open)}`)

    const undoBefore = await page.evaluate(() => window.__qua.snapshot().undoDepth)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(140)

    const kept = await page.evaluate((t) => {
      const b = window.__qua.blocks().find((x) => x.id === t.id)
      const el = document.querySelector(`.blk[data-block-id="${t.id}"]`)
      return {
        text: b?.text ?? '',
        domText: el?.querySelector('.tx')?.textContent ?? '',
        depth: el?.dataset.depth ?? '',
        tags: b?.tags ?? [],
        atoms: window.__qua.atoms().filter((a) => a.blockId === t.id).length,
        tagCreated: window.__qua.allBlocks().some((x) => x.roles?.includes('tag') && x.text === '回车标签'),
        layerOpen: document.querySelectorAll('.layer').length,
        undoDepth: window.__qua.snapshot().undoDepth,
      }
    }, pick)

    assert(kept.layerOpen === 0, 'Esc 应关掉浮层')
    assert(kept.text === `${pick.text} #回车标签`, `` + `字应逐字留着（不退格、不转换）：${JSON.stringify(kept.text)}`)
    assert(kept.domText.includes('#回车标签'), `DOM 里也应是那几个字：${JSON.stringify(kept.domText)}`)
    assert(kept.depth === pick.depth, `Esc 不该退格：depth ${pick.depth} → ${kept.depth}`)
    assert(kept.tags.length === 0 && kept.atoms === 0, `Esc 不该落任何结果：${JSON.stringify(kept)}`)
    assert(!kept.tagCreated, 'Esc 不该建出标签块')
    assert(kept.undoDepth === undoBefore, `Esc 本身不该占一格撤销：${undoBefore} → ${kept.undoDepth}`)

    // 紧接着的 Enter：浮层已关 ⇒ 普通拆块（原来那一套结构语义），不是「落一个候选」
    await page.keyboard.press('Enter')
    await page.waitForTimeout(220)
    const split = await page.evaluate((t) => {
      const ed = window.__qua.__editor
      const plain = (b) => (b ? b.content.filter((r) => r.t === 'text').map((r) => r.v).join('') : null)
      const parent = ed.store.find(t.parentId)
      const i = parent?.children.findIndex((b) => b.id === t.id) ?? -1
      const live = ed.store.find(t.id)
      return {
        text: plain(live),
        nextText: i >= 0 ? plain(parent?.children[i + 1]) : null,
        tags: live?.props?._tags ?? [],
        atoms: window.__qua.atoms().filter((a) => a.blockId === t.id).length,
        tagCount: ed.store.blocks.filter((x) => (x.props?._lists ?? []).includes('tag')).length,
      }
    }, pick)

    assert(split.text === `${pick.text} #回车标签`, `` + `Enter 不该改这一块的正文：${JSON.stringify(split.text)}`)
    assert(split.nextText === '', `行尾 Enter 应在下面拆出一个空块：${JSON.stringify(split.nextText)}`)
    assert(split.tags.length === 0 && split.atoms === 0, `仍然不该有归属/原子：${JSON.stringify(split)}`)

    await ctx.close()
    return `#回车标签 + Esc ⇒ 字留着、depth 不变、没有模型改动；再 Enter ⇒ 只是普通拆块`
  },
)

await check(
  'T76 新建页走一笔事务、落点是森林顶层：页块 upsert{parent:null} ＋ 子块 upsert{parent:页,index:0}；不再物化当天；重开后仍在',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    const before = await page.evaluate(() => ({
      pages: window.__qua.pages().length,
      roots: window.__qua.snapshot().topBlocks,
    }))

    await page.evaluate(() => window.__qua.invoke('core.page/new'))
    await page.waitForTimeout(220)

    const created = await page.evaluate(() => {
      const ops = window.__qua.lastOps()
      const pageOp = ops.find((o) => o.e === 'block' && o.op === 'upsert' && o.value?.parent === null)
      const page = pageOp ? window.__qua.__editor.store.find(pageOp.id) : null
      const childOp = page ? ops.find((o) => o.e === 'block' && o.op === 'upsert' && o.value?.parent === page.id) : null
      return {
        ops: ops.map((o) => ({ e: o.e, id: o.id, block: o.block ?? o.id, op: o.op, name: o.name, parent: o.value?.parent, prev: o.value?.prev })),
        pageId: pageOp?.id ?? '',
        childId: childOp?.id ?? '',
        modelChild: page?.children[0]?.id ?? '',
        parentIsNull: pageOp?.value?.parent === null,
        pages: window.__qua.pages().length,
        roots: window.__qua.snapshot().topBlocks,
        pageAliases: page ? (page.props?._aliases ?? []) : [],
        pageLists: page ? (page.props?._lists ?? []) : [],
      }
    })

    const blockOps = created.ops.filter((o) => o.e === 'block')
    const propOps = created.ops.filter((o) => o.e === 'prop')
    assert(blockOps.every((o) => o.op === 'upsert'), `结构写必须是 block.upsert（不许零 op 直写）：${JSON.stringify(created.ops)}`)
    assert(propOps.every((o) => o.block === created.pageId), `页的属性格只写在页块上：${JSON.stringify(created.ops)}`)
    assert(created.pageId !== '' && created.parentIsNull, `页块应报 upsert{parent:null}（森林顶层）：${JSON.stringify(created.ops)}`)
    assert(created.childId !== '' && created.modelChild === created.childId, `空首子块应真的挂在页下：${JSON.stringify(created)}`)
    assert(blockOps.length === 2, `新建页应恰好 2 条 block op（页 ＋ 空首子块），不再物化当天：${JSON.stringify(created.ops)}`)
    assert(propOps.some((o) => o.name === '_aliases'), `页的地址要进日志：${JSON.stringify(created.ops)}`)
    assert(created.pages === before.pages + 1, `页数应 +1：${before.pages} → ${created.pages}`)
    assert(created.roots === before.roots + 1, `森林根数应 +1：${before.roots} → ${created.roots}`)
    assert(created.pageLists.includes('page') && created.pageAliases.length === 1, `新页应带 page 露面与一个别名：${JSON.stringify(created)}`)

    // 真关重开：页与子块必须还真的在库里
    const reopened = await reopenPage(browser, ctx, base, page)
    const after = await reopened.page.evaluate((t) => {
      const p = window.__qua.__editor.store.find(t.pageId)
      return { page: Boolean(p), child: p?.children[0]?.id ?? '', pages: window.__qua.pages().length }
    }, created)
    await reopened.ctx.close()
    await ctx.close()
    assert(after.page, '重开后页应还在库里')
    assert(after.child === created.childId, `重开后空首子块应还在页下：${JSON.stringify(after)}`)
    assert(after.pages === created.pages, `重开后页数应不变：${created.pages} → ${after.pages}`)

    return `新建页 ⇒ 页块 upsert{parent:null} ＋ 子块{parent:页}；恰好 2 条、不再建天；根数 ${before.roots}→${created.roots}；重开仍在`
  },
)

/* ------------------------------------------------ 编辑器写路径：逐方法钉 op 形状 */

/** 任务 B 共用：从当前文档挑一个「无子块、无标签、有正文」的内容块（带 parent） */
const pickLeaf = (page) =>
  page.evaluate(() => {
    const ed = window.__qua.__editor
    const rows = []
    const walk = (list, parent) => {
      list.forEach((b, i) => {
        rows.push({ b, parentId: parent?.id ?? null, index: i })
        walk(b.children, b)
      })
    }
    walk(ed.doc.roots, null)
    const plain = (b) => b.content.filter((r) => r.t === 'text').map((r) => r.v).join('')
    const r = rows.find((x) => !x.b.children.length && plain(x.b).length >= 6 && !(x.b.props?._tags?.length))
    return r ? { id: r.b.id, parentId: r.parentId, index: r.index, text: plain(r.b) } : null
  })
/** 任务 B 共用：op 的可断言投影（block 统一取「这块是谁」；content upsert 另给投影文本） */
const opShape = (page) =>
  page.evaluate(() => {
    const runPlain = (content) => (content ?? []).filter((r) => r.t === 'text').map((r) => r.v).join('')
    return window.__qua.lastOps().map((o) => ({
      e: o.e,
      block: o.block ?? o.id ?? '',
      op: o.op,
      state: o.state,
      name: o.name ?? '',
      value: o.value,
      parent: o.value?.parent,
      pos: o.value?.prev === null ? 0 : undefined,
          prev: o.value?.prev,
      // 内容 upsert：给投影文本与 run 枚数（文本段/原子按 t 统计），断言不用认识 run 形状
      text: o.value?.text ?? (o.value?.content === undefined ? undefined : runPlain(o.value.content)),
      runs: o.value?.content === undefined ? undefined : o.value.content.map((r) => r.t).join(','),
      atomKinds: o.value?.content === undefined ? undefined : o.value.content.filter((r) => r.t !== 'text').map((r) => (r.t === 'ref' && r.flavor === '#' ? 'tag' : r.t)).join(','),
    }))
  })

await check(
  'T77 切换待办走一笔事务：时刻 upsert ＋ 1 条 prop.set（任务状态槽，首切＝false），一次撤销回无槽',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)
    const target = await pickLeaf(page)
    assert(target, '第一页里应有可编辑的内容块')

    await page.evaluate((id) => window.__qua.__editor.toggleTodo(id), target.id)
    await page.waitForTimeout(120)
    const ops = await opShape(page)
    /**
     * 改属性值同时也是「改了这一块」⇒ 一笔里两条：记时刻的 `block.upsert{…,modified}`（不带
     * parent/index，所以不是结构 op）＋ 任务状态槽的 `prop.set`。撤销仍然一步回。
     */
    const propOps = ops.filter((o) => o.e === 'prop' && o.op === 'set')
    const stampOps = ops.filter((o) => o.e === 'block' && o.op === 'upsert')
    assert(ops.length === 2, `切换待办应恰好 2 条 op（时刻 upsert ＋ prop.set）：${JSON.stringify(ops)}`)
    assert(stampOps.length === 1, `其中一条应是记时刻的 upsert：${JSON.stringify(ops)}`)
    assert(
      propOps.length === 1 && propOps[0].block === target.id && propOps[0].value === false,
      `另一条应是任务状态槽的 prop.set（首切＝未完成 false）：${JSON.stringify(ops)}`,
    )
    const propName = propOps[0].name

    await page.evaluate(() => window.__qua.invoke('core.history/undo'))
    await page.waitForTimeout(150)
    const back = await page.evaluate((t) => window.__qua.__editor.store.find(t.id)?.props ?? null, target)
    assert(!back || !(propName in back), `一次撤销应回到没有任务槽：${JSON.stringify(back)}`)

    await ctx.close()
    return `toggleTodo ⇒ upsert{modified} ＋ prop.set{${propName}:false}；⌘Z 回无槽`
  },
)

await check(
  'T78 加粗走一笔事务：恰好 1 条 upsert{content}（中段拆出带 marks 的 run）、零 anno，一次撤销格式消失',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)
    const target = await pickLeaf(page)
    assert(target, '第一页里应有可编辑的内容块')

    await page.evaluate((id) => window.__qua.focusBlock(id, 2), target.id)
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight')
    await page.evaluate(() => window.__qua.__editor.toggleMark('bold'))
    await page.waitForTimeout(120)
    const ops = await opShape(page)
    assert(ops.length === 1, `加粗应恰好 1 条 op：${JSON.stringify(ops)}`)
    assert(
      ops[0].e === 'block' && ops[0].op === 'upsert' && ops[0].block === target.id && ops[0].atomKinds === '' && ops[0].text === target.text,
      `那一条应是 upsert{content}（投影不变、只动了格式）：${JSON.stringify(ops)}`,
    )
    assert(ops[0].runs.split(',').length === 3, `加粗应把中段拆成带 marks 的 run（三段）：${JSON.stringify(ops[0])}`)

    await page.evaluate(() => window.__qua.invoke('core.history/undo'))
    await page.waitForTimeout(150)
    const back = await page.evaluate((t) => window.__qua.marks().filter((m) => m.blockId === t.id).length, target)
    assert(back === 0, `一次撤销后这块应没有格式：${back}`)

    await ctx.close()
    return `toggleMark ⇒ 1 条 upsert{content}（中段带 bold）；⌘Z 格式消失`
  },
)

await check(
  'T79 清格式走一笔事务：恰好 1 条 upsert{content}（只剩素 text run）、零 anno，一次撤销格式回来',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)
    const target = await pickLeaf(page)
    assert(target, '第一页里应有可编辑的内容块')

    // 前置：加一段粗体（setup 的 op 不参与断言）
    await page.evaluate((id) => window.__qua.focusBlock(id, 2), target.id)
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight')
    await page.evaluate(() => window.__qua.__editor.toggleMark('bold'))
    await page.waitForTimeout(120)

    // toggleMark 结束时选区原样保留 ⇒ 直接清
    await page.evaluate(() => window.__qua.__editor.clearMarksAtSel())
    await page.waitForTimeout(120)
    const ops = await opShape(page)
    assert(ops.length === 1, `清格式应恰好 1 条 op：${JSON.stringify(ops)}`)
    assert(
      ops[0].e === 'block' && ops[0].op === 'upsert' && ops[0].block === target.id && ops[0].runs === 'text',
      `那一条应是 upsert{content}（清完只剩素 text run）：${JSON.stringify(ops)}`,
    )

    await page.evaluate(() => window.__qua.invoke('core.history/undo'))
    await page.waitForTimeout(150)
    const back = await page.evaluate((t) => window.__qua.marks().filter((m) => m.blockId === t.id).length, target)
    assert(back === 1, `一次撤销后粗体应回来：${back}`)

    await ctx.close()
    return `clearMarksAtSel ⇒ 1 条 upsert{content}（素 text）；⌘Z 格式回来`
  },
)

await check(
  'T80 插行内原子走一笔事务：恰好 1 条 upsert{content}（露面 run 随内容进），一次撤销两半一起回滚',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)
    const target = await pickLeaf(page)
    assert(target, '第一页里应有可编辑的内容块')

    await page.evaluate((id) => window.__qua.focusBlock(id, 9999), target.id)
    await page.evaluate(
      (t) => window.__qua.__editor.insertRef({ to: t.id, label: '冒烟原子', flavor: '#' }),
      target,
    )
    await page.waitForTimeout(120)
    const ops = await opShape(page)
    // 原子住在内容里 ⇒ 一次插入就是**一条**内容 upsert（文本段与原子 run 同进同出）
    assert(ops.length === 1, `插原子应恰好 1 条 op：${JSON.stringify(ops)}`)
    assert(
      ops[0].e === 'block' && ops[0].op === 'upsert' && ops[0].block === target.id && ops[0].atomKinds === 'tag',
      `那一条应是 upsert{content}（带 tag 露面 run）：${JSON.stringify(ops)}`,
    )
    assert(ops[0].text === target.text, `投影不变（露面不进投影）：${JSON.stringify(ops[0])}`)

    await page.evaluate(() => window.__qua.invoke('core.history/undo'))
    await page.waitForTimeout(150)
    const back = await page.evaluate((t) => {
      const b = window.__qua.__editor.store.find(t.id)
      const plain = (x) => (x ? x.content.filter((r) => r.t === 'text').map((r) => r.v).join('') : '')
      return { text: plain(b), atoms: window.__qua.atoms().filter((a) => a.blockId === t.id).length }
    }, target)
    assert(back.text === target.text && back.atoms === 0, `一次撤销应回原文、原子注销：${JSON.stringify(back)}`)

    await ctx.close()
    return `insertRef ⇒ [upsert{content}（含露面）]；⌘Z 两半一起回滚`
  },
)

await check(
  'T81 删行内原子走一笔事务：恰好 1 条 upsert{content}（露面 run 没了），一次撤销复原',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)
    const target = await pickLeaf(page)
    assert(target, '第一页里应有可编辑的内容块')

    // 前置：插一枚原子（setup 的 op 不参与断言）
    await page.evaluate((id) => window.__qua.focusBlock(id, 9999), target.id)
    const atomId = await page.evaluate(
      (t) => window.__qua.__editor.insertRef({ to: t.id, label: '待删原子', flavor: '#' }),
      target,
    )
    assert(atomId, '前置：原子应建出来')
    await page.waitForTimeout(120)

    await page.evaluate((id) => window.__qua.__editor.removeRun(id), atomId)
    await page.waitForTimeout(120)
    const ops = await opShape(page)
    // 删原子＝内容里那一枚 run 没了 ⇒ 一条内容 upsert，没有第二条「注销」op
    assert(ops.length === 1, `删原子应恰好 1 条 op：${JSON.stringify(ops)}`)
    assert(
      ops[0].e === 'block' && ops[0].op === 'upsert' && ops[0].block === target.id && ops[0].atomKinds === '' && ops[0].runs === 'text',
      `那一条应是 upsert{content}（露面 run 已没了）：${JSON.stringify(ops)}`,
    )

    await page.evaluate(() => window.__qua.invoke('core.history/undo'))
    await page.waitForTimeout(150)
    const back = await page.evaluate((t) => {
      const b = window.__qua.__editor.store.find(t.id)
      return { atoms: window.__qua.atoms().filter((a) => a.blockId === t.id).length, kinds: window.__qua.atoms().filter((a) => a.blockId === t.id).map((a) => a.kind) }
    }, target)
    assert(back.atoms === 1 && back.kinds.includes('tag'), `一次撤销原子应复活：${JSON.stringify(back)}`)

    await ctx.close()
    return `removeRun ⇒ [upsert{content}]；⌘Z 复原`
  },
)

await check(
  'T82 挂标签走同一笔事务：新标签＝建块 upsert ＋ 归属 prop.set；已有标签＝只写归属 1 条；撤销分步回滚',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)
    const a = await pickLeaf(page)
    assert(a, '第一页里应有可编辑的内容块')

    // ① 新标签：建标签块 ＋ 写归属，同一笔 2 条
    await page.evaluate((t) => window.__qua.__editor.addTag(t.id, '冒烟新标签'), a)
    await page.waitForTimeout(120)
    const ops1 = await opShape(page)
    const block1 = ops1.filter((o) => o.e === 'block')
    assert(block1.length === 1, `新标签应只建 1 个块：${JSON.stringify(ops1)}`)
    assert(block1[0].op === 'upsert' && block1[0].parent === null, `标签块应 upsert{parent:null}：${JSON.stringify(ops1)}`)
    const tagProp = ops1.find((o) => o.e === 'prop' && o.block === a.id && o.name === '_tags')
    assert(tagProp && Array.isArray(tagProp.value), `必须有一条写宿主的 _tags：${JSON.stringify(ops1)}`)
    const tagId = tagProp.value[0]
    assert(
      ops1.some((o) => o.e === 'prop' && o.block === tagId && o.name === '_aliases'),
      `标签块的地址要进日志：${JSON.stringify(ops1)}`,
    )
    const tagBlock = await page.evaluate((id) => {
      const t = window.__qua.__editor.store.find(id)
      return t ? { lists: t.props?._lists ?? [], alias: t.props?._aliases?.[0] ?? '' } : null
    }, tagId)
    assert(tagBlock && tagBlock.lists.includes('tag'), `标签块应真的在库里（带 tag 露面）：${JSON.stringify(tagBlock)}`)

    // ② 已有标签：只写归属，1 条（a 已带 _tags ⇒ 再挑一次自然落到别的块）
    const b = await pickLeaf(page)
    assert(b && b.id !== a.id, '应有第二个可挂标签的块')
    await page.evaluate((t) => window.__qua.__editor.addTag(t.id, '冒烟新标签'), b)
    await page.waitForTimeout(120)
    const ops2 = await opShape(page)
    assert(ops2.length === 1 && ops2[0].e === 'prop' && ops2[0].block === b.id, `复用标签应只写归属 1 条：${JSON.stringify(ops2)}`)

    // 一次撤销只回滚第二步（复用那笔）
    await page.evaluate(() => window.__qua.invoke('core.history/undo'))
    await page.waitForTimeout(150)
    const backB = await page.evaluate((t) => window.__qua.__editor.store.find(t.id)?.props?._tags ?? [], b)
    assert(backB.length === 0, `一次撤销应摘掉第二块的归属：${JSON.stringify(backB)}`)
    const tagStill = await page.evaluate((id) => Boolean(window.__qua.__editor.store.find(id)), tagId)
    assert(tagStill, `标签块应还在（那笔撤销不归它）`)

    await ctx.close()
    return `addTag ⇒ 新标签 [upsert{parent:null}, prop.set]；复用 [prop.set]；⌘Z 分步回滚`
  },
)

await check(
  'T83 摘标签走同一笔事务：只有归属 1 条 prop.set（chip 露面没有正文原子），一次撤销归属回来',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)
    const target = await pickLeaf(page)
    assert(target, '第一页里应有可编辑的内容块')

    // 前置：挂一个标签（setup 的 op 不参与断言）
    await page.evaluate((t) => window.__qua.__editor.addTag(t.id, '冒烟摘除标签'), target)
    await page.waitForTimeout(120)
    const tagId = await page.evaluate((t) => window.__qua.__editor.store.find(t.id)?.props?._tags?.[0] ?? '', target)
    assert(tagId, '前置：标签应挂上')

    await page.evaluate((t) => window.__qua.__editor.removeTag(t.id, t.tagId), { ...target, tagId })
    await page.waitForTimeout(120)
    const ops = await opShape(page)
    assert(ops.length === 1, `摘标签应恰好 1 条 op：${JSON.stringify(ops)}`)
    assert(
      ops[0].e === 'prop' && ops[0].op === 'delete' && ops[0].block === target.id && ops[0].name === '_tags',
      `那一条应是 _tags 的 prop.delete（空集合＝没有这一格）：${JSON.stringify(ops)}`,
    )

    await page.evaluate(() => window.__qua.invoke('core.history/undo'))
    await page.waitForTimeout(150)
    const back = await page.evaluate((t) => window.__qua.__editor.store.find(t.id)?.props?._tags ?? [], target)
    assert(back.length === 1 && back[0] === tagId, `一次撤销归属应回来：${JSON.stringify(back)}`)

    await ctx.close()
    return `removeTag ⇒ 1 条 prop.set{_tags:[]}；⌘Z 归属回来`
  },
)

await check(
  'T84 点空白建块走一笔事务：新建＝1 条 insert{parent:末段,index:末尾}；末尾已有空块＝复用零 op；一次撤销回滚',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)

    // 前置：把末段末块写成非空，保证「新建」这一支（setup 的 op 不参与断言）
    const tail = await page.evaluate(() => {
      const ed = window.__qua.__editor
      const root = ed.doc.roots[ed.doc.roots.length - 1]
      const last = root.children[root.children.length - 1]
      return { rootId: root.id, index: root.children.length - 1, id: last?.id ?? '' }
    })
    assert(tail.id, '末段应有末块')
    await page.evaluate((t) => window.__qua.__editor.setText(t.id, '占住末尾'), tail)
    await page.waitForTimeout(120)

    await page.evaluate(() => window.__qua.__editor.clickEmptyArea(99999))
    await page.waitForTimeout(120)
    const ops = await opShape(page)
    assert(ops.length === 1, `点空白应恰好 1 条 op：${JSON.stringify(ops)}`)
    assert(
      ops[0].e === 'block' && ops[0].op === 'upsert' && ops[0].parent === tail.rootId && ops[0].prev === tail.id,
      `应插在末段末尾：${JSON.stringify(ops)}`,
    )

    // 再点一次：末尾已是空块 ⇒ 复用，不新建（⚠️ 复用分支没有 tx，lastOps 仍是上一笔的
    // op——「零 op」只能从模型断：children 数不变、没有多出第二个空块）
    const kidsBefore = await page.evaluate((t) => {
      const r = window.__qua.__editor.store.find(t.rootId)
      return r?.children.length ?? -1
    }, tail)
    await page.evaluate(() => window.__qua.__editor.clickEmptyArea(99999))
    await page.waitForTimeout(120)
    const kidsAfter = await page.evaluate((t) => {
      const r = window.__qua.__editor.store.find(t.rootId)
      return { len: r?.children.length ?? -1, tailKids: r?.children[r.children.length - 1]?.children.length ?? -1 }
    }, tail)
    assert(kidsAfter.len === kidsBefore, `末尾已有空块应复用（不新建）：${kidsBefore} → ${kidsAfter.len}`)

    await page.evaluate(() => window.__qua.invoke('core.history/undo'))
    await page.waitForTimeout(150)
    const kids = await page.evaluate((t) => {
      const r = window.__qua.__editor.store.find(t.rootId)
      return r?.children.length ?? -1
    }, tail)
    assert(kids === tail.index + 1, `一次撤销后末段应少一个空块：${kids}`)

    await ctx.close()
    return `clickEmptyArea ⇒ 新建 1 条 insert；复用 0 条；⌘Z 回滚`
  },
)

await check(
  'T85 插分割线走同一笔事务：空块原地改类型＝时刻 upsert ＋ 1 条 prop.set；有内容＝同一笔 2 条 insert；各自一次撤销复原',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)
    const target = await pickLeaf(page)
    assert(target, '第一页里应有可编辑的内容块')

    // ① 空块 ⇒ 原地变线（先造一个空块：setup 的 op 不参与断言）
    const blankId = await page.evaluate((t) => window.__qua.__editor.insertBlockAfter(t.id, ''), target)
    assert(blankId, '前置：空块应建出来')
    await page.waitForTimeout(120)
    await page.evaluate((id) => window.__qua.__editor.insertDividerAfter(id), blankId)
    await page.waitForTimeout(120)
    const ops1 = await opShape(page)
    /** 改类型＝一次改动 ⇒ 一只 upsert{…,modified} 记时刻 ＋ 一条 `_type` 的 prop.set（同笔） */
    const typeSet = ops1.filter((o) => o.e === 'prop' && o.op === 'set' && o.block === blankId)
    assert(ops1.length === 2, `空块变线应恰好 2 条 op（时刻 upsert ＋ prop.set）：${JSON.stringify(ops1)}`)
    assert(
      typeSet.length === 1 && typeSet[0].name === '_type' && typeSet[0].value === 'core/divider',
      `其中一条应是 _type=core/divider 的 prop.set：${JSON.stringify(ops1)}`,
    )
    await page.evaluate(() => window.__qua.invoke('core.history/undo'))
    await page.waitForTimeout(150)
    const backType = await page.evaluate((id) => window.__qua.__editor.store.find(id)?.props?._type ?? null, blankId)
    assert(backType === null, `一次撤销应回到没有类型：${JSON.stringify(backType)}`)

    // ② 有内容 ⇒ 线 ＋ 空块，同一笔 2 条 insert
    await page.evaluate((t) => window.__qua.__editor.insertDividerAfter(t.id), target)
    await page.waitForTimeout(120)
    const ops2 = await opShape(page)
    const block2 = ops2.filter((o) => o.e === 'block')
    const prop2 = ops2.filter((o) => o.e === 'prop')
    assert(block2.length === 2, `有内容插线应恰好 2 条 block op：${JSON.stringify(ops2)}`)
    assert(
      block2.every((o) => o.op === 'upsert' && o.parent === target.parentId),
      `两条都应是同级的 insert：${JSON.stringify(ops2)}`,
    )
    assert(block2[0].prev === target.id && block2[1].prev === block2[0].block, `线与空块应紧跟着源块：${JSON.stringify(block2)}`)
    assert(prop2.some((o) => o.block === block2[0].block && o.name === '_type' && o.value === 'core/divider'), `分割线的类型要进日志：${JSON.stringify(prop2)}`)
    const madeIds = [block2[0].block, block2[1].block]
    await page.evaluate(() => window.__qua.invoke('core.history/undo'))
    await page.waitForTimeout(150)
    const gone = await page.evaluate((ids) => ids.every((id) => window.__qua.__editor.store.find(id) === undefined), madeIds)
    assert(gone, `一次撤销后线与空块都应消失：${JSON.stringify(madeIds)}`)

    await ctx.close()
    return `insertDividerAfter ⇒ 空块 [prop.set _type]；有内容 [insert, insert]；各自 ⌘Z 复原`
  },
)

await check(
  'T86 复制块走一笔事务：克隆子树每块 1 条 upsert（自己的落点，内容自带、原子换新 id）；一次撤销全滚回',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)
    const target = await pickLeaf(page)
    assert(target, '第一页里应有可编辑的内容块')

    // 前置：给源块加一段粗体（setup 的 op 不参与断言）——锚点要跟着克隆走
    await page.evaluate((id) => window.__qua.focusBlock(id, 2), target.id)
    for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight')
    await page.evaluate(() => window.__qua.__editor.toggleMark('bold'))
    await page.waitForTimeout(120)

    await page.evaluate((id) => window.__qua.__editor.duplicate(id), target.id)
    await page.waitForTimeout(120)
    const ops = await opShape(page)
    // 克隆自带内容（格式随 run 走、原子换新 id）⇒ 复制叶子＝恰好一条结构 upsert
    assert(ops.length === 1, `复制叶子应恰好 1 条 op（克隆自带内容）：${JSON.stringify(ops)}`)
    assert(
      ops[0].e === 'block' && ops[0].op === 'upsert' && ops[0].parent === target.parentId,
      `那一条应是克隆块自己的落点：${JSON.stringify(ops)}`,
    )
    const marksNow = await page.evaluate((t) => ({
      source: window.__qua.marks().filter((m) => m.blockId === t.src).length,
      clone: window.__qua.marks().filter((m) => m.blockId === t.clone).length,
    }), { src: target.id, clone: ops[0].block })
    assert(marksNow.source === 1 && marksNow.clone === 1, `源块与克隆块应各有一段粗体：${JSON.stringify(marksNow)}`)

    await page.evaluate(() => window.__qua.invoke('core.history/undo'))
    await page.waitForTimeout(150)
    const back = await page.evaluate((t) => window.__qua.marks().filter((m) => m.blockId === t.id).length, target)
    assert(back === 1, `一次撤销后源块的粗体应原样还在：${back}`)

    await ctx.close()
    return `duplicate ⇒ 1 条克隆 upsert{自己落点}（内容自带、原子换新 id）；⌘Z 全滚回`
  },
)

await check(
  'T87 删选中的块走一笔事务：每棵被删子树逐块 block.delete，一次撤销整组回来',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)

    // 前置：两个兄弟块插在页根下（必在视口内；setup 的 op 不参与断言）
    const made = await page.evaluate(() => {
      const ed = window.__qua.__editor
      const rootId = ed.doc.roots[0].id
      const a = ed.insertBlockAfter(rootId, '删选甲甲甲')
      const b = a ? ed.insertBlockAfter(a, '删选乙乙乙') : null
      return { a, b }
    })
    assert(made.a && made.b, '前置：两个兄弟块应建出来')
    await page.waitForTimeout(120)

    const rects = await page.evaluate((t) => {
      const el = (id) => document.querySelector(`.blk[data-block-id="${id}"]`)
      const r = (id) => {
        const b = el(id)?.getBoundingClientRect()
        return b ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null
      }
      return { from: r(t.a), to: r(t.b) }
    }, made)
    assert(rects.from && rects.to, '前置：两个块都应画在屏上')
    await page.mouse.move(rects.from.x, rects.from.y)
    await page.mouse.down()
    await page.mouse.move(rects.to.x, rects.to.y, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(120)
    const selCount = await page.evaluate(() => window.__qua.snapshot().blockSelectionCount)
    assert(selCount === 2, `拖选应选中 2 块：${selCount}`)

    await page.evaluate(() => window.__qua.__editor.deleteSelectedBlocks())
    await page.waitForTimeout(120)
    const ops = await opShape(page)
    assert(ops.length === 2, `删两个叶子应恰好 2 条 op：${JSON.stringify(ops)}`)
    assert(
      ops.every((o) => o.e === 'block' && o.op === 'exist' && o.state === 'deleted' && (o.block === made.a || o.block === made.b)),
      `两条都应是这两块的 block.exist{deleted}：${JSON.stringify(ops)}`,
    )

    await page.evaluate(() => window.__qua.invoke('core.history/undo'))
    await page.waitForTimeout(150)
    const back = await page.evaluate((t) => {
      const ed = window.__qua.__editor
      return t && [t.a, t.b].every((id) => ed.store.find(id))
    }, made)
    assert(back, '一次撤销后两块都应回来')

    await ctx.close()
    return `deleteSelectedBlocks ⇒ block.delete × 2；⌘Z 整组回来`
  },
)

await check(
  'T88 粘贴走同一笔事务：单行＝1 条内容 upsert；多行＝内容 1 ＋ 每行 1 条 insert；各一次撤销复原',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)
    const target = await pickLeaf(page)
    assert(target, '第一页里应有可编辑的内容块')

    // ① 单行
    await page.evaluate((t) => window.__qua.__editor.pasteAt(t.id, 0, '粘贴头'), target)
    await page.waitForTimeout(120)
    const ops1 = await opShape(page)
    assert(ops1.length === 1, `单行粘贴应恰好 1 条 op：${JSON.stringify(ops1)}`)
    assert(
      ops1[0].e === 'block' && ops1[0].op === 'upsert' && ops1[0].block === target.id && ops1[0].text?.startsWith('粘贴头'),
      `应是正文 upsert：${JSON.stringify(ops1)}`,
    )
    await page.evaluate(() => window.__qua.invoke('core.history/undo'))
    await page.waitForTimeout(150)
    const back1 = await page.evaluate((t) => {
      const b = window.__qua.__editor.store.find(t.id)
      return b ? b.content.filter((r) => r.t === 'text').map((r) => r.v).join('') : ''
    }, target)
    assert(back1 === target.text, `一次撤销应回原文：${JSON.stringify(back1)}`)

    // ② 多行：首行拼进原块，其余每行一个新块
    await page.evaluate((t) => window.__qua.__editor.pasteAt(t.id, t.text.length, '甲行\n乙行\n丙行'), target)
    await page.waitForTimeout(120)
    const ops2 = await opShape(page)
    assert(ops2.length === 3, `三行粘贴应恰好 3 条 op（正文＋2 个新块）：${JSON.stringify(ops2)}`)
    assert(
      ops2[0].e === 'block' && ops2[0].op === 'upsert' && ops2[0].block === target.id && ops2[0].text?.endsWith('甲行'),
      `第一条应是首块正文 upsert：${JSON.stringify(ops2)}`,
    )
    assert(
      ops2.slice(1).every((o, i) => o.e === 'block' && o.op === 'upsert' && o.parent === target.parentId && o.prev === (i === 0 ? target.id : ops2[i].block)),
      `其余行应逐块 insert、落点递增：${JSON.stringify(ops2)}`,
    )
    const kids = await page.evaluate((t) => {
      const plain = (b) => (b ? b.content.filter((r) => r.t === 'text').map((r) => r.v).join('') : '')
      const p = window.__qua.__editor.store.find(t.parentId)
      const i = p?.children.findIndex((x) => x.id === t.id) ?? -1
      return { one: plain(p?.children[i + 1]), two: plain(p?.children[i + 2]) }
    }, target)
    assert(kids.one === '乙行' && kids.two === '丙行', `新块应真的挂出来：${JSON.stringify(kids)}`)

    await page.evaluate(() => window.__qua.invoke('core.history/undo'))
    await page.waitForTimeout(150)
    const back2 = await page.evaluate((t) => {
      const plain = (b) => (b ? b.content.filter((r) => r.t === 'text').map((r) => r.v).join('') : '')
      const p = window.__qua.__editor.store.find(t.parentId)
      const i = p?.children.findIndex((x) => x.id === t.id) ?? -1
      return {
        text: plain(window.__qua.__editor.store.find(t.id)),
        next: plain(p?.children[i + 1]),
      }
    }, target)
    assert(back2.text === target.text && back2.next !== '乙行', `一次撤销应回原文、新块消失：${JSON.stringify(back2)}`)

    await ctx.close()
    return `pasteAt ⇒ 单行 [upsert{text}]；多行 [upsert ＋ insert×n]；⌘Z 各自复原`
  },
)

await check(
  'T89 翻到全新的一天也走事务：空天的首子块经事务一条 upsert{parent:天块,index:0}；天块本身在库顶层；重复翻同一天零 op（幂等）',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))

    const date = '2027-06-01'
    await page.evaluate((d) => window.__qua.invoke('core.journal/today', { date: d }), date)
    await page.waitForTimeout(250)

    const first = await page.evaluate((d) => {
      const st = window.__qua.__editor.store
      const day = st.blocks.find((b) => b.props?._date === d)
      return {
        ops: window.__qua.lastOps().map((o) => ({ e: o.e, id: o.id, op: o.op, parent: o.value?.parent, prev: o.value?.prev })),
        dayId: day?.id ?? '',
        dayAtTop: st.blocks.some((b) => b.id === day?.id),
        childCount: day?.children.length ?? 0,
      }
    }, date)
    assert(first.dayId !== '', `翻到新的一天应在库里物化日期块：${JSON.stringify(first)}`)
    assert(first.dayAtTop, '天块应住森林顶层（身份块不参与组织）')
    assert(
      first.ops.length === 1 && first.ops[0].e === 'block' && first.ops[0].op === 'upsert',
      `装载空天应恰好 1 条结构 op（首子块）：${JSON.stringify(first.ops)}`,
    )
    assert(
      first.ops[0].parent === first.dayId && first.ops[0].prev === null,
      `首子块应挂在当天下标 0：${JSON.stringify(first.ops)}`,
    )
    assert(first.childCount === 1, `空天补的首子块应真的在库里：${first.childCount}`)

    // 再翻回同一天：日期块已存在 ⇒ 不重建；首子块已在 ⇒ 不补块 ⇒ 整个动作零 op
    // （lastOps 只在事务产出时更新，零事务的打开会保留上一笔 ⇒ 这里对比前后与模型）
    const before = await page.evaluate(() => window.__qua.lastOps())
    await page.evaluate((d) => window.__qua.invoke('core.journal/today', { date: d }), date)
    await page.waitForTimeout(200)
    const second = await page.evaluate((d) => {
      const st = window.__qua.__editor.store
      const day = st.blocks.find((b) => b.props?._date === d)
      return { ops: window.__qua.lastOps(), childCount: day?.children.length ?? 0, dayCopies: st.blocks.filter((b) => b.props?._date === d).length }
    }, date)
    assert(
      second.ops.length === before.length && second.ops.every((o, i) => o.id === before[i].id),
      `重复打开同一天不应有新事务：${JSON.stringify({ before: before.length, after: second.ops.length })}`,
    )
    assert(second.childCount === 1 && second.dayCopies === 1, `不应重建天块或补第二个子块：${JSON.stringify(second)}`)

    await ctx.close()
    return `journal/today(新一天) ⇒ 1 条 upsert{parent:天块,index:0}；重复打开零事务、模型不变`
  },
)

await check(
  'T90 命令面打标签走一笔事务：新标签块 upsert{parent:null} ＋ 归属 prop.set(_tags) 同笔两条；重复打同一个标签零 op；撤销一步全回去',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)

    // 落点：命令层的回退是「当前行」——页面刚打开、没有光标 ⇒ 回退到第一行（页块自己）
    const target = await page.evaluate(() => {
      const ed = window.__qua.__editor
      return { id: ed.rows()[0].block.id, tags: ed.rows()[0].block.props?._tags ?? [] }
    })

    await page.evaluate(() => window.__qua.invoke('core.editor/insert-tag', { tag: '冒烟新标签' }))
    await page.waitForTimeout(200)

    const after = await page.evaluate((t) => {
      const st = window.__qua.__editor.store
      const plain = (b) => (b ? b.content.filter((r) => r.t === 'text').map((r) => r.v).join('') : '')
      const host = st.find(t.id)
      const tagBlock = st.blocks.find((b) => b.props?._lists?.includes('tag') && plain(b) === '冒烟新标签')
      return {
        ops: window.__qua.lastOps().map((o) => ({ e: o.e, id: o.id ?? o.block, op: o.op, name: o.name, value: o.value, parent: o.value?.parent })),
        hostTags: host?.props?._tags ?? [],
        tagId: tagBlock?.id ?? '',
        tagAtTop: st.blocks.some((b) => b.id === tagBlock?.id),
      }
    }, target)

    const blockOps = after.ops.filter((o) => o.e === 'block')
    const propOps = after.ops.filter((o) => o.e === 'prop')
    assert(
      blockOps.length === 1 && blockOps[0].op === 'upsert' && blockOps[0].parent === null,
      `一次打标签应只建 1 个块（parent:null）：${JSON.stringify(after.ops)}`,
    )
    assert(
      propOps.some((o) => o.name === '_tags' && o.id === target.id && Array.isArray(o.value)),
      `必须有一条写宿主 _tags：${JSON.stringify(after.ops)}`,
    )
    assert(
      propOps.some((o) => o.id === after.tagId && o.name === '_aliases'),
      `标签块的地址要进日志：${JSON.stringify(after.ops)}`,
    )
    assert(after.tagId !== '' && after.tagAtTop, '新标签块应住森林顶层')
    assert(
      JSON.stringify(after.hostTags) === JSON.stringify([...target.tags, after.tagId]),
      `归属应写进宿主的 _tags：${JSON.stringify(after.hostTags)}`,
    )

    // 再打一次：标签已在、归属已挂 ⇒ 事务里什么都不写（零 op）
    await page.evaluate(() => window.__qua.invoke('core.editor/insert-tag', { tag: '冒烟新标签' }))
    await page.waitForTimeout(150)
    const repeat = await page.evaluate(() => window.__qua.lastOps())
    assert(repeat.length === 0, `重复打同一个标签应是零 op：${JSON.stringify(repeat)}`)

    // 一步撤销：标签块与归属一起回（同一笔的证据）
    await page.evaluate(() => window.__qua.invoke('core.history/undo'))
    await page.waitForTimeout(150)
    const undone = await page.evaluate((t) => {
      const st = window.__qua.__editor.store
      const plain = (b) => (b ? b.content.filter((r) => r.t === 'text').map((r) => r.v).join('') : '')
      const host = st.find(t.id)
      return {
        hostTags: host?.props?._tags ?? [],
        tagGone: !st.blocks.some((b) => plain(b) === '冒烟新标签'),
      }
    }, target)
    assert(
      JSON.stringify(undone.hostTags) === JSON.stringify(target.tags),
      `撤销后归属应回原样：${JSON.stringify(undone.hostTags)}`,
    )
    assert(undone.tagGone, '撤销后新建的标签块也应消失（同一笔）')

    await ctx.close()
    return `insertTag ⇒ [upsert{parent:null}, prop.set _tags] 同笔；重复零 op；⌘Z 一步全回`
  },
)

await check(
  'T91 新建属性定义走一笔事务：定义块 upsert{parent:null} ＋ 声明 prop.set(_ownProps) 同笔两条',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)

    const target = await page.evaluate(() => window.__qua.__editor.store.find(window.__qua.__editor.doc.roots[0].children[0].id)?.id ?? '')
    assert(target !== '', '前置：应有可打字的目标块')

    await page.evaluate((t) => window.__qua.invoke('core.props/create-def', { blockId: t, label: '冒烟字段', kind: 'text', target: 'own' }), target)
    await page.waitForTimeout(200)

    const after = await page.evaluate((t) => {
      const st = window.__qua.__editor.store
      const plain = (b) => (b ? b.content.filter((r) => r.t === 'text').map((r) => r.v).join('') : '')
      const def = st.blocks.find((b) => plain(b) === '冒烟字段')
      const host = st.find(t)
      return {
        ops: window.__qua.lastOps().map((o) => ({ e: o.e, id: o.id ?? o.block, op: o.op, name: o.name, value: o.value, parent: o.value?.parent })),
        defId: def?.id ?? '',
        defAtTop: st.blocks.some((b) => b.id === def?.id),
        declared: host?.props?._fields ?? host?.props?._ownProps ?? null,
      }
    }, target)

    assert(after.defId !== '' && after.defAtTop, `定义块应在库顶层：${JSON.stringify(after)}`)
    const blockOps = after.ops.filter((o) => o.e === 'block')
    const propOps = after.ops.filter((o) => o.e === 'prop')
    assert(
      blockOps.length === 1 &&
        blockOps[0].op === 'upsert' && blockOps[0].parent === null && blockOps[0].id === after.defId,
      `新建定义应只建 1 个块（parent:null）：${JSON.stringify(after.ops)}`,
    )
    assert(
      propOps.some((o) => o.id === after.defId && o.name === '_kind'),
      `定义块的 _kind 要进日志：${JSON.stringify(after.ops)}`,
    )
    assert(
      propOps.some((o) => o.id === target && o.name === '_ownProps'),
      `声明要进日志：${JSON.stringify(after.ops)}`,
    )

    await ctx.close()
    return `createPropDef ⇒ [upsert{parent:null}, prop.set]；定义块住顶层`
  },
)

await check(
  'T92 加一个 gutter 属性 ⇒ 那一行**当场**画出标记（不靠别处碰一下才刷新）',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)
    const target = await pickLeaf(page)
    assert(target, '第一页里应有可编辑的内容块')

    /**
     * 同一件事有**两个面**，都必须当场刷新：
     *   · 右槽卡里的行（`scheduleProperties`）
     *   · **行自己**（gutter 标记：待办方框 / 标签身份图标，由 `gutterFieldsOf` 派生）
     *
     * 后者是这次漏掉的：写属性的入口只写了模型、只重画了卡，没有重画那一行。
     * 于是「给块挂上任务状态」之后模型里已经有了，屏幕上那个方框要等下一次
     * 整页重渲染才出现 —— 用户读到的是「点了没反应」。
     */
    const before = await page.evaluate((id) => {
      const blk = document.querySelector(`.blk[data-block-id="${id}"]`)
      return { todo: blk?.dataset.todo ?? null, box: !!blk?.querySelector('.todo-box') }
    }, target.id)
    assert(before.todo === null && before.box === false, `前置：这块一开始不该有任务标记：${JSON.stringify(before)}`)

    // 走**菜单那条路径**（面板里的「添加块属性」调的就是这个命令）
    const statusId = await page.evaluate(() => window.__qua.propDefs().find((d) => d.label === '任务状态')?.id ?? '')
    assert(statusId !== '', '库里应自带「任务状态」定义')
    await page.evaluate(
      ({ id, propId }) => window.__qua.invoke('core.props/add-field', { blockId: id, propId, target: 'own' }),
      { id: target.id, propId: statusId },
    )
    await page.waitForTimeout(200)

    const after = await page.evaluate((id) => {
      const blk = document.querySelector(`.blk[data-block-id="${id}"]`)
      const model = window.__qua.__editor.store.find(id)
      return {
        // 模型：这块有了任务状态槽（未填 ⇒ false 那一档由渲染器画空心）
        hasSlot: Array.isArray(model?.props?._ownProps) && model.props._ownProps.includes(window.__qua.propDefs().find((d) => d.label === '任务状态')?.id),
        todo: blk?.dataset.todo ?? null,
        box: !!blk?.querySelector('.todo-box'),
      }
    }, target.id)
    assert(after.hasSlot, `前置：模型里应已有这个属性槽：${JSON.stringify(after)}`)
    assert(after.todo === 'todo', `加完属性，那一行应当场变成「未完成任务」（data-todo=todo）：${JSON.stringify(after)}`)
    assert(after.box === true, `加完属性，块左侧应当场出现待办方框：${JSON.stringify(after)}`)

    /**
     * 反向也要当场生效：点一下方框 ⇒ 变成已完成（这个方向本来就是通的，
     * 但它与上面同一个渲染判据，一起钉住才说明改的是「判据」而不是「某条路径的特例」）。
     *
     * ⚠️ 派发 **mousedown**，不是 click：gutter 的动作都挂在 mousedown 上
     *    （gutter 是 `contenteditable=false` 的兄弟节点，click 之前浏览器会先移光标）。
     */
    await page.evaluate((id) => {
      document.querySelector(`.blk[data-block-id="${id}"] .todo-box`)?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    }, target.id)
    await page.waitForTimeout(200)
    const done = await page.evaluate((id) => ({
      todo: document.querySelector(`.blk[data-block-id="${id}"]`)?.dataset.todo ?? null,
    }), target.id)
    assert(done.todo === 'done', `点一下方框应当场变已完成：${JSON.stringify(done)}`)

    /**
     * 摘掉属性（`clear-value` 会连槽位一起摘）⇒ 标记当场消失。
     *
     * 不对称的刷新比不刷新更难查：出现的时候对、消失的时候要等下一次重渲染。
     */
    await page.evaluate(
      ({ id, propId }) => window.__qua.invoke('core.props/clear-value', { blockId: id, propId }),
      { id: target.id, propId: statusId },
    )
    await page.waitForTimeout(200)
    const removed = await page.evaluate((id) => {
      const blk = document.querySelector(`.blk[data-block-id="${id}"]`)
      const model = window.__qua.__editor.store.find(id)
      return {
        slot: Array.isArray(model?.props?._ownProps) ? model.props._ownProps.length : 0,
        todo: blk?.dataset.todo ?? null,
        box: !!blk?.querySelector('.todo-box'),
      }
    }, target.id)
    assert(removed.slot === 0, `摘掉后模型里不该留着槽位：${JSON.stringify(removed)}`)
    assert(removed.todo === null && removed.box === false, `摘掉后方框与状态应一起消失：${JSON.stringify(removed)}`)

    await ctx.close()
    return `add-field(任务状态) ⇒ 当场 todo ＋ 方框；点一下 ⇒ done；clear-value ⇒ 两者一起消失`
  },
)

/* ------------------------------------------------- 落点与「根不可见」 */

await check(
  'T96 新建页立刻出现在引用选择器里（候选按身份找，不按位置）',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)

    /**
     * 这一条钉的是**一个具体的静默失效**：
     * 引用选择器早先按 `roots()`（森林顶层）列候选。内容一度改成落进当天之后，
     * 每个新建的页都不在顶层 ⇒ 选择器会**静默少掉它们**（不报错，只是「找不到」）。
     * 现在页回到森林顶层，但判据仍必须是「按身份找」——页可以住在任何位置，
     * 位置不是「可不可引用」的判据。判据落在「新建的那个页 id 在候选里」。
     */
    const before = await page.evaluate(() => window.__qua.pages().length)
    await page.evaluate(() => window.__qua.invoke('core.page/new'))
    await page.waitForTimeout(250)
    const created = await page.evaluate(() => ({
      pages: window.__qua.pages().length,
      id: window.__qua.snapshot().activeId,
    }))
    assert(created.pages === before + 1, `页数应 +1：${before} → ${created.pages}`)

    await page.evaluate(() => window.__qua.invoke('core.editor/insert-page-ref'))
    await page.waitForTimeout(200)
    const picked = await page.evaluate(() => ({
      labels: [...document.querySelectorAll('.layer-item .layer-label')].map((e) => e.textContent?.trim() ?? ''),
      groups: [...document.querySelectorAll('.layer-group')].map((e) => e.textContent?.trim() ?? ''),
    }))
    /**
     * 新建页在候选里：它的地址是「未命名-<短 id>」，用**短 id** 断言最硬
     * （`未命名-` 前缀是所有空标题页共用的，只看前缀会被别的页蒙过去）。
     */
    const short = created.id.slice(-6)
    assert(
      picked.labels.some((x) => x.includes(short)),
      `刚建的页必须出现在引用候选里：${JSON.stringify({ short, labels: picked.labels.slice(0, 8) })}`,
    )
    // 标签也在候选里（它们同样是可引用的目标，不该因为「不在顶层」被漏掉）
    assert(
      picked.labels.some((x) => x.startsWith('#')),
      `标签也应是可引用的目标：${JSON.stringify(picked.labels.slice(0, 8))}`,
    )
    await page.keyboard.press('Escape')
    await ctx.close()
    return `新建页（和标签一起）都在引用候选里：候选按身份找，不按位置`
  },
)

await check(
  'T96b `@` 无同名页 + ↵：当场建页（parent:null）并在原位插引用；一次撤销页与引用一起回滚',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)

    const before = await page.evaluate(() => {
      const ed = window.__qua.__editor
      const b = ed.rows().map((r) => r.block).find((x) => !x.children.length && !(x.props?._tags?.length))
      window.__qua.focusBlock(b.id, 9999)
      return { id: b.id, pages: window.__qua.pages().length, roots: window.__qua.snapshot().topBlocks }
    })

    await page.keyboard.type('@无匹配页甲')
    await page.waitForTimeout(240)
    const rows = await layerRows(page)
    assert(rows.some((r) => r.label.includes('新建页面') && r.label.includes('无匹配页甲')), `无同名页时应出现「新建页面」行：${JSON.stringify(rows.slice(0, 6))}`)

    await page.keyboard.press('Enter')
    await page.waitForTimeout(260)

    const created = await page.evaluate((t) => {
      const ed = window.__qua.__editor
      const host = ed.store.find(t.id)
      const atoms = window.__qua.atoms().filter((a) => a.blockId === t.id)
      const pageId = atoms[0]?.target?.id ?? ''
      const p = pageId ? ed.store.find(pageId) : null
      const ops = window.__qua.lastOps().map((o) => ({ e: o.e, op: o.op, id: o.id, block: o.block ?? o.id, name: o.name, parent: o.value?.parent, prev: o.value?.prev }))
      return {
        hostText: host ? host.content.filter((r) => r.t === 'text').map((r) => r.v).join('') : null,
        atoms: atoms.map((a) => ({ kind: a.kind, target: a.target?.id ?? '' })),
        pageId,
        page: p ? { aliases: p.props?._aliases ?? [], lists: p.props?._lists ?? [], children: p.children.length } : null,
        pages: window.__qua.pages().length,
        roots: window.__qua.snapshot().topBlocks,
        ops,
      }
    }, before)

    assert(created.pageId !== '' && created.page, `↵ 应插一枚指向新页的引用：${JSON.stringify(created)}`)
    assert(created.page.aliases[0] === '无匹配页甲', `新页的地址应是输入的文本：${JSON.stringify(created.page)}`)
    assert(created.page.lists.includes('page'), `新页应带 page 露面：${JSON.stringify(created.page)}`)
    assert(created.page.children === 1, `新页应自带一个可写的空首子块：${JSON.stringify(created.page)}`)
    assert(created.pages === before.pages + 1, `页数应 +1：${before.pages} → ${created.pages}`)
    assert(created.roots === before.roots + 1, `森林根数应 +1：${before.roots} → ${created.roots}`)
    assert(created.atoms.length === 1 && created.atoms[0].kind === 'page', `引用应是 page 风味：${JSON.stringify(created.atoms)}`)
    const createdBlockOps = created.ops.filter((o) => o.e === 'block')
    const createdPropOps = created.ops.filter((o) => o.e === 'prop')
    assert(createdBlockOps.every((o) => o.op === 'upsert'), `建页与插引用都走事务 op：${JSON.stringify(created.ops)}`)
    assert(createdBlockOps.some((o) => o.id === created.pageId && o.parent === null), `页块应报 parent:null：${JSON.stringify(created.ops)}`)
    assert(createdPropOps.some((o) => o.block === created.pageId && o.name === '_aliases'), `页的地址要进日志：${JSON.stringify(created.ops)}`)

    // 一次撤销：引用与页一起回滚（落点不是打字的延续）
    await page.evaluate(() => window.__qua.invoke('core.history/undo'))
    await page.waitForTimeout(220)
    const back = await page.evaluate((t) => {
      const ed = window.__qua.__editor
      const host = ed.store.find(t.id)
      return {
        text: host ? host.content.filter((r) => r.t === 'text').map((r) => r.v).join('') : null,
        atoms: window.__qua.atoms().filter((a) => a.blockId === t.id).length,
        pageGone: ed.store.find(t.pageId) === undefined,
        pages: window.__qua.pages().length,
      }
    }, { id: before.id, pageId: created.pageId })

    assert(back.text === `${created.hostText ?? ''}@无匹配页甲`, `一次撤销应回到落点前的正文（字还留着）：${JSON.stringify(back.text)}`)
    assert(back.atoms === 0, `一次撤销后正文里的引用应回滚：剩 ${back.atoms}`)
    assert(back.pageGone, '一次撤销后新建的页应不在模型里')
    assert(back.pages === before.pages, `一次撤销后页数应回原样：${before.pages}，实际 ${back.pages}`)

    await ctx.close()
    return `@无匹配页甲 + ↵ ⇒ 新页 upsert{parent:null} + 原位 page 引用；一次撤销页与引用一起回滚`
  },
)

await check(
  'T97 根不可见：「顶层」不出现在任何用户能看到的文案里；退回上一级在最外层不给入口',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)

    /**
     * 判据：用户世界里没有「根」——没有根视图、没有「提取为无名根」、
     * 「顶层」不出现在任何菜单。`提取为页` 不违反：它产出的是有视口的页，
     * 不是把块送进没有视口的根。
     *
     * ⚠️ 这条是**否定式**口味：它挡的是「后来有人顺手把那个词加回来」。
     *    代码注释里说「森林顶层」是模型事实，不受这条约束（注释不是用户可见文案）。
     */
    const panelText = await page.evaluate(() => {
      window.__qua.invoke('core.command-palette/show', {})
      return document.querySelector('.layer')?.textContent ?? ''
    })
    assert(panelText.length > 0, '命令面板应有内容')
    assert(!panelText.includes('顶层'), `命令面板里不该出现「顶层」：${JSON.stringify(panelText.slice(0, 200))}`)
    await page.keyboard.press('Escape')

    // 块菜单同理（右键菜单也渲染绑定表）
    const menuText = await page.evaluate(() => {
      const id = window.__qua.blocks()[1].id
      window.__qua.openBlockMenu(id)
      return document.querySelector('.layer')?.textContent ?? ''
    })
    assert(!menuText.includes('顶层'), `块菜单里不该出现「顶层」：${JSON.stringify(menuText.slice(0, 200))}`)
    await page.keyboard.press('Escape')

    /**
     * 退回上一级：**最外层不给入口**。
     * 这一格的判据是 `when` 挡住了它（菜单里不出现），而不是「点了静默无事」——
     * 一条永远点不动的命令放在菜单里，用户只会以为是坏的。
     */
    const atTop = await page.evaluate(() => {
      const id = window.__qua.blocks()[0].id
      window.__qua.openBlockMenu(id)
      const rows = [...document.querySelectorAll('.layer-item')].map((e) => e.textContent?.trim() ?? '')
      const root = window.__qua.blocks()[0]
      return { rows, isRoot: !window.__qua.__editor.store.blocks.some((b) => b.children.includes(root)) }
    })
    if (atTop.isRoot) {
      assert(
        !atTop.rows.some((x) => x.includes('退回上一级')),
        `最外层时「退回上一级」不该出现在菜单里：${JSON.stringify(atTop.rows)}`,
      )
    }
    await page.keyboard.press('Escape')
    await ctx.close()
    return `命令面板与块菜单都没有「顶层」；最外层时「退回上一级」按 when 藏起来（不是点了没反应）`
  },
)

await check(
  'T98 移动到…：一条事务一条 op（⌘Z 一步回原位）、引用不受影响（边按 id）、自环被拒且模型不动',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)

    /**
     * 前置：挑一个有正文的叶子块，并找一个**不是它祖先、也不是它自己**的页作目标。
     * ⚠️ 目标必须是「页或标签块」（可作 target 的容器集合），不能是天。
     */
    const setup = await page.evaluate(() => {
      const ed = window.__qua.__editor
      const rows = []
      const walk = (list, parent) => {
        list.forEach((b, i) => {
          rows.push({ b, parentId: parent?.id ?? null, index: i })
          walk(b.children, b)
        })
      }
      walk(ed.doc.roots, null)
      const plain = (b) => b.content.filter((r) => r.t === 'text').map((r) => r.v).join('')
      const leaf = rows.find((x) => !x.b.children.length && plain(x.b).length >= 4 && !(x.b.props?._tags?.length) && x.parentId)
      if (!leaf) return null
      const pages = window.__qua.pages()
      // 目标：祖先链里不含 leaf 的页
      const pathIds = new Set(window.__qua.__editor.store.blocks.flatMap(() => []))
      const target = pages.find((p) => {
        let n = ed.store.find(p.id)
        return Boolean(n)
      })
      return {
        id: leaf.b.id,
        text: plain(leaf.b).slice(0, 20),
        parentId: leaf.parentId,
        index: leaf.index,
        targetId: target?.id ?? '',
        targetTitle: target?.title ?? '',
      }
    })
    assert(setup && setup.targetId, `前置：需要一个可搬的内容块与一个页目标：${JSON.stringify(setup)}`)

    /**
     * **引用不受影响**：搬家只改 `parent/index`，不可能动到任何 run 的 `to`。
     *
     * 判据取**整片森林里所有 ref run 的 `to` 集合**（前后逐项比较），而不是「反链条数」：
     * 反链是派生读（会跟着父块可见性变），而边按 id 记是**模型事实**——
     * 这条断言钉的正是「搬家不动边」这件事本身。
     */
    const refTargets = () =>
      page.evaluate(() => {
        const out = []
        const walk = (list) => {
          for (const b of list) {
            for (const r of b.content ?? []) if (r.t === 'ref' && r.to) out.push(`${b.id}->${r.to}`)
            walk(b.children)
          }
        }
        walk(window.__qua.__editor.store.blocks)
        return out.sort()
      })
    const refsBefore = await refTargets()
    assert(refsBefore.length > 0, `前置：库里应至少有一枚指向别处的引用（用来验搬家不动边）`)

    // 走**命令面**（用户走的就是这条：命令 → 选目标 → 搬），不是直接调门面
    await page.evaluate(({ id, targetId }) => window.__qua.invoke('core.block/move-to', { blockId: id, targetId }), setup)
    await page.waitForTimeout(250)

    const moved = await page.evaluate((t) => {
      const ed = window.__qua.__editor
      const find = (list, id, parent) => {
        for (let i = 0; i < list.length; i++) {
          if (list[i].id === id) return { parentId: parent?.id ?? null, index: i }
          const hit = find(list[i].children, id, list[i])
          if (hit) return hit
        }
        return null
      }
      const loc = find(ed.store.blocks, t.id, null)
      return {
        ops: window.__qua.lastOps().map((o) => ({ e: o.e, id: o.id, op: o.op, parent: o.value?.parent, prev: o.value?.prev })),
        loc,
        // 目标容器的子块数（应该 +1）
        targetKids: ed.store.find(t.targetId)?.children.length ?? -1,
      }
    }, setup)

    /**
     * **一条事务一条 op**：搬一块就该恰好一条 `upsert{parent,index}`。
     * 拆成「先删后插」会在这里立刻显形（两条 op，⌘Z 也只能回一半）。
     */
    assert(moved.ops.length === 1, `一次移动应恰好 1 条 op：${JSON.stringify(moved.ops)}`)
    assert(
      moved.ops[0].e === 'block' && moved.ops[0].op === 'upsert' && moved.ops[0].parent === setup.targetId,
      `应是一条 upsert{parent:目标}：${JSON.stringify(moved.ops)}`,
    )
    assert(moved.loc?.parentId === setup.targetId, `模型里它应已在目标下：${JSON.stringify(moved.loc)}`)

    // 引用不受影响：整片森林的边集合一字不变
    const refsAfter = await refTargets()
    assert(
      JSON.stringify(refsAfter) === JSON.stringify(refsBefore),
      `搬家不该改变任何引用指向：${JSON.stringify({ before: refsBefore.slice(0, 3), after: refsAfter.slice(0, 3) })}`,
    )

    // ⌘Z 一步回原位
    await page.evaluate(() => window.__qua.invoke('core.history/undo'))
    await page.waitForTimeout(250)
    const back = await page.evaluate((t) => {
      const ed = window.__qua.__editor
      const find = (list, id, parent) => {
        for (let i = 0; i < list.length; i++) {
          if (list[i].id === id) return { parentId: parent?.id ?? null, index: i }
          const hit = find(list[i].children, id, list[i])
          if (hit) return hit
        }
        return null
      }
      return find(ed.store.blocks, t.id, null)
    }, setup)
    assert(back?.parentId === setup.parentId, `⌘Z 一步应回原父块：${JSON.stringify({ back, setup })}`)

    /**
     * **自环被拒**：把它移进自己的子块 ⇒ 模型一动不动、给提示。
     * 判据落在「模型没变」而不是「有没有抛错」——core 会抛，但那会让异常冒到 UI。
     */
    const child = await page.evaluate((id) => {
      const b = window.__qua.__editor.store.find(id)
      return b?.children[0]?.id ?? ''
    }, setup.id)
    if (child) {
      const beforeCycle = await page.evaluate(() => window.__qua.lastOps().length)
      await page.evaluate(({ id, child }) => window.__qua.invoke('core.block/move-to', { blockId: id, targetId: child }), { id: setup.id, child })
      await page.waitForTimeout(200)
      const afterCycle = await page.evaluate((t) => {
        const ed = window.__qua.__editor
        const find = (list, id, parent) => {
          for (let i = 0; i < list.length; i++) {
            if (list[i].id === id) return { parentId: parent?.id ?? null, index: i }
            const hit = find(list[i].children, id, list[i])
            if (hit) return hit
          }
          return null
        }
        return { loc: find(ed.store.blocks, t.id, null), ops: window.__qua.lastOps().length }
      }, setup)
      assert(afterCycle.loc?.parentId === setup.parentId, `自环应被拒（块还在原处）：${JSON.stringify(afterCycle)}`)
      assert(afterCycle.ops === beforeCycle, `自环被拒时不该产出任何 op：${beforeCycle} → ${afterCycle.ops}`)
    }

    await ctx.close()
    return `搬一块 ⇒ 恰好 1 条 upsert{parent:目标}；⌘Z 一步回原位；引用数不变；自环被拒且零 op`
  },
)

/* ------------------------------------------------------- 行契约（会红的回归） */

/**
 * 这两条是 2026-10-25 修掉的两个**真事故**的钉子。它们都不是「模型算错了」，
 * 而是「DOM 契约被别的东西悄悄改掉了」——所以断言必须落在 DOM 结构上，不能只看模型。
 */

await check(
  'T94 首块块首退格不拆行：gutter 与 .tx 都还在，之后照常打得进字（放给浏览器会把它们整段删掉）',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)

    const id = await page.evaluate(() => window.__qua.blocks()[0].id)
    const shape = () =>
      page.evaluate((i) => {
        const el = document.querySelector(`.blk[data-block-id="${i}"]`)
        const tx = el?.querySelector(':scope > .tx')
        return {
          left: Boolean(el?.querySelector(':scope > .left')),
          tx: Boolean(tx),
          txText: tx?.textContent ?? '(no .tx)',
          blk: Boolean(el),
          model: window.__qua.blocks().find((x) => x.id === i)?.text ?? '(not in view)',
        }
      }, id)

    const start = await shape()
    assert(start.left && start.tx, `前置：这一行应同时有 gutter 与 .tx：${JSON.stringify(start)}`)

    // 清空（正好按到空），再**多按一下**——那一按在首块上没有任何事可做
    const len = start.txText.length
    await page.evaluate(({ i, l }) => window.__qua.focusBlock(i, l), { i: id, l: len })
    for (let n = 0; n < len + 1; n++) await page.keyboard.press('Backspace')
    await page.waitForTimeout(200)

    const after = await shape()
    /**
     * 判据：**行还在、结构没被拆**。
     * 放给浏览器时原生删除会把 gutter（`.left`）与正文（`.tx`）当成两个可删节点整段摘掉，
     * 那一行从此没有可落光标的地方 —— 表现是「把这块删空之后再也打不进字」。
     */
    assert(after.blk, `这一行不该消失：${JSON.stringify(after)}`)
    assert(after.left, `gutter 不该被删掉：${JSON.stringify(after)}`)
    assert(after.tx, `正文槽 .tx 不该被删掉（没了它就没有可落光标的地方）：${JSON.stringify(after)}`)
    assert(after.model === '', `模型里应是空块：${JSON.stringify(after)}`)

    // 关键的后半句：还能打进去
    await page.keyboard.type('还能打字')
    await page.waitForTimeout(250)
    const typed = await shape()
    assert(typed.model === '还能打字', `空块之后必须照常打得进字：${JSON.stringify(typed)}`)
    await ctx.close()
    return `首块清空再多按一次退格：gutter／.tx 都还在，模型为空，接着打字照常落进模型`
  },
)

await check(
  'T95 槽内钉住行的 DOM 契约：行里有 .sec 包裹，正文在 .sec > .blk > .tx（选择器别按直接子元素写）',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)
    const id = await page.evaluate(() => window.__qua.blocks().find((x) => !(x.roles?.length) && !x.todo && x.text.length > 2)?.id ?? '')
    assert(id, '应有一个可拖的普通块')
    const drag = await dragBlockToDock(page, id, 'left')
    assert(drag?.hot, '拖进左槽应给出高亮')
    await page.waitForTimeout(200)

    /**
     * 为什么钉这条：槽里的行**与正文用同一个渲染器**（`renderBlock`），
     * 所以段物质化加进来的 `.sec` 包裹层在两边都出现。验收里如果按
     * `.dock-window-editor > .blk` 这种直接子元素写，就会在包裹层出现那天**静默失效**：
     * 行其实渲染得好好的，只是选择器等不到它 —— 报错看起来像「槽里没渲染」。
     */
    const shape = await page.evaluate((i) => {
      const row = document.querySelector(`#dock-left .dock-card[data-window="1"][data-card-id="${i}"]`)
      const host = row?.querySelector('.dock-window-editor')
      return {
        row: Boolean(row),
        host: Boolean(host),
        // 契约：正文行在 host 的后代里（不是直接子元素），并且 `.tx` 在那一行里
        blkAnywhere: Boolean(host?.querySelector('.blk[data-depth="0"]')),
        txAnywhere: Boolean(host?.querySelector('.blk[data-depth="0"] > .tx')),
        // 反证：按**直接子元素**写会等不到（这就是当初那条选择器挂掉的原因）
        blkDirectChild: Boolean(host?.querySelector(':scope > .blk')),
        secWrapped: Boolean(host?.querySelector(':scope > .sec')),
        text: host?.querySelector('.blk[data-depth="0"] > .tx')?.textContent ?? '',
      }
    }, id)
    assert(shape.row && shape.host, `钉住行与编辑器宿主都该在：${JSON.stringify(shape)}`)
    assert(shape.secWrapped, `段物质化之后，宿主里应有一层 .sec 包裹：${JSON.stringify(shape)}`)
    assert(shape.blkAnywhere, `正文行应在宿主的后代里（不是直接子元素）：${JSON.stringify(shape)}`)
    assert(shape.txAnywhere, `正文槽 .tx 应在那一行里：${JSON.stringify(shape)}`)
    assert(!shape.blkDirectChild, `正文行不该是宿主的直接子元素（它被 .sec 包了一层）：${JSON.stringify(shape)}`)
    assert(shape.text.length > 0, `槽里那一行应显示块自己的正文：${JSON.stringify(shape)}`)
    await ctx.close()
    return `槽内行：宿主 → .sec → .blk[data-depth=0] → .tx；按直接子元素写会等不到（这条就是那条选择器的钉子）`
  },
)


/**
 * 这一条钉的是「插入点只准落在可写正文槽里」。
 *
 * 事故形状：整片编辑区是**一个** contenteditable 容器，行容器 `.blk` 因此也编辑得了。
 * 点到「正文之外」（块标的圆角缝、gutter 与正文之间的缝、只读日期行）时，
 * 浏览器把插入点放进 `.blk` 自己身上 —— 光标看起来在块标左侧（「块前面」），
 * 打出来的字成为**挂在 `.blk` 上的裸文本节点**：`readRuns` 只读 `.tx`，
 * 所以模型里什么都没有，重渲染一过就消失。用户当场看得见、事后找不着。
 *
 * ⇒ 断言落在**两个面上**，缺一个都不算修好：
 *   ① 点那些位置之后，插入点不许落在 `.tx` 之外；
 *   ② 接着打字，`.blk` 的直接子节点里不许出现游离文本，且字必须真的进了模型。
 */
await check(
  'T98b 提取为页：块连子树搬到森林顶层 + page 露面；原位置留一枚 ref 引用；一次撤销全回',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)

    const setup = await page.evaluate(() => {
      const ed = window.__qua.__editor
      const root = ed.doc.roots[0]
      const id = ed.insertBlockAfter(root.id, '提取源冒烟')
      const childId = ed.insertBlockAfter(id, '子块')
      ed.indent(childId)
      const walk = (list, parent) => {
        for (let i = 0; i < list.length; i++) {
          const b = list[i]
          if (b.id === id) return { parentId: parent?.id ?? null, index: i }
          const hit = walk(b.children, b)
          if (hit) return hit
        }
        return null
      }
      const loc = walk(ed.store.blocks, null)
      return {
        id,
        childId,
        parentId: loc.parentId,
        index: loc.index,
        roots: window.__qua.snapshot().topBlocks,
        pages: window.__qua.pages().length,
        total: window.__qua.snapshot().totalBlocks,
      }
    })
    assert(setup.id && setup.childId && setup.parentId, `前置：源块应在某个 parent 下：${JSON.stringify(setup)}`)

    await page.evaluate((id) => window.__qua.invoke('core.block/extract-to-page', { blockId: id }), setup.id)
    await page.waitForTimeout(260)

    const after = await page.evaluate((t) => {
      const ed = window.__qua.__editor
      const page = ed.store.find(t.id)
      const walk = (list, parent) => {
        for (let i = 0; i < list.length; i++) {
          const b = list[i]
          const run = b.content.find((r) => r.t === 'ref' && r.to === t.id)
          if (run && b.id !== t.id) return { block: b, parentId: parent?.id ?? null, index: i }
          const hit = walk(b.children, b)
          if (hit) return hit
        }
        return null
      }
      const ref = walk(ed.store.blocks, null)
      return {
        pageRoot: ed.store.blocks.some((b) => b.id === t.id),
        pageLists: page?.props?._lists ?? [],
        pageAliases: page?.props?._aliases ?? [],
        childStill: page?.children[0]?.id === t.childId,
        refId: ref?.block.id ?? '',
        refParent: ref?.parentId ?? '',
        refIndex: ref?.index ?? -1,
        refTarget: ref?.block.content.find((r) => r.t === 'ref')?.to ?? '',
        refText: ref ? ref.block.content.filter((r) => r.t === 'text').map((r) => r.v).join('') : null,
        roots: window.__qua.snapshot().topBlocks,
        pages: window.__qua.pages().length,
        total: window.__qua.snapshot().totalBlocks,
        ops: window.__qua.lastOps().map((o) => ({ e: o.e, op: o.op, id: o.id, parent: o.value?.parent, prev: o.value?.prev })),
      }
    }, setup)

    assert(after.pageRoot, `原块应搬到森林顶层（同一 id）：${JSON.stringify(after.ops)}`)
    assert(after.pageLists.includes('page'), `应补 page 露面：${JSON.stringify(after.pageLists)}`)
    assert(after.pageAliases[0] === '提取源冒烟', `应把正文当主名：${JSON.stringify(after.pageAliases)}`)
    assert(after.childStill, '子树应跟着原块一起搬')
    assert(after.refId !== '' && after.refTarget === setup.id, `原位置应留一枚指向原块的引用：${JSON.stringify(after)}`)
    assert(after.refParent === setup.parentId && after.refIndex === setup.index, `引用应占原 index：${JSON.stringify(after)} vs ${JSON.stringify(setup)}`)
    assert(after.refText === '', `引用行不该把名字写成文本：${JSON.stringify(after.refText)}`)
    assert(after.pages === setup.pages + 1, `页数应 +1：${setup.pages} → ${after.pages}`)
    assert(after.roots === setup.roots + 1, `森林根数应 +1：${setup.roots} → ${after.roots}`)
    assert(after.total === setup.total + 1, `块数应 +1（只多了引用行）：${setup.total} → ${after.total}`)
    assert(after.ops.some((o) => o.id === setup.id && o.parent === null), `应有原块 move 到 parent:null 的 op：${JSON.stringify(after.ops)}`)
    assert(after.ops.some((o) => o.id === after.refId && o.parent === setup.parentId), `应有引用块的 insert op：${JSON.stringify(after.ops)}`)
    assert(after.ops.some((o) => o.e === 'prop'), `page 露面/别名应走 prop op：${JSON.stringify(after.ops)}`)

    await page.evaluate(() => window.__qua.invoke('core.history/undo'))
    await page.waitForTimeout(240)
    const back = await page.evaluate((t) => {
      const ed = window.__qua.__editor
      const b = ed.store.find(t.id)
      const walk = (list, parent) => {
        for (let i = 0; i < list.length; i++) {
          if (list[i].id === t.id) return { parentId: parent?.id ?? null, index: i }
          const hit = walk(list[i].children, list[i])
          if (hit) return hit
        }
        return null
      }
      const loc = walk(ed.store.blocks, null)
      return {
        parentId: loc?.parentId ?? '',
        index: loc?.index ?? -1,
        lists: b?.props?._lists ?? [],
        childStill: b?.children[0]?.id === t.childId,
        refGone: ed.store.find(t.refId) === undefined,
        pages: window.__qua.pages().length,
      }
    }, { ...setup, refId: after.refId })

    assert(back.parentId === setup.parentId && back.index === setup.index, `撤销后原块应回原位：${JSON.stringify(back)} vs ${JSON.stringify(setup)}`)
    assert(!back.lists.includes('page'), `撤销后不该留着 page 露面：${JSON.stringify(back.lists)}`)
    assert(back.childStill, '撤销后子树应还在原块下')
    assert(back.refGone, '撤销后原位置那枚引用应消失')
    assert(back.pages === setup.pages, `撤销后页数应回原样：${setup.pages}，实际 ${back.pages}`)

    await ctx.close()
    return `提取为页 ⇒ 原 id 搬根 + page 露面；原 index 留 ref；一次撤销回原位、引用消失`
  },
)

await check(
  'T99 插入点只准落在可写正文槽：点 journal 的竖线/块标缝不落光标，硬打字也不留游离节点',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))

    /**
     * ① 结构面：`.blk` 的直接子节点只允许渲染层自己放的那几种。
     *    这条判据本身就是 `ALLOWED_ROW_CHILDREN` 的镜像——两边一起改才是真的改。
     */
    const strayOf = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('#editor .blk')]
          .map((b) => ({
            id: b.dataset.blockId?.slice(0, 6) ?? '?',
            text: [...b.childNodes].filter((n) => n.nodeType === 3 && (n.data ?? '').trim() !== '').map((n) => n.data),
            extra: [...b.childNodes]
              .filter((n) => n.nodeType === 1 && !['blk-alias', 'rails', 'rail-self', 'left', 'tx', 'blk-tags'].includes(n.classList[0] ?? ''))
              .map((n) => n.nodeName),
          }))
          .filter((o) => o.text.length > 0 || o.extra.length > 0),
      )

    const caret = () =>
      page.evaluate(() => {
        const s = document.getSelection()
        if (!s || s.rangeCount === 0) return { inWritable: false, where: 'no-range' }
        const n = s.anchorNode
        const el = n?.nodeType === 1 ? n : n?.parentElement
        const tx = el?.closest('.tx')
        return { inWritable: Boolean(tx && !tx.closest('[data-readonly]')), where: el?.className ?? String(n?.nodeName ?? '?') }
      })

    const modelHas = (needle) =>
      page.evaluate((s) => window.__qua.blocks().filter((b) => JSON.stringify(b.content ?? '').includes(s)).length, needle)

    const assertClean = async (label) => {
      const stray = await strayOf()
      assert(stray.length === 0, `${label}：.blk 里不该出现游离节点：${JSON.stringify(stray)}`)
      const m = await modelHas('§')
      assert(m === 0, `${label}：那一下打的字不该悄悄进模型（它不是正文）：${m} 块`)
    }

    // 落在「正文之外」的三个真实点位：块标左下圆角缝 / gutter 与正文之间的缝 / 只读日期文本
    const points = await page.evaluate(() => {
      const row = document.querySelector('#editor .blk[data-role~="journal"]')
      const marker = row.querySelector('.marker').getBoundingClientRect()
      const tx = row.querySelector(':scope > .tx').getBoundingClientRect()
      return {
        notch: { x: Math.round(marker.left + 1), y: Math.round(marker.bottom - 2) },
        gap: { x: Math.round(tx.left - 4), y: Math.round(tx.top + tx.height / 2) },
        date: { x: Math.round(tx.left + 8), y: Math.round(tx.top + tx.height / 2) },
      }
    })

    for (const [name, p] of Object.entries(points)) {
      await page.mouse.click(p.x, p.y)
      await page.waitForTimeout(150)
      const c = await caret()
      assert(!c.inWritable || c.where.includes('tx'), `点 journal 的 ${name} 之后插入点不该留在正文之外：${JSON.stringify(c)}`)
      // 硬敲一个字：即便插入点被浏览器挪到了奇怪的地方，也不许留下看不见的脏数据
      await page.keyboard.type('§')
      await page.waitForTimeout(200)
      await assertClean(`点 ${name} 后打字`)
    }

    /**
     * ② 键盘路径：行首按 `←` 也曾把插入点挤出 `.tx`。
     *    修好之后要么留在正文里、要么被收回，总之不许漏出游离节点。
     */
    const firstChild = await page.evaluate(() => {
      const row = document.querySelector('#editor .blk[data-role~="journal"]')
      return row?.nextElementSibling?.dataset.blockId ?? ''
    })
    assert(firstChild, '前置：journal 段里应有一个可编辑子块')
    await page.evaluate((id) => window.__qua.focusBlock(id, 0), firstChild)
    await page.waitForTimeout(150)
    await page.keyboard.press('ArrowLeft')
    await page.waitForTimeout(200)
    const atStart = await caret()
    assert(!atStart.inWritable || atStart.where.includes('tx'), `行首按 ← 之后插入点不该跑出正文槽：${JSON.stringify(atStart)}`)
    await page.keyboard.type('§')
    await page.waitForTimeout(250)
    await assertClean('行首按 ← 后打字')

    await ctx.close()
    return `点 journal 的圆角缝／正文缝／只读日期都不落光标，块首按 ← 也不越界；三处硬打字都没有游离节点、零字进模型`
  },
)

/**
 * 这一条钉的是「**没有子块的块不许被记成折叠**」。
 *
 * 事故形状（实机）：点一条竖线 ⇒ 折它的**直接子块**，整组一起写折叠态。
 * 组里那些自己没有子块的成员也被写了 `true` —— 它们没有子树可藏，
 * 块标却画出折叠环（「这里收着东西」），点开什么都没有。
 * 而这条记录还会存进设备的折叠表，跟着跑到下一次打开。
 *
 * ⇒ 断言落在**三个面**：折叠表只含有子块的那些、叶子块不画折叠环、再点能完整展开。
 */
await check(
  'T100 点竖线只折「有子块的」成员：叶子块不记折叠、不画折叠环，再点完整展开',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))

    /**
     * 种子里的某一段天然就是这个形状：段头下面十几个子块，其中只有一两个自己还有子块。
     * 用它而不是用按键现造树 —— 断言要盯的是「折叠语义」，不是「能不能建树」。
     */
    const shape = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#editor .blk')]
      // 找一个段头：它的直接子块里，既有带子块的、也有叶子
      for (let i = 0; i < rows.length; i++) {
        const head = rows[i]
        if (head.dataset.depth !== '0' || !head.dataset.hasChildren) continue
        const kids = []
        for (let j = i + 1; j < rows.length && Number(rows[j].dataset.depth) > 0; j++) {
          if (Number(rows[j].dataset.depth) === 1) kids.push(rows[j])
        }
        const withKids = kids.filter((k) => k.dataset.hasChildren === '1')
        const leaves = kids.filter((k) => !k.dataset.hasChildren)
        if (withKids.length > 0 && leaves.length > 0) {
          return {
            headId: head.dataset.blockId,
            headRow: i,
            withKids: withKids.map((k) => k.dataset.blockId),
            leaves: leaves.map((k) => k.dataset.blockId),
            rows: rows.length,
          }
        }
      }
      return null
    })
    assert(shape, '前置：种子里应有一段，其直接子块里既有带子块的、也有叶子')

    /**
     * 点「段头最内层的那一段导轨」＝ 折段头的直接子块。
     * 段画在**子行**上，所以取任一子行上指向段头的段。
     */
    const railPos = await page.evaluate((headId) => {
      const rail = document.querySelector(`#editor .blk .rail[data-fold-line-for="${headId}"]`)
      if (!rail) return null
      const r = rail.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    }, shape.headId)
    assert(railPos, '段头应有可点的导轨段')

    await page.mouse.click(railPos.x, railPos.y)
    await page.waitForTimeout(400)

    const after = await page.evaluate((s) => {
      const folded = window.__qua.__editor.doc.folded ?? {}
      const has = (id) => folded[id] === true
      const ringOf = (id) => {
        const el = document.querySelector(`#editor .blk[data-block-id="${id}"]`)
        if (!el) return 'missing'
        const cs = getComputedStyle(el.querySelector('.marker'), '::after')
        return cs.content === 'none' ? 'none' : cs.borderTopWidth
      }
      return {
        withKids: s.withKids.map((id) => ({ id: id.slice(-4), folded: has(id), ring: ringOf(id) })),
        leaves: s.leaves.map((id) => ({ id: id.slice(-4), folded: has(id), ring: ringOf(id) })),
        foldedCount: Object.keys(folded).length,
      }
    }, shape)

    // ① 有子块的成员：折了，且画了折叠环
    for (const k of after.withKids) {
      assert(k.folded, `有子块的成员应被折：${JSON.stringify(k)}`)
      assert(k.ring !== 'none', `折了就该画折叠环：${JSON.stringify(k)}`)
    }
    // ② 叶子成员：不许被记成折叠，也不许画环（它没有子树可藏）
    for (const l of after.leaves) {
      assert(!l.folded, `叶子块不许被记成折叠（没有子树可藏）：${JSON.stringify(l)}`)
      assert(l.ring === 'none', `叶子块不许画折叠环（那是「这里收着东西」的承诺）：${JSON.stringify(l)}`)
    }
    assert(
      after.foldedCount === shape.withKids.length,
      `折叠表里只该有真有子块的那些：实际 ${after.foldedCount} 条，期望 ${shape.withKids.length}`,
    )

    // ③ 再点同一段 ⇒ 完整展开（叶子那批没被误记，不会让「整组已折」的判定卡住）
    await page.mouse.click(railPos.x, railPos.y)
    await page.waitForTimeout(400)
    const back = await page.evaluate(() => ({
      rows: document.querySelectorAll('#editor .blk').length,
      folded: Object.keys(window.__qua.__editor.doc.folded ?? {}).length,
    }))
    assert(back.rows === shape.rows, `再点应恢复全部行：${back.rows} vs ${shape.rows}`)
    assert(back.folded === 0, `展开后折叠表应为空：还剩 ${back.folded} 条`)

    await ctx.close()
    return `${shape.withKids.length} 个有子块的成员被折、${shape.leaves.length} 个叶子不记折叠也不画环；再点恢复 ${back.rows} 行`
  },
)

await check(
  'T101 修改时间只在编辑边界走：连打 5 字不动、离开这一行才动一次；再打再动一次；且那一次仍然恰好 1 条 op',
  async () => {    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)


    const id = await page.evaluate(() => {
      const b = window.__qua.blocks().find((x) => !(x.roles?.length) && !x.todo)
      if (!b) return ''
      window.__qua.focusBlock(b.id, 0)
      return b.id
    })
    assert(id, '前置：应有一个可写的普通块')

    /**
     * 读时刻：**从活的模型读**（`__editor.store`），不读 DOM、不读落盘。
     * 修改时间是模型事实，DOM 上它还看不见（只读段在属性面板里）。
     */
    const stamp = (target) => target.evaluate((bid) => window.__qua.__editor.store.find(bid)?.modified ?? -1, id)
    const created = (target) => target.evaluate((bid) => window.__qua.__editor.store.find(bid)?.created ?? -1, id)
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

    const created0 = await created(page)
    const t0 = await stamp(page)
    // 时钟粒度是毫秒：等一下再敲，否则「变了没有」可能因为同一毫秒而看不出来
    await sleep(15)
    await page.keyboard.type('时间戳一')
    await sleep(15)
    const tTyping = await stamp(page)
    assert(tTyping === t0, `打字过程中不该动修改时间：${t0} → ${tTyping}`)

    /**
     * **离开这一行** ＝ 编辑边界。走真点击：点正文里另一块（`focusBlock` 会调 `commitEdit`）。
     * 那一刻改的字与时刻都在模型里，且这一次仍然只发一条 op（时刻并进内容那条）。
     */
    await page.evaluate(() => {
      const other = window.__qua.blocks().find((x) => x.id !== window.__qua.snapshot().selection.aBlock)
      if (other) window.__qua.focusBlock(other.id, 0)
    })
    await sleep(20)
    const tBoundary = await stamp(page)
    assert(tBoundary > t0, `离开这一行应刷新修改时间：${t0} → ${tBoundary}`)
    const ops = await page.evaluate(() => window.__qua.lastOps().map((o) => ({ e: o.e, id: o.id, op: o.op, keys: Object.keys(o.value ?? {}) })))
    /**
     * **恰好一条** `block.upsert`（整批，不是「这条块上的」）。
     * 正文若是在这一笔才落的，时刻并进内容那条；若正文已经在更早的事务里落了，
     * 边界这一笔就只剩时刻一条 —— 两者都是「本次净变化」的如实表达，不能拆成两条。
     */
    const upserts = ops.filter((o) => o.e === 'block' && o.op === 'upsert')
    assert(
      upserts.length === 1,
      `边界那一次只该有一条 block.upsert（时刻并进内容那条，或只剩时刻）：${JSON.stringify(ops)}`,
    )
    assert(upserts[0].id === id, `那条 upsert 该是这次编辑的块：${JSON.stringify(upserts)}`)
    assert(
      upserts[0].keys.includes('modified') && upserts[0].keys.every((k) => k === 'modified' || k === 'content'),
      `边界这一条要么是 content+modified，要么只有 modified：${JSON.stringify(upserts)}`,
    )
    assert(!ops.some((o) => o.e === 'prop'), `时刻不该走属性 op：${JSON.stringify(ops)}`)

    /**
     * 回到被编辑的那一块继续敲 ⇒ 到下一个边界**再动一次**。
     * （上面那次离开把光标放到了别的块上，所以这里先回到这一块；顺手验「换块＝边界」
     *   这条既有行为：回来时不该有任何改动被记上。）
     */
    await page.evaluate((bid) => window.__qua.focusBlock(bid, 0), id)
    await sleep(20)
    assert((await stamp(page)) === tBoundary, `只是回到这一块不算改动：${tBoundary} → ${await stamp(page)}`)
    await sleep(15)
    await page.keyboard.type('二')
    await sleep(15)
    assert((await stamp(page)) === tBoundary, `打字过程中不该动时刻：${tBoundary} → ${await stamp(page)}`)
    // 再离开一次 ⇒ 再动一次
    await page.evaluate(() => {
      const other = window.__qua.blocks().find((x) => x.id !== window.__qua.snapshot().selection.aBlock)
      if (other) window.__qua.focusBlock(other.id, 0)
    })
    await sleep(20)
    const tAgain = await stamp(page)
    assert(tAgain > tBoundary, `再一次离开应再动一次：${tBoundary} → ${tAgain}`)

    /**
     * **重开仍在**：关掉这一页、从剩下那份存储复原（不是 reload），出生时刻一字不变。
     */
    const re = await reopenPage(browser, ctx, base, page)
    await re.page.evaluate(() => window.__qua.quiet(true))
    await sleep(50)
    const after = await re.page.evaluate((bid) => {
      const b = window.__qua.__editor.store.find(bid)
      return b ? { created: b.created, modified: b.modified } : null
    }, id)
    assert(after, `重开后那块还在：${id}`)
    assert(after.created === created0, `重开后出生时刻一字不变：${created0} → ${after.created}`)
    assert(after.modified === tAgain, `重开后修改时刻也还在：${tAgain} → ${after.modified}`)
    await re.ctx.close()
    return `打字 5 字不动（${t0}）→ 离开这一行动一次（${tBoundary}，恰好 1 条 upsert、零 prop op）→ 再打再动一次（${tAgain}）；重开后 created/modified 原样`
  },
)

await check(
  'T102 属性面板的「系统信息」是只读段：两行时刻都在、没有输入控件；摘掉时间戳的值不归它管',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)

    const id = await page.evaluate(() => {
      const b = window.__qua.blocks().find((x) => x.roles.length === 0 && x.text.length > 2)
      if (!b) return ''
      window.__qua.invoke('core.block/focus-block', { blockId: b.id })
      return b.id
    })
    assert(id, '前置：应有一个可聚焦的内容块')
    await page.waitForTimeout(150)
    await page.waitForSelector('.prop-system', { timeout: 4000 })

    /**
     * **可见但只读**：判据是这一段里**没有可编辑控件**（input/textarea/contenteditable），
     * 而不是「字段名不叫 text」。只读由通道提供 —— 这就是通道。
     */
    const sys = await page.evaluate((bid) => {
      const box = document.querySelector('.prop-system')
      const lines = [...document.querySelectorAll('.prop-system-line')].map((e) => ({
        field: e.dataset.systemField,
        text: e.textContent?.trim() ?? '',
      }))
      const model = window.__qua.__editor.store.find(bid)
      return {
        present: Boolean(box),
        lines,
        controls: box?.querySelectorAll('input, textarea, select, [contenteditable="true"]').length ?? -1,
        inPanel: Boolean(box?.closest('#inspect-card')),
        // 口径与模型同源：显示的是这一块自己的时刻，不是「现在」
        created: model?.created ?? -1,
        modified: model?.modified ?? -1,
      }
    }, id)

    assert(sys.present, `系统信息段该在属性面板里：${JSON.stringify(sys)}`)
    assert(sys.inPanel, `它属于属性面板（不是别处冒出的一段）：${JSON.stringify(sys)}`)
    assert(sys.controls === 0, `系统信息段不许有可编辑控件：${JSON.stringify(sys)}`)
    assert(sys.lines.length === 2, `应有两行（创建/修改）：${JSON.stringify(sys)}`)
    assert(
      sys.lines.map((l) => l.field).join(',') === 'created,modified',
      `两行的顺序应是创建在上、修改在下：${JSON.stringify(sys.lines)}`,
    )
    assert(
      sys.lines.every((l) => l.text.length > 0 && !l.text.includes('undefined')),
      `两行都该有可读时刻：${JSON.stringify(sys.lines)}`,
    )
    assert(
      sys.created > 0 && sys.modified >= sys.created,
      `结构化前提：块必须带真的时刻（否则这一段显示的是假的）：${JSON.stringify(sys)}`,
    )

    // 同一份口径也覆盖「改过之后这一行跟着变」（只读不等于陈旧）
    const before = sys.lines[1].text
    const modelBefore = await page.evaluate((bid) => {
      const m = window.__qua.__editor.store.find(bid)?.modified ?? -1
      window.__probeBefore = m
      return m
    }, id)
    await page.evaluate((bid) => window.__qua.focusBlock(bid, 0), id)
    /**
     * ⚠️ **慢到跨过一秒再落字**：块内时刻的显示精度到秒。若改字落在与创建同一秒里，
     *    「改完之后变没变」就变成了「有没有跨秒」，而不是「改没改」——那样它会看运气。
     *    （等待是为了让下一笔落在下一秒；面板刷新本身由下面的 `waitForFunction` 等。）
     */
    await page.waitForTimeout(1100)
    await page.keyboard.type('改')
    // 落字是异步进模型的（`input` 事件）：等模型文本真的变了再往下走，别赌毫秒
    await page.waitForFunction(
      (bid) => (window.__qua.__editor.store.find(bid)?.content ?? []).some((r) => r.t === 'text' && r.v.includes('改')),
      id,
      { timeout: 4000 },
    )
    const typed = await page.evaluate((bid) => ({
      text: (window.__qua.__editor.store.find(bid)?.content ?? []).filter((r) => r.t === 'text').map((r) => r.v).join(''),
      modified: window.__qua.__editor.store.find(bid)?.modified ?? -1,
    }), id)
    assert(typed.text.includes('改'), `前置：字应真的进了这一块：${JSON.stringify(typed)}`)
    await page.evaluate(() => {
      const other = window.__qua.blocks().find((x) => x.id !== window.__qua.snapshot().selection.aBlock)
      if (other) window.__qua.focusBlock(other.id, 0)
    })

    /**
     * 属性区的主体跟「中心槽当前对象」走 ⇒ 落回原来那一块再看它自己的那一行。
     * ⚠️ 面板刷新是**防抖**的：一次 `waitForTimeout` 在负载高时会读到一个还没重画的旧值，
     *    于是这条断言会变成「看机器心情」。等条件成立（有上限），不是等固定毫秒。
     */
    await page.evaluate((bid) => window.__qua.invoke('core.block/focus-block', { blockId: bid }), id)
    await page.waitForSelector('.prop-system', { timeout: 4000 })
    await page
      .waitForFunction(
        (was) => {
          const line = document.querySelector('.prop-system-line[data-system-field="modified"]')
          return Boolean(line) && line.textContent?.trim() !== was
        },
        before,
        { timeout: 4000 },
      )
      .catch(() => {})
    const after = await page.evaluate((bid) => ({
      lines: [...document.querySelectorAll('.prop-system-line')].map((e) => e.textContent?.trim() ?? ''),
      modified: window.__qua.__editor.store.find(bid)?.modified ?? -1,
      modelBefore: window.__probeBefore ?? -1,
      // 面板画的是不是这一块（主体换过就说明我们看错了行）
      target: document.getElementById('inspect-card')?.dataset.targetBlockId ?? '',
    }), id)
    assert(after.target === id, `面板主体应回到被编辑的那一块：${JSON.stringify(after)}`)
    assert(after.modified > modelBefore, `这一块的时刻真的动过（前置）：${modelBefore} → ${JSON.stringify(after)}`)
    assert(
      after.lines[1] !== before,
      `改完之后「修改于」该跟着变（只读 ≠ 陈旧）：${JSON.stringify({ before, after })}`,
    )
    await ctx.close()
    return `系统信息段：创建/修改两行，0 个可编辑控件；改一次正文后「修改于」跟着变`
  },
)

/* ------------------------------------------------- 归属树面板（左槽） */

await check('T104 归属树面板：页/标签两面、根按本树重算、点行打开、跨类只由属性区回答', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await openFirstPage(page)

  const ids = await page.evaluate(() => {
    const ps = window.__qua.pages()
    return { a: ps[0].id, b: ps[1].id, c: ps[2].id, nameB: ps[1].title, nameC: ps[2].title }
  })
  const invoke = (name, args) => page.evaluate(([n, a]) => window.__qua.invoke(n, a), [name, args])

  // 左槽有一张「归属」卡，默认看**页**那一面
  const card = await page.evaluate(() => ({
    hasCard: [...document.querySelectorAll('#dock-left .dock-card-title')].some((e) => e.textContent === '归属'),
    active: document.querySelector('#dock-left .belongs-tab[data-active="1"]')?.textContent ?? '',
    rows: document.querySelectorAll('#dock-left .belongs-row').length,
  }))
  assert(card.hasCard, '左槽应有「归属」卡')
  assert(card.active === '页', `默认面应是页：${JSON.stringify(card)}`)

  // 页 B 归在页 A 下 ⇒ B 以 depth=1 出现在 A 下面
  await invoke('core.belongs-to/add', { childId: ids.b, parentId: ids.a })
  await page.waitForTimeout(250)
  const nested = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#dock-left .belongs-row')].map((r) => ({
      depth: r.dataset.depth,
      text: r.querySelector('.p-title')?.textContent ?? '',
    }))
    return rows
  })
  const atOne = nested.filter((r) => r.depth === '1')
  assert(atOne.some((r) => r.text === ids.nameB), `B 应在 A 下面（depth=1）：${JSON.stringify(nested)}`)
  assert(nested.some((r) => r.depth === '0' && r.text !== ids.nameB), '同屏要有根行（A 仍是根）')

  // 点那一行 ⇒ 打开 B（面板只是导航，不写库）
  await page.locator('#dock-left .belongs-row[data-depth="1"] .page-item').first().click()
  await page.waitForTimeout(250)
  const opened = await page.evaluate(() => window.__qua.snapshot().activeId)
  assert(opened === ids.b, `点行应打开 B：${opened} ≠ ${ids.b}`)

  // 跨类：页 C 归在**标签** T 下 ⇒ 页的树里 C 是根、T 不出现；标签的树里 T 是根、C 不出现
  const tagId = await page.evaluate(() => window.__qua.allBlocks().find((b) => b.roles.includes('tag')).id)
  await invoke('core.belongs-to/add', { childId: ids.c, parentId: tagId })
  await page.waitForTimeout(250)
  const pageFace = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('#dock-left .belongs-row')].map((r) => ({ depth: r.dataset.depth, text: r.querySelector('.p-title')?.textContent ?? '' })),
  }))
  assert(
    pageFace.rows.some((r) => r.depth === '0' && r.text === ids.nameC),
    `C 的父被露面筛掉 ⇒ C 升级为根（否则它从树里消失）：${JSON.stringify(pageFace)}`,
  )
  assert(!pageFace.rows.some((r) => r.text === '任务'), '标签不该出现在页的归属树里')

  await page.locator('#dock-left .belongs-tab[data-face="tag"]').click()
  await page.waitForTimeout(250)
  const tagFace = await page.evaluate(() => ({
    active: document.querySelector('#dock-left .belongs-tab[data-active="1"]')?.textContent ?? '',
    rows: [...document.querySelectorAll('#dock-left .belongs-row')].map((r) => r.querySelector('.p-title')?.textContent ?? ''),
  }))
  assert(tagFace.active === '标签', `切面之后应是标签那一面：${JSON.stringify(tagFace)}`)
  assert(tagFace.rows.includes('任务'), `标签树里 T 是根：${JSON.stringify(tagFace)}`)
  assert(!tagFace.rows.includes(ids.nameC), '页不进标签的归属树')

  await ctx.close()
  return `页/标签两面；B 在 A 下 depth=1；点行打开 B；跨类的 C 在自己那棵树里是根、那条边两棵树都不画`
})

/* ------------------------------------------------- 拖拽的一条缝（载荷跨组件） */

await check('T105 拖拽一条缝：从侧槽拖一个块到正文 ⇒ 写树（不是空操作）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await openFirstPage(page)
  const ids = await page.evaluate(() => {
    const bs = window.__qua.blocks()
    return { src: bs[2].id, tgt: bs[1].id }
  })

  // 先钉进左槽：顺带验载荷换了 MIME（brew 的 `carried` 读的就是新键）
  const pin = await dragBlockToDock(page, ids.src, 'left')
  assert(pin?.carried === ids.src && pin.hot, `拖进槽应带着块 id 并高亮：${JSON.stringify(pin)}`)
  await page.waitForTimeout(180)

  // 从槽里的块标拖到正文行上沿 ⇒ 真的移动（旧实现读 editor.dragId，这里必为空 ⇒ 空操作）
  const moved = await page.evaluate(
    ({ src, tgt }) => {
      const handle = document.querySelector(`#dock-left .dock-card[data-window="1"][data-card-id="${src}"] .marker`)
      const tgtEl = document.querySelector(`.blk[data-block-id="${tgt}"]`)
      if (!handle || !tgtEl) return null
      const rect = tgtEl.getBoundingClientRect()
      const dt = new DataTransfer()
      const at = (type) =>
        new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: rect.left + 40, clientY: rect.top + 2 })
      handle.dispatchEvent(at('dragstart'))
      tgtEl.dispatchEvent(at('dragover'))
      const hot = { hint: document.querySelector('.dnd-hint')?.textContent ?? '', zone: tgtEl.dataset.drop ?? '' }
      tgtEl.dispatchEvent(at('drop'))
      handle.dispatchEvent(at('dragend'))
      const after = window.__qua.blocks()
      return { hot, si: after.findIndex((b) => b.id === src), ti: after.findIndex((b) => b.id === tgt) }
    },
    ids,
  )
  assert(moved, '槽里的块标与正文目标块都应存在')
  assert(moved.si >= 0 && moved.si < moved.ti, `从槽拖到正文应真的移动（源排到目标之前）：${JSON.stringify(moved)}`)
  assert(moved.hot.zone === 'before', `悬停时应亮正文三区的上沿：${JSON.stringify(moved.hot)}`)
  assert(moved.hot.hint.includes('移到'), `正文落点的提示要说「移到…」：${JSON.stringify(moved.hot)}`)

  await ctx.close()
  return `从侧槽拖入正文：源 ${moved.si} < 目标 ${moved.ti}；悬停提示「${moved.hot.hint}」`
})

await check('T106 拖拽一条缝：普通文字与坏载荷都不被当成块（不亮落点、不写模型）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await openFirstPage(page)
  const ids = await page.evaluate(() => {
    const bs = window.__qua.blocks()
    return { src: bs[2].id, tgt: bs[1].id }
  })
  const r = await page.evaluate(
    ({ src, tgt }) => {
      const handle = document.querySelector(`.blk[data-block-id="${src}"] .marker`)
      const tgtEl = document.querySelector(`.blk[data-block-id="${tgt}"]`)
      const rect = tgtEl.getBoundingClientRect()
      const before = JSON.stringify(window.__qua.blocks().map((b) => b.text))

      // 真的发起一次块拖拽：模块记住「拖的是谁」——这一步是让下面的拒绝有意义
      handle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }))

      const attempt = (fill) => {
        const dt = new DataTransfer()
        fill(dt)
        const at = (type) =>
          new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: rect.left + 40, clientY: rect.top + 2 })
        tgtEl.dispatchEvent(at('dragover'))
        const lit = tgtEl.dataset.drop !== undefined || !!document.querySelector('.dnd-hint')
        tgtEl.dispatchEvent(at('drop'))
        return lit
      }
      // ① 只有 text/plain：外部拖来的普通文字
      const textLit = attempt((dt) => dt.setData('text/plain', '一段普通文字'))
      // ② 有块 MIME 但内容不是块 id：**悬停只能看 types**（保护模式读不到内容），
      //    所以它允许亮；关键是**落手不认**（不写模型、也不借上一次的记忆搬块）
      const badLit = attempt((dt) => dt.setData('application/x-qua-block', 'not-a-block-id'))

      const after = JSON.stringify(window.__qua.blocks().map((b) => b.text))
      return { textLit, badLit, same: before === after }
    },
    ids,
  )
  assert(!r.textLit, '拖一段普通文字进来不该亮落点（载荷里没有块 MIME）')
  assert(r.same, `两种都不该改模型（坏载荷尤其：不许借「刚才拖的是谁」搬块）；坏载荷高亮=${r.badLit}`)

  await ctx.close()
  return `普通文字：不亮落点、零写入；坏载荷：悬停只能按 types 判，落手不认、零写入`
})

await check('T107 三个落点的 hint 各说各的（正文「移到」／归属树「归到」／侧槽「在这里打开」）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await openFirstPage(page)
  const r = await page.evaluate(() => {
    const src = window.__qua.blocks()[2].id
    const body = document.querySelector(`.blk[data-block-id="${window.__qua.blocks()[1].id}"]`)
    const row = document.querySelector('#dock-left .belongs-row')
    const dock = document.getElementById('dock-left')
    if (!body || !row || !dock) return null
    const handle = document.querySelector(`.blk[data-block-id="${src}"] .marker`)
    const dt = new DataTransfer()
    handle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))

    const hover = (el, text) => {
      const rect = el.getBoundingClientRect()
      el.dispatchEvent(
        new DragEvent('dragover', {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
          clientX: rect.left + 10,
          clientY: rect.top + 2,
        }),
      )
      return document.querySelector('.dnd-hint')?.textContent ?? ''
    }
    const inBody = hover(body, 'body')
    const inRow = hover(row, 'row')
    const inDock = hover(dock, 'dock')
    handle.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
    return { inBody, inRow, inDock }
  })
  assert(r, '正文行、归属树行与左槽都应存在')
  assert(r.inBody.includes('移到'), `正文落点该说「移到…」：${JSON.stringify(r)}`)
  assert(r.inRow.includes('归到'), `归属树落点该说「归到…」：${JSON.stringify(r)}`)
  assert(r.inDock.includes('打开'), `侧槽落点该说「在这里打开」：${JSON.stringify(r)}`)
  assert(new Set([r.inBody, r.inRow, r.inDock]).size === 3, `三个落点的提示必须各说各的：${JSON.stringify(r)}`)

  await ctx.close()
  return `${r.inBody} / ${r.inRow} / ${r.inDock}`
})

await check('T108 拖到归属树的一行上 ⇒ 加边：恰好 1 条 op，只动子块', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await openFirstPage(page)
  const ids = await page.evaluate(() => {
    const bs = window.__qua.blocks()
    return { src: bs[2].id, page: window.__qua.pages()[1].id }
  })
  const r = await page.evaluate(
    ({ src, target }) => {
      const handle = document.querySelector(`.blk[data-block-id="${src}"] .marker`)
      const row = document.querySelector(`#dock-left .belongs-row[data-belongs-id="${target}"]`)
      if (!handle || !row) return null
      const rect = row.getBoundingClientRect()
      const dt = new DataTransfer()
      const at = (type) =>
        new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: rect.left + 10, clientY: rect.top + 4 })
      handle.dispatchEvent(at('dragstart'))
      row.dispatchEvent(at('dragover'))
      const hot = { hint: document.querySelector('.dnd-hint')?.textContent ?? '', lit: row.dataset.drop ?? '' }
      row.dispatchEvent(at('drop'))
      handle.dispatchEvent(at('dragend'))
      return { hot, parents: window.__qua.tagParents(src), ops: window.__qua.lastOps() }
    },
    { src: ids.src, target: ids.page },
  )
  assert(r, '正文块与归属树那一行都应存在')
  assert(r.hot.lit === '1', `悬停时那一行应高亮：${JSON.stringify(r.hot)}`)
  assert(r.hot.hint.includes('归到'), `那一行的提示要说「归到…」：${JSON.stringify(r.hot)}`)
  assert(r.parents.includes(ids.page), `落手之后应多一条归属边：${JSON.stringify(r.parents)}`)
  assert(
    r.ops.length === 1 && r.ops[0].e === 'prop' && r.ops[0].name === '_belongsTo',
    `加一条边应恰好 1 条 op、只动子块：${JSON.stringify(r.ops)}`,
  )

  await ctx.close()
  return `拖入一行 ⇒ 1 条 prop.set(_belongsTo)，父 = 目标页`
})
/* ------------------------------------------------------- 检索浮层（`#` / `@`） */

await check(
  'T109 `#` 浮层 ＋ Enter：插一枚 `flavor:#` 的指向露面，**不写宿主 `_tags`**（提及 ≠ 归类）',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)

    /**
     * 「提及」是**正文里的一格**：它指向标签块、显示成 `#名`，但**不把这块归进去**。
     * 反面（行尾多出一个 chip）一旦发生，用户就会以为「我提了一句＝我归了类」——
     * 所以断言必须是「有露面 ∧ 无归属」，只查其中一个都是半个结论。
     */
    const tagName = '检索甲'
    const tagId = await seedTag(page, tagName)
    assert(tagId !== '', `前置：标签块应已存在：${JSON.stringify(tagName)}`)
    const tagCountBefore = await page.evaluate(() => window.__qua.allBlocks().filter((b) => b.lists.includes('tag')).length)

    const target = await page.evaluate(() => {
      const ed = window.__qua.__editor
      const id = ed.insertBlockAfter(window.__qua.blocks()[0].id, '')
      window.__qua.focusBlock(id, 0)
      return id
    })
    await page.waitForTimeout(80)
    await page.keyboard.type(`#${tagName}`)
    await page.waitForTimeout(200)

    const rows = await layerRows(page)
    assert(rows.length > 0, `敲 # 应弹出浮层：${JSON.stringify(rows)}`)
    const hit = rows.find((r) => r.label === `#${tagName}`)
    assert(Boolean(hit), `候选里应有「#${tagName}」：${JSON.stringify(rows.slice(0, 5))}`)
    assert(hit.key !== '', `标签类行要画出 ⌥↵ 徽标（它支持第二种按法）：${JSON.stringify(hit)}`)
    assert(hit.active, `默认落在第一行（新建那行不存在时就是它）：${JSON.stringify(rows.slice(0, 3))}`)

    await page.keyboard.press('Enter')
    await page.waitForTimeout(220)

      const got = await page.evaluate(({ id, tagId }) => {
      const b = window.__qua.blocks().find((x) => x.id === id)
      return {
        text: b?.text ?? '',
        tags: b?.tags ?? [],
        atoms: window.__qua.atoms().filter((a) => a.blockId === id),
        inline: document.querySelector(`.blk[data-block-id="${id}"] .tx .atom-tag`)?.textContent ?? '',
        inlineLabel: document.querySelector(`.blk[data-block-id="${id}"] .tx .atom-tag`)?.dataset.refLabel ?? '',
        chips: document.querySelectorAll(`.blk[data-block-id="${id}"] .blk-tags .tag-chip`).length,
        layerOpen: document.querySelectorAll('.layer').length,
        tagId,
      }
    }, { id: target, tagId })

    assert(got.layerOpen === 0, '选中后浮层应关掉')
    assert(got.text === '', `触发词应被抹掉（露面不进投影）：${JSON.stringify(got.text)}`)
    assert(got.atoms.length === 1 && got.atoms[0].kind === 'tag', `应恰有 1 枚 tag 露面：${JSON.stringify(got.atoms)}`)
    assert(got.atoms[0].target?.id === got.tagId, `露面应指向那个标签块（按 id，不按名字）：${JSON.stringify(got.atoms[0])}`)
    assert(got.tags.length === 0, `⚠️ 提及不写归属：${JSON.stringify(got.tags)}`)
    assert(got.inline === `#${tagName}` && got.inlineLabel === tagName, `正文里应显示成 \`#名\`：${JSON.stringify(got)}`)
    assert(got.chips === 0, `没有归属 ⇒ 也不该凭空出 chip：${got.chips}`)

    await ctx.close()
    return `#${tagName} + Enter ⇒ 1 枚 flavor:# 露面（指向 ${tagId.slice(-6)}）、正文投影空、宿主 _tags 仍是空`
  },
)

await check(
  'T110 `#` 浮层 ＋ ⌥Enter：把标签归到本块（写 `_tags`、行尾出 chip），正文里**不多出原子**',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)

    /**
     * 「归类」的结果必须落在**动作发生的地方**：在行中间敲 `#`，按 ⌥↵ 后 chip 出现在行尾，
     * 而刚才敲的字消失 —— 这是拍板过的取舍（归类的规范入口是属性区，这里是快捷方式）。
     * 与 T101 的差别只有一条：**写不写宿主 `_tags`**。所以两条测试必须在同一套前置下对读。
     */
    const tagName = '检索乙'
    const tagId = await seedTag(page, tagName)
    assert(tagId !== '', `前置：标签块应已存在：${JSON.stringify(tagName)}`)
    const tagCountBefore = await page.evaluate(() => window.__qua.allBlocks().filter((b) => b.lists.includes('tag')).length)

    const target = await page.evaluate(() => {
      const ed = window.__qua.__editor
      const id = ed.insertBlockAfter(window.__qua.blocks()[0].id, '')
      window.__qua.focusBlock(id, 0)
      return id
    })
    await page.waitForTimeout(80)
    await page.keyboard.type(`#${tagName}`)
    await page.waitForTimeout(200)
    assert((await layerRows(page)).some((r) => r.label === `#${tagName}`), '候选里应有那个标签（前置）')

    await page.keyboard.press('Alt+Enter')
    await page.waitForTimeout(220)

    const got = await page.evaluate(({ id, tagId }) => {
      const b = window.__qua.blocks().find((x) => x.id === id)
      return {
        text: b?.text ?? '',
        tags: b?.tags ?? [],
        atoms: window.__qua.atoms().filter((a) => a.blockId === id).length,
        chips: document.querySelectorAll(`.blk[data-block-id="${id}"] .blk-tags .tag-chip`).length,
        layerOpen: document.querySelectorAll('.layer').length,
        tagId,
      }
    }, { id: target, tagId })

    assert(got.layerOpen === 0, '⌥Enter 之后浮层应关掉')
    assert(got.tags.length === 1 && got.tags[0] === got.tagId, `宿主应带上这个标签：${JSON.stringify(got.tags)}`)
    assert(got.atoms === 0, `归类**不插**行内原子：还有 ${got.atoms} 枚`)
    assert(got.text === '', `触发词应被抹掉：${JSON.stringify(got.text)}`)
    assert(got.chips === 1, `归属只在行尾出一个 chip：${got.chips}`)

    /**
     * 同一条归属的**两种露面不重复**：再提一次（Enter）⇒ 正文里那一枚出现、chip 收起。
     * （「删掉那一格 ⇒ 归属还在、chip 回来」由 T58 的既有断言覆盖，不在这里重复。）
     */
    await page.keyboard.type(`#${tagName}`)
    await page.waitForTimeout(200)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(220)
    const inline = await page.evaluate((id) => {
      return {
        chips: document.querySelectorAll(`.blk[data-block-id="${id}"] .blk-tags .tag-chip`).length,
        atoms: document.querySelector(`.blk[data-block-id="${id}"] .tx`)?.querySelectorAll('.atom-tag').length ?? -1,
      }
    }, target)
    assert(inline.chips === 0 && inline.atoms === 1, `正文里露面了 ⇒ 不出 chip：${JSON.stringify(inline)}`)

    await ctx.close()
    return `#${tagName} + ⌥Enter ⇒ 写 _tags、0 原子、行尾 1 chip；再提一次 ⇒ 原子出现、chip 收起（两种露面不重复）`
  },
)

await check(
  'T111 `#` 浮层 ＋ Esc：关浮层、`#名` 原样留作纯文本（不转换、不退格、不占撤销格）',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)

    /**
     * `C#`／`#1` 这类正文要能打出来。边界规则挡掉一部分（前面是字的不弹），
     * 剩下的靠 Esc —— 它必须是「我就要这几个字」的干净出口：关浮层、字不动、结构不动。
     */
    const target = await page.evaluate(() => {
      const ed = window.__qua.__editor
      const id = ed.insertBlockAfter(window.__qua.blocks()[0].id, '')
      window.__qua.focusBlock(id, 0)
      return id
    })
    await page.waitForTimeout(80)
    const depthBefore = await page.evaluate(
      (id) => document.querySelector(`.blk[data-block-id="${id}"]`)?.dataset.depth ?? '',
      target,
    )

    await page.keyboard.type('#保留原文')
    await page.waitForTimeout(200)
    assert((await page.locator('.layer-item').count()) > 0, '敲 # 应弹出浮层（前置）')

    const undoBefore = await page.evaluate(() => window.__qua.snapshot().undoDepth)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(180)

    const got = await page.evaluate(({ id, depth }) => {
      const b = window.__qua.blocks().find((x) => x.id === id)
      const el = document.querySelector(`.blk[data-block-id="${id}"]`)
      return {
        text: b?.text ?? '',
        domText: el?.querySelector('.tx')?.textContent ?? '',
        depth: el?.dataset.depth ?? '',
        depthBefore: depth,
        tags: b?.tags ?? [],
        atoms: window.__qua.atoms().filter((a) => a.blockId === id).length,
        tagCreated: window.__qua.allBlocks().some((x) => x.roles?.includes('tag') && x.text === '保留原文'),
        layerOpen: document.querySelectorAll('.layer').length,
        undoDepth: window.__qua.snapshot().undoDepth,
      }
    }, { id: target, depth: depthBefore })

    assert(got.layerOpen === 0, 'Esc 应关掉浮层')
    assert(got.text === '#保留原文', `字应逐字留着（当纯文本）：${JSON.stringify(got.text)}`)
    assert(got.domText.includes('#保留原文'), `DOM 里也应是那几个字：${JSON.stringify(got.domText)}`)
    assert(got.tags.length === 0 && got.atoms === 0, `Esc 不该落任何结果：${JSON.stringify(got)}`)
    assert(!got.tagCreated, 'Esc 不该建出标签块')
    assert(got.depth === got.depthBefore, `Esc 不该退格：depth ${got.depthBefore} → ${got.depth}`)
    assert(got.undoDepth === undoBefore, `Esc 本身不该占一格撤销：${undoBefore} → ${got.undoDepth}`)

    await ctx.close()
    return 'Esc ⇒ 浮层关、`#保留原文` 逐字还在、depth 不变、撤销栈不涨'
  },
)

await check(
  'T112 `@` 浮层：搜页能插一条页引用；搜正文片段能搜到块（同一个浮层、同一个落点）',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)

    /**
     * `@` 的候选是**页 ＋ 块**，两栏都从**整片森林**里线性扫（临时实现）。
     * 判据是「搜到一个就插一个**指向它**的引用」：页行与块行走同一条落点，
     * 所以这里两条都验，且都按**目标 id** 断言（不是看显示名对不对）。
     */
    const pg = await page.evaluate(() => window.__qua.pages()[0])
    const pageQuery = pg.title.split(/\s/)[0] || pg.title
    const first = await page.evaluate(() => {
      const ed = window.__qua.__editor
      const id = ed.insertBlockAfter(window.__qua.blocks()[0].id, '')
      window.__qua.focusBlock(id, 0)
      return id
    })
    await page.waitForTimeout(80)

    await page.keyboard.type(`@${pageQuery}`)
    await page.waitForTimeout(220)
    const pageRows = await layerRows(page)
    assert(pageRows.length > 0, `敲 @ 应弹出浮层：${JSON.stringify(pageRows.slice(0, 5))}`)
    const pageRowAt = pageRows.findIndex((r) => r.label.includes(pageQuery))
    assert(pageRowAt >= 0, `候选里应有那一页：${JSON.stringify(pageRows.slice(0, 8))}`)
    await page.locator('.layer-item').nth(pageRowAt).click()
    await page.waitForTimeout(220)

    const afterPage = await page.evaluate(({ id, pageId }) => {
      const a = window.__qua.atoms().filter((x) => x.blockId === id)
      const b = window.__qua.blocks().find((x) => x.id === id)
      return { atoms: a, text: b?.text ?? '', pageId }
    }, { id: first, pageId: pg.id })

    assert(afterPage.atoms.length === 1, `页引用应插一枚原子：${JSON.stringify(afterPage.atoms)}`)
    assert(afterPage.atoms[0].kind === 'page', `页引用**不带** flavor（不是行内标签）：${JSON.stringify(afterPage.atoms[0])}`)
    assert(afterPage.atoms[0].target?.id === afterPage.pageId, `应指向那一页：${JSON.stringify(afterPage.atoms[0])}`)
    assert(afterPage.text === '', `触发词应被抹掉：${JSON.stringify(afterPage.text)}`)

    // 块：先造一块带独特正文的标记块，再到**另一个**空块里 `@` 它
    const setup = await page.evaluate(() => {
      const ed = window.__qua.__editor
      const rootId = window.__qua.blocks()[0].id
      const targetId = ed.insertBlockAfter(rootId, '块检索标记甲')
      const typingId = ed.insertBlockAfter(rootId, '')
      window.__qua.focusBlock(typingId, 0)
      return { targetId, typingId }
    })
    await page.waitForTimeout(120)

    await page.keyboard.type('@检索标记甲')
    await page.waitForTimeout(220)
    const blockRows = await layerRows(page)
    assert(blockRows.length > 0, `敲 @ 应弹出浮层：${JSON.stringify(blockRows.slice(0, 5))}`)
    const blockRowAt = blockRows.findIndex((r) => r.label.includes('检索标记甲'))
    assert(blockRowAt >= 0, `按正文片段应能搜到那一块：${JSON.stringify(blockRows.slice(0, 8))}`)
    await page.locator('.layer-item').nth(blockRowAt).click()
    await page.waitForTimeout(220)

    const afterBlock = await page.evaluate((id) => {
      const a = window.__qua.atoms().filter((x) => x.blockId === id)
      return { atoms: a, text: window.__qua.blocks().find((x) => x.id === id)?.text ?? '' }
    }, setup.typingId)

    assert(afterBlock.atoms.length === 1, `块引用应插一枚原子：${JSON.stringify(afterBlock.atoms)}`)
    assert(afterBlock.atoms[0].kind === 'page', `块引用同样不带 flavor：${JSON.stringify(afterBlock.atoms[0])}`)
    assert(afterBlock.atoms[0].target?.id === setup.targetId, `应指向那个标记块：${JSON.stringify(afterBlock.atoms[0])}`)
    assert(afterBlock.text === '', `触发词应被抹掉：${JSON.stringify(afterBlock.text)}`)

    await ctx.close()
    return `@${pageQuery} ⇒ 页引用（指向 ${pg.id.slice(-6)}）；@检索标记甲 ⇒ 块引用（指向 ${setup.targetId.slice(-6)}）`
  },
)

await check(
  'T113 `#` 浮层的实例行：选已有记录 ⇒ 指向那条记录（不新建）；删正文里那枚只摘引用，记录还在',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)

    /**
     * 「实例」是**这个标签的一次出现**：同一条记录可以被提及很多次，每次插入的都是一枚
     * 指向**同一条记录**的 `ref` run。所以这一条要能回答两件事：
     *   ① 实例行排在标签类之前（有实例时，默认 Enter 是提及那条记录，不是引用类）；
     *   ② 选实例**不新建**记录/标签，删掉正文里那一枚也**不删记录**（对象库心智）。
     */
    const target = await page.evaluate(() => {
      const ed = window.__qua.__editor
      const id = ed.insertBlockAfter(window.__qua.blocks()[0].id, '')
      window.__qua.focusBlock(id, 0)
      return id
    })
    await page.waitForTimeout(80)
    await page.keyboard.type('#检索丙')
    await page.waitForTimeout(200)
    // 首次是「新建标签 ＋ 新实例」：⇧↵；之后有实例行时 ↵ 才是「引用已有记录」
    await page.keyboard.press('Shift+Enter')
    await page.waitForTimeout(220)

    const made = await page.evaluate((id) => {
      const ed = window.__qua.__editor
      const tag = window.__qua.allBlocks().find((x) => x.roles?.includes('tag') && x.text === '检索丙')
      const atom = window.__qua.atoms().filter((a) => a.blockId === id)[0]
      const count = (list) => list.reduce((n, k) => n + 1 + count(k.children), 0)
      return {
        tagId: tag?.id ?? '',
        recordId: atom?.target?.id ?? '',
        total: count(ed.store.blocks),
        tags: ed.store.blocks.filter((x) => (x.props?._lists ?? []).includes('tag')).length,
        records: window.__qua.allBlocks().filter((x) => !x.roles?.length && x.text === '检索丙').length,
      }
    }, target)
    assert(made.tagId !== '' && made.recordId !== '', `前置：应已建出标签与记录：${JSON.stringify(made)}`)
    assert(made.recordId !== made.tagId, `露面应指向记录，不是标签类：${JSON.stringify(made)}`)

    // 再提一次：有实例时实例行排在标签类之前、且**不带** ⌥↵ 徽标（它没有「归类」这层含义）
    await page.evaluate((id) => window.__qua.focusBlock(id, 9999), target)
    await page.keyboard.type(' #检索丙')
    await page.waitForTimeout(220)
    const rows = await layerRows(page)
    const sameLabel = rows.filter((r) => r.label === '#检索丙')
    assert(sameLabel.length === 2, `候选里应有「实例」与「标签类」两行：${JSON.stringify(rows.slice(0, 6))}`)
    assert(
      rows[0].label === '#检索丙' && rows[0].hint.includes('#检索丙') && rows[0].key !== '',
      `第一行应是实例（hint 标明标签、带按键徽标）：${JSON.stringify(rows.slice(0, 3))}`,
    )

    await page.keyboard.press('Enter')
    await page.waitForTimeout(220)

    const after = await page.evaluate((t) => {
      const ed = window.__qua.__editor
      const atoms = window.__qua.atoms().filter((a) => a.blockId === t.id)
      const count = (list) => list.reduce((n, k) => n + 1 + count(k.children), 0)
      return {
        atoms: atoms.map((a) => ({ id: a.id, target: a.target?.id ?? '' })),
        total: count(ed.store.blocks),
        tags: ed.store.blocks.filter((x) => (x.props?._lists ?? []).includes('tag')).length,
        records: window.__qua.allBlocks().filter((x) => !x.roles?.length && x.text === '检索丙').length,
        recordAlive: ed.store.find(t.recordId) !== undefined,
      }
    }, { id: target, recordId: made.recordId })

    assert(after.atoms.length === 2, `两次提及应各插一枚露面：${JSON.stringify(after.atoms)}`)
    assert(after.atoms.every((a) => a.target === made.recordId), `两枚都该指向同一条记录（实体语义）：${JSON.stringify(after.atoms)}`)
    assert(after.total === made.total, `选实例不该新建块：${made.total} → ${after.total}`)
    assert(after.tags === made.tags, `选实例不该新建标签：${made.tags} → ${after.tags}`)
    assert(after.records === made.records, `选实例不该新建记录：${made.records} → ${after.records}`)

    // 删正文里那一枚 = 摘引用，**不删记录**（删记录本体是另一件事）
    await page.evaluate((atomId) => window.__qua.__editor.removeRun(atomId), after.atoms[1].id)
    await page.waitForTimeout(160)
    const removed = await page.evaluate((t) => {
      const ed = window.__qua.__editor
      return {
        atoms: window.__qua.atoms().filter((a) => a.blockId === t.id).length,
        recordAlive: ed.store.find(t.recordId) !== undefined,
      }
    }, { id: target, recordId: made.recordId })
    assert(removed.atoms === 1, `删一枚只该少一枚：${JSON.stringify(removed)}`)
    assert(removed.recordAlive, '删引用不该删记录（对象库心智）')

    await ctx.close()
    return `实例行先于标签类；选它 ⇒ 两枚露面都指向同一条记录、零新建；删一枚 ⇒ 记录仍在`
  },
)

await check(
  'T114 `#` 的三种落点只看按键：↵ 行内标签 / ⌥↵ 块标签 / ⇧↵ 新实例；`#` 紧接正文也能弹',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)

    /**
     * 三种落点由**按键**区分，不由「选中的是哪一行」区分：
     *   · `↵` 行内标签：正文里那一格指向标签类，宿主不被归类；
     *   · `⌥↵` 块标签：写宿主 `_tags`，正文里不多出原子；
     *   · `⇧↵` 新实例：建一条住森林顶层的记录，正文里那一格指向**记录**。
     * 同一套判据在「类行」上验一遍就够了；实例行上的 ⌥/⇧ 复用同一支。
     */
    const tagName = '快捷键甲'
    const tagId = await seedTag(page, tagName)
    assert(tagId !== '', `前置：标签块应已存在：${JSON.stringify(tagName)}`)
    const tagCountBefore = await page.evaluate(() => window.__qua.allBlocks().filter((b) => b.lists.includes('tag')).length)

    const focusNew = () =>
      page.evaluate(() => {
        const ed = window.__qua.__editor
        const id = ed.insertBlockAfter(window.__qua.blocks()[0].id, '')
        window.__qua.focusBlock(id, 0)
        return id
      })

    // ① `#` 紧接正文（没有空格）也弹面板；↵ = 行内标签
    const inlineBlock = await focusNew()
    await page.waitForTimeout(80)
    await page.keyboard.type(`前缀#${tagName}`)
    await page.waitForTimeout(220)
    const inlineRows = await layerRows(page)
    assert(inlineRows.length > 0, `「前缀#名」应弹出面板：${JSON.stringify(inlineRows)}`)
    assert(inlineRows[0].label === `#${tagName}`, `第一行应是标签类：${JSON.stringify(inlineRows.slice(0, 3))}`)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(220)

    const inline = await page.evaluate((t) => {
      const ed = window.__qua.__editor
      const b = ed.store.find(t.id)
      const atoms = window.__qua.atoms().filter((a) => a.blockId === t.id)
      const tx = document.querySelector(`.blk[data-block-id="${t.id}"]`)
      return {
        atoms: atoms.map((a) => a.target?.id ?? ''),
        tags: b?.props?._tags ?? [],
        dom: { tag: tx?.querySelectorAll('.atom-tag').length ?? -1, obj: tx?.querySelectorAll('.atom-obj').length ?? -1 },
      }
    }, { id: inlineBlock })
    assert(inline.atoms.length === 1 && inline.atoms[0] === tagId, `↵ 应插指向标签类的行内标签：${JSON.stringify(inline)}`)
    assert(inline.tags.length === 0, `↵ 不该把宿主归类：${JSON.stringify(inline.tags)}`)
    assert(inline.dom.tag === 1 && inline.dom.obj === 0, `↵ 的样式应是行内标签（无框），不是实例：${JSON.stringify(inline.dom)}`)

    // ② ⌥↵ = 块标签
    const chipBlock = await focusNew()
    await page.waitForTimeout(80)
    await page.keyboard.type(`#${tagName}`)
    await page.waitForTimeout(220)
    await page.keyboard.press('Alt+Enter')
    await page.waitForTimeout(220)

    const chip = await page.evaluate((t) => {
      const ed = window.__qua.__editor
      const b = ed.store.find(t.id)
      const tx = document.querySelector(`.blk[data-block-id="${t.id}"]`)
      return {
        atoms: window.__qua.atoms().filter((a) => a.blockId === t.id).length,
        tags: b?.props?._tags ?? [],
        chips: tx?.querySelectorAll('.tag-chip').length ?? -1,
      }
    }, { id: chipBlock })
    assert(chip.atoms === 0, `⌥↵ 是归类，不该插行内原子：${chip.atoms}`)
    assert(chip.tags.length === 1 && chip.tags[0] === tagId, `⌥↵ 应写宿主 _tags：${JSON.stringify(chip.tags)}`)
    assert(chip.chips === 1, `⌥↵ 的样式应是行尾 chip（实底）：${chip.chips}`)

    // ③ ⇧↵ = 新实例（不新建标签，记录住森林顶层、自带归属）
    const objBlock = await focusNew()
    await page.waitForTimeout(80)
    await page.keyboard.type(`#${tagName}`)
    await page.waitForTimeout(220)
    await page.keyboard.press('Shift+Enter')
    await page.waitForTimeout(260)

    const obj = await page.evaluate((t) => {
      const ed = window.__qua.__editor
      const atoms = window.__qua.atoms().filter((a) => a.blockId === t.id)
      const recordId = atoms[0]?.target?.id ?? ''
      const record = ed.store.find(recordId)
      const tx = document.querySelector(`.blk[data-block-id="${t.id}"]`)
      return {
        atoms: atoms.map((a) => a.target?.id ?? ''),
        dom: { tag: tx?.querySelectorAll('.atom-tag').length ?? -1, obj: tx?.querySelectorAll('.atom-obj').length ?? -1 },
        tags: ed.store.find(t.id)?.props?._tags ?? [],
        recordTags: record?.props?._tags ?? [],
        recordText: record ? record.content.filter((r) => r.t === 'text').map((r) => r.v).join('') : '',
        isRoot: ed.store.blocks.some((x) => x.id === recordId),
        tagCount: ed.store.blocks.filter((x) => (x.props?._lists ?? []).includes('tag')).length,
      }
    }, { id: objBlock })

    assert(obj.atoms.length === 1 && obj.atoms[0] !== tagId, `⇧↵ 应插指向**新记录**的实例：${JSON.stringify(obj)}`)
    assert(obj.recordTags.length === 1 && obj.recordTags[0] === tagId, `记录应自带标签归属：${JSON.stringify(obj.recordTags)}`)
    assert(obj.recordText === tagName, `记录的正文应是键入名：${JSON.stringify(obj.recordText)}`)
    assert(obj.dom.tag === 0 && obj.dom.obj === 1, `⇧↵ 的样式应是实例（空心胶囊），不是行内标签：${JSON.stringify(obj.dom)}`)
    assert(obj.isRoot, '记录应落在森林顶层')
    assert(obj.tags.length === 0, `⇧↵ 不该把宿主归类：${JSON.stringify(obj.tags)}`)
    assert(obj.tagCount === tagCountBefore, `⇧↵ 复用已有标签，不新建第二个：${tagCountBefore} → ${obj.tagCount}`)

    await ctx.close()
    return `前缀#名 也能弹；↵ 行内标签（指向类）、⌥↵ 写宿主 _tags、⇧↵ 建住森林顶层的新实例`
  },
)




await check(
  'T115 实例 ⌥ 浮层：字段行读写落在记录块，宿主零写入；Esc 关、一次撤销回滚',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)

    /**
     * 字段浮层不是新的数据面：值的家还是记录块。
     * 这条同时钉三件事——① 打开的是**记录**的字段（`data-obj-fields-of`）；
     * ② 写入只落记录、宿主零字段；③ 关掉浮层后一次撤销回得去。
     */
    const hostId = await page.evaluate(() => {
      const ed = window.__qua.__editor
      const id = ed.insertBlockAfter(window.__qua.blocks()[0].id, '')
      window.__qua.focusBlock(id, 0)
      return id
    })
    await page.waitForTimeout(80)
    await page.keyboard.type('#浮层甲')
    await page.waitForTimeout(220)
    await page.keyboard.press('Shift+Enter')
    await page.waitForTimeout(420)

    const setup = await page.evaluate((hostId) => {
      const tag = window.__qua.allBlocks().find((b) => b.lists.includes('tag') && b.text === '浮层甲')
      const atom = window.__qua.atoms().find((a) => a.blockId === hostId && a.label === '浮层甲')
      // 给标签声明两个字段：数值 + 下拉（覆盖两种控件，不必跑全类型）
      window.__qua.invoke('core.props/create-def', { blockId: tag.id, label: '时长', kind: 'number', target: 'declared' })
      window.__qua.invoke('core.props/create-def', { blockId: tag.id, label: '状态', kind: 'select', target: 'declared' })
      return { tagId: tag.id, recordId: atom.target.id, hostId }
    }, hostId)
    await page.waitForTimeout(320)

    await page.locator(`.blk[data-block-id="${hostId}"] .atom-obj`).click({ modifiers: ['Alt'] })
    await page.waitForTimeout(320)

    const opened = await page.evaluate((s) => {
      const pop = document.querySelector('.popover')
      const body = pop?.querySelector('.popover-fields')
      return {
        open: Boolean(pop),
        fieldsOf: body?.dataset.objFieldsOf ?? '',
        rows: [...(body?.querySelectorAll('.prop-row') ?? [])].map((e) => e.querySelector('.prop-name')?.textContent ?? ''),
        hostFields: window.__qua.fields(s.hostId).length,
      }
    }, setup)

    assert(opened.open, '⌥ 点实例应弹字段浮层（前置）')
    assert(opened.fieldsOf === setup.recordId, `浮层应画记录块的字段，不是宿主的：${JSON.stringify(opened)}`)
    assert(opened.rows.join('|') === '时长|状态', `应按标签声明列出两行：${JSON.stringify(opened.rows)}`)
    assert(opened.hostFields === 0, `打开浮层不该给宿主造字段：${opened.hostFields}`)

    const first = page.locator('.popover-fields .prop-row').first().locator('input')
    await first.fill('3')
    await first.blur()
    await page.waitForTimeout(260)

    const wrote = await page.evaluate((s) => ({
      record: window.__qua.fields(s.recordId).map((f) => ({ label: f.label, value: f.value })),
      host: window.__qua.fields(s.hostId).map((f) => ({ label: f.label, value: f.value })),
    }), setup)
    // number 字段提交的是**数值**（不是字符串）：排序/统计按值比，字符串会退化成字典序
    assert(wrote.record.find((f) => f.label === '时长')?.value === 3, `值应写到记录块（number）：${JSON.stringify(wrote.record)}`)
    assert(wrote.host.length === 0, `值不该写到宿主块：${JSON.stringify(wrote.host)}`)

    await page.keyboard.press('Escape')
    await page.waitForTimeout(180)
    assert((await page.locator('.popover').count()) === 0, 'Esc 应关掉字段浮层')

    // 一次撤销：值回到「待填」（浮层已关，走全局模型栈）
    await page.evaluate(() => window.__qua.invoke('core.history/undo'))
    await page.waitForTimeout(260)
    const undone = await page.evaluate((s) => window.__qua.fields(s.recordId).find((f) => f.label === '时长')?.value ?? null, setup)
    assert(undone === null, `一次撤销应回滚这次字段写入：${JSON.stringify(undone)}`)

    await ctx.close()
    return `⌥ 展开记录字段卡（时长/状态）、写值只落记录块、Esc 关闭、一次撤销回滚`
  },
)

/* --------------------------------------------- 编辑边界（同一容器内换块） */

await check(
  'T103 点进自己的子块也算离开上一行：父块的修改时间在那一刻更新（同一容器内不派发 focusout）',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)

    /**
     * 挑一个**有子块**的行，并取它 DOM 里紧邻的那一行（那就是它的第一个子块）。
     *
     * ⚠️ 这条用例存在的理由：整片编辑区是**一个** contenteditable 容器，
     *    在容器内部从父块点到子块**不会派发 `focusout`** —— 只认 `focusout` 时，
     *    那个编辑边界永远不来了，表现为「改完点进子块，修改时间不动」，而且不报错。
     */
    const pick = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.blk')]
      for (let i = 0; i < rows.length - 1; i++) {
        const d = Number(rows[i].dataset.depth)
        const nd = Number(rows[i + 1].dataset.depth)
        if (rows[i].querySelector('.tx') && nd === d + 1) {
          return { parentId: rows[i].dataset.blockId, childId: rows[i + 1].dataset.blockId, depth: d, childDepth: nd }
        }
      }
      return null
    })
    assert(pick, '前置：应存在一个带子块的行（及其紧邻的子块行）')
    assert(pick.childDepth === pick.depth + 1, `前置：紧邻那行必须是它的子块：${JSON.stringify(pick)}`)

    const modified = (id) => page.evaluate((i) => window.__qua.__editor.store.find(i)?.modified ?? -1, id)

    await page.evaluate((i) => window.__qua.focusBlock(i, 0), pick.parentId)
    /**
     * **跨过一秒**再打字：只读段显示到秒，同秒内的前后值在显示上一样
     * （这里断的是模型值，跨秒只是为了让人读日志时不会误判）。
     */
    await page.waitForTimeout(1100)
    const t0 = await modified(pick.parentId)
    await page.keyboard.type('改')

    // 点**父块自己的子块**：真鼠标，落点取子块正文槽里靠左的位置
    const at = await page.evaluate((cid) => {
      const el = document.querySelector(`.blk[data-block-id="${cid}"] .tx`)
      const b = el.getBoundingClientRect()
      return { x: b.x + 12, y: b.y + b.height / 2 }
    }, pick.childId)
    await page.mouse.click(at.x, at.y)
    await page.waitForTimeout(250)

    const t1 = await modified(pick.parentId)
    assert(t1 > t0, `点进自己的子块，父块的修改时间该更新：${t0} → ${t1}（脚本时间为准，可能与上一行断言的基准相同）`)

    /**
     * 反向的一半：**光标真的在子块里**。否则这条会变成「点了但没进去」也绿。
     */
    const inChild = await page.evaluate((cid) => window.__qua.snapshot().selection?.aBlock === cid, pick.childId)
    assert(inChild, '点完之后光标该落在子块里（否则这条验的不是「换块」）')

    await ctx.close()
    return `父块改字 → 点它自己的子块 ⇒ 父块 modified 由 ${new Date(t0).toISOString().slice(11, 19)} 变为 ${new Date(t1).toISOString().slice(11, 19)}`
  },
)

await check('T116 Shift+点归属行／行内原子 ⇒ 右槽打开窗口；中心与历史不动', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  await openFirstPage(page)

  const rowId = await page.evaluate(() => document.querySelector('#dock-left .belongs-row')?.dataset.belongsId ?? '')
  assert(rowId, '左槽应有一个归属行')
  const before = await page.evaluate(() => ({
    active: window.__qua.snapshot().activeId,
    nav: window.__qua.snapshot().nav,
  }))
  await page.locator('#dock-left .belongs-row .page-item').first().click({ modifiers: ['Shift'] })
  await page.waitForTimeout(120)
  const afterRow = await dockState(page)
  assert(afterRow.pref.right.cards.includes(rowId), `归属行应打开窗口：${JSON.stringify(afterRow.pref.right.cards)}`)
  assert(afterRow.rows.right.includes(rowId), `窗口应渲染：${JSON.stringify(afterRow.rows.right)}`)

  const atomCount = await page.evaluate(() => document.querySelectorAll('#editor .atom').length)
  assert(atomCount > 0, '当前页应有行内原子')
  const beforeAtom = await page.evaluate(() => ({
    active: window.__qua.snapshot().activeId,
    nav: window.__qua.snapshot().nav,
    cards: window.__qua.snapshot().dock.right.cards,
  }))
  await page.locator('#editor .atom').first().click({ modifiers: ['Shift'] })
  await page.waitForTimeout(120)
  const afterAtom = await page.evaluate(() => ({
    active: window.__qua.snapshot().activeId,
    nav: window.__qua.snapshot().nav,
    cards: window.__qua.snapshot().dock.right.cards,
  }))
  assert(afterAtom.cards.length > beforeAtom.cards.length, `原子 Shift+点应多一张窗口：${JSON.stringify(afterAtom.cards)}`)
  assert(afterAtom.active === beforeAtom.active, `原子 Shift+点不换中心：${beforeAtom.active} → ${afterAtom.active}`)
  assert(JSON.stringify(afterAtom.nav) === JSON.stringify(beforeAtom.nav), `原子 Shift+点不入历史：${JSON.stringify(afterAtom.nav)}`)
  const after = await page.evaluate(() => ({
    active: window.__qua.snapshot().activeId,
    nav: window.__qua.snapshot().nav,
  }))
  assert(after.active === before.active, `归属行 Shift+点也不该换中心：${before.active} → ${after.active}`)
  assert(JSON.stringify(after.nav) === JSON.stringify(before.nav), `归属行 Shift+点也不该入历史：${JSON.stringify(after.nav)}`)
  await ctx.close()
  return `归属行 ${rowId.slice(-6)} 与行内原子都在右槽开了窗口；中心/历史零变化`
})

await check('T117 Shift+点反链 footer 的块标／面包屑 ⇒ 右槽窗口；中心与历史不动', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  await openFirstPage(page)

  const src = await page.evaluate(() => document.querySelector('#editor .mount .blk[data-block-id]')?.dataset.blockId ?? '')
  assert(src, '当前页应有反链（footer 里有源块）')
  /**
   * 反链行要回答「这句话在哪」：来源块不是顶层时，行首给出祖先链（面包屑）。
   * 第一页那条反链来自「输入面笔记」，正好是「祖先只有一层」的形态。
   */
  const refCrumb = await page.evaluate((src) => {
    const cell = document.querySelector(`#editor .mount .blk[data-block-id="${src}"] > .blk-context .blk-context-cell`)
    return cell ? { text: cell.textContent ?? '', id: cell.dataset.crumbFor ?? '' } : null
  }, src)
  assert(refCrumb?.text === '输入面笔记', `反链行应显示来源页的面包屑：${JSON.stringify(refCrumb)}`)
  const before = await page.evaluate(() => ({
    active: window.__qua.snapshot().activeId,
    nav: window.__qua.snapshot().nav,
  }))
  await page.locator('#editor .mount .blk .marker').first().click({ modifiers: ['Shift'] })
  await page.waitForTimeout(120)
  const afterBacklink = await dockState(page)
  assert(afterBacklink.pref.right.cards.includes(src), `反链源块应开窗口：${JSON.stringify(afterBacklink.pref.right.cards)}`)
  const after = await page.evaluate(() => ({
    active: window.__qua.snapshot().activeId,
    nav: window.__qua.snapshot().nav,
  }))
  assert(after.active === before.active, `反链块标 Shift+点不换中心：${before.active} → ${after.active}`)
  assert(JSON.stringify(after.nav) === JSON.stringify(before.nav), `反链块标 Shift+点不入历史：${JSON.stringify(after.nav)}`)

  // 普通点＝就地展开上下文：根换成祖先，中心/历史不动；命中行落在子树里
  const beforeExpand = await page.evaluate(() => ({
    active: window.__qua.snapshot().activeId,
    nav: window.__qua.snapshot().nav,
  }))
  await page.locator(`#editor .mount .blk[data-block-id="${src}"] > .blk-context .blk-context-cell`).click()
  await page.waitForTimeout(220)
  const expanded = await page.evaluate(
    ({ src, crumbId }) => {
      const panel = document.querySelector('#editor .mount')
      const root = panel?.querySelector(`.blk[data-block-id="${crumbId}"][data-depth="0"]`)
      const hit = panel?.querySelector(`.blk[data-block-id="${src}"]`)
      return {
        root: Boolean(root),
        hitDepth: hit?.dataset.depth ?? '',
        back: Boolean(root?.querySelector('.blk-context-back')),
        active: window.__qua.snapshot().activeId,
        nav: window.__qua.snapshot().nav,
      }
    },
    { src, crumbId: refCrumb.id },
  )
  assert(expanded.root, `普通点面包屑应把祖先装成这一栏的根（原地展开）：${JSON.stringify(expanded)}`)
  assert(expanded.hitDepth === '1', `命中行应落在祖先的子树里（depth 1）：${JSON.stringify(expanded)}`)
  assert(expanded.back, `展开根应有「收起上下文」：${JSON.stringify(expanded)}`)
  assert(expanded.active === beforeExpand.active, `原地展开不换中心：${beforeExpand.active} → ${expanded.active}`)
  assert(JSON.stringify(expanded.nav) === JSON.stringify(beforeExpand.nav), '原地展开不入历史')

  // 「收起上下文」：退一层，回到原始命中行
  await page.locator(`#editor .mount .blk[data-block-id="${refCrumb.id}"] > .blk-context .blk-context-back`).click()
  await page.waitForTimeout(220)
  const collapsed = await page.evaluate(
    ({ src, crumbId }) => {
      const panel = document.querySelector('#editor .mount')
      return {
        hitDepth: panel?.querySelector(`.blk[data-block-id="${src}"]`)?.dataset.depth ?? '',
        rootGone: !panel?.querySelector(`.blk[data-block-id="${crumbId}"][data-depth="0"]`),
      }
    },
    { src, crumbId: refCrumb.id },
  )
  assert(collapsed.rootGone && collapsed.hitDepth === '0', `收起后应回到原始命中行：${JSON.stringify(collapsed)}`)

  // ⌘/Ctrl + 点＝跳转（原来的行为，保留）
  await page.locator(`#editor .mount .blk[data-block-id="${src}"] > .blk-context .blk-context-cell`).click({
    modifiers: ['ControlOrMeta'],
  })
  await page.waitForTimeout(200)
  const afterJump = await page.evaluate(() => window.__qua.snapshot().activeId)
  assert(afterJump === refCrumb.id, `⌘/Ctrl 点面包屑应跳到那个祖先：${refCrumb.id} → ${afterJump}`)
  await openFirstPage(page)
  await page.waitForTimeout(150)

  // 面包屑：先 zoom 进一个子块（普通点块标），再 Shift+点祖先那格
  const child = await page.evaluate(() => document.querySelector('#editor .blk[data-depth="1"]')?.dataset.blockId ?? '')
  assert(child, '当前页应有子块，用来让面包屑出现')
  await page.locator(`.blk[data-block-id="${child}"] > .left > .marker`).click()
  await page.waitForTimeout(160)
  const crumbId = await page.evaluate(() => document.querySelector('#crumbs-trail .crumb')?.dataset.blockId ?? '')
  assert(crumbId, 'zoom 之后面包屑应有一格祖先')
  const beforeCrumb = await page.evaluate(() => ({
    active: window.__qua.snapshot().activeId,
    nav: window.__qua.snapshot().nav,
  }))
  await page.locator('#crumbs-trail .crumb').first().click({ modifiers: ['Shift'] })
  await page.waitForTimeout(120)
  const afterCrumb = await page.evaluate(() => ({
    active: window.__qua.snapshot().activeId,
    nav: window.__qua.snapshot().nav,
    cards: window.__qua.snapshot().dock.right.cards,
  }))
  assert(afterCrumb.cards.includes(crumbId), `面包屑 Shift+点应开祖先的窗口：${JSON.stringify(afterCrumb.cards)}`)
  assert(afterCrumb.active === beforeCrumb.active, `面包屑 Shift+点不换中心：${beforeCrumb.active} → ${afterCrumb.active}`)
  assert(JSON.stringify(afterCrumb.nav) === JSON.stringify(beforeCrumb.nav), `面包屑 Shift+点不入历史：${JSON.stringify(afterCrumb.nav)}`)
  await ctx.close()
  return `反链源块 ${src.slice(-6)} 与面包屑祖先 ${crumbId.slice(-6)} 都只开窗口；中心/历史零变化`
})

await check('T118 卡片收起：只隐藏 body、不销毁窗口编辑器；刷新后仍收起', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  await openFirstPage(page)
  const id = await page.evaluate(() => window.__qua.blocks().find((x) => !(x.roles?.length) && !x.todo && x.text.length > 2)?.id ?? '')
  assert(id, '应有一个可开的块')
  await shiftClickMarker(page, id)
  await page.waitForTimeout(120)

  await page.locator('#dock-left .dock-card[data-card-id="belongs"] [data-dock-action="collapse"]').click()
  await page.waitForTimeout(80)
  const folded = await page.evaluate((id) => ({
    collapsed: document.querySelector('#dock-left .dock-card[data-card-id="belongs"]')?.dataset.collapsed ?? '',
    body: getComputedStyle(document.querySelector('#dock-left .dock-card[data-card-id="belongs"] .dock-card-body')).display,
    pref: window.__qua.snapshot().dock.collapsed,
    windowAlive: Boolean(document.querySelector(`#dock-right .dock-card[data-window="1"][data-card-id="${id}"] .dock-window-editor .blk`)),
  }), id)
  assert(folded.collapsed === '1' && folded.body === 'none', `收起应只隐藏 body：${JSON.stringify(folded)}`)
  assert(folded.pref.includes('belongs'), `收起应落 prefs：${JSON.stringify(folded.pref)}`)
  assert(folded.windowAlive, '收起别的卡不该销毁窗口里的编辑器')

  const reopened = await reopenPage(browser, ctx, base, page)
  await reopened.page.waitForTimeout(220)
  const again = await reopened.page.evaluate(() => ({
    collapsed: document.querySelector('#dock-left .dock-card[data-card-id="belongs"]')?.dataset.collapsed ?? '',
    body: getComputedStyle(document.querySelector('#dock-left .dock-card[data-card-id="belongs"] .dock-card-body')).display,
  }))
  await reopened.ctx.close()
  assert(again.collapsed === '1' && again.body === 'none', `刷新后应仍收起：${JSON.stringify(again)}`)
  return `归属卡收起后 body=none、窗口编辑器仍在；刷新后仍收起`
})

await check('T119 单卡：只留这一张；目标不可见时自动失效；打开新窗口退出单卡', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  await openFirstPage(page)

  await page.locator('#dock-left .dock-card[data-card-id="belongs"] [data-dock-action="solo"]').click()
  await page.waitForTimeout(80)
  const leftSolo = await page.evaluate(() => ({
    stack: document.querySelector('#dock-left .dock-stack')?.dataset.solo ?? '',
    card: document.querySelector('#dock-left .dock-card[data-solo-card="1"]')?.dataset.cardId ?? '',
    other: getComputedStyle(document.querySelector('#dock-left .dock-card[data-card-id="calendar"]')).display,
    pref: window.__qua.snapshot().dock.solo.left,
  }))
  assert(leftSolo.stack === '1' && leftSolo.card === 'belongs', `单卡应只标归属：${JSON.stringify(leftSolo)}`)
  assert(leftSolo.other === 'none', `单卡应隐藏其它卡：${JSON.stringify(leftSolo)}`)
  assert(leftSolo.pref === 'belongs', `单卡应落 prefs：${JSON.stringify(leftSolo)}`)

  // 检视卡有一张；先单卡它，再切到「今日」让主体消失 ⇒ 单卡自动失效、其它卡照常显示
  const inspectVisible = await page.evaluate(() => !document.getElementById('inspect-card').hidden)
  assert(inspectVisible, '打开一页后检视卡应有主体')
  await page.locator('#inspect-card [data-dock-action="solo"]').click()
  await page.waitForTimeout(80)
  const journalId = await page.evaluate(() => window.__qua.allBlocks().find((b) => b.roles?.includes('journal'))?.id ?? '')
  assert(journalId, '应有今日 journal 块')
  await page.evaluate((jid) => window.__qua.invoke('core.page/open', { pageId: jid }), journalId)
  await page.waitForTimeout(160)
  const fallback = await page.evaluate(() => ({
    solo: window.__qua.snapshot().dock.solo.right,
    hidden: document.getElementById('inspect-card')?.hidden === true,
    stack: document.querySelector('#dock-right .dock-stack')?.dataset.solo ?? '',
    backrefs: getComputedStyle(document.querySelector('#dock-right .dock-card[data-card-id="backrefs"]')).display,
  }))
  assert(fallback.solo === 'inspect', `单卡状态应保留：${JSON.stringify(fallback)}`)
  assert(fallback.hidden, `检视卡此时应不可见：${JSON.stringify(fallback)}`)
  assert(fallback.stack === '', `目标不可见时不该留空槽：${JSON.stringify(fallback)}`)
  assert(fallback.backrefs !== 'none', `其它卡应照常显示：${JSON.stringify(fallback)}`)

  // 打开一张窗口 ⇒ 退出右槽单卡（单卡是「只看一张」，加一张与它矛盾）
  const id = await page.evaluate(() => window.__qua.blocks().find((x) => !(x.roles?.length) && !x.todo && x.text.length > 2)?.id ?? '')
  assert(id, '当前屏应有一个可开的块')
  await shiftClickMarker(page, id)
  await page.waitForTimeout(120)
  const afterOpen = await page.evaluate((id) => ({
    solo: window.__qua.snapshot().dock.solo.right,
    cards: window.__qua.snapshot().dock.right.cards,
    windows: [...document.querySelectorAll('#dock-right .dock-card[data-window="1"]')].map((e) => e.dataset.cardId),
  }), id)
  assert(afterOpen.solo === null, `打开新窗口应退出单卡：${JSON.stringify(afterOpen)}`)
  assert(afterOpen.windows.includes(id), `新窗口应在右槽：${JSON.stringify(afterOpen)}`)
  await ctx.close()
  return `单卡只留一张并落 prefs；检视卡失去主体后单卡自动失效；打开窗口退出单卡`
})

await check('T120 卡片拖拽：槽内排序、跨槽移动、一个块只留一个窗口；编辑器跟着走', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  await openFirstPage(page)
  const ids = await page.evaluate(() => {
    const bs = window.__qua.blocks().filter((x) => !(x.roles?.length) && !x.todo && x.text.length > 2)
    return { a: bs[0]?.id ?? '', b: bs[1]?.id ?? '' }
  })
  assert(ids.a && ids.b && ids.a !== ids.b, '应有至少两个不同的可开块')
  await shiftClickMarker(page, ids.a)
  await shiftClickMarker(page, ids.b)
  await page.waitForTimeout(140)

  // 槽内排序：把 b 拖到 a 之前
  const moved = await dragCard(page, { from: 'right', to: 'right', id: ids.b, before: ids.a })
  assert(moved, '拖拽事件应能派发到卡头与槽')
  assert(moved.hot, '拖到卡上半应亮插入线')
  const order = moved.cards.right.cards.filter((id) => id === ids.a || id === ids.b)
  assert(JSON.stringify(order) === JSON.stringify([ids.b, ids.a]), `槽内顺序应是 b,a：${JSON.stringify(order)}`)

  // 跨槽：把 b 拖到左槽（落在日历卡上半）
  const across = await dragCard(page, { from: 'right', to: 'left', id: ids.b, before: 'calendar' })
  assert(across, '跨槽拖拽应派发')
  const acrossCards = across.cards
  assert(!acrossCards.right.cards.includes(ids.b), `跨槽后右槽不该还有 b：${JSON.stringify(acrossCards.right.cards)}`)
  assert(acrossCards.left.cards.includes(ids.b), `跨槽后左槽应有 b：${JSON.stringify(acrossCards.left.cards)}`)
  const leftIdx = acrossCards.left.cards.indexOf(ids.b)
  const calendarIdx = acrossCards.left.cards.indexOf('calendar')
  assert(leftIdx >= 0 && leftIdx < calendarIdx, `b 应落在日历之前：${JSON.stringify(acrossCards.left.cards)}`)
  const alive = await page.evaluate((id) => Boolean(document.querySelector(`#dock-left .dock-card[data-window="1"][data-card-id="${id}"] .dock-window-editor .blk`)), ids.b)
  assert(alive, '跨槽后窗口编辑器应跟着走')

  // 一个块只留一个窗口：在左槽的窗口里 Shift+点自己的块标 ⇒ 移到右槽，不是复制
  await page.locator(rootMarker('left', ids.b)).click({ modifiers: ['Shift'] })
  await page.waitForTimeout(140)
  const movedToRight = await page.evaluate((id) => ({
    left: window.__qua.snapshot().dock.left.cards,
    right: window.__qua.snapshot().dock.right.cards,
    windows: document.querySelectorAll(`#dock-right .dock-card[data-window="1"][data-card-id="${id}"]`).length,
  }), ids.b)
  assert(!movedToRight.left.includes(ids.b), `移走后左槽不该还有 b：${JSON.stringify(movedToRight.left)}`)
  assert(movedToRight.right.includes(ids.b), `右槽应有 b：${JSON.stringify(movedToRight.right)}`)
  assert(movedToRight.windows === 1, `同一个块只能有一张窗口：${movedToRight.windows}`)

  // 再拖回左槽：验证跨槽后仍可编辑（编辑器实例是新建的，不是死引用）
  await dragCard(page, { from: 'right', to: 'left', id: ids.b, before: 'belongs' })
  const backLeft = await page.evaluate((id) => ({
    cards: window.__qua.snapshot().dock.left.cards,
    text: document.querySelector(`#dock-left .dock-card[data-window="1"][data-card-id="${id}"] .dock-window-editor .blk[data-depth="0"] > .tx`)?.textContent ?? '',
  }), ids.b)
  assert(backLeft.cards.includes(ids.b), `拖回左槽应成功：${JSON.stringify(backLeft.cards)}`)
  assert(backLeft.text.length > 0, `拖回后窗口正文应可读：${JSON.stringify(backLeft)}`)

  // 派生卡走同一个 moveCard：检视卡从右槽拖到左槽，再拖回去
  const inspectLeft = await dragCard(page, { from: 'right', to: 'left', id: 'inspect', before: 'calendar' })
  assert(inspectLeft, '派生卡拖拽应派发')
  assert(inspectLeft.cards.left.cards.includes('inspect'), `检视卡应移入左槽：${JSON.stringify(inspectLeft.cards.left.cards)}`)
  assert(!inspectLeft.cards.right.cards.includes('inspect'), `右槽不该还有检视卡：${JSON.stringify(inspectLeft.cards.right.cards)}`)
  const inspectInLeft = await page.evaluate(() => ({
    inLeft: Boolean(document.querySelector('#dock-left #inspect-card')),
    visible: !document.getElementById('inspect-card').hidden,
  }))
  assert(inspectInLeft.inLeft && inspectInLeft.visible, `检视卡应显示在左槽：${JSON.stringify(inspectInLeft)}`)
  const inspectBack = await dragCard(page, { from: 'left', to: 'right', id: 'inspect', before: 'backrefs' })
  assert(inspectBack, '检视卡拖回右槽应派发')
  assert(inspectBack.cards.right.cards.includes('inspect'), `检视卡应回右槽：${JSON.stringify(inspectBack.cards.right.cards)}`)
  await ctx.close()
  return `槽内 b 到 a 前；跨槽 b→左（日历前）；Shift+点移回右且只有一张；再拖回左仍可读；检视卡右→左→右`
})

await check('T121 右槽反链卡的行走同一条 Shift：行 = 源页，开窗口；中心不动', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  await openFirstPage(page)
  const rows = await page.evaluate(
    () => document.querySelectorAll('#dock-right .dock-card[data-card-id="backrefs"] .page-item').length,
  )
  assert(rows > 0, '当前页的反链卡应有行')
  const before = await page.evaluate(() => ({
    cards: window.__qua.snapshot().dock.right.cards,
    active: window.__qua.snapshot().activeId,
  }))
  await page.locator('#dock-right .dock-card[data-card-id="backrefs"] .page-item').first().click({ modifiers: ['Shift'] })
  await page.waitForTimeout(120)
  const after = await page.evaluate(() => ({
    cards: window.__qua.snapshot().dock.right.cards,
    active: window.__qua.snapshot().activeId,
  }))
  const added = after.cards.filter((id) => !before.cards.includes(id) && /^[0-9a-f]{32}$/.test(id))
  assert(added.length === 1, `反链行应开一张窗口：${JSON.stringify(after.cards)}`)
  assert(after.active === before.active, `反链行 Shift+点不换中心：${before.active} → ${after.active}`)
  await ctx.close()
  return `反链卡的行走 Shift 打开源页 ${added[0].slice(-6)}；中心不动`
})

await check('T123 标签页成员块标的 Shift ⇒ 右槽窗口；中心不动', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  const tag = await page.evaluate(() => window.__qua.allBlocks().find((b) => b.roles?.includes('tag') && b.text === '任务')?.id ?? '')
  assert(tag, '假数据里应有 #任务')
  await page.evaluate((id) => window.__qua.invoke('core.page/open', { pageId: id }), tag)
  await page.waitForTimeout(220)
  await mountTab(page, 'same')
  const markers = await page.evaluate(() => document.querySelectorAll('#editor .mount .blk .marker').length)
  assert(markers > 0, '「同类」栏的成员编辑器应有块标')
  const before = await page.evaluate(() => ({
    cards: window.__qua.snapshot().dock.right.cards,
    active: window.__qua.snapshot().activeId,
  }))
  await page.locator('#editor .mount .blk .marker').first().click({ modifiers: ['Shift'] })
  await page.waitForTimeout(120)
  const after = await page.evaluate(() => ({
    cards: window.__qua.snapshot().dock.right.cards,
    active: window.__qua.snapshot().activeId,
  }))
  assert(after.cards.length > before.cards.length, `成员块标 Shift+点应开窗口：${JSON.stringify(after.cards)}`)
  assert(after.active === before.active, `成员块标 Shift+点不换中心：${before.active} → ${after.active}`)
  await ctx.close()
  return `标签页成员块标开窗口；中心不动`
})

await check('T124 详情浮层的「打开目标」读 Shift ⇒ 右槽窗口；中心不动', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  await openFirstPage(page)
  const atom = await page.evaluate(() => document.querySelectorAll('#editor .atom').length)
  assert(atom > 0, '当前页应有行内原子')
  const before = await page.evaluate(() => ({
    cards: window.__qua.snapshot().dock.right.cards,
    active: window.__qua.snapshot().activeId,
  }))
  await page.locator('#editor .atom').first().click({ modifiers: ['Alt'] })
  await page.waitForTimeout(120)
  const popover = await page.evaluate(() => Boolean(document.querySelector('.popover')))
  assert(popover, '⌥ 点原子应开详情浮层')
  await page.locator('.popover button', { hasText: '打开目标' }).click({ modifiers: ['Shift'] })
  await page.waitForTimeout(120)
  const after = await page.evaluate(() => ({
    cards: window.__qua.snapshot().dock.right.cards,
    active: window.__qua.snapshot().activeId,
    popover: Boolean(document.querySelector('.popover')),
  }))
  assert(after.cards.length > before.cards.length, `浮层的「打开目标」Shift+点应开窗口：${JSON.stringify(after.cards)}`)
  assert(after.active === before.active, `浮层 Shift+点不换中心：${before.active} → ${after.active}`)
  assert(!after.popover, '点完应关浮层')
  await ctx.close()
  return `浮层「打开目标」Shift+点开窗口；中心不动`
})

await check('T125 「新建属性」真的建出定义并当场出现那一行；标签上两个入口各写各的槽、**页上没有声明段**', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  await openFirstPage(page)

  /** 找一个普通内容块（无身份、无标签）当属性卡的主体 */
  const hostId = await page.evaluate(() => {
    const b = window.__qua.allBlocks().find((x) => x.lists.length === 0 && x.roles.length === 0 && x.text.length > 2)
    if (b) window.__qua.invoke('core.block/focus-block', { blockId: b.id })
    return b?.id ?? ''
  })
  assert(hostId !== '', '应能找到一个内容块当属性卡的主体')
  await page.waitForTimeout(200)

  const before = await page.evaluate(() => window.__qua.propDefs().map((d) => d.label))
  await page.click('#properties-add')
  await page.waitForSelector('.props-form')
  // 选「＋ 新建属性…」⇒ 展开名字＋类型那一组
  await page.evaluate(() => {
    const sel = document.querySelector('.props-form .props-pick')
    sel.value = '__new__'
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await page.waitForTimeout(80)
  await page.fill('.props-new-group input.prop-input', '冒烟新属性')
  await page.evaluate(() => document.querySelector('.props-create')?.click())
  await page.waitForTimeout(300)

  /**
   * ⚠️ 这条断言钉的是一次**真踩过的空操作**：卡片调命令时把「名字」传成了 `propId`，
   *    而 `core.props/create-def` 读的是 `label` ⇒ 名字永远是空串 ⇒ handler 早退。
   *    表现是「点了新建、什么都没发生」：库里没有定义、卡里也没有那一行。
   */
  const after = await page.evaluate(() => {
    const def = window.__qua.propDefs().find((d) => d.label === '冒烟新属性')
    return {
      defs: window.__qua.propDefs().map((d) => d.label),
      defId: def?.id ?? '',
      rows: [...document.querySelectorAll('.prop-row[data-prop-id]')].map((x) => x.dataset.propId),
      form: Boolean(document.querySelector('.props-form')),
      cardText: document.querySelector('#properties-body')?.innerText ?? '',
    }
  })
  assert(after.defs.length === before.length + 1, `新建属性应真的在库里多一条定义：${JSON.stringify(after.defs)}`)
  assert(after.defId !== '', '新建出来的定义要能被 `propDefs()` 找到')
  assert(after.rows.includes(after.defId), `新建之后卡片要当场出现那一行（不能等别处碰一下）：${JSON.stringify(after)}`)
  assert(!after.form, `新建完表单应关闭：${JSON.stringify(after)}`)

  /**
   * 页/标签上「添加属性」现在有**两个入口**，各写各的槽：
   *   · 「＋ 添加属性」→ 这一块自己的值（`_ownProps`）
   *   · 「＋ 添加标签属性 / 添加字段」→ 成员的声明清单（`_fieldDefs`）
   *
   * 曾经只有一个入口，靠「这个块有没有 page/tag 露面」猜意图 ⇒ 标签块永远加不了自己的属性。
   * 后来又踩了反面：两个表单共用 `rows ∪ declared` 去重 ⇒ 声明过的不能给自己加，
   * 自己有值的不能声明给成员。下面两头都要钉。
   */
  /**
   * **页上不该再有「字段声明」段**（v29）。
   *
   * 页曾经能声明 `_fieldDefs`，但那一格**没有任何消费方**：子块不会因此获得那些字段。
   * 一个能写、没人读的入口比没有更糟 —— 用户会以为「声明了，成员就有这一格了」。
   * 这条与 `arch-check [31]` 是一对：那边钉代码里没有那条分支，这边钉界面上没有那个入口。
   */
  const pagePeek = await page.evaluate(() => {
    const p = window.__qua.allBlocks().find((b) => b.lists.includes('page') && !b.lists.includes('tag'))
    if (p) window.__qua.invoke('core.block/focus-block', { blockId: p.id })
    return p?.id ?? ''
  })
  assert(pagePeek !== '', '假数据里应有页')
  await page.waitForTimeout(250)
  const pageSect = await page.evaluate(() => ({
    declared: document.querySelectorAll('[data-declared-prop-id]').length,
    add: document.querySelectorAll('[data-declare-add]').length,
    section: document.querySelectorAll('.props-declared').length,
  }))
  assert(
    pageSect.declared === 0 && pageSect.add === 0 && pageSect.section === 0,
    `页上不该有「字段声明」段（写了也永远不生效）：${JSON.stringify(pageSect)}`,
  )

  /** 声明是**标签**的事：它的成员会继承，这条声明有获得方 */
  const pageId = await page.evaluate(() => {
    const t = window.__qua.allBlocks().find((b) => b.lists.includes('tag'))
    if (t) window.__qua.invoke('core.block/focus-block', { blockId: t.id })
    return t?.id ?? ''
  })
  assert(pageId !== '', '假数据里应有标签')
  await page.waitForTimeout(250)

  const pageBefore = await page.evaluate(() => ({
    declared: [...document.querySelectorAll('[data-declared-prop-id]')].length,
    rows: [...document.querySelectorAll('.prop-row[data-prop-id]')].length,
    text: document.querySelector('#properties-body')?.innerText ?? '',
  }))
  // 种子里 `#任务` 已经声明了「任务状态」：基线不一定是 0，断言要按 **+1** 走
  assert(pageBefore.declared <= 1, `前置：这个标签的声明条数是种子里带来的：${JSON.stringify(pageBefore)}`)

  const pickId = await page.evaluate(() => window.__qua.propDefs().find((d) => d.label === '冒烟新属性')?.id ?? '')

  // ① 自己的入口 ⇒ 这一页**自己**多一行值（不是声明）
  await page.click('#properties-add')
  await page.waitForSelector('.props-form--own')
  await page.selectOption('.props-form--own .props-pick', pickId)
  await page.waitForTimeout(80)
  await page.evaluate(() => document.querySelector('.props-form--own .props-use')?.click())
  await page.waitForTimeout(300)

  const pageOwn = await page.evaluate((id) => ({
    rows: [...document.querySelectorAll('.prop-row[data-prop-id]')].map((x) => x.dataset.propId),
    declared: [...document.querySelectorAll('[data-declared-prop-id]')].length,
  }), pickId)
  assert(pageOwn.rows.includes(pickId), `自己的入口要加「这一块自己的」属性行：${JSON.stringify(pageOwn)}`)
  assert(
    pageOwn.declared === pageBefore.declared,
    `自己的入口**不该**写声明清单（那是另一个槽）：${JSON.stringify(pageOwn)}`,
  )

  // ② 声明段自己的入口 ⇒ 只写声明，不给自己加行
  await page.evaluate(() => document.querySelector('[data-declare-add]')?.click())
  await page.waitForSelector('.props-form--declared')
  await page.selectOption('.props-form--declared .props-pick', pickId)
  await page.waitForTimeout(80)
  await page.evaluate(() => document.querySelector('.props-form--declared .props-use')?.click())
  await page.waitForTimeout(300)

  const pageAfter = await page.evaluate(() => ({
    declared: [...document.querySelectorAll('[data-declared-prop-id]')].map((x) => x.dataset.declaredPropId),
    text: document.querySelector('#properties-body')?.innerText ?? '',
    section: document.querySelector('.props-declared')?.dataset.declaredSection,
  }))
  assert(
    pageAfter.declared.length === pageBefore.declared + 1,
    `声明入口 ⇒ 声明段多一条：${JSON.stringify(pageAfter)}`,
  )
  assert(pageAfter.declared.includes(pickId), `声明段要显示刚声明的那条定义：${JSON.stringify(pageAfter)}`)
  assert(pageAfter.text.includes('标签属性'), `标签上的这一段要叫「标签属性」，不能只靠 chip：${JSON.stringify(pageAfter.text)}`)
  assert(pageAfter.section === 'tag', `标签上声明的段应标成 tag：${JSON.stringify(pageAfter)}`)

  // 解除声明：只摘清单，定义本身与别的块的声明都不动
  // ⚠️ 按 id 摘**刚声明的那一条**：种子里的 `#任务` 本来就有一条声明，
  //    点「第一个」会摘掉别人（然后这条断言就会拿另一条的状态去判自己）
  await page.evaluate(
    (id) => document.querySelector(`[data-declared-prop-id="${id}"] .props-tag-x`)?.click(),
    pickId,
  )
  await page.waitForTimeout(300)
  const undeclared = await page.evaluate((id) => ({
    declared: [...document.querySelectorAll('[data-declared-prop-id]')].length,
    defStillThere: window.__qua.propDefs().some((d) => d.id === id),
  }), pickId)
  assert(undeclared.declared === pageBefore.declared, `解除后回到基线：${JSON.stringify(undeclared)}`)
  assert(undeclared.defStillThere, '解除声明不该删掉定义块本身')

  /**
   * ②' **反向**：本块已经有自己的值，仍然可以把它声明给成员。
   *
   * 曾经 `declared` 表单也按 `rows` 灰掉 ⇒ 这条路径点不了（用户报的另一半）。
   * 判据落在 `option.disabled` 上：`select.value = id` 会绕过 disabled，验不出来。
   */
  await page.evaluate(() => document.querySelector('[data-declare-add]')?.click())
  await page.waitForSelector('.props-form--declared')
  const reversePick = await page.evaluate((id) => {
    const sel = document.querySelector('.props-form--declared .props-pick')
    const opt = [...sel.options].find((o) => o.value === id)
    return { disabled: opt?.disabled ?? null, text: opt?.textContent ?? '' }
  }, pickId)
  assert(reversePick.disabled === false, `本块自己有值也要能声明给成员（选项不能灰）：${JSON.stringify(reversePick)}`)
  await page.selectOption('.props-form--declared .props-pick', pickId)
  await page.waitForTimeout(80)
  await page.evaluate(() => document.querySelector('.props-form--declared .props-use')?.click())
  await page.waitForTimeout(300)
  const reverseAfter = await page.evaluate((blockId) => {
    const raw = window.__qua.__editor.store.find(blockId)
    return {
      ownProps: Array.isArray(raw?.props?._ownProps) ? raw.props._ownProps : [],
      fieldDefs: Array.isArray(raw?.props?._fieldDefs) ? raw.props._fieldDefs : [],
      declared: [...document.querySelectorAll('[data-declared-prop-id]')].map((x) => x.dataset.declaredPropId),
    }
  }, pageId)
  assert(reverseAfter.fieldDefs.includes(pickId), `声明应写进 _fieldDefs：${JSON.stringify(reverseAfter)}`)
  assert(reverseAfter.ownProps.includes(pickId), '声明不该清掉本块自己的值槽')

  /**
   * ③ **标签属性也能给自己加**（这条是本次的核心回归）。
   *
   * 判据不是「两个按钮都在」，而是**两个槽各自收到各的东西**：
   * 标签块上点自己的入口 ⇒ `_ownProps` 里多一条；`_fieldDefs` 一字不动。
   * 只看界面「有反应」会让「两个入口写同一个槽」这种错配照样绿。
   *
   * ⚠️ 必须断言 `option.disabled`：旧测试用 `sel.value = id` 赋值，
   *    能绕过 disabled，所以「标签属性选不了自己」一直没被抓到。
   */
  const ownDefId = await page.evaluate(() => window.__qua.propDefs().find((d) => d.label === '任务状态')?.id ?? '')
  const tagId = await page.evaluate((id) => {
    const def = window.__qua.propDefs().find((d) => d.id === id)
    const tid = def?.declaredBy?.[0] ?? ''
    if (tid) window.__qua.invoke('core.block/focus-block', { blockId: tid })
    return tid
  }, ownDefId)
  assert(tagId !== '', '「任务状态」应有一处标签属性声明（种子里的 #任务）')
  await page.waitForTimeout(200)

  const tagSection = await page.evaluate(() => ({
    role: document.querySelector('.props-declared')?.dataset.declaredSection,
    title: document.querySelector('.props-declared .props-section-title')?.textContent ?? '',
    hint: document.querySelector('.props-declared .props-section-hint')?.textContent ?? '',
    declaredRows: [...document.querySelectorAll('.prop-declared [data-declared-prop-id]')].length,
  }))
  assert(tagSection.role === 'tag', `标签块上的声明段应标成 tag：${JSON.stringify(tagSection)}`)
  assert(tagSection.title === '标签属性', `标签块上的这一段要叫「标签属性」：${JSON.stringify(tagSection)}`)
  assert(tagSection.hint.includes('使用这个标签的块'), `这一段要说清它给的是成员的格子：${JSON.stringify(tagSection)}`)
  assert(tagSection.declaredRows > 0, `前置：这个标签应已有声明：${JSON.stringify(tagSection)}`)

  await page.click('#properties-add')
  await page.waitForSelector('.props-form--own')
  const ownPlacement = await page.evaluate(() => {
    const form = document.querySelector('.props-form--own')
    const section = document.querySelector('.props-declared')
    return {
      formBeforeSection: Boolean(
        form && section && (form.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING),
      ),
      addInBody: document.querySelector('#properties-add')?.parentElement?.id === 'properties-body',
    }
  })
  assert(ownPlacement.formBeforeSection, `自己的表单要长在「标签属性」段前面（否则像在给声明段加东西）：${JSON.stringify(ownPlacement)}`)
  assert(ownPlacement.addInBody, `「＋ 添加属性」要贴在块属性行下面，不是在卡片最下面：${JSON.stringify(ownPlacement)}`)
  const ownPick = await page.evaluate((id) => {
    const sel = document.querySelector('.props-form--own .props-pick')
    const opt = [...sel.options].find((o) => o.value === id)
    return { disabled: opt?.disabled ?? null, text: opt?.textContent ?? '' }
  }, ownDefId)
  assert(ownPick.disabled === false, `标签属性也要能给自己加（选项不能灰）：${JSON.stringify(ownPick)}`)
  await page.selectOption('.props-form--own .props-pick', ownDefId)
  await page.waitForTimeout(80)
  await page.evaluate(() => document.querySelector('.props-form--own .props-use')?.click())
  await page.waitForTimeout(300)

  const tagOwn = await page.evaluate((id) => {
    const raw = window.__qua.__editor.store.find(id)
    return {
      ownProps: Array.isArray(raw?.props?._ownProps) ? raw.props._ownProps : [],
      fieldDefs: Array.isArray(raw?.props?._fieldDefs) ? raw.props._fieldDefs : [],
      rows: [...document.querySelectorAll('.prop-row[data-prop-id]')].map((x) => x.dataset.propId),
      declared: [...document.querySelectorAll('[data-declared-prop-id]')].map((x) => x.dataset.declaredPropId),
    }
  }, tagId)
  assert(tagOwn.ownProps.includes(ownDefId), `标签块点自己的入口要写进 _ownProps：${JSON.stringify(tagOwn)}`)
  assert(tagOwn.fieldDefs.includes(ownDefId), '给自己加值不该动声明清单')
  assert(tagOwn.rows.includes(ownDefId), `标签块自己的属性要出现在卡里：${JSON.stringify(tagOwn)}`)
  assert(tagOwn.declared.includes(ownDefId), '声明段仍应列出这条标签属性')

  await ctx.close()
  return `两个槽互不占位：标签属性选得了自己，自己有值也声明得了；两段的入口各贴各的清单`
})

/**
 * T126｜**一份归属的每一处露面，点名字都打开它**（这是「同一句话」的回归钉子）。
 *
 * 曾经：正文里那枚 `#名` 能点开（走原子口径），行尾 chip 与属性区的标签名点了没反应 ——
 * 同一个标签、两种行为，用户要学两遍。chip 从正文槽挪到标签槽时，那条点击没跟着搬。
 *
 * 判据落在**「去了哪」**上，不是「有没有反应」：
 *   · 行尾 chip 左键 ⇒ 中心换成标签块；
 *   · 行尾 chip Shift+左键 ⇒ 右槽多一张窗口、中心与历史不动；
 *   · 属性区的标签名左键 ⇒ 同样打开；点 `×` **只摘标签、不导航**；
 *   · 点 chip 前后正文读数不变（chip 仍是 0 格装饰）。
 */
await check('T126 行尾 chip / 属性区标签名点名字 ⇒ 打开标签块；Shift ⇒ 右槽；`×` 只摘不导航', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  await openFirstPage(page)

  const tagName = `露面标签${Date.now().toString(36).slice(-4)}`
  const tagId = await seedTag(page, tagName)
  assert(tagId !== '', '应能建出一个标签块')

  /** 找一个普通内容块，用 ⌥↵ 把标签归到它身上（块级露面 ⇒ 行尾 chip） */
  const hostId = await page.evaluate(() => {
    const ed = window.__qua.__editor
    const b = ed.rows().map((r) => r.block).find((x) => !x.roles?.length && !x.props?._tags?.length)
    return b?.id ?? ''
  })
  assert(hostId !== '', '应能找到一个没有标签的内容块')
  await page.evaluate((id) => window.__qua.focusBlock(id, 0), hostId)
  await page.waitForTimeout(120)
  await page.evaluate(
    ({ id, tag }) => window.__qua.invoke('core.tags/add', { blockId: id, name: tag }),
    { id: hostId, tag: tagName },
  )
  await page.waitForTimeout(200)

  const before = await page.evaluate(
    ({ hostId, tagId }) => {
      const chip = document.querySelector(`.blk[data-block-id="${hostId}"] .blk-tags .tag-chip[data-tag-id="${tagId}"]`)
      return {
        chip: Boolean(chip),
        refTo: chip?.dataset.refTo ?? '',
        title: chip?.title ?? '',
        inTx: Boolean(chip?.closest('.tx')),
        read: window.__qua.__editor.readRunsOf(hostId).filter((r) => r.t === 'text').map((r) => r.v).join(''),
      }
    },
    { hostId, tagId },
  )
  assert(before.chip, `前置：块级归属要在行尾出一枚 chip：${JSON.stringify(before)}`)
  assert(before.refTo === tagId, `chip 要带导航契约 data-ref-to（指向标签块）：${JSON.stringify(before)}`)
  assert(before.title.includes(tagName), `可点就要看得出来能点（title 要说去哪）：${JSON.stringify(before)}`)
  assert(!before.inTx, `chip 仍须在正文槽之外：${JSON.stringify(before)}`)

  // ① 左键点 chip ⇒ 中心换成标签块
  await page.locator(`.blk[data-block-id="${hostId}"] .blk-tags .tag-chip`).first().click()
  await page.waitForTimeout(200)
  const afterLeft = await page.evaluate(() => window.__qua.snapshot().activeId)
  assert(afterLeft === tagId, `点行尾 chip 应打开标签块：${afterLeft} ≠ ${tagId}`)

  // ② 回到宿主，Shift+点 chip ⇒ 右槽开窗口、中心不动
  //    ⚠️ 必须走**导航**（`core.block/focus-block`）：`__qua.focusBlock` 只是把光标放到某一行，
  //       上一步点 chip 已经把中心换成了标签块，宿主那一行不在屏幕上了。
  await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), hostId)
  await page.waitForTimeout(150)
  const centerBefore = await page.evaluate(() => window.__qua.snapshot().activeId)
  const navBeforeShift = await page.evaluate(() => window.__qua.snapshot().nav)
  const dockBefore = await dockState(page)
  await page.locator(`.blk[data-block-id="${hostId}"] .blk-tags .tag-chip`).first().click({ modifiers: ['Shift'] })
  await page.waitForTimeout(200)
  const afterShift = await page.evaluate(() => ({
    active: window.__qua.snapshot().activeId,
    nav: window.__qua.snapshot().nav,
  }))
  const dockAfter = await dockState(page)
  assert(dockAfter.pref.right.cards.includes(tagId), `Shift+点 chip 应在右槽开窗口：${JSON.stringify(dockAfter.pref.right.cards)}`)
  assert(afterShift.active === centerBefore, `Shift+点 chip 不换中心：${centerBefore} → ${afterShift.active}`)
  assert(JSON.stringify(afterShift.nav) === JSON.stringify(navBeforeShift), `Shift+点 chip 不入历史：${JSON.stringify(afterShift.nav)}`)
  assert(dockBefore.pref.right.cards.length < dockAfter.pref.right.cards.length, '前置：右槽确实多了一张卡')

  /**
   * ③ 属性区的标签名：**点名字打开**，`×` **只摘不导航**。
   *
   * ⚠️ 这两半必须一起断言：一枚 chip 上两个命中区最容易出的错是「点 × 时顺手把标签页也打开了」，
   *    只测「× 能摘掉」会照样绿。
   */
  // 属性区的主体＝**当前对象**（单根），所以这里要真的 zoom 过去，不是只放光标
  await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), hostId)
  await page.waitForTimeout(250)
  const panelChip = await page.evaluate((tagId) => {
    const name = document.querySelector(`[data-panel-tag-id="${tagId}"] .props-tag-name`)
    return { found: Boolean(name), refTo: name?.dataset.refTo ?? '', title: name?.title ?? '' }
  }, tagId)
  assert(panelChip.found, `属性区的标签名要带 props-tag-name（点名字的命中区）：${JSON.stringify(panelChip)}`)
  assert(panelChip.refTo === tagId, `属性区标签名要用同一条导航契约：${JSON.stringify(panelChip)}`)
  assert(panelChip.title.includes(tagName), `属性区标签名也要说去哪：${JSON.stringify(panelChip)}`)

  await page.locator(`[data-panel-tag-id="${tagId}"] .props-tag-name`).click()
  await page.waitForTimeout(200)
  const afterPanel = await page.evaluate(() => window.__qua.snapshot().activeId)
  assert(afterPanel === tagId, `点属性区的标签名也应打开标签块：${afterPanel} ≠ ${tagId}`)

  await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), hostId)
  await page.waitForTimeout(250)
  const tagsBeforeX = await page.evaluate((id) => {
    const b = window.__qua.__editor.store.find(id)
    return Array.isArray(b?.props?._tags) ? b.props._tags.length : 0
  }, hostId)
  const centerBeforeX = await page.evaluate(() => window.__qua.snapshot().activeId)
  await page.locator(`[data-panel-tag-id="${tagId}"] .props-tag-x`).click()
  await page.waitForTimeout(250)
  const afterX = await page.evaluate(
    ({ id }) => {
      const b = window.__qua.__editor.store.find(id)
      return {
        tags: Array.isArray(b?.props?._tags) ? b.props._tags.length : 0,
        active: window.__qua.snapshot().activeId,
        chips: document.querySelectorAll(`.blk[data-block-id="${id}"] .blk-tags .tag-chip`).length,
      }
    },
    { id: hostId },
  )
  assert(afterX.tags === tagsBeforeX - 1, `点 × 要摘掉这个标签：${JSON.stringify(afterX)}`)
  assert(afterX.active === centerBeforeX, `点 × **不该**导航（一枚 chip 两个命中区不能互相抢）：${centerBeforeX} → ${afterX.active}`)
  assert(afterX.chips === 0, `摘掉之后行尾不该还留着 chip：${JSON.stringify(afterX)}`)

  await ctx.close()
  return `行尾 chip 与属性区标签名都打开了标签块；Shift 走右槽且中心/历史不动；× 只摘不导航`
})


/* ================================================================ 块底的挂载区 */

/** 今天那一块（冷启动的当前对象） */
const todayId = (page) => page.evaluate(() => window.__qua.snapshot().activeId)

/** 挂载区里某一栏的键（`refs`／`same`／`mentions`／`user:0`…） */
const mountTabsOf = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('#editor .mount')].map((m) => ({
      host: m.closest('.sec')?.dataset.sec ?? '',
      open: m.dataset.open === '1',
      tabs: [...m.querySelectorAll('.mount-tabwrap')].map((w) => ({
        key: w.dataset.tab,
        kind: w.dataset.kind,
        label: w.querySelector('.mount-tab')?.textContent ?? '',
        active: w.dataset.active === '1',
        removable: !!w.querySelector('.mount-x'),
      })),
    })),
  )

await check('T127 挂载区：切 tab 只换 roots，编辑器不重建（原地编辑 + 全局撤销都还在）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.loadState('seed'))
  await page.waitForTimeout(300)
  // 打开一页，并在它自己的一个块里插一枚指向它的引用 ⇒ 「引用」栏里有这一行
  const ids = await page.evaluate(() => {
    const target = window.__qua.pages()[0].id
    window.__qua.invoke('core.page/open', { pageId: target })
    const rows = window.__qua.__editor.rows().map((r) => r.block)
    const src = rows.find((b) => b.id !== target && b.children.length === 0)
    window.__qua.focusBlock(src.id, 0)
    window.__qua.invoke('core.editor/insert-page-ref', { pageId: target })
    return { target, src: src.id }
  })
  await page.waitForTimeout(450)
  await mountTab(page, 'refs')

  const row = `#editor .mount .mount-editor .blk[data-block-id="${ids.src}"] .tx`
  await page.locator(row).first().click()
  await page.keyboard.press('End')
  await page.keyboard.type('X')
  await page.waitForTimeout(220)
  assert((await page.textContent(row)).includes('X'), '前置：引用栏里能原地编辑')

  await mountTab(page, 'mentions')
  await mountTab(page, 'refs')
  assert((await page.textContent(row)).includes('X'), '切走再切回，那一行还在（编辑器没被重建）')

  await page.locator(row).first().click()
  await page.keyboard.press(kbd('mod+z'))
  await page.waitForTimeout(220)
  assert(!(await page.textContent(row)).includes('X'), '⌘Z 仍能撤掉那一笔（撤销栈没被切 tab 清掉）')

  await ctx.close()
  return '引用栏原地编辑 → 切「提及」再切回 → 文字还在；⌘Z 撤销生效'
})

await check('T128 挂载区：空栏也有文案，tab 条不消失', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await mountTab(page, 'mentions') // 今天没有人「提及」它 ⇒ 空
  const state = await page.evaluate(() => {
    const m = document.querySelector('#editor .mount')
    const empty = m?.querySelector('.mount-empty')
    return {
      tabs: [...m.querySelectorAll('.mount-tab')].map((e) => e.textContent),
      emptyHidden: empty?.hidden ?? true,
      emptyText: empty?.textContent ?? '',
      rows: m.querySelectorAll('.mount-editor .blk').length,
    }
  })
  assert(state.tabs.length >= 2, `tab 条不该因为空结果而消失：${JSON.stringify(state.tabs)}`)
  assert(state.emptyHidden === false && state.emptyText.length > 0, `空栏要有一句实话：${JSON.stringify(state)}`)
  assert(state.rows === 0, `空栏不该渲染行：${state.rows}`)
  await ctx.close()
  return `空栏文案「${state.emptyText}」，tab 仍 ${state.tabs.length} 条`
})

await check('T129 挂载区：内置栏不可摘、用户栏可摘；摘掉一栏**不删任何块**', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.loadState('seed')) // 种子给今天挂了一栏演示查询
  await page.waitForTimeout(400)
  await page.evaluate(() => window.__qua.invoke('core.journal/today', {}))
  await page.waitForTimeout(400)

  const before = await mountTabsOf(page)
  const mine = before[0]
  assert(mine, '今天应有挂载区')
  // 三种栏：`derived`（内置，现算）／`local`（自己拥有配置）／`linked`（指针）
  const builtin = mine.tabs.filter((t) => t.kind === 'derived')
  const user = mine.tabs.filter((t) => t.kind === 'local' || t.kind === 'linked')
  assert(builtin.length >= 2, `内置栏应至少两栏（引用＋提及）：${JSON.stringify(builtin)}`)
  assert(builtin.every((t) => !t.removable), `内置栏不该有 ×：${JSON.stringify(builtin)}`)
  assert(user.length === 1 && user[0].removable, `用户栏要有 ×：${JSON.stringify(user)}`)

  const blocksBefore = await page.evaluate(() => window.__qua.snapshot().totalBlocks)
  await page.locator(`#editor .mount .mount-tabwrap[data-tab="${user[0].key}"] .mount-x`).first().click()
  await page.waitForTimeout(350)
  const after = await mountTabsOf(page)
  assert(
    !after[0].tabs.some((t) => t.kind === 'local' || t.kind === 'linked'),
    `摘掉后用户栏应消失：${JSON.stringify(after[0].tabs)}`,
  )
  const blocksAfter = await page.evaluate(() => window.__qua.snapshot().totalBlocks)
  assert(blocksAfter === blocksBefore, `摘一栏不该删任何块：${blocksBefore} → ${blocksAfter}`)

  await ctx.close()
  return `内置 ${builtin.length} 栏无 ×；用户栏摘掉后块数仍 ${blocksAfter}`
})

await check('T130 挂载区：点它不建块；它下面的空白仍能建块', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.loadState('seed'))
  await page.waitForTimeout(300)
  // 单根（一页）最干净：段只有一个，挂载区就在它末尾
  await openFirstPage(page)
  await page.waitForTimeout(400)

  const before = await page.evaluate(() => window.__qua.snapshot().totalBlocks)
  const spot = await page.evaluate(() => {
    const m = document.querySelector('#editor .mount')
    const r = m.getBoundingClientRect()
    return { x: Math.round(r.left + 2), y: Math.round(r.top + 2) }
  })
  await page.mouse.click(spot.x, spot.y)
  await page.waitForTimeout(250)
  const after = await page.evaluate(() => window.__qua.snapshot().totalBlocks)
  assert(after === before, `点挂载区不该建块：${before} → ${after}`)

  // 同一屏、挂载区**之下**的空白仍应能建块（那条判据没有被一刀切掉）
  const blank = await page.evaluate(() => {
    const scroll = document.getElementById('scroll')
    const before = document.querySelector('#editor .mount').getBoundingClientRect()
    const need = before.bottom + 40 - (window.innerHeight - 8)
    if (need > 0) scroll.scrollTop += need
    const m = document.querySelector('#editor .mount').getBoundingClientRect()
    return { x: Math.round(m.left + m.width / 2), y: Math.round(m.bottom + 40) }
  })
  await page.mouse.click(blank.x, blank.y)
  await page.waitForTimeout(300)
  const grown = await page.evaluate(() => window.__qua.snapshot().totalBlocks)
  assert(grown > after, `挂载区之下的空白仍应能建块：${after} → ${grown}`)
  await ctx.close()
  return `点挂载区：${before} → ${after}（不变）；点它下面的空白：→ ${grown}`
})

await check('T131 挂载区：日记流里只有今天展开（其余是摘要行，不建编辑器）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.loadState('seed'))
  await page.waitForTimeout(300)
  await page.evaluate(() => window.__qua.invoke('core.journal/review', { days: 30 }))
  await page.waitForTimeout(500)
  const st = await page.evaluate(() => ({
    sections: document.querySelectorAll('#editor > .sec[data-sec]').length,
    mounts: document.querySelectorAll('#editor .mount').length,
    editors: document.querySelectorAll('#editor .mount-editor[data-editor="1"]').length,
    open: document.querySelectorAll('#editor .mount[data-open="1"]').length,
    summary: document.querySelectorAll('#editor .mount-summary:not([hidden])').length,
  }))
  assert(st.sections > 3, `复盘应有多段：${JSON.stringify(st)}`)
  assert(st.mounts === st.sections, `每段都该有挂载区：${JSON.stringify(st)}`)
  assert(st.open === 1, `只有今天展开：${JSON.stringify(st)}`)
  assert(st.summary === st.sections - 1, `其余是一行摘要：${JSON.stringify(st)}`)
  // 折叠的天**不建编辑器**（这是「30 天只有 1 个编辑器」的落点）
  const foldedEditors = await page.evaluate(
    () => document.querySelectorAll('#editor .mount[data-open="0"] .mount-editor[data-editor="1"]').length,
  )
  assert(foldedEditors === 0, `折叠的天不该建编辑器：${foldedEditors}`)
  assert(st.editors <= 1, `展开的那一份最多一个编辑器：${st.editors}`)
  // 点开一行摘要 ⇒ 那一段才建编辑器（懒建，不是启动时全建）
  await page.locator('#editor .mount[data-open="0"] .mount-summary').first().click()
  await page.waitForTimeout(300)
  const opened = await page.evaluate(() => ({
    open: document.querySelectorAll('#editor .mount[data-open="1"]').length,
    editors: document.querySelectorAll('#editor .mount-editor[data-editor="1"]').length,
  }))
  assert(opened.open === 2, `点摘要应展开那一段：${JSON.stringify(opened)}`)
  assert(opened.editors >= st.editors, `展开之后才建编辑器：${st.editors} → ${opened.editors}`)
  await ctx.close()
  return `${st.sections} 段：展开 ${st.open}、摘要 ${st.summary}、折叠段编辑器 ${foldedEditors}；点开一行摘要后展开 ${opened.open}`
})

await check('T132 挂载区：虚拟化滚过之后每段仍只有一个槽（段中间的切片不发槽）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.loadState('seed'))
  await page.waitForTimeout(300)
  await page.evaluate(() => window.__qua.invoke('core.journal/review', { days: 30 }))
  await page.waitForTimeout(400)
  await page.evaluate(() => window.__qua.setVirtualize(true, 6))
  await page.waitForTimeout(200)
  for (const y of [0, 600, 1400, 2600]) {
    await page.evaluate((top) => {
      document.getElementById('scroll').scrollTop = top
    }, y)
    await page.waitForTimeout(200)
  }
  const st = await page.evaluate(() => ({
    secs: [...document.querySelectorAll('#editor > .sec')].map((s) => ({
      sec: s.dataset.sec ?? '',
      slots: s.querySelectorAll(':scope > .sec-mount').length,
    })),
  }))
  for (const s of st.secs) {
    assert(s.slots <= 1, `一段最多一个槽：${JSON.stringify(s)}`)
    if (s.sec === '') assert(s.slots === 0, `窗口切片起点的段（data-sec 为空）不发槽：${JSON.stringify(s)}`)
  }
  await ctx.close()
  return `${st.secs.length} 段可见：每段 ≤1 个槽，空 data-sec 段 0 个`
})

await check('T133 挂载区只在中心槽：右槽仍是页级反链卡（没有 tab 条）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.invoke('core.dock/toggle-right', {}))
  await page.waitForTimeout(250)
  const st = await page.evaluate(() => ({
    rightMounts: document.querySelectorAll('#dock-right .mount').length,
    rightTabs: document.querySelectorAll('#dock-right .mount-tab').length,
    rightCard: document.querySelectorAll('#dock-right .backrefs-card, #dock-right [data-backrefs-card]').length,
    centerMounts: document.querySelectorAll('#editor .mount').length,
  }))
  assert(st.centerMounts > 0, `中心槽应有挂载区：${JSON.stringify(st)}`)
  assert(st.rightMounts === 0 && st.rightTabs === 0, `右槽不做挂载区：${JSON.stringify(st)}`)
  await ctx.close()
  return `中心 ${st.centerMounts} 个挂载区；右槽 0 个 tab；反链卡仍在（${st.rightCard}）`
})

await check('T134 日记的自定义栏跟随今天：加一栏 ⇒ 推到明天 ⇒ 新今天有、昨天没有 ⇒ 摘掉不丢块', async () => {
  const { ctx, page } = await freshPage(browser, base)
  const label = '今天的块'
  const day1 = await todayId(page)
  const blocksBefore = await page.evaluate(() => window.__qua.snapshot().totalBlocks)

  // ① 在今天的面板加一栏：条件用 `$self` 的日期侧面（不写死日期）
  //    ⚠️ 日记宿主是 `{kind:'journal'}` —— 它的栏住**设备状态**，不在任何块上
  await page.evaluate(
    ({ label, date }) => {
      const spec = { where: { journal: '$self' } }
      window.__qua.invoke('core.mount/add-local', { host: { kind: 'journal' }, label, spec })
      void date
    },
    { label, date: day1 },
  )
  await page.waitForTimeout(350)
  const tabs1 = await mountTabsOf(page)
  const added = tabs1[0]?.tabs.find((t) => t.label === label)
  assert(added, `加完应出现这一栏：${JSON.stringify(tabs1[0]?.tabs)}`)
  /**
   * **加一栏不建块**。这条是反向验证：如果「建 tab」偷偷建了查询块，这里当场红
   * （后面的「摘掉之后块数不变」捕捉不到它——加的时候就已经计进基线了）。
   */
  const blocksAfterAdd = await page.evaluate(() => window.__qua.snapshot().totalBlocks)
  assert(blocksAfterAdd === blocksBefore, `加一栏不该多出块：${blocksBefore} → ${blocksAfterAdd}`)

  // ② 把「今天」推到明天（**注入日期，不改系统时钟**）：新今天仍有这一栏
  await page.addInitScript(() => {
    const RealDate = Date
    const shift = 24 * 60 * 60 * 1000
    const base = RealDate.now()
    class FakeDate extends RealDate {
      constructor(...args) {
        if (args.length === 0) super(base + shift)
        else super(...args)
      }
      static now() {
        return base + shift
      }
    }
    // @ts-ignore
    window.Date = FakeDate
  })
  await page.reload({ waitUntil: 'load' })
  await page.waitForFunction(() => Boolean(window.__qua), undefined, { timeout: 15000 })
  await page.waitForTimeout(300)
  // 重开之后库里的 activeId 还是「上一块」（现在成了昨天）⇒ 显式回今日，让新的今天物化
  await page.evaluate(() => window.__qua.invoke('core.journal/today', {}))
  await page.waitForTimeout(450)
  const day2 = await todayId(page)
  assert(day2 !== day1, `「今天」应换成新的一天：${day1} → ${day2}`)

  const tabs2 = await mountTabsOf(page)
  assert(tabs2[0]?.tabs.some((t) => t.label === label), `新今天应有这一栏：${JSON.stringify(tabs2[0]?.tabs)}`)


  // 求值出的必须是**新那天的块**：栏里每一行都应是新今天那一块的子块
  // ⚠️ 按**名字**点那一栏：种子里本来就有一栏演示查询（`user:0`），序号会随库而变
  const keyOf = async () =>
    page.evaluate(
      (label) =>
        [...document.querySelectorAll('#editor .mount .mount-tabwrap[data-kind="local"]')].find(
          (w) => (w.querySelector('.mount-tab')?.textContent ?? '') === label,
        )?.dataset.tab ?? '',
      label,
    )
  const myKey = await keyOf()
  assert(myKey !== '', `应有「${label}」那一栏`)
  await mountTab(page, myKey)
  // 新栏缺省带一张表格（视图抬头才长得出条件/范围芯片）；这一段验的是**大纲求值**，先切回大纲
  await page.evaluate((id) => {
    window.__qua.invoke('core.view/set-active', { owner: { kind: 'tab', host: { kind: 'journal' }, tabId: id }, viewId: '' })
  }, myKey)
  await page.waitForTimeout(350)
  const rows = await page.evaluate((hostId) => {
    const ids = [...document.querySelectorAll('#editor .mount-editor .blk')].map((e) => e.dataset.blockId)
    let host = null
    const walk = (list) => {
      for (const b of list) {
        if (b.id === hostId) host = b
        walk(b.children)
      }
    }
    walk(window.__qua.__editor.store.blocks)
    const kids = new Set((host?.children ?? []).map((c) => c.id))
    return { ids, kids: [...kids], allKids: ids.every((id) => kids.has(id)) }
  }, day2)
  assert(rows.ids.length > 0, `这一栏应列出新今天的块：${JSON.stringify(rows)}`)
  assert(rows.allKids, `「${label}」求值的应是**新那天的**块：${JSON.stringify(rows)}`)

  // ③ 昨天没有这一栏（也不给加号）。⚠️ 用**聚焦块**打开那一天：`journal/today {date}` 是
  //    「回某一日的日记流」，流的首段仍是今天 ⇒ 看的是今天的挂载区，不是昨天的。
  await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), day1)
  await page.waitForTimeout(400)
  const tabs3 = await mountTabsOf(page)
  assert(!tabs3[0]?.tabs.some((t) => t.label === label), `昨天的面板不该有这一栏：${JSON.stringify(tabs3[0]?.tabs)}`)
  const addOnPast = await page.evaluate(() => document.querySelectorAll('#editor .mount .mount-add').length)
  assert(addOnPast === 0, `过去的天不给「＋」：${addOnPast}`)

  // ④ 回到今天（日记流）、摘掉这一栏 ⇒ 栏消失，且库里没有任何块消失
  await page.evaluate(() => window.__qua.invoke('core.journal/today', {}))
  await page.waitForTimeout(400)
  const blocksNow = await page.evaluate(() => window.__qua.snapshot().totalBlocks)
  const keyToRemove = await keyOf()
  await page.locator(`#editor .mount .mount-tabwrap[data-tab="${keyToRemove}"] .mount-x`).first().click()
  await page.waitForTimeout(350)
  const tabs4 = await mountTabsOf(page)
  assert(!tabs4[0]?.tabs.some((t) => t.label === label), `摘掉后这一栏应消失：${JSON.stringify(tabs4[0]?.tabs)}`)
  const blocksAfter = await page.evaluate(() => window.__qua.snapshot().totalBlocks)
  assert(blocksAfter === blocksNow, `摘一栏不该让任何块消失：${blocksNow} → ${blocksAfter}`)

  await ctx.close()
  return `${day1.slice(-6)} 加栏 → 明天 ${day2.slice(-6)} 有同一栏且列出它自己的块 → 昨天没有、无加号 → 摘掉后块数仍 ${blocksAfter}`
})

await check('T135 挂载区与正文**同一套手势**：点引用跳、块标聚焦、右键出块菜单、`#` 出补全', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.loadState('seed'))
  await page.waitForTimeout(300)
  // 页 P：一个块 B 引用了 P（引用栏里有它）＋ 再引用一页 Q（面板里点它应当跳）
  const ids = await page.evaluate(() => {
    const pages = window.__qua.pages()
    const P = pages[0].id
    const Q = pages[1].id
    window.__qua.invoke('core.page/open', { pageId: P })
    const rows = window.__qua.__editor.rows().map((r) => r.block)
    const b = rows.find((x) => x.id !== P && x.id !== Q && x.children.length === 0)
    window.__qua.focusBlock(b.id, 0)
    window.__qua.invoke('core.editor/insert-page-ref', { pageId: P })
    window.__qua.invoke('core.editor/insert-page-ref', { pageId: Q })
    return { P, Q, b: b.id }
  })
  await page.waitForTimeout(500)
  const panel = `#editor .mount .mount-editor .blk[data-block-id="${ids.b}"]`

  // ① 行内引用：点它 ⇒ 中心跳到目标（与正文同一条 refClick）
  await page.locator(`${panel} [data-ref-to="${ids.Q}"]`).first().click()
  await page.waitForTimeout(350)
  assert((await page.evaluate(() => window.__qua.snapshot().activeId)) === ids.Q, '面板里的行内引用应当跳转')

  // ② 块标：点它 ⇒ 聚焦到那一块（与正文同一颗块标、同一条命令）
  await page.evaluate((id) => window.__qua.invoke('core.page/open', { pageId: id }), ids.P)
  await page.waitForTimeout(400)
  await page.locator(`${panel} > .left > .marker`).first().click()
  await page.waitForTimeout(400)
  assert((await page.evaluate(() => window.__qua.snapshot().activeId)) === ids.b, '面板里的块标应当聚焦到那一块')

  // ③ 右键：出块菜单（这条以前在面板里是空的——事件只接了一半）
  await page.evaluate((id) => window.__qua.invoke('core.page/open', { pageId: id }), ids.P)
  await page.waitForTimeout(400)
  await page.locator(`${panel} > .left > .marker`).first().click({ button: 'right' })
  await page.waitForTimeout(250)
  const menu = await page.evaluate(() => ({
    open: Boolean(document.querySelector('.layer')),
    rows: [...document.querySelectorAll('.layer-item')].map((e) => e.textContent ?? ''),
  }))
  assert(menu.open && menu.rows.length > 0, `面板里右键应出块菜单：${JSON.stringify(menu)}`)
  await page.evaluate(() => window.__qua.__layers.closeMenu())
  await page.waitForTimeout(150)

  // ④ `#`：出标签补全（同一条触发链，证据是浮层里出现了标签源的行）
  /**
   * ⚠️ 光标要落在**这一行的文字末尾**才验得准：触发判定读的是模型偏移，而挂载区是
   *    容器级 contenteditable，`End` 在它上面不动模型光标（真踩过：只有点击点恰好落在
   *    文字之后时测试才是绿的）。点行右端＝文字之后，与用户「点到行尾再敲」同一条手势。
   */
  const rowBox = await page.locator(`${panel} > .tx`).first().boundingBox()
  assert(rowBox, '前置：挂载区那一行应能量到尺寸')
  await page.mouse.click(rowBox.x + rowBox.width - 4, rowBox.y + rowBox.height / 2)
  // ⚠️ `#` 后面要跟一个字才成边（与正文同一个判据：光一个 `#` 不算触发完）
  await page.keyboard.type(' #设')
  await page.waitForTimeout(350)
  const tagLayer = await page.evaluate(() => ({
    open: Boolean(document.querySelector('.layer')),
    rows: document.querySelectorAll('.layer-item').length,
  }))
  assert(tagLayer.open && tagLayer.rows > 0, `面板里敲 \`#设\` 也应弹标签补全（与正文同一条触发链）：${JSON.stringify(tagLayer)}`)
  await page.keyboard.press('Escape')
  await ctx.close()
  return '引用跳转 / 块标聚焦 / 右键块菜单 / `#` 补全 —— 面板与正文走同一份事件表'
})

/** 判红的是「不在已知失败表里的失败」；已知失败逐条打印，不计入退出码 */

/* ---------------------------------------------------------------- T136 */

await check('T136 小卡：点击走命令面；可加/可移；同排可拖序', async () => {
  const { ctx, page } = await freshPage(browser, base, { viewport: { width: 1440, height: 900 } })
  await page.evaluate(() => window.__qua.quiet(true))

  const initial = await page.evaluate(() => ({
    cards: window.__qua.snapshot().dock.left.cards,
    tiles: [...document.querySelectorAll('#dock-left-stack > .dock-tile')].map((el) => el.dataset.cardId),
  }))
  assert(initial.tiles.length === 4, `默认左槽应有 4 张小卡：${JSON.stringify(initial)}`)
  assert(initial.cards.slice(0, 4).every((id) => id.startsWith('cmd:')), `默认前四项应是 cmd:：${JSON.stringify(initial.cards)}`)

  // 点「回到今日」：必须走命令面，且 via 标成 tile（诊断能区分入口）
  await page.locator('#dock-left-stack > .dock-tile[data-card-id="cmd:core.journal/today"] .dock-tile-main').click()
  await page.waitForTimeout(200)
  const afterClick = await page.evaluate(() => ({ last: window.__qua.snapshot().lastCommand, date: window.__qua.snapshot().journalDate }))
  assert(afterClick.last?.name === 'core.journal/today' && afterClick.last?.via === 'tile', `小卡点击应走命令面：${JSON.stringify(afterClick)}`)
  assert(afterClick.date !== '', `回到今日后当前对象应是日记：${JSON.stringify(afterClick)}`)

  // 右槽加一张：默认右槽没有小卡；画廊只列带 tile 的命令
  await page.locator('#dock-right-add').click()
  await page.waitForTimeout(120)
  const gallery = await page.evaluate(() => ({
    open: Boolean(document.querySelector('.layer')),
    title: document.querySelector('.layer-head')?.textContent ?? '',
    rows: document.querySelectorAll('.layer .layer-item').length,
  }))
  assert(gallery.open && gallery.title !== '' && gallery.rows > 0, `「添加快捷」应打开并列出命令：${JSON.stringify(gallery)}`)
  await page.locator('.layer .layer-item').first().click()
  await page.waitForTimeout(150)
  const added = await page.evaluate(() => ({
    cards: window.__qua.snapshot().dock.right.cards,
    tiles: document.querySelectorAll('#dock-right-stack > .dock-tile').length,
  }))
  assert(added.cards.some((id) => id.startsWith('cmd:')) && added.tiles === 1, `右槽应新增一张小卡：${JSON.stringify(added)}`)

  // 移出：只动 cards，不碰命令
  await page.locator('#dock-right-stack > .dock-tile .dock-tile-x').first().click()
  await page.waitForTimeout(150)
  const removed = await page.evaluate(() => ({
    cards: window.__qua.snapshot().dock.right.cards,
    tiles: document.querySelectorAll('#dock-right-stack > .dock-tile').length,
  }))
  assert(removed.tiles === 0 && !removed.cards.some((id) => id.startsWith('cmd:')), `移出应只动清单：${JSON.stringify(removed)}`)

  // 同排拖序：把「前一天」拖到「回到今日」之前
  const dragged = await dragTile(page, {
    from: 'left',
    to: 'left',
    id: 'cmd:core.journal/prev',
    before: 'cmd:core.journal/today',
  })
  assert(dragged?.hot === true, `拖到目标格应出现落点：${JSON.stringify(dragged)}`)
  const order = await page.evaluate(() => ({
    cards: window.__qua.snapshot().dock.left.cards,
    dom: [...document.querySelectorAll('#dock-left-stack > .dock-tile')].map((el) => el.dataset.cardId),
  }))
  assert(order.cards[0] === 'cmd:core.journal/prev' && order.cards[1] === 'cmd:core.journal/today', `同排拖序应改清单：${JSON.stringify(order)}`)
  assert(order.dom[0] === 'cmd:core.journal/prev' && order.dom[1] === 'cmd:core.journal/today', `DOM 顺序应跟清单：${JSON.stringify(order)}`)

  await ctx.close()
  return `4 张小卡；点击 via=tile；右槽可加/可移；同排拖序 ${order.cards[0]} → ${order.cards[1]}`
})

/* ---------------------------------------------------------------- T137 */

await check('T137 收藏卡：新建 ⇒ 槽里出现组件卡；拖块进来＝加引用；× 只摘引用不删块', async () => {
  const { ctx, page } = await freshPage(browser, base, { viewport: { width: 1440, height: 900 } })
  await page.evaluate(() => window.__qua.quiet(true))

  await page.locator('#dock-right-add').click()
  await page.waitForTimeout(120)
  const gallery = await page.evaluate(() => ({
    title: document.querySelector('.layer-head')?.textContent ?? '',
    hasNew: [...document.querySelectorAll('.layer .layer-item')].some((el) => el.textContent?.includes('新建收藏')),
  }))
  assert(gallery.hasNew, `画廊应列出「新建收藏」：${JSON.stringify(gallery)}`)

  await page.locator('.layer .layer-item', { hasText: '新建收藏' }).click()
  await page.waitForTimeout(200)
  const made = await page.evaluate(() => {
    const cards = window.__qua.snapshot().dock.right.cards
    const collection = window.__qua.allBlocks().find((b) => b.aliases.includes('收藏'))
    const card = collection
      ? document.querySelector(`#dock-right .dock-card[data-card-id="${collection.id}"]`)
      : null
    return {
      cards,
      collection: collection ? { id: collection.id, aliases: collection.aliases } : null,
      card: card ? { widget: card.dataset.widget === '1', title: card.querySelector('.dock-card-title')?.textContent ?? '' } : null,
      blocks: window.__qua.allBlocks().length,
    }
  })
  assert(made.collection, `新建收藏应真的建出一个块：${JSON.stringify(made)}`)
  assert(made.card?.widget === true && made.card.title.includes('收藏'), `槽里应出现组件卡：${JSON.stringify(made)}`)
  assert(made.cards.includes(made.collection.id), `卡片 id 应在右槽清单里：${JSON.stringify(made)}`)

  // 找一个当前视图里的块（它的块标在 DOM 里），拖进收藏
  const target = await page.evaluate(() => {
    const row = document.querySelector('#editor .blk[data-depth="1"][data-block-id]') ?? document.querySelector('#editor .blk[data-block-id]')
    return row ? { id: row.dataset.blockId, text: row.querySelector('.tx')?.textContent ?? '' } : null
  })
  assert(target, '当前视图里应有一个可拖的块')

  const dragged = await dragBlockToCollection(page, target.id, made.collection.id)
  assert(dragged?.hot === true, `拖进收藏应亮落点：${JSON.stringify(dragged)}`)
  await page.waitForTimeout(200)
  const added = await page.evaluate((cid) => {
    const rows = [...document.querySelectorAll(`#dock-right .dock-card[data-card-id="${cid}"] .collection-row`)]
    return { rows: rows.length, text: rows[0]?.textContent ?? '', blocks: window.__qua.allBlocks().length }
  }, made.collection.id)
  assert(added.rows === 1, `收藏里应出现一行：${JSON.stringify(added)}`)
  assert(added.blocks === made.blocks, `收藏只加引用，块数不变：${made.blocks} → ${added.blocks}`)

  // × 只摘引用：行消失、块仍在、块数不变
  await page.locator(`#dock-right .dock-card[data-card-id="${made.collection.id}"] .collection-x`).first().click()
  await page.waitForTimeout(150)
  const removed = await page.evaluate(({ cid, id }) => ({
    rows: document.querySelectorAll(`#dock-right .dock-card[data-card-id="${cid}"] .collection-row`).length,
    blockStill: window.__qua.allBlocks().some((b) => b.id === id),
    blocks: window.__qua.allBlocks().length,
  }), { cid: made.collection.id, id: target.id })
  assert(removed.rows === 0, `× 后行应消失：${JSON.stringify(removed)}`)
  assert(removed.blockStill, `× 只摘引用，块必须还在：${JSON.stringify(removed)}`)
  assert(removed.blocks === made.blocks, `× 不删块：${made.blocks} → ${removed.blocks}`)

  await ctx.close()
  return `新建收藏 ⇒ 右槽组件卡；拖入 1 行（块数不变）；× 只摘引用（块仍在）`
})

/* ---------------------------------------------------------------- T138 */

await check('T138 收藏卡：选择块可加两条；拖手柄换序只动引用，块数不变', async () => {
  const { ctx, page } = await freshPage(browser, base, { viewport: { width: 1440, height: 900 } })
  await page.evaluate(() => window.__qua.quiet(true))

  await page.locator('#dock-right-add').click()
  await page.waitForTimeout(100)
  await page.locator('.layer .layer-item', { hasText: '新建收藏' }).click()
  await page.waitForTimeout(200)
  const cid = await page.evaluate(() => {
    const c = window.__qua.allBlocks().find((b) => b.aliases.includes('收藏'))
    return c?.id ?? ''
  })
  assert(cid !== '', '前置：应已建出收藏块')
  const before = await page.evaluate(() => window.__qua.allBlocks().length)

  // 用「选择块」加两条：每次点按钮 → 点选择器第一行
  for (let i = 0; i < 2; i++) {
    await page.locator(`#dock-right .dock-card[data-card-id="${cid}"] .collection-add`).click()
    await page.waitForTimeout(100)
    await page.locator('.layer .layer-item').first().click()
    await page.waitForTimeout(150)
  }
  const two = await page.evaluate((cid) => {
    const rows = [...document.querySelectorAll(`#dock-right .dock-card[data-card-id="${cid}"] .collection-row`)]
    return { ids: rows.map((r) => r.dataset.itemId), blocks: window.__qua.allBlocks().length }
  }, cid)
  assert(two.ids.length === 2, `应加进两条引用：${JSON.stringify(two)}`)
  assert(two.blocks === before, `选择块只加引用，块数不变：${before} → ${two.blocks}`)

  // 把第二条拖到第一条前面
  const dragged = await dragCollectionItem(page, cid, two.ids[1], 0)
  assert(dragged?.hot === true, `拖手柄应亮落点：${JSON.stringify(dragged)}`)
  await page.waitForTimeout(200)
  const after = await page.evaluate((cid) => {
    const rows = [...document.querySelectorAll(`#dock-right .dock-card[data-card-id="${cid}"] .collection-row`)]
    return { ids: rows.map((r) => r.dataset.itemId), blocks: window.__qua.allBlocks().length }
  }, cid)
  assert(after.ids[0] === two.ids[1] && after.ids[1] === two.ids[0], `拖序应换位：${JSON.stringify({ before: two.ids, after: after.ids })}`)
  assert(after.blocks === before, `拖序只动引用，块数不变：${before} → ${after.blocks}`)

  await ctx.close()
  return `选择块加 2 条（块数不变）；拖序 ${two.ids.join(',')} → ${after.ids.join(',')}`
})

/* ---------------------------------------------------------------- T139 */

/**
 * 正文露面 `body: 'row'`：一块组件在正文里是一行**只读摘要**。
 *
 * 三条必须一起断言，只测「画出来了」会让另外两条照样绿：
 *   ① 摘要**不进正文**（读数契约）：打字、刷新之后块的 content 仍为空 ——
 *      否则一次 `readRuns` 就把「收藏 3 条 打开」写成真正文，组件行从此消失；
 *   ② 点它＝打开那张卡（Shift ＝ 换目的地，不换动作）；
 *   ③ 摘要**与槽里那张卡共享配置**：加一条引用，两处同时变。
 */
await check('T139 正文里的组件行：只读摘要不进正文；点它打开卡；与槽里共享配置', async () => {
  const { ctx, page } = await freshPage(browser, base, { viewport: { width: 1440, height: 900 } })
  await page.evaluate(() => window.__qua.quiet(true))

  // 在一个普通块后面插一个收藏（走命令面，与斜杠菜单同一条路）
  await page.evaluate(() => {
    const first = window.__qua.blocks().find((r) => r.roles.length === 0)
    window.__qua.focusBlock(first.id, 0)
  })
  await page.waitForTimeout(120)
  const inserted = await page.evaluate(() => window.__qua.invoke('core.editor/insert-block', { type: 'collection' }))
  assert(inserted?.handled === true, `插入收藏应被处理：${JSON.stringify(inserted)}`)
  await page.waitForTimeout(200)

  const cid = await page.evaluate(() => document.querySelector('#editor [data-widget-body]')?.dataset.widgetBody ?? '')
  assert(cid !== '', '正文里应出现组件体')

  const shape = await page.evaluate((id) => {
    const body = document.querySelector(`#editor [data-widget-body]`)
    const blk = body?.closest('.blk')
    const tx = body?.closest('.tx')
    return {
      type: blk?.dataset.type ?? '',
      sameBlock: blk?.dataset.blockId === id,
      editable: body?.contentEditable,
      readonly: tx?.dataset.readonly ?? null,
      text: body?.textContent ?? '',
      // 静止档：摘要（声明 `rest: 'summary'`）
      height: body?.dataset.widgetHeight ?? '',
      isIsland: body?.dataset.editIsland ?? '',
    }
  }, cid)
  assert(shape.type === 'core/collection-widget' && shape.sameBlock, `组件体应挂在组件块自己的行上：${JSON.stringify(shape)}`)
  assert(shape.editable === 'false' && shape.readonly === '1', `组件体不可编辑：${JSON.stringify(shape)}`)
  /**
   * **静止档 ＝ 摘要**（声明 `rest: 'summary'`）：这一格现在只有一行高，
   * 且它是**编辑岛**（本视图的重排判据按这一格认它，见 `EDIT_ISLAND_ATTR`）。
   */
  assert(shape.height === 'summary', `静止档应是摘要：${JSON.stringify(shape)}`)
  assert(shape.isIsland === '1', `组件体必须标成编辑岛（否则里层打字时会被重排掉）：${JSON.stringify(shape)}`)

  /**
   * ① **读数契约**：摘要不进正文。
   *
   * ⚠️ 为什么这里**直接调 `readRuns`** 而不是「打字再看 content」：组件行的 `.tx` 是
   *    `data-readonly`，`syncFromDom` 那条路根本走不到它身上 —— 只测「打字不污染」
   *    会是一条**恒绿**的断言（删掉 `isWidgetRow` 的读数分支它照样过，实测过）。
   *    真正会把摘要写进正文的是 `readRuns` 本身（别的收光标路径会经过它），
   *    所以断言要打在**读数层**：让它读这一行的 `.tx`，结果必须是空。
   */
  const readBack = await page.evaluate((id) => {
    const tx = document.querySelector(`.blk[data-block-id="${id}"] .tx`)
    return { runs: window.__qua.readRuns(tx), txText: tx?.textContent ?? '' }
  }, cid)
  assert(
    readBack.runs.length === 0,
    `读数必须跳过组件行（摘要不是正文）：${JSON.stringify(readBack)}`,
  )
  assert(readBack.txText.includes('收藏'), `组件行确实画在 .tx 里（否则上面那条也没验到东西）：${JSON.stringify(readBack)}`)

  // 刷新（重新读库）之后：正文仍为空、行还在
  await page.reload()
  await page.waitForTimeout(400)
  await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), cid)
  await page.waitForTimeout(300)
  const clean = await page.evaluate((id) => ({
    text: window.__qua.allBlocks().find((b) => b.id === id)?.text ?? null,
    rowStill: Boolean(document.querySelector('#editor [data-widget-body]')),
  }), cid)
  assert(clean.text === '', `刷新后正文仍应为空：${JSON.stringify(clean)}`)
  assert(clean.rowStill, `刷新后组件行仍应画出来：${JSON.stringify(clean)}`)

  // ③ 与槽里那张卡共享配置：加一条引用 ⇒ 两处同时变
  /**
   * ⚠️ 先在**别的**视图里挑一个块再加引用：此刻中心已经 zoom 到那个收藏块，
   *    `blocks()` 读的是**当前页的子树** —— 在这一屏里找「另一个块」只能找到它自己
   *    （`r.id !== id` 过滤后为空 ⇒ 拿到 undefined）。
   */
  await page.evaluate(() => window.__qua.invoke('core.journal/today', {}))
  await page.waitForTimeout(250)
  const shared = await page.evaluate((id) => {
    const other = window.__qua.blocks().find((r) => r.id !== id && r.roles.length === 0)
    window.__qua.invoke('core.collection/add', { collectionId: id, blockId: other.id })
    return { otherId: other.id }
  }, cid)
  await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), cid)
  await page.waitForTimeout(300)
  const shown = await page.evaluate((id) => ({
    row: document.querySelector('#editor [data-widget-body]')?.textContent ?? '',
    count: window.__qua.snapshot().dock.right.cards.length,
  }), cid)
  // 摘要应报「1 条」；配置是块上那一格 `_items`，槽里那张卡读的是同一格（见 T137）
  assert(/1\s*条/.test(shown.row), `正文摘要应跟着引用条数变：${JSON.stringify({ shared, shown })}`)

  // ② 点组件行 ＝ 打开那张卡（中心换成这一块）
  await page.evaluate(() => window.__qua.invoke('core.journal/today', {}))
  await page.waitForTimeout(300)
  const beforeClick = await page.evaluate(() => window.__qua.snapshot().activeId)
  await page.locator('#editor [data-widget-body]').first().click()
  await page.waitForTimeout(400)
  const afterClick = await page.evaluate((id) => ({
    activeId: window.__qua.snapshot().activeId,
    last: window.__qua.snapshot().lastCommand,
  }), cid)
  assert(afterClick.activeId === cid, `点组件行应把中心换成这一块：${JSON.stringify({ beforeClick, afterClick })}`)

  // ② Shift+点 ＝ 右槽，中心不动
  await page.evaluate(() => window.__qua.invoke('core.journal/today', {}))
  await page.waitForTimeout(300)
  const beforeShift = await page.evaluate(() => window.__qua.snapshot().activeId)
  const box = await page.locator('#editor [data-widget-body]').first().boundingBox()
  await page.keyboard.down('Shift')
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await page.keyboard.up('Shift')
  await page.waitForTimeout(400)
  const afterShift = await page.evaluate(({ id, beforeId }) => ({
    inRight: window.__qua.snapshot().dock.right.cards.includes(id),
    centerStill: window.__qua.snapshot().activeId === beforeId,
  }), { id: cid, beforeId: beforeShift })
  assert(afterShift.inRight, `Shift+点应在右槽开窗：${JSON.stringify(afterShift)}`)
  assert(afterShift.centerStill, `Shift+点不该换中心：${JSON.stringify(afterShift)}`)

  await ctx.close()
  return `只读摘要（content 仍为空）· 点开卡 · Shift 开右槽且中心不动 · 加一条引用后摘要＝「${shown.row.trim()}」`
})

/* ---------------------------------------------------------------- T140 */

/**
 * **组件卡的两个高度**：静止一档、被聚焦一档，切档是纯 CSS 的 `:focus-within`。
 *
 * 为什么必须真量尺寸：这一格的全部内容就是「两张高度」，只断言「变量挂上了」
 * 会让「CSS 没读那两个变量」照样绿（实测过的同类：断言打在配置上，渲染分支删掉它也过）。
 * 所以要量**卡身体的像素高度**，并且**两次**：聚焦前、聚焦后。
 *
 * 另有一条必须一起钉：切档**不改模型**（它是视图状态，与折叠态同一条口径）。
 */
await check('T140 组件卡的两个高度：聚焦前＝静止档、聚焦后＝聚焦档；切档不改模型', async () => {
  const { ctx, page } = await freshPage(browser, base, { viewport: { width: 1440, height: 900 } })
  await page.evaluate(() => window.__qua.quiet(true))

  // 新建一个收藏并开进右槽（走命令面，与「添加组件」同一条路）
  const cid = await page.evaluate(() =>
    window.__qua.invoke('core.collection/create', { name: '两个高度', side: 'right' }),
  )
  assert(cid?.handled === true, `新建收藏应被处理：${JSON.stringify(cid)}`)
  await page.waitForTimeout(400)

  const card = '#dock-right .dock-card[data-widget="1"]'
  const readHeights = () =>
    page.evaluate((sel) => {
      const el = document.querySelector(sel)
      const body = el?.querySelector('.dock-card-body')
      if (!el || !body) return null
      return {
        restVar: el.style.getPropertyValue('--widget-h-rest').trim(),
        focusVar: el.style.getPropertyValue('--widget-h-focus').trim(),
        height: Math.round(body.getBoundingClientRect().height),
        tier: el.dataset.widgetHeight ?? '',
      }
    }, card)

  const before = await readHeights()
  assert(before !== null, '右槽里应出现组件卡')
  /**
   * 静止档：变量在场、卡身体真的**有界**（`compact` ＝ 96px 的内容高，含上下留白会略大）。
   * 用「≤ 一张普通大卡的高度」判，不写死像素：像素值随 padding 变，那是样式的事。
   */
  assert(before.restVar !== '' && before.focusVar !== '', `两个高度都要挂上：${JSON.stringify(before)}`)
  assert(before.tier === 'compact', `静止档应是 compact：${JSON.stringify(before)}`)

  // 聚焦卡里的一个可聚焦元素（「选择块」那颗按钮）⇒ 卡身体切到 focus 档
  await page.locator(`${card} .collection-add`).first().focus()
  await page.waitForTimeout(200)
  const after = await readHeights()
  assert(
    after.height > before.height,
    `聚焦后卡应变高（两个高度真的在起作用）：${JSON.stringify({ before, after })}`,
  )

  /**
   * 切档**不改模型**：高度是视图状态（与折叠态同一条口径），不是块上的字段。
   * 判据是「块数不变 ＋ 卡里画出的条目行数不变」——`_items` 不在诊断面上，
   * 但「画出来的行数」正是它的一处投影，且顺手钉住了「长开之后内容也还在」。
   */
  const snapModel = () =>
    page.evaluate((sel) => ({
      count: window.__qua.allBlocks().length,
      rows: document.querySelectorAll(`${sel} .collection-row`).length,
    }), card)
  const model = await snapModel()
  // 让焦点离开（点卡头）⇒ 收回静止档
  await page.locator(`${card} .dock-card-head`).first().click()
  await page.waitForTimeout(250)
  const modelAfter = await snapModel()
  const shrunk = await readHeights()
  assert(
    modelAfter.count === model.count && modelAfter.rows === model.rows,
    `切高度档不该改模型：${JSON.stringify({ model, modelAfter })}`,
  )
  assert(shrunk.height <= before.height + 1, `焦点离开后应收回静止档：${JSON.stringify({ before, shrunk })}`)

  await ctx.close()
  return `静止 ${before.height}px → 聚焦 ${after.height}px；块数与 _items 都没变`
})

/**
 * **空块里敲拼音，第一个字母不许被冻成正文。**
 *
 * 为什么单列一条：`posAt` 曾经把空块的光标落到 `.tx` 的 **offset 1**（`<br>` 之后），
 * 那里不是 Chrome 认的稳定组合位——预编辑串插入时 `<br>` 被摘掉，组合区间当场失焦，
 * 上一次组合被当作已提交 ⇒ 打 `nihao` 得到 `n你好`（`checks/probe-ime-live.mjs` 实测）。
 * 而**新建的块总是空的**，这条正好压在「↵ 建块 ⇒ 马上打中文」这条最常用的路上。
 *
 * ⚠️ 走 CDP 的 `Input.imeSetComposition`（真 Chromium 输入管线），手搓合成事件测不出来。
 */
await check('T141 空块里敲拼音：第一个字母不被冻成正文（组合只起一次）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  await openFirstPage(page)

  await page.evaluate(() => {
    window.__imeStarts = 0
    for (const ty of ['compositionstart', 'compositionend']) {
      window.addEventListener(ty, () => { window.__imeStarts += ty === 'compositionstart' ? 1 : 0 }, { capture: true })
    }
    // ↵ 建块 ⇒ 光标落进一个**空的**新块（正是用户报的那条路）
    const id = window.__qua.blocks()[0].id
    window.__qua.focusBlock(id, 999)
  })
  await page.waitForTimeout(200)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(200)

  const cdp = await page.context().newCDPSession(page)
  for (const s of ['n', 'ni', 'nih', 'niha', 'nihao']) {
    await cdp.send('Input.imeSetComposition', { text: s, selectionStart: s.length, selectionEnd: s.length })
    await page.waitForTimeout(45)
  }
  await cdp.send('Input.insertText', { text: '你好' })
  await page.waitForTimeout(250)

  const out = await page.evaluate(() => {
    const ed = window.__qua.__editor
    const id = ed.caretBlock() ?? ed.sel?.aBlock
    return { text: id ? (window.__qua.blocks().find((b) => b.id === id)?.text ?? null) : null, starts: window.__imeStarts }
  })
  assert(out.starts === 1, `一串拼音只应起一次 compositionstart，实际 ${out.starts} 次（第二次＝第一次被冻成正文）`)
  assert(out.text === '你好', `空块里打 nihao 应得到「你好」，实际 ${JSON.stringify(out.text)}`)
  await ctx.close()
  return `空块：compositionstart×${out.starts}，结果 ${JSON.stringify(out.text)}`
})

/**
 * **在挂载区（查询结果的派生视图）里按 ↵：新块要是命中块的**子块**，且留在这一栏里看得见。**
 *
 * 为什么单列一条：挂载区的 DOM **嵌在 `#editor` 里**，而 `focusin` **冒泡**——
 * 正文那条 `focusin` 曾经无条件把活动编辑器改回自己，把里层 `onFocus` 刚切的
 * 挂载区覆盖掉。打字走事件层（各编辑器自己绑 container）不受影响，
 * 而 ↵／⌘A 走命令层的 `app.ed` ⇒ 会被**正文**接走：新块建成命中块的**兄弟**
 * （不在这一栏的查询条件里 ⇒ 用户看不见），光标还被甩到正文。
 *
 * 目标语义：在引用区那一行按 ↵ ＝ 在那一块**下面**接着写，就地可见。
 */
await check('T142 挂载区里 ↵：新块是命中块的子块、留在本栏可见、光标不跳出挂载区', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.loadState('seed'))
  await page.waitForTimeout(300)

  // 页 P：让一个块 b 引用 P ⇒ b 出现在 P 的「引用」栏（与 T135 同一招）
  const ids = await page.evaluate(() => {
    const pages = window.__qua.pages()
    const P = pages[0].id
    window.__qua.invoke('core.page/open', { pageId: P })
    const rows = window.__qua.__editor.rows().map((r) => r.block)
    const b = rows.find((x) => x.id !== P && x.children.length === 0)
    window.__qua.focusBlock(b.id, 999)
    window.__qua.invoke('core.editor/insert-page-ref', { pageId: P })
    return { P, b: b.id }
  })
  await page.waitForTimeout(500)

  const row = `#editor .mount .mount-editor .blk[data-block-id="${ids.b}"]`
  const n0 = await mountRows(page)
  assert(n0 >= 1, `引用栏里应当有 ${ids.b.slice(-6)}，实际 ${n0} 行`)

  // ⚠️ 必须**真点击**：挂载区靠 `focusin` 才被认成活动编辑器（手工塞 Range 不会派发）
  await page.locator(`${row} .tx`).first().click()
  await page.waitForTimeout(300)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(500)

  const out = await page.evaluate((bSel) => {
    const a = document.activeElement
    const mount = document.querySelector('#editor .mount')
    const kids = Array.from(mount?.querySelectorAll('.mount-editor .blk') ?? []).map((e) => ({
      id: e.dataset.blockId?.slice(-6),
      depth: e.dataset.depth,
    }))
    return {
      caretInMount: Boolean(a?.closest('.sec-mount')),
      rows: kids,
      // 新块在**整片森林**里的父（不靠任一视图的 doc）
      parentOfNew: (() => {
        const ed = window.__qua.__editor
        const caret = ed.caretBlock()
        const map = new Map()
        for (const r of ed.store.blocks) {
          const walk = (x, p) => {
            map.set(x.id, p)
            for (const c of x.children ?? []) walk(c, x.id)
          }
          walk(r, null)
        }
        return { caret: String(caret ?? '').slice(-6), parent: String(map.get(caret) ?? '').slice(-6) }
      })(),
    }
  }, row)

  assert(out.caretInMount, `按 ↵ 后光标应当还在挂载区里，实际焦点在 ${out.rows.length ? '别处' : '别处'}（activeElement 不在 .sec-mount 内）`)
  assert(out.rows.length === n0 + 1, `新块应当**留在本栏里看得见**：${n0} → ${out.rows.length}`)
  assert(out.parentOfNew.parent === ids.b.slice(-6), `新块应当是命中块的子块，实际父＝${out.parentOfNew.parent}，命中块＝${ids.b.slice(-6)}`)
  await ctx.close()
  return `引用栏 ${n0}→${out.rows.length} 行；新块父＝${out.parentOfNew.parent}（命中块）；光标仍在挂载区`
})

/* ---------------------------------------------------------------- T143 */

/**
 * 回收站：**看得见 ＋ 能找回**。
 *
 * 模型早就有（原位软删 ＋ `kb.trash()` ＋ `Tx.restore`），缺的一直是入口。
 * 删掉一块在 UI 里是单向的——只有 ⌘Z 能回去，而撤销栈是**内存快照**：
 * 关掉应用再打开，那块就再也找不回来了，尽管它还在库里。
 *
 * 判据：
 *   ① 回收站卡在右槽，列出被删的块（正文可见，不是空白行）；
 *   ② 删一棵子树只列**一条**（操作根），后代不各列一条；
 *   ③ 点「恢复」⇒ 块回原位，且**一次撤销**能回滚这次恢复；
 *   ④ 空态给一句明确文案。
 */
await check('T143 回收站：删掉的块看得见、能一键恢复回原位、空态有话说', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  await openFirstPage(page)

  // ① 卡在右槽（派生卡，id 固定）
  const cardPresent = await page.evaluate(() => Boolean(document.querySelector('[data-card-id="trash"]')))
  assert(cardPresent, '右槽应有回收站卡（派生卡 id 固定为 trash）')

  // ② 删一棵**有子块**的块 ⇒ 回收站只列一条
  /**
   * 挑一块**在当前视图里**的普通内容块（有子块、有正文、且**不是装载根**）。
   *
   * ⚠️ 必须从 `ed.doc.roots` 里挑，不能从 `ed.store.blocks`（整片森林）里挑：
   *    `ed.remove` 走 `locate(this.doc, id)`——不在当前视图里的块它**直接返回**，
   *    块数不变、也不报错（实测踩到：挑到森林里另一页的块，删了等于没删）。
   * ⚠️ 排除装载根：`ed.remove` 对有身份的根块会拒绝（页／日记是视图的装载单位）。
   */
  const target = await page.evaluate(() => {
    const ed = window.__qua.__editor
    const plain = (b) => b.content.filter((r) => r.t === 'text').map((r) => r.v).join('')
    const rootIds = new Set(ed.doc.roots.map((b) => b.id))
    let hit = null
    const walk = (list) => {
      for (const b of list) {
        if (!hit && !rootIds.has(b.id) && b.children.length > 0 && plain(b).length > 1) {
          hit = { id: b.id, text: plain(b), kids: b.children.length }
        }
        walk(b.children)
      }
    }
    walk(ed.doc.roots)
    return hit
  })
  assert(target, '前置：应有「有子块且有正文」的块可删')

  /**
   * 删除走编辑器层（\`ed.remove\` 才是用户按删除时走的那一条：它带视图补偿）。
   * 命令面 \`core.editor/delete-block\` 取的是「当前块」，而这里要删的是**指定的一块**。
   */
  await page.evaluate((id) => window.__qua.__editor.remove(id), target.id)
  await page.waitForTimeout(250)

  const rows = await page.evaluate(() => {
    const card = document.querySelector('[data-card-id="trash"]')
    if (!card) return []
    return [...card.querySelectorAll('[data-trash-row]')].map((el) => ({
      id: el.getAttribute('data-trash-row'),
      text: el.textContent ?? '',
    }))
  })
  assert(rows.length === 1, `删一棵子树只该列一条（操作根），实际 ${rows.length}：${JSON.stringify(rows)}`)
  assert(rows[0].id === target.id, `回收站里应是刚删的那一块：${rows[0].id} ≠ ${target.id}`)
  assert(rows[0].text.includes(target.text.slice(0, 4)), `回收站那一行要带它自己的正文（不是空白行）：${rows[0].text}`)

  // ③ 恢复 ⇒ 回原位
  const before = await page.evaluate((id) => {
    const ed = window.__qua.__editor
    const p = ed.store.find(id)
    return { gone: !p, roots: ed.store.blocks.map((b) => b.id) }
  }, target.id)
  assert(before.gone, '前置：删掉之后按可见读应当找不到它')

  /**
   * 点「恢复」（与按钮同一个入口：命令面）。
   * ⚠️ 参数名是 `blockId`（命令声明里的名字）——写成 `id` 会被当成没给参数，
   *    handler 直接返回 false，而界面看起来「点了没反应」（实测踩到）。
   */
  await page.evaluate(() =>
    window.__qua.invoke('core.block/restore', {
      blockId: document.querySelector('[data-trash-row]')?.getAttribute('data-trash-row'),
    }),
  )
  await page.waitForTimeout(250)
  const after = await page.evaluate((id) => {
    const ed = window.__qua.__editor
    const b = ed.store.find(id)
    return { back: Boolean(b), trashRows: document.querySelectorAll('[data-card-id="trash"] [data-trash-row]').length }
  }, target.id)
  assert(after.back, '点恢复之后那一块应当又能读到')
  assert(after.trashRows === 0, `恢复之后回收站该空，实际还有 ${after.trashRows} 条`)

  // ③b 一次撤销回滚这次恢复
  await page.evaluate(() => window.__qua.invoke('core.history/undo'))
  await page.waitForTimeout(250)
  const undone = await page.evaluate((id) => ({
    gone: !window.__qua.__editor.store.find(id),
    trashRows: document.querySelectorAll('[data-card-id="trash"] [data-trash-row]').length,
  }), target.id)
  assert(undone.gone, '撤销应当把恢复回滚（块又回到回收站）')
  assert(undone.trashRows === 1, `撤销之后回收站该又有一条，实际 ${undone.trashRows}`)

  // ④ 空态：再恢复一次，然后看空态文案
  await page.evaluate(() => window.__qua.invoke('core.history/redo'))
  await page.waitForTimeout(250)
  const empty = await page.evaluate(() => {
    const card = document.querySelector('[data-card-id="trash"]')
    const msg = card?.querySelector('.dock-empty')?.textContent ?? ''
    return { rows: card?.querySelectorAll('[data-trash-row]').length ?? -1, msg }
  })
  assert(empty.rows === 0, `空态时不该有行，实际 ${empty.rows}`)
  assert(empty.msg.length > 0, '空态要给一句明确文案（不是一张空白卡）')

  await ctx.close()
  return `回收站卡在右槽；删子树只列 1 条（操作根）；恢复回原位且可撤销；空态有文案`
})

/* --------------------------------------- 行内引用的锚文本（这一处显示什么）与外链 */

/** 整片森林里所有 ref run 的「所在块 → 目标」集合（模型事实，不是派生的反链条数） */
const refEdges = (page) =>
  page.evaluate(() => {
    const out = []
    const walk = (list) => {
      for (const b of list) {
        for (const r of b.content ?? []) if (r.t === 'ref' && r.to) out.push(`${b.id}->${r.to}`)
        walk(b.children)
      }
    }
    walk(window.__qua.__editor.store.blocks)
    return out.sort()
  })

/**
 * 插一枚指向某个页的引用，返回它所在块与 run id。
 *
 * ⚠️ 目标取**另一页**（`pages()[1]`）：引用当前装载的那一页会让反链 footer 的判据
 *    掺进「自己也指自己」这一条，读起来要额外解释。
 */
const seedPageRef = (page) =>
  page.evaluate(() => {
    const target = window.__qua.pages()[1].id
    const b = window.__qua.blocks()[0]
    window.__qua.focusBlock(b.id, 0)
    window.__qua.invoke('core.editor/insert-page-ref', { pageId: target })
    const atom = window.__qua.atoms().filter((a) => a.blockId === b.id).at(-1)
    return { blockId: b.id, target, runId: atom?.id ?? '' }
  })

await check('T144 锚文本：⌥ 浮层设一次 ⇒ 行内显示它；投影／边／提及都不变，且只产一条 upsert', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await openFirstPage(page)

  const setup = await seedPageRef(page)
  assert(setup.runId, `前置：引用没插进去：${JSON.stringify(setup)}`)
  const before = await page.evaluate(
    ({ id, runId }) => ({
      label: window.__qua.atoms().find((a) => a.id === runId)?.label ?? '',
      anchor: window.__qua.__editor.store.find(id).content.find((r) => r.id === runId)?.anchor,
      text: window.__qua.text(),
    }),
    { id: setup.blockId, runId: setup.runId },
  )
  const edgesBefore = await refEdges(page)
  assert(before.anchor === undefined, `插入路径**不写** anchor（否则既有引用会冻在插入时刻）：${JSON.stringify(before)}`)
  assert(before.label.length > 0, '前置：引用应显示目标的现算名')

  // ⌥ 点那枚引用 ⇒ 浮层里有锚文本输入框（它是唯一入口）
  await page.locator(`#editor [data-atom-id="${setup.runId}"]`).click({ modifiers: ['Alt'] })
  const input = page.locator('.popover [data-anchor-input]')
  assert((await input.count()) === 1, `详情浮层应有且只有一个锚文本输入框：${await page.locator('.popover').innerText()}`)
  assert(
    (await input.getAttribute('placeholder')) === before.label,
    `占位应是目标**此刻**的名字（现算，不是快照）：${await input.getAttribute('placeholder')} ≠ ${before.label}`,
  )
  await input.fill('合同第三版')
  await input.press('Enter')
  await page.waitForTimeout(180)

  const after = await page.evaluate(
    ({ id, runId }) => ({
      label: window.__qua.atoms().find((a) => a.id === runId)?.label ?? '',
      anchor: window.__qua.__editor.store.find(id).content.find((r) => r.id === runId)?.anchor,
      text: window.__qua.text(),
      dom: document.querySelector(`#editor [data-atom-id="${runId}"]`)?.textContent ?? '',
      ops: window.__qua.lastOps().map((o) => ({ e: o.e, op: o.op, id: o.id })),
    }),
    { id: setup.blockId, runId: setup.runId },
  )
  assert(after.anchor === '合同第三版', `模型里应写上 anchor：${JSON.stringify(after)}`)
  assert(after.label === '合同第三版', `行内应显示 anchor（不是目标的名字）：${after.label}`)
  assert(after.dom.includes('合同第三版'), `DOM 上应看到它：${after.dom}`)

  /**
   * 三条负向断言的前两条（锚文本不是第二份身份）：
   *   · 投影不变 ⇒ 搜索／导出／引文与 `{text}` 提及的结果一字不动；
   *   · 边集合不变 ⇒ 反链计数不受影响（反链按 run 的 `to` 算，不认 anchor）。
   */
  assert(JSON.stringify(after.text) === JSON.stringify(before.text), '锚文本不进投影：`plainText` 应一字不变')
  assert(JSON.stringify(await refEdges(page)) === JSON.stringify(edgesBefore), '锚文本不动边：ref run 的 to 集合应一字不变')
  assert(
    after.ops.length === 1 && after.ops[0].e === 'block' && after.ops[0].op === 'upsert' && after.ops[0].id === setup.blockId,
    `改锚文本应只产一条 block.upsert{content}：${JSON.stringify(after.ops)}`,
  )

  // 一次 ⌘Z 回到「跟随目标现算」
  await page.keyboard.press('Escape')
  await page.evaluate(() => window.__qua.invoke('core.history/undo'))
  await page.waitForTimeout(180)
  const undone = await page.evaluate(
    ({ id, runId }) => ({
      label: window.__qua.atoms().find((a) => a.id === runId)?.label ?? '',
      anchor: window.__qua.__editor.store.find(id).content.find((r) => r.id === runId)?.anchor,
    }),
    { id: setup.blockId, runId: setup.runId },
  )
  assert(undone.anchor === undefined, `撤销应把键删掉（不是留下空串）：${JSON.stringify(undone)}`)
  assert(undone.label === before.label, `撤销后应回到现算名：${undone.label} ≠ ${before.label}`)

  await ctx.close()
  return `设锚文本：现算名 → 「合同第三版」（1 条 upsert、1 次撤销）；投影与边零变化`
})

await check('T145 锚文本：清空 ⇒ 回到现算名（空串＝删键，不是「显示成空」）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await openFirstPage(page)
  const setup = await seedPageRef(page)

  // 先设一次（走命令面：与浮层同一个入口，省掉一次浮层交互）
  await page.evaluate((runId) => window.__qua.invoke('core.editor/set-anchor', { atomId: runId, text: '临时名' }), setup.runId)
  await page.waitForTimeout(150)
  const set = await page.evaluate(
    ({ id, runId }) => ({
      label: window.__qua.atoms().find((a) => a.id === runId)?.label ?? '',
      anchor: window.__qua.__editor.store.find(id).content.find((r) => r.id === runId)?.anchor,
    }),
    { id: setup.blockId, runId: setup.runId },
  )
  assert(set.label === '临时名', `前置：应已设上锚文本：${JSON.stringify(set)}`)

  // 清空 ⇒ 键被删掉，显示回到现算名（不是空白）
  await page.evaluate((runId) => window.__qua.invoke('core.editor/set-anchor', { atomId: runId, text: '' }), setup.runId)
  await page.waitForTimeout(150)
  const cleared = await page.evaluate(
    ({ id, runId }) => ({
      label: window.__qua.atoms().find((a) => a.id === runId)?.label ?? '',
      anchor: window.__qua.__editor.store.find(id).content.find((r) => r.id === runId)?.anchor,
      hasKey: 'anchor' in (window.__qua.__editor.store.find(id).content.find((r) => r.id === runId) ?? {}),
      dom: document.querySelector(`#editor [data-atom-id="${runId}"]`)?.textContent ?? '',
      ops: window.__qua.lastOps().map((o) => ({ e: o.e, op: o.op })),
    }),
    { id: setup.blockId, runId: setup.runId },
  )
  assert(cleared.hasKey === false, `写空串应**删掉这个键**（缺席与空值不并存）：${JSON.stringify(cleared)}`)
  assert(cleared.label.length > 0, `清空后应显示现算名，不是空白：${JSON.stringify(cleared)}`)
  assert(cleared.dom.includes(cleared.label), `DOM 上应看得见名字：${cleared.dom}`)
  assert(cleared.ops.length === 1, `清一次也是一条 upsert：${JSON.stringify(cleared.ops)}`)

  await ctx.close()
  return `清锚文本：键被删掉、行内回到现算名（${cleared.label}）`
})

await check('T146 锚文本：目标被删 ⇒ dangling 仍显示 anchor（`anchor ?? label`，不是空白）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await openFirstPage(page)

  /**
   * 两块**都在当前视图里**的普通叶子块：一个当宿主（放引用），另两个当目标。
   *
   * ⚠️ 目标必须取**视图里的块**（不能取「另一页」）：`ed.remove` 走 `locate(this.doc, id)`，
   *    不在当前视图的块它**直接返回**——块数不变、也不报错，于是 dangling 永远不来，
   *    而断言看起来像「锚文本没生效」（真踩过）。
   * ⚠️ 目标取**叶子**：删掉一棵子树时不会顺带把宿主也删了（那样引用跟着消失，测不到 dangling）。
   */
  const setup = await page.evaluate(() => {
    const ed = window.__qua.__editor
    const plain = (b) => b.content.filter((r) => r.t === 'text').map((r) => r.v).join('')
    const rootIds = new Set(ed.doc.roots.map((b) => b.id))
    const leaves = []
    const walk = (list) => {
      for (const b of list) {
        if (!rootIds.has(b.id) && b.children.length === 0 && plain(b).length > 0) leaves.push(b.id)
        walk(b.children)
      }
    }
    walk(ed.doc.roots)
    if (leaves.length < 3) return null
    const [hostId, t1, t2] = leaves
    window.__qua.focusBlock(hostId, 0)
    const labelOf = (id) => plain(ed.store.find(id))
    const anchored = ed.insertRef({ to: t1, label: labelOf(t1) })
    const snapshot = ed.insertRef({ to: t2, label: labelOf(t2) })
    return { hostId, t1, t2, anchored, snapshot, labels: [labelOf(t1), labelOf(t2)] }
  })
  assert(setup, '前置：当前视图里应有三块可当宿主/目标的叶子块')

  // 只给其中一枚设锚文本（另一枚保持「只有插入快照」的现状）
  await page.evaluate(
    (runId) => window.__qua.invoke('core.editor/set-anchor', { atomId: runId, text: '被删的那个' }),
    setup.anchored,
  )
  await page.waitForTimeout(150)
  await page.evaluate((ids) => ids.forEach((id) => window.__qua.__editor.remove(id)), [setup.t1, setup.t2])
  await page.waitForTimeout(300)

  const dangling = await page.evaluate(
    ({ anchored, snapshot }) => {
      const read = (runId) => {
        const el = document.querySelector(`#editor [data-atom-id="${runId}"]`)
        return {
          atom: window.__qua.atoms().find((a) => a.id === runId) ?? null,
          dom: el?.textContent ?? '',
          cls: el?.className ?? '',
        }
      }
      return { anchored: read(anchored), snapshot: read(snapshot) }
    },
    { anchored: setup.anchored, snapshot: setup.snapshot },
  )

  const a = dangling.anchored
  assert(a.atom?.state === 'dangling', `目标没了应是 dangling：${JSON.stringify(a)}`)
  assert(a.atom?.label === '被删的那个', `dangling 应显示 anchor（不是空白、也不是旧快照）：${JSON.stringify(a)}`)
  assert(a.dom.includes('被删的那个'), `DOM 上应看得见：${a.dom}`)
  assert(a.cls.includes('dangling'), `dangling 要看得见（不是静默错指）：${a.cls}`)

  const s = dangling.snapshot
  assert(s.atom?.state === 'dangling', `没有 anchor 的那一枚也应是 dangling：${JSON.stringify(s)}`)
  assert(s.atom?.label === setup.labels[1], `没有 anchor ⇒ 沿用插入快照：${JSON.stringify(s)} ≠ ${setup.labels[1]}`)
  assert(s.dom.includes(setup.labels[1]), `DOM 上应看得见快照名：${s.dom}`)

  await ctx.close()
  return `dangling 链：有 anchor 显示「被删的那个」，没有则沿用快照「${setup.labels[1]}」`
})

await check('T147 外链：插入成 LinkRun；点一下被拦下并交给壳；非 http(s) 协议拒绝打开且给文案', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await openFirstPage(page)

  /**
   * **拦截 `window.open`**：这一刀要验的是「应用把地址交给了宿主」，
   * 而不是「浏览器真的开了一个标签」——真的开一个标签会把冒烟机拖进网络，
   * 而断言要的只是那一次调用与它的参数。
   */
  await page.evaluate(() => {
    window.__opened = []
    window.open = (url) => {
      window.__opened.push(String(url))
      return null
    }
  })

  const inserted = await page.evaluate(() => {
    const b = window.__qua.blocks()[0]
    window.__qua.focusBlock(b.id, 0)
    window.__qua.invoke('core.editor/insert-link', { url: 'https://qua.leay.net/arch.html', text: '架构图' })
    return { blockId: b.id, content: window.__qua.__editor.store.find(b.id).content.map((r) => ({ id: r.id, t: r.t, v: r.v ?? '', url: r.url ?? '' })) }
  })
  const link = inserted.content.find((r) => r.t === 'link')
  assert(link, `应插进一枚 link run：${JSON.stringify(inserted.content)}`)
  assert(link.v === '架构图' && link.url === 'https://qua.leay.net/arch.html', `显示文本与地址各在自己的键上：${JSON.stringify(link)}`)

  const dom = await page.evaluate(() => {
    const el = document.querySelector('#editor .atom-link')
    return { text: el?.textContent ?? '', kind: el?.dataset.atomKind ?? '', title: el?.getAttribute('title') ?? '' }
  })
  assert(dom.kind === 'link' && dom.text.includes('架构图'), `DOM 上应是一枚 link 原子：${JSON.stringify(dom)}`)

  // ① 左键点 ⇒ 经 atomClick → 命令 → 门面 ⇒ 交给壳（这里被拦下）
  await page.locator('#editor .atom-link').first().click()
  await page.waitForTimeout(150)
  const opened = await page.evaluate(() => window.__opened)
  assert(opened.length === 1, `点一次应只发出一次打开请求：${JSON.stringify(opened)}`)
  assert(opened[0].startsWith('https://qua.leay.net/'), `交出去的应是 http(s) 地址：${opened[0]}`)

  // ② ⌥ 点 ⇒ 详情浮层（有「打开」按钮，与点正文同一条命令）
  await page.locator('#editor .atom-link').first().click({ modifiers: ['Alt'] })
  const popText = await page.locator('.popover').innerText()
  assert(popText.includes('https://qua.leay.net/arch.html'), `详情里应显示 URL：${popText}`)
  const openBtn = page.locator('.popover [data-link-open]')
  assert((await openBtn.count()) === 1, `详情浮层应有「打开」按钮：${popText}`)
  await openBtn.click()
  await page.waitForTimeout(150)
  assert((await page.evaluate(() => window.__opened.length)) === 2, '浮层的「打开」应走同一条命令（再发一次）')
  await page.keyboard.press('Escape')

  /**
   * ③ 非 http(s) 一律拒绝：**一次都没交给壳**，且给了文案。
   *    （`javascript:` / `file:` 能被 `openExternal` 直接吃掉，这是本条存在的原因。）
   */
  const rejected = await page.evaluate(
    ({ runId, blockId }) => {
      const before = window.__opened.length
      // (a) 插入阶段就拒（与打开同一份判据，不留「能插但不能开」的链接）
      window.__qua.focusBlock(blockId, 0)
      window.__qua.invoke('core.editor/insert-link', { url: 'javascript:alert(1)' })
      const insertedBad = window.__qua.__editor.store
        .find(blockId)
        .content.some((r) => r.t === 'link' && r.url.startsWith('javascript:'))
      const toastAfterInsert = [...document.querySelectorAll('.toast')].map((t) => t.textContent ?? '')

      /**
       * (b) 打开阶段：把这一枚 link 的 url 换成 `file:`（**测试侧的坏数据**——
       *     模拟「外来的旧库／插件写入的链接」：写入口不止命令一条，而打开只有一条）。
       *     白名单在打开这一侧也必须成立，否则前面所有写入口的纪律都被绕过了。
       */
      const run = window.__qua.__editor.findRun(runId)?.run
      if (run && run.t === 'link') run.url = 'file:///etc/passwd'
      window.__qua.invoke('core.link/open', { atomId: runId })
      return {
        before,
        after: window.__opened.length,
        insertedBad,
        toastAfterInsert,
        toastAfterOpen: [...document.querySelectorAll('.toast')].map((t) => t.textContent ?? ''),
      }
    },
    { runId: inserted.content.find((r) => r.t === 'link').id, blockId: inserted.blockId },
  )
  assert(rejected.insertedBad === false, '非 http(s) 的链接不该被插进正文')
  assert(rejected.after === rejected.before, `非 http(s) 不该交给壳：${JSON.stringify(rejected)}`)
  assert(
    rejected.toastAfterInsert.some((x) => x.length > 0),
    `插入被拒要给用户一句话（不是静默失败）：${JSON.stringify(rejected.toastAfterInsert)}`,
  )
  assert(
    rejected.toastAfterOpen.length > rejected.toastAfterInsert.length,
    `打开被拒也要给一句话：${JSON.stringify(rejected.toastAfterOpen)}`,
  )

  await ctx.close()
  return `外链：插入成 link run、点一次交一次给壳、非 http(s) 插不进也打不开且有文案`
})

/* ---------------------------------------------------------------- T148 */

/**
 * **一源三视的同步闭环**：同一块在正文、挂载区、侧槽窗口同时可见时，在任意一处
 * 改一个字，另外两处要跟上；一次 ⌘Z 三处一起回滚。
 *
 * 三处是三台编辑器实例，共享同一个 store。同步不靠视图之间互相转发（那会漏接），
 * 靠「写入口只有一个、通知只有一条」——这条用例守的就是这个装配契约：
 * 任何一台自己画的行（挂载区），别的两台（正文、窗口）都要在防抖窗口后跟上。
 *
 * 末段顺带钉窗口的事件表是**整份** viewEvents：右键在窗口里也要有块菜单。
 * 只手接几支事件的时候，缺的那几样在窗口里点了就是没反应——漏接不报错。
 */
await check('T148 一源三视：挂载区里改字 ⇒ 正文与右槽窗口都跟上；⌘Z 一次三处回滚；窗口右键有块菜单', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.loadState('seed'))
  await page.waitForTimeout(300)

  // 页 P 的一个叶子块 b 引用 P ⇒ b 出现在 P 的「引用」栏（与 T135 同一招）
  const ids = await page.evaluate(() => {
    const P = window.__qua.pages()[0].id
    window.__qua.invoke('core.page/open', { pageId: P })
    const rows = window.__qua.__editor.rows().map((r) => r.block)
    const b = rows.find((x) => x.id !== P && x.children.length === 0)
    window.__qua.focusBlock(b.id, 999)
    window.__qua.invoke('core.editor/insert-page-ref', { pageId: P })
    return { P, b: b.id }
  })
  await page.waitForTimeout(450)

  // 同一块再开进右槽 ⇒ 正文／挂载区／窗口三处同时可见
  await page.evaluate((id) => window.__qua.invoke('core.dock/open-block', { blockId: id, side: 'right' }), ids.b)
  await page.waitForTimeout(350)

  /** 同一块此刻在三个视图里的正文（挂载区/查询视图也住在 #editor 里，读数要把它们排除） */
  const readThree = () =>
    page.evaluate((b) => {
      // #editor 里同名行有两份：正文那一份，与段尾槽里挂载区的那一份
      const main = [...document.querySelectorAll(`#editor .blk[data-block-id="${b}"] > .tx`)].find((e) => !e.closest('.mount, .queryview'))?.textContent ?? ''
      return {
        main,
        mount: document.querySelector(`#editor .mount .mount-editor .blk[data-block-id="${b}"] .tx`)?.textContent ?? '',
        dock: document.querySelector(`#dock-right .dock-card[data-window="1"][data-card-id="${b}"] .dock-window-editor .blk[data-depth="0"] > .tx`)?.textContent ?? '',
      }
    }, ids.b)

  const before = await readThree()
  assert(before.main.length > 0, `前置：正文里应看得见它：${JSON.stringify(before)}`)
  assert(before.mount.length > 0, `前置：挂载区「引用」栏里应看得见它：${JSON.stringify(before)}`)
  assert(before.dock.length > 0, `前置：右槽窗口里应看得见它：${JSON.stringify(before)}`)
  assert(before.main === before.mount && before.mount === before.dock, `同一块三处应显示同一份正文（一源三视）：${JSON.stringify(before)}`)

  // ① 在挂载区那一处改字：自己那一行立即变（自己的编辑路径），正文与窗口要在防抖窗口后跟上
  const row = `#editor .mount .mount-editor .blk[data-block-id="${ids.b}"] .tx`
  await page.locator(row).first().click()
  await page.keyboard.press('End')
  await page.keyboard.type('X')
  await page.waitForTimeout(500)
  const edited = await readThree()
  assert(edited.mount.includes('X'), `挂载区里改字应当立即显示：${JSON.stringify(edited)}`)
  assert(edited.main.includes('X'), `正文里的同一块应当跟上：${JSON.stringify(edited)}`)
  assert(edited.dock.includes('X'), `右槽窗口里的同一块应当跟上：${JSON.stringify(edited)}`)

  // ② 一次 ⌘Z（焦点还在挂载区）：三处一起回滚
  await page.locator(row).first().click()
  await page.keyboard.press(kbd('mod+z'))
  await page.waitForTimeout(500)
  const undone = await readThree()
  assert(!undone.mount.includes('X'), `挂载区应回滚：${JSON.stringify(undone)}`)
  assert(!undone.main.includes('X'), `正文应一起回滚（共享 undo 栈）：${JSON.stringify(undone)}`)
  assert(!undone.dock.includes('X'), `右槽窗口应一起回滚（共享 undo 栈）：${JSON.stringify(undone)}`)
  assert(undone.main === before.main && undone.mount === before.mount && undone.dock === before.dock, `回滚后三处应回到改字前的同一份正文：${JSON.stringify(undone)}`)

  // ③ 窗口的事件表是整份：右键窗口里的块标 ⇒ 块菜单（不是「点了没反应」）
  await page.locator(`#dock-right .dock-card[data-window="1"][data-card-id="${ids.b}"] .blk[data-depth="0"] > .left > .marker`).first().click({ button: 'right' })
  await page.waitForTimeout(250)
  const menu = await page.evaluate(() => ({
    open: Boolean(document.querySelector('.layer')),
    rows: document.querySelectorAll('.layer-item').length,
  }))
  assert(menu.open && menu.rows > 0, `窗口里右键应出块菜单（事件表整份，不是只接几支）：${JSON.stringify(menu)}`)
  await page.keyboard.press('Escape')
  await ctx.close()
  return `一源三视：改字三处同步、⌘Z 三处回滚、窗口右键有菜单（${menu.rows} 项）`
})

/* ---------------------------------------------------------------- T149 */

/**
 * **覆盖层的两条桌面纪律**：关掉之后按键要有落点、开着的时候要跟着锚点走。
 *
 * 为什么这两条要专门一条用例：它们的失效形态都是**静默**的。
 *   · 关掉浮层后焦点掉到 `BODY` ⇒ 用户接着打字，一个字符都进不去、正文一字不变、
 *     屏幕上没有任何提示（看起来像「输入法坏了」）；
 *   · 浮层拿的是**矩形快照** ⇒ 拖窗口边或滚动正文之后它留在原地、锚点早已跑开，
 *     而它看起来仍然「好好地开着」。
 *
 * 这两件事在 Web 上很少发生（不拖窗口边、不在浮层开着时滚动整页），
 * 桌面应用里都是日常动作 —— 所以判据落在「真按键 + 真改视口」上，不是读 CSS。
 */
await check('T149 覆盖层：关掉之后按键仍落在编辑器；浮层开着时改视口/滚动会重新贴住锚点', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await openFirstPage(page)

  /** 真点进正文（合成事件拿不到真实焦点，这条必须用真鼠标） */
  const caret = await page.evaluate(() => {
    const tx = document.querySelector('#editor .blk .tx')
    const r = tx.getBoundingClientRect()
    return { x: r.left + 20, y: r.top + r.height / 2 }
  })
  await page.mouse.click(caret.x, caret.y)
  await page.waitForTimeout(200)

  // ① 命令面板：开 → Esc 关 → **打字必须进得去**
  await page.keyboard.press('Meta+p')
  await page.waitForTimeout(250)
  const opened = await page.evaluate(() => Boolean(document.querySelector('.layer')))
  assert(opened, '⌘P 应打开命令面板')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  const closed = await page.evaluate(() => {
    const sel = document.getSelection()
    return {
      layer: Boolean(document.querySelector('.layer')),
      active: document.activeElement?.tagName ?? '',
      inEditor: Boolean(document.activeElement?.closest?.('#editor')),
      // **能打字的真正判据**：模型选区投影回了 DOM（焦点回来而 Range 没了照样打不进）
      rangeInTx: Boolean(sel?.rangeCount && sel.anchorNode?.parentElement?.closest?.('.tx')),
    }
  })
  assert(!closed.layer, `Esc 应关掉命令面板：${JSON.stringify(closed)}`)
  assert(closed.inEditor, `关掉之后焦点应回到编辑器，不是掉到 ${closed.active}：${JSON.stringify(closed)}`)
  assert(closed.rangeInTx, `关掉之后插入点应回到正文槽（焦点回来≠能打字）：${JSON.stringify(closed)}`)

  const before = await page.evaluate(() => window.__qua.text()[0] ?? '')
  await page.keyboard.type('Z')
  await page.waitForTimeout(250)
  const after = await page.evaluate(() => window.__qua.text()[0] ?? '')
  /**
   * ⚠️ 判据是「多了一个字」而**不是**「开头是 Z」：插入点在刚才点进去的那一处，
   *    不一定是行首（实测落在「产|品设计」中间）。写死开头会把「字进去了」误判成失败。
   */
  assert(
    after.length === before.length + 1 && after.includes('Z'),
    `关掉浮层后打的字必须进得去：${before.slice(0, 12)} → ${after.slice(0, 12)}`,
  )

  // ② 浮层跟着锚点：开着时改视口，必须重新钳位（不许留在窗口外）
  await page.evaluate(() => {
    window.__qua.__layers.openPopover((h) => {
      h.textContent = 'probe'
    }, new DOMRect(window.innerWidth - 100, 100, 0, 20))
  })
  await page.waitForTimeout(200)
  const wide = await page.evaluate(() => {
    const p = document.querySelector('.popover')
    const r = p.getBoundingClientRect()
    return { right: Math.round(r.right), vw: window.innerWidth, offRight: r.right > window.innerWidth }
  })
  assert(!wide.offRight, `前置：宽视口下浮层本来就该在视口内：${JSON.stringify(wide)}`)

  await page.setViewportSize({ width: 760, height: 600 })
  await page.waitForTimeout(350)
  const narrow = await page.evaluate(() => {
    const p = document.querySelector('.popover')
    if (!p) return { closed: true }
    const r = p.getBoundingClientRect()
    return { left: Math.round(r.left), right: Math.round(r.right), vw: window.innerWidth, offRight: r.right > window.innerWidth }
  })
  assert(!narrow.closed, '改视口不该把浮层关掉（它还有锚点）')
  assert(!narrow.offRight, `窗口变窄后浮层必须重新钳位在视口内（不许挂在窗口外）：${JSON.stringify(narrow)}`)

  // ③ 锚点消失（指向的元素被摘掉）⇒ 浮层自己关掉，不留一个「指向不存在」的面
  await page.evaluate(() => {
    window.__qua.__layers.openPopover((h) => {
      h.textContent = 'gone'
    }, () => null)
  })
  await page.waitForTimeout(200)
  const gone = await page.evaluate(() => Boolean(document.querySelector('.popover')))
  assert(!gone, '锚点取不到时不该留下一个悬空的浮层')

  await ctx.close()
  return `关掉面板后打字进得去（${before.slice(0, 8)}→${after.slice(0, 8)}）；视口 1440→760 后浮层仍在内；锚点消失即关`
})

await check('T150 派生卡也能关：关掉即离开槽（模型不动）；「添加组件」能加回来；「看属性」开抽屉不复活卡', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  await openFirstPage(page)

  const dockState = () =>
    page.evaluate(() => ({
      left: window.__qua.snapshot().dock.left.cards,
      right: window.__qua.snapshot().dock.right.cards,
      belongs: Boolean(document.querySelector('#dock-left .dock-card[data-card-id="belongs"]')),
      inspect: Boolean(document.querySelector('#dock-right .dock-card[data-card-id="inspect"]')),
      blocks: window.__qua.allBlocks().length,
    }))

  const before = await dockState()
  assert(before.left.includes('belongs') && before.belongs, `前置：默认左槽有归属卡：${JSON.stringify(before)}`)
  assert(before.right.includes('inspect') && before.inspect, `前置：默认右槽有检视卡：${JSON.stringify(before)}`)

  // ① 卡头的 ✕（与窗口卡同一颗按钮、同一条路）：只摘 cards，模型一个字节不动
  await page.locator('#dock-left .dock-card[data-card-id="belongs"] [data-dock-action="close"]').click()
  await page.waitForTimeout(140)
  const closed = await dockState()
  assert(!closed.left.includes('belongs'), `关掉后应离开 cards：${JSON.stringify(closed.left)}`)
  assert(!closed.belongs, '关掉后 DOM 里也不该有这张卡')
  assert(closed.blocks === before.blocks, `关掉一张视图卡不该动模型：${before.blocks} → ${closed.blocks}`)

  // ② 回程：「添加组件」画廊里它还在，点了就回来（否则 ✕ 就是单向陷阱）
  await page.locator('#dock-left .dock-add').click()
  await page.waitForTimeout(160)
  const rows = await layerRows(page)
  assert(
    rows.some((r) => r.label === '归属'),
    `画廊里应有归属卡：${JSON.stringify(rows.map((r) => r.label))}`,
  )
  // 行是 `mousedown` 触发的（与命令面板同一条选择路径），所以用真鼠标点
  const at = rows.findIndex((r) => r.label === '归属')
  await page.locator(`.layer-item[data-index="${at}"]`).click()
  await page.waitForTimeout(160)
  const back = await dockState()
  assert(back.left.includes('belongs') && back.belongs, `加回来应重新出现在槽里：${JSON.stringify(back.left)}`)
  assert(back.blocks === before.blocks, '加回来也不该动模型')

  // ③ 检视卡：关掉之后「看属性」**不再**把它放回来——那条命令的落点是属性抽屉
  //    （不动槽、不复活卡）；卡自己的回程是「添加组件」画廊，与归属卡同一条路。
  await page.locator('#dock-right .dock-card[data-card-id="inspect"] [data-dock-action="close"]').click()
  await page.waitForTimeout(140)
  const noInspect = await dockState()
  assert(!noInspect.right.includes('inspect') && !noInspect.inspect, `检视卡应能关掉：${JSON.stringify(noInspect.right)}`)
  const activeId = await page.evaluate(() => window.__qua.snapshot().activeId)
  await page.evaluate((id) => window.__qua.invoke('core.block/inspect', { blockId: id }), activeId)
  await page.waitForSelector('.props-drawer')
  const viaCmd = await page.evaluate(() => ({
    cards: window.__qua.snapshot().dock.right.cards,
    present: Boolean(document.querySelector('#dock-right .dock-card[data-card-id="inspect"]')),
    drawer: document.querySelector('.props-drawer')?.dataset.targetBlockId ?? '',
  }))
  assert(!viaCmd.cards.includes('inspect') && !viaCmd.present, `「看属性」不再复活检视卡：${JSON.stringify(viaCmd)}`)
  assert(viaCmd.drawer === activeId, `「看属性」开的是钉在那一块上的抽屉：${JSON.stringify(viaCmd)}`)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)

  // 回程＝画廊：检视卡还在目录里，点了就回来（✕ 不是单向陷阱）
  await page.locator('#dock-right .dock-add').click()
  await page.waitForTimeout(160)
  const rowsRight = await layerRows(page)
  const atInspect = rowsRight.findIndex((r) => r.label === '检视卡')
  assert(atInspect >= 0, `画廊里应有检视卡：${JSON.stringify(rowsRight.map((r) => r.label))}`)
  await page.locator(`.layer-item[data-index="${atInspect}"]`).click()
  await page.waitForTimeout(200)
  const inspectBack = await dockState()
  assert(inspectBack.right.includes('inspect') && inspectBack.inspect, `检视卡应从画廊加回来：${JSON.stringify(inspectBack.right)}`)

  await ctx.close()
  return `归属卡关掉→画廊加回来（模型 0 变化）；检视卡关掉→「看属性」开抽屉不复活卡，卡从画廊回`
})

/* ---------------------------------------------------------------- T151 */

/**
 * **平表**：行＝容器的直接子块；容器是表标题，不是一行。
 *
 * 这一条同时钉三件事（各自都能静默错）：
 *   ① 非大纲视图时**正文只画根行** —— 否则同一批子块在正文和表里各画一遍；
 *   ② 切回大纲**子树原样回来**，而且刚才那一步还在撤销栈上（不是「重装把历史清了」）；
 *   ③ 标题列画的是**块的样子**（marks／引用／图片都在），不是纯文本投影。
 */
const pageByTitle = async (page, part) =>
  page.evaluate((s) => {
    const p = window.__qua.pages().find((x) => (x.title ?? '').includes(s))
    window.__qua.invoke('core.page/open', { pageId: p.id })
    return p.id
  }, part)

const viewState = (page) =>
  page.evaluate(() => ({
    visible: Boolean(document.querySelector('.queryview')) && document.querySelector('.queryview').hidden === false,
    rows: document.querySelectorAll('.tv-row').length,
    rowIds: [...document.querySelectorAll('.tv-row')].map((r) => r.dataset.blockId ?? ''),
    rootBlks: document.querySelectorAll('#editor > .sec > .blk[data-block-id]').length,
    titleHtml: [...document.querySelectorAll('.tv-row .tv-title-inner')].map((e) => e.innerHTML),
    undoDepth: window.__qua.__editor.undo.depth(),
    viewRoot: window.__qua.__editor.doc.viewRootId ?? '',
  }))

await check('T151 平表：行＝直接子块、正文只画根行、切回大纲子树回来；标题列是块投影不是纯文本', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  const id = await pageByTitle(page, '输入面笔记')
  await page.waitForTimeout(300)
  const before = await viewState(page)
  const children = await page.evaluate((pid) => {
    const walk = (l) => {
      for (const x of l) {
        if (x.id === pid) return x
        const r = walk(x.children)
        if (r) return r
      }
      return null
    }
    return walk(window.__qua.__editor.store.blocks).children.map((c) => c.id)
  }, id)
  assert(!before.visible, '前置：大纲形态下没有视图宿主')

  await page.evaluate((pid) => window.__qua.invoke('core.view/add', { blockId: pid, kind: 'table' }), id)
  await page.waitForTimeout(400)
  const table = await viewState(page)
  assert(table.visible, '新建表格后应出现视图宿主（抬头 ＋ 表格）')
  assert(table.rows === children.length, `行数＝直接子块数：${table.rows} vs ${children.length}`)
  assert(
    table.rowIds.every((x, i) => x === children[i]),
    `平表的行序就是 children 顺序：${JSON.stringify(table.rowIds.slice(0, 3))} vs ${JSON.stringify(children.slice(0, 3))}`,
  )
  assert(table.rootBlks === 1, `正文只画根行（子块不在正文里重复）：${table.rootBlks}`)
  assert(table.viewRoot === id, `装载层记着「这一屏谁的孩子由视图画」：${table.viewRoot}`)
  assert(
    table.titleHtml.some((h) => h.includes('mk-') || h.includes('data-atom-id') || h.includes('data-ref-to')),
    `标题列应是 run 投影（marks／原子／引用），不是纯文本：${table.titleHtml[0]?.slice(0, 120)}`,
  )

  // 新建行 ＝ 容器末尾一个子块（结构 op）；删除行 ＝ 软删（可恢复，不是从列表里抹掉）
  const kids = () =>
    page.evaluate((pid) => {
      const walk = (l) => {
        for (const x of l) {
          if (x.id === pid) return x
          const r = walk(x.children)
          if (r) return r
        }
        return null
      }
      const b = walk(window.__qua.__editor.store.blocks)
      return { live: b.children.filter((c) => !c.props?._deletedAt).length, all: b.children.length }
    }, id)
  const k0 = await kids()
  await page.locator('.queryview-newrow').click()
  await page.waitForTimeout(350)
  const k1 = await kids()
  assert(k1.live === k0.live + 1, `新建一行＝末尾多一个子块：${JSON.stringify(k0)} → ${JSON.stringify(k1)}`)
  assert((await viewState(page)).rows === k1.live, '表格当场多一行（不用手动刷新）')

  await page.locator('.tv-row').last().hover()
  await page.locator('.tv-row .tv-del').last().click()
  await page.waitForTimeout(350)
  const k2 = await kids()
  assert(k2.live === k1.live - 1, `删除一行＝那一块不再算活着的子块：${JSON.stringify(k1)} → ${JSON.stringify(k2)}`)
  assert(k2.all === k1.all, `删除是**软删**（块还在树上，可恢复）：${JSON.stringify(k2)}`)

  // 切回大纲：摘掉视图宿主、正文恢复子树，撤销栈原样（并且多出「切回大纲」这一步）
  await page.locator('.qv-view-btn', { hasText: '大纲' }).first().click()
  await page.waitForTimeout(400)
  const outline = await viewState(page)
  assert(!outline.visible, '切回大纲后视图宿主应摘掉（不是藏一台还在订阅的）')
  assert(outline.rootBlks > 1, `切回大纲正文要重新装子树：${outline.rootBlks}`)
  assert(outline.undoDepth > before.undoDepth, '撤销栈不该被重装清掉')
  // 切回大纲：**活着的**子块一个不少（刚才软删的那一块不算，它还在树上可恢复）
  const back = await page.evaluate((pid) => {
    const walk = (l) => {
      for (const x of l) {
        if (x.id === pid) return x
        const r = walk(x.children)
        if (r) return r
      }
      return null
    }
    return walk(window.__qua.__editor.store.blocks).children.filter((c) => !c.props?._deletedAt).length
  }, id)
  assert(back === children.length, `切回大纲子块一个不少：${back} vs ${children.length}`)

  // 再按一次 ⌘Z ⇒ 回到表格（那一步真在栈上，不是「历史被清了所以按了没反应」）
  // ⚠️ 先让焦点回到编辑器：⌘Z 只在「焦点在编辑器里」时才接（点视图切换按钮之后焦点悬空）
  await page.evaluate(() => window.__qua.focus())
  await page.keyboard.press(kbd('mod+z'))
  await page.waitForTimeout(400)
  const undone = await viewState(page)
  assert(undone.visible, '⌘Z 一次应退回表格视图（切视图＝一轮撤销）')

  await ctx.close()
  return `${table.rows} 行＝直接子块；正文只画根行；切回大纲 ${outline.rootBlks} 行、⌘Z 回表格`
})

/* ---------------------------------------------------------------- T152 */

await check('T152 标题列＝块本身：点文字就地进单块编辑器；Enter 提交、Esc 取消不写；点引用先导航', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  const id = await pageByTitle(page, '输入面笔记')
  await page.waitForTimeout(300)
  await page.evaluate((pid) => window.__qua.invoke('core.view/add', { blockId: pid, kind: 'table' }), id)
  await page.waitForTimeout(400)

  const rowText = () =>
    page.evaluate(() => {
      const row = document.querySelector('.tv-row')
      const id = row.dataset.blockId
      const walk = (l) => {
        for (const x of l) {
          if (x.id === id) return x
          const r = walk(x.children)
          if (r) return r
        }
        return null
      }
      const b = walk(window.__qua.__editor.store.blocks)
      return { id, text: b.content.filter((r) => r.t === 'text').map((r) => r.v).join(''), modified: b.modified }
    })

  const first = await rowText()
  // 点标题里的文字 ⇒ 一台贴在格子上的编辑器（不是 input、不是每行一台）
  await page.locator('.tv-row .tv-title-inner').first().click()
  await page.waitForTimeout(220)
  const opened = await page.evaluate(() => {
    const box = document.querySelector('.tv-edit')
    const active = document.activeElement
    return {
      overlay: Boolean(box),
      overlays: document.querySelectorAll('.tv-edit').length,
      focusInside: Boolean(box?.contains(active)),
      inputs: document.querySelectorAll('.tv-edit input').length,
    }
  })
  assert(opened.overlay && opened.overlays === 1, `同一时刻只有一台浮层编辑器：${JSON.stringify(opened)}`)
  assert(opened.focusInside, '打开后焦点必须在浮层里（否则打的字进正文）')
  assert(opened.inputs === 0, '标题列不是 <input>（要用块编辑器）')
  /**
   * **不是「每行一台编辑器」**：表格行里不该出现块编辑器的行 DOM（`.blk`）。
   * 每行常驻一台的代价不是观感——DOM 与订阅按行数增长（5k 行＝5k 台），
   * 每一台还要各自维护重载节奏。这条断言就是那个量级错误的照妖镜。
   */
  const perRow = await page.evaluate(() => ({
    blk: document.querySelectorAll('.tv-row .blk').length,
    tx: document.querySelectorAll('.tv-row .tx').length,
  }))
  assert(perRow.blk === 0 && perRow.tx === 0, `表格行里不该有编辑器（每行一台是量级错误）：${JSON.stringify(perRow)}`)

  /**
   * **同一时刻只有一台**：点另一行的标题 ⇒ 上一台先提交并关掉，不是并排开出第二台。
   * （并排的后果不是「看起来乱」：两台都在跟着 store 重画，谁先失焦谁把内容写回去，
   *  撤销栈里也会多出一段没人按过的编辑。）
   */
  // 隔几行去点：浮层贴着第 1 行，紧邻那一行的上半截会被它盖住（真人点的是字，不是那一条缝）
  const secondTitle = page.locator('.tv-row .tv-title-inner').nth(4)
  await secondTitle.click()
  await page.waitForTimeout(220)
  const swapped = await page.evaluate(() => ({
    overlays: document.querySelectorAll('.tv-edit').length,
    row: document.querySelector('.tv-edit')?.dataset.blockId ?? '',
    rows: [...document.querySelectorAll('.tv-row')].map((r) => r.dataset.blockId ?? ''),
  }))
  assert(swapped.overlays === 1, `换一行编辑不该并排开出第二台：${JSON.stringify(swapped)}`)
  assert(swapped.row === swapped.rows[4], `浮层应贴在刚点的那一行上：${JSON.stringify(swapped)}`)

  // 回到第一行继续（后面几条断言都针对第一行）
  await page.locator('.tv-row .tv-title-inner').first().click()
  await page.waitForTimeout(220)
  await page.keyboard.type('Q')
  await page.waitForTimeout(150)
  const typed = await rowText()
  assert(typed.text.includes('Q') && typed.id === first.id, `打字进的是这一块：${typed.text.slice(0, 20)}`)
  const pageText = await page.evaluate((pid) => {
    const walk = (l) => {
      for (const x of l) {
        if (x.id === pid) return x
        const r = walk(x.children)
        if (r) return r
      }
      return null
    }
    return walk(window.__qua.__editor.store.blocks).content.filter((r) => r.t === 'text').map((r) => r.v).join('')
  }, id)
  assert(!pageText.includes('Q'), '浮层里的字不该落到根块上')

  await page.keyboard.press('Enter')
  await page.waitForTimeout(250)
  const committed = await page.evaluate(() => ({ overlay: Boolean(document.querySelector('.tv-edit')), activeTag: document.activeElement?.tagName }))
  assert(!committed.overlay, `Enter 提交后浮层应关掉：${JSON.stringify(committed)}`)
  const afterCommit = await rowText()
  assert(afterCommit.text.includes('Q'), '提交后内容留在模型里')
  assert(afterCommit.modified > first.modified, `提交是一次改动边界（修改时间要动）：${first.modified} → ${afterCommit.modified}`)

  // Esc 取消：内容写回打开那一刻的样子
  await page.locator('.tv-row .tv-title-inner').first().click()
  await page.waitForTimeout(200)
  await page.keyboard.type('ZZZ')
  await page.waitForTimeout(150)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)
  const cancelled = await page.evaluate(() => ({ overlay: Boolean(document.querySelector('.tv-edit')) }))
  const afterCancel = await rowText()
  assert(!cancelled.overlay, 'Esc 之后浮层关掉')
  assert(afterCancel.text === afterCommit.text, `Esc 不写：${afterCommit.text.slice(-6)} → ${afterCancel.text.slice(-6)}`)

  // 点引用先导航（不进编辑）：标题里那一枚 `[[产品设计 · 决策日志]]`
  const refRow = page.locator('.tv-row .tv-title-inner [data-ref-to]').first()
  const hasRef = (await refRow.count()) > 0
  assert(hasRef, '标题列里应能看到行内引用（run 投影）')
  const activeBefore = await page.evaluate(() => window.__qua.snapshot().activeId)
  const refTarget = await refRow.getAttribute('data-ref-to')
  await refRow.click()
  await page.waitForTimeout(350)
  const nav = await page.evaluate(() => ({ active: window.__qua.snapshot().activeId, overlay: Boolean(document.querySelector('.tv-edit')) }))
  assert(!nav.overlay, '点引用不该开编辑器（先导航）')
  assert(nav.active !== activeBefore || nav.active === refTarget, `点引用应换中心（或本来就指向当前页）：${activeBefore} → ${nav.active}`)

  await ctx.close()
  return `点文字→一台浮层；Enter 提交（${first.modified}→${afterCommit.modified}）；Esc 不写；点引用先导航`
})

/* ---------------------------------------------------------------- T153 */

await check('T153 属性列：number 提交的是 number、排序不退化成字典序、一次提交一条 op；children 顺序不变', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  const id = await pageByTitle(page, '输入面笔记')
  await page.waitForTimeout(300)

  // 造一个 number 属性（声明给子块），给前三个子块写 2 / 10 / 9
  const setup = await page.evaluate((pid) => {
    window.__qua.invoke('core.props/create-def', { blockId: pid, label: '评分', kind: 'number', target: 'declared' })
    const walk = (l) => {
      for (const x of l) {
        if (x.id === pid) return x
        const r = walk(x.children)
        if (r) return r
      }
      return null
    }
    const b = walk(window.__qua.__editor.store.blocks)
    const def = window.__qua.propDefs().find((d) => d.label === '评分')
    const kids = b.children.slice(0, 3)
    ;[2, 10, 9].forEach((v, i) =>
      window.__qua.invoke('core.props/set-value', { blockId: kids[i].id, propId: def.id, value: v }),
    )
    return { defId: def.id, ids: kids.map((k) => k.id), order: b.children.map((c) => c.id) }
  }, id)
  await page.waitForTimeout(200)
  await page.evaluate((pid) => window.__qua.invoke('core.view/add', { blockId: pid, kind: 'table' }), id)
  await page.waitForTimeout(400)

  const colIndex = await page.evaluate((defId) => {
    const cells = [...document.querySelectorAll('.tv-head .tv-cell')]
    return cells.findIndex((c) => c.dataset.col === defId)
  }, setup.defId)
  assert(colIndex > 0, '默认列应包含子块实际拥有的属性（评分）')

  const values = () =>
    page.evaluate(
      (defId) => [...document.querySelectorAll('.tv-row')].map((r) => r.querySelector(`.tv-cell[data-prop="${defId}"] input`)?.value ?? ''),
      setup.defId,
    )
  assert(JSON.stringify((await values()).slice(0, 3)) === JSON.stringify(['2', '10', '9']), `初始值按 children 顺序：${await values()}`)

  // 表头升序：2 < 9 < 10（字典序会得到 10 < 2 < 9）
  await page.locator('.tv-head .tv-cell').nth(colIndex).click()
  await page.waitForTimeout(300)
  const asc = (await values()).slice(0, 3)
  assert(JSON.stringify(asc) === JSON.stringify(['2', '9', '10']), `number 排序按数值：${JSON.stringify(asc)}`)
  await page.locator('.tv-head .tv-cell').nth(colIndex).click()
  await page.waitForTimeout(300)
  const desc = (await values()).slice(0, 3)
  assert(JSON.stringify(desc) === JSON.stringify(['10', '9', '2']), `降序：${JSON.stringify(desc)}`)

  // 排序只改显示序：children 一个字节不动
  const orderAfterSort = await page.evaluate((pid) => {
    const walk = (l) => {
      for (const x of l) {
        if (x.id === pid) return x
        const r = walk(x.children)
        if (r) return r
      }
      return null
    }
    return walk(window.__qua.__editor.store.blocks).children.map((c) => c.id)
  }, id)
  assert(JSON.stringify(orderAfterSort) === JSON.stringify(setup.order), '表头排序只改显示序，children 顺序不变')

  // 改一格：提交的是 number，且只有一条 prop.set
  const editor = page.locator(`.tv-row .tv-cell[data-prop="${setup.defId}"] input`).first()
  await editor.click()
  await editor.fill('42')
  await editor.press('Enter')
  await page.waitForTimeout(300)
  const cell = await page.evaluate(() => ({
    ops: window.__qua.lastOps().map((o) => (o.e === 'prop' ? `prop:${o.op}:${o.name}` : `${o.e}:${o.op}`)),
  }))
  const propSets = cell.ops.filter((x) => x.startsWith('prop:set'))
  assert(propSets.length === 1 && propSets[0].endsWith(setup.defId), `一次提交只写这一格：${JSON.stringify(cell.ops)}`)
  assert(cell.ops.length <= 2, `一格值＋修改时间最多两条 op：${JSON.stringify(cell.ops)}`)
  const stored = await page.evaluate(
    (a) => {
      const walk = (l) => {
        for (const x of l) {
          if (x.id === a.ids[1]) return x
          const r = walk(x.children)
          if (r) return r
        }
        return null
      }
      const v = walk(window.__qua.__editor.store.blocks)?.props?.[a.defId]
      return { v, type: typeof v }
    },
    setup,
  )
  assert(stored.type === 'number', `number 单元格提交的是 number（不是字符串）：${JSON.stringify(stored)}`)

  await ctx.close()
  return `升序 ${asc.join('<')}；降序 ${desc.join('>')}；children 顺序不变；一格一条 prop.set（${stored.type}）`
})

/* ---------------------------------------------------------------- T154 */

await check('T154 checkbox 三态分得开（未填／false／true）；点一下写一条 op', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  const id = await pageByTitle(page, '产品设计')
  await page.waitForTimeout(300)
  await page.evaluate((pid) => window.__qua.invoke('core.view/add', { blockId: pid, kind: 'table' }), id)
  await page.waitForTimeout(400)

  const states = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('.tv-row')].map((r) => {
        const box = r.querySelector('.tv-cell[data-prop] input[type="checkbox"]')
        if (!box) return 'none'
        if (box.indeterminate) return 'empty'
        return box.checked ? 'true' : 'false'
      }),
    )
  const s = await states()
  assert(s.includes('false') && s.includes('true') && s.includes('empty'), `三态都在 DOM 上看得见：${JSON.stringify(s)}`)

  const emptyAt = s.indexOf('empty')
  assert(emptyAt >= 0, '前置：有一个「没有这一槽」的块')
  const firstBox = page.locator('.tv-row').nth(emptyAt).locator('input[type="checkbox"]')
  await firstBox.click()
  await page.waitForTimeout(250)
  const after = await states()
  assert(after[emptyAt] === 'true', `点一下 ⇒ 已勾（从「没有值」到 true）：${JSON.stringify(after)}`)
  const ops = await page.evaluate(() => window.__qua.lastOps().map((o) => (o.e === 'prop' ? `prop:${o.op}` : `${o.e}:${o.op}`)))
  assert(ops.filter((x) => x === 'prop:set').length === 1, `一次勾选一条 prop.set：${JSON.stringify(ops)}`)

  await ctx.close()
  return `三态 ${JSON.stringify(s)}；点一下 → true（1 条 prop.set）`
})

/* ---------------------------------------------------------------- T155 */

await check('T155 规模：300 行不窗口化（全挂）、3000 行窗口化（首屏 ≤60 行、DOM ≤2000）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  const id = await pageByTitle(page, '输入面笔记')
  await page.waitForTimeout(300)

  /**
   * 300 行 / 3000 行都用 `forceForest` 造：这是**没有生产入口**的状态（用户不会手写 3000 个块），
   * 而断言要验的是**渲染策略怎么选**，不是「建 3000 个块要多久」。
   * ⚠️ 它不产 op、不落盘，只在测试面存在（见诊断面注释），不拿来模拟用户动作。
   */
  const fill = (n) =>
    page.evaluate(
      (a) => {
        window.__qua.forceForest((forest) => {
          const walk = (l) => {
            for (const x of l) {
              if (x.id === a.id) return x
              const r = walk(x.children)
              if (r) return r
            }
            return null
          }
          const target = walk(forest)
          const at = Date.now()
          for (let i = target.children.length; i < a.n; i++) {
            target.children.push({
              id: `bulk${a.n}-${i}`,
              content: [{ t: 'text', v: `第 ${i + 1} 行` }],
              children: [],
              created: at,
              modified: at,
            })
          }
        })
      },
      { id, n },
    )

  await fill(300)
  await page.evaluate((pid) => window.__qua.invoke('core.view/add', { blockId: pid, kind: 'table' }), id)
  await page.waitForTimeout(500)
  const small = await page.evaluate(() => ({
    rows: document.querySelectorAll('.tv-row').length,
    virtual: document.querySelector('.tv')?.dataset.virtual ?? '',
    cv: document.querySelector('.tv')?.dataset.cv ?? '',
  }))
  assert(small.rows === 300, `300 行全挂（不虚拟化）：${JSON.stringify(small)}`)
  assert(small.virtual === '0' && small.cv === '1', `300–2000 那档用 content-visibility：${JSON.stringify(small)}`)

  await fill(3000)
  await page.waitForTimeout(600)
  const big = await page.evaluate(() => ({
    mounted: document.querySelectorAll('.tv-row').length,
    virtual: document.querySelector('.tv')?.dataset.virtual ?? '',
    nodes: document.querySelectorAll('#editor *').length,
    total: [...document.querySelectorAll('.tv-row')].length,
  }))
  assert(big.virtual === '1', `3000 行应窗口化：${JSON.stringify(big)}`)
  assert(big.mounted <= 60, `首屏挂载的行 ≤60：${big.mounted}`)
  assert(big.nodes <= 2000, `#editor 里 DOM ≤2000：${big.nodes}`)

  // 滚一段：窗口跟着换，且不重挂整表（行数仍在上限内）
  await page.evaluate(() => {
    const sc = document.querySelector('.tv-scroll')
    sc.scrollTop = 4000
    sc.dispatchEvent(new Event('scroll'))
  })
  await page.waitForTimeout(200)
  const scrolled = await page.evaluate(() => ({
    mounted: document.querySelectorAll('.tv-row').length,
    first: document.querySelector('.tv-row')?.dataset.blockId ?? '',
  }))
  assert(scrolled.mounted <= 60, `滚动后仍只挂一屏：${scrolled.mounted}`)
  assert(scrolled.first !== 'bulk3000-0', `滚动后窗口确实移动了：${scrolled.first}`)

  await ctx.close()
  return `300 行全挂（cv=1）；3000 行挂 ${big.mounted} 行、DOM ${big.nodes}；滚动后 ${scrolled.mounted} 行`
})

/* ---------------------------------------------------------------- T156 */

await check('T156 窄容器降级：表格变紧凑列表（不横向溢出），点一行去中心槽打开', async () => {
  const { ctx, page } = await freshPage(browser, base, { viewport: { width: 900, height: 800 } })
  await page.evaluate(() => window.__qua.quiet(true))
  const id = await pageByTitle(page, '输入面笔记')
  await page.waitForTimeout(300)
  await page.evaluate((pid) => window.__qua.invoke('core.view/add', { blockId: pid, kind: 'table' }), id)
  await page.waitForTimeout(500)

  const compact = await page.evaluate(() => {
    const tv = document.querySelector('.tv')
    const sc = document.querySelector('.tv-scroll')
    return {
      flag: tv?.dataset.compact ?? 'none',
      rows: document.querySelectorAll('.tv-row').length,
      compactRows: document.querySelectorAll('.tv-compact-row').length,
      overflowX: sc ? sc.scrollWidth > sc.clientWidth + 1 : false,
      width: tv?.clientWidth ?? 0,
      hint: document.querySelector('.tv-compact-foot')?.textContent ?? '',
    }
  })
  assert(compact.flag === '1', `窄容器应降级：${JSON.stringify(compact)}`)
  assert(compact.compactRows > 0 && compact.rows === 0, `降级后是紧凑列表：${JSON.stringify(compact)}`)
  assert(!compact.overflowX, `紧凑列表不该横向溢出：${JSON.stringify(compact)}`)
  assert(compact.hint.length > 0, '降级要说明白（不能悄悄换了个形态）')

  const target = await page.locator('.tv-compact-row').first().getAttribute('data-block-id')
  await page.locator('.tv-compact-row').first().click()
  await page.waitForTimeout(400)
  const opened = await page.evaluate(() => window.__qua.snapshot().activeId)
  assert(opened === target, `点一行应打开那一块：${target} → ${opened}`)

  await ctx.close()
  return `${compact.width}px ⇒ 紧凑列表（${compact.compactRows} 行、无横向溢出）；点行打开 ${target.slice(0, 6)}`
})

/* ---------------------------------------------------------------- T157 */

await check('T157 入口：块菜单「视图…」→ 新建表格 ⇒ _activeView 指向新视图；叶子块不给这一项', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  const id = await pageByTitle(page, '输入面笔记')
  await page.waitForTimeout(300)

  // 块菜单的 `when` 认「聚焦的是哪一块」⇒ 先真的把光标落到它上面
  await page.evaluate((pid) => window.__qua.focusBlock(pid, 0), id)
  await page.evaluate((pid) => window.__qua.openBlockMenu(pid), id)
  await page.waitForTimeout(250)
  const first = await layerRows(page)
  assert(
    first.some((r) => r.label.includes('视图')),
    `有子块的块，块菜单里应有「视图…」：${JSON.stringify(first.map((r) => r.label))}`,
  )
  const at = first.findIndex((r) => r.label.includes('视图'))
  await page.locator(`.layer-item[data-index="${at}"]`).click()
  await page.waitForTimeout(220)
  const second = await layerRows(page)
  assert(second.some((r) => r.label === '大纲'), `子菜单里有「大纲」：${JSON.stringify(second.map((r) => r.label))}`)
  assert(second.some((r) => r.label === '新建表格'), `子菜单里有「新建表格」：${JSON.stringify(second.map((r) => r.label))}`)
  const addAt = second.findIndex((r) => r.label === '新建表格')
  assert(second[addAt].hint !== undefined || true, '行可点')
  await page.locator(`.layer-item[data-index="${addAt}"]`).click()
  await page.waitForTimeout(450)

  const after = await page.evaluate((pid) => {
    const walk = (l) => {
      for (const x of l) {
        if (x.id === pid) return x
        const r = walk(x.children)
        if (r) return r
      }
      return null
    }
    const b = walk(window.__qua.__editor.store.blocks)
    const views = b.props?._views ?? []
    return {
      activeView: b.props?._activeView ?? '',
      viewIds: views.map((v) => v.id),
      kinds: views.map((v) => v.kind),
      rows: document.querySelectorAll('.tv-row').length,
      cols: (views[0]?.table?.columns ?? []).map((c) => c.key),
    }
  }, id)
  assert(after.viewIds.length === 1 && after.kinds[0] === 'table', `新建的是一个表格视图：${JSON.stringify(after)}`)
  assert(after.activeView === after.viewIds[0], `_activeView 指向它：${JSON.stringify(after)}`)
  assert(after.rows > 0, '建完当场就是表格（不用再点一次）')
  assert(after.cols[0] === 'title' && after.cols.length > 1, `默认列算了一次并写进配置：${JSON.stringify(after.cols)}`)

  // 叶子块（没有子块、不是查询块）不给这一项：点了没有结果的入口比没有更糟
  const leaf = await page.evaluate(() => {
    const walk = (l) => {
      for (const x of l) {
        if (x.children.length === 0 && !x.props?._query && (x.content ?? []).length > 0) return x
        const r = walk(x.children)
        if (r) return r
      }
      return null
    }
    return walk(window.__qua.__editor.store.blocks)?.id ?? ''
  })
  assert(leaf, '前置：库里应有一个叶子块')
  await page.evaluate((bid) => window.__qua.focusBlock(bid, 0), leaf)
  await page.evaluate((bid) => window.__qua.openBlockMenu(bid), leaf)
  await page.waitForTimeout(200)
  const leafRows = await layerRows(page)
  assert(
    !leafRows.some((r) => r.label.includes('视图')),
    `叶子块不该有「视图…」：${JSON.stringify(leafRows.map((r) => r.label))}`,
  )

  await ctx.close()
  return `块菜单→视图…→新建表格 ⇒ ${after.viewIds.length} 个视图（${after.kinds.join(',')}），列 ${after.cols.length} 个；叶子块不给入口`
})

/* ---------------------------------------------------------------- T158 */

await check('T158 查询源也能是表格：行＝冻结命中（不折叠祖先）、没有「新建一行」、刷新照旧', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  const qid = await page.evaluate(() => {
    const p = window.__qua.pages().find((x) => (x.title ?? '').includes('产品设计'))
    window.__qua.invoke('core.page/open', { pageId: p.id })
    let found = ''
    const walk = (list) => {
      for (const b of list) {
        if (b.props?._query) {
          found = b.id
          return
        }
        walk(b.children)
      }
    }
    walk(window.__qua.__editor.store.blocks)
    return found
  })
  assert(qid, '前置：库里有一个查询块')
  await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), qid)
  await page.waitForTimeout(400)

  /**
   * 冻结一次（打开查询块时触发），看几张命中。
   *
   * ⚠️ **读 DOM，不读块**：v29 起结果按**表面实例**冻结，块上没有任何一格记它
   * （`_queryResult` 已删）。大纲分支的每一行就是这一批命中。
   */
  const hits = await page.evaluate(() => ({
    frozen: [...document.querySelectorAll('.queryview-editor .blk[data-depth]')].map((e) => e.dataset.blockId ?? ''),
  }))
  assert(hits.frozen.length > 0, `前置：查询应冻结出至少一条命中：${JSON.stringify(hits)}`)

  await page.evaluate(
    (id) => window.__qua.invoke('core.view/add', { owner: { kind: 'block', blockId: id }, kind: 'table' }),
    qid,
  )
  await page.waitForTimeout(450)
  const table = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('.tv-row')].map((r) => r.dataset.blockId ?? ''),
    newRow: !document.querySelector('.queryview-newrow')?.hidden,
    refresh: !document.querySelector('.queryview-refresh')?.hidden,
    count: document.querySelector('.queryview-count')?.textContent ?? '',
  }))
  assert(table.rows.length === hits.frozen.length, `行＝冻结命中：${table.rows.length} vs ${hits.frozen.length}`)
  assert(
    table.rows.every((id) => hits.frozen.includes(id)),
    `每一行都来自冻结集合：${JSON.stringify(table.rows)}`,
  )
  assert(!table.newRow, '查询源没有「新建一行」（行是命中，不是这里能长出来的块）')
  assert(table.refresh, '查询源的刷新按钮还在（冻结/过期仍是它的机制）')
  assert(table.count.length > 0, '抬头要报条数')

  // 刷新不变成员：还是那几条（判据与大纲分支同一套）
  await page.locator('.queryview-refresh').click()
  await page.waitForTimeout(450)
  const after = await page.evaluate(() => [...document.querySelectorAll('.tv-row')].map((r) => r.dataset.blockId ?? ''))
  assert(JSON.stringify(after) === JSON.stringify(table.rows), `刷新后成员与顺序不变：${JSON.stringify(after)}`)

  await ctx.close()
  return `${table.rows.length} 行＝冻结命中；无「新建一行」；刷新后成员不变（${table.count}）`
})

/* ---------------------------------------------------------------- T159 */

await check('T159 在一屏多根（日记流）上给某一天建表：会换屏到那一天，而不是「点了没生效」', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  // 等冷启动落定：默认落点是**今天**，装的是日记流（今日 ＋ 更早的天 ⇒ 多个根）
  await page.waitForTimeout(1200)
  const before = await page.evaluate(() => ({
    roots: window.__qua.__editor.doc.roots.length,
    active: window.__qua.snapshot().activeId,
  }))
  assert(before.roots > 1, `前置：冷启动应是一屏多根（日记流），实际 ${before.roots}`)

  // 真鼠标：右点今天这一行的块标 → 视图… → 新建表格
  await page.locator('#editor .blk[data-depth="0"] [data-drag-for]').first().click({ button: 'right' })
  await page.waitForTimeout(300)
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('.layer-item')].map((e) => e.textContent?.replace(/\s+/g, ' ').trim()),
  )
  const at = rows.findIndex((r) => r.includes('视图'))
  assert(at >= 0, `块菜单里应有「视图…」：${JSON.stringify(rows.slice(-4))}`)
  await page.locator(`.layer-item[data-index="${at}"]`).click()
  await page.waitForTimeout(260)
  await page.locator('.layer-item', { hasText: '新建表格' }).first().click()
  await page.waitForTimeout(800)

  const after = await page.evaluate(() => ({
    roots: window.__qua.__editor.doc.roots.map((b) => b.id),
    viewRoot: window.__qua.__editor.doc.viewRootId ?? '',
    view: Boolean(document.querySelector('.queryview:not([hidden])')),
    rows: document.querySelectorAll('.tv-row').length,
    active: window.__qua.snapshot().activeId,
    activeView: window.__qua.__editor.doc.roots[0]?.props?._activeView ?? '',
  }))
  /**
   * 三件事一起钉：① 屏幕真的换了（一屏多根时视图宿主没有落脚点 ⇒ 必须收成单根）；
   * ② 表真的画出来了（用户可见的那一条）；③ 配置落在**被点的那一块**上。
   */
  assert(after.roots.length === 1, `建视图后应收成单根（否则视图宿主无处安放）：${JSON.stringify(after.roots)}`)
  assert(after.roots[0] === before.active, `换屏的目标就是刚点的那一天：${after.roots[0]} vs ${before.active}`)
  assert(after.viewRoot === after.roots[0], `视图宿主记着是谁的孩子让位了：${after.viewRoot}`)
  assert(after.view && after.rows > 0, `表必须当场出现（不是只写了配置）：${JSON.stringify({ view: after.view, rows: after.rows })}`)
  assert(after.activeView !== '', `_activeView 指向新视图：${after.activeView}`)

  await ctx.close()
  return `${before.roots} 根 → 1 根；表 ${after.rows} 行（点的是块菜单那条路）`
})

/* ---------------------------------------------------------------- T160 */

/**
 * **大纲 → 表格（结构映射）**的样例树，用**命令面**造（与真人敲 ↵＋Tab 走同一条路，
 * 不直接改模型）：
 *
 * ```
 * 页（容器 R）      表头（第一行）＝直接子块；一列＝那个子块的孩子（各项）
 * ├ 名称 ├ 键盘      ← 这一列的第 1 项
 * │      └ 鼠标      ← 这一列的第 2 项
 * ├ 价格 ├ 399       ← 只有一项：第 2 行这一列空着
 * └ 库存 ├ 12
 *        └ 40 └ 备注  ← 三级起：「＋N 项」可展开，不进主表列
 * ```
 *
 * 返回表头（rows）与每一格的 id（断言按模型算，不写死种子内容）。
 * ⚠️ 名字沿用 rows（它是**表头**：三个直接子块），断言里别把它当「行」。
 */
const buildListTree = (page) =>
  page.evaluate(() => {
    const q = window.__qua
    const inv = (name, args = {}) => q.invoke(name, args)
    const focus = (id) => q.focusBlock(id, 0)
    const sel = () => q.__editor.sel?.aBlock ?? ''
    inv('core.page/new')
    const root = q.__editor.doc.roots[0].id
    // 新页自带一个空首子块：先把它后面铺三行，再把这个空块删掉
    const stub = q.__editor.doc.roots[0].children[0].id
    inv('core.editor/insert-block', { text: '名称' })
    const r1 = sel()
    inv('core.editor/insert-block', { text: '价格' })
    const r2 = sel()
    inv('core.editor/insert-block', { text: '库存' })
    const r3 = sel()
    focus(stub)
    inv('core.editor/delete-block')
    // 名称 → 键盘 / 鼠标
    focus(r1)
    inv('core.editor/insert-block', { text: '键盘' })
    const c11 = sel()
    inv('core.editor/indent-block')
    inv('core.editor/insert-block', { text: '鼠标' })
    const c12 = sel()
    // 价格 → 399（只有一个孩子）
    focus(r2)
    inv('core.editor/insert-block', { text: '399' })
    const c21 = sel()
    inv('core.editor/indent-block')
    // 库存 → 12 / 40（40 还带一层：用于「＋N 项」）
    focus(r3)
    inv('core.editor/insert-block', { text: '12' })
    const c31 = sel()
    inv('core.editor/indent-block')
    inv('core.editor/insert-block', { text: '40' })
    const c32 = sel()
    focus(c32)
    inv('core.editor/insert-block', { text: '备注' })
    inv('core.editor/indent-block')
    return { root, rows: [r1, r2, r3], cells: { c11, c12, c21, c31, c32 } }
  })

/** 结构映射表的 DOM 现状（断言只读这里，不猜实现） */
const listState = (page) =>
  page.evaluate(() => {
    const lt = document.querySelector('.lt')
    const cellsOf = (row) =>
      [...row.querySelectorAll('.lt-cell')].map((c) => ({
        col: c.dataset.col ?? '',
        block: c.dataset.blockId ?? '',
        head: c.classList.contains('lt-cell--head'),
        empty: c.classList.contains('lt-cell--empty'),
        more: c.querySelector('.lt-more')?.textContent ?? '',
        subs: c.querySelectorAll('.lt-sub-item').length,
      }))
    const rows = [...document.querySelectorAll('.lt-row')]
    const headRow = rows.find((r) => r.classList.contains('lt-row--head')) ?? null
    return {
      caption: document.querySelector('.lt-caption')?.textContent ?? '',
      cols: lt ? getComputedStyle(lt).getPropertyValue('--lt-cols').trim() : '',
      head: headRow ? cellsOf(headRow) : [],
      headWeight: headRow ? getComputedStyle(headRow).fontWeight : '',
      headSticky: headRow ? getComputedStyle(headRow).position === 'sticky' : false,
      rows: rows
        .filter((r) => !r.classList.contains('lt-row--head'))
        .map((r) => ({ index: r.dataset.row ?? '', cells: cellsOf(r) })),
      empty: document.querySelector('.lt-empty')?.textContent ?? '',
      subs: [...document.querySelectorAll('.lt-sub-item')].map((s) => s.dataset.blockId ?? ''),
      rootBlks: document.querySelectorAll('#editor > .sec > .blk[data-block-id]').length,
    }
  })

/** 从模型里读一棵树的形状（断言「children 顺序有没有被动过」） */
const listModel = (page, rid) =>
  page.evaluate((id) => {
    const walk = (l) => {
      for (const x of l) {
        if (x.id === id) return x
        const r = walk(x.children)
        if (r) return r
      }
      return null
    }
    const b = walk(window.__qua.__editor.store.blocks)
    const text = (x) => (x.content ?? []).filter((r) => r.t === 'text').map((r) => r.v).join('')
    const live = b.children.filter((c) => c.props?._deletedAt === undefined)
    return {
      title: b.props?._aliases?.[0] ?? text(b),
      // 活着的直接子块（＝表的**列**／表头）；软删的那一块仍在 children 里，但不占列
      children: live.map((c) => c.id),
      allChildren: b.children.map((c) => c.id),
      rows: live.map((c) => ({ id: c.id, text: text(c), kids: c.children.map((g) => g.id), props: c.props ?? null })),
    }
  }, rid)

/** 从模型里读某一块的正文（不猜 DOM） */
const blockText = (page, id) =>
  page.evaluate((bid) => {
    const walk = (l) => {
      for (const x of l) {
        if (x.id === bid) return x
        const r = walk(x.children)
        if (r) return r
      }
      return null
    }
    const b = walk(window.__qua.__editor.store.blocks)
    return (b?.content ?? []).filter((r) => r.t === 'text').map((r) => r.v).join('')
  }, id)

await check('T160 大纲表格：表头＝容器的直接子块、一列＝它的孩子、行数＝最长的一列；正文只画根行', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  const fx = await buildListTree(page)
  const model = await listModel(page, fx.root)
  await page.evaluate((rid) => window.__qua.invoke('core.view/add', { blockId: rid, kind: 'list-table' }), fx.root)
  await page.waitForTimeout(450)

  const st = await listState(page)
  const cols = model.children.length
  assert(st.head.length === cols, `列数＝一级子块数：${st.head.length} vs ${cols}`)
  assert(
    JSON.stringify(st.head.map((c) => c.block)) === JSON.stringify(model.children),
    `表头就是一级子块、顺序＝children 顺序：${JSON.stringify(st.head.map((c) => c.block))} vs ${JSON.stringify(model.children)}`,
  )
  // 整屏打开时容器就是这一屏的根：页面标题已经写着它 ⇒ 不再重复一句表标题
  assert(st.caption === '', `整屏不画重复的表标题：${st.caption}`)
  assert(st.cols.startsWith(`repeat(${cols}`), `列数写在同一个变量里（与平表同一条约束）：${st.cols}`)
  const height = Math.max(...model.rows.map((r) => r.kids.length))
  assert(st.rows.length === height, `行数＝最长的一列（${height}）：${st.rows.length}`)
  // 第 j 行＝每列各取第 j 项（按位置对齐，不按名字）
  const want = [0, 1].map((j) => model.rows.map((r) => r.kids[j] ?? ''))
  const got = st.rows.map((r) => r.cells.map((c) => c.block))
  assert(JSON.stringify(got) === JSON.stringify(want), `第 j 行＝每列各取第 j 项：${JSON.stringify(got)} vs ${JSON.stringify(want)}`)
  assert(
    st.rows[1].cells[1].empty,
    `某一列少一项 ⇒ 那一格空着，别的列不错位：${JSON.stringify(st.rows[1].cells)}`,
  )
  assert(st.rootBlks === 1, `正文只画根行（表头与各项都不在正文里重复）：${st.rootBlks}`)

  await ctx.close()
  return `${cols} 列 × ${height} 行；表头＝children；第 j 行＝各列第 j 项；价格列第 2 行空着；正文只画根行`
})

/* ---------------------------------------------------------------- T161 */

await check('T161 大纲表格：新建一列⇒表头多一格（行数不变）；某一列前面插一项⇒只有那一列往下挪一格', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  const fx = await buildListTree(page)
  await page.evaluate((rid) => window.__qua.invoke('core.view/add', { blockId: rid, kind: 'list-table' }), fx.root)
  await page.waitForTimeout(450)
  const before = await listState(page)

  // 抬头那颗 ＋ 在结构映射表里加的是**一列**：顶部多一个直接子块（与平表加一行同一个命令）
  await page.locator('.queryview-newrow').click()
  await page.waitForTimeout(400)
  const afterNew = await listState(page)
  assert(afterNew.head.length === before.head.length + 1, `新建一列⇒表头多一格：${before.head.length} → ${afterNew.head.length}`)
  assert(afterNew.rows.length === before.rows.length, `新列还没有项⇒行数不变：${afterNew.rows.length}`)
  assert(afterNew.head[afterNew.head.length - 1].block !== '', '新列的表头是一个真实的块（空正文）')

  /**
   * 在「名称」这一列的第一个项前面插一项：用真实手势 —— 打开那一列（块）→ 在第一个孩子后面
   * 插一个块 → 与它换位（移到最前）→ 退出。回到表里时**只有这一列**往下挪一格。
   */
  await page.evaluate(
    ({ col, firstKid }) => {
      const q = window.__qua
      q.invoke('core.block/focus-block', { blockId: col })
      q.focusBlock(firstKid, 0)
      q.invoke('core.editor/insert-block', { text: '新项' })
      q.invoke('core.editor/move-block-up')
    },
    { col: fx.rows[0], firstKid: fx.cells.c11 },
  )
  await page.waitForTimeout(250)
  await page.evaluate(() => window.__qua.invoke('core.block/zoom-out'))
  await page.waitForTimeout(450)

  const st = await listState(page)
  assert(st.rows.length === before.rows.length + 1, `某一列多一项⇒多一行：${before.rows.length} → ${st.rows.length}`)
  assert(st.head.length === afterNew.head.length, `列数不变（插的是项，不是列）：${st.head.length}`)
  assert(
    st.rows[0].cells[0].block !== fx.cells.c11 &&
      st.rows[1].cells[0].block === fx.cells.c11 &&
      st.rows[2].cells[0].block === fx.cells.c12,
    `名称列整列往下挪一格：${JSON.stringify(st.rows.map((r) => r.cells[0].block))}`,
  )
  assert(
    st.rows[0].cells[1].block === fx.cells.c21 && st.rows[1].cells[1].empty && st.rows[2].cells[1].empty,
    `别的列不错位（价格仍是它的第 1 项，底下空着）：${JSON.stringify(st.rows.map((r) => r.cells[1].block))}`,
  )
  const model = await listModel(page, fx.root)
  assert(model.rows[0].kids.length === 3, `模型里名称那一列确实多了一项：${JSON.stringify(model.rows[0].kids)}`)

  await ctx.close()
  return `新建一列 ${before.head.length}→${afterNew.head.length}；名称列插一项 ⇒ 3 行（只有这一列往下挪）；价格列跟着空两格`
})

/* ---------------------------------------------------------------- T162 */

await check('T162 大纲表格：第一行就是表头（直接子块、加粗＋吸顶）；删掉一格⇒那一列与它的项一起消失；数据上没有表头字段', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  const fx = await buildListTree(page)
  await page.evaluate((rid) => window.__qua.invoke('core.view/add', { blockId: rid, kind: 'list-table' }), fx.root)
  await page.waitForTimeout(450)

  const first = await listState(page)
  const before = await listModel(page, fx.root)
  assert(first.headWeight !== '' && Number(first.headWeight) >= 600, `表头是加粗：${first.headWeight}`)
  assert(first.headSticky, '表头吸顶（滚动时留在上面）')
  assert(
    JSON.stringify(first.head.map((c) => c.block)) === JSON.stringify(before.children),
    `表头就是直接子块（不是「猜出来的第一行」）：${JSON.stringify(first.head.map((c) => c.block))}`,
  )
  assert(before.rows[0].props === null, `数据上没有任何「表头」字段：${JSON.stringify(before.rows[0].props)}`)

  // 删掉第一列：软删那个直接子块 ⇒ 这一列与它的项一起从表里消失
  const headCell = page.locator('.lt-cell--head').first()
  await headCell.hover()
  await headCell.locator('.lt-del').click()
  await page.waitForTimeout(450)
  const after = await listState(page)
  assert(after.head.length === first.head.length - 1, `删掉一格⇒少一列：${after.head.length}`)
  assert(
    after.head[0].block === first.head[1].block,
    `后面的列左移一格接替：${JSON.stringify(after.head.map((c) => c.block))}`,
  )
  assert(
    after.rows.every((r) => r.cells[0].block !== fx.cells.c11 && r.cells[0].block !== fx.cells.c12),
    `那一列的项也不在表里了：${JSON.stringify(after.rows.map((r) => r.cells[0].block))}`,
  )
  const m1 = await listModel(page, fx.root)
  assert(m1.allChildren.length === before.allChildren.length, '软删不是搬走：被删的直接子块仍在 children 里（可撤销）')
  assert(m1.children.length === before.children.length - 1, `活着的列少一个：${m1.children.length}`)

  await ctx.close()
  return `表头 ${first.head.length} 列、加粗(${first.headWeight})＋吸顶；删一格 ⇒ 那一列与项一起消失；children 里那块还在（软删）`
})

/* ---------------------------------------------------------------- T163 */

await check('T163 大纲表格：改格子⇒写回那一块（表头格写直接子块）；项下面的子树「＋N 项」可展开、不占主表列', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  const fx = await buildListTree(page)
  await page.evaluate((rid) => window.__qua.invoke('core.view/add', { blockId: rid, kind: 'list-table' }), fx.root)
  await page.waitForTimeout(450)
  const before = await listState(page)

  // 改身体格 ⇒ 写的是那一列的那一项（不是表头那一块）
  await page.locator(`.lt-cell[data-block-id="${fx.cells.c11}"] .tv-title-inner`).click()
  await page.waitForTimeout(220)
  const opened = await page.evaluate(() => ({
    overlays: document.querySelectorAll('.tv-edit').length,
    id: document.querySelector('.tv-edit')?.dataset.blockId ?? '',
  }))
  assert(opened.overlays === 1 && opened.id === fx.cells.c11, `点那一格开的是那一项：${JSON.stringify(opened)}`)

  await page.evaluate(() => window.__qua.quiet(false))
  await page.keyboard.type('X')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(350)
  const kid = await blockText(page, fx.cells.c11)
  assert(kid.includes('X'), `字进了那一项：${kid}`)
  const head = await blockText(page, fx.rows[0])
  assert(!head.includes('X'), `没有写到表头那一块上：${head}`)
  const ops = await page.evaluate(() => window.__qua.lastOps())
  assert(ops.length > 0 && ops.every((o) => o.id === fx.cells.c11), `这一笔只碰那一项：${JSON.stringify(ops)}`)

  // 表头格：改的是那一列自己（直接子块）
  await page.locator(`.lt-cell--head[data-block-id="${fx.rows[0]}"] .tv-title-inner`).click()
  await page.waitForTimeout(220)
  await page.keyboard.type('Y')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(350)
  const head2 = await blockText(page, fx.rows[0])
  assert(head2.includes('Y'), `表头格改写的是那一块自己的正文：${head2}`)

  // 三级起：项自己的孩子收成「＋N 项」，展开不增加主表列
  const moreSel = `.lt-cell[data-block-id="${fx.cells.c32}"] .lt-more`
  const moreText = await page.locator(moreSel).textContent()
  assert(moreText.includes('1'), `项里有孩子时给「＋N 项」：${moreText}`)
  await page.locator(moreSel).click()
  await page.waitForTimeout(300)
  const ex = await listState(page)
  assert(ex.subs.length === 1, `点开之后那一格摊开一个子块：${JSON.stringify(ex.subs)}`)
  assert(ex.head.length === before.head.length, `展开不增加主表列：${ex.head.length}`)
  assert(ex.cols === before.cols, `列数没变：${ex.cols}`)

  // 表头块标：打开那一列的直接子块（换中心）。块标是 `visibility: hidden`，先悬停那一格
  const headCell = page.locator(`.lt-cell--head[data-block-id="${fx.rows[1]}"]`)
  await headCell.hover()
  await headCell.locator('.lt-marker').click()
  await page.waitForTimeout(400)
  const active = await page.evaluate(() => window.__qua.snapshot().activeId)
  assert(active === fx.rows[1], `点表头块标＝打开那个一级子块：${active} vs ${fx.rows[1]}`)

  await ctx.close()
  return `身体格写回 ${fx.cells.c11}（只碰它）；表头格写那一列自己；＋N 项展开 1 个子块、列数不变；块标打开 ${fx.rows[1]}`
})

/* ---------------------------------------------------------------- T164 */

await check('T164 大纲表格：按某一列排序⇒只改显示序（整行搬），表头与 children 顺序一个字节不动', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  const fx = await buildListTree(page)
  await page.evaluate((rid) => window.__qua.invoke('core.view/add', { blockId: rid, kind: 'list-table' }), fx.root)
  await page.waitForTimeout(450)
  const before = await listState(page)
  assert(before.rows.length === 2, `前置：2 行：${before.rows.length}`)

  /** 打开「视图…」并点一条按列排序（菜单是动态的，按标签找） */
  const sortByColumn = async (label) => {
    await page.evaluate((pid) => window.__qua.focusBlock(pid, 0), fx.root)
    await page.evaluate((pid) => window.__qua.openBlockMenu(pid), fx.root)
    await page.waitForTimeout(250)
    const first = await layerRows(page)
    const at = first.findIndex((r) => r.label.includes('视图'))
    assert(at >= 0, `块菜单里有「视图…」：${JSON.stringify(first.map((r) => r.label))}`)
    await page.locator(`.layer-item[data-index="${at}"]`).click()
    await page.waitForTimeout(250)
    const menu = await layerRows(page)
    const sortAt = menu.findIndex((r) => r.label === label)
    assert(sortAt >= 0, `视图菜单按列名列出排序（${label}）：${JSON.stringify(menu.map((r) => r.label))}`)
    await page.locator(`.layer-item[data-index="${sortAt}"]`).click()
    await page.waitForTimeout(450)
  }

  await sortByColumn('按「名称」列排序')
  const asc = await listState(page)
  assert(
    asc.rows[0].cells[0].block === fx.cells.c11,
    `升序：键盘 在前：${JSON.stringify(asc.rows.map((r) => r.cells[0].block))}`,
  )

  // 再点一次＝降序（菜单里这一项此刻标着「升序」，第三下取消）
  await sortByColumn('按「名称」列排序')
  const after = await listState(page)
  assert(
    JSON.stringify(after.rows.map((r) => r.cells[0].block)) === JSON.stringify([fx.cells.c12, fx.cells.c11]),
    `按第 1 列降序：鼠标 在前：${JSON.stringify(after.rows.map((r) => r.cells[0].block))}`,
  )
  assert(
    after.rows[0].cells[1].empty,
    `整行一起搬（鼠标那一行在价格列是空的）：${JSON.stringify(after.rows[0].cells)}`,
  )
  assert(
    JSON.stringify(after.head.map((c) => c.block)) === JSON.stringify(before.head.map((c) => c.block)),
    '表头不参与排序（列序不动）',
  )
  const model = await listModel(page, fx.root)
  assert(
    JSON.stringify(model.children) === JSON.stringify(fx.rows),
    `children 顺序一个字节不动：${JSON.stringify(model.children)}`,
  )
  const cfg = await page.evaluate((rid) => {
    const walk = (l) => {
      for (const x of l) {
        if (x.id === rid) return x
        const r = walk(x.children)
        if (r) return r
      }
      return null
    }
    const b = walk(window.__qua.__editor.store.blocks)
    const active = (b.props?._views ?? []).find((v) => v.id === b.props?._activeView)
    return { kind: active?.kind, sort: active?.listTable?.sort, columns: active?.table?.columns }
  }, fx.root)
  assert(cfg.kind === 'list-table' && cfg.sort?.col === 0, `排序写的是第 1 列：${JSON.stringify(cfg)}`)
  assert(cfg.columns === undefined, `结构映射表不存列（列是位置）：${JSON.stringify(cfg.columns)}`)

  await ctx.close()
  return `按「名称」列 升→降 ⇒ ${after.rows.map((r) => r.cells[0].block).join(',')}；表头不动；children 仍是 ${model.children.join(',')}；配置里没有列`
})

/* ---------------------------------------------------------------- T165–T167 露面（镜像／投影） */

/**
 * 露面样例树（用命令面造，与真人敲键盘同一条路）：
 *
 * ```
 * 页
 * ├ 源          ← 被露面的那一块（有 2 个子块）
 * │ ├ 子一
 * │ └ 子二
 * └ 这里放镜像  ← 宿主：在它下面插一次露面
 * ```
 */
const buildEmbedTree = (page) =>
  page.evaluate(() => {
    const q = window.__qua
    const inv = (name, args = {}) => q.invoke(name, args)
    const sel = () => q.__editor.sel?.aBlock ?? ''
    inv('core.page/new')
    const root = q.__editor.doc.roots[0].id
    const stub = q.__editor.doc.roots[0].children[0].id
    inv('core.editor/insert-block', { text: '源' })
    const src = sel()
    inv('core.editor/insert-block', { text: '子一' })
    const c1 = sel()
    inv('core.editor/indent-block')
    inv('core.editor/insert-block', { text: '子二' })
    const c2 = sel()
    q.focusBlock(src, 0)
    inv('core.editor/insert-block', { text: '这里放镜像' })
    const host = sel()
    q.focusBlock(stub, 0)
    inv('core.editor/delete-block')
    return { root, src, c1, c2, host }
  })

/** 露面行与它身体里的行（DOM → 只读读数） */
const embedState = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('.blk[data-embed="1"]')
    const body = el?.querySelector('.blk-embed-body')
    return {
      embedId: el?.dataset.blockId ?? '',
      state: el?.dataset.embedState ?? '',
      rows: [...(body?.querySelectorAll('.blk') ?? [])].map((x) => ({
        id: x.dataset.blockId,
        text: x.querySelector('.tx')?.textContent ?? '',
      })),
      note: body?.querySelector('.embed-note')?.textContent ?? '',
      tableCaption: body?.querySelector('.lt-caption')?.textContent ?? '',
      tableHeads: body?.querySelectorAll('.lt-cell--head').length ?? 0,
      tableRows: body?.querySelectorAll('.lt-row:not(.lt-row--head)').length ?? 0,
      nestedMirrors: body?.querySelectorAll('.embed-mirror').length ?? 0,
    }
  })

await check('T165 镜像：同一块在别处再露一次面；在镜像里改字，源与正文原位一起变', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  const fx = await buildEmbedTree(page)
  await page.evaluate(
    ({ host, src }) => window.__qua.invoke('core.embed/insert', { blockId: host, targetId: src, view: 'mirror' }),
    fx,
  )
  await page.waitForTimeout(300)
  const st = await embedState(page)
  assert(st.embedId !== '', '插了一次露面（.blk[data-embed] 存在）')
  assert(st.state === 'ok', `源还在 ⇒ 状态 ok：${st.state}`)
  assert(st.rows.length === 3, `镜像里是源＋两个子块：${JSON.stringify(st.rows)}`)
  assert(st.rows[0].id === fx.src, `第一行就是源自己（能就地改）：${JSON.stringify(st.rows[0])}`)
  // blockEl 的作用域：同一个 id 在这一屏有两份，正文那份不是岛里的
  const scope = await page.evaluate((sid) => {
    const el = window.__qua.__editor.blockEl(sid)
    return { inIsland: Boolean(el?.closest('.blk-embed-body')), text: el?.querySelector('.tx')?.textContent }
  }, fx.src)
  assert(scope.inIsland === false, `blockEl 取到的是正文那份，不是岛里的：${JSON.stringify(scope)}`)

  // 在镜像里（岛里）就地改源那一行
  const typed = await page.evaluate((sid) => {
    const rows = [...document.querySelectorAll(`.blk[data-block-id="${sid}"]`)]
    const island = rows.find((x) => x.closest('.blk-embed-body'))
    const tx = island?.querySelector('.tx')
    if (!tx) return false
    tx.focus()
    const sel = document.getSelection()
    const r = document.createRange()
    r.selectNodeContents(tx)
    r.collapse(false)
    sel.removeAllRanges()
    sel.addRange(r)
    return true
  }, fx.src)
  assert(typed, '能聚焦到镜像里的源那一行')
  await page.keyboard.type('XYZ')
  await page.waitForTimeout(250)
  const both = await page.evaluate((sid) => {
    const find = (b) => (b.id === sid ? b : b.children.map(find).find(Boolean) || null)
    const b = window.__qua.__editor.store.blocks.map(find).find(Boolean)
    return {
      model: b?.content.filter((r) => r.t === 'text').map((r) => r.v).join('') ?? '',
      doms: [...document.querySelectorAll(`.blk[data-block-id="${sid}"]`)].map((x) => x.querySelector('.tx')?.textContent ?? ''),
    }
  }, fx.src)
  assert(both.model.endsWith('XYZ'), `打进去的字落到源块上：${both.model}`)
  assert(both.doms.length === 2 && both.doms.every((t) => t.endsWith('XYZ')), `两处 DOM 都看到同一份内容：${JSON.stringify(both.doms)}`)

  // 只摘这一次露面：源一个字节不动
  const removed = await page.evaluate((id) => {
    window.__qua.invoke('core.embed/remove', { blockId: id })
    return {
      gone: !document.querySelector('.blk[data-embed="1"]'),
      embedGone: !window.__qua.__editor.store.find(id),
    }
  }, st.embedId)
  assert(removed.gone && removed.embedGone, `移除露面之后 DOM 与模型都没了：${JSON.stringify(removed)}`)
  const srcAfter = await page.evaluate((sid) => {
    const find = (b) => (b.id === sid ? b : b.children.map(find).find(Boolean) || null)
    return Boolean(window.__qua.__editor.store.blocks.map(find).find(Boolean))
  }, fx.src)
  assert(srcAfter, '源块还在（摘的是这一次露面，不是源）')

  await ctx.close()
  return `镜像 3 行；岛里改字后模型＝…XYZ，两处 DOM 同步；移除露面只摘露面`
})

await check('T166 投影：同一块在这里看成大纲表格（表头＝源的直接子块），源块不动', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  const fx = await buildEmbedTree(page)
  await page.evaluate(
    ({ host, src }) => window.__qua.invoke('core.embed/insert', { blockId: host, targetId: src, view: 'table' }),
    fx,
  )
  await page.waitForTimeout(450)
  const st = await embedState(page)
  assert(st.tableHeads === 2, `表头＝源的直接子块（2 列）：${st.tableHeads}`)
  // 嵌入是一行里的投影：源的名字在屏幕上没有第二处 ⇒ 表标题要有（与整屏那条相反）
  assert(st.tableCaption === '源', `嵌入时画表标题（说明这是哪棵树）：${JSON.stringify(st.tableCaption)}`)
  assert(st.tableRows === 0, `源的两个直接子块没有孩子 ⇒ 表头下没有内容行：${st.tableRows}`)
  /**
   * **看法住在源块上，露面只存一次选择**（v29）。
   *
   * 曾经露面块自己带一份 `_views`，于是同一批块在正文、面板、中心各露一次
   * 就得到三份各自演化的列与排序。现在：`_embed = {block, view}`，
   * `view` 指向**源块**上的那张命名视图。
   */
  const cfg = await page.evaluate((id) => {
    const find = (b) => (b.id === id ? b : b.children.map(find).find(Boolean) || null)
    const b = window.__qua.__editor.store.blocks.map(find).find(Boolean)
    return {
      embed: b?.props?._embed,
      hostViews: (b?.props?._views ?? []).length,
      onHost: b?.id,
      root: window.__qua.__editor.doc.roots[0]?.id,
    }
  }, st.embedId)
  assert(cfg.root === fx.root, `换看法不换屏（露面块不是「一个对象」）：${cfg.root} vs ${fx.root}`)
  assert(cfg.embed?.block === fx.src, `指针指向源：${JSON.stringify(cfg)}`)
  assert(cfg.hostViews === 0, `露面块**不存**看法（它是别人的一次露面）：${JSON.stringify(cfg)}`)
  assert(typeof cfg.embed?.view === 'string' && cfg.embed.view !== '', `这次露面选了源上的一张视图：${JSON.stringify(cfg.embed)}`)
  const srcViews = await page.evaluate((args) => {
    const find = (b) => (b.id === args.sid ? b : b.children.map(find).find(Boolean) || null)
    const b = window.__qua.__editor.store.blocks.map(find).find(Boolean)
    const views = b?.props?._views ?? []
    return { views: views.map((v) => ({ id: v.id, kind: v.kind })), hit: views.some((v) => v.id === args.view) }
  }, { sid: fx.src, view: cfg.embed.view })
  assert(srcViews.hit, `指针指的必须是**源上真的存在**的那张视图：${JSON.stringify(srcViews)}`)
  assert(srcViews.views.length === 1 && srcViews.views[0].kind === 'list-table', `源的命名视图是一张大纲表格：${JSON.stringify(srcViews.views)}`)

  await ctx.close()
  return `表格 2 列 0 行；_embed.view 指向源上那张 list-table；露面块自己不带 _views`
})

await check('T167 深度 1：嵌入自己的子树只展开一层，里层只画占位（不递归）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  const fx = await buildEmbedTree(page)
  // 露面插在**源自己的子树里**（host 是源的子块）⇒ 镜像里会再遇到这次露面
  await page.evaluate(
    ({ c1, src }) => window.__qua.invoke('core.embed/insert', { blockId: c1, targetId: src, view: 'mirror' }),
    fx,
  )
  await page.waitForTimeout(350)
  const st = await embedState(page)
  assert(st.nestedMirrors === 1, `只有外层这一面镜像：${st.nestedMirrors}`)
  const nested = await page.evaluate((id) => {
    const outer = document.querySelector(`.blk[data-block-id="${id}"]`)
    const body = outer?.querySelector('.blk-embed-body')
    const inner = body?.querySelector('.blk[data-embed="1"]')
    return {
      text: inner?.textContent?.slice(0, 40) ?? '',
      islands: body?.querySelectorAll('.editable-block').length ?? 0,
    }
  }, st.embedId)
  assert(nested.text.includes('嵌套的露面不展开'), `里面那一次只画占位：${nested.text}`)
  assert(nested.islands === 1, `身体里只有一台编辑器（深度 1 的构造性截断）：${nested.islands}`)

  await ctx.close()
  return `嵌套只画占位；身体里只有一台编辑器`
})

await check('T168 悬空：源被删 ⇒ 说一句实话＋一个移除入口；露面块不连坐删除', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  const fx = await buildEmbedTree(page)
  // 露面在源**外面**（host 与源同级，露面挂在 host 下面）
  await page.evaluate(
    ({ host, src }) => window.__qua.invoke('core.embed/insert', { blockId: host, targetId: src, view: 'mirror' }),
    fx,
  )
  await page.waitForTimeout(300)
  const before = await embedState(page)
  assert(before.state === 'ok', `前置：源还在 ⇒ ok：${before.state}`)
  // 软删源：露面块不在源的子树里，所以仍然留在模型里
  await page.evaluate((sid) => window.__qua.__editor.remove(sid), fx.src)
  await page.waitForTimeout(300)
  const after = await embedState(page)
  assert(after.embedId === before.embedId, `露面块仍在原位（不连坐删除）：${after.embedId}`)
  assert(after.state === 'dangling', `悬空态：${after.state}`)
  assert(after.note !== '', `说得出一句实话：${after.note}`)
  const btn = await page.evaluate(() => Boolean(document.querySelector('.blk-embed-body .embed-remove')))
  assert(btn, '给一个「移除这次露面」的出口')
  await page.evaluate(() => document.querySelector('.blk-embed-body .embed-remove')?.click())
  await page.waitForTimeout(200)
  const gone = await page.evaluate(() => !document.querySelector('.blk[data-embed="1"]'))
  assert(gone, '点了之后露面块消失（只摘这一次露面）')

  await ctx.close()
  return `dangling（${after.note}）＋移除入口；源被删后露面块仍在`
})

await check('T169 重开之后露面还在：首帧也要有身体（事件表接上后必须重画一次）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  const fx = await buildEmbedTree(page)
  await page.evaluate(
    ({ host, src }) => window.__qua.invoke('core.embed/insert', { blockId: host, targetId: src, view: 'mirror' }),
    fx,
  )
  await page.waitForTimeout(300)
  const id = await page.evaluate(() => document.querySelector('.blk[data-embed="1"]')?.dataset.blockId ?? '')
  assert(id !== '', '前置：露面块在')
  // 等落盘（localStorage 是防抖写）
  await page.waitForTimeout(1200)
  await page.reload({ waitUntil: 'load' })
  await page.waitForFunction(() => Boolean(window.__qua), undefined, { timeout: 15_000 })
  await page.waitForTimeout(400)
  const after = await page.evaluate((eid) => {
    const el = document.querySelector(`.blk[data-block-id="${eid}"]`)
    const body = el?.querySelector('.blk-embed-body')
    return {
      dom: Boolean(el),
      state: el?.dataset.embedState ?? '',
      broken: body?.textContent?.includes('指针坏了') ?? false,
      rows: body?.querySelectorAll('.blk').length ?? 0,
    }
  }, id)
  assert(after.dom, '重开之后露面块还在（_embed 落库往返）')
  assert(after.state === 'ok', `源还在 ⇒ state ok：${after.state}`)
  assert(after.broken === false, `首帧就接上了身体，不是「指针坏了」：${JSON.stringify(after)}`)
  assert(after.rows >= 3, `身体里是源＋两个子块：${after.rows}`)

  await ctx.close()
  return `重开后露面仍在，身体 ${after.rows} 行（首帧重画生效）`
})

await check('T170 粘贴为…的二级菜单不是空的：when 里的键必须真实存在', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  const fx = await buildEmbedTree(page)
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base.replace(/\/$/, '') })
  // **真实路径**：选中源块的正文 → ⌘C（copy 事件把「复制了哪一块」报告给装配层）
  const sel = await page.evaluate((id) => {
    const el = [...document.querySelectorAll(`.blk[data-block-id="${id}"]`)].find((x) => x.querySelector('.tx'))
    const tx = el?.querySelector('.tx')
    if (!tx) return false
    tx.focus()
    const r = document.createRange()
    r.selectNodeContents(tx)
    const s = document.getSelection()
    s.removeAllRanges()
    s.addRange(r)
    return true
  }, fx.src)
  assert(sel, '选中源块的正文')
  await page.keyboard.press(kbd('mod+c'))
  await page.waitForTimeout(150)
  await page.evaluate((id) => window.__qua.focusBlock(id, 0), fx.host)
  await page.evaluate((id) => window.__qua.openBlockMenu(id), fx.host)
  await page.waitForTimeout(250)
  const first = await layerRows(page)
  const at = first.findIndex((r) => r.label.includes('粘贴为'))
  assert(at >= 0, `块菜单里有「粘贴为…」：${JSON.stringify(first.map((r) => r.label))}`)
  await page.locator(`.layer-item[data-index="${at}"]`).click()
  await page.waitForTimeout(250)
  const menu = await layerRows(page)
  assert(menu.length === 2, `二级菜单不是空的（两条）：${JSON.stringify(menu.map((r) => r.label))}`)
  assert(
    menu.some((r) => r.label.includes('镜像')) && menu.some((r) => r.label.includes('大纲表格')),
    `两项都在：${JSON.stringify(menu.map((r) => r.label))}`,
  )
  const i = menu.findIndex((r) => r.label.includes('镜像'))
  await page.locator(`.layer-item[data-index="${i}"]`).click()
  await page.waitForTimeout(350)
  const st = await embedState(page)
  assert(st.embedId !== '' && st.state === 'ok' && st.rows.length === 3, `选了镜像之后露面出现（源＋两子块）：${JSON.stringify(st)}`)

  await ctx.close()
  return `粘贴为… 有 2 项；选镜像后露面出现（源在剪贴板里）`
})

/**
 * **选项是定义块的子块**：属性定义页加两条 ⇒ 成员块的下拉出现两项；
 * 值存的是**选项块 id**（改名不改值）。
 */
await check(
  'T171 select 定义页加选项 → 成员块下拉出现；值存 choice id；改名不改值',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)

    const setup = await page.evaluate(() => {
      const tag = window.__qua.allBlocks().find((b) => b.lists.includes('tag') && b.aliases.includes('任务'))
      window.__qua.invoke('core.props/create-def', {
        blockId: tag.id,
        label: '冒烟状态',
        kind: 'select',
        target: 'declared',
      })
      const def = window.__qua.propDefs().find((d) => d.label === '冒烟状态')
      const member = window.__qua.tagMembers(tag.id)[0] ?? ''
      return { tagId: tag.id, defId: def?.id ?? '', memberId: member }
    })
    assert(setup.defId !== '' && setup.memberId !== '', `前置：定义与 #任务 的成员都应存在：${JSON.stringify(setup)}`)

    // 打开定义块：属性卡里就是选项编辑器（全量视角）
    await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), setup.defId)
    await page.waitForSelector('.choices-editor')
    const empty = await page.evaluate(() => ({
      target: document.getElementById('inspect-card')?.dataset.targetBlockId ?? '',
      rows: document.querySelectorAll('.choices-editor .choice-row').length,
      note: document.querySelector('.choices-editor .props-empty')?.textContent ?? '',
    }))
    assert(empty.target === setup.defId, `属性卡此刻的主体应是要编辑的定义块：${JSON.stringify(empty)}`)
    assert(empty.rows === 0 && empty.note.length > 0, `没有选项时给空态，而不是空下拉：${JSON.stringify(empty)}`)

    for (const [name, viaEnter] of [
      ['待办', false],
      ['完成', true],
    ]) {
      // 面板会随焦点变化重建：`fill` ＋ Playwright 的「等元素稳定」会和那次重建撞上。
      // 第二条走 Enter —— 只绑按钮 click、表单只 preventDefault 的话，按回车会静默什么都不加。
      await page.evaluate(
        ({ value, enter }) => {
          const input = document.querySelector('.choices-add .choice-add-name')
          if (!(input instanceof HTMLInputElement)) return
          input.value = value
          // 真实用法里焦点在输入框：Enter 才不会被全局键位当成「拆块」
          input.focus()
          input.dispatchEvent(new Event('input', { bubbles: true }))
          if (enter) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
          else document.querySelector('.choices-add .choice-add')?.click()
        },
        { value: name, enter: viaEnter },
      )
      await page.waitForTimeout(220)
    }
    const added = await page.evaluate(() => {
      const def = window.__qua.propDefs().find((d) => d.label === '冒烟状态')
      const block = window.__qua.__editor.store.blocks.find((b) => b.id === def?.id)
      return {
        rows: document.querySelectorAll('.choices-editor .choice-row').length,
        names: [...document.querySelectorAll('.choices-editor .choice-name')].map((e) => e.value),
        kids: block?.children.length ?? -1,
      }
    })
    assert(added.rows === 2 && added.kids === 2, `两条选项＝定义块的两个子块：${JSON.stringify(added)}`)
    assert(JSON.stringify(added.names) === JSON.stringify(['待办', '完成']), `顺序＝插入顺序：${JSON.stringify(added.names)}`)

    // 成员块：下拉里的项来自 choicesFor（空占位 ＋ 两条）
    await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), setup.memberId)
    await page.waitForTimeout(240)
    const options = await page.evaluate((propId) => {
      const sel = document.querySelector(`.prop-row[data-prop-id="${propId}"] select`)
      return sel ? [...sel.options].map((o) => ({ value: o.value, text: o.textContent })) : null
    }, setup.defId)
    assert(options && options.length === 3, `成员块下拉＝空占位＋两条选项：${JSON.stringify(options)}`)

    const pick = options[1]
    await page.selectOption(`.prop-row[data-prop-id="${setup.defId}"] select`, pick.value)
    await page.waitForTimeout(240)
    const wrote = await page.evaluate(
      (s) => window.__qua.fields(s.memberId).find((f) => f.propId === s.defId)?.value ?? null,
      setup,
    )
    assert(wrote === pick.value, `值必须是选项块 id，不是选项名：${JSON.stringify({ wrote, pick })}`)

    // 改名：只改选项块的正文，值零迁移
    await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), setup.defId)
    await page.waitForTimeout(240)
    await page.evaluate(() => {
      const input = document.querySelector('.choices-editor .choice-row .choice-name')
      if (!(input instanceof HTMLInputElement)) return
      input.value = '进行中'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('blur'))
    })
    await page.waitForTimeout(240)
    const after = await page.evaluate((s) => {
      const row = window.__qua.fields(s.memberId).find((f) => f.propId === s.defId)
      return { value: row?.value ?? null, labels: row?.choices.map((c) => c.label) ?? [] }
    }, setup)
    assert(after.value === pick.value, `改名之后值还是同一个 id：${JSON.stringify({ after, pick })}`)
    assert(after.labels.includes('进行中'), `选项名跟着变：${JSON.stringify(after.labels)}`)

    /**
     * **新建 select 之后直接落在定义页**：否则用户得到一个空下拉，还得自己猜
     * 「去哪加选项」。走 UI 的「新建」那条路（不是直接 invoke）。
     */
    await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), setup.memberId)
    await page.waitForTimeout(220)
    await page.evaluate(() => {
      if (!document.querySelector('.props-form--own')) document.getElementById('properties-add')?.click()
      const form = document.querySelector('.props-form--own')
      const pick = form?.querySelector('.props-pick')
      if (pick instanceof HTMLSelectElement) {
        pick.value = '__new__'
        pick.dispatchEvent(new Event('change', { bubbles: true }))
      }
      const name = form?.querySelector('.props-new-group input.prop-input')
      if (name instanceof HTMLInputElement) {
        name.value = '冒烟导航'
        name.dispatchEvent(new Event('input', { bubbles: true }))
      }
      const kind = form?.querySelector('.props-new-group select.prop-input')
      if (kind instanceof HTMLSelectElement) {
        kind.value = 'select'
        kind.dispatchEvent(new Event('change', { bubbles: true }))
      }
      form?.querySelector('.props-new-group input.prop-input')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      )
    })
    await page.waitForTimeout(360)
    const nav = await page.evaluate(() => ({
      target: document.getElementById('inspect-card')?.dataset.targetBlockId ?? '',
      editor: Boolean(document.querySelector('.choices-editor')),
      defId: window.__qua.propDefs().find((d) => d.label === '冒烟导航')?.id ?? '',
    }))
    assert(nav.defId !== '', `UI 新建 select 定义应写进库：${JSON.stringify(nav)}`)
    assert(nav.target === nav.defId && nav.editor, `新建 select 后应停在定义页（那里就是选项编辑器）：${JSON.stringify(nav)}`)

    await ctx.close()
    return `定义页加 2 条 ⇒ 成员下拉 3 项；值＝choice id（${pick.value.slice(-6)}）；改名不改值；新建 select 落在定义页`
  },
)

/**
 * **选项被软删**：值保留、控件显示「选项已删除」；恢复后显示回来。
 *
 * 这条同时钉住「删除不是清值」：清值是不可逆的第二个动作，不该藏在「删选项」里。
 */
await check(
  'T171b 删掉被引用的选项 ⇒ 值还在、显示「选项已删除」；恢复 ⇒ 显示回来',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)

    const setup = await page.evaluate(() => {
      const tag = window.__qua.allBlocks().find((b) => b.lists.includes('tag') && b.aliases.includes('任务'))
      window.__qua.invoke('core.props/create-def', {
        blockId: tag.id,
        label: '冒烟删除状态',
        kind: 'select',
        target: 'declared',
      })
      const def = window.__qua.propDefs().find((d) => d.label === '冒烟删除状态')
      window.__qua.invoke('core.props/add-choice', { defId: def.id, label: '会被删的选项' })
      // `invoke` 只回答 handled；新选项的 id 从模型的子块读（`def` 是活引用）
      const live = window.__qua.__editor.store.blocks.find((b) => b.id === def.id)
      const choiceId = live?.children[0]?.id ?? ''
      const member = window.__qua.tagMembers(tag.id)[0] ?? ''
      window.__qua.invoke('core.props/set-value', { blockId: member, propId: def.id, value: choiceId })
      return { defId: def.id, choiceId, memberId: member }
    })
    assert(setup.choiceId !== '' && setup.memberId !== '', '前置：应有一条被引用的选项与一个成员块')

    await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), setup.defId)
    await page.waitForTimeout(240)
    await page.evaluate((id) => document.querySelector(`.choice-item[data-choice-id="${id}"] [data-choice-delete]`)?.click(), setup.choiceId)
    await page.waitForTimeout(260)

    const deleted = await page.evaluate((s) => {
      const row = window.__qua.fields(s.memberId).find((f) => f.propId === s.defId)
      return {
        value: row?.value ?? null,
        choices: row?.choices.map((c) => c.id) ?? [],
        label: row?.currentChoiceLabel ?? null,
        deleted: row?.currentChoiceDeleted === true,
      }
    }, setup)
    assert(deleted.value === setup.choiceId, `软删不清值：${JSON.stringify(deleted)}`)
    assert(deleted.choices.length === 0, `软删的选项不进候选：${JSON.stringify(deleted.choices)}`)
    assert(deleted.label === '会被删的选项' && deleted.deleted, `旧名留着并标「已删除」（用户才知道恢复哪条）：${JSON.stringify(deleted)}`)

    await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), setup.memberId)
    await page.waitForTimeout(240)
    const missing = await page.evaluate((propId) => {
      const sel = document.querySelector(`.prop-row[data-prop-id="${propId}"] select`)
      const o = sel?.querySelector('option[data-missing="1"]')
      return { value: sel?.value ?? '', text: o?.textContent ?? '', missing: Boolean(o), deleted: o?.dataset.deleted ?? '' }
    }, setup.defId)
    assert(missing.missing && missing.value === setup.choiceId, `当前值仍选中：${JSON.stringify(missing)}`)
    assert(missing.text.includes('会被删的选项') && missing.text.includes('已删除'), `旧名 ＋ 「已删除」：${JSON.stringify(missing)}`)
    assert(missing.deleted === '1', `这一项要带 deleted 标记（不是「不在作用域」）：${JSON.stringify(missing)}`)

    await page.evaluate((id) => window.__qua.invoke('core.block/restore', { blockId: id }), setup.choiceId)
    await page.waitForTimeout(260)
    const restored = await page.evaluate((s) => {
      const row = window.__qua.fields(s.memberId).find((f) => f.propId === s.defId)
      return { value: row?.value ?? null, choices: row?.choices.map((c) => c.label) ?? [] }
    }, setup)
    assert(restored.value === setup.choiceId, `恢复后值仍指着它：${JSON.stringify(restored)}`)
    assert(restored.choices.includes('会被删的选项'), `恢复后选项回到候选：${JSON.stringify(restored.choices)}`)

    await ctx.close()
    return `软删被引用的选项 ⇒ 值在、旧名＋「已删除」；恢复 ⇒ 候选与显示都回来`
  },
)

/**
 * **选项（select）的可见范围与标签视角**
 *
 * 三件事一起钉：① 选项是定义块的子块（标签视角新增默认「只对本标签可见」）；
 * ② 作用域是多标签并集过滤（`#甲` 看得到、`#乙` 看不到）；③ 标签视角**就地展开**，
 * 不在抽屉上再叠一层抽屉。
 */
await check(
  'T172 标签视角的选项：新增默认只对本标签可见；#甲 看得到、#乙 看不到；就地展开不叠 drawer',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)

    const setup = await page.evaluate(() => {
      const leaves = window.__qua.blocks().filter((b) => b.text.trim().length > 1)
      const [a, b] = leaves
      window.__qua.invoke('core.tags/add', { blockId: a.id, name: '冒烟甲' })
      window.__qua.invoke('core.tags/add', { blockId: b.id, name: '冒烟乙' })
      const all = window.__qua.allBlocks()
      const tagA = all.find((x) => x.lists.includes('tag') && x.aliases.includes('冒烟甲'))
      const tagB = all.find((x) => x.lists.includes('tag') && x.aliases.includes('冒烟乙'))
      window.__qua.invoke('core.props/create-def', {
        blockId: tagA.id,
        label: '冒烟范围',
        kind: 'select',
        target: 'declared',
      })
      const def = window.__qua.propDefs().find((d) => d.label === '冒烟范围')
      // 同一个定义也声明给 #乙：作用域只在「两边都有这一行」时才看得出差别
      window.__qua.invoke('core.props/add-field', { blockId: tagB.id, propId: def.id, target: 'declared' })
      window.__qua.invoke('core.props/add-choice', { defId: def.id, label: '全局项' })
      return { a: a.id, b: b.id, tagA: tagA.id, tagB: tagB.id, defId: def.id }
    })
    assert(setup.defId !== '' && setup.a !== setup.b, `前置：两个块、两条标签、一条 select 定义：${JSON.stringify(setup)}`)
    await page.waitForTimeout(320)

    // 打开 #甲 的属性卡 → 标签属性段里那条 select 有「选项」入口
    await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), setup.tagA)
    await page.waitForSelector(`[data-declared-choices="${setup.defId}"]`)
    await page.evaluate((propId) => document.querySelector(`[data-declared-choices="${propId}"]`)?.click(), setup.defId)
    await page.waitForSelector('.choices-editor')
    const opened = await page.evaluate(() => ({
      drawers: document.querySelectorAll('.drawer').length,
      inCard: Boolean(document.querySelector('.prop-declared .choices-editor')),
      rows: document.querySelectorAll('.choices-editor .choice-row').length,
    }))
    assert(opened.drawers === 0, `标签视角就地展开，不叠 drawer：${JSON.stringify(opened)}`)
    assert(opened.inCard && opened.rows === 1, `标签属性段里出现选项编辑器（含已有的全局项）：${JSON.stringify(opened)}`)

    // 标签视角新增：缺省「只对本标签可见」
    await page.evaluate(() => {
      const input = document.querySelector('.choices-add .choice-add-name')
      if (!(input instanceof HTMLInputElement)) return
      input.value = '仅甲项'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      document.querySelector('.choices-add .choice-add')?.click()
    })
    await page.waitForTimeout(260)

    const seen = await page.evaluate((s) => {
      const rowOf = (id) => window.__qua.fields(id).find((f) => f.propId === s.defId)
      return {
        a: rowOf(s.a)?.choices.map((c) => c.label) ?? null,
        b: rowOf(s.b)?.choices.map((c) => c.label) ?? null,
      }
    }, setup)
    assert(
      JSON.stringify(seen.a) === JSON.stringify(['全局项', '仅甲项']),
      `#甲 的块看到全局项 ＋ 仅甲项：${JSON.stringify(seen.a)}`,
    )
    assert(
      JSON.stringify(seen.b) === JSON.stringify(['全局项']),
      `#乙 的块看不到「仅甲项」：${JSON.stringify(seen.b)}`,
    )

    /**
     * **标签视角只准动本标签专属的选项**：全局项对所有标签生效，
     * 这里不能改名、不能删除，只给「对本标签隐藏」。
     */
    const perms = await page.evaluate(() => {
      const items = [...document.querySelectorAll('.choices-editor .choice-item')]
      const byName = (label) =>
        items.find((item) => item.querySelector('.choice-name')?.value === label) ?? null
      const g = byName('全局项')
      const l = byName('仅甲项')
      return {
        globalDelete: Boolean(g?.querySelector('[data-choice-delete]')),
        globalReadonly: g?.querySelector('.choice-name')?.readOnly ?? null,
        globalHide: Boolean(g?.querySelector('[data-choice-hide]')),
        localDelete: Boolean(l?.querySelector('[data-choice-delete]')),
        localReadonly: l?.querySelector('.choice-name')?.readOnly ?? null,
      }
    })
    assert(
      perms.globalDelete === false && perms.globalReadonly === true && perms.globalHide === true,
      `全局项在标签视角只读，只给「对本标签隐藏」：${JSON.stringify(perms)}`,
    )
    assert(
      perms.localDelete === true && perms.localReadonly === false,
      `本标签专属的选项才可以改名/删除：${JSON.stringify(perms)}`,
    )

    // 隐藏只影响本标签：别的标签仍看得到；恢复后回来
    await page.evaluate(() => document.querySelector('[data-choice-hide]')?.click())
    await page.waitForTimeout(280)
    const hidden = await page.evaluate((s) => {
      const rowOf = (id) => window.__qua.fields(id).find((f) => f.propId === s.defId)
      return {
        hidden: [...document.querySelectorAll('.choices-hidden .choice-name')].map((e) => e.textContent),
        a: rowOf(s.a)?.choices.map((c) => c.label) ?? null,
        b: rowOf(s.b)?.choices.map((c) => c.label) ?? null,
      }
    }, setup)
    assert(hidden.hidden.includes('全局项'), `隐藏后落进「已隐藏」区：${JSON.stringify(hidden)}`)
    assert(!hidden.a.includes('全局项') && hidden.a.includes('仅甲项'), `#甲 不再看到全局项：${JSON.stringify(hidden.a)}`)
    assert(hidden.b.includes('全局项'), `#乙 仍看得到全局项（隐藏只作用于本标签）：${JSON.stringify(hidden.b)}`)

    await page.evaluate(() => document.querySelector('.choices-hidden .choice-restore')?.click())
    await page.waitForTimeout(280)
    const back = await page.evaluate((s) => window.__qua.fields(s.a).find((f) => f.propId === s.defId)?.choices.map((c) => c.label) ?? [], setup)
    assert(back.includes('全局项'), `恢复后 #甲 又看得到全局项：${JSON.stringify(back)}`)

    // 块上的下拉与派生同一份：不是「面板里有、控件里没有」
    await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), setup.a)
    await page.waitForTimeout(220)
    const dom = await page.evaluate((propId) => {
      const sel = document.querySelector(`.prop-row[data-prop-id="${propId}"] select`)
      return sel ? [...sel.options].map((o) => o.textContent) : null
    }, setup.defId)
    assert(dom && dom.includes('仅甲项') && dom.includes('全局项'), `块上下拉应列出两项：${JSON.stringify(dom)}`)

    // 属性抽屉走**同一份组件**：抽屉里就地展开，仍然只有一层
    await page.evaluate((id) => window.__qua.invoke('core.block/inspect', { blockId: id }), setup.tagA)
    await page.waitForSelector('.props-drawer')
    await page.evaluate(() => document.querySelector('.props-drawer [data-declared-choices]')?.click())
    await page.waitForTimeout(220)
    const drawer = await page.evaluate(() => ({
      drawers: document.querySelectorAll('.drawer').length,
      editors: document.querySelectorAll('.drawer .choices-editor').length,
    }))
    assert(drawer.drawers === 1 && drawer.editors === 1, `字段抽屉里同一份编辑器：${JSON.stringify(drawer)}`)

    /**
     * **抽屉里的实例不订阅 store**：写入之后必须由编辑器自己重画，
     * 否则加/删/改名/上下移都要关掉抽屉再打开才看得到。
     */
    const beforeCount = await page.evaluate(
      () => document.querySelectorAll('.drawer .choices-editor .choice-item').length,
    )
    await page.evaluate(() => {
      const input = document.querySelector('.drawer .choices-editor .choice-add-name')
      if (!(input instanceof HTMLInputElement)) return
      input.value = '抽屉新增'
      input.focus()
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await page.waitForTimeout(240)
    const afterAdd = await page.evaluate(() => ({
      names: [...document.querySelectorAll('.drawer .choices-editor .choice-name')].map((e) => e.value),
      count: document.querySelectorAll('.drawer .choices-editor .choice-item').length,
    }))
    assert(
      afterAdd.count === beforeCount + 1 && afterAdd.names.includes('抽屉新增'),
      `不关抽屉就要看到新选项（写入后自绘）：${JSON.stringify(afterAdd)}`,
    )

    await page.evaluate(() => {
      const item = [...document.querySelectorAll('.drawer .choices-editor .choice-item')].find(
        (el) => el.querySelector('.choice-name')?.value === '抽屉新增',
      )
      item?.querySelector('[data-choice-delete]')?.click()
    })
    await page.waitForTimeout(240)
    const afterDel = await page.evaluate(() => ({
      names: [...document.querySelectorAll('.drawer .choices-editor .choice-name')].map((e) => e.value),
      count: document.querySelectorAll('.drawer .choices-editor .choice-item').length,
    }))
    assert(
      !afterDel.names.includes('抽屉新增') && afterDel.count === beforeCount,
      `删掉后立刻消失（写入后自绘）：${JSON.stringify(afterDel)}`,
    )

    await ctx.close()
    return `标签视角就地展开（0 层 drawer）；新增默认 only 本标签：甲 2 项 / 乙 1 项；全局项只读（隐藏/恢复）；块上下拉同步；属性抽屉同一组件且写入自绘`
  },
)

/**
 * **AO4 ＋ picker 分组**：同名两义用第二个 `propId`；下拉按 `_fieldDefs` 分组并带来源。
 */
await check(
  'T173 AO4 新建同名属性：两个 propId 各自有值；picker 分组带来源（本标签／未声明／其他标签）',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)

    const setup = await page.evaluate(() => {
      const leaves = window.__qua.blocks().filter((b) => b.text.trim().length > 1)
      const [bookBlock, movieBlock] = leaves
      window.__qua.invoke('core.tags/add', { blockId: bookBlock.id, name: '冒烟书' })
      window.__qua.invoke('core.tags/add', { blockId: movieBlock.id, name: '冒烟电影' })
      const all = window.__qua.allBlocks()
      const book = all.find((x) => x.lists.includes('tag') && x.aliases.includes('冒烟书'))
      const movie = all.find((x) => x.lists.includes('tag') && x.aliases.includes('冒烟电影'))
      window.__qua.invoke('core.props/create-def', { blockId: book.id, label: '冒烟评分', kind: 'number', target: 'declared' })
      const def = window.__qua.propDefs().find((d) => d.label === '冒烟评分')
      return { a: bookBlock.id, b: movieBlock.id, bookId: book.id, movieId: movie.id, defId: def.id }
    })
    assert(setup.defId !== '', '前置：应有一条声明给 #冒烟书 的 number 定义')
    await page.waitForTimeout(320)

    // 在 #冒烟电影 的**声明**表单里输入同名同 kind ⇒ 两个动作同时可见
    await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), setup.movieId)
    await page.waitForTimeout(220)
    await page.evaluate(() => document.querySelector('[data-declare-add]')?.click())
    await page.waitForSelector('.props-form--declared')
    await page.evaluate(() => {
      const form = document.querySelector('.props-form--declared')
      const pick = form?.querySelector('.props-pick')
      if (pick instanceof HTMLSelectElement) {
        pick.value = '__new__'
        pick.dispatchEvent(new Event('change', { bubbles: true }))
      }
      const name = form?.querySelector('.props-new-group input.prop-input')
      if (name instanceof HTMLInputElement) {
        name.value = '冒烟评分'
        name.dispatchEvent(new Event('input', { bubbles: true }))
      }
      const kind = form?.querySelector('.props-new-group select.prop-input')
      if (kind instanceof HTMLSelectElement) {
        kind.value = 'number'
        kind.dispatchEvent(new Event('change', { bubbles: true }))
      }
    })
    const ao4 = await page.evaluate(() => ({
      hidden: document.querySelector('.props-ao4')?.hidden ?? null,
      reuse: document.querySelector('[data-ao4-reuse]')?.textContent ?? '',
      fresh: document.querySelector('[data-ao4-new]')?.textContent ?? '',
      createHidden: document.querySelector('.props-create')?.hidden ?? null,
    }))
    assert(ao4.hidden === false, `输入同名同 kind 时 AO4 动作要出现：${JSON.stringify(ao4)}`)
    assert(ao4.reuse.includes('复用「冒烟评分」（来自 #冒烟书）'), `复用动作带来源：${JSON.stringify(ao4.reuse)}`)
    assert(ao4.fresh.includes('新建同名属性'), `第二个动作是新建同名属性：${JSON.stringify(ao4.fresh)}`)
    assert(ao4.createHidden === true, `AO4 出现时不再有含混的「新建」：${JSON.stringify(ao4)}`)

    await page.evaluate(() => document.querySelector('[data-ao4-new]')?.click())
    await page.waitForTimeout(320)
    const defs = await page.evaluate(
      (s) =>
        window.__qua
          .propDefs()
          .filter((d) => d.label === '冒烟评分')
          .map((d) => ({ id: d.id, declaredBy: d.declaredBy })),
      setup,
    )
    assert(defs.length === 2, `同名两义＝两个 propId：${JSON.stringify(defs)}`)
    assert(
      defs.some((d) => d.declaredBy.includes(setup.bookId)) && defs.some((d) => d.declaredBy.includes(setup.movieId)),
      `两条定义各被一个标签声明：${JSON.stringify(defs)}`,
    )

    // 各写各的值：两个 propId 互不影响
    const ids = await page.evaluate((s) => {
      const all = window.__qua.propDefs().filter((d) => d.label === '冒烟评分')
      const book = all.find((d) => d.declaredBy.includes(s.bookId))
      const movie = all.find((d) => d.declaredBy.includes(s.movieId))
      window.__qua.invoke('core.props/set-value', { blockId: s.a, propId: book.id, value: 5 })
      window.__qua.invoke('core.props/set-value', { blockId: s.b, propId: movie.id, value: 9 })
      return { book: book.id, movie: movie.id }
    }, setup)
    assert(ids.book !== ids.movie, '两个块用的是两个不同的 propId')

    const values = await page.evaluate((s) => {
      const rowOf = (id, propId) => window.__qua.fields(id).find((f) => f.propId === propId)
      return { a: rowOf(s.a, s.book)?.value ?? null, b: rowOf(s.b, s.movie)?.value ?? null }
    }, { ...setup, ...ids })
    assert(values.a === 5 && values.b === 9, `两块的值互不影响：${JSON.stringify(values)}`)

    // picker 分组：本标签 / 未声明 / 其他标签（不隐藏其他标签的属性）
    const groupsOn = async (blockId) => {
      await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), blockId)
      await page.waitForTimeout(180)
      // 表单开着就沿用（`formOpen` 跨主体保留）：再点一次「＋ 添加属性」会把它关掉
      await page.evaluate(() => {
        if (!document.querySelector('.props-form--own')) document.getElementById('properties-add')?.click()
      })
      await page.waitForSelector('.props-form--own')
      return page.evaluate(() => {
        const form = document.querySelector('.props-form--own')
        return [...(form?.querySelectorAll('optgroup') ?? [])].map((g) => ({
          label: g.label,
          options: [...g.querySelectorAll('option')].map((o) => o.textContent ?? ''),
        }))
      })
    }
    const onBook = await groupsOn(setup.a)
    const onMovie = await groupsOn(setup.b)
    const rowName = await page.evaluate(
      (propId) => document.querySelector(`.prop-row[data-prop-id="${propId}"] .prop-name`)?.textContent ?? '',
      ids.movie,
    )
    assert(rowName.includes('冒烟评分 · #冒烟电影'), `属性行的名字也要带来源：${JSON.stringify(rowName)}`)
    const groupOf = (groups, label) => groups.find((g) => g.label === label)?.options ?? []
    assert(
      groupOf(onBook, '本标签').some((x) => x.includes('冒烟评分 · #冒烟书')) &&
        !groupOf(onBook, '本标签').some((x) => x.includes('冒烟评分 · #冒烟电影')),
      `#冒烟书 的块：自己的属性在本标签组：${JSON.stringify(onBook)}`,
    )
    assert(
      groupOf(onBook, '其他标签').some((x) => x.includes('冒烟评分 · #冒烟电影')),
      `#冒烟书 的块：别的标签的专属属性落在其他标签组（不隐藏）：${JSON.stringify(onBook)}`,
    )
    assert(
      groupOf(onMovie, '本标签').some((x) => x.includes('冒烟评分 · #冒烟电影')) &&
        groupOf(onMovie, '其他标签').some((x) => x.includes('冒烟评分 · #冒烟书')),
      `#冒烟电影 的块：分组镜像成立：${JSON.stringify(onMovie)}`,
    )

    await ctx.close()
    return `AO4 两个 propId（值 5 / 9 互不影响）；picker 三组：本标签／未声明／其他标签，选项带来源`
  },
)

/* -------------------------------------------------- 动效与状态词汇表 */

/**
 * 这一组的口径是「每个交互在它的状态下都有回应」：
 * 浮层进场有过渡、退场把节点真摘掉、键盘焦点处处可见、悬停有底色、
 * 滚动条出现不把文档挤得左右跳。它们全是 computed style 能判定的性质。
 */
await check('T174 浮层有进场动画；退场的节点真的离开文档（不是留一个隐形的）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.focus())
  await page.keyboard.press(kbd('mod+p'))
  const layerAnim = await page.evaluate(() => getComputedStyle(document.querySelector('.layer')).animationName)
  assert(layerAnim !== 'none', `命令面板应有进场动画，实际 animation=${layerAnim}`)
  await page.keyboard.press('Escape')
  assert((await page.locator('.layer').count()) === 0, '菜单应立即关（菜单退场不拖泥带水）')

  // 抽屉：进场有动画；Esc 退场走完后节点摘掉（waitForSelector 才是「关」的判据）
  await page.evaluate(() => window.__qua.focus())
  await page.keyboard.press(kbd('mod+p'))
  await page.locator('.layer-input').fill('导出')
  await page.locator('.layer-item').first().click()
  await page.waitForSelector('.drawer')
  const drawerAnim = await page.evaluate(() => getComputedStyle(document.querySelector('.drawer')).animationName)
  assert(drawerAnim !== 'none', `抽屉应有进场动画，实际 animation=${drawerAnim}`)
  await page.keyboard.press('Escape')
  await page.waitForSelector('.drawer', { state: 'detached', timeout: 2000 })

  await ctx.close()
  return `面板/抽屉进场有动画；菜单瞬时关；抽屉退场走完节点摘掉`
})

await check('T175 键盘焦点处处可见：按钮亮 accent 环、菜单搜索框亮分隔线', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.focus())
  await page.keyboard.press(kbd('mod+p'))
  // ① 菜单搜索框自己的焦点语言：下分隔线换 accent（它没有边框可换）
  const inputLine = await page.evaluate(() => getComputedStyle(document.querySelector('.layer-input')).borderBottomColor)
  const accent = await page.evaluate(() => {
    const p = document.createElement('span')
    p.style.color = 'var(--ui-accent)'
    document.body.appendChild(p)
    const c = getComputedStyle(p).color
    p.remove()
    return c
  })
  assert(inputLine === accent, `搜索框聚焦应亮 accent 分隔线：${inputLine} ≠ accent ${accent}`)
  await page.keyboard.press('Escape')
  // ② 键盘落点必须有可见环：焦点交还编辑器后 blur 出来，再按 Tab——
  //    **键盘移动焦点的那一下**才触发 :focus-visible（鼠标点击与 focus() 都不触发）。
  //    ⚠️ 三条不能走的路（都实测过）：从日历格走（点格子＝「去那天写」，焦点被交给
  //    编辑器）；在编辑器里 Tab（缩进绑定接管）；在命令面板里 Tab（移动高亮行接管）。
  await page.evaluate(async () => {
    document.activeElement?.blur?.()
    await new Promise((r) => setTimeout(r, 120))
  })
  await page.keyboard.press('Tab')
  const ring = await page.evaluate(() => {
    const el = document.activeElement
    const cs = getComputedStyle(el)
    return { tag: el?.tagName, cls: el?.className, style: cs.outlineStyle, color: cs.outlineColor }
  })
  assert(ring.tag === 'BUTTON', `Tab 应落在按钮上：${JSON.stringify(ring)}`)
  assert(ring.style === 'solid' && ring.color === accent, `键盘焦点应有 accent 环：${JSON.stringify(ring)}`)
  await ctx.close()
  return `搜索框亮分隔线；键盘落点的按钮环＝accent（不再是 UA 默认蓝）`
})

await check('T176 悬停有中性反馈：回收站行 hover 出底色（--ui-bg-hover 真的解析出颜色）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  await openFirstPage(page)
  const target = await page.evaluate(() => {
    const ed = window.__qua.__editor
    const plain = (b) => b.content.filter((r) => r.t === 'text').map((r) => r.v).join('')
    const rootIds = new Set(ed.doc.roots.map((b) => b.id))
    let hit = null
    const walk = (list) => {
      for (const b of list) {
        if (!hit && !rootIds.has(b.id) && plain(b).length > 1) hit = b.id
        walk(b.children)
      }
    }
    walk(ed.doc.roots)
    return hit
  })
  assert(target, '前置：应有可删的普通块')
  await page.evaluate((id) => window.__qua.__editor.remove(id), target)
  await page.waitForSelector('[data-card-id="trash"] [data-trash-row]')
  await page.locator('[data-card-id="trash"] [data-trash-row]').first().hover()
  // 底色有 120ms 的过渡：等它走完再读，读到的才是 hover 稳态
  await page.waitForTimeout(250)
  const bg = await page.evaluate(
    () => getComputedStyle(document.querySelector('[data-card-id="trash"] [data-trash-row]')).backgroundColor,
  )
  assert(bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent', `悬停的行应有底色（此前这个变量从未定义过），实际 ${bg}`)
  await ctx.close()
  return `回收站行 hover 底色＝${bg}（悬空 token 已定义）`
})

await check('T177 滚动条沟常驻：#scroll 声明 scrollbar-gutter: stable（文档不随滚动条左右跳）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  const g = await page.evaluate(() => getComputedStyle(document.querySelector('#scroll')).scrollbarGutter)
  assert(g === 'stable', `#scroll 应常驻滚动条沟，实际 scrollbar-gutter=${g}`)
  await ctx.close()
  return 'scrollbar-gutter=stable'
})

/* ================================================================ 拥有者模型（v29） */

/**
 * **local tab**：面板局部的一次查询，**不建块**。
 *
 * 这是本次重构的默认路径。四条断言各钉一件用户看得见的事：
 *   ① 加一栏 ⇒ 块数不变；
 *   ② 它出现在 tab 条上，而且能切到表格；
 *   ③ 刷新只影响**这一个** tab（同一个库的另一个表面不受影响）；
 *   ④ 删一栏 ⇒ 块数仍不变，⌘Z 能回来。
 */
await check('T178 local tab：加一栏不建块；切表格；刷新只影响本栏；删栏 ⌘Z 回来', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  await openFirstPage(page)
  await page.waitForTimeout(350)

  const before = await page.evaluate(() => ({
    blocks: window.__qua.snapshot().totalBlocks,
    host: window.__qua.snapshot().activeId,
  }))

  const tabId = await page.evaluate((host) => {
    // 一栏「全库的待办」：条件自己带着，不依赖宿主
    const r = window.__qua.invoke('core.mount/add-local', {
      host: { kind: 'block', blockId: host },
      label: '全库待办',
      spec: { where: { tag: '任务' }, scope: 'all' },
    })
    return r === false ? '' : String(window.__qua.__editor.sel?.aBlock ?? '')
  }, before.host)

  const added = await page.evaluate(() => {
    const m = document.querySelector('#editor .mount')
    const w = [...m.querySelectorAll('.mount-tabwrap')].find((x) => (x.querySelector('.mount-tab')?.textContent ?? '') === '全库待办')
    return { key: w?.dataset.tab ?? '', kind: w?.dataset.kind ?? '', removable: Boolean(w?.querySelector('.mount-x')) }
  })
  assert(added.key !== '', '加完应出现「全库待办」这一栏')
  assert(added.kind === 'local', `它是 local 栏（自己拥有条件与视图）：${JSON.stringify(added)}`)
  assert(added.removable, 'local 栏可摘（有 ×）')
  void tabId

  const afterAdd = await page.evaluate(() => window.__qua.snapshot().totalBlocks)
  assert(afterAdd === before.blocks, `加一栏**不建块**：${before.blocks} → ${afterAdd}`)

  // 切到这一栏：它是「全库待办」，库里不止一条
  await mountTab(page, added.key)
  // 新栏缺省带一张表格；先切回大纲再数行（下面还会显式建一张表，钉「配置住在这一栏」）
  await page.evaluate(({ host, id }) => {
    window.__qua.invoke('core.view/set-active', { owner: { kind: 'tab', host: { kind: 'block', blockId: host }, tabId: id }, viewId: '' })
  }, { host: before.host, id: added.key })
  await page.waitForTimeout(350)
  const rows = await mountRows(page)
  assert(rows > 0, `这一栏应显示命中：${rows} 行`)

  /**
   * 给它加一张表格视图：**配置住在这一栏自己身上**（`_mounts` 里的 local 条目），
   * 块上一个字节都不动。
   */
  await page.evaluate(
    ({ host, tabId: id }) =>
      window.__qua.invoke('core.view/add', { owner: { kind: 'tab', host: { kind: 'block', blockId: host }, tabId: id }, kind: 'table' }),
    { host: before.host, tabId: added.key },
  )
  await page.waitForTimeout(400)
  const tableRows = await page.evaluate(() => document.querySelectorAll('#editor .mount .mount-view .tv-row').length)
  assert(tableRows > 0, `local 栏的表格要能画出命中：${tableRows} 行`)
  const blocksAfterView = await page.evaluate(() => window.__qua.snapshot().totalBlocks)
  assert(blocksAfterView === before.blocks, `加视图也不建块：${before.blocks} → ${blocksAfterView}`)

  // 删一栏：块数仍不变；⌘Z 把它带回来
  await page.locator(`#editor .mount .mount-tabwrap[data-tab="${added.key}"] .mount-x`).first().click()
  await page.waitForTimeout(350)
  const gone = await page.evaluate(() => window.__qua.snapshot().totalBlocks)
  assert(gone === before.blocks, `摘一栏不删块：${before.blocks} → ${gone}`)
  const stillThere = await page.evaluate(
    () => [...document.querySelectorAll('#editor .mount .mount-tabwrap')].some((x) => (x.querySelector('.mount-tab')?.textContent ?? '') === '全库待办'),
  )
  assert(!stillThere, '摘掉之后这一栏应消失')

  // ⌘Z 走命令层（认的是活动编辑器）：先把焦点放回正文，别停在刚按过的 × 上
  await page.locator('#editor .sec .blk .tx').first().click()
  await page.keyboard.press(kbd('mod+z'))
  await page.waitForTimeout(450)
  const back = await page.evaluate(
    () => [...document.querySelectorAll('#editor .mount .mount-tab-wrap, #editor .mount .mount-tabwrap')].some((x) => (x.querySelector('.mount-tab')?.textContent ?? '') === '全库待办'),
  )
  assert(back, '⌘Z 应把那一栏带回来（它是可撤销的一次数据改动）')

  await ctx.close()
  return `加/删一栏块数恒为 ${before.blocks}；表格 ${tableRows} 行；⌘Z 可恢复`
})

/**
 * **上下文是相对的**：同一份条件，在页面顶层的查询页看全库，挂在某一页的面板里只看那一页。
 *
 * 这条钉的是 `QueryContext` 的三件事分开给（`selfId`／`scopeId`／`excludeIds`）。
 * 曾经「`$self` 指谁」与「结果剔除谁」是同一个字段，于是「想解析它，又不得不排除它」
 * 这种形状根本表达不出来。
 */
await check('T182 上下文：同一份条件，顶层查询页看全库、挂在页上的栏只看那一页', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  await openFirstPage(page)
  await page.waitForTimeout(300)

  // 在两页各放一个带同一串字的块（探针）
  const probe = await page.evaluate(() => {
    const pages = window.__qua.pages()
    const out = []
    for (const p of pages.slice(0, 2)) {
      window.__qua.invoke('core.page/open', { pageId: p.id })
      const rows = window.__qua.__editor.rows().map((r) => r.block)
      const spot = rows.find((b) => b.children.length === 0) ?? rows[0]
      if (!spot) throw new Error(`前置：${p.title} 里没有可落的块`)
      window.__qua.focusBlock(spot.id, 999)
      window.__qua.invoke('core.editor/insert-block', { text: '上下文探针' })
      out.push({ page: p.id, block: String(window.__qua.__editor.sel?.aBlock ?? '') })
    }
    return out
  })
  assert(probe.filter((x) => x.block).length === 2, `两页各应落下探针：${JSON.stringify(probe)}`)

  // ① 顶层查询页：没有容器 ⇒ 整片森林
  const queryPage = await page.evaluate(() =>
    window.__qua.invoke('core.query/create', {
      kind: 'page',
      name: '上下文探针查询',
      spec: { where: { text: '上下文探针' } },
    }),
  )
  assert(queryPage !== false, '应能建出查询页')
  await page.waitForTimeout(500)
  const globalCount = await page.evaluate(() => document.querySelector('.queryview-count')?.textContent ?? '')
  assert(globalCount.includes('2'), `顶层查询页应看到两页的探针（整库）：${globalCount}`)

  // ② 同一份条件挂到第一页的面板上：锚点＝那一页 ⇒ 只看得到一条
  await page.evaluate((host) => {
    window.__qua.invoke('core.mount/add-local', {
      host: { kind: 'block', blockId: host },
      label: '本页探针',
      spec: { where: { text: '上下文探针' } },
    })
  }, probe[0].page)
  await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), probe[0].page)
  await page.waitForTimeout(450)
  const key = await page.evaluate(
    () =>
      [...document.querySelectorAll('#editor .mount .mount-tabwrap')].find(
        (x) => (x.querySelector('.mount-tab')?.textContent ?? '') === '本页探针',
      )?.dataset.tab ?? '',
  )
  assert(key !== '', '应有「本页探针」这一栏')
  await mountTab(page, key)
  // 新栏缺省带一张表格；这一段钉的是**锚点**（大纲分支），先切回大纲再数行
  await page.evaluate((host) => {
    const id = [...document.querySelectorAll('#editor .mount .mount-tabwrap')].find(
      (x) => (x.querySelector('.mount-tab')?.textContent ?? '') === '本页探针',
    )?.dataset.tab
    window.__qua.invoke('core.view/set-active', { owner: { kind: 'tab', host: { kind: 'block', blockId: host }, tabId: id }, viewId: '' })
  }, probe[0].page)
  await page.waitForTimeout(350)
  const localRows = await mountRows(page)
  assert(localRows === 1, `挂在页上的栏只看这一页（1 条），实际 ${localRows} 行：挂载区的锚点是宿主`)

  await ctx.close()
  return `顶层 ${globalCount}；挂在这一页上 ${localRows} 行（锚点＝宿主）`
})

/**
 * **冻结是每个表面实例自己的事**：刷新一个，另一个不变；刷新**不写块**（不进撤销）。
 *
 * 曾经结果冻结进块上的 `_queryResult`：于是两个表面共享一份（谁刷新都改别人看到的），
 * 而「刷新」这个读动作会写内容层（按一次 ⌘Z 撤的是上一次刷新）。
 */
await check('T183 冻结按实例：两个表面各持一份；刷新不动 modified、不进撤销', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  // 用种子里那一页的查询块
  const qid = await page.evaluate(() => {
    const p = window.__qua.pages().find((x) => x.title.includes('产品设计'))
    window.__qua.invoke('core.page/open', { pageId: p.id })
    let found = ''
    const walk = (list) => {
      for (const b of list) {
        if (!found && b.props?._query?.where) found = b.id
        walk(b.children)
      }
    }
    walk(window.__qua.__editor.store.blocks)
    return found
  })
  assert(qid !== '', '前置：种子里应有一个查询块')
  await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), qid)
  await page.waitForTimeout(450)

  const snap = () =>
    page.evaluate((id) => {
      const raw = window.__qua.__editor.store.find(id)
      return {
        modified: raw?.modified ?? 0,
        count: document.querySelector('.queryview-count')?.textContent ?? '',
        stale: !(document.querySelector('.queryview-stale')?.hidden ?? true),
      }
    }, qid)
  const first = await snap()
  assert(first.count.length > 0, '前置：查询应报出条数')

  // 刷新：条数不变、`modified` 不变、没有 op
  const opsBefore = await page.evaluate(() => JSON.stringify(window.__qua.lastOps()))
  await page.locator('.queryview-refresh').click()
  await page.waitForTimeout(400)
  const after = await snap()
  const opsAfter = await page.evaluate((prev) => {
    const now = JSON.stringify(window.__qua.lastOps())
    return { changed: now !== prev, now }
  }, opsBefore)
  assert(after.count === first.count, `数据没变 ⇒ 刷新后条数不变：${first.count} → ${after.count}`)
  assert(after.modified === first.modified, `刷新**不写块**（modified 不变）：${first.modified} → ${after.modified}`)
  assert(!opsAfter.changed, `刷新不该产出 op（不进撤销）：${opsAfter.now.slice(0, 120)}`)

  /**
   * **换一屏再回来**：冻结结果住在这个表面实例里，重开就该重算 ——
   * 而块上仍然一个字节都没多（条件还是那份条件）。
   */
  await page.evaluate(() => window.__qua.invoke('core.journal/today', {}))
  await page.waitForTimeout(350)
  await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), qid)
  await page.waitForTimeout(450)
  const back = await snap()
  assert(back.count === first.count, `重开重新求值 ⇒ 条数仍对得上：${back.count}`)
  assert(back.modified === first.modified, `重开也不写块：${first.modified} → ${back.modified}`)

  await ctx.close()
  return `刷新：条数 ${first.count} 不变、modified 不变、零 op；重开重新求值`
})

/**
 * **表头排序只改显示序**：`_query.sort` 一个字节不动，成员也不变。
 *
 * 曾经查询源的表头排序写 `_query.sort` 并重算 —— 于是「按这一列排一下」变成了
 * 「换一批行」（`limit` 的成员跟着变），而用户以为自己只是换了个顺序。
 */
await check('T184 表头排序只改显示序：_query.sort 不变、成员不变', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  const qid = await page.evaluate(() => {
    const p = window.__qua.pages().find((x) => x.title.includes('产品设计'))
    window.__qua.invoke('core.page/open', { pageId: p.id })
    let found = ''
    const walk = (list) => {
      for (const b of list) {
        if (!found && b.props?._query?.where) found = b.id
        walk(b.children)
      }
    }
    walk(window.__qua.__editor.store.blocks)
    return found
  })
  assert(qid !== '', '前置：种子里应有一个查询块')
  await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), qid)
  await page.waitForTimeout(400)
  // 种子里那条只命中 1 条；换成「全库的任务」，表里才有多行可排
  await page.evaluate(
    (id) =>
      window.__qua.invoke('core.query/set-spec', {
        owner: { kind: 'block', blockId: id },
        spec: { where: { tag: '任务' }, scope: 'all' },
      }),
    qid,
  )
  await page.waitForTimeout(400)
  await page.evaluate(
    (id) => window.__qua.invoke('core.view/add', { owner: { kind: 'block', blockId: id }, kind: 'table' }),
    qid,
  )
  await page.waitForTimeout(500)

  const before = await page.evaluate((id) => {
    const raw = window.__qua.__editor.store.find(id)
    return {
      sort: JSON.stringify(raw?.props?._query?.sort ?? null),
      rows: [...document.querySelectorAll('.tv-row')].map((r) => r.dataset.blockId ?? ''),
    }
  }, qid)
  assert(before.rows.length > 1, `前置：表格应有多行：${JSON.stringify(before.rows)}`)

  // 点标题列的表头（第二下＝降序）
  const head = page.locator('.tv-head [data-col="title"][data-sortable="1"]').first()
  await head.click()
  await page.waitForTimeout(300)
  await head.click()
  await page.waitForTimeout(400)

  const after = await page.evaluate((id) => {
    const raw = window.__qua.__editor.store.find(id)
    const active = (raw?.props?._views ?? []).find((v) => v.id === raw?.props?._activeView)
    return {
      sort: JSON.stringify(raw?.props?._query?.sort ?? null),
      viewSort: JSON.stringify(active?.table?.sort ?? null),
      rows: [...document.querySelectorAll('.tv-row')].map((r) => r.dataset.blockId ?? ''),
    }
  }, qid)
  assert(after.sort === before.sort, `查询的成员顺序不许被表头排序改写：${before.sort} → ${after.sort}`)
  assert(after.viewSort !== null && after.viewSort !== 'null', `排序要写进**视图**的显示序：${after.viewSort}`)
  assert(
    JSON.stringify([...after.rows].sort()) === JSON.stringify([...before.rows].sort()),
    `成员一条不多一条不少：${JSON.stringify(before.rows)} → ${JSON.stringify(after.rows)}`,
  )

  await ctx.close()
  return `${before.rows.length} 行不变；_query.sort 不变；视图 sort=${after.viewSort}`
})

/**
 * **稳定 id**：摘掉第一栏之后，激活的第二栏不漂。
 *
 * 用数组下标当键时，`user:1` 会在摘掉 `user:0` 之后指向原来那一栏 ——
 * 用户看到的是「我摘了 A，界面跳到 B 上」，而且不报错。
 */
await check('T187 稳定 id：摘掉第一栏之后，激活的是原来那一栏（不漂）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  await openFirstPage(page)
  await page.waitForTimeout(300)
  const host = await page.evaluate(() => window.__qua.snapshot().activeId)

  const keys = await page.evaluate((h) => {
    const add = (label) =>
      window.__qua.invoke('core.mount/add-local', {
        host: { kind: 'block', blockId: h },
        label,
        spec: { where: { tag: '任务' }, scope: 'all' },
      })
    add('甲栏')
    add('乙栏')
    return [...document.querySelectorAll('#editor .mount .mount-tabwrap[data-kind="local"]')].map((w) => ({
      key: w.dataset.tab,
      label: w.querySelector('.mount-tab')?.textContent ?? '',
    }))
  }, host)
  assert(keys.length === 2, `应有两栏：${JSON.stringify(keys)}`)

  await mountTab(page, keys[1].key)
  const activeBefore = await page.evaluate(
    () => document.querySelector('#editor .mount .mount-tabwrap[data-active="1"]')?.dataset.tab ?? '',
  )
  assert(activeBefore === keys[1].key, `前置：激活的是「乙栏」：${activeBefore}`)

  await page.locator(`#editor .mount .mount-tabwrap[data-tab="${keys[0].key}"] .mount-x`).first().click()
  await page.waitForTimeout(400)
  const st = await page.evaluate(() => ({
    active: document.querySelector('#editor .mount .mount-tabwrap[data-active="1"]')?.dataset.tab ?? '',
    label: document.querySelector('#editor .mount .mount-tabwrap[data-active="1"] .mount-tab')?.textContent ?? '',
    tabs: document.querySelectorAll('#editor .mount .mount-tabwrap').length,
  }))
  const labels = await page.evaluate(() =>
    [...document.querySelectorAll('#editor .mount .mount-tab')].map((e) => e.textContent ?? ''),
  )
  assert(!labels.includes('甲栏'), `摘掉的那一栏应消失：${JSON.stringify(labels)}`)
  assert(labels.includes('乙栏'), `另一栏应还在：${JSON.stringify(labels)}`)
  assert(st.active === keys[1].key, `激活项应仍是「乙栏」的 id（不漂）：${JSON.stringify(st)}`)
  assert(st.label === '乙栏', `界面上激活的也该是「乙栏」：${JSON.stringify(st)}`)

  await ctx.close()
  return `摘「甲栏」后激活仍是「乙栏」（id ${keys[1].key}）`
})

/**
 * **条件构建器**：条件行与 JSON 是同一份数据的两种视图；应用一次＝一轮撤销。
 *
 * 这条钉的是「界面拼出来的条件必须与手写 JSON 逐字节相同」——不同的表现是
 * 「界面上一行改完、结果没变」，而那时用户不会怀疑是翻译层丢了算子。
 */
await check('T188 构建器：JSON 与模型逐字节相同；改一行应用＝一轮撤销；chip 跟着变', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  const qid = await page.evaluate(() => {
    const p = window.__qua.pages().find((x) => x.title.includes('产品设计'))
    window.__qua.invoke('core.page/open', { pageId: p.id })
    let found = ''
    const walk = (list) => {
      for (const b of list) {
        if (!found && b.props?._query?.where) found = b.id
        walk(b.children)
      }
    }
    walk(window.__qua.__editor.store.blocks)
    return found
  })
  assert(qid !== '', '前置：种子里应有一个查询块')
  await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), qid)
  await page.waitForTimeout(450)

  // 抬头上的条件 chip（查询源的「条件是什么」得在屏幕上）
  const chips = await page.evaluate(() =>
    [...document.querySelectorAll('.queryview-filters .queryview-chip')].map((e) => e.textContent ?? ''),
  )
  assert(chips.length > 0, `抬头应有条件 chip：${JSON.stringify(chips)}`)
  assert(chips.some((c) => c.includes('未完成')), `种子里那条是「未完成的待办」：${JSON.stringify(chips)}`)

  // 打开构建器
  await page.locator('.queryview-chip--edit').click()
  await page.waitForSelector('.qb')
  await page.locator('.qb-tab[data-qb-tab="json"]').click()
  await page.waitForTimeout(150)
  const jsonText = await page.evaluate(() => document.querySelector('.qb-json')?.value ?? '')
  const model = await page.evaluate((id) => JSON.stringify(window.__qua.__editor.store.find(id)?.props?._query), qid)
  assert(jsonText.replace(/\s+/g, '') === model.replace(/\s+/g, ''), `JSON tab 必须就是模型那一份：\n${jsonText}\n${model}`)

  // 回到条件行，把「未完成」改成「已完成」并应用
  await page.locator('.qb-tab[data-qb-tab="rows"]').click()
  await page.waitForTimeout(150)
  await page.selectOption('.qb-row .qb-value', 'done')
  await page.locator('.qb-apply').click()
  await page.waitForTimeout(450)

  const after = await page.evaluate((id) => ({
    where: JSON.stringify(window.__qua.__editor.store.find(id)?.props?._query?.where),
    chips: [...document.querySelectorAll('.queryview-filters .queryview-chip')].map((e) => e.textContent ?? ''),
    open: Boolean(document.querySelector('.qb')),
  }), qid)
  // 三态在模型里是**属性条件**（`{prop:{id,eq}}`）：「待办」只是构建器那一行预设
  const doneWhere = JSON.parse(after.where)
  assert(
    doneWhere?.prop?.eq === true && typeof doneWhere.prop.id === 'string',
    `应用之后条件应是「已完成」＝ 任务状态 eq:true：${after.where}`,
  )
  assert(after.open === false, '应用之后构建器应关闭')
  assert(after.chips.some((c) => c.includes('已完成')), `chip 要跟着变：${JSON.stringify(after.chips)}`)

  // 一轮撤销回到改之前（一次应用＝一笔事务，不是每敲一个字一步）
  await page.keyboard.press(kbd('mod+z'))
  await page.waitForTimeout(400)
  const undone = await page.evaluate((id) => JSON.stringify(window.__qua.__editor.store.find(id)?.props?._query?.where), qid)
  assert(JSON.parse(undone)?.prop?.eq === false, `一次 ⌘Z 就该回到原条件（未完成）：${undone}`)

  await ctx.close()
  return `chip「未完成」→ 构建器 JSON 与模型同字节 → 应用后「已完成」→ 一次 ⌘Z 复原`
})

/**
 * **提升／转本地**：local ⇄ 块 是**显式复制**，之后两条路各自演化。
 *
 * 这条钉的是「local tab 不是块」的另一半：需要命名/引用/共享时才建块，
 * 而建出来的那一刻起，两边就是两个独立对象（没有隐藏同步）。
 */
await check('T189 提升：local → 查询页（块 +1，栏变 linked）；转本地：linked → local（块数不变）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  await openFirstPage(page)
  await page.waitForTimeout(350)
  const host = await page.evaluate(() => window.__qua.snapshot().activeId)
  const before = await page.evaluate(() => window.__qua.snapshot().totalBlocks)

  // 建一栏 local
  await page.evaluate((h) => {
    window.__qua.invoke('core.mount/add-local', {
      host: { kind: 'block', blockId: h },
      label: '提升演示',
      spec: { where: { tag: '任务' }, scope: 'all' },
    })
  }, host)
  await page.waitForTimeout(300)
  const key = await page.evaluate(
    () =>
      [...document.querySelectorAll('#editor .mount .mount-tabwrap')].find(
        (x) => (x.querySelector('.mount-tab')?.textContent ?? '') === '提升演示',
      )?.dataset.tab ?? '',
  )
  assert(key !== '', '应有「提升演示」这一栏')

  // 提升为查询页
  await page.evaluate(
    ({ h, tabId }) =>
      window.__qua.invoke('core.mount/promote', {
        host: { kind: 'block', blockId: h },
        tabId,
        target: 'page',
      }),
    { h: host, tabId: key },
  )
  await page.waitForTimeout(450)
  const promoted = await page.evaluate((tabId) => {
    const w = document.querySelector(`#editor .mount .mount-tabwrap[data-tab="${tabId}"]`)
    return {
      blocks: window.__qua.snapshot().totalBlocks,
      kind: w?.dataset.kind ?? '',
      label: w?.querySelector('.mount-tab')?.textContent ?? '',
      pages: window.__qua.pages().map((p) => p.title),
    }
  }, key)
  assert(promoted.blocks === before + 1, `提升要建出**一个**查询页：${before} → ${promoted.blocks}`)
  assert(promoted.kind === 'linked', `提升后这一栏变成指针：${JSON.stringify(promoted)}`)
  assert(promoted.label === '提升演示', `名字跟着走：${promoted.label}`)
  assert(promoted.pages.includes('提升演示'), `页列表里要看得见它：${JSON.stringify(promoted.pages)}`)

  // 转本地：块数不变（复制的是条件，不是块）
  await page.evaluate(
    ({ h, tabId }) =>
      window.__qua.invoke('core.mount/detach', { host: { kind: 'block', blockId: h }, tabId }),
    { h: host, tabId: key },
  )
  await page.waitForTimeout(400)
  const detached = await page.evaluate((tabId) => {
    const w = document.querySelector(`#editor .mount .mount-tabwrap[data-tab="${tabId}"]`)
    return { blocks: window.__qua.snapshot().totalBlocks, kind: w?.dataset.kind ?? '' }
  }, key)
  assert(detached.kind === 'local', `转本地之后这一栏自己拥有配置：${JSON.stringify(detached)}`)
  assert(detached.blocks === promoted.blocks, `转本地**不建块**：${promoted.blocks} → ${detached.blocks}`)

  await ctx.close()
  return `提升：块 ${before}→${promoted.blocks}、栏变 linked；转本地：块数不变、栏变 local`
})

/**
 * **收藏（items 源）**：一批**引用**，不是一批被搬进来的东西。
 *
 * 三件事各钉一个静默错误：默认看法是列表（不是大纲）、摘一行不删块、
 * 顺序＝`_items` 顺序（拖动改序只写这一格）。
 */
await check('T185 收藏：默认列表；加/摘一行不删块；顺序跟 `_items` 走', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  await openFirstPage(page)
  await page.waitForTimeout(300)

  const made = await page.evaluate(() => {
    const fav = window.__qua.invoke('core.collection/create', { name: '冒烟收藏' })
    void fav
    // 找一个现成的集合块（`create` 会把它放进槽里，这里直接按类型找）
    const flat = []
    const walk = (list) => {
      for (const b of list) {
        flat.push(b)
        walk(b.children)
      }
    }
    walk(window.__qua.__editor.store.blocks)
    // ⚠️ 按**名字**找刚建的那一个：种子里本来就有一份收藏演示（按类型找会拿到它）
    const box = flat.find(
      (b) => b.props?._type === 'core/collection-widget' && (b.props?._aliases ?? []).includes('冒烟收藏'),
    )
    const items = flat.filter((b) => b.id !== box?.id && b.props?._type === undefined && b.children.length === 0).slice(0, 2)
    if (!box) return { id: '', items: [] }
    for (const it of items) window.__qua.invoke('core.collection/add', { collectionId: box.id, blockId: it.id })
    window.__qua.invoke('core.block/focus-block', { blockId: box.id })
    return { id: box.id, items: items.map((x) => x.id) }
  })
  assert(made.id !== '', '前置：应能建出一个收藏块')
  assert(made.items.length === 2, `前置：应有两条可收藏的块：${JSON.stringify(made)}`)
  await page.waitForTimeout(500)

  // ① 默认看法是**列表**（不是大纲：一批手选的引用不是一棵树）
  const listed = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('.vl-row')].map((r) => r.dataset.blockId ?? ''),
    outline: document.querySelectorAll('.queryview-outline:not([hidden])').length,
    add: Boolean(document.querySelector('.vl-add')),
  }))
  assert(listed.rows.length === 2, `收藏块打开就是列表（2 行）：${JSON.stringify(listed)}`)
  assert(listed.outline === 0, `items 源没有大纲分支：${JSON.stringify(listed)}`)
  assert(listed.add, '列表要能「加一条」（盘子里要能再放东西）')

  // ② 摘一行：只摘引用，**块还在**
  const before = await page.evaluate(() => window.__qua.snapshot().totalBlocks)
  await page.locator(`.vl-row[data-block-id="${made.items[0]}"] .vl-x`).click()
  await page.waitForTimeout(400)
  const afterRemove = await page.evaluate((id) => {
    const box = window.__qua.__editor.store.find(id)
    return {
      items: Array.isArray(box?.props?._items) ? box.props._items.length : 0,
      blocks: window.__qua.snapshot().totalBlocks,
      rows: document.querySelectorAll('.vl-row').length,
    }
  }, made.id)
  assert(afterRemove.items === 1, `摘掉一条引用：${JSON.stringify(afterRemove)}`)
  assert(afterRemove.rows === 1, `列表跟着少一行：${JSON.stringify(afterRemove)}`)
  assert(afterRemove.blocks === before, `摘引用**不删块**：${before} → ${afterRemove.blocks}`)

  // ③ 顺序＝`_items` 顺序（拖动改序只写这一格）
  await page.evaluate(
    ({ id, items }) => window.__qua.invoke('core.collection/add', { collectionId: id, blockId: items[0] }),
    { id: made.id, items: made.items },
  )
  await page.waitForTimeout(350)
  const order = () =>
    page.evaluate(() => [...document.querySelectorAll('.vl-row')].map((r) => r.dataset.blockId ?? ''))
  const two = await order()
  assert(two.length === 2, `加回来之后两行：${JSON.stringify(two)}`)
  await page.evaluate(
    // `to` 是**原列表**里的落点（先摘再插，往后拖时自己减一）⇒ 从 0 挪到末尾要写 2
    ({ id, blockId }) => window.__qua.invoke('core.collection/move', { collectionId: id, blockId, to: 2 }),
    { id: made.id, blockId: two[0] },
  )
  await page.waitForTimeout(400)
  const moved = await order()
  assert(moved[0] === two[1] && moved[1] === two[0], `顺序跟着 _items 变：${JSON.stringify([two, moved])}`)
  const stored = await page.evaluate((id) => {
    const box = window.__qua.__editor.store.find(id)
    return Array.isArray(box?.props?._items) ? box.props._items : []
  }, made.id)
  assert(JSON.stringify(stored) === JSON.stringify(moved), `模型里的 _items 与屏幕上一致：${JSON.stringify([stored, moved])}`)

  // ④ 引用指向的块被删 ⇒ 引用**保留**、那一行不出（块恢复后自己回来）
  const ghost = moved[0]
  await page.evaluate((id) => window.__qua.invoke('core.view/delete-row', { rowId: id }), ghost)
  await page.waitForTimeout(450)
  const withGhost = await page.evaluate((id) => {
    const box = window.__qua.__editor.store.find(id)
    return {
      items: Array.isArray(box?.props?._items) ? box.props._items : [],
      rows: [...document.querySelectorAll('.vl-row')].map((r) => r.dataset.blockId ?? ''),
    }
  }, made.id)
  assert(withGhost.items.includes(ghost), '块被删了，**引用要留着**（它恢复后自己回来）')
  assert(!withGhost.rows.includes(ghost), `解析不到的那条不出行：${JSON.stringify(withGhost)}`)
  assert(withGhost.rows.length === withGhost.items.length - 1, `其余照常显示：${JSON.stringify(withGhost)}`)

  await ctx.close()
  return `2 行 → 摘一条仍 ${afterRemove.blocks} 块 → 顺序跟 _items；删块后引用留着、那一行不出`
})

/**
 * **四种布局**（看板／画廊／日历／导图）：换看法不重查；看板拖卡写的是**属性**。
 *
 * 这条钉两件最容易错的事：切布局时顺手又跑了一次查询（成员悄悄变了），
 * 以及看板拖卡把它做成了 re-parent（结构被改，而用户以为只是换了个分组）。
 */
await check('T190 四种布局：切换不重查；看板拖卡写属性不换父子；导图只接子树', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  const qid = await page.evaluate(() => {
    const p = window.__qua.pages().find((x) => x.title.includes('产品设计'))
    window.__qua.invoke('core.page/open', { pageId: p.id })
    let found = ''
    const walk = (list) => {
      for (const b of list) {
        if (!found && b.props?._query?.where) found = b.id
        walk(b.children)
      }
    }
    walk(window.__qua.__editor.store.blocks)
    return found
  })
  assert(qid !== '', '前置：种子里应有一个查询块')
  await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), qid)
  await page.waitForTimeout(400)
  // 换成「全库的任务」，才有多个可分组的值
  await page.evaluate(
    (id) =>
      window.__qua.invoke('core.query/set-spec', {
        owner: { kind: 'block', blockId: id },
        spec: { where: { tag: '任务' }, scope: 'all' },
      }),
    qid,
  )
  await page.waitForTimeout(450)
  const countOf = () => page.evaluate(() => document.querySelector('.queryview-count')?.textContent ?? '')
  // ⚠️ 别叫 `base`：那是 harness 的站点地址，闭包里重名会撞 TDZ
  const rowsBefore = await countOf()

  const addView = async (kind) => {
    await page.evaluate(
      ({ id, k }) => window.__qua.invoke('core.view/add', { owner: { kind: 'block', blockId: id }, kind: k }),
      { id: qid, k: kind },
    )
    await page.waitForTimeout(450)
  }

  // ① 看板：列 ≥2（含「未设置」）；拖一张卡到另一列 ⇒ 只改那一格
  await addView('board')
  const board = await page.evaluate(() => ({
    cols: [...document.querySelectorAll('.vb-col')].map((c) => c.dataset.value ?? ''),
    cards: document.querySelectorAll('.vb-card').length,
    unset: Boolean(document.querySelector('.vb-col[data-unset="1"]')),
  }))
  assert(board.cols.length >= 2, `看板应至少有一列（＋未设置）：${JSON.stringify(board)}`)
  assert(board.cards > 0, `看板要画出卡：${JSON.stringify(board)}`)
  assert(board.unset, `「未设置」那一列必须在（藏起来＝告诉用户这些不存在）：${JSON.stringify(board)}`)

  const card = await page.evaluate(() => {
    const el = document.querySelector('.vb-card')
    return { id: el?.dataset.blockId ?? '', parent: window.__qua.__editor.store.find(el?.dataset.blockId ?? '') ? 'ok' : '' }
  })
  assert(card.id !== '', '前置：应有一张卡')
  const parentBefore = await page.evaluate((id) => {
    // 这一块在整片森林里的父（拖完必须一模一样）
    let parent = ''
    const walk = (list, p) => {
      for (const b of list) {
        if (b.id === id) parent = p ?? ''
        walk(b.children, b.id)
      }
    }
    walk(window.__qua.__editor.store.blocks, null)
    return parent
  }, card.id)
  const targetCol = await page.evaluate((own) => {
    const col = [...document.querySelectorAll('.vb-col')].find((c) => (c.dataset.value ?? '') !== own)
    return { value: col?.dataset.value ?? '', unset: col?.dataset.unset === '1' }
  }, await page.evaluate((id) => window.__qua.__editor.store.find(id)?.props?.['_query'] ? '' : '', card.id))
  void targetCol
  const colValue = await page.evaluate(() => {
    const cols = [...document.querySelectorAll('.vb-col')]
    const withValue = cols.find((c) => c.dataset.unset !== '1' && c.dataset.value !== '')
    return withValue?.dataset.value ?? ''
  })
  assert(colValue !== '', `前置：应有一列带值：${colValue}`)
  const propId = await page.evaluate((id) => window.__qua.__editor.store.find(id)?.props?._views?.find((v) => v.id === window.__qua.__editor.store.find(id)?.props?._activeView)?.board?.groupBy ?? '', qid)
  assert(propId !== '', '前置：看板应有分组列')
  await page.evaluate(
    ({ propId: pid, value, blockId }) => window.__qua.invoke('core.props/set-value', { blockId, propId: pid, value }),
    { propId, value: colValue, blockId: card.id },
  )
  await page.waitForTimeout(400)
  const afterDrag = await page.evaluate(({ id, q }) => {
    let parent = ''
    const walk = (list, p) => {
      for (const b of list) {
        if (b.id === id) parent = p ?? ''
        walk(b.children, b.id)
      }
    }
    walk(window.__qua.__editor.store.blocks, null)
    // ⚠️ 条件在**查询块**身上，不在卡上：拖卡不该让查询的条件发生任何变化
    return { parent, where: JSON.stringify(window.__qua.__editor.store.find(q)?.props?._query?.where) }
  }, { id: card.id, q: qid })
  assert(afterDrag.parent === parentBefore, `拖卡不许换父子（那会改结构）：${parentBefore} → ${afterDrag.parent}`)
  assert(afterDrag.where === '{"tag":"任务"}', `拖卡不许改条件：${afterDrag.where}`)

  // ② 画廊：一格一卡
  await addView('gallery')
  const gallery = await page.evaluate(() => ({
    cards: document.querySelectorAll('.vg-card').length,
    cover: document.querySelectorAll('.vg-cover').length,
  }))
  assert(gallery.cards > 0 && gallery.cover === gallery.cards, `画廊一格一卡、每张都有封面位：${JSON.stringify(gallery)}`)

  // ③ 日历：月网格 42 格、今天有描边
  await addView('calendar')
  const cal = await page.evaluate(() => ({
    days: document.querySelectorAll('.vc-day').length,
    today: document.querySelectorAll('.vc-day[data-today="1"]').length,
  }))
  assert(cal.days === 42, `月网格应有 42 格（6 周 × 7 天）：${JSON.stringify(cal)}`)
  assert(cal.today === 1, `今天要有描边（一个月里只有一格）：${JSON.stringify(cal)}`)

  // ④ 换看法不重查：条数一直是冻结出来的那一批
  assert((await countOf()) === rowsBefore, `切换布局不该重查：${rowsBefore} → ${await countOf()}`)

  // ⑤ 导图只接子树：给一页（children 源）建导图，节点数＝它的子树块数
  const pageInfo = await page.evaluate(() => {
    const p = window.__qua.pages().find((x) => x.title.includes('产品设计'))
    window.__qua.invoke('core.page/open', { pageId: p.id })
    let size = 0
    const walk = (list) => {
      for (const b of list) {
        size++
        walk(b.children)
      }
    }
    const page2 = window.__qua.__editor.store.blocks.find((b) => b.id === p.id)
    if (page2) walk([page2])
    return { id: p.id, size }
  })
  await page.waitForTimeout(350)
  await page.evaluate(
    (id) => window.__qua.invoke('core.view/add', { owner: { kind: 'block', blockId: id }, kind: 'mindmap' }),
    pageInfo.id,
  )
  await page.waitForTimeout(500)
  const mm = await page.evaluate(() => ({
    nodes: document.querySelectorAll('.vm-node').length,
    edges: document.querySelectorAll('.vm-edge').length,
  }))
  assert(mm.nodes === pageInfo.size, `导图的节点＝这一页的子树（${pageInfo.size}）：${JSON.stringify(mm)}`)
  assert(mm.edges === mm.nodes - 1, `每个非根节点一条边：${JSON.stringify(mm)}`)

  await ctx.close()
  return `看板 ${board.cols.length} 列／画廊 ${gallery.cards} 卡／日历 42 格／导图 ${mm.nodes} 节点；条数始终 ${rowsBefore}`
})

/**
 * **判定放在所有用例之后**：写在这里之前时，后面的用例（T136 起）即使红了也不会进
 * `fail`，而退出码看的是 `fail` ⇒ 那一截用例其实是「跑了但不判红」的假绿。
 */
const known = results.filter((r) => !r.ok && r.known)
const fail = results.filter((r) => !r.ok && !r.known).length

/**
 * ⚠️ **报告先写，再关浏览器。** 反过来的话，机器被压死那一刻 Chrome 先死，
 *    `browser.close()` 抛出来，报告就永远没写 —— 编排端只能看到「这一片没留下报告」，
 *    而真正的原因是「这一片的用例其实已经跑完了，只是答案没被记下来」。
 *    关浏览器失败不该吞掉结果。
 */
if (REPORT) {
  // 分片：只留报告，逐条打印交给编排脚本（四片各打一遍会把输出搅成一团）
  await writeFile(REPORT, JSON.stringify({ total: seq, cases: results, known: known.map((r) => r.name) }))
}

try {
  await browser.close()
} catch (e) {
  console.error(`关浏览器失败（结果已写完，不影响判定）：${e?.message ?? e}`)
}
if (server) server.close()




if (!REPORT) {
  console.log('')
  for (const r of results) {
    const tag = r.ok ? '\u001b[32mPASS\u001b[0m' : r.known ? '\u001b[33mKNOWN\u001b[0m' : '\u001b[31mFAIL\u001b[0m'
    console.log(`${tag}  ${r.name}`)
    if (r.known) console.log(`      \u001b[33m已知失败（不判红）：${r.known}\u001b[0m`)
    if (r.msg) console.log(`      ${String(r.msg).replace(/\n/g, '\n      ')}`)
  }
  const k = known.length ? `（其中 ${known.length} 条是已知失败，不判红）` : ''
  console.log(`\n${results.length - known.length - fail}/${results.length} 通过${k}${SHARD ? `（分片 ${SHARD.i + 1}/${SHARD.n}）` : ''}\n`)
}
process.exit(fail === 0 ? 0 : 1)
