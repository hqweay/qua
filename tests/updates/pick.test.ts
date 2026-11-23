/**
 * 更新判定的契约（纯函数层）。
 *
 * 五条，测试名就是那五条：
 *   ① 只有**已发布**且比当前高的才推——draft 不推、同号不推、旧版不推；
 *   ② 通道是**单向闸**：正式版用户不会被拉进 beta；beta 用户收得到更高的正式版；
 *   ③ 预发布段的数字按**数值**比（`beta.10 > beta.6`），否则第 10 个 beta 会被判成旧版；
 *   ④ 比的是最高版本，不是列表首个（API 返回序不是契约）；
 *   ⑤ 坏载荷一律降级成 `unavailable`，**不抛**（启动路径不许因为 GitHub 改字段就断）。
 * 外加 ⑥：安装包按平台/架构挑，挑不到只让 `asset` 为空，不推翻「有新版」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareVersions, parseVersion, pickLatest } from '../../electron/updates/pick.ts'

const rel = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  draft: false,
  prerelease: tag.includes('-'),
  html_url: `https://example.com/${tag}`,
  body: `notes for ${tag}`,
  published_at: '2026-01-01T00:00:00Z',
  ...extra,
})

test('① 只有已发布且更高的才推：draft / 同号 / 旧版都不推', () => {
  assert.deepEqual(pickLatest([rel('v0.1.0-beta.7', { draft: true })], '0.1.0-beta.6'), {
    kind: 'unavailable',
    reason: 'no-release',
  })

  assert.deepEqual(pickLatest([rel('v0.1.0-beta.6')], '0.1.0-beta.6'), {
    kind: 'up-to-date',
    current: '0.1.0-beta.6',
  })

  assert.deepEqual(pickLatest([rel('v0.1.0-beta.5')], '0.1.0-beta.6'), {
    kind: 'up-to-date',
    current: '0.1.0-beta.6',
  })

  const hit = pickLatest([rel('v0.1.0-beta.7')], '0.1.0-beta.6')
  assert.equal(hit.kind, 'available')
  assert.equal(hit.next, '0.1.0-beta.7')
  assert.equal(hit.notes, 'notes for v0.1.0-beta.7')
})

test('② 通道是单向闸：正式版不收 beta，beta 收得到更高的正式版', () => {
  // 0.2.0-beta.1 比 0.1.0 高，但它是预发布 ⇒ 正式版用户不该被拉进去
  assert.deepEqual(pickLatest([rel('v0.2.0-beta.1')], '0.1.0'), {
    kind: 'unavailable',
    reason: 'no-release',
  })

  // beta 用户必须能升到正式版：这正是 beta 通道存在的意义
  const hit = pickLatest([rel('v0.1.0')], '0.1.0-beta.6')
  assert.equal(hit.kind, 'available')
  assert.equal(hit.next, '0.1.0')
})

test('③ 预发布段按数值比：beta.10 比 beta.6 新', () => {
  const order = ['0.1.0-beta.6', '0.1.0-beta.10', '0.1.0-beta.2']
  const sorted = [...order].sort((a, b) => compareVersions(parseVersion(a)!, parseVersion(b)!))
  assert.deepEqual(sorted, ['0.1.0-beta.2', '0.1.0-beta.6', '0.1.0-beta.10'])

  // 同号正式版大于预发布版
  assert.equal(compareVersions(parseVersion('0.1.0')!, parseVersion('0.1.0-beta.99')!), 1)
  // 前缀更短的小
  assert.equal(compareVersions(parseVersion('0.1.0-beta')!, parseVersion('0.1.0-beta.1')!), -1)

  const hit = pickLatest([rel('v0.1.0-beta.6'), rel('v0.1.0-beta.10')], '0.1.0-beta.6')
  assert.equal(hit.kind, 'available')
  assert.equal(hit.next, '0.1.0-beta.10')
})

test('④ 取最高而不是列表首个', () => {
  const hit = pickLatest([rel('v0.1.0-beta.7'), rel('v0.1.0-beta.9'), rel('v0.1.0-beta.8')], '0.1.0-beta.6')
  assert.equal(hit.kind, 'available')
  assert.equal(hit.next, '0.1.0-beta.9')
})

test('⑤ 坏载荷降级成 unavailable，不抛', () => {
  // 形状本身不对（不是数组）⇒ bad-payload
  for (const bad of [null, 42, 'oops', {}]) {
    assert.deepEqual(pickLatest(bad, '0.1.0-beta.6'), { kind: 'unavailable', reason: 'bad-payload' })
  }
  // 是数组、但挑不出可用条目（之前没有发布过 / 条目全坏）⇒ no-release
  for (const empty of [[], [null], [{ tag_name: 3 }]]) {
    assert.deepEqual(pickLatest(empty, '0.1.0-beta.6'), { kind: 'unavailable', reason: 'no-release' })
  }
  // 当前版本自己读不懂 ⇒ 也说不出谁更新（不是「已是最新」）
  assert.deepEqual(pickLatest([rel('v0.1.0')], 'nightly'), { kind: 'unavailable', reason: 'bad-payload' })
  // 有版本没地址 ⇒ 点了也没地方去
  assert.deepEqual(pickLatest([rel('v0.1.0', { html_url: undefined })], '0.1.0-beta.6'), {
    kind: 'unavailable',
    reason: 'bad-payload',
  })
})

/**
 * ⑥ 安装包挑选：mac 挑 arm64 dmg、Windows 挑 x64 exe；架构对不上／平台不认／载荷没 assets
 *    都只让 `asset` 为空，**不推翻「有新版」本身**——调用方退回发布页，而不是推一个装不上的下载。
 */
test('⑥ 安装包按平台/架构挑，挑不到只影响 asset、不影响「有新版」', () => {
  const tag = '0.1.0-beta.9'
  const assets = [
    {
      name: `Qua-${tag}-arm64.dmg`,
      browser_download_url: `https://example.com/${tag}-arm64.dmg`,
      size: 111,
      digest: 'sha256:AAAA',
    },
    { name: `Qua-${tag}-x64.exe`, browser_download_url: `https://example.com/${tag}-x64.exe`, size: 222 },
    { name: `Qua-${tag}-x64.exe.blockmap`, browser_download_url: 'https://example.com/x.blockmap', size: 1 },
    // 地址不是 http(s) ⇒ 不认（下载器只走 http/https）
    { name: `Qua-${tag}-arm64.dmg`, browser_download_url: 'ftp://example.com/x.dmg', size: 333 },
  ]
  const feed = [rel(`v${tag}`, { assets })]

  const mac = pickLatest(feed, '0.1.0-beta.8', { platform: 'darwin', arch: 'arm64' })
  assert.equal(mac.kind, 'available')
  assert.equal(mac.kind === 'available' && mac.asset?.name, `Qua-${tag}-arm64.dmg`)
  assert.equal(mac.kind === 'available' && mac.asset?.size, 111)
  assert.equal(mac.kind === 'available' && mac.asset?.digest, 'sha256:AAAA')

  const win = pickLatest(feed, '0.1.0-beta.8', { platform: 'win32', arch: 'x64' })
  assert.equal(win.kind, 'available')
  assert.equal(win.kind === 'available' && win.asset?.name, `Qua-${tag}-x64.exe`)
  // GitHub 没给摘要 ⇒ digest 为空，下载器只校验字节数
  assert.equal(win.kind === 'available' && win.asset?.digest, null)

  // 架构对不上、平台不认、载荷没 assets：都是「有新版，但没有可下载的包」
  for (const target of [
    { platform: 'darwin', arch: 'x64' },
    { platform: 'linux', arch: 'x64' },
    { platform: 'win32', arch: 'arm64' },
  ]) {
    const hit = pickLatest(feed, '0.1.0-beta.8', target)
    assert.equal(hit.kind, 'available')
    assert.equal(hit.kind === 'available' && hit.asset, null)
  }
  const noAssets = pickLatest([rel(`v${tag}`)], '0.1.0-beta.8', { platform: 'darwin', arch: 'arm64' })
  assert.equal(noAssets.kind, 'available')
  assert.equal(noAssets.kind === 'available' && noAssets.asset, null)

  // 候选条目本身不像话（非 http 地址 / 字节数为 0）⇒ 等同挑不到，绝不推一个下不动的包
  const badOnly = pickLatest(
    [
      rel(`v${tag}`, {
        assets: [
          { name: `Qua-${tag}-arm64.dmg`, browser_download_url: 'ftp://example.com/x.dmg', size: 333 },
          { name: `Qua-${tag}-arm64.dmg`, browser_download_url: 'https://example.com/zero.dmg', size: 0 },
        ],
      }),
    ],
    '0.1.0-beta.8',
    { platform: 'darwin', arch: 'arm64' },
  )
  assert.equal(badOnly.kind, 'available')
  assert.equal(badOnly.kind === 'available' && badOnly.asset, null)

  // 不传 target（旧调用点/纯版本判据）不挑资产，行为保留
  const plain = pickLatest(feed, '0.1.0-beta.8')
  assert.equal(plain.kind, 'available')
  assert.equal(plain.kind === 'available' && plain.asset, null)
})
