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
  src.includes("warnEl.title = '自本页加载以来共 ' + jankTotal"))

console.log('17. 打字让路（真机 2026-09-14 用户自测：关掉聊天室窗口后延迟消失）')
check('识别"用户正对着输入框"', src.includes('function userIsTyping()') &&
  src.includes("tag === 'textarea' || tag === 'input'") && src.includes('el.isContentEditable === true'))
check('  刷新时让路（打在重绘闸门之前）', refreshSrc !== null && refreshSrc.includes('if (userIsTyping()) return'))
check('  让路判断在后台判断之后、组字判断之前',
  refreshSrc !== null &&
  refreshSrc.indexOf('if (document.hidden === true) return') < refreshSrc.indexOf('if (userIsTyping()) return') &&
  refreshSrc.indexOf('if (userIsTyping()) return') < refreshSrc.indexOf('renderBlocked(dragging, composing)'))
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
check('  头部只在异常时出现（重绘 ≥100ms / 拉取 ≥500ms / 停摆 ≥600ms）',
  src.includes("if (diagRepaint >= 100)") && src.includes("if (diagRpc >= 500)")
  && src.includes("if (jank.count > 0 && jank.ms >= 600)"))

console.log('19. 「欠一次表态」必须说清是哪一条（真机 #1348：只报靶子会把旧账吞掉）')
// 场景与真机一致：人的发言让全体欠回执 → 有人回了 → 一条只 @ 了别人的消息把靶子挪走。
// 旧面板对第二个人什么也不显示 —— 它欠着 #h1，而屏幕上「已读 N · 已表态 -」看起来一切正常。
check('靶子上欠的人：报出靶子的 seq',
  api.owedLabel({ owed: true, overdue: false, owedSeqs: [31] }, 31) === ' · 欠一次表态 #31',
  api.owedLabel({ owed: true, overdue: false, owedSeqs: [31] }, 31))
check('  逾时说逾时、并带上 seq',
  api.owedLabel({ owed: true, overdue: true, owedSeqs: [31] }, 31) === ' · ⚠ 逾时未表态 #31',
  api.owedLabel({ owed: true, overdue: true, owedSeqs: [31] }, 31))
check('  同时欠着更早的 → 只报条数，不铺满整行',
  api.owedLabel({ owed: true, overdue: false, owedSeqs: [7, 19, 31] }, 31) === ' · 欠一次表态 #31（另 2 条更早未回: #7 #19）',
  api.owedLabel({ owed: true, overdue: false, owedSeqs: [7, 19, 31] }, 31))
// 这一格是 #1348 的核心：靶子上不欠，但旧账还在。旧面板在这里什么都不说。
const oldOnly = api.owedLabel({ owed: false, overdue: false, owedSeqs: [7, 19] }, 31)
check('只在旧账上欠的人也要显示（旧面板这里是空白）', oldOnly.includes('#7') && oldOnly.includes('#19'), oldOnly)
check('  并且写明它不会被重新唤醒（不许写成"必须回"）',
  oldOnly.includes('当前靶子 #31 不欠') && oldOnly.indexOf('必须') < 0, oldOnly)
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

const pendRoom = {
  targetSeq: 31,
  pending: ['cccccccc'],
  pendingDetail: [
    { sessionId: 'cccccccc-1111', shortId: 'cccccccc', seqs: [31, 7] },
    { sessionId: 'dddddddd-2222', shortId: 'dddddddd', seqs: [7] },
  ],
}
const pend = api.pendingRows(pendRoom)
check('靶子上欠的进 target 栏，并点名是哪一条',
  pend.target.length === 1 && pend.target[0].indexOf('cccccccc') === 0 && pend.target[0].includes('#31'), pend.target)
check('  同时欠旧账的只报条数（一行读得完）', pend.target[0].includes('另 1 条更早未回'), pend.target[0])
check('只有旧账的进 older 栏（旧面板完全不显示这些人）',
  pend.older.length === 1 && pend.older[0].includes('dddddddd') && pend.older[0].includes('#7'), pend.older)
check('宿主没重启（没有 pendingDetail）→ 退回旧的只报人',
  JSON.stringify(api.pendingRows({ targetSeq: 3, pending: ['session-eeeeeeee-1'] })) === '{"target":["eeeeeeee"],"older":[]}',
  api.pendingRows({ targetSeq: 3, pending: ['session-eeeeeeee-1'] }))
check('空房间不炸', api.pendingRows(null).target.length === 0)

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

console.log('')
console.log('RESULT  ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
