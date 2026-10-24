/**
 * `pnpm check` —— 浏览器级冒烟：**真 Chrome ＋ 真按键 ＋ 真鼠标**，逐条打勾。
 * 断言口径尽量贴任务书：能敲字 / Enter 拆块 / Backspace 合并 / Tab 缩进 / 折叠 / 拖拽重排 /
 * 四种区间格式 / 两种行内原子 / 命令面板（无绑定也能执行）/ 菜单由绑定表渲染 /
 * localStorage 持久化 / 三风格 × 亮暗 / 空态·稀疏态·降级态 / 虚拟化与 composing 角标。
 *
 * ⚠️ **每条用例必须 `await check(...)`**：`check` 是 async，漏掉 await 的用例会和文件末尾的
 *    `browser.close()` 并发，报 `browserContext.newPage: Target page, context or browser has been closed`
 *    —— 看起来像浏览器挂了，其实是用例没进队列。
 */
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { assert, freshPage, key as kbd, launch, openPage, reopenPage, resolveBase } from '../scripts/harness.mjs'

const SHOTS = fileURLToPath(new URL('../shots/', import.meta.url))
const results = []

async function check(name, fn) {
  try {
    const msg = await fn()
    results.push({ name, ok: true, msg: msg ?? '' })
  } catch (e) {
    results.push({ name, ok: false, msg: e?.message ?? String(e) })
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

/** 真的走一遍 HTML5 DnD：块标 dragstart（`text/plain` = 块 id）→ 槽 dragover → drop */
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
      return { hot, carried: dt.getData('text/plain') }
    },
    { id: blockId, side },
  )

/** 槽当前状态：prefs 里的清单 + 真正渲染出来的行（按 nav 顺序） */
const dockState = (page) =>
  page.evaluate(() => {
    const rows = (side) =>
      [...document.querySelectorAll(`#dock-${side} .pin-row`)].map((r) => r.dataset.blockId)
    return { pref: window.__qua.snapshot().dock, rows: { left: rows('left'), right: rows('right') } }
  })

/** 钉住行里**那一块自己的**正文（行内还有它的子树，不能取行内第一个/全部 `.tx`） */
const pinRootText = (page, side, blockId) =>
  page.evaluate(
    ({ side, id }) =>
      document.querySelector(
        `#dock-${side} .pin-row[data-block-id="${id}"] > .pin-editor > .blk[data-depth="0"] > .tx`,
      )?.textContent ?? '',
    { side, id: blockId },
  )

/* ---------------------------------------------------------------- 敲字 */

await check('T1 冷启动不抢光标；点块才聚焦，块属性只在聚焦块时出现；journal 的日期行不被写入', async () => {
  const { ctx, page, errors } = await freshPage(browser, base)
  const before = await snap(page)
  const cold = await page.evaluate(() => {
    // journal 首行是只读日期 ⇒ 第一个可编辑块是它的子块
    const b = window.__qua.blocks()
    const editable = b.find((x) => !x.roles?.includes('journal'))
    const editor = document.getElementById('editor')
    return {
      id: editable?.id ?? '',
      focused: editor?.contains(document.activeElement) ?? false,
      sel: window.__qua.snapshot().selection ?? null,
      propsHidden: document.getElementById('properties')?.hidden ?? null,
    }
  })
  assert(cold.id, `冷启动应能找到第一个可编辑块：${JSON.stringify(cold)}`)
  assert(!cold.focused, `冷启动不该把焦点抢进编辑器：${JSON.stringify(cold)}`)
  assert(!cold.sel, `冷启动不该有模型选区：${JSON.stringify(cold)}`)
  assert(cold.propsHidden === true, `冷启动没有聚焦块 ⇒ 属性区应收起：${JSON.stringify(cold)}`)

  // 真点一下那一行：这才是「用户让某一块聚焦」的动作
  await page.locator(`.blk[data-block-id="${cold.id}"] > .tx`).click()
  await page.waitForTimeout(120)
  const clicked = await page.evaluate(() => {
    const editor = document.getElementById('editor')
    const props = document.getElementById('properties')
    return {
      focused: editor?.contains(document.activeElement) ?? false,
      sel: window.__qua.snapshot().selection ?? null,
      propsHidden: props?.hidden ?? null,
      propsTarget: props?.dataset.targetBlockId ?? '',
    }
  })
  assert(clicked.focused, `点击块后编辑器应获得焦点：${JSON.stringify(clicked)}`)
  assert(clicked.sel?.aBlock === cold.id, `点击后选区应落在被点的块上：${JSON.stringify(clicked)}`)
  assert(clicked.propsHidden === false, `有聚焦块 ⇒ 属性区应显示：${JSON.stringify(clicked)}`)
  assert(clicked.propsTarget === cold.id, `属性区应画在聚焦块上：${JSON.stringify(clicked)}`)

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
  return `冷启动无焦点、无选区、属性区收起；点击后落点 ${cold.id.slice(-6)}；块数 ${after.blocks}，DOM 节点 ${after.domNodes}`
})

await check('T1b 属性目标随聚焦块变化；点到编辑区外收起；再点块恢复', async () => {
  const { ctx, page } = await freshPage(browser, base)
  const ids = await page.evaluate(() =>
    window.__qua
      .blocks()
      .filter((b) => !b.roles?.includes('journal'))
      .map((b) => b.id),
  )
  assert(ids.length >= 2, `至少需要两个可编辑块才能测「换目标」：${JSON.stringify(ids)}`)
  const [a, b] = ids
  const state = () =>
    page.evaluate(() => {
      const props = document.getElementById('properties')
      return { hidden: props?.hidden ?? null, target: props?.dataset.targetBlockId ?? '' }
    })

  await page.locator(`.blk[data-block-id="${a}"] > .tx`).click()
  await page.waitForTimeout(120)
  assert((await state()).target === a, `焦点在块 A ⇒ 属性目标应是 A：${JSON.stringify(await state())}`)

  await page.locator(`.blk[data-block-id="${b}"] > .tx`).click()
  await page.waitForTimeout(120)
  assert((await state()).target === b, `焦点换到块 B ⇒ 属性目标应跟着换：${JSON.stringify(await state())}`)

  // 右上角（三槽外侧的边距/槽头）不是编辑区、也不是属性区 ⇒ 面板收起
  await page.mouse.click(8, 8)
  await page.waitForTimeout(120)
  const outside = await state()
  assert(outside.hidden === true, `点到编辑区外 ⇒ 属性区应收起：${JSON.stringify(outside)}`)

  await page.locator(`.blk[data-block-id="${a}"] > .tx`).click()
  await page.waitForTimeout(120)
  const back = await state()
  assert(back.hidden === false && back.target === a, `再点块 ⇒ 属性区恢复并画在该块上：${JSON.stringify(back)}`)

  await ctx.close()
  return `A→B 跟随、外侧点击收起、再点 A 恢复（${a.slice(-6)} / ${b.slice(-6)}）`
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

await check('T3 四种区间格式走**区间锚点**（⌘B/⌘I/⌘E/⌘`），不是 run 属性', async () => {
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
  for (const [, t] of keys) assert(types.has(t), `缺少 ${t} 锚点：${JSON.stringify(marks)}`)
  for (const m of marks) assert(m.end > m.start && m.blockId.length === 32, `锚点形状不对：${JSON.stringify(m)}`)
  const dom = await page.evaluate(() => ({
    bold: document.querySelectorAll('.mk-bold').length,
    italic: document.querySelectorAll('.mk-italic').length,
    hl: document.querySelectorAll('.mk-highlight').length,
    code: document.querySelectorAll('.mk-code').length,
  }))
  assert(dom.bold && dom.italic && dom.hl && dom.code, `DOM 里四种表现不齐：${JSON.stringify(dom)}`)
  await ctx.close()
  return `marks=${marks.length}（${[...types].join('/')}）`
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

await check('T4 锚点的粘性映射：在区间起点插入不撑大、终点插入不动', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await openFirstPage(page)
  const r = await page.evaluate(() => {
    const id = window.__qua.blocks()[0].id
    window.__qua.focusBlock(id, 0)
    return id
  })
  /**
   * ⚠️ 读回的是**这一次刚加上的那条**（`[0,2)`），不是 `marks()[0]`：种子里本来就有一条
   *    `bold`，两者同型时按数组下标取会随写入顺序漂移（实测取到另一块上的那条，报 `[5,21)`）。
   */
  const bold0 = () =>
    page.evaluate(
      (id) => window.__qua.marks().find((m) => m.blockId === id && m.type === 'bold' && m.start < 2) ?? null,
      r,
    )
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press(kbd('mod+b'))
  const m0 = await bold0()
  assert(m0 && m0.start === 0 && m0.end === 2, `初始锚点应为 [0,2)：${JSON.stringify(m0)}`)
  // 光标停到区间起点（offset 0）再插入 ⇒ 起点右移（不撑大）
  await page.evaluate((id) => window.__qua.focusBlock(id, 0), r)
  await page.keyboard.type('X')
  const m1 = await bold0()
  assert(m1 && m1.start === 1 && m1.end === 3, `起点插入后应整体右移到 [1,3)：${JSON.stringify(m1)}`)
  // 光标停到区间终点再插入 ⇒ 终点不动
  await page.evaluate((id) => window.__qua.focusBlock(id, 3), r)
  await page.keyboard.type('Y')
  const m2 = await bold0()
  assert(m2 && m2.start === 1 && m2.end === 3, `终点插入后应保持 [1,3)：${JSON.stringify(m2)}`)
  await ctx.close()
  return `[0,2) →起点插→ [1,3) →终点插→ [1,3)（两端口径与既有实现一致）`
})

/* -------------------------------------------------------- 行内原子 */

await check('T5 行内原子：引用 chip 与图片占位各占 1 格，随文本漂移，可点开信息', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await openFirstPage(page)
  const r = await page.evaluate(() => {
    const blk = window.__qua.blocks()[0]
    window.__qua.focusBlock(blk.id, 0)
    const target = window.__qua.pages()[1].id
    window.__qua.invoke('core.editor/insert-page-ref', { pageId: target })
    const atom = window.__qua.atoms().find((a) => a.blockId === blk.id)
    return { atom, text: window.__qua.blocks()[0].text, id: blk.id, total: window.__qua.atoms().length }
  })
  assert(r.atom, `引用原子没插进去：${JSON.stringify(r)}`)
  const a = r.atom
  assert(a.end - a.start === 1, `原子应恒占 1 格：${JSON.stringify(a)}`)
  assert(r.text[a.start] === '\uFFFC', `文本里那一格应是占位符 U+FFFC：${JSON.stringify(r.text.slice(0, 6))}`)
  await page.evaluate((id) => window.__qua.focusBlock(id, 0), r.id)
  await page.keyboard.type('前')
  const shifted = (await page.evaluate(() => window.__qua.atoms())).find((x) => x.blockId === r.id)
  assert(shifted.start === a.start + 1, `在原子前插入应右移 1：${a.start} → ${shifted.start}`)
  await page.evaluate(() => window.__qua.invoke('core.editor/insert-image', { preset: 'missing' }))
  const atoms = await page.evaluate(() => window.__qua.atoms())
  assert(atoms.some((x) => x.kind === 'image'), '图片原子没插进去')
  const domAtoms = await page.evaluate(() => ({
    page: document.querySelectorAll('.atom-page').length,
    image: document.querySelectorAll('.atom-image').length,
    missing: document.querySelectorAll('.atom-image.missing').length,
  }))
  assert(domAtoms.page >= 3 && domAtoms.image >= 1, `假数据 + 新插入的原子数不对：${JSON.stringify(domAtoms)}`)
  assert(domAtoms.missing >= 1, '缺失资产应有 .missing 表现（状态不是错误）')
  // ⌥ 点击才弹信息（左键默认是「打开目标」，见 T43）
  await page.locator('.atom-page').first().click({ modifiers: ['Alt'] })
  const popText = await page.locator('.popover').innerText()
  assert(popText.includes('引文快照') || popText.includes('状态'), `引用信息气泡没内容：${popText}`)
  await page.keyboard.press('Escape')
  assert((await page.locator('.popover').count()) === 0, 'Esc 应关掉信息气泡')
  await ctx.close()
  return `原子 ${atoms.length} 个；chip+图片都在，缺资产有 .missing 表现，点开有信息`
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

  // R2：无子块的行**不生成** `.fold` 节点（不是 visibility:hidden）
  const foldOnLeaf = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#editor .blk')]
    const leaves = rows.filter((el) => !el.dataset.hasChildren)
    return {
      leafCount: leaves.length,
      withFold: leaves.filter((el) => el.querySelector('.fold')).length,
      // 对照：有子块的行必须生成
      parentsWithFold: rows.filter((el) => el.dataset.hasChildren && el.querySelector('.fold')).length,
      parentCount: rows.filter((el) => el.dataset.hasChildren).length,
    }
  })
  assert(foldOnLeaf.leafCount > 0, '假数据里应有无子块的行')
  assert(foldOnLeaf.withFold === 0, `无子块的行不该生成 .fold 节点（R2），实际 ${foldOnLeaf.withFold}/${foldOnLeaf.leafCount}`)
  assert(
    foldOnLeaf.parentsWithFold === foldOnLeaf.parentCount,
    `有子块的行都应生成 .fold：${foldOnLeaf.parentsWithFold}/${foldOnLeaf.parentCount}`,
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

  await ctx.close()
  return `marker=${r.markerClasses}（${r.markerW}）｜三角 absolute/opacity ${r.foldOpacity}｜无子块不生成 .fold（${foldOnLeaf.leafCount} 行）｜折叠态环 ${ring.width} ${ring.style}`
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
  assert(body.includes('roots') && body.includes('marks') && body.includes('atoms'), '抽屉里应是模型 JSON')
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
  const beforeAtoms = (await page.evaluate(() => window.__qua.atoms())).length
  await page.keyboard.press('Enter')
  const afterAtoms = (await page.evaluate(() => window.__qua.atoms())).length
  assert(afterAtoms === beforeAtoms + 1, '斜杠菜单选「图片」应插入一个原子')
  const t = await texts(page)
  assert(!t.some((x) => x.includes('/图')), `` + `斜杠查询词应从文本里抹掉：${JSON.stringify(t.slice(-2))}`)
  await ctx.close()
  return `块菜单 ${viaClick.length} 项 / ${grouped.length} 组；斜杠输入「/图」→ ${filteredRows} 项 → 插入原子`
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
  // 打开「产品设计 · 决策日志」：seed 里那一页带一个查询块（条件＝本页的待办）
  await page.evaluate(() => {
    const p = window.__qua.pages().find((x) => (x.title ?? '').includes('产品设计'))
    window.__qua.invoke('core.page/open', { pageId: p.id })
  })
  await page.waitForTimeout(300)

  const view = () =>
    page.evaluate(() => ({
      hidden: document.getElementById('queryview').hidden,
      title: document.getElementById('queryview-title').textContent,
      count: document.getElementById('queryview-count').textContent,
      refresh: document.getElementById('queryview-refresh')?.textContent ?? '',
      stale: !document.getElementById('queryview-stale').hidden,
      rows: Array.from(document.querySelectorAll('#queryview-editor .blk .tx')).map((e) => e.textContent),
    }))

  const first = await view()
  assert(!first.hidden, '这一页有查询块 ⇒ 查询视图应当可见')
  assert(first.rows.length === 1, `本页应只有 1 条待办，实际 ${JSON.stringify(first.rows)}`)
  assert(first.refresh.length > 0, '刷新按钮必须有文案（D6）')
  assert(!first.stale, '刚冻结完不该显示「可能已过期」')

  const targetId = await page.evaluate(() =>
    window.__qua.blocks().find((x) => x.text.includes('引用某段'))?.id ?? '',
  )
  assert(targetId, '前置：应能找到那条待办')

  // ① 内容不冻（D5）：在正文里改字 ⇒ 查询视图**立即**显示新文字
  await page.evaluate((id) => window.__qua.focusBlock(id, 0), targetId)
  await page.keyboard.type('改字 ')
  await page.waitForTimeout(200)
  const edited = await view()
  assert(edited.rows.some((r) => r.startsWith('改字')), `内容应当实时更新（D5）：${JSON.stringify(edited.rows)}`)
  assert(edited.count === first.count, '改字不该改成员数（D4：冻的是成员与顺序）')
  assert(edited.stale, '结果里的块变了 ⇒ 应当提示「可能已过期」')

  // ② 成员不冻（D4）：把它改成已完成 ⇒ 不再匹配，但**列表仍应留着**，等刷新再移除
  await page.evaluate(() => window.__qua.invoke('core.editor/toggle-todo'))
  await page.waitForTimeout(200)
  const stillThere = await view()
  assert(stillThere.rows.length === 1, `去掉匹配后不许自动重排（D4）：${JSON.stringify(stillThere.rows)}`)
  assert(stillThere.stale, '仍然要提示可能已过期')

  // ③ 刷新按钮（D6）：这时才改变成员
  await page.click('#queryview-refresh')
  await page.waitForTimeout(300)
  const refreshed = await view()
  assert(refreshed.rows.length === 0, `刷新后才移除（D6）：${JSON.stringify(refreshed.rows)}`)
  assert(refreshed.count.startsWith('0'), `条数要跟着变：${refreshed.count}`)
  assert(!refreshed.stale, '刷新完不应再提示已过期')
  assert(!refreshed.hidden && refreshed.refresh.length > 0, '空结果也要保留抬头与刷新按钮（不是静默消失）')

  // ④ 落盘：结果集入 KB（刷新只改 _queryResult，不 re-parent）
  const frozen = await page.evaluate(() => {
    const raw = localStorage.getItem(localStorage.key(0))
    const data = JSON.parse(raw).data
    const q = data.blocks.flatMap(function flat(b) { return [b, ...b.children.flatMap(flat)] }).find((b) => Boolean(b.props?._query?.where))
    return { hasQuery: Boolean(q?.props?._query), result: q?.props?._queryResult, children: q?.children?.length ?? -1 }
  })
  assert(frozen.hasQuery, '条件要落在 _query 上（AF5：查询块＝数据侧）')
  assert(Array.isArray(frozen.result) && frozen.result.length === 0, '冻结结果要入 KB')
  assert(frozen.children === 0, '刷新不许把结果 re-parent 成查询块的子块（AF2/AF3）')

  await ctx.close()
  return `1 条 → 改字实时更新（成员不变）→ 不匹配仍保留 → 刷新后 ${refreshed.count}；结果集入 KB 且未 re-parent`
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
  const readback = await page.evaluate((id) => window.__qua.__editor.readText(id), target.targetId)
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
  assert(!it.text.includes('\uFFFC'), `正文里不该为标签多出一格占位符：${JSON.stringify(it.text)}`)

  // ② 呈现：行尾拼一枚 `#名` chip，但**它不参与读数**
  const shown = await page.evaluate(
    ({ blockId, tagId }) => {
      const chip = document.querySelector(`.blk[data-block-id="${blockId}"] .tx .tag-chip[data-tag-id="${tagId}"]`)
      return { chip: chip?.textContent ?? '', read: window.__qua.__editor.readText(blockId) }
    },
    { blockId: it.blockId, tagId: it.tag.id },
  )
  assert(shown.chip === '#回归标签', `标签应显示成 #名（引用才是 [[名]]）：${JSON.stringify(shown)}`)
  assert(shown.read === it.text, `chip 拼在正文里但不属于正文：读数应仍是原正文 —— ${JSON.stringify(shown)}`)

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
  const { ctx, page } = await freshPage(browser, base, { viewport: { width: 1440, height: 1200 } })
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
    const root = ed.doc.roots[0]
    return {
      roots: ed.doc.roots.length,
      rootText: root.text,
      kids: root.children.map((b) => ({ id: b.id, text: b.text })),
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
  const ids = await page.evaluate(() => {
    const ed = window.__qua.__editor
    const rootId = ed.doc.roots[0].id
    const a = ed.insertBlockAfter(rootId, 'AAAA')
    const b = ed.insertBlockAfter(a, 'BBBB')
    const c = ed.insertBlockAfter(b, 'CCCC')
    return { a, b, c }
  })
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
    const rows = [...document.querySelectorAll('#editor > .blk')]
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
    heads: [...document.querySelectorAll('#editor > .blk[data-depth="0"]')].map((el) => el.dataset.role ?? ''),
    dates: [...document.querySelectorAll('#editor > .blk[data-depth="0"]')].map((el) => el.querySelector('.tx')?.dataset.ph ?? ''),
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
    const rows = [...document.querySelectorAll('#editor > .blk')]
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
    roots: [...document.querySelectorAll('#editor > .blk')].filter((el) => el.dataset.depth === '0').length,
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
    roots: [...document.querySelectorAll('#editor > .blk')].filter((el) => el.dataset.depth === '0').length,
  }))
  assert(afterZoom.roots === 1, `zoom 后视图应只剩一块：${JSON.stringify(afterZoom)}`)

  // 后退 ⇒ 应回到 feed（多段），而不是一个孤立的天
  await page.evaluate(() => window.__qua.invoke('core.history/back'))
  await page.waitForTimeout(240)
  const back = await page.evaluate(() => ({
    roots: [...document.querySelectorAll('#editor > .blk')].filter((el) => el.dataset.depth === '0').length,
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
      [...document.querySelectorAll('#editor > .blk[data-depth="0"]')].map((el) => el.dataset.blockId),
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

await check('T58 行内标签：敲完分隔符 ⇒ 正文 1 格原子 ＋ 块上的归属，chip 不重复', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  await openFirstPage(page)

  // 找一个空块并落光标（focusBlock 同时把 DOM 焦点交进去；冷启动不再自动聚焦）
  const target = await page.evaluate(() => {
    const ed = window.__qua.__editor
    const rootId = window.__qua.blocks()[0].id
    const id = ed.insertBlockAfter(rootId, '')
    window.__qua.focusBlock(id, 0)
    return id
  })
  await page.waitForTimeout(80)

  const tagName = '自动归属'
  await page.keyboard.type(`写点东西 #${tagName} `)
  await page.waitForTimeout(220)

  const got = await page.evaluate(({ id, name }) => {
    const b = window.__qua.blocks().find((x) => x.id === id)
    const tx = document.querySelector(`.blk[data-block-id="${id}"] .tx`)
    const atomEl = tx?.querySelector('.atom-tag')
    return {
      text: b?.text ?? '',
      found: Boolean(b),
      tags: b?.tags ?? [],
      atoms: window.__qua.atoms().filter((a) => a.blockId === id),
      chips: tx ? tx.querySelectorAll('.tag-chip').length : -1,
      inline: atomEl?.textContent ?? '',
      inlineLabel: atomEl?.dataset.refLabel ?? '',
      tagBlock: window.__qua.allBlocks().find((x) => x.roles?.includes('tag') && x.text === name)?.id ?? '',
      caret: window.__qua.__editor.sel,
    }
  }, { id: target, name: tagName })

  assert(got.found, '前置：插入的块应在当前视图里：' + JSON.stringify(got))

  /**
   * **行内标签的判据**：
   *   `#名` 不是「正文里的几个字」，而是**正文里的一格**（原子）＋ 块上的一条归属。
   *   两处必须同时成立；只做一半就是「查询里有、正文里看不到」或反过来。
   */
  assert(got.text === '写点东西 \uFFFC ', '正文里应把 `#名` 换成 1 格占位符（分隔符留着）：' + JSON.stringify(got.text))
  assert(got.atoms.length === 1 && got.atoms[0].kind === 'tag', '应产出 1 枚 tag 原子：' + JSON.stringify(got.atoms))
  assert(got.tagBlock !== '', '敲完就该建出标签块：' + JSON.stringify(got.tagBlock))
  assert(got.tags.length === 1 && got.tags[0] === got.tagBlock, '归属应指向那个标签块：' + JSON.stringify({ tags: got.tags, tag: got.tagBlock }))
  assert(got.inline === `#${tagName}`, '正文里应显示成 `#名`：' + JSON.stringify(got.inline))
  assert(got.inlineLabel === tagName, '显示名应是解析出来的（不带 #）：' + JSON.stringify(got.inlineLabel))
  assert(got.chips === 0, '已经在正文里露面 ⇒ 不该再出一个 chip（否则一个标签显示两次）')
  assert(got.caret?.aOff === 7, '光标应停在标签之后（`写点东西 ` 5 字 ＋ 1 格 ＋ 1 空格）：' + JSON.stringify(got.caret))

  // 删字不摘标签：光标停在标签之后按 Backspace ⇒ 那一格没了，归属还在，落回 chip
  await page.evaluate((id) => window.__qua.__editor.placeCaret(id, 6), target)
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(200)
  const afterDel = await page.evaluate((id) => {
    const b = window.__qua.blocks().find((x) => x.id === id)
    const tx = document.querySelector(`.blk[data-block-id="${id}"] .tx`)
    return {
      tags: b?.tags ?? [],
      atoms: window.__qua.atoms().filter((a) => a.blockId === id).length,
      chips: tx ? tx.querySelectorAll('.tag-chip').length : -1,
      inline: tx ? tx.querySelectorAll('.atom-tag').length : -1,
    }
  }, target)
  assert(afterDel.atoms === 0, '删掉那一格 ⇒ 原子跟着没了（不留孤儿）：' + JSON.stringify(afterDel))
  assert(afterDel.tags.length === 1, '⚠️ 删字**不摘标签**：归属仍在「这块属于它」：' + JSON.stringify(afterDel))
  assert(afterDel.chips === 1 && afterDel.inline === 0, '不在正文里露面了 ⇒ 归属落回 chip（只一个显示位置）')

  await ctx.close()
  return `敲「#${tagName}」⇒ 1 格原子 ＋ 归属；删字 ⇒ 原子消失、归属落回 chip`
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
    const tx = document.querySelector(`.blk[data-block-id="${id}"] .tx`)
    return {
      text: b?.text ?? '',
      tags: b?.tags ?? [],
      chips: tx ? [...tx.querySelectorAll('.tag-chip')].map((e) => e.textContent) : [],
      panel: [...document.querySelectorAll('.props-tag')].map((e) => e.textContent),
    }
  }, pageId)
  assert(added.tags.length === 1, '面板挂标签应写进块上的归属：' + JSON.stringify(added))
  assert(added.chips.length === 1 && added.chips[0] === '#项目', '块级标签应渲染成正文之后的 chip：' + JSON.stringify(added.chips))
  assert(added.panel.some((s) => s.includes('#项目')), '面板这一行应显示刚挂上的标签：' + JSON.stringify(added.panel))
  assert(!added.text.includes('项目'), '属性面板入口**不碰正文**：' + JSON.stringify(added.text))

  await page.click('.props-tag .props-tag-x')
  await page.waitForTimeout(250)
  const removed = await page.evaluate((id) => {
    const b = window.__qua.blocks().find((x) => x.id === id)
    const tx = document.querySelector(`.blk[data-block-id="${id}"] .tx`)
    return {
      tags: b?.tags ?? [],
      chips: tx ? tx.querySelectorAll('.tag-chip').length : -1,
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
    window.__qua.invoke('core.props/create-def', { blockId: host, label: '负责人', kind: 'ref' })
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
    find(b, ed.doc.roots)?.children.push({ id: 'kid-' + b, text: '子块不该留', children: [] })
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
    const roots = [...document.querySelectorAll('#editor > .blk[data-role="journal"]')]
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
    const roots = [...document.querySelectorAll('#editor > .blk[data-role="journal"]')]
    const last = roots[roots.length - 1]
    return last?.nextElementSibling?.dataset.blockId ?? ''
  })
  assert(oldestChild, '最早的一段应有一个可编辑子块')
  await page.evaluate((id) => window.__qua.focusBlock(id, 9999), oldestChild)
  await page.keyboard.type('历史编辑')
  const edited = await page.evaluate(() => ({
    hasText: window.__qua.blocks().some((b) => b.text.includes('历史编辑')),
    rootTexts: [...document.querySelectorAll('#editor > .blk[data-role="journal"]')].map((el) => el.querySelector('.tx')?.textContent ?? ''),
  }))
  assert(edited.hasText, '历史天的子块应能编辑')
  assert(edited.rootTexts.every((t) => t === ''), `journal 段头的正文应保持为空：${JSON.stringify(edited.rootTexts)}`)

  // ③ 切到页再回日记流：历史天的编辑必须**写回**且重新装载后还在
  await page.evaluate(() => window.__qua.invoke('core.page/open', { pageId: window.__qua.pages()[0].id }))
  await page.evaluate(() => window.__qua.invoke('core.journal/today'))
  const persisted = await page.evaluate(() => ({
    hasText: window.__qua.blocks().some((b) => b.text.includes('历史编辑')),
    roots: document.querySelectorAll('#editor > .blk[data-role="journal"]').length,
  }))
  assert(persisted.hasText, '切页再回来，历史天的编辑应还在（syncSections 按 root id 写回）')
  assert(persisted.roots === 3, `回今日应重新装 3 段：${JSON.stringify(persisted)}`)

  await ctx.close()
  return `3 段：${feed.dates.join(' / ')}；最早一段可编辑并跨页写回`
})

await check('T29 滚到底加载更早的日记（只加载存在的天）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  const before = await page.evaluate(() => document.querySelectorAll('#editor > .blk[data-role="journal"]').length)
  const after = await page.evaluate(() => {
    const el = document.querySelector('#scroll')
    el.scrollTop = el.scrollHeight
    el.dispatchEvent(new Event('scroll'))
    const roots = [...document.querySelectorAll('#editor > .blk[data-role="journal"]')]
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
    const row = document.querySelector(`#backlinks-editor .blk[data-block-id="${id}"] .tx`)
    return { visible: !document.querySelector('#backlinks')?.hidden, text: row?.textContent ?? '' }
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
    const tx = document.querySelector(`#backlinks-editor .blk[data-block-id="${id}"] .tx`)
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
    const tx = document.querySelector(`#backlinks-editor .blk[data-block-id="${id}"] .tx`)
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
    footer: document.querySelector(`#backlinks-editor .blk[data-block-id="${id}"] .tx`)?.textContent ?? '',
  }), blockId)
  assert(both.footer.includes('Y'), `footer 应可原地编辑：${JSON.stringify(both)}`)
  assert(both.main.includes('Y'), `正文里的同一块应同步（共享 store）：${JSON.stringify(both)}`)

  // 全局 undo：焦点在 footer，Meta+Z 回滚 store，正文与 footer 一起复原
  await page.keyboard.press(kbd('mod+z'))
  await page.waitForTimeout(120)
  const undone = await page.evaluate((id) => ({
    main: window.__qua.blocks().find((b) => b.id === id)?.text ?? '',
    footer: document.querySelector(`#backlinks-editor .blk[data-block-id="${id}"] .tx`)?.textContent ?? '',
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
    const walk = (b, d) => {
      if (d >= 2 && b.text.length > 2) return b
      for (const c of b.children) {
        const hit = walk(c, d + 1)
        if (hit) return hit
      }
      return null
    }
    const b = walk(ed.doc.roots[0], 0)
    window.__qua.focusBlock(b.id, b.text.length)
    window.__qua.invoke('core.editor/insert-page-ref', { pageId: target })
    // 读的是插入**之后**的文本（含原子占位符），它同时也是 zoom 之后的页名
    return { id: b.id, text: b.text }
  }, targetPage)
  await page.waitForTimeout(350) // footer 的 200ms 查询去抖

  const marker = `#backlinks-editor .blk[data-block-id="${src.id}"] > .left > .marker`
  assert((await page.locator(marker).count()) === 1, `footer 里应有该源块的块标：${src.id}`)
  const before = await snap(page)
  await page.locator(marker).click()
  await page.waitForTimeout(200)

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
    const atomId = window.__qua.__editor.insertAtom('page', { label: '今日', target: { kind: 'page', id: j.id } })
    return { journal: j.id, src: src.id, atomId }
  })
  assert(ids.atomId, '冷启动下应能往正文插一个指向今日 journal 的原子')
  await page.waitForTimeout(350)

  assert(await page.evaluate(() => !document.querySelector('#backlinks')?.hidden), '冷启动的当前对象（今日 journal）应出现反链 footer')
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
  await page.locator(`#backlinks-editor .blk[data-block-id="${ids.src}"] > .tx`).first().click({ position: { x: 6, y: 6 } })
  await page.keyboard.press('End')
  await page.keyboard.type('Y')
  await page.waitForTimeout(150)

  const after = await page.evaluate((id) => ({
    rows: document.querySelectorAll('#editor .blk').length,
    texts: window.__qua.text(),
    firstId: document.querySelector('#editor .blk')?.dataset.blockId ?? '',
    footer: document.querySelector(`#backlinks-editor .blk[data-block-id="${id}"] > .tx`)?.textContent ?? '',
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
    const walk = (b, d) => {
      if (d >= 2 && b.text.length > 2) return b
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
      const row = document.querySelector(`#editor .blk[data-block-id="${blockId}"]`)
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
  await page.locator(`#editor .blk[data-block-id="${deep}"] > .left > .marker`).hover()
  const hovered = await readRow(deep)
  assert(
    hovered.boxW === '12px' && hovered.focusFor === deep,
    `悬停块标不该动身份图标：${JSON.stringify(hovered)}`,
  )

  await ctx.close()
  return `todo/done/深缩进（depth ${deepRow.depth}）三种：块标恒为圆点＋可聚焦，方框在身份图标上（.ico ${deepRow.boxW}）`
})

await check('T44 左键点引用直接打开目标；⌥ 才弹详情；dangling / 图片仍弹详情', async () => {
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

  // 图片原子：行为不变（点开资产信息）
  await page.locator('#editor .atom-image').first().click()
  const iPop = await page.locator('.popover').innerText()
  assert(iPop.includes('删除这个图片原子'), `图片原子仍应弹资产信息：${iPop.slice(0, 60)}`)

  await ctx.close()
  return `左键打开「${r.targetTitle}」；⌥/dangling/图片仍弹详情；块数仍 ${opened.total}`
})

await check('T15 角标：块数 / DOM 节点数 / 主题 / composing 都在', async () => {  const { ctx, page } = await freshPage(browser, base)
  const badge = await page.locator('#badge').innerText()
  const s = await snap(page)
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

  return `过新 v99 原样保留；损坏 JSON 原样保留；告警「${a.text.slice(0, 24)}…」`
})

/* ------------------------------------------------------------ 侧槽 */

await check('T45 Shift+点块标 ⇒ 右槽自动打开并钉住该块；再点一次取消；待办方框同样走这条而不勾选', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  await openFirstPage(page)
  // 先关掉右槽：Shift+点击必须能把它叫回来（否则「打开了但看不见」）
  await page.evaluate(() => window.__qua.invoke('core.dock/toggle-right'))
  await page.waitForTimeout(80)
  const closed = (await dockState(page)).pref.right
  assert(closed.open === false, `右槽应先关着：${JSON.stringify(closed)}`)

  const picked = await page.evaluate(() => {
    const b = window.__qua.blocks().find((x) => !(x.roles?.length) && !x.todo && x.text.length > 2)
    return b?.id ?? ''
  })
  assert(picked, '假数据里应有一个普通内容块')
  assert(await shiftClickMarker(page, picked), '应点得到该块的块标')
  await page.waitForTimeout(120)
  const pinned = await dockState(page)
  assert(pinned.pref.right.open === true, `Shift+点击应把右槽打开：${JSON.stringify(pinned.pref.right)}`)
  assert(pinned.pref.right.pins.includes(picked), `应钉住被点的块：${JSON.stringify(pinned.pref.right.pins)}`)
  assert(pinned.rows.right.includes(picked), `右槽应渲染出该块：${JSON.stringify(pinned.rows.right)}`)

  assert(await shiftClickMarker(page, picked), '第二次 Shift+点击')
  await page.waitForTimeout(120)
  const unpinned = await dockState(page)
  assert(!unpinned.pref.right.pins.includes(picked), `再按一次应取消钉住：${JSON.stringify(unpinned.pref.right.pins)}`)
  assert(!unpinned.rows.right.includes(picked), `取消后右槽不该再渲染它：${JSON.stringify(unpinned.rows.right)}`)

  // 待办行的方框＝块标：Shift+点击是「在右槽打开」，不是勾选
  await page.evaluate(() => window.__qua.invoke('core.dock/toggle-right'))
  await page.waitForTimeout(80)
  const todo = await page.evaluate(() => {
    const b = window.__qua.blocks().find((x) => x.todo)
    return b ? { id: b.id, todo: b.todo } : null
  })
  assert(todo, '假数据里应有待办块')
  await shiftClickMarker(page, todo.id)
  await page.waitForTimeout(120)
  const afterTodo = await page.evaluate((id) => ({
    todo: window.__qua.blocks().find((b) => b.id === id)?.todo ?? null,
    dock: window.__qua.snapshot().dock,
    rows: [...document.querySelectorAll('#dock-right .pin-row')].map((r) => r.dataset.blockId),
  }), todo.id)
  assert(afterTodo.dock.right.open === true, `待办方框的 Shift+点击也应打开右槽：${JSON.stringify(afterTodo.dock.right)}`)
  assert(afterTodo.dock.right.pins.includes(todo.id), `待办块应被钉住：${JSON.stringify(afterTodo.dock.right.pins)}`)
  assert(afterTodo.todo === todo.todo, `Shift+点击方框不该切换待办：${todo.todo} → ${afterTodo.todo}`)
  assert(afterTodo.rows.includes(todo.id), `待办块也应渲染在右槽：${JSON.stringify(afterTodo.rows)}`)
  await ctx.close()
  return `关闭态被叫回；普通块与待办块都按 id 进出（待办状态保持 ${todo.todo}）`
})

await check('T46 从正文块标拖进左槽 ⇒ 钉住并渲染；在槽里编辑，正文同一个块同步（共享 store）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__qua.quiet(true))
  await openFirstPage(page)
  const id = await page.evaluate(() => window.__qua.blocks().find((x) => !(x.roles?.length) && !x.todo && x.text.length > 2)?.id ?? '')
  assert(id, '应有一个可拖的普通块')

  const drag = await dragBlockToDock(page, id, 'left')
  assert(drag, '拖拽事件应能派发到块标与左槽')
  assert(drag.carried === id, `dragover 时 dataTransfer 里应带着块 id：${JSON.stringify(drag)}`)
  assert(drag.hot, '拖拽经过槽时应给出高亮（data-drop-pin）')
  await page.waitForTimeout(140)
  const afterDrag = await dockState(page)
  assert(afterDrag.pref.left.pins.includes(id), `左槽应钉住拖入的块：${JSON.stringify(afterDrag.pref.left.pins)}`)
  assert(afterDrag.rows.left.includes(id), `左槽应渲染该块：${JSON.stringify(afterDrag.rows.left)}`)

  // 在槽里（它的第一个实例）打字 ⇒ 正文同一个块（同一 store 对象）应同步
  const sel = `#dock-left .pin-row[data-block-id="${id}"] > .pin-editor > .blk[data-depth="0"] > .tx`
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

  const sel = `#dock-left .pin-row[data-block-id="${id}"] > .pin-editor > .blk[data-depth="0"] > .tx`
  await page.locator(sel).click()
  await page.keyboard.press('End')
  // 逐键输入：若每键都整槽重画，光标会被重置，最终文本不会是一段连续的串
  await page.keyboard.type('ABC连续')
  await page.waitForTimeout(120)
  const typed = await pinRootText(page, 'left', id)
  assert(typed.includes('ABC连续'), `连续输入应完整落在同一处（整槽重画会打断光标）：${JSON.stringify(typed)}`)
  const focusOk = await page.evaluate((id) => {
    const row = document.querySelector(`#dock-left .pin-row[data-block-id="${id}"]`)
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

await check('T48 祖先也被钉住 ⇒ 只渲染祖先（不重复）；钉住清单随 prefs 落盘，重开后仍在', async () => {
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
  assert(nestedState.pref.right.pins.length === 2, `两块都应记在清单里：${JSON.stringify(nestedState.pref.right.pins)}`)
  assert(
    nestedState.rows.right.length === 1 && nestedState.rows.right[0] === nested.parent,
    `祖先也在清单里时只渲染祖先：${JSON.stringify(nestedState.rows.right)}（父 ${nested.parent}）`,
  )

  const leftId = await page.evaluate(() => window.__qua.blocks().find((x) => !(x.roles?.length) && !x.todo && x.text.length > 2)?.id ?? '')
  await dragBlockToDock(page, leftId, 'left')
  await page.waitForTimeout(400)
  const saved = await dockState(page)
  const reopened = await reopenPage(browser, ctx, base, page)
  await reopened.page.waitForTimeout(220)
  const restored = await reopened.page.evaluate(() => ({
    dock: window.__qua.snapshot().dock,
    left: [...document.querySelectorAll('#dock-left .pin-row')].map((r) => r.dataset.blockId),
    right: [...document.querySelectorAll('#dock-right .pin-row')].map((r) => r.dataset.blockId),
  }))
  await reopened.ctx.close()
  assert(
    JSON.stringify(restored.dock.left.pins) === JSON.stringify(saved.pref.left.pins) &&
      JSON.stringify(restored.dock.right.pins) === JSON.stringify(saved.pref.right.pins),
    `重开后清单应原样回来：\n  before ${JSON.stringify(saved.pref)}\n  after  ${JSON.stringify(restored.dock)}`,
  )
  assert(restored.left.includes(leftId), `重开后左槽应仍渲染钉住的块：${JSON.stringify(restored.left)}`)
  assert(
    restored.right.length === 1 && restored.right[0] === nested.parent,
    `重开后右槽仍只渲染祖先：${JSON.stringify(restored.right)}`,
  )
  await ctx.close()
  return `清单 ${saved.pref.left.pins.length}+${saved.pref.right.pins.length} 项落盘；右槽只画祖先 ${nested.parent.slice(-6)}`
})

await check('T49 钉住行有移除入口：移出槽但不删块；左槽移除后清单与 DOM 同时清干净', async () => {
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
  await page.locator(`#dock-left .pin-row[data-block-id="${picked.id}"] .pin-remove`).click()
  await page.waitForTimeout(140)
  const after = await page.evaluate((id) => ({
    dock: window.__qua.snapshot().dock,
    rows: [...document.querySelectorAll('#dock-left .pin-row')].map((r) => r.dataset.blockId),
    block: window.__qua.blocks().find((b) => b.id === id) ?? null,
    topBlocks: window.__qua.snapshot().topBlocks,
  }), picked.id)
  assert(!after.dock.left.pins.includes(picked.id), `移除后清单里不该还有它：${JSON.stringify(after.dock.left.pins)}`)
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
    head: document.querySelector('#editor > .blk[data-depth="0"]')?.dataset.blockId ?? '',
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
    (tagId) => window.__qua.invoke('core.props/create-def', { blockId: tagId, label: '状态', kind: 'text' }),
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

  // 标签页的属性区显示「声明字段」，但没有给标签块自己设值的输入
  const declared = await page.evaluate(() => ({
    visible: !document.getElementById('properties').hidden,
    labels: [...document.querySelectorAll('.props-declared .prop-name')].map((e) => e.textContent),
    valueInputs: document.querySelectorAll('.props-declared .prop-input').length,
  }))
  assert(declared.visible, '标签页应显示属性区')
  assert(declared.labels.includes('状态'), `声明字段里应有「状态」：${JSON.stringify(declared)}`)
  assert(declared.valueInputs === 0, '声明节没有值输入（值在成员块上）')

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
  // ⚠️ 「任务状态」归 gutter（`_uiPosition: 'block-left'`）⇒ **不进右侧面板**：
  //    同一个值不能有两个编辑面。所以这里看得到的仍只有「状态」那一行。
  await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), hostId)
  await page.waitForTimeout(120)
  const panel = await page.evaluate(() => {
    const row = document.querySelector(`.prop-row[data-prop-id]`)
    return {
      label: row?.querySelector('.prop-name')?.textContent ?? '',
      source: row?.querySelector('.prop-source')?.textContent ?? '',
      value: row?.querySelector('.prop-input')?.value ?? '',
      rows: document.querySelectorAll('.prop-row[data-prop-id]').length,
    }
  })
  assert(panel.rows === 1, `同一 propId 只显示一行，且归 gutter 的不在面板里：${JSON.stringify(panel)}`)
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
      const el = document.querySelector(`.blk[data-block-id="${blockId}"] .tx .tag-chip[data-tag-id="${tagId}"]`)
      return { text: el?.textContent ?? '', read: window.__qua.__editor.readText(blockId) }
    },
    { blockId: hostId, tagId: tag.tagId },
  )
  assert(chip.text === '#任务', `成员块行尾应有一枚 #任务 chip：${JSON.stringify(chip)}`)
  assert(!chip.read.includes('#任务'), `chip 不该进正文读数：${JSON.stringify(chip)}`)

  await ctx.close()
  return `定义 ${defs[0].id.slice(-6)} 被 #任务 声明；成员值「已完成」；行尾 chip ${JSON.stringify(chip.text)} 不进读数`
})

/* ------------------------------------------------- 标签层级（属于 / 包含 / 成员） */

await check('T52 标签层级：属于/包含双面板、成员含算作、禁环、删父留悬空可见', async () => {
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

  // #演员 属于 #人物（子侧写 _parentTags）
  await page.evaluate(
    ({ child, parent }) => window.__qua.invoke('core.tags/add-parent', { childId: child, parentId: parent }),
    { child: tags['演员'], parent: tags['人物'] },
  )
  const rel = await page.evaluate(
    (id) => ({ parents: window.__qua.tagParents(id), children: window.__qua.tagChildren(id) }),
    tags['人物'],
  )
  assert(rel.children.includes(tags['演员']), `#人物 的「包含」应含 #演员：${JSON.stringify(rel)}`)

  // 算作：查 #人物 的成员要含只打 #演员 的 B
  const deep = await page.evaluate((id) => window.__qua.tagMembersDeep(id), tags['人物'])
  assert(deep.includes(ids.b), `#人物 的成员应含只打 #演员 的块（算作）：${JSON.stringify(deep)}`)
  assert(deep.includes(ids.a), '#人物 也应含双打的块')

  // 打开 #人物 页：双面板 ＋ 成员 footer
  await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), tags['人物'])
  await page.waitForTimeout(200)
  const ui = await page.evaluate(() => ({
    visible: !document.getElementById('tagpanel').hidden,
    relations: document.getElementById('tagpanel-relations').textContent ?? '',
    members: document.querySelectorAll('#tagpanel-members-editor .blk').length,
  }))
  assert(ui.visible, '打开标签页应显示 footer')
  assert(ui.relations.includes('包含') && ui.relations.includes('#演员'), `「包含」面板应列 #演员：${ui.relations}`)
  assert(ui.relations.includes('属于'), '「属于」面板也在（两个方向同一块页上并列）')
  assert(ui.members >= 2, `成员 footer 应渲染出成员块（含算作）：${ui.members}`)

  // 算作 ≠ 拥有字段：给 #人物 声明一个字段，只打 #演员 的 B 不获得它
  await page.evaluate(
    (id) => window.__qua.invoke('core.props/create-def', { blockId: id, label: '姓名', kind: 'text' }),
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
    ({ child, parent }) => window.__qua.invoke('core.tags/add-parent', { childId: child, parentId: parent }),
    { child: tags['人物'], parent: tags['演员'] },
  )
  const afterCycle = await page.evaluate(
    (id) => ({ parents: window.__qua.tagParents(id), children: window.__qua.tagChildren(id) }),
    tags['人物'],
  )
  assert(!afterCycle.parents.includes(tags['演员']), `成环写入应被拒绝：${JSON.stringify(afterCycle)}`)
  assert(afterCycle.children.includes(tags['演员']), '原有那条边不能被拒绝的写入改掉')

  // 删父（模拟：直接从森林移除）⇒ 子标签的 ref 留着、面板显示「已删除」、可清理
  const dangling = await page.evaluate((parentId) => {
    const forest = window.__qua.__editor.store.blocks
    const i = forest.findIndex((b) => b.id === parentId)
    if (i < 0) return null
    forest.splice(i, 1)
    window.__qua.__editor.store.invalidateIndex()
    window.__qua.__editor.store.touch()
    window.__qua.invoke('core.block/focus-block', { blockId: window.__qua.allBlocks().find((b) => b.text === '演员')?.id ?? '' })
    return { parents: window.__qua.tagParents(window.__qua.allBlocks().find((b) => b.text === '演员')?.id ?? ''), danglingIds: window.__qua.tagDanglingParents(window.__qua.allBlocks().find((b) => b.text === '演员')?.id ?? '') }
  }, tags['人物'])
  assert(dangling && dangling.danglingIds.length === 1, `删父应留下悬空 ref：${JSON.stringify(dangling)}`)
  await page.waitForTimeout(250)
  const danglingUi = await page.evaluate(() => document.getElementById('tagpanel-relations').textContent ?? '')
  assert(danglingUi.includes('已删除'), `悬空归属应可见：${danglingUi}`)
  assert(danglingUi.includes('清理'), '悬空归属应可清理')

  await ctx.close()
  return `#演员 属于 #人物；#人物 成员含只打 #演员 的块；成环被拒；删父留可见悬空`
})

/* ------------------------------------------------- UI：让一个块成为页 / 标签 */

await check('T53 列表露面：输入名字建标签、同名页兼作标签、标签也作为页、摘标签只摘露面', async () => {
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
  await page.click('#tagpanel-page')
  await page.waitForTimeout(200)
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

  await ctx.close()
  return `新建 #人物（别名＋tag 露面）；页「${reuseName}」兼作标签；#临时 加 page 露面进页列表；摘 tag 只摘露面、名字还在且可撤销`
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
      await page.waitForSelector('.props-form')
    }
    const shape = () =>
      page.evaluate(() => {
        const form = document.querySelector('.props-form')
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
      const o = [...document.querySelectorAll('.props-form .props-pick option')].find((x) => x.value === id)
      return o ? o.textContent : null
    }, defId)
    assert(option !== null, `picker 里应有「评分」这一项：${option}`)
    assert(option.includes('数字'), `已有定义的项要本地化类型（应含「数字」）：${option}`)
    assert(!option.includes('number'), `已有定义的项不该露裸类型名 number：${option}`)

    // ② 选真实定义 ⇒ 只露「用这个」，新建组仍收着
    await page.evaluate((id) => {
      const sel = document.querySelector('.props-form .props-pick')
      sel.value = id
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    }, defId)
    const picked = await shape()
    assert(picked.groupHidden === true && !picked.groupVisible, `选已有属性时新建组仍应收起：${JSON.stringify(picked)}`)
    assert(picked.useVisible, `选已有属性时应露出「用这个」：${JSON.stringify(picked)}`)
    assert(picked.visibleSelects === 1, `选已有属性时类型下拉仍不该出现：${JSON.stringify(picked)}`)

    // 直接派发 DOM click：面板会随焦点变化重建，Playwright 的「等元素稳定」会撞上那次重建
    await page.evaluate(() => document.querySelector('.props-use')?.click())
    await page.waitForTimeout(150)
    // 点按钮后焦点在面板里；把光标放回刚才那块，面板目标仍是它
    await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), hostId)
    await page.waitForTimeout(150)
    const used = await page.evaluate((id) => ({
      form: Boolean(document.querySelector('.props-form')),
      row: Boolean(document.querySelector(`.prop-row[data-prop-id="${id}"]`)),
    }), defId)
    assert(!used.form, `点「用这个」后表单应关闭：${JSON.stringify(used)}`)
    assert(used.row, `面板里应出现「评分」这一行：${JSON.stringify(used)}`)

    // ③ 选哨兵「＋ 新建属性…」⇒ 第二行整组露出来（名字输入 ＋ 7 种类型）
    await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), hostId)
    await page.waitForTimeout(100)
    await open()
    await page.evaluate(() => {
      const sel = document.querySelector('.props-form .props-pick')
      sel.value = '__new__'
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const fresh = await page.evaluate(() => {
      const form = document.querySelector('.props-form')
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
  'T62 已在块上的属性留在 picker 里（灰掉而不是消失），归 gutter 的属性在面板里说清它在哪',
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

    const panel = await page.evaluate((propId) => ({
      rows: [...document.querySelectorAll('.prop-row[data-prop-id]')].map((x) => x.dataset.propId),
      note: [...document.querySelectorAll('.props-empty')].map((x) => x.textContent),
    }), target.defId)
    assert(!panel.rows.includes(target.defId), `归 gutter 的属性不在这里出第二个编辑面：${JSON.stringify(panel)}`)
    assert(panel.note.some((x) => x.includes('任务状态')), `面板要说明它在块左侧：${JSON.stringify(panel)}`)
    assert(!panel.note.some((x) => x.includes('还没有块属性')), `已有属性时不能同时说「还没有块属性」：${JSON.stringify(panel)}`)

    await page.click('#properties-add')
    await page.waitForSelector('.props-form')
    const option = await page.evaluate((propId) => {
      const o = [...document.querySelectorAll('.props-form .props-pick option')].find((x) => x.value === propId)
      return o ? { text: o.textContent, disabled: o.disabled } : null
    }, target.defId)
    assert(option !== null, '已在块上的属性不该从 picker 里消失（那会让小库的下拉变空）')
    assert(option.disabled === true, `已在块上的属性应不可选：${JSON.stringify(option)}`)
    assert(option.text.includes('已在块上'), `要写明为什么不可选：${JSON.stringify(option)}`)

    await ctx.close()
    return `picker 保留「任务状态 · 勾选（已在块上）」且 disabled；面板写明「在块左侧编辑」`
  },
)

await check(
  'T63 `setText` 走一笔事务：正文改掉只发 1 条 upsert{text}（无锚点变化 ⇒ 0 条 anno），一次撤销回得去',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)

    const target = await page.evaluate(() => {
      const ed = window.__qua.__editor
      // 挑一个可编辑的内容块（没角色 ⇒ 不是页/日记/标签这些身份块，正文归它自己）
      const b = ed.doc.roots.flatMap((r) => [r, ...r.children]).find((x) => !(x.roles?.length) && !x.children.length)
      return { id: b?.id ?? '', text: b?.text ?? '', marks: window.__qua.marks().length, atoms: window.__qua.atoms().length }
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
      return {
        ops: ops.map((o) => ({ e: o.e, id: o.id, op: o.op, text: o.value?.text })),
        text: window.__qua.blocks().find((b) => b.id === id)?.text ?? '',
        // 只取正文：带标签的块在正文之后还有 chip，`textContent` 会把 `#名` 也读进来
        dom:
          [...(document.querySelector(`.blk[data-block-id="${id}"] .tx`)?.childNodes ?? [])]
            .filter((n) => !(n instanceof Element && n.classList.contains('tag-chip')))
            .map((n) => n.textContent)
            .join('') || '',
        marks: window.__qua.marks().length,
        atoms: atoms.length,
        dupAtoms: atoms.length - new Set(atoms).size,
      }
    }, target.id)
    await page.waitForTimeout(120)

    const upserts = after.ops.filter((o) => o.e === 'block' && o.op === 'upsert')
    const annos = after.ops.filter((o) => o.e === 'anno')
    assert(after.ops.length === 1, `一次 setText 只该产 1 条 op：${JSON.stringify(after.ops)}`)
    assert(upserts.length === 1 && upserts[0].text === '改过的字', `那一条应是 block.upsert{text}：${JSON.stringify(upserts)}`)
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
      text: window.__qua.__editor.doc.roots.flatMap((r) => [r, ...r.children]).map((b) => b.text),
    }))
    assert(back.text.includes(target.text), `一次撤销应回到原文「${target.text}」：${JSON.stringify(back.text)}`)
    assert(!back.text.includes('改过的字'), `撤销后不该还留着新正文：${JSON.stringify(back.text)}`)

    await ctx.close()
    return `setText ⇒ ops=[block.upsert{text}]（1 条，0 条 anno）；正文/DOM 同步改；⌘Z 回原文`
  },
)

await check(
  'T64 真实键入也走一笔事务：打一个普通字只发 1 条 upsert{text}（无锚点变化 ⇒ 0 条 anno），一次撤销回得去',
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
      const b = ed
        .rows()
        .map((r) => r.block)
        .find((x) => !(x.roles?.length) && !x.children.length && !(x.props?._tags?.length))
      return { id: b?.id ?? '', text: b?.text ?? '' }
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
        ops: window.__qua.lastOps().map((o) => ({ e: o.e, id: o.id ?? o.block, op: o.op, text: o.value?.text })),
        text: b?.text ?? '',
        // 读数与模型同一口径（`readText` 跳过 chip）；另留一份 DOM 原样，便于失败时看出差在哪
        measured: ed.readText(id),
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
    assert(upserts.length === 1 && upserts[0].text === after.text, `那一条应是 block.upsert{text}：${JSON.stringify(upserts)}`)
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
        text: live?.text ?? null,
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
  'T65 `insertBlockAfter` 走一笔事务：插一块只发 1 条 upsert{parent,index}（落点由事务算，不是 splice 出来再报）；空块 + 待办只发 1 条 prop.set；一次撤销回得去',
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
      const b = ed
        .rows()
        .map((r) => r.block)
        .find((x) => x.text !== '' && !(x.roles?.length) && parentOf(x.id) !== null)
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
          if (b.id === newId && b.text === '插一块') inModel = true
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
    assert(upsert.value?.index === target.index + 1, `下标应是原块之后：${JSON.stringify(upsert.value)}（期望 ${target.index + 1}）`)
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
      assert(todo.ops.length === 1, `空块 + 待办只该产 1 条 op：${JSON.stringify(todo.ops)}`)
      assert(propSets.length === 1, `那一条应是 prop.set：${JSON.stringify(todo.ops)}`)
      assert(structOps.length === 0, `空块 + 待办不该发结构 op：${JSON.stringify(structOps)}`)
      assert(todo.bools.length === 1 && todo.bools[0] === false, `块上应落一个「未完成」的任务状态值：${JSON.stringify(todo.bools)}`)
    }

    await ctx.close()
    return todo.skipped
      ? 'insertBlockAfter ⇒ ops=[block.upsert{parent,index}]（1 条，落点＝原块之后）；⌘Z 回原样。空块+待办分支本页没有空块，跳过'
      : 'insertBlockAfter ⇒ ops=[block.upsert{parent,index}]（1 条，落点＝原块之后）；⌘Z 回原样；空块 + /待办 ⇒ ops=[prop.set]（1 条，0 条结构 op）'
  },
)

await check(
  'T66 块中 Enter（split 支）走一笔事务：恰好 2 条 op（左半 upsert{parent,index} ＋ 原块 upsert{text}），一次撤销回得去',
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
      const b = ed
        .rows()
        .map((r) => r.block)
        .find(
          (x) =>
            x.text.length >= 4 &&
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
        text: b?.text ?? '',
        parentId: parent?.id ?? '',
        index: parent ? parent.children.findIndex((k) => k.id === b.id) : -1,
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
      const live = ed.store.find(t.id)
      const parent = ed.store.find(t.parentId)
      const kids = (parent?.children ?? []).map((b) => ({ id: b.id, text: b.text }))
      let total = 0
      const walk = (list) => {
        for (const b of list) {
          total++
          walk(b.children)
        }
      }
      walk(ed.store.blocks)
      return {
        ops: window.__qua.lastOps().map((o) => ({ e: o.e, id: o.id ?? o.block, op: o.op, value: o.value })),
        text: live?.text ?? '',
        kids,
        total,
        // `doc` 是装载窗口：新块也必须在它里面（`tx.insert` 改的是共享的兄弟数组）
        rows: ed.rows().map((r) => ({ id: r.block.id, text: r.block.text })),
        // 这两块都没有锚点 ⇒ `textContent` 就是正文
        domText: [...document.querySelectorAll('.blk .tx')].map((el) => el.textContent ?? ''),
      }
    }, target)

    const textOps = after.ops.filter((o) => o.e === 'block' && o.op === 'upsert' && o.value?.text !== undefined)
    const structOps = after.ops.filter((o) => o.e === 'block' && o.op === 'upsert' && o.value?.parent !== undefined)
    assert(after.ops.length === 2, `块中 Enter 只该产 2 条 op（正文一半 ＋ 结构一块）：${JSON.stringify(after.ops)}`)
    assert(textOps.length === 1, `应恰有 1 条 upsert{text}：${JSON.stringify(after.ops)}`)
    assert(textOps[0].id === target.id, `正文那一条应指向原块（它保 id）：${JSON.stringify(textOps[0])}`)
    assert(
      textOps[0].value.text === target.text.slice(2),
      `原块应只留右半：期望「${target.text.slice(2)}」，实际「${textOps[0].value.text}」`,
    )
    assert(structOps.length === 1, `应恰有 1 条 upsert{parent,index}：${JSON.stringify(after.ops)}`)
    assert(structOps[0].id !== target.id, '结构那一条应指向左半新块')
    assert(
      structOps[0].value.parent === target.parentId,
      `左半的父应是「${target.parentId}」，实际「${structOps[0].value.parent}」`,
    )
    assert(
      structOps[0].value.index === target.index,
      `左半应插在原 index 之前（原块顺延到它下面）：期望 ${target.index}，实际 ${structOps[0].value.index}`,
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
      return { text: ed.store.find(t.id)?.text ?? null, gone, total }
    }, { id: target.id, leftId: structOps[0].id })
    assert(back.text === target.text, `一次撤销应回到整块原文「${target.text}」：${JSON.stringify(back)}`)
    assert(back.gone, '一次撤销后左半新块应不在模型里')
    assert(back.total === target.before, `一次撤销块数应回原样：${target.before}，实际 ${back.total}`)

    await ctx.close()
    return `块中 Enter ⇒ ops=[upsert{parent,index}, upsert{text}]（2 条）；原块=右半、左半占原位；⌘Z 回原样`
  },
)

await check(
  'T67 真实键入 `#不存在的标签` 走同一笔事务：正文 upsert ＋ 新标签块 upsert{parent:null} ＋ 归属 prop.set ＋ 原子 anno.set 同批；一次撤销连标签块一起回滚',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)

    /**
     * 挑一个**可编辑的内容块**（无子块、无标签、无锚点）：往它末尾敲一段新的是最干净的输入面。
     * 前面留一个空格 ⇒ `#` 前面不是字，才会被认成标签语法（`a#b` 不是标签）。
     */
    const before = await page.evaluate(() => {
      const ed = window.__qua.__editor
      const b = ed
        .rows()
        .map((r) => r.block)
        .find((x) => !(x.roles?.length) && !x.children.length && !(x.props?._tags?.length))
      const count = (list) => list.reduce((n, k) => n + 1 + count(k.children), 0)
      return {
        id: b?.id ?? '',
        text: b?.text ?? '',
        total: count(ed.store.blocks),
        tags: ed.store.blocks.filter((x) => (x.props?._lists ?? []).includes('tag')).length,
      }
    })
    assert(before.id !== '', '第一页里应有可编辑的内容块')
    await page.waitForTimeout(120)

    // 真按键（走 `input` → `syncFromDom`）：末尾空格是**分隔符**，到这一刻才认 `#zzz` 敲完
    await page.evaluate((id) => window.__qua.focusBlock(id, 9999), before.id)
    await page.keyboard.type(' #zzz ')
    await page.waitForTimeout(150)

    const after = await page.evaluate((t) => {
      const ed = window.__qua.__editor
      const live = ed.store.find(t.id)
      const ops = window.__qua.lastOps()
      const tagOp = ops.find((o) => o.e === 'block' && o.op === 'upsert' && o.value?.parent === null)
      const tagId = tagOp?.id ?? ''
      const tag = tagId ? ed.store.find(tagId) : undefined
      return {
        ops: ops.map((o) => ({
          e: o.e,
          id: o.id ?? o.block ?? '',
          block: o.block ?? '',
          op: o.op,
          name: o.name ?? '',
          text: o.value?.text,
          parent: o.value && 'parent' in o.value ? o.value.parent : undefined,
          annoKind: o.e === 'anno' ? (o.value?.kind ?? '') : '',
          annoTarget: o.e === 'anno' ? (o.value?.target?.id ?? '') : '',
        })),
        tagId,
        tagExists: Boolean(tag),
        tagLists: tag?.props?._lists ?? [],
        tagAlias: tag?.props?._aliases?.[0] ?? '',
        text: live?.text ?? '',
        tags: live?.props?._tags ?? [],
        atoms: ed.atoms.filter((a) => a.blockId === t.id).map((a) => ({ kind: a.kind, target: a.target?.id ?? '' })),
      }
    }, before)

    const textOps = after.ops.filter((o) => o.e === 'block' && o.op === 'upsert' && o.text !== undefined)
    const tagBlockOps = after.ops.filter((o) => o.e === 'block' && o.op === 'upsert' && o.parent === null)
    const tagPropOps = after.ops.filter((o) => o.e === 'prop' && o.name === '_tags' && o.op === 'set')
    const tagAnnoOps = after.ops.filter((o) => o.e === 'anno' && o.op === 'set' && o.annoKind === 'tag')

    assert(textOps.length >= 1, `应至少 1 条 block.upsert{text}：${JSON.stringify(after.ops)}`)
    assert(textOps.some((o) => o.id === before.id), `正文那条应指向被敲的块：${JSON.stringify(textOps)}`)
    assert(tagBlockOps.length === 1, `应恰有 1 条新标签块的 upsert{parent:null}：${JSON.stringify(after.ops)}`)
    assert(tagPropOps.length === 1, `应恰有 1 条 prop.set{_tags}：${JSON.stringify(after.ops)}`)
    assert(tagPropOps[0].id === before.id, `归属应写在被敲的块上：${JSON.stringify(tagPropOps[0])}`)
    assert(tagAnnoOps.length === 1, `应恰有 1 条 tag 原子的 anno.set：${JSON.stringify(after.ops)}`)
    assert(
      tagAnnoOps[0].block === before.id && tagAnnoOps[0].annoTarget === after.tagId,
      `原子应落在被敲块上、指向新建的标签块：${JSON.stringify(tagAnnoOps[0])}`,
    )

    // 模型：标签块真在库里、块上真有归属、正文里真有原子
    assert(after.tagExists, `新标签块应真的进了库：${JSON.stringify(after.tagId)}`)
    assert(after.tagAlias === 'zzz', `标签块的名字应是 zzz：${JSON.stringify(after.tagAlias)}`)
    assert(after.tagLists.includes('tag'), `新块应有 tag 露面位：${JSON.stringify(after.tagLists)}`)
    assert(after.tags.includes(after.tagId), `块上的 _tags 应含新标签：${JSON.stringify(after.tags)}`)
    assert(
      after.atoms.some((a) => a.kind === 'tag' && a.target === after.tagId),
      `正文里应有一枚指向它的 tag 原子：${JSON.stringify(after.atoms)}`,
    )
    assert(
      after.text === `${before.text} \uFFFC `,
      `模型正文应是「前缀 ＋ 空格 ＋ 1 格原子 ＋ 空格」：${JSON.stringify(after.text)}`,
    )

    // 一次撤销：正文、原子、归属、**标签块本身**都回到输入前
    await page.evaluate(() => window.__qua.invoke('core.history/undo'))
    await page.waitForTimeout(220)
    const back = await page.evaluate((t) => {
      const ed = window.__qua.__editor
      const live = ed.store.find(t.id)
      const count = (list) => list.reduce((n, k) => n + 1 + count(k.children), 0)
      return {
        text: live?.text ?? null,
        tags: live?.props?._tags ?? null,
        tagGone: ed.store.find(t.tagId) === undefined,
        atoms: ed.atoms.filter((a) => a.blockId === t.id).length,
        total: count(ed.store.blocks),
        tagCount: ed.store.blocks.filter((x) => (x.props?._lists ?? []).includes('tag')).length,
      }
    }, { id: before.id, tagId: after.tagId })

    assert(back.text === before.text, `一次撤销应回到输入前的正文「${before.text}」：${JSON.stringify(back.text)}`)
    assert(back.tagGone, '一次撤销后新建的标签块应不在模型里')
    assert(!(back.tags ?? []).includes(after.tagId), `一次撤销后归属应回滚：${JSON.stringify(back.tags)}`)
    assert(back.atoms === 0, `一次撤销后正文里的 tag 原子应回滚：剩 ${back.atoms} 条`)
    assert(back.total === before.total, `一次撤销块数应回原样：${before.total}，实际 ${back.total}`)
    assert(back.tagCount === before.tags, `标签块数应回原样：${before.tags}，实际 ${back.tagCount}`)

    await ctx.close()
    return `键入「 #zzz 」⇒ 同一笔：upsert{text}×${textOps.length} ＋ 新标签 upsert{parent:null} ＋ prop.set{_tags} ＋ anno.set{tag}；⌘Z 连标签块一起回滚`
  },
)

await check(
  'T68 缩进／反缩进／上下换位各走一笔事务：每次恰好 1 条 upsert{parent,index}，一次撤销复原',
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

    const depthOf = (id) =>
      page.evaluate(
        (id) => Number(document.querySelector(`.blk[data-block-id="${id}"]`)?.dataset.depth ?? -1),
        id,
      )
    const ops = () =>
      page.evaluate(() => window.__qua.lastOps().map((o) => ({ e: o.e, id: o.id, op: o.op, value: o.value })))

    /** 一次结构移动的 op 形状：恰好一条 upsert{parent,index}，不带正文、不带属性 */
    const oneMove = (list, want) => {
      assert(list.length === 1, `应恰好 1 条 op：${JSON.stringify(list)}`)
      assert(list[0].e === 'block' && list[0].id === pick.id && list[0].op === 'upsert', `应是一条 block.upsert：${JSON.stringify(list)}`)
      const v = list[0].value ?? {}
      assert(
        Object.keys(v).length === 2 && v.parent !== undefined && v.index !== undefined,
        `只该带 {parent,index}（不带正文/属性）：${JSON.stringify(v)}`,
      )
      assert(v.parent === want.parentId, `父块应是「${want.parentId}」，实际「${v.parent}」`)
      assert(v.index === want.index, `下标应是 ${want.index}，实际 ${v.index}`)
    }

    // ① Tab 缩进：变前兄弟的最后一个孩子（落点 ＝ 前兄弟此刻的子块数）
    await page.evaluate((p) => window.__qua.focusBlock(p.id, 1), pick)
    await page.keyboard.press('Tab')
    await page.waitForTimeout(180)
    oneMove(await ops(), { parentId: prev, index: prevStart.kids })
    const afterIndent = await pos(pick.id)
    assert(
      afterIndent.parentId === prev && afterIndent.index === prevStart.kids,
      `缩进后应挂在前兄弟的孩子末尾：${JSON.stringify(afterIndent)}（期望 ${prev}#${prevStart.kids}）`,
    )
    assert((await depthOf(pick.id)) === pick.depth + 1, `DOM 深度应 +1：${pick.depth} → ${await depthOf(pick.id)}`)

    // ② Shift+Tab 反缩进：变父的下一个兄弟 ⇒ 回到原位
    await page.keyboard.press('Shift+Tab')
    await page.waitForTimeout(180)
    oneMove(await ops(), { parentId: start.parentId, index: prevStart.index + 1 })
    const afterOutdent = await pos(pick.id)
    assert(
      afterOutdent.parentId === start.parentId && afterOutdent.index === start.index,
      `反缩进应回到原位：${JSON.stringify(start)} → ${JSON.stringify(afterOutdent)}`,
    )
    assert((await depthOf(pick.id)) === pick.depth, `DOM 深度应回原样：${await depthOf(pick.id)}`)

    // ③ ⌘⇧↑ 上移一位：同层换位，仍是一条 move
    await page.keyboard.press('Meta+Shift+ArrowUp')
    await page.waitForTimeout(180)
    oneMove(await ops(), { parentId: start.parentId, index: start.index - 1 })
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
    return `缩进/反缩进/上移 ⇒ 各 1 条 upsert{parent,index}（父块与下标都随模型真值）；⌘Z 回原位`
  },
)

await check(
  'T69 删块走一笔事务：操作根恰好 1 条 block.delete；可见读全部消失，块带标记留在森林原位（原位软删），一次撤销复原',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)

    /**
     * 挑一个**叶子内容块**（无子块、无身份、无锚点）：子树只有它自己 ⇒ op 数可精确断言；
     * 没有锚点 ⇒ `syncAnchors` 不会在断言之外动 marks/atoms。
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
        ops: window.__qua.lastOps().map((o) => ({ e: o.e, id: o.id, op: o.op })),
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
      after.ops[0].e === 'block' && after.ops[0].id === pick.id && after.ops[0].op === 'delete',
      `应是一条 block.delete 指向被删块：${JSON.stringify(after.ops)}`,
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
        ops: window.__qua.lastOps().map((o) => ({ e: o.e, id: o.id, op: o.op })),
        pages: window.__qua.pages().length,
        pageGone: ed.store.find(t.pageId) === undefined,
        kidGone: ed.store.find(t.kidId) === undefined,
        pageMarked: page ? Boolean(page.props?._deletedAt) : false,
        kids: page ? page.children.map((b) => b.id) : [],
      }
    }, created)

    const deletes = after.ops.filter((o) => o.e === 'block' && o.op === 'delete').map((o) => o.id)
    assert(
      after.ops.length === 1 && deletes[0] === created.pageId,
      `删页应恰好 1 条 block.delete（操作根；子树的不可见是继承的）：${JSON.stringify(after.ops)}`,
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
  'T71 退格合并走一笔事务：正文 upsert ×2（前块拼接＋空壳清空）＋ 子块逐个 move ＋ block.delete，一次撤销连子块复原',
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
      const writable = (b) => !b.props?._date && !b.props?._kind && !b.props?._query
      for (let i = 1; i < rows.length; i++) {
        const cur = rows[i].block
        const prev = rows[i - 1].block
        if (cur.children.length < 1 || !cur.text || !writable(prev)) continue
        if (marks.some((m) => m.blockId === cur.id) || atoms.some((a) => a.blockId === cur.id)) continue
        return {
          id: cur.id,
          text: cur.text,
          kids: cur.children.map((k) => k.id),
          prevId: prev.id,
          prevText: prev.text,
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
      const prev = ed.store.find(t.prevId)
      // 含被删块的遍历：被并块是**原位标记**的空壳
      let husk = null
      const walk = (list) => {
        for (const b of list) {
          if (b.id === t.id) husk = { marked: Boolean(b.props?._deletedAt), text: b.text, kids: b.children.length }
          walk(b.children)
        }
      }
      walk(ed.store.blocks)
      return {
        ops: window.__qua.lastOps().map((o) => ({ e: o.e, id: o.id, op: o.op, value: o.value })),
        gone: ed.store.find(t.id) === undefined,
        prevText: prev?.text ?? null,
        prevKids: (prev?.children ?? []).map((b) => b.id),
        husk,
      }
    }, pick)

    const textOps = after.ops.filter((o) => o.e === 'block' && o.op === 'upsert' && o.value?.text !== undefined)
    const moveOps = after.ops.filter((o) => o.e === 'block' && o.op === 'upsert' && o.value?.parent !== undefined)
    const delOps = after.ops.filter((o) => o.e === 'block' && o.op === 'delete')

    // 两条正文 upsert：前一块拼接 ＋ 被并块空壳清空（删除是原位标记，壳留在树上）
    assert(textOps.length === 2, `应恰有 2 条正文 upsert（前块拼接＋空壳清空）：${JSON.stringify(after.ops)}`)
    assert(textOps[0].id === pick.prevId, `正文应写进前一块「${pick.prevId}」：${JSON.stringify(textOps[0])}`)
    const huskOp = textOps.find((o) => o.id === pick.id)
    assert(huskOp && huskOp.value.text === '', `被并块空壳应清空：${JSON.stringify(huskOp)}`)
    assert(
      textOps[0].value.text === pick.prevText + pick.text,
      `前一块应变成「前文＋被并块」：${JSON.stringify(textOps[0].value.text)}`,
    )
    assert(moveOps.length === pick.kids.length, `子块应逐个 move（${pick.kids.length} 条）：${JSON.stringify(after.ops)}`)
    for (const [n, kid] of pick.kids.entries()) {
      const op = moveOps.find((o) => o.id === kid)
      assert(op, `子块 ${kid} 应有自己的 move op：${JSON.stringify(moveOps)}`)
      assert(op.value.parent === pick.prevId, `子块应挂到前一块下：${JSON.stringify(op)}`)
      assert(op.value.index === pick.prevKids + n, `子块落点应是 ${pick.prevKids + n}：${JSON.stringify(op.value)}`)
    }
    assert(delOps.length === 1 && delOps[0].id === pick.id, `被并块应有 1 条 block.delete：${JSON.stringify(delOps)}`)
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
      const prev = ed.store.find(t.prevId)
      let cur = null
      let total = 0
      const walk = (list, parent) => {
        list.forEach((b, i) => {
          total++
          if (b.id === t.id) cur = { parentId: parent?.id ?? null, index: i, text: b.text, kids: b.children.map((k) => k.id) }
          walk(b.children, b)
        })
      }
      walk(ed.store.blocks, null)
      return { prevText: prev?.text ?? null, cur, total, dom: Boolean(document.querySelector(`.blk[data-block-id="${t.id}"]`)) }
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
  'T72 退格合并把锚点搬到前一块：区间整体后移前一块原长，被并块不留锚点',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)

    /** 挑一个**带锚点**的块（mark 或 atom），且文档序前一块可写 */
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
    assert(target, '第一页里应有「带锚点、前一块可写」的块')

    await page.evaluate((id) => window.__qua.focusBlock(id, 0), target.id)
    /**
     * **聚焦之后再取锚点**：落光标会裁剪越界锚点（`pruneToText`），拿聚焦前的偏移
     * 去比撤销快照，会得到一个「撤销后对不上」的假红。
     */
    const pick = await page.evaluate((t) => {
      const ed = window.__qua.__editor
      const prev = ed.store.find(t.prevId)
      return {
        ...t,
        prevText: prev?.text ?? '',
        marks: ed.store.marks
          .filter((x) => x.blockId === t.id)
          .map(({ id, type, start, end }) => ({ id, type, start, end })),
        atoms: ed.store.atoms.filter((x) => x.blockId === t.id).map(({ id, start, end }) => ({ id, start, end })),
      }
    }, target)
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(200)

    const after = await page.evaluate((t) => {
      const ed = window.__qua.__editor
      return {
        ops: window.__qua.lastOps().map((o) => ({ e: o.e, block: o.block, id: o.id, op: o.op })),
        marks: ed.store.marks.map(({ id, type, blockId, start, end }) => ({ id, type, blockId, start, end })),
        atoms: ed.store.atoms.map(({ id, blockId, start, end }) => ({ id, blockId, start, end })),
      }
    }, pick)

    const shift = pick.prevText.length
    for (const m of pick.marks) {
      // `normalizeMarks` 会把同类型、接壤的区间并成一条 ⇒ 用「覆盖范围」判，不认 id
      const got = after.marks.find(
        (x) => x.blockId === pick.prevId && x.type === m.type && x.start <= m.start + shift && x.end >= m.end + shift,
      )
      assert(got, `mark ${m.id} 应搬到前一块并覆盖 [${m.start + shift},${m.end + shift})：${JSON.stringify(after.marks)}`)
    }
    for (const a of pick.atoms) {
      const got = after.atoms.find((x) => x.id === a.id)
      assert(got, `atom ${a.id} 应还在`)
      assert(got.blockId === pick.prevId, `atom ${a.id} 应落到前一块：${JSON.stringify(got)}`)
      assert(
        got.start === a.start + shift && got.end === a.end + shift,
        `atom ${a.id} 区间应整体后移 ${shift}：${JSON.stringify(a)} → ${JSON.stringify(got)}`,
      )
    }
    assert(!after.atoms.some((x) => x.blockId === pick.id), '被并块上不该留下锚点')
    assert(!after.marks.some((x) => x.blockId === pick.id), '被并块上不该留下 mark')

    const annoDels = after.ops.filter((o) => o.e === 'anno' && o.op === 'delete')
    assert(
      annoDels.length === pick.marks.length + pick.atoms.length,
      `被并块这边每个锚点各一条 anno.delete：${JSON.stringify(after.ops)}`,
    )

    await page.evaluate(() => window.__qua.invoke('core.history/undo'))
    await page.waitForTimeout(200)
    const back = await page.evaluate((t) => {
      const ed = window.__qua.__editor
      return {
        marks: ed.store.marks.filter((x) => x.blockId === t.id).map(({ id, start, end }) => ({ id, start, end })),
        atoms: ed.store.atoms.filter((x) => x.blockId === t.id).map(({ id, start, end }) => ({ id, start, end })),
      }
    }, pick)
    assert(
      JSON.stringify(back.marks.map((m) => [m.id, m.start, m.end]).sort()) ===
        JSON.stringify(pick.marks.map((m) => [m.id, m.start, m.end]).sort()),
      `一次撤销 mark 应回原块原位：undo 后 ${JSON.stringify(back.marks)}，合并前 ${JSON.stringify(pick.marks)}`,
    )
    assert(
      JSON.stringify(back.atoms.map((a) => [a.id, a.start, a.end]).sort()) ===
        JSON.stringify(pick.atoms.map((a) => [a.id, a.start, a.end]).sort()),
      `一次撤销 atom 应回原块原位：undo 后 ${JSON.stringify(back.atoms)}，合并前 ${JSON.stringify(pick.atoms)}`,
    )

    await ctx.close()
    return `合并搬锚点：${pick.marks.length} mark ＋ ${pick.atoms.length} atom 整体后移 ${shift}；anno.set/delete 各一条；⌘Z 回原位`
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
      return { id: r.id, text: r.text, kids: r.children.length }
    })
    await page.evaluate((id) => window.__qua.focusBlock(id, 0), root.id)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(180)
    const pageEnter = await page.evaluate((t) => {
      const ed = window.__qua.__editor
      const r = ed.store.find(t.id)
      return {
        ops: window.__qua.lastOps().map((o) => ({ e: o.e, id: o.id, op: o.op, value: o.value })),
        text: r?.text ?? null,
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
    assert(op0.value.parent === root.id && op0.value.index === 0, `落点应是根的第 0 位：${JSON.stringify(op0.value)}`)
    assert(pageEnter.text === root.text, '根正文不该被切开（有身份的根只插空子块）')
    assert(pageEnter.kids === root.kids + 1, `子块数应 +1：${root.kids} → ${pageEnter.kids}`)

    // ② 内容根（zoom 进来的一块）：块中 Enter ⇒ 左半留根、右半成首个子块
    const inner = await page.evaluate(() => {
      const ed = window.__qua.__editor
      // 找一个正文 ≥ 4 字、无身份的子孙块，聚焦它（focus-block 会把它装成唯一根）
      let hit = null
      const walk = (list) => {
        for (const b of list) {
          if (hit) return
          const identity = Boolean(b.props?._lists?.length || b.props?._aliases?.length || b.props?._date || b.props?._kind || b.props?._query)
          if (!identity && b.text.length >= 4) {
            hit = { id: b.id, text: b.text }
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
      return {
        ops: window.__qua.lastOps().map((o) => ({ e: o.e, id: o.id, op: o.op, value: o.value })),
        text: r?.text ?? null,
        firstKid: r?.children[0]?.id ?? '',
        firstKidText: r?.children[0]?.text ?? null,
      }
    }, inner)

    const textOps = contentEnter.ops.filter((o) => o.e === 'block' && o.op === 'upsert' && o.value?.text !== undefined)
    const moveOps = contentEnter.ops.filter((o) => o.e === 'block' && o.op === 'upsert' && o.value?.parent !== undefined)
    assert(
      textOps.length === 1 && moveOps.length === 1,
      `内容根块中拆应 2 条结构 op（其余只该是锚点跟右半走）：${JSON.stringify(contentEnter.ops)}`,
    )
    assert(textOps.length === 1 && textOps[0].id === inner.id, `原块应留左半：${JSON.stringify(textOps)}`)
    assert(textOps[0].value.text === inner.text.slice(0, 2), `左半应是「${inner.text.slice(0, 2)}」：${JSON.stringify(textOps[0].value.text)}`)
    assert(moveOps.length === 1 && moveOps[0].id === contentEnter.firstKid, `应插一个新首个子块：${JSON.stringify(moveOps)}`)
    assert(moveOps[0].value.parent === inner.id && moveOps[0].value.index === 0, `落点应是根的第 0 位：${JSON.stringify(moveOps[0].value)}`)
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
      for (const r of rows) {
        const b = r.block
        if (!r.parentId || b.text.length < 8) continue
        if (b.props?._lists?.length || b.props?._aliases?.length) continue
        if (marks.some((m) => m.blockId === b.id) || atoms.some((a) => a.blockId === b.id)) continue
        return { id: b.id, parentId: r.parentId, text: b.text, kidsBefore: 0 }
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
      const r = ed.store.find(t.id)
      const parent = ed.store.find(t.parentId)
      const i = parent?.children.findIndex((b) => b.id === t.id) ?? -1
      return {
        ops: window.__qua.lastOps().map((o) => ({ e: o.e, id: o.id, op: o.op, value: o.value })),
        text: r?.text ?? null,
        sibling: i > 0 ? (parent?.children[i - 1]?.text ?? null) : null,
        dom: [...document.querySelectorAll('.blk .tx')].map((el) => el.textContent ?? ''),
      }
    }, pick)

    const textOps = after.ops.filter((o) => o.e === 'block' && o.op === 'upsert' && o.value?.text !== undefined)
    const insertOps = after.ops.filter((o) => o.e === 'block' && o.op === 'upsert' && o.value?.parent !== undefined)
    assert(after.ops.length === 2, `删选区 + 拆应合成 2 条 op（没有单独的删除 op）：${JSON.stringify(after.ops)}`)
    assert(textOps.length === 1 && textOps[0].id === pick.id, `原块应只写一次正文：${JSON.stringify(textOps)}`)
    assert(
      textOps[0].value.text === pick.text.slice(4),
      `原块应保选区之后的右半「${pick.text.slice(4)}」：${JSON.stringify(textOps[0].value.text)}`,
    )
    assert(insertOps.length === 1, `左半应是一条插入：${JSON.stringify(insertOps)}`)
    assert(insertOps[0].value.parent === pick.parentId, '左半应与原块同级')
    assert(after.text === pick.text.slice(4), '模型里原块应是右半')
    assert(after.sibling === pick.text.slice(0, 2), `左半应是选区之前那截「${pick.text.slice(0, 2)}」：${JSON.stringify(after.sibling)}`)
    assert(after.dom.includes(pick.text.slice(0, 2)), 'DOM 应重画出左半')
    assert(after.dom.includes(pick.text.slice(4)), 'DOM 应重画出右半')

    await page.evaluate(() => window.__qua.invoke('core.history/undo'))
    await page.waitForTimeout(200)
    const back = await page.evaluate((t) => {
      const ed = window.__qua.__editor
      const r = ed.store.find(t.id)
      const parent = ed.store.find(t.parentId)
      return { text: r?.text ?? null, kids: parent?.children.length ?? 0 }
    }, pick)
    assert(back.text === pick.text, `一次撤销应回到整块原文：${JSON.stringify(back.text)}`)
    assert(back.kids === pick.kidsBefore, `块数应复原：${pick.kidsBefore} → ${back.kids}`)

    await ctx.close()
    return `选区 [2,4) + Enter ⇒ ops=[插入左半, 正文右半]（2 条，无单独删除）；⌘Z 回原文`
  },
)

await check(
  'T75 行尾 `#标签` + Enter 同一笔：转换（建标签/归属/原子）与结构拆分一起落，一次撤销全回滚',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)

    /** 挑一个非根、无子块、无标签的可编辑内容块：行尾敲标签再回车 */
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
      return b ? { id: b.block.id, parentId: b.parentId, text: b.block.text } : null
    })
    assert(pick, '第一页里应有可编辑的内容块')
    pick.kidsBefore = await page.evaluate(
      (t) => window.__qua.__editor.store.find(t.parentId)?.children.length ?? 0,
      pick,
    )

    await page.evaluate((id) => window.__qua.focusBlock(id, 9999), pick.id)
    await page.keyboard.type(' #回车标签')
    await page.waitForTimeout(120)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(220)

    const after = await page.evaluate((t) => {
      const ed = window.__qua.__editor
      const live = ed.store.find(t.id)
      const ops = window.__qua.lastOps()
      const tagOp = ops.find((o) => o.e === 'block' && o.op === 'upsert' && o.value?.parent === null)
      const tagId = tagOp?.id ?? ''
      const tag = tagId ? ed.store.find(tagId) : undefined
      const parent = ed.store.find(t.parentId)
      const i = parent?.children.findIndex((b) => b.id === t.id) ?? -1
      return {
        ops: ops.map((o) => ({
          e: o.e,
          id: o.id,
          op: o.op,
          text: o.value?.text,
          parent: o.value && 'parent' in o.value ? o.value.parent : undefined,
          name: o.name ?? '',
          annoKind: o.e === 'anno' ? (o.value?.kind ?? '') : '',
        })),
        text: live?.text ?? null,
        tags: live?.props?._tags ?? [],
        nextText: i >= 0 ? (parent?.children[i + 1]?.text ?? null) : null,
        tagExists: Boolean(tag),
        tagAlias: tag?.props?._aliases?.[0] ?? '',
      }
    }, pick)

    const textOps = after.ops.filter((o) => o.e === 'block' && o.op === 'upsert' && o.text !== undefined)
    const tagBlockOps = after.ops.filter((o) => o.e === 'block' && o.op === 'upsert' && o.parent === null)
    const tagPropOps = after.ops.filter((o) => o.e === 'prop' && o.name === '_tags' && o.op === 'set')
    const tagAnnoOps = after.ops.filter((o) => o.e === 'anno' && o.op === 'set' && o.annoKind === 'tag')
    const structOps = after.ops.filter((o) => o.e === 'block' && o.op === 'upsert' && typeof o.parent === 'string')

    assert(tagBlockOps.length === 1, `同一笔里应建出标签块：${JSON.stringify(after.ops)}`)
    assert(tagPropOps.length === 1, `同一笔里应写归属：${JSON.stringify(after.ops)}`)
    assert(tagAnnoOps.length === 1, `同一笔里应插 tag 原子：${JSON.stringify(after.ops)}`)
    assert(textOps.length === 1, `正文应只写一次（转换后带原子）：${JSON.stringify(after.ops)}`)
    assert(structOps.length === 1, `结构拆分应是同一笔里的 1 条插入：${JSON.stringify(after.ops)}`)
    assert(after.ops.length === 5, `总计应是 5 条（正文＋标签块＋归属＋原子＋结构）：${JSON.stringify(after.ops)}`)
    assert(after.tagExists && after.tagAlias === '回车标签', `标签块应真的建出来：${JSON.stringify(after)}`)
    assert(after.tags.includes(tagBlockOps[0].id), `归属应含新标签：${JSON.stringify(after.tags)}`)
    assert(after.text === `${pick.text} \uFFFC`, `正文应是「前缀＋空格＋1 格原子」：${JSON.stringify(after.text)}`)
    assert(after.nextText === '', `光标所在块之后应多出一个空块（Enter 的结构那一半）：${JSON.stringify(after.nextText)}`)

    await page.evaluate(() => window.__qua.invoke('core.history/undo'))
    await page.waitForTimeout(220)
    const back = await page.evaluate((t) => {
      const ed = window.__qua.__editor
      const live = ed.store.find(t.id)
      const parent = ed.store.find(t.parentId)
      return {
        text: live?.text ?? null,
        tags: live?.props?._tags ?? null,
        atoms: ed.atoms.filter((a) => a.blockId === t.id).length,
        tagGone: ed.store.find(t.tagId) === undefined,
        kids: parent?.children.length ?? 0,
      }
    }, { ...pick, tagId: tagBlockOps[0].id })
    assert(
      back.text === pick.text + ' #回车标签',
      `一次撤销应回到「敲完标签、还没回车」的正文：${JSON.stringify(back.text)}`,
    )
    assert(!(back.tags ?? []).length && back.atoms === 0, `归属与原子应回滚：${JSON.stringify(back)}`)
    assert(back.tagGone, '一次撤销后新建的标签块应消失')
    assert(back.kids === pick.kidsBefore, `结构拆分也应回滚：${pick.kidsBefore} → ${back.kids}`)

    await ctx.close()
    return `「 #回车标签」+ Enter ⇒ 同一笔 5 条 op（正文/标签块/归属/原子/结构）；⌘Z 全回滚`
  },
)

await check(
  'T76 新建页走一笔事务：页块与空首子块同一笔进库，恰好 2 条 upsert（页{parent:null,index:n}＋子块{parent:pageId,index:0}）；真关重开后页与子块都还在；页数 +1',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    const before = await page.evaluate(() => ({
      pages: window.__qua.pages().length,
      // 根数要用**森林根**：`blocks()` 返回的是装载文档的平铺，不是顶层
      roots: window.__qua.snapshot().topBlocks,
    }))

    await page.evaluate(() => window.__qua.invoke('core.page/new'))
    await page.waitForTimeout(200)

    const created = await page.evaluate(() => {
      const ops = window.__qua.lastOps()
      const pageOp = ops.find((o) => o.e === 'block' && o.op === 'upsert' && o.value?.parent === null)
      const childOp = ops.find((o) => o.e === 'block' && o.op === 'upsert' && o.value?.parent === pageOp?.id)
      // 用真模型取子树：诊断面的 `blocks()` 里 `children` 是数量，不是数组
      const page = window.__qua.__editor.store.find(pageOp?.id)
      return {
        ops: ops.map((o) => ({ e: o.e, id: o.id, op: o.op, parent: o.value?.parent, index: o.value?.index })),
        pageId: pageOp?.id ?? '',
        childId: childOp?.id ?? '',
        pages: window.__qua.pages().length,
        modelChild: page?.children[0]?.id ?? '',
      }
    })

    assert(created.ops.length === 2, `新建一页应恰好 2 条 op：${JSON.stringify(created.ops)}`)
    assert(
      created.ops.every((o) => o.e === 'block' && o.op === 'upsert'),
      `两条都应是 block.upsert（结构写不许零 op 直写）：${JSON.stringify(created.ops)}`,
    )
    assert(created.pageId !== '', `应有页块自己的 upsert{parent:null}：${JSON.stringify(created.ops)}`)
    assert(
      created.ops.find((o) => o.id === created.pageId)?.index === before.roots,
      `页块应插在根列表末尾（index=${before.roots}）：${JSON.stringify(created.ops)}`,
    )
    assert(
      created.childId !== '' &&
        created.ops.find((o) => o.id === created.childId)?.parent === created.pageId &&
        created.ops.find((o) => o.id === created.childId)?.index === 0,
      `空首子块应报它自己的落点 {parent:pageId,index:0}：${JSON.stringify(created.ops)}`,
    )
    assert(created.modelChild === created.childId, '模型里子块应真的挂在页下')
    assert(created.pages === before.pages + 1, `页数应 +1：${before.pages} → ${created.pages}`)

    // 真关重开（reload 不算「关掉重开」）：页与子块必须还真的在库里
    const reopened = await reopenPage(browser, ctx, base, page)
    const after = await reopened.page.evaluate((t) => {
      // 用真模型取：诊断面的 `blocks()` 里 `children` 是数量，读不出子块 id
      const p = window.__qua.__editor.store.find(t.pageId)
      return { page: Boolean(p), child: p?.children[0]?.id ?? '', pages: window.__qua.pages().length }
    }, created)
    await reopened.ctx.close()
    await ctx.close()
    assert(after.page, '重开后页应还在库里')
    assert(after.child === created.childId, `重开后空首子块应还在页下：${JSON.stringify(after)}`)
    assert(after.pages === created.pages, `重开后页数应不变：${created.pages} → ${after.pages}`)

    return `新建页 ⇒ 恰好 2 条 upsert（页{parent:null,index:${before.roots}}＋子块{parent:页,index:0}）；页数 ${before.pages}→${created.pages}；真关重开两者仍在`
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
    const r = rows.find((x) => !x.b.children.length && x.b.text.length >= 6 && !(x.b.props?._tags?.length))
    return r ? { id: r.b.id, parentId: r.parentId, index: r.index, text: r.b.text } : null
  })
/** 任务 B 共用：op 的可断言投影（block 统一取「这块是谁」；anno 另取锚点 id） */
const opShape = (page) =>
  page.evaluate(() =>
    window.__qua.lastOps().map((o) => ({
      e: o.e,
      block: o.block ?? o.id ?? '',
      aid: o.e === 'anno' ? (o.id ?? '') : '',
      op: o.op,
      name: o.name ?? '',
      value: o.value,
      parent: o.value?.parent,
      index: o.value?.index,
      text: o.value?.text,
      kind: o.value?.kind ?? '',
      type: o.value?.type ?? '',
    })),
  )

await check(
  'T77 切换待办走一笔事务：恰好 1 条 prop.set（任务状态槽，首切＝false），一次撤销回无槽',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)
    const target = await pickLeaf(page)
    assert(target, '第一页里应有可编辑的内容块')

    await page.evaluate((id) => window.__qua.__editor.toggleTodo(id), target.id)
    await page.waitForTimeout(120)
    const ops = await opShape(page)
    assert(ops.length === 1, `切换待办应恰好 1 条 op：${JSON.stringify(ops)}`)
    assert(
      ops[0].e === 'prop' && ops[0].op === 'set' && ops[0].block === target.id && ops[0].value === false,
      `那一条应是任务状态槽的 prop.set（首切＝未完成 false）：${JSON.stringify(ops)}`,
    )
    const propName = ops[0].name

    await page.evaluate(() => window.__qua.invoke('core.history/undo'))
    await page.waitForTimeout(150)
    const back = await page.evaluate((t) => window.__qua.__editor.store.find(t.id)?.props ?? null, target)
    assert(!back || !(propName in back), `一次撤销应回到没有任务槽：${JSON.stringify(back)}`)

    await ctx.close()
    return `toggleTodo ⇒ 1 条 prop.set{${propName}:false}；⌘Z 回无槽`
  },
)

await check(
  'T78 加粗走一笔事务：只有 anno.set、零 block op，一次撤销格式消失',
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
      ops[0].e === 'anno' && ops[0].op === 'set' && ops[0].block === target.id && ops[0].type === 'bold',
      `那一条应是 anno.set{bold}：${JSON.stringify(ops)}`,
    )

    await page.evaluate(() => window.__qua.invoke('core.history/undo'))
    await page.waitForTimeout(150)
    const back = await page.evaluate((t) => window.__qua.marks().filter((m) => m.blockId === t.id).length, target)
    assert(back === 0, `一次撤销后这块应没有锚点：${back}`)

    await ctx.close()
    return `toggleMark ⇒ 1 条 anno.set{bold}（0 条 block op）；⌘Z 格式消失`
  },
)

await check(
  'T79 清格式走一笔事务：只有 anno.delete、零 block op，一次撤销格式回来',
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
      ops[0].e === 'anno' && ops[0].op === 'delete' && ops[0].block === target.id,
      `那一条应是 anno.delete：${JSON.stringify(ops)}`,
    )

    await page.evaluate(() => window.__qua.invoke('core.history/undo'))
    await page.waitForTimeout(150)
    const back = await page.evaluate((t) => window.__qua.marks().filter((m) => m.blockId === t.id).length, target)
    assert(back === 1, `一次撤销后粗体应回来：${back}`)

    await ctx.close()
    return `clearMarksAtSel ⇒ 1 条 anno.delete（0 条 block op）；⌘Z 格式回来`
  },
)

await check(
  'T80 插行内原子走一笔事务：正文 1 条 upsert ＋ 原子 1 条 anno.set，一次撤销两半一起回滚',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)
    const target = await pickLeaf(page)
    assert(target, '第一页里应有可编辑的内容块')

    await page.evaluate((id) => window.__qua.focusBlock(id, 9999), target.id)
    await page.evaluate(
      (t) => window.__qua.__editor.insertAtom('tag', { label: '冒烟原子', target: { kind: 'block', id: t.id } }),
      target,
    )
    await page.waitForTimeout(120)
    const ops = await opShape(page)
    assert(ops.length === 2, `插原子应恰好 2 条 op：${JSON.stringify(ops)}`)
    assert(
      ops[0].e === 'block' && ops[0].op === 'upsert' && ops[0].block === target.id && ops[0].text?.includes('\uFFFC'),
      `第一条应是正文 upsert（带占位格）：${JSON.stringify(ops)}`,
    )
    assert(
      ops[1].e === 'anno' && ops[1].op === 'set' && ops[1].block === target.id && ops[1].kind === 'tag',
      `第二条应是原子的 anno.set：${JSON.stringify(ops)}`,
    )

    await page.evaluate(() => window.__qua.invoke('core.history/undo'))
    await page.waitForTimeout(150)
    const back = await page.evaluate((t) => {
      const b = window.__qua.__editor.store.find(t.id)
      return { text: b?.text ?? '', atoms: window.__qua.atoms().filter((a) => a.blockId === t.id).length }
    }, target)
    assert(!back.text.includes('\uFFFC') && back.atoms === 0, `一次撤销应回原文、原子注销：${JSON.stringify(back)}`)

    await ctx.close()
    return `insertAtom ⇒ [正文 upsert｛含⌷｝, anno.set{tag}]；⌘Z 两半一起回滚`
  },
)

await check(
  'T81 删行内原子走一笔事务：正文 1 条 upsert ＋ 原子 1 条 anno.delete，一次撤销复原',
  async () => {
    const { ctx, page } = await freshPage(browser, base)
    await page.evaluate(() => window.__qua.quiet(true))
    await openFirstPage(page)
    const target = await pickLeaf(page)
    assert(target, '第一页里应有可编辑的内容块')

    // 前置：插一枚原子（setup 的 op 不参与断言）
    await page.evaluate((id) => window.__qua.focusBlock(id, 9999), target.id)
    const atomId = await page.evaluate(
      (t) => window.__qua.__editor.insertAtom('tag', { label: '待删原子', target: { kind: 'block', id: t.id } }),
      target,
    )
    assert(atomId, '前置：原子应建出来')
    await page.waitForTimeout(120)

    await page.evaluate((id) => window.__qua.__editor.removeAtom(id), atomId)
    await page.waitForTimeout(120)
    const ops = await opShape(page)
    assert(ops.length === 2, `删原子应恰好 2 条 op：${JSON.stringify(ops)}`)
    assert(
      ops[0].e === 'block' && ops[0].op === 'upsert' && !ops[0].text?.includes('\uFFFC'),
      `第一条应是正文 upsert（占位格没了）：${JSON.stringify(ops)}`,
    )
    assert(ops[1].e === 'anno' && ops[1].op === 'delete' && ops[1].value?.id === atomId, `第二条应是 anno.delete：${JSON.stringify(ops)}`)

    await page.evaluate(() => window.__qua.invoke('core.history/undo'))
    await page.waitForTimeout(150)
    const back = await page.evaluate((t) => {
      const b = window.__qua.__editor.store.find(t.id)
      return { text: b?.text ?? '', atoms: window.__qua.atoms().filter((a) => a.blockId === t.id).length }
    }, target)
    assert(back.text.includes('\uFFFC') && back.atoms === 1, `一次撤销应回占位格、原子复活：${JSON.stringify(back)}`)

    await ctx.close()
    return `removeAtom ⇒ [正文 upsert, anno.delete]；⌘Z 复原`
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
    assert(ops1.length === 2, `新标签应恰好 2 条 op：${JSON.stringify(ops1)}`)
    assert(
      ops1[0].e === 'block' && ops1[0].op === 'upsert' && ops1[0].parent === null,
      `第一条应是标签块 upsert{parent:null}：${JSON.stringify(ops1)}`,
    )
    assert(
      ops1[1].e === 'prop' && ops1[1].op === 'set' && ops1[1].block === a.id && Array.isArray(ops1[1].value),
      `第二条应是归属 prop.set：${JSON.stringify(ops1)}`,
    )
    const tagId = ops1[1].value[0]
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
      ops[0].e === 'prop' && ops[0].op === 'set' && ops[0].block === target.id && Array.isArray(ops[0].value) && ops[0].value.length === 0,
      `那一条应是 _tags 清空的 prop.set：${JSON.stringify(ops)}`,
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
      ops[0].e === 'block' && ops[0].op === 'upsert' && ops[0].parent === tail.rootId && ops[0].index === tail.index + 1,
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
  'T85 插分割线走同一笔事务：空块原地改类型＝1 条 prop.set；有内容＝同一笔 2 条 insert；各自一次撤销复原',
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
    assert(ops1.length === 1, `空块变线应恰好 1 条 op：${JSON.stringify(ops1)}`)
    assert(
      ops1[0].e === 'prop' && ops1[0].op === 'set' && ops1[0].block === blankId && ops1[0].name === '_type' && ops1[0].value === 'core/divider',
      `那一条应是 _type=core/divider 的 prop.set：${JSON.stringify(ops1)}`,
    )
    await page.evaluate(() => window.__qua.invoke('core.history/undo'))
    await page.waitForTimeout(150)
    const backType = await page.evaluate((id) => window.__qua.__editor.store.find(id)?.props?._type ?? null, blankId)
    assert(backType === null, `一次撤销应回到没有类型：${JSON.stringify(backType)}`)

    // ② 有内容 ⇒ 线 ＋ 空块，同一笔 2 条 insert
    await page.evaluate((t) => window.__qua.__editor.insertDividerAfter(t.id), target)
    await page.waitForTimeout(120)
    const ops2 = await opShape(page)
    assert(ops2.length === 2, `有内容插线应恰好 2 条 op：${JSON.stringify(ops2)}`)
    assert(
      ops2.every((o) => o.e === 'block' && o.op === 'upsert' && o.parent === target.parentId),
      `两条都应是同级的 insert：${JSON.stringify(ops2)}`,
    )
    assert(ops2[0].index === target.index + 1 && ops2[1].index === target.index + 2, `线与空块应紧跟着源块：${JSON.stringify(ops2)}`)
    const madeIds = [ops2[0].block, ops2[1].block]
    await page.evaluate(() => window.__qua.invoke('core.history/undo'))
    await page.waitForTimeout(150)
    const gone = await page.evaluate((ids) => ids.every((id) => window.__qua.__editor.store.find(id) === undefined), madeIds)
    assert(gone, `一次撤销后线与空块都应消失：${JSON.stringify(madeIds)}`)

    await ctx.close()
    return `insertDividerAfter ⇒ 空块 [prop.set _type]；有内容 [insert, insert]；各自 ⌘Z 复原`
  },
)

await check(
  'T86 复制块走一笔事务：克隆子树每块 1 条 upsert（自己的落点）＋ 克隆的锚点 anno.set；源块与别的块的锚点不动；一次撤销全滚回',
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
    assert(ops.length === 2, `复制叶子应恰好 2 条 op（结构＋克隆锚点）：${JSON.stringify(ops)}`)
    assert(
      ops[0].e === 'block' && ops[0].op === 'upsert' && ops[0].parent === target.parentId,
      `第一条应是克隆块自己的落点：${JSON.stringify(ops)}`,
    )
    assert(
      ops[1].e === 'anno' && ops[1].op === 'set' && ops[1].block === ops[0].block && ops[1].type === 'bold',
      `第二条应是克隆块上的 anno.set：${JSON.stringify(ops)}`,
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
    return `duplicate ⇒ [克隆 upsert{自己落点}, 克隆锚点 anno.set]；源/别块锚点不动；⌘Z 全滚回`
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
      ops.every((o) => o.e === 'block' && o.op === 'delete' && (o.block === made.a || o.block === made.b)),
      `两条都应是这两块的 block.delete：${JSON.stringify(ops)}`,
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
  'T88 粘贴走同一笔事务：单行＝1 条正文 upsert；多行＝正文 1 ＋ 每行 1 条 insert；各一次撤销复原',
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
    const back1 = await page.evaluate((t) => window.__qua.__editor.store.find(t.id)?.text ?? '', target)
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
      ops2.slice(1).every((o, i) => o.e === 'block' && o.op === 'upsert' && o.parent === target.parentId && o.index === target.index + 1 + i),
      `其余行应逐块 insert、落点递增：${JSON.stringify(ops2)}`,
    )
    const kids = await page.evaluate((t) => {
      const p = window.__qua.__editor.store.find(t.parentId)
      const i = p?.children.findIndex((x) => x.id === t.id) ?? -1
      return { one: p?.children[i + 1]?.text ?? '', two: p?.children[i + 2]?.text ?? '' }
    }, target)
    assert(kids.one === '乙行' && kids.two === '丙行', `新块应真的挂出来：${JSON.stringify(kids)}`)

    await page.evaluate(() => window.__qua.invoke('core.history/undo'))
    await page.waitForTimeout(150)
    const back2 = await page.evaluate((t) => {
      const p = window.__qua.__editor.store.find(t.parentId)
      const i = p?.children.findIndex((x) => x.id === t.id) ?? -1
      return {
        text: window.__qua.__editor.store.find(t.id)?.text ?? '',
        next: p?.children[i + 1]?.text ?? '',
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
        ops: window.__qua.lastOps().map((o) => ({ e: o.e, id: o.id, op: o.op, parent: o.value?.parent, index: o.value?.index })),
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
      first.ops[0].parent === first.dayId && first.ops[0].index === 0,
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
      const host = st.find(t.id)
      const tagBlock = st.blocks.find((b) => b.props?._lists?.includes('tag') && b.text === '冒烟新标签')
      return {
        ops: window.__qua.lastOps().map((o) => ({ e: o.e, id: o.id ?? o.block, op: o.op, name: o.name, parent: o.value?.parent })),
        hostTags: host?.props?._tags ?? [],
        tagId: tagBlock?.id ?? '',
        tagAtTop: st.blocks.some((b) => b.id === tagBlock?.id),
      }
    }, target)

    assert(
      after.ops.length === 2 &&
        after.ops[0].e === 'block' && after.ops[0].op === 'upsert' && after.ops[0].parent === null &&
        after.ops[1].e === 'prop' && after.ops[1].name === '_tags' && after.ops[1].id === target.id,
      `一次打标签应恰好 2 条 op（建标签块＋写归属，同一笔）：${JSON.stringify(after.ops)}`,
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
      const host = st.find(t.id)
      return {
        hostTags: host?.props?._tags ?? [],
        tagGone: !st.blocks.some((b) => b.text === '冒烟新标签'),
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

    await page.evaluate((t) => window.__qua.invoke('core.props/create-def', { blockId: t, label: '冒烟字段', kind: 'text' }), target)
    await page.waitForTimeout(200)

    const after = await page.evaluate((t) => {
      const st = window.__qua.__editor.store
      const def = st.blocks.find((b) => b.text === '冒烟字段')
      const host = st.find(t)
      return {
        ops: window.__qua.lastOps().map((o) => ({ e: o.e, id: o.id ?? o.block, op: o.op, name: o.name, parent: o.value?.parent })),
        defId: def?.id ?? '',
        defAtTop: st.blocks.some((b) => b.id === def?.id),
        declared: host?.props?._fields ?? host?.props?._ownProps ?? null,
      }
    }, target)

    assert(after.defId !== '' && after.defAtTop, `定义块应在库顶层：${JSON.stringify(after)}`)
    assert(
      after.ops.length === 2 &&
        after.ops[0].e === 'block' && after.ops[0].op === 'upsert' && after.ops[0].parent === null &&
        after.ops[1].e === 'prop' && after.ops[1].op === 'set' && after.ops[1].id === target,
      `新建定义＋声明应是同一笔恰好 2 条 op（upsert{parent:null} ＋ prop.set）：${JSON.stringify(after.ops)}`,
    )

    await ctx.close()
    return `createPropDef ⇒ [upsert{parent:null}, prop.set]；定义块住顶层`
  },
)

/* ---------------------------------------------------------------- 汇总 */

await browser.close()
if (server) server.close()

console.log('')
let fail = 0
for (const r of results) {
  console.log(`${r.ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m'}  ${r.name}`)
  if (r.msg) console.log(`      ${String(r.msg).replace(/\n/g, '\n      ')}`)
  if (!r.ok) fail++
}
console.log(`\n${results.length - fail}/${results.length} 通过\n`)
process.exit(fail === 0 ? 0 : 1)
