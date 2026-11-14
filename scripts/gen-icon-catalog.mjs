/**
 * 生成全量图标 catalog：读 `lucide-static`（devDependency，只为生成）里每个图标的
 * `<svg>` 内联内容，产出 `src/view/icon-catalog.ts`（**生成文件随源码提交**——构建不依赖生成步骤，
 * 生产依赖保持 0；存的是上游 path 数据，图标名字本身住在调用点）。
 *
 * 为什么全量而不是「用到才粘」：换图标只是加一行引用，不再维护一张手粘表；
 * 「全量 path 表进主包」的体积先量（生成文件提交后 `pnpm build` 看真实数字），
 * 超预期再谈拆包——先让 treadmill 消失，再优化它。
 *
 * 用法：`node scripts/gen-icon-catalog.mjs`（改完 vendor 版本后重跑一次；不要手改产物）。
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const ICONS_DIR = join(ROOT, 'node_modules', 'lucide-static', 'icons')
const OUT = join(ROOT, 'src', 'view', 'icon-catalog.ts')

const version = JSON.parse(readFileSync(join(ROOT, 'node_modules', 'lucide-static', 'package.json'), 'utf8')).version

const entries = []
for (const f of readdirSync(ICONS_DIR).sort()) {
  if (!f.endsWith('.svg')) continue
  const svg = readFileSync(join(ICONS_DIR, f), 'utf8')
  // 内联内容 = <svg …> 与 </svg> 之间；属性（viewBox/描边/圆头）由运行时的 createIcon 统一给
  // ⚠️ 剥掉标签间的空白：svg 里的换行会进宿主的 textContent，把断言与读数都搅了
  const inner = svg
    .slice(svg.indexOf('>') + 1, svg.lastIndexOf('</svg>'))
    .replace(/>\s+</g, '><')
    .trim()
  if (!inner) continue
  const name = f.replace(/\.svg$/, '')
  entries.push([name, inner])
}

const lines = entries.map(([name, body]) => `  ${JSON.stringify(name)}: ${JSON.stringify(body)},`)
const out = `/**
 * 全量图标 catalog —— **本文件由脚本生成，不要手改**：
 * \`node scripts/gen-icon-catalog.mjs\`（读 lucide-static@${version}，图标数 ${entries.length}）。
 *
 * 为什么全量：换图标＝加一行引用；手粘表要人肉对账（引用落在表外只会在运行时
 * 读成一排问号）。升级 vendor 版本＝重跑脚本 ＋ 真机扫一眼换脸的图标。
 *
 * 视觉口径统一为 24 网格、2px 描边、圆头圆角；颜色一律 \`currentColor\`
 * （属性由 \`icons.ts\` 的 \`createIcon\` 统一给，这里只有 path 数据）。
 * 图形数据：Lucide ${version}（ISC）。
 */
export const ICON_PATHS = {
${lines.join('\n')}
} as const
`

writeFileSync(OUT, out)
const kb = (Buffer.byteLength(out) / 1024).toFixed(0)
console.log(`已生成 ${relative(ROOT, OUT)}：${entries.length} 个图标，源 ${kb}KB`)
