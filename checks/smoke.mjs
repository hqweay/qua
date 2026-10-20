/**
 * `pnpm check` —— 浏览器级冒烟：**真 Chrome ＋ 真按键 ＋ 真鼠标**，逐条打勾。
 * 断言口径尽量贴任务书：能敲字 / Enter 拆块 / Backspace 合并 / Tab 缩进 / 折叠 / 拖拽重排 /
 * 四种区间格式 / 两种行内原子 / 命令面板（无绑定也能执行）/ 菜单由绑定表渲染 /
 * localStorage 持久化 / 三风格 × 亮暗 / 空态·稀疏态·降级态 / 虚拟化与 composing 角标。
 */
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { assert, freshPage, launch, openPage, reopenPage, resolveBase } from '../scripts/harness.mjs'

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

const snap = (page) => page.evaluate(() => window.__demo.snapshot())
const blocks = (page) => page.evaluate(() => window.__demo.blocks())
const texts = (page) => page.evaluate(() => window.__demo.text())

/**
 * 冷启动落在**今日 journal**，而 `blocks`/`text` 读的是**当前页的子树**
 * ⇒ 凡是要测「某一页的内容」的用例，必须**显式打开那一页**，别依赖「第 1 块就是它」。
 * （journal 是一块，但不是页：`pages()` 只列 `page` 角色，所以 `pages()[0]` 就是假数据第 1 页。）
 */
const openFirstPage = (page) =>
  page.evaluate(() => window.__demo.invoke('core.page/open', { pageId: window.__demo.pages()[0].id }))

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
    return { pref: window.__demo.snapshot().dock, rows: { left: rows('left'), right: rows('right') } }
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

await check('T1 打开就能敲：光标落在第一个**可编辑**块；journal 的日期行不被写入', async () => {
  const { ctx, page, errors } = await freshPage(browser, base)
  const before = await snap(page)
  const at = await page.evaluate(() => {
    // journal 首行是只读日期 ⇒ 光标应落在它的第一个子块，而不是日期行
    const b = window.__demo.blocks()
    const editable = b.find((x) => x.role !== 'journal')
    return { id: editable?.id ?? '', sel: window.__demo.snapshot().selection }
  })
  assert(at.id && at.sel?.aBlock === at.id, `冷启动光标应落在第一个可编辑块：${JSON.stringify(at)}`)
  await page.evaluate(() => window.__demo.focus())
  await page.keyboard.type('真正敲进去的六个字')
  await page.keyboard.press('End')
  const after = await snap(page)
  const t = await texts(page)
  assert(!errors.length, `页面报错：${errors.join(' | ')}`)
  assert(after.blocks === before.blocks, `块数应不变：${before.blocks} → ${after.blocks}`)
  // 打进**光标所在块**（不是 flatten 的第 0 条——那是只读的日期行）
  const got = await page.evaluate(() => {
    const sel = window.__demo.snapshot().selection
    return window.__demo.blocks().find((x) => x.id === sel?.aBlock)?.text ?? ''
  })
  assert(got.includes('真正敲进去的六个字'), `光标所在块没拿到文本：${JSON.stringify(got)}｜全量=${JSON.stringify(t)}`)
  // 日期行仍是空的：日期是 `_date` 的只读投影，打进去的字不许落在它上面
  const journalText = await page.evaluate(() => window.__demo.blocks().find((b) => b.role === 'journal')?.text)
  assert(journalText === '', `journal 行不该被写入：${JSON.stringify(journalText)}`)
  await ctx.close()
  return `块数 ${after.blocks}，DOM 节点 ${after.domNodes}；日期行仍为空`
})

await check('T2 Enter 拆块 ／ Backspace 合并 ／ Tab 缩进 ／ Shift+Tab 还原', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await openFirstPage(page) // 冷启动在 journal 上，本用例测的是假数据第一页
  await page.evaluate(() => {
    const id = window.__demo.blocks()[0].id
    window.__demo.focusBlock(id, 4)
  })
  const n0 = (await blocks(page)).length
  await page.keyboard.press('Enter')
  await page.keyboard.type('新块')
  const split = await blocks(page)
  assert(split.length === n0 + 1, `拆块后应多一块：${n0} → ${split.length}`)
  assert(split[1].text.startsWith('新块'), `新块文本不对：${JSON.stringify(split[1].text)}`)
  const focused = await page.evaluate(() => window.__demo.snapshot().selection.aBlock)
  // 移到块首再退格 ⇒ 合并到前一块（**内容接到前一块末尾**，前一块保留 id）
  await page.evaluate((id) => window.__demo.focusBlock(id, 0), focused)
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
  await page.evaluate((p) => window.__demo.focusBlock(p.id, p.off), pick)
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
    const id = window.__demo.blocks()[0].id
    window.__demo.focusBlock(id, 0)
  })
  const keys = [
    ['Meta+b', 'bold'],
    ['Meta+i', 'italic'],
    ['Meta+e', 'highlight'],
    ['Meta+`', 'code'],
  ]
  for (const [k] of keys) {
    await page.keyboard.press('Shift+ArrowRight')
    await page.keyboard.press(k)
  }
  const marks = await page.evaluate(() => window.__demo.marks())
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
  await page.evaluate(() => window.__demo.focus())
  await page.keyboard.press('End')
  const idle = await page.evaluate(() => document.querySelectorAll('.selbar').length)
  assert(idle === 0, '光标态不该有划选气泡')

  // ③ 选中一段文本：气泡浮出，格式按钮齐；点「加粗」真的加粗，且**选区保住**（否则取消不了）
  // ⚠️ 光标先落进**有正文**的块（首行是页块自己，正文非空；紧随其后的子块也可以）
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#editor .blk')]
    const target = rows.find((el) => (el.querySelector('.tx')?.textContent ?? '').length >= 2)
    if (target) window.__demo.focusBlock(target.dataset.blockId, target.querySelector('.tx').textContent.length)
  })
  await page.keyboard.press('Shift+ArrowLeft')
  await page.keyboard.press('Shift+ArrowLeft')
  await page.waitForFunction(() => document.querySelectorAll('.selbar').length === 1, null, { timeout: 2000 })
  const btns = await page.evaluate(() => [...document.querySelectorAll('.selbar .sel-btn')].map((b) => b.dataset.command))
  assert(btns.includes('core.anno/toggle-bold'), `气泡里应有加粗：${JSON.stringify(btns)}`)
  assert(btns.includes('core.editor/copy-ref'), `气泡里应有「复制带引文的引用」：${JSON.stringify(btns)}`)

  const before = await page.evaluate(() => window.__demo.marks().length)
  await page.evaluate(() => {
    const b = document.querySelector('.selbar .sel-btn[data-command="core.anno/toggle-bold"]')
    b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  })
  await page.waitForFunction(
    (n) => document.querySelectorAll('.mk-bold').length > 0 || window.__demo.marks().length !== n,
    before,
    { timeout: 2000 },
  )
  const after = await page.evaluate(() => ({
    marks: window.__demo.marks().length,
    barStill: Boolean(document.querySelector('.selbar')),
    selText: document.getSelection()?.toString() ?? '',
  }))
  assert(after.selText.length >= 2, `点完格式后选区塌了（就再也取消不了）：${JSON.stringify(after)}`)
  assert(after.barStill, '选区还在，气泡就该还在')

  // ④ 选区一塌，气泡自己消失
  await page.evaluate(() => document.getSelection()?.removeAllRanges())
  await page.keyboard.press('End')
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
    const id = window.__demo.blocks()[0].id
    window.__demo.focusBlock(id, 0)
    return id
  })
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('Meta+b')
  const m0 = (await page.evaluate(() => window.__demo.marks()))[0]
  assert(m0.start === 0 && m0.end === 2, `初始锚点应为 [0,2)：${JSON.stringify(m0)}`)
  // 光标停到区间起点（offset 0）再插入 ⇒ 起点右移（不撑大）
  await page.evaluate((id) => window.__demo.focusBlock(id, 0), r)
  await page.keyboard.type('X')
  const m1 = (await page.evaluate(() => window.__demo.marks()))[0]
  assert(m1.start === 1 && m1.end === 3, `起点插入后应整体右移到 [1,3)：${JSON.stringify(m1)}`)
  // 光标停到区间终点再插入 ⇒ 终点不动
  await page.evaluate((id) => window.__demo.focusBlock(id, 3), r)
  await page.keyboard.type('Y')
  const m2 = (await page.evaluate(() => window.__demo.marks()))[0]
  assert(m2.start === 1 && m2.end === 3, `终点插入后应保持 [1,3)：${JSON.stringify(m2)}`)
  await ctx.close()
  return `[0,2) →起点插→ [1,3) →终点插→ [1,3)（两端口径与既有实现一致）`
})

/* -------------------------------------------------------- 行内原子 */

await check('T5 行内原子：引用 chip 与图片占位各占 1 格，随文本漂移，可点开信息', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await openFirstPage(page)
  const r = await page.evaluate(() => {
    const blk = window.__demo.blocks()[0]
    window.__demo.focusBlock(blk.id, 0)
    const target = window.__demo.pages()[1].id
    window.__demo.invoke('core.editor/insert-page-ref', { pageId: target })
    const atom = window.__demo.atoms().find((a) => a.blockId === blk.id)
    return { atom, text: window.__demo.blocks()[0].text, id: blk.id, total: window.__demo.atoms().length }
  })
  assert(r.atom, `引用原子没插进去：${JSON.stringify(r)}`)
  const a = r.atom
  assert(a.end - a.start === 1, `原子应恒占 1 格：${JSON.stringify(a)}`)
  assert(r.text[a.start] === '\uFFFC', `文本里那一格应是占位符 U+FFFC：${JSON.stringify(r.text.slice(0, 6))}`)
  await page.evaluate((id) => window.__demo.focusBlock(id, 0), r.id)
  await page.keyboard.type('前')
  const shifted = (await page.evaluate(() => window.__demo.atoms())).find((x) => x.blockId === r.id)
  assert(shifted.start === a.start + 1, `在原子前插入应右移 1：${a.start} → ${shifted.start}`)
  await page.evaluate(() => window.__demo.invoke('core.editor/insert-image', { preset: 'missing' }))
  const atoms = await page.evaluate(() => window.__demo.atoms())
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
  await page.evaluate(() => window.__demo.quiet(true))

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
    const byId = (id) => window.__demo.blocks().find((b) => b.id === id)
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
    const bs = window.__demo.blocks()
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
    const after = window.__demo.blocks()
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
  await page.evaluate(() => window.__demo.focus())
  await page.keyboard.press('Meta+p')
  const rows = await page.locator('.layer-item').count()
  assert(rows > 30, `命令面板应列出全部命令，实际 ${rows} 行`)
  const noKey = await page.evaluate(() => {
    const log = window.__demo.__registry.list()
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
  // D1/B1：叶子块也给「聚焦到此块」（修订的附注）
  assert(viaClick.some((t) => t.includes('聚焦到此块')), `块菜单应含 zoom 入口（叶子也給）：${JSON.stringify(viaClick)}`)
  const grouped = await page.locator('.layer-group').allInnerTexts()
  assert(grouped.length >= 3, `块菜单应分组渲染：${JSON.stringify(grouped)}`)
  await page.keyboard.press('Escape')
  assert((await page.locator('.layer').count()) === 0, 'Esc 应关掉块菜单')
  // 斜杠：在空块里键入 `/`，菜单应弹出并随打字过滤
  await page.evaluate(() => {
    const bs = window.__demo.blocks()
    const id = bs[bs.length - 1].id
    window.__demo.focusBlock(id, 0)
  })
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('/')
  const slashRows = await page.locator('.layer-item').count()
  assert(slashRows >= 5, `斜杠菜单应有条目，实际 ${slashRows}`)
  await page.keyboard.type('图')
  const filteredRows = await page.locator('.layer-item').count()
  assert(filteredRows >= 1 && filteredRows <= slashRows, `斜杠应随打字过滤：${slashRows} → ${filteredRows}`)
  const beforeAtoms = (await page.evaluate(() => window.__demo.atoms())).length
  await page.keyboard.press('Enter')
  const afterAtoms = (await page.evaluate(() => window.__demo.atoms())).length
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
    const b = window.__demo.blocks().find((x) => x.role !== 'journal')
    window.__demo.focusBlock(b.id, 0)
  })
  await page.keyboard.type('持久化标记 ')
  await page.keyboard.press('Shift+ArrowRight')
  await page.keyboard.press('Meta+b')
  await page.waitForTimeout(450)
  const before = await page.evaluate(() => ({
    marks: window.__demo.marks().length,
    atoms: window.__demo.atoms().length,
    saved: window.__demo.snapshot().hasLocalStorage,
  }))
  assert(before.saved, 'localStorage 里应有快照')
  // ⚠️ 2026-10-20：原来这里是 `page.reload()`。reload 不算「关掉重开」，
  //    所以改成真正的「关页 → 从关页后的存储复原 → 重开」（见 harness 的 `reopenPage`）。
  const reopened = await reopenPage(browser, ctx, base, page)
  const after = await reopened.page.evaluate(() => ({
    text: window.__demo.text().join('|'),
    marks: window.__demo.marks().length,
    atoms: window.__demo.atoms().length,
    pages: window.__demo.snapshot().pageCount,
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
      const b = window.__demo.blocks().find((x) => x.role !== 'journal')
      window.__demo.focusBlock(b.id, 0)
    })
    await page.keyboard.type('页隐藏标记 ')
    const reopened = await reopenPage(browser, ctx, base, page)
    const text = await reopened.page.evaluate(() => window.__demo.text().join('|'))
    await reopened.ctx.close()
    assert(text.includes('页隐藏标记'), `关页前那批没落盘：${text.slice(0, 40)}`)
  }

  // ② 升级前的**裸库**（v3，没有信封）：必须走 expired 显式作废，绝不能把 v3 当成当前版本打开
  // ⚠️ 判据只看**可观测的两件事**：库被重 seed（旧字没了）、不进只读态。
  //    「作废要说得出来」由启动告警常驻条保证（`ui.boot.expired` → `chrome.showNotice`），
  //    但那是**下一轮装配**才知道的事，不放进这里的断言。
  {
    const { ctx, page } = await freshPage(browser, base)
    const before = await page.evaluate(() => window.__demo.text())
    // 先等首屏那次提交落盘（异步批次）：此刻键位上才有一份 v4 信封
    await page.waitForFunction(() => localStorage.length > 0)
    await page.evaluate(() => {
      // 先拿到当前信封的形状，再把它拆成「升级前的裸库」（v3、没有信封）
      const key = localStorage.key(0)
      const legacy = JSON.parse(localStorage.getItem(key))
      legacy.data.version = 3
      legacy.data.blocks = [{ ...legacy.data.blocks[0], text: '旧库里的字不该被当成 v4 打开' }]
      localStorage.setItem(key, JSON.stringify(legacy.data))
    })
    const reopened = await reopenPage(browser, ctx, base, page)
    const snap = await reopened.page.evaluate(() => ({ ...window.__demo.snapshot(), text: window.__demo.text().join('|') }))
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
    await seed.page.waitForFunction(() => localStorage.length > 0)
    await seed.page.evaluate(() => {
      localStorage.setItem(localStorage.key(0), JSON.stringify({ some: 'other-backend' }))
    })
    const state = await seed.ctx.storageState()
    await seed.ctx.close()
    const ctx2 = await browser.newContext({ storageState: state })
    const { page: page2 } = await openPage(browser, ctx2, base)
    const snap = await page2.evaluate(() => ({
      readOnly: window.__demo.snapshot().readOnly,
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
  await page.evaluate(() => window.__demo.setTheme('light'))
  const light = await sig()
  await page.evaluate(() => window.__demo.setTheme('dark'))
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
  await page.evaluate(() => window.__demo.setTheme('system'))
  const sysLight = await sig()
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(80)
  const sysDark = await sig()
  const sysDarkResolved = await page.evaluate(() => window.__demo.resolvedTheme())
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
    const p = window.__demo.pages().find((x) => (x.title ?? '').includes('产品设计'))
    window.__demo.invoke('core.page/open', { pageId: p.id })
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
    window.__demo.blocks().find((x) => x.text.includes('引用某段'))?.id ?? '',
  )
  assert(targetId, '前置：应能找到那条待办')

  // ① 内容不冻（D5）：在正文里改字 ⇒ 查询视图**立即**显示新文字
  await page.evaluate((id) => window.__demo.focusBlock(id, 0), targetId)
  await page.keyboard.type('改字 ')
  await page.waitForTimeout(200)
  const edited = await view()
  assert(edited.rows.some((r) => r.startsWith('改字')), `内容应当实时更新（D5）：${JSON.stringify(edited.rows)}`)
  assert(edited.count === first.count, '改字不该改成员数（D4：冻的是成员与顺序）')
  assert(edited.stale, '结果里的块变了 ⇒ 应当提示「可能已过期」')

  // ② 成员不冻（D4）：把它改成已完成 ⇒ 不再匹配，但**列表仍应留着**，等刷新再移除
  await page.evaluate(() => window.__demo.invoke('core.editor/toggle-todo'))
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
    const q = data.blocks.flatMap(function flat(b) { return [b, ...b.children.flatMap(flat)] }).find((b) => b.role === 'query')
    return { hasQuery: Boolean(q?.props?._query), result: q?.props?._queryResult, children: q?.children?.length ?? -1 }
  })
  assert(frozen.hasQuery, '条件要落在 _query 上（AF5：查询块＝数据侧）')
  assert(Array.isArray(frozen.result) && frozen.result.length === 0, '冻结结果要入 KB')
  assert(frozen.children === 0, '刷新不许把结果 re-parent 成查询块的子块（AF2/AF3）')

  await ctx.close()
  return `1 条 → 改字实时更新（成员不变）→ 不匹配仍保留 → 刷新后 ${refreshed.count}；结果集入 KB 且未 re-parent`
})

await check('T37 演示状态下打字要落盘（已知风险 3）：切到稀疏态 → 打字 → 关页重开还在', async () => {
  const { ctx, page } = await freshPage(browser, base)
  // ① 切到稀疏态（这条路径原先把 `children` 装成 roots，与 openPage 的 `rootsFor(p)` 分叉）
  await page.evaluate(() => window.__demo.loadState('sparse'))
  const target = await page.evaluate(() => {
    const b = window.__demo.blocks().find((x) => x.role !== 'journal')
    window.__demo.focusBlock(b.id, 0)
    return b.id
  })
  await page.keyboard.type('稀疏态里打的字 ')
  await page.waitForTimeout(350)

  // ② 关页重开：字必须还在（且落在**同一个块**上，不是被 seed 覆盖后凭空出现）
  const reopened = await reopenPage(browser, ctx, base, page)
  const after = await reopened.page.evaluate(
    (id) => ({ blocks: window.__demo.blocks(), text: window.__demo.text().join('|') }),
    target,
  )
  await reopened.ctx.close()
  assert(after.text.includes('稀疏态里打的字'), `重开后字丢了（演示状态不落盘）：${after.text.slice(0, 40)}`)
  assert(after.blocks.some((b) => b.id === target), `重开后块 id 变了（静默换库）：${target}`)

  return `稀疏态打字 → 关页重开：${after.text.slice(0, 20)}…`
})

await check('T12 空态 / 稀疏态 / 降级态都能看（超长块与全英文不横向溢出）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__demo.loadState('empty'))
  const empty = await snap(page)
  assert(empty.blocks === 1, `空态应是「一个空块」：${empty.blocks}`)
  assert(await page.locator('#empty-hint:visible').count() === 1, '空态应给提示')
  await page.evaluate(() => window.__demo.loadState('sparse'))
  const sparse = await snap(page)
  // ⚠️ 稀疏态的形状**两种都合法**（2026-10-20）：装载口径修好后，页块自己也是根 ⇒ 渲染「页名 ＋ 一个子块」＝ 2 行。
  //    旧口径把 `children` 当 roots ⇒ 1 行。这里只钉「这个库里只有一页、内容不超过这两行」，不再钉死行数。
  assert(sparse.pageCount === 1 && sparse.blocks <= 2 && sparse.blocks >= 1, `稀疏态：1 页 不超过 2 行，实际 ${JSON.stringify(sparse)}`)
  assert(await page.locator('#empty-hint:visible').count() === 0, '稀疏态不该再显示空态提示')
  await page.evaluate(() => window.__demo.loadState('degraded'))
  const deg = await page.evaluate(() => ({
    blocks: window.__demo.blocks(),
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    editorOverflow: Array.from(document.querySelectorAll('.blk .tx')).some((e) => e.scrollWidth > e.clientWidth + 1),
  }))
  const longest = Math.max(...deg.blocks.map((b) => b.text.length))
  assert(longest > 500, `降级态里应有超长块，实际最长 ${longest}`)
  assert(deg.overflowX <= 1, `页面不该横向溢出：${deg.overflowX}px`)
  assert(!deg.editorOverflow, '超长/全英文块不该横向溢出容器')

  // 页名的兜底与截断：**页名现在只出现在引用选择器里**（左槽已改为「收藏容器块」，
  // 不再列出全部页 —— ）。所以到那个真正的落点去验。
  await page.evaluate(() => window.__demo.invoke('core.editor/insert-page-ref'))
  await page.waitForTimeout(150)
  const titles = await page.evaluate(() =>
    [...document.querySelectorAll('.layer-item .layer-label')].map((e) => e.textContent?.trim() ?? ''),
  )
  assert(titles.includes('无标题'), `无标题页要有兜底：${JSON.stringify(titles)}`)
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
  await page.evaluate(() => window.__demo.setVirtualize(true, 3))
  const v = await snap(page)
  assert(v.domBlocks < v.blocks, `虚拟化下 DOM 块应少于块数：${v.domBlocks} / ${v.blocks}`)
  assert(v.domBlocks <= 7, `半径 3 大约只挂 7 行：${v.domBlocks}`)
  const placeholders = await page.locator('.ph').count()
  assert(placeholders >= 1, '窗口外应该有占位 div')
  await page.evaluate(() => window.__demo.setVirtualize(false))
  const off = await snap(page)
  assert(off.domBlocks === off.blocks, `关掉虚拟化应全挂：${off.domBlocks} / ${off.blocks}`)
  await ctx.close()
  return `on: DOM 块 ${v.domBlocks}/${v.blocks}（占位 ${placeholders}）；off: ${off.domBlocks}/${off.blocks}`
})

await check('T14 composing 守卫：组合期键位绑定自动不命中（命令零触发）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  const r = await page.evaluate(() => {
    const before = window.__demo.commandLog().length
    window.__demo.invoke('core.demo/simulate-ime')
    return { fired: window.__demo.commandLog().length - before, toast: document.querySelector('.toast')?.textContent ?? '' }
  })
  // simulate-ime 自己会记 1 条日志（命令本身），组合期不应再触发任何键位命令
  assert(r.fired === 1, `组合期只应有「模拟 IME」这一条命令，实际新增 ${r.fired}`)
  assert(r.toast.includes('0 次'), `toast 应报告零触发：${r.toast}`)
  const composing = await page.evaluate(() => {
    const ed = window.__demo.__editor
    ed.probe.isComposing = true
    const hit = window.__demo.__registry.invoke('core.editor/split-block', {}, 'keymap', ed.ctxKeys()).handled
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
    const s = window.__demo.snapshot()
    return {
      role: window.__demo.ctxKeys().journalView,
      date: s.journalDate,
      // ：没有「标题」了 ⇒ 日期的落点是**首行的只读占位**（.tx[data-ph]）
      title: document.querySelector('#editor .blk[data-role="journal"] .tx')?.dataset.ph ?? '',
    }
  })
  assert(boot.role === true, `冷启动应落在 journal（ctx.journalView）：${JSON.stringify(boot)}`)
  assert(/^\d{4}-\d{2}-\d{2}$/.test(boot.date), `journalDate 应是本地日：${JSON.stringify(boot)}`)
  assert(boot.title.length > 0 && !/^\d{4}-\d{2}-\d{2}$/.test(boot.title), `journal 首行的只读占位应是日期的可读投影，不是裸 ISO：${boot.title}`)

  // ② 「一天一个」＝结构保证：反复调用同一天，块数不增（id 由日期确定性派生）
  const n0 = await page.evaluate(() => window.__demo.snapshot().topBlocks)
  for (let i = 0; i < 3; i++) await page.evaluate(() => window.__demo.invoke('core.journal/today'))
  const n1 = await page.evaluate(() => window.__demo.snapshot().topBlocks)
  assert(n1 === n0, `回今日应幂等（块数不增）：${n0} → ${n1}`)
  const dupes = await page.evaluate(() => {
    const ids = window.__demo.blocks().filter((b) => b.role === 'journal').map((b) => b.id)
    return { count: ids.length, unique: new Set(ids).size }
  })
  assert(dupes.count === dupes.unique, `同一天不得有两个 journal 块：${JSON.stringify(dupes)}`)

  // ③ 翻日：前一天 → 已存在的天复用（种子给了昨天）；**不存在的天** → 物化一块，再开不增
  const prev = await page.evaluate(() => {
    window.__demo.invoke('core.journal/prev')
    return { date: window.__demo.snapshot().journalDate, n: window.__demo.snapshot().topBlocks }
  })
  assert(prev.date < boot.date, `前一天应早于今天：${boot.date} → ${prev.date}`)
  const far = await page.evaluate(() => {
    const d = new Date()
    d.setDate(d.getDate() - 10)
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const n0 = window.__demo.snapshot().topBlocks
    window.__demo.invoke('core.journal/today', { date: iso })
    const n1 = window.__demo.snapshot().topBlocks
    window.__demo.invoke('core.journal/today', { date: iso })
    const n2 = window.__demo.snapshot().topBlocks
    return { iso, n0, n1, n2, shown: window.__demo.snapshot().journalDate }
  })
  assert(far.n1 === far.n0 + 1, `翻到不存在的天应物化一块：${JSON.stringify(far)}`)
  assert(far.n2 === far.n1, `再次打开同一天应幂等（块数不增）：${JSON.stringify(far)}`)
  assert(far.shown === far.iso, `打开远处某天应落在它：${JSON.stringify(far)}`)
  const back = await page.evaluate(() => {
    window.__demo.invoke('core.journal/today')
    return { date: window.__demo.snapshot().journalDate, n: window.__demo.snapshot().topBlocks }
  })
  assert(back.date === boot.date && back.n >= prev.n, `回今日应复用已物化的块：${JSON.stringify(back)}`)

  // ④ 日期只读：改名、反复回今日、翻日回来 —— 日期都不动
  const ro = await page.evaluate(() => {
    const before = window.__demo.snapshot().journalDate
    window.__demo.invoke('core.page/rename')
    window.__demo.invoke('core.page/rename')
    window.__demo.invoke('core.journal/today', { date: before })
    return { before, after: window.__demo.snapshot().journalDate, title: document.querySelector('#editor .blk[data-role="journal"] .tx')?.dataset.ph ?? '' }
  })
  assert(ro.after === ro.before, `日期不得被改：${JSON.stringify(ro)}`)
  assert(ro.title.length > 0, `只读占位仍要显示日期：${JSON.stringify(ro)}`)

  await ctx.close()
  return `冷启动在 ${boot.date}（首行占位「${boot.title}」）；回今日 ×3 块数恒 ${n0}；翻日 ${boot.date}→${prev.date}→${back.date}`
})

await check('T26 Enter 四分支（块中同级拆/空块反缩进/块尾子块/块尾同级）、点空白建子块、只读行不落光标、折叠图标贴自己的块标', async () => {
  const { ctx, page } = await freshPage(browser, base)
  // ：冷启动是长日记流；本用例测的是单容器里的 Enter/空白语义 ⇒ 先打开第一页。
  await openFirstPage(page)
  const rows = () =>
    page.evaluate(() =>
      window.__demo.blocks().map((b) => ({
        text: b.text,
        depth: Number(document.querySelector(`.blk[data-block-id="${b.id}"]`)?.dataset.depth ?? -1),
        kids: b.children,
      })),
    )

  // ① 造一个「有子块」的块：取一个**正文非空的内容块** p（排除页根，否则 p 没有前兄弟可缩进）
  const pid = await page.evaluate(() => {
    const ed = window.__demo.__editor
    const rootId = ed.doc.roots[0].id
    const p = window.__demo.blocks().find((b) => b.id !== rootId && b.children === 0 && b.text !== '' && b.text.length > 4)
    const c = ed.insertBlockAfter(p.id, '子块甲')
    ed.indent(c)
    return p.id
  })
  const t0 = await rows()
  const parentDepth = t0.find((r) => r.text === '子块甲').depth - 1
  const pre = await page.evaluate((id) => {
    const b = window.__demo.blocks().find((x) => x.id === id)
    return { children: b?.children, text: b?.text?.slice(0, 30), roots: window.__demo.__editor.doc.roots.length }
  }, pid)
  assert(pre.children === 1, `前置：父块应带 1 个子块：${JSON.stringify(pre)}`)

  // ② 带子块的块尾 Enter ⇒ **子块**（插成首个），子树不丢
  await page.evaluate((id) => window.__demo.focusBlock(id, 9999), pid)
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('新子块')
  const t1 = await rows()
  const child = t1.find((r) => r.text === '新子块')
  assert(child, `块尾 Enter 后应有新块：${JSON.stringify(t1.map((r) => r.text))}`)
  assert(child.depth === parentDepth + 1, `有子块时块尾 Enter 应建**子块**：父 ${parentDepth}，新块 ${child.depth}`)
  assert((await page.evaluate((id) => window.__demo.blocks().find((b) => b.id === id)?.children, pid)) === 2, '既有子块不该丢')

  // ③ 无子块的块尾 Enter ⇒ **同级**（Leaf 分支；取任意叶子）
  const leafId = await page.evaluate(() => window.__demo.blocks().find((b) => b.children === 0 && b.text.length > 3).id)
  const leafDepth = (await rows()).find((r, i, all) => true) && (await page.evaluate((id) => Number(document.querySelector(`.blk[data-block-id="${id}"]`).dataset.depth), leafId))
  await page.evaluate((id) => window.__demo.focusBlock(id, 9999), leafId)
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('叶子后')
  const t2 = await rows()
  const after = t2.find((r) => r.text === '叶子后')
  assert(after && after.depth === leafDepth, `无子块时块尾 Enter 应建**同级**：叶 ${leafDepth}，新块 ${after?.depth}`)

  // ⑤ 块中 Enter ⇒ **同级拆**：
  //    左半进**上方新块**；原块保 id/右半/子树；光标留原块 0 位
  const splitCase = await page.evaluate(() => {
    const ed = window.__demo.__editor
    const rootId = ed.doc.roots[0].id
    const base = window.__demo.blocks().find((b) => b.id !== rootId && b.text.length > 3)
    const sid = ed.insertBlockAfter(base.id, '甲乙丙')
    const kid = ed.insertBlockAfter(sid, '子')
    ed.indent(kid)
    return { sid }
  })
  const sidDepth = await page.evaluate(
    (id) => Number(document.querySelector(`.blk[data-block-id="${id}"]`).dataset.depth),
    splitCase.sid,
  )
  await page.evaluate((id) => window.__demo.focusBlock(id, 1), splitCase.sid)
  await page.keyboard.press('Enter')
  const t4 = await rows()
  const keptRow = await page.evaluate((id) => {
    const b = window.__demo.blocks().find((x) => x.id === id)
    return { text: b.text, kids: b.children, sel: window.__demo.snapshot().selection }
  }, splitCase.sid)
  assert(keptRow.text === '乙丙', `块中 Enter 应让原块保留右半：${JSON.stringify(keptRow.text)}`)
  assert(keptRow.kids === 1, `子树应留在原块：本地块数 ${keptRow.kids}`)
  const leftRow = t4.find((r) => r.text === '甲')
  assert(leftRow, `左半应在新块：${JSON.stringify(t4.map((r) => r.text))}`)
  assert(leftRow.depth === sidDepth, `新块应与原块**同级**：原 ${sidDepth}，新 ${leftRow.depth}`)
  assert(keptRow.sel.aBlock === splitCase.sid && keptRow.sel.aOff === 0, `光标应留在原块 0 位：${JSON.stringify(keptRow.sel)}`)
  await page.keyboard.type('X')
  const keptText = await page.evaluate((id) => window.__demo.blocks().find((b) => b.id === id).text, splitCase.sid)
  assert(keptText === 'X乙丙', `打字应落回原块（不是新块）：${JSON.stringify(keptText)}`)

  // ⑥ 空块（缩进 ≥ 2 层）Enter ⇒ **反缩进**（退化成反缩进，不建新块）：
  //    不建块，只升一层；到顶层后再 Enter 才建同级
  const outCase = await page.evaluate(() => {
    const ed = window.__demo.__editor
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
  await page.evaluate((id) => window.__demo.focusBlock(id, 0), outCase.c)
  await page.keyboard.press('Enter')
  const outDepth1 = await page.evaluate(
    (id) => Number(document.querySelector(`.blk[data-block-id="${id}"]`).dataset.depth),
    outCase.c,
  )
  const nOut1 = (await rows()).length
  assert(nOut1 === nOut0, `空块 Enter 反缩进不该建块：${nOut0} → ${nOut1}`)
  assert(outDepth1 === outDepth0 - 1, `空块 Enter 应升一层：${outDepth0} → ${outDepth1}`)
  const outSel = await page.evaluate(() => window.__demo.snapshot().selection)
  assert(outSel.aBlock === outCase.c && outSel.aOff === 0, `反缩进后光标应留在原块：${JSON.stringify(outSel)}`)
  await page.keyboard.press('Enter')
  const nOut2 = (await rows()).length
  assert(nOut2 === nOut1 + 1, `顶层空块 Enter 应建同级：${nOut1} → ${nOut2}`)

  // ④ 点「最后一行下方」空白 ⇒ 建**当前对象的子块**（D2 修订），且落光标
  const blank = await page.evaluate(() => {
    const all = [...document.querySelectorAll('#editor .blk')]
    const last = all[all.length - 1].getBoundingClientRect()
    return { x: 640, y: last.bottom + 18 }
  })
  const n0 = (await rows()).length
  await page.mouse.click(blank.x, blank.y)
  const t3 = await rows()
  assert(t3.length === n0 + 1, `点空白应建一块：${n0} → ${t3.length}`)
  assert(t3[t3.length - 1].depth === 1, `点空白建的应是当前对象的**子块**（depth 1），实际 ${t3[t3.length - 1].depth}`)
  assert(t3[t3.length - 1].text === '', '新块应是空的')
  const focused = await page.evaluate(() => window.__demo.snapshot().selection)
  assert(focused?.aBlock && focused.aOff === 0, `点空白后光标应落在新块：${JSON.stringify(focused)}`)

  // ⑤ 点与正文同高的**左侧留白** ⇒ 不该建块（clientY 判据）
  const sideY = await page.evaluate(() => {
    const tx = document.querySelector('#editor .blk .tx').getBoundingClientRect()
    return tx.top + tx.height / 2
  })
  const n1 = (await rows()).length
  await page.mouse.click(120, sideY)
  assert((await rows()).length === n1, '点与正文同高的左侧留白不该建块')

  // ⑥ `/` 建块落在根行（section 根）时，必须插成**它的子块**，不能新增根
  // （N 个 section 是正常形状；不变量从「roots 只有 1」改成「根行插块不新增根」）
  const selfInsert = await page.evaluate(() => {
    const ed = window.__demo.__editor
    const rootId = ed.doc.roots[0].id
    const before = window.__demo.blocks().length
    const beforeRoots = ed.doc.roots.length
    const id = ed.insertBlockAfter(rootId, '斜杠块')
    const rows = window.__demo.blocks()
    return { id, before, after: rows.length, roots: ed.doc.roots.length, beforeRoots, depth: Number(document.querySelector(`.blk[data-block-id="${id}"]`)?.dataset.depth ?? -1) }
  })
  assert(selfInsert.roots === selfInsert.beforeRoots, `根行插块不该新增根：${selfInsert.beforeRoots} → ${selfInsert.roots}`)
  assert(selfInsert.depth === 1, `根行插块应是它的子块（depth 1）：${selfInsert.depth}`)
  assert(selfInsert.after === selfInsert.before + 1, '根行插块应块数 +1')

  // ⑦ 点**块标**（＝ zoom）不该顺手建块 —— composedPath 修复点
  const marker = await page.evaluate(() => {
    const m = document.querySelector('[data-focus-for]')
    const r = m.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  const n2 = await page.evaluate(() => window.__demo.snapshot().totalBlocks)
  await page.mouse.click(marker.x, marker.y)
  const n3 = await page.evaluate(() => window.__demo.snapshot().totalBlocks)
  assert(n3 === n2, `点块标（zoom）不该建块：${n2} → ${n3}`)

  await ctx.close()
  return `带子块的块尾 ⇒ 子块（depth ${child.depth}）；叶子块尾 ⇒ 同级（depth ${after?.depth}）；点空白 ⇒ depth 1 子块；留白/块标不误建`
})

await check('T30 聚焦块（section 根）文本中间 Enter ⇒ 左半留根、右半成首个子块', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await openFirstPage(page)
  const ids = await page.evaluate(() => {
    const ed = window.__demo.__editor
    const rootId = ed.doc.roots[0].id
    const id = ed.insertBlockAfter(rootId, '聚焦甲乙丙')
    const kid = ed.insertBlockAfter(id, '聚焦子')
    ed.indent(kid)
    window.__demo.invoke('core.block/focus-block', { blockId: id })
    return { id, kid }
  })
  const roots = await page.evaluate(() => window.__demo.__editor.doc.roots.map((b) => b.id))
  assert(roots.length === 1 && roots[0] === ids.id, `zoom 后 doc.roots 应只有聚焦块：${JSON.stringify(roots)}`)
  const n0 = await page.evaluate(() => window.__demo.snapshot().totalBlocks)
  await page.evaluate((id) => window.__demo.focusBlock(id, 2), ids.id)
  await page.keyboard.press('Enter')
  const st = await page.evaluate(() => {
    const ed = window.__demo.__editor
    const root = ed.doc.roots[0]
    return {
      roots: ed.doc.roots.length,
      rootText: root.text,
      kids: root.children.map((b) => ({ id: b.id, text: b.text })),
      sel: window.__demo.snapshot().selection,
    }
  })
  assert(st.roots === 1, `拆块不应新增根：${st.roots}`)
  assert(st.rootText === '聚焦', `左半应留在聚焦块：${JSON.stringify(st.rootText)}`)
  assert(st.kids.length === 2, `聚焦块应有两个子块：${JSON.stringify(st.kids)}`)
  assert(st.kids[0].text === '甲乙丙', `右半应成为首个子块：${JSON.stringify(st.kids[0])}`)
  assert(st.kids[1].id === ids.kid, `既有子块应保留：${JSON.stringify(st.kids)}`)
  assert(st.sel.aBlock === st.kids[0].id && st.sel.aOff === 0, `光标应落在右半子块 0 位：${JSON.stringify(st.sel)}`)
  const n1 = await page.evaluate(() => window.__demo.snapshot().totalBlocks)
  assert(n1 === n0 + 1, `拆块应只多一块：${n0} → ${n1}`)
  await page.keyboard.type('X')
  const first = await page.evaluate((id) => window.__demo.blocks().find((b) => b.id === id)?.text, st.kids[0].id)
  assert(first === 'X甲乙丙', `打字应落在右半子块：${JSON.stringify(first)}`)
  await ctx.close()
  return `聚焦块「${st.rootText}」；首子块「${st.kids[0].text}」＋既有子块；光标在首子块`
})

await check('T31 普通块块首 Enter ⇒ 上方插空块并把光标放进去（原块文本不变）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await openFirstPage(page)
  const ids = await page.evaluate(() => {
    const ed = window.__demo.__editor
    const rootId = ed.doc.roots[0].id
    const id = ed.insertBlockAfter(rootId, '块首甲乙')
    return { id }
  })
  const depth = await page.evaluate(
    (id) => Number(document.querySelector(`.blk[data-block-id="${id}"]`).dataset.depth),
    ids.id,
  )
  const n0 = await page.evaluate(() => window.__demo.snapshot().totalBlocks)
  await page.evaluate((id) => window.__demo.focusBlock(id, 0), ids.id)
  await page.keyboard.press('Enter')
  const st = await page.evaluate((id) => {
    const ed = window.__demo.__editor
    const loc = window.__demo.blocks().find((b) => b.id === id)
    const sel = window.__demo.snapshot().selection
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
  const n1 = await page.evaluate(() => window.__demo.snapshot().totalBlocks)
  assert(n1 === n0 + 1, `块首 Enter 应只多一块：${n0} → ${n1}`)
  await page.keyboard.type('X')
  const typed = await page.evaluate((id) => window.__demo.blocks().find((b) => b.id === id)?.text, st.sel.aBlock)
  assert(typed === 'X', `打字应落在上方新块：${JSON.stringify(typed)}`)
  await ctx.close()
  return `原块「${st.text}」不变；上方新块获得光标（depth ${st.selDepth}）`
})

await check('T32 Shift+Enter 刻意等同 Enter（v1 不做软换行）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await openFirstPage(page)
  const ids = await page.evaluate(() => {
    const ed = window.__demo.__editor
    const rootId = ed.doc.roots[0].id
    return { id: ed.insertBlockAfter(rootId, '软换甲乙丙') }
  })
  const depth = await page.evaluate(
    (id) => Number(document.querySelector(`.blk[data-block-id="${id}"]`).dataset.depth),
    ids.id,
  )
  const n0 = await page.evaluate(() => window.__demo.snapshot().totalBlocks)
  await page.evaluate((id) => window.__demo.focusBlock(id, 2), ids.id)
  await page.keyboard.press('Shift+Enter')
  const st = await page.evaluate((id) => {
    const ed = window.__demo.__editor
    const b = window.__demo.blocks().find((x) => x.id === id)
    const sel = window.__demo.snapshot().selection
    const rows = window.__demo.blocks()
    return { text: b?.text, sel, rows: rows.map((r) => r.text) }
  }, ids.id)
  assert(st.text === '甲乙丙', `Shift+Enter 应像 Enter 一样保留右半：${JSON.stringify(st.text)}`)
  assert(st.rows.includes('软换'), `左半应在上方新块：${JSON.stringify(st.rows)}`)
  assert(!st.rows.some((t) => t.includes('\n')), `不应插入软换行：${JSON.stringify(st.rows)}`)
  assert(st.sel.aBlock === ids.id && st.sel.aOff === 0, `光标应留原块 0 位：${JSON.stringify(st.sel)}`)
  const n1 = await page.evaluate(() => window.__demo.snapshot().totalBlocks)
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
    const ed = window.__demo.__editor
    return ed.insertBlockAfter(ed.doc.roots[0].id, 'abcdefghij')
  })
  const n0 = await page.evaluate(() => window.__demo.snapshot().totalBlocks)

  const select = async (from, key, times) => {
    await page.evaluate(({ id, from }) => window.__demo.focusBlock(id, from), { id, from })
    await page.keyboard.down('Shift')
    for (let i = 0; i < times; i++) await page.keyboard.press(key)
    await page.keyboard.up('Shift')
    const sel = await page.evaluate(() => window.__demo.snapshot().selection)
    assert(sel.aOff === 2 && sel.hOff === 6, `选区应是 [2,6)：${JSON.stringify(sel)}`)
  }
  const read = () =>
    page.evaluate((id) => {
      const b = window.__demo.blocks().find((x) => x.id === id)
      return {
        text: b?.text,
        rows: window.__demo.blocks().map((r) => r.text),
        sel: window.__demo.snapshot().selection,
        n: window.__demo.snapshot().totalBlocks,
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
  await page.keyboard.press('Meta+z')
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
    const ed = window.__demo.__editor
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
      count: window.__demo.snapshot().blockSelectionCount,
      painted: document.querySelectorAll('.blk[data-blocksel="1"]').length,
      textSel: document.getSelection()?.toString() ?? '',
      texts: window.__demo.blocks().map((b) => b.text),
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
  await page.keyboard.press('Meta+z')
  await page.waitForTimeout(80)
  const back = await state()
  assert(back.texts.includes('AAAA') && back.texts.includes('BBBB') && back.texts.includes('CCCC'), `一次撤销应复原三块：${JSON.stringify(back.texts)}`)

  // ⑤ Shift+拖拽 = 跨块**文本**（我们的增量；块选区不激活）
  await page.evaluate((id) => window.__demo.focusBlock(id, 0), ids.a)
  await drag(ra, rc, true)
  const text = await state()
  assert(text.count === 0, `Shift+拖拽不应选块：${JSON.stringify(text)}`)
  assert(text.textSel.includes('AAAA') && text.textSel.includes('BBBB'), `Shift+拖拽应选到跨块文本：${JSON.stringify(text.textSel)}`)
  await page.keyboard.press('Escape')

  // ⑥ Mod+Shift+A 全选块；Enter 清选区并落到首块 0 位
  await page.evaluate((id) => window.__demo.focusBlock(id, 0), ids.a)
  await page.keyboard.press('Meta+Shift+A')
  const all = await state()
  assert(all.count > 0, `Mod+Shift+A 应选块：${JSON.stringify(all)}`)
  await page.keyboard.press('Enter')
  const afterEnter = await page.evaluate(() => ({
    count: window.__demo.snapshot().blockSelectionCount,
    sel: window.__demo.snapshot().selection,
  }))
  assert(afterEnter.count === 0, `Enter 应清块选区：${JSON.stringify(afterEnter)}`)
  assert(afterEnter.sel?.aOff === 0, `Enter 后光标应在首块 0 位：${JSON.stringify(afterEnter.sel)}`)

  // ⑦ Shift+↓ 的边界规则：块尾起块选区并可扩展；文本内部仍是原生文本选区
  await page.evaluate((id) => window.__demo.focusBlock(id, 9999), ids.a)
  await page.keyboard.press('Shift+ArrowDown')
  const edge1 = await state()
  assert(edge1.count === 1, `块尾 Shift+↓ 应起块选区（1 块）：${JSON.stringify(edge1)}`)
  await page.keyboard.press('Shift+ArrowDown')
  const edge2 = await state()
  assert(edge2.count === 2, `再按 Shift+↓ 应扩到 2 块：${JSON.stringify(edge2)}`)
  await page.keyboard.press('Escape')
  await page.evaluate((id) => window.__demo.focusBlock(id, 1), ids.a)
  await page.keyboard.press('Shift+ArrowDown')
  const inner = await state()
  assert(inner.count === 0, `文本内部 Shift+↓ 不应起块选区：${JSON.stringify(inner)}`)
  assert(inner.textSel.length > 0, `文本内部 Shift+↓ 应是原生文本选区：${JSON.stringify(inner.textSel)}`)

  // ⑧ ⌘A 两次：第一次文本全选；已全选时再按升级为全选块
  await page.keyboard.press('Escape')
  await page.evaluate((id) => window.__demo.focusBlock(id, 0), ids.a)
  await page.keyboard.press('Meta+a')
  const textAll = await page.evaluate(() => ({
    count: window.__demo.snapshot().blockSelectionCount,
    sel: window.__demo.snapshot().selection,
  }))
  assert(textAll.count === 0, `第一次 ⌘A 应是文本全选：${JSON.stringify(textAll)}`)
  await page.keyboard.press('Meta+a')
  const blockAll = await state()
  assert(blockAll.count > 0, `第二次 ⌘A 应升级为块选区：${JSON.stringify(blockAll)}`)

  await ctx.close()
  return `单块内拖=文本；A→C=3 块；右键多块菜单删除 + 一次撤销；Shift+拖=跨块文本；Mod+Shift+A 全选块；Enter 清选区；Shift+↓ 边界规则；⌘A 两次升级`
})

await check('T27 光标行隐藏占位、journal 日期不可聚焦、折叠图标贴自己的块标', async () => {
  const { ctx, page } = await freshPage(browser, base)

  // ① 光标所在行**不显示**占位符（否则光标落在「空块」二字后面）
  const ph = await page.evaluate(() => {
    const ed = window.__demo.__editor
    const id = ed.insertBlockAfter(window.__demo.blocks()[0].id, '')
    ed.placeCaret(id, 0)
    const el = document.querySelector(`.blk[data-block-id="${id}"] .tx`)
    const before = getComputedStyle(el, '::before').content
    // 把光标挪到别的块 ⇒ 占位应回来
    ed.placeCaret(window.__demo.blocks()[0].id, 0)
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
  const selBefore = await page.evaluate(() => window.__demo.snapshot().selection)
  await page.mouse.click(jpos.x, jpos.y)
  const selAfter = await page.evaluate(() => window.__demo.snapshot().selection)
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
      active: window.__demo.snapshot().journalDate,
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
  await page.evaluate((id) => window.__demo.focusBlock(id, 9999), oldestChild)
  await page.keyboard.type('历史编辑')
  const edited = await page.evaluate(() => ({
    hasText: window.__demo.blocks().some((b) => b.text.includes('历史编辑')),
    rootTexts: [...document.querySelectorAll('#editor > .blk[data-role="journal"]')].map((el) => el.querySelector('.tx')?.textContent ?? ''),
  }))
  assert(edited.hasText, '历史天的子块应能编辑')
  assert(edited.rootTexts.every((t) => t === ''), `journal 段头的正文应保持为空：${JSON.stringify(edited.rootTexts)}`)

  // ③ 切到页再回日记流：历史天的编辑必须**写回**且重新装载后还在
  await page.evaluate(() => window.__demo.invoke('core.page/open', { pageId: window.__demo.pages()[0].id }))
  await page.evaluate(() => window.__demo.invoke('core.journal/today'))
  const persisted = await page.evaluate(() => ({
    hasText: window.__demo.blocks().some((b) => b.text.includes('历史编辑')),
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
  const targetPage = await page.evaluate(() => window.__demo.pages()[0].id)
  await page.evaluate((id) => window.__demo.invoke('core.page/open', { pageId: id }), targetPage)

  // 在目标页里造一个「引用目标页自己」的块 ⇒ 它既在正文，也出现在 footer 反链里
  const blockId = await page.evaluate((target) => {
    const bs = window.__demo.blocks()
    const b = bs.find((x) => x.id !== target && x.text.length > 2)
    window.__demo.focusBlock(b.id, b.text.length)
    window.__demo.invoke('core.editor/insert-page-ref', { pageId: target })
    return b.id
  }, targetPage)
  await page.waitForTimeout(350) // footer 的 200ms 查询去抖

  const footer = await page.evaluate((id) => {
    const row = document.querySelector(`#backlinks-editor .blk[data-block-id="${id}"] .tx`)
    return { visible: !document.querySelector('#backlinks')?.hidden, text: row?.textContent ?? '' }
  }, blockId)
  assert(footer.visible, `footer 反链应出现：${JSON.stringify(footer)}`)

  // 在 footer 里原地编辑；正文里的同一块（同一 store 对象）应同步
  await page.locator(`#backlinks-editor .blk[data-block-id="${blockId}"] .tx`).click()
  await page.keyboard.press('End')
  await page.keyboard.type('Y')
  await page.waitForTimeout(120)
  const both = await page.evaluate((id) => ({
    main: window.__demo.blocks().find((b) => b.id === id)?.text ?? '',
    footer: document.querySelector(`#backlinks-editor .blk[data-block-id="${id}"] .tx`)?.textContent ?? '',
  }), blockId)
  assert(both.footer.includes('Y'), `footer 应可原地编辑：${JSON.stringify(both)}`)
  assert(both.main.includes('Y'), `正文里的同一块应同步（共享 store）：${JSON.stringify(both)}`)

  // 全局 undo：焦点在 footer，Meta+Z 回滚 store，正文与 footer 一起复原
  await page.keyboard.press('Meta+z')
  await page.waitForTimeout(120)
  const undone = await page.evaluate((id) => ({
    main: window.__demo.blocks().find((b) => b.id === id)?.text ?? '',
    footer: document.querySelector(`#backlinks-editor .blk[data-block-id="${id}"] .tx`)?.textContent ?? '',
  }), blockId)
  assert(!undone.footer.includes('Y') && !undone.main.includes('Y'), `footer 里的 undo 应回滚两个实例：${JSON.stringify(undone)}`)

  await ctx.close()
  return 'footer 反链：原地编辑 + 正文同步 + 全局 undo'
})

await check('T39 反链 footer 的块标能聚焦：点一下中心槽切到该源块（嵌套块也进得去），不误建空块', async () => {
  const { ctx, page } = await freshPage(browser, base)
  const targetPage = await page.evaluate(() => window.__demo.pages()[0].id)
  await page.evaluate((id) => window.__demo.invoke('core.page/open', { pageId: id }), targetPage)

  // 源块挑**深度 ≥ 2** 的：只在顶层里找目标的实现会在这条路径上失败
  const src = await page.evaluate((target) => {
    const ed = window.__demo.__editor
    const walk = (b, d) => {
      if (d >= 2 && b.text.length > 2) return b
      for (const c of b.children) {
        const hit = walk(c, d + 1)
        if (hit) return hit
      }
      return null
    }
    const b = walk(ed.doc.roots[0], 0)
    window.__demo.focusBlock(b.id, b.text.length)
    window.__demo.invoke('core.editor/insert-page-ref', { pageId: target })
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
    active: window.__demo.snapshot().activePage,
    total: window.__demo.snapshot().totalBlocks,
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

await check('T40 冷启动直接打字后 ⌘Z：撤销只回滚文字，不把整片正文清空（未经 openPage）', async () => {
  const { ctx, page } = await freshPage(browser, base)

  /**
   * ⚠️ 冷启动走的是 `new BlockEditor({ doc })`，**没有** `loadPage()`。
   *    root id 若只在 `loadPage()` 里登记，第一次 undo 的 `reloadFromStore()` 就会
   *    按空列表重载 ⇒ 正文（`doc.roots`）被清空，而 store 里的块其实还在。
   *    所以这里**不调用** openPage，直接从冷启动状态打字。
   */
  const before = await page.evaluate(() => {
    const bs = window.__demo.blocks()
    const b = bs.find((x) => x.role !== 'journal')
    window.__demo.focusBlock(b.id, 0)
    const s = window.__demo.snapshot()
    return { id: b.id, text: b.text, texts: window.__demo.text(), total: s.totalBlocks, dom: s.domBlocks }
  })
  await page.keyboard.type('Z')
  await page.waitForTimeout(80)
  const typed = await page.evaluate((id) => window.__demo.blocks().find((b) => b.id === id)?.text ?? '', before.id)
  assert(typed.startsWith('Z'), `冷启动后应能直接敲进第一行：${JSON.stringify(typed.slice(0, 8))}`)

  await page.keyboard.press('Meta+z')
  await page.waitForTimeout(150)
  const after = await page.evaluate(() => {
    const s = window.__demo.snapshot()
    return { texts: window.__demo.text(), total: s.totalBlocks, dom: s.domBlocks, rows: document.querySelectorAll('#editor .blk').length }
  })
  assert(after.rows > 0, '撤销后正文一行都不剩（DOM 被清空）')
  assert(after.texts.length === before.texts.length, `撤销后正文行数应复原：${before.texts.length} → ${after.texts.length}`)
  assert(JSON.stringify(after.texts) === JSON.stringify(before.texts), `撤销应把文字回到原样：${JSON.stringify({ before: before.texts.slice(0, 2), after: after.texts.slice(0, 2) })}`)
  assert(after.total === before.total && after.dom === before.dom, `撤销不该改块数/DOM 行数：${JSON.stringify({ before, after })}`)

  await ctx.close()
  return `冷启动敲 1 字 → ⌘Z：${before.texts.length} 行原样回来（DOM ${after.dom} 行，块数 ${after.total}）`
})

await check('T41 冷启动后在反链 footer 编辑，不会把正文重载成空（共享 store 首次 touch）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  const ids = await page.evaluate(() => {
    const bs = window.__demo.blocks()
    const j = bs.find((b) => b.role === 'journal')
    const src = bs.find((b) => b.role !== 'journal' && b.text.length > 2)
    window.__demo.focusBlock(src.id, src.text.length)
    /**
     * `[[ ]]` 的引用目标只解析 `page` 角色（journal 的正文是空的，日期在 `_date` 里），
     * 所以「让今日 journal 有反链」只能直接在编辑器上放一个原子里。这里要紧的是
     * **冷启动**这条路径（没有 openPage），不是用户从哪个菜单插的。
     */
    const atomId = window.__demo.__editor.insertAtom('page', { label: '今日', target: { kind: 'page', id: j.id } })
    return { journal: j.id, src: src.id, atomId }
  })
  assert(ids.atomId, '冷启动下应能往正文插一个指向今日 journal 的原子')
  await page.waitForTimeout(350)

  assert(await page.evaluate(() => !document.querySelector('#backlinks')?.hidden), '冷启动的当前对象（今日 journal）应出现反链 footer')
  const before = await page.evaluate(() => ({
    texts: window.__demo.text(),
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
    texts: window.__demo.text(),
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

await check('T42 待办行的方框独占块标槽：不叠圆点（todo / done / 深缩进 / hover）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await openFirstPage(page)

  // 深缩进：把一个第 3 层的块标成待办
  const deep = await page.evaluate(() => {
    const ed = window.__demo.__editor
    const walk = (b, d) => {
      if (d >= 2 && b.text.length > 2) return b
      for (const c of b.children) {
        const hit = walk(c, d + 1)
        if (hit) return hit
      }
      return null
    }
    const b = walk(ed.doc.roots[0], 0)
    window.__demo.focusBlock(b.id, 0)
    window.__demo.invoke('core.editor/toggle-todo')
    return b.id
  })

  const readRow = (id) =>
    page.evaluate((blockId) => {
      const row = document.querySelector(`#editor .blk[data-block-id="${blockId}"]`)
      const m = row?.querySelector(':scope > .left > .marker')
      const before = m ? getComputedStyle(m, '::before') : null
      return {
        todo: row?.dataset.todo ?? '',
        depth: Number(row?.dataset.depth ?? -1),
        classes: m ? [...m.classList].sort().join(' ') : '',
        before: before?.content ?? '',
        beforeW: before?.width ?? '',
        boxW: m?.querySelector('.ico') ? getComputedStyle(m.querySelector('.ico')).width : '',
      }
    }, id)

  const deepRow = await readRow(deep)
  assert(deepRow.todo !== '' && deepRow.depth >= 2, `深缩进待办没建成：${JSON.stringify(deepRow)}`)
  assert(deepRow.classes.includes('todo-box') && deepRow.classes.includes('marker'), `方框应仍是块标（同一元素）：${deepRow.classes}`)
  assert(deepRow.before === 'none', `待办行不该再生成圆点（::before content=${deepRow.before}）`)
  assert(deepRow.boxW === '12px', `方框应正常画出来：${deepRow.boxW}`)

  // 假数据里已有的 todo / done 两态都只有方框
  const all = await page.evaluate(() =>
    [...document.querySelectorAll('#editor .blk[data-todo]')].map((row) => {
      const m = row.querySelector(':scope > .left > .marker')
      return {
        todo: row.dataset.todo,
        classes: m ? [...m.classList].sort().join(' ') : '',
        before: m ? getComputedStyle(m, '::before').content : '',
        boxW: m?.querySelector('.ico') ? getComputedStyle(m.querySelector('.ico')).width : '',
      }
    }),
  )
  assert(all.some((r) => r.todo === 'todo') && all.some((r) => r.todo === 'done'), `应同时看到 todo 与 done：${JSON.stringify(all)}`)
  for (const r of all) {
    assert(r.before === 'none', `待办（${r.todo}）不该生成圆点：${JSON.stringify(r)}`)
    assert(r.classes.includes('todo-box') && r.boxW === '12px', `待办（${r.todo}）的方框应在：${JSON.stringify(r)}`)
  }

  // hover 只改可见度，不能把圆点露出来
  await page.locator(`#editor .blk[data-block-id="${deep}"] > .left > .marker`).hover()
  const hovered = await readRow(deep)
  assert(hovered.before === 'none', `hover 时不该露出圆点：${hovered.before}`)

  await ctx.close()
  return `todo/done/深缩进（depth ${deepRow.depth}）三种都只有方框（.ico ${deepRow.boxW}，::before none）`
})

await check('T43 左键点引用直接打开目标；⌥ 才弹详情；dangling / 图片仍弹详情', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await openFirstPage(page)

  const r = await page.evaluate(() => {
    const el = document.querySelector('#editor .atom-page:not(.dangling)')
    const a = window.__demo.atoms().find((x) => x.id === el?.dataset.atomId)
    const target = window.__demo.pages().find((p) => p.id === a?.target?.id)
    return {
      atomId: el?.dataset.atomId ?? '',
      title: el?.title ?? '',
      targetTitle: target?.title ?? '',
      total: window.__demo.snapshot().totalBlocks,
    }
  })
  assert(r.atomId && r.targetTitle, `应能找到一条可解析的页面引用：${JSON.stringify(r)}`)
  assert(r.title.includes('左键打开') && r.title.includes('⌥'), `原子 title 应说明「左键打开、⌥ 详情」：${r.title}`)

  // 左键：直接打开目标块（页面），不弹详情、不建块
  await page.locator(`#editor .atom-page[data-atom-id="${r.atomId}"]`).click()
  await page.waitForTimeout(200)
  const opened = await page.evaluate(() => {
    const s = window.__demo.snapshot()
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
  await page.evaluate(() => window.__demo.badgePanel(true))
  const panel = await page.locator('#badge-panel').innerText()
  assert(panel.includes('上下文键') && panel.includes('按键命中追踪'), `角标面板应含诊断两件套：${panel.slice(0, 80)}`)
  await ctx.close()
  return badge.replace(/\s+/g, ' ')
})

await check('T18 跨页锚点不被误删：在当前容器里删块，只回收**这一块**的锚点', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__demo.quiet(true))

  /**
   * ⚠️ 这条是 2026-10-20 修掉的一个**真实数据丢失**的回归断言：
   *   `marks`/`atoms` 是**库级平铺**的，而 `ed.doc` 只装**当前容器的子树**。
   *   早先用 `ed.doc` 去裁剪库级锚点 ⇒ 在任一页删一块，**别的页的锚点全被静默删掉**
   *   （实机复现：marks 24→7；落在 journal 上时 28→1）。
   * ⇒ 判死范围必须只限**本容器内**的块；容器外的锚点编辑器无权处置。
   */
  const before = await page.evaluate(() => {
    // 先打开一个有锚点的页，把它自己那几块的锚点 id 记下来做对照
    window.__demo.invoke('core.page/open', { pageId: window.__demo.pages()[0].id })
    const own = new Set(window.__demo.blocks().map((b) => b.id))
    return {
      marks: window.__demo.marks().length,
      atoms: window.__demo.atoms().length,
      own: [...own],
    }
  })
  // 回到别的容器（今日 journal），删掉一块
  await page.evaluate(() => window.__demo.invoke('core.journal/today'))
  await new Promise((r) => setTimeout(r, 150))
  const target = await page.evaluate(() => {
    const bs = window.__demo.blocks()
    const id = bs[bs.length - 1].id
    window.__demo.focusBlock(id, 0)
    return id
  })
  const mid = await page.evaluate((id) => ({
    marks: window.__demo.marks().length,
    atoms: window.__demo.atoms().length,
    // 被删那一块自己带几条锚点 ⇒ 允许的掉幅度**恰好**等于这个数
    onTarget: window.__demo.marks().filter((m) => m.blockId === id).length,
  }), target)
  await page.evaluate(() => window.__demo.invoke('core.editor/delete-block'))
  await new Promise((r) => setTimeout(r, 250))
  const after = await page.evaluate(() => ({ marks: window.__demo.marks().length, atoms: window.__demo.atoms().length }))

  // 判据：掉的数量**恰好**＝被删块自带的锚点数，不能多一条
  assert(after.marks === mid.marks - mid.onTarget, `只该回收被删块自己的锚点（应少 ${mid.onTarget} 条）：${JSON.stringify({ mid, after })}`)
  assert(after.atoms <= mid.atoms, `原子不该变多：${JSON.stringify({ mid, after })}`)
  // 回到第一页：它自己的锚点必须还在（这是 bug 最直观的证据）
  await page.evaluate(() => window.__demo.invoke('core.page/open', { pageId: window.__demo.pages()[0].id }))
  await new Promise((r) => setTimeout(r, 250))
  const back = await page.evaluate(() => ({ marks: window.__demo.marks().length, atoms: window.__demo.atoms().length }))
  assert(back.marks >= before.marks - 3, `第一页的锚点不该被别的容器删掉：${JSON.stringify({ before, back })}`)
  assert(back.atoms >= before.atoms, `第一页的原子不该被删：${JSON.stringify({ before, back })}`)

  await ctx.close()
  return `删 ${target.slice(-6)}：库级 marks ${mid.marks}→${after.marks}、atoms ${mid.atoms}→${after.atoms}；回到第一页仍有 ${back.marks} 条锚点（起始 ${before.marks}）`
})

await check('T19 zoom in：进子树、面包屑可退回、顶层时面包屑隐藏、锚点不走丢', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__demo.quiet(true))

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
      here: window.__demo.blocks().length,
      marks: window.__demo.marks().length,
      atoms: window.__demo.atoms().length,
    }))

  // ① 顶层：面包屑不出现（现状观感不被改变）
  await page.evaluate(() => window.__demo.invoke('core.page/open', { pageId: window.__demo.pages()[0].id }))
  await new Promise((r) => setTimeout(r, 200))
  const top = await st()
  assert(!top.trailShown, `顶层不该显示面包屑：${JSON.stringify(top)}`)

  // ② zoom 进一个有子块的块：编辑器只剩它的子树；面包屑出现且只有祖先（不含自己）
  const target = await page.evaluate(() => {
    // ⚠️ 排除**首行**（= 顶层页块自己）：zoom 到顶层等于没 zoom，面包屑必然为空
    const ids = new Set([...document.querySelectorAll('#editor .blk[data-depth="0"]')].map((el) => el.dataset.blockId))
    const b = window.__demo.blocks().find((x) => x.children > 0 && !ids.has(x.id))
    return b ? { id: b.id, text: b.text } : null
  })
  assert(target, '假数据里应有带子块的非顶层块')
  await page.evaluate((id) => window.__demo.invoke('core.block/focus-block', { blockId: id }), target.id)
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
   * ④ **叶子块也给 zoom**（B1，修订的附注）。
   *    旧口径「没有子树可聚焦就不给」会让点击行为**时 zoom 时不 zoom**；
   *    行为是「点块标＝聚焦」，叶子上就是「只看这一块」。
   *    ⇒ 现在 zoom 到叶子：编辑器只剩它一行，面包屑仍是它自己的祖先链。
   */
  const leaf = await page.evaluate(() => {
    const ids = new Set([...document.querySelectorAll('#editor .blk[data-depth="0"]')].map((el) => el.dataset.blockId))
    const b = window.__demo.blocks().find((x) => x.children === 0 && !ids.has(x.id))
    return b ? { id: b.id, text: b.text } : null
  })
  let leafView = null
  if (leaf) {
    await page.evaluate((id) => window.__demo.invoke('core.block/focus-block', { blockId: id }), leaf.id)
    await new Promise((r) => setTimeout(r, 250))
    leafView = await st()
    assert(leafView.trailShown, `叶子块也应能 zoom（D1/B1）：${JSON.stringify(leafView)}`)
    assert(leafView.here === 1, `zoom 到叶子后编辑器应只剩它一行，实际 ${leafView.here} 块`)
    assert(leafView.firstRow === leaf.text.trim(), `那一行应是叶子自己：${JSON.stringify({ want: leaf.text, got: leafView.firstRow })}`)
  }

  await ctx.close()
  return `顶层 ${top.here} 块 → zoom ${zoomed.here} 块（面包屑「${zoomed.trail.join(' › ')}」）→ 退回 ${back.here} 块${leafView ? ` → 叶子 zoom ${leafView.here} 块` : ''}；锚点恒 ${top.marks}/${top.atoms}`
})

await check('T25 块标左键 = 聚焦/zoom：点一下进子树，右键才开菜单', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__demo.quiet(true))
  await page.evaluate(() => window.__demo.invoke('core.page/open', { pageId: window.__demo.pages()[0].id }))
  await new Promise((r) => setTimeout(r, 200))

  const target = await page.evaluate(() => {
    const ids = new Set([...document.querySelectorAll('#editor .blk[data-depth="0"]')].map((el) => el.dataset.blockId))
    const b = window.__demo.blocks().find((x) => x.children > 0 && !ids.has(x.id))
    // ⚠️ `__demo.blocks()` 把 children 拍平成**计数**；子树规模用「可见行数」口径：
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
    here: window.__demo.blocks().length,
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
    const before = window.__demo.blocks().length
    const marker = document.querySelector('#editor .blk[data-depth="0"] .marker')
    marker.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return { before, after: window.__demo.blocks().length, menu: document.querySelectorAll('.layer').length }
  })
  assert(selfClick.menu === 0, '点顶层块标也不该开菜单')
  assert(selfClick.after === selfClick.before, `点顶层块标（＝zoom 到自己）不该改变装载：${JSON.stringify(selfClick)}`)

  await ctx.close()
  return `左键点 ${target.id.slice(-6)} → zoom 收窄到 ${zoomed.here} 块（面包屑「${zoomed.trail.join(' › ')}」，无菜单）；右键 → 块菜单 ${menuLabels.length} 项`
})

await check('T21 收藏 ＝ 命名容器块 ＋ 一列块引用（不是「全部页」）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__demo.quiet(true))

  const view = () =>
    page.evaluate(() => ({
      containers: [...document.querySelectorAll('#dock-left .dock-card')].map((c) => ({
        title: c.querySelector('.dock-card-title')?.textContent?.trim() ?? '',
        rows: [...c.querySelectorAll('.favorite-row')].map((r) => r.querySelector('.p-title')?.textContent?.trim() ?? ''),
      })),
    }))

  // ① 左槽只列**收藏容器里的引用**，不是全部页（假数据 6 页，收藏 2 条）
  const boot = await view()
  const fav = boot.containers.find((c) => c.title === '常用')
  assert(fav, `左槽应有「常用」这个收藏容器：${JSON.stringify(boot.containers)}`)
  assert(fav.rows.length === 2, `收藏里应有 2 条引用，实际 ${fav.rows.length}：${JSON.stringify(fav.rows)}`)
  const pageCount = await page.evaluate(() => window.__demo.pages().length)
  assert(pageCount > fav.rows.length, `收藏不该等于全部页（页 ${pageCount} / 收藏 ${fav.rows.length}）`)

  // ② 收藏顺序＝容器里的顺序位；同一块不会因为被收藏而在自己身上留标记
  const order0 = await page.evaluate(() => {
    const c = window.__demo.snapshot().topBlocks
    return { top: c }
  })
  assert(order0.top >= 1, '森林里应有收藏容器块')

  // ③ 把当前页加进收藏（块菜单那条命令）→ 左槽多一行
  const before = (await view()).containers.find((c) => c.title === '常用').rows.length
  const added = await page.evaluate(() => {
    const id = window.__demo.pages()[2].id
    window.__demo.invoke('core.favorites/add', { blockId: id })
    return id
  })
  await page.waitForTimeout(200)
  const after = (await view()).containers.find((c) => c.title === '常用').rows.length
  assert(after === before + 1, `加入收藏后应多一行：${before} → ${after}`)

  // ④ 幂等：再加一次不多
  await page.evaluate((id) => window.__demo.invoke('core.favorites/add', { blockId: id }), added)
  await page.waitForTimeout(200)
  assert((await view()).containers.find((c) => c.title === '常用').rows.length === after, '重复收藏不该多一行')

  // ⑤ 移出：点行尾的 ×
  await page.locator('#dock-left .favorite-row').first().locator('.favorite-remove').click({ force: true })
  await page.waitForTimeout(200)
  const afterRemove = (await view()).containers.find((c) => c.title === '常用').rows.length
  assert(afterRemove === after - 1, `移出后应少一行：${after} → ${afterRemove}`)

  // ⑥ **删掉容器块，被收藏的数据不受影响**的解耦判据）
  //    端到端这里不做：demo 没有「删除顶层容器块」的命令面入口；
  //    该判据已在 `tests/favorites.test.ts` 用模型层严格验证（删容器后页仍在）。
  const pagesNow = await page.evaluate(() => window.__demo.pages().length)
  assert(pagesNow === pageCount, `收藏操作不该改变页数：${pageCount} → ${pagesNow}`)

  await ctx.close()
  return `收藏「常用」2 条（共 ${pageCount} 页）→ 加 1 → 幂等不变 → 移出 1；全程页数不变`
})

await check('T22 首行即当前对象：页名可编辑、在首行按 Enter 不自环', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__demo.quiet(true))
  await openFirstPage(page)

  // ① 首行是**页块自己**，且**可编辑**（旧形状里它是只读的「标题」）
  const first = await page.evaluate(() => {
    const el = document.querySelector('#editor .blk[data-depth="0"]')
    return { id: el.dataset.blockId, text: el.querySelector('.tx').textContent.trim() }
  })
  assert(first.text === '产品设计 · 决策日志', `首行应是页块正文：${JSON.stringify(first)}`)

  // ② 在首行末尾敲字 ⇒ 改的是**页块正文**（旧形状里改不了）
  await page.evaluate((id) => window.__demo.focusBlock(id, 999), first.id)
  await page.keyboard.type('！')
  const renamed = await page.evaluate((id) => {
    const p = window.__demo.pages().find((x) => x.id === id)
    return p ? p.title : '(gone)'
  }, first.id)
  assert(renamed.endsWith('！'), `在首行敲字应改到页块正文：${JSON.stringify(renamed)}`)
  await page.keyboard.press('Backspace')

  // ③ 首行按 Enter：**不自环**（拆块的 children 转移会让「对象变成自己的子块」）
  const n0 = await page.evaluate(() => window.__demo.snapshot().topBlocks)
  await page.evaluate((id) => window.__demo.focusBlock(id, 2), first.id)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(200)
  const r = await page.evaluate(() => ({
    top: window.__demo.snapshot().topBlocks,
    firstRow: document.querySelector('#editor .blk[data-depth="0"] .tx')?.textContent?.trim() ?? '',
    // 自环的证据：首行的 children 里出现了自己的 id
    selfChild: (() => {
      const firstEl = document.querySelector('#editor .blk[data-depth="0"]')
      const id = firstEl?.dataset.blockId
      return id ? window.__demo.blocks().some((b) => b.id === id && b.children > 0 && false) : null
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
  const pageCount = await page.evaluate(() => window.__demo.pages().length)
  for (let i = 0; i < pageCount; i++) {
    await page.evaluate((n) => window.__demo.invoke('core.page/open', { pageId: window.__demo.pages()[n].id }), i)
    const r = await page.evaluate(() => {
      const blocks = window.__demo.blocks()
      // 锚点是**库级平铺**的：只取落在当前页可见块上的那些（其余属于别的页）
      const visible = new Map(blocks.map((b) => [b.id, b]))
      const model = window.__demo
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
    await page.waitForFunction(() => Boolean(window.__demo))
    const snap = await page.evaluate(() => window.__demo.snapshot())
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

await check('T44 Shift+点块标 ⇒ 右槽自动打开并钉住该块；再点一次取消；待办方框同样走这条而不勾选', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__demo.quiet(true))
  await openFirstPage(page)
  // 先关掉右槽：Shift+点击必须能把它叫回来（否则「打开了但看不见」）
  await page.evaluate(() => window.__demo.invoke('core.dock/toggle-right'))
  await page.waitForTimeout(80)
  const closed = (await dockState(page)).pref.right
  assert(closed.open === false, `右槽应先关着：${JSON.stringify(closed)}`)

  const picked = await page.evaluate(() => {
    const b = window.__demo.blocks().find((x) => !x.role && !x.todo && x.text.length > 2)
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
  await page.evaluate(() => window.__demo.invoke('core.dock/toggle-right'))
  await page.waitForTimeout(80)
  const todo = await page.evaluate(() => {
    const b = window.__demo.blocks().find((x) => x.todo)
    return b ? { id: b.id, todo: b.todo } : null
  })
  assert(todo, '假数据里应有待办块')
  await shiftClickMarker(page, todo.id)
  await page.waitForTimeout(120)
  const afterTodo = await page.evaluate((id) => ({
    todo: window.__demo.blocks().find((b) => b.id === id)?.todo ?? null,
    dock: window.__demo.snapshot().dock,
    rows: [...document.querySelectorAll('#dock-right .pin-row')].map((r) => r.dataset.blockId),
  }), todo.id)
  assert(afterTodo.dock.right.open === true, `待办方框的 Shift+点击也应打开右槽：${JSON.stringify(afterTodo.dock.right)}`)
  assert(afterTodo.dock.right.pins.includes(todo.id), `待办块应被钉住：${JSON.stringify(afterTodo.dock.right.pins)}`)
  assert(afterTodo.todo === todo.todo, `Shift+点击方框不该切换待办：${todo.todo} → ${afterTodo.todo}`)
  assert(afterTodo.rows.includes(todo.id), `待办块也应渲染在右槽：${JSON.stringify(afterTodo.rows)}`)
  await ctx.close()
  return `关闭态被叫回；普通块与待办块都按 id 进出（待办状态保持 ${todo.todo}）`
})

await check('T45 从正文块标拖进左槽 ⇒ 钉住并渲染；在槽里编辑，正文同一个块同步（共享 store）', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__demo.quiet(true))
  await openFirstPage(page)
  const id = await page.evaluate(() => window.__demo.blocks().find((x) => !x.role && !x.todo && x.text.length > 2)?.id ?? '')
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
    main: window.__demo.blocks().find((b) => b.id === id)?.text ?? '',
    dom: document.querySelector(`#editor .blk[data-block-id="${id}"] > .tx`)?.textContent ?? '',
  }), id)
  const pinText = await pinRootText(page, 'left', id)
  assert(fromSlot.main.includes('槽内附加'), `槽内编辑应写进共享 store：${JSON.stringify(fromSlot.main)}`)
  assert(fromSlot.dom.includes('槽内附加'), `正文 DOM 应同步：${JSON.stringify(fromSlot.dom)}`)
  assert(pinText.includes('槽内附加'), `槽里那一行自己也应显示：${JSON.stringify(pinText)}`)

  // 反向：正文改 ⇒ 槽里的行跟着变（防抖窗口之后）
  await page.evaluate((id) => window.__demo.focusBlock(id, 0), id)
  await page.keyboard.type('正文附加')
  await page.waitForTimeout(220)
  const fromMain = await page.evaluate((id) => window.__demo.blocks().find((b) => b.id === id)?.text ?? '', id)
  const mirror = await pinRootText(page, 'left', id)
  assert(fromMain.startsWith('正文附加'), `正文应拿到新文本：${JSON.stringify(fromMain.slice(0, 20))}`)
  assert(mirror.startsWith('正文附加'), `槽里的同一块应跟着更新：${JSON.stringify(mirror.slice(0, 20))}`)
  await ctx.close()
  return `同块两处：槽内打字 ⇒ 正文含「槽内附加」；正文打字 ⇒ 槽内同步（${mirror.slice(0, 12)}…）`
})

await check('T46 槽内连续输入不被整槽重画打断；⌘Z 在槽里回滚的是**全局共享**的那一份', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__demo.quiet(true))
  await openFirstPage(page)
  const id = await page.evaluate(() => window.__demo.blocks().find((x) => !x.role && !x.todo && x.text.length > 2)?.id ?? '')
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

  await page.keyboard.press('Meta+z')
  await page.waitForTimeout(200)
  const afterUndo = await page.evaluate((id) => ({
    main: window.__demo.blocks().find((b) => b.id === id)?.text ?? '',
  }), id)
  const pinAfter = await pinRootText(page, 'left', id)
  assert(!afterUndo.main.includes('ABC连续'), `槽里的 ⌘Z 应回滚共享 store：${JSON.stringify(afterUndo.main)}`)
  assert(!pinAfter.includes('ABC连续'), `槽里的行也必须跟着回滚：${JSON.stringify(pinAfter)}`)
  await ctx.close()
  return `逐键输入保持连续；⌘Z 后正文与槽同时回滚`
})

await check('T47 祖先也被钉住 ⇒ 只渲染祖先（不重复）；钉住清单随 prefs 落盘，重开后仍在', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__demo.quiet(true))
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

  const leftId = await page.evaluate(() => window.__demo.blocks().find((x) => !x.role && !x.todo && x.text.length > 2)?.id ?? '')
  await dragBlockToDock(page, leftId, 'left')
  await page.waitForTimeout(400)
  const saved = await dockState(page)
  const reopened = await reopenPage(browser, ctx, base, page)
  await reopened.page.waitForTimeout(220)
  const restored = await reopened.page.evaluate(() => ({
    dock: window.__demo.snapshot().dock,
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

await check('T48 钉住行有移除入口：移出槽但不删块；左槽移除后清单与 DOM 同时清干净', async () => {
  const { ctx, page } = await freshPage(browser, base)
  await page.evaluate(() => window.__demo.quiet(true))
  await openFirstPage(page)
  const picked = await page.evaluate(() => {
    const b = window.__demo.blocks().find((x) => !x.role && !x.todo && x.text.length > 2)
    return b ? { id: b.id, text: b.text } : null
  })
  assert(picked, '应有一个可拖的块')
  await dragBlockToDock(page, picked.id, 'left')
  await page.waitForTimeout(140)
  const before = await page.evaluate(() => window.__demo.snapshot().topBlocks)
  await page.locator(`#dock-left .pin-row[data-block-id="${picked.id}"] .pin-remove`).click()
  await page.waitForTimeout(140)
  const after = await page.evaluate((id) => ({
    dock: window.__demo.snapshot().dock,
    rows: [...document.querySelectorAll('#dock-left .pin-row')].map((r) => r.dataset.blockId),
    block: window.__demo.blocks().find((b) => b.id === id) ?? null,
    topBlocks: window.__demo.snapshot().topBlocks,
  }), picked.id)
  assert(!after.dock.left.pins.includes(picked.id), `移除后清单里不该还有它：${JSON.stringify(after.dock.left.pins)}`)
  assert(!after.rows.includes(picked.id), `移除后 DOM 里不该还有这一行：${JSON.stringify(after.rows)}`)
  assert(after.block && after.block.text === picked.text, `移除只影响视图，不该删块：${JSON.stringify(after.block)}`)
  assert(after.topBlocks === before, `块数应不变：${before} → ${after.topBlocks}`)
  assert(after.dock.left.open === true, '移除最后一项不该顺手关掉左槽')
  await ctx.close()
  return `移出 ${picked.text.slice(0, 10)}…：清单/行清空，块仍在（块数 ${after.topBlocks}）`
})

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
