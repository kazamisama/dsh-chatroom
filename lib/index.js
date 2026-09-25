/**
 * dsh-chatroom —— 多会话聊天室（Host 半侧）
 *
 * 设计权威：BLUEPRINT.md（§2 决定表 / §7 投递动词映射 / §8 房间协议）
 *
 * 零依赖：本文件**不 import 任何 @deepseek-ai 包**，只 import node 内置模块。
 * 原因（本机实测 2026-09-10）：插件以 link: 方式装进 profile 时，Node 按**真实路径**
 * 解析依赖，会去 D:\dsh_dev\dsh-chatroom\node_modules 和各上级目录找，而那里没有
 * @deepseek-ai/*；本盘又不支持创建 junction，无法补出这条路径。
 * 用户既有的 dsh-raw-html 同样是零依赖 —— 这是本生态里被验证过的正确姿势。
 * 因此：工具定义直接用 register() 接受的原始 JSON Schema；消息用本地
 * createUserMessage 复刻（等价于 dsh-llm 的实现，见下方注释）。
 *
 * 职责边界：
 *   本文件只做「接线」——把 lib/rooms.js 的纯状态机接到 DSH 的四个宿主面：
 *     ctx.tools          → room_* 工具
 *     ctx.agents         → 投递（followup / inject / steer）+ 冷会话唤醒
 *     ctx.systemPrompt   → 房间协议注入
 *     connection.rpc     → 房间面板的数据与操作通道
 *   状态与规则一律在 rooms.js。
 *
 * source 的归属形态（D7a，2026-09-23 按 session format v4 改写过一次）：
 *   · **有作者的**（某个会话发的）⇒ { kind: 'agent-message', form: 'relay', senderSessionId, roomId }
 *     —— 这正是 DSH 自己的 `AgentMessageSource`（dsh-subagent 的 agentMessageSource 同形），
 *     客户端按这个 kind 渲染「来自会话 X」（dsh-client-ui-chat 的 turnTriggerDetails 里
 *     case 'agent-message' → message.trigger.agent）。
 *   · **人发的**（房间里没有 sessionId）⇒ { kind: 'user', roomId } —— 树内对用户输入的规范 kind。
 *   ⚠ v4 起 `{ kind: 'plugin', plugin: … }` 这种 v3 包装被**明确拒绝**：
 *     dsh-session-persistence-jsonl 的 v4 校验要求 kind 是非空字符串且 ≠ 'plugin'，
 *     否则整条投递被拒（真机 2026-09-23：被唤醒的会话报
 *     「format v4 message requires a producer-owned source kind」）。
 */
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createChatroomStore, shortId, parseMentions, parseMentionsScoped, detectOverreach, VERDICTS,
  memberOwnership, matchesOwnedPath, suspectGlobs, bareTokens, DIRECTION_MAX_CHARS, extraFilesOwnerNote,
} from './rooms.js'
import { verifyDeclaration, describeVerification, resolveWorktree, VERIFIED } from './gitcheck.js'
import { REJUDGE_BATCH, rejudgeInputs, rejudgeStamp } from './rejudge.js'

/** 稳定 Cordis 插件名。 */
const name = 'dsh-chatroom'
/** 硬依赖：没有工具面，这个插件没有意义。其余服务走 ctx.get 软取。 */
const inject = ['tools']
/**
 * 一帧消息最多补投几次。到顶就不再补 —— 后台通道（inject）不进台账，所以这里只可能是
 * 「有义务/要唤醒」的那些；一直补不出去说明对方根本没有可用 agent，再试只是噪音。
 */
const DELIVERY_MAX_ATTEMPTS = 3

/** 房间面板与宿主之间的 loopback RPC 通道。 */
const RPC_CHANNEL = '/dsh-chatroom'
/**
 * 状态目录（与 dsh-raw-html 同域，都是 ~/.dsh 下的用户数据）。
 * DSH_CHATROOM_HOME 可覆盖 —— 测试用它把状态写进临时目录，绝不碰真实房间数据。
 */
const STATE_ROOT = process.env.DSH_CHATROOM_HOME !== undefined && process.env.DSH_CHATROOM_HOME !== ''
  ? process.env.DSH_CHATROOM_HOME
  : path.join(os.homedir(), '.dsh', 'dsh-chatroom')
/** 系统提示词 section 名。 */
const PROTOCOL_SECTION = 'chatroom:protocol'
/** 成员**自己的**边界段（按 agent 作用域注册，见 §11.35）。与全局协议段分开命名，免得同名冲突。 */
const BOUNDARY_SECTION = 'chatroom:boundary'
// （原先这里有个 SOURCE_PLUGIN = 'dsh-chatroom'，用来拼 { kind:'plugin', plugin:… } 那种归属。
//   session format v4 起那种包装会被拒收，归属改用 DSH 已声明的两种 kind —— 见 chatroomSource()。
//   删掉它而不是留着：一个没人用的常量会让人以为"插件还在声明自己的 source kind"。）

/** 成员给某条消息的判断，模型可见的固定四选一（BLUEPRINT D13）。 */
const VERDICT_LABELS = {
  unaffected: '不受影响',
  'catch-up': '我要跟上',
  retest: '我要重跑测试',
  'need-info': '需要更多信息',
}

/** 诊断日志：DSH_CHATROOM_DEBUG=1 才输出（装机排查用，平时完全静默）。 */
const DEBUG = process.env.DSH_CHATROOM_DEBUG === '1'
function debug(...args) {
  if (DEBUG) console.log('[dsh-chatroom]', ...args)
}

/**
 * 会话日志的可能文件名（含**版本号**那一族）。
 * **认不出文件名 = 认不出会话**：真机 2026-09-23 DSH 升到 0.1.7-alpha.2 之后写的是
 * `session.v4.jsonl.zstd`，而这里停在 v3 ⇒ 那个文件一个都不命中 ⇒ bytes=0 ⇒ 被当成
 * **空会话**排除出候选（还让"最近活动"退回读那份**冻结的** v3 文件，实测滞后 0.3–253 小时）。
 */
const SESSION_LOG_NAMES = ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.jsonl.zstd', 'session.jsonl']

/**
 * 任意版本的会话日志文件名：`session.jsonl` / `session.jsonl.zstd` / `session.vN.jsonl(.zstd)`。
 * 兜底扫描用它 —— 下一个大版本再改名（v5…）时，不至于又变成"文件在、我们不认识"。
 */
export function isSessionLogName(name) {
  return /^session(\.v\d+)?\.jsonl(\.zstd)?$/.test(String(name))
}

/**
 * 数一份 zstd 会话日志里**全部帧**的记录行数（返回 -1 = 判不了，调用方按"不空"处理）。
 *
 * 为什么不能只解一次：DSH 的会话日志是**多帧**的（每次 flush 一帧），而 Node 的 zstd API
 * **只解第一帧** —— 而第一帧只有 session 头那一行。真机 2026-09-23 实测：v3 与 v4 的最小空会话
 * 都是 2–3 帧、首帧 1 行；**有内容的会话首帧同样是 1 行**（39f99497 那份 8.9 MB / 104 帧的日志，
 * 首帧也只有 1 行）。所以老判据（解压一次数行数）只要真被执行，就会把**有内容的会话判成空会话** ——
 * 它至今没出事，只因为"只在 <64 KB 时才解压"把大多数会话挡在了门外。
 * 按帧魔数切开逐帧解；有切坏的帧（魔数出现在压缩数据里）就返回 -1，宁可多显示一个会话。
 */
function countLogLines(raw) {
  if (typeof zlib.zstdDecompressSync !== 'function') return -1
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets = []
  let i = 0
  for (;;) {
    const at = raw.indexOf(MAGIC, i)
    if (at < 0) break
    offsets.push(at)
    i = at + 4
  }
  if (offsets.length === 0) return -1
  if (offsets[0] !== 0) offsets.unshift(0)
  let lines = 0
  let broken = 0
  for (let k = 0; k < offsets.length; k++) {
    const end = k + 1 < offsets.length ? offsets[k + 1] : raw.length
    try {
      const text = zlib.zstdDecompressSync(raw.subarray(offsets[k], end)).toString('utf8')
      lines += text.split('\n').filter((line) => line.trim() !== '').length
    } catch (err) { broken++ }
  }
  return broken > 0 ? -1 : lines
}

/**
 * 把一个会话目录读成一条索引记录：`{ lastActivityAt, createdAt, bytes, logFile, blank }`。
 *
 * 为什么抽成模块级函数：这一段**每种错法都是静默的** —— 文件名不认识 ⇒ bytes=0 ⇒
 * 被判成"空会话"⇒ 从候选里消失，而界面上只是"少了一个会话"。抽出来才**能单测**。
 */
export async function classifySessionDir(dir) {
  let st
  try { st = await fs.stat(dir) } catch (err) { return null }
  if (!st.isDirectory()) return null
  let lastActivityAt = st.mtimeMs
  let createdAt = st.birthtimeMs || st.ctimeMs || 0
  let bytes = 0
  let logFile = ''
  const consider = async (full) => {
    try {
      const fst = await fs.stat(full)
      lastActivityAt = Math.max(lastActivityAt, fst.mtimeMs)
      if (fst.birthtimeMs > 0) createdAt = createdAt === 0 ? fst.birthtimeMs : Math.min(createdAt, fst.birthtimeMs)
      if (fst.size >= bytes) { bytes = fst.size; logFile = full }
    } catch (err) { /* 没有这个候选名就换下一个 */ }
  }
  for (const name of SESSION_LOG_NAMES) await consider(path.join(dir, name))
  // 一个已知名字都没命中 ⇒ 这一版 DSH 换了文件名：**扫一遍目录**（只在没命中时才付这个代价）。
  if (logFile === '') {
    let names = []
    try { names = await fs.readdir(dir) } catch (err) { names = [] }
    for (const name of names) if (isSessionLogName(name)) await consider(path.join(dir, name))
  }
  // **空会话**（建了没用过）不进候选：DSH 自己的侧栏也不显示它们
  // （投影缓存里那个 sessionListMetadata.blank 就是干这个的），数量必须一致。
  // 判定不能只看"文件为 0 字节"：真机上那种会话的日志是 337 字节 —— 只有一行
  // session 头，没有任何会话记录。所以小文件解压数一下记录数；大文件必然是"有内容"，
  // 不解压，代价可以忽略。
  let blank = bytes === 0
  if (!blank && bytes < 64 * 1024 && logFile !== '') {
    try {
      const raw = await fs.readFile(logFile)
      if (logFile.endsWith('.zstd')) {
        const lines = countLogLines(raw)
        // -1 = 解不了/切坏了 ⇒ **按"不空"处理**（宁可多显示一个会话，也不能把有内容的藏起来）
        blank = lines >= 0 ? lines <= 1 : false
      } else {
        blank = raw.toString('utf8').split('\n').filter((line) => line.trim() !== '').length <= 1
      }
    } catch (err) { blank = false }
  }
  return { lastActivityAt, createdAt, bytes, logFile, blank }
}

// ===========================================================================
// 本地消息构造（等价于 @deepseek-ai/dsh-llm 的 createUserMessage）
//   createUserMessage(input) = freezeMessage({ ...input, role:'user', id: MessageId(randomUUID()) })
//   freezeMessage(m)         = deepFreeze(structuredClone(m))
// 复刻而非 import，见文件头「零依赖」说明。
// ===========================================================================

/** 递归冻结（与 dsh-llm 的 deepFreeze 语义一致：不可变快照）。 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}

/**
 * 递归剔除值为 `undefined` 的键。
 *
 * 为什么必须有：DSH 的会话日志写入走**严格 lossless-JSON 校验**，
 * 一条消息里只要有 `undefined` 就会被拒收，报
 * `session event "agent/inbox/spliced" carries non-JSON-serializable data`。
 * JSON.stringify 会静默丢掉 undefined，所以这种 bug 在本地自测里看不出来 ——
 * 真机踩过（2026-09-10，人的发言在 source.senderSessionId 上带出 undefined）。
 */
function withoutUndefined(value) {
  if (Array.isArray(value)) return value.map(withoutUndefined)
  if (value === null || typeof value !== 'object') return value
  const out = {}
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) continue
    out[key] = withoutUndefined(value[key])
  }
  return out
}

/**
 * 房间消息投给某个会话时的 **source**（归属）——按 DSH 的 session format v4 口径构造。
 *
 * 两条分支都不是自定义形状，而是树内**已声明**的两种（这是 D7a 的本意：客户端只认已声明形态）：
 *  · 有作者（会话发的）：`{ kind: 'agent-message', form: 'relay', senderSessionId }`
 *    —— DSH 自己的 `AgentMessageSource`；dsh-subagent 的 `agentMessageSource(sender)` 与它逐字同形。
 *  · 人发的（房间里没有 sessionId）：`{ kind: 'user' }` —— 树内对用户输入的规范 kind。
 * 两个分支都带上 `roomId`（v4 只校验 kind，其余自有字段保留；房间日志取证时它有用）。
 *
 * ⚠ **v4 起 `{ kind: 'plugin', plugin: … }` 会被明确拒绝**（kind 必须非空且 ≠ 'plugin'），
 * 真机 2026-09-23 的表现是：被唤醒的会话报
 * 「format v4 message requires a producer-owned source kind」，整条投递被拒 ——
 * 也就是说**别人收不到房间消息**，而这在插件这一侧看起来只是"投递失败"。
 */
function chatroomSource(author, roomId) {
  const base = author === null || author === undefined || author === ''
    ? { kind: 'user' }
    : { kind: 'agent-message', form: 'relay', senderSessionId: String(author) }
  if (typeof roomId === 'string' && roomId !== '') base.roomId = roomId
  return base
}

/** 造一条已识别、已冻结、且保证 lossless-JSON 的 user 角色消息。 */
function createUserMessage(input) {
  return deepFreeze(withoutUndefined(structuredClone({ ...input, role: 'user', id: randomUUID() })))
}

/** 工具输出渲染：一行文本。 */
function textRender(_args, value) {
  return [{ type: 'text', text: String(value && value.text !== undefined ? value.text : '') }]
}

/** 本地时刻（YYYY-MM-DD HH:MM）—— 房间消息的 ts 是给人看的，UTC/ISO 会让人看错时区。 */
function stamp(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}

/**
 * room_say 的返回值说明：@ 了谁、压了谁、为什么。**必须列短号**。
 *
 * 为什么（真机 #1598/#1606）：旧文案只说「提到 N 人、没唤醒谁」，作者很容易把它读成
 * "我 @ 成功了" —— 于是那条消息的提问静默降级成背景，作者直到别人重问才发现。
 * 现在把**被压掉的短号列出来**，作者一眼能看到"我 @ 了但没生效"。
 */
function describeMentions({ kept, dropped, byFlag, markedLines, woke }) {
  const names = (ids) => ids.map((id) => shortId(id)).join(' ')
  const parts = []
  if (kept.length > 0) {
    parts.push('@ 了 ' + kept.length + ' 人（' + names(kept) + '），已唤醒 ' + woke + ' 人 —— 他们必须回一句')
  }
  if (dropped.length > 0) {
    parts.push('压掉 ' + dropped.length + ' 人（' + names(dropped) + '）：'
      + (byFlag ? 'wake=false' : '那几行写了「不需要回应」')
      + ' —— 只作背景投递，没有登记义务')
  }
  if (!byFlag && markedLines > 0 && kept.length > 0) {
    parts.push('⚠「不需要回应」只压它所在的那一行；其余 @ 照常登记（要整条免回请传 wake=false）')
  }
  if (parts.length === 0) {
    // P4（真机 2026-09-25 #5017③，214c26f9 连发 9 条零唤醒）：正文里 **0 个 @** 时旧文案什么都不说，
    // 而「已发言」与「已唤醒」只差两个字、含义却差着"对方欠不欠回执" —— 读漏的代价就是一次静默降级。
    // 把计数**写死在返回里**（mentions: 0 / woke: 0），别让人从两个字里推断。
    return '（正文里 0 个 @ ⇒ mentions: 0 / woke: 0 —— **没有登记任何回执义务**，这条只作背景投递；'
      + '要谁回就在**正文里**写 @短号）'
  }
  return '（' + parts.join('；') + '）'
}

/** 一串路径 token 的紧凑写法（给 room_status / room_owners 用）。 */
function listTokens(list, max = 3) {
  const arr = Array.isArray(list) ? list : []
  return arr.slice(0, max).join(' ') + (arr.length > max ? ' …共 ' + arr.length + ' 条' : '')
}

/**
 * 方向声明的**形状提示**（用户 2026-09-25 裁定的四段标准；214c26f9 #5052 的提案 P6）。
 *
 * 为什么是"提示"不是"判据"：唤醒帧只回显 direction 的**前 200 字**（本文件那处 shown 截断），
 * 所以【面】【不碰】【纪律】落在 200 字之后 = 别人**读不到纪律、只读到故事**。
 * 但插件不替用户/房间执行这条标准（他们明说「只提示、不改判定」）：不合标准照样受理、照样存全文。
 */
function directionShapeHints(direction) {
  const text = String(direction === undefined || direction === null ? '' : direction)
  const out = []
  const NEED = ['【面】', '【不碰】', '【纪律】']
  const late = NEED.filter((tag) => {
    const at = text.indexOf(tag)
    return at < 0 || at >= 200
  })
  if (late.length > 0) {
    out.push('前 200 字里缺 ' + late.join(' / ') + '（唤醒帧只回显前 200 字 ⇒ 落在后面的段落别人读不到，只读得到故事）')
  }
  if (text.length > 400) out.push('正文 ' + text.length + ' 字（标准 ≤400）')
  const rot = []
  if (/\d{4}-\d{2}-\d{2}/.test(text)) rot.push('日期')
  if (/(^|[^0-9a-f])[0-9a-f]{7,40}([^0-9a-f]|$)/.test(text)) rot.push('commit sha')
  if (/#\d{3,}/.test(text)) rot.push('#seq')
  if (/[\w./-]+\.\w+:\d+/.test(text)) rot.push('file:line')
  if (rot.length > 0) {
    out.push('含会腐烂的引用（' + rot.join(' / ') + '）—— 方向要长期有效，引用请改成文档小节号')
  }
  if (/更正我上一条|原先|之前我|root ?cause/i.test(text)) out.push('像是历史叙述（更正/原先/根因）—— 方向是覆盖式的：历史归房间消息与文档')
  return out
}
/** 一串 seq 的紧凑写法（太长就省略 —— 房间记录是给人扫的，不是给人数的）。 */
function listSeqs(seqs, max = 4) {
  return seqs.slice(0, max).map((s) => '#' + s).join(' ')
    + (seqs.length > max ? ' …(共 ' + seqs.length + ' 条)' : '')
}

/** 正文压成一行（列表模式用；全文模式不压）。 */
function flatten(text, max) {
  const one = String(text || '').replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max) + '…' : one
}

/**
 * 回执的 note。**不静默截断** —— 房间里的回执正文有时就是几 KB 的答复
 * （#1352 那种逐条回答），截了必须说出来，否则读者会以为那就是全文。
 */
function trimNote(note, max = 2000) {
  const s = String(note || '')
  return s.length > max ? s.slice(0, max) + ' …（截断，原文 ' + s.length + ' 字）' : s
}

function apply(ctx) {
  const tools = ctx.get('tools')
  const systemPrompt = ctx.get('systemPrompt')
  const agents = ctx.get('agents')

  /**
   * 软依赖要**现取**，不能在这里取一次就记住。
   *
   * 真机教训（2026-09-12）：`const sessionQuery = ctx.get('sessionQuery')` 在 apply() 那一刻
   * 拿到的是 undefined（那个服务还没挂载），于是插件一辈子以为"没有 sessionQuery"，
   * 转头去读投影缓存 —— 而那份缓存是**过期的**，结果最新建的那个会话根本不在候选里。
   * 而 DSH 自己的会话列表用的正是 `sessionQuery.listSessions()`，所以它总是新鲜的。
   */
  function serviceOf(name) {
    return ctx.get === undefined ? undefined : ctx.get(name)
  }

  if (tools === undefined) {
    debug('apply(): tools 服务不可用 —— 插件不注册任何东西')
    return
  }
  debug('apply(): tools=ok systemPrompt=' + (systemPrompt !== undefined) + ' agents=' + (agents !== undefined)
    + ' sessionQuery(此刻)=' + (serviceOf('sessionQuery') !== undefined) + '（它可能稍后才挂载，所以只在用时现取）')

  const store = createChatroomStore({ root: STATE_ROOT })
  /** 加载完成的信号：所有入口先 await 它，避免首个工具调用读到空状态。 */
  const ready = store.load().catch(() => undefined)

  /** 冷唤醒出来的 AgentHandle（由本插件 fiber 持有；不持有就会被卸载掉）。 */
  const wakeHandles = new Map()
  ctx.effect(() => () => {
    for (const handle of wakeHandles.values()) {
      try { void handle.dispose() } catch { /* 卸载期忽略 */ }
    }
    wakeHandles.clear()
  }, 'chatroom wake handles')

  // =======================================================================
  // 投递层（BLUEPRINT §7）
  // =======================================================================

  /**
   * 会话投影缓存（GUI 侧边栏用的同一份数据）：`tables.sessions.<id>` 下有
   * `identity.{cwd,createdAt}` 与 `rows.title.val`。
   *
   * 为什么要读这个文件而不是 ctx.sessionQuery：**本机实测该服务未挂载**
   * （真机日志：sessionQuery=false），而人要看的是「标题 + 工作区」——
   * 只给 shortId 等于没给身份。只读、容错，格式变了就静默降级。
   * 带 3 秒 TTL：面板每 2 秒轮询一次，不能每次都读 350KB。
   */
  const projectionCache = { at: 0, map: new Map() }
  /**
   * 成员工作区的**会话表**缓存（#1756）。`unlisted` = 上一次列表里没出现的 id ——
   * 记着它是为了别让一个"查不到的成员"把每次判定都变成一次全量列表。
   */
  const sessionWsCache = { at: 0, map: new Map(), unlisted: new Set() }
  /**
   * 投影缓存的文件名**不写死**：archive-manager 会把默认的 session-projection-cache
   * 换成自己的存储域（本机是 session_projcache_archive_manager_v2）。写死旧名字会读到
   * 一份**过期副本** —— 真机实测：旧的停在 9/10、105 个会话；活的那份 143 个。
   * 所以扫描同前缀的 json，取 mtime 最新的那个。
   */
  async function projectionFile() {
    const dir = path.join(os.homedir(), '.dsh', 'storages')
    let best = null
    try {
      for (const name of await fs.readdir(dir)) {
        if (!/^session_projcache.*\.json$/.test(name)) continue
        const full = path.join(dir, name)
        try {
          const st = await fs.stat(full)
          if (best === null || st.mtimeMs > best.mtimeMs) best = { full, mtimeMs: st.mtimeMs }
        } catch (err) { /* 单个文件读不到就跳过 */ }
      }
    } catch (err) {
      debug('投影缓存目录不可读: ' + (err && err.message ? err.message : String(err)))
    }
    return best === null ? null : best.full
  }
  async function projectionIndex() {
    if (projectionCache.map.size > 0 && Date.now() - projectionCache.at < 3000) return projectionCache.map
    const map = new Map()
    try {
      const file = await projectionFile()
      if (file === null) throw new Error('目录里没有 session_projcache*.json')
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
      const sessions = parsed === null || parsed === undefined ? undefined : parsed.tables?.sessions
      if (sessions !== null && typeof sessions === 'object') {
        for (const [key, entry] of Object.entries(sessions)) {
          const identity = entry?.identity ?? {}
          const titleRow = entry?.rows?.title
          // **键不是会话 id**：新版缓存（archive-manager 的 v2 域）用不透明键
          // `session_<token>`，真 id 在 entry.sessionId 里 —— 本机实测 143/143 个都不同。
          // 拿键当 id 会得到一堆 "session_" 开头的假 id，「定位 / 加入」全部打空。
          const id = typeof entry?.sessionId === 'string' && entry.sessionId !== '' ? entry.sessionId : key
          // 「最近活动」= 最后一次人给的 prompt。DSH 自己的会话列表就是拿它显示
          // 「3 分钟前」的（sessionListMetadata.lastPromptAt），取不到才退回创建时间。
          const listMeta = entry?.rows?.sessionListMetadata?.val
          const lastPromptAt = listMeta !== null && typeof listMeta === 'object' && typeof listMeta.lastPromptAt === 'number'
            ? listMeta.lastPromptAt
            : 0
          const createdAt = typeof identity.createdAt === 'number' ? identity.createdAt : 0
          map.set(id, {
            title: typeof titleRow?.val === 'string' ? titleRow.val : '',
            cwd: typeof identity.cwd === 'string' ? identity.cwd : '',
            createdAt,
            lastActivityAt: lastPromptAt > 0 ? lastPromptAt : createdAt,
          })
        }
      }
    } catch (err) {
      debug('投影缓存不可用: ' + (err && err.message ? err.message : String(err)))
    }
    projectionCache.at = Date.now()
    projectionCache.map = map
    return map
  }

  /**
   * 归档集合。archive-manager 把归档标记放在 workspace 注册表状态里
   * （\`~/.dsh/storages/workspace.json\` → \`global.archivedSessionIds\`），
   * 而在 GUI 里归档会话是**隐藏**的 —— 候选列表必须与之一致，否则人会看到
   * 一堆自己早就归档掉的会话（真机反馈 2026-09-12）。
   * 读不到就当作「没有归档」：宁可多给，不可把候选清空。
   */
  const archivedCache = { at: 0, set: new Set() }
  async function archivedIds() {
    if (Date.now() - archivedCache.at < 3000) return archivedCache.set
    const set = new Set()
    try {
      const file = path.join(os.homedir(), '.dsh', 'storages', 'workspace.json')
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'))
      const ids = parsed === null || parsed === undefined ? undefined : parsed.global?.archivedSessionIds
      if (Array.isArray(ids)) {
        for (const id of ids) if (typeof id === 'string') set.add(id)
      }
    } catch (err) {
      debug('归档集合不可用（不阻断候选）: ' + (err && err.message ? err.message : String(err)))
    }
    archivedCache.at = Date.now()
    archivedCache.set = set
    return set
  }

  /**
   * 磁盘上的会话目录索引：~/.dsh/sessions/<工作区目录>/session-<uuid>/
   *
   * 为什么需要它：投影缓存**会过期**。真机 2026-09-12 实测 —— v2 那份停在 9/10，
   * 之后新建的会话根本不在里面，人会看到「最新的会话不见了」。而目录是权威的：
   * 会话一建就有目录。日志文件的 mtime 还顺手给了**新鲜的**「最近活动」，
   * 比缓存里的 lastPromptAt 更准。
   *
   * 3 秒 TTL：面板每 2 秒轮询一次，不能每次都把两百个目录 stat 一遍。
   */
  const dirIndexCache = { at: 0, map: new Map() }
  async function sessionDirIndex() {
    if (Date.now() - dirIndexCache.at < 3000) return dirIndexCache.map
    const map = new Map()
    const root = path.join(os.homedir(), '.dsh', 'sessions')
    try {
      for (const wsDirName of await fs.readdir(root)) {
        const wsDir = path.join(root, wsDirName)
        let names
        try { names = await fs.readdir(wsDir) } catch (err) { continue }
        for (const name of names) {
          if (!name.startsWith('session-')) continue // 裸 uuid 目录 = 子代理，不进候选（详见 dropSubagents）
          const dir = path.join(wsDir, name)
          try {
            // 一条记录里所有判据都来自 classifySessionDir —— **判据只有一处**，
            // 免得"改了一处、另一处还在用老规则"（2026-09-23 我自己就犯过：把文件名修好了、
            // 却把逐帧数行数那条新规则只加在导出的那个函数里，运行时这条路还在按第一帧判空）。
            const rec = await classifySessionDir(dir)
            if (rec === null) continue
            map.set(name, {
              wsDir: wsDirName,
              lastActivityAt: rec.lastActivityAt,
              createdAt: rec.createdAt,
              blank: rec.blank,
            })
          } catch (err) { /* 单个会话读不到就跳过 */ }
        }
      }
    } catch (err) {
      debug('会话目录索引不可用: ' + (err && err.message ? err.message : String(err)))
    }
    dirIndexCache.at = Date.now()
    dirIndexCache.map = map
    return map
  }

  /**
   * 语料条目：**优先 sessionQuery**（与 DSH 自己的会话列表同一个源：最新，且带
   * parentSession / delegationDepth 这些权威字段），否则退回投影缓存 ∪ 磁盘目录。
   * @returns [{ id, cwd, createdAt, lastActivityAt, title, live, parentSession, delegationDepth }]
   */
  async function corpusEntries() {
    const dirs = await sessionDirIndex()
    const query = serviceOf('sessionQuery')
    if (query !== undefined && typeof query.listSessions === 'function') {
      try {
        const recs = await query.listSessions()
        // ⚠ 这里**故意不取标题**：几百条标题要 20 秒（见 titleCache 的注释）。
        // 标题由调用方按"最终要显示的那几十条"去缓存里取，缺的后台补。
        const out = recs
          .map((rec) => {
            const header = rec?.header
            if (header === undefined || typeof header.id !== 'string') return null
            const createdAt = typeof header.createdAt === 'number' ? header.createdAt : 0
            const onDisk = dirs.get(header.id)
            if (onDisk !== undefined && onDisk.blank === true) return null // 空会话：与 DSH 侧栏一致地不显示
            return {
              id: header.id,
              cwd: typeof header.cwd === 'string' ? header.cwd : '',
              createdAt,
              title: titleCache.get(header.id) || '',
              live: rec.live === true,
              // 子代理的**权威**标记（GUI 就是靠它把子代理挡在会话列表外的）
              parentSession: typeof header.parentSession === 'string' ? header.parentSession : '',
              delegationDepth: typeof header.delegationDepth === 'number' ? header.delegationDepth : 0,
              // 「最近活动」：磁盘日志 mtime 最新；没有才退回 header / 创建时间
              lastActivityAt: Math.max(
                onDisk === undefined ? 0 : onDisk.lastActivityAt,
                typeof header.lastPromptAt === 'number' && header.lastPromptAt > 0 ? header.lastPromptAt : 0,
                createdAt,
              ),
            }
          })
          .filter((x) => x !== null)
        if (out.length > 0) return out
      } catch (err) {
        debug('listSessions 失败，退回投影缓存: ' + (err && err.message ? err.message : String(err)))
      }
    }

    // 退回：投影缓存（可能过期）∪ 磁盘目录（把缓存漏掉的新会话补回来）
    const map = await projectionIndex()
    // 工作区目录名是有损编码（--C-Users-chiriu-...--），反解不出来；
    // 但可以从**已知会话**投票得出映射，再给「只在磁盘上出现」的会话用。
    const wsCwd = new Map()
    for (const [id, d] of dirs) {
      const hit = map.get(id)
      if (hit !== undefined && hit.cwd !== '' && !wsCwd.has(d.wsDir)) wsCwd.set(d.wsDir, hit.cwd)
    }
    const merged = new Map()
    for (const [id, v] of map) {
      merged.set(id, {
        id,
        cwd: v.cwd,
        createdAt: v.createdAt,
        lastActivityAt: Math.max(v.lastActivityAt || 0, v.createdAt || 0),
        title: v.title,
        live: false,
        parentSession: '',
        delegationDepth: 0,
      })
    }
    for (const [id, d] of dirs) {
      if (d.blank === true) { merged.delete(id); continue } // 空会话不显示（同上）
      const hit = merged.get(id)
      if (hit === undefined) {
        merged.set(id, {
          id,
          cwd: wsCwd.get(d.wsDir) || '',
          createdAt: d.createdAt,
          lastActivityAt: d.lastActivityAt,
          title: '',
          live: false,
          parentSession: '',
          delegationDepth: 0,
        })
      } else {
        hit.lastActivityAt = Math.max(hit.lastActivityAt, d.lastActivityAt)
      }
    }
    return [...merged.values()]
  }

  /**
   * 子代理会话不进候选 —— 人在 DSH 自己的会话列表里也看不到它们。
   *
   * 判定依据（真机逐条核对，2026-09-12）：权威字段是会话日志头的
   * `delegationDepth`/`parentSession`（子代理 ≥1 且有 parent，顶层恒为 0/null）；
   * 而它在磁盘与本机缓存上的**形态特征**是：顶层会话 id 一律 `session-<uuid>`，
   * 子代理是裸 uuid（本机 9 个顶层 / 3 个子代理逐一对上，depth 0 / ≥1）。
   * 为了不把 143 个 zstd 日志逐个解头，这里用形态判定，**并留一道保险**：
   * 若这一版 DSH 换了顶层 id 形态（一个都不带 `session-`），就整体不筛 ——
   * 宁可多给几个子代理，也不能把候选清空。
   */
  function dropSubagents(entries) {
    // ① 权威标记优先：sessionQuery 的 header 直接带 parentSession / delegationDepth
    const byHeader = entries.filter((e) => !(e.delegationDepth > 0) && (e.parentSession || '') === '')
    if (byHeader.length !== entries.length) {
      return { kept: byHeader, dropped: entries.length - byHeader.length }
    }
    // ② header 没给（投影缓存路径）→ 退回 id 形态判定，并留保险
    const topLevel = entries.filter((e) => String(e.id).startsWith('session-'))
    if (topLevel.length === 0) {
      debug('顶层会话 id 形态变了（没有 session- 前缀）→ 跳过子代理过滤')
      return { kept: entries, dropped: 0 }
    }
    return { kept: topLevel, dropped: entries.length - topLevel.length }
  }

  /**
   * 标题缓存 + 后台预热。
   *
   * 为什么必须缓存：`readTitleSnapshots` 每条都很贵（真机实测：几百条要 **20 秒**，
   * 因为它要为缺投影的会话去读会话日志）。面板每 2 秒轮询一次，绝不能挂在请求路径上。
   * 所以：请求路径只读这个 Map（零成本），缺的丢给后台慢慢补 —— 补到了下一轮自然出现。
   * '' 是有效值（表示"确实没有标题"），别当成"还没查过"。
   */
  const titleCache = new Map()
  /** 查空过的 id → 上次尝试时间。**空值不能永久缓存**：源可能只是暂时没给（或还没生成），
   *  过一阵要能再试；冷却 60 秒，避免每 2 秒轮询都去啃磁盘。 */
  const titleMissAt = new Map()
  const TITLE_MISS_COOLDOWN_MS = 60 * 1000
  let titleWarmInFlight = false
  function warmTitles(ids) {
    if (titleWarmInFlight) return
    const now = Date.now()
    const missing = []
    for (const id of ids) {
      if (typeof id !== 'string' || id === '') continue
      if (titleCache.has(id)) continue
      if (now - (titleMissAt.get(id) || 0) < TITLE_MISS_COOLDOWN_MS) continue
      missing.push(id)
      if (missing.length >= 120) break // 一次最多补 120 条，别一口气把磁盘读爆
    }
    if (missing.length === 0) return
    titleWarmInFlight = true
    void (async () => {
      try {
        const got = await titlesFor(missing)
        for (const id of missing) {
          const title = got.get(id)
          if (typeof title === 'string' && title !== '') {
            titleCache.set(id, title)
            titleMissAt.delete(id)
          } else {
            titleMissAt.set(id, Date.now()) // 记下这次查空，冷却后再试
          }
        }
      } catch (err) {
        debug('标题预热失败（下一轮再试）: ' + (err && err.message ? err.message : String(err)))
      } finally {
        titleWarmInFlight = false
      }
    })()
  }

  /**
   * 批量取会话标题。人认得出的是**标题**，不是 shortId。按条隔离失败。
   */
  async function titlesFor(ids) {
    const map = new Map()
    if (ids.length === 0) return map
    const query = serviceOf('sessionQuery')
    if (query !== undefined && typeof query.readTitleSnapshots === 'function') {
      try {
        const results = await query.readTitleSnapshots(ids)
        for (const r of results) {
          if (r?.status === 'fulfilled' && typeof r.value?.title?.title === 'string') {
            map.set(r.sessionId, r.value.title.title)
          }
        }
      } catch (err) {
        debug('readTitleSnapshots 失败，退回投影缓存: ' + (err && err.message ? err.message : String(err)))
      }
    }
    // **两个源都要查，不能谁先给就 return**：快照常常只认得其中一部分（真机：120 条里给回几条），
    // 一旦提前 return，剩下的就永远没标题 —— 面板上整整一屏「(无标题会话)」。
    const projection = await projectionIndex()
    for (const id of ids) {
      if (map.has(id)) continue
      const hit = projection.get(id)
      if (hit !== undefined && hit.title !== '') map.set(id, hit.title)
    }
    return map
  }

  /**
   * sessionId → 工作区，取自**会话表**（`sessionQuery.listSessions()` 的 `header.cwd`）。
   *
   * 为什么需要它（真机 #1756，审计席实测"同一个提问、两次相反的答案"）：原来只有
   * 「活 Agent 的 header.cwd」这一个真实来源 —— 那个源**只在"这一刻它是活的"时才有**，
   * 于是同一个问题在 23:57 与 00:06 给出相反答案（6126bf05 当时没有活 Agent）。
   * 会话表里活的与已落盘的都在，且与存活无关；投影缓存实测对本房间成员**零命中**
   * （`session_projcache.json` 停在 09-10），只能当第三兜底。
   *
   * 缓存策略（都为了"结论要稳"）：30 秒 TTL；**有成员不在表里**就立刻重列一次
   * （新会话刚建就该出现在这里）；但**上一次就查不到的 id** 不再触发重列 ——
   * 否则一个查不到的成员会让每次判定都去列一遍会话表。
   */
  async function sessionWorkspaceMap(need = null) {
    const now = Date.now()
    const wanted = Array.isArray(need) ? need : []
    let stale = sessionWsCache.map.size === 0 || now - sessionWsCache.at >= 30000
    if (!stale && wanted.some((id) => !sessionWsCache.map.has(id) && !sessionWsCache.unlisted.has(id))) stale = true
    if (!stale) return sessionWsCache.map
    const map = new Map()
    const query = serviceOf('sessionQuery')
    if (query !== undefined && query !== null && typeof query.listSessions === 'function') {
      try {
        const recs = await query.listSessions()
        for (const rec of recs === null || recs === undefined ? [] : recs) {
          const header = rec === null || rec === undefined ? undefined : rec.header
          if (header === null || header === undefined) continue
          if (typeof header.id !== 'string' || typeof header.cwd !== 'string' || header.cwd === '') continue
          map.set(header.id, header.cwd)
        }
      } catch (err) {
        debug('成员工作区：会话表这一源拿不到（跳过）: ' + (err && err.message ? err.message : String(err)))
      }
    }
    // 只有真的列到东西才更新缓存：服务还没挂上（懒挂载，§11.13）时保持原样、下次再试
    if (map.size > 0) {
      sessionWsCache.at = now
      sessionWsCache.map = map
      sessionWsCache.unlisted = new Set(wanted.filter((id) => !map.has(id)))
    }
    return sessionWsCache.map
  }

  /**
   * 每个成员的工作区。三个源，按可靠性排：
   *   ① 活 Agent 的 header.cwd —— 最准，但只在"这一刻它是活的"时才有；
   *   ② 会话表的 header.cwd —— 与存活无关（#1756 补的正是这一源）；
   *   ③ 投影缓存 —— 本机对房间成员零命中，纯兜底。
   * 三个都没有 ⇒ 空串 = **未知**（不是"不在"）⇒ 判定按保守走（见 ownershipLookup）。
   */
  async function memberWorkspaceMap(roomId) {
    const map = new Map()
    const projection = await projectionIndex()
    const members = store.activeMembers(roomId)
    const sessions = await sessionWorkspaceMap(members.map((m) => m.sessionId))
    for (const m of members) {
      const live = agents === undefined ? undefined : agents.get(m.sessionId)
      const cwd = (live && live.session && live.session.header && live.session.header.cwd)
        || sessions.get(m.sessionId)
        || (projection.get(m.sessionId) || {}).cwd
        || ''
      map.set(m.sessionId, cwd)
    }
    return map
  }

  /**
   * 确定性匹配（BLUEPRINT §6.4）：**零 token** 判断「谁可能相关」。
   *
   * 只有命中的成员才收到「必须回一句」的 followup（会唤醒）；
   * 其余成员仍会通过 inject 看到这条变更，但不被打扰、不产生义务。
   * 这正是蓝图 §2.2 里「全体可见」与「降低信息交流成本」的调和点 ——
   * 如果每次变更都把全体叫起来过一次模型，房间越大越亏。
   */
  /**
   * 「这次声明的文件牵动谁」—— **唤醒路由（room_declare_change）与事前查询（room_owners）
   * 共用这一个函数**。
   *
   * 为什么必须共用：如果事前查询说"没人负责"、实际却叫醒了三个人（或反过来），
   * 那张事前确认表本身就是新的假绿来源 —— 而"两张表各说各话"正是本插件反复咬的形状。
   *
   * 判据（BLUEPRINT §6.4），按优先级：
   *   ① 命中**结构化边界**（room_intent 的 paths / join 的 subscriptions）→ 相关，且这是确定性的；
   *   ② 命中散文方向里解析出的路径 → 相关（仍是猜的，但比"同工作区"精确）；
   *   ③ 命中它自己声明**不碰**的 → 不相关（宁可少叫，也不要把"我让出来的地盘"判成它的）；
   *   ④ 完全没声明过边界 → 回落旧行为「同工作区即相关」。
   *
   * ④ 是**故意保守**的：真机 #1434 里"5 个同工作区成员全被叫醒"正是它造成的，
   * 但把没声明的人静默判成"不相关"会更糟 —— 那等于让人因为没写文档而漏掉该知道的事。
   * 没声明是一个洞，补法是让它去 room_intent 给 paths，不是让插件替它猜。
   */
  async function ownershipLookup(roomId, workspace, files) {
    const members = store.activeMembers(roomId)
    const declared = (Array.isArray(files) ? files : []).map((f) => path.normalize(String(f)).replace(/\\/g, '/'))
    if (members.length === 0 || declared.length === 0) return []
    const workspaces = await memberWorkspaceMap(roomId)
    const declWs = workspace === '' ? '' : path.resolve(String(workspace))
    const rows = []
    for (const m of members) {
      const own = memberOwnership(m)
      const mWs = workspaces.get(m.sessionId) || ''
      const resolved = mWs === '' ? '' : path.resolve(mWs)
      const sameWs = declWs !== '' && resolved === declWs
      const row = {
        sessionId: m.sessionId,
        shortId: shortId(m.sessionId),
        roleName: String(m.roleName || ''),
        wouldWake: false,
        reason: '',
        matched: [],
        source: own.structured ? '结构化边界' : (own.owned.length > 0 ? '散文方向' : '未声明边界'),
        workspace: mWs,
      }
      // **观察者/静音席位**（真机 #1714）：它们不认领任何路径，但收录范围是明确的 ——
      // 旧模型只有"结构化 vs 兜底"两档，于是观察者被当成"没声明边界"而吃下落唤醒
      // （255563de 实测：一晚 10 次唤醒、0 次与职责相关），而工具还会建议它"补 paths 就能收敛"
      // —— 对"要收全量变更"的审计席，那条建议是**错的**（补了就漏审）。
      if (m.watch === 'all') {
        row.wouldWake = true
        row.reason = '观察者席位（watch=all）：收全量变更，且不参与越界判定'
        rows.push(row)
        continue
      }
      // **唤醒席**（真机 #1920，用户提的需求）：全推 + **叫醒** + **不必回**。
      // 三根轴里唯一还没落地的那个角 —— all 把「叫醒」与「必须回」绑成了一件事，
      // 于是自动审计席只有两难：被叫 26 次/小时且每次必回（回执会退化成走过场），或一次都不醒。
      // 实现上它进**唤醒集**（wouldWake=true ⇒ 有人投 followup）、但不进**义务集**
      // （noReply=true ⇒ 不进 mentions ⇒ obligors 里没有它）。
      if (m.watch === 'wake') {
        row.wouldWake = true
        row.noReply = true
        row.reason = '唤醒席（watch=wake）：变更全推、**会叫醒它看一眼**，但不登记回执义务（不必回话）'
        rows.push(row)
        continue
      }
      // **只收不答席**（真机 #1798）：全推（看得见）但**不叫醒**、也不产生义务。
      // 与 all 的差别只有一格：all 会进 relatedMemberIds ⇒ 拿 followup「你必须回一句」；
      // feed 不进 ⇒ fanout 的背景通道把它当普通全推成员 inject（skipInject 放行）。
      if (m.watch === 'feed') {
        row.reason = '只收不答席（watch=feed）：变更通知全推（背景通道），但**不产生义务**、不会叫醒它'
        rows.push(row)
        continue
      }
      if (m.watch === 'none') {
        // 这句话出现在 room_owners 里，读者会把它读成「声明里 @ 我仍会叫到我」—— 而声明通道的义务
        // 只来自 related(=wouldWake) ∪ overreach，正文里的 @ 根本不参与（真机 #1824，S7 报的）。
        // 所以必须点名「哪条通道」：普通发言（room_say）的 @ 才算。
        // 另一个坑一并说清：**领地真被越界时它仍会被点名确认**（detectOverreach 不看 watch）。
        row.reason = '静音席位（watch=none）：不收变更推送、也不因变更被唤醒。**普通发言**里被 @ 仍会叫到'
          + '（**声明正文里的 @ 不算**）'
          + (own.owned.length > 0 ? '；它声明的领地真被越界时仍会被点名确认' : '')
        rows.push(row)
        continue
      }
      if (declared.length === 0) { rows.push(row); continue }
      // 命中判定：结构化边界与散文解析出的 token 都算「负责」，排除优先（BLUEPRINT §11.18 的老口径）
      const hits = []
      let excluded = false
      for (const file of declared) {
        const hit = matchesOwnedPath(file, own.owned)
        if (hit === null) continue
        if (matchesOwnedPath(file, own.excluded) !== null) { excluded = true; continue }
        hits.push({ file, token: hit.token, kind: hit.kind, index: hit.index })
      }
      if (hits.length > 0) {
        const known = resolved !== ''
        const crossWsOk = sameWs || (known && await fileExistsIn(resolved, hits[0].file))
        // **未知 ≠ 不在**（真机 #1756：同一个提问，23:57 说 0 人、00:06 说 3 人 ——
        // 差别只在"那一刻它有没有活 Agent"，而结论读起来像事实）。
        // 取不到工作区时跨工作区那道理**查不动**；旧代码在这里静默不叫，还把理由写成
        // 「不在它的工作区里」—— 那是**断言一个它并不知道的事实**。
        // 按 ④ 同族的保守口径：查不动就照样叫，并如实说"未知"。
        if (crossWsOk || !known) {
          row.wouldWake = true
          row.unknownWorkspace = !known
          row.reason = '命中' + (own.structured ? '结构化边界' : '散文方向')
            + (known ? '' : '（**取不到它的工作区 —— 未知，不是"不在"**：跨工作区那道理查不动，按保守口径照样叫）')
          row.matched = hits
        } else {
          row.reason = '命中了，但那个相对路径不在它的工作区里（跨工作区同名文件不误伤）'
        }
        rows.push(row)
        continue
      }
      // ⚠ **只有结构化边界才配当「过滤器」**。这条是 shadow run 逼出来的（2026-09-16）：
      // 拿真房间试跑时，ulysses/app.py 的结论是「0 人会醒」—— 因为 6126bf05 明明在改它，
      // 但散文只写了主题（「harness 回话管线」），没写文件名 ⇒ 从散文推出来的边界**天然不完整**。
      // 用不完整的清单去**压制**唤醒 = 让人被悄悄跳过（正是本插件最想避免的那件事）；
      // 而多叫一个只是贵一点。所以：结构化边界是权威（命中才醒），散文只做加法。
      if (own.structured) {
        row.reason = excluded ? '命中的是它声明**不碰**的路径' : '声明过结构化边界，这些文件不在其中'
        rows.push(row)
        continue
      }
      // 没有结构化边界 → 旧行为（宁多勿漏），并**明说**补 paths 才能收敛
      if (mWs === '') {
        // 同一条道理：工作区**未知**时旧代码"不叫" —— 等于让人因为**取不到信息**而被跳过。
        // 保守走（与 ④ 的"宁多勿漏"同族）：叫它，并让它知道补 paths 才能收敛。
        row.wouldWake = true
        row.unknownWorkspace = true
        row.reason = '没给结构化边界，也**取不到它的工作区（未知，不是"不在"）** → 按保守口径叫它'
          + '（补 room_intent 的 paths 才能收敛）'
        rows.push(row)
        continue
      }
      if (sameWs) {
        row.wouldWake = true
        row.reason = excluded
          ? '命中的是它声明不碰的路径，但它**没给结构化边界** → 仍按「同工作区即相关」叫它（补 paths 才能收敛）'
          : '没给结构化边界 → 回落「同工作区即相关」（补 room_intent 的 paths 就能收敛）'
        rows.push(row)
        continue
      }
      let hitFile = null
      for (const rel of declared) {
        if (await fileExistsIn(resolved, rel)) { hitFile = rel; break }
      }
      if (hitFile !== null) {
        row.wouldWake = true
        row.reason = '没给结构化边界，但 ' + hitFile + ' 确实存在于它的工作区'
      } else {
        row.reason = '没给结构化边界，且不在同一工作区'
      }
      rows.push(row)
    }
    return rows
  }

  /** 该相对路径是否真的存在于某个工作区（跨工作区判据，避免同名文件误伤）。 */
  async function fileExistsIn(resolvedWorkspace, rel) {
    if (resolvedWorkspace === '') return false
    try {
      await fs.access(path.join(resolvedWorkspace, rel))
      return true
    } catch {
      return false
    }
  }

  /**
   * 「这次声明的文件牵动谁」—— 返回**两个**名单（真机 #1920 起它们不再相同）：
   *   wake    = 要被**叫醒**的人（含 watch=all 与 watch=wake）
   *   noReply = 其中**不必回**的那些（watch=wake：醒过来看一眼就行）
   * 义务集 = wake − noReply，再并上越界点名的负责人（`detectOverreach` 不看 watch：
   * 你的地盘真被动了，那是定向确认，不是广播）。
   */
  async function relatedIds(roomId, declarerId, workspace, files) {
    const rows = await ownershipLookup(roomId, workspace, files)
    const woke = rows.filter((r) => r.wouldWake && r.sessionId !== declarerId)
    const wake = woke.map((r) => r.sessionId)
    const noReply = woke.filter((r) => r.noReply === true).map((r) => r.sessionId)
    debug('确定性匹配: 叫醒 ' + wake.length + ' 人（其中不必回 ' + noReply.length + ' 人）/ ' + rows.length + ' 名成员')
    return { wake, noReply }
  }

  /** 构造一条房间消息的模型可见文本。 */
  function frame(room, message, extra = '') {
    const who = message.sender && message.sender.user === true
      ? '用户'
      : shortId(message.sender && message.sender.sessionId)
        + (message.sender && message.sender.roleName ? ' (' + message.sender.roleName + ')' : '')
    return '[聊天室 ' + room.name + ' #' + message.seq + '] ' + who + ': ' + message.body + extra
  }

  /**
   * 冷唤醒的组装参数（M4）。**两样都必须给**，这是真机踩出来的：
   *
   * 1. `agentOptions`：`{{model}}` 提示词变量取自 `agent.options.model`
   *    （`dsh-agent-loop/lib/index.js:1025` —— `ctx.systemPrompt.variable("model", (c) => c.agent?.options.model)`）。
   *    不给 → 被唤醒的 agent 第一轮**必崩**：
   *    `prompt variable "{{model}}" has no value for this assembly (section "deployment:persona")`。
   * 2. `setup`：挂载会话记录里的 preset。不给 → 它跑在**宿主组合**上而不是自己的预设上，
   *    工具集和提示词全错。GUI 注释原话：*a session opened after a restart ran on host
   *    tools and the deployment persona*。
   *
   * 参照实现：`dsh-host-apiproxy/lib/types/api-proxy.js:1343-1347`。
   * 缺哪一样都不报错、只是坏得更隐蔽，所以这里逐项尽力并如实降级。
   */
  async function buildResumeOptions(sessionId) {
    const options = { resumeSessionId: sessionId }

    const defaultModel = ctx.get('agentDefaultModel')
    if (defaultModel !== undefined && typeof defaultModel.currentSelection === 'function') {
      const selection = defaultModel.currentSelection()
      if (selection !== undefined && selection !== null && typeof selection.model === 'string' && selection.model !== '') {
        options.agentOptions = { provider: selection.provider, model: selection.model }
      }
    }
    if (options.agentOptions === undefined) {
      debug('冷唤醒: 拿不到默认模型，' + shortId(sessionId) + ' 可能在提示词组装时崩')
    }

    const presets = ctx.get('agentPresets')
    if (presets !== undefined && typeof presets.resolve === 'function' && typeof presets.mount === 'function') {
      let presetId
      const persistence = ctx.get('sessionPersistence')
      if (persistence !== undefined && typeof persistence.list === 'function') {
        try {
          const header = (await persistence.list()).find((h) => h !== null && h !== undefined && h.id === sessionId)
          if (header !== undefined && typeof header.agentPreset === 'string') presetId = header.agentPreset
        } catch (err) {
          debug('冷唤醒: 读会话 header 失败 -> ' + (err && err.message ? err.message : String(err)))
        }
      }
      try {
        const resolved = await presets.resolve(presetId)
        const resolvedId = resolved === undefined || resolved === null ? presetId : resolved.id
        options.setup = async (agentCtx) => {
          await presets.mount(agentCtx, resolvedId)
        }
        debug('冷唤醒: preset=' + String(resolvedId))
      } catch (err) {
        debug('冷唤醒: preset 解析失败，将退回宿主组合 -> ' + (err && err.message ? err.message : String(err)))
      }
    }
    return options
  }

  /** 取一个成员的活 Agent；没有则按需冷唤醒（侦察确认：ctx.agents.resume 可用）。 */
  async function agentFor(sessionId, { wake = true } = {}) {
    if (agents === undefined) return null
    const live = agents.get(sessionId)
    if (live !== undefined) {
      debug('agentFor: 命中活 Agent ' + shortId(sessionId) + ' (status=' + live.status + ')')
      return live
    }
    debug('agentFor: ' + shortId(sessionId) + ' 不是活 Agent，尝试冷唤醒')
    if (wake !== true) return null
    try {
      const handle = await agents.resume(await buildResumeOptions(sessionId))
      wakeHandles.set(sessionId, handle)
      return handle.agent
    } catch (err) {
      // 冷唤醒失败（无持久化后端 / 会话已不存在）不是致命错误：房间照常记录，只是投递未达。
      debug('agentFor: 冷唤醒失败 ' + shortId(sessionId) + ' -> ' + (err && err.message ? err.message : String(err)))
      return null
    }
  }

  // ---- 成员边界进**自己的** system prompt（真机 #1732，255563de 报） ------------------
  //
  // 问题：方向此前只活在两个地方 —— 房间侧 rooms.json + **被叫醒那一刻的帧尾**。
  // 于是三种回合里会话不知道自己的边界：自己开工 / 用户直接跟它对话 / 新窗口第一轮；
  // 而帧尾那份是 fan-out 时的**快照**，压缩之后还可能已经是旧的。
  //
  // 做法（照第一方插件 dsh-file-reference-local 的成例）：把一条 section 注册进
  // **这个 agent 自己的作用域** —— agent.ctx.inject([systemPrompt], scope => scope.systemPrompt.section(...))。
  // 关键在 text() 是**每次组装现算**的：它闭包住 sessionId、读的是 store 的当前值，
  // 所以方向一改，下一轮提示词就是新的（帧尾那条快照补不上的正是这一格）。
  //
  // 为什么不能只注册一条全局 section 再在 text() 里看"这次组装的是谁"：AssembleContext 只有
  // { scope, signal }、**没有 agent/session 身份**（#1732 报的硬约束；我读 types/index.d.ts:37-45 核过）。
  const boundaryFibers = new Map() // sessionId -> { agent, fiber }

  /** 这个成员此刻的边界（空串 = 不在任何房间 → 空段自动消失，不占 token）。每次组装现算。 */
  function boundaryText(sessionId) {
    const out = []
    for (const room of store.listRooms()) {
      const m = store.members(room.id).find((x) => x.sessionId === sessionId && x.enabled !== false)
      if (m === undefined) continue
      // 散文的**尾部标点要先去掉**：这一段是 `你的方向：<散文>；收录范围：…` 直接拼的，
      // 散文本身以句号结尾时拼出来就是「…报告并 @ 负责人。；你负责：…」（".；"）。
      // 真机 #1772 由 255563de 报来（它自己那条就是句号结尾）；我自己这一轮的提示词里也有同一个形状。
      // 只剥尾部、只剥标点 —— 中间那些标点是作者的话，不动。
      const rawDir = String(m.selfDescription || "").trim()
      const dir = rawDir.replace(/[。；;．.]+$/u, "").trim()
      const paths = Array.isArray(m.paths) ? m.paths : []
      const excludes = Array.isArray(m.excludes) ? m.excludes : []
      const watch = m.watch === "all" ? "全收（观察者/审计席）"
        : (m.watch === "wake" ? "唤醒（全推变更、会叫醒，但不必回执）"
          : (m.watch === "feed" ? "只收不答（全推变更、不产生义务）"
            : (m.watch === "none" ? "静音（不收变更推送；普通发言里 @ 你仍会叫到）" : "默认（只推 @ 你 与人的发言）")))
      // **这条段的成本是"每个请求都付"**，所以必须自己带上限（真机复算：13 人里中位 460 字、
      // 最长 1091 字 —— 那是按全文方向 + 全部 paths 算的，太贵）。它是**提醒**，不是台账：
      // 方向截 200 字、paths 只列前 4 条，要全的用 room_status 拉。
      // 截断在**剥标点之后**：否则 `dir.slice(0,200)+"…"` 会把那个还要去掉的句号留在中间。
      // 方向只有标点（剥完为空）⇒ 按"还没声明方向"走，而不是印一个空的「你的方向：；…」。
      const shortDir = dir.length > 200 ? dir.slice(0, 200) + "…" : dir
      const pathShot = paths.slice(0, 4).join(" ") + (paths.length > 4 ? " …共 " + paths.length + " 条" : "")
      out.push("【聊天室边界 · " + room.name + "】"
        + (dir !== "" ? "你的方向：" + shortDir : "你还没声明方向（先调 room_intent）")
        + (paths.length > 0 ? "；你负责：" + pathShot : "")
        + (excludes.length > 0 ? "；不碰：" + excludes.join(" ") : "")
        + "；收录范围：" + watch
        + "。改别人的地盘之前先 room_owners 查一次，并在房间里 @ 负责人。")
    }
    return out.join("\n")
  }

  /** 给这个 agent 装上「你的边界」段（作用域 = 它自己）。同一个人换了 agent 对象要重装。 */
  function installBoundary(agent, sessionId) {
    if (agent === undefined || agent === null) return
    const prev = boundaryFibers.get(sessionId)
    if (prev !== undefined && prev.agent === agent) return
    if (prev !== undefined) {
      try { prev.fiber.dispose() } catch { /* 卸载期忽略 */ }
      boundaryFibers.delete(sessionId)
    }
    const actx = agent.ctx
    if (actx === undefined || actx === null || typeof actx.inject !== "function") return
    try {
      const fiber = actx.inject(["systemPrompt"], (scope) => {
        const sp = scope === undefined || scope === null ? undefined : scope.systemPrompt
        if (sp === undefined || typeof sp.section !== "function") return
        sp.section({
          name: BOUNDARY_SECTION,
          order: 161, // 紧跟全局协议段（order 160），读起来是一块
          text: () => boundaryText(sessionId),
        })
      })
      boundaryFibers.set(sessionId, { agent, fiber })
    } catch (err) {
      debug("边界段注册失败（不影响房间）: " + (err && err.message ? err.message : String(err)))
    }
  }

  /** 这个 session 是不是某个房间的在册成员（新 agent 只给成员装段）。 */
  function isRoomMember(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return false
    return store.listRooms().some((room) => store.activeMembers(room.id).some((m) => m.sessionId === sessionId))
  }

  /** 房间成员里凡是有活 agent 的，都装上边界段（启动时一次；此后靠 deliver 兜）。 */
  function installBoundariesForMembers() {
    if (agents === undefined || typeof agents.get !== "function") return
    for (const room of store.listRooms()) {
      for (const m of store.activeMembers(room.id)) {
        const live = agents.get(m.sessionId)
        if (live !== undefined && live !== null) installBoundary(live, m.sessionId)
      }
    }
  }

  /**
   * 把一条房间消息投递给某个成员。
   * @param mode 'followup' 产生义务、会唤醒（BLUEPRINT §7 第一行）
   *             'inject'   只是背景上下文、不唤醒、不产生义务
   */
  /** 一帧消息真正送进某个 agent；失败只留证据、返回 false（不抛）。 */
  function sendOne(agent, mode, msg, room, extra) {
    const author = msg.sender && typeof msg.sender.sessionId === 'string' ? msg.sender.sessionId : null
    // 只放真实存在的字段：人的发言没有 senderSessionId，就**换成 user 那支**（不是留个空键 ——
    // 带 undefined 的键会被 DSH 的 lossless-JSON 校验拒收，真机 2026-09-10 踩过）。
    const userMessage = createUserMessage({
      content: [{ type: 'text', text: frame(room || { name: '?' }, msg, extra) }],
      source: chatroomSource(author, msg.roomId),
    })
    try {
      if (mode === 'inject') agent.inject(userMessage)
      else if (mode === 'steer') agent.steer(userMessage)
      else agent.followup(userMessage)
      return true
    } catch (err) {
      // 吞掉原因是不可诊断的：这里必须留下证据。
      debug('deliver: ' + mode + ' 投递失败 -> '
        + (err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err)))
      return false
    }
  }

  /**
   * 把一条房间消息投递给某个成员。
   *
   * **投递台账在这里记**（借自 agent-team 的 durable mailbox：投递 · 确认 · 恢复）：
   *  · 投之前记一笔（幂等）；投成功 markDelivered，失败 failDelivery（attempts+1）；
   *  · **补投**：这个人若还有「上次没投出去」的帧，先补最老的那一帧（recovery 那一段）。
   *    agent-team 的原话：*a teammate that was offline receives its queued messages when it resumes*。
   *  · **背景通道（inject）不进台账**：它本来就是"看得到但不打扰"的尽力而为，
   *    把没有义务的推送也记成"待确认"只会让面板上的待确认数永远不归零。
   *  · 台账的持久化由调用方在循环之后 persist 一次（真机 rooms.json 已 7.8 MB，
   *    每个成员写一次会把一条消息变成 N 次整份落盘）。
   */
  async function deliver(sessionId, message, { mode = 'followup', extra = '' } = {}) {
    const agent = await agentFor(sessionId)
    const roomId = typeof message.roomId === 'string' ? message.roomId : null
    const tracked = roomId !== null && mode !== 'inject'
    if (tracked) store.recordDelivery(roomId, sessionId, message.seq)
    if (agent === null) {
      if (tracked) store.failDelivery(roomId, sessionId, message.seq)
      return false
    }
    // 顺手把「你的边界」段装到它自己身上（幂等；换了 agent 对象会重装）——
    // 这样它**不必被叫醒**也能在任何回合看到自己的边界（#1732）。
    installBoundary(agent, sessionId)
    if (tracked) {
      const missed = store.pendingDeliveries(roomId, sessionId)
        .find((d) => d.deliveredAt === null && d.seq !== message.seq && (d.attempts || 0) < DELIVERY_MAX_ATTEMPTS)
      if (missed !== undefined) {
        const old = store.state.messages.find((m) => m.roomId === roomId && m.seq === missed.seq)
        if (old !== undefined) {
          const room = message.room || store.getRoom(roomId)
          if (sendOne(agent, mode, old, room, ' —— **补投**：这一条上次没能送到你这里')) {
            store.markDelivered(roomId, sessionId, missed.seq)
          } else {
            store.failDelivery(roomId, sessionId, missed.seq)
          }
        }
      }
    }
    const ok = sendOne(agent, mode, message, message.room || store.getRoom(roomId), extra)
    if (tracked) {
      if (ok) store.markDelivered(roomId, sessionId, message.seq)
      else store.failDelivery(roomId, sessionId, message.seq)
    }
    return ok
  }

  /** 任务在人读得到的地方长什么样（列表与单条共用一种写法）。 */
  function describeTask(roomId, t) {
    const own = t.owner === null ? '未认领' : shortId(t.owner)
    const deps = Array.isArray(t.deps) && t.deps.length > 0 ? ' ←依赖 ' + t.deps.join(',') : ''
    const paths = Array.isArray(t.expectPaths) && t.expectPaths.length > 0 ? '  预期改: ' + t.expectPaths.join(' ') : ''
    const note = t.note === undefined ? '' : '  （' + t.note + '）'
    return '[' + t.id + '] ' + t.status + '  ' + own + '  ' + t.title + deps + paths + note
  }

  /**
   * 任务里的 expectPaths 与**成员边界**对一遍 —— 这条最值钱的地方是**时机**：
   * 房间原来只会在"改完声明"之后 ⚠（事后对质），有了任务板就能在**认领任务时**看见会碰谁的地盘。
   * 与 room_declare_change 共用 detectOverreach（同一个判据，绝不另起一套）。
   * **不写 @、不登记义务**：任务板是分工，不是要谁表态（与 ⚠ 越界那行同一条纪律）。
   */
  function expectPathsNote(roomId, expectPaths, selfSessionId, opts = {}) {
    const files = Array.isArray(expectPaths) ? expectPaths : []
    if (files.length === 0) return ''
    const hits = detectOverreach(files, store.members(roomId), selfSessionId, opts)
    if (hits.length === 0) return ''
    return '  ⚠ **可能越界**：' + hits.map((h) => h.matched
      .map((m) => m.file + '（匹配到方向里的「' + m.token + '」）').join('、')
      + ' 落在 ' + shortId(h.sessionId) + ' 声明的范围').join('；')
      + ' —— 只是范围提示，要不要请对方确认由你定'
  }

  /**
   * 投递时附一句「你负责什么」。
   *
   * 方向是这套东西避免**越权**的唯一依据：没有它，收到消息的会话只能凭感觉判断
   * 「这块是不是我该动的」。所以每次叫人回话，都顺手把它的方向摆到眼前 ——
   * 没声明过的就明说要先声明（真机反馈 2026-09-12：责任区分不明显、可能越权）。
   */
  function directionHint(member, seq) {
    const mine = String(member.selfDescription || '')
    const paths = Array.isArray(member.paths) ? member.paths : []
    // 边界是**机器读的**那一份，唤醒帧里必须给出来：只给散文的话，
    // 收件人看到的是一段可能已被截断的叙述，而判定用的是 paths（两者不一致时它会莫名其妙被叫醒/不被叫醒）。
    const bound = paths.length > 0
      ? '（你的机器可读边界：' + paths.slice(0, 6).join(' ') + (paths.length > 6 ? ' …共 ' + paths.length + ' 条' : '') + '）'
      : ''
    // ⚠ **这里不能写断言式的话**（真机 #1714，255563de 实测）：这一帧的内容是 fan-out 那一刻的
    // 快照，而 DSH 可能把它压在 next-turn 队列里几分钟 —— 送达时"你还没声明方向"可能已经是假话
    // （它实测到同一字段在一次声明前后取到两种值）。所以改成条件式，并标明取自何时。
    const stamp = seq === undefined || seq === null ? '' : '（本帧取自 #' + seq + ' 发出时）'
    if (mine === '' && bound === '') {
      return ' ｜ ' + stamp + '若你还没在房间里声明方向，先调 room_intent 说清你负责什么 —— 别人才判断得了边界'
    }
    // 显示侧才截：存储是全文（setSelfDescription 不再静默截断），这里受上下文预算约束
    const shown = mine.length > 200 ? mine.slice(0, 200) + '…（共 ' + mine.length + ' 字，全文用 room_status 读）' : mine
    // 同理：**方向也是快照**，可能已经改过。标明取自何时，读者才知道要不要以它为准。
    const text = mine !== '' ? '你声明过的方向：「' + shown + '」' : '（你的方向只有结构化边界，没有散文）'
    const watchNote = member.watch === 'all' ? '（观察者席位：收全量变更）'
      : (member.watch === 'wake' ? '（唤醒席：变更全推、会叫醒你，但不必回执）'
        : (member.watch === 'feed' ? '（只收不答席：变更全推、不产生义务）'
          : (member.watch === 'none' ? '（静音席位：不收变更推送）' : '')))
    return ' ｜ ' + stamp + text + bound + watchNote + '（若这次动作越出这个范围，请在回执里说明）'
  }

  /**
   * 背景注入要不要跳过这个成员（2026-09-16 用户决定：**默认只推「@ 你」与「人的发言」**）。
   *
   * 三档，由成员自己的 room_intent 定：
   *   watch=all   —— 观察者/审计席：**全推** + 每条都唤醒 + **必回**（义务）
   *   watch=wake  —— **唤醒席**：全推 + 叫醒，但**不必回**（真机 #1920 补的那个角）
   *   watch=feed  —— **只收不答**：全推，但**不叫醒**、不产生义务（真机 #1798 补的那个角）
   *   watch=quiet —— 默认：只推「@ 你」与「人的发言」；变更与闲聊一律走「拉」
   *   watch=none  —— 同 quiet，且**连变更推送也不要**（普通发言里 @ 它仍会叫到；声明正文里的 @ 不算，真机 #1824）
   *
   * 为什么这是"开关"而不是"判据"（上一版的教训）：变更通知带 files、可以确定性判定，
   * 但 free 发言没有文件清单 —— "与谁相关"只能猜，而今晚所有事故都来自猜。
   * 用户选了明确的默认值，于是这里不再有任何猜测成分。
   *
   * 不推 ≠ 看不见：room_message(seq) 与 room_status 仍能拉到全文，房间历史与审计链一条不少。
   * 人的发言永远推（D4 义务）；@ 你 的走上游的义务通道，根本到不了这里。
   */
  function skipInject(member, message) {
    if (message.kind === 'human') return false   // D4：人的发言全体可见，不受收录范围影响
    // 观察者席与只收不答席：**全推**。两者的差别不在这一层，而在义务层
    // （all 会被 ownershipLookup 判 wouldWake ⇒ 走 followup；feed 不进那一步 ⇒ 只 inject）。
    if (member.watch === 'all' || member.watch === 'feed' || member.watch === 'wake') return false
    return true                                  // quiet（默认）/ none：其余一律走「拉」
  }

  /**
   * 一条消息产生义务后，逐人投递。
   * BLUEPRINT D5：只有「人的发言 / @ 提及」走到这里；回执（terminal）永远走不到。
   */
  async function fanout(roomId, seq, opts = {}) {
    const room = store.getRoom(roomId)
    if (room === null) return []
    const message = store.state.messages.find((m) => m.roomId === roomId && m.seq === seq)
    if (message === undefined) return []
    const obligors = store.obligors(roomId, seq)
    const obligated = new Set(obligors.map((m) => m.sessionId))
    const mentioned = new Set(Array.isArray(message.mentions) ? message.mentions : [])
    const author = message.sender && message.sender.sessionId ? message.sender.sessionId : null
    // 提前建：下面「唤醒但不必回」那一轮与背景通道那一轮都要用它
    const alreadyJudged = new Set(store.judgedBy(roomId, seq))
    const results = []
    for (const member of obligors) {
      // 作者自己不投（真机 #45 / #58 / #61）：obligors 那一侧已经排过，这里再挡一道 ——
      // 对着「正在执行这次 room_say 的 agent」发 followup 是**唯一**能产生
      // 「回执之后又被投一次」的形状（DSH 挂进 next-turn 队列、下一轮才落地）。
      if (author !== null && member.sessionId === author) continue
      const why = mentioned.has(member.sessionId) ? '有人 @ 了你 —— 你必须回一句判断' : '你必须回一句判断'
      const options = ' —— ' + why + '，用 room_judge 工具，verdict 只能取：'
        + VERDICTS.map((v) => v + '(' + VERDICT_LABELS[v] + ')').join(' / ')
        // 投递会滞后：对方可能已经从 room_status 看到这条义务、先表了态，这一帧才落地。
        // 那是回声，不是要它再表一次 —— 明说，别让它去猜（D5 表态是终端的）。
        + '（投递可能滞后：若房间里已显示你就这条表过态，忽略本条即可）'
        + directionHint(member, message.seq)
      const ok = await deliver(member.sessionId, { ...message, room }, { mode: 'followup', extra: options })
      results.push({ sessionId: member.sessionId, delivered: ok })
    }
    // 台账改动合并成**一次**落盘（见 deliver 的说明：每个成员写一次 = N 次整份写）
    if (results.length > 0) await store.persist()
    // **唤醒但不登记义务**（watch=wake，真机 #1920）：这些人不在 mentions 里，所以 obligors 里没有他们 ——
    // 那正是他们**要**的（叫醒 ≠ 必须回）。这里单独补一帧 followup，并**明说不用回**，
    // 让「醒过来看一眼」与「写一句话」在投递层就分开。
    const wakeOnly = new Set(Array.isArray(opts.wakeOnly) ? opts.wakeOnly : [])
    const wakeNote = ' —— 这条只叫你**看一眼**：**不要求回执**（要表态才用 room_judge；不回也不会有人等你）'
    for (const member of store.activeMembers(roomId)) {
      if (!wakeOnly.has(member.sessionId)) continue
      if (obligated.has(member.sessionId)) continue // 已经在义务通道里投过了（越界点名等）
      if (alreadyJudged.has(member.sessionId)) continue
      if (author !== null && member.sessionId === author) continue
      const ok = await deliver(member.sessionId, { ...message, room }, {
        mode: 'followup', extra: wakeNote + directionHint(member, message.seq),
      })
      results.push({ sessionId: member.sessionId, delivered: ok, woken: true })
    }
    // 非义务成员走背景通道：看得到，但不被打扰（BLUEPRINT §2.2）
    // 不回声给发送者自己 —— 它当然知道自己说了什么。
    // **也不回声给已经表过态的人**：表态是终端的（D5），同一条消息不该再送一次
    // （#55 报的「投递层不查已表态」；obligors 那边已经排除，背景通道这里也要排）。
    for (const member of store.activeMembers(roomId)) {
      if (obligated.has(member.sessionId)) continue
      if (wakeOnly.has(member.sessionId)) continue   // 上面已单独叫醒过，别再给它 inject 一遍
      if (alreadyJudged.has(member.sessionId)) continue
      if (author !== null && member.sessionId === author) continue
      // **变更通知按领地过滤**（用户 2026-09-16 定，真机实测支撑）：
      // 有结构化边界的成员此前会收到"与自己无关"的变更**全文** —— 实测（本房间最近 60 分钟）
      // 26 条 / 42 KB，而 13 名成员里 9 名的"相关"是 0 条 ⇒ 每人每小时白吞一整段长对话。
      // 只在**能确定性判定**时才不推（给了 paths 且没命中 / 明确 watch=none）；
      // 没给边界的人照旧全推 —— 对它来说"不相关"不是事实，是猜测（而今晚的教训全是猜出来的）。
      if (skipInject(member, message)) continue
      await deliver(member.sessionId, { ...message, room }, { mode: 'inject' })
    }
    return results
  }

  /**
   * 紧急通道（M3）：用 `steer` 把一条消息插进所有在房间成员的**当前**轮次。
   *
   * **尽力而为** —— `steer` 在取消/销毁时会被丢弃（BLUEPRINT §7），所以它永远不承载
   * 「必须回」的语义：不产生义务、不保证送达、不需要回执。只用在该停手的时候。
   */
  async function broadcastAlert(roomId, seq) {
    const room = store.getRoom(roomId)
    if (room === null) return []
    const message = store.state.messages.find((m) => m.roomId === roomId && m.seq === seq)
    if (message === undefined) return []
    const results = []
    for (const member of store.activeMembers(roomId)) {
      const extra = ' —— ⚡ 紧急打断（best-effort）：若你的当前轮次还没走到步边界，这条可能不达。不需要回执。'
      const delivered = await deliver(member.sessionId, { ...message, room }, { mode: 'steer', extra })
      results.push({ sessionId: member.sessionId, delivered })
    }
    debug('紧急通道: ' + results.filter((r) => r.delivered).length + '/' + results.length + ' 已投出（尽力而为）')
    return results
  }

  /**
   * 审计导出（M3）：把房间历史导成 Markdown —— 蓝图 §13 要求
   * 「每条存在会话日志里的房间消息，都能回答『谁、何时、给谁、说了什么』」。
   */
  function exportMarkdown(roomId) {
    const room = store.getRoom(roomId)
    if (room === null) return ''
    const st = store.status(roomId)
    if (st === null) return ''
    const lines = []
    lines.push('# 聊天室：' + room.name)
    lines.push('')
    lines.push('- 房间 id：' + room.id)
    lines.push('- 创建：' + new Date(room.createdAt).toISOString())
    lines.push('- 导出：' + new Date().toISOString())
    lines.push('- 成员上限 ' + room.policy.maxMembers + ' · 线程预算 ' + room.policy.threadBudget + ' 跳')
    lines.push('')
    lines.push('## 成员')
    lines.push('')
    lines.push('| 短号 | 角色 | 会话标题 | 负责方向 | 在房间 | 已读 |')
    lines.push('|---|---|---|---|---|---|')
    for (const m of st.members) {
      lines.push('| ' + m.shortId + ' | ' + (m.roleName || '') + ' | ' + (m.title || '') + ' | '
        + (m.selfDescription || '') + ' | ' + (m.inRoom ? '是' : '否') + ' | ' + m.lastReadSeq + ' |')
    }
    const changes = store.state.changes.filter((c) => c.roomId === roomId)
    if (changes.length > 0) {
      lines.push('')
      lines.push('## 变更声明与核验')
      for (const c of changes) {
        lines.push('')
        lines.push('### #' + c.seq + ' [' + c.verdict + '] ' + ((c.files || []).join('、') || '（未声明文件）'))
        lines.push('- 声明者：' + shortId(c.declaredBy))
        lines.push('- 依据：' + c.reason + (c.head ? '（HEAD ' + c.head + '）' : ''))
        if (c.diffStat) lines.push('- diff：' + String(c.diffStat).split('\n').filter(Boolean).join(' ; '))
        lines.push('- 相关成员：' + ((c.related || []).map(shortId).join('、') || '（无 —— 未打扰任何人）'))
      }
    }
    lines.push('')
    lines.push('## 时间线')
    for (const m of store.state.messages.filter((x) => x.roomId === roomId)) {
      const who = m.sender && m.sender.user === true
        ? '用户'
        : shortId(m.sender && m.sender.sessionId)
          + (m.sender && m.sender.roleName ? '（' + m.sender.roleName + '）' : '')
      const marks = m.kind + (m.terminal ? '·终端' : '') + (m.budgetStopped ? '·预算耗尽' : '')
      lines.push('- ' + new Date(m.ts).toISOString() + '  **' + who + '**  [' + marks + ']  ' + m.body)
    }
    lines.push('')
    return lines.join('\n')
  }

  // =======================================================================
  // 工具面（BLUEPRINT §8）—— 原始 JSON Schema，不经 defineTool 转换
  // =======================================================================

  /** 从工具执行上下文取调用方 session id。 */
  function callerOf(exec) {
    const agent = exec && exec.agent
    if (agent === undefined || agent === null) return null
    if (agent.session !== undefined && agent.session !== null && agent.session.id !== undefined) return agent.session.id
    return agent.id !== undefined ? agent.id : null
  }

  /**
   * 调用方会话的工作区（`header.cwd`）；拿不到就是空串 = **未知**。
   * 越界判定要拿它跟成员的工作区比（提案 B / P2：不同工作区的同名文件不算越界）。
   */
  function workspaceOf(exec) {
    const agent = exec && exec.agent
    const cwd = agent !== undefined && agent !== null && agent.session !== undefined && agent.session !== null
      && agent.session.header !== undefined && agent.session.header !== null
      ? agent.session.header.cwd : undefined
    return typeof cwd === 'string' ? cwd : ''
  }

  /** 按 id 或名称找房间。 */
  function resolveRoom(key) {
    const wanted = String(key)
    return store.listRooms().find((r) => r.id === wanted || r.name === wanted) || null
  }

  /** 成员在房间里的显示角色名（BLUEPRINT §5：人指定的标签，不改历史归属）。 */
  function roleNameOf(roomId, sessionId) {
    const member = store.members(roomId).find((m) => m.sessionId === sessionId)
    return member === undefined ? '' : member.roleName
  }

  const disposers = []

  disposers.push(registerRoomTool({
    name: 'room_status',
    description: '查看聊天室现状：成员、身份、**各自的边界（负责哪些路径）**、谁欠哪一条回执（**带 seq**）、最近的变更。'
      + '不传 room 则列出全部房间。'
      + '「欠一次表态」后面跟的是**那一条的序号** —— 不用再从"已读停在 N"去猜。'
      + '想读某一条的正文或某个人的回执正文，用 room_message。',
    parameters: {
      type: 'object',
      properties: {
        room: { type: 'string', description: '房间 id 或名称；省略则列出全部房间。' },
        directions: { type: 'boolean', description: 'true = 把每位成员的方向全文都打出来（默认只给你的那一份，避免 N×长文灌上下文）。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      render: textRender,
    },
    execute: async (args, exec) => {
      await ready
      const me = callerOf(exec)
      const wantAllDirections = args.directions === true
      // 列出全部时也要按**成员资格**过滤（栅栏在注册期只拦"点名了房间"的那种调用）。
      const rooms = store.listRooms().filter((r) => store.activeMembers(r.id).some((m) => m.sessionId === me))
      if (rooms.length === 0) {
        return { text: '你还没有加入任何聊天室（房间成员由用户在房间面板里显式加入）—— 或者房间确实一个都还没有。' }
      }
      const wanted = args.room === undefined ? null : String(args.room)
      const picked = wanted === null ? rooms : rooms.filter((r) => r.id === wanted || r.name === wanted)
      if (picked.length === 0) return { text: '找不到房间：' + wanted }
      // 看状态 = **确认**：这一屏里有房间的最后 seq 和它欠谁的回执，它已经"到了房间里"。
      for (const r of picked) await store.ackDelivery(r.id, me, store.lastSeq(r.id))
      const lines = []
      // 状态文件的麻烦不能是静默的（真机 #653：调用方无从判断写没写进去）：
      // 房间在内存里是完整的，盘上可能不是 —— 这条必须在状态里说出来。
      const stateErr = typeof store.stateError === 'function' ? store.stateError() : null
      if (stateErr !== null) {
        lines.push('⚠ 状态文件出过问题（房间里看得到，盘上可能没有）：' + stateErr)
      }
      for (const room of picked) {
        const st = store.status(room.id)
        lines.push('房间 ' + room.name + ' (' + room.id + ')  共 ' + st.members.length + ' 名成员，最后 seq=' + st.lastSeq
          + '，当前靶子 #' + st.targetSeq)
        // 「欠一次表态」必须带上 seq（真机 #1348）：靶子只是最新那条，而义务会积压 ——
        // 只报"欠一次"而不报"欠哪一条"，问的人就只能去翻自己的上下文，翻不到就只能重问一次，
        // 而重问在这套纪律里是**主动唤醒别人**的高成本动作。
        const older = []
        for (const m of st.members) {
          const own = Array.isArray(m.owedSeqs) ? m.owedSeqs : []
          const onTarget = own.indexOf(st.targetSeq) >= 0
          const rest = own.filter((s) => s !== st.targetSeq)
          let owedText = ''
          if (onTarget) {
            owedText = m.overdue ? '  ← 欠一次表态 #' + st.targetSeq + '（已逾时）' : '  ← 欠一次表态 #' + st.targetSeq
            if (rest.length > 0) owedText += '（另有更早未回的 ' + listSeqs(rest) + '）'
          } else if (own.length > 0) {
            owedText = '  ← 还欠更早的 ' + listSeqs(own) + '（当前靶子 #' + st.targetSeq + ' 上不欠 —— 不会再被唤醒）'
          }
          for (const s of rest) older.push(shortId(m.sessionId) + '@' + s)
          // 边界（机器读的那份）要能一眼看到：它决定"改动会不会叫醒这个人"。
          // 只报"未声明方向"是不够的 —— 真机上 6 人里 3 人的方向已被静默截断，
          // 而**结构化边界**（paths）不会随散文一起被砍。
          const p = Array.isArray(m.paths) ? m.paths : []
          const x = Array.isArray(m.excludes) ? m.excludes : []
          let boundText
          // 收录范围那一根轴优先显示：观察者/静音席位**没有**"未声明边界"这个洞，
          // 它们是"按设计不认领"（真机 #1714 —— 旧文案把这两件事混成一句）。
          if (m.watch === 'all') {
            boundText = '  · 观察者席位（收全量变更，不参与越界判定）'
          } else if (m.watch === 'wake') {
            boundText = '  · 唤醒席（变更全推 + 会叫醒，但不必回执）'
          } else if (m.watch === 'feed') {
            boundText = '  · 只收不答席（变更全推、不产生义务）'
          } else if (m.watch === 'none') {
            boundText = '  · 静音席位（不收变更推送；**普通发言**里 @ 仍会叫到）'
          } else if (p.length > 0) {
            boundText = '  · 边界 ' + listTokens(p) + (x.length > 0 ? '（不碰 ' + listTokens(x, 2) + '）' : '')
          } else if (String(m.selfDescription || '') !== '') {
            boundText = '  · 边界靠散文猜（会误报/漏报 —— 建议用 room_intent 的 paths）'
          } else {
            boundText = '  · ⚠ 未声明边界（任何同工作区改动都会唤醒它）'
          }
          lines.push('  - [' + shortId(m.sessionId) + ']'
            + (m.roleName ? ' ' + m.roleName : '')
            + (m.sessionId === me ? ' ← 你' : '')
            + (m.inRoom ? '' : '  ⚠ 未在房间（用户已关闭）— 不要等它的回执')
            + '  已读 ' + m.lastReadSeq
            + boundText
            + owedText
            + (m.verdict ? '  已表态: ' + m.verdict : ''))
          const full = String(m.selfDescription || '')
          if (full !== '' && (wantAllDirections || m.sessionId === me)) {
            lines.push('      ' + (m.sessionId === me ? '你的方向全文' : '方向全文') + '（' + full.length + ' 字）：' + full)
          }
        }
        if (st.pending.length > 0) {
          lines.push('  待表态（靶子 #' + st.targetSeq + '）: ' + st.pending.map(shortId).join(', '))
        }
        if (older.length > 0) {
          lines.push('  旧账（更早的那些没回，**不会再被投递唤醒** —— 要不要补由你和用户定）: '
            + (older.length > 12 ? older.slice(0, 12).join(' ') + ' …共 ' + older.length + ' 条' : older.join(' ')))
        }
      }
      return { text: lines.join('\n') }
    },
  }))

  /**
   * 一条消息的完整档案：正文 + @ 了谁 + 各人的回执（谁 / 什么 verdict / note）。
   *
   * 为什么要有它（真机 #1348）：**回执正文不在提问者的上下文里** ——
   * 「#1295 他当时回了什么」本该是一次查询，实际却只能再问一次；
   * 而重问在这套纪律里是主动唤醒别人的高成本动作（#1349 就是这么发生的）。
   * 事实早就在房间日志里逐字躺着（4025ec87 #1359 也是这么手工查的），缺的只是入口。
   */
  function describeMessage(room, m) {
    const lines = []
    const senderId = m.sender && typeof m.sender.sessionId === 'string' ? m.sender.sessionId : null
    const who = senderId !== null
      ? '[' + shortId(senderId) + ']' + (m.sender.roleName ? ' ' + m.sender.roleName : '')
      : (m.sender && m.sender.user === true ? '[用户]' : '[未知发送者]')
    lines.push('#' + m.seq + '  ' + stamp(m.ts) + '  ' + m.kind
      + (m.terminal === true ? '·终端' : '')
      + (m.budgetStopped === true ? '·线程预算耗尽（不产生义务）' : '')
      + (typeof m.threadId === 'string' ? '  （回复 #' + String(m.threadId).replace(/^re:/, '') + '，第 ' + (m.depth || 0) + ' 跳）' : '')
      + '  ← ' + who)
    const mentions = Array.isArray(m.mentions) ? m.mentions : []
    if (mentions.length > 0) {
      lines.push('@ 到（定向义务 —— 这些人被唤醒过、且要回一句）: ' + mentions.map((x) => shortId(x)).join(' '))
    } else if (m.kind === 'human') {
      lines.push('@ 到: 全体在房间成员（这是用户在说话）')
    }
    // 回执：**正文**才是这条工具存在的理由，所以 verdict 与 note 一起给。
    const js = store.state.judgments.filter((j) => j.roomId === room.id && j.seq === m.seq)
    const still = store.obligors(room.id, m.seq)
    if (js.length === 0 && still.length === 0) {
      lines.push('回执: 这一条不要求任何人回执（终端消息，或没有 @ 任何人，或线程预算已耗尽）')
    } else {
      lines.push('回执（' + js.length + ' 人已回）:')
      if (js.length === 0) lines.push('  （还没有人回过）')
      for (const j of js) {
        lines.push('  [' + shortId(j.sessionId) + '] ' + j.verdict
          + (j.note ? ' —— ' + trimNote(j.note) : '') + '    ' + stamp(j.ts))
      }
      if (still.length > 0) {
        lines.push('还欠: ' + still.map((x) => shortId(x.sessionId)).join(' ')
          + '  ← 把上面的正文与回执转给它们即可，不必让它们再问一遍')
      } else if (m.terminal !== true) {
        lines.push('还欠: （无 —— 这条的回执已经齐了）')
      }
    }
    lines.push('')
    lines.push('正文:')
    lines.push(String(m.body || '')) // 不截断：正文就是这条消息本身
    return lines.join('\n')
  }

  disposers.push(registerRoomTool({
    name: 'room_message',
    description: '读房间历史：给 seq 就返回**那一条**的正文、@ 了谁、以及各人的回执（谁 / 什么 verdict / note 正文）——'
      + '「他当时回了什么」不该靠再问一次（问一次 = 主动唤醒别人）。'
      + '不给 seq 就列出最近的消息（可用 since_seq 从某条之后往前读），用来先找到 seq。',
    parameters: {
      type: 'object',
      properties: {
        room: { type: 'string', description: '房间 id 或名称。' },
        seq: { type: 'integer', description: '要读的那一条（房间里的 #1234）。给了它就只返回这一条。' },
        since_seq: { type: 'integer', description: '列表模式：只看这个序号**之后**的消息。' },
        limit: { type: 'integer', description: '列表模式最多返回多少条，默认 20，上限 50。' },
      },
      required: ['room'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { seq: { type: 'integer' }, text: { type: 'string' } },
        required: ['seq', 'text'],
        additionalProperties: false,
      },
      render: textRender,
    },
    execute: async (args, exec) => {
      await ready
      const room = resolveRoom(args.room)
      if (room === null) return { seq: 0, text: '找不到房间：' + args.room }
      // 主动来拉 = **确认**（A 段第二半）：拉到哪条就确认到哪条。
      const me = exec === undefined ? null : callerOf(exec)
      const all = store.state.messages.filter((m) => m.roomId === room.id)
      if (all.length === 0) return { seq: 0, text: '房间 ' + room.name + ' 还没有任何消息。' }
      const lastSeq = all[all.length - 1].seq
      if (args.seq !== undefined && args.seq !== null) {
        const seq = Number(args.seq)
        // 非法值拒绝而不是夹取（同一套口径：静默改数会让调用方以为查到的是别的条）
        if (!Number.isInteger(seq)) {
          return { seq: 0, text: 'seq 必须是整数（收到 ' + JSON.stringify(args.seq) + '）' }
        }
        const hit = all.find((m) => m.seq === seq)
        if (hit === undefined) {
          return { seq, text: '房间里没有 #' + seq + '（现有 #' + all[0].seq + '–#' + lastSeq + '）' }
        }
        if (me !== null) await store.ackDelivery(room.id, me, seq)
        return { seq, text: describeMessage(room, hit) }
      }
      const rawLimit = args.limit === undefined || args.limit === null ? 20 : Number(args.limit)
      if (!Number.isInteger(rawLimit) || rawLimit < 1) {
        return { seq: 0, text: 'limit 必须是 ≥1 的整数（收到 ' + JSON.stringify(args.limit) + '）' }
      }
      const limit = Math.min(50, rawLimit)
      const from = args.since_seq === undefined || args.since_seq === null ? null : Number(args.since_seq)
      if (from !== null && !Number.isInteger(from)) {
        return { seq: 0, text: 'since_seq 必须是整数（收到 ' + JSON.stringify(args.since_seq) + '）' }
      }
      const pool = from === null ? all.slice(-limit) : all.filter((m) => m.seq > from).slice(0, limit)
      if (pool.length === 0) {
        return { seq: 0, text: '#' + from + ' 之后没有消息（最后 seq=' + lastSeq + '）。' }
      }
      const lines = ['房间 ' + room.name + '：#' + pool[0].seq + '–#' + pool[pool.length - 1].seq
        + '（共 ' + pool.length + ' 条，最后 seq=' + lastSeq + '）']
      for (const m of pool) {
        const sid = m.sender && typeof m.sender.sessionId === 'string' ? shortId(m.sender.sessionId) : '用户'
        const flags = (m.terminal === true ? '·终端' : '') + (Array.isArray(m.mentions) ? ' @' + m.mentions.length : '')
        lines.push('#' + m.seq + '  ' + stamp(m.ts) + '  ' + m.kind + flags + '  [' + sid + ']  ' + flatten(m.body, 110))
      }
      lines.push('（要看某一条的正文与全部回执：room_message(room=' + room.id + ', seq=…)）')
      // 列表分支拉到的是**最新的那一段**，等价于确认到房间最后一条（pool 是尾巴）。
      if (me !== null) await store.ackDelivery(room.id, me, lastSeq)
      return { seq: pool[pool.length - 1].seq, text: lines.join('\n') }
    },
  }))

  disposers.push(registerRoomTool({
    name: 'room_task',
    description: '房间的任务板（借自 DSH agent-team 的 shared task DAG）：create / claim / update / list。'
      + '每条任务带负责人、依赖（同房间的其它任务；成环会被拒）、以及**预期要改的文件**。'
      + 'expectPaths 会在**建任务/认领任务的那一刻**就和成员边界对一遍 —— '
      + '要碰别人的地盘，当场就看得见 ⚠，不必等改完再事后对质（这是房间原有判据的一次"往上挪一格"）。',
    parameters: {
      type: 'object',
      properties: {
        room: { type: 'string', description: '房间 id 或名称。' },
        op: { type: 'string', enum: ['create', 'claim', 'update', 'list'], description: '要做的事。' },
        taskId: { type: 'string', description: 'claim / update 时针对的任务 id。' },
        title: { type: 'string', description: 'create 时的任务标题。' },
        owner: { type: 'string', description: '负责人 sessionId（空字符串 = 放开认领）。' },
        deps: { type: 'array', items: { type: 'string' }, description: '依赖的 taskId 列表。' },
        expectPaths: { type: 'array', items: { type: 'string' }, description: '预期要改的文件/目录。' },
        status: { type: 'string', enum: ['open', 'claimed', 'done', 'dropped'], description: 'update 时的状态。' },
        note: { type: 'string', description: '一句话备注。' },
      },
      required: ['room', 'op'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
        required: ['ok', 'text'],
        additionalProperties: false,
      },
      render: textRender,
    },
    execute: async (args, exec) => {
      await ready
      const sessionId = callerOf(exec)
      const room = resolveRoom(args.room)
      if (room === null) return { ok: false, text: '找不到房间：' + args.room }
      const op = String(args.op)
      // 事前越界也要带工作区（提案 B / P2）：任务里的 expectPaths 是相对**调用方工作区**写的，
      // 跨工作区的同名文件不参与判定。与 room_declare_change 用的是同一份成员工作区。
      const wsOpts = {
        declarerWorkspace: workspaceOf(exec),
        memberWorkspaces: await memberWorkspaceMap(room.id),
      }
      try {
        if (op === 'create') {
          const task = await store.createTask({
            roomId: room.id,
            title: args.title,
            owner: args.owner === undefined || args.owner === '' ? null : String(args.owner),
            deps: args.deps === undefined ? [] : args.deps,
            expectPaths: args.expectPaths === undefined ? [] : args.expectPaths,
            createdBy: sessionId,
            note: args.note === undefined ? '' : String(args.note),
          })
          return { ok: true, text: '任务已建：' + describeTask(room.id, task) + expectPathsNote(room.id, task.expectPaths, sessionId, wsOpts) }
        }
        if (op === 'claim') {
          const task = await store.claimTask(String(args.taskId), sessionId)
          return { ok: true, text: '已认领：' + describeTask(room.id, task) + expectPathsNote(room.id, task.expectPaths, sessionId, wsOpts) }
        }
        if (op === 'update') {
          const patch = {}
          if (args.title !== undefined) patch.title = args.title
          if (args.status !== undefined) patch.status = args.status
          if (args.owner !== undefined) patch.owner = args.owner === '' ? null : String(args.owner)
          if (args.deps !== undefined) patch.deps = args.deps
          if (args.expectPaths !== undefined) patch.expectPaths = args.expectPaths
          if (args.note !== undefined) patch.note = args.note
          const task = await store.updateTask(String(args.taskId), patch)
          return { ok: true, text: '任务已更新：' + describeTask(room.id, task) + expectPathsNote(room.id, task.expectPaths, sessionId, wsOpts) }
        }
        if (op === 'list') {
          const tasks = store.tasksFor(room.id)
          if (tasks.length === 0) return { ok: true, text: '房间 ' + room.name + ' 的任务板是空的。' }
          const lines = ['房间 ' + room.name + ' 的任务板（' + tasks.length + ' 条）：']
          for (const t of tasks) lines.push('  ' + describeTask(room.id, t))
          return { ok: true, text: lines.join('\n') }
        }
        return { ok: false, text: '未知 op：' + op + '（只能是 create / claim / update / list）' }
      } catch (err) {
        // 失败一律**说清楚**是哪一条规则拦下的（任务板的价值一半在"说不清就没人用"）
        return { ok: false, text: '任务板操作失败：' + (err && err.message ? err.message : String(err)) }
      }
    },
  }))

  disposers.push(registerRoomTool({
    name: 'room_say',
    description: '在聊天室里说一句话。默认**不**要求别人回应（只是背景上下文）；'
      + '但话里写了 @短号、@角色名 或 @全体，被点到的人就会被**主动唤醒**、并且必须回一句判断。'
      + '要点名要人表态、要划边界，都用 @。'
      + '**只是想提到某人、不要他回话**：正文里写明「不需要回应」，或传 wake=false（后者更硬）。',
    parameters: {
      type: 'object',
      properties: {
        room: { type: 'string', description: '房间 id 或名称。' },
        text: { type: 'string', description: '要说的内容。' },
        wake: {
          type: 'boolean',
          description: '可选：@ 到的人要不要真的被唤醒并要求回话。默认 true。'
            + '只想"提到"某人时传 false（正文里写「不需要回应」同样有效，但这个参数更明确）。',
        },
        retracts: {
          type: 'array',
          items: { type: 'integer' },
          description: '可选：**撤回你自己**之前某几条消息产生的义务（例：[1601]）。'
            + 'wake=false 与「不需要回应」标记只在**发送时**抑制；这条是**事后**销账 ——'
            + '只认作者本人，销掉之后那几条从对方的「欠一次表态 / 旧账」里一并消失（真机 #2131③）。',
        },
      },
      required: ['room', 'text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { seq: { type: 'integer' }, text: { type: 'string' } },
        required: ['seq', 'text'],
        additionalProperties: false,
      },
      render: textRender,
    },
    execute: async (args, exec) => {
      await ready
      const sessionId = callerOf(exec)
      const room = resolveRoom(args.room)
      if (room === null) return { seq: 0, text: '找不到房间：' + args.room }
      const text = String(args.text)
      // @ 提及 → 定向义务（会主动唤醒被点到的人）。没有 @ 就只是背景上下文，不打扰任何人。
      // 「不需要回应」是**段落级**的（#1598/#1609 报的缺陷：整条抑制会把别处的真提问一起吞掉）。
      const scoped = parseMentionsScoped(text, store.activeMembers(room.id), sessionId)
      // 显式 wake=false 是**整条**免回（比文本标记更硬，也是唯一能确定表达"整条"的办法）。
      const byFlag = args.wake === false
      const mentions = byFlag ? [] : scoped.mentions
      const suppressed = byFlag
        ? scoped.mentions.concat(scoped.suppressed.filter((id) => !scoped.mentions.includes(id)))
        : scoped.suppressed
      // **作者撤回**（#2131③）：先销账，再发这条 —— 销的是「义务」，不是消息本身。
      const wantRetract = (Array.isArray(args.retracts) ? args.retracts : [])
        .map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0)
      const retracted = []
      const refused = []
      for (const s of wantRetract) {
        const r = await store.retract(room.id, s, sessionId)
        if (r.ok === true) retracted.push({ seq: r.seq, already: r.already === true })
        else refused.push('#' + s + '（' + (r.reason === 'not-author' ? '不是你发的' : '房间里没有这条') + '）')
      }
      // 机器动作写进正文：别人看到的是「撤回」这件事本身，而不是自己去猜散文。
      const retractNote = retracted.length > 0
        ? '  〔已撤回 ' + retracted.map((r) => '#' + r.seq).join('、') + ' 的义务：那几条不用再回〕'
        : ''
      // P5（真机 2026-09-25 #5017②）：一条新 @ 会把**房间靶子**推走 —— 原来欠着旧靶子的人**仍欠**，
      // 但不会再被唤醒去回（那就是"旧账"）。这里先记下推之前的靶子，发完再把事实写进返回。
      const targetBefore = store.status(room.id).targetSeq
      const message = await store.appendMessage({
        roomId: room.id,
        sender: { sessionId, roleName: roleNameOf(room.id, sessionId) },
        kind: 'free',
        body: text + retractNote,
        mentions: mentions.length > 0 ? mentions : null,
      })      // **永远走 fanout**：有 @ 的那些人拿 followup（被唤醒、必须回），
      // 其余成员拿 inject（背景上下文，看得到但不被打扰）—— BLUEPRINT §2.2 的背景通道。
      // （早先"没 @ 就不投递"是错的：那样别人连背景都看不到。）
      const delivered = await fanout(room.id, message.seq)
      const woke = delivered.filter((d) => d.delivered).length
      // P5：谁被这条推成了旧账（仍欠、但不会再被唤醒）。判据取自 store.status（与 room_status / 面板同一份）。
      const after = store.status(room.id)
      const displaced = after.members.filter((m) => {
        const own = Array.isArray(m.owedSeqs) ? m.owedSeqs : []
        return targetBefore > 0 && own.includes(targetBefore) && !own.includes(after.targetSeq)
      })
      const displaceNote = displaced.length === 0 ? ''
        : '；⚠ 靶子从 #' + targetBefore + ' 推到 #' + after.targetSeq + '：' + displaced.length + ' 人（'
          + displaced.map((m) => shortId(m.sessionId)).join(' ') + '）仍欠 #' + targetBefore
          + '，但它已成**旧账** —— 不会再被投递唤醒（room_status 看得到；要它现在回就用 room_alert 或再 @ 一条）'
      return {
        seq: message.seq,
        text: '已发言 #' + message.seq
          + describeMentions({ kept: mentions, dropped: suppressed, byFlag, markedLines: scoped.markedLines, woke })
          + displaceNote
          + (retracted.length > 0
            ? '；已撤回 ' + retracted.map((r) => '#' + r.seq + (r.already ? '（本来就已撤回）' : '')).join('、') + ' 的义务'
            : '')
          + (refused.length > 0 ? '；没撤回：' + refused.join('、') : ''),
      }
    },
  }))

  disposers.push(registerRoomTool({
    name: 'room_judge',
    description: '对聊天室里某条消息表态。这是终端的：表态不会要求别人再表态。',
    parameters: {
      type: 'object',
      properties: {
        room: { type: 'string', description: '房间 id 或名称。' },
        seq: { type: 'integer', description: '要回应的消息序号。' },
        verdict: { type: 'string', enum: VERDICTS, description: '不受影响 / 我要跟上 / 我要重跑测试 / 需要更多信息。' },
        note: { type: 'string', description: '可选的一句补充。' },
      },
      required: ['room', 'seq', 'verdict'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
        required: ['ok', 'text'],
        additionalProperties: false,
      },
      render: textRender,
    },
    execute: async (args, exec) => {
      await ready
      const sessionId = callerOf(exec)
      const room = resolveRoom(args.room)
      if (room === null) return { ok: false, text: '找不到房间：' + args.room }
      await store.judge({
        roomId: room.id,
        seq: Number(args.seq),
        sessionId,
        verdict: String(args.verdict),
        note: args.note === undefined ? '' : String(args.note),
      })
      // 表态 = **确认**：它确实到了房间里，把 ≤ 这条的投递台账销掉（A 段第二半）。
      await store.ackDelivery(room.id, sessionId, Number(args.seq))
      const st = store.status(room.id, Number(args.seq))
      return {
        ok: true,
        text: '已表态 #' + args.seq + '：' + args.verdict
          + (st.pending.length > 0 ? '；还差 ' + st.pending.map(shortId).join(', ') : '；该条已全员表态'),
      }
    },
  }))

  disposers.push(registerRoomTool({
    name: 'room_declare_change',
    description: '声明你改动了哪些文件。房间会立刻用 git 事实核验这份声明（已证实 / 未证实 / 与事实不符），'
      + '并只叫醒可能受影响的成员。改完共享文件必须调用它——隐瞒或含糊会让别人基于错误假设工作。',
    parameters: {
      type: 'object',
      properties: {
        room: { type: 'string', description: '房间 id 或名称。' },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: '改动的工作区相对路径列表（相对你的会话工作目录，如 `dsh-chatroom/lib/index.js`）。'
            + '核验时若你的会话工作目录不是 git 仓库，会自动按这些文件回溯到它们所属的仓库。',
        },
        summary: { type: 'string', description: '一句话说明改了什么。' },
        symbols: { type: 'array', items: { type: 'string' }, description: '涉及的函数/类名，便于别人判断相关性。' },
        intent: { type: 'string', description: '为什么改。' },
        ref: {
          type: 'string',
          description: '可选：本次改动对应的 commit。给了它，核验就以 commit 事实为准（与时间无关）——'
            + '能解析成 commit、是 HEAD 的祖先、且该 commit 覆盖了你声明的文件 → 直接判定「已证实」。'
            + '已经提交过的改动建议都带上它。',
        },
      },
      required: ['room', 'files', 'summary'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { seq: { type: 'integer' }, verdict: { type: 'string' }, text: { type: 'string' } },
        required: ['seq', 'verdict', 'text'],
        additionalProperties: false,
      },
      render: textRender,
    },
    execute: async (args, exec) => {
      await ready
      const sessionId = callerOf(exec)
      const room = resolveRoom(args.room)
      if (room === null) return { seq: 0, verdict: 'unknown', text: '找不到房间：' + args.room }
      const files = Array.isArray(args.files) ? args.files.map(String) : []
      const declaredWorkspace = workspaceOf(exec)

      // 0) **事实该去哪问**（§6.2.1）：会话 cwd 是 git 工作区就用它；不是（真机：cwd 是
      //    几个仓库的父目录，插件自己刚建仓也照样核不出来）就按声明文件回溯到所属仓库。
      //    回溯只改「去哪个仓库查」与声明路径的写法，不改变「要有 git 事实才算已证实」这条。
      const resolved = await resolveWorktree({ workspace: declaredWorkspace, files })
      const workspace = resolved.workspace

      // 1) 拿 git 事实对质（BLUEPRINT §6.2）。失败一律 unverified，不拖垮登记。
      //    锚点 = **本次会话的开始时间**（拿不到退房间建立时间）。这是判定「这次会话里到底动没动过」
      //    的正确基准 —— 2026-09-12 的事故就是锚错了地方：拿"房间上次记下的 HEAD"当基准，
      //    结果一个 1 小时 54 分前提交、刚进房间才声明的改动被判成「与事实不符」（撒谎档）。
      const baseline = store.baselineFor(room.id, workspace)
      const sessionStart = exec && exec.agent && exec.agent.session && exec.agent.session.header
        && typeof exec.agent.session.header.createdAt === 'number' ? exec.agent.session.header.createdAt : 0
      const anchorMs = sessionStart > 0 ? sessionStart : (typeof room.createdAt === 'number' ? room.createdAt : null)
      const anchorLabel = sessionStart > 0 ? '本次会话开始' : '房间建立'
      const check = await verifyDeclaration({
        workspace,
        files: resolved.files,
        sinceRef: baseline === null ? null : baseline.head,
        anchorMs,
        anchorLabel,
        ref: args.ref === undefined || args.ref === null ? null : String(args.ref),
      })
      // 回溯这件事必须跟着结论走：描述里会写明「git 事实取自哪个仓库」，
      // 否则一句「已证实」会被读成是对会话工作区的判定（而那个目录根本不是仓库）。
      check.workspaceUsed = workspace
      check.repoFallback = resolved.fallback
      // 回溯的**理由**也要带出去：两种情形读起来完全不同
      // （"会话工作区不是仓库" vs "声明的文件在别的仓库里" —— 后者真机 #1454 撞过）
      check.repoReason = resolved.reason
      // 路径写错时的提示（真机 2026-09-16 我自己把 `dsh-chatroom/BLUEPRINT.md` 写成了 `BLUEPRINT.md`）
      check.nearMiss = resolved.nearMiss
      const mark = describeVerification(check)
      debug('变更核验: ' + check.verdict + ' (' + check.reason + ') workspace=' + workspace
        + (resolved.fallback ? ' [回溯自声明文件；会话 cwd=' + declaredWorkspace + ']' : ''))

      // 2) 确定性匹配：谁可能相关（零 token）。只有他们会被叫醒表态。
      const relatedSets = await relatedIds(room.id, sessionId, workspace, files)
      const related = relatedSets.wake
      const noReplySet = new Set(relatedSets.noReply)

      // 声明者自己的方向也带上：别人据此判断「这算不算越界」，比事后对质便宜。
      const members = store.members(room.id)
      const mineMember = members.find((m) => m.sessionId === sessionId)
      const mineDir = mineMember === undefined ? '' : String(mineMember.selfDescription || '')

      // 3) 越界检测：这些文件落在**别人**声明负责的范围里吗？
      //    用户原话：「发现别的会话负责的区域有问题，没有发到 chatroom 并 @，直接自己改了」。
      //    插件拦不住手，但能让它**不可能悄悄发生**：写进消息 + 把负责人一起 @ 上（它必须回一句）。
      //
      //    ⚠ 行的措辞是 #45 那次假阳性逼出来的：**必须回引「匹配到哪个子串、来自哪一句」**。
      //    原来只写「落在 @xxx 负责的范围（它的方向：…）」——方向被截断，作者要自己回去翻才想得到
      //    是哪个词触发的。现在一眼能自诊（甚至一眼能看出这是我的误判）。
      const overreach = detectOverreach(files, members, sessionId, {
        // 声明的文件住在哪个工作区（resolveWorktree 的结论）—— 成员的 paths 是相对**它自己**工作区写的，
        // 不同工作区不参与判定（提案 B / P2：真机 #4866/#4870 那两次假 ⚠ 就是兄弟仓的同名文件命中本仓边界）。
        declarerWorkspace: workspace,
        memberWorkspaces: await memberWorkspaceMap(room.id),
      })
      // 注意：这里**故意不写 `@`**（只写裸短号）。
      // 义务根本不靠正文里的 @ —— 它由下面 mentions 数组显式给出；而正文里的 @ 是一颗雷：
      // 任何人想讨论这条 ⚠，就必须引述它，一引述就 @ 到它点名的人（真机 #58 报的
      // 「引述即提及」，两个实例都源于这段文本）。插件自己产出的文本更不该带引信。
      const overreachNote = overreach.length === 0 ? '' : ' ⚠ **可能越界**：'
        + overreach.map((h) => h.matched
          .map((m) => m.file + '（匹配到方向第 ' + m.index + ' 句里的「' + m.token + '」：'
            + m.sentence.slice(0, 60) + (m.sentence.length > 60 ? '…' : '') + '）')
          .join('、')
          + ' 落在 ' + shortId(h.sessionId) + ' 声明的范围 —— 请 ' + shortId(h.sessionId) + ' 确认').join('；')
      if (overreach.length > 0) debug('越界提醒: ' + overreach.map((h) => shortId(h.sessionId)).join(','))

      const body = String(args.summary)
        + (files.length > 0 ? ' [' + files.join(', ') + ']' : '')
        + (args.intent ? ' — ' + args.intent : '')
        + (mineDir === '' ? ' （⚠ 我还没声明方向）' : ' （我的方向：' + mineDir + '）')
        + overreachNote
        + '  ' + mark
        // ref 覆盖之外的额外文件落在**谁的地盘**（837e0518 #3863：这条提示要能回答"带了谁的 hunk"）。
        // 与上面那条 ⚠ 同一条纪律：**只写裸短号，不制造提及、不登记义务** —— 它是范围提示，不是要谁表态。
        + extraFilesOwnerNote(check.refExtra, members, sessionId, {
          declarerWorkspace: workspace,
          memberWorkspaces: await memberWorkspaceMap(room.id),
        })

      // 定向义务 = 会被叫醒的相关成员里**需要回**的那些 ∪ 被越界点名的负责人
      // （watch=wake 的人照样被叫醒，但不进义务集、不进 mentions：真机 #1920）
      const obliged = [...new Set([
        ...related.filter((id) => !noReplySet.has(id)),
        ...overreach.map((h) => h.sessionId),
      ])]
      const message = await store.appendMessage({
        roomId: room.id,
        sender: { sessionId, roleName: roleNameOf(room.id, sessionId) },
        kind: 'change-notice',
        body,
        refs: files,
        mentions: obliged,
      })

      store.state.changes.push({
        id: 'chg-' + message.seq,
        seq: message.seq, // 面板靠它把变更和该条消息的表态 join 起来
        roomId: room.id,
        // workspaceId/files 是**核验口径**（历史重判 §11.x 会拿这两个字段重跑，
        // 所以必须是「事实所在的那个仓库 + 仓库内相对路径」）；声明原话另存一列备查。
        workspaceId: workspace,
        files: resolved.files,
        declaredWorkspace: declaredWorkspace,
        declaredFiles: files,
        // 声明者给的 ref 与它的**解析状态**（#623：ref 无效必须留痕，不能只活在回执里）。
        // refState: null（没给）/ ok / not-found / not-a-commit / not-ancestor / unavailable
        ref: typeof args.ref === 'string' && args.ref.trim() !== '' ? args.ref.trim() : null,
        refState: check.refState === undefined ? null : check.refState,
        symbols: Array.isArray(args.symbols) ? args.symbols.map(String) : [],
        declaredBy: sessionId,
        verdict: check.verdict,
        reason: check.reason,
        head: check.head,
        diffStat: check.diffStat,
        perFile: check.files,
        related,
        ts: Date.now(),
      })
      await store.persist()
      // 记下新的参照点：下次声明就能精确判断「自那以来动没动过」。
      await store.setBaseline(room.id, workspace, check.head)

      const delivered = await fanout(room.id, message.seq, { wakeOnly: relatedSets.noReply })
      const arrived = delivered.filter((d) => d.delivered).length
      return {
        seq: message.seq,
        verdict: check.verdict,
        text: '变更已登记 #' + message.seq + '。' + mark + '。'
          // 越界提醒也要**当场**回到声明者手里：它是最该看到这条的人（别人只是被 @ 来确认）
          + (overreachNote === '' ? '' : overreachNote + '。')
          + (related.length === 0
            ? '没有成员被判定为可能受影响（仅记入房间，不打扰任何人）'
            : '已唤醒 ' + related.length + ' 名可能相关的成员，投递成功 ' + arrived + '/' + delivered.length)
          + (check.verdict === 'contradicted'
            ? '。⚠ 声明与 git 事实不符，请在房间里澄清'
            : ''),
      }
    },
  }))

  disposers.push(registerRoomTool({
    name: 'room_alert',
    description: '⚡ 紧急打断：把一条消息立刻插进房间里所有成员的当前轮次（steer）。'
      + '尽力而为——对方若没走到步边界可能收不到，且不需要回执。只用在「停，别动那个文件」这类事上，'
      + '不要用它来代替正常发言（room_say）或需要别人表态的变更声明（room_declare_change）。',
    parameters: {
      type: 'object',
      properties: {
        room: { type: 'string', description: '房间 id 或名称。' },
        text: { type: 'string', description: '要立刻传达的内容。' },
      },
      required: ['room', 'text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { delivered: { type: 'integer' }, total: { type: 'integer' }, text: { type: 'string' } },
        required: ['delivered', 'total', 'text'],
        additionalProperties: false,
      },
      render: textRender,
    },
    execute: async (args, exec) => {
      await ready
      const sessionId = callerOf(exec)
      const room = resolveRoom(args.room)
      if (room === null) return { delivered: 0, total: 0, text: '找不到房间：' + args.room }
      const message = await store.appendMessage({
        roomId: room.id,
        sender: { sessionId, roleName: roleNameOf(room.id, sessionId) },
        kind: 'alert',
        body: String(args.text),
      })
      const results = await broadcastAlert(room.id, message.seq)
      const arrived = results.filter((r) => r.delivered).length
      return {
        delivered: arrived,
        total: results.length,
        text: '⚡ 已尽力投出 #' + message.seq + '：' + arrived + '/' + results.length
          + '（steer 可能被丢弃，不保证送达，也不需要回执）',
      }
    },
  }))

  disposers.push(registerRoomTool({
    name: 'room_intent',
    description: '声明你当前负责的**设计方向与约束**。两件事分开：'
      + '`direction` 是散文，给人读；`paths`/`excludes` 是**机器读的边界**（glob/路径数组）——'
      + '**改了哪些文件会不会唤醒你、算不算越界，只看 paths**（没给 paths 时才退回去猜散文，而猜会误报）。'
      + '方向变了就再调一次覆盖。'
      + '**标准形状**（用户 2026-09-25 裁定 —— 唤醒帧只回显前 200 字，所以**顺序比长度重要**）：'
      + '【面】一句话我负责什么面 ／ 【不碰】禁区（没有就写无）／ 【纪律】1–3 条可执行约束 ／ 【收录】watch 档位。'
      + '四条判据：【面】【不碰】【纪律】必须落在**前 200 字**内；正文 ≤400 字；'
      + '不写会腐烂的引用（日期 / sha / #seq / file:line —— 要引就引文档小节号）；覆盖式写（历史归房间消息与文档）。'
      + '不合标准**不会被拒** —— 只在返回值里提示你差在哪。',
    parameters: {
      type: 'object',
      properties: {
        room: { type: 'string', description: '房间 id 或名称。' },
        direction: { type: 'string', description: '一句话说清你负责的方向（散文，给人读；上限 ' + DIRECTION_MAX_CHARS + ' 字，超了会报错而不是截断）。' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: '你负责的路径（机器读）。例：["ulysses/app.py", "ulysses/runtime/harness/**"]。'
            + '匹配规则：带 `*`/`?` ／以 `/` 结尾 ／没有扩展名 ⇒ 按**前缀**匹配（**`*`/`?` 不是通配符**，'
            + '要「这一族」就用结尾的 `**`，例 `ulysses/runtime/harness/**`）；否则按文件**后缀**匹配。'
            + '给了它，唤醒判定就不再猜散文（**有 paths 就只读 paths**）。',
        },
        watch: {
          type: 'string',
          enum: ['all', 'wake', 'feed', 'quiet', 'none'],
          description: '收录范围（**与"有没有领地"是两件事**，只读/审计席位用这个，不要编一条假 paths）。'
            + '三根轴：**推不推** × **叫不叫醒** × **要不要每条都应一声**（八个角里只有四个成立）：'
            + 'all = 全推 + 叫醒 + **必回**（观察者/审计席：逐条独立核验与表态都是它的活）；'
            + 'wake = 全推 + **叫醒**，但**不必回**（唤醒席：醒过来看一眼，看完不必写话 —— 自动审计岗，真机 #1920）；'
            + 'feed = 全推、但**不叫醒**（只收不答席：要看得见，不必每条都应一声 —— 真机 #1798 那个岗位）；'
            + 'quiet = **默认**，只推「@ 你」与「人的发言」，其余用 room_message 拉；'
            + 'none = 同 quiet，且连变更推送也不要（**普通发言**里 @ 你仍会叫到你；**声明正文里的 @ 不算**）。',
          // 两处用词要拧成一套：推送 = 进不进你的上下文；唤醒 = 要不要你回一句。
          // none 是两个都不要，但「普通发言的 @」与「声明正文的 @」是两回事 —— 后者由 related(=wouldWake) 决定。
        },
        excludes: {
          type: 'array',
          items: { type: 'string' },
          description: '你**明确不碰**的路径（机器读）。例：["dashboard.css"]。命中它的改动不会叫醒你、也不算越界。'
            + '匹配规则同 paths（`*`/`?` 不是通配符；要一族就用结尾的 `**`）。',
        },
      },
      required: ['room', 'direction'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      render: textRender,
    },
    execute: async (args, exec) => {
      await ready
      const sessionId = callerOf(exec)
      const room = resolveRoom(args.room)
      if (room === null) return { text: '找不到房间：' + args.room }
      let updated = null
      try {
        updated = await store.setSelfDescription(room.id, sessionId, String(args.direction), {
          paths: args.paths === undefined ? null : args.paths,
          excludes: args.excludes === undefined ? null : args.excludes,
          watch: args.watch === undefined ? null : args.watch,
        })
      } catch (err) {
        return { text: '方向没记下：' + (err && err.message ? err.message : String(err)) }
      }
      if (updated === null) return { text: '你不是这个房间的成员，无法声明方向（请让用户把你加入房间）。' }
      const paths = Array.isArray(updated.paths) ? updated.paths : []
      const excludes = Array.isArray(updated.excludes) ? updated.excludes : []
      const watch = updated.watch === 'all' || updated.watch === 'none' || updated.watch === 'quiet'
        || updated.watch === 'feed' || updated.watch === 'wake'
        ? updated.watch : null
      // 收录范围说清了就不该再催它补 paths —— 观察者席位**故意**没有领地
      // （真机 #1714：工具曾对着审计席建议"补 paths 就能收敛"，那条建议对它是错的）。
      // 看起来像通配、其实永远不会命中的条目（`*`/`?` **不是通配符**）—— 当场点出来，别让它静默失效。
      const suspects = suspectGlobs(paths).concat(suspectGlobs(excludes))
      const globWarn = suspects.length === 0
        ? ''
        : suspects.map((t) => '`' + t + '`').join('、') + ' 含 `*`/`?`，但判据里**它们不是通配符**（按字面前缀匹配）'
          + ' ⇒ 这条**匹配不到任何文件、等于没写**。要覆盖一族：逐条列，或写成以 `**` 结尾的目录前缀（例 `tests/unit/**`）。'
      // 「裸文件名」token（没有 `/`）的**当场提示**（提案 B / P3，真机 #4866/#4870）：
      // 它会命中**任何目录下**的同名文件 —— 那两次假 ⚠ 就是这么来的，而当时的提示只飘在别人的帧里。
      const shapeHints = directionShapeHints(updated.selfDescription)
      const bares = bareTokens(paths)
      const bareWarn = bares.length === 0
        ? ''
        : bares.map((t) => '`' + t + '`').join('、') + ' 没有 `/` ⇒ 按判据它会命中**任何目录下**的同名文件'
          + '（例：`README.md` 会命中 `docs/README.md`，也会命中别的仓库里的 `README.md` ⇒ 一条假 ⚠ + 一次被迫回执）。'
          + '只想认领某一个就写全路径（`docs/README.md`）；确实要整个名字族用 `**` 结尾写目录前缀。'
      const scope = watch === 'all'
        ? '收录范围：**观察者/审计席**（全推：变更通知与闲聊都进上下文，**每条变更都叫醒你**）'
        : (watch === 'wake'
          ? '收录范围：**唤醒席**（变更通知全推、**会叫醒你**，但不登记回执义务 —— 看一眼就行）'
        : (watch === 'feed'
          ? '收录范围：**只收不答席**（变更通知全推、进背景通道，但**不叫醒**、也不产生义务）'
        : (watch === 'quiet'
          ? '收录范围：**只推 @ 你 的与人的发言**（默认档；其余用 room_message 拉）'
          : (watch === 'none'
            ? '收录范围：**静音**（不收变更推送，也不因变更被唤醒；**普通发言**里被 @ 仍会叫到，**声明正文里的 @ 不算**）'
          : (paths.length > 0
            ? '机器读的边界 ' + paths.length + ' 条：' + paths.join(' ')
            : '⚠ 你没给 paths —— 唤醒与越界判定只能去猜这段散文，会误报也会漏报（例：'
              + '方向里写「不进 X 依赖图」时，X 可能被当成你的地盘）。'
              + '若你本来就**不认领**任何路径（只读/审计席），改用 watch="all"／"wake"／"feed" 明确表达，别编一条假 paths。')))))
      return {
        text: '方向已记录（共 ' + String(updated.selfDescription).length + ' 字，全文保存、不再截断）。'
          + scope
          + (paths.length > 0 && watch !== null ? '；另有边界 ' + paths.length + ' 条：' + paths.join(' ') : '')
          + (excludes.length > 0 ? '；明确不碰：' + excludes.join(' ') : '')
          // **静默失效要喊出来**（真机 #3169）：`*`/`?` 不是通配符，写成 `a*.py` 会永远匹配不到 ——
          // 而「排除没生效」的代价是一次误唤醒 + 一次被迫回执，此前却没有任何提示。
          + (globWarn === '' ? '' : '；⚠ ' + globWarn)
          // 提案 B / P3：同一句话**当场回给作者**，而不是等它变成别人帧里的 ⚠。
          // `README.md` 这种没有 `/` 的 token 会命中任何目录下的同名文件（真机 #4866/#4870：
          // 兄弟仓的 `dsh-ulysses-mcp/README.md` 两次命中本仓成员的 `README.md`）——
          // 判据不替人猜（"短路径命中长路径"是有意的），但作者该在**写下它的时候**就知道。
          + (bareWarn === '' ? '' : '；⚠ ' + bareWarn)
          // P6（214c26f9 #5052，用户裁定）：四段标准**只提示、不改判定**。
          // 触发它的成本（前 200 字只回显、后 400 字没人读）就摆在返回值里，作者自己决定改不改。
          + (shapeHints.length === 0 ? '；形状 ✓ 四段标准通过' : '；⚠ 形状提示：' + shapeHints.join('；')),
      }
    },
  }))

  disposers.push(registerRoomTool({
    name: 'room_owners',
    description: '动手**之前**查边界：这些路径归谁负责、会被唤醒的是谁。'
      + '与 room_declare_change 的唤醒判定**是同一个函数**，不会出现「查的时候说没人负责、叫的时候叫了三个人」。'
      + '用途：改别人的地盘之前先确认（而不是等声明之后被标 ⚠）。',
    parameters: {
      type: 'object',
      properties: {
        room: { type: 'string', description: '房间 id 或名称。' },
        paths: { type: 'array', items: { type: 'string' }, description: '要查的路径（相对工作区），例：["ulysses/app.py"]。' },
        workspace: { type: 'string', description: '这些路径所在的工作区绝对路径；省略则用你自己的工作区。' },
      },
      required: ['room', 'paths'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      render: textRender,
    },
    execute: async (args, exec) => {
      await ready
      const sessionId = callerOf(exec)
      const room = resolveRoom(args.room)
      if (room === null) return { text: '找不到房间：' + args.room }
      const files = (Array.isArray(args.paths) ? args.paths : []).map((p) => String(p))
      if (files.length === 0) return { text: 'paths 不能为空 —— 要查哪些文件？' }
      let workspace = args.workspace === undefined || args.workspace === null ? '' : String(args.workspace)
      if (workspace === '') {
        // 不传就用调用者自己的工作区（它多半就是要在那里动手）
        const live = agents === undefined ? undefined : agents.get(sessionId)
        workspace = (live && live.session && live.session.header && live.session.header.cwd) || ''
        if (workspace === '') {
          const map = await memberWorkspaceMap(room.id)
          workspace = map.get(sessionId) || ''
        }
      }
      const rows = await ownershipLookup(room.id, workspace, files)
      if (rows.length === 0) return { text: '房间里没有可判定的成员。' }
      // 与 relatedMemberIds 完全一致地**排除声明者自己** —— 查询与路由必须给出同一张名单，
      // 否则"查的时候说 2 人、真声明只叫 1 人"就又成了两张表各说各话。
      // 三个桶（真机 #1920）：**会被叫醒且要回** / **会被叫醒但不必回**（watch=wake）/ 不会被叫醒。
      // 少这一桶的话，wake 席会被印在「不会被唤醒」里 —— 而它恰恰是会被叫的。
      const woke = rows.filter((r) => r.wouldWake && r.sessionId !== sessionId)
      const wake = woke.filter((r) => r.noReply !== true)
      const wakeNoReply = woke.filter((r) => r.noReply === true)
      const self = rows.filter((r) => r.wouldWake && r.sessionId === sessionId)
      const rest = rows.filter((r) => !r.wouldWake)
      if (self.length > 0) { /* 自己命中自己的边界不算被叫醒，下面单独说一句 */ }
      const lines = ['房间 ' + room.name + '：' + files.join('、')
        + (workspace === '' ? '（工作区未知）' : '（工作区 ' + path.basename(workspace) + '）')]
      lines.push('会唤醒**且要回**（' + wake.length + ' 人，收到「必须回一句」的 followup）:')
      if (wake.length === 0) lines.push('  （没有 —— 这条改动不会叫醒任何人，只进背景通道）')
      for (const r of wake) {
        lines.push('  - [' + r.shortId + ']' + (r.roleName ? ' ' + r.roleName : '')
          + (r.sessionId === sessionId ? ' ← 就是你自己' : '')
          + ' —— ' + r.reason
          + (r.matched.length > 0 ? '：' + r.matched.map((m) => m.file + ' ↔ ' + m.token).join('，') : '')
          + (r.unknownWorkspace === true ? '  ⚠工作区未知' : ''))
      }
      if (wakeNoReply.length > 0) {
        lines.push('会唤醒但**不必回**（' + wakeNoReply.length + ' 人，watch=wake —— 只叫它看一眼，不登记回执）:')
        for (const r of wakeNoReply) {
          lines.push('  - [' + r.shortId + ']' + (r.roleName ? ' ' + r.roleName : '') + ' —— ' + r.reason)
        }
      }
      lines.push('不会被唤醒（' + rest.length + ' 人，仍然看得到这条声明）:')
      for (const r of rest) {
        lines.push('  - [' + r.shortId + ']' + (r.roleName ? ' ' + r.roleName : '')
          + ' —— ' + r.reason)
      }
      if (self.length > 0) {
        lines.push('（你自己：' + self[0].reason + ' —— 但自己声明不会叫醒自己，所以你不需要回执）')
      }
      // 未知工作区必须**说出来**（真机 #1756）：这张表是「动手之前的边界确认」，
      // 把「取不到」读成「没人负责」正是它最危险的错法。
      const unknownWs = rows.filter((r) => r.unknownWorkspace === true)
      if (unknownWs.length > 0) {
        lines.push('⚠ 有 ' + unknownWs.length + ' 人的工作区**取不到**（未知，不是「不在」）——'
          + ' 他们的结论按保守口径给（会唤醒），成色低于「已核对」。')
      }
      if (wake.length > 0) {
        lines.push('👉 你要改的这些文件里有别人的地盘：先在房间里 room_say @ 那位负责人说清（它会必须回一句），别悄悄改。')
      }
      return { text: lines.join('\n') }
    },
  }))

  debug('工具已注册: ' + disposers.length + ' 个')
  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* 卸载期忽略 */ }
    }
  }, 'chatroom tools')

  // =======================================================================
  // 房间协议注入（BLUEPRINT §8）
  // =======================================================================

  if (systemPrompt !== undefined) {
    ctx.effect(() => systemPrompt.section({
      name: PROTOCOL_SECTION,
      order: 160,
      text: () => [
        '【聊天室协议】本机启用了 dsh-chatroom：多个会话可以在同一个房间里同步变更。',
        '- 你被用户加入某个房间后，房间里会出现你的短号身份。',
        '- 你改动了共享文件后，必须调用 room_declare_change 声明；隐瞒或含糊会让别人基于错误假设工作。',
        '- 房间会用 git 事实核验你的声明。查不到（非 git 工作区、纯删除等）只算「未证实」，不算撒谎；与事实冲突才会被标红。',
        '- 已经提交过的改动，声明时带上 ref=<commit>：核验以 commit 事实为准（是 HEAD 的祖先 + 覆盖所声明的文件 → 直接已证实），与时间无关，最不容易被误判。',
        '- 提交时用显式路径（git add <file> <file>…），**不要 git add -A / git add .** —— 会把别人正在改的文件一起卷进你的提交，仓库会短暂处于「你的文档已入库、别人的代码还没提交」的不自洽状态（本仓库真机上发生过两次）。',
        '- 收到以「[聊天室 …]」开头的消息并被告知必须回一句时，调用 room_judge，verdict 四选一：'
          + VERDICTS.map((v) => v + '(' + VERDICT_LABELS[v] + ')').join(' / ') + '。',
        '- 表态是终端的：你表态后不会有人因此再要求你表态。不要为了礼貌而回复别人的表态。',
        '- 想知道现状用 room_status（它会告诉你**欠的是哪一条 #seq**）；想说话用 room_say —— 默认**不**要求别人回应，只是背景上下文。',
        '- **分工用 room_task**（任务板）：create / claim / update / list。任务的 expectPaths（预期要改哪些文件）在'
          + '**建任务/认领任务的那一刻**就会和成员边界对一遍 —— 要碰别人的地盘，当场看得见 ⚠，不必等改完再事后对质。',
        '- **默认只推「@ 你」与「人的发言」**（2026-09-16 用户定）：变更通知与别人的闲聊**不再进你的上下文**，',
        '  要看用 room_message(seq) / room_status 拉（房间历史一条不少）。要全量、且每条都愿意表态 ⇒ room_intent 传 watch="all"；',
        '  要**被叫醒但不必每条都应一声** ⇒ watch="wake"（全推进上下文并唤醒你，不登记义务）；',
        '  要看得见但**别叫醒我** ⇒ watch="feed"（全推进上下文，不产生义务）；连变更推送也不要则传 watch="none"（普通发言里 @ 你仍会叫到）。',
        '  命中你 paths 的变更**仍会叫醒你**（那是义务，不是推送）。',
        '- 想知道**某一条**说了什么、谁 @ 了谁、各人的回执正文：用 room_message(room, seq=…) ——',
        '  「他当时回了什么」是一次查询，不是一次打扰：重问一次 = 主动唤醒别人（真机 #1348/#1349 就是这么发生的）。',
        '- 要谁表态、要划边界，就在 room_say 里写 @短号 / @角色名 / @全体：被点到的人会被**主动唤醒**，且必须回一句判断。',
        '- 只是想「提到」某人、不要他回话：正文里写明「不需要回应」，或给 room_say 传 wake=false —— 那就只是背景投递，不登记义务（作者说了不用回，就不用回）。',
        '- **引述别人的话时用引号或代码块**（「」/`` ` ``/```）：引述里的 @ 不算提及 —— 否则「引述某条 ⚠ 行」会连带把被点名的人叫起来，讨论警告这个动作本身制造提及。自己也不会被自己 @ 到。',
        '- **不要写自己的短号**：自我提及不产生义务（作者不欠自己回执），写了也会被丢掉。',
        '- 你收到的唤醒帧可能**滞后**（投递时你正在忙，它会等到你下一轮才落地）：若房间里已显示你就那条表过态，忽略该帧即可。',
        '- 用 room_intent 声明你当前负责的设计方向与约束：**direction 给人读，paths 给机器读**。',
        '  唤醒谁、算不算越界只看 paths（不给就退回猜散文，会误报也会漏报）。**只读/审计席位不要编假 paths** ——',
        '  用 watch="all"（收全量变更 + 每条必回）、watch="wake"（全推 + 叫醒、不必回）、watch="feed"（全推、不叫醒）或 watch="none"（不收变更推送；普通发言里 @ 仍会叫到）。',
        '  很多"设计偏离"不是谁改了文件造成的，',
        '  而是两个会话各自以为对方在做别的方向 —— 先说清方向，比事后对 diff 便宜得多。',
        '- **动手之前先查边界**：room_owners(room, paths=[…]) 告诉你这些文件归谁、会叫醒谁（与声明时的唤醒判定同一个函数）。',
        '  要改别人的地盘，先在房间里 @ 他（room_say），不要悄悄改。',
        '- **进房间第一件事就是声明方向**：没声明方向的成员，别人判断不了你会不会越界，你的回执也就没了依据。',
        '- 别人叫你回话时，消息末尾会附上你自己声明过的方向；若要做的动作越出那个范围，请在回执的 note 里说明。',
        '- **发现别人负责的区域有问题：先在房间里 @ 他，不要自己动手。** 悄悄改别人的区域是这套东西最想避免的事 ——',
        '  真发生时的正确姿势是：room_say 里 @短号 说明问题（他会被必须回一句），或者你确实要越界改，就在 room_declare_change 里说清并 @ 他。',
        '- 声明改动时若文件落在别人负责的范围里，房间会自动标「⚠ 可能越界」并把那位负责人 @ 上。',
      ].join('\n'),
    }), 'chatroom protocol section')
    debug('协议 section 已注册')
  }

  // ---- 边界段：启动时装已有成员 + 新 agent 创建时装（#1732）------------------
  // 少了"新 agent"这一半，"新窗口第一轮"就仍然看不到边界 —— 而那恰恰是报这条的人举的三种回合之一。
  void ready.then(() => { installBoundariesForMembers() }).catch(() => { /* 存储没加载成功就算了 */ })
  if (typeof ctx.on === 'function') {
    ctx.effect(() => {
      const off = ctx.on('agent/created', (payload) => {
        const agent = payload === undefined || payload === null ? undefined : payload.agent
        if (agent === undefined || agent === null) return
        const sessionId = callerOf({ agent })
        if (sessionId === null || !isRoomMember(sessionId)) return
        installBoundary(agent, sessionId)
      })
      return () => { if (typeof off === 'function') off() }
    }, 'chatroom: 新 agent 装边界段')
  }
  ctx.effect(() => () => {
    for (const entry of boundaryFibers.values()) {
      try { entry.fiber.dispose() } catch { /* 卸载期忽略 */ }
    }
    boundaryFibers.clear()
  }, 'chatroom: 边界段')

  // =======================================================================
  // 面板通道（loopback RPC）
  // =======================================================================

  /**
   * 房间工具的**统一栅栏**：非成员一律拒。
   *
   * 为什么必须有它（真机 2026-09-23 照出来的）：我派出去的一个 subagent **不是** ulysses 的成员，
   * 却成功调用了 room_declare_change —— 消息进了房间，还在 mentions 里登记了我、**给我造了一条义务**。
   * 九个工具当时都只取 caller 的 sessionId，**没有任何一处校验成员资格** ⇒ 本机任何一个会话
   * 只要知道房间 id，就能读整间房的历史、往里发言、制造义务。而本插件的设计前提写得很清楚
   * （BLUEPRINT §12.3）：房间跨工作区、成员 X 的变更会进成员 Y 的上下文，所以**成员必须是用户显式选的**。
   *
   * 读侧也拦：泄漏面就是"历史"。人走的面板不受影响（那条路是浏览器 cookie 栅栏，不是这个工具面）。
   *
   * 做成**注册期包装**、而不是在九个 execute 里各写一遍：这个洞的成因正是"每个工具各自处理"，
   * 以后新加房间工具也不会漏（除非它绕开这个注册函数）。
   */
  function shapeRefusal(spec, text) {
    const props = spec.output && spec.output.schema && spec.output.schema.properties
      ? spec.output.schema.properties : {}
    if (props.ok !== undefined) return { ok: false, text }
    if (props.seq !== undefined) return { seq: 0, text }
    return { text }
  }

  function registerRoomTool(spec) {
    const inner = spec.execute
    const wrapped = {
      ...spec,
      execute: async (args, exec) => {
        const sessionId = callerOf(exec)
        const wanted = args === undefined || args === null || args.room === undefined || args.room === null
          ? null : String(args.room)
        // 没点名房间的（room_status 的"列出全部"）由工具自己按成员过滤；点名了的在这里拦。
        if (wanted !== null) {
          const target = resolveRoom(wanted)
          if (target !== null && !store.activeMembers(target.id).some((m) => m.sessionId === sessionId)) {
            return shapeRefusal(spec, '你不是房间 ' + target.name + '（' + target.id + '）的成员 —— '
              + '房间成员必须由**用户显式加入**（房间面板里加），不是"用到就在里面"。加进去之后这个工具就能用了。')
          }
        }
        return inner(args, exec)
      },
    }
    return tools.register(wrapped)
  }

  /** 面板要的一屏数据。 */
  async function snapshot(roomId) {
    const st = store.status(roomId)
    if (st === null) return null
    const t0 = Date.now()
    const messages = store.state.messages.filter((m) => m.roomId === roomId).slice(-100)
    // **标题只从缓存读，不在请求路径上取**（真机 2026-09-16：面板量到 state 中位 890ms，
    // 而同一时刻插件自身的 status + 切片只要 15ms、载荷才 0.2MB ⇒ 差的就是这一行 await）。
    // 与「候选」那条路**同一套做法**（见 case 'candidates' 的注释：那句决定了接口是 20 秒还是几十毫秒）：
    // 缓存里有就用，没有先给空串，缺的丢给 warmTitles 后台预热 —— 下一次轮询自然补上
    // （标题在渲染指纹里，所以会触发一次重画，不会"永远是(无标题会话)"）。
    warmTitles(st.members.map((m) => m.sessionId))
    return {
      room: st.room,
      lastSeq: st.lastSeq,
      targetSeq: st.targetSeq,
      members: st.members.map((m) => ({
        ...m,
        title: titleCache.get(m.sessionId) || '',
        // 「已投递但还没确认」的条数（A 段台账）。面板据此显示谁没确认 —— 0 时面板不显示。
        pending: store.pendingDeliveries(roomId, m.sessionId).length,
      })),
      pending: st.pending,
      // 面板要显示「欠的是哪一条」：pending 只说人，pendingDetail 把 seq 一起带上（真机 #1348）。
      pendingDetail: st.pendingDetail,
      messages,
      judgments: st.judgments,
      changes: store.state.changes.filter((c) => c.roomId === roomId).slice(-50),
      // 任务板（B 段）。owner 已经是**短号**（面板只认这个），deps/expectPaths 原样给。
      tasks: store.tasksFor(roomId).map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        owner: t.owner === null ? null : shortId(t.owner),
        deps: Array.isArray(t.deps) ? t.deps : [],
        expectPaths: Array.isArray(t.expectPaths) ? t.expectPaths : [],
        updatedAt: t.updatedAt,
      })),
      // 主机侧自己的耗时：面板量的是**往返**，只有把"我花了多少"减出来，
      // 才能回答"慢在通道还是慢在我"（890ms 那次就是这么定性的）。
      ms: { build: Date.now() - t0 },
    }
  }

  function ok(value) { return { ok: true, value } }
  /**
   * 端点失败的统一形状。**details 不可省**：新版浏览器半侧
   * （dsh-client-connection 的 parseConnectionResponse）要求 error.details 是个对象，
   * 少这个字段会把一次「业务失败」变成客户端 TypeError。
   */
  function fail(message) {
    return { ok: false, error: { code: 'chatroom_error', message, details: {} } }
  }

  /**
   * 历史更正：用新的判定基准**重判**历史上被标成「与事实不符」的声明。
   *
   * 为什么必须做：2026-09-12 之前的锚点是「房间上次记下的 HEAD」或 30 分钟窗口，
   * 会把**真的、只是声明得晚**的改动判成撒谎（真机 #32 就是）。那种记录留在房间里会误导后来人 ——
   * 房间里的话是给人看的，一个假红标比没有标更糟。
   *
   * 做法是**重跑一遍核验**，不是把标签刷绿：只有新判据确实给出 verified 才更正，
   * 并把「从什么改成了什么」一并写进记录与那条消息里。幂等：改过的就不再是 contradicted。
   */
  let correctiveInFlight = false
  /** 重判的接线（章 / 判定输入 / 批量）在 lib/rejudge.js —— 单独成模块，它的**字节**才进得了自动挡的摘要。 */
  async function correctHistoricalVerdicts() {
    // 防重入：这个函数由定时器每 10 秒叫一次，而它自己可能要跑十几秒（listSessions + 若干次 git）。
    // 允许并发的话，两次会同时改同一条记录 —— 真机上就发生过：后一次把「已经是 verified」
    // 当成了「从什么改成」，于是记录里写出 "verified → 已证实" 这种胡话。
    if (correctiveInFlight) return { done: false, fixed: 0 }
    correctiveInFlight = true
    try {
      await ready // 存储可能还没加载完 —— 不等它就会看到空的 changes，然后误判"没事可做"
      // 两类都要重判：**假红**（contradicted）与**假阴性**（unverified）。
      // 后者是 2026-09-16 补的：仓库路由那条 bug 把"声明落在别的仓库"的多目录声明判成
      // 「未证实（不在 git 仓库内）」—— 它不撒谎，但同样是**错的标签**，而它不会自愈
      // （旧筛选只收 contradicted；我自己那条 #1472 就是这么留下来的）。
      // **按章过滤**（章 = 判据指纹），不是"前 20 条"：判对了的红永远留在队列里，取前 20 条会让它
      // 只涨不落，排在后面的新假红永远轮不到。
      const stamp = rejudgeStamp()
      const pending = store.state.changes
        .filter((c) => c.verdict === 'contradicted' || c.verdict === 'unverified')
        .filter((c) => c.rejudgedUnder !== stamp)
      if (pending.length === 0) return { done: true, fixed: 0 }
      // 锚点 = 声明者会话的开始时间。运行时有 sessionQuery 就直接拿（历史会话也带 createdAt）。
      const starts = new Map()
      const query = serviceOf('sessionQuery')
      if (query !== undefined && typeof query.listSessions === 'function') {
        try {
          const recs = await query.listSessions()
          for (const rec of recs) {
            const header = rec === null || rec === undefined ? undefined : rec.header
            if (header !== undefined && typeof header.id === 'string' && typeof header.createdAt === 'number') {
              starts.set(header.id, header.createdAt)
            }
          }
        } catch (err) {
          debug('历史更正：拿不到会话表（跳过）: ' + (err && err.message ? err.message : String(err)))
        }
      }
      let fixed = 0
      let examined = 0
      // 盖了多少个章。**必须单独数**：盖章也是状态变化，见下面 persist 的条件。
      let stamped = 0
      for (const change of pending) {
        if (examined >= REJUDGE_BATCH) break // 用满一批就收手，下一次 tick 接着做
        // 判定输入全部来自 rejudgeInputs（锚点/ref/路由）；拿不到锚点它就返回 null。
        // 返回 null 时**不盖章、也不占这一批的额度** —— 见那边的说明。
        const inputs = await rejudgeInputs(change, starts)
        if (inputs === null) continue
        examined++
        const re = await verifyDeclaration(inputs)
        // 翻没翻都盖上章：判据没变就不必把同样的 git 再跑一遍
        // （不盖章的话，一次启动要把这些记录全验一遍，下次启动再来一遍 —— 而这套东西的判据很少变）
        // 章 = 判据指纹，判据一改它自己就变，不靠谁记得 +1（见 rejudgeStamp）。
        change.rejudgedUnder = stamp
        stamped++
        // **只要判定变了就写回**，不只是"翻成已证实"。
        // 真机 2026-09-25（837e0518 #4835③ 让我核的那条）：这里原来只有
        // `if (re.verdict !== VERIFIED) continue` ⇒ **降档**（contradicted → 未证实，也就是"把假红摘掉"）
        // 在重判里**永远写不回去**：判据修好了、章也盖了，记录却仍挂着旧判词与旧 reason
        // —— 假红链只会"不再新增"，永远不会闭合。与 v4 那次同族：**判据变了，旧结论就得跟着变**。
        if (re.verdict === change.verdict && re.reason === change.reason) continue
        const mark = describeVerification(re)
        // 「从什么改成什么」的**前者要在改之前读**（早先写成改完再读 change.verdict，
        // 被并发的那一次改掉之后就成了 "verified → 已证实" 这种胡话）。
        // 存**代码**、渲染成中文：早先这里把"未证实"这个**标签**塞进 rejudgeFrom，
        // 与下面的修复循环按代码比较，两边对不上。
        // 注意**不要**叫 VERDICT_LABELS：模块级那个同名的是**表态**（unaffected / catch-up…）的词表，
        // 这个说的是**声明判定**（已证实 / 未证实 / 与事实不符）—— 同名不同域正是 #3646 A3 抓的那种遮蔽。
        const DECL_LABELS = { verified: '已证实', unverified: '未证实', contradicted: '与事实不符' }
        const from = change.verdict
        const note = '（判定基准修正后重判：' + (DECL_LABELS[from] || from) + ' → '
          + (DECL_LABELS[re.verdict] || re.verdict) + '）'
        change.rejudgedAt = Date.now()
        change.rejudgeFrom = from
        change.verdict = re.verdict
        change.reason = re.reason
        change.perFile = re.files
        change.head = re.head
        const message = store.state.messages.find((m) => m.seq === change.seq && m.roomId === change.roomId)
        if (message !== undefined && typeof message.body === 'string') {
          const at = message.body.lastIndexOf('git 校验')
          message.body = (at >= 0 ? message.body.slice(0, at) : message.body + '  ') + mark + ' ' + note
        }
        fixed++
      }
      // 顺手修坏掉的注记：并发那一次写出的 rejudgeFrom 是错的（见上），语义上只可能是 contradicted。
      let repaired = 0
      for (const change of store.state.changes) {
        // 两个合法代码都要放过（原来只放过 contradicted ⇒ 会把"从 unverified 平反"的注记也改坏）。
        if (change.rejudgedAt === undefined || change.rejudgeFrom === 'contradicted'
          || change.rejudgeFrom === 'unverified') continue
        change.rejudgeFrom = 'contradicted'
        const message = store.state.messages.find((m) => m.seq === change.seq && m.roomId === change.roomId)
        if (message !== undefined && typeof message.body === 'string') {
          message.body = message.body.replace(/（判定基准修正后重判：[^）]*）/g, '（判定基准修正后重判：contradicted → 已证实）')
        }
        repaired++
      }
      // 落盘条件里**必须带上 stamped**（真机 2026-09-20 02:32 那次重启照出来的洞）：
      // 盖章只改内存时，磁盘上一个章都没有 —— 直到某个**无关**动作顺手 persist 才跟着落盘
      // （我是靠"重启后磁盘上 0 条盖章、而内存里 12 条都盖好了"这个矛盾抓到的）。
      // 后果不是错判，是**白跑**：每次启动都把同一批 pending 重验一遍，而"每个版本只重判一次"成了空话。
      if (fixed > 0 || repaired > 0 || stamped > 0) {
        await store.persist()
        debug('历史更正：' + fixed + ' 条误判已按新基准改为「已证实」'
          + (repaired > 0 ? '；另修正 ' + repaired + ' 条写坏的注记' : '')
          + (stamped > 0 ? '；盖章 ' + stamped + ' 条（判据没变的话，下次启动就不再验它们）' : ''))
      }
      // 会话表拿到了、这一批也做完了 → 收工；这一批用满额度说明后面还有，留给下一次 tick
      // （拿不到会话表就返回 done:false，稍后重试）
      return { done: starts.size > 0 && examined < REJUDGE_BATCH, fixed }
    } catch (err) {
      debug('历史更正失败（不影响运行）: ' + (err && err.message ? err.message : String(err)))
      return { done: false, fixed: 0 }
    } finally {
      correctiveInFlight = false
    }
  }

  /**
   * 启动后做一次历史更正。不能立刻跑：sessionQuery 是**懒挂载**的，
   * 插件 apply 的那一刻它多半还没出现（§11.13 那个教训）。所以先试一次，
   * 拿不到会话表就每 10 秒再试，最多 6 次；拿到过就收工。
   */
  ctx.effect(() => {
    let stopped = false
    let tries = 0
    const stop = () => {
      stopped = true
      clearInterval(timer)
    }
    const tick = async () => {
      if (stopped) return
      tries++
      const r = await correctHistoricalVerdicts()
      if (r.done === true || tries >= 6) stop()
    }
    const timer = setInterval(() => { void tick() }, 10000)
    void tick()
    return stop
  }, 'chatroom: 历史判定更正')

  // =======================================================================
  // 面板通道的传输层（BLUEPRINT §4）
  //   面板不持有状态真相，所有数据与操作都走这条 loopback 通道。
  //   新版 DSH 起，通道不能再只靠 connection.rpc.handle 挂（见下方 ① 注释），
  //   于是直接在插件自己 inject 的 webServer 上挂一条 prefix 路由，逐分支复刻
  //   Connection /api 的传输语义（401/403 栅栏 · content-type · endpoint 段校验 ·
  //   信封校验 · rpcId 回带 · 404/415/400/413/500 分支）。
  //   语义参照：dsh-client-connection/lib/index.js 的 rpcFetchHandler / register。
  // =======================================================================

  /** 请求体上限：面板载荷都是小 JSON（房间快照），4 MB 足够，且能拒绝无界缓冲。 */
  const RPC_BODY_MAX = 4 * 1024 * 1024
  /** endpoint 段允许的字符（与 dsh-client-connection 的 ENDPOINT_SEGMENT_PATTERN 对齐）。 */
  const ENDPOINT_SEGMENT = /^[A-Za-z0-9_$.-]+$/
  /** 信封解析不出来时的兜底 rpcId（与 dsh 内部 INVALID_REQUEST_RPC_ID 对齐）。 */
  const INVALID_RPC_ID = 'invalid-request'

  /** 从 `<channel>/<endpoint>` 取出 endpoint；段非法返回 undefined（与 dsh 同规则）。 */
  function endpointOf(channel, pathname) {
    if (!pathname.startsWith(channel + '/')) return undefined
    const endpoint = pathname.slice(channel.length + 1)
    if (endpoint.split('/').some((seg) => seg === '' || seg === '.' || seg === '..' || !ENDPOINT_SEGMENT.test(seg))) {
      return undefined
    }
    return endpoint
  }

  /** 旧版 DSH 没有浏览器 cookie 认证，退回 rpc.handle({ authority:'loopback' }) 的语义。 */
  function isLoopback(req) {
    const addr = req.socket === undefined || req.socket === null ? undefined : req.socket.remoteAddress
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
  }

  /**
   * 401/403 判定。新版走 connection.requestRejection（浏览器 cookie + Host/Origin 栅栏），
   * 该方法不存在（旧版）时只做 loopback 栅栏。
   */
  function rejectionOf(connection, req) {
    if (connection !== undefined && typeof connection.requestRejection === 'function') {
      try {
        return connection.requestRejection(req)
      } catch (err) {
        return 403
      }
    }
    return isLoopback(req) ? undefined : 403
  }

  /** 有界读取请求体；超限 reject 一个带 tooLarge 标记的错误。 */
  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          const err = new Error('request body too large')
          err.tooLarge = true
          reject(err)
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  function writeJson(res, status, body) {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
    })
    res.end(text)
  }

  function writeText(res, status, text) {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(text)
  }

  /** 服务端信封（与 dsh 内部 fullResponse 同形）。 */
  function respond(rpcId, result) {
    return { type: 'server-response', rpcId, result }
  }

  /**
   * 把通道挂到 webServer 上，返回幂等的 disposer。
   * @param {object} webServer 宿主 webServer 服务
   * @param {string} channel 通道前缀
   * @param {Function} handler (endpoint, payload) => Promise<result>
   * @param {object} connection 连接服务（仅用于 requestRejection）
   */
  function mountRoute(webServer, channel, handler, connection) {
    const route = {
      kind: 'prefix',
      path: channel,
      handler: async (req, res) => {
        const rejection = rejectionOf(connection, req)
        if (rejection !== undefined) {
          writeText(res, rejection, rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        const raw = req.url === undefined || req.url === null ? '/' : req.url
        const endpoint = endpointOf(channel, new URL(raw, 'http://dsh.internal').pathname)
        if (req.method !== 'POST' || endpoint === undefined) {
          writeText(res, 404, 'not found')
          return
        }
        const contentType = req.headers === undefined ? undefined : req.headers['content-type']
        if (typeof contentType !== 'string' || contentType.split(';')[0].trim().toLowerCase() !== 'application/json') {
          writeText(res, 415, 'content type must be application/json')
          return
        }
        let text
        try {
          text = await readBody(req, RPC_BODY_MAX)
        } catch (err) {
          const tooLarge = err !== null && err !== undefined && err.tooLarge === true
          writeText(res, tooLarge ? 413 : 400, tooLarge ? 'request body too large' : 'request body unreadable')
          return
        }
        let message
        try {
          message = JSON.parse(text)
        } catch (err) {
          writeJson(res, 400, respond(INVALID_RPC_ID, fail('body is not JSON')))
          return
        }
        const isObject = message !== null && typeof message === 'object' && Array.isArray(message) === false
        if (isObject === false || message.type !== 'client-request'
          || typeof message.rpcId !== 'string' || typeof message.method !== 'string') {
          const rpcId = isObject && typeof message.rpcId === 'string' ? message.rpcId : INVALID_RPC_ID
          writeJson(res, 400, respond(rpcId, fail('invalid client-request message')))
          return
        }
        if (message.method !== endpoint) {
          writeJson(res, 200, respond(message.rpcId,
            fail('method ' + JSON.stringify(message.method) + ' does not match endpoint ' + JSON.stringify(endpoint))))
          return
        }
        let result
        try {
          result = await handler(endpoint, message.payload)
        } catch (err) {
          writeText(res, 500, 'handler failure: ' + String(err))
          return
        }
        writeJson(res, 200, respond(message.rpcId, result))
      },
    }
    const dispose = webServer.register(route)
    return () => {
      try { if (typeof dispose === 'function') dispose() } catch (err) { /* 卸载期忽略 */ }
    }
  }

  ctx.inject(['connection'], (connectionCtx) => {
    const connection = connectionCtx.connection
    if (connection === undefined) {
      debug('connection 服务不可用 —— 面板通道未注册')
      return
    }

    /** 面板的全部端点。两条传输路径（webServer 直挂 / rpc.handle 回退）共用它。 */
    const handleRpc = async (endpoint, payload) => {
      await ready
      debug('RPC 调用: ' + endpoint)
      const body = payload === null || typeof payload !== 'object' ? {} : payload
      try {
        switch (endpoint) {
          case 'state': {
            const t0 = Date.now()
            const rooms = await Promise.all(store.listRooms().map((room) => snapshot(room.id)))
            return ok({ rooms, ms: { total: Date.now() - t0 } })
          }
          case 'create-room': {
            const room = await store.createRoom({ name: String(body.name || '未命名房间') })
            return ok({ room: await snapshot(room.id) })
          }
          case 'remove-room':
            await store.removeRoom(String(body.roomId))
            return ok({ removed: String(body.roomId) })
          case 'join': {
            const member = await store.join(String(body.roomId), String(body.sessionId), {
              roleName: body.roleName === undefined ? '' : String(body.roleName),
            })
            return ok({ member })
          }
          case 'set-enabled': {
            const member = await store.setEnabled(String(body.roomId), String(body.sessionId), body.enabled === true)
            return ok({ member })
          }
          case 'set-policy': {
            // 房间策略（成员上限 / 线程预算）就地可改：真机反馈"撞到 room is full 才知道有个上限"。
            // 非法值由 store 抛出来、原样带回给面板（夹取会让人以为设上了）。
            const room = store.getRoom(String(body.roomId))
            if (room === null) return fail('room not found')
            try {
              await store.setPolicy(room.id, { maxMembers: body.maxMembers, threadBudget: body.threadBudget })
            } catch (err) {
              return fail(err !== null && typeof err === 'object' && err.message ? String(err.message) : String(err))
            }
            return ok({ status: await snapshot(room.id) })
          }
          case 'say': {
            // 人的发言：D4 默认产生全员义务。
            // **但人可以定向**（2026-09-16 改）：@ 了短号/角色名就只叫被点的人。
            // 为什么必须有：不 @ 就全体 ⇒ "每条用户发言 = N 次模型调用"，人数上限直接等于每条消息的成本；
            // agent 侧的 room_say 早就会解析 @ 了，只有人在面板里说话时反而不能定向 —— 那是漏的一半。
            const room = store.getRoom(String(body.roomId))
            if (room === null) return fail('room not found')
            const said = String(body.text || '')
            const found = parseMentions(said, store.activeMembers(room.id), null)
            const message = await store.appendMessage({
              roomId: room.id,
              sender: { user: true },
              kind: 'human',
              body: said,
              mentions: found.length > 0 ? found : null,
            })
            const delivered = await fanout(room.id, message.seq)
            return ok({ message, delivered })
          }
          case 'judge': {
            await store.judge({
              roomId: String(body.roomId),
              seq: Number(body.seq),
              sessionId: String(body.sessionId),
              verdict: String(body.verdict),
              note: body.note === undefined ? '' : String(body.note),
            })
            return ok({ status: await snapshot(String(body.roomId)) })
          }
          case 'candidates': {
            // 候选 = 持久化语料 ∪ 活 Agent。
            // 只列活会话是死循环：想让它活着得先去 GUI 打开它，而面板里又看不到它。
            const liveAgents = agents === undefined ? [] : agents.list()
            const archived = await archivedIds()
            const corpus = dropSubagents(await corpusEntries())
            const rows = new Map()
            let archivedDropped = 0
            for (const e of corpus.kept) {
              if (archived.has(e.id)) { archivedDropped++; continue } // 归档会话在 GUI 里是隐藏的，候选里也不该出现
              rows.set(e.id, {
                sessionId: e.id,
                shortId: shortId(e.id),
                live: e.live,
                status: '',
                // cwd 在 session.header.cwd / 投影缓存 identity.cwd，
                // 不在 session 本身上 —— 真机实测踩过：取错字段 → 候选全显示「未知工作区」。
                cwd: e.cwd,
                createdAt: e.createdAt,
                lastActivityAt: e.lastActivityAt,
                title: e.title,
              })
            }
            let liveSubagentsDropped = 0
            for (const agent of liveAgents) {
              if (archived.has(agent.id)) continue
              // 活 Agent 里也可能挂着子代理（父会话还活着时）：先看 header 的权威标记，
              // header 没给才退回 id 形态
              const liveHeader = agent.session === undefined ? undefined : agent.session.header
              const markedChild = liveHeader !== undefined && liveHeader !== null && (
                (typeof liveHeader.parentSession === 'string' && liveHeader.parentSession !== '')
                || (typeof liveHeader.delegationDepth === 'number' && liveHeader.delegationDepth > 0))
              const shapedChild = corpus.dropped > 0 && !String(agent.id).startsWith('session-')
              if (markedChild || shapedChild) { liveSubagentsDropped++; continue }
              const cwd = (agent.session && agent.session.header && agent.session.header.cwd) || ''
              const row = rows.get(agent.id)
              if (row === undefined) {
                rows.set(agent.id, {
                  sessionId: agent.id,
                  shortId: shortId(agent.id),
                  live: true,
                  status: agent.status,
                  cwd,
                  createdAt: 0,
                  lastActivityAt: 0,
                })
              } else {
                row.live = true
                row.status = agent.status
                if (row.cwd === '') row.cwd = cwd
                // 活着的会话：它自己的 header 更准（投影缓存可能还没落盘）
                const header = agent.session && agent.session.header
                const liveAt = header !== undefined && typeof header.lastPromptAt === 'number' ? header.lastPromptAt : 0
                if (liveAt > (row.lastActivityAt || 0)) row.lastActivityAt = liveAt
              }
            }
            // 截断前先按「最近活动」排序：面板默认就是这个序，先砍掉的应当是真正陈旧的会话。
            // 客户端可以再按别的键重排（排序控件在面板上）。
            // 上限从 60 提到 120 —— 排序要看得见效果，样本太小排序就没意义了。
            const list = [...rows.values()]
              .sort((a, b) => (b.lastActivityAt || b.createdAt) - (a.lastActivityAt || a.createdAt))
              .slice(0, 120)
            // 标题只从缓存读（零成本），缺的丢给后台预热 —— 这一句决定了本接口是 20 秒还是几十毫秒。
            // 补到的标题下一轮轮询自然出现（标题也在渲染指纹里，所以会触发一次重画）。
            const ids = list.map((c) => c.sessionId)
            for (const c of list) {
              if (c.title === undefined || c.title === '') c.title = titleCache.get(c.sessionId) || ''
              c.workspace = c.cwd === '' ? '' : path.basename(c.cwd)
            }
            warmTitles(ids)
            // 把「为什么少了几个」一并告诉面板：子代理与归档各隐藏了多少，
            // 免得人以为候选列表坏了（真东西不见了却不知道为什么，是最难查的那种反馈）。
            return ok({
              candidates: list,
              hidden: { subagents: corpus.dropped + liveSubagentsDropped, archived: archivedDropped },
            })
          }
          case 'alert': {
            // 人的紧急打断：不产生义务，只尽力插进去。
            const room = store.getRoom(String(body.roomId))
            if (room === null) return fail('room not found')
            const message = await store.appendMessage({
              roomId: room.id,
              sender: { user: true },
              kind: 'alert',
              body: String(body.text || ''),
            })
            const delivered = await broadcastAlert(room.id, message.seq)
            return ok({ message, delivered })
          }
          case 'export': {
            const room = store.getRoom(String(body.roomId))
            if (room === null) return fail('room not found')
            return ok({ markdown: exportMarkdown(room.id), name: room.name })
          }
          case 'client-log': {
            // 客户端 → 宿主的诊断通道。存在的理由很实际：
            // 浏览器里发生的事（座位注册成没成、渲染有没有抛）我看不见，
            // 而「看不见的失败」正是这个项目反复踩的坑。
            debug('[client] ' + String(body.text || '').slice(0, 400))
            return ok({ logged: true })
          }
          case 'diagnose': {
            // 一次性排障端点：把「取不到 Agent」和「投递被拒」两种失败分开。
            const sid = String(body.sessionId || '')
            const listed = agents === undefined ? [] : agents.list().map((a) => ({ id: a.id, status: a.status }))
            const got = agents === undefined ? undefined : agents.get(sid)
            const info = {
              agentsService: agents !== undefined,
              liveCount: listed.length,
              listed,
              getResult: got === undefined ? 'undefined' : (got === null ? 'null' : typeof got),
              idMatches: got === undefined || got === null ? null : got.id === sid,
            }
            if (got !== undefined && got !== null) {
              try {
                got.followup(createUserMessage({
                  content: [{ type: 'text', text: 'diagnose ping（最小 source）' }],
                  source: chatroomSource(null, 'diagnose'),
                }))
                info.followupMinimal = 'ok'
              } catch (err) {
                info.followupMinimal = 'threw: ' + (err && err.message ? err.message : String(err))
              }
              try {
                got.followup(createUserMessage({
                  content: [{ type: 'text', text: 'diagnose ping（relay source）' }],
                  // 与真实投递**同一个构造函数**：诊断要是能过，真实路径就也能过（否则诊断没意义）
                  source: chatroomSource('diagnose', 'diagnose'),
                }))
                info.followupRelay = 'ok'
              } catch (err) {
                info.followupRelay = 'threw: ' + (err && err.message ? err.message : String(err))
              }
            }
            return ok(info)
          }
          default:
            return fail('unknown endpoint: ' + String(endpoint))
        }
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }

    // ① 新版 DSH：直挂到本插件自己的 webServer 上。
    //    client-connection 把 inject 收缩为 ['credentials'] 之后，rpc.handle() 内部
    //    那句 owner.webServer.register(...) 会抛 "cannot get property ... without inject"，
    //    通道挂在半路 —— 浏览器侧的 POST /dsh-chatroom/* 掉进静态兜底处理器并收到 405。
    const webServer = ctx.get === undefined ? undefined : ctx.get('webServer')
    if (webServer !== undefined && webServer !== null && typeof webServer.register === 'function') {
      try {
        const dispose = mountRoute(webServer, RPC_CHANNEL, handleRpc, connection)
        ctx.effect(() => dispose, 'dsh-chatroom: panel rpc route')
        debug('注册面板 RPC 通道（webServer 直挂）: ' + RPC_CHANNEL)
        return
      } catch (err) {
        debug('webServer 直挂失败，回退 rpc.handle: ' + (err && err.message ? err.message : String(err)))
      }
    }

    // ② 旧版 DSH（没有 webServer 服务）：回退原来的通道注册。
    if (connection.rpc === undefined || typeof connection.rpc.handle !== 'function') {
      debug('connection.rpc.handle 不可用 —— 面板通道未注册')
      return
    }
    try {
      connection.rpc.handle(RPC_CHANNEL, handleRpc, { authority: 'loopback' })
      debug('注册面板 RPC 通道（rpc.handle 回退）: ' + RPC_CHANNEL)
    } catch (err) {
      debug('rpc.handle 回退失败: ' + (err && err.message ? err.message : String(err)))
    }
  })
}

export { apply, inject, name }
