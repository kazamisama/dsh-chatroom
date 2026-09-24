/**
 * 不变量模块的测试 —— 自己造一份最小 state，不起真 store。
 *
 * 为什么造而不起 store：这三个函数是**纯**的（同步、不碰 IO、不改传入对象），
 * 用真 store 会把「不变量写错了」和「落盘/加载出问题了」混成同一条红，而这两件事的修法完全不同。
 * 这里对每条规则各钉一个正例与一个反例；反例还要验 err.code 与信息里点出的字段 ——
 * 调用方要能只凭 code 分流（数据坏了 vs IO 失败），人要能只看信息那一句就知道是谁的错。
 */
import {
  assertMessageAppend, assertJudgment, assertTaskWrite, assertStateShape,
  MESSAGE_KINDS, VERDICTS, TASK_STATUSES,
} from '../lib/invariants.js'
// 只有**常量**从 rooms.js 引：invariants.js 自己不能 import 它（调用点就在它的写路径上，会成环），
// 所以两份常量的漂移由这几条断言来钉 —— 这是本文件存在的一半理由。
import { MESSAGE_KINDS as ROOM_KINDS, VERDICTS as ROOM_VERDICTS } from '../lib/rooms.js'

let pass = 0
let fail = 0

function check(label, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra))) }
}

/**
 * 「必须抛」：要求 err.code 正好是 INVARIANT_<code>，且信息里出现 says 那段文字。
 * 只验「抛了」是不够的 —— 抛一个 TypeError 也是抛，而调用方按 code 分流的逻辑会当场失灵；
 * 只验 code 也不够 —— 信息里不点出是哪个字段，人还得回头翻代码。
 */
function checkThrows(label, fn, code, says) {
  let err = null
  try { fn() } catch (e) { err = e }
  if (err === null) { check(label, false, '没有抛（期望 INVARIANT_' + code + '）'); return }
  const codeOk = err.code === 'INVARIANT_' + code
  const saysOk = says === undefined || String(err.message).includes(says)
  check(label, codeOk && saysOk, { code: err.code, want: 'INVARIANT_' + code, says: says, message: err.message })
}

/** 抓错误回来自己看（体检那种一次报一堆的，需要读 err.problems 而不只是「抛了没」）。 */
function grab(fn) {
  try { fn(); return null } catch (e) { return e }
}

const ALICE = 'session-aaaaaaaa-1111-1111-111111111111'
const BOB = 'session-bbbbbbbb-2222-2222-222222222222'
const CAROL = 'session-cccccccc-3333-3333-333333333333'   // 在成员表里，但 enabled=false（用户关了开关）
const DAVE = 'session-dddddddd-4444-4444-444444444444'    // 根本不是成员

const member = (sessionId, enabled) => ({
  roomId: 'room-a', sessionId, roleName: sessionId.slice(8, 16), enabled, joinedAt: 1, subscriptions: [], selfDescription: '',
})

/** 最小 state：两个房间、三个成员（一个被关掉）、两条消息、一份游标。 */
function makeState() {
  return {
    version: 1,
    rooms: [
      { id: 'room-a', name: 'A', createdBy: 'user', createdAt: 1, policy: { maxMembers: 5, threadBudget: 4 } },
      { id: 'room-b', name: 'B', createdBy: 'user', createdAt: 2, policy: { maxMembers: 5, threadBudget: 4 } },
    ],
    members: [member(ALICE, true), member(BOB, true), member(CAROL, false)],
    messages: [
      { seq: 1, roomId: 'room-a', sender: { user: true }, kind: 'human', body: '人说话', refs: [], terminal: false, ts: 1 },
      { seq: 2, roomId: 'room-a', sender: { sessionId: ALICE }, kind: 'free', body: '背景', refs: [], terminal: false, ts: 2 },
    ],
    cursors: [{ roomId: 'room-a', sessionId: ALICE, lastSeq: 2 }],
    changes: [],
    judgments: [],
    baselines: [],
    deliveries: [],
    tasks: [],
    nextSeq: 3,
  }
}

const msg = (over) => Object.assign({
  seq: 3, roomId: 'room-a', sender: { sessionId: ALICE }, kind: 'free', body: '新消息', refs: [], terminal: false, ts: 3,
}, over)

const task = (over) => Object.assign({
  id: 't-new', roomId: 'room-a', title: '做一件事', status: 'open', owner: null, deps: [], expectPaths: [],
  createdBy: ALICE, createdAt: 3, updatedAt: 3, note: '',
}, over)

console.log('0. 常量与 rooms.js 不漂移')
check('MESSAGE_KINDS 与 rooms.js 一致', JSON.stringify(MESSAGE_KINDS) === JSON.stringify(ROOM_KINDS),
  { here: MESSAGE_KINDS, rooms: ROOM_KINDS })
check('VERDICTS 与 rooms.js 一致', JSON.stringify(VERDICTS) === JSON.stringify(ROOM_VERDICTS),
  { here: VERDICTS, rooms: ROOM_VERDICTS })
check('TASK_STATUSES 正好是这四个', TASK_STATUSES.join(',') === 'open,claimed,done,dropped', TASK_STATUSES)

console.log('')
console.log('1. assertMessageAppend —— 正例')
const s1 = makeState()
check('合法消息通过，返回 true', assertMessageAppend(s1, msg()) === true)
check('  会话发送者通过', assertMessageAppend(s1, msg({ sender: { sessionId: BOB } })) === true)
check('  user 发送者通过', assertMessageAppend(s1, msg({ sender: { user: true } })) === true)
check('  mentions 指向 enabled 成员通过', assertMessageAppend(s1, msg({ mentions: [BOB] })) === true)
check('  mentions 显式空数组通过', assertMessageAppend(s1, msg({ mentions: [] })) === true)
check('  seq 恰好 = 该房间 max + 1 通过', assertMessageAppend(s1, msg({ seq: 3 })) === true)
check('  另一个房间从自己的 seq = 1 起算（每房间各自单调）',
  assertMessageAppend(s1, msg({ roomId: 'room-b', seq: 1, sender: { user: true } })) === true)
check('  通过一次不改 state（消息仍 2 条、nextSeq 仍 3）', s1.messages.length === 2 && s1.nextSeq === 3, s1)

console.log('')
console.log('2. assertMessageAppend —— 反例')
const s2 = makeState()
checkThrows('state 不是对象', () => assertMessageAppend(null, msg()), 'STATE_SHAPE')
checkThrows('message 不是对象', () => assertMessageAppend(s2, null), 'MESSAGE_SHAPE')
checkThrows('roomId 缺失', () => assertMessageAppend(s2, msg({ roomId: undefined })), 'ROOM_ID_INVALID', 'message.roomId')
checkThrows('房间不存在', () => assertMessageAppend(s2, msg({ roomId: 'room-z' })), 'ROOM_NOT_FOUND', 'room-z')
checkThrows('seq = 0', () => assertMessageAppend(s2, msg({ seq: 0 })), 'SEQ_INVALID', 'message.seq')
checkThrows('seq 是负数', () => assertMessageAppend(s2, msg({ seq: -3 })), 'SEQ_INVALID', 'seq')
checkThrows('seq 是字符串', () => assertMessageAppend(s2, msg({ seq: '3' })), 'SEQ_INVALID', 'seq')
checkThrows('seq 不是整数', () => assertMessageAppend(s2, msg({ seq: 3.5 })), 'SEQ_INVALID', 'seq')
checkThrows('seq 缺失', () => assertMessageAppend(s2, msg({ seq: undefined })), 'SEQ_INVALID', 'seq')
// seq 单调是这一节的靶心：重复与回退都必须被拒
checkThrows('seq 重复（= 已有的 2）', () => assertMessageAppend(s2, msg({ seq: 2 })), 'SEQ_NOT_MONOTONIC', '最大 seq 已经是 2')
checkThrows('seq 回退（= 已有的 1）', () => assertMessageAppend(s2, msg({ seq: 1 })), 'SEQ_NOT_MONOTONIC', '最大 seq 已经是 2')
checkThrows('kind 不在枚举里', () => assertMessageAppend(s2, msg({ kind: 'chat' })), 'KIND_INVALID', 'message.kind')
checkThrows('kind 缺失', () => assertMessageAppend(s2, msg({ kind: undefined })), 'KIND_INVALID', 'kind')
checkThrows('sender 缺失', () => assertMessageAppend(s2, msg({ sender: undefined })), 'SENDER_SHAPE', 'message.sender')
checkThrows('sender 两个分支都给了', () => assertMessageAppend(s2, msg({ sender: { sessionId: ALICE, user: true } })),
  'SENDER_AMBIGUOUS', 'user: true')
checkThrows('sender 两个分支都没有', () => assertMessageAppend(s2, msg({ sender: { user: false } })), 'SENDER_SHAPE', 'message.sender')
checkThrows('sender.sessionId 是空串', () => assertMessageAppend(s2, msg({ sender: { sessionId: '' } })), 'SENDER_SHAPE', 'sessionId')
checkThrows('sender 不是房间成员', () => assertMessageAppend(s2, msg({ sender: { sessionId: DAVE } })), 'SENDER_NOT_MEMBER', DAVE)
checkThrows('sender 是 enabled=false 的成员（关掉开关就不在房间里）',
  () => assertMessageAppend(s2, msg({ sender: { sessionId: CAROL } })), 'SENDER_NOT_MEMBER', CAROL)
// 给非成员登记义务：这一节另一个靶心
checkThrows('mentions 给非成员登记义务', () => assertMessageAppend(s2, msg({ mentions: [DAVE] })), 'MENTION_NOT_MEMBER', DAVE)
checkThrows('mentions 给关掉开关的成员登记义务', () => assertMessageAppend(s2, msg({ mentions: [CAROL] })),
  'MENTION_NOT_MEMBER', 'mentions')
checkThrows('mentions 不是数组', () => assertMessageAppend(s2, msg({ mentions: BOB })), 'MENTIONS_SHAPE', 'message.mentions')
checkThrows('mentions 里有非字符串', () => assertMessageAppend(s2, msg({ mentions: [7] })), 'MENTIONS_SHAPE', 'mentions[0]')
checkThrows('mentions 里有空串', () => assertMessageAppend(s2, msg({ mentions: [''] })), 'MENTIONS_SHAPE', 'mentions[0]')

console.log('')
console.log('3. assertJudgment')
const s3 = makeState()
check('合法回执通过', assertJudgment(s3, { roomId: 'room-a', seq: 1, sessionId: ALICE, verdict: 'catch-up', note: '' }) === true)
check('  另一个 verdict 也通过',
  assertJudgment(s3, { roomId: 'room-a', seq: 2, sessionId: BOB, verdict: 'need-info', note: 'x' }) === true)
checkThrows('judgment 不是对象', () => assertJudgment(s3, null), 'JUDGMENT_SHAPE')
checkThrows('roomId 指向不存在的房间',
  () => assertJudgment(s3, { roomId: 'room-z', seq: 1, sessionId: ALICE, verdict: 'unaffected' }), 'ROOM_NOT_FOUND', 'room-z')
checkThrows('seq 指向不存在的消息',
  () => assertJudgment(s3, { roomId: 'room-a', seq: 99, sessionId: ALICE, verdict: 'unaffected' }),
  'SEQ_NOT_FOUND', '没有对应的消息')
checkThrows('seq 不是正整数',
  () => assertJudgment(s3, { roomId: 'room-a', seq: 0, sessionId: ALICE, verdict: 'unaffected' }), 'SEQ_INVALID', 'judgment.seq')
checkThrows('seq 是字符串',
  () => assertJudgment(s3, { roomId: 'room-a', seq: '1', sessionId: ALICE, verdict: 'unaffected' }), 'SEQ_INVALID', 'seq')
checkThrows('verdict 不在枚举里',
  () => assertJudgment(s3, { roomId: 'room-a', seq: 1, sessionId: ALICE, verdict: 'later' }), 'VERDICT_INVALID', 'judgment.verdict')
checkThrows('verdict 缺失',
  () => assertJudgment(s3, { roomId: 'room-a', seq: 1, sessionId: ALICE }), 'VERDICT_INVALID', 'verdict')
checkThrows('表态的人不是成员',
  () => assertJudgment(s3, { roomId: 'room-a', seq: 1, sessionId: DAVE, verdict: 'unaffected' }), 'JUDGMENT_NOT_MEMBER', DAVE)
checkThrows('表态的人被关掉了开关',
  () => assertJudgment(s3, { roomId: 'room-a', seq: 1, sessionId: CAROL, verdict: 'unaffected' }), 'JUDGMENT_NOT_MEMBER', CAROL)
checkThrows('sessionId 缺失',
  () => assertJudgment(s3, { roomId: 'room-a', seq: 1, verdict: 'unaffected' }), 'JUDGMENT_SHAPE', 'sessionId')

console.log('')
console.log('4. assertTaskWrite')
const s4 = makeState()
s4.tasks = [task({ id: 't-1' }), task({ id: 't-2', deps: ['t-1'] })]
const s4other = makeState()
s4other.tasks = [task({ id: 't-b', roomId: 'room-b' })]
const s4two = makeState()
s4two.tasks = [task({ id: 't-a', deps: ['t-b'] }), task({ id: 't-b' })]
const s4three = makeState()
s4three.tasks = [task({ id: 't1', deps: ['t2'] }), task({ id: 't2', deps: ['t3'] })]
const s4dirty = makeState()
s4dirty.tasks = [task({ id: 't-a', deps: ['t-b'] }), task({ id: 't-b', deps: ['t-a'] })]
check('无依赖的新任务通过', assertTaskWrite(s4, task()) === true)
check('  owner = null 通过', assertTaskWrite(s4, task({ owner: null })) === true)
check('  owner 是 enabled=false 的成员也通过（归属不随开关失效）', assertTaskWrite(s4, task({ owner: CAROL })) === true)
check('  deps 指向同房间已有任务通过', assertTaskWrite(s4, task({ deps: ['t-1', 't-2'] })) === true)
check('  expectPaths 非空通过', assertTaskWrite(s4, task({ expectPaths: ['lib/rooms.js'] })) === true)
check('  菱形依赖（两个任务依赖同一个前置）不是环', assertTaskWrite(s4, task({ id: 't-3', deps: ['t-1', 't-2'] })) === true)
checkThrows('task 不是对象', () => assertTaskWrite(s4, null), 'TASK_SHAPE')
checkThrows('roomId 指向不存在的房间', () => assertTaskWrite(s4, task({ roomId: 'room-z' })), 'ROOM_NOT_FOUND', 'room-z')
checkThrows('roomId 缺失', () => assertTaskWrite(s4, task({ roomId: undefined })), 'ROOM_ID_INVALID', 'task.roomId')
checkThrows('id 是空串', () => assertTaskWrite(s4, task({ id: '' })), 'TASK_ID_INVALID', 'task.id')
checkThrows('id 缺失', () => assertTaskWrite(s4, task({ id: undefined })), 'TASK_ID_INVALID', 'task.id')
checkThrows('status 不在枚举里', () => assertTaskWrite(s4, task({ status: 'blocked' })), 'TASK_STATUS_INVALID', 'task.status')
checkThrows('status 缺失', () => assertTaskWrite(s4, task({ status: undefined })), 'TASK_STATUS_INVALID', 'status')
checkThrows('owner 字段缺失', () => assertTaskWrite(s4, task({ owner: undefined })), 'TASK_OWNER_SHAPE', 'task.owner')
checkThrows('owner 不是字符串', () => assertTaskWrite(s4, task({ owner: 7 })), 'TASK_OWNER_SHAPE', 'owner')
checkThrows('owner 不是这个房间的成员', () => assertTaskWrite(s4, task({ owner: DAVE })), 'TASK_OWNER_NOT_MEMBER', DAVE)
checkThrows('deps 缺失', () => assertTaskWrite(s4, task({ deps: undefined })), 'TASK_DEPS_SHAPE', 'task.deps')
checkThrows('deps 不是数组', () => assertTaskWrite(s4, task({ deps: 't-1' })), 'TASK_DEPS_SHAPE', 'deps')
checkThrows('deps 里有非字符串', () => assertTaskWrite(s4, task({ deps: [7] })), 'TASK_DEPS_SHAPE', 'deps[0]')
checkThrows('deps 指向不存在的任务', () => assertTaskWrite(s4, task({ deps: ['t-nope'] })), 'TASK_DEP_NOT_FOUND', 't-nope')
checkThrows('deps 不能跨房间借 id', () => assertTaskWrite(s4other, task({ roomId: 'room-a', deps: ['t-b'] })),
  'TASK_DEP_NOT_FOUND', 't-b')
// 环：这一节的靶心
checkThrows('自己依赖自己', () => assertTaskWrite(s4, task({ id: 't-new', deps: ['t-new'] })), 'TASK_CYCLE', '环')
checkThrows('两环：把 t-b 改成依赖 t-a', () => assertTaskWrite(s4two, task({ id: 't-b', deps: ['t-a'] })),
  'TASK_CYCLE', 't-a → t-b → t-a')
checkThrows('三环：t1 → t2 → t3 → t1', () => assertTaskWrite(s4three, task({ id: 't3', deps: ['t1'] })),
  'TASK_CYCLE', 't1 → t2 → t3 → t1')
checkThrows('整图里已有的环也拦住（不是只查「我参与的那个环」）',
  () => assertTaskWrite(s4dirty, task({ id: 't-free', deps: [] })), 'TASK_CYCLE')
checkThrows('expectPaths 缺失', () => assertTaskWrite(s4, task({ expectPaths: undefined })),
  'TASK_EXPECT_PATHS_SHAPE', 'task.expectPaths')
checkThrows('expectPaths 不是数组', () => assertTaskWrite(s4, task({ expectPaths: 'lib/x.js' })), 'TASK_EXPECT_PATHS_SHAPE', 'expectPaths')
checkThrows('expectPaths 里有非字符串', () => assertTaskWrite(s4, task({ expectPaths: [7] })), 'TASK_EXPECT_PATHS_SHAPE', 'expectPaths[0]')
checkThrows('expectPaths 里有空串', () => assertTaskWrite(s4, task({ expectPaths: [''] })), 'TASK_EXPECT_PATHS_SHAPE', 'expectPaths[0]')
check('  expectPaths 显式 [] 通过', assertTaskWrite(s4, task({ expectPaths: [] })) === true)

console.log('')
console.log('5. 纯函数纪律：同步、不碰 IO、不改传入对象')
// 冻结（副本模块是严格模式）：只要实现里哪怕写一个字节，这里就会抛 TypeError。
const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}
const s5 = makeState()
// 备一个任务行，好让「候选任务不被改」这条能带上真的 deps（而不是空数组那种看不出动静的情况）
s5.tasks = [task({ id: 't-1' })]
const snapshot = JSON.stringify(s5)
check('冻结的 state + 冻结的消息通过（一个字节都没写）', assertMessageAppend(deepFreeze(s5), deepFreeze(msg())) === true)
check('  冻结的 state + 冻结的回执通过',
  assertJudgment(deepFreeze(s5), deepFreeze({ roomId: 'room-a', seq: 1, sessionId: ALICE, verdict: 'unaffected', note: '' })) === true)
check('  冻结的 state + 冻结的任务通过', assertTaskWrite(deepFreeze(s5), deepFreeze(task())) === true)
check('state 的内容一个字节没变', JSON.stringify(s5) === snapshot)
const candidate = msg({ mentions: [BOB] })
const candidateBefore = JSON.stringify(candidate)
assertMessageAppend(s5, candidate)
check('候选对象没被改（不补默认值、不夹取）', JSON.stringify(candidate) === candidateBefore)
const candidateTask = task({ deps: ['t-1'] })
const taskBefore = JSON.stringify(candidateTask)
assertTaskWrite(s5, candidateTask)
check('候选任务没被改', JSON.stringify(candidateTask) === taskBefore)
check('同步返回 true（不是 Promise）', assertMessageAppend(s5, msg()) === true)

console.log('')
console.log('6. assertStateShape（加载期体检）')
const healthy = makeState()
healthy.judgments = [{ roomId: 'room-a', seq: 1, sessionId: ALICE, verdict: 'catch-up', note: '' }]
healthy.tasks = [task({ id: 't-1' })]
healthy.deliveries = [{ roomId: 'room-a', sessionId: BOB, seq: 1, at: 1, deliveredAt: null, attempts: 0 }]
check('一份健康 state 通过', assertStateShape(healthy) === true)
// 这条是写给「体检误伤」的：同一房间的两条消息只有一个能「比谁都大」，
// 体检若照搬写入侧那条规则，任何有两段以上对话的房间都会红。
check('  同房间多条不同 seq 的消息不被误伤', assertStateShape(makeState()) === true)
checkThrows('state 不是对象', () => assertStateShape(null), 'STATE_SHAPE')

const badRooms = makeState()
badRooms.rooms = {}
const eRooms = grab(() => assertStateShape(badRooms))
check('rooms 类型不对被点出来', eRooms !== null && String(eRooms.message).includes('state.rooms 必须是数组'),
  eRooms === null ? null : eRooms.message)

const badSeq = makeState()
badSeq.messages = badSeq.messages.concat([
  { seq: 2, roomId: 'room-a', sender: { user: true }, kind: 'free', body: '重复 seq', refs: [], terminal: false, ts: 3 },
])
const eSeq = grab(() => assertStateShape(badSeq))
check('重复 seq 在体检里被点出',
  eSeq !== null && eSeq.problems.some((p) => p.code === 'INVARIANT_SEQ_NOT_MONOTONIC'), eSeq === null ? null : eSeq.problems)

const badCycle = makeState()
badCycle.tasks = [task({ id: 't-a', deps: ['t-b'] }), task({ id: 't-b', deps: ['t-a'] })]
const eCycle = grab(() => assertStateShape(badCycle))
check('环依赖在体检里被点出',
  eCycle !== null && eCycle.problems.some((p) => p.code === 'INVARIANT_TASK_CYCLE'), eCycle === null ? null : eCycle.problems)

const badMany = makeState()
badMany.members.push(Object.assign(member(DAVE, true), { roomId: 'room-z' }))
badMany.deliveries.push({ roomId: 'room-a', sessionId: BOB, seq: 99, at: 1, deliveredAt: null, attempts: 0 })
badMany.cursors[0].lastSeq = -1
const eMany = grab(() => assertStateShape(badMany))
check('一次收齐多个问题（不是抛第一个）', eMany !== null && eMany.problems.length >= 3, eMany === null ? null : eMany.problems.length)
check('  每条问题带自己的 code（调用方能按条分流）',
  eMany !== null && eMany.problems.every((p) => typeof p.code === 'string' && p.code.startsWith('INVARIANT_')),
  eMany === null ? null : eMany.problems)
check('  投递账指向不存在的消息被点出',
  eMany !== null && eMany.problems.some((p) => p.code === 'INVARIANT_SEQ_NOT_FOUND'), eMany === null ? null : eMany.problems)

console.log('')
console.log('RESULT  ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
