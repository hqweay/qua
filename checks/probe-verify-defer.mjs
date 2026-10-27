/**
 * 探针：**组合期被推迟的那次重排，组合结束后真的补上了吗？**
 *
 * 组合期一律「只记欠一次」的守卫有个天然风险：记账之后没人消费 ⇒ 正文永久停在旧形状
 * （改属性看不到、别的视图的改动不显示）。本探针验证「结束即补」这条闭环真的成立。
 *
 * 用法：node checks/probe-verify-defer.mjs
 * ⚠️ 诊断探针，不进 gate。
 */
import { _electron } from 'playwright-core'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CACHE = join(ROOT, '.cache', 'verify-defer')
rmSync(CACHE, { recursive: true, force: true })
mkdirSync(CACHE, { recursive: true })
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(...a)

const app = await _electron.launch({
  args: [ROOT, `--user-data-dir=${CACHE}`, '--no-sandbox', '--disable-gpu'],
  env,
})
const page = await app.firstWindow()
await page.waitForFunction(() => Boolean(window.__qua), null, { timeout: 30000 })
await page.evaluate(() => window.__qua.quiet(true))
await sleep(500)
const cdp = await page.context().newCDPSession(page)

/**
 * 冷启动落在今日 journal（整段只读），先显式打开一页真实内容，
 * 否则「找不到可写块」——这是探针自身的取景问题，不是产品问题。
 */
await page.evaluate(() => {
  const pages = window.__qua.pages()
  if (pages.length > 0) window.__qua.invoke('core.page/open', { pageId: pages[0].id })
})
await sleep(300)

const t = await page.evaluate(() => {
  /**
   * 挑一个**真的可写**的正文块。
   * ⚠️ 判据要看 DOM 的 `.tx[contenteditable]`，不要靠诊断面的 `roles` 猜：
   *    `roles` 为空只说明「不是 journal 本身」，日记的**子块**同样是只读外观的日期区，
   *    而「只读」的判据在 `isReadonlyBlock`（`isJournal(b) || typeDecl.text === 'readonly'`）。
   */
  for (const b of window.__qua.blocks()) {
    if (!b.text || b.text.length < 3) continue
    const tx = document.querySelector(`.blk[data-block-id="${b.id}"] .tx`)
    // ⚠️ 判据是 `isContentEditable`（**计算后**的可编辑性），不是 `contenteditable` 属性：
    //    子块的 `.tx` 不带那个属性（它继承自容器），按属性判会把所有正常行都漏掉。
    // 还要排除**段根行**（页／天／查询记录的抬头）：它的正文是别名头，不是可组合的文本槽
    const el = document.querySelector(`.blk[data-block-id="${b.id}"]`)
    if (el?.dataset.depth !== '0' && tx?.isContentEditable && tx.dataset.readonly !== '1') {
      return { id: b.id, text: b.text }
    }
  }
  return null
})
if (!t) {
  log('✗ 找不到可写的正文块')
  await app.close()
  process.exit(1)
}
log(`目标块 ${t.id.slice(-6)}  "${t.text}"`)

/**
 * ⚠️ 后台窗口拿不到**焦点**：没有焦点时 `focusBlock` 里的 `editorEl.focus()` 不生效，
 *    `placeCaret` 只写了 Range 但浏览器不认，`getSelection().anchorNode` 会是 null。
 *    所以先把窗口提到前台，再落光标——否则整轮探针的 IME 会打到别处。
 */
/**
 * ⚠️ 落光标走**真鼠标点击**，不用 `focusBlock(id, 0)`：
 *    后台窗口里 `focusBlock` 的 `editorEl.focus()` 不生效，`placeCaret` 写进去的 Range
 *    浏览器不认，`getSelection().anchorNode` 会是 null（实测）——那样后面的 IME 会打到别处。
 *    真点击是「用户点一行」的原样复现，顺带把焦点给到位。
 */
const box = await page.evaluate((id) => {
  const el = document.querySelector(`.blk[data-block-id="${id}"] .tx`)
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.left + 8, y: r.top + r.height / 2 }
}, t.id)
if (!box) {
  log('✗ 目标块没挂上 DOM')
  await app.close()
  process.exit(1)
}
await page.mouse.click(box.x, box.y)
await sleep(200)
// 前置断言：光标真的在这个块的可写槽里，否则后面的 IME 打到别处、整轮结论作废
const focused = await page.evaluate((id) => {
  const s = document.getSelection()
  const tx = document.querySelector(`.blk[data-block-id="${id}"] .tx`)
  return {
    inTarget: Boolean(tx?.contains(s?.anchorNode ?? null)),
    ce: Boolean(tx?.isContentEditable),
    mounted: Boolean(tx),
    sel: s?.anchorNode?.nodeName ?? null,
    selBlock: s?.anchorNode ? (s.anchorNode.parentElement?.closest?.('.blk')?.dataset.blockId?.slice(-6) ?? null) : null,
  }
}, t.id)
log(`前置：光标在目标块内=${focused.inTarget} 可编辑=${focused.ce} 已挂载=${focused.mounted} 光标节点=${focused.sel} 所在块=${focused.selBlock}`)
if (!focused.inTarget || !focused.ce) {
  log('✗ 前置不成立（光标没落进目标块），本轮结论作废')
  await app.close()
  process.exit(1)
}

/* 组合期「改属性」——走真实命令（会 repaintBlock ⇒ renderBlock） */
await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 })
await sleep(200)
const during = await page.evaluate((id) => {
  const composingBefore = window.__qua.__editor.probe.isComposing
  const ed = window.__qua.__editor
  const el0 = ed.blockEl(id)
  // 追一下这一笔命令到底调了哪些渲染入口（诊断用）
  const calls = []
  for (const name of ['renderBlock', 'renderAll', 'applyWindow', 'reloadFromStore']) {
    const orig = ed[name].bind(ed)
    ed[name] = (...a) => { calls.push(name + (ed.probe.isComposing ? ':C' : ':-')); return orig(...a) }
  }
  const ok = window.__qua.invoke('core.editor/toggle-todo', {}, 'api')
  window.__calls = calls
  // ⚠️ 取 DOM 元素要**同步紧接**命令之后：中间若让出一帧，别处（`armFlush`／属性面板）
  //    可能已经把它换掉，那样测到的就不是「命令有没有换 DOM」。
  const el1 = ed.blockEl(id)
  return {
    commandOk: ok,
    // 组合期换 DOM 了吗？判据是「同一个元素还在不在」
    sameElement: el0 === el1,
    todoInModel: window.__qua.blocks().find((x) => x.id === id)?.todo === 'todo',
    calls: window.__calls,
    composingBefore,
  }
}, t.id)
log(`组合期改属性：${JSON.stringify(during)}`)

await cdp.send('Input.insertText', { text: '中' })
await sleep(700) // 等 armFlush 的 200ms 补做
const after = await page.evaluate((id) => {
  const ed = window.__qua.__editor
  const el = ed.blockEl(id)
  return {
    model: window.__qua.blocks().find((x) => x.id === id)?.text,
    composing: ed.probe.isComposing,
    pendingTimer: Boolean(ed.pendingTimer),
    // 补做真的发生了吗：todo 的外观应当已经出现在 DOM 上
    domHasTodo: Boolean(el?.querySelector('.blk__todo, [data-todo]')) || Boolean(el?.dataset.todo),
  }
}, t.id)
log(`组合结束后：${JSON.stringify(after)}`)

const verdict = {
  '组合期没有换 DOM（同一元素）': during.sameElement === true,
  '组合期命令仍然改了模型': during.todoInModel === true,
  '组合结束后补做已发生（DOM 出现 todo 外观）': after.domHasTodo === true,
  '组合结束后 composing 已复位': after.composing === false,
  '没有残留待补账': after.pendingTimer === false,
}
log('\n══════ 结论 ══════')
log(JSON.stringify(verdict, null, 2))
const failed = Object.entries(verdict).filter(([, v]) => !v)
if (failed.length) log(`\n✗ 未通过：${failed.map(([k]) => k).join(' / ')}`)
else log('\n✔ 守卫与补做闭环成立')

await app.close()
