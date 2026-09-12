/**
 * 面板纯函数的测试（headless）。
 *
 * 为什么：我已经因为"看不见浏览器"漏过两个 UI bug（闪烁、纯文本消息）。
 * 渲染成什么样测不了，但**决定渲染什么的那几个纯函数能测** —— 而 bug 恰恰出在那里：
 * 「半份数据渲染」是 refresh 的编排错，而"哪些算需要打扰人的事"是 collectProblems 的判断错。
 *
 * 做法同 tests/markdown.mjs：从 lib/client.js 源码里**抽出真实实现**（按函数名 + 括号配对），
 * 不复制逻辑。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = await fs.readFile(path.join(here, '..', 'lib', 'client.js'), 'utf8')

/** 按函数名抽出实现（括号配对；面板里的函数体内没有含花括号的字符串）。 */
function extractFunction(source, name) {
  const marker = 'function ' + name + '('
  const start = source.indexOf(marker)
  if (start < 0) return null
  let i = source.indexOf('{', start)
  let depth = 0
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  return null
}

const NAMES = [
  'tint', 'verdictChip', 'shortOf', 'ago', 'attentionOf', 'signatureOf', 'collectProblems',
  // 群聊式渲染的身份层：归组键、色相、头像字、显示名、时刻
  'senderKey', 'hueOf', 'initialsOf', 'displayNameOf', 'clockOf',
  // 渲染闸门：指纹挂在节点上（2026-09-12 空白面板事故）
  'shouldRepaint',
  // 重建闸门：拖动与输入法组字期间不许换 DOM 节点（2026-09-12 输入法反馈）
  'renderBlocked',
  // 邀请选择器的工作区筛选与排序（2026-09-12 反馈）
  'workspaceBuckets', 'filterCandidates', 'sortCandidates',
]
const missing = NAMES.filter((n) => extractFunction(src, n) === null)
if (missing.length > 0) {
  console.log('FAIL  从 client.js 抽不到这些函数（改名了？）：' + missing.join(', '))
  process.exit(1)
}

const T = {
  text: 'TEXT', text2: 'TEXT2', text3: 'TEXT3', caption: 'CAP', bg: 'BG', hover: 'HOVER',
  border: 'BORDER', borderSoft: 'BORDERSOFT', code: 'CODE', ok: 'OK', bad: 'BAD', warn: 'WARN', biz: 'BIZ',
}
const api = new Function(
  'var currentRoom = "room-a";\nvar T = ' + JSON.stringify(T) + ';\n'
  + NAMES.map((n) => extractFunction(src, n)).join('\n\n')
  + '\nreturn { ' + NAMES.join(', ') + ' }'
)()

let pass = 0
let fail = 0
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra))) }
}

console.log('1. shortOf —— 身份短号，与宿主侧同一套规则')
check('去前缀取前 8 位', api.shortOf('session-aaaabbbb-1111') === 'aaaabbbb', api.shortOf('session-aaaabbbb-1111'))
check('无前缀也取 8 位', api.shortOf('1b68df32-x') === '1b68df32', api.shortOf('1b68df32-x'))
check('undefined 不炸', api.shortOf(undefined) === '')

console.log('2. ago —— 相对时间')
const now = Date.now()
check('刚刚', api.ago(now - 1000) === '刚刚', api.ago(now - 1000))
check('分钟', api.ago(now - 5 * 60000) === '5 分钟前', api.ago(now - 5 * 60000))
check('小时', api.ago(now - 3 * 3600000) === '3 小时前', api.ago(now - 3 * 3600000))
check('非数字返回空', api.ago(undefined) === '')

console.log('3. attentionOf —— 「有没有事」的汇总（顶部状态行与标签角标共用这一个算法）')
const madeRoom = {
  room: { id: 'room-a', name: '甲' },
  targetSeq: 7,
  members: [
    { shortId: 'aaaaaaaa', inRoom: true, overdue: true },
    { shortId: 'bbbbbbbb', inRoom: true, overdue: false },
    { shortId: 'cccccccc', inRoom: false, overdue: false },
  ],
  pending: ['aaaaaaaa', 'bbbbbbbb'],
  changes: [{ seq: 3, verdict: 'verified' }, { seq: 4, verdict: 'contradicted' }],
}
const a = api.attentionOf(madeRoom)
check('与事实不符计数', a.bad === 1, a.bad)
check('逾时计数', a.overdue === 1, a.overdue)
check('待表态计数', a.pending === 2, a.pending)
check('不在房间计数', a.attentionOnly === 1, a.attentionOnly)
// 逾时的人本来就在 pending 里，角标不能把他算两次
check('角标总数不重复计逾时', a.total === 3, a.total)
const clean = api.attentionOf({ room: { id: 'r' }, members: [{ inRoom: true }], pending: [], changes: [] })
check('一切正常时 total=0', clean.total === 0, clean)
check('null 房间不炸', api.attentionOf(null).total === 0)

console.log('4. signatureOf —— 渲染闸门（写错它就会每 2 秒重建 DOM，把用户打的字冲掉）')
const base = {
  rooms: [{ room: { id: 'room-a' }, lastSeq: 1, messages: [{ seq: 1 }], changes: [], members: [{ shortId: 'aaaaaaaa', inRoom: true, owed: false, overdue: false, verdict: null }] }],
  candidates: [{ shortId: 'dddddddd', live: true, status: 'idle' }],
}
const sig1 = api.signatureOf(base)
check('同样输入 → 同样指纹', sig1 === api.signatureOf(JSON.parse(JSON.stringify(base))))
const more = JSON.parse(JSON.stringify(base))
more.rooms[0].messages.push({ seq: 2 })
more.rooms[0].lastSeq = 2
check('多一条消息 → 指纹变', api.signatureOf(more) !== sig1)
const judged = JSON.parse(JSON.stringify(base))
judged.rooms[0].members[0].verdict = 'catch-up'
check('有人表态 → 指纹变', api.signatureOf(judged) !== sig1)
const overdue = JSON.parse(JSON.stringify(base))
overdue.rooms[0].members[0].overdue = true
check('有人逾时 → 指纹变', api.signatureOf(overdue) !== sig1)
const offline = JSON.parse(JSON.stringify(base))
offline.rooms[0].members[0].inRoom = false
check('有人离开房间 → 指纹变', api.signatureOf(offline) !== sig1)
const cand = JSON.parse(JSON.stringify(base))
cand.candidates[0].status = 'running'
check('候选会话状态变 → 指纹变', api.signatureOf(cand) !== sig1)
check('null 不炸', api.signatureOf(null) === '')

console.log('5. collectProblems —— 什么值得打扰人（弹窗的判据）')
const problems = api.collectProblems([
  {
    room: { id: 'room-a', name: '甲' },
    targetSeq: 9,
    changes: [{ seq: 3, verdict: 'verified' }, { seq: 4, verdict: 'contradicted', files: ['app.py'] }],
    members: [{ shortId: 'aaaaaaaa', overdue: true, title: '会话甲' }, { shortId: 'bbbbbbbb', overdue: false }],
    messages: [
      { seq: 10, body: 'need-info: 我需要更多信息' },
      { seq: 11, body: '请 @用户 确认一下方向' },
    ],
  },
])
const kinds = problems.map((p) => p.kind).sort().join(',')
check('三类都抓到了', kinds === 'at,bad,overdue', kinds)
check('与事实不符带上文件名', problems.filter((p) => p.kind === 'bad')[0].text.includes('app.py'),
  problems.filter((p) => p.kind === 'bad')[0].text)
check('逾时带上会话标题', problems.filter((p) => p.kind === 'overdue')[0].text.includes('会话甲'))
check('@ 的键含 seq（同一条只弹一次）', problems.filter((p) => p.kind === 'at')[0].key === 'room-a|at|11')
const clean2 = api.collectProblems([
  { room: { id: 'r', name: '乙' }, targetSeq: 1, changes: [{ seq: 1, verdict: 'verified' }], members: [{ shortId: 'x', overdue: false }], messages: [{ seq: 1, body: 'unaffected: 我没动' }] },
])
check('正常表态不打扰', clean2.length === 0, clean2)
check('空输入不炸', api.collectProblems([]).length === 0)
check('undefined 不炸', api.collectProblems(undefined).length === 0)

console.log('6. 群聊身份层 —— 归组、配色、名字')
const mA = { sender: { sessionId: 'session-aaaabbbb-1111', roleName: '实现者' } }
const mB = { sender: { sessionId: 'session-ccccdddd-2222' } }
const mUser = { sender: { user: true } }
check('归组键：用户是 user', api.senderKey(mUser) === 'user', api.senderKey(mUser))
check('归组键：按会话 id', api.senderKey(mA) === 'session-aaaabbbb-1111', api.senderKey(mA))
check('缺 sender 不炸', api.senderKey({}) === 'unknown', api.senderKey({}))
const h1 = api.hueOf('session-aaaabbbb-1111')
check('色相稳定（同 id 同色 —— 否则头像每轮闪）', h1 === api.hueOf('session-aaaabbbb-1111'), h1)
check('色相在 0..359', h1 >= 0 && h1 < 360, h1)
check('不同 id 不同色', h1 !== api.hueOf('session-ccccdddd-2222'))
check('头像字：角色名首字优先', api.initialsOf(mA) === '实', api.initialsOf(mA))
check('头像字：用户是「你」', api.initialsOf(mUser) === '你', api.initialsOf(mUser))
check('头像字：无角色名用短号前两位', api.initialsOf(mB) === 'ccccdddd'.slice(0, 2), api.initialsOf(mB))
const room = { members: [{ sessionId: 'session-ccccdddd-2222', title: '前端重构' }] }
check('显示名：用户 = 你', api.displayNameOf(mUser, room) === '你', api.displayNameOf(mUser, room))
check('显示名：角色名优先于标题', api.displayNameOf(mA, room) === '实现者', api.displayNameOf(mA, room))
check('显示名：回退到会话标题', api.displayNameOf(mB, room) === '前端重构', api.displayNameOf(mB, room))
check('显示名：再回退到短号', api.displayNameOf({ sender: { sessionId: 'session-eeeeffff-9' } }, room) === 'eeeeffff')
check('时刻补零', api.clockOf(new Date(2026, 0, 2, 9, 5).getTime()) === '09:05',
  api.clockOf(new Date(2026, 0, 2, 9, 5).getTime()))
check('时刻非数字返回空', api.clockOf(undefined) === '')

console.log('7. shouldRepaint —— 指纹闸门（2026-09-12「关掉再打开永远空白」的守卫）')
check('刚新建的空壳必画（它没有指纹）', api.shouldRepaint({}, 'sig-1') === true)
check('同一节点 + 同指纹 → 不画（省掉每 2 秒的重建）', api.shouldRepaint({ _signature: 'sig-1' }, 'sig-1') === false)
check('同一节点 + 指纹变了 → 画', api.shouldRepaint({ _signature: 'sig-1' }, 'sig-2') === true)
check('被主动作废（_signature=""）→ 必画', api.shouldRepaint({ _signature: '' }, 'sig-1') === true)
check('面板不在（节点为 null）→ 不画', api.shouldRepaint(null, 'sig-1') === false)
check('undefined 不炸', api.shouldRepaint(undefined, 'sig-1') === false)

console.log('8. renderBlocked —— 重建 DOM 的闸门（拖动 / 输入法组字）')
check('都不在 → 可以重建', api.renderBlocked(false, false) === false)
check('拖动中 → 不重建（换了节点，拖动当场断）', api.renderBlocked(true, false) === true)
check('组字中 → 不重建（换了节点，候选窗和半个字一起没）', api.renderBlocked(false, true) === true)
check('两个都在 → 不重建', api.renderBlocked(true, true) === true)
check('缺参不炸（undefined 视为不在）', api.renderBlocked(undefined, undefined) === false)

console.log('9. workspaceBuckets / filterCandidates —— 邀请选择器的工作区筛选')
const cands = [
  { sessionId: 's1', shortId: 'a1', title: '甲会话', cwd: 'D:\\proj\\app', workspace: 'app' },
  { sessionId: 's2', shortId: 'b2', title: '乙会话', cwd: 'D:\\proj\\app', workspace: 'app' },
  { sessionId: 's3', shortId: 'c3', title: '丙会话', cwd: 'C:\\other\\lib', workspace: 'lib' },
  { sessionId: 's4', shortId: 'd4', title: '无工作区', cwd: '', workspace: '' },
]
const buckets = api.workspaceBuckets(cands)
check('工作区分组：3 组（含未知）', buckets.length === 3, buckets.map((b) => b.cwd))
check('按会话数降序', buckets[0].cwd === 'D:\\proj\\app' && buckets[0].count === 2, buckets[0])
check('空 cwd 显示为「(未知工作区)」', buckets.filter((b) => b.cwd === '')[0].label === '(未知工作区)')
check('同名不同路径不会被合并（键是完整 cwd）',
  api.workspaceBuckets([
    { cwd: 'D:\\a\\app', workspace: 'app' }, { cwd: 'D:\\b\\app', workspace: 'app' },
  ]).length === 2)
check('空输入不炸', api.workspaceBuckets(undefined).length === 0)
check('不筛选 → 全给', api.filterCandidates(cands, '', '').length === 4)
check('按工作区筛（完整 cwd 精确匹配）', api.filterCandidates(cands, '', 'D:\\proj\\app').length === 2)
check('工作区 + 关键词是 AND', api.filterCandidates(cands, '乙', 'D:\\proj\\app').length === 1)
check('关键词命中短号', api.filterCandidates(cands, 'c3', '').length === 1)
check('关键词命中工作区名', api.filterCandidates(cands, 'lib', '').length === 1)
check('关键词大小写不敏感', api.filterCandidates(cands, '丙', 'C:\\other\\lib').length === 1)
check('空输入不炸', api.filterCandidates(undefined, undefined, undefined).length === 0)

console.log('10. sortCandidates —— 邀请选择器的排序（默认「最近活动」）')
const sortRows = [
  { sessionId: 'a', title: 'Beta', createdAt: 300, lastActivityAt: 100 },
  { sessionId: 'b', title: 'Alpha', createdAt: 100, lastActivityAt: 300 },
  { sessionId: 'c', title: 'Gamma', createdAt: 200 }, // 没有 lastActivityAt → 退回 createdAt
]
const ids = (list) => list.map((r) => r.sessionId).join('')
check('默认：最近活动降序', ids(api.sortCandidates(sortRows, 'activity-desc')) === 'bca', ids(api.sortCandidates(sortRows, 'activity-desc')))
check('最近活动升序（最久没动在前）', ids(api.sortCandidates(sortRows, 'activity-asc')) === 'acb', ids(api.sortCandidates(sortRows, 'activity-asc')))
check('创建时间降序', ids(api.sortCandidates(sortRows, 'created-desc')) === 'acb', ids(api.sortCandidates(sortRows, 'created-desc')))
check('标题 A→Z', ids(api.sortCandidates(sortRows, 'title-asc')) === 'bac', ids(api.sortCandidates(sortRows, 'title-asc')))
check('缺 lastActivityAt 的条目按 createdAt 参与排序（c 落在中位）',
  ids(api.sortCandidates(sortRows, 'activity-desc')) === 'bca')
check('未知排序键退回默认（不炸）', ids(api.sortCandidates(sortRows, 'nope')) === 'bca')
check('不改动传入的数组', sortRows.map((r) => r.sessionId).join('') === 'abc')
check('空输入不炸', api.sortCandidates(undefined, 'activity-desc').length === 0)

console.log('')
console.log('RESULT  ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
