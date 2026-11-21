/**
 * **块标签字段卡的开合状态**：哪一枚 chip 的字段三角现在应该朝下。
 *
 * 为什么状态住在这里而不是 DOM 上：字段卡是**单一瞬时面**（同屏只留最后打开的那一个），
 * 而它一写值就会重画宿主行 —— chip 与三角都是重建的。把 `aria-expanded` 写在三角元素上，
 * 重画一次就丢（真浏览器实测：改一个字段后三角复位，卡片还开着）。所以开合状态按
 * `宿主 id + 标签 id` 记在渲染层能读到的地方，三角每次重建时按它补上。
 *
 * 判据边界：这是**渲染输入**，不是模型状态，也不落盘。同一次打开里，同一块在同一标签下的
 * 所有露面（镜像/嵌入）共享同一个朝向 —— 卡片本来也只有一个。
 */

let open: { hostId: string; tagId: string } | null = null

/** 记下这次打开的宿主与标签（浮层打开时调用）。 */
export function setOpenTagFields(hostId: string, tagId: string): void {
  open = { hostId, tagId }
}

/** 关闭时清掉；只清**同一对** id，避免迟到的关闭回调把后打开的那一枚抹掉。 */
export function clearOpenTagFields(hostId: string, tagId: string): void {
  if (open?.hostId === hostId && open.tagId === tagId) open = null
}

/** 这枚 chip 的字段三角此刻该不该朝下。 */
export function isTagFieldsOpen(hostId: string, tagId: string): boolean {
  return open?.hostId === hostId && open.tagId === tagId
}
