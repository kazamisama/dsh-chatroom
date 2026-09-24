/**
 * dsh-chatroom —— 不变量（写之前的体检，纯函数）
 *
 * 为什么要独立成一个模块（机制从 DSH 0.1.7 agent-team 的 src/invariant.ts 借来）：
 * 本插件的状态是**整份 JSON 直接落盘**（lib/rooms.js 的 persist），写之前没有任何校验 ——
 * 一旦把「@ 一个不在房间里的人」或「依赖成环的任务」写进去，坏状态就**留在盘上**，
 * 之后只能靠人在 room_status 里看出来。这里把「候选事件先重放校验、再追加」单独做出来，
 * 于是坏状态**写不进去**，而不是写进去以后再靠人发现。
 *
 * 三条纪律（都不是风格问题）：
 *  1. **同步、不碰 IO**：它要站在 persist() 前面。异步或读盘会把「校验」变成第二个故障源 ——
 *     校验失败与写盘失败就分不清了，而这两种失败该有的反应完全不同。
 *  2. **不改传入对象**：调用方紧接着就要把同一个 message/task 对象 push 进 state；
 *     校验顺手「修正」字段（补默认值、夹取）等于把写入口偷偷改了形，而且没有任何提示。
 *     所以这里只**拒绝**，从不修补（与 setPolicy 拒绝 1.5 而不是 floor 成 1 是同一条纪律）。
 *  3. **抛 Error 且 err.code 以 'INVARIANT_' 开头**：调用方要能只凭 code 分辨
 *     「这是数据坏了」还是「这是 IO 失败了」。
 *
 * 为什么不 import lib/rooms.js 里的 MESSAGE_KINDS / VERDICTS：调用点就在 rooms.js 的写路径上，
 * 反向 import 会成环。这里自带一份常量，并由 tests/invariants.mjs 直接拿 rooms.js 的导出做
 * 等值断言来钉住漂移 —— 漂了就红，而不是靠人记得改两处。
 */

/** 消息类别（必须与 rooms.MESSAGE_KINDS 一致，见文件头）。 */
export const MESSAGE_KINDS = ['human', 'change-notice', 'judgment', 'free', 'system', 'alert']

/** 判断枚举（必须与 rooms.VERDICTS 一致）。 */
export const VERDICTS = ['unaffected', 'catch-up', 'retest', 'need-info']

/**
 * 任务状态。done / dropped 是终态。
 * 这里只校验**取值合法**，不管流转（谁能把 open 改成 done 是任务工具的事）——
 * 本模块拦的是「写进去本身就是坏数据」，不是「这次状态迁移合不合规」。
 */
export const TASK_STATUSES = ['open', 'claimed', 'done', 'dropped']

/** 状态对象的九张表（BLUEPRINT §9 数据模型 + 本次新增的 deliveries / tasks）。 */
const STATE_TABLES = ['rooms', 'members', 'messages', 'cursors', 'changes', 'judgments', 'baselines', 'deliveries', 'tasks']

// ---- 小工具（全部纯函数，不写任何东西）--------------------------------------

function isObj(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 值的可读描述。为什么每处报错都要带上它：只说「类型不对」，人还得自己回头去翻那个对象长什么样；
 * 把**收到的东西**直接印出来，一眼就能定位（真机上一半的往返成本都花在「到底收到的是什么」上）。
 */
function describe(value) {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined（字段缺失）'
  if (Array.isArray(value)) return '数组 [' + value.length + ' 项]'
  if (typeof value === 'string') return '字符串 ' + JSON.stringify(value.length > 40 ? value.slice(0, 40) + '…' : value)
  if (typeof value === 'object') {
    let text
    try { text = JSON.stringify(value) } catch { text = String(value) }
    if (typeof text !== 'string') text = String(value)
    return '对象 ' + (text.length > 80 ? text.slice(0, 80) + '…' : text)
  }
  return typeof value + ' ' + JSON.stringify(value)
}

function invariantError(code, message, problems) {
  const err = new Error(message)
  err.code = 'INVARIANT_' + code
  // 体检一次收齐所有问题时，清单挂在 err.problems 上（每条带自己的 code）——
  // 只把清单拼进 message 的话，调用方就没法按条分流了。
  if (problems !== undefined) err.problems = problems
  return err
}

function fail(code, message) {
  throw invariantError(code, message)
}

function assertStateObject(state) {
  if (!isObj(state)) {
    fail('STATE_SHAPE', 'state 必须是对象（rooms / members / messages 的容器），收到 ' + describe(state))
  }
}

function requireObj(value, where, code) {
  if (!isObj(value)) fail(code, where + ' 必须是对象，收到 ' + describe(value))
}

/**
 * 取一张表。**键缺失算空表，类型不对算坏数据**：本次新增的 deliveries / tasks 在旧落盘文件里
 * 没有键 —— 那是迁移中的空表；但 `tasks: {}` 或 `messages: "x"` 是真坏，
 * 当成空表放过就成了本项目反复踩的「看着成功、其实没生效」。
 */
function tableOf(state, key) {
  const list = state[key]
  if (list === undefined) return []
  if (!Array.isArray(list)) {
    fail('STATE_SHAPE', 'state.' + key + ' 必须是数组（键缺失可以，类型不对不行），收到 ' + describe(list))
  }
  return list
}

/** 房间里有没有这一行（不抛，只回答在不在）。 */
function hasRoom(state, roomId) {
  if (typeof roomId !== 'string' || roomId === '') return false
  return tableOf(state, 'rooms').some((r) => isObj(r) && r.id === roomId)
}

function findRoom(state, roomId, where) {
  if (typeof roomId !== 'string' || roomId === '') {
    fail('ROOM_ID_INVALID', where + ' 必须是房间 id 字符串，收到 ' + describe(roomId))
  }
  const rooms = tableOf(state, 'rooms')
  const room = rooms.find((r) => isObj(r) && r.id === roomId)
  if (room === undefined) {
    const known = rooms.filter((r) => isObj(r) && typeof r.id === 'string').map((r) => r.id)
    fail('ROOM_NOT_FOUND', where + ' 指向不存在的房间 ' + JSON.stringify(roomId)
      + '（已存在的房间：' + (known.length === 0 ? '一个都没有' : known.join(', ')) + '）')
  }
  return room
}

/**
 * 房间成员。enabledOnly=true 就是 rooms.js 的 activeMembers 口径（enabled !== false）——
 * 「关掉开关的人不在房间里」是这一屋子的基本约定：不产生义务，也不欠回执。
 */
function membersOf(state, roomId, enabledOnly) {
  return tableOf(state, 'members')
    .filter((m) => isObj(m) && m.roomId === roomId && (!enabledOnly || m.enabled !== false))
}

/** 报错时把「房间里到底有谁」带上：说某人不是成员时，人下一步一定是去查名单。 */
function memberHint(list) {
  if (list.length === 0) return '（该房间 enabled 的成员：一个都没有）'
  return '（该房间 enabled 的成员：' + list.map((m) => String(m.sessionId)).join(', ') + '）'
}

/** 房间里已有消息的最大 seq（只按数值看，坏行里的非整数 seq 直接不计入）。 */
function maxSeq(messages, roomId) {
  let max = 0
  for (const m of messages) {
    if (!isObj(m) || m.roomId !== roomId) continue
    const n = Number(m.seq)
    if (Number.isInteger(n) && n > max) max = n
  }
  return max
}

/**
 * 任务依赖图里找一个环，返回环上的 id 序列（如 ['t1','t2','t1']），无环返回 null。
 * 三色 DFS：只有**还在栈上**的节点才算环 —— 已访问完的（黑）不算。
 * 少了这一格，菱形依赖（两个任务依赖同一个前置）会被误判成环，把合法写入拦下来。
 */
function findTaskCycle(edges) {
  const mark = new Map()
  const stack = []
  let cycle = null
  const visit = (id) => {
    if (cycle !== null) return
    const seen = mark.get(id) || 0
    if (seen === 2) return
    if (seen === 1) {
      cycle = stack.slice(stack.indexOf(id)).concat(id)
      return
    }
    mark.set(id, 1)
    stack.push(id)
    for (const dep of edges.get(id) || []) {
      if (edges.has(dep)) visit(dep)
    }
    stack.pop()
    mark.set(id, 2)
  }
  for (const id of edges.keys()) {
    visit(id)
    if (cycle !== null) break
  }
  return cycle
}

// ---- 写入口的闸 -------------------------------------------------------------

/**
 * 校验「这条消息可以被追加进 state」。通过返回 true，不通过抛 INVARIANT_*。
 *
 * 为什么 seq 要在这里管：seq 是**所有**定位语义的主键 —— 已读游标（cursors.lastSeq）、
 * 回执（judgments.seq）、投递账（deliveries.seq）全都只按 (roomId, seq) 查。
 * 复用或回退一个 seq，等于把一条旧消息的义务接到另一条新消息的内容上，
 * 而两边看上去都正常（真机 #58 那一类「回执对不上」的根就在这里）。
 */
export function assertMessageAppend(state, message, index = null) {
  assertStateObject(state)
  requireObj(message, 'message', 'MESSAGE_SHAPE')

  const roomId = message.roomId
  // index.tolerant = **加载期那把尺**：只判形状与 seq，**不判资格**。
  // 两个理由都是真机上量出来的：
  //  · 房间可以被删掉而历史留着（removeRoom 只清 rooms/members）⇒ 孤儿消息不是坏数据；
  //  · **成员资格随时间变**（用户会把会话移出房间）⇒ 真机 room-8ckwxq0d 里 15 条消息的发送者
  //    今天已不是该房间成员，而它们写的时候都在。拿今天的名单去判当年的发言，是把历史判成坏数据。
  // 资格只在**写入口**判（那里判得准，也能给出发送方看得懂的错）。
  // orphanRooms 是**确实被删过的**房间 id 集合（由 store 在加载时从盘上推出来、运行时 removeRoom 再补）。
  // 只放行它们 —— 不传这个集合时（测试）退化成"任何查不到的房间都算历史"。
  const removed = index !== null && index.orphanRooms instanceof Set ? index.orphanRooms : null
  const tolerant = index !== null && index.tolerant === true
  const orphan = tolerant && !hasRoom(state, roomId) && (removed === null || removed.has(roomId))
  const lenient = tolerant
  if (!orphan) findRoom(state, roomId, 'message.roomId')

  if (!Number.isInteger(message.seq) || message.seq <= 0) {
    fail('SEQ_INVALID', 'message.seq 必须是正整数（房间 ' + roomId + '），收到 ' + describe(message.seq))
  }
  const messages = tableOf(state, 'messages')
  // 两条分支的区别只有一个事实：**候选是不是已经在表里**。
  //   在表里  ⇒ 这次调用是加载期体检（assertStateShape 逐行复用本函数）。
  //             那一行没有「比谁都大」可言 —— 同一个房间里除了最大的那条，其余每条都会被那条规则误伤，
  //             所以它只要求同房间内 seq 不重复。
  //   不在表里 ⇒ 真正的写入，要求严格大于该房间已有的最大 seq。
  if (messages.indexOf(message) >= 0) {
    // 每条都扫一遍全表 = **O(n²)**：真机 4674 条消息实测 473 ms（同一份 state 的 JSON.stringify 只要 25 ms）。
    // 加载期会传一个预建索引进来，这里退化成 O(1)；写入口不传（它是每次一次 O(n)，相对写入本身可忽略）。
    const key = roomId + '#' + String(message.seq)
    if (index !== null && index.seenSeqs instanceof Set) {
      if (index.seenSeqs.has(key)) {
        fail('SEQ_NOT_MONOTONIC', '房间 ' + roomId + ' 里有两条消息共用 seq = ' + message.seq
          + ' —— seq 是 (roomId, seq) 定位的主键，重复会让游标 / 回执 / 投递账随机命中其中一条')
      }
      index.seenSeqs.add(key)
    } else {
      const dup = messages.some((m) => m !== message && isObj(m) && m.roomId === roomId && Number(m.seq) === message.seq)
      if (dup) {
        fail('SEQ_NOT_MONOTONIC', '房间 ' + roomId + ' 里有两条消息共用 seq = ' + message.seq
          + ' —— seq 是 (roomId, seq) 定位的主键，重复会让游标 / 回执 / 投递账随机命中其中一条')
      }
    }
  } else {
    const max = maxSeq(messages, roomId)
    if (message.seq <= max) {
      fail('SEQ_NOT_MONOTONIC', 'message.seq 必须大于房间 ' + roomId + ' 已有的最大 seq，收到 ' + message.seq
        + '，而该房间最大 seq 已经是 ' + max + ' —— seq 只增、不复用：游标 / 回执 / 投递账全都按 (roomId, seq) 定位，'
        + '复用会把上一条消息的义务接到这一条上')
    }
  }

  if (!MESSAGE_KINDS.includes(message.kind)) {
    fail('KIND_INVALID', 'message.kind 必须是 ' + MESSAGE_KINDS.join(' / ') + ' 之一（房间 ' + roomId + '），收到 '
      + describe(message.kind))
  }

  const sender = message.sender
  if (!isObj(sender)) {
    fail('SENDER_SHAPE', 'message.sender 必须是 { sessionId } 或 { user: true } 之一（房间 ' + roomId + '），收到 '
      + describe(sender))
  }
  const hasSession = sender.sessionId !== undefined && sender.sessionId !== null
  const isUser = sender.user === true
  if (hasSession && isUser) {
    fail('SENDER_AMBIGUOUS', 'message.sender 同时给了 sessionId=' + JSON.stringify(sender.sessionId)
      + ' 与 user: true —— 一条消息只能有一个发送者：并存会让「作者是谁」有两个答案，'
      + '而自提及排除、作者撤回、投递对象都只按 sender.sessionId 取作者')
  }
  if (!hasSession && !isUser) {
    fail('SENDER_SHAPE', 'message.sender 既没有 sessionId 也没有 user: true（房间 ' + roomId + '），收到 ' + describe(sender)
      + ' —— 没有作者的消息谁都不欠它，也没有人能撤回它')
  }
  if (hasSession) {
    if (typeof sender.sessionId !== 'string' || sender.sessionId === '') {
      fail('SENDER_SHAPE', 'message.sender.sessionId 必须是非空字符串（房间 ' + roomId + '），收到 '
        + describe(sender.sessionId))
    }
    // 孤儿消息（房间已删）跳成员校验：成员是随房间一起删的，那时候谁在房间里已经无从查证，
    // 拿今天的名单去判当年的发言只会把历史判成坏数据。
    const live = (orphan || lenient) ? null : membersOf(state, roomId, true)
    if (live !== null && !live.some((m) => m.sessionId === sender.sessionId)) {
      fail('SENDER_NOT_MEMBER', 'message.sender.sessionId = ' + JSON.stringify(sender.sessionId)
        + ' 不是房间 ' + roomId + ' enabled 的成员' + memberHint(live) + ' —— 非成员的消息看上去是一条正常发言，'
        + '但它永远不会出现在任何回执名单里（静默坏）')
    }
  }

  if (message.mentions !== undefined && message.mentions !== null) {
    if (!Array.isArray(message.mentions)) {
      fail('MENTIONS_SHAPE', 'message.mentions 必须是数组（不写就不写，写了就得是数组；房间 ' + roomId + '），收到 '
        + describe(message.mentions))
    }
    // 只认完整 sessionId。本插件的写路径（parseMentions / parseMentionsScoped）产出的就是完整 id；
    // obligors 里对短号的那一格宽容是给**盘上旧行**读的，不是写入口的许可。
    const live = (orphan || lenient) ? null : membersOf(state, roomId, true)
    for (let i = 0; i < message.mentions.length; i++) {
      const id = message.mentions[i]
      if (typeof id !== 'string' || id === '') {
        fail('MENTIONS_SHAPE', 'message.mentions[' + i + '] 必须是非空字符串（房间 ' + roomId + '），收到 ' + describe(id))
      }
      if (live !== null && !live.some((m) => m.sessionId === id)) {
        fail('MENTION_NOT_MEMBER', 'message.mentions[' + i + '] = ' + JSON.stringify(id) + ' 不是房间 ' + roomId
          + ' enabled 的成员' + memberHint(live) + ' —— 给非成员登记义务是**静默**错误：那条「你必须回一句」'
          + '永远没有合法收件人，而发送方看到的是「发送成功」')
      }
    }
  }

  return true
}

/**
 * 校验「这条回执可以写进去」。
 *
 * 为什么 verdict 与 sessionId 也要在写前验：回执是**终端动作**（D5），它会销掉一条义务；
 * 一条指向不存在消息、或来自非成员的回执，什么也销不掉，却在房间日志里留下「有人表过态了」——
 * 欠它的人于是继续欠着，而所有人都以为这件事已经了结。
 */
export function assertJudgment(state, judgment, index = null) {
  assertStateObject(state)
  requireObj(judgment, 'judgment', 'JUDGMENT_SHAPE')

  // index.tolerant = 加载期那把尺：**只判形状，不判引用**。
  // 引用是**历史的**：房间会被删（room-demo01 那种）、消息来自更早的版本或被种子脚本写过，
  // 用今天的表去核当年的引用只会把历史判成坏数据（真机上最后剩下的 2 条都是这一类）。
  // 引用校验留在**写入口** —— 那里判得准，而且能给出调用方看得懂的错。
  const lenient = index !== null && index.tolerant === true
  const removed = index !== null && index.orphanRooms instanceof Set ? index.orphanRooms : null
  const roomId = judgment.roomId
  // 与消息同一条尺：查不到房间时，只有"确实被删过"的才当历史，别的照旧是坏数据
  if (!(lenient && !hasRoom(state, roomId) && (removed === null || removed.has(roomId)))) {
    findRoom(state, roomId, 'judgment.roomId')
  }

  if (!Number.isInteger(judgment.seq) || judgment.seq <= 0) {
    fail('SEQ_INVALID', 'judgment.seq 必须是正整数（房间 ' + roomId + '），收到 ' + describe(judgment.seq))
  }
  const messages = tableOf(state, 'messages')
  // Number() 而不是 ===：盘上可能有历史行把 seq 存成了字符串（retract 里也是这么比的）。
  const target = messages.find((m) => isObj(m) && m.roomId === roomId && Number(m.seq) === judgment.seq)
  if (!lenient && target === undefined) {
    fail('SEQ_NOT_FOUND', 'judgment.seq = ' + judgment.seq + ' 在房间 ' + roomId + ' 里没有对应的消息（该房间最大 seq '
      + maxSeq(messages, roomId) + '）—— 回执指向不存在的消息，等于销了一条不存在的义务')
  }

  if (typeof judgment.sessionId !== 'string' || judgment.sessionId === '') {
    fail('JUDGMENT_SHAPE', 'judgment.sessionId 必须是非空字符串（房间 ' + roomId + '），收到 ' + describe(judgment.sessionId))
  }
  const live = lenient ? null : membersOf(state, roomId, true)
  if (live !== null && !live.some((m) => m.sessionId === judgment.sessionId)) {
    fail('JUDGMENT_NOT_MEMBER', 'judgment.sessionId = ' + JSON.stringify(judgment.sessionId) + ' 不是房间 ' + roomId
      + ' enabled 的成员' + memberHint(live) + ' —— 只有房间里的人能表态；开关关掉的人不欠回执，也没有回执可销')
  }

  if (!VERDICTS.includes(judgment.verdict)) {
    fail('VERDICT_INVALID', 'judgment.verdict 必须是 ' + VERDICTS.join(' / ') + ' 之一（房间 ' + roomId + '），收到 '
      + describe(judgment.verdict))
  }

  return true
}

/**
 * 校验「这个任务可以被写进去」（新建或更新）。
 *
 * 为什么依赖成环必须在这里拦：环里的任务**每一个**都只是「在等前置」，
 * 状态列上看不出任何异常 —— 坏的是「整张图永远不会有人可做」，而它没有报错的机会。
 *
 * 为什么 deps / expectPaths 的**缺失**也拒（而不是当成空数组）：这两张表是这次新加的，
 * 还没有历史包袱；而少写它们的后果正是静默的 —— 任务看上去正常，「等谁」和「会动哪些文件」却都成了空。
 * 要空就显式写 []。
 */
export function assertTaskWrite(state, task) {
  assertStateObject(state)
  requireObj(task, 'task', 'TASK_SHAPE')

  const roomId = task.roomId
  findRoom(state, roomId, 'task.roomId')

  if (typeof task.id !== 'string' || task.id === '') {
    fail('TASK_ID_INVALID', 'task.id 必须是非空字符串（房间 ' + roomId + '），收到 ' + describe(task.id))
  }
  if (!TASK_STATUSES.includes(task.status)) {
    fail('TASK_STATUS_INVALID', 'task.status 必须是 ' + TASK_STATUSES.join(' / ') + ' 之一（房间 ' + roomId + '），收到 '
      + describe(task.status))
  }

  // owner：null（没人认领）或房间成员。**只要求「是成员」，不要求 enabled** ——
  // owner 是归属声明，不是义务：用户把某人静音（enabled=false）不该让它的任务失去归属。
  if (task.owner === undefined) {
    fail('TASK_OWNER_SHAPE', 'task.owner 必须显式给出（房间 ' + roomId + '）：没人认领就写 null，'
      + '字段缺失会让「这个任务有主吗」变成一个要靠猜的问题')
  }
  if (task.owner !== null) {
    if (typeof task.owner !== 'string' || task.owner === '') {
      fail('TASK_OWNER_SHAPE', 'task.owner 必须是 sessionId 字符串或 null（房间 ' + roomId + '），收到 ' + describe(task.owner))
    }
    const all = membersOf(state, roomId, false)
    if (!all.some((m) => m.sessionId === task.owner)) {
      fail('TASK_OWNER_NOT_MEMBER', 'task.owner = ' + JSON.stringify(task.owner) + ' 不是房间 ' + roomId + ' 的成员（成员：'
        + (all.length === 0 ? '一个都没有' : all.map((m) => String(m.sessionId)).join(', ')) + '）—— '
        + 'owner 写了一个不存在的人，等于这个任务没人能认领，而它看上去「已经有主了」')
    }
  }

  if (!Array.isArray(task.deps)) {
    fail('TASK_DEPS_SHAPE', 'task.deps 必须是任务 id 的数组（房间 ' + roomId + '）：没有依赖就显式写 []，收到 '
      + describe(task.deps) + ' —— 字段缺失会让「它等谁」悄悄变成「它不等任何人」')
  }
  const siblings = tableOf(state, 'tasks').filter((t) => isObj(t) && t.roomId === roomId && typeof t.id === 'string')
  for (let i = 0; i < task.deps.length; i++) {
    const dep = task.deps[i]
    if (typeof dep !== 'string' || dep === '') {
      fail('TASK_DEPS_SHAPE', 'task.deps[' + i + '] 必须是非空字符串（指向同一房间内的任务 id；房间 ' + roomId
        + '），收到 ' + describe(dep))
    }
    if (dep === task.id) {
      fail('TASK_CYCLE', 'task.deps[' + i + '] 指向任务自己（' + task.id + '）—— 自己依赖自己就是最短的环：'
        + '它永远不会就绪，而状态列里看上去只是「还没轮到」')
    }
    if (!siblings.some((t) => t.id === dep)) {
      fail('TASK_DEP_NOT_FOUND', 'task.deps[' + i + '] = ' + JSON.stringify(dep) + ' 在房间 ' + roomId + ' 里没有对应任务'
        + '（已有任务：' + (siblings.length === 0 ? '一个都没有' : siblings.map((t) => t.id).join(', '))
        + '）—— 悬空依赖会让这个任务永远等一个不存在的前置；跨房间的 id 也是这里拦住的')
    }
  }

  // 环检测在**整张房间图**上做（把这次写入覆盖进去），不只查「我参与的那个环」：
  // 只查自己那个环，会把别人已经写坏的环放过，而本模块存在的意义就是让坏图写不进去。
  const edges = new Map()
  for (const t of siblings) edges.set(t.id, Array.isArray(t.deps) ? t.deps : [])
  edges.set(task.id, task.deps)
  const cycle = findTaskCycle(edges)
  if (cycle !== null) {
    fail('TASK_CYCLE', '任务依赖成环：' + cycle.join(' → ') + '（房间 ' + roomId + '）—— '
      + '环里每个任务都只是「在等前置」，没有任何一个会先就绪，而这张图不会报错，只会一直不动')
  }

  if (!Array.isArray(task.expectPaths)) {
    fail('TASK_EXPECT_PATHS_SHAPE', 'task.expectPaths 必须是字符串数组（房间 ' + roomId + '）：不预期改任何文件就写 []，收到 '
      + describe(task.expectPaths) + ' —— 字段缺失会让「这个任务会动哪些文件」悄悄变成「什么都不动」')
  }
  for (let i = 0; i < task.expectPaths.length; i++) {
    const p = task.expectPaths[i]
    if (typeof p !== 'string' || p === '') {
      fail('TASK_EXPECT_PATHS_SHAPE', 'task.expectPaths[' + i + '] 必须是非空字符串（房间 ' + roomId + '），收到 ' + describe(p)
        + ' —— 空字符串匹配不到任何文件：它不报错，只会让越界检测静默失效')
    }
  }

  return true
}

// ---- 加载期体检（可选）------------------------------------------------------

/**
 * 加载期体检。**只报告，不修补**；三个 assert* 才是写入口的闸。
 *
 * 为什么还需要它：写入口的闸只拦得住「经过写路径」的坏数据；盘上的坏数据（历史版本、手改、
 * 半截写入）只能在**读进来之后**再核一遍。这里**一次收齐所有问题**再抛，而不是抛第一个 ——
 * 修状态文件的人要的是一份清单，不是挤牙膏；每条问题带自己的 code，放在 err.problems 里。
 */
export function assertStateShape(state, options = {}) {
  if (!isObj(state)) {
    throw invariantError('STATE_SHAPE', 'state 必须是对象，收到 ' + describe(state))
  }
  const problems = []
  const report = (err) => {
    problems.push({ code: typeof err.code === 'string' ? err.code : 'INVARIANT_STATE_SHAPE', message: err.message })
  }
  const table = (key) => {
    const list = state[key]
    if (list === undefined) return []   // 旧文件缺表：store 的 EMPTY() 会补成空表
    if (!Array.isArray(list)) {
      problems.push({ code: 'INVARIANT_STATE_SHAPE', message: 'state.' + key + ' 必须是数组，收到 ' + describe(list) })
      return []
    }
    for (let i = 0; i < list.length; i++) {
      if (!isObj(list[i])) {
        problems.push({
          code: 'INVARIANT_STATE_SHAPE',
          message: 'state.' + key + '[' + i + '] 必须是对象（一行记录），收到 ' + describe(list[i]),
        })
      }
    }
    return list.filter(isObj)
  }

  const tables = {}
  for (const key of STATE_TABLES) tables[key] = table(key)
  const { rooms, members, messages, cursors, deliveries, tasks, judgments } = tables

  const roomIds = new Set()
  for (const room of rooms) {
    if (typeof room.id !== 'string' || room.id === '') {
      problems.push({ code: 'INVARIANT_ROOM_ID_INVALID', message: 'state.rooms 里有一行没有合法 id，收到 ' + describe(room.id) })
      continue
    }
    if (roomIds.has(room.id)) {
      problems.push({
        code: 'INVARIANT_ROOM_ID_INVALID',
        message: 'state.rooms 里房间 id 重复：' + JSON.stringify(room.id) + ' —— 按 id 查房间会随机命中其中一行',
      })
    }
    roomIds.add(room.id)
  }

  for (const m of members) {
    if (!roomIds.has(m.roomId)) {
      problems.push({
        code: 'INVARIANT_ROOM_NOT_FOUND',
        message: 'state.members 里 sessionId=' + describe(m.sessionId) + ' 的行指向不存在的房间 ' + describe(m.roomId),
      })
    }
    if (typeof m.sessionId !== 'string' || m.sessionId === '') {
      problems.push({ code: 'INVARIANT_SHAPE', message: 'state.members 里有一行 sessionId 不是非空字符串，收到 ' + describe(m.sessionId) })
    }
  }

  for (const c of cursors) {
    if (!roomIds.has(c.roomId)) {
      problems.push({
        code: 'INVARIANT_ROOM_NOT_FOUND',
        message: 'state.cursors 里有一条游标指向不存在的房间 ' + describe(c.roomId),
      })
    }
    if (!Number.isInteger(c.lastSeq) || c.lastSeq < 0) {
      problems.push({
        code: 'INVARIANT_SHAPE',
        message: 'state.cursors（房间 ' + describe(c.roomId) + '）的 lastSeq 必须是 ≥0 的整数，收到 ' + describe(c.lastSeq),
      })
    }
  }

  // 投递账：它决定「这一条还该不该再送一次」，seq 指向不存在的消息就会永远漏掉/重发那一条。
  for (const d of deliveries) {
    if (!roomIds.has(d.roomId)) {
      problems.push({ code: 'INVARIANT_ROOM_NOT_FOUND', message: 'state.deliveries 里有一条记录指向不存在的房间 ' + describe(d.roomId) })
      continue
    }
    if (!Number.isInteger(d.seq) || d.seq <= 0) {
      problems.push({
        code: 'INVARIANT_SEQ_INVALID',
        message: 'state.deliveries（房间 ' + d.roomId + '）的 seq 必须是正整数，收到 ' + describe(d.seq),
      })
    } else if (!messages.some((m) => m.roomId === d.roomId && Number(m.seq) === d.seq)) {
      problems.push({
        code: 'INVARIANT_SEQ_NOT_FOUND',
        message: 'state.deliveries（房间 ' + d.roomId + '）的 seq=' + d.seq + ' 没有对应消息 —— 投递账指向不存在的消息，'
          + '重试判定会永远漏掉那一条',
      })
    }
    if (typeof d.sessionId !== 'string' || d.sessionId === '') {
      problems.push({ code: 'INVARIANT_SHAPE', message: 'state.deliveries 里有一条记录 sessionId 不是非空字符串，收到 ' + describe(d.sessionId) })
    } else if (!members.some((m) => m.roomId === d.roomId && m.sessionId === d.sessionId)) {
      problems.push({
        code: 'INVARIANT_SHAPE',
        message: 'state.deliveries 里 sessionId=' + JSON.stringify(d.sessionId) + ' 不是房间 ' + d.roomId + ' 的成员',
      })
    }
    if (d.deliveredAt !== null && !Number.isFinite(d.deliveredAt)) {
      problems.push({
        code: 'INVARIANT_SHAPE',
        message: 'state.deliveries（房间 ' + d.roomId + '，seq=' + describe(d.seq) + '）的 deliveredAt 必须是数字或 null，收到 '
          + describe(d.deliveredAt),
      })
    }
    if (!Number.isInteger(d.attempts) || d.attempts < 0) {
      problems.push({
        code: 'INVARIANT_SHAPE',
        message: 'state.deliveries（房间 ' + d.roomId + '，seq=' + describe(d.seq) + '）的 attempts 必须是 ≥0 的整数，收到 '
          + describe(d.attempts),
      })
    }
  }

  // 逐行复用写入口那三个函数：**同一份规则**，才能保证「盘上读回来的」与「写进去的」是同一个标准。
  // 没有第二份加载期规则，就没有「写的时候合法、读的时候非法」这种漂移。
  // 预建索引 + tolerant：这一次调用是**加载期体检**（见 assertMessageAppend 的 index 参数）
  const messageIndex = { seenSeqs: new Set(), tolerant: true, orphanRooms: options.orphanRooms }
  for (const m of messages) {
    try { assertMessageAppend(state, m, messageIndex) } catch (err) { report(err) }
  }
  for (const j of judgments) {
    try { assertJudgment(state, j, messageIndex) } catch (err) { report(err) }
  }
  for (const t of tasks) {
    try { assertTaskWrite(state, t) } catch (err) { report(err) }
  }

  if (problems.length > 0) {
    throw invariantError('STATE_SHAPE', '状态体检发现 ' + problems.length + ' 个问题：\n  - '
      + problems.map((p) => p.message).join('\n  - '), problems)
  }
  return true
}
