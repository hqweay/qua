/**
 * 演示与诊断命令：换库、虚拟化开关、输入法组合期自检。
 */
import type { MsgId } from '../../core/msg.ts'
import { t } from '../../core/msg.ts'
import { fixtureWorkspace } from '../../core/seed.ts'
import { DEFAULT_PREFS } from '../../core/workspace.ts'
import type { App, FixtureName } from '../../core/ports.ts'
import type { DevDeps } from './types.ts'

const STATE_LABEL: Record<FixtureName, MsgId> = {
  seed: 'ui.state.seed',
  empty: 'ui.state.empty',
  sparse: 'ui.state.sparse',
  degraded: 'ui.state.degraded',
  boot: 'ui.state.boot',
}

export function devCommands(d: DevDeps): Pick<App, 'loadState' | 'setVirtualize' | 'runImeProbe'> {
  return {
    loadState: (state) => {
      const fresh = fixtureWorkspace(state)
      // 换的是内容，不是外观：保留用户当前的主题档位
      fresh.prefs = { ...DEFAULT_PREFS, ...fresh.prefs, theme: d.prefs().theme }
      d.replaceWorkspace(fresh)
      d.toast(t('ui.toast.stateLoaded', { state: t(STATE_LABEL[state]) }))
    },

    setVirtualize: (on, radius) => {
      const r = typeof radius === 'number' ? radius : 12
      d.setVirtualize(on, r)
      d.scheduleSave()
      d.scheduleBadge()
      d.toast(on ? t('ui.toast.virtOn', { radius: r }) : t('ui.toast.virtOff'))
    },

    runImeProbe: () => {
      const fired = d.probeComposing()
      d.scheduleBadge()
      return { fired, seq: d.compositionSeq() }
    },
  }
}
