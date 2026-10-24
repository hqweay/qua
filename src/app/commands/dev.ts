/**
 * 演示与诊断命令：换库、虚拟化开关、输入法组合期自检。
 */
import type { MsgId } from '../../core/msg.ts'
import { t } from '../../core/msg.ts'
import { fixtureWorkspace } from '../../core/seed.ts'
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
      /**
       * ⚠️ **换的是内容，不是外观**：夹具不再带偏好（v15 起偏好属于设备、不属库），
       *    所以这里既不用保留、也不会覆盖用户当前的主题／槽宽／钉住清单。
       */
      d.replaceWorkspace(fixtureWorkspace(state))
      d.toast(t('ui.toast.stateLoaded', { state: t(STATE_LABEL[state]) }))
    },

    setVirtualize: (on, radius) => {
      const r = typeof radius === 'number' ? radius : 12
      d.setVirtualize(on, r)
      d.scheduleDeviceSave()
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
