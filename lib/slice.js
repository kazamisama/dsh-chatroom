/**
 * dsh-chatroom —— 按 UTF-16 码元**安全地**切文本（叶子模块：**零 import**）。
 *
 * 为什么值得单独一个文件（真机 2026-10-07 的事故）：
 *   slice() 数的是码元，而 emoji 这类星平面字符占**两格**。正文第 500 格正好是某个 emoji 的高代理时，
 *   slice(0, 500) 留下一个**孤立高代理**；这条帧进了别人的会话上下文，适配器原样序列化进请求体
 *   （JSON.stringify 只把它转义成 \\ud83d）⇒ 服务端 400 拒收 ⇒ 那个会话**此后每一轮都失败**，
 *   而坏消息永久留在历史里 ⇒ **无法自愈**（受害会话换账号、发新消息都救不回来）。
 *   ⇒ 凡是"文本会进模型上下文"的截断（投递帧 / 摘要 / 回执 / 边界注入 / **错误文案**）都必须走这里。
 *
 * 为什么是**叶子**模块（零 import、谁也不依赖）：三个消费者分属不同层，而它们之间**不能互相 import** ——
 *   · index.js（宿主投递）、
 *   · rooms.js（状态机，自己的错误文案也要用），
 *   · invariants.js（写前体检）——它**刻意不 import rooms.js**（rooms.js 的写路径 import 它 ⇒ 反向 import 成环，
 *     见该文件头部那条纪律），所以共享的东西只能落在**比它们都低**的一层。
 *   三条都只 import 这一个叶子 ⇒ 一份实现、零环。
 *
 * 实现与 DSH 自己 dsh-spill-policy 的 textSlice 一致（头 −1／尾 +1）；本插件零依赖，
 * 不引 @deepseek-ai/* 的导出（那会是"同一件事的第二份副本"，今天已经在两处栽过）。
 */

/**
 * @param {string} text 原文本
 * @param {number} length 预算（UTF-16 码元数）
 * @param {boolean} [tail] true = 取尾部；默认取头部
 * @returns {string} 不落在代理项中间的切片（比预算**至多少一格**）
 */
export function sliceUnits(text, length, tail) {
  const s = String(text === undefined || text === null ? "" : text)
  const fromTail = tail === true
  let cut = fromTail ? s.length - length : length
  const prev = s.charCodeAt(cut - 1)
  const cur = s.charCodeAt(cut)
  // 只在**恰好**切在一对中间时挪一格；其它情形原样（码元预算不变）。
  if (prev >= 0xD800 && prev <= 0xDBFF && cur >= 0xDC00 && cur <= 0xDFFF) cut += fromTail ? 1 : -1
  return fromTail ? s.slice(cut) : s.slice(0, cut)
}
