/**
 * 演示 handler：换夹具、输入法组合期自检、整库重置。
 */
import { t } from '../../core/msg.ts'
import type { Handler } from '../../core/ports.ts'
import { S } from './shared.ts'

export const DEV_HANDLERS: Record<string, Handler> = {
  /* ---- 演示 ---- */
  'dev.fixture/load': (a, app) => {
    const s = S(a.state, 'seed')
    if (s !== 'seed' && s !== 'empty' && s !== 'sparse' && s !== 'degraded' && s !== 'boot') return false
    app.loadState(s)
    return true
  },
  'dev.ime/simulate': (_a, app) => {
    const r = app.runImeProbe()
    app.toast(t('ui.toast.imeProbe', { fired: r.fired, seq: r.seq.join('→') }), r.fired === 0 ? 'ok' : 'warn')
    return true
  },
  'dev.workspace/reset': (_a, app) => {
    app.resetWorkspace()
    return true
  },
}
