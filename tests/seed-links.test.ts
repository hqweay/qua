/**
 * **种子里的外链**（首屏导览那三个地址）与 DSL 的 `[名字](地址)`。
 *
 * 为什么值得钉：首屏是唯一一处「用户不用点菜单就能看见外链长什么样」的地方。
 * 它要是写成纯文本，新功能在演示里就等于不存在；它要是写错了地址，演示会变成
 * 「链接坏了」——所以这里同时钉**有**（确实解析成 link run）与**不造**（坏地址退回纯文本）。
 *
 * ⚠️ 还有一条容易忘的副作用，写在断言里当规定：**link 不进 `plainText` 投影**
 *    （原子本来就不是文本流的一部分）。所以「地址」这三个字之后的网址不再出现在
 *    搜索/导出/引文里——这是模型口径，不是这次改动弄丢的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInline, seedWorkspace } from '../src/core/infra/seed.ts'
import { FEATURE_DATE_PROP_ID, FEATURE_STATUS_PROP_ID } from '../src/core/fixtures/seed.ts'
import { plainText, walkForest, checkExternalUrl, type Block, type Run } from '../src/core/index.ts'

const CANONICAL = [
  'https://github.com/hqweay/qua/releases',
  'https://github.com/hqweay/qua',
  'https://qua.leay.net/',
  'https://qua.leay.net/arch.html',
]

test('首屏的四个地址是真 link run：名字留空 ⇒ 显示地址本身，地址过白名单', () => {
  const ws = seedWorkspace()
  const links: Extract<Run, { t: 'link' }>[] = []
  for (const b of ws.blocks) {
    walkForest([b], (x) => {
      for (const r of x.content) if (r.t === 'link') links.push(r)
      return true
    })
  }
  assert.ok(links.length >= 4, `种子里应至少有四枚外链，实际 ${links.length}`)

  for (const url of CANONICAL) {
    const hit = links.filter((l) => l.url === url)
    assert.ok(hit.length > 0, `首屏应有一枚指向 ${url} 的外链`)
    // `[](地址)` 的名字留空 ⇒ `v` 落地址本身（`v` 是内容，永远不许是空串）
    for (const l of hit) assert.equal(l.v, url, `显示名留空时应显示地址本身：${JSON.stringify(l)}`)
  }
  for (const l of links) {
    assert.equal(checkExternalUrl(l.url).ok, true, `种子里不该有打不开的地址：${l.url}`)
    assert.ok(l.v.length > 0, `外链的显示文本不许是空：${JSON.stringify(l)}`)
  }
})

test('DSL：`[名字](地址)` 的名字进 `v`、地址进 `url`（两个键，不是一个）', () => {
  const { runs } = parseInline('看 [架构图](https://qua.leay.net/arch.html) 这一张')
  const link = runs.find((r) => r.t === 'link')
  assert.ok(link && link.t === 'link', `应解析出一枚外链：${JSON.stringify(runs)}`)
  assert.equal(link.v, '架构图')
  assert.equal(link.url, 'https://qua.leay.net/arch.html')
  // 它是一枚**原子**：占 1 格，前后文本各自成段
  assert.equal(runs.filter((r) => r.t === 'text').length, 2)
})

test('DSL：白名单外的地址退回纯文本（宁可点不动，也不造一枚打不开的链接）', () => {
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd']) {
    const { runs } = parseInline(`[点我](${bad})`)
    assert.equal(runs.some((r) => r.t === 'link'), false, `不该为 ${bad} 造外链：${JSON.stringify(runs)}`)
    // 原文留着，读者看得见「这里本来想放个链接」——静默吞掉比点不动更糟
    assert.ok(plainText(runs).includes(bad), `原文应原样留下：${plainText(runs)}`)
  }
})

test('外链不进 `plainText` 投影（原子不是文本流的一部分）', () => {
  const { runs } = parseInline('地址 [](https://qua.leay.net/)')
  assert.equal(plainText(runs), '地址 ', '投影只取 text run；地址住在 `url` 上')
})

/* ------------------------------------------------- 行内标签（`#名`）：同一份归属的两种露面 */

test('DSL：`#标签` 解析成 flavor `#` 的引用 run，尾部标点不进名字', () => {
  const { runs } = parseInline('正文里的 #功能 是一次提及，占一格。')
  const tag = runs.find((r) => r.t === 'ref' && r.flavor === '#')
  assert.ok(tag && tag.t === 'ref', `应解析出一枚行内标签：${JSON.stringify(runs)}`)
  assert.equal(tag.flavor, '#')
  assert.equal(tag.label, '功能', `句号应留给文本流，不进名字：${JSON.stringify(tag)}`)
  // 它是一枚原子：占 1 格；普通页引用（不带 flavor）不受影响
  assert.equal(runs.some((r) => r.t === 'ref' && r.flavor === undefined), false)
})

test('种子里的行内标签回填到了「功能」标签块（标签占地址，解析同一张表）', () => {
  const ws = seedWorkspace()
  let hit: { to?: string; label: string } | undefined
  let tagId: string | undefined
  for (const b of ws.blocks) {
    walkForest([b], (x) => {
      if (plainText(x.content).trim() === '功能' && x.props?._lists?.includes('tag')) tagId = x.id
      return true
    })
  }
  assert.ok(tagId, '种子里应有「功能」标签块')
  for (const b of ws.blocks) {
    walkForest([b], (x) => {
      for (const r of x.content) if (r.t === 'ref' && r.flavor === '#') hit = r
      return true
    })
  }
  assert.ok(hit, '种子里应有一枚行内标签 run（首屏导览那一行）')
  assert.equal(hit!.to, tagId, `行内标签应解析到标签块：${JSON.stringify(hit)}`)
})

/* ------------------------------------------------- 属性 / 实例 / 看法样本（数据形状钉住） */

test('种子顶层的「功能看板」带四张命名看法，激活的是看板（分组键＝功能状态）', () => {
  const ws = seedWorkspace()
  const board = ws.blocks.find((b) => plainText(b.content).trim() === '功能看板')
  assert.ok(board, '顶层应有「功能看板」查询块')
  const views = board.props?._views as { id: string; kind: string; groupBy?: string }[] | undefined
  assert.ok(Array.isArray(views) && views.length === 4, `应有四张看法：${JSON.stringify(views)}`)
  assert.deepEqual(
    views!.map((v) => v.kind),
    ['cards', 'table', 'cards', 'calendar'],
    `顺序＝看板 / 表格 / 画廊 / 日历：${JSON.stringify(views)}`,
  )
  const kanban = views![0]!
  assert.ok(kanban.groupBy && kanban.groupBy !== '', '看板必须有分组键（否则它是画廊）')
  assert.equal(board.props?._activeView, 'seed-kanban', `激活看法应是看板：${JSON.stringify(board.props)}`)
})

test('功能实例：普通内容块 ＋ 归属 ＋ 值（没有新实体），有一条不填状态的缺省样本', () => {
  const ws = seedWorkspace()
  const tag = ws.blocks.find((b) => plainText(b.content).trim() === '功能' && b.props?._lists?.includes('tag'))
  assert.ok(tag, '应有「功能」标签块')
  const instances = ws.blocks.filter((b) => b.props?._tags?.includes(tag!.id))
  assert.ok(instances.length >= 6, `顶层应有多条功能实例：${instances.length}`)
  const withStatus = instances.filter((b) => (b.props as Record<string, string>)[FEATURE_STATUS_PROP_ID])
  const withDate = instances.filter((b) => (b.props as Record<string, string>)[FEATURE_DATE_PROP_ID])
  assert.ok(withStatus.length >= 5, `多数实例应填状态：${withStatus.length}`)
  assert.ok(withDate.length >= 4, `已落地的实例应带日期（日历的落点）：${withDate.length}`)
  // 实例没有地址：身份由归属给出，不写 _aliases
  for (const b of instances) assert.equal(b.props?._aliases, undefined, `实例不该有地址：${plainText(b.content)}`)
})

test('镜像、算作、子块行头属性三份样本的数据形状（要拿到已建块 id 才能写的那批）', () => {
  const ws = seedWorkspace()
  const byPlain = (prefix: string): Block | undefined => {
    let hit: Block | undefined
    for (const b of ws.blocks) {
      walkForest([b], (x) => {
        if (hit) return false
        if (plainText(x.content).startsWith(prefix)) hit = x
        return true
      })
    }
    return hit
  }
  const p3 = ws.blocks.find((b) => plainText(b.content).trim() === '每周复盘')
  assert.ok(p3, '应有「每周复盘」页')
  const nextStep = p3!.children.find((c) => plainText(c.content).startsWith('下一步'))
  assert.ok(nextStep, 'p3 应有「下一步」块')

  // 镜像：p1 有一枚宿主块，_embed 指向「下一步」（view:'' ＝ 跟随源）
  const p1 = ws.blocks.find((b) => plainText(b.content).trim() === '欢迎使用相')
  assert.ok(p1, '应有「欢迎使用相」页')
  const mirror = p1!.children.find((c) => c.props?._embed)
  assert.ok(mirror, 'p1 底部应有一枚镜像宿主块')
  assert.deepEqual(mirror!.props!._embed, { block: nextStep!.id, view: '' })

  // 算作：p2 的迁移笔记同时挂在「下一步」下（_belongsTo 多一条父边）
  const migration = byPlain('把内容搬去别的库之前')
  assert.ok(migration, 'p2 应有迁移笔记块')
  const edges = (migration!.props as Record<string, string[]> | undefined)?._belongsTo ?? []
  assert.ok(edges.includes(nextStep!.id), `迁移笔记应算作「下一步」的一员：${JSON.stringify(edges)}`)

  // 子块行头属性：父块声明 _childProps，直接子块带着这一栏的值
  const childProps = (nextStep!.props as Record<string, string[]> | undefined)?._childProps
  assert.deepEqual(childProps, [FEATURE_STATUS_PROP_ID], `「下一步」应声明行头属性：${JSON.stringify(childProps)}`)
  const valued = nextStep!.children.filter((c) => (c.props as Record<string, string> | undefined)?.[FEATURE_STATUS_PROP_ID])
  assert.ok(valued.length === nextStep!.children.length && valued.length >= 3, `子块都应带状态值：${valued.length}`)
})
