import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createChatroomStore, shortId, parseMentions, ownedPaths, detectOverreach, saysNoReply, VERDICTS } from '../lib/rooms.js'

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

await fs.rm(root, { recursive: true, force: true })
console.log('')
console.log('RESULT  ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
