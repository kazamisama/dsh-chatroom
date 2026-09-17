import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createChatroomStore, shortId, parseMentions, parseMentionsScoped, ownedPaths, detectOverreach, saysNoReply, VERDICTS,
  structuredPaths, memberOwnership, matchesOwnedPath, cleanPathList, DIRECTION_MAX_CHARS,
} from '../lib/rooms.js'

const root = path.join(os.tmpdir(), 'dsh-chatroom-smoke-' + Date.now())
let pass = 0
let fail = 0
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra))) }
}

const store = createChatroomStore({ root })
await store.load()

const A = 'session-aaaabbbb-1111-2222-3333-444455556666'
const B = 'session-ccccdddd-1111-2222-3333-444455556666'
const C = '1b68df32-d51e-4dab-b1ea-74f76b1c12c2'

console.log('1. 房间与成员')
const room = await store.createRoom({ name: '跨会话变更同步' })
await store.join(room.id, A, { roleName: '实现者' })
await store.join(room.id, B, { roleName: '评审' })
await store.join(room.id, C)
check('3 名成员', store.members(room.id).length === 3)
check('短号取前 8 位', shortId(A) === 'aaaabbbb', shortId(A))
check('无 session- 前缀也能取', shortId(C) === '1b68df32', shortId(C))
// 新版投影缓存用 `session_<token>` 这种不透明键：只剥 `session-` 的话，
// 一整屏会话会显示成同一个 "session_"，等于没有身份（真机 2026-09-12 踩到）
check('session_ 前缀也剥', shortId('session_hfv1M-KFYcGFiBD7rbBVNdU') === 'hfv1M-KF', shortId('session_hfv1M-KFYcGFiBD7rbBVNdU'))

console.log('2. 人的发言 → 全体产生义务（D4）')
const m1 = await store.appendMessage({ roomId: room.id, sender: { user: true }, kind: 'human', body: '谁动了 app.py 的 parse_cfg？' })
check('义务人 = 3', store.obligors(room.id, m1.seq).length === 3, store.obligors(room.id, m1.seq).map((m) => shortId(m.sessionId)))

console.log('3. 表态是终端的（D5）')
const j1 = await store.judge({ roomId: room.id, seq: m1.seq, sessionId: A, verdict: 'catch-up', note: '我依赖它，马上跟' })
check('judgment 落库', j1 !== undefined && j1.verdict === 'catch-up')
const judgmentMsg = store.deltaFor(room.id, 'nobody').find((m) => m.kind === 'judgment')
check('表态同时落一条消息', judgmentMsg !== undefined)
check('该消息 terminal', judgmentMsg !== undefined && judgmentMsg.terminal === true)
check('terminal 消息不产生新义务', store.obligors(room.id, judgmentMsg.seq).length === 0)

console.log('4. 状态：谁还没表态（§13 验收）')
await store.judge({ roomId: room.id, seq: m1.seq, sessionId: B, verdict: 'unaffected' })
const st = store.status(room.id, m1.seq)
check('pending 只剩 1 人', st.pending.length === 1, st.pending)
check('默认靶子 = 最近一条产生义务的消息', store.status(room.id).targetSeq === m1.seq, store.status(room.id).targetSeq)
check('pending 是 C', shortId(st.pending[0]) === '1b68df32', st.pending)
check('A 的判断已记录', st.members.find((m) => m.shortId === 'aaaabbbb').verdict === 'catch-up')

console.log('5. 成员被用户关闭 → 不参与，不是未表态（D2 / 场景 C）')
await store.setEnabled(room.id, C, false)
check('activeMembers = 2', store.activeMembers(room.id).length === 2)
const m2 = await store.appendMessage({ roomId: room.id, sender: { user: true }, kind: 'human', body: '再确认一次' })
check('新发言的义务人 = 2（不含已关闭的 C）', store.obligors(room.id, m2.seq).length === 2, store.obligors(room.id, m2.seq).map((m) => shortId(m.sessionId)))
const st2 = store.status(room.id)
const cRow = st2.members.find((m) => m.shortId === '1b68df32')
check('C 在名册里 inRoom=false', cRow.inRoom === false)
check('C 不在 pending 里', !st2.pending.includes(C))

console.log('6. 已读游标与增量（D6）')
const before = store.deltaFor(room.id, C).length
await store.markRead(room.id, C, store.lastSeq(room.id))
check('已读后增量为 0', store.deltaFor(room.id, C).length === 0, before)
await store.appendMessage({ roomId: room.id, sender: { sessionId: A }, kind: 'free', body: '我改完 app.py 了' })
check('新消息后增量为 1', store.deltaFor(room.id, C).length === 1)
check('A 自己的游标仍停在表态那条', store.cursorOf(room.id, A) === m1.seq, store.cursorOf(room.id, A))

console.log('7. 持久化：重载后状态还在')
const reloaded = createChatroomStore({ root })
await reloaded.load()
check('房间还在', reloaded.getRoom(room.id) !== null)
check('成员还在', reloaded.members(room.id).length === 3)
check('C 的关闭状态还在', reloaded.members(room.id).find((m) => m.sessionId === C).enabled === false)
check('判断还在', reloaded.status(room.id, m1.seq).members.find((m) => m.shortId === 'aaaabbbb').verdict === 'catch-up')
check('seq 连续未重置', reloaded.lastSeq(room.id) === store.lastSeq(room.id))

console.log('8. 非法输入被拒绝')
let threw = false
try { await store.judge({ roomId: room.id, seq: m1.seq, sessionId: A, verdict: 'looks-fine-to-me' }) } catch { threw = true }
check('未知 verdict 被拒', threw)
check('VERDICTS 是四个', VERDICTS.length === 4, VERDICTS)

console.log('9. M3：线程预算（回执终端的双保险）')
let parentSeq = m2.seq
for (let i = 0; i < 4; i++) {
  const hop = await store.appendMessage({
    roomId: room.id,
    sender: { sessionId: A },
    kind: 'free',
    body: 'hop ' + i,
    threadId: 're:' + parentSeq,
  })
  parentSeq = hop.seq
}
const deep = store.state.messages.find((m) => m.seq === parentSeq)
check('深度被逐跳记录', deep.depth === 4, deep.depth)
check('深度用尽 → 标记 budgetStopped', deep.budgetStopped === true, deep.budgetStopped)
const overBudget = await store.appendMessage({
  roomId: room.id,
  sender: { sessionId: A },
  kind: 'change-notice',
  body: '还想叫人',
  mentions: [B],
  threadId: 're:' + parentSeq,
})
check('预算耗尽后 mentions 被丢弃', overBudget.mentions === undefined, overBudget.mentions)
check('预算耗尽后不产生任何义务', store.obligors(room.id, overBudget.seq).length === 0)
const underBudget = await store.appendMessage({
  roomId: room.id,
  sender: { sessionId: A },
  kind: 'change-notice',
  body: '正常一跳',
  mentions: [B],
})
check('预算之内的 mentions 照常生效', store.obligors(room.id, underBudget.seq).length >= 1,
  store.obligors(room.id, underBudget.seq).map((m) => shortId(m.sessionId)))

console.log('10. M3：逾时（纯读取时计算，不写消息不起定时器）')
const tight = store.status(room.id, m2.seq, 0)
check('阈值 0 → 欠表态者标记逾时', tight.members.find((m) => m.sessionId === B).overdue === true,
  tight.members.find((m) => m.sessionId === B))
check('房间级 overdue 也为真', tight.overdue === true)
const loose = store.status(room.id, m2.seq, 100000)
check('阈值极大 → 不逾时', loose.members.find((m) => m.sessionId === B).overdue === false)
check('已表态者永远不算逾时', loose.members.filter((m) => m.verdict !== null).every((m) => m.overdue === false))

console.log('11. M3：alert 是合法类别，且不产生义务')
const al = await store.appendMessage({ roomId: room.id, sender: { sessionId: A }, kind: 'alert', body: '停，别动 app.py' })
check('alert 被接受', al.kind === 'alert')
check('alert 不产生义务', store.obligors(room.id, al.seq).length === 0)
let badKind = false
try { await store.appendMessage({ roomId: room.id, sender: { sessionId: A }, kind: 'nope', body: 'x' }) } catch { badKind = true }
check('未知类别仍被拒', badKind)

console.log('12. parseMentions —— @ 是唯一能把「背景里看到」变成「被叫起来」的说法')
const ml = [
  { sessionId: 'session-aaaabbbb-1111-2222', roleName: '实现者' },
  { sessionId: '1b68df32-d51e-4dab-b1ea', roleName: '审计员' },
  { sessionId: 'session-ccccdddd-2222-3333', roleName: '' },
]
check('没有 @ → 谁也不提', parseMentions('我改完了，你们看着办', ml).length === 0)
check('@短号 → 命中一个', JSON.stringify(parseMentions('@aaaabbbb 请确认载荷', ml)) === JSON.stringify(['session-aaaabbbb-1111-2222']))
check('@角色名 → 命中', JSON.stringify(parseMentions('@审计员 看下这个', ml)) === JSON.stringify(['1b68df32-d51e-4dab-b1ea']))
check('@全体 → 全部', parseMentions('@全体 停一下', ml).length === 3)
check('@所有人 → 全部', parseMentions('@所有人 停一下', ml).length === 3)
check('@all → 全部', parseMentions('@all stop', ml).length === 3)
check('多个 @ → 都命中', parseMentions('@aaaabbbb @审计员 一起看', ml).length === 2)
check('@ 到不存在的短号 → 不误伤', parseMentions('@deadbeef 在吗', ml).length === 0)
check('没成员不炸', parseMentions('@aaaabbbb', undefined).length === 0)
check('text 为 undefined 不炸', parseMentions(undefined, ml).length === 0)
// **前缀命中**（真机 #1970 的同族，来自审计席自己的量具）：@ 后面的短号必须是**独立的一段**。
// 这条通道的后果比「量具读错」重得多 —— 它会**唤醒一个成员**、登记「你必须回一句」的义务。
check('更长 id 的前缀不算提及（@aaaabbbb9999）', parseMentions('@aaaabbbb9999 在吗', ml).length === 0)
check('短号后紧跟字母也不算（@aaaabbbbX）', parseMentions('@aaaabbbbX 在吗', ml).length === 0)
check('后面是标点 / 空格 / 行尾照旧算',
  parseMentions('@aaaabbbb，请确认', ml).length === 1 && parseMentions('@aaaabbbb) 收尾', ml).length === 1
  && parseMentions('就 @aaaabbbb', ml).length === 1, parseMentions('@aaaabbbb，请确认', ml).length)
// **`-`/`_` 只对「词」算边界**（真机 #1982②/#1985① 量到、#1987 定案）：短号是一条 uuid 的前 8 位，
// `-` 之后仍是**同一条 id** ⇒ 那两格对短号只制造漏报（列表形态会**静默丢掉前一个**）。
check('短号后紧跟 `-` 仍算点名（@aaaabbbb-的领地）', parseMentions('@aaaabbbb-的领地', ml).length === 1,
  parseMentions('@aaaabbbb-的领地', ml))
check('列表形态 @a-@b → **两个**都要点到（旧行为丢前一个）',
  JSON.stringify(parseMentions('@aaaabbbb-@ccccdddd 一起看', ml)) === JSON.stringify(['session-aaaabbbb-1111-2222', 'session-ccccdddd-2222-3333']),
  parseMentions('@aaaabbbb-@ccccdddd 一起看', ml))
check('而「词」的边界保留：@审计员-lead 不算点到审计员', parseMentions('@审计员-lead 这是另一个名字', ml).length === 0,
  parseMentions('@审计员-lead 这是另一个名字', ml))
check('@allows 不算 @全体（同族的前缀命中）', parseMentions('@allows 这不是点名', ml).length === 0)
check('「词」的边界也保留：@all-hands 不算喊全体（收掉的话代价是叫醒全房间）',
  parseMentions('@all-hands 这是频道名', ml).length === 0, parseMentions('@all-hands 这是频道名', ml))
check('@everyoneX 也不算', parseMentions('@everyoneX 这不是点名', ml).length === 0)

console.log('13. 越界检测 —— 「别人负责的区域，别悄悄改」')
const DIR_IMPL = '我负责 harness 回话管线（runaway 的输出上限补丁）与 WebUI 聊天区渲染（js/chat.js 的气泡真实性修复）；不碰同目录的 js/memory.js 与 dashboard.css。'
const split = ownedPaths(DIR_IMPL)
const tokensOf = (list) => list.map((x) => x.token)
check('抽出「负责」的文件', tokensOf(split.owned).includes('js/chat.js'), tokensOf(split.owned))
check('「不碰」的归另一边', tokensOf(split.excluded).includes('js/memory.js') && tokensOf(split.excluded).includes('dashboard.css'), tokensOf(split.excluded))
check('不碰的不算负责（两清单不重叠）', !tokensOf(split.owned).includes('js/memory.js'), tokensOf(split.owned))
check('每条都带出它所在的句子与句号（⚠ 行要回引）',
  split.owned.every((x) => typeof x.sentence === 'string' && x.sentence !== '' && typeof x.index === 'number'),
  split.owned)
check('空方向不炸', ownedPaths(undefined).owned.length === 0)

const roster = [
  { sessionId: 'session-impl', roleName: '实现者', enabled: true, selfDescription: DIR_IMPL },
  { sessionId: 'session-audit', roleName: '审计员', enabled: true, selfDescription: '只做审计，不改代码' },
]
const intoOwned = detectOverreach(['webui/pages/static/js/chat.js'], roster, 'session-audit')
check('改了别人负责的文件 → 命中', intoOwned.length === 1 && intoOwned[0].sessionId === 'session-impl', intoOwned)
check('  带上它的方向，便于判断', String(intoOwned[0].direction).includes('js/chat.js'))
check('  回引匹配到的子串', intoOwned[0].matched[0].token === 'js/chat.js', intoOwned[0].matched)
check('  回引它所在的句子', String(intoOwned[0].matched[0].sentence).includes('js/chat.js'), intoOwned[0].matched[0].sentence)
check('改了别人声明「不碰」的文件 → 不算越界', detectOverreach(['js/memory.js', 'dashboard.css'], roster, 'session-audit').length === 0)
check('改自己的文件 → 不算越界', detectOverreach(['js/chat.js'], roster, 'session-impl').length === 0)
check('没有方向的成员不参与判定', detectOverreach(['anything.py'], roster, 'session-audit').length === 0)
check('被用户关掉的成员不参与判定',
  detectOverreach(['js/chat.js'], [{ ...roster[0], enabled: false }], 'session-audit').length === 0)
check('空输入不炸', detectOverreach(undefined, undefined, 'x').length === 0)

console.log('14. 越界检测的假阳性（真机 #45 报来的原文）')
// 原文要点：路径字面量出现在**否定**语境里（「我从未声明过所有权…只追加自己的章节」），
// 旧词表只认「不碰/不动/不负责」，于是被读成了所有权主张，把一次正常改动标成了越界。
const DIR_REPORTED = '负责 Ulysses 仓库前端表现层中除 js/chat.js 之外的部分：ulysses/adapters/webui/** 的页面 / '
  + 'dashboard.css / 前端 JS（memory.js、mind.js、graph.js、fx/*）/ 自托管字体；js/chat.js 归 6126bf05。'
  + '另：docs/README.md 与 docs/ulysses-implementation-blueprint.md 我从未声明过所有权，'
  + '但 AGENTS §7 要求文档变更必须追加变更记录，故我会在这两个文件里只追加自己负责的章节与变更记录行。'
const reported = [
  { sessionId: 'session-front', roleName: '', enabled: true, selfDescription: DIR_REPORTED },
]
check('「从未声明过所有权」的路径不算它的地盘',
  detectOverreach(['docs/README.md', 'docs/ulysses-implementation-blueprint.md'], reported, 'session-other').length === 0,
  detectOverreach(['docs/README.md'], reported, 'session-other'))
check('它真正负责的前端文件仍然命中',
  detectOverreach(['ulysses/adapters/webui/pages/index.html'], reported, 'session-other').length === 1)
check('它明确「不碰」的 js/chat.js 不算它的',
  detectOverreach(['js/chat.js'], reported, 'session-other').length === 0)

console.log('15. 正文自带「免回执」标记 + 已表态者不再欠（真机 #55 报的两条）')
// ① 作者说了不用回，就不用回 —— 真机 #53 我正文写了「不要求谁回应」，插件照样把人叫起来了
check('「不要求谁回应」被认出来', saysNoReply('同步一下，不要求谁回应') === true)
check('「不需要回应」被认出来', saysNoReply('只是记录一下：不需要回应') === true)
check('「无需回复」被认出来', saysNoReply('无需回复，我这边已经处理') === true)
check('「不必表态」被认出来', saysNoReply('这条不必表态') === true)
check('英文 no reply needed 被认出来', saysNoReply('FYI, no reply needed') === true)
check('正常点名 → 不算免回执', saysNoReply('@1b68df32 请确认载荷') === false)
check('半截词不误伤（「不必回滚」不是免回执）', saysNoReply('这个改动不必回滚，继续跑') === false)
check('空文本不炸', saysNoReply(undefined) === false)

// ② 表态是终端的：已经表过态的人不再欠这条消息（否则投递层会把「你必须回一句」再送一次）
const mOwed = await store.appendMessage({ roomId: room.id, sender: { user: true }, kind: 'human', body: '这条要不要一起看？' })
// 注意：跑到这里时 C 已被用户关闭（§5），活跃成员是 2 人 —— 按实际活跃数断言，不写死
const activeNow = store.activeMembers(room.id).length
check('人发言 → 全体活跃成员欠回执', store.obligors(room.id, mOwed.seq).length === activeNow,
  store.obligors(room.id, mOwed.seq).map((m) => shortId(m.sessionId)))
await store.judge({ roomId: room.id, seq: mOwed.seq, sessionId: B, verdict: 'unaffected', note: '' })
const owedAfter = store.obligors(room.id, mOwed.seq).map((m) => m.sessionId)
check('B 表态后不再欠', owedAfter.length === activeNow - 1 && !owedAfter.includes(B), owedAfter.map(shortId))
check('judgedBy 能查出谁表过态', store.judgedBy(room.id, mOwed.seq).includes(B), store.judgedBy(room.id, mOwed.seq).map(shortId))

console.log('15b. **作者撤回** —— 「事后销账」有机器动作（真机 #2131③）')
// 房间本来就有「作者说了不用回就不用回」，但那两个机制（wake=false 与正文标记）只在**发送时**抑制；
// 义务一旦登记，事后没有机器动作能销它 ⇒ 目标只能白花一轮去 judge 一条早就作废的消息。
const mRetract = await store.appendMessage({ roomId: room.id, sender: { sessionId: A }, kind: 'free', body: '@' + shortId(B) + ' 你看下这条' , mentions: [B] })
check('撤回前：被点到的人欠它', store.obligors(room.id, mRetract.seq).length === 1,
  store.obligors(room.id, mRetract.seq).map((m) => shortId(m.sessionId)))
const rNotAuthor = await store.retract(room.id, mRetract.seq, B)
check('非作者撤不动（明确拒绝，不静默）', rNotAuthor.ok === false && rNotAuthor.reason === 'not-author', rNotAuthor)
const rMissing = await store.retract(room.id, 999999, A)
check('房间里没有这条 → 也说清楚', rMissing.ok === false && rMissing.reason === 'no-such-message', rMissing)
const rOk = await store.retract(room.id, mRetract.seq, A)
check('作者撤回成立，并回答「销掉了谁」', rOk.ok === true && rOk.already === false && rOk.cleared.length === 1, rOk)
check('撤回后那条不再向任何人要回执', store.obligors(room.id, mRetract.seq).length === 0)
const rAgain = await store.retract(room.id, mRetract.seq, A)
check('幂等：重复撤回不报错', rAgain.ok === true && rAgain.already === true, rAgain)

console.log('16. 引述即提及 —— 引述里的 @ 不算，自己也不 @ 自己（真机 #58 报的）')
const mm = [
  { sessionId: 'session-4025aaaa-1111', roleName: '前端' },
  { sessionId: 'session-39f9bbbb-2222', roleName: '' },
]
check('裸 @ 短号 → 命中', parseMentions('@4025aaaa 请确认', mm).length === 1, parseMentions('@4025aaaa 请确认', mm))
check('围栏代码块里的 @ 不算', parseMentions('引述如下：\n```\n@4025aaaa 请确认\n```\n完毕', mm).length === 0,
  parseMentions('引述如下：\n```\n@4025aaaa 请确认\n```\n完毕', mm))
check('行内 code 里的 @ 不算', parseMentions('原文是 `@4025aaaa 请确认`', mm).length === 0)
check('「」里的 @ 不算', parseMentions('它写着「⚠ 落在 @4025aaaa 的范围」', mm).length === 0)
check('『』里的 @ 不算', parseMentions('它写着『@4025aaaa 确认』', mm).length === 0)
check('成对双引号里的 @ 不算', parseMentions('它写着 "@4025aaaa 确认"', mm).length === 0)
check('引述之外的点名照样命中',
  parseMentions('引述「@4025aaaa」之后，我还是要点名 @39f9bbbb', mm).join() === 'session-39f9bbbb-2222',
  parseMentions('引述「@4025aaaa」之后，我还是要点名 @39f9bbbb', mm))
check('自己 @ 自己不算（自提及永远是笔误）',
  parseMentions('@4025aaaa 我自己补一句', mm, 'session-4025aaaa-1111').length === 0)
check('@全体 也不把自己算进去',
  parseMentions('@全体 停一下', mm, 'session-4025aaaa-1111').join() === 'session-39f9bbbb-2222',
  parseMentions('@全体 停一下', mm, 'session-4025aaaa-1111'))

console.log('17. 作者不必回应自己 —— 自我提及不是义务（真机 #45 / #58 / #61 报的「重复投递」）')
// 真机记录里躺着两条 sender ∈ mentions 的旧消息（#45 / #58）。光靠 parseMentions
// 不再产生新的还不够：状态层必须自己排掉作者 —— 排不掉的后果不是「多一条待表态」，
// 而是投递层会对着**正在执行这次 room_say 的那个 agent 自己**发 followup，
// DSH 只能挂进 next-turn 队列，等它下一轮才落地 —— 那时它已经从 room_status
// 看到并回执过了，于是那帧就成了「回执之后又被投一次」。
const mSelf = await store.appendMessage({
  roomId: room.id,
  sender: { sessionId: A, roleName: '实现者' },
  kind: 'free',
  body: '给 @aaaabbbb 和自己留个记录',
  mentions: [A, B], // 故意照旧记录的坏形状写：发送者也在 mentions 里
})
const owedSelf = store.obligors(room.id, mSelf.seq).map((m) => m.sessionId)
check('作者不在义务人里（自我提及不算）', !owedSelf.includes(A), owedSelf.map(shortId))
check('  被点到的别人照常欠回执', owedSelf.includes(B), owedSelf.map(shortId))
// 反向对照：作者被排除，不等于「这条消息没人欠」—— 义务不能被顺手清空
const mOther = await store.appendMessage({
  roomId: room.id, sender: { sessionId: B, roleName: '评审' }, kind: 'free',
  body: '给 @aaaabbbb 的一条', mentions: [A],
})
check('别人点作者 → 作者照常欠回执',
  store.obligors(room.id, mOther.seq).map((m) => m.sessionId).includes(A),
  store.obligors(room.id, mOther.seq).map((m) => shortId(m.sessionId)))

console.log('18. 并发写盘不许互相踩（真机 #653 / #661 报的：同一批次并发发两条房间消息）')
// 旧实现：所有写入共用 rooms.json.tmp —— 并发时先到的 rename 会把**别人写进 tmp 的内容**
// 当成自己的提交（"抛错但其实写进去了"），被覆盖的那次连内容一起丢（"抛错且真丢了"）。
const root2 = path.join(os.tmpdir(), 'dsh-chatroom-concurrent-' + Date.now())
const store2 = createChatroomStore({ root: root2 })
await store2.load()
const room2 = await store2.createRoom({ name: '并发写' })
await store2.join(room2.id, A, { roleName: '实现者' })
const N18 = 12
const settled = await Promise.allSettled(
  Array.from({ length: N18 }, (_, i) => store2.appendMessage({
    roomId: room2.id, sender: { sessionId: A, roleName: '实现者' }, kind: 'free', body: '并发 ' + i,
  })),
)
check('并发 ' + N18 + ' 条 append 全部成功（无 ENOENT）',
  settled.every((r) => r.status === 'fulfilled'),
  settled.filter((r) => r.status === 'rejected').map((r) => String(r.reason && r.reason.message)))
const onDisk = JSON.parse(await fs.readFile(path.join(root2, 'rooms.json'), 'utf8'))
const persisted = onDisk.messages.filter((m) => m.roomId === room2.id)
check('  盘上每一条都在（不丢条）', persisted.length === N18, persisted.length)
check('  盘上 seq 连续无重复', new Set(persisted.map((m) => m.seq)).size === N18,
  persisted.map((m) => m.seq).sort((x, y) => x - y))
check('  没留下 tmp 垃圾', (await fs.readdir(root2)).filter((f) => f.endsWith('.tmp')).length === 0,
  await fs.readdir(root2))
check('  写成功就不该报"状态文件出问题"', store2.stateError() === null, store2.stateError())

// 读盘损坏：不再静默退回空状态（那等于整份房间记录无声清零）
const root3 = path.join(os.tmpdir(), 'dsh-chatroom-corrupt-' + Date.now())
await fs.mkdir(root3, { recursive: true })
await fs.writeFile(path.join(root3, 'rooms.json'), '{"rooms": [{"id": "room-x"', 'utf8') // 半截 JSON
const store3 = createChatroomStore({ root: root3 })
await store3.load()
check('  损坏文件 → 以空状态启动，但**留下原文**',
  (await fs.readdir(root3)).some((f) => f.includes('corrupt-')), await fs.readdir(root3))
check('  并且这件事被记下来（room_status 会说出来）',
  typeof store3.stateError() === 'string' && store3.stateError().includes('读不出来'), store3.stateError())
await fs.rm(root3, { recursive: true, force: true })
await fs.rm(root2, { recursive: true, force: true })

console.log('19. 房间策略就地可改（真机反馈 2026-09-14：撞到 room is full 才知道有个上限）')
const pRoom = await store.createRoom({ name: '策略' })
check('默认上限 = 5', pRoom.policy.maxMembers === 5, pRoom.policy)
let pol = await store.setPolicy(pRoom.id, { maxMembers: 3, threadBudget: 6 })
check('设两个字段', pol.policy.maxMembers === 3 && pol.policy.threadBudget === 6, pol.policy)
pol = await store.setPolicy(pRoom.id, { maxMembers: 2 })
check('只设一个字段时另一个不动', pol.policy.maxMembers === 2 && pol.policy.threadBudget === 6, pol.policy)
check('空 patch 不改动', (await store.setPolicy(pRoom.id, {})).policy.maxMembers === 2)
await store.setPolicy(pRoom.id, { maxMembers: 3 })
await store.join(pRoom.id, A, {})
await store.join(pRoom.id, B, {})
await store.join(pRoom.id, C, {})
check('三名成员坐满上限', store.activeMembers(pRoom.id).length === 3, store.activeMembers(pRoom.id).length)
const D19 = 'session-ddddeeee-1111-2222-3333-444455556666'
let threw19 = null
try { await store.join(pRoom.id, D19, {}) } catch (err) { threw19 = String(err.message) }
check('到达上限 → 拒绝并说清上限', threw19 !== null && threw19.includes('room is full (3'), threw19)
await store.setPolicy(pRoom.id, { maxMembers: 1 })
check('上限降到低于当前人数：允许（不踢人）', store.activeMembers(pRoom.id).length === 3, store.activeMembers(pRoom.id).length)
threw19 = null
try { await store.join(pRoom.id, D19, {}) } catch (err) { threw19 = String(err.message) }
check('  但仍加不进新人', threw19 !== null, threw19)
for (const bad of [0, 999, 'abc', -1, 1.5]) {
  let err19 = null
  try { await store.setPolicy(pRoom.id, { maxMembers: bad }) } catch (err) { err19 = String(err.message) }
  check('  非法值 ' + JSON.stringify(bad) + ' 被拒（不夹取、不静默截断）', err19 !== null && err19.includes('成员上限'), err19)
}
let err19b = null
try { await store.setPolicy(pRoom.id, { threadBudget: 0 }) } catch (err) { err19b = String(err.message) }
check('  线程预算非法值也被拒', err19b !== null && err19b.includes('线程预算'), err19b)
const storeB = createChatroomStore({ root })
await storeB.load()
check('策略落盘（重开仍在）',
  storeB.getRoom(pRoom.id).policy.maxMembers === 1 && storeB.getRoom(pRoom.id).policy.threadBudget === 6,
  storeB.getRoom(pRoom.id).policy)

console.log('20. 「欠的是哪一条」—— 义务会积压，靶子只报最新那条（真机 #1348 / #1279 / #1268）')
// 场景就是真机里发生的那一幕：人的发言让全体欠回执 → 有人回了 → 之后一条只 @ 了**别人**的消息
// 把靶子挪走。旧的 status 只说「谁欠靶子」，于是「谁还欠着 #h1」在面板与 room_status 里
// 同时消失，两个人只能各自推理「已读停在 N」算不算 N。
const root4 = path.join(os.tmpdir(), 'dsh-chatroom-owed-' + Date.now())
let fakeNow = Date.now()
const s4 = createChatroomStore({ root: root4, now: () => fakeNow })
await s4.load()
const r4 = await s4.createRoom({ name: '欠哪一条' })
const P = 'session-4025aaaa-1111-2222-3333-444455556666'
const Q = 'session-39f9bbbb-1111-2222-3333-444455556666'
await s4.join(r4.id, P, { roleName: '前端' })
await s4.join(r4.id, Q, { roleName: '审计' })
const h1 = await s4.appendMessage({ roomId: r4.id, sender: { user: true }, kind: 'human', body: '这条全体都得回' })
check('人发言 → 两人都欠', s4.obligors(r4.id, h1.seq).length === 2, s4.obligors(r4.id, h1.seq).length)
await s4.judge({ roomId: r4.id, seq: h1.seq, sessionId: Q, verdict: 'catch-up' })
const m20 = await s4.appendMessage({
  roomId: r4.id, sender: { sessionId: P, roleName: '前端' }, kind: 'free',
  body: '只问 @39f9bbbb', mentions: [Q],
})
const st4 = s4.status(r4.id)
check('靶子 = 最新那条产生义务的消息', st4.targetSeq === m20.seq, st4.targetSeq)
const pRow = st4.members.find((m) => m.shortId === '4025aaaa')
const qRow = st4.members.find((m) => m.shortId === '39f9bbbb')
check('P 的欠账里带着 seq（旧的 h1）', pRow.owedSeqs.join() === String(h1.seq), pRow.owedSeqs)
check('  P 在靶子上不欠 → owed=false（旧行为），但欠账没被吞掉',
  pRow.owed === false && pRow.owedSeqs.length === 1, { owed: pRow.owed, seqs: pRow.owedSeqs })
check('Q 欠的是靶子那条', qRow.owedSeqs.join() === String(m20.seq) && qRow.owed === true, qRow.owedSeqs)
check('pending 仍是「靶子上还欠谁」（投递层与旧面板的既有语义，不许变）',
  st4.pending.length === 1 && st4.pending[0] === Q, st4.pending.map(shortId))
check('pendingDetail 把 seq 一起带上（面板与 room_status 用它说「欠哪条」）',
  st4.pendingDetail.length === 2
  && st4.pendingDetail.find((d) => d.shortId === '4025aaaa').seqs.join() === String(h1.seq)
  && st4.pendingDetail.find((d) => d.shortId === '39f9bbbb').seqs.join() === String(m20.seq),
  st4.pendingDetail)
check('owedSeqs(房间) 给 Map，owedSeqs(房间, 人) 给数组',
  s4.owedSeqs(r4.id).get(P).join() === String(h1.seq) && s4.owedSeqs(r4.id, Q).join() === String(m20.seq),
  [...s4.owedSeqs(r4.id)].map(([id, s]) => shortId(id) + ':' + s.join()))
check('openObligations 只列还欠的那些（顺序 = seq 升序）',
  s4.openObligations(r4.id).map((o) => o.seq).join() === [h1.seq, m20.seq].join(),
  s4.openObligations(r4.id).map((o) => o.seq))
// 逾时判据跟着放宽：欠着很久以前那条、而靶子很新的时候，旧实现显示「未逾时」——
// 那正是 #1348 里查不出来的那种（欠着，却看不出欠）。
fakeNow += 2 * 3600000
const st4b = s4.status(r4.id)
check('  旧账也会被标逾时（旧判据只看靶子，会漏）',
  st4b.members.find((m) => m.shortId === '4025aaaa').overdue === true,
  st4b.members.find((m) => m.shortId === '4025aaaa'))
check('  逾时的具体 seq 一并给出来（供面板/工具说清是「哪一条」逾时）',
  st4b.members.find((m) => m.shortId === '4025aaaa').overdueSeqs.join() === String(h1.seq),
  st4b.members.find((m) => m.shortId === '4025aaaa').overdueSeqs)
await s4.judge({ roomId: r4.id, seq: h1.seq, sessionId: P, verdict: 'unaffected' })
check('补了旧账 → 它从欠账里消失', s4.owedSeqs(r4.id, P).length === 0, s4.owedSeqs(r4.id, P))
await s4.setEnabled(r4.id, Q, false)
check('被用户关掉的成员不参与（欠账里也不该有它）',
  s4.owedSeqs(r4.id, Q).length === 0 && s4.openObligations(r4.id).length === 0,
  s4.openObligations(r4.id).map((o) => shortId(o.sessionId) + '@' + o.seq))
await fs.rm(root4, { recursive: true, force: true })

console.log('21. 机器读的边界（真机 2026-09-16：6 人里 3 人的方向被静默截断到 200 字）')
// 起因（房间 P1）：把散文当机器输入会一直付误报的代价 —— 否定词表为 #45 打过补丁，
// 而「不进 X 依赖图」这类措辞不在表里；更硬的是方向被 slice(0,200) 砍断，
// 6126bf05 的「不碰 dashboard.css」在**数据**里只剩 dashbo。
const sp = structuredPaths(['ulysses/app.py', 'ulysses/runtime/harness/**', 'dashboard.css', '  ', './web/app.py'])
check('结构化条目按形状判类型（文件 vs 目录）',
  sp.length === 4 && sp[0].kind === 'file' && sp[1].kind === 'dir' && sp[3].token === 'web/app.py',
  sp.map((x) => x.token + ':' + x.kind))
check('  没有扩展名的按目录前缀匹配',
  matchesOwnedPath('ulysses/core/config.py', structuredPaths(['ulysses/core'])) !== null)
check('  文件按后缀匹配（短路径命中长路径）',
  matchesOwnedPath('a/b/dashboard.css', structuredPaths(['dashboard.css'])) !== null)
check('  非数组 / 空值不炸', structuredPaths(undefined).length === 0 && structuredPaths(null).length === 0)
let threw21 = null
try { cleanPathList('not-an-array', 'paths') } catch (err) { threw21 = String(err.message) }
check('  paths 不是数组 → 报错（不静默当成空）', threw21 !== null && threw21.includes('必须是字符串数组'), threw21)
threw21 = null
try { cleanPathList(Array.from({ length: 41 }, (_, i) => 'f' + i + '.py'), 'paths') } catch (err) { threw21 = String(err.message) }
check('  超过 40 条 → 报错（它不是第二篇散文）', threw21 !== null && threw21.includes('最多 40 条'), threw21)

const ownA = memberOwnership({ paths: ['ulysses/app.py'], selfDescription: '我负责 ulysses/web/** 的端点' })
check('结构化 + 散文合并成一份边界', ownA.owned.length === 2 && ownA.structured === true, ownA.owned.map((x) => x.token))
const ownB = memberOwnership({ selfDescription: '不碰 dashboard.css；负责 ulysses/app.py' })
check('散文里的否定进 excluded（legacy 那条路仍要工作）',
  ownB.excluded.length === 1 && ownB.owned.length === 1 && ownB.structured === false,
  { owned: ownB.owned.map((x) => x.token), excluded: ownB.excluded.map((x) => x.token) })
const ownC = memberOwnership({ subscriptions: ['ulysses/app.py'] })
check('subscriptions 也算机器可读的边界（旧字段不再是死的）', ownC.structured === true && ownC.owned.length === 1)

const overStruct = detectOverreach(['ulysses/app.py'], [
  { sessionId: 'me', paths: ['ulysses/app.py'] },
  { sessionId: 'other', paths: ['ulysses/app.py'] },
], 'me')
check('结构化边界参与越界判定（旧实现只读 selfDescription）',
  overStruct.length === 1 && overStruct[0].sessionId === 'other', overStruct.map((h) => h.sessionId))
check('  带出结构化来源（⚠ 行据此措辞，不再说"方向第 N 句"）',
  overStruct[0].matched[0].index === 0 && overStruct[0].matched[0].sentence.includes('结构化'), overStruct[0].matched[0])
const overExcl = detectOverreach(['dashboard.css'], [
  { sessionId: 'other', paths: ['dashboard.css'], excludes: ['dashboard.css'] },
], 'me')
check('自己声明不碰的 → 不算越界（排除优先）', overExcl.length === 0, overExcl)

console.log('22. 方向存全文、不再静默截断（setSelfDescription）')
const dRoom = await store.createRoom({ name: '方向长度' })
const LONG = '负'.repeat(300) + ' ulysses/app.py'
await store.join(dRoom.id, A, { roleName: '实现者' })
let m22 = await store.setSelfDescription(dRoom.id, A, LONG, { paths: ['ulysses/app.py'], excludes: ['dashboard.css'] })
check('300 字方向原样存下（旧实现会砍到 200）', m22.selfDescription.length === LONG.length, m22.selfDescription.length)
check('  paths / excludes 落库', m22.paths.join() === 'ulysses/app.py' && m22.excludes.join() === 'dashboard.css',
  { paths: m22.paths, excludes: m22.excludes })
m22 = await store.setSelfDescription(dRoom.id, A, '改短了')
check('  不传 paths → 保留上一次的边界（只改散文不会把边界弄丢）',
  m22.paths.join() === 'ulysses/app.py' && m22.selfDescription === '改短了', { p: m22.paths, d: m22.selfDescription })
m22 = await store.setSelfDescription(dRoom.id, A, '改短了', { paths: [] })
check('  显式传空数组 → 清空边界', m22.paths.length === 0, m22.paths)
let threw22 = null
try { await store.setSelfDescription(dRoom.id, A, 'x'.repeat(DIRECTION_MAX_CHARS + 1)) } catch (err) { threw22 = String(err.message) }
check('  超上限 → 报错而不是截断（截断正是这次要修的 bug）', threw22 !== null && threw22.includes('方向太长'), threw22)

console.log('22b. 观察者/静音席位 —— 收录范围与"有没有领地"是两根轴（真机 #1714）')
// 真机代价：只读席位一晚被唤醒 10 次、0 次与职责相关；而工具还建议它"补 paths 就能收敛"
// —— 对"要收全量变更"的审计席，那条建议是错的（补了就漏审）。
m22 = await store.setSelfDescription(dRoom.id, A, '只读审计席，不认领任何路径', { watch: 'all' })
check('watch=all 落库', m22.watch === 'all' && (m22.paths || []).length === 0, { watch: m22.watch, paths: m22.paths })
check('  它**不需要** paths 也能表达收录范围', store.status(dRoom.id).members[0].watch === 'all')
// **唤醒席**（真机 #1920）：三根轴（推不推 × 叫不叫醒 × 要不要回）里缺的那个角 —— 全推 + 叫醒 + 不必回。
m22 = await store.setSelfDescription(dRoom.id, A, '自动审计席：醒过来看一眼就行，不必写话', { watch: 'wake' })
check('watch=wake 落库（全推 + 会叫醒 + 不必回）', m22.watch === 'wake' && store.status(dRoom.id).members[0].watch === 'wake')
// **只收不答席**（真机 #1798）：全推但**不叫醒**、也不产生义务。
m22 = await store.setSelfDescription(dRoom.id, A, '安全审计席：要看得见，不必每条都应一声', { watch: 'feed' })
check('watch=feed 落库（全推 + 不产生义务）', m22.watch === 'feed' && store.status(dRoom.id).members[0].watch === 'feed')
m22 = await store.setSelfDescription(dRoom.id, A, '静音席', { watch: 'none' })
check('watch=none 落库', m22.watch === 'none')
let threw22b = null
try { await store.setSelfDescription(dRoom.id, A, 'x', { watch: 'sometimes' }) } catch (err) { threw22b = String(err.message) }
check('  非法值拒绝而不是夹取（与 paths/policy 同一套口径）',
  threw22b !== null && threw22b.includes('watch 只能是'), threw22b)
m22 = await store.setSelfDescription(dRoom.id, A, '改回普通')
check('  不传 watch → 保留上一次的（与 paths 同一条规矩）', m22.watch === 'none', m22.watch)
const st22 = store.status(dRoom.id)
check('  status 把边界带给面板与工具',
  Array.isArray(st22.members[0].paths) && Array.isArray(st22.members[0].excludes), st22.members[0].paths)

console.log('23. 「不需要回应」是**段落级**的（真机 #1587/#1596/#1597/#1598/#1609，有重放证据）')
// 缺陷形状：整条 includes 一次 ⇒ 一处逐条标注把同一条消息里别处的真 @ 全压掉，
// 房间判「没有 @ 任何人」，两个真提问静默降级成背景（S6 重放：那三条的 mentions 全是 null）。
// #1606 更狠：作者为了解释被吞而**原样引了一遍那句话** ⇒ 缺陷被解释动作再触发一次。
const mm23 = [
  { sessionId: 'session-aaaa1111-0001', roleName: '甲' },
  { sessionId: 'session-bbbb2222-0002', roleName: '乙' },
  { sessionId: 'session-cccc3333-0003', roleName: '' },
]
const A23 = mm23[0].sessionId
const B23 = mm23[1].sessionId
const C23 = mm23[2].sessionId
const s23 = (text) => parseMentionsScoped(text, mm23, null)

const sameLine = s23('@aaaa1111 顺带同步一下：不需要回应')
check('同一行里「@ + 不需要回应」→ 照旧不进义务（#55 那条钉子的形状没变）',
  sameLine.mentions.length === 0 && sameLine.suppressed.join() === A23, sameLine)

const otherLine = s23('@aaaa1111 请把 §2 改掉\n另给乙一条更正（不需要回应）\n@bbbb2222 请裁一句')
check('#1587 的形状：标记独占一行 → **两个真 @ 都保住**',
  otherLine.mentions.join() === [A23, B23].join(), otherLine)
check('  那一行没有 @ ⇒ 不压任何人', otherLine.suppressed.length === 0, otherLine.suppressed)
check('  但记下"见过标记"（返回值据此提示作者）', otherLine.markedLines === 1, otherLine.markedLines)

const mixed = s23('@aaaa1111 这条不用回（不需要回应）\n@bbbb2222 这条要回')
check('同行压掉、异行保住 —— 粒度是"行"不是"条"',
  mixed.mentions.join() === B23 && mixed.suppressed.join() === A23, mixed)

const none = s23('@aaaa1111 正常提问\n@bbbb2222 另一件事')
check('没有标记 → 全部登记', none.mentions.join() === [A23, B23].join() && none.suppressed.length === 0, none)
check('  没有 @ 也没有标记 → 空（纯背景）', s23('只是一条记录').mentions.length === 0)
check('  引述里的 @ 仍不算（段落级不放松引述规则）',
  s23('原文写着 `@aaaa1111 请确认`（只是引述）\n@bbbb2222 请回这句').mentions.join() === B23,
  s23('原文写着 `@aaaa1111 请确认`（只是引述）\n@bbbb2222 请回这句'))
check('  角色名也吃同一套规则',
  s23('@甲 不用回（不需要回应）\n@乙 请回').mentions.join() === B23, s23('@甲 不用回（不需要回应）\n@乙 请回'))
check('  同一个人在两行都被点到、其中一行要压制 → 保住（去重按"至少一处要回"）',
  s23('@cccc3333（不需要回应）\n@cccc3333 请回这句').mentions.join() === C23,
  s23('@cccc3333（不需要回应）\n@cccc3333 请回这句'))
check('undefined / 空文本不炸', s23(undefined).mentions.length === 0 && s23('').suppressed.length === 0)
// **引述里的标记不算**（#1597 的真机形状：作者为了解释这条缺陷，把「不需要回应」原样引了一遍）
check('引述里的标记不算（作者在解释这个 bug 时不会再触发它）',
  s23('@aaaa1111 上一条我写了「不需要回应」，所以被吞了 —— 请把 §2 改掉').mentions.join() === A23,
  s23('@aaaa1111 上一条我写了「不需要回应」，所以被吞了 —— 请把 §2 改掉'))
check('  行内 code / 代码块里的标记同样不算',
  s23('@aaaa1111 词表里有 `不需要回应` 这一条，请裁一句').mentions.join() === A23
  && s23('@aaaa1111 见下：\n```\n不需要回应\n```').mentions.join() === A23)
check('  但**非引述**的括号标注照旧算（#55 的形状不能被引述规则误伤）',
  s23('@aaaa1111 顺带同步一下（不需要回应）').mentions.length === 0)

await fs.rm(root, { recursive: true, force: true })
console.log('')
console.log('RESULT  ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
