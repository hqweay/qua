/**
 * 英文字典——把四份分片合成与 `MSG` 同键的一张表。
 *
 * 分片只为了翻译时能并行、能逐片核对；运行时它们就是一张扁平表，与中文侧同一套 id。
 * `satisfies Record<MsgId, string>` 让漏翻译在 `pnpm typecheck` 阶段就红，
 * 而不是等用户切到英文才看到一串裸 id。
 */
import type { MsgId } from './msg.ts'
import { EN1 } from './msg-en-1.ts'
import { EN2 } from './msg-en-2.ts'
import { EN3 } from './msg-en-3.ts'
import { EN4 } from './msg-en-4.ts'

export const MSG_EN = {
  ...EN1,
  ...EN2,
  ...EN3,
  ...EN4,
  'ui.settings.language': 'Interface language',
  'ui.settings.languageHint': 'Switching reloads the window so the entire interface (including menu text) changes. Defaults to your system language.',
  'ui.locale.zh': 'Chinese',
  'ui.locale.en': 'English',
  'cmd.view.set-locale': 'Set interface language (Chinese / English)',
} as const satisfies Record<MsgId, string>
