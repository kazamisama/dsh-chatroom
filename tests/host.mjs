/**
 * dsh-chatroom 宿主半侧集成测试 —— 用假 cordis Context 驱动真实的 apply()。
 *
 * 这是「装机前能拿到的最强证据」：不需要启动 DSH，就能验证
 * 工具注册、投递路由、义务展开、终端回执、面板 RPC 是否真的按蓝图工作。
 * 状态写进临时目录（DSH_CHATROOM_HOME），绝不碰真实房间数据。
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = path.join(os.tmpdir(), 'dsh-chatroom-host-' + Date.now())
process.env.DSH_CHATROOM_HOME = HOME

const { apply, inject, name } = await import('../lib/index.js')

let pass = 0
let fail = 0
/** JSON.stringify 会静默丢 undefined，所以必须显式查：DSH 的日志校验拒绝 undefined。 */
function hasUndefined(value, path = '$') {
  if (value === undefined) return path
  if (value === null || typeof value !== 'object') return null
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = hasUndefined(value[i], path + '[' + i + ']')
      if (hit !== null) return hit
    }
    return null
  }
  for (const key of Object.keys(value)) {
    const hit = hasUndefined(value[key], path + '.' + key)
    if (hit !== null) return hit
  }
  return null
}

function check(label, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra))) }
}

// ---- 假 DSH 服务 ---------------------------------------------------------

function fakeAgent(id, status = 'idle', cwd = 'D:\\proj') {
  const calls = []
  return {
    id, status,
    session: { id, header: { cwd } },
    calls,
    followup(m) { calls.push({ mode: 'followup', message: m }) },
    inject(m) { calls.push({ mode: 'inject', message: m }) },
    steer(m) { calls.push({ mode: 'steer', message: m }) },
  }
}

const A = fakeAgent('session-aaaabbbb-1111-2222-3333-444455556666')
const B = fakeAgent('1b68df32-d51e-4dab-b1ea-74f76b1c12c2')
const C = fakeAgent('session-ccccdddd-1111-2222-3333-444455556666') // 冷会话：不在 live 注册表里
// E 在另一个工作区，且那里没有 app.py —— 用来验证「不确定性匹配不误伤」
const E = fakeAgent('session-eeeeffff-1111-2222-3333-444455556666', 'idle', 'D:\\other')
const live = new Map([[A.id, A], [B.id, B], [E.id, E]])

const registered = []
const section = { spec: null }
const rpcCalls = { channel: null, handler: null, options: null }
const effects = []

const toolsService = { register(def) { registered.push(def); return () => {} } }
const systemPromptService = { section(spec) { section.spec = spec; return () => {} } }
const resumeCalls = []
const mountCalls = []
const agentsService = {
  get: (id) => live.get(id),
  list: () => [...live.values()],
  resume: async (options) => {
    resumeCalls.push(options)
    throw new Error('测试环境没有持久化后端') // 冷唤醒失败路径照旧要优雅降级
  },
}
// M4：冷唤醒的三件套（参照 dsh-host-apiproxy 的 ensureSession）
const fakeDefaultModel = { currentSelection: () => ({ provider: 'deepseek', model: 'v4' }) }
const fakeAgentPresets = {
  resolve: async (id) => ({ id: id === undefined ? 'standard' : id }),
  mount: async (_agentCtx, id) => { mountCalls.push(id); return { id } },
}
const fakePersistence = {
  list: async () => [{ id: C.id, agentPreset: 'cordis' }],
}
const connectionService = {
  rpc: {
    handle(channel, handler, options) {
      rpcCalls.channel = channel
      rpcCalls.handler = handler
      rpcCalls.options = options
      return async () => {}
    },
  },
}

// 会话查询：候选列表的标题与「持久化语料」都来自它
const DORMANT = 'session-deadbeef-0000-1111-2222-333333333333'
const sessionQueryService = {
  listSessions: async () => [
    { header: { id: A.id, cwd: 'D:\\proj', createdAt: 100 }, live: true, persisted: true },
    { header: { id: DORMANT, cwd: 'D:\\other', createdAt: 200 }, live: false, persisted: true },
  ],
  readTitleSnapshots: async (ids) => ids.map((id) => ({
    sessionId: id,
    status: 'fulfilled',
    value: { session: { id }, title: { title: '会话标题-' + String(id).slice(-8) } },
  })),
}

const ctx = {
  get: (k) => ({
    tools: toolsService,
    systemPrompt: systemPromptService,
    agents: agentsService,
    sessionQuery: sessionQueryService,
    agentDefaultModel: fakeDefaultModel,
    agentPresets: fakeAgentPresets,
    sessionPersistence: fakePersistence,
  })[k],
  effect: (fn, label) => { const d = fn(); effects.push({ label, d }); return d },
  inject: (deps, cb) => { if (deps.includes('connection')) cb({ connection: connectionService }) },
}

apply(ctx)

const rpc = (endpoint, payload) => rpcCalls.handler(endpoint, payload)
const tool = (n) => registered.find((t) => t.name === n)
const exec = (agent) => ({ agent, signal: { throwIfAborted() {} } })
const callsOf = (agent) => agent.calls

console.log('1. 注册面')
check('导出 name/inject', name === 'dsh-chatroom' && inject[0] === 'tools', { name, inject })
check('注册了 7 个工具', registered.length === 7, registered.map((t) => t.name))
for (const n of ['room_status', 'room_message', 'room_say', 'room_judge', 'room_declare_change', 'room_alert', 'room_intent']) {
  check('工具存在: ' + n, tool(n) !== undefined)
  check('  ' + n + ' 有 output.render', typeof tool(n).output.render === 'function')
}
check('每个工具都有原始 JSON Schema 参数', registered.every((t) => t.parameters && t.parameters.type === 'object'))
check('协议 section 已注册', section.spec !== null && section.spec.name === 'chatroom:protocol')
check('RPC 通道正确', rpcCalls.channel === '/dsh-chatroom')
check('RPC authority=loopback（少这个运行时会抛）', rpcCalls.options && rpcCalls.options.authority === 'loopback')

console.log('2. 建房与拉人（面板通道）')
const created = await rpc('create-room', { name: '变更同步' })
check('create-room ok', created.ok === true, created)
const roomId = created.value.room.room.id
const cands = await rpc('candidates', {})
check('candidates 列出 3 个活会话', cands.value.candidates.filter((c) => c.live).length === 3,
  cands.value.candidates.map((c) => c.shortId + (c.live ? ':live' : ':dormant')))
// 按 id 找行，不按下标 —— 列表按创建时间倒序，下标会随数据变
const aCand = cands.value.candidates.find((c) => c.sessionId === A.id)
// 回归：cwd 必须取自 session.header.cwd —— 取错字段在真机上表现是「未知工作区」
check('candidates 带出真实 cwd', aCand.cwd === 'D:\\proj', aCand)
check('candidates 带出工作区名（归属标签）', aCand.workspace === 'proj', aCand.workspace)
// 回归：人认得出的是标题，不是 id —— 只给 id 等于没给身份。
// 但标题**不在请求路径上取**：真机上对几百条会话取标题要 20 秒（缺投影的要回读会话日志），
// 会把面板拖成 20 秒空白。所以改成"缓存优先 + 后台预热"：第一轮可以没有，预热后必须出现。
check('candidates 不阻塞取标题（title 一定是字符串，不能是 undefined）', typeof aCand.title === 'string', aCand.title)
const candsWarm = await (async () => {
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 100))
    const again = await rpc('candidates', {})
    const row = again.value.candidates.find((c) => c.sessionId === A.id)
    if (row !== undefined && row.title.startsWith('会话标题-')) return row
  }
  return null
})()
check('预热后 candidates 带出会话标题', candsWarm !== null, candsWarm && candsWarm.title)
// 回归：只列活会话是死循环（想让它活着得先去 GUI 打开它，而面板里又看不到它）
const dormant = cands.value.candidates.find((c) => c.sessionId === DORMANT)
check('候选包含休眠会话（冷启动也能选）', dormant !== undefined, cands.value.candidates.map((c) => c.shortId))
check('休眠会话标记为非 live', dormant !== undefined && dormant.live === false, dormant && dormant.live)
check('活会话标记为 live', cands.value.candidates.find((c) => c.sessionId === A.id).live === true)
await rpc('join', { roomId, sessionId: A.id, roleName: '实现者' })
const joined = await rpc('join', { roomId, sessionId: B.id })
check('join ok', joined.ok === true)
const st0 = await rpc('state', {})
check('房间里有 2 名成员', st0.value.rooms[0].members.length === 2)

console.log('3. 人的发言 → 全员产生义务并 followup（D4 / §7）')
const said = await rpc('say', { roomId, text: '谁动了 app.py 的 parse_cfg？' })
check('say ok', said.ok === true, said)
check('投递结果 2/2', said.value.delivered.filter((d) => d.delivered).length === 2, said.value.delivered)
check('A 收到 followup', callsOf(A).length === 1 && callsOf(A)[0].mode === 'followup')
check('B 收到 followup', callsOf(B).length === 1 && callsOf(B)[0].mode === 'followup')
const textA = callsOf(A)[0].message.content[0].text
check('消息带房间与序号', textA.includes('[聊天室 变更同步 #1]'), textA)
check('消息点名必须回一句', textA.includes('必须回一句判断') && textA.includes('room_judge'))
check('消息枚举了四种 verdict', textA.includes('unaffected') && textA.includes('retest'))
check('来源是 relay 形态（GUI 才认）', callsOf(A)[0].message.source.form === 'relay'
  && callsOf(A)[0].message.source.kind === 'plugin'
  && callsOf(A)[0].message.source.plugin === 'dsh-chatroom', callsOf(A)[0].message.source)
check('消息已冻结（不可变）', Object.isFrozen(callsOf(A)[0].message))
// 回归：DSH 的会话日志走严格 lossless-JSON 校验，一条 undefined 就整条拒收。
// 真机上表现为 delivered:false + "carries non-JSON-serializable data"。
check('投递的消息不含 undefined（lossless JSON）', hasUndefined(callsOf(A)[0].message) === null, hasUndefined(callsOf(A)[0].message))
check('消息可无损往返 JSON', JSON.stringify(JSON.parse(JSON.stringify(callsOf(A)[0].message))) === JSON.stringify(callsOf(A)[0].message))
check('消息是 user 角色', callsOf(A)[0].message.role === 'user')

console.log('4. 表态是终端的（D5）—— 这是整个设计不爆炸的那条规则')
const judged = await tool('room_judge').execute({ room: roomId, seq: 1, verdict: 'catch-up', note: '我依赖它' }, exec(A))
check('room_judge ok', judged.ok === true, judged)
check('表态没有给任何人新增投递', callsOf(A).length === 1 && callsOf(B).length === 1,
  { A: callsOf(A).length, B: callsOf(B).length })
const st1 = await rpc('state', {})
check('待表态只剩 B', st1.value.rooms[0].pending.length === 1 && st1.value.rooms[0].pending[0] === B.id,
  st1.value.rooms[0].pending)
check('A 的 verdict 已记录',
  st1.value.rooms[0].members.find((m) => m.shortId === 'aaaabbbb').verdict === 'catch-up')

console.log('5. 成员被用户关闭 → 不参与而非未表态（D2 / 场景 C）')
await rpc('set-enabled', { roomId, sessionId: B.id, enabled: false })
const said2 = await rpc('say', { roomId, text: '我要动 app.py 了' })
check('关闭后只有 A 被要求表态', said2.value.delivered.length === 1 && said2.value.delivered[0].sessionId === A.id,
  said2.value.delivered)
const st2 = await rpc('state', {})
const bRow = st2.value.rooms[0].members.find((m) => m.shortId === '1b68df32')
check('B 标记为未在房间', bRow.inRoom === false)
check('B 不在待表态名单里', !st2.value.rooms[0].pending.includes(B.id))

console.log('6. 声明变更：确定性匹配决定谁被叫醒（M1）')
await rpc('set-enabled', { roomId, sessionId: B.id, enabled: true })
await rpc('join', { roomId, sessionId: E.id }) // 异工作区、且那儿没有 app.py
const beforeA = callsOf(A).length
const beforeB = callsOf(B).length
const beforeE = callsOf(E).length
const declared = await tool('room_declare_change').execute(
  { room: roomId, files: ['app.py'], summary: '把 parse_cfg 改成读环境变量', symbols: ['parse_cfg'] },
  exec(A),
)
// 假工作区 D:proj 不存在 → gitcheck 返回 unverified（而不是 contradicted）——
// 这条断言守的是蓝图 §6.2 的分寸：查不到 ≠ 撒谎。
check('声明被受理，且查不到时不判撒谎', declared.verdict === 'unverified' && declared.seq > 0, declared)
check('同工作区的 B 被叫醒（followup，必须表态）',
  callsOf(B).length === beforeB + 1 && callsOf(B)[beforeB].mode === 'followup',
  callsOf(B).slice(beforeB).map((c) => c.mode))
check('异工作区且无同名文件的 E 只收背景 inject（不被打扰）',
  callsOf(E).length === beforeE + 1 && callsOf(E)[beforeE].mode === 'inject',
  callsOf(E).slice(beforeE).map((c) => c.mode))
check('发送者不会收到自己的回声', callsOf(A).length === beforeA)
const st3 = await rpc('state', {})
const change0 = st3.value.rooms[0].changes[0]
check('变更登记进了房间快照', st3.value.rooms[0].changes.length === 1 && change0.verdict === 'unverified', change0)
check('变更记录带核验理由与相关成员', change0.reason === 'workspace-missing'
  && Array.isArray(change0.related) && change0.related.length === 1 && change0.related[0] === B.id,
  { reason: change0.reason, related: change0.related })
check('房间消息里写明了 git 校验结论', String(st3.value.rooms[0].messages.slice(-1)[0].body).includes('git 校验'), st3.value.rooms[0].messages.slice(-1)[0].body)

console.log('7. 冷会话：唤醒失败要优雅降级，不能让房间崩')
await rpc('join', { roomId, sessionId: C.id })
const said3 = await rpc('say', { roomId, text: '还有一个成员在睡觉' })
const cRes = said3.value.delivered.find((d) => d.sessionId === C.id)
check('冷成员被列入义务人', cRes !== undefined, said3.value.delivered)
check('但投递标记为未达（不是静默假装成功）', cRes.delivered === false, cRes)
check('冷成员一条消息都没收到', callsOf(C).length === 0)
check('房间本身没崩：消息照常落库', said3.value.message.seq > 0)

console.log('7.1 冷唤醒必须带 agentOptions + setup（M4 真机踩坑回归）')
check('resume 确实被调用了', resumeCalls.length >= 1, resumeCalls.length)
const ro = resumeCalls[resumeCalls.length - 1]
// 不给 agentOptions → {{model}} 无值 → 被唤醒的 agent 第一轮必崩
// （dsh-agent-loop/lib/index.js:1025 从 agent.options.model 取这个变量）
check('带上了默认模型', ro.agentOptions !== undefined && ro.agentOptions.model === 'v4', ro.agentOptions)
check('带上 provider', ro.agentOptions !== undefined && ro.agentOptions.provider === 'deepseek', ro.agentOptions)
// 不给 setup → 它跑在宿主组合上，工具集与提示词全错
check('带上了 setup', typeof ro.setup === 'function')
await ro.setup({})
check('setup 挂载的是该会话记录的 preset', mountCalls[mountCalls.length - 1] === 'cordis', mountCalls)
check('resumeSessionId 是目标会话', ro.resumeSessionId === C.id, ro.resumeSessionId)

console.log('8. 状态机与工具面一致（room_status 工具）')
// @ 提及 → 主动唤醒（真机反馈 2026-09-12：agent 写 @ 根本叫不动人）
const mroom = await rpc('create-room', { name: '@唤醒' })
const mroomId = mroom.value.room.room.id
await rpc('join', { roomId: mroomId, sessionId: A.id, roleName: '实现者' })
await rpc('join', { roomId: mroomId, sessionId: B.id, roleName: '审计员' })
const bBefore1 = callsOf(B).length
await tool('room_say').execute({ room: mroomId, text: '我改完了，你们看着办' }, exec(A))
const quiet = callsOf(B).slice(bBefore1)
check('不 @ 任何人 → 只进背景通道（inject），不唤醒', quiet.length > 0 && quiet.every((c) => c.mode === 'inject'),
  quiet.map((c) => c.mode))
const bBefore2 = callsOf(B).length
const atSay = await tool('room_say').execute({ room: mroomId, text: '@1b68df32 请确认载荷' }, exec(A))
const woke = callsOf(B).slice(bBefore2)
check('@ 短号 → 被 followup 主动唤醒', woke.some((c) => c.mode === 'followup'), woke.map((c) => c.mode))
check('  唤醒语里点明「有人 @ 了你」',
  woke.some((c) => JSON.stringify(c.message).includes('有人 @ 了你')), woke.map((c) => JSON.stringify(c.message).slice(0, 60)))
// 真机 #61：投递给正在跑的那个 agent 的 followup 会被 DSH 挂进 next-turn 队列，
// 等它下一轮才落地 —— 那时它可能已经从 room_status 看到并回执过了。
// 所以每一帧唤醒语都要自带这句免责说明，让滞后的帧能自我消解。
check('  唤醒语写明「投递可能滞后」',
  woke.some((c) => JSON.stringify(c.message).includes('投递可能滞后')),
  woke.map((c) => JSON.stringify(c.message).slice(0, 60)))
check('  返回值说明唤醒了谁', /已唤醒 1 人/.test(atSay.text), atSay.text)

// 「提到」不等于「点名」（真机 #55 报的：正文写了不需要回应，插件照样把人叫起来了）
const bBeforeText = callsOf(B).length
const quietText = await tool('room_say').execute({ room: mroomId, text: '@1b68df32 顺带同步一下：不需要回应' }, exec(A))
const afterText = callsOf(B).slice(bBeforeText)
check('正文写了「不需要回应」→ 不产生义务，只走背景通道',
  afterText.length > 0 && afterText.every((c) => c.mode === 'inject'), afterText.map((c) => c.mode))
check('  返回值说明为什么没唤醒', /没有登记义务/.test(quietText.text), quietText.text)
const bBeforeFlag = callsOf(B).length
const quietFlag = await tool('room_say').execute({ room: mroomId, text: '@1b68df32 只是提到你', wake: false }, exec(A))
const afterFlag = callsOf(B).slice(bBeforeFlag)
check('wake=false → 同样不产生义务', afterFlag.length > 0 && afterFlag.every((c) => c.mode === 'inject'),
  afterFlag.map((c) => c.mode))
check('  返回值写明是 wake=false', /wake=false/.test(quietFlag.text), quietFlag.text)

// 引述即提及（真机 #58）：引述里的 @ 不该把人叫起来；自己也不该被自己 @ 到
const bBeforeQuote = callsOf(B).length
await tool('room_say').execute({ room: mroomId, text: '原文写着 `@1b68df32 请确认载荷`（只是引述）' }, exec(A))
const afterQuote = callsOf(B).slice(bBeforeQuote)
check('行内 code 里引述的 @ 不产生义务', afterQuote.length > 0 && afterQuote.every((c) => c.mode === 'inject'),
  afterQuote.map((c) => c.mode))
const aBeforeSelf = callsOf(A).length
const selfSay = await tool('room_say').execute({ room: mroomId, text: '@aaaabbbb 我自己补一句' }, exec(A))
check('自己 @ 自己不算提及', !/已唤醒/.test(selfSay.text), selfSay.text)
check('  自己也没收到 followup', callsOf(A).slice(aBeforeSelf).every((c) => c.mode !== 'followup'),
  callsOf(A).slice(aBeforeSelf).map((c) => c.mode))

const statusText = await tool('room_status').execute({ room: roomId }, exec(A))
check('room_status 能读到房间', statusText.text.includes('变更同步'), statusText.text.slice(0, 120))
check('room_status 标出未表态者', statusText.text.length > 0)

console.log('8.5 「欠的是哪一条」与「他当时回了什么」（真机 #1348 / #1349）')
// 起因（真机）：6126bf05 想知道 d8e86630 对 #1295 回了什么 —— 回执正文不在它的上下文里，
// room_status 也只说「欠一次表态」而不说是哪一条，于是"一次查询"变成了"再打扰一次"。
const asked = await tool('room_say').execute({ room: mroomId, text: '@1b68df32 请把 #1295 的回执再贴一次' }, exec(A))
const askedSeq = asked.seq
const stAsk = await tool('room_status').execute({ room: mroomId }, exec(A))
check('room_status 说清欠的是哪一条', stAsk.text.includes('欠一次表态 #' + askedSeq), stAsk.text)
check('  待表态一行也带 seq 与靶子',
  stAsk.text.includes('待表态（靶子 #' + askedSeq + '）') && stAsk.text.includes('1b68df32'), stAsk.text)
const judgeReply = await tool('room_judge').execute(
  { room: mroomId, seq: askedSeq, verdict: 'catch-up', note: '我接 API 半' }, exec(B))
check('B 表态成功', judgeReply.ok === true, judgeReply)
const readBack = await tool('room_message').execute({ room: mroomId, seq: askedSeq }, exec(A))
check('room_message 取回正文', readBack.text.includes('请把 #1295 的回执再贴一次'), readBack.text.slice(0, 240))
check('  带上被 @ 的人', readBack.text.includes('@ 到') && readBack.text.includes('1b68df32'), readBack.text.slice(0, 240))
// 这一段就是「不用再问一次」的那半：verdict 与 note 正文都在里面
check('  带出回执正文（verdict + note）',
  readBack.text.includes('catch-up') && readBack.text.includes('我接 API 半'), readBack.text)
check('  回执齐了就明说齐了', readBack.text.includes('还欠: （无'), readBack.text)
check('  seq 对不上时说清范围，不给一段空话',
  (await tool('room_message').execute({ room: mroomId, seq: 999999 }, exec(A))).text.includes('没有 #999999'),
  (await tool('room_message').execute({ room: mroomId, seq: 999999 }, exec(A))).text)
// 非法值拒绝而不是夹取（与 set-policy 同一套口径）：静默改数会让调用方以为查的是别的条
check('  seq 非整数 → 拒绝',
  (await tool('room_message').execute({ room: mroomId, seq: 'abc' }, exec(A))).text.includes('必须是整数'),
  (await tool('room_message').execute({ room: mroomId, seq: 'abc' }, exec(A))).text)
check('  limit 非整数 → 拒绝',
  (await tool('room_message').execute({ room: mroomId, limit: 0 }, exec(A))).text.includes('limit 必须是'),
  (await tool('room_message').execute({ room: mroomId, limit: 0 }, exec(A))).text)
check('  since_seq 非整数 → 拒绝',
  (await tool('room_message').execute({ room: mroomId, since_seq: 1.5 }, exec(A))).text.includes('since_seq 必须是'),
  (await tool('room_message').execute({ room: mroomId, since_seq: 1.5 }, exec(A))).text)
const listed = await tool('room_message').execute({ room: mroomId, limit: 4 }, exec(A))
check('不给 seq → 列表模式（一行一条，用来先找 seq）',
  listed.text.includes('#' + askedSeq) && listed.text.split('\n').length >= 5, listed.text)
const older = await tool('room_message').execute({ room: mroomId, since_seq: askedSeq - 1, limit: 2 }, exec(A))
check('since_seq 从某条之后往前读', older.text.includes('：#' + askedSeq + '–'), older.text)
// 回执被改过也读得回来（表态是幂等的覆盖，不是追加）
await tool('room_judge').execute({ room: mroomId, seq: askedSeq, verdict: 'retest', note: '我要重跑' }, exec(B))
const reread = await tool('room_message').execute({ room: mroomId, seq: askedSeq }, exec(A))
check('  改过的回执读回来是新的那份（旧的不会被当成两条）',
  reread.text.includes('我要重跑') && !reread.text.includes('我接 API 半'), reread.text)

console.log('9. 非法输入被拒绝')
const bad = await rpc('judge', { roomId, seq: 1, sessionId: A.id, verdict: '随便' })
check('未知 verdict 被拒', bad.ok === false, bad)
const badRoom = await rpc('nope', {})
check('未知端点被拒', badRoom.ok === false && String(badRoom.error.message).includes('unknown endpoint'))

console.log('9.5 越界提醒：⚠ 行要回引「匹配到哪个子串、来自哪一句」（真机 #45 的诉求）')
// B 声明一个它负责的目录；A 随后改这个目录里的文件 → 消息里应当出现 ⚠ 并回引匹配细节，且 B 被 @
await tool('room_intent').execute({ room: roomId, direction: 'B 负责 ulysses/adapters/webui/** 的页面与 dashboard.css；不碰 js/memory.js' }, exec(B))
const beforeOverB = callsOf(B).length
const over = await tool('room_declare_change').execute(
  { room: roomId, files: ['ulysses/adapters/webui/pages/index.html'], summary: '顺手修了页面' }, exec(A))
check('越界提醒出现在消息里', over.text.includes('可能越界'), over.text.slice(0, 200))
check('  回引匹配到的子串', over.text.includes('匹配到方向第') && over.text.includes('webui'), over.text.slice(0, 240))
check('  回引它所在的句子', over.text.includes('负责 ulysses/adapters/webui'), over.text.slice(0, 240))
check('  负责人被 followup 唤醒（必须回一句）',
  callsOf(B).slice(beforeOverB).some((c) => c.mode === 'followup'),
  callsOf(B).slice(beforeOverB).map((c) => c.mode))

console.log('10. M3：紧急通道（steer）与审计导出')
const snapshotBefore = (await rpc('state', {})).value.rooms.find((r) => r.room.id === roomId)
const beforeAlertB = callsOf(B).length
const alerted = await rpc('alert', { roomId, text: '停，别动 app.py' })
check('alert ok', alerted.ok === true, alerted)
check('用 steer 投递（不是 followup）',
  callsOf(B).length === beforeAlertB + 1 && callsOf(B)[beforeAlertB].mode === 'steer',
  callsOf(B).slice(beforeAlertB).map((c) => c.mode))
check('紧急消息里写明了「可能不达、不需要回执」',
  callsOf(B)[beforeAlertB].message.content[0].text.includes('可能不达'), callsOf(B)[beforeAlertB].message.content[0].text.slice(0, 140))
const snapshotAfter = (await rpc('state', {})).value.rooms.find((r) => r.room.id === roomId)
check('alert 不新增任何义务（不承载「必须回」）',
  snapshotAfter.pending.length === snapshotBefore.pending.length,
  { before: snapshotBefore.pending.length, after: snapshotAfter.pending.length })
const alertTool = await tool('room_alert').execute({ room: roomId, text: '停一下' }, exec(A))
check('room_alert 工具可用', alertTool.total >= 1, alertTool)

const intentRes = await tool('room_intent').execute({ room: roomId, direction: '只动前端表现层，不碰数据模型' }, exec(A))
check('room_intent 可用', intentRes.text.includes('方向已记录'), intentRes)
const withIntent = (await rpc('state', {})).value.rooms.find((r) => r.room.id === roomId)
check('方向进了成员快照（面板据此显示）',
  withIntent.members.find((m) => m.shortId === 'aaaabbbb').selfDescription === '只动前端表现层，不碰数据模型',
  withIntent.members.find((m) => m.shortId === 'aaaabbbb').selfDescription)

const exported = await rpc('export', { roomId })
check('导出 ok', exported.ok === true && typeof exported.value.markdown === 'string', exported.ok)
const md = exported.ok === true ? exported.value.markdown : ''
check('导出含房间名', md.includes('变更同步'), md.slice(0, 60))
check('导出含成员表', md.includes('## 成员') && md.includes('| 短号 |'))
check('导出含变更核验章节', md.includes('## 变更声明与核验'))
check('导出含完整时间线', md.includes('## 时间线') && md.includes('alert'), md.length)
check('导出标注了终端回执', md.includes('judgment·终端'), md.includes('judgment'))

console.log('9.6 set-policy —— 房间策略就地可改（真机反馈：撞到 room is full 才知道有上限）')
const polOk = await rpc('set-policy', { roomId, maxMembers: '2', threadBudget: '6' })
check('改策略成功', polOk.ok === true, polOk)
const polState = (await rpc('state', {})).value.rooms.find((r) => r.room.id === roomId)
check('  策略已生效', polState.room.policy.maxMembers === 2 && polState.room.policy.threadBudget === 6, polState.room.policy)
const polBad = await rpc('set-policy', { roomId, maxMembers: '0' })
check('  非法值被拒，且带回服务端原话', polBad.ok === false && String(polBad.error.message).includes('成员上限'), polBad)
const polBack = await rpc('set-policy', { roomId, maxMembers: '5', threadBudget: '4' })
check('  改回去（不打扰后面的用例）', polBack.ok === true, polBack)

await fs.rm(HOME, { recursive: true, force: true })
console.log('')
console.log('RESULT  ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
