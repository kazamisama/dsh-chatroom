/**
 * dsh-chatroom —— 历史重判的**接线**：章（stamp）、判定输入、批量。
 *
 * 为什么单独成一个模块（837e0518 在 #3638② / #3641 点出来的）：
 *  · 「自动挡」得盖住**所有**判据，而判据不止在 `lib/gitcheck.js` 里 —— 锚点 / ref / 仓库路由
 *    是在这里装配的（真机 #1454/#1458 修的就是这里的路由，而它当年就在 index.js 里）。
 *  · 独立成文件之后，自动挡 = **两个文件的字节摘要**（本模块 + gitcheck.js），于是"章对不对"
 *    可以在测试里**独立算一遍对账**，而不是去源码里找字符串在不在 ——
 *    后者有个一行的洞（#3641 的变异 A）：把 `const stamp = rejudgeStamp()` 换成常量之后，
 *    那些字符串**仍然全在**（定义还摆着，只是没人用），整套测试照样绿，而自动挡已经没了。
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { criteriaFingerprint, resolveWorktree } from './gitcheck.js'

/**
 * 手工版本号 —— 手工挡的第三个分量，两个用途：
 *   · **兜底**：指纹算不出来时（源码读不到），至少还有一个在变的量；
 *   · **扳机**：判据**之外**的世界变了（例如会话表给出的 createdAt 语义变了、或你只想让它重跑一轮）时，
 *     +1 就能主动触发一轮重判 —— 这是自动挡给不了的那只手。
 *
 * 为什么要有「盖章」这回事（真机 2026-09-20 自查出来的）：重判队列原来是
 * 「所有 contradicted/unverified 的**前 20 条**」，而**判对了的红**永远留在队列里 ⇒ 队列只涨不落：
 * 超过 20 条之后，一条**新的假红**排在末尾就再也轮不到重判 —— 自愈**静默失效**（当天实测 12 条，只剩 8 格）。
 * 按章过滤之后：每一版判据、每条记录只重判一次，后来的不会被前面的堵住。
 */
export const REJUDGE_VERSION = 1

/** 一批最多重判多少条：一次启动别把 git 跑爆，剩下的留给下一次 tick。 */
export const REJUDGE_BATCH = 20

/**
 * 自动挡的另一分量：**本模块字节**的摘要（判定输入就装配在这里）。
 *
 * 这一分量先前取的是 `String(rejudgeInputs)`（函数源码）：换成整份文件字节之后，同一份摘要
 * 既能被测试独立算出来对账，也顺带盖住了这个模块里的其它判据（批量与手工版本号也一起被盖）。
 */
export function assemblyFingerprint(file = fileURLToPath(new URL('./rejudge.js', import.meta.url))) {
  try {
    return 'i' + createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 8)
  } catch {
    return 'i0'
  }
}

/**
 * 自动挡的**第三**分量：**施判者**的字节摘要（`lib/index.js` 里那段"拿输入 → 判一回 → 写回记录"）。
 *
 * 为什么必须有这一段（真机 2026-09-25，我自己犯的）：修完「重判只写回平反、不写回**降档**」之后重启，
 * 承诺要报的降档条数是 **0** —— 因为那一笔改的是 `lib/index.js`（施判者），而章只盖 `gitcheck.js`
 * 与 `rejudge.js` ⇒ **章没变 ⇒ 已盖章的记录根本不会被重新判定 ⇒ 修好的写回路径一次都没跑过**
 * （离线重放同一份 store：本该翻 9 条、其中 5 条换成新理由）。
 * 这正是本文件下面那句注释警告过的形状 —— "那处改动若发生在盖章之后而指纹不带它，它修好的那批记录
 * **永远**不会被重判回来，自愈静默失效换个地方再犯一次"，只是它当时说的是**输入装配**，
 * 而这次走的是**施判者**。
 *
 * 粒度取**整份 index.js**、而不是切出那一段：过触发是安全的（重判幂等，一批最多 REJUDGE_BATCH 条，
 * 十几条实测一秒内跑完），漏触发才是这个洞；而切片会随无关编辑漂移、且改到它调用的帮手就漏了。
 */
export function applierFingerprint(file = fileURLToPath(new URL('./index.js', import.meta.url))) {
  try {
    return 'a' + createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 8)
  } catch {
    return 'a0'
  }
}

/**
 * 这批记录该盖什么章 —— **复合的**（837e0518 #3638②③）：
 *
 *     g[lib/gitcheck.js 的字节摘要] | i[本模块的字节摘要] | a[index.js 的字节摘要] | v[手工版本号]
 *
 * 前三段是**自动挡**：改任一处 —— 判据（gitcheck.js）、输入装配（本模块）、**施判者**（index.js 的写回段）——
 * 章自己就变，不需要谁记得 +1。最后一段是**手工挡**（兜底 + 扳机，见 REJUDGE_VERSION 的说明）。
 *
 * ⚠ 调用方**必须**真的用它 —— 把 `const stamp = rejudgeStamp()` 换成常量，自动挡就静默没了，
 * 而"定义还在"会让只看"字符串在不在"的测试照样全绿。
 */
export function rejudgeStamp() {
  return (criteriaFingerprint() || 'g0') + '|' + assemblyFingerprint() + '|' + applierFingerprint()
    + '|v' + REJUDGE_VERSION
}

/**
 * 重判的**判定输入装配** —— 三个输入都在这里：锚点（声明者会话的开始时间）、ref（原声明的 commit）、
 * 仓库路由（按**声明文件**回溯，不与"上次核验的答案"挂钩）。
 *
 * 它**本身是判据的一部分**，所以本模块的字节进了 rejudgeStamp 的摘要（837e0518 #3638②）：
 * 真机 #1454/#1458 修的就是**这里的路由** —— 那处改动若发生在盖章之后而指纹不带它，
 * 它修好的那批记录**永远不会**被重判回来，「自愈静默失效」换个地方再犯一次。
 *
 * @returns 交给 verifyDeclaration 的参数；**锚点拿不到就返回 null**（调用方跳过，且**不盖章**）。
 */
export async function rejudgeInputs(change, starts) {
  const anchorMs = starts.get(change.declaredBy)
  // 拿不到锚点就不动它（宁可少判），也不盖章 —— 会话表可能只是还没挂载完，
  // 盖了章就等于把"这次没查到"当成"它没问题"，下次再也不会试。
  if (typeof anchorMs !== 'number' || anchorMs <= 0) return null
  // **重判也要走同一套仓库路由**（真机 2026-09-16，房间 #1454/#1458）：这里原来直接用
  // change.workspaceId —— 那个字段是**上一次核验时**的答案，于是"交付物在旁仓"的声明
  // 在重判时仍然拿会话仓库去解析 ref ⇒ 永远重判不回来。与 room_declare_change 共用
  // resolveWorktree，两条路才不会各说各话。
  const resolved = await resolveWorktree({ workspace: change.workspaceId, files: change.files })
  return {
    workspace: resolved.workspace,
    files: resolved.files,
    anchorMs,
    anchorLabel: '本次会话开始',
    // **必须带上原声明的 ref**（#623）：不带的话，一条「ref 无效」的判定会在下次启动
    // 重判时退回文件覆盖检查、被改回「已证实」—— 等于把刚堵上的洞在重判路径上又开一次。
    ref: typeof change.ref === 'string' && change.ref !== '' ? change.ref : null,
  }
}
