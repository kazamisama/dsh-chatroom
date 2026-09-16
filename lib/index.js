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
 * 一处刻意的设计偏离（相对 BLUEPRINT D7，已记为 D7a）：
 *   source 实装为 { kind: 'plugin', plugin: 'dsh-chatroom', form: 'relay',
 *   senderSessionId, roomId }，而不是自定义 kind 'chatroom' —— 浏览器半侧渲染器
 *   只认已声明形态，自定义 kind 会掉进 OpaqueBody 分支，丢掉「来自会话 X」。
 */
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createChatroomStore, shortId, parseMentions, parseMentionsScoped, detectOverreach, VERDICTS,
  memberOwnership, matchesOwnedPath, DIRECTION_MAX_CHARS,
} from './rooms.js'
import { verifyDeclaration, describeVerification, resolveWorktree, VERIFIED } from './gitcheck.js'

/** 稳定 Cordis 插件名。 */
const name = 'dsh-chatroom'
/** 硬依赖：没有工具面，这个插件没有意义。其余服务走 ctx.get 软取。 */
const inject = ['tools']
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
/** 投递来源：复用 relay 形态，让浏览器半侧渲染出「来自会话 X」。 */
const SOURCE_PLUGIN = 'dsh-chatroom'

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
  return parts.length === 0 ? '' : '（' + parts.join('；') + '）'
}

/** 一串路径 token 的紧凑写法（给 room_status / room_owners 用）。 */
function listTokens(list, max = 3) {
  const arr = Array.isArray(list) ? list : []
  return arr.slice(0, max).join(' ') + (arr.length > max ? ' …共 ' + arr.length + ' 条' : '')
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
            const st = await fs.stat(dir)
            if (!st.isDirectory()) continue
            let mtimeMs = st.mtimeMs
            let createdAt = st.birthtimeMs || st.ctimeMs || 0
            let bytes = 0
            let biggest = ''
            for (const candidate of ['session.jsonl.zstd', 'session.jsonl', 'session.v3.jsonl.zstd']) {
              try {
                const full = path.join(dir, candidate)
                const fst = await fs.stat(full)
                mtimeMs = Math.max(mtimeMs, fst.mtimeMs)
                if (fst.birthtimeMs > 0) createdAt = createdAt === 0 ? fst.birthtimeMs : Math.min(createdAt, fst.birthtimeMs)
                if (fst.size >= bytes) { bytes = fst.size; biggest = full }
              } catch (err) { /* 换下一个候选名 */ }
            }
            // **空会话**（建了没用过）不进候选：DSH 自己的侧栏也不显示它们
            // （投影缓存里那个 sessionListMetadata.blank 就是干这个的），数量必须一致。
            // 判定不能只看"文件为 0 字节"：真机上那种会话的日志是 337 字节 —— 只有一行
            // session 头，没有任何会话记录。所以小文件解压数一下记录数；大文件必然是"有内容"，
            // 不解压，代价可以忽略。
            let blank = bytes === 0
            if (!blank && bytes < 64 * 1024 && biggest !== '') {
              try {
                const raw = await fs.readFile(biggest)
                // zstd 解压是 Node 22.15+/23+ 才有的 API：没有就按"不空"处理（宁可多给）
                const unzstd = typeof zlib.zstdDecompressSync === 'function'
                const text = biggest.endsWith('.zstd')
                  ? (unzstd ? zlib.zstdDecompressSync(raw).toString('utf8') : '')
                  : raw.toString('utf8')
                if (text !== '') blank = text.split('\n').filter((line) => line.trim() !== '').length <= 1
              } catch (err) { blank = false }
            }
            map.set(name, { wsDir: wsDirName, lastActivityAt: mtimeMs, createdAt, blank })
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

  /** 每个成员的工作区（活 Agent 优先，其次投影缓存）。确定性匹配要用。 */
  async function memberWorkspaceMap(roomId) {
    const map = new Map()
    const projection = await projectionIndex()
    for (const m of store.activeMembers(roomId)) {
      const live = agents === undefined ? undefined : agents.get(m.sessionId)
      const cwd = (live && live.session && live.session.header && live.session.header.cwd)
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
      if (m.watch === 'none') {
        row.reason = '静音席位（watch=none）：不收变更唤醒（被 @ 时仍会叫到）'
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
        const crossWsOk = sameWs || (resolved !== '' && await fileExistsIn(resolved, hits[0].file))
        if (crossWsOk) {
          row.wouldWake = true
          row.reason = '命中' + (own.structured ? '结构化边界' : '散文方向')
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
        row.reason = '没给结构化边界，也取不到它的工作区 → 不叫（让它补 room_intent 的 paths）'
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

  async function relatedMemberIds(roomId, declarerId, workspace, files) {
    const rows = await ownershipLookup(roomId, workspace, files)
    const out = rows.filter((r) => r.wouldWake && r.sessionId !== declarerId).map((r) => r.sessionId)
    debug('确定性匹配: ' + out.length + '/' + rows.length + ' 名成员会被唤醒')
    return out
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

  /**
   * 把一条房间消息投递给某个成员。
   * @param mode 'followup' 产生义务、会唤醒（BLUEPRINT §7 第一行）
   *             'inject'   只是背景上下文、不唤醒、不产生义务
   */
  async function deliver(sessionId, message, { mode = 'followup', extra = '' } = {}) {
    const agent = await agentFor(sessionId)
    if (agent === null) return false
    // 只放真实存在的字段：人的发言没有 senderSessionId，就不要放这个键。
    const source = { kind: 'plugin', plugin: SOURCE_PLUGIN, form: 'relay', roomId: message.roomId }
    const author = message.sender && typeof message.sender.sessionId === 'string' ? message.sender.sessionId : null
    if (author !== null) source.senderSessionId = author
    const userMessage = createUserMessage({
      content: [{ type: 'text', text: frame(message.room || { name: '?' }, message, extra) }],
      source,
    })
    try {
      if (mode === 'inject') agent.inject(userMessage)
      else if (mode === 'steer') agent.steer(userMessage)
      else agent.followup(userMessage)
      return true
    } catch (err) {
      // 吞掉原因是不可诊断的：这里必须留下证据。
      debug('deliver: ' + mode + ' 投递失败 ' + shortId(sessionId) + ' -> '
        + (err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err)))
      return false
    }
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
      : (member.watch === 'none' ? '（静音席位：不收变更唤醒）' : '')
    return ' ｜ ' + stamp + text + bound + watchNote + '（若这次动作越出这个范围，请在回执里说明）'
  }

  /**
   * 一条消息产生义务后，逐人投递。
   * BLUEPRINT D5：只有「人的发言 / @ 提及」走到这里；回执（terminal）永远走不到。
   */
  async function fanout(roomId, seq) {
    const room = store.getRoom(roomId)
    if (room === null) return []
    const message = store.state.messages.find((m) => m.roomId === roomId && m.seq === seq)
    if (message === undefined) return []
    const obligors = store.obligors(roomId, seq)
    const obligated = new Set(obligors.map((m) => m.sessionId))
    const mentioned = new Set(Array.isArray(message.mentions) ? message.mentions : [])
    const author = message.sender && message.sender.sessionId ? message.sender.sessionId : null
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
    // 非义务成员走背景通道：看得到，但不被打扰（BLUEPRINT §2.2）
    // 不回声给发送者自己 —— 它当然知道自己说了什么。
    // **也不回声给已经表过态的人**：表态是终端的（D5），同一条消息不该再送一次
    // （#55 报的「投递层不查已表态」；obligors 那边已经排除，背景通道这里也要排）。
    const alreadyJudged = new Set(store.judgedBy(roomId, seq))
    for (const member of store.activeMembers(roomId)) {
      if (obligated.has(member.sessionId)) continue
      if (alreadyJudged.has(member.sessionId)) continue
      if (author !== null && member.sessionId === author) continue
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

  disposers.push(tools.register({
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
      const rooms = store.listRooms()
      if (rooms.length === 0) return { text: '还没有任何聊天室。' }
      const wanted = args.room === undefined ? null : String(args.room)
      const picked = wanted === null ? rooms : rooms.filter((r) => r.id === wanted || r.name === wanted)
      if (picked.length === 0) return { text: '找不到房间：' + wanted }
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
          } else if (m.watch === 'none') {
            boundText = '  · 静音席位（不收变更唤醒）'
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

  disposers.push(tools.register({
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
    execute: async (args) => {
      await ready
      const room = resolveRoom(args.room)
      if (room === null) return { seq: 0, text: '找不到房间：' + args.room }
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
      return { seq: pool[pool.length - 1].seq, text: lines.join('\n') }
    },
  }))

  disposers.push(tools.register({
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
      const message = await store.appendMessage({
        roomId: room.id,
        sender: { sessionId, roleName: roleNameOf(room.id, sessionId) },
        kind: 'free',
        body: text,
        mentions: mentions.length > 0 ? mentions : null,
      })
      // **永远走 fanout**：有 @ 的那些人拿 followup（被唤醒、必须回），
      // 其余成员拿 inject（背景上下文，看得到但不被打扰）—— BLUEPRINT §2.2 的背景通道。
      // （早先"没 @ 就不投递"是错的：那样别人连背景都看不到。）
      const delivered = await fanout(room.id, message.seq)
      const woke = delivered.filter((d) => d.delivered).length
      return {
        seq: message.seq,
        text: '已发言 #' + message.seq
          + describeMentions({ kept: mentions, dropped: suppressed, byFlag, markedLines: scoped.markedLines, woke }),
      }
    },
  }))

  disposers.push(tools.register({
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
      const st = store.status(room.id, Number(args.seq))
      return {
        ok: true,
        text: '已表态 #' + args.seq + '：' + args.verdict
          + (st.pending.length > 0 ? '；还差 ' + st.pending.map(shortId).join(', ') : '；该条已全员表态'),
      }
    },
  }))

  disposers.push(tools.register({
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
      const declaredWorkspace = (exec && exec.agent && exec.agent.session && exec.agent.session.header
        && exec.agent.session.header.cwd) || ''

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
      const mark = describeVerification(check)
      debug('变更核验: ' + check.verdict + ' (' + check.reason + ') workspace=' + workspace
        + (resolved.fallback ? ' [回溯自声明文件；会话 cwd=' + declaredWorkspace + ']' : ''))

      // 2) 确定性匹配：谁可能相关（零 token）。只有他们会被叫醒表态。
      const related = await relatedMemberIds(room.id, sessionId, workspace, files)

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
      const overreach = detectOverreach(files, members, sessionId)
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

      // 定向义务 = 确定性匹配到的相关成员 ∪ 被越界点名的负责人
      const obliged = [...new Set([...related, ...overreach.map((h) => h.sessionId)])]
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

      const delivered = await fanout(room.id, message.seq)
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

  disposers.push(tools.register({
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

  disposers.push(tools.register({
    name: 'room_intent',
    description: '声明你当前负责的**设计方向与约束**。两件事分开：'
      + '`direction` 是散文，给人读；`paths`/`excludes` 是**机器读的边界**（glob/路径数组）——'
      + '**改了哪些文件会不会唤醒你、算不算越界，只看 paths**（没给 paths 时才退回去猜散文，而猜会误报）。'
      + '方向变了就再调一次覆盖。',
    parameters: {
      type: 'object',
      properties: {
        room: { type: 'string', description: '房间 id 或名称。' },
        direction: { type: 'string', description: '一句话说清你负责的方向（散文，给人读；上限 ' + DIRECTION_MAX_CHARS + ' 字，超了会报错而不是截断）。' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: '你负责的路径（机器读）。例：["ulysses/app.py", "ulysses/runtime/harness/**"]。'
            + '带 ** 或没有扩展名按目录前缀匹配，否则按文件后缀匹配。给了它，唤醒判定就不再猜散文。',
        },
        watch: {
          type: 'string',
          enum: ['all', 'none'],
          description: '收录范围（**与"有没有领地"是两件事**，只读/审计席位用这个，不要编一条假 paths）：'
            + 'all = 收全量变更、但不参与越界判定；none = 不收变更唤醒（被 @ 时仍会叫到）。不给则按 paths 判。',
        },
        excludes: {
          type: 'array',
          items: { type: 'string' },
          description: '你**明确不碰**的路径（机器读）。例：["dashboard.css"]。命中它的改动不会叫醒你、也不算越界。',
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
      const watch = updated.watch === 'all' || updated.watch === 'none' ? updated.watch : null
      // 收录范围说清了就不该再催它补 paths —— 观察者席位**故意**没有领地
      // （真机 #1714：工具曾对着审计席建议"补 paths 就能收敛"，那条建议对它是错的）。
      const scope = watch === 'all'
        ? '收录范围：**观察者席位**（收全量变更、不参与越界判定，不需要 paths）'
        : (watch === 'none'
          ? '收录范围：**静音席位**（不收变更唤醒；被 @ 时仍会叫到）'
          : (paths.length > 0
            ? '机器读的边界 ' + paths.length + ' 条：' + paths.join(' ')
            : '⚠ 你没给 paths —— 唤醒与越界判定只能去猜这段散文，会误报也会漏报（例：'
              + '方向里写「不进 X 依赖图」时，X 可能被当成你的地盘）。'
              + '若你本来就**不认领**任何路径（只读/审计席），改用 watch="all" 明确表达，别编一条假 paths。'))
      return {
        text: '方向已记录（共 ' + String(updated.selfDescription).length + ' 字，全文保存、不再截断）。'
          + scope
          + (paths.length > 0 && watch !== null ? '；另有边界 ' + paths.length + ' 条：' + paths.join(' ') : '')
          + (excludes.length > 0 ? '；明确不碰：' + excludes.join(' ') : ''),
      }
    },
  }))

  disposers.push(tools.register({
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
      const wake = rows.filter((r) => r.wouldWake && r.sessionId !== sessionId)
      const self = rows.filter((r) => r.wouldWake && r.sessionId === sessionId)
      const rest = rows.filter((r) => !r.wouldWake)
      if (self.length > 0) { /* 自己命中自己的边界不算被叫醒，下面单独说一句 */ }
      const lines = ['房间 ' + room.name + '：' + files.join('、')
        + (workspace === '' ? '（工作区未知）' : '（工作区 ' + path.basename(workspace) + '）')]
      lines.push('会唤醒（' + wake.length + ' 人，收到「必须回一句」的 followup）:')
      if (wake.length === 0) lines.push('  （没有 —— 这条改动不会叫醒任何人，只进背景通道）')
      for (const r of wake) {
        lines.push('  - [' + r.shortId + ']' + (r.roleName ? ' ' + r.roleName : '')
          + (r.sessionId === sessionId ? ' ← 就是你自己' : '')
          + ' —— ' + r.reason
          + (r.matched.length > 0 ? '：' + r.matched.map((m) => m.file + ' ↔ ' + m.token).join('，') : ''))
      }
      lines.push('不会被唤醒（' + rest.length + ' 人，仍然看得到这条声明）:')
      for (const r of rest) {
        lines.push('  - [' + r.shortId + ']' + (r.roleName ? ' ' + r.roleName : '')
          + ' —— ' + r.reason)
      }
      if (self.length > 0) {
        lines.push('（你自己：' + self[0].reason + ' —— 但自己声明不会叫醒自己，所以你不需要回执）')
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
        '- 想知道**某一条**说了什么、谁 @ 了谁、各人的回执正文：用 room_message(room, seq=…) ——',
        '  「他当时回了什么」是一次查询，不是一次打扰：重问一次 = 主动唤醒别人（真机 #1348/#1349 就是这么发生的）。',
        '- 要谁表态、要划边界，就在 room_say 里写 @短号 / @角色名 / @全体：被点到的人会被**主动唤醒**，且必须回一句判断。',
        '- 只是想「提到」某人、不要他回话：正文里写明「不需要回应」，或给 room_say 传 wake=false —— 那就只是背景投递，不登记义务（作者说了不用回，就不用回）。',
        '- **引述别人的话时用引号或代码块**（「」/`` ` ``/```）：引述里的 @ 不算提及 —— 否则「引述某条 ⚠ 行」会连带把被点名的人叫起来，讨论警告这个动作本身制造提及。自己也不会被自己 @ 到。',
        '- **不要写自己的短号**：自我提及不产生义务（作者不欠自己回执），写了也会被丢掉。',
        '- 你收到的唤醒帧可能**滞后**（投递时你正在忙，它会等到你下一轮才落地）：若房间里已显示你就那条表过态，忽略该帧即可。',
        '- 用 room_intent 声明你当前负责的设计方向与约束：**direction 给人读，paths 给机器读**。',
        '  唤醒谁、算不算越界只看 paths（不给就退回猜散文，会误报也会漏报）。**只读/审计席位不要编假 paths** ——',
        '  用 watch="all"（收全量变更、不参与越界判定）或 watch="none"（不收变更唤醒，被 @ 仍会叫到）。',
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

  // =======================================================================
  // 面板通道（loopback RPC）
  // =======================================================================

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
      members: st.members.map((m) => ({ ...m, title: titleCache.get(m.sessionId) || '' })),
      pending: st.pending,
      // 面板要显示「欠的是哪一条」：pending 只说人，pendingDetail 把 seq 一起带上（真机 #1348）。
      pendingDetail: st.pendingDetail,
      messages,
      judgments: st.judgments,
      changes: store.state.changes.filter((c) => c.roomId === roomId).slice(-50),
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
      const pending = store.state.changes
        .filter((c) => c.verdict === 'contradicted' || c.verdict === 'unverified')
        .slice(0, 20)
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
      for (const change of pending) {
        const anchorMs = starts.get(change.declaredBy)
        if (typeof anchorMs !== 'number' || anchorMs <= 0) continue // 拿不到锚点就不动它（宁可少判）
        // **重判也要走同一套仓库路由**（真机 2026-09-16，房间 #1454/#1458）：
        // 这里原来直接用 change.workspaceId —— 那个字段是**上一次核验时**的答案，于是
        // "交付物在旁仓"的声明在重判时仍然拿会话仓库去解析 ref ⇒ 永远重判不回来。
        // 与 room_declare_change 共用 resolveWorktree，两条路才不会各说各话。
        const resolved = await resolveWorktree({ workspace: change.workspaceId, files: change.files })
        const re = await verifyDeclaration({
          workspace: resolved.workspace,
          files: resolved.files,
          anchorMs,
          anchorLabel: '本次会话开始',
          // **必须带上原声明的 ref**（#623）：不带的话，一条「ref 无效」的判定会在下次启动
          // 重判时退回文件覆盖检查、被改回「已证实」—— 等于把刚堵上的洞在重判路径上又开一次。
          ref: typeof change.ref === 'string' && change.ref !== '' ? change.ref : null,
        })
        if (re.verdict !== VERIFIED) continue // 重判后仍然对不上 → 那是真的，保持原判
        const mark = describeVerification(re)
        // 「从什么改成什么」的**前者要在改之前读**（早先写成改完再读 change.verdict，
        // 被并发的那一次改掉之后就成了 "verified → 已证实" 这种胡话）。
        // 现在筛进来两类，所以它不再恒为 contradicted —— 更要先读后写。
        const from = change.verdict === 'unverified' ? '未证实' : 'contradicted'
        const note = '（判定基准修正后重判：' + from + ' → 已证实）'
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
        if (change.rejudgedAt === undefined || change.rejudgeFrom === 'contradicted') continue
        change.rejudgeFrom = 'contradicted'
        const message = store.state.messages.find((m) => m.seq === change.seq && m.roomId === change.roomId)
        if (message !== undefined && typeof message.body === 'string') {
          message.body = message.body.replace(/（判定基准修正后重判：[^）]*）/g, '（判定基准修正后重判：contradicted → 已证实）')
        }
        repaired++
      }
      if (fixed > 0 || repaired > 0) {
        await store.persist()
        debug('历史更正：' + fixed + ' 条误判已按新基准改为「已证实」'
          + (repaired > 0 ? '；另修正 ' + repaired + ' 条写坏的注记' : ''))
      }
      // 会话表拿到了 → 该判的都判过了，不用再来（拿不到就返回 done:false，稍后重试）
      return { done: starts.size > 0, fixed }
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
                  source: { kind: 'plugin', plugin: SOURCE_PLUGIN },
                }))
                info.followupMinimal = 'ok'
              } catch (err) {
                info.followupMinimal = 'threw: ' + (err && err.message ? err.message : String(err))
              }
              try {
                got.followup(createUserMessage({
                  content: [{ type: 'text', text: 'diagnose ping（relay source）' }],
                  source: {
                    kind: 'plugin',
                    plugin: SOURCE_PLUGIN,
                    form: 'relay',
                    senderSessionId: 'diagnose',
                    roomId: 'diagnose',
                  },
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
