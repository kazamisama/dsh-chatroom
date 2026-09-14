/**
 * dsh-chatroom —— 房间状态机（纯逻辑，不 import 任何 DSH API，可独立测试）
 *
 * 设计权威：BLUEPRINT.md（§5 身份 / §9 数据模型 / §2 D5 回执终端）
 *
 * 本模块只负责「状态」，不负责「投递」。投递（followup/inject/steer）在 lib/index.js，
 * 因为那需要 DSH 的 Agent API。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** 结构化判断枚举（BLUEPRINT D13）——只有这四个，自由文本进 note。 */
export const VERDICTS = ['unaffected', 'catch-up', 'retest', 'need-info']

/** 消息类别（BLUEPRINT §9）。terminal 的消息不产生新义务（D5）。 */
export const MESSAGE_KINDS = ['human', 'change-notice', 'judgment', 'free', 'system', 'alert']

/** 欠表态多久算逾时（M3）。只用于展示与统计，不产生任何副作用。 */
export const DEFAULT_OVERDUE_MINUTES = 10

/** 产生「必须回」义务的类别：只有人的发言。@ 提及在投递层另行展开为定向义务。 */
const OBLIGATING_KINDS = new Set(['human'])

/** 房间人数上限（BLUEPRINT §10 上限保护）。 */
export const DEFAULT_MAX_MEMBERS = 5
/** 线程预算：一条线程最多几跳（BLUEPRINT D5 双保险）。 */
export const DEFAULT_THREAD_BUDGET = 4

const EMPTY = () => ({
  version: 1,
  rooms: [],
  members: [],
  messages: [],
  cursors: [],
  changes: [],
  judgments: [],
  baselines: [],
  nextSeq: 1,
})

/**
 * 短号：session id 前 8 位，房间里的显示身份（BLUEPRINT §5）。
 * 两种前缀都剥：`session-`（常见）与 `session_`（新版缓存的不透明键形态）——
 * 只剥前者的话，后者会显示成一个毫无区分度的 "session_"。
 */
export function shortId(sessionId) {
  const s = String(sessionId || '')
  const stripped = s.startsWith('session-') || s.startsWith('session_') ? s.slice(8) : s
  return stripped.slice(0, 8)
}

/**
 * 剥掉「引述」部分：围栏代码块、行内 code、「」『』、成对双引号。
 *
 * 为什么：真机 #58 把机制钉死了 —— **引述即提及**。有人想讨论房间自己那条
 * 「⚠ 可能越界 … @某某 确认」，就必须引述它；而引述它，就必然 @ 到里面那个人，
 * 于是讨论越界警告这个动作本身会制造提及（#45 与 #53 两次都源于同一段被引述的文本）。
 *
 * 只剥成对的、边界清楚的引述；ASCII 单引号不剥（don't 这种撇号会被误伤）。
 */
function stripQuoted(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' ')   // 围栏代码块
    .replace(/`[^`\n]*`/g, ' ')        // 行内 code
    .replace(/「[^」]*」/g, ' ')        // 中文引号
    .replace(/『[^』]*』/g, ' ')
    .replace(/"[^"\n]*"/g, ' ')        // 成对双引号
}

/**
 * 从一段话里解析 @ 提及，返回被提及成员的 sessionId 列表。**纯函数**，独立可测。
 *
 * 为什么必须有它：房间消息是人读的，而 @ 是**唯一**能让人从"背景里看到了"
 * 变成"被叫起来必须回一句"的说法。没有它，agent 写的「@6126bf05 请确认」根本不会
 * 唤醒 6126bf05 —— 它只是被投了一份背景上下文（真机反馈 2026-09-12）。
 *
 * 认三种写法（都不区分大小写）：
 *   @短号（房间里显示的那 8 位）／@角色名／@全体（也认 all、everyone、所有人）
 *
 * 两条防误伤（真机 #58 报的）：
 *   1. **引述里的 @ 不算**（见 stripQuoted）——「引述即提及」是这套东西最容易自己咬自己的地方；
 *   2. **发送者不提及自己**：自提及永远是笔误，不该产生「你必须回一句」的义务。
 *
 * @param senderId 可选：这条消息的发送者，从结果里排除。
 */
export function parseMentions(text, members, senderId = null) {
  const body = String(text === undefined || text === null ? '' : text)
  const list = Array.isArray(members) ? members : []
  if (body.indexOf('@') < 0) return []
  const live = stripQuoted(body)
  const notSelf = (m) => senderId === null || senderId === undefined || m.sessionId !== senderId
  if (/@(全体|所有人|all|everyone)/i.test(live)) return list.filter(notSelf).map((m) => m.sessionId)
  const ids = []
  for (const member of list) {
    if (!notSelf(member)) continue
    const short = shortId(member.sessionId)
    const role = String(member.roleName || '')
    if (short !== '' && live.indexOf('@' + short) >= 0) ids.push(member.sessionId)
    else if (role !== '' && live.indexOf('@' + role) >= 0) ids.push(member.sessionId)
  }
  return ids
}

/**
 * 方向文本里的否定词：这些词所在的片段表示「这不是我的地盘」，不表示「我负责」。
 *
 * 词表是**必要之恶**：靠语义猜一定会有漏网（真机 #45 报的假阳性就是 ——
 * 对方写的是「我从未声明过所有权，但…我会在这两个文件里只追加自己的章节」，
 * 旧词表只认「不碰 / 不动 / 不负责」，于是路径字面量被读成了所有权主张）。
 * 所以：词表尽量宽（假阳性会让人被迫来问，代价比漏报高），并且 ⚠ 行必须**回引匹配到的那一句**，
 * 让漏网的那次也能一眼自诊。
 */
const DIRECTION_NEGATIVE_MARKERS = [
  '不碰', '不动', '别动', '勿动', '不要动', '不负责', '不涉', '不管', '不改', '免动',
  // 真机踩过的措辞：说「不是我的」时照样会带出路径字面量
  '从未', '未声明', '无所有权', '没有所有权', '不拥有', '不是我的', '非我', '不在我', '不属于', '不归我',
  '只追加', '只报告', '只读', '仅报告', '除外',
  "don't touch", 'do not touch', 'avoid', 'not responsible', 'no ownership', 'not mine', 'out of scope',
]

/** 「归 <别人的短号>」也是否定：说的是别人的地盘（js/chat.js 归 6126bf05）。 */
const DIRECTION_OTHERS_PATTERN = /(?:归|属于|划给)\s*@?[0-9a-zA-Z_][0-9a-zA-Z_-]{3,}/

/** 「除 X 之外」——只否定 X，**不否定整句**（见 ownedPaths 里的说明）。 */
const DIRECTION_EXCEPT_PATTERN = /除\s*([^，,。；;、]{1,60}?)\s*(?:之外|以外)/

/** 方向文本里认得出是「文件」的词：带已知扩展名。 */
const DIRECTION_FILE_PATTERN = /[A-Za-z0-9_\-./]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|css|scss|html|md|json|ya?ml|sh|ps1|go|rs|java|c|cc|cpp|h|hpp|sql|toml|ini)\b/g

/**
 * 认得出是「目录 / 通配」的词：至少两段路径。
 * 为什么需要它：真机的方向就写成 `ulysses/adapters/webui/** 的页面` —— 只认带扩展名的文件，
 * 整块目录的所有权就漏掉了（有人进去改页面不会被提醒）。
 */
const DIRECTION_DIR_PATTERN = /[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.*-]+)+/g

/**
 * 从一句「方向」里抽出它**负责**哪些文件、以及明确说**不碰**哪些文件。（纯函数，独立可测。）
 *
 * 为什么要区分正负：真机上有人这样写方向 ——
 * 「我负责 …（js/chat.js 的气泡真实性修复）；**不碰**同目录的 js/memory.js 与 dashboard.css」。
 * 把「不碰」也算成它的地盘，就会把它明明让出来的文件误判成越界。
 *
 * 做法：按标点切片段 → 片段里带否定词就归 excluded，否则归 owned。
 */
export function ownedPaths(direction) {
  const out = { owned: [], excluded: [] }
  const text = String(direction === undefined || direction === null ? '' : direction)
  const segments = text.split(/[；;。\n，,、（）()【】\[\]｜|]+/)
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]
    const fileTokens = segment.match(DIRECTION_FILE_PATTERN) || []
    const dirTokens = (segment.match(DIRECTION_DIR_PATTERN) || []).filter((t) => !fileTokens.includes(t))
    if (fileTokens.length === 0 && dirTokens.length === 0) continue
    // 「除 X 之外」**只否定 X**，不否定整句 —— 真机原文就是
    // 「负责 …除 js/chat.js 之外的部分：… dashboard.css …」：整句算否定的话，
    // 他真正负责的 dashboard.css 也会被让出去（漏报比误报便宜，但没必要漏）。
    const exceptHit = DIRECTION_EXCEPT_PATTERN.exec(segment)
    const exceptScope = exceptHit === null ? '' : exceptHit[1]
    const negative = DIRECTION_NEGATIVE_MARKERS.some((marker) => segment.toLowerCase().includes(marker))
      || DIRECTION_OTHERS_PATTERN.test(segment)
    const push = (token, kind) => {
      const clean = token.replace(/^\.\//, '').replace(/\\/g, '/')
      // 连同**它所在的句子与句号**一起带出来：⚠ 行要能回引，人才好自诊（#45 的诉求）
      const item = { token: clean, kind, sentence: segment.trim(), index: i + 1 }
      const inExcept = exceptScope !== '' && exceptScope.indexOf(token) >= 0
      if (negative || inExcept) out.excluded.push(item)
      else out.owned.push(item)
    }
    for (const token of fileTokens) push(token, 'file')
    for (const token of dirTokens) push(token, 'dir')
  }
  return out
}

/**
 * 声明的文件是否落在某个方向 token 上。
 * 文件 token 按**后缀**匹配（短路径能命中长路径）；目录/通配 token 按**前缀**匹配。
 */
function fileMatchesToken(file, item) {
  const f = String(file).replace(/\\/g, '/').toLowerCase()
  const t = String(item.token).replace(/\\/g, '/').replace(/\*+$/, '').replace(/\/+$/, '').toLowerCase()
  if (t === '' || f === '') return false
  if (item.kind === 'dir') return f === t || f.startsWith(t + '/')
  return f === t || f.endsWith('/' + t) || f.endsWith(t)
}

/**
 * 「越界」检测：这次声明的文件，落在了**别人**声明负责的范围里吗？（纯函数，独立可测。）
 *
 * 越权的真机形态（用户原话）：*发现别的会话负责的区域有问题，没有发到 chatroom 并 @，
 * 直接自己改了*。插件拦不住手，但可以让它**不可能悄悄发生** —— 声明时就把
 * 「这文件落在谁的地盘」写进消息，并把那位负责人一起 @ 上（于是它必须回一句）。
 *
 * 明确的「不碰」优先于「负责」：文件同时命中两者的，按没越界处理（宁可少判）。
 * 被用户关掉的成员不参与判定（它不在房间里，叫它也不会应）。
 */
export function detectOverreach(files, members, declarerId) {
  const list = Array.isArray(members) ? members : []
  const declared = Array.isArray(files) ? files : []
  const hits = []
  for (const member of list) {
    if (member.sessionId === declarerId) continue
    if (member.enabled === false) continue
    const split = ownedPaths(member.selfDescription)
    if (split.owned.length === 0) continue
    const matched = []
    for (const file of declared) {
      const own = split.owned.find((item) => fileMatchesToken(file, item))
      if (own === undefined) continue
      if (split.excluded.some((item) => fileMatchesToken(file, item))) continue // 它自己说了不碰 → 不算越界
      // 把「匹配到哪个子串、来自哪一句」一并带出来 —— 假阳性时这正是自诊要的东西
      matched.push({ file, token: own.token, kind: own.kind, sentence: own.sentence, index: own.index })
    }
    if (matched.length > 0) {
      hits.push({
        sessionId: member.sessionId,
        direction: String(member.selfDescription || ''),
        files: matched.map((m) => m.file),
        matched,
      })
    }
  }
  return hits
}

/**
 * 正文里写明了「不需要回应」吗？（纯函数，独立可测。）
 *
 * 为什么需要它：真机 #53 我在正文里写了「不要求谁回应」，插件照样把被点到的人叫起来、
 * 还塞了强制回执义务 —— **作者自己最清楚这条要不要人回**，正文说了就照办（#55 报的）。
 *
 * 只认明确的长短语，不认「不必回」这种半截词（「不必回滚」会被误伤）。
 * 另有一条更硬的路径：`room_say` 的 `wake: false` 参数（显式声明 > 文本解析）。
 */
const NO_REPLY_MARKERS = [
  '不需要回应', '不需要回复', '不需要回执', '不需要回话', '不需要表态', '不需要谁回应',
  '不要求回应', '不要求回复', '不要求回执', '不要求回话', '不要求表态', '不要求谁回应',
  '不需回应', '无需回应', '无需回复', '无需回执', '无需回话', '无需表态',
  '不必回应', '不必回复', '不必回执', '不必回话', '不必表态',
  '不用回应', '不用回复', '不用回执', '不用回话', '不用表态',
  '免回执', '无需回复我', '不用回复我', '不必回复我',
  'no reply needed', 'no response needed', 'no reply required', 'no response required',
  'no need to reply', 'no need to respond', 'do not reply', "don't reply", 'fyi only',
]

export function saysNoReply(text) {
  const body = String(text === undefined || text === null ? '' : text).toLowerCase()
  if (body === '') return false
  return NO_REPLY_MARKERS.some((marker) => body.includes(marker))
}

/**
 * 创建一个房间存储。
 * @param root 状态目录（默认由调用方给 ~/.dsh/dsh-chatroom）
 */
export function createChatroomStore({ root, now = () => Date.now(), newId = () => Math.random().toString(36).slice(2, 10) }) {
  const stateFile = path.join(root, 'rooms.json')
  let state = EMPTY()

  async function load() {
    try {
      const raw = await fs.readFile(stateFile, 'utf8')
      const parsed = JSON.parse(raw)
      state = Object.assign(EMPTY(), parsed)
      stateError = null
    } catch (err) {
      // 首次运行（ENOENT）是正常的；**文件存在却读不出来**不是 —— 那不是"没有房间"，
      // 是**一份记录正在被丢掉**。旧行为是静默退回空状态（catch → EMPTY），
      // 于是一次写坏就等于整份房间记录无声清零（真机 #653 的并发窗口正好能造出半截文件）。
      // 现在：先把原文另存一份（人不丢证据），再把这件事记下来给 room_status 说。
      const code = err !== null && typeof err === 'object' ? err.code : null
      if (code !== 'ENOENT') {
        const backup = stateFile + '.corrupt-' + Date.now()
        try { await fs.rename(stateFile, backup) } catch { /* 存不下也不阻断加载 */ }
        stateError = '状态文件读不出来（' + (err && err.message ? String(err.message) : String(err))
          + '）—— 原文已另存为 ' + path.basename(backup) + '，本次以空房间启动'
      }
      state = EMPTY()
    }
    return state
  }

  /**
   * 落盘。**串行化 + 每次写入用自己的 tmp 名**（真机 #653 / #661 报的）。
   *
   * 旧实现所有写入共用 `rooms.json.tmp`，并发时（同一批次里发两条房间消息）会出现两个方向都坏：
   *   A 写 tmp → B 写 tmp（**覆盖掉 A 的内容**）→ A rename 成功（盘上是 B 的内容，A 的载荷没了）
   *   → B rename → ENOENT（tmp 已被 A 消费掉）
   * 于是「抛错但其实写进去了」与「抛错且真的丢了」会同时出现，而调用方**无从判断该不该重试**：
   * 重试可能造重复、不重试可能静默丢一条「我改了什么」。
   *
   * 修法两件事一起做：写入排队（同进程内不会交错），以及每次写入用**自己的** tmp 名
   * （即使将来有第二个进程，也不会互相消费对方的 tmp）。
   */
  let writeChain = Promise.resolve()
  let writeSeq = 0
  /**
   * 状态文件出过什么问题（写盘失败 / 读盘时发现损坏）。
   * 两件事都不该是静默的：房间在内存里是完整的，盘上可能不是（真机 #653）。
   * 它不是给机器看的，是给 room_status 看的 —— 所以读盘成功即清空。
   */
  let stateError = null

  async function writeOnce() {
    await fs.mkdir(root, { recursive: true })
    const tmp = stateFile + '.' + process.pid + '.' + (writeSeq++) + '.tmp'
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
    try {
      try {
        await fs.rename(tmp, stateFile)
      } catch {
        // Windows 上杀软/索引器偶尔短暂占用文件（真机里"重试一次就成功"）；重试一次再放弃。
        await new Promise((resolve) => setTimeout(resolve, 25))
        await fs.rename(tmp, stateFile)
      }
      stateError = null
    } catch (err) {
      // 自己的 tmp 自己清 —— 但别用清理的失败覆盖真正的错因。
      try { await fs.unlink(tmp) } catch { /* 清不掉就算了 */ }
      stateError = err && err.message ? String(err.message) : String(err)
      throw err
    }
  }

  function persist() {
    // 排队：前一次写完（**成功或失败**）才开始下一次 —— 一次失败不能毒化整条队列。
    const next = writeChain.then(writeOnce, writeOnce)
    writeChain = next.then(() => undefined, () => undefined)
    return next
  }

  /** 状态文件最近的麻烦（没有就是 null）。room_status 用它把静默降级说出来。 */
  function stateErrorText() {
    return stateError
  }

  // ---- 房间 ---------------------------------------------------------------

  function listRooms() {
    return state.rooms.slice()
  }

  function getRoom(roomId) {
    return state.rooms.find((r) => r.id === roomId) || null
  }

  async function createRoom({ name: roomName, createdBy = 'user', maxMembers = DEFAULT_MAX_MEMBERS } = {}) {
    const room = {
      id: 'room-' + newId(),
      name: roomName || '未命名房间',
      createdBy,
      createdAt: now(),
      policy: { maxMembers, threadBudget: DEFAULT_THREAD_BUDGET },
    }
    state.rooms.push(room)
    await persist()
    return room
  }

  /**
   * 改房间策略（成员上限 / 线程预算）。
   *
   * 只收这两个字段，**非法值一律拒绝（抛）而不是夹取** —— 夹取会让调用方以为设上了，
   * 那是"静默改坏"的形状（真机教训：这一屋子的错都是"看着成功、其实没生效"）。
   *
   * 允许把上限调到**低于当前人数**：已经在房间里的人不受影响（既成事实），
   * 只是在那之前加不进新成员 —— 比"拒绝降低"更符合直觉（人数只会因为用户关闭而减少）。
   */
  async function setPolicy(roomId, patch = {}) {
    const room = getRoom(roomId)
    if (room === null) throw new Error('room not found: ' + roomId)
    const next = { ...room.policy }
    const intOf = (value, label, low, high) => {
      // **不 Math.floor**：1.5 静默变成 1 也是"夹取"，而这句承诺的是"拒绝"。
      const n = Number(value)
      // **isInteger 而不是 isFinite**：1.5 过得了后者的闸，然后被原样存进策略里
      if (!Number.isInteger(n) || n < low || n > high) {
        throw new Error(label + ' 必须是 ' + low + '..' + high + ' 的整数（收到 ' + JSON.stringify(value) + '）')
      }
      return n
    }
    if (patch !== null && typeof patch === 'object') {
      if (patch.maxMembers !== undefined && patch.maxMembers !== null && String(patch.maxMembers) !== '') {
        next.maxMembers = intOf(patch.maxMembers, '成员上限', 1, 64)
      }
      if (patch.threadBudget !== undefined && patch.threadBudget !== null && String(patch.threadBudget) !== '') {
        next.threadBudget = intOf(patch.threadBudget, '线程预算', 1, 32)
      }
    }
    room.policy = next
    await persist()
    return room
  }

  async function removeRoom(roomId) {
    state.rooms = state.rooms.filter((r) => r.id !== roomId)
    state.members = state.members.filter((m) => m.roomId !== roomId)
    state.cursors = state.cursors.filter((c) => c.roomId !== roomId)
    // 消息与判断保留：审计需要（BLUEPRINT §13 最后一条）
    await persist()
  }

  // ---- 成员（BLUEPRINT D2：用户逐个开关，默认不加入）------------------------

  function members(roomId) {
    return state.members.filter((m) => m.roomId === roomId)
  }

  /** 在房间里的成员（enabled=true 才算「在房间」；缺席者不产生义务）。 */
  function activeMembers(roomId) {
    return members(roomId).filter((m) => m.enabled !== false)
  }

  async function join(roomId, sessionId, { roleName = '', subscriptions = [], enabled = true } = {}) {
    const room = getRoom(roomId)
    if (room === null) throw new Error('room not found: ' + roomId)
    const active = activeMembers(roomId)
    if (active.length >= room.policy.maxMembers && !active.some((m) => m.sessionId === sessionId)) {
      throw new Error('room is full (' + room.policy.maxMembers + ' members max)')
    }
    let member = members(roomId).find((m) => m.sessionId === sessionId)
    if (member === undefined) {
      member = { roomId, sessionId, roleName, enabled, joinedAt: now(), subscriptions: subscriptions.slice(), selfDescription: '' }
      state.members.push(member)
    } else {
      member.enabled = enabled
      if (roleName !== '') member.roleName = roleName
      if (subscriptions.length > 0) member.subscriptions = subscriptions.slice()
    }
    // 新成员从「当前最后一条」开始读，不补历史（否则一进房间就被灌一屏）
    if (!state.cursors.some((c) => c.roomId === roomId && c.sessionId === sessionId)) {
      state.cursors.push({ roomId, sessionId, lastSeq: lastSeq(roomId) })
    }
    await persist()
    return member
  }

  /**
   * 开关成员资格（D2）。关闭后该成员不产生义务，房间显示「未在房间（用户已关闭）」。
   */
  async function setEnabled(roomId, sessionId, enabled) {
    const member = members(roomId).find((m) => m.sessionId === sessionId)
    if (member === undefined) throw new Error('member not found in room')
    member.enabled = enabled === true
    await persist()
    return member
  }

  /** 成员的一句话自述（BLUEPRINT §5 状态层）。 */
  async function setSelfDescription(roomId, sessionId, text) {
    const member = members(roomId).find((m) => m.sessionId === sessionId)
    if (member === undefined) return null
    member.selfDescription = String(text || '').slice(0, 200)
    await persist()
    return member
  }

  // ---- 消息 ---------------------------------------------------------------

  function lastSeq(roomId) {
    const list = state.messages.filter((m) => m.roomId === roomId)
    return list.length === 0 ? 0 : list[list.length - 1].seq
  }

  /**
   * 追加一条消息。
   * @param sender { sessionId } 或 { user: true }
   * @param kind MESSAGE_KINDS 之一
   * @param terminal 该消息是否是终端动作（回执）——终端消息不产生新义务（D5）
   */
  async function appendMessage({ roomId, sender, kind, body, refs = [], terminal = false, threadId = null, mentions = null }) {
    if (!MESSAGE_KINDS.includes(kind)) throw new Error('unknown message kind: ' + kind)

    // 线程深度（M3）：threadId 形如 "re:<seq>"，深度 = 被回复消息的深度 + 1。
    const parent = typeof threadId === 'string' && threadId.startsWith('re:')
      ? state.messages.find((m) => m.roomId === roomId && String(m.seq) === threadId.slice(3))
      : undefined
    const depth = parent === undefined ? 0 : (parent.depth || 0) + 1
    const room = state.rooms.find((r) => r.id === roomId)
    const budget = room === undefined ? DEFAULT_THREAD_BUDGET : room.policy.threadBudget
    // 深度用尽：这条消息**不再产生任何新义务**（BLUEPRINT D5 的双保险）。
    // 判断在写入时做，读取路径保持纯函数。
    const exhausted = depth >= budget

    const message = {
      seq: state.nextSeq++,
      roomId,
      sender,
      kind,
      body: String(body || ''),
      refs: refs.slice(),
      terminal: terminal === true,
      threadId,
      // 定向义务：@ 提及，以及变更通知里被确定性匹配判定「可能相关」的成员（BLUEPRINT §6.4）。
      // 只在非空时写键 —— 保持消息是干净的 lossless JSON。
      ...(Array.isArray(mentions) && mentions.length > 0 && !exhausted ? { mentions: mentions.slice() } : {}),
      ...(depth > 0 ? { depth } : {}),
      ...(exhausted ? { budgetStopped: true } : {}),
      ts: now(),
    }
    state.messages.push(message)
    await persist()
    return message
  }

  /** 一条消息产生义务的成员（D5：只有非终端、且类别在 OBLIGATING_KINDS 里）。 */
  function obligors(roomId, seq) {
    const message = state.messages.find((m) => m.roomId === roomId && m.seq === seq)
    if (message === undefined) return []
    if (message.terminal === true) return []
    // 线程预算耗尽 → 义务到此为止（M3）
    if (message.budgetStopped === true) return []
    if (!OBLIGATING_KINDS.has(message.kind) && !Array.isArray(message.mentions)) return []
    const base = activeMembers(roomId)
    // **表态是终端的（D5）**：已经表过态的人不再欠这条消息任何东西。
    // 少了这一步，投递层会把同一条消息连同「你必须回一句」再送一次 ——
    // 状态显示（pending）是对的、消息却重复来，真机 #55 就是这么报上来的。
    const judged = new Set(judgedBy(roomId, seq))
    // **作者永远不欠自己一条回执**（真机 #45 / #58 / #61 报的「重复投递」）。
    // 自我提及不是义务：谁也回应不了自己。真机记录里已经躺着两条 sender ∈ mentions
    // 的旧消息，所以这一层必须自己排 —— 光靠 parseMentions 不再产生新的不够。
    // 排不掉的后果不是「多一条待表态」那么轻：投递层会对着**正在执行这次 room_say
    // 的那个 agent 自己**发 followup，DSH 只能把它挂进 inbox 队列（target=next-turn），
    // 等它下一轮开始时才落地 —— 那时它多半已经从 room_status 看到并回执过了，
    // 于是那帧就成了「回执之后又被投一次」。
    const author = message.sender && typeof message.sender.sessionId === 'string'
      ? message.sender.sessionId
      : null
    const owed = base.filter((m) => !judged.has(m.sessionId) && m.sessionId !== author)
    // 人的发言 → 全体在房间成员；其余（含 @ 提及）→ 仅被提及者
    if (message.kind === 'human' && !Array.isArray(message.mentions)) return owed
    const mentioned = new Set(message.mentions || [])
    return owed.filter((m) => mentioned.has(m.sessionId) || mentioned.has(shortId(m.sessionId)))
  }

  /** 这条消息已经表过态的成员。投递层也要用它（别把「你必须回一句」再送一次）。 */
  function judgedBy(roomId, seq) {
    return state.judgments
      .filter((j) => j.roomId === roomId && j.seq === seq)
      .map((j) => j.sessionId)
  }

  // ---- 已读游标与增量（D6）------------------------------------------------

  function cursorOf(roomId, sessionId) {
    const c = state.cursors.find((x) => x.roomId === roomId && x.sessionId === sessionId)
    return c === undefined ? 0 : c.lastSeq
  }

  async function markRead(roomId, sessionId, seq) {
    let c = state.cursors.find((x) => x.roomId === roomId && x.sessionId === sessionId)
    if (c === undefined) {
      c = { roomId, sessionId, lastSeq: 0 }
      state.cursors.push(c)
    }
    if (seq > c.lastSeq) c.lastSeq = seq
    await persist()
    return c
  }

  /** 自成员上次已读以来的增量——这是唯一该进成员上下文的历史（D6）。 */
  function deltaFor(roomId, sessionId) {
    const from = cursorOf(roomId, sessionId)
    return state.messages.filter((m) => m.roomId === roomId && m.seq > from)
  }

  // ---- 判断（D13）---------------------------------------------------------

  async function judge({ roomId, seq, sessionId, verdict, note = '' }) {
    if (!VERDICTS.includes(verdict)) throw new Error('unknown verdict: ' + verdict)
    const existing = state.judgments.find((j) => j.roomId === roomId && j.seq === seq && j.sessionId === sessionId)
    if (existing !== undefined) {
      existing.verdict = verdict
      existing.note = note
      existing.ts = now()
      await persist()
      return existing
    }
    const judgment = { roomId, seq, sessionId, verdict, note, ts: now() }
    state.judgments.push(judgment)
    // 表态必须同时落一条 terminal 消息：房间日志里要看得见「谁表了什么态」（BLUEPRINT §13）。
    // terminal=true 保证回执不产生新义务（D5 回执终端）。
    await appendMessage({
      roomId,
      sender: { sessionId },
      kind: 'judgment',
      body: note === '' ? verdict : verdict + ': ' + note,
      refs: [],
      terminal: true,
      threadId: 're:' + seq,
    })
    // 表态同时推进已读游标
    await markRead(roomId, sessionId, seq)
    await persist()
    return judgment
  }

  /**
   * 房间现状：谁欠一次表态、谁已经表了、谁不在房间（不参与）。
   * 这是面板与 room_status 工具的唯一数据源。
   */
  /**
   * 最近一条「产生义务」的消息。面板默认要盯的是它——不是最后一条消息。
   * 因为表态本身也会落消息（terminal），若以最后一条为准，一有人表态靶子就跑了。
   */
  function latestObligatingSeq(roomId) {
    const list = state.messages.filter((m) => m.roomId === roomId)
    for (let i = list.length - 1; i >= 0; i--) {
      if (obligors(roomId, list[i].seq).length > 0) return list[i].seq
    }
    return lastSeq(roomId)
  }

  function status(roomId, seq = null, overdueMinutes = DEFAULT_OVERDUE_MINUTES) {
    const room = getRoom(roomId)
    if (room === null) return null
    const target = seq === null ? latestObligatingSeq(roomId) : seq
    const owed = obligors(roomId, target).map((m) => m.sessionId)
    const done = state.judgments.filter((j) => j.roomId === roomId && j.seq === target)
    const doneIds = new Set(done.map((j) => j.sessionId))
    // 逾时（M3）：欠表态超过阈值。**纯读取时计算** —— 不写消息、不起定时器，
    // 面板每 2 秒轮询，逾时一到自然就显示出来了，没有重复通知的问题。
    const targetMessage = state.messages.find((m) => m.roomId === roomId && m.seq === target)
    const ageMs = targetMessage === undefined ? 0 : now() - targetMessage.ts
    const overdue = ageMs > overdueMinutes * 60000
    return {
      room,
      lastSeq: lastSeq(roomId),
      targetSeq: target,
      members: members(roomId).map((m) => ({
        sessionId: m.sessionId,
        shortId: shortId(m.sessionId),
        roleName: m.roleName,
        enabled: m.enabled !== false,
        inRoom: m.enabled !== false,
        selfDescription: m.selfDescription,
        lastReadSeq: cursorOf(roomId, m.sessionId),
        owed: owed.includes(m.sessionId) && !doneIds.has(m.sessionId),
        overdue: owed.includes(m.sessionId) && !doneIds.has(m.sessionId) && overdue,
        verdict: (done.find((j) => j.sessionId === m.sessionId) || {}).verdict || null,
      })),
      pending: owed.filter((id) => !doneIds.has(id)),
      overdue: overdue && owed.some((id) => !doneIds.has(id)),
      judgments: done,
    }
  }

  // ---- 变更核验的参照点（BLUEPRINT §6.2）--------------------------------

  /**
   * 房间对某个工作区上次记下的 HEAD。
   * 有它，「与事实不符」才是**判定**而不是猜测 —— 否则一个 40 分钟前提交、
   * 现在才声明的改动会被时间窗冤枉成撒谎，而这个信号一旦误报就没人信了。
   */
  function baselineFor(roomId, workspace) {
    return state.baselines.find((b) => b.roomId === roomId && b.workspace === workspace) || null
  }

  async function setBaseline(roomId, workspace, head) {
    if (typeof head !== 'string' || head === '') return null
    let entry = state.baselines.find((x) => x.roomId === roomId && x.workspace === workspace)
    if (entry === undefined) {
      entry = { roomId, workspace, head, at: now() }
      state.baselines.push(entry)
    } else {
      entry.head = head
      entry.at = now()
    }
    await persist()
    return entry
  }

  return {
    load,
    persist,
    stateError: stateErrorText,
    listRooms,
    baselineFor,
    setBaseline,
    getRoom,
    createRoom,
    setPolicy,
    removeRoom,
    members,
    activeMembers,
    join,
    setEnabled,
    setSelfDescription,
    appendMessage,
    obligors,
    judgedBy,
    cursorOf,
    markRead,
    deltaFor,
    judge,
    status,
    latestObligatingSeq,
    lastSeq,
    get state() { return state },
  }
}
