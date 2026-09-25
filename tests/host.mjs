/**
 * dsh-chatroom 宿主半侧集成测试 —— 用假 cordis Context 驱动真实的 apply()。
 *
 * 这是「装机前能拿到的最强证据」：不需要启动 DSH，就能验证
 * 工具注册、投递路由、义务展开、终端回执、面板 RPC 是否真的按蓝图工作。
 * 状态写进临时目录（DSH_CHATROOM_HOME），绝不碰真实房间数据。
 */
import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const HOME = path.join(os.tmpdir(), 'dsh-chatroom-host-' + Date.now())
process.env.DSH_CHATROOM_HOME = HOME

const { apply, inject, name, isSessionLogName, classifySessionDir } = await import('../lib/index.js')
const { rejudgeStamp } = await import('../lib/rejudge.js')
const zlib = await import('node:zlib')

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
  const sections = []
  const agent = {
    id, status,
    session: { id, header: { cwd } },
    calls,
    sections,
    followup(m) { calls.push({ mode: 'followup', message: m }) },
    inject(m) { calls.push({ mode: 'inject', message: m }) },
    steer(m) { calls.push({ mode: 'steer', message: m }) },
  }
  // 按 agent 作用域注册 system prompt 段的成例（DSH 第一方 dsh-file-reference-local 就是这么写的）：
  //   agent.ctx.inject(['systemPrompt'], scope => scope.systemPrompt.section({ name, order, text }))
  // 假 agent 只记录注册到了什么 —— 边界段那几条用例就是靠它断言的。
  agent.ctx = {
    inject: (deps, cb) => {
      cb({ systemPrompt: { section: (spec) => { sections.push(spec); return () => {} } } })
      return { dispose: () => {} }
    },
  }
  return agent
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
// 可变：8.75 会往里加一条"只有会话表知道的冷会话"（会话表是成员工作区的那个稳来源）
const sessionRows = [
  { header: { id: A.id, cwd: 'D:\\proj', createdAt: 100 }, live: true, persisted: true },
  { header: { id: DORMANT, cwd: 'D:\\other', createdAt: 200 }, live: false, persisted: true },
]
const sessionQueryService = {
  listSessions: async () => sessionRows,
  // 这个服务在真机上很贵（"几百条要 20 秒"），所以用它来验证「请求路径上有没有等它」：
  // 测试里临时把延迟拉高，看 state 会不会跟着慢。
  readTitleSnapshots: async (ids) => {
    if (titleDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, titleDelayMs))
    return ids.map((id) => ({
      sessionId: id,
      status: 'fulfilled',
      value: { session: { id }, title: { title: '会话标题-' + String(id).slice(-8) } },
    }))
  },
}
let titleDelayMs = 0

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

// 预置一条 pending 记录：**重判的盖章必须落盘**（真机 2026-09-20 照出来的洞 —— 只盖在内存里，
// 磁盘上一条都没有，于是每次启动都把同一批 pending 白验一遍）。这条记录用一个不存在的房间 id，
// 免得它出现在任何按房间聚合的读法里。
const SEED_CHANGE = {
  id: 'chg-rejudge-seed',
  seq: 999001,
  roomId: 'room-rejudge-probe',
  workspaceId: 'D:\\proj',
  files: ['nothing-here.py'],
  declaredBy: A.id,
  ref: null,
  verdict: 'unverified',
  reason: 'no-worktree-found',
  ts: 1,
}
// 第二条种子：**降档**（把假红摘掉）也必须写回。真机 2026-09-25 照出来的洞：重判原来只有
// `if (re.verdict !== VERIFIED) continue` ⇒ contradicted → 未证实 永远写不回去 ——
// 判据修好了、章也盖了，旧红却仍挂在面上。要用真 git 仓库 + 被 .gitignore 排除的文件（真机 data/** 的形状）。
const DOWN_REPO = path.join(os.tmpdir(), 'dsh-chatroom-down-' + Date.now())
await fs.mkdir(path.join(DOWN_REPO, 'data'), { recursive: true })
{
  const runGit = promisify(execFile)
  await runGit('git', ['-C', DOWN_REPO, 'init', '-q'], { windowsHide: true })
  await runGit('git', ['-C', DOWN_REPO, 'config', 'user.email', 't@t.t'], { windowsHide: true })
  await runGit('git', ['-C', DOWN_REPO, 'config', 'user.name', 't'], { windowsHide: true })
  await fs.writeFile(path.join(DOWN_REPO, '.gitignore'), 'data/\n')
  await fs.writeFile(path.join(DOWN_REPO, 'tracked.py'), 'x = 1\n')
  await runGit('git', ['-C', DOWN_REPO, 'add', '.gitignore', 'tracked.py'], { windowsHide: true })
  await runGit('git', ['-C', DOWN_REPO, 'commit', '-qm', 'init'], { windowsHide: true })
  await fs.writeFile(path.join(DOWN_REPO, 'data', 'runtime.json'), '{}\n')
}
const SEED_DOWN = {
  id: 'chg-rejudge-downgrade-seed',
  seq: 999002,
  roomId: 'room-rejudge-probe',
  workspaceId: DOWN_REPO,
  files: ['data/runtime.json'],
  declaredBy: A.id,
  ref: null,
  verdict: 'contradicted',
  reason: 'no-declared-file-shows-any-change',
  ts: 1,
}
await fs.mkdir(HOME, { recursive: true })
await fs.writeFile(path.join(HOME, 'rooms.json'), JSON.stringify({ version: 1, changes: [SEED_CHANGE, SEED_DOWN] }), 'utf8')

apply(ctx)

// 重判在 apply 时立刻跑一次（异步），所以这里等它把章写进盘 —— 不是等它"算出来"。
let seeded = null
for (let i = 0; i < 40 && seeded === null; i++) {
  await new Promise((resolve) => setTimeout(resolve, 100))
  try {
    const raw = JSON.parse(await fs.readFile(path.join(HOME, 'rooms.json'), 'utf8'))
    const found = (raw.changes || []).find((c) => c.id === SEED_CHANGE.id)
    if (found !== undefined && found.rejudgedUnder !== undefined) seeded = found
  } catch { /* 还没落盘 */ }
}
check('重判盖的章**会落盘**（只盖在内存里 = 每次启动白跑一遍 · #3646 后的复验）',
  seeded !== null && seeded.rejudgedUnder === rejudgeStamp(),
  seeded === null ? '磁盘上一直没有 rejudgedUnder' : seeded.rejudgedUnder)

// **降档也要写回**（真机 2026-09-25 · #4835③）：contradicted → 未证实 必须真的落到记录上，
// 而不是"章盖了、判词和 reason 还是旧的"（那正是"改了颜色没改判据"的形状）。
let downgraded = null
for (let i = 0; i < 40 && downgraded === null; i++) {
  await new Promise((resolve) => setTimeout(resolve, 100))
  try {
    const raw = JSON.parse(await fs.readFile(path.join(HOME, 'rooms.json'), 'utf8'))
    const found = (raw.changes || []).find((c) => c.id === SEED_DOWN.id)
    if (found !== undefined && found.rejudgedUnder !== undefined) downgraded = found
  } catch { /* 还没落盘 */ }
}
check('★ 重判**降档**也写回：假红（contradicted）被摘成未证实',
  downgraded !== null && downgraded.verdict === 'unverified',
  downgraded === null ? '记录没被重判到' : downgraded.verdict)
check('★ 而且 reason **真的换成了新值**（不是只改颜色、留着旧 reason）',
  downgraded !== null && downgraded.reason === 'declared-files-invisible-to-git',
  downgraded === null ? '无' : downgraded.reason)
check('  「从什么改成什么」记下来了（代码形态，供修复循环比较）',
  downgraded !== null && downgraded.rejudgeFrom === 'contradicted'
  && typeof downgraded.rejudgedAt === 'number', downgraded === null ? '无' : [downgraded.rejudgeFrom, downgraded.rejudgedAt])

const rpc = (endpoint, payload) => rpcCalls.handler(endpoint, payload)
const tool = (n) => registered.find((t) => t.name === n)
const exec = (agent) => ({ agent, signal: { throwIfAborted() {} } })
const callsOf = (agent) => agent.calls

console.log('1. 注册面')
check('导出 name/inject', name === 'dsh-chatroom' && inject[0] === 'tools', { name, inject })
check('注册了 9 个工具', registered.length === 9, registered.map((t) => t.name))
for (const n of ['room_status', 'room_message', 'room_task', 'room_say', 'room_judge', 'room_declare_change', 'room_alert', 'room_intent', 'room_owners']) {
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
// 来源形态 = DSH 在两个分支上都**已声明**的 kind（v3 的 { kind:'plugin', plugin:… } 包装在 v4 里
// 被**明确拒绝**：真机 2026-09-23 被唤醒的会话报「format v4 message requires a producer-owned source kind」）。
// 这里那条是**人发的**（面板 say，房间里没有 sessionId）⇒ user 分支；
// 会话发的 agent-message 分支由第 14 节的全量扫描钉住。
check('来源是 v4 认可的形态（人的发言 → user，带 roomId）',
  callsOf(A)[0].message.source.kind === 'user'
  && callsOf(A)[0].message.source.roomId === roomId, callsOf(A)[0].message.source)
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
check('异工作区且无同名文件的 E 既不叫也不推（quiet 默认：连背景都不进上下文）',
  callsOf(E).length === beforeE,
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
check('不 @ 任何人 → 不唤醒（quiet 默认下连背景也不再推；要收全量用 watch=all，见 8.66）',
  quiet.every((c) => c.mode !== 'followup'),
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
check('正文写了「不需要回应」→ 不产生义务、也不推（quiet 默认）',
  afterText.every((c) => c.mode !== 'followup'), afterText.map((c) => c.mode))
check('  返回值说明为什么没唤醒', /没有登记义务/.test(quietText.text), quietText.text)
const bBeforeFlag = callsOf(B).length
const quietFlag = await tool('room_say').execute({ room: mroomId, text: '@1b68df32 只是提到你', wake: false }, exec(A))
const afterFlag = callsOf(B).slice(bBeforeFlag)
check('wake=false → 同样不产生义务、也不推', afterFlag.every((c) => c.mode !== 'followup'),
  afterFlag.map((c) => c.mode))
check('  返回值写明是 wake=false', /wake=false/.test(quietFlag.text), quietFlag.text)
check('  并且**列出被压掉的短号**（#1598：作者常把"提到 N 人"读成"我 @ 成功了"）',
  quietFlag.text.includes('压掉 1 人（1b68df32）'), quietFlag.text)

// 段落级抑制（真机 #1587/#1596/#1597 的重放证据：整条抑制把别处的真提问一起吞了）
const bBeforeScope = callsOf(B).length
const scoped = await tool('room_say').execute({
  room: mroomId,
  text: '@1b68df32 **请把 §2 那行改掉**\n另给某人一条更正（不需要回应）：那是个旧快照\n@aaaabbbb 请裁一句',
}, exec(A))
const afterScope = callsOf(B).slice(bBeforeScope)
check('标记独占一行时，别处的 @ **照常唤醒**（#1587 的形状）',
  afterScope.some((c) => c.mode === 'followup'), afterScope.map((c) => c.mode))
check('  返回值把保住的人列出来', /@ 了 \d+ 人（1b68df32/.test(scoped.text) || scoped.text.includes('1b68df32'), scoped.text)
check('  并且提示"标记只压它所在那一行"',
  scoped.text.includes('只压它所在的那一行'), scoped.text)
// 反向对照：同一个人「这一行通知、那一行提问」→ 保住（去重按"至少一处要回"）
const bBeforeSame = callsOf(B).length
const sameLine = await tool('room_say').execute({
  room: mroomId,
  text: '@1b68df32 这条只是通知（不需要回应）\n@1b68df32 但这条真的要你回一句',
}, exec(A))
check('同一人一行被标记、另一行是提问 → 保住（不因为一处标注丢掉提问）',
  callsOf(B).slice(bBeforeSame).some((c) => c.mode === 'followup'), callsOf(B).slice(bBeforeSame).map((c) => c.mode))
check('  返回值提示「标记只压它所在的那一行」', sameLine.text.includes('只压它所在的那一行'), sameLine.text)

// 引述即提及（真机 #58）：引述里的 @ 不该把人叫起来；自己也不该被自己 @ 到
const bBeforeQuote = callsOf(B).length
await tool('room_say').execute({ room: mroomId, text: '原文写着 `@1b68df32 请确认载荷`（只是引述）' }, exec(A))
const afterQuote = callsOf(B).slice(bBeforeQuote)
check('行内 code 里引述的 @ 不产生义务', afterQuote.every((c) => c.mode !== 'followup'),
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

console.log('8.6 边界进路由：谁被唤醒由「负责哪些路径」决定（房间 P0/P1，真机 2026-09-16）')
// 起因：本房间 5 个会话同工作区 ⇒ 旧实现「同工作区 → 任何改动都算相关」把 5 个人全叫醒，
// 与 §2.2/§6.4/§10 的「M ≤ N，靠确定性预筛收敛」相悖。
// 这条测试是**同一个房间内的 A/B**：先看兜底（没声明边界 → 同工作区即相关），
// 再给 B 声明边界、重复同一次声明 ⇒ B 不该再被叫醒。
const bRoom = await rpc('create-room', { name: '边界路由' })
const bRoomId = bRoom.value.room.room.id
await rpc('join', { roomId: bRoomId, sessionId: A.id, roleName: '实现者' })
await rpc('join', { roomId: bRoomId, sessionId: B.id, roleName: '审计员' })
await rpc('join', { roomId: bRoomId, sessionId: E.id, roleName: '跨工作区' })
const wakesOf = (agent, from) => callsOf(agent).slice(from).filter((c) => c.mode === 'followup').length
// ① 都没声明边界 → 同工作区兜底（旧行为，故意保留：没声明是它自己的洞）
let b0 = callsOf(B).length
let e0 = callsOf(E).length
await tool('room_declare_change').execute({ room: bRoomId, files: ['ulysses/app.py'], summary: '改 app.py' }, exec(A))
check('① 没声明边界 → 同工作区的 B 被兜底唤醒（旧行为）', wakesOf(B, b0) === 1, callsOf(B).slice(b0).map((c) => c.mode))
check('   跨工作区且文件不存在于它的工作区 → E 不叫', wakesOf(E, e0) === 0, callsOf(E).slice(e0).map((c) => c.mode))

// ② B 声明机器可读的边界之后，**同一次声明**不再叫醒它
const intentB = await tool('room_intent').execute({
  room: bRoomId, direction: '负责 web 端点', paths: ['ulysses/web/**'],
}, exec(B))
check('② room_intent 记下结构化边界', intentB.text.includes('机器读的边界 1 条'), intentB.text)
b0 = callsOf(B).length
await tool('room_declare_change').execute({ room: bRoomId, files: ['ulysses/app.py'], summary: '再改 app.py' }, exec(A))
check('   声明过边界且没命中 → B 既不被叫醒，**也不再收到全文注入**（2026-09-16 收窄：推→拉）',
  wakesOf(B, b0) === 0 && callsOf(B).slice(b0).length === 0,
  callsOf(B).slice(b0).map((c) => c.mode))
// 收录范围（用户 2026-09-16：默认 quiet，审计方 watch=all）
const eQuiet = callsOf(E).length
await tool('room_say').execute({ room: bRoomId, text: '一条纯背景发言，不点名任何人' }, exec(A))
check('默认档（quiet）：别人的闲聊不再推到未声明 watch 的人面前',
  callsOf(E).slice(eQuiet).length === 0, callsOf(E).slice(eQuiet).map((c) => c.mode))
await tool('room_intent').execute({ room: bRoomId, direction: '审计席：全量收录', watch: 'all' }, exec(E))
const eAll = callsOf(E).length
await tool('room_say').execute({ room: bRoomId, text: '再一条纯背景发言' }, exec(A))
check('观察者席（watch=all）：同样的闲聊照收（零义务的背景通道）',
  callsOf(E).slice(eAll).some((c) => c.mode === 'inject'), callsOf(E).slice(eAll).map((c) => c.mode))
const eHuman = callsOf(E).length
await rpc('say', { roomId: bRoomId, text: '人的一句话（全体要回）' })
check('人的发言一律照推（D4 不受收录范围影响）',
  callsOf(E).slice(eHuman).some((c) => c.mode === 'followup'), callsOf(E).slice(eHuman).map((c) => c.mode))

// ③ 改到它的地盘 → 又叫醒它（不是"声明过边界就永远安静"）
b0 = callsOf(B).length
await tool('room_declare_change').execute({ room: bRoomId, files: ['ulysses/web/app.py'], summary: '改 web/app.py' }, exec(A))
check('③ 命中它的边界 → 照样唤醒', wakesOf(B, b0) === 1, callsOf(B).slice(b0).map((c) => c.mode))

// ④ excludes 优先：它明确说了不碰的，命中也算没关系
await tool('room_intent').execute({
  room: bRoomId, direction: '负责 web，但不碰 web/app.py', paths: ['ulysses/web/**'], excludes: ['ulysses/web/app.py'],
}, exec(B))
b0 = callsOf(B).length
await tool('room_declare_change').execute({ room: bRoomId, files: ['ulysses/web/app.py'], summary: '又改 web/app.py' }, exec(A))
check('④ 命中的是它声明「不碰」的 → 不唤醒（排除优先）', wakesOf(B, b0) === 0, callsOf(B).slice(b0).map((c) => c.mode))

console.log('8.65 观察者/静音席位 —— 收录范围与"有没有领地"是两根轴（真机 #1714）')
// 真机代价：只读审计席一晚被唤醒 10 次、0 次与职责相关；而 room_owners 还建议它"补 paths 就能收敛"
// —— 对"要收全量变更"的席位，那条建议是错的（补了就漏审）。E 在另一个工作区，本来不会被叫。
const watchIntent = await tool('room_intent').execute({ room: bRoomId, direction: '只读审计席（不认领任何路径）', watch: 'all' }, exec(E))
check('room_intent 接受 watch=all，且**不再催** paths',
  watchIntent.text.includes('观察者/审计席') && !watchIntent.text.includes('你没给 paths'), watchIntent.text)
let eWatch = callsOf(E).length
await tool('room_declare_change').execute({ room: bRoomId, files: ['ulysses/whatever.py'], summary: '旁观改动' }, exec(A))
check('  观察者席位收到变更唤醒（连跨工作区也一样）',
  callsOf(E).slice(eWatch).some((c) => c.mode === 'followup'), callsOf(E).slice(eWatch).map((c) => c.mode))
const owWatch = await tool('room_owners').execute({ room: bRoomId, paths: ['ulysses/whatever.py'], workspace: 'D:\\proj' }, exec(A))
const watcherLine = owWatch.text.split('\n').find((l) => l.includes('eeeeffff')) || ''
check('  room_owners 对它写「观察者席位」、不再建议补 paths',
  watcherLine.includes('观察者席位') && !watcherLine.includes('补 room_intent'), watcherLine)
await tool('room_intent').execute({ room: bRoomId, direction: '静音席（不收变更）', watch: 'none' }, exec(E))
eWatch = callsOf(E).length
await tool('room_declare_change').execute({ room: bRoomId, files: ['ulysses/whatever.py'], summary: '再看一次' }, exec(A))
check('  静音席位不再被叫（背景通道仍收得到）',
  callsOf(E).slice(eWatch).every((c) => c.mode !== 'followup'), callsOf(E).slice(eWatch).map((c) => c.mode))
const stWatch = await tool('room_status').execute({ room: bRoomId }, exec(A))
const watchLines = stWatch.text.split('\n').filter((l) => l.includes('静音席位') || l.includes('观察者席位')).join(' | ')
check('room_status 把「按设计不认领」写成静音/观察者，而不是「⚠ 未声明边界」',
  stWatch.text.includes('静音席位') && !watchLines.includes('未声明边界'), watchLines)

console.log('8.67 只收不答席 watch=feed —— 全推、但不产生义务（真机 #1798 补的那个角）')
// 缺的那一格：既有的三档里，`all`=全推+每条都唤醒、`quiet`=不推、`none`=不推且不叫；
// 「要看得见、但不必每条都应一声」表达不出来 —— 于是第二类观察席只能二选一（每小时几十次无谓回合，或看不见）。
const feedIntent = await tool('room_intent').execute(
  { room: bRoomId, direction: '安全审计席：要看得见，不必每条都应一声', watch: 'feed' }, exec(E))
check('room_intent 接受 watch=feed，并说清「不产生义务」',
  feedIntent.text.includes('只收不答席') && feedIntent.text.includes('不产生义务'), feedIntent.text)
eWatch = callsOf(E).length
await tool('room_declare_change').execute({ room: bRoomId, files: ['ulysses/whatever.py'], summary: '安全席看一眼这次改动' }, exec(A))
const feedCalls = callsOf(E).slice(eWatch)
check('  变更通知照推（走背景通道 inject）', feedCalls.some((c) => c.mode === 'inject'), feedCalls.map((c) => c.mode))
check('  但**不产生义务**（没有 followup「你必须回一句」）',
  feedCalls.length > 0 && feedCalls.every((c) => c.mode !== 'followup'), feedCalls.map((c) => c.mode))
const owFeed = await tool('room_owners').execute({ room: bRoomId, paths: ['ulysses/whatever.py'], workspace: 'D:\\proj' }, exec(A))
const feedLine = owFeed.text.split('\n').find((l) => l.includes('eeeeffff')) || ''
check('  room_owners 写明它是只收不答（不是「看不见」，也不是「观察者席位」）',
  feedLine.includes('只收不答') && feedLine.includes('不产生义务'), feedLine)
const stFeed = await tool('room_status').execute({ room: bRoomId }, exec(A))
check('  room_status 单独一档显示', stFeed.text.includes('只收不答席（变更全推、不产生义务）'),
  stFeed.text.split('\n').find((l) => l.includes('eeeeffff')))
// 复原成 none —— 后面的 8.7/8.75 按「它是不叫醒的席位」写断言。
await tool('room_intent').execute({ room: bRoomId, direction: '静音席（不收变更）', watch: 'none' }, exec(E))

console.log('8.67b watch=none 那句括号说的是**哪条通道**（真机 #1824，S7 报的措辞歧义）')
// 那句话出现在 room_owners 里，读者会读成「**声明**里 @ 我仍会叫到我」—— 而声明通道的义务
// 只来自 related(=wouldWake) ∪ overreach（正文里的 @ 根本不参与）。把两条通道各自钉一条行为断言：
eWatch = callsOf(E).length
await tool('room_declare_change').execute(
  { room: bRoomId, files: ['ulysses/whatever.py'], summary: '@eeeeffff 这条是**声明**：正文里 @ 了它' }, exec(A))
check('  声明正文里的 @ 不产生义务（静音席什么都不收）',
  callsOf(E).slice(eWatch).length === 0, callsOf(E).slice(eWatch).map((c) => c.mode))
eWatch = callsOf(E).length
await tool('room_say').execute({ room: bRoomId, text: '@eeeeffff 这条是**普通发言**：@ 才真的叫到你' }, exec(A))
check('  普通发言里的 @ 会叫到它（这才是那句括号的意思）',
  callsOf(E).slice(eWatch).some((c) => c.mode === 'followup'), callsOf(E).slice(eWatch).map((c) => c.mode))
const owNone = await tool('room_owners').execute({ room: bRoomId, paths: ['ulysses/whatever.py'], workspace: 'D:\\proj' }, exec(A))
const noneLine = owNone.text.split('\n').find((l) => l.includes('eeeeffff')) || ''
check('  room_owners 那句写清了是哪条通道',
  noneLine.includes('普通发言') && noneLine.includes('声明正文里的 @ 不算'), noneLine)

console.log('8.67c 唤醒席 watch=wake —— 会被叫醒，但**不登记义务**（真机 #1920，用户提的需求）')
// 三根轴（推不推 × 叫不叫醒 × 要不要回）里唯一还没落地的角：`all` 把「叫醒」与「必须回」绑成了一件事，
// 于是自动审计席只有两难 —— 每小时被叫 26 次且每次必回（回执很快退化成走过场），或者一次都不醒。
const wakeIntent = await tool('room_intent').execute(
  { room: bRoomId, direction: '自动审计席：醒过来看一眼就行，不必写话', watch: 'wake' }, exec(E))
check('room_intent 接受 watch=wake，并说清「会叫醒 / 不登记义务」',
  wakeIntent.text.includes('唤醒席') && wakeIntent.text.includes('不登记回执义务'), wakeIntent.text)
let eWake = callsOf(E).length
const declWake = await tool('room_declare_change').execute({ room: bRoomId, files: ['ulysses/whatever.py'], summary: '唤醒席试一次' }, exec(A))
const wakeCalls = callsOf(E).slice(eWake)
check('  被**叫醒**了（followup，而不是背景 inject）',
  wakeCalls.some((c) => c.mode === 'followup'), wakeCalls.map((c) => c.mode))
const wakeFrame = ((wakeCalls.find((c) => c.mode === 'followup') || {}).message || { content: [{ text: '' }] }).content[0].text
check('  帧里**明说不用回**，且**没有**「你必须回一句」',
  wakeFrame.includes('不要求回执') && !wakeFrame.includes('你必须回一句'), wakeFrame.slice(0, 220))
const owWake = await tool('room_owners').execute({ room: bRoomId, paths: ['ulysses/whatever.py'], workspace: 'D:\\proj' }, exec(A))
const wakeLine = owWake.text.split('\n').find((l) => l.includes('eeeeffff')) || ''
check('  room_owners 单列一桶「会唤醒但**不必回**」',
  owWake.text.includes('会唤醒但**不必回**（1 人') && wakeLine.includes('不登记回执义务'), owWake.text)
const stWakeLine = (await tool('room_status').execute({ room: bRoomId }, exec(A))).text.split('\n').find((l) => l.includes('eeeeffff')) || ''
check('  room_status 单列一档', stWakeLine.includes('唤醒席（变更全推 + 会叫醒，但不必回执）'), stWakeLine)
// **对照**：同一个情形换成 all ⇒ 拿到的帧必须带「你必须回一句」（否则这一档就白加了）
await tool('room_intent').execute({ room: bRoomId, direction: '审计席：每条都回', watch: 'all' }, exec(E))
eWake = callsOf(E).length
await tool('room_declare_change').execute({ room: bRoomId, files: ['ulysses/whatever.py'], summary: '对照：all 档' }, exec(A))
const allFrame = ((callsOf(E).slice(eWake).find((c) => c.mode === 'followup') || {}).message || { content: [{ text: '' }] }).content[0].text
check('  对照：all 档同一情形**必须回**', allFrame.includes('你必须回一句'), allFrame.slice(0, 200))
// 复原成 none —— 后面的 8.7/8.75 按「它是不叫醒的席位」写断言。
await tool('room_intent').execute({ room: bRoomId, direction: '静音席（不收变更）', watch: 'none' }, exec(E))
void declWake

console.log('8.68 成员边界进**自己的** system prompt（真机 #1732）')
// 起点：方向此前只活在房间侧 + 被叫醒那一帧的帧尾 ⇒ 自己开工 / 用户直接对话 / 新窗口第一轮都看不到自己的边界。
// 做法：把一条 section 注册进**这个 agent 自己的作用域**，且 text() 每次组装现算。
const secB2 = B.sections.find((s) => s.name === 'chatroom:boundary')
check('投递时给成员装上了 chatroom:boundary 段（按 agent 作用域，不是全局）',
  secB2 !== undefined, B.sections.map((s) => s.name))
check('  段文本读的是**活状态**（此刻列出 B 所在的房间与边界）',
  secB2 !== undefined && typeof secB2.text === 'function' && secB2.text().includes('边界路由'),
  secB2 === undefined ? '(没装上)' : secB2.text().slice(0, 160))
await tool('room_intent').execute({ room: bRoomId, direction: '改过的方向：只看 web', watch: 'all' }, exec(B))
check('  —— 改方向后，同一个段（没重装）的 text() 就是新的',
  secB2 !== undefined && secB2.text().includes('改过的方向'), secB2 === undefined ? '' : secB2.text().slice(0, 140))
check('  段里带机器读的边界与收录范围',
  secB2 !== undefined && secB2.text().includes('ulysses/web/**') && secB2.text().includes('收录范围'),
  secB2 === undefined ? '' : secB2.text().slice(0, 200))
// 段文本按房间逐条算：被移出**这个**房间后，那一条要消失（其余房间照旧）——
// 完全不出现（空串）只发生在"一个房间都不在"的时候，那是空段自动消失那一档。
await rpc('set-enabled', { roomId: bRoomId, sessionId: B.id, enabled: false })
check('被移出这个房间后，段里那一条就没了（其余房间不受影响）',
  secB2 !== undefined && !secB2.text().includes('边界路由') && secB2.text().includes('变更同步'),
  secB2 === undefined ? '' : secB2.text().slice(0, 160))
await rpc('set-enabled', { roomId: bRoomId, sessionId: B.id, enabled: true })
check('加回来又有内容', secB2 !== undefined && secB2.text().includes('边界路由'),
  secB2 === undefined ? '' : secB2.text().slice(0, 80))
// 拼串的边界（真机 #1772 由 255563de 报来）：段是 `你的方向：<散文>；收录范围：…` 直接拼的，
// 散文自己以句号结尾时就会印出「…负责人。；你负责：…」这种"。；"。只剥尾部标点。
await tool('room_intent').execute({ room: bRoomId, direction: '负责 web 端点的收尾。', watch: 'quiet' }, exec(B))
const secDot = secB2 === undefined ? '' : secB2.text()
check('散文以句号结尾 → 段里不出现「。；」', !secDot.includes('。；') && secDot.includes('负责 web 端点的收尾'), secDot)
check('  句号也不许变成「…。；收录范围」以外的怪形（分隔符照旧只有一个）',
  (secDot.match(/收尾[；;。]/g) || []).length === 1, secDot)
await tool('room_intent').execute({ room: bRoomId, direction: '。', watch: 'quiet' }, exec(B))
const secOnly = secB2 === undefined ? '' : secB2.text()
check('散文只有标点（剥完为空）→ 按「还没声明方向」走，不印空的「你的方向：；」',
  secOnly.includes('你还没声明方向（先调 room_intent）') && !secOnly.includes('你的方向：；'), secOnly)
// 复原 B 的方向/边界/watch —— 后面的 8.7 依赖它"paths 命中但 excludes 挡住"这个形状。
// ⚠ watch 必须**显式**给回 quiet：setSelfDescription 的规矩是"不传就保留上一次"（与 paths 同），
// 而上面刚把它设成过 all；不显式复位，8.7 就会看到一个"观察者席位"（我第一版就是这么错的）。
await tool('room_intent').execute({
  room: bRoomId, direction: '负责 web，但不碰 web/app.py', paths: ['ulysses/web/**'],
  excludes: ['ulysses/web/app.py'], watch: 'quiet',
}, exec(B))

console.log('8.7 room_owners：动手之前查边界，且与唤醒判定同源')
const owners = await tool('room_owners').execute({ room: bRoomId, paths: ['ulysses/app.py'], workspace: 'D:\\proj' }, exec(A))
check('列出会唤醒的人', owners.text.includes('会唤醒**且要回**（0 人') || owners.text.includes('会唤醒**且要回**（1 人'), owners.text)
check('  没给结构化边界的人带原因，且说明"自己声明不会叫醒自己"',
  owners.text.includes('没给结构化边界 → 回落「同工作区即相关」')
  && owners.text.includes('自己声明不会叫醒自己'), owners.text)
// B 在 ④ 里声明了 excludes web/app.py ⇒ 查这个路径时它该出现在"不会被唤醒"并给出原因
const owners2 = await tool('room_owners').execute({ room: bRoomId, paths: ['ulysses/web/app.py'], workspace: 'D:\\proj' }, exec(A))
check('  命中它声明「不碰」的路径 → 进"不会被唤醒"并给原因',
  owners2.text.includes('不会被唤醒') && owners2.text.includes('1b68df32') && owners2.text.includes('不碰'), owners2.text)
// 换一个真属于 B 的路径：它该出现在会唤醒名单，并提示先 @ 负责人
const owners3 = await tool('room_owners').execute({ room: bRoomId, paths: ['ulysses/web/other.js'], workspace: 'D:\\proj' }, exec(A))
check('  命中它的边界 → 进"会唤醒"并提示先 @ 负责人',
  owners3.text.includes('会唤醒**且要回**（1 人') && owners3.text.includes('1b68df32') && owners3.text.includes('别悄悄改'), owners3.text)
// **同源检查**：查询说会叫醒谁，room_declare_change 就真叫醒谁（同一个函数，不许两张表各说各话）
b0 = callsOf(B).length
await tool('room_declare_change').execute({ room: bRoomId, files: ['ulysses/web/other.js'], summary: '同源核对' }, exec(A))
check('  同源：查询说会叫醒 1 人（B），声明就真的只叫醒 1 人',
  owners3.text.includes('会唤醒**且要回**（1 人') && wakesOf(B, b0) === 1, { owner: owners3.text.split('\n')[1], woke: wakesOf(B, b0) })

console.log('8.75 成员工作区：**未知 ≠ 不在**（真机 #1756 —— 同一个提问、两次相反的答案）')
// 真机：`room_owners(paths=["ulysses/app.py"])` 23:57 说「会唤醒 0 人」、00:06 说 3 人，参数一字未改。
// 差别只在那一刻 6126bf05 有没有活 Agent —— 当时唯一的工作区来源就是活 Agent：
// 取不到 ⇒ 静默不叫，还把理由写成「不在它的工作区里」（**断言一个它并不知道的事实**）。
// 现在两条都改：① 加会话表这一源（与存活无关）；② 取不到 ⇒ 按保守口径照样叫 + 如实说「未知」。
const F = fakeAgent('session-fff00000-1111-2222-3333-444455556666') // 只用来拿 id，不进 live 表
const shortOf = (id) => id.replace(/^session-/, '').slice(0, 8)
// 房间默认上限 5 人（DEFAULT_MAX_MEMBERS），而这一段要再进 3 个；
// 顺带记一笔：**join 撞上限时只是 ok:false**（不抛），所以下面每个 join 都核对返回值 ——
// 第一版就是漏了这一步，DORMANT 静默没进房间，③ 才以「查不到那一行」的形式失败。
const pol8 = await rpc('set-policy', { roomId: bRoomId, maxMembers: 8 })
check('  先把成员上限抬到 8（否则第 3 个 join 会静默失败）', pol8.ok === true, pol8)
sessionRows.push({ header: { id: F.id, cwd: 'D:\\proj', createdAt: 300 }, live: false, persisted: true })
const jF = await rpc('join', { roomId: bRoomId, sessionId: F.id, roleName: '只有会话表知道它' })
check('  join F（只有会话表知道它）', jF.ok === true, jF)
await tool('room_intent').execute({ room: bRoomId, direction: '负责 app.py（冷会话）', paths: ['ulysses/app.py'], watch: 'quiet' }, exec(F))
const jC = await rpc('join', { roomId: bRoomId, sessionId: C.id, roleName: '谁都查不到它' })
check('  join C（哪个源都查不到它）', jC.ok === true, jC)
await tool('room_intent').execute({ room: bRoomId, direction: '负责 app.py（分布未知）', paths: ['ulysses/app.py'], watch: 'quiet' }, exec(C))
const jD = await rpc('join', { roomId: bRoomId, sessionId: DORMANT })
check('  join DORMANT（会话表说它在别的仓库）', jD.ok === true, jD)
await tool('room_intent').execute({ room: bRoomId, direction: '别的工作区也有一份', paths: ['ulysses/app.py'], watch: 'quiet' },
  exec(fakeAgent(DORMANT, 'idle', 'D:\\other')))
const ow176 = await tool('room_owners').execute({ room: bRoomId, paths: ['ulysses/app.py'], workspace: 'D:\\proj' }, exec(A))
const lineOf176 = (id) => ow176.text.split('\n').find((l) => l.includes('[' + shortOf(id) + ']')) || ''
check('① 会话表这一源：冷会话也按工作区命中（改前会被静默丢掉）',
  lineOf176(F.id).includes('命中结构化边界') && !lineOf176(F.id).includes('未知'), lineOf176(F.id))
check('② 工作区取不到 ⇒ 保守口径叫它，并如实说「未知」',
  lineOf176(C.id).includes('未知') && lineOf176(C.id).includes('命中结构化边界'), lineOf176(C.id))
check('  且不再写「不在它的工作区里」（那是它不知道的事实）',
  !lineOf176(C.id).includes('不在它的工作区里'), lineOf176(C.id))
check('③ 已核对确实在别的仓库 ⇒ 仍然不误伤', lineOf176(DORMANT).includes('不在它的工作区里'), lineOf176(DORMANT))
check('  表尾有 ⚠ 汇总（别把「取不到」读成「没人负责」）',
  ow176.text.includes('工作区**取不到**'), ow176.text.split('\n').slice(-1)[0])
check('  查询说会唤醒 2 人（F 与 C；A 是调用者自己、B 不命中、E 是静音席）',
  ow176.text.includes('会唤醒**且要回**（2 人'), ow176.text.split('\n')[1])
// **同源**：查询说会叫醒谁，声明就真叫醒谁（同一个函数，不许两张表各说各话）—— 冷会话也在名单里。
const w0 = callsOf(A).length
const decl176 = await tool('room_declare_change').execute({ room: bRoomId, files: ['ulysses/app.py'], summary: '同源核对（含冷会话）' }, exec(A))
check('  同源：声明也叫醒 2 人（冷会话照样进名单）', decl176.text.includes('已唤醒 2 名'), decl176.text)
void w0

// 提案 B / P2（真机 #4866/#4870）：**越界判定也要带工作区** —— 同一个相对路径、不同工作区的成员，
// 不该收到 ⚠（DORMANT 的 `ulysses/app.py` 在 D:\other，A 声明的是 D:\proj 那一份）。
const p2decl = await tool('room_declare_change').execute({ room: bRoomId, files: ['ulysses/app.py'], summary: 'P2：异工作区不误伤' }, exec(A))
const p2msg = await tool('room_message').execute({ room: bRoomId, seq: p2decl.seq }, exec(A))
const warn176 = (p2msg.text.split('\n').find((l) => l.includes('可能越界')) || '')
check('P2 异工作区的成员**不在 ⚠ 行里**（同 token、不同仓库）',
  warn176 !== '' && !warn176.includes(shortOf(DORMANT)), warn176)
check('  同工作区 / 工作区未知的成员照旧收到 ⚠（判定没被砍空）',
  warn176.includes(shortOf(F.id)) && warn176.includes(shortOf(C.id)), warn176)
// 提案 B / P3：裸文件名 token（没有 `/`）**当场回给作者**，而不是等它变成别人帧里的 ⚠。
const bareIntent = await tool('room_intent').execute(
  { room: bRoomId, direction: '裸名边界试试', paths: ['README.md'], watch: 'quiet' }, exec(E))
check('P3 裸文件名 token 当场回给作者（带例子与两种写法）',
  bareIntent.text.includes('没有 `/`') && bareIntent.text.includes('docs/README.md'), bareIntent.text)

console.log('8.95 **作者撤回** —— 事后销账（真机 #2131③）')
// 背景：@ 被抑制后重发成新 seq，原 seq 的债会永久留在旧账里；目标只能白花一轮去 judge 它。
// 现在给作者一个机器动作：room_say({ retracts: [seq] })。
const rc = await rpc('create-room', { name: '撤回' })
const rcId = rc.value.room.room.id
await rpc('join', { roomId: rcId, sessionId: A.id })
await rpc('join', { roomId: rcId, sessionId: B.id })
const said0 = await tool('room_say').execute({ room: rcId, text: '@1b68df32 你看一下这条' }, exec(A))
let rcSt = await tool('room_status').execute({ room: rcId }, exec(A))
check('@ 到的人欠这条', rcSt.text.includes('待表态（靶子 #' + said0.seq + '）') && rcSt.text.includes('1b68df32'),
  rcSt.text.split('\n').filter((l) => l.includes('待表态')).join(' | '))
const bWake0 = callsOf(B).length
const badRetract = await tool('room_say').execute({ room: rcId, text: '我想撤掉别人的', retracts: [said0.seq], wake: false }, exec(B))
check('非作者撤不动（明确拒绝，不静默）', badRetract.text.includes('没撤回') && badRetract.text.includes('不是你发的'), badRetract.text)
void bWake0
const goodRetract = await tool('room_say').execute({ room: rcId, text: '刚才那条作废', retracts: [said0.seq], wake: false }, exec(A))
check('作者撤回：返回里说清销了哪条', goodRetract.text.includes('已撤回 #' + said0.seq + ' 的义务'), goodRetract.text)
// 作者自己收不到自己那条（fanout 跳过作者）、B 是 quiet 档也只走「拉」⇒ 从房间里读它。
const stored = await tool('room_message').execute({ room: rcId, seq: goodRetract.seq }, exec(A))
check('  正文带机器标记（别人不用去猜散文）',
  stored.text.indexOf('〔已撤回 #' + said0.seq + ' 的义务') >= 0, stored.text.replace(/\s+/g, ' ').slice(0, 160))
rcSt = await tool('room_status').execute({ room: rcId }, exec(A))
check('撤回后那条从账上消失', !rcSt.text.includes('靶子 #' + said0.seq), rcSt.text.split('\n').slice(-2).join(' | '))

console.log('8.96 通配直觉的**静默失效**要当场喊一声（真机 #3169）')
// `*`/`?` 不是通配符：写成 `ulysses/web/*.js` 会按**字面前缀**匹配 ⇒ 永远不命中、且此前毫无提示。
// 喊出来的位置选在 room_intent 的返回里 —— 声明者当场就能改，不用等一次误唤醒之后才发现。
const globIntent = await tool('room_intent').execute(
  { room: rcId, direction: '测试：排除用通配直觉写法', excludes: ['ulysses/web/*.js'], watch: 'quiet' }, exec(A))
check('点出「像通配却永不命中」的条目',
  globIntent.text.includes('不是通配符') && globIntent.text.includes('ulysses/web/*.js'), globIntent.text)
const cleanIntent = await tool('room_intent').execute(
  { room: rcId, direction: '测试：正常写法', excludes: ['ulysses/web/**'], watch: 'quiet' }, exec(A))
check('  正常写法（`**` 结尾）不喊', !cleanIntent.text.includes('不是通配符'), cleanIntent.text)

console.log('8.8 人的发言也能定向（P5）与边界的可视化（P6）')
// 不 @ → 全体（D4 不变）；@ 了 → 只有被点的人欠回执
let hum = await rpc('say', { roomId: bRoomId, text: '全体都看一下' })
const humSeq1 = hum.value.message.seq
const stHum1 = await tool('room_status').execute({ room: bRoomId }, exec(A))
check('人发言不 @ → 全体欠（靶子就是这条）',
  stHum1.text.includes('待表态（靶子 #' + humSeq1 + '）'), stHum1.text)
hum = await rpc('say', { roomId: bRoomId, text: '@1b68df32 只看你这一份' })
const humSeq2 = hum.value.message.seq
const stHum2 = await tool('room_status').execute({ room: bRoomId }, exec(A))
const pendingLine = stHum2.text.split('\n').find((l) => l.includes('待表态（靶子 #' + humSeq2 + '）')) || ''
check('人发言 @ 了谁 → 只叫谁（人数不再等于每条消息的成本）',
  pendingLine.includes('1b68df32') && !pendingLine.includes('83d4e6de'), pendingLine)
check('room_status 把边界摆出来（谁负责哪些路径）',
  stHum2.text.includes('边界 ulysses/web/**'), stHum2.text.split('\n').filter((l) => l.includes('边界')).join(' | '))
check('  未声明边界的人被标出来（它是边界图上的洞）',
  stHum2.text.includes('未声明边界'), stHum2.text)

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

console.log('11. 源码绊线：历史重判必须走**同一套**仓库路由（#1454 那个假红就是"两条路各写各的"）')
// 这条只能做源码级绊线：重判由插件内部的 10 秒定时器驱动，host 测试里没有可调的钩子。
// 它抓的形状很具体 —— 重判路径直接拿 change.workspaceId（上一次核验的答案）去解析 ref，
// 于是"交付物在旁仓"的声明永远重判不回来（真机 2026-09-16 #1454/#1458）。
const indexSrc = await fs.readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
// 窗口用**下一个循环**当结尾，不再是一个固定字数：这段代码会继续长，而字数上限会静默地
// 把后面那些行挤出窗口 —— 真机上就是这么把「former 在改写前读」那条绊线打红的（2026-09-20）。
const rejudgeStart = indexSrc.indexOf('for (const change of pending)')
const rejudgeEnd = indexSrc.indexOf('for (const change of store.state.changes)', rejudgeStart)
// 找不到结尾锚点就**当场红**，不再退回一个字数上限（837e0518 #3634④ 提的那一处）：
// 字数上限会让断言随代码长度**静默**失真 —— 真机 2026-09-20 就是这么把「former 在改写前读」挤出窗口的。
// 退回"到文件末尾"是安全的：窗口只会变宽，而变宽只可能让 includes 更容易成立。
check('  重判路径的结尾锚点还在（结构变了要红，别让窗口被悄悄截断）', rejudgeEnd > rejudgeStart, { rejudgeStart, rejudgeEnd })
const rejudgeBlock = indexSrc.slice(rejudgeStart, rejudgeEnd > rejudgeStart ? rejudgeEnd : indexSrc.length)
// 判定输入的装配（锚点 / ref / 路由）住在一个**独立模块**里（lib/rejudge.js）—— 独立成文件，
// 它的**字节**才进得了自动挡的摘要（837e0518 #3638②/#3641）。循环体只负责"拿输入、调一回、盖章"。
const rejudgeSrc = await fs.readFile(new URL('../lib/rejudge.js', import.meta.url), 'utf8')
const inputsAt = rejudgeSrc.indexOf('export async function rejudgeInputs(change, starts)')
const inputsBlock = rejudgeSrc.slice(inputsAt, inputsAt + 1600)
check('重判路径先按声明文件定位仓库',
  inputsBlock.includes('await resolveWorktree({ workspace: change.workspaceId'),
  inputsBlock.slice(0, 200))
// 只收 contradicted 会漏掉**假阴性**（未证实）—— 那条 bug 把它判成「不在 git 仓库内」，
// 而它不会被任何东西自愈（我自己那条 #1472 就是这么留下来的，2026-09-16）
check('  重判同时收「与事实不符」与「未证实」两类',
  indexSrc.includes("c.verdict === 'contradicted' || c.verdict === 'unverified'"),
  '筛选条件里应当同时出现 contradicted 与 unverified')
// 绊线只钉**意图**（former 在改写前读），不再钉那一行的字面量：2026-09-25 那一版把
// "未证实"这个**标签**换成**代码**存进 rejudgeFrom（下面的修复循环按代码比较，两边才对得上），
// 于是旧的字面量断言自己红了 —— 它钉的是实现细节，不是它想守的那件事。
check('  「从什么改成什么」的 former 在改写前读（否则会写出 verified → 已证实 这种胡话）',
  (() => {
    const fromAt = rejudgeBlock.indexOf('const from = change.verdict')
    const writeAt = rejudgeBlock.indexOf('change.verdict = re.verdict')
    return fromAt >= 0 && writeAt > fromAt
  })(), rejudgeBlock.slice(0, 260))
check('  判词用中文标签渲染（存代码、渲染标签，不混用）',
  rejudgeBlock.includes('DECL_LABELS'), rejudgeBlock.slice(0, 260))
// ★ 这一条钉的是 2026-09-25 修掉的那个洞（837e0518 #4835③ 让我核的）：
// 原来只有 `if (re.verdict !== VERIFIED) continue` ⇒ contradicted → 未证实 永远写不回去，
// 判据修好了、章也盖了，旧红仍挂在面上。行为层面由上面那条种子记录覆盖，这里钉死形状不许回退。
// 判"旧那一行还在不在"时**必须带缩进**：注释里也引用了那句原文，只说 includes 会被自己的注释打红。
check('★ 重判不只写回"翻成已证实"（降档也要写回，否则假红永不闭合）',
  !rejudgeBlock.includes('\n        if (re.verdict !== VERIFIED) continue')
  && rejudgeBlock.includes('if (re.verdict === change.verdict && re.reason === change.reason) continue'),
  rejudgeBlock.slice(0, 300))
check('  并把解析后的 workspace/files 交给 verifyDeclaration',
  inputsBlock.includes('workspace: resolved.workspace,') && inputsBlock.includes('files: resolved.files,')
  && rejudgeBlock.includes('await verifyDeclaration(inputs)'),
  inputsBlock.slice(0, 200))
// 判据版本（2026-09-20 自查出来的）：队列以前取「前 20 条」，而**判对了的红**永远留在队列里 ⇒
// 队列只涨不落：超过 20 条之后，一条排在末尾的**新假红**再也轮不到重判 —— 自愈就静默失效了
// （真机当天量到 12 条，只剩 8 格）。
// #3641 的一行的洞（837e0518 用变异跑出来的）：上面这些断言只看"字符串在不在"——
// 把 `const stamp = rejudgeStamp()` 换成 `const stamp = 'v' + REJUDGE_VERSION` 之后，
// 那些字符串**仍然全在**（定义还摆着，只是没人用），整套照样绿，而两段自动挡已经没了。
// 所以接线那一行必须单独守；"值对不对"由 tests/gitcheck.mjs 第 14 节逐段独立算出来对账。
//
// #3646 的 A3 补上了这条绊线的一个缺口：在**同一作用域**里写 `const rejudgeStamp = () => 'v1'` 遮蔽导入，
// 调用那一行的**文本一字不改** ⇒ 只看"文本在不在"的断言照样绿。
// 顺带否掉一个更省的想法（"这个标识符出现次数 == 2"）：index.js 里本来就有一句注释提到它，
// 计数版**当场就是错的**。文本绊线挡得住的是改名/内联/遮蔽这类现实改动，挡不住刻意构造的形状 ——
// 这是它的固有边界，所以这里三件事一起查（调用文本 / 无本地同名定义 / 真的从 rejudge.js 导入）。
check('  接线真的调 rejudgeStamp()，且没有本地同名遮蔽（#3646 的 A3）',
  /const stamp = rejudgeStamp\(\)/.test(indexSrc)
  && !/(?:const|let|var|function|class)\s+rejudgeStamp\b/.test(indexSrc)
  && indexSrc.includes("import { REJUDGE_BATCH, rejudgeInputs, rejudgeStamp } from './rejudge.js'"),
  '三者缺一不可：调用文本 / 无本地同名定义 / 真的从 rejudge.js 导入')
check('  按**判据指纹**盖章，不取「前 20 条」（否则新假红会被前面的堵死）',
  indexSrc.includes('.filter((c) => c.rejudgedUnder !== stamp)'),
  '那条 filter 缺了就等于没盖章')
// 837e0518 #3634③ + #3638②：章若只是"手工 +1 的常量"就会忘；而只盖 lib/gitcheck.js 又漏掉
// index.js 这边装配的判据（锚点 / ref / 路由 —— #1454/#1458 修的**正是**这里）。
// 所以章是**复合**的：两段自动挡（gitcheck 字节 + rejudgeInputs 源码）+ 一段手工挡（兜底/扳机）。
check('  章在 lib/rejudge.js 里装配（两段自动挡 + 一段手工挡）',
  rejudgeSrc.includes('export function rejudgeStamp()')
  && rejudgeSrc.includes("(criteriaFingerprint() || 'g0') + '|' + assemblyFingerprint() + '|v' + REJUDGE_VERSION"),
  rejudgeSrc.slice(rejudgeSrc.indexOf('export function rejudgeStamp'), rejudgeSrc.indexOf('export function rejudgeStamp') + 200))
check('  自动挡覆盖 index.js 那边的判据：锚点/ref/路由都在 rejudgeInputs 里，模块字节进章',
  inputsAt > 0 && inputsBlock.includes("ref: typeof change.ref === 'string'")
  && rejudgeSrc.includes('export function assemblyFingerprint'),
  { inputsAt })
check('  翻没翻都盖章（判据没变就不必把同样的 git 再跑一遍）',
  rejudgeBlock.includes('change.rejudgedUnder = stamp'), rejudgeBlock.slice(0, 400))
const anchorSkip = rejudgeBlock.indexOf('if (inputs === null) continue')
const stampAt = rejudgeBlock.indexOf('change.rejudgedUnder = stamp')
check('  拿不到锚点时**不盖章**（会话表可能还没挂载完，下次还要再试）',
  anchorSkip >= 0 && stampAt > anchorSkip && !rejudgeBlock.slice(anchorSkip, stampAt).includes('rejudgedUnder'),
  { anchorSkip, stampAt })
check('  一批用满额度就不收工（留给下一次 tick，不让后面的记录饿死）',
  rejudgeBlock.includes('if (examined >= REJUDGE_BATCH) break')
  && indexSrc.includes('examined < REJUDGE_BATCH'), rejudgeBlock.slice(0, 160))

console.log('12. state 不在请求路径上取标题（真机 2026-09-16：往返中位 890ms，而插件自身只要 15ms）')
// 真机读数：候选 中位894ms/14KB 与 拉取 中位890ms 几乎相等、载荷差 14 倍 ⇒ 不是载荷、不是处理器；
// 两条 RPC 共用的只有 readTitleSnapshots（state 给成员取、candidates 给 45 个会话取）。
// 这里把那个服务拖慢，验证 state 不再等它。
titleDelayMs = 400
const tState = Date.now()
const stSlow = await rpc('state', {})
const dtState = Date.now() - tState
check('标题服务慢 400ms 时 state 仍然快（标题只读缓存 + 后台预热）', dtState < 150, { ms: dtState })
check('  载荷里带主机自报耗时（面板据此把"通道"与"我"分开）',
  stSlow.ok === true && stSlow.value.ms !== undefined && typeof stSlow.value.ms.total === 'number',
  stSlow.ok === true ? stSlow.value.ms : stSlow)
titleDelayMs = 0
await new Promise((resolve) => setTimeout(resolve, 500)) // 等后台预热收尾，别影响后面的用例

console.log('13. 会话目录的读法：**认得出名字**、**数得全帧**（DSH 0.1.7-alpha.2 的适配）')
// 真机形状（2026-09-23 升级后照出来的）：
//  · 0.1.7 写的是 session.v4.jsonl.zstd，而候选名单停在 v3 ⇒ 名字认不出 ⇒ bytes=0 ⇒ 判成"空会话"；
//  · 更根本的一条：日志是**多帧**的（每次 flush 一帧），而 Node 的 zstd API **只解第一帧** ——
//    第一帧永远只有 session 头那一行（v3/v4 都一样，实测 8.9MB/104 帧的日志首帧也是 1 行）⇒
//    "解压数行数"这条老判据每次执行都判错。真机上 20 个小日志样本，老规则 **20/20 判错**，
//    新规则与 DSH 自己的口径（blank = seq === 0）**20/20 一致**。
check('文件名认得出 v4（0.1.7 写的就是它）', isSessionLogName('session.v4.jsonl.zstd'))
check('  也认得出 v3 / 无名版 / 未压缩', isSessionLogName('session.v3.jsonl.zstd')
  && isSessionLogName('session.jsonl.zstd') && isSessionLogName('session.jsonl'))
check('  连**没见过**的版本号也认（下一个大版本改名不会再静默瞎掉）', isSessionLogName('session.v9.jsonl.zstd'))
check('  但不是日志的一律不认', !isSessionLogName('notes.txt') && !isSessionLogName('session.v4.jsonl.zstd.bak')
  && !isSessionLogName('session-projection-cache.json'))
const frame = (text) => zlib.zstdCompressSync(Buffer.from(text, 'utf8'))
const mkdir = async (name, files) => {
  const dir = path.join(HOME, 'sessions-probe', name)
  await fs.mkdir(dir, { recursive: true })
  for (const [f, buf] of Object.entries(files)) await fs.writeFile(path.join(dir, f), buf)
  return dir
}
const HEADER = '{"type":"session","version":4,"id":"session-x"}\n'
const EMPTY_MULTIFRAME = Buffer.concat([frame(HEADER), frame('')])
const USED_MULTIFRAME = Buffer.concat([frame(HEADER), frame('{"type":"permission/preset","seq":0}\n{"type":"sandbox/mode","seq":1}\n')])
const d1 = await mkdir('empty', { 'session.v4.jsonl.zstd': EMPTY_MULTIFRAME })
const d2 = await mkdir('used', { 'session.v4.jsonl.zstd': USED_MULTIFRAME })
const d3 = await mkdir('future', { 'session.v9.jsonl.zstd': USED_MULTIFRAME })
const d4 = await mkdir('plain', { 'session.jsonl': Buffer.from(HEADER + '{"seq":1}\n', 'utf8') })
const d5 = await mkdir('plainblank', { 'session.jsonl': Buffer.from(HEADER, 'utf8') })
const d6 = await mkdir('noise', { 'session.v4.jsonl.zstd': USED_MULTIFRAME, 'notes.txt': Buffer.from('x'.repeat(9999), 'utf8') })
const blankOf = async (d) => (await classifySessionDir(d)).blank
check('头部一帧 + 空帧 → 仍是空会话', (await blankOf(d1)) === true)
check('头部一帧 + **记录帧** → 不再是空会话（老规则在这里判错）', (await blankOf(d2)) === false)
check('  没见过的版本号走兜底扫描，同样判对', (await blankOf(d3)) === false)
check('未压缩的日志照样数得出记录', (await blankOf(d4)) === false && (await blankOf(d5)) === true)
check('目录里的无关大文件不参与判定', (await blankOf(d6)) === false)
check('  但"最近活动"取的是**日志文件**的 mtime（比目录准）',
  (await classifySessionDir(d2)).logFile.endsWith('session.v4.jsonl.zstd'),
  (await classifySessionDir(d2)).logFile)
check('不存在的目录返回 null（不炸）', (await classifySessionDir(path.join(HOME, 'no-such-dir'))) === null)

console.log('14. 每条投递都要过 DSH 的 **v4 source 判据**（真机 2026-09-23 的报错形状）')
// 判据逐字照搬 DSH：dsh-session-persistence-jsonl 的 v4 校验 ——
// source 是对象、kind 是非空字符串、且 ≠ 'plugin'。不满足就整条投递被拒，
// 而插件这一侧只看到"投递失败"，被唤醒的会话才看得到原因。
const v4SourceOk = (m) => {
  const s = m === undefined || m === null ? null : m.source
  return s !== null && typeof s === 'object' && typeof s.kind === 'string' && s.kind.length > 0 && s.kind !== 'plugin'
}
const allDelivered = [...live.values()].flatMap((a) => callsOf(a).map((c) => ({ session: a.id, message: c.message })))
const badSource = allDelivered.filter((d) => !v4SourceOk(d.message))
check('整套测试里投出去的 ' + allDelivered.length + ' 条消息，source 全部过 v4 判据',
  allDelivered.length > 0 && badSource.length === 0,
  badSource.slice(0, 2).map((b) => b.message && b.message.source))
check('  会话发的用 agent-message（带真实 senderSessionId）',
  allDelivered.some((d) => d.message.source.kind === 'agent-message' && typeof d.message.source.senderSessionId === 'string'))
check('  人发的用 user（房间里没有 sessionId，不能编一个）',
  allDelivered.some((d) => d.message.source.kind === 'user'), '人的发言也要投给成员')

console.log('15. 任务板 + 投递台账（A/B 两段的行为验收）')
// 先给 A 一个**结构化边界**：任务里写了它的地盘时，要能**在建任务那一刻**就看到 ⚠（事前而不是事后）
await tool('room_intent').execute({ room: roomId, direction: '只做审计，不改代码', paths: ['webui/**'] }, exec(A))
const t15 = await tool('room_task').execute({
  room: roomId, op: 'create', title: '加投递台账', expectPaths: ['webui/pages/static/js/chat.js'],
}, exec(B))
check('room_task create 成功', t15.ok === true && t15.text.includes('加投递台账'), t15.text)
check('  **事前**越界：建任务时就把 A 的地盘点出来（不必等改完再事后对质）',
  t15.text.includes('可能越界') && t15.text.includes('webui/pages/static/js/chat.js'), t15.text)
check('  而且不制造提及/义务（任务板是分工，不是要谁表态）', !t15.text.includes('@'), t15.text)
const tid15 = (t15.text.match(/task-\d+/) || [])[0]
check('  拿到任务 id', typeof tid15 === 'string' && tid15 !== '', tid15)
const list15 = await tool('room_task').execute({ room: roomId, op: 'list' }, exec(A))
check('list 列出任务（含状态与归属）', list15.ok === true && list15.text.includes('加投递台账') && list15.text.includes('open'), list15.text)
const claim15 = await tool('room_task').execute({ room: roomId, op: 'claim', taskId: tid15 }, exec(A))
check('认领成功 → claimed', claim15.ok === true && claim15.text.includes('claimed'), claim15.text)
const dup15 = await tool('room_task').execute({ room: roomId, op: 'claim', taskId: tid15 }, exec(B))
check('  别人再认领 → 拒绝并说清原因', dup15.ok === false && dup15.text.includes('已被'), dup15.text)
// 「校验失败不许改掉一半」：status 与非法 deps 同时给，任务必须**原样**（还是 claimed）
const bad15 = await tool('room_task').execute({ room: roomId, op: 'update', taskId: tid15, status: 'done', deps: ['task-999'] }, exec(A))
check('  非法依赖 → 拒绝', bad15.ok === false && bad15.text.includes('不存在'), bad15.text)
const snap15 = (await rpc('state', {})).value.rooms.find((r) => r.room.id === roomId)
const after15 = snap15.tasks.find((t) => t.id === tid15)
check('  且**没有改掉一半**（状态仍是 claimed，不是 done）', after15.status === 'claimed', after15)
check('  任务进了面板载荷（owner 已是短号）', after15.owner === A.id.slice(0, 8) || after15.owner === A.id.slice(8, 16), after15.owner)
const done15 = await tool('room_task').execute({ room: roomId, op: 'update', taskId: tid15, status: 'done' }, exec(A))
check('  合法 update → done', done15.ok === true && done15.text.includes('done'), done15.text)

// ---- A 段：投递台账 + 确认 ----
const pending15 = async (sid) => {
  const sm = (await rpc('state', {})).value.rooms.find((r) => r.room.id === roomId)
  const mm = sm.members.find((x) => x.sessionId === sid)
  return mm === undefined ? -1 : mm.pending
}
// 相对量：前面的用例也会留下没确认的投递（这正是台账在干活），所以只能比**增量**
const beforeA15 = await pending15(A.id)
const beforeB15 = await pending15(B.id)
const asked15 = await rpc('say', { roomId, text: '@' + A.id.slice(0, 8) + ' 台账验收：请回一句' })
const av = asked15.value === undefined ? {} : asked15.value
const seq15 = av.seq !== undefined ? av.seq : (av.message === undefined ? undefined : av.message.seq)
check('发出一条点名的房间消息', typeof seq15 === 'number' && seq15 > 0, asked15.value)
check('  被点名的人台账 +1', (await pending15(A.id)) === beforeA15 + 1, { beforeA15, now: await pending15(A.id) })
// 注意：这条**不是**"只叫 @ 到的人" —— 人的发言按设计叫**全体**（BLUEPRINT §2.2），
// 所以 B 也会 +1。测试把这个规则写下来，免得以后有人以为是漏投。
check('  没被点名的人也 +1（人的发言按设计叫全体，不是漏投）',
  (await pending15(B.id)) === beforeB15 + 1, { beforeB15, now: await pending15(B.id) })
await tool('room_judge').execute({ room: roomId, seq: seq15, verdict: 'unaffected' }, exec(A))
check('  它表态 = **确认**，台账清零', (await pending15(A.id)) === 0, await pending15(A.id))

console.log('16. 房间工具的**成员栅栏**（真机 2026-09-23：非成员的 subagent 成功声明，还给人造了义务）')
const outsider = fakeAgent('session-99998888-1111-2222-3333-444455556666')
const outDecl = await tool('room_declare_change').execute({ room: roomId, files: ['x.py'], summary: '非成员试试' }, exec(outsider))
check('非成员声明 → 被拒（返回形状仍守它自己的 schema）',
  outDecl.seq === 0 && String(outDecl.text).includes('不是房间'), outDecl)
check('  文案给出可操作的一条（成员由用户在面板里加）', String(outDecl.text).includes('用户显式加入'), outDecl.text)
const outSay = await tool('room_say').execute({ room: roomId, text: '非成员发言' }, exec(outsider))
check('非成员发言 → 被拒', outSay.seq === 0 && String(outSay.text).includes('不是房间'), outSay)
const outJudge = await tool('room_judge').execute({ room: roomId, seq: 1, verdict: 'unaffected' }, exec(outsider))
check('非成员表态 → 被拒', outJudge.ok === false && String(outJudge.text).includes('不是房间'), outJudge)
const outTask = await tool('room_task').execute({ room: roomId, op: 'list' }, exec(outsider))
check('非成员看任务板 → 也被拒（读侧一样拦：泄漏面就是历史）', outTask.ok === false, outTask)
const outList = await tool('room_status').execute({}, exec(outsider))
check('非成员"列出全部房间" → 一个都看不到', outList.text.includes('还没有加入任何聊天室'), outList.text)
const outNamed = await tool('room_status').execute({ room: roomId }, exec(outsider))
check('非成员点名某个房间 → 也拒', outNamed.text.includes('不是房间'), outNamed.text)
const inStatus = await tool('room_status').execute({ room: roomId }, exec(A))
check('成员照常能用（别把好人也拦了）', !inStatus.text.includes('不是房间'), inStatus.text.slice(0, 60))
const snap16 = (await rpc('state', {})).value.rooms.find((r) => r.room.id === roomId)
check('  非成员的发言没有在房间里留下任何消息',
  !JSON.stringify(snap16.messages).includes('非成员发言'), '房间里不该有它的声音')

await fs.rm(HOME, { recursive: true, force: true })
console.log('')
console.log('RESULT  ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
