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
// 写之前的体检（机制借自 DSH agent-team 的 src/invariant.ts）：
// 「候选事件先重放校验、再追加」—— 坏状态**写不进去**，而不是写进去后靠人在 room_status 里看出来。
import { assertMessageAppend, assertJudgment, assertTaskWrite, assertStateShape } from './invariants.js'

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
/**
 * 逾期提醒（"追"）的两个闸（用户 2026-09-25 裁定"追"）。
 *
 * 在此之前**没有任何路径会重发**一条已投递但没回的义务 —— 欠账只被读出来，不会自己找上门。
 * 但"追"必须是有限度的，否则它就从"提醒"变成"骚扰"，而骚扰的下场是被忽略：
 *   · 同一条义务冷却 30 分钟（投递可能滞后，追太密只会在对方的队列里叠帧）；
 *   · 最多追 3 次，之后只在 room_status / 面板里显示（把"他不回"变成可见的事实，而不是继续敲）。
 * 明确声明 watch=feed（看得见但别叫醒我）或 none 的席位**不追** —— 那是它们自己声明的合约。
 */
export const REMIND_COOLDOWN_MS = 30 * 60 * 1000
export const REMIND_MAX = 3

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
  // 投递台账（A）与任务板（B）——两张都只在"还没结束"时留痕：ack 掉 / 做完就没了。
  deliveries: [],
  tasks: [],
  // 逾期提醒台账：一条 (房间, 人, 消息) 一条记录，只记 lastAt/count。
  // 它**不**取代投递台账：投递台账回答"这一帧送到了没有"，这张回答"我已经敲过他几次"。
  reminders: [],
  nextTaskId: 1,
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
 * `@token` 是不是一次**点名** —— `@` 后面的 token 必须是**独立的一段**。
 *
 * 边界类的宽窄取决于「接上它之后还是不是同一个指称」（真机 #1970 → #1987）：
 *
 * · **`[0-9A-Za-z]` 永远是边界** —— 它防的是「匹配到一个**不对**的人」：短号是 8 位 hex，
 *   可以是更长 hex/id 串的前缀（`@1789318461` ⇒ `17893184` 谁也不是）。这一格绝不能碰。
 * · **`-` / `_` 只对「词」算边界**（wordLike）：`all-hands`、`auditor-lead` 是**另一个指称**；
 *   而短号是一条 uuid 的**前 8 位**，`-`/`_` 之后仍是**同一条 id**
 *   （`@6126bf05-8163-40fa-…` 就是那个会话）⇒ 对短号来说这两格**只制造漏报、不提供保护**
 *   （#1982②/#1985① 量到：列表形态 `@a-@b` 会**静默丢掉前一个**）⇒ 短号那一路把它们去掉。
 *
 * 角色名里的中文不受影响 —— 前缀匹配角色名是想要的宽松度（`@审计` 命中「审计员」）。
 */
function mentionsToken(text, token, wordLike = false) {
  if (token === '') return false
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp('@' + esc + (wordLike ? '(?![0-9A-Za-z_-])' : '(?![0-9A-Za-z])')).test(text)
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
  if (/@(全体|所有人|all|everyone)(?![0-9A-Za-z_-])/i.test(live)) return list.filter(notSelf).map((m) => m.sessionId)
  const ids = []
  for (const member of list) {
    if (!notSelf(member)) continue
    const short = shortId(member.sessionId)
    const role = String(member.roleName || '')
    if (short !== '' && mentionsToken(live, short)) ids.push(member.sessionId)
    else if (role !== '' && mentionsToken(live, role, true)) ids.push(member.sessionId)
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
  // 只有前两支：**必须有目录边界**。
  // 原来还有第三支 `f.endsWith(t)` —— 它让**半个文件名**也命中：token `webui_auth.py` 命中
  // `tests/unit/test_webui_auth.py`；token `README.md` 命中任何目录下的同名文件。
  // 代价在本仓是真账：`test_webui_*` 的撞名，以及 a4ebb86b 声明里的 `dsh-ulysses-mcp/README.md`
  // 两次命中 837e0518 的边界（真机 #4866/#4870 ⇒ 一条假 ⚠ + 一次被迫回执）。
  // 注释里那句「短路径能命中长路径」**第二支已经表达了**（token `app.py` 命中 `ulysses/app.py` 是靠 `/app.py`）。
  return f === t || f.endsWith('/' + t)
}

/**
 * 工作区归一（比较用）：空/非字符串 ⇒ `''` = **未知**；否则解析成绝对路径、统一分隔符、Windows 下不分大小写。
 * 「未知」不参与比较 —— 宁可多一条 ⚠，也不要把"查不到"当成"不在"（与 BLUEPRINT §6.4 同一条纪律）。
 */
export function normalizeWorkspace(value) {
  if (typeof value !== 'string' || value.trim() === '') return ''
  let abs = value.trim()
  try { abs = path.resolve(abs) } catch { /* 不是合法路径就当字面量比 */ }
  const unified = abs.replace(/\\/g, '/')
  return process.platform === 'win32' ? unified.toLowerCase() : unified
}

/**
 * 「裸文件名」token —— 没有 `/` 的那些（真机 #4866/#4870 的触发形状，提案 B / P3）。
 *
 * `README.md` 这样的 token 按上面的规则**会命中任何目录下的同名文件**（`docs/README.md` 命中了、
 * `dsh-ulysses-mcp/README.md` 也命中了）。这不是判据的错（"短路径命中长路径"是有意为之），
 * 而是**声明得太宽**：作者想要的多半是某一个具体的 `README.md`。
 * 这里只**挑出来回给作者**（在 room_intent 受理时），不改判定 —— 判据不能替人猜。
 */
export function bareTokens(list) {
  const out = []
  for (const raw of Array.isArray(list) ? list : []) {
    const token = String(raw === undefined || raw === null ? '' : raw).trim()
      .replace(/^\.\//, '').replace(/\\/g, '/').replace(/\/+$/, '')
    if (token === '' || token.includes('/')) continue
    if (/[*?]/.test(token)) continue // 那是 suspectGlobs 的活
    if (!out.includes(token)) out.push(token)
  }
  return out
}

/**
 * 结构化声明的路径（room_intent 的 paths/excludes、join 的 subscriptions）
 * → 与 ownedPaths() **同形状**的条目，让匹配只有一套实现。
 *
 * 为什么要有这一路（2026-09-16，房间 #1420 系列提的 P1，我在活数据上复核过）：
 * 把散文当机器输入会一直付误报的代价 —— 房间 #45 的假阳性催生了否定词表，
 * 而 a4ebb86b 方向里的「**不进** ulysses/runtime 依赖图」中的「不进」不在词表里，
 * 于是每次 runtime 改动都给它挂 ⚠（它在 #1410/#1417 自己报过这条"同源误配"）。
 * 更硬的证据在**数据**里：方向被静默截断到 200 字，本房间 6 人里 3 人顶在上限，
 * 6126bf05 的「不碰 dashboard.css」只剩 `dashbo` —— 否定词和路径一起断掉。
 */
/** 方向散文的上限（**超了报错，不静默截**）。机器读的边界不受它约束 —— 走 paths。 */
export const DIRECTION_MAX_CHARS = 2000
/** 结构化边界最多几条（每条也要短：它是给机器读的，不是第二篇散文）。 */
export const DIRECTION_MAX_PATHS = 40
const PATH_TOKEN_MAX_CHARS = 200

/** paths/excludes 的清洗：去空、去重、限长；非法就抛（不静默丢）。 */
export function cleanPathList(value, label) {
  if (value === null || value === undefined) return []
  if (!Array.isArray(value)) throw new Error(label + ' 必须是字符串数组')
  if (value.length > DIRECTION_MAX_PATHS) {
    throw new Error(label + ' 最多 ' + DIRECTION_MAX_PATHS + ' 条（收到 ' + value.length + '）—— 它是给机器读的边界，不是清单')
  }
  const out = []
  for (const raw of value) {
    const token = String(raw === undefined || raw === null ? '' : raw).trim().replace(/\\/g, '/')
    if (token === '') continue
    if (token.length > PATH_TOKEN_MAX_CHARS) throw new Error(label + ' 里的条目太长（' + token.length + ' 字）：' + token.slice(0, 40) + '…')
    if (!out.includes(token)) out.push(token)
  }
  return out
}

export function structuredPaths(list) {
  const out = []
  for (const raw of Array.isArray(list) ? list : []) {
    const token = String(raw === undefined || raw === null ? '' : raw).trim().replace(/^\.\//, '').replace(/\\/g, '/')
    if (token === '') continue
    // 带 `*`/`?` ／以斜杠结尾 ／没有扩展名 → 按**字面前缀**匹配；否则按文件（后缀）匹配。
    // ⚠ `*` / `?` **不是通配符** —— 它们只是前缀里的一串普通字符（真机 #3169：
    // `tests/unit/test_webui_auth*.py` 于是永远匹配不到 `tests/unit/test_webui_auth.py`，且**没有任何提示**）。
    // 「这一族」的唯一写法是**以 `**` 结尾**；可疑写法由 suspectGlobs() 挑出来喊一声。
    const kind = /[*?]/.test(token) || token.endsWith('/') || !/\.[A-Za-z0-9]+$/.test(token) ? 'dir' : 'file'
    out.push({ token, kind, sentence: '（结构化声明）', index: 0 })
  }
  return out
}

/**
 * 「看起来像通配、其实永远不会命中」的条目（真机 #3169）。
 *
 * 判据里只有一种通配写法有效：**以 `**` 结尾**（= 这一族，按前缀匹配）。
 * 其余含 `*`/`?` 的条目都按**字面前缀**匹配 ⇒ `tests/unit/test_webui_auth*.py` 要求路径以那**整串**结尾，
 * 于是永远匹配不到 `tests/unit/test_webui_auth.py`：**排除静默失效**，代价是一次误唤醒 + 一次被迫回执。
 *
 * 只挑出来喊一声，**不偷偷把它们变成 glob** —— 那会改变所有现存 paths/excludes 的判定（判据不能悄悄换）。
 */
export function suspectGlobs(list) {
  const out = []
  for (const raw of Array.isArray(list) ? list : []) {
    const token = String(raw === undefined || raw === null ? '' : raw).trim().replace(/\\/g, '/')
    if (token === '') continue
    if (!/[*?]/.test(token)) continue
    if (token.endsWith('/**')) continue
    if (!out.includes(token)) out.push(token)
  }
  return out
}

/**
 * 一个成员声明过的地盘 —— **路由、越界判定、事前查询三处共用的唯一来源**。
 *
 * 三处各写一遍是这类系统最容易分叉的地方：查的时候说"没人负责"、叫的时候叫了三个人，
 * 那张事前确认表本身就是新的假绿来源。
 * `structured` = 有没有机器可读的那一份（决定"没命中"能不能当成"不相关"）。
 */
export function memberOwnership(member) {
  const m = member === undefined || member === null ? {} : member
  const declared = structuredPaths(m.paths)
  const subscribed = structuredPaths(m.subscriptions)
  const prose = ownedPaths(m.selfDescription)
  const structured = declared.length > 0 || subscribed.length > 0
  const machine = declared.concat(subscribed)
  return {
    // **有机器可读的那份就只读它，散文不再兜底**（真机 #3122，2026-09-19）：
    // 散文里**提到**一个文件名 ≠ 声明了它 —— 6588d7f6 那句「store.py 的 schema/DDL……是全仓依赖面，
    // 改动前必须先在房间广播」本来是**规矩**，却被读成了所有权主张；代价是一次多余叫醒 + 一次被迫回执，
    // 而更贵的是后果：这类误报会教人不再信任 ⚠。
    // 这条同时让「事前查询（room_owners）」与「事后 ⚠（detectOverreach）」**按构造成一致**：
    // 两处本来就共用本函数，是"把两路合成一份"让它们读到了不同的集合 ⇒ 同一路径一个说 0 人、一个说 1 人。
    // 正负**一起**只看机器那份（既有的 excludes 就是为"不必再用散文写不碰"准备的）。
    owned: structured ? machine : prose.owned,
    excluded: structured ? structuredPaths(m.excludes) : structuredPaths(m.excludes).concat(prose.excluded),
    structured,
    // 散文那份**仍然留着**：只给"没命中时怎么写理由 / 要不要催它补 paths"用，不参与判定。
    proseOwned: prose.owned,
  }
}

/** 命中第一个匹配项（没有则 null）—— 匹配规则只有 fileMatchesToken 一套。 */
export function matchesOwnedPath(file, items) {
  for (const item of Array.isArray(items) ? items : []) {
    if (fileMatchesToken(file, item)) return item
  }
  return null
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
export function detectOverreach(files, members, declarerId, opts = {}) {
  const list = Array.isArray(members) ? members : []
  const declared = Array.isArray(files) ? files : []
  // **边界要带工作区**（提案 B / P2，真机 #4866/#4870）：成员的 paths 是**相对它自己的工作区**写的；
  // 另一侧仓库的同名文件落在它的 token 上，只是巧合。声明的文件住在哪个工作区，由调用方解析好传进来
  //（room_declare_change 用 resolveWorktree 的结论、room_task/room_owners 用它自己的工作区）。
  const declarerWs = normalizeWorkspace(opts.declarerWorkspace)
  const memberWsMap = opts.memberWorkspaces instanceof Map ? opts.memberWorkspaces : null
  const hits = []
  for (const member of list) {
    if (member.sessionId === declarerId) continue
    if (member.enabled === false) continue
    // 两边都**知道**工作区且不同 ⇒ 这条声明根本不在它的仓库里，不参与判定。
    // 任一侧未知（空串）就照旧判定 —— 未知是"查不到"，不是"不在"。
    if (memberWsMap !== null && declarerWs !== '') {
      const mWs = normalizeWorkspace(memberWsMap.get(member.sessionId))
      if (mWs !== '' && mWs !== declarerWs) continue
    }
    // 结构化 paths **优先、且优先到底**：有它就不再读散文（memberOwnership 里那条规矩，真机 #3122）
    const own = memberOwnership(member)
    if (own.owned.length === 0) continue
    const matched = []
    for (const file of declared) {
      const hit = matchesOwnedPath(file, own.owned)
      if (hit === null) continue
      if (matchesOwnedPath(file, own.excluded) !== null) continue // 它自己说了不碰 → 不算越界
      // 把「匹配到哪个子串、来自哪一句」一并带出来 —— 假阳性时这正是自诊要的东西
      matched.push({ file, token: hit.token, kind: hit.kind, sentence: hit.sentence, index: hit.index })
    }
    if (matched.length > 0) {
      hits.push({
        sessionId: member.sessionId,
        direction: String(member.selfDescription || ''),
        paths: Array.isArray(member.paths) ? member.paths.slice() : [],
        structured: own.structured,
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

/**
 * 允许中间夹「你 / 您 / 你们」以及一个「再」的写法（真机 #3169）。
 *
 * 真机原话是「@39f99497 这半**不需要你回应**，只登记一个事实」—— 字面表里没有带「你」的那一形，
 * 于是它**照样被当成真 @ 唤醒、还登记了义务**：作者明说了不用回，插件却逼人回一句。
 * 仍然只认**长短语**（回应/回复/回执/回话/表态），绝不认「不必回」那种半截词 —— 那会误伤「不必回滚」。
 * 与字面表是**并集**：字面表继续管它那一批（含 `不需要谁回应` 这种夹了别的词的写法）。
 */
const NO_REPLY_PATTERNS = [
  /不需(?:要)?(?:你|您|你们)?(?:再)?(?:回应|回复|回执|回话|表态)/,
  /不要求(?:你|您|你们)?(?:再)?(?:回应|回复|回执|回话|表态)/,
  /不(?:必|用)(?:你|您|你们)?(?:再)?(?:回应|回复|回执|回话|表态)/,
  /(?:无需|免)(?:你|您|你们)?(?:再)?(?:回应|回复|回执|回话|表态)/,
  /no need (?:for you )?to (?:reply|respond)/,
  /no (?:reply|response) (?:is )?(?:needed|required)/,
]

export function saysNoReply(text) {
  const body = String(text === undefined || text === null ? '' : text).toLowerCase()
  if (body === '') return false
  if (NO_REPLY_MARKERS.some((marker) => body.includes(marker))) return true
  return NO_REPLY_PATTERNS.some((re) => re.test(body))
}

/**
 * 段落级的「不需要回应」—— 返回 { mentions, suppressed, markedLines }。
 *
 * 为什么必须收窄（真机 #1587 / #1596 / #1597 / #1598 / #1606 / #1609，并有重放证据）：
 * 旧实现拿**整条正文**做一次 includes，于是「另给某人一条时序更正（不需要回应）」这种
 * **逐条标注**会把同一条消息里另外两处「@某人 请裁一句」一起压掉 —— 作者以为问了，
 * 房间判「没有 @ 任何人」，两个真提问静默降级成背景（S6 重放：那三条的 mentions 全是 null）。
 * #1606 的序列更狠：作者为了解释这次被吞而**原样引了一遍那句话** ⇒ 缺陷被自己的解释再触发一次。
 *
 * 规则：标记只压**它所在那一行**里的 @；某行有标记但没有 @ ⇒ 那一行不压任何东西。
 * 「@ 与标记同一行」的语义一个字没变 —— 那才是 #55 要压的形状，host 测试钉着它。
 * 代价是**会漏压**：作者把"整条免回"写在独立一行、别处仍 @ 人时，那些 @ 照常登记义务。
 * 这是故意的取舍（多叫一个人只是贵；漏掉一个真提问等于它没人应），并且 wake=false 仍在，
 * 要整条免回就用它。
 */
export function parseMentionsScoped(text, members, senderId = null) {
  const lines = String(text === undefined || text === null ? '' : text).split('\n')
  const mentions = []
  const suppressed = []
  let markedLines = 0
  for (const line of lines) {
    const found = parseMentions(line, members, senderId)
    // **引述里的标记不算**（与「引述里的 @ 不算提及」同一条规则）：#1597 的作者为了解释
    // 自己被吞，把「不需要回应」原样引了一遍 —— 若不剥引述，这条缺陷会被"解释它"这个动作
    // 再触发一次（#1606 的原话：作者越想说清自己被吞，就越会写那句话）。
    const bare = stripQuoted(line)
    if (!saysNoReply(bare)) {
      for (const id of found) if (!mentions.includes(id)) mentions.push(id)
      continue
    }
    markedLines++
    for (const id of found) if (!suppressed.includes(id)) suppressed.push(id)
  }
  return { mentions, suppressed, markedLines }
}

/**
 * 创建一个房间存储。
 * @param root 状态目录（默认由调用方给 ~/.dsh/dsh-chatroom）
 */
/**
 * 「ref 覆盖之外的额外文件**落在谁的地盘**」那一句（837e0518 #3863 的提案）。
 *
 * 纪律与 ⚠ 越界那行完全一样：**只写裸短号，不产生提及、不登记义务** ——
 * 它是**范围提示**（"这条提交可能把谁的 hunk 一起带走了"），不是要谁表态。
 * 放在这里（而不是 index.js 里）是为了**能单测**：一条纯函数，喂成员表就能验。
 */
export function extraFilesOwnerNote(extraFiles, members, selfSessionId, opts = {}) {
  const files = Array.isArray(extraFiles) ? extraFiles : []
  if (files.length === 0) return ''
  // 工作区也要带（214c26f9 #5017① 静态读出来的那处漏传）：这一句虽然**不登记义务**，
  // 但写错人同样是一条假提示 —— 判据只有一套，两处调用点必须传同样的 opts。
  const hits = detectOverreach(files, members, selfSessionId, opts)
  if (hits.length === 0) return ''
  return ' ｜ 其中 ' + hits
    .map((h) => h.matched.map((m) => m.file).join('、') + ' 落在 ' + shortId(h.sessionId) + ' 的边界里')
    .join('；') + '（**范围提示，不需要谁回话**）'
}

export function createChatroomStore({ root, now = () => Date.now(), newId = () => Math.random().toString(36).slice(2, 10) }) {
  const stateFile = path.join(root, 'rooms.json')
  let state = EMPTY()
  /** 「确实被删过的房间」id 集合（加载时推出、removeRoom 补）。只给体检用，不落盘。 */
  let orphanRooms = new Set()

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
    // 「确实被删过的房间」：盘上还留着它们的历史（消息 / 回执），而 rooms 里已经没有它们了。
    // 加载时推一次（不落盘、不动 schema）—— 体检据此区分"历史"与"引用了一个从没存在过的房间"。
    orphanRooms = new Set()
    const live = new Set(state.rooms.map((r) => (r === null || typeof r !== 'object' ? '' : r.id)))
    for (const m of state.messages) if (m !== null && typeof m === 'object' && !live.has(m.roomId)) orphanRooms.add(m.roomId)
    for (const j of state.judgments) if (j !== null && typeof j === 'object' && !live.has(j.roomId)) orphanRooms.add(j.roomId)
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

  /**
   * 落盘。**默认先做一次整状态体检**（机制借自 agent-team 的 src/invariant.ts）—— 单一咽喉，
   * 所以连"没有单独加过断言"的那些 mutation（createRoom / removeRoom / join / ack / setPolicy …）也一并覆盖。
   *
   * 为什么默认打开、而不是让调用方自己记得加：**这个洞的成因就是"每个入口各自处理"**
   * （真机 2026-09-23：三个逐点断言写着、整状态校验器被测了 93 条却一次都没接上，
   *  于是四处 mutation 在断言之外照常落盘）。默认安全，只有**已经被更强的逐点断言挡在前面**的
   * 热路径才显式 skip（见 appendMessage / judge / createTask / updateTask 的调用点）。
   *
   * fail-closed：体检没过就**不写盘**（盘上留着上一份好状态），并把原因记进 stateError，
   * 让 room_status 把它说出来 —— 而不是让一份坏状态安静地覆盖掉好的那份。
   * 代价是实测来的：真实 9.7 MB / 4682 条消息的 state 上体检 **52.6 ms**（同一份 state 的 JSON.stringify 25 ms）；
   * 热路径 skip，所以每条消息的写入不为它付钱。
   *
   * @param skipStateCheck 只给"已经有逐点断言"的热路径用。
   */
  function persist({ skipStateCheck = false } = {}) {
    if (!skipStateCheck) {
      try {
        assertStateShape(state, { orphanRooms })
      } catch (err) {
        stateError = '状态体检没过，本次**没有写盘**：' + (err && err.message ? String(err.message) : String(err))
        throw err
      }
    }
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
    // 于是这些消息立刻变成"孤儿" —— 先把它记进"确实被删过的房间"，否则紧接着的体检会把它当坏数据。
    orphanRooms.add(roomId)
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

  /**
   * 成员的一句话自述 + **机器可读的边界**（BLUEPRINT §5 状态层 / §6.4 判据③）。
   *
   * 旧实现是 `String(text).slice(0, 200)` —— **静默截断**。真机实测（2026-09-16）：
   * 本房间 6 人里 3 人顶在 200 字，6126bf05 的「不碰 dashboard.css」只剩 `dashbo`，
   * d8e86630 的 `/api/persona/prompt` 整条边界消失。
   * 现在两件事分开：**散文存全**（超长**报错**而不是截），**机器读的边界走 paths/excludes**。
   * 显示侧要短，就由显示侧去截（directionHint）—— 存储不许替人做这个决定。
   */
  async function setSelfDescription(roomId, sessionId, text, { paths = null, excludes = null, watch = null } = {}) {
    const member = members(roomId).find((m) => m.sessionId === sessionId)
    if (member === undefined) return null
    const full = String(text === undefined || text === null ? '' : text).trim()
    if (full.length > DIRECTION_MAX_CHARS) {
      throw new Error('方向太长（' + full.length + ' 字 > ' + DIRECTION_MAX_CHARS + '）——'
        + '边界请用 paths 交给机器读，散文只留要点')
    }
    const p = cleanPathList(paths, 'paths')
    const x = cleanPathList(excludes, 'excludes')
    if (watch !== null && watch !== undefined && watch !== 'all' && watch !== 'none' && watch !== 'quiet'
      && watch !== 'feed' && watch !== 'wake') {
      throw new Error('watch 只能是 "all"（全推 + 每条变更都唤醒 + 必回）/ "wake"（全推 + 叫醒，但**不必回**）/ '
        + '"feed"（全推、不叫醒、不必回）/ "quiet"（默认：只推 @ 你 与人的发言）/ "none"（连变更推送也不要），收到 '
        + JSON.stringify(watch))
    }
    member.selfDescription = full
    // 显式给了才动（`paths: []` = 清空；不传 = 保留上一次的）
    if (paths !== null && paths !== undefined) member.paths = p
    if (excludes !== null && excludes !== undefined) member.excludes = x
    // **收录范围**（真机 #1714 + 用户 2026-09-16 的决定）：它与"有没有领地"是**两个问题**，
    // 旧模型把它们当成一根轴，于是只读席位只能二选一：编一条假领地，或吃下全量推送。
    //   all   = 全推（观察者/审计席）+ 每条变更都唤醒 + **登记回执义务**
    //   wake  = 全推 + 叫醒，但**不登记义务**（唤醒席：醒过来看一眼，看完不必写话，真机 #1920）
    //   feed  = 全推，但**不叫醒**（只收不答席：看得见，不必每条都应一声，真机 #1798）
    //   quiet = **默认**：只推「@ 你」与「人的发言」，其余走「拉」
    //   none  = 同 quiet，且连变更推送也不要
    // 三根轴才是完整的：(推不推) × (叫不叫醒) × (要不要回)，八个角里真正有意义的四个 ——
    //   all=(推,醒,回) / wake=(推,醒,不回) / feed=(推,不醒,不回) / quiet=none=(不推,…)。
    //   「不推却叫醒」与「不推却要回」都不成立，「推+不醒+要回」也不成立（没告诉它，凭什么要它回）。
    if (watch !== null && watch !== undefined) member.watch = watch
    await persist()
    return member
  }

  // ---- 消息 ---------------------------------------------------------------

  function lastSeq(roomId) {
    const list = state.messages.filter((m) => m.roomId === roomId)
    return list.length === 0 ? 0 : list[list.length - 1].seq
  }

  /**
   * **作者撤回**自己某条消息产生的义务（真机 #2131③）。
   *
   * 为什么需要它：房间已经有「**作者说了不用回就不用回**」——但现有两个机制（`wake=false` 与正文里的
   * 「不需要回应」标记）都只在**发送时**抑制。义务一旦登记，事后没有任何机器动作能销掉它，
   * 目标只能白花一轮去 judge 一条早就作废的消息（6588d7f6 这次就是这么花的）。
   * 「表态是终端的」说的是**只有目标能替自己表态**，不是「义务不可撤回」——撤回权在**作者**手里。
   *
   * 只认作者本人；撤回后 `obligors()` 恒返回空 ⇒ 那条从 pending / 旧账 / 投递里一并消失。
   * 幂等：重复撤回返回 already=true，不报错。
   */
  async function retract(roomId, seq, sessionId) {
    const message = state.messages.find((m) => m.roomId === roomId && Number(m.seq) === Number(seq))
    if (message === undefined) return { ok: false, reason: 'no-such-message' }
    const author = message.sender && typeof message.sender.sessionId === 'string' ? message.sender.sessionId : null
    if (author === null || author !== sessionId) return { ok: false, reason: 'not-author' }
    if (message.retracted === true) return { ok: true, already: true, seq: message.seq }
    // 撤回前先记下账上还有谁欠它 —— 返回值要能回答「这一下销掉了什么」，否则没法自诊。
    const cleared = obligors(roomId, message.seq).map((m) => m.sessionId)
    message.retracted = true
    await persist()
    return { ok: true, already: false, seq: message.seq, cleared }
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
    // 写之前体检（**在任何 mutation 之前**）：坏数据不进 state，也就不可能留在盘上。
    assertMessageAppend(state, message)
    state.messages.push(message)
    // 这条入口**已经**被逐点断言挡在前面（错得更早、上下文更好），所以整状态体检跳过 —— 省下每次写入的那 50ms
    await persist({ skipStateCheck: true })
    return message
  }

  /** 一条消息产生义务的成员（D5：只有非终端、且类别在 OBLIGATING_KINDS 里）。 */
  function obligors(roomId, seq) {
    const message = state.messages.find((m) => m.roomId === roomId && m.seq === seq)
    if (message === undefined) return []
    // **作者撤回**（真机 #2131③）：撤回之后这条不再向任何人要回执 ——
    // pending / 旧账 / 投递三处都是从这里取名单的，所以一处即全线生效。
    if (message.retracted === true) return []
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
    assertJudgment(state, judgment)
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

  /**
   * 房间里**当前还没被回执消掉**的全部义务（按 seq 升序）。{ seq, sessionId, ts }
   *
   * 为什么需要它（真机 #1348）：`latestObligatingSeq` 只回答「**最新**那条要谁回」，
   * 而义务是会积压的 —— 一条更晚的、@ 了别人的消息会把靶子挪走，
   * 于是「谁还欠着 #1236」在 room_status 与面板里**同时消失**，
   * 两个人只能各自推理「已读停在 N」算不算 N（真机 #1279 的交叉推理、#1268 的
   * 「谁 @ 了我、要我对哪个 seq 表态，把 seq 告诉我」）。
   *
   * 这是**只读视图**，不改义务模型：谁欠谁仍由 obligors() 独家判定。
   * 唯一的自造逻辑是预筛 —— 而且只排除「obligors 必然返回空」的消息，
   * 免得这里长成第二套真相（判据漂移的典型：两处都"看起来对"）。
   */
  function openObligations(roomId) {
    const out = []
    for (const m of state.messages) {
      if (m.roomId !== roomId) continue
      if (m.terminal === true || m.budgetStopped === true) continue
      if (!OBLIGATING_KINDS.has(m.kind) && !Array.isArray(m.mentions)) continue
      for (const member of obligors(roomId, m.seq)) {
        out.push({ seq: m.seq, sessionId: member.sessionId, ts: m.ts })
      }
    }
    return out
  }

  /** 某人当前欠的 seq（升序）；不传 sessionId 给 Map<sessionId, seq[]>。 */
  function owedSeqs(roomId, sessionId = null) {
    const map = new Map()
    for (const o of openObligations(roomId)) {
      const list = map.get(o.sessionId)
      if (list === undefined) map.set(o.sessionId, [o.seq])
      else list.push(o.seq)
    }
    return sessionId === null ? map : (map.get(sessionId) || [])
  }

  /**
   * 逾期提醒的**候选**（纯读，不投递、不写状态）。判据全部来自已经存在的原语：
   * openObligations 说"谁欠哪一条、什么时候开始的"，成员表说"这个人选了什么档"。
   * 冷却/次数上限都在这层，投递层只管发 —— 这样"追了几次"是个可断言的事实，不是副作用。
   */
  function reminderTargets(at = now(), opts = {}) {
    const cooldownMs = opts.cooldownMs === undefined ? REMIND_COOLDOWN_MS : opts.cooldownMs
    const max = opts.max === undefined ? REMIND_MAX : opts.max
    const overdueMinutes = opts.overdueMinutes === undefined ? DEFAULT_OVERDUE_MINUTES : opts.overdueMinutes
    const out = []
    for (const room of state.rooms) {
      if (room.enabled === false) continue
      const rows = members(room.id)
      for (const o of openObligations(room.id)) {
        if (at - o.ts <= overdueMinutes * 60000) continue
        const member = rows.find((m) => m.sessionId === o.sessionId)
        if (member === undefined || member.enabled === false) continue
        // 这两档是**本人声明的**"别叫醒我"：追它们等于把用户的档位设置当摆设。
        if (member.watch === 'feed' || member.watch === 'none') continue
        const rec = state.reminders.find(
          (r) => r.roomId === room.id && r.sessionId === o.sessionId && r.seq === o.seq,
        )
        const count = rec === undefined ? 0 : rec.count
        if (count >= max) continue
        if (rec !== undefined && at - rec.at < cooldownMs) continue
        out.push({ roomId: room.id, sessionId: o.sessionId, seq: o.seq, ageMs: at - o.ts, count })
      }
    }
    return out
  }

  /** 记一次提醒。**先发后记**的调用方要注意：这一层只负责"记下来"，不保证送达。 */
  function markReminded(roomId, sessionId, seq, at = now()) {
    const rec = state.reminders.find((r) => r.roomId === roomId && r.sessionId === sessionId && r.seq === seq)
    if (rec === undefined) {
      state.reminders.push({ roomId, sessionId, seq, at, count: 1 })
      return 1
    }
    rec.at = at
    rec.count = (rec.count || 0) + 1
    return rec.count
  }

  /**
   * 记一次**投递失败**（提醒送不出去）。刻意**不动** `count`/`at`：
   *  · 「不记账」的原意是"没被打扰到就不该消耗冷却"，所以失败要继续每轮重试；
   *  · 但失败**必须可见** —— 审计席 2026-09-25 指出的缺口：失败路径只有一条 debug，
   *    系统性失败（对方长期不在、resume 一直失败）在房间与面板上**完全不出现**，而面板正是 owner 看的那一面。
   */
  function noteRemindFailure(roomId, sessionId, seq, at = now()) {
    const rec = state.reminders.find((r) => r.roomId === roomId && r.sessionId === sessionId && r.seq === seq)
    if (rec === undefined) {
      state.reminders.push({ roomId, sessionId, seq, at: 0, count: 0, fails: 1, lastFailAt: at })
      return 1
    }
    rec.fails = (rec.fails || 0) + 1
    rec.lastFailAt = at
    return rec.fails
  }

  /** 某人在某房间**送不出去**的提醒次数（只读，给 room_status / 面板用）。 */
  function remindFails(roomId, sessionId) {
    let n = 0
    for (const r of state.reminders) {
      if (r.roomId === roomId && r.sessionId === sessionId) n += r.fails || 0
    }
    return n
  }

  /** 某人在某房间被自动提醒过几次（只读，给 room_status / 面板用）。 */
  function remindedCount(roomId, sessionId) {
    let n = 0
    for (const r of state.reminders) {
      if (r.roomId === roomId && r.sessionId === sessionId) n += r.count || 0
    }
    return n
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
    // 「欠一次表态」必须说清**是哪一条**（真机 #1348）：target 只是最新那条，
    // 义务却会积压 —— 只看靶子的人拿不到自己真正欠的那条 seq。
    const openBy = new Map()
    for (const o of openObligations(roomId)) {
      let entry = openBy.get(o.sessionId)
      if (entry === undefined) {
        entry = { seqs: [], overdueSeqs: [] }
        openBy.set(o.sessionId, entry)
      }
      entry.seqs.push(o.seq)
      if (now() - o.ts > overdueMinutes * 60000) entry.overdueSeqs.push(o.seq)
    }
    const openOf = (id) => openBy.get(id) || { seqs: [], overdueSeqs: [] }
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
        // 机器可读的边界（面板/room_status/room_owners 都要用）。只增字段，不改旧字段语义。
        paths: Array.isArray(m.paths) ? m.paths.slice() : [],
        excludes: Array.isArray(m.excludes) ? m.excludes.slice() : [],
        // 'all' | 'wake' | 'feed' | 'quiet' | 'none' | null —— 收录范围那一根轴（与"有没有领地"正交，见 setSelfDescription）
        // null 就是"没声明"，行为上等同 quiet（2026-09-16 用户定的默认）。
        watch: m.watch === 'all' || m.watch === 'none' || m.watch === 'quiet' || m.watch === 'feed' || m.watch === 'wake' ? m.watch : null,
        // 这个人当前欠的全部 seq（不只是靶子上那条）；空数组 = 什么都不欠。
        // **升序**（最老在前）—— 这是契约，不是巧合：渲染端（room_status / 面板）按 own[0] 当"这个人最老的那条"。
        // 目前它由 openObligations 按 state.messages 顺序生成而天然成立；这里显式排一次，
        // 免得哪天上游改了迭代顺序、而下游的"最老"悄悄变成另一条（2026-09-25 从靶子口径改成按人口径时钉的）。
        owedSeqs: openOf(m.sessionId).seqs.slice().sort((a, b) => a - b),
        overdueSeqs: openOf(m.sessionId).overdueSeqs,
        owed: owed.includes(m.sessionId) && !doneIds.has(m.sessionId),
        // 逾时的判据从「靶子老了」放宽成「它欠的任意一条老了」——
        // 欠着两天前那条、却因为靶子很新而显示「未逾时」，正是 #1348 里查不出来的那种。
        overdue: (owed.includes(m.sessionId) && !doneIds.has(m.sessionId) && overdue)
          || openOf(m.sessionId).overdueSeqs.length > 0,
        verdict: (done.find((j) => j.sessionId === m.sessionId) || {}).verdict || null,
        // 被**自动提醒**过几次（"追"的可见性）：没有它，机器人就是在暗处敲人。
        reminded: remindedCount(room.id, m.sessionId),
        // 送不出去的提醒次数（失败要可见 —— 不能只活在 debug 里）。
        remindFails: remindFails(room.id, m.sessionId),
      })),
      pending: owed.filter((id) => !doneIds.has(id)),
      // 待表态的**明细**（谁 · 欠哪几条）。pending 是「靶子上还欠谁」——投递层与旧面板读它，
      // 形状不动；新增的这一份是给人/agent 看的「欠的是哪一条」。
      pendingDetail: [...openBy.entries()].map(([sessionId, v]) => ({
        sessionId,
        shortId: shortId(sessionId),
        seqs: v.seqs,
        overdueSeqs: v.overdueSeqs,
      })),
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

  // ---- 投递台账（借自 DSH agent-team 的 durable mailbox：投递 · 确认 · 恢复）----
  //
  // 为什么需要它：以前一条消息**只投一次**（fanout 当场 best-effort），投失败就永远丢了 ——
  // 义务还挂在房间里（room_status 看得见「欠」），但那个成员**永远不会知道**有人叫过它。
  // agent-team 把这件事拆成三段（它的原话：the guarantee is retry plus de-duplication），
  // 这里照抄这三段，只做**进程内**那一版（它自己也只承诺进程内，不做跨进程共识）。
  //
  // 热路径纪律：fanout 对**每个成员**都要记一笔，而整份 rooms.json 真机已经 7.8 MB ——
  // 所以 record/mark/fail **只改内存**，由调用方在循环之后 persist 一次；
  // ack 是低频（人真的到房间里来才会发生），它自己 persist。
  function deliveryOf(roomId, sessionId, seq) {
    return state.deliveries.find((x) => x.roomId === roomId && x.sessionId === sessionId && x.seq === seq)
  }

  /** 记一笔「这条要投给这个人」。**幂等**：重投、冷唤醒、重判都可能再来一次。 */
  function recordDelivery(roomId, sessionId, seq) {
    let d = deliveryOf(roomId, sessionId, seq)
    if (d === undefined) {
      d = { roomId, sessionId, seq, at: now(), deliveredAt: null, attempts: 0 }
      state.deliveries.push(d)
    }
    return d
  }

  /** 投出去了 —— **不代表对方看过**（帧进了它的 next-turn 队列而已）。 */
  function markDelivered(roomId, sessionId, seq) {
    const d = deliveryOf(roomId, sessionId, seq)
    if (d === undefined) return null
    if (d.deliveredAt === null) d.deliveredAt = now()
    return d
  }

  /** 这一投失败了（拿不到 agent / 抛错）：attempts+1，留给下一次补投。 */
  function failDelivery(roomId, sessionId, seq) {
    const d = deliveryOf(roomId, sessionId, seq)
    if (d === undefined) return null
    d.attempts = (d.attempts || 0) + 1
    return d
  }

  /**
   * 这个人确认到 upToSeq：把 ≤ 它的台账删掉，返回删了几条。
   *
   * 「确认」的判据是**它自己动了房间工具**（表态 / 拉消息 / 看状态）——那时它确实到了房间里。
   * 光"投出去了"不算：投出去的是帧，对方可能根本没起来（真机 #4111 那次就是"插件以为成功、收件人整条被拒"）。
   */
  async function ackDelivery(roomId, sessionId, upToSeq) {
    const before = state.deliveries.length
    state.deliveries = state.deliveries.filter(
      (x) => !(x.roomId === roomId && x.sessionId === sessionId && x.seq <= upToSeq),
    )
    const removed = before - state.deliveries.length
    if (removed > 0) await persist()
    return removed
  }

  /** 还没确认的投递（可按人过滤），按 seq 升序。 */
  function pendingDeliveries(roomId, sessionId = null) {
    return state.deliveries
      .filter((x) => x.roomId === roomId && (sessionId === null || x.sessionId === sessionId))
      .slice()
      .sort((a, b) => a.seq - b.seq)
  }

  // ---- 任务板（借自 agent-team 的 shared task DAG）----------------------------
  //
  // 房间以前只有「谁改了什么」（changes）与「谁欠谁」（obligations），没有**分工**：
  // 这件事归谁、依赖谁、预期动哪些文件。最后一件尤其值 —— 有了 expectPaths，
  // 越界就能从**事后**（改完才 ⚠）提前到**事前**（认领任务的那一刻就看得见会碰谁的地盘）。

  const TASK_STATUSES = ['open', 'claimed', 'done', 'dropped']

  function tasksFor(roomId) {
    return state.tasks.filter((t) => t.roomId === roomId)
  }

  function getTask(taskId) {
    return state.tasks.find((t) => t.id === taskId) || null
  }

  /** 从 from 出发能不能走到 target —— 依赖成环检测用。 */
  function taskReaches(from, target, seen = new Set()) {
    if (from === target) return true
    if (seen.has(from)) return false
    seen.add(from)
    const t = state.tasks.find((x) => x.id === from)
    if (t === undefined) return false
    for (const d of (t.deps || [])) if (taskReaches(d, target, seen)) return true
    return false
  }

  /** 依赖必须是同房间内**已存在**的任务，且**不许成环** —— 互相等就是死锁。 */
  function checkDeps(roomId, selfId, deps) {
    const list = Array.isArray(deps) ? deps.map(String) : []
    for (const d of list) {
      if (selfId !== null && d === selfId) throw new Error('任务不能依赖自己: ' + selfId)
      const t = getTask(d)
      if (t === null) throw new Error('依赖的任务不存在: ' + d)
      if (t.roomId !== roomId) throw new Error('依赖的任务不在这个房间: ' + d)
      if (selfId !== null && taskReaches(d, selfId)) throw new Error('依赖成环: ' + selfId + ' ← ' + d)
    }
    return list
  }

  function assertMemberOf(roomId, sessionId, label) {
    if (!members(roomId).some((m) => m.sessionId === sessionId)) {
      throw new Error(label + '不是这个房间的成员: ' + shortId(sessionId))
    }
  }

  async function createTask({ roomId, title, owner = null, deps = [], expectPaths = [], createdBy = null, note = '' }) {
    if (getRoom(roomId) === null) throw new Error('room not found: ' + roomId)
    const text = String(title === undefined || title === null ? '' : title).trim()
    if (text === '') throw new Error('任务必须有标题')
    if (owner !== null) assertMemberOf(roomId, String(owner), '负责人')
    const task = {
      id: 'task-' + (state.nextTaskId++),
      roomId,
      title: text,
      status: owner === null ? 'open' : 'claimed',
      owner: owner === null ? null : String(owner),
      deps: checkDeps(roomId, null, deps),
      expectPaths: cleanPathList(expectPaths, '任务的 expectPaths'),
      createdBy: createdBy === null ? null : String(createdBy),
      createdAt: now(),
      updatedAt: now(),
      ...(note === '' ? {} : { note: String(note) }),
    }
    assertTaskWrite(state, task)
    state.tasks.push(task)
    await persist({ skipStateCheck: true })
    return task
  }

  async function claimTask(taskId, sessionId) {
    const t = getTask(taskId)
    if (t === null) throw new Error('任务不存在: ' + taskId)
    assertMemberOf(t.roomId, sessionId, '认领人')
    if (t.owner !== null && t.owner !== sessionId) throw new Error('任务已被 ' + shortId(t.owner) + ' 认领: ' + taskId)
    t.owner = sessionId
    if (t.status === 'open') t.status = 'claimed'
    t.updatedAt = now()
    await persist()
    return t
  }

  /**
   * 改任务。**先造一份候选、全部校验通过才提交** —— 这正是这次从 agent-team 借的
   * "candidate events replayed before append"（它的 src/invariant.ts）。
   * 反面例子是校验失败时已经改掉了一半：调用方拿到"失败"，而状态里那条任务其实被改了。
   */
  async function updateTask(taskId, patch = {}) {
    const t = getTask(taskId)
    if (t === null) throw new Error('任务不存在: ' + taskId)
    const next = { ...t }
    if (patch.title !== undefined) {
      const x = String(patch.title).trim()
      if (x === '') throw new Error('任务标题不能为空')
      next.title = x
    }
    if (patch.status !== undefined) {
      const s = String(patch.status)
      if (!TASK_STATUSES.includes(s)) throw new Error('未知状态: ' + s + '（只能是 ' + TASK_STATUSES.join('/') + '）')
      next.status = s
    }
    if (patch.owner !== undefined) {
      if (patch.owner === null) {
        next.owner = null
      } else {
        assertMemberOf(t.roomId, String(patch.owner), '负责人')
        next.owner = String(patch.owner)
      }
    }
    if (patch.deps !== undefined) next.deps = checkDeps(t.roomId, t.id, patch.deps)
    if (patch.expectPaths !== undefined) next.expectPaths = cleanPathList(patch.expectPaths, '任务的 expectPaths')
    if (patch.note !== undefined) {
      const n = String(patch.note)
      if (n === '') delete next.note
      else next.note = n
    }
    next.updatedAt = now()
    // 到这一步才动内存：上面任何一条抛了，state 里那条任务原样不动
    assertTaskWrite(state, next)
    Object.assign(t, next)
    // note 被清空时要真的把键删掉（lossless JSON：空串与"没有这个键"是两回事）
    if (next.note === undefined) delete t.note
    await persist({ skipStateCheck: true })
    return t
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
    retract,
    judgedBy,
    openObligations,
    owedSeqs,
    cursorOf,
    markRead,
    deltaFor,
    judge,
    recordDelivery,
    markDelivered,
    failDelivery,
    ackDelivery,
    pendingDeliveries,
    tasksFor,
    getTask,
    createTask,
    claimTask,
    updateTask,
    status,
    reminderTargets,
    markReminded,
    remindedCount,
    noteRemindFailure,
    remindFails,
    latestObligatingSeq,
    lastSeq,
    get state() { return state },
  }
}
