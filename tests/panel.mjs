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
  // 用户侧未读与滚动锚（2026-09-14 反馈：发消息时滚动条复位）
  'unreadOf', 'scrollAnchorOf', 'applyScrollAnchor',
  // 「欠的是哪一条」（2026-09-14 真机 #1348：靶子只报最新那条，义务却会积压）
  'owedLabel', 'pendingRows',
  // 停摆窗口（2026-09-16：计数与时长必须同一个窗口）
  'recentJank',
  // 方向 / 机器读的边界两行（2026-09-16：方向被静默截断到 200 字之后，两者第一次有了可见差别）
  'directionLineOf',
  // 拉取的分布（2026-09-16 方案 a：最大值读不出"尖峰还是常态"）
  'recentStats',
  // 任务板 + 投递台账（宿主新加的两张表：字段缺失 / 不是数组 / 元素缺字段都要容错）
  'taskStatusLabel', 'taskRowsOf', 'taskLineOf', 'pendingDeliveryLabel',
  // 「这个面板自己花了多少」的一行读数（宿主载荷的 ms.build + 本机停摆探针的**同一窗口**计数）
  'fmtMs', 'numOrNull', 'usageLineOf',
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

console.log('11. 用户侧未读 + 滚动锚 —— 「发消息时滚动条复位」的回归（真机反馈 2026-09-14）')
const msgs = [{ seq: 5 }, { seq: 6 }, { seq: 7 }, { seq: 8 }]
check('游标 5 → 未读 6/7/8', api.unreadOf(msgs, 5).map((m) => m.seq).join() === '6,7,8',
  api.unreadOf(msgs, 5).map((m) => m.seq))
check('游标停在最新 → 没有未读', api.unreadOf(msgs, 8).length === 0)
check('没有游标 → 全算未读', api.unreadOf(msgs, 0).length === 4)
check('空/坏输入不炸', api.unreadOf(undefined, undefined).length === 0 && api.unreadOf([{}, null], 0).length === 0)

check('贴着底部 → 跟随最新（stick）',
  api.scrollAnchorOf({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 }).stick === true)
check('翻上去看历史 → 不 stick，且记下原位置',
  api.scrollAnchorOf({ scrollTop: 100, scrollHeight: 3000, clientHeight: 400 }).stick === false &&
  api.scrollAnchorOf({ scrollTop: 100, scrollHeight: 3000, clientHeight: 400 }).top === 100)
check('差 20px 仍算底部（容差内不跟人较劲）',
  api.scrollAnchorOf({ scrollTop: 880, scrollHeight: 1000, clientHeight: 100 }).stick === true)
check('没有节点时不炸（stick 兜底）', api.scrollAnchorOf(null).stick === true)

const node = { scrollTop: 0, scrollHeight: 5000, clientHeight: 400 }
api.applyScrollAnchor(node, { top: 123, stick: false })
check('恢复：不 stick 就用记下的位置', node.scrollTop === 123, node.scrollTop)
api.applyScrollAnchor(node, { top: 123, stick: true })
check('恢复：stick 就直接到底', node.scrollTop === 5000, node.scrollTop)
check('空节点不炸', (api.applyScrollAnchor(null, { top: 1, stick: true }), true))

// **这两条才是回归钉**：挂树前赋值一律被夹成 0 —— 那就是"复位"本身。
const swapSrc = extractFunction(src, 'swap')
check('swap：先量锚点，再 replaceWith，最后恢复',
  swapSrc !== null &&
  swapSrc.indexOf('scrollAnchorOf(old._content || old)') < swapSrc.indexOf('old.replaceWith(panel)') &&
  swapSrc.indexOf('applyScrollAnchor(panel._content || panel, anchor)') > swapSrc.indexOf('old.replaceWith(panel)'),
  swapSrc)
check('  旧写法（把旧节点的 scrollTop 直接赋给新节点）不许回来',
  !/panel\.scrollTop\s*=\s*old\.scrollTop/.test(src))
check('  挂树之后要跑渲染期接线（未读游标能量出高度才敢推进）',
  swapSrc !== null && swapSrc.indexOf('panel._afterMount()') > swapSrc.indexOf('old.replaceWith(panel)'))

const buildSrc = extractFunction(src, 'buildRoom')
check('buildRoom：接线登记成回调（挂在**壳**上，不是内容区），而不是当场执行',
  buildSrc !== null && buildSrc.indexOf('shell._afterMount = function') > 0 &&
  buildSrc.indexOf("content.addEventListener('scroll', update)") > 0)
check('  未读计数用**全部消息**（不是那 40 条切片）',
  buildSrc !== null && buildSrc.includes('unreadOf(room.messages, readSeq)'))
check('  「跳到最新」按钮在场且用 sticky 钉底',
  buildSrc !== null && buildSrc.includes('position:sticky') && buildSrc.includes('跳到最新'))
check('  未读分界文案在场', buildSrc !== null && buildSrc.includes('条未读'))
// 真机反馈 2026-09-16：**抽屉**是第二个滚动容器（成员 12 人时要滚很久），
// 旧实现只带内容区那一个 ⇒ 滚到中间看成员，下一次 4 秒轮询就跳回顶部。
check('swap：抽屉的滚动位置也要带过去（两个独立滚动容器，各存各的）',
  swapSrc !== null && swapSrc.includes('var drawerTop = old._drawer')
  && swapSrc.indexOf('panel._drawer.scrollTop = drawerTop') > swapSrc.indexOf('old.replaceWith(panel)'),
  swapSrc)
const viewSrc = extractFunction(src, 'makeRoomView')
check('副页（React 座位）重建也保住滚动位置',
  viewSrc !== null && viewSrc.includes('applyScrollAnchor(host, anchor)'))

console.log('12. 侧面抽屉 + 头部固定（真机反馈 2026-09-14：信息和聊天混在一起、滚下去抓不住窗口）')
check('面板壳不再自己滚（flex 列：头部固定、内容区自己滚）',
  src.includes('resize:both;overflow:hidden;display:flex;flex-direction:column;'))
check('  头部是壳的固定子节点（不是滚动内容的一部分）',
  src.includes("var head = el('div', S.head)") && src.includes('panel.appendChild(head)'))
check('  内容区单独登记成滚动容器', src.includes('panel._content = body'))
check('  抽屉登记成壳的子节点', src.includes('panel._drawer = drawer'))
check('  抽屉默认收起', src.includes('applyDrawer(panel, false)'))
check('  抽屉开合只改 transform/visibility（不重渲染）',
  src.includes("drawer.style.transform = isOpen ? 'translateX(0)'") && src.includes('drawer.style.visibility ='))
check('  抽屉状态跟着节点过重渲染（否则每 2 秒被弹回去）',
  src.includes('panel._drawerOpen = old._drawerOpen === true'))
check('buildRoom：成员/邀请路由进抽屉，聊天流进内容区',
  buildSrc !== null && buildSrc.includes('if (drawer !== null) panel = drawer') &&
  buildSrc.includes('panel = content') && buildSrc.includes('var content = panel._content || panel'))
check('  副页（没有抽屉）全部照旧落在 host 上',
  buildSrc !== null && buildSrc.includes('var drawer = panel._drawer || null'))

console.log('13. 「按钮按不了」的两个真根因（真机反馈 2026-09-14）')
// 根因一：加入失败被静默吞掉 —— store.join 满员时会抛，而处理器不看 ok
check('加入会话：失败要弹出来，不许静默',
  buildSrc !== null && buildSrc.includes("reportFailure('加入会话', res)"))
check('  移出/重新启用成员同理', buildSrc !== null && buildSrc.includes('reportFailure(m.inRoom ?'))
check('  新建房间同理', src.includes("reportFailure('新建房间', res)"))
check('  人的发言失败**不清空草稿**（那句话还在人手里）',
  buildSrc !== null && buildSrc.includes("reportFailure('发送', res)"))
const reportSrc = extractFunction(src, 'reportFailure')
check('reportFailure 把服务端的 message 带出来',
  reportSrc !== null && reportSrc.includes('res.error.message'))
// 根因二：卡住的 composing 会把所有重画挡掉
check('composing 自愈：组字元素离开文档即解除冻结',
  src.includes('!document.contains(composingEl)'))
check('  记录组字中的元素', src.includes('composingEl = e.target || null'))
check('  compositionend 清掉它', src.includes('composingEl = null'))

console.log('14. 轮询收敛（真机反馈 2026-09-14：会话内发消息要等近 10 秒 —— 自己的footprint先收干净）')
const refreshSrc = extractFunction(src, 'refresh')
check('面板：页面在后台就不轮询', refreshSrc !== null && refreshSrc.includes('if (document.hidden === true) return'))
check('  自愈那一行在后台判断**之前**（冻结不能因为切后台就永远修不回来）',
  refreshSrc !== null &&
  refreshSrc.indexOf('!document.contains(composingEl)') < refreshSrc.indexOf('if (document.hidden === true) return'))
check('候选不再每 2 秒拉：抽屉开着 / 邀请展开 / 还没有过一份 才拉',
  refreshSrc !== null && refreshSrc.includes('var wantsCandidates = lastCandidates === null') &&
  refreshSrc.includes('pick.open === true') && refreshSrc.includes('liveNode._drawerOpen === true'))
check('  不需要候选时直接返回（不发出那次请求）',
  refreshSrc !== null && refreshSrc.includes('if (!wantsCandidates) return'))
check('入口角标轮询也跳过后台', src.includes("// 后台标签页不拉（角标只是个数，回来时补一次就够）"))
check('  副页轮询同样', src.includes('if (document.hidden === true) return // 后台标签页不拉'))
check('回到前台补一次', src.includes("document.addEventListener('visibilitychange', function () {") &&
  src.includes('if (document.hidden !== true) reload()'))
check('打开抽屉时把候选拉新（那里正是「邀请加入」的家）',
  src.includes('if (panel._drawerOpen === true) reload()'))

console.log('15. 房间策略就地可改（真机反馈 2026-09-14：撞到 room is full 才发现有个上限）')
check('抽屉里有策略块', buildSrc !== null && buildSrc.includes("'房间策略'"))
check('  两个数字字段（成员上限 / 线程预算）', buildSrc !== null &&
  buildSrc.includes("numField('成员上限'") && buildSrc.includes("numField('线程预算'"))
check('  保存走 set-policy，失败要把服务端原话带出来', buildSrc !== null &&
  buildSrc.includes("rpc('set-policy'") && buildSrc.includes("reportFailure('改房间策略', res)"))
check('  输入框带 data-draft（重渲染不冲掉正在输的值）',
  buildSrc !== null && buildSrc.includes("input.setAttribute('data-draft', label)"))
check('状态行把人数与上限一起说',
  buildSrc !== null && buildSrc.includes("+ '/' + room.room.policy.maxMembers + ' 名成员'"))

console.log('16. 主线程停摆探针（真机 2026-09-14：界面侧间歇卡顿，而服务端 4-49ms、整机 12-36% 都健康）')
check('探针记录停摆时长与时刻', src.includes('jankLog.push({ at: now, ms: drift') && src.includes("clientLog('主线程停摆 '"))
check('  只报 ≥600ms 的停摆（普通抖动不算）', src.includes('if (drift >= 600)'))
check('  窗口由 recentJank 现算（不是靠"计数何时清零"）',
  src.includes('function recentJank(log, at)') && src.includes('var cut = now - 5 * 60 * 1000'))
check('  停摆进了自诊断那条（带**窗口内**次数与归因）',
  src.includes("diagBits.push('停摆 ' + (jank.ms / 1000).toFixed(1) + 's×' + jank.count + '/5分'") &&
  src.includes("jank.mine === true ? '(重建中)' : '(非我)'"))
check('探针：只在**前台可见**时计停摆（webview 被挂起/节流也会拖后定时器，那是假象）',
  src.includes('if (document.hidden === true) return') && src.includes('jankTotal++'))
check('  归因：停摆时我是不是正在重建面板', src.includes('mine: renderInFlight === true'))
check('  重绘期间立旗（含早退路径都要放下）',
  src.includes('renderInFlight = true') && src.includes('renderInFlight = false'))
check('面板轮询放到 4 秒（原来 2 秒）', src.includes('window.setInterval(refresh, 4000)'))
check('  启动一次（apply 里，且有重入保护）',
  src.includes('if (jankProbeOn) return') && src.includes('startJankProbe()'))
check('  由 createPanel 读它（面板一开就能看到）',
  src.includes('var jank = recentJank(jankLog)'))
// 2026-09-16 修：旧写法把**自页面加载以来累计**的次数，和**受 5 分钟窗口约束**的时长
// 摆在同一个"×N"里显示（clientLog 里甚至直接写着"最近 5 分钟第 N 次"）。
// 我自己读用户发的截图时就被它带偏过一次 —— 诊断数字口径不一致比没有诊断更糟。
check('计数与时长必须同窗口（旧写法混了两个窗口）',
  !src.includes('jankCount') && !src.includes('jankWorstMs') && !src.includes('recentJankMs'))
check('  并且带上"最近一次是什么时候"（回答"还在发生吗"）', src.includes("+ ' · ' + ago(jank.at)"))
check('  累计值降级到悬停提示（"新问题还是老问题"是另一个问题）',
  src.includes("'自本页加载以来共 ' + jankTotal") && src.includes('diagWrap.title = ['))

console.log('17. 打字让路（真机 2026-09-14 用户自测：关掉聊天室窗口后延迟消失）')
check('识别"用户正对着输入框"', src.includes('function userIsTyping()') &&
  src.includes("tag === 'textarea' || tag === 'input'") && src.includes('el.isContentEditable === true'))
check('  刷新时让路（打在重绘闸门之前）',
  refreshSrc !== null && refreshSrc.includes('if (force !== true && userIsTyping()) return'))
check('  让路判断在后台判断之后、组字判断之前',
  refreshSrc !== null &&
  refreshSrc.indexOf('if (document.hidden === true) return') < refreshSrc.indexOf('if (force !== true && userIsTyping()) return') &&
  refreshSrc.indexOf('if (force !== true && userIsTyping()) return') < refreshSrc.indexOf('renderBlocked(dragging, composing)'))
// 真机 2026-09-16：刷新页面后光标还在 composer 里，此时打开面板 ⇒ 每次轮询都提前返回 ⇒ 面板**永远空白**
// （我盯了 80 秒一帧都没有），而且没有 RPC ⇒ 诊断也被饿死（头部连"拉取"都不显示）。
check('  但打开面板的第一帧不受让路约束（空面板比一次重绘更打扰人）',
  src.includes('refresh(true) // 第一帧不受') && src.includes('function refresh(force)'))
check('失焦不再触发重画（那次实现可能自激：重绘换节点 → focusout → 重绘…）',
  !src.includes("document.addEventListener('focusout', function () {"))
check('重绘节流：400ms 内不重复重建（切断任何"重绘触发重绘"的环）',
  src.includes('lastRenderAt !== 0 && diagT0 - lastRenderAt < 400'))
check('重绘频率计数器（一分钟窗口）',
  src.includes('function renderRate()') && src.includes('renderTimes.push(now)'))
check('  头部只在 >20 次/分 时显示（正常是每分钟十几次）',
  src.includes("if (rate > 20) diagBits.push('重绘 ' + rate + '次/分')"))

console.log('18. 自诊断三计数器（间歇症状不能靠单次 A/B 定性）')
check('三个数各有取样与读取', src.includes('function noteDiag(') && src.includes('function recentMax(') &&
  src.includes("noteDiag('repaint'") && src.includes("noteDiag('rpc'"))
check('  重绘：render() 自己计时（含早退路径也不至于记脏数）', src.includes('var diagT0 = performance.now()'))
check('  rpc：量 state 的客户端往返', src.includes('var diagRpcT0 = performance.now()'))
check('  只认最近 5 分钟', src.includes('Date.now() - 5 * 60 * 1000'))
// 真机反馈（2026-09-16，用户）：改成分位之后"没看到那个字段" —— 因为正常时一个字都不显示，
// 人就没法自己判断。所以正常时给一行**暗色**中位数（样本 ≥8 才给，避免面板刚打开就报一个没意义的数）。
check('  正常时也给一行暗色读数（拉取中位·样本数）',
  src.includes("diagCalm.push('拉取 '") && src.includes('diagRpc.max >= 500')
  && src.includes("diagWrap.appendChild(el('span', 'color:' + T.text3 + ';'"))
// ⚠ UI（真机截图 2026-09-16）：诊断行长度不可控，旧写法把标题挤成 0 宽、自己截断在半个数上、
// 右边的拖动/抽屉/关闭被推出面板。现在：标题定宽、诊断行自己省略号、全文进悬停、按钮 flex:none。
check('诊断行不会把标题/按钮挤走',
  src.includes("el('span', 'flex:none;white-space:nowrap;', '会话聊天室')")
  && src.includes('flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;')
  && src.includes("grip: 'flex:none;opacity:.55;"))
check('  被省略号吃掉的部分进悬停（含"主机自报多少"那一格）',
  src.includes('diagWrap.title = [') && src.includes('其余是通道/排队'))
check('  时长紧凑化（2443ms → 2.4s，380px 头部才放得下）',
  src.includes('function fmtMs(') && src.includes("(v / 1000).toFixed(1) + 's'"))
// 只有时长分不开"处理慢"与"传得慢"：把**载荷大小**与**候选那条 RPC**也记下来
// （真机 2026-09-16：拉取中位 528ms，而插件侧构建 15ms、载荷 0.2MB ⇒ 得知道差在哪一段）
check('  拉取连载荷大小一起报（528ms/201KB vs 528ms/2KB 是两回事）',
  src.includes('medianKb') && src.includes('function payloadKb(')
  && src.includes("noteDiag('rpc', performance.now() - diagRpcT0, payloadKb(stateRes), hostMsOf(stateRes))"))
// 往返 = 主机 + 通道。只有把主机自报的那一段减出来，"慢在通道"与"慢在我"才分得开 ——
// 真机 2026-09-16 那个 890ms 就是靠这条减法定性到 readTitleSnapshots 上的。
check('  往返里再分出"主机自报了多少"（一次减法定性）',
  src.includes('function hostMsOf(') && src.includes('medianHost') && src.includes('function hostBit('))
check('  候选那条 RPC 单独计时（两个并发 RPC 才看得出谁在等谁）',
  src.includes("noteDiag('cand'") && src.includes("diagCalm.push('候选 '") && src.includes('var diagCandT0 = performance.now()'))
check('  头部只在异常时出现橙字（重绘 ≥100ms / 拉取 ≥500ms / 停摆 ≥600ms）',
  src.includes("if (diagRepaint >= 100)") && src.includes("if (diagRpc.max >= 500)")
  && src.includes("if (jank.count > 0 && jank.ms >= 600)"))

console.log('19. 「欠一次表态」必须说清是哪一条（真机 #1348：只报靶子会把旧账吞掉）')
// 场景与真机一致：人的发言让全体欠回执 → 有人回了 → 一条只 @ 了别人的消息把靶子挪走。
// 旧面板对第二个人什么也不显示 —— 它欠着 #h1，而屏幕上「已读 N · 已表态 -」看起来一切正常。
check('只欠一条：报出那一条的 seq（与 #1348 起的老口径一致）',
  api.owedLabel({ owed: true, overdue: false, owedSeqs: [31] }) === ' · 欠一次表态 #31',
  api.owedLabel({ owed: true, overdue: false, owedSeqs: [31] }))
check('  逾时说逾时、并带上 seq',
  api.owedLabel({ owed: true, overdue: true, owedSeqs: [31] }) === ' · ⚠ 逾时未表态 #31',
  api.owedLabel({ owed: true, overdue: true, owedSeqs: [31] }))
// **口径改了**（cdfc696d #5017②，2026-09-25）：主语从"房间靶子"换成"这个人自己最老的那条"。
// 依据是实测：没有任何路径会重新唤醒一条"已投递但没回"的义务（补投只补投递失败的帧、且取**最老**那条；
// overdue 只被报告）。旧文案那组「靶子=会被重新唤醒 / 旧账=不会再被唤醒」在投递层不成立。
check('欠多条：主语是**最老**那条，其余按更晚列出',
  api.owedLabel({ owed: true, overdue: false, owedSeqs: [7, 19, 31] }) === ' · 欠 3 条表态，最老 #7（另有更晚未回: #19 #31）',
  api.owedLabel({ owed: true, overdue: false, owedSeqs: [7, 19, 31] }))
// 这一格仍是 #1348 的核心：**靶子上不欠的人也必须显示**（旧面板在这里什么都不说）。
const oldOnly = api.owedLabel({ owed: false, overdue: false, owedSeqs: [7, 19] })
check('靶子上不欠的人照样显示（旧面板这里是空白）', oldOnly.includes('#7') && oldOnly.includes('#19'), oldOnly)
check('  **不再**声称"会被/不会被重新唤醒"（那句话在投递层不成立）',
  oldOnly.indexOf('唤醒') < 0 && oldOnly.indexOf('必须') < 0, oldOnly)
check('  什么都不欠 → 空串（不要多出一行噪声）', api.owedLabel({ owed: false, owedSeqs: [] }, 31) === '', api.owedLabel({ owed: false, owedSeqs: [] }, 31))
check('过期 seq 的溢出被收住（最多 3 个 + …）',
  api.owedLabel({ owed: false, owedSeqs: [1, 2, 3, 4, 5] }, 31).includes('…'),
  api.owedLabel({ owed: false, owedSeqs: [1, 2, 3, 4, 5] }, 31))
// 宿主还没重启时快照里没有 owedSeqs：退回旧文案，但**不许把「欠」吞掉**
check('快照里没有 owedSeqs 时退回旧文案（宿主没重启也不会漏报）',
  api.owedLabel({ owed: true, overdue: false }, 31) === ' · 欠一次表态',
  api.owedLabel({ owed: true, overdue: false }, 31))
check('  逾时的旧文案同样退回', api.owedLabel({ owed: true, overdue: true }, 31) === ' · ⚠ 逾时未表态')
check('  不欠就是空（旧形状也一样）', api.owedLabel({ owed: false }, 31) === '')
check('undefined 不炸', api.owedLabel(undefined, 31) === '')

// 夹具顺序按**载荷契约**写：pendingDetail.owedSeqs 是**升序（最老在前）**
// —— 宿主侧 rooms.js 的 status() 显式排过序（原来乱序的 [31, 7] 会让"最老"变成 #31，
// 而渲染端正是按 own[0] 当最老的）。
const pendRoom = {
  targetSeq: 31,
  pending: ['cccccccc'],
  pendingDetail: [
    { sessionId: 'cccccccc-1111', shortId: 'cccccccc', seqs: [7, 31] },
    { sessionId: 'dddddddd-2222', shortId: 'dddddddd', seqs: [7] },
  ],
}
const pend = api.pendingRows(pendRoom)
check('每人一行：报**他自己最老**的那条（不再分靶子/旧账两栏）',
  pend.rows.length === 2 && pend.rows[0].indexOf('cccccccc') === 0 && pend.rows[0].includes('#7'), pend.rows)
check('  同时欠得更晚的只报条数（一行读得完）', pend.rows[0].includes('另 1 条更晚未回'), pend.rows[0])
check('靶子上不欠的人也有一行（旧面板完全不显示这些人）',
  pend.rows[1].includes('dddddddd') && pend.rows[1].includes('#7'), pend.rows)
check('宿主没重启（没有 pendingDetail）→ 退回旧的只报人',
  JSON.stringify(api.pendingRows({ targetSeq: 3, pending: ['session-eeeeeeee-1'] })) === '{"rows":["eeeeeeee"]}',
  api.pendingRows({ targetSeq: 3, pending: ['session-eeeeeeee-1'] }))
check('空房间不炸', api.pendingRows(null).rows.length === 0)

console.log('20. recentJank —— 停摆的次数与时长必须是同一个窗口（2026-09-16 修的诊断谎言）')
const nowMs = Date.now()
const jk = (msAgo, ms, mine) => ({ at: nowMs - msAgo, ms: ms, mine: mine })
check('窗口内计数', api.recentJank([jk(1000, 2000, true), jk(2000, 900, false)], nowMs).count === 2,
  api.recentJank([jk(1000, 2000, true), jk(2000, 900, false)], nowMs))
check('窗口外的不算（旧记录不许一直挂着）',
  api.recentJank([jk(6 * 60000, 20000, true), jk(1000, 800, false)], nowMs).count === 1,
  api.recentJank([jk(6 * 60000, 20000, true), jk(1000, 800, false)], nowMs))
check('取窗口内**最坏**那次，不是最后一次',
  api.recentJank([jk(1000, 700, false), jk(2000, 9000, true)], nowMs).ms === 9000,
  api.recentJank([jk(1000, 700, false), jk(2000, 9000, true)], nowMs))
check('  归因跟着最坏那次走（不是"最后一次的归因"）',
  api.recentJank([jk(1000, 700, false), jk(2000, 9000, true)], nowMs).mine === true)
check('  并给出它发生的时刻（面板显示"几分钟前"）',
  api.recentJank([jk(120000, 5000, false)], nowMs).at === nowMs - 120000)
check('全是旧记录 → 计数 0（整块消失，而不是挂着一个陈年数字）',
  api.recentJank([jk(10 * 60000, 17000, false)], nowMs).count === 0)
check('空日志 / undefined 不炸',
  api.recentJank([], nowMs).count === 0 && api.recentJank(undefined, nowMs).ms === 0)

console.log('21. 成员行的「方向 / 边界」两行（2026-09-16：散文被截断，机器读的是 paths）')
check('有结构化边界 → 单独一行列出，并带不碰项',
  api.directionLineOf({ selfDescription: '我负责前端', paths: ['a.js', 'b/**'], excludes: ['c.css'] }).bound
    === '边界 a.js b/**（不碰 c.css）',
  api.directionLineOf({ selfDescription: '我负责前端', paths: ['a.js', 'b/**'], excludes: ['c.css'] }).bound)
check('  超过 3 条就省略，不铺满成员行',
  api.directionLineOf({ paths: ['1', '2', '3', '4', '5'] }).bound.includes('…共 5 条'),
  api.directionLineOf({ paths: ['1', '2', '3', '4', '5'] }).bound)
check('只有散文、没有 paths → 明说边界是猜的（会误报/漏报）',
  api.directionLineOf({ selfDescription: '我负责前端' }).bound === '边界靠散文猜（会误报/漏报）',
  api.directionLineOf({ selfDescription: '我负责前端' }).bound)
check('  散文很长 → 显示侧才截（存储是全文），并标出总字数',
  api.directionLineOf({ selfDescription: 'x'.repeat(300) }).text.includes('（共 300 字）'),
  api.directionLineOf({ selfDescription: 'x'.repeat(300) }).text.slice(-20))
check('什么都没有 → 两行都空（调用方据此显示"未声明边界"的红字）',
  api.directionLineOf({}).text === '' && api.directionLineOf({}).bound === '',
  api.directionLineOf({}))
check('undefined 不炸', api.directionLineOf(undefined).bound === '')
// 观察者席位的边界文案（2026-09-16 更正）：宿主侧 detectOverreach **不看 watch** ——
// 它只跳过 enabled === false 的成员与声明者本人。所以 watch=all 只要给了 paths 就照样参与越界判定，
// 旧文案「不参与越界判定」是**与事实不符**的（宿主侧 index.js 的同款文案先改掉了这一处）。
check('观察者席位：收全量变更，领地仍按它给的 paths 算',
  api.directionLineOf({ watch: 'all', paths: ['a.js'] }).bound === '观察者席位（收全量变更；领地按它给的 paths 算）',
  api.directionLineOf({ watch: 'all', paths: ['a.js'] }).bound)
// 行为钉（不是源码 grep）：注释里可以引旧话，但**返回给用户的那一行**不许再把那句话带回来。
check('  旧说法（观察者不参与越界判定）不许从任何 watch 取值里回来',
  ['all', 'wake', 'feed', 'none', undefined].every(function (w) {
    return api.directionLineOf({ watch: w, paths: ['a.js'], selfDescription: '我负责前端' }).bound.indexOf('不参与') < 0
  }))

console.log('22. recentStats —— 拉取的分布（2026-09-16 方案 a：最大值读不出形状）')
const nowS = Date.now()
const sample = (msAgo, ms) => ({ at: nowS - msAgo, ms: ms })
const spike = api.recentStats([sample(1000, 4457), sample(2000, 90), sample(3000, 88), sample(4000, 120)], nowS)
check('尖峰：最坏 4457 / 中位介于 90 与 120 之间',
  spike.max === 4457 && spike.count === 4 && spike.median === Math.round((90 + 120) / 2), spike)
check('  并给出最坏那次的时刻（"4 分钟前"往往就是页面刚加载那一刻）',
  spike.maxAt === nowS - 1000, spike.maxAt)
const steady = api.recentStats([sample(1000, 4457), sample(2000, 3900), sample(3000, 4100)], nowS)
check('常态慢：中位也是几千（与尖峰一眼可分）', steady.median === 4100 && steady.max === 4457, steady)
check('窗口外的样本不算', api.recentStats([sample(6 * 60000, 9000), sample(1000, 50)], nowS).count === 1,
  api.recentStats([sample(6 * 60000, 9000), sample(1000, 50)], nowS))
check('奇数个样本取正中间那个', api.recentStats([sample(1, 10), sample(2, 20), sample(3, 30)], nowS).median === 20)
check('空样本 / undefined 不炸',
  api.recentStats([], nowS).count === 0 && api.recentStats(undefined, nowS).max === 0 &&
  api.recentStats([], nowS).median === 0)
check('全是旧样本 → 计数 0（头部那一行整块消失）',
  api.recentStats([sample(10 * 60000, 5000)], nowS).count === 0)

console.log('23. 任务板 + 投递台账（宿主新加的两张表：面板只消费，且字段可能还没到齐）')
// 一份「宿主已经改完」的合成载荷（形状照冻结协议写）
const tasksRoom = {
  tasks: [
    { id: 't1', title: '浏览器半侧任务板', status: 'claimed', owner: 'session-aaaa1111-1',
      deps: [], expectPaths: ['lib/client.js'], updatedAt: 11 },
    { id: 't2', title: '宿主侧投递台账', status: 'open', owner: null,
      deps: ['t1'], expectPaths: [], updatedAt: 12 },
  ],
}
const trows = api.taskRowsOf(tasksRoom)
check('任务条数 = 载荷里的条数（面板标题上的计数就是它）', trows.length === 2, trows.length)
check('owner：给的是短号（喂全长 id 也剥成短号）', trows[0].owner === 'aaaa1111', trows[0].owner)
check('owner：null → 「未认领」（不是空白、也不是 null 字样）', trows[1].owner === '未认领', trows[1].owner)
check('状态翻成中文', trows[0].status === '已认领' && trows[1].status === '待认领',
  [trows[0].status, trows[1].status])
check('依赖 / 预期改动规整成数组',
  trows[1].deps.join() === 't1' && trows[0].expectPaths.join() === 'lib/client.js',
  [trows[1].deps, trows[0].expectPaths])
check('元信息一行：状态 · 归属 · 依赖 · 预期改动都在',
  api.taskLineOf(trows[0]) === '已认领 · aaaa1111 · 预期改动 lib/client.js'
  && api.taskLineOf(trows[1]) === '待认领 · 未认领 · 依赖 t1',
  [api.taskLineOf(trows[0]), api.taskLineOf(trows[1])])
// ② tasks 为空 → 整块不出现：块的出现条件就是 taskRowsOf(...).length > 0
check('tasks 为空数组 → 空（整块不出现）', api.taskRowsOf({ tasks: [] }).length === 0)
check('  字段缺失 / null / 不是数组 → 空（宿主还没改完也不炸）',
  api.taskRowsOf({}).length === 0 && api.taskRowsOf({ tasks: null }).length === 0
  && api.taskRowsOf({ tasks: 't1' }).length === 0 && api.taskRowsOf(undefined).length === 0
  && api.taskRowsOf(null).length === 0)
check('  元素缺字段也不炸（title/owner/deps/expectPaths/status 全可缺）',
  api.taskRowsOf({ tasks: [{}, { title: '只有标题' }, null, undefined] }).length === 2,
  api.taskRowsOf({ tasks: [{}, { title: '只有标题' }, null, undefined] }).length)
check('  缺 title 给一个可读的占位（不许渲染出一行空白）',
  api.taskRowsOf({ tasks: [{}] })[0].title === '(无标题任务)')
check('  没见过的状态原样带出（不吞、也不猜成已完成）',
  api.taskRowsOf({ tasks: [{ status: 'blocked' }] })[0].status === 'blocked')
check('  deps / expectPaths 里的 null、空串、非数组成员都被丢掉',
  JSON.stringify(api.taskRowsOf({ tasks: [{ deps: [null, '', 't1', undefined], expectPaths: 'x' }] })[0])
    .includes('"deps":["t1"]')
  && JSON.stringify(api.taskRowsOf({ tasks: [{ deps: [null, '', 't1', undefined], expectPaths: 'x' }] })[0])
    .includes('"expectPaths":[]'))
check('taskLineOf 空输入不炸', api.taskLineOf(undefined) === '' && api.taskLineOf(null) === '')
// ③ pending：0 不显示、>0 才显示
check('pending=0 → 空串（这一行一个字都不多）', api.pendingDeliveryLabel(0) === '', api.pendingDeliveryLabel(0))
check('pending=2 → 显示 2', api.pendingDeliveryLabel(2) === '2 条待确认', api.pendingDeliveryLabel(2))
check('  缺失 / null / 非数 / 负数 → 空串且不炸',
  api.pendingDeliveryLabel(undefined) === '' && api.pendingDeliveryLabel(null) === ''
  && api.pendingDeliveryLabel('x') === '' && api.pendingDeliveryLabel(-3) === '')
check('  数字字符串也认（载荷过 JSON，但别假设宿主一定给 number）',
  api.pendingDeliveryLabel('2') === '2 条待确认', api.pendingDeliveryLabel('2'))
check('  小数取整（投递条数只可能是整数，万一是小数也别显示半个）',
  api.pendingDeliveryLabel(2.7) === '2 条待确认', api.pendingDeliveryLabel(2.7))

// 渲染结构：DOM 起不来，就钉在源码上（本文件一贯做法）
check('buildRoom：任务板只在有条目时出现（空 → 整块不出现）',
  buildSrc !== null && buildSrc.includes('var taskRows = taskRowsOf(room)')
  && buildSrc.includes('if (taskRows.length > 0)'))
// 块自己只负责画：从「取数据」到「切回抽屉」之间不许出现 rpc / 事件处理器
const taskBlock = buildSrc === null ? '' : buildSrc.slice(
  buildSrc.indexOf('var taskRows = taskRowsOf(room)'),
  buildSrc.indexOf('if (drawer !== null) panel = drawer'))
check('  任务板是只读的（块内没有 rpc 调用、也没有事件处理器）',
  taskBlock.includes('taskLineOf(t)') && taskBlock.indexOf('rpc(') < 0 && taskBlock.indexOf('addEventListener') < 0,
  taskBlock.length)
check('  成员行挂上待确认标记（0 时拼出来还是原来那一行）',
  buildSrc !== null && buildSrc.includes('pendingDeliveryLabel(m.pending)')
  && buildSrc.includes("pendingBit === '' ? '' : ' · ' + pendingBit"))

// 新表的变化不一定伴随消息：不进指纹，面板就会一直显示旧状态（数字说谎比没有数字更糟）
const sigTasks = JSON.parse(JSON.stringify(base))
sigTasks.rooms[0].tasks = [{ id: 't1', title: '任务', status: 'open', owner: null, updatedAt: 1 }]
check('任务变化 → 指纹变（认领 / 完成都不产生消息）', api.signatureOf(sigTasks) !== sig1)
const sigTaskTitle = JSON.parse(JSON.stringify(sigTasks))
sigTaskTitle.rooms[0].tasks[0].title = '改了标题'
check('  改标题也算变化', api.signatureOf(sigTaskTitle) !== api.signatureOf(sigTasks))
const sigPend = JSON.parse(JSON.stringify(base))
sigPend.rooms[0].members[0].pending = 2
check('待确认数变化 → 指纹变（确认掉一条同样没有任何消息）', api.signatureOf(sigPend) !== sig1)
const sigBad = JSON.parse(JSON.stringify(base))
sigBad.rooms[0].tasks = 'nope'
check('tasks 不是数组时指纹不炸（照旧算出字符串）', typeof api.signatureOf(sigBad) === 'string')

console.log('24. usageLineOf —— 「这个面板自己花了多少」的一行读数（宿主 ms.build + 本机停摆探针）')
// 全齐：宿主构建这一屏的 ms（载荷字段 room.ms.build） + 本页停摆（次数与最坏值**同窗口**：自加载）
const usageFull = api.usageLineOf({ ms: { build: 15 } }, { total: 3, worst: 1200 })
check('两个数都在 → 一行两段（中都分隔）',
  usageFull === '用量 宿主 15ms · 停摆 3 次/本页(最坏 1.2s)', usageFull)
// 窗口必须写在文案里：头部那行的停摆是「最近 5 分钟」（recentJank 现算），这一行是「自加载」。
// 两个窗口混着读会得出相反的结论 —— 2026-09-16 那次「9 小时前停了 9 次」就是这么来的。
check('  窗口写进文案（自加载 ≠ 头部那行的「最近 5 分钟」）', usageFull.includes('次/本页'), usageFull)
check('  长时长换成秒（380px 的状态行才放得下）',
  api.usageLineOf({ ms: { build: 2400 } }).includes('2.4s'), api.usageLineOf({ ms: { build: 2400 } }))
check('只有 payload（刚打开面板、探针还没记录）→ 只报宿主那一段',
  api.usageLineOf({ ms: { build: 12 } }) === '用量 宿主 12ms', api.usageLineOf({ ms: { build: 12 } }))
check('只有本机计数（老宿主没有 ms 字段）→ 只报停摆那一段',
  api.usageLineOf(null, { total: 2, worst: 900 }) === '用量 停摆 2 次/本页(最坏 900ms)',
  api.usageLineOf(null, { total: 2, worst: 900 }))
check('  停摆 0 次 → 这一格不出现（0 是噪声，不是读数）',
  api.usageLineOf({}, { total: 0, worst: 0 }) === '', api.usageLineOf({}, { total: 0, worst: 0 }))
check('  有次数没有最坏值（半份数据）→ 次数照报，括号整段不写',
  api.usageLineOf({}, { total: 4 }) === '用量 停摆 4 次/本页', api.usageLineOf({}, { total: 4 }))
check('  小数次数取整（次数只可能是整数，万一是小数也别显示半个）',
  api.usageLineOf({}, { total: 2.7 }) === '用量 停摆 2 次/本页', api.usageLineOf({}, { total: 2.7 }))
// 缺失 / 非数 / 负数 → **整行不显示**：这是这一行最重要的性质（宁可不说，也不打一个 undefined）
check('缺 ms / ms 为 null / build 缺失 → 空串',
  api.usageLineOf({}, {}) === '' && api.usageLineOf({ ms: null }, {}) === ''
  && api.usageLineOf({ ms: {} }, {}) === '' && api.usageLineOf({ ms: { build: null } }, {}) === '',
  [api.usageLineOf({}, {}), api.usageLineOf({ ms: {} }, {}), api.usageLineOf({ ms: { build: null } }, {})])
check('非数（字符串 / 布尔 / 对象 / 数组）→ 空串',
  api.usageLineOf({ ms: { build: '15' } }, {}) === ''
  && api.usageLineOf({ ms: { build: true } }, {}) === ''
  && api.usageLineOf({ ms: { build: {} } }, {}) === ''
  && api.usageLineOf({ ms: { build: [15] } }, {}) === '',
  api.usageLineOf({ ms: { build: '15' } }, {}))
check('负数 → 空串（读数里不许出现 -3ms）',
  api.usageLineOf({ ms: { build: -3 } }, {}) === ''
  && api.usageLineOf({ ms: { build: -1 } }, { total: -2, worst: -5 }) === '',
  api.usageLineOf({ ms: { build: -3 } }, {}))
check('NaN / ±Infinity → 空串',
  api.usageLineOf({ ms: { build: NaN } }, {}) === ''
  && api.usageLineOf({ ms: { build: Infinity } }, {}) === ''
  && api.usageLineOf({ ms: { build: -Infinity } }, {}) === ''
  && api.usageLineOf({}, { total: NaN, worst: Infinity }) === '',
  api.usageLineOf({}, { total: NaN, worst: Infinity }))
check('undefined / null 输入不炸（room 与 stats 都可以缺）',
  api.usageLineOf(undefined, undefined) === '' && api.usageLineOf(null, null) === ''
  && api.usageLineOf(undefined, { total: 1 }) === '用量 停摆 1 次/本页')
check('任何输入都不会把 undefined / NaN 打出来',
  [usageFull, api.usageLineOf(undefined, undefined), api.usageLineOf({ ms: { build: NaN } }, { total: NaN }),
    api.usageLineOf({}, { total: 4 }), api.usageLineOf({ ms: { build: 2400 } }, {})]
    .every((s) => s.indexOf('undefined') < 0 && s.indexOf('NaN') < 0))
// 渲染结构：DOM 起不来，就钉在源码上（本文件一贯做法）
check('buildRoom：这一行真的画进状态行，且空串时一个节点都不加',
  buildSrc !== null && buildSrc.includes('usageLineOf(room, { total: jankTotal, worst: jankAllWorstMs })')
  && buildSrc.includes("if (usage !== '') bar.appendChild(el('span', S.weak, usage))"))
check('  位置在状态行里（成员数之后、切换标签之前）—— 不为它新开一节',
  buildSrc !== null && buildSrc.indexOf('usageLineOf(room, {') > buildSrc.indexOf("' 名成员'")
  && buildSrc.indexOf('usageLineOf(room, {') < buildSrc.indexOf('var tabs = el('))
check('  两个数都是现成的：载荷字段 room.ms.build + 探针的累计窗口（不新增 RPC 字段、不另立计数器）',
  src.includes('room.ms.build') && buildSrc !== null
  && buildSrc.includes('total: jankTotal, worst: jankAllWorstMs')
  && !src.includes('usageRpcField') && !src.includes('usageCounter'))

console.log('')
console.log('RESULT  ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
