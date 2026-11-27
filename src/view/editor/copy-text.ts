/**
 * 复制块时读哪一段文本、引用落在哪个 id 上。
 *
 * 块不只是正文：代码块有身体，露面只是指向源的指针。复制必须按块的类型说话，
 * 不能把「这一行显示的字」当成所有块唯一的真相。
 */
import { authoredTextOf, blockLabel, blockTypeOf, CODE_TYPE, plainText, readEmbed, type Block } from '../../core/index.ts'
import { t } from '../../core/infra/msg.ts'

/** 露面复制时引用落在源 id 上：拿宿主的 id 当源会指向镜子自己。 */
export function copySourceIdOf(b: Block | undefined): string {
  return readEmbed(b)?.block ?? b?.id ?? ''
}

/** 正文味按块类型分派：代码块带身体，露面只给一句「这是对谁的露面」。 */
export function copyTextOfBlock(b: Block | undefined, find: (id: string) => Block | undefined): string {
  if (!b) return ''
  const ref = readEmbed(b)
  if (ref) {
    const source = find(ref.block)
    return t('ui.embed.copyRef', { name: source ? blockLabel(source, find) : ref.block })
  }
  return blockTypeOf(b) === CODE_TYPE ? authoredTextOf(b) : plainText(b.content)
}
