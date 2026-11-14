/**
 * 生成 emoji 数据 catalog：读 `emojibase-data`（devDependency，只为生成）的**中文**
 * 标注数据（label/tags 是 CLDR zh），产出 `src/ui/overlay/emoji-catalog.ts`
 * （**生成文件随源码提交**，与图标 catalog 同一纪律：构建不依赖生成步骤，生产依赖保持 0）。
 *
 * 取舍：
 *   · 只取顶层条目（**肤色变体 v1 不做**——skins 整段丢掉）；
 *   · `component` 组（肤色修饰符这类零件）不进目录——它不是可用的脸；
 *   · 记录压成 `{ u, l, t, g }`（unicode／中文标注／中文关键词／分组），
 *     渲染零成本（字符即数据），选择器按标注过滤。
 *
 * 用法：`node scripts/gen-emoji-catalog.mjs`（升级 vendor 后重跑一次；不要手改产物）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DATA_DIR = join(ROOT, 'node_modules', 'emojibase-data')
const OUT = join(ROOT, 'src', 'ui', 'overlay', 'emoji-catalog.ts')

const version = JSON.parse(readFileSync(join(DATA_DIR, 'package.json'), 'utf8')).version
const entries = JSON.parse(readFileSync(join(DATA_DIR, 'zh', 'compact.json'), 'utf8'))
const messages = JSON.parse(readFileSync(join(DATA_DIR, 'zh', 'messages.json'), 'utf8'))

const groupNames = Object.fromEntries(
  messages.groups.filter((g) => g.key !== 'component').map((g) => [g.key, g.message]),
)
const groupKeys = Object.fromEntries(messages.groups.map((g) => [g.key, g.order]))

const records = []
for (const e of entries) {
  if (e.group === undefined || e.group === 2) continue // component 组是零件，不是脸
  const key = messages.groups.find((g) => g.order === e.group)?.key
  if (!key || !(key in groupNames)) continue
  records.push({
    u: e.unicode,
    l: e.label,
    ...(Array.isArray(e.tags) && e.tags.length > 0 ? { t: e.tags } : {}),
    g: key,
    o: e.order ?? 0,
  })
}
// 组内按上游 order（同一组内顺序稳定）
records.sort((a, b) => (groupKeys[a.g] - groupKeys[b.g]) || (a.o - b.o))

const out = `/**
 * emoji 数据 catalog —— **本文件由脚本生成，不要手改**：
 * \`node scripts/gen-emoji-catalog.mjs\`（读 emojibase-data@${version}，emoji 数 ${records.length}）。
 *
 * 中文标注（label／tags）来自 CLDR zh；分组名同源。只 vendor 数据不装框架：
 * 这份是纯表（字符即数据，渲染零成本），选择器按标注过滤、按分组导航。
 * 肤色变体 v1 不做（上游 skins 整段不取）。
 */
export interface EmojiEntry {
  /** emoji 字符（字面渲染的值本身） */
  u: string
  /** 中文标注（CLDR zh） */
  l: string
  /** 中文关键词（可搜） */
  t?: string[]
  /** 分组 key（导航用） */
  g: string
  /** 组内顺序（上游 order；只用于排序稳定） */
  o?: number
}

export const EMOJI_GROUPS: Record<string, string> = ${JSON.stringify(groupNames, null, 2)}

export const EMOJI_ENTRIES: EmojiEntry[] = ${JSON.stringify(records, null, 0)}
`

writeFileSync(OUT, out)
const kb = (Buffer.byteLength(out) / 1024).toFixed(0)
console.log(`已生成 ${relative(ROOT, OUT)}：${records.length} 条，源 ${kb}KB`)
