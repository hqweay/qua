/**
 * 夹具入口：按名字取一份「可直接装载」的库。
 *
 * 名字与 `FixtureName` 同源 —— 命令面上的 `dev.fixture/load` 用它换内容，
 * 所以这里只做**分派**：每一态怎么造、造什么内容，各自住在自己的文件里。
 * 冷启动态（`boot`）借道 `core/bootstrap.ts`：它描述的是「第一次打开看到什么」，
 * 不是一组假数据样张。
 */
import { bootWorkspace } from '../bootstrap.ts'
import type { FixtureName } from '../ports.ts'
import type { Workspace } from '../workspace.ts'
import { degradedWorkspace, emptyWorkspace, sparseWorkspace } from './states.ts'
import { seedWorkspace } from './seed.ts'

export function fixtureWorkspace(name: FixtureName): Workspace {
  const ws =
    name === 'empty'
      ? emptyWorkspace()
      : name === 'sparse'
        ? sparseWorkspace()
        : name === 'degraded'
          ? degradedWorkspace()
          : name === 'boot'
            ? bootWorkspace()
            : seedWorkspace()
  return ws
}
