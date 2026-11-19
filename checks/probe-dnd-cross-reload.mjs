/**
 * 探针：跨表面拖拽之后，**正文跟不跟变**？
 *
 * 用户报（修完「正文拖块进窗口没反应」之后）：A、B 在正文；A 拖进右槽（钉成窗口）、
 * B 拖进窗口里 A 的行（作为子块）⇒ 模型里 B 已是 A 的子块，正文还停在旧形状，
 * 直到下一次编辑才刷新。
 *
 * 记五本账，定「卡在哪一格」：
 *   ① 事件账：dragstart／dragend／pointer 系来没来（bindPressFreeze 靠它们放开指针位）；
 *   ② 通知账：store.notify 的 source／ids／structural（主编辑器认不认这笔是别人的）；
 *   ③ 模型账：store 里 B 的父亲是谁；
 *   ④ 屏幕账：正文 DOM 里 B 挂在谁下面、行的 rev 落后多少；
 *   ⑤ 状态机账：mainEd.reloader 的 pending／pendingStructural／pointerDown——
 *     pending=false 且屏幕旧 ⇒ 补做跑过但画旧（保留行快路）；pending=true ⇒ 欠账没补。
 *
 * 用法：node checks/probe-dnd-cross-reload.mjs
 * ⚠️ 诊断探针，不进 gate。
 */
import { _electron } from 'playwright-core'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CACHE = join(ROOT, '.cache', 'dnd-cross-reload')
rmSync(CACHE, { recursive: true, force: true })
mkdirSync(CACHE, { recursive: true })
const cleanEnv = { ...process.env }
delete cleanEnv.ELECTRON_RUN_AS_NODE
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(...a)

const app = await _electron.launch({ args: [ROOT, `--user-data-dir=${CACHE}`, '--no-sandbox', '--disable-gpu'], env: cleanEnv })
try {
  const page = await app.firstWindow()
  page.on('pageerror', (err) => log('✗ pageerror:', err?.message ?? err))
  page.on('console', (msg) => {
    if (msg.type() === 'error') log('✗ console.error:', msg.text().slice(0, 300))
  })
  await page.waitForFunction(() => Boolean(window.__qua), null, { timeout: 30000 })
  await page.evaluate(() => window.__qua?.quiet?.(true))
  await sleep(900)

  // ---- 种 A、B（id 必须 32 位十六进制：drop 期 `isBlockId` 按这个收载荷）
  const seed = await page.evaluate(() => {
    const ed = window.__qua.__editor
    const rootId = ed.doc.roots[0]?.id
    const parent = ed.store.find(rootId)
    if (!parent) return null
    const mk = (id, v) => ({ id, content: [{ t: 'text', v }], children: [], created: Date.now(), modified: Date.now() })
    const A = mk('a'.repeat(32), 'A')
    const B = mk('b'.repeat(32), 'B')
    parent.children.push(A, B)
    ed.store.discardIndex()
    ed.renderAll()
    return { A: A.id, B: B.id }
  })
  if (!seed) throw new Error('种子失败：当前屏没有根块')
  log('种子完成')

  // ---- 装五本账
  await page.evaluate(() => {
    const ed = window.__qua.__editor
    window.__probe = { events: [], notes: [] }
    for (const ev of ['dragstart', 'dragend', 'pointerdown', 'pointerup', 'pointercancel', 'drop']) {
      document.addEventListener(
        ev,
        (e) => {
          const row = e.target?.closest?.('.blk')
          window.__probe.events.push({ ev, t: Math.round(performance.now()), row: (row?.dataset.blockId ?? '').slice(-4) })
        },
        { capture: true },
      )
    }
    ed.store.subscribe((source, ids, structural) => {
      window.__probe.notes.push({
        src: source === ed ? 'main' : source == null ? 'none' : 'other',
        ids: (ids ?? []).map((s) => s.slice(-4)),
        structural: structural === true,
        t: Math.round(performance.now()),
      })
    })
    // 重画入口打点（运行时包一层；属性查找发生在调用时刻 ⇒ 订阅者拿到的就是这层）
    const origReload = ed.reloadFromStore.bind(ed)
    ed.reloadFromStore = (...args) => {
      window.__probe.notes.push({ reload: [...args].map(String), t: Math.round(performance.now()) })
      return origReload(...args)
    }
    const origRender = ed.render.renderAllPreservingAnchor.bind(ed.render)
    ed.render.renderAllPreservingAnchor = (anchorId) => {
      window.__probe.notes.push({
        renderAllAnchor: true,
        anchor: anchorId ? anchorId.slice(-4) : 'null',
        t: Math.round(performance.now()),
      })
      return origRender(anchorId)
    }
  })

  const readState = (label) =>
    page.evaluate((label) => {
      const ed = window.__qua.__editor
      const model = []
      const walk = (b, depth) => {
        model.push(`${b.id.slice(-4)}@${depth}`)
        ;(b.children ?? []).forEach((c) => walk(c, depth + 1))
      }
      ed.doc.roots.forEach((r) => walk(r, 0))
      const rows = Array.from(ed.container.querySelectorAll('.blk'))
        .filter((el) => el.closest('[data-edit-island]') == null)
        .map((el) => ({
          id: (el.dataset.blockId ?? '').slice(-4),
          d: el.dataset.depth ?? '-',
          rev: el.dataset.rev ?? '-',
        }))
      const rl = ed.reloader ?? {}
      return {
        label,
        rev: ed.store.revision,
        model,
        rows,
        reloader: { pending: rl.pending ?? null, pStruct: rl.pendingStructural ?? null, ptrDown: rl.pointerDown ?? null },
      }
    }, label)

  // ---- ① A 的块标 → 右槽（钉成窗口）
  const rightSlot = page.locator('#dock-right')
  const slotBox = await rightSlot.boundingBox()
  log(`右槽宽：${slotBox?.width}`)
  const aHandle = page.locator(`#editor [data-drag-for="${seed.A}"]`)
  if (!(await aHandle.boundingBox())) throw new Error('A 的块标没找到')
  await aHandle.dragTo(rightSlot, {
    targetPosition: { x: (slotBox?.width ?? 200) / 2, y: Math.min((slotBox?.height ?? 300) / 2, 120) },
  })
  await sleep(600)
  const winCard = await page.locator('#dock-right .dock-card[data-window="1"]').count()
  log(`右槽窗口卡数：${winCard}`)

  // ---- ② B 的块标（正文）→ 窗口里 A 的行中间（inside）
  // 真人手势里，按下块标前正文多半有输入会话（点过行／光标在正文）。
  // 先点进 B 的行正文再拖：inputSession 锚到 B ⇒ renderAllPreservingAnchor 走锚点保留支。
  const bTx = page.locator(`#editor .blk[data-block-id="${seed.B}"] .tx`).first()
  const bTxBox = await bTx.boundingBox()
  if (bTxBox) {
    await page.mouse.click(bTxBox.x + bTxBox.width / 2, bTxBox.y + bTxBox.height / 2)
    await sleep(200)
  }
  const bHandle = page.locator(`#editor [data-drag-for="${seed.B}"]`)
  const aRow = page.locator(`#dock-right .dock-card[data-window="1"] .dock-window-editor .blk[data-block-id="${seed.A}"]`).first()
  const aBox = await aRow.boundingBox()
  log(`窗口里 A 的行：${JSON.stringify(aBox)}`)
  if (!aBox) throw new Error('窗口里没找到 A 的行')
  await bHandle.dragTo(aRow, { targetPosition: { x: aBox.width / 2, y: aBox.height / 2 } })
  await sleep(250)
  log('—— drop 后 250ms ——')
  log(JSON.stringify(await readState('t+250'), null, 1))
  await sleep(600)
  log('—— drop 后 850ms（补做窗口已过）——')
  log(JSON.stringify(await readState('t+850'), null, 1))

  // ---- ③ 模拟「再动一下」（点一下正文行：pointerdown/up 会放开指针位、排补做）
  const bRow = page.locator(`#editor .blk[data-block-id="${seed.B}"]`).first()
  const bBox = await bRow.boundingBox()
  if (bBox) await page.mouse.click(bBox.x + bBox.width / 2, bBox.y + bBox.height / 2)
  await sleep(500)
  log('—— 点过正文之后 ——')
  log(JSON.stringify(await readState('after-click'), null, 1))

  log('事件账：', JSON.stringify(await page.evaluate(() => window.__probe.events)))
  log('通知账：', JSON.stringify(await page.evaluate(() => window.__probe.notes)))
} finally {
  await app.close()
}
