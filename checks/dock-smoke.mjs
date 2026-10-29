/**
 * `pnpm check:dock` ——三槽与排版形状的**布局断言**的 A 系列 ＋ 宽度口径）。
 *
 * 为什么单独一个文件（而不是塞进 smoke）：这里全部是**量尺寸**的断言（getBoundingClientRect /
 * getComputedStyle / 改视口），与 smoke 的「敲字／按键／交互」是两类测试；混在一起会让
 * 一次视口变更波及后面所有用例。
 *
 * ⚠️ **只断言能测的**：A5／A6／A9／A10／A11 依赖「视图块系统 / 布局型块 / 编辑态 / 深度上限 /
 * minW 类型声明」——这些在当前实现里**还不存在**，本文件把它们显式标成 SKIP 并写明理由，
 * 不假装通过（宁可少一条绿，不要一条假绿）。
 */
import { assert, freshPage, launch, resolveBase } from '../scripts/harness.mjs'

const results = []
async function check(name, fn) {
  try {
    const msg = await fn()
    results.push({ name, ok: true, msg: msg ?? '' })
  } catch (e) {
    results.push({ name, ok: false, msg: e?.message ?? String(e) })
  }
}
function skip(name, why) {
  results.push({ name, ok: true, skip: true, msg: `SKIP —— ${why}` })
}

const { base, mode, server } = await resolveBase()
const browser = await launch()
console.log(`\n布局断言：${base}（${mode}）\n`)

/* ---------------------------------------------------------------- 工具 */

/** 三槽的实测矩形（px） */
/** ⚠️ 这个函数会被 `page.evaluate(dockBox)` 序列化后**在页面里跑**，所以不能引用外部变量 */
const dockBox = () =>
  ['left', 'center', 'right'].reduce((acc, side) => {
    const el = document.getElementById(`dock-${side}`)
    if (!el) return acc
    const r = el.getBoundingClientRect()
    acc[side] = { x: r.x, w: r.width, visible: getComputedStyle(el).visibility !== 'hidden' }
    return acc
  }, {})

const setOpen = (page, left, right) =>
  page.evaluate(
    (s) => {
      document.body.dataset.dockLeft = s.left ? 'open' : 'closed'
      document.body.dataset.dockRight = s.right ? 'open' : 'closed'
    },
    { left, right },
  )

/** 打开一页并等排版稳定 */
async function openFirstPage(page) {
  await page.evaluate(() => window.__qua.invoke('core.page/open', { pageId: window.__qua.pages()[0].id }))
  await page.waitForTimeout(200)
}

/* ---------------------------------------------------------------- A13 */

await check('A13 左右槽是对称实例：同一容器类型、同一 class 前缀，差异只在 data-dock', async () => {
  const { ctx, page } = await freshPage(browser, base, { viewport: { width: 1440, height: 900 } })
  await page.evaluate(() => window.__qua.quiet(true))
  /**
   * ⚠️ A13 的口径是「**两栏是对称实例**」，不是「两栏内容一样」。
   * 槽里装的是**块**，左右槽装的块本来就不同（左＝今日，右＝反链）
   *   ⇒ 比「内部标签序列」会把**内容差异**误判成**结构不对称**。
   *    正确的判据是：**槽自身的骨架**（tag / class / data-dock / 直接子元素结构）一致，
   *    差异只在 `data-dock` 与槽里的内容。
   */
  const shape = await page.evaluate(() => {
    const pick = (id) => {
      const el = document.getElementById(id)
      const head = el.querySelector(':scope > .dock-head')
      const stack = el.querySelector(':scope > .dock-stack')
      return {
        tag: el.tagName,
        classes: [...el.classList].sort().join(' '),
        dock: el.dataset.dock,
        // 直接子元素的骨架（不递归进块内容）
        children: [...el.children].map((c) => `${c.tagName}.${[...c.classList].sort().join('.')}`).join(' | '),
        headClasses: head ? [...head.classList].sort().join(' ') : '(none)',
        headChildren: head ? [...head.children].map((c) => c.tagName).join(',') : '(none)',
        stackClasses: stack ? [...stack.classList].sort().join(' ') : '(none)',
      }
    }
    return { left: pick('dock-left'), right: pick('dock-right') }
  })
  assert(shape.left.tag === shape.right.tag, `左右槽标签应一致：${shape.left.tag} vs ${shape.right.tag}`)
  assert(shape.left.classes === shape.right.classes, `左右槽 class 应一致：${shape.left.classes} vs ${shape.right.classes}`)
  assert(shape.left.dock === 'left' && shape.right.dock === 'right', `差异应只在 data-dock：${JSON.stringify(shape)}`)
  assert(shape.left.children === shape.right.children, `槽骨架应一致：\n  ${shape.left.children}\n  ${shape.right.children}`)
  assert(shape.left.headChildren === shape.right.headChildren, `槽抬头骨架应一致：${shape.left.headChildren} vs ${shape.right.headChildren}`)
  await ctx.close()
  return `同构 ${shape.left.tag}.${shape.left.classes}｜子元素 ${shape.left.children}（data-dock 分别 left/right；槽内块不同属内容差异）`
})

/* ---------------------------------------------------------------- A14 */

await check('A14 非压缩区间：开关一槽，另一槽宽度不变；中心槽吃掉差值', async () => {
  const { ctx, page } = await freshPage(browser, base, { viewport: { width: 1440, height: 900 } })
  await page.evaluate(() => window.__qua.quiet(true))
  const before = await page.evaluate(dockBox)
  assert(before.left.visible && before.right.visible, `默认两槽应都开：${JSON.stringify(before)}`)

  // 关右槽 ⇒ 左槽宽不变、中心槽变宽
  await setOpen(page, true, false)
  await page.waitForTimeout(120)
  const noRight = await page.evaluate(dockBox)
  assert(Math.abs(noRight.left.w - before.left.w) <= 1, `关右槽不该改变左槽宽：${before.left.w} → ${noRight.left.w}`)
  assert(noRight.center.w > before.center.w, `关右槽后中心槽应变宽：${before.center.w} → ${noRight.center.w}`)

  // 关左槽 ⇒ 右槽宽不变
  await setOpen(page, false, true)
  await page.waitForTimeout(120)
  const noLeft = await page.evaluate(dockBox)
  assert(Math.abs(noLeft.right.w - before.right.w) <= 1, `关左槽不该改变右槽宽：${before.right.w} → ${noLeft.right.w}`)
  await ctx.close()
  return `左 ${before.left.w}→${noRight.left.w}（关右）/ 右 ${before.right.w}→${noLeft.right.w}（关左），中心 ${before.center.w}→${noRight.center.w}`
})

/* ---------------------------------------------------------------- A15 */

await check('A15 宽度手柄：拖动改宽并落盘、clamp 保证中心槽可用；双击恢复默认；关闭/压缩区间不给手柄', async () => {
  const { ctx, page } = await freshPage(browser, base, { viewport: { width: 1440, height: 900 } })
  await page.evaluate(() => window.__qua.quiet(true))

  const read = () =>
    page.evaluate(() => {
      const w = (side) => document.getElementById(`dock-${side}`).getBoundingClientRect().width
      const display = (side) => getComputedStyle(document.querySelector(`#dock-${side} .dock-resize`)).display
      return {
        widths: { left: w('left'), center: w('center'), right: w('right') },
        handles: { left: display('left'), right: display('right') },
        dock: window.__qua.snapshot().dock,
        inner: window.innerWidth,
        over: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      }
    })

  /** 用真鼠标从手柄中点拖 dx（左槽向右为正；右槽向左为正） */
  const drag = async (side, dx) => {
    const box = await page.locator(`#dock-${side} .dock-resize`).boundingBox()
    assert(box, `${side} 槽手柄应有可拖区域`)
    const x = box.x + box.width / 2
    const y = box.y + Math.min(120, box.height / 2)
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + dx, y, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(120)
  }

  /**
   * token 里的默认槽宽：**从 CSS 读，不写死在断言里**。
   *
   * 早先这里直接写 `236` / `320`，于是「改默认宽度」这种纯外观调整会把门禁打红，
   * 而红的是断言本身（它测的是「等于我记住的那个数」），不是行为。
   * 现在它测的是「双击 == 交回 token 默认」这条真性质。
   */
  const tokenDefault = (side) =>
    page.evaluate(
      (s) => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(`--ui-dock-w-${s}`)),
      side,
    )
  const defLeft = await tokenDefault('left')
  const defRight = await tokenDefault('right')

  const start = await read()
  assert(start.dock.left.width === null && Math.abs(start.widths.left - defLeft) <= 1, `初始应是 token 默认宽（${defLeft}）：${JSON.stringify(start)}`)
  assert(start.handles.left !== 'none' && start.handles.right !== 'none', `开着的槽应显示手柄：${JSON.stringify(start.handles)}`)

  // 左槽向右拖 120：宽度跟着变、写进 prefs、中心槽仍有可用空间
  await drag('left', 120)
  const wide = await read()
  assert(Math.abs(wide.widths.left - (start.widths.left + 120)) <= 2, `左槽应跟着拖宽：${start.widths.left} → ${wide.widths.left}`)
  assert(wide.dock.left.width === Math.round(wide.widths.left), `prefs 里应写入实测宽度：${JSON.stringify(wide.dock.left)}`)
  assert(wide.widths.center >= 480, `中心槽不该被挤到 480 以下：${wide.widths.center}`)
  assert(!wide.over, `拖宽不该横向溢出：${JSON.stringify(wide.widths)}`)

  // 关掉再打开：宽度从 prefs 写回（冷启动 / 切槽走的是同一条 applyChrome）
  await page.evaluate(() => window.__qua.invoke('core.dock/toggle-left'))
  await page.waitForTimeout(120)
  const hidden = await read()
  assert(hidden.widths.left <= 0.5, `关掉的左槽应把列宽收成 0：${hidden.widths.left}`)
  await page.evaluate(() => window.__qua.invoke('core.dock/toggle-left'))
  await page.waitForTimeout(120)
  const reopened = await read()
  assert(
    Math.abs(reopened.widths.left - wide.widths.left) <= 1 && reopened.dock.left.width === wide.dock.left.width,
    `重新打开应从 prefs 写回宽度：${JSON.stringify(reopened.dock.left)} / ${reopened.widths.left}`,
  )

  // 拖到远超上限：宽度停在 clamp（视口 − 另一侧 − 中心保底）上，中心槽仍在
  await drag('left', 2000)
  const capped = await read()
  const max = capped.inner - start.widths.right - 480
  assert(Math.abs(capped.widths.left - max) <= 2, `宽度应被 clamp 到 ${max}：${capped.widths.left}`)
  assert(capped.widths.center >= 480 - 1 && !capped.over, `clamp 后中心槽仍应可用：${JSON.stringify(capped.widths)}`)

  // 双击手柄 ⇒ 交回 token 默认
  await page.locator('#dock-left .dock-resize').dblclick()
  await page.waitForTimeout(120)
  const reset = await read()
  assert(reset.dock.left.width === null, `双击后 prefs.width 应为 null：${JSON.stringify(reset.dock.left)}`)
  assert(Math.abs(reset.widths.left - defLeft) <= 1, `双击后应回到默认宽 ${defLeft}：${reset.widths.left}`)

  // 右槽：向左拖 100 ⇒ 变宽（左右手柄方向相反）
  const rightBefore = reset.widths.right
  await drag('right', -100)
  const rightAfter = await read()
  assert(Math.abs(rightAfter.widths.right - (rightBefore + 100)) <= 2, `右槽应向左拖变宽：${rightBefore} → ${rightAfter.widths.right}`)
  assert(rightAfter.dock.right.width === Math.round(rightAfter.widths.right), `右槽宽度应落盘：${JSON.stringify(rightAfter.dock.right)}`)
  await page.locator('#dock-right .dock-resize').dblclick()
  await page.waitForTimeout(120)
  const rightReset = await read()
  assert(rightReset.dock.right.width === null && Math.abs(rightReset.widths.right - defRight) <= 1, `右槽双击恢复默认 ${defRight}：${JSON.stringify(rightReset.dock.right)} / ${rightReset.widths.right}`)

  // 关闭的槽不可拖（手柄不可见）
  await setOpen(page, true, false)
  await page.waitForTimeout(120)
  const closed = await read()
  assert(closed.handles.right === 'none', `关掉的右槽不该露出手柄：${JSON.stringify(closed.handles)}`)
  await setOpen(page, true, true)

  // 压缩区间（< 840）：手柄收起，宽度回落到下限，且不横向溢出
  await page.setViewportSize({ width: 800, height: 900 })
  await page.waitForTimeout(120)
  const compact = await read()
  assert(compact.handles.left === 'none' && compact.handles.right === 'none', `压缩区间应收起手柄：${JSON.stringify(compact.handles)}`)
  assert(Math.abs(compact.widths.left - 180) <= 1 && Math.abs(compact.widths.right - 180) <= 1, `压缩区间两侧应锁在下限：${JSON.stringify(compact.widths)}`)
  assert(!compact.over, `压缩区间不该横向溢出：${JSON.stringify(compact.widths)}`)

  await ctx.close()
  return `左 ${defLeft}→${Math.round(wide.widths.left)}（clamp ${max}）→双击 ${defLeft}；右 ${defRight}→${Math.round(rightAfter.widths.right)}；关闭/800px 均无手柄`
})

/* ---------------------------------------------------------------- A17 */

await check('A18 小卡按列均分、整排右缘与大卡对齐；高度固定 44px；大卡跨整行', async () => {
  const { ctx, page } = await freshPage(browser, base, { viewport: { width: 1440, height: 900 } })
  await page.evaluate(() => window.__qua.quiet(true))
  const m = await page.evaluate(() => {
    const stack = document.getElementById('dock-left-stack')
    const cs = getComputedStyle(stack)
    const sr = stack.getBoundingClientRect()
    const tiles = [...stack.querySelectorAll(':scope > .dock-tile')].map((el) => {
      const r = el.getBoundingClientRect()
      return { w: +r.width.toFixed(1), h: +r.height.toFixed(1), top: +r.top.toFixed(1), left: +r.left.toFixed(1), right: +r.right.toFixed(1) }
    })
    const card = [...stack.querySelectorAll(':scope > .dock-card')].find((el) => !el.hidden)
    const cr = card ? card.getBoundingClientRect() : null
    return {
      tiles,
      rightTiles: document.querySelectorAll('#dock-right-stack > .dock-tile').length,
      stack: { left: +sr.left.toFixed(1), right: +sr.right.toFixed(1), width: +sr.width.toFixed(1) },
      padL: parseFloat(cs.paddingLeft),
      padR: parseFloat(cs.paddingRight),
      gap: parseFloat(cs.gap),
      card: cr ? { left: +cr.left.toFixed(1), right: +cr.right.toFixed(1), top: +cr.top.toFixed(1), width: +cr.width.toFixed(1) } : null,
    }
  })

  assert(m.tiles.length === 4, `默认左槽应有 4 张小卡，实际 ${m.tiles.length}`)
  assert(m.rightTiles === 0, `默认右槽不该有小卡，实际 ${m.rightTiles}`)

  /**
   * **判据（对齐，不是绝对宽度）**：小卡排成一整行时，**最后一格的右缘 ＝ 大卡的右缘
   * ＝ 内容区右缘**。
   *
   * 为什么不再断言「固定 44px」：固定宽会留下一条 30px 的尾巴（224px 的内容区
   * 只放得下 4×44 ＋ 3×6 ＝ 194px），于是小卡右缘与大卡右缘差 30px —— 看起来像没摆正。
   * 现在列宽由网格均分，格子会在 40–56px 之间浮动，但**右缘永远对齐**。
   * 宽度只保留一个「不许被压成一条」的下限。
   */
  const last = m.tiles[m.tiles.length - 1]
  const contentRight = m.stack.right - m.padR
  assert(Math.abs(last.right - contentRight) <= 1, `最后一格小卡应贴内容区右缘（不留尾巴）：${JSON.stringify({ last, contentRight })}`)
  assert(Math.abs(m.card.right - contentRight) <= 1, `大卡右缘也应贴内容区右缘（两者必须对齐）：${JSON.stringify(m.card)}`)
  assert(Math.abs(last.right - m.card.right) <= 1, `小卡与大卡的右缘必须对齐：${JSON.stringify({ tileRight: last.right, cardRight: m.card.right })}`)

  for (const t of m.tiles) {
    assert(t.h === 44, `小卡高度仍固定 44px（一排要一样高）：${JSON.stringify(t)}`)
    // 宽度均分后不许被压成一条（槽很窄时列会缩，但不该小于可点的下限）
    assert(t.w >= 36, `小卡宽度不该被压到不可点：${JSON.stringify(t)}`)
  }

  const tops = [...new Set(m.tiles.map((t) => t.top))]
  assert(tops.length === 1, `同一行小卡应顶对齐：${JSON.stringify(tops)}`)
  assert(Math.abs(m.tiles[0].left - (m.stack.left + m.padL)) <= 0.5, `第一张小卡应贴内容区左缘：${JSON.stringify(m)}`)

  // 间距恒等：相邻两格的缝必须都一样（均分之后仍要守这条，否则「看起来不齐」会以另一种形式回来）
  const gaps = m.tiles.slice(1).map((t, i) => +(t.left - m.tiles[i].right).toFixed(1))
  assert(new Set(gaps).size === 1, `相邻小卡的缝必须恒等：${JSON.stringify(gaps)}`)

  assert(m.card, '默认左槽应有一张大卡')
  assert(m.card.top >= m.tiles[0].top + 44, `大卡应换到小卡下一行：${JSON.stringify(m)}`)
  assert(Math.abs(m.card.width - (m.stack.width - m.padL - m.padR)) <= 1, `大卡应跨整行：${JSON.stringify(m)}`)

  await ctx.close()
  return `左槽 4 张小卡均分（各 ${m.tiles[0].w}px）、右缘与大卡对齐（${last.right}＝${m.card.right}）；高度 44px；右槽 0 张小卡`
})

/* ---------------------------------------------------------------- 保底 */

await check('中心槽保底 480：840 以上守住；840 以下解除且**无横向溢出**', async () => {
  const { ctx, page } = await freshPage(browser, base, { viewport: { width: 1440, height: 900 } })
  await page.evaluate(() => window.__qua.quiet(true))
  const rows = []
  for (const w of [1440, 1100, 1036, 1000, 900, 840, 839, 800, 760, 720]) {
    await page.setViewportSize({ width: w, height: 900 })
    await page.waitForTimeout(80)
    const m = await page.evaluate(() => {
      // ⚠️ 这里在**页面上下文**里跑：不能调用 Node 侧的 `dockBox`，只能内联同样的量法
      const box = (side) => {
        const el = document.getElementById(`dock-${side}`)
        return el ? el.getBoundingClientRect().width : 0
      }
      return {
        left: { w: box('left') },
        center: { w: box('center') },
        right: { w: box('right') },
        over: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      }
    })
    rows.push({ w, left: Math.round(m.left.w), center: Math.round(m.center.w), right: Math.round(m.right.w), over: m.over })
  }
  for (const r of rows) {
    assert(!r.over, `${r.w}px 宽不该横向溢出：${JSON.stringify(r)}`)
    if (r.w >= 840) assert(r.center >= 480, `${r.w}px 宽中心槽应保住 480：${r.center}`)
    assert(r.left >= 180 - 1 && r.right >= 180 - 1, `${r.w}px 宽侧槽应不低于 180：${JSON.stringify(r)}`)
  }
  await ctx.close()
  return rows.map((r) => `${r.w}:${r.left}/${r.center}/${r.right}`).join(' ')
})

/* ---------------------------------------------------------------- A1 */

await check('A1 同容器相邻块间距全等（offset 差值集合大小 = 1）', async () => {
  const { ctx, page } = await freshPage(browser, base, { viewport: { width: 1440, height: 900 } })
  await page.evaluate(() => window.__qua.quiet(true))
  await openFirstPage(page)
  // 取同一层（data-depth 相同且相邻）的块，量「上一块底 → 本块顶」的间距
  const gaps = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#editor .blk')]
    const out = []
    for (let i = 1; i < rows.length; i++) {
      const d = rows[i].dataset.depth
      if (rows[i - 1].dataset.depth !== d) continue
      const a = rows[i - 1].getBoundingClientRect()
      const b = rows[i].getBoundingClientRect()
      out.push(Math.round((b.top - a.bottom) * 10) / 10)
    }
    return out
  })
  assert(gaps.length >= 3, `假数据里应有足够多的同层相邻块，实际 ${gaps.length}`)
  const uniq = [...new Set(gaps)]
  assert(uniq.length === 1, `同容器相邻块间距应全等，实测 ${JSON.stringify(uniq)}（样本 ${gaps.length}）`)
  await ctx.close()
  return `${gaps.length} 对相邻块，间距恒为 ${uniq[0]}px`
})

/* ---------------------------------------------------------------- A2 */

await check('A2 通用块样式 padding-block / margin 为 0（S2：豁免只有渲染器 inset）', async () => {
  const { ctx, page } = await freshPage(browser, base, { viewport: { width: 1440, height: 900 } })
  await page.evaluate(() => window.__qua.quiet(true))
  await openFirstPage(page)

  /**
   * ⚠️ 口径：**通用块样式**里 `padding-block: 0; margin: 0`。
   *    「块的垂直留白只来自渲染器的 inset 与容器的 gap」。
   *
   *    ⚠️ 2026-10-20：**甲/乙/丙三皮肤整体删除**，内建只有一种样式
   *       ⇒ 原先「甲必须全 0、丙卡片允许 inset」的两段测量失去对象。
   *       现在的口径更简单也更严：**单一样式下所有块都该全零**（没有卡片渲染器了）。
   */
  const read = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('#editor .blk')].map((el) => {
        const s = getComputedStyle(el)
        return {
          depth: el.dataset.depth,
          pad: parseFloat(s.paddingTop) + parseFloat(s.paddingBottom),
          mar: parseFloat(s.marginTop) + parseFloat(s.marginBottom),
        }
      }),
    )

  const all = await read()
  const bad = all.filter((x) => x.pad > 0.5 || x.mar > 0.5)
  assert(all.length > 0, '应有块')
  assert(bad.length === 0, `块的 padding-block/margin 必须为 0（间距归容器）：${JSON.stringify(bad.slice(0, 4))}`)

  await ctx.close()
  return `单一内建样式：${all.length} 块全零 padding-block/margin（三皮肤已删）`
})

/* ---------------------------------------------------------------- A3 */

await check('A3 嵌套深度 ≥1 的块不带 border / box-shadow（层级不靠画框）', async () => {
  const { ctx, page } = await freshPage(browser, base, { viewport: { width: 1440, height: 900 } })
  await page.evaluate(() => window.__qua.quiet(true))
  await openFirstPage(page)
  const bad = await page.evaluate(() => {
    const out = []
    for (const el of document.querySelectorAll('#editor .blk')) {
      if (Number(el.dataset.depth) < 1) continue
      const s = getComputedStyle(el)
      const bw = parseFloat(s.borderTopWidth) + parseFloat(s.borderBottomWidth) + parseFloat(s.borderLeftWidth) + parseFloat(s.borderRightWidth)
      if (bw > 0.5 || s.boxShadow !== 'none') out.push({ depth: el.dataset.depth, bw, shadow: s.boxShadow })
    }
    return out
  })
  assert(bad.length === 0, `嵌套块不该有 border/shadow：${JSON.stringify(bad.slice(0, 4))}`)
  await ctx.close()
  return `深度 ≥1 的块全部无 border / 无 shadow`
})

/* ---------------------------------------------------------------- A7 */

await check('A7 正文行宽不超过 measure，且不窄于可读下限', async () => {
  const { ctx, page } = await freshPage(browser, base, { viewport: { width: 1440, height: 900 } })
  await page.evaluate(() => window.__qua.quiet(true))
  await openFirstPage(page)
  const m = await page.evaluate(() => {
    const doc = document.getElementById('doc')
    const cs = getComputedStyle(document.documentElement)
    const measure = parseFloat(getComputedStyle(doc).width)
    const limit = parseFloat(cs.getPropertyValue('--ui-editor-w')) || 720
    const fs = parseFloat(getComputedStyle(doc).fontSize) || 16
    return { measure, limit, fs, docW: Math.round(doc.getBoundingClientRect().width) }
  })
  // 20em 的可读下限按**正文基准字号**算
  const minReadable = m.fs * 20
  assert(m.measure <= m.limit + 1, `正文宽 ${m.measure} 不应超过 measure ${m.limit}`)
  assert(m.measure >= Math.min(minReadable, 320), `正文不该窄到不可读（20em≈${Math.round(minReadable)}，实际 ${m.measure}）`)
  await ctx.close()
  return `正文栏 ${m.docW}px（measure 上限 ${m.limit}px，20em≈${Math.round(minReadable)}px）`
})

/* ---------------------------------------------------------------- A8 */

await check('A8 View 态没有缩放手柄；拖拽把手已并进块标，静止态不可见', async () => {
  const { ctx, page } = await freshPage(browser, base, { viewport: { width: 1440, height: 900 } })
  await page.evaluate(() => window.__qua.quiet(true))
  await openFirstPage(page)
  const r = await page.evaluate(() => {
    const visible = (el) => {
      const s = getComputedStyle(el)
      return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.01
    }
    return {
      resizes: document.querySelectorAll('#editor .resize, #editor [data-resize]').length,
      // D4：把手与块标合并 ⇒ 不再有独立的 `.handle` 槽位；判据改为「抓手图标静止不可见」
      grips: [...document.querySelectorAll('#editor .marker .grip')].filter(visible).length,
      gripTotal: document.querySelectorAll('#editor .marker .grip').length,
      // 编辑器失焦 = View 态
      focusInEditor: document.getElementById('editor').contains(document.activeElement),
    }
  })
  assert(r.resizes === 0, `View 态不该有缩放手柄：${r.resizes}`)
  assert(r.grips === 0, `View 态（编辑器失焦）不该有可见的抓手图标，实际 ${r.grips}/${r.gripTotal}`)
  await ctx.close()
  return `View 态：可见抓手 ${r.grips}/${r.gripTotal} 个、缩放手柄 ${r.resizes} 个（把手已并进块标，D4）`
})

/* ---------------------------------------------------------------- A16 */

await check('A16 每一行的块标与正文首行共中线（含子块；跨字号与密度）', async () => {
  const { ctx, page } = await freshPage(browser, base, { viewport: { width: 1440, height: 900 } })
  await page.evaluate(() => window.__qua.quiet(true))
  /**
   * ⚠️ 冷启动是**日记流**：段头那行字在 `::before`（`_date` 的只读投影）里，
   *    不是文本节点 ⇒ 取不到字形盒。要测「深度 0 的大字号行」得先打开一页
   *    （页块作为正文第一行时用 `--ui-fs-lg`，正文是可编辑的描述）。
   */
  await openFirstPage(page)
  await page.waitForTimeout(150)

  /**
   * **判据**：同一行里「块标中心」与「正文首行的**行盒中心**」同高（差 ≤ 0.6px）。
   *
   * 为什么不能拿 `--ui-line-h` 当基准：它是**行高下限**（28px），而正文首行的行盒是
   * `字号 × --ui-lh-relaxed`（子块 13.5 × 1.85 ≈ 25px，深度 0 ≈ 28.7px）。
   * 两者不是同一个数 ⇒ 用固定高度给 gutter 定高时，**只有字号恰好撑满 28px 的行**看起来齐
   * （聚焦块正好如此，于是「只有它对齐」）。gutter 必须按 `1lh` 跟这一行自己的字号走。
   *
   * ⚠️ 量的是**行盒**（`.tx` 顶部 ＋ 一个 `line-height`），不是字形盒（Range 的 client rects）：
   *    字形盒是字体的 em 框，同一段文字在 14.5px 与 15.5px 下各有自己的舍入，
   *    拿它当基准会引入 0.5–1px 的字体度量噪声（实测同一条规则在压缩密度下报 0.91px）。
   *    块标本来就跟行盒居中，行盒才是它该对齐的东西。
   * ⚠️ 要**跨字号**取样：只测一种字号时比值恒等，上面那个 bug 从 28 ≡ 28 里看不出来。
   */
  const measure = () =>
    page.evaluate(() => {
      const out = []
      for (const el of document.querySelectorAll('#editor .blk')) {
        const tx = el.querySelector(':scope > .tx')
        const mk = el.querySelector(':scope > .left > .marker')
        if (!tx || !mk) continue
        const cs = getComputedStyle(tx)
        const lh = parseFloat(cs.lineHeight)
        const t = tx.getBoundingClientRect()
        const m = mk.getBoundingClientRect()
        const rule = tx.querySelector(':scope > .divider-rule')
        // 分割线没有字：它的「行」就是那条线本身
        const ref = rule ? (r) => (r.top + r.bottom) / 2 : null
        const lineCenter = rule ? ref(rule.getBoundingClientRect()) : t.top + lh / 2
        out.push({
          depth: Number(el.dataset.depth),
          fs: parseFloat(cs.fontSize),
          kind: rule ? 'divider' : (tx.textContent ?? '').trim() ? 'text' : 'empty',
          delta: Math.round((m.top + m.height / 2 - lineCenter) * 100) / 100,
          text: (tx.textContent ?? '').slice(0, 10),
        })
      }
      return out
    })

  const rows = await measure()
  assert(rows.length >= 5, `应有足够多的行可测：${rows.length}`)
  const textRows = rows.filter((r) => r.kind === 'text')
  const fontSizes = [...new Set(textRows.map((r) => r.fs))]
  assert(fontSizes.length >= 2, `样本必须跨字号（否则这条断言看不出问题）：${JSON.stringify(fontSizes)}`)
  const bad = rows.filter((r) => Math.abs(r.delta) > 0.6)
  assert(bad.length === 0, `块标应与正文首行共中线（差 ≤0.6px），实测：${JSON.stringify(bad.slice(0, 4))}`)

  // 压缩密度只改 token：同一判据必须仍成立
  await page.evaluate(() => {
    document.body.dataset.density = 'compact'
  })
  await page.waitForTimeout(150)
  const compact = await measure()
  const badCompact = compact.filter((r) => Math.abs(r.delta) > 0.6)
  assert(badCompact.length === 0, `压缩密度下块标仍应与正文首行共中线：${JSON.stringify(badCompact.slice(0, 4))}`)
  await page.evaluate(() => {
    delete document.body.dataset.density
  })

  await ctx.close()
  const worst = Math.max(...rows.map((r) => Math.abs(r.delta)))
  const worstCompact = Math.max(...compact.map((r) => Math.abs(r.delta)))
  return `${rows.length} 行 × ${fontSizes.length} 档字号（${fontSizes.join('/')}px），最大偏差 ${worst}px；压缩密度 ${worstCompact}px`
})

/* ---------------------------------------------------------------- A17 */

await check('A17 父块的竖线在本行换行后不断：自身延续段 ＋ 子行段拼成一条连续线', async () => {
  const { ctx, page } = await freshPage(browser, base, { viewport: { width: 1000, height: 900 } })
  await page.evaluate(() => window.__qua.quiet(true))
  await openFirstPage(page)

  /**
   * **判据**：把一条父块的正文写长到换行（≥3 行）之后，指向它的竖线从**它自己的块标中心**
   * 一直连到**最后一个子行的底边**，中间不许有豁口。
   *
   * 为什么会有豁口：导轨是按「每一行画**祖先**的段」生成的 —— 一条线活在**子行**上。
   * ⇒ 父块**自己那一行**没有属于它的线。父块单行时这段空隙不到 10px 看不出来，
   *   正文一换行，那几行正文的左侧就整片是空的，看起来像线断了。
   * 修法是把父块的线**两处拼起来**：自己这一行（`.rail-self`）＋ 所有子行（`.rail`）。
   *
   * ⚠️ 必须**真的写长**再量：不换行时这个 bug 的偏差小于肉眼阈值，断言会假绿。
   */
  const target = await page.evaluate(() => {
    for (const el of document.querySelectorAll('#editor .blk')) {
      if (Number(el.dataset.depth) === 1 && el.dataset.hasChildren === '1') return el.dataset.blockId
    }
    return null
  })
  assert(target, '假数据里应有「深度 1 且有子块」的行可测')

  await page.evaluate((id) => window.__qua.focusBlock(id, 0), target)
  await page.keyboard.press('End')
  await page.keyboard.type('，故意写长一点，让它换行成三行左右，再看这一块自己的竖线有没有跟着走下来。')
  await page.waitForTimeout(250)
  await page.evaluate(() => document.activeElement?.blur?.())
  await page.waitForTimeout(150)

  const r = await page.evaluate((id) => {
    const rows = [...document.querySelectorAll('#editor .blk')]
    const el = document.querySelector(`.blk[data-block-id="${id}"]`)
    const rowRect = el.getBoundingClientRect()
    const mk = el.querySelector(':scope > .left > .marker').getBoundingClientRect()
    const self = el.querySelector(':scope > .rail-self')
    // 这一块自己的线：自身段 ＋ 所有子行上指向它的段
    const segs = []
    if (self) {
      const b = self.getBoundingClientRect()
      segs.push({ top: b.top, bottom: b.bottom, src: 'self' })
    }
    for (const row of rows) {
      for (const rail of row.querySelectorAll(':scope > .rails > .rail')) {
        if (rail.dataset.foldLineFor !== id) continue
        const b = rail.getBoundingClientRect()
        segs.push({ top: b.top, bottom: b.bottom, src: 'child' })
      }
    }
    segs.sort((a, b) => a.top - b.top)
    const holes = []
    let cur = segs[0]?.top ?? 0
    for (const s of segs) {
      if (s.top - cur > 0.6) holes.push({ from: +cur.toFixed(1), to: +s.top.toFixed(1), size: +(s.top - cur).toFixed(1) })
      cur = Math.max(cur, s.bottom)
    }
    const lineX = self ? Math.round(self.getBoundingClientRect().left + self.getBoundingClientRect().width / 2) : null
    const markerX = Math.round(mk.left + mk.width / 2)
    return {
      lines: Math.round((el.querySelector(':scope > .tx').getBoundingClientRect().height) / parseFloat(getComputedStyle(el.querySelector(':scope > .tx')).lineHeight)),
      rowH: +rowRect.height.toFixed(1),
      hasSelf: Boolean(self),
      segCount: segs.length,
      startTop: segs[0] ? +segs[0].top.toFixed(1) : null,
      markerCenter: +(mk.top + mk.height / 2).toFixed(1),
      endBottom: +cur.toFixed(1),
      lastChildBottom: +rows[rows.indexOf(el) + 1] ? 0 : 0,
      holes,
      lineX,
      markerX,
    }
  }, target)

  assert(r.lines >= 3, `前置：这一块应已换行成 ≥3 行（否则看不出豁口），实际 ${r.lines} 行`)
  assert(r.hasSelf, `有子块的行应生成自己的延续段（.rail-self），实际没有`)
  assert(r.holes.length === 0, `父块的竖线在换行后不该断开，实测豁口：${JSON.stringify(r.holes)}`)
  assert(Math.abs(r.startTop - r.markerCenter) <= 1.5, `线的起点应贴着块标中心（${r.markerCenter}），实际 ${r.startTop}`)
  assert(r.lineX === r.markerX, `自己的线应与自己的块标在同一 x：线 ${r.lineX} vs 块标 ${r.markerX}`)

  /**
   * 折叠后子行不挂载 ⇒ 不留悬空的一段线。
   * ⚠️ 用的是「折**自己**」（`toggleCollapse`，也就是点折叠三角），不是「折子块」那条：
   *    折子块时父块仍展开、自身段仍然有意义；折自己才会让子行整体不挂载。
   */
  await page.evaluate((id) => window.__qua.__editor.toggleCollapse(id), target)
  await page.waitForTimeout(250)
  const folded = await page.evaluate((id) => {
    const el = document.querySelector(`.blk[data-block-id="${id}"]`)
    return { collapsed: el?.dataset.collapsed === '1', hasSelf: Boolean(el?.querySelector(':scope > .rail-self')) }
  }, target)
  assert(folded.collapsed, `前置：应已折叠：${JSON.stringify(folded)}`)
  assert(!folded.hasSelf, `折叠（子行不挂载）时不该留一段悬空的自身线段：${JSON.stringify(folded)}`)

  await ctx.close()
  return `换行 ${r.lines} 行（行高 ${r.rowH}px）时线仍连续：${r.segCount} 段、起点 ${r.startTop}（块标中心 ${r.markerCenter}）、零豁口；折叠后自身段撤掉`
})

/* ---------------------------------------------------------------- A19 */

await check('A19 浮层里的输入行：输入框拿到可用的宽度，说明文字独占一行', async () => {
  const { ctx, page } = await freshPage(browser, base, { viewport: { width: 1440, height: 900 } })
  await page.evaluate(() => window.__qua.quiet(true))
  await openFirstPage(page)

  /**
   * **判据**：`.popover-anchor`（锚文本那一行、外链输入框）里，输入框的**可用宽度**
   * 不能小于浮层内容宽的一半，且说明那一行必须**在输入框下方**（不是被挤进同一行）。
   *
   * 为什么这条要量而不是看图：说明是 `flex: 1 0 100%`——它要独占整行，
   * 但容器**不换行**时这条 basis 只会去挤同一行：输入框被压成 14px 宽、拉成 100 多像素高，
   * 外观上「浮层里有几个竖条」，而**用户打不进字**。字面看 CSS 每一条都对，
   * 缺的只是容器上的 `flex-wrap`（实测：380px 浮层里输入框只剩 14px）。
   */
  const setup = await page.evaluate(() => {
    // 先造一枚页引用，再 ⌥ 点开它的详情浮层（锚文本输入框只在这里）
    const target = window.__qua.pages()[1].id
    const b = window.__qua.blocks()[0]
    window.__qua.focusBlock(b.id, 0)
    window.__qua.invoke('core.editor/insert-page-ref', { pageId: target })
    return { blockId: b.id, target }
  })
  assert(setup.target, `前置：应能取到第二页：${JSON.stringify(setup)}`)
  await page.waitForTimeout(200)
  await page.locator(`#editor .atom-page`).first().click({ modifiers: ['Alt'] })
  await page.waitForTimeout(200)

  const m = await page.evaluate(() => {
    const read = (label) => {
      const box = document.querySelector(`.popover form.popover-anchor`)
      if (!box) return { label, missing: true }
      const inputs = [...box.querySelectorAll('input')]
      const note = box.querySelector('.popover-note')
      const content = box.getBoundingClientRect()
      const widest = inputs.length ? Math.max(...inputs.map((i) => i.getBoundingClientRect().width)) : 0
      return {
        label,
        count: inputs.length,
        contentW: +content.width.toFixed(1),
        widestInputW: +widest.toFixed(1),
        // 说明是不是真的换到下一行了：它的顶边要在**每一个输入框**的底边之下
        noteBelow: note ? inputs.every((i) => note.getBoundingClientRect().top >= i.getBoundingClientRect().bottom - 0.5) : null,
        inputH: inputs.length ? +Math.max(...inputs.map((i) => i.getBoundingClientRect().height)).toFixed(1) : 0,
      }
    }
    return { anchor: read('锚文本') }
  })
  assert(!m.anchor.missing, `⌥ 点页引用应开出带锚文本输入行的浮层：${JSON.stringify(m)}`)
  assert(m.anchor.count >= 1, `锚文本那一行应有输入框：${JSON.stringify(m.anchor)}`)
  assert(
    m.anchor.widestInputW >= m.anchor.contentW / 2,
    `输入框应拿到至少半个浮层宽（否则打不进字）：${JSON.stringify(m.anchor)}`,
  )
  assert(m.anchor.noteBelow === true, `说明应换到输入框下方，而不是挤在同一行：${JSON.stringify(m.anchor)}`)
  // 高度也别被拉变形：一行输入框的高度不该超过两倍行高（被挤成竖条时实测 113px）
  assert(m.anchor.inputH <= 48, `输入框高度应是一行（≤48px），实际 ${m.anchor.inputH}px：${JSON.stringify(m.anchor)}`)

  // 同一条几何也被外链输入框复用（两个字段 ＋ 按钮 ＋ 说明）：一起验
  await page.keyboard.press('Escape')
  await page.evaluate(() => window.__qua.invoke('core.editor/insert-link', {}))
  await page.waitForTimeout(200)
  const link = await page.evaluate(() => {
    const box = document.querySelector('.popover form.popover-anchor')
    if (!box) return { missing: true }
    const inputs = [...box.querySelectorAll('input')]
    const note = box.querySelector('.popover-note')
    const content = box.getBoundingClientRect()
    return {
      count: inputs.length,
      contentW: +content.width.toFixed(1),
      widestInputW: +Math.max(...inputs.map((i) => i.getBoundingClientRect().width)).toFixed(1),
      noteBelow: note ? inputs.every((i) => note.getBoundingClientRect().top >= i.getBoundingClientRect().bottom - 0.5) : null,
      inputH: +Math.max(...inputs.map((i) => i.getBoundingClientRect().height)).toFixed(1),
    }
  })
  assert(!link.missing, `插入外链应开出一个问地址的浮层：${JSON.stringify(link)}`)
  assert(link.count === 2, `外链浮层应有地址与显示文本两个输入框：${JSON.stringify(link)}`)
  /**
   * 这一行是两个字段**并排**（地址 ＋ 显示文本 ＋ 按钮），所以判据不是「半个浮层」，
   * 而是**每个字段都还剩能打字的宽度**——挤成竖条时每个只剩 14px。
   */
  assert(
    link.widestInputW >= 120,
    `外链的输入框都该有能打字的宽度（≥120px），实测最宽 ${link.widestInputW}px：${JSON.stringify(link)}`,
  )
  assert(link.noteBelow === true, `外链浮层的说明应独占一行：${JSON.stringify(link)}`)
  assert(link.inputH <= 48, `外链输入框高度应是一行（≤48px），实际 ${link.inputH}px：${JSON.stringify(link)}`)

  await ctx.close()
  return `锚文本输入框 ${m.anchor.widestInputW}px（浮层 ${m.anchor.contentW}px）、说明换行；外链两框 ${link.widestInputW}px`
})

/* ---------------------------------------------------------------- A20 */

await check('A20 单行省略原语：名字足够长时也不折行、不撑破容器', async () => {
  const { ctx, page } = await freshPage(browser, base, { viewport: { width: 1440, height: 900 } })
  await page.evaluate(() => window.__qua.quiet(true))
  await openFirstPage(page)

  /**
   * **判据**：`.ui-ellipsis` 的元素在**长名字**下仍然
   * ① `white-space: nowrap` ＋ `text-overflow: ellipsis`（省略而不是折行）；
   * ② 右缘不越过容器内容区（`min-width: 0` 真的生效）。
   *
   * 为什么要专门喂长名字：这四条声明漏任何一条，**短名字下都看不出来**
   * ——而真实库里的页名／标签名经常很长。这条用例的前身是「11 处逐字相同的五条声明」，
   * 现在是「一处原语 ＋ 一条只喂长名字的断言」。
   *
   * ⚠️ 顺带钉住 `ui-ellipsis` 与 `ui-ellipsis-grow` 是**两件事**：前者是文本行为、
   *    后者是布局行为。合成一条时，被外层定宽的那些元素（块别名、看图标题）
   *    会被硬塞一个 `flex: 1`，宽度分配当场变样。
   */
  const probe = await page.evaluate(() => {
    /**
     * 把第一个页名改成一个**很长的**名字。
     *
     * ⚠️ 用 `forceForest`（模型层的探针入口）而不是命令面：这里要验的是**渲染**，
     *    不是「改名命令写对了没有」。走命令面会把两件事的失败混在一条断言里。
     */
    const long = '一个非常长的页名'.repeat(8)
    window.__qua.forceForest((forest) => {
      const P = forest[0]
      P.props = { ...(P.props ?? {}), _aliases: [long] }
    })
    window.__qua.invoke('core.page/open', { pageId: window.__qua.pages()[0].id })
    return { long }
  })
  await page.waitForTimeout(350)

  const m = await page.evaluate(() => {
    const out = []
    for (const el of document.querySelectorAll('#dock-left .ui-ellipsis, #dock-right .ui-ellipsis')) {
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      const pr = el.parentElement.getBoundingClientRect()
      const lines = Math.round(r.height / (parseFloat(cs.lineHeight) || 16))
      out.push({
        cls: el.className,
        ws: cs.whiteSpace,
        to: cs.textOverflow,
        lines,
        overflowsParent: r.right > pr.right + 1,
        text: (el.textContent ?? '').slice(0, 12),
      })
    }
    return out
  })
  assert(m.length >= 2, `槽里应有若干走省略原语的名字：${JSON.stringify(m)}`)
  const wrapped = m.filter((x) => x.ws !== 'nowrap' || x.to !== 'ellipsis')
  assert(wrapped.length === 0, `省略原语必须是 nowrap ＋ ellipsis（不许退化成折行）：${JSON.stringify(wrapped)}`)
  const tall = m.filter((x) => x.lines > 1)
  assert(tall.length === 0, `长名字下也不许折成两行：${JSON.stringify(tall)}`)
  const spill = m.filter((x) => x.overflowsParent)
  assert(spill.length === 0, `长名字不许撑破容器（min-width: 0 要真的生效）：${JSON.stringify(spill)}`)

  await ctx.close()
  void probe
  return `${m.length} 处省略原语在长名字下仍单行、不溢出（最长名字 ${probe.long.length} 字）`
})

/* ---------------------------------------------------------------- A21 */

await check('A21 日历卡：一格一天、周一起始、点一格去那天；写过的那天有标记', async () => {
  const { ctx, page } = await freshPage(browser, base, { viewport: { width: 1440, height: 900 } })
  await page.evaluate(() => window.__qua.quiet(true))
  await page.waitForTimeout(400)

  /**
   * **判据**（四条，都是日历自己要说的事）：
   *   ① 一屏一个月：格数 ＝ 这个月的天数，月外留空（不画邻月日期）；
   *   ② 周一起始：表头是「一…日」，且 1 号落在它真实的那一格；
   *   ③ **写过的那天要看得见**（`data-written`）——日历一半的用处是「这天写过」；
   *   ④ **点一格 ＝ 去那天**，且点完这一格立刻变成「写过」。
   *
   * ⚠️ ③ 特别值得钉：只画数字的日历看起来完全正常，但「哪天写过」看不出来 ——
   *    而那正是用户打开日历的理由。
   */
  const before = await page.evaluate(() => {
    const card = document.querySelector('#dock-left .dock-card[data-card-id="calendar"]')
    if (!card) return { missing: true }
    const cells = [...card.querySelectorAll('.cal-cell:not(.cal-pad)')]
    return {
      title: card.querySelector('.dock-card-title')?.textContent ?? '',
      label: card.querySelector('.cal-label')?.textContent ?? '',
      weekdays: [...card.querySelectorAll('.cal-week')].map((w) => w.textContent),
      cellCount: cells.length,
      pads: card.querySelectorAll('.cal-pad').length,
      today: cells.filter((c) => c.dataset.today === '1').map((c) => c.dataset.date),
      written: cells.filter((c) => c.dataset.written === '1').map((c) => c.dataset.date),
      dates: cells.map((c) => c.dataset.date),
    }
  })
  assert(!before.missing, '默认左槽应有日历卡（派生卡，靠 cards 里的 `calendar`）')
  assert(before.weekdays.join(',') === '一,二,三,四,五,六,日', `表头应周一起始：${before.weekdays.join(',')}`)
  assert(before.cellCount >= 28 && before.cellCount <= 31, `一屏一个月（28–31 格）：${before.cellCount}`)
  assert(before.today.length === 1, `今天应恰好有一格被标出：${JSON.stringify(before.today)}`)

  // ① 月外留空：格数 ＋ 空位数 ＝ 这个月占的格（含 1 号之前的那几格）
  const y = Number(before.today[0].slice(0, 4))
  const m = Number(before.today[0].slice(5, 7))
  const days = new Date(y, m, 0).getDate()
  assert(before.cellCount === days, `${y}-${m} 应有 ${days} 格，实际 ${before.cellCount}`)
  // 1 号之前的空位数 ＝ 1 号是周几（周一起始 ⇒ 周一为 0）
  const firstPad = (new Date(y, m - 1, 1).getDay() + 6) % 7
  assert(before.pads === firstPad, `1 号之前的空位应是 ${firstPad} 个（周一起始），实际 ${before.pads}`)

  // ③ 写过的那天要有标记（种子库里今天一定写过）
  assert(before.written.length >= 1, `有内容的日期必须标出来（否则日历只剩数字）：${JSON.stringify(before.written)}`)
  assert(before.written.includes(before.today[0]), `今天写过，应带 written 标记：${JSON.stringify(before.written)}`)

  // ④ 点一个**没写过**的日期 ⇒ 中心槽换成那天，且这一格立刻变成「写过」
  const blank = before.dates.find((d) => !before.written.includes(d))
  assert(blank, `本月应有一个没写过的日期可点：${JSON.stringify(before.written)}`)
  await page.locator(`#dock-left .cal-cell[data-date="${blank}"]`).click()
  await page.waitForTimeout(450)
  const after = await page.evaluate((d) => {
    const cell = document.querySelector(`#dock-left .cal-cell[data-date="${d}"]`)
    return {
      written: cell?.dataset.written === '1',
      // 中心槽换成了那一天（日记块的日期行是只读投影，取它的占位文案）
      editorRows: document.querySelectorAll('#editor .blk').length,
      firstBlock: window.__qua.text()[0]?.slice(0, 24) ?? '',
    }
  }, blank)
  assert(after.written, `点完这一格应立刻标成「写过」（写完要看得见）：${JSON.stringify(after)}`)
  assert(after.editorRows > 0, `点一格应把中心槽换成那一天：${JSON.stringify(after)}`)

  await ctx.close()
  return `日历 ${before.label}：${before.cellCount} 格 ＋ ${before.pads} 空位（周一起始）；写过 ${before.written.length} 天；点 ${blank} ⇒ 打开且立刻标为写过`
})

/* ---------------------------------------------------------------- A22 */

await check('A22 卡里的一列块与空态只有一个产地（`card-parts`）：形状一致、空态有话说', async () => {
  const { ctx, page } = await freshPage(browser, base, { viewport: { width: 1440, height: 900 } })
  await page.evaluate(() => window.__qua.quiet(true))
  await page.evaluate(() => window.__qua.invoke('core.page/open', { pageId: window.__qua.pages()[0].id }))
  await page.waitForTimeout(400)

  /**
   * **判据**：所有派生卡里的「一列块」都带 `block-list`（同一个行距来源），
   * 所有空态都带 `dock-empty`（同一种「为什么这里是空的」写法）。
   *
   * 为什么这条值得有：这两样此前在四张派生卡 ＋ 组件卡 ＋ 槽空态里各手写一遍。
   * 抄漏 `block-list` 的后果是「这一列块没有行距」——而在两三行的短列表上，
   * 行距差不出来。抄漏空态则是「一个什么都没有的框」，用户分不清「没内容」和「没加载」。
   */
  const m = await page.evaluate(() => {
    const lists = [...document.querySelectorAll('#dock-left .dock-card .block-list, #dock-right .dock-card .block-list')]
    const notes = [...document.querySelectorAll('#dock-left .dock-empty, #dock-right .dock-empty')]
    const emptyWithText = notes.filter((n) => (n.textContent ?? '').trim() !== '')
    return {
      listCount: lists.length,
      // 一列块的形状来源：`display: flex` ＋ 纵向（来自 `.block-list`）
      listShapes: lists.map((el) => {
        const cs = getComputedStyle(el)
        return { display: cs.display, dir: cs.flexDirection }
      }),
      noteCount: notes.length,
      notesWithoutText: notes.filter((n) => (n.textContent ?? '').trim() === '').length,
      emptyWithText: emptyWithText.length,
    }
  })
  assert(m.listCount >= 2, `槽里应有若干「一列块」容器：${JSON.stringify(m)}`)
  const bad = m.listShapes.filter((s) => s.display !== 'flex' || s.dir !== 'column')
  assert(bad.length === 0, `「一列块」都该来自同一份原语（flex ＋ column）：${JSON.stringify(bad)}`)
  assert(m.notesWithoutText === 0, `空态必须说一句为什么（不许留空框）：${JSON.stringify(m)}`)

  await ctx.close()
  return `${m.listCount} 处一列块共用同一形状；${m.noteCount} 处空态都有话`
})

/* ---------------------------------------------------------------- 不适用项 */

skip('A5／A6 布局型块的列数降级与右栏转覆盖', '当前实现还没有「布局型块（表格/看板/白板）」与 minW 类型声明；右栏转覆盖按宽度口径回扫后标为后置')
skip('A9 进/出 Edit 态所有块 rect 不变（±0.5px）', '当前实现没有独立的「布局编辑双态」（View/Edit 切换按钮）；当前是「失焦＝View」，无切换动作可测')
skip('A10 深度 ≥3 的节点不存在（插第 4 层被拒）', '`indentBlock` 目前无深度上限（这条要等「深度上限」的口径定下来再断言）')
skip('A11 容器内 cols ≤ floor(宽/minW(type))', '依赖类型声明里的 `minW`，当前实现尚无布局型块')
skip('A12 单一内建样式下 A1–A11 全绿', 'A1–A3／A7／A8 已在唯一内建样式下断言（三皮肤已删）；跨外观矩阵等 A5/A6/A9/A10/A11 可行后一起跑')

/* ---------------------------------------------------------------- 汇总 */

await browser.close()
if (server) server.close()

console.log('')
let fail = 0
for (const r of results) {
  const tag = r.ok ? (r.skip ? '\u001b[33mSKIP\u001b[0m' : '\u001b[32mPASS\u001b[0m') : '\u001b[31mFAIL\u001b[0m'
  console.log(`${tag}  ${r.name}`)
  if (r.msg) console.log(`      ${String(r.msg).replace(/\n/g, '\n      ')}`)
  if (!r.ok) fail++
}
const ran = results.filter((r) => !r.skip).length
console.log(`\n${ran - fail}/${ran} 通过　·　${results.length - ran} 条 SKIP（当前实现尚无对应机制）\n`)
process.exit(fail === 0 ? 0 : 1)
