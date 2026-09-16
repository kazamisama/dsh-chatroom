/**
 * dsh-chatroom —— 多会话聊天室（浏览器半侧）
 *
 * 设计权威：BLUEPRINT.md（§4 架构 / D2 成员开关 / D8 独立房间面板 / §5 身份显示）
 *
 * 挂载方式与 dsh-raw-html 同构（本机已验证可行的手工 bundle）：
 *   1. 在**会话头部动作区**注入「房」入口（原来挂在 composer 尾部，真机反馈后挪走 ——
 *      那是发送按钮的位置，而房间是会话级的东西，语义上该和标题在一起）；
 *   2. 点击弹出固定在 body 上的面板，锚定按钮位置；
 *   3. React 重渲染会移除注入节点 → MutationObserver 补回；
 *   4. 数据与操作全部走 loopback RPC（通道 /dsh-chatroom），面板自己不持有状态真相。
 */
window.__ModuleLoader__.load({
  id: 'dsh-chatroom',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    var BTN_ID = 'dsh-chatroom-btn'
    var PANEL_ID = 'dsh-chatroom-panel'
    var CHANNEL = '/dsh-chatroom'

    /** Host RPC 调用器（apply 时注入）。 */
    var hostRpc = null
    /** 当前面板选中的房间 id。 */
    var currentRoom = null
    /** 轮询句柄（面板关闭即停）。 */
    var pollTimer = null
    /** 最近一次快照（重渲染用）。 */
    var lastState = null
    /**
     * 邀请选择器状态（模块级：重渲染不丢）。
     * workspace 用完整 cwd 做键（空串 = 全部），sort 见 SORTS。
     */
    var pick = { open: false, query: '', workspace: '', sort: 'activity-desc' }
    /** 当前主题明暗（由渲染时的真实背景算出，见 schemeOf）—— 原生下拉的弹出层要用它。 */
    var themeScheme = 'dark'
    /** 排序方式：默认最近活动在前（与 DSH 自己的会话列表同一个直觉）。 */
    var SORTS = [
      { id: 'activity-desc', label: '最近活动 ↓' },
      { id: 'activity-asc', label: '最久没动 ↑' },
      { id: 'created-desc', label: '创建时间 ↓' },
      { id: 'title-asc', label: '标题 A→Z' },
    ]
    /** 副页当前的重画函数 / 重新拉取函数（由视图组件挂载时设置）。 */
    var viewDraw = null
    var viewPull = null

    /**
     * 让**当前可见的**表面重新拉一次数据。
     * 交互后必须立刻反映，不能等下一次 2 秒轮询 —— 而浮窗和副页各有各的拉取器，
     * 原来那些 `.then(reload)` 在副页里是**静默失效**的（refresh 只服务浮窗）。
     */
    /**
     * RPC 失败**必须说出来**（真机反馈 2026-09-14：加入房间失败被静默吞掉，
     * 用户看到的就是"这个按钮按不了"）。最典型的一种：房间满员 ——
     * store.join 抛 `room is full`，而原来的处理器是 .then(reload)、根本不看 ok。
     */
    function reportFailure(what, res) {
      var msg = res && res.error && res.error.message ? res.error.message : '未知错误'
      window.alert(what + '失败：' + msg)
    }

    function reload() {
      if (document.getElementById(PANEL_ID) !== null) {
        invalidatePanel()
        refresh()
      }
      if (typeof viewPull === 'function') viewPull()
    }

    /**
     * 重画当前可见的表面。两个表面可能同时开着，各画各的 —— 交互后要立刻有反馈，
     * 不能等下一次 2 秒轮询。
     */
    function redraw() {
      if (document.getElementById(PANEL_ID) !== null) render()
      if (typeof viewDraw === 'function') viewDraw()
    }

    /** 时钟时刻（群聊里比"3 分钟前"更好定位）。 */
    function clockOf(ts) {
      if (typeof ts !== 'number') return ''
      var d = new Date(ts)
      var hh = d.getHours()
      var mm = d.getMinutes()
      return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm
    }

    /** 往宿主日志写一行 —— 面板里看不见的失败，至少要能在服务端日志里看见。 */
    function clientLog(text) {
      try { rpc('client-log', { text: String(text) }) } catch (e) {}
    }

    /** 客户端 cordis 上下文（apply 时注入；用来导航到某个会话）。 */
    var clientCtx = null
    /** 面板位置（拖动后记住，跨开关与刷新保持）。 */
    var panelPos = null
    /**
     * 拖动中。必须暂停轮询重渲染：面板每 2 秒会换一次 DOM 节点，
     * 拖动途中被换掉 = 拖动直接断掉（这是「可拖动」最容易踩的坑）。
     */
    var dragging = false
    /**
     * 输入法正在组字（中文/日文的候选窗还开着）。
     * 组字期间**一律不重建 DOM**：面板与副页都是「整块重建」式渲染，而输入法挂在那个
     * 具体的 input 节点上 —— 节点被换掉，候选窗就没了、字会丢一半、或者同一个字进来两次。
     * 草稿保护只救 value/焦点/选区，救不了组字会话本身（真机反馈 2026-09-12）。
     */
    var composing = false
    /** 正在组字的那个元素（自愈用：它离开文档 = 那次组字已经不可能继续）。 */
    var composingEl = null

    /**
     * 本插件所有轮询的总闸（诊断用）。
     * 真机 2026-09-14：会话内消息偶发卡在「发送中...」，而服务端 0.6 秒就收到了 —— 症状在浏览器侧。
     * 排查时需要能**一次**把本插件的周期性开销清零（而不是逐项猜），所以留这一个开关。
     */
    var POLLS_ENABLED = true

    // ---- 主线程卡顿探针 ------------------------------------------------------
    //
    // 为什么要有它（真机 2026-09-14）：用户报"会话内发消息要等几秒"，而且是**界面侧**、
    // 跨会话、间歇出现。同时刻的三路采样却是健康的（服务端 4-49 ms、进程 150-200% 常态、
    // 整机 12-36%、没有 pytest/ollama 突增）—— 那就只能直接量**这个页面主线程停摆了多久**。
    //
    // 原理：定时器被主线程拖后多少毫秒就是它停摆了多久。页面卡住时，恰恰是它最没能力报告的时刻，
    // 所以这里只**记录**（时间 + 时长），读的时候看"最近 5 分钟有没有"。
    // 顺带一个好处：客户端半侧是**热更新**的 —— 装这个探针不用重启，刷新即可。
    /** 最近 5 分钟内的停摆：{ at, ms, mine }。窗口由 recentJank() 现算，不看"计数何时清零"。 */
    var jankLog = []
    /** 自页面加载以来的总次数与最坏值 —— 只用来说明"这是新问题还是老问题"。 */
    var jankTotal = 0
    var jankAllWorstMs = 0
    /** 此刻是不是正在重建面板（停摆归因用：真机 2026-09-14 那次 17.8s 要能说清是不是我）。 */
    var renderInFlight = false
    /** 上次重绘的时刻（节流用）。 */
    var lastRenderAt = 0
    function startJankProbe() {
      if (jankProbeOn) return
      jankProbeOn = true
      var last = Date.now()
      window.setInterval(function () {
        var now = Date.now()
        var drift = now - last - 250
        last = now
        // **只认前台可见时的停摆**：webview 被挂起/切到后台时，浏览器会节流定时器，
        // 那会让 drift 变得很大 —— 那是"没人在看"，不是"页面被占住"（真机 2026-09-14 差点误判）。
        if (document.hidden === true) return
        if (drift >= 600) {
          jankTotal++
          if (drift > jankAllWorstMs) jankAllWorstMs = drift
          jankLog.push({ at: now, ms: drift, mine: renderInFlight === true }) // 归因：这一次停摆时，面板是不是正在重建
          if (jankLog.length > 200) jankLog.shift()
          // 措辞要跟计数口径一致：这是**自页面加载以来**的第 N 次，不是"最近 5 分钟第 N 次"
          // （2026-09-16 修：旧文案把累计值说成了窗口值，我自己读截图时就被它带偏过一次）。
          clientLog('主线程停摆 ' + Math.round(drift) + ' ms（自加载第 ' + jankTotal + ' 次）'
            + (renderInFlight ? ' —— 停摆时**正在**重建面板' : ' —— 停摆时面板没在重建'))
        }
      }, 250)
    }
    /**
     * 用户此刻是不是正对着某个输入框（含 GUI 的发送框）。
     *
     * 为什么需要它（真机 2026-09-14，用户自测）：**关掉聊天室窗口后延迟就消失**。
     * 那条延迟的形态是"消息卡在「发送中...」几秒"—— 而发送恰恰发生在输入框刚打完字、
     * 焦点还在输入框上的那一刻。本插件每 2 秒的拉取+重建只要和这一刻撞上，就会把主线程占住一会儿，
     * 而界面那条"提交→放置"的往返正好在等主线程。
     * 所以：**你在打字/正要发送时，我不刷新**（松手失焦后再补一次）。
     */
    function userIsTyping() {
      var el = document.activeElement
      if (el === null || el === undefined) return false
      if (el.isContentEditable === true) return true
      var tag = String(el.tagName || '').toLowerCase()
      return tag === 'textarea' || tag === 'input'
    }

    /**
     * 自诊断计数器（真机 2026-09-14）。
     *
     * 为什么要有：那条"发送中卡几秒"是**间歇**的 —— 单次 A/B（"关掉面板就不卡了"）在间歇症状上
     * 不构成证据。能分辨的只有三个数，而且必须**同时刻**取：
     *   repaint —— 我自己的整面板重建耗时（大 = 我的锅）
     *   rpc     —— 我拉 state 的客户端往返（大 = 服务端/链路慢，而不是主线程）
     *   stall   —— 页面主线程停摆（大 = 有东西占住主线程，可能是任何插件）
     * 三个都小、而你仍然看到"发送中"卡住 → 那条往返不在浏览器这一侧。
     */
    var diagSamples = { repaint: [], rpc: [] }
    function noteDiag(kind, ms) {
      var arr = diagSamples[kind]
      arr.push({ ms: ms, at: Date.now() })
      if (arr.length > 40) arr.shift()
    }
    /** 最近 5 分钟内的最大值（毫秒）；没有就 0。 */
    function recentMax(kind) {
      var cut = Date.now() - 5 * 60 * 1000
      var best = 0
      var arr = diagSamples[kind]
      for (var i = 0; i < arr.length; i++) if (arr[i].at >= cut && arr[i].ms > best) best = arr[i].ms
      return best
    }

    /**
     * 最近 5 分钟内的停摆汇总：{ count, ms, at, mine }（纯函数，可测）。
     *
     * 为什么不直接用"上次停摆的时长 + 一个计数器"（旧写法，2026-09-16 改）：
     * 那两个数的窗口不一样 —— 时长受 5 分钟窗口约束，**计数却是自页面加载以来累计的**，
     * 于是面板上「停摆 17.5s×9」读起来像"最近 5 分钟停了 9 次"，
     * 实际可能是"9 小时前停了 9 次、最近 5 分钟只停了一次"。诊断数字说谎比没有诊断更糟。
     */
    function recentJank(log, at) {
      var now = typeof at === 'number' ? at : Date.now()
      var cut = now - 5 * 60 * 1000
      var out = { count: 0, ms: 0, at: 0, mine: false }
      var list = log || []
      for (var i = 0; i < list.length; i++) {
        var e = list[i]
        if (e === null || e === undefined || e.at < cut) continue
        out.count++
        if (e.ms > out.ms) { out.ms = e.ms; out.at = e.at; out.mine = e.mine === true }
      }
      return out
    }
    var jankProbeOn = false

    /**
     * 现在能不能重建 DOM？拖动与组字期间都不行 —— 两者都是"节点被换掉就当场断掉"。
     * 纯函数，所以 tests/panel.mjs 直接测它。
     */
    function renderBlocked(draggingNow, composingNow) {
      return draggingNow === true || composingNow === true
    }
    var POS_KEY = 'dsh.chatroom.panelPos'
    /**
     * 用户侧已读游标：每个房间记"最后看见的 seq"。
     * 面板是**用户的眼睛**（不是某个会话的眼睛），所以它自己的游标不自研一套状态机、只落 localStorage。
     */
    var READ_KEY = 'dsh.chatroom.read.'

    function readSeqOf(roomId) {
      try { return Number(window.localStorage.getItem(READ_KEY + String(roomId)) || 0) || 0 } catch (e) { return 0 }
    }

    function saveReadSeq(roomId, seq) {
      try { window.localStorage.setItem(READ_KEY + String(roomId), String(Number(seq) || 0)) } catch (e) {}
    }

    /** 未读 = seq 比游标新的那些消息（纯函数，面板测试直接喂）。 */
    function unreadOf(messages, lastReadSeq) {
      var cut = Number(lastReadSeq) || 0
      return (messages || []).filter(function (m) { return Number(m && m.seq) > cut })
    }

    /**
     * 滚动锚：重渲染**之前**量一次，节点**进树之后**再恢复。
     *
     * 为什么要有这对函数：原来的 swap() 把旧节点的 scrollTop **直接赋给还没进树的新节点**，
     * 而那行写在替换（replaceWith）**之前** —— 挂树前的节点没有内容盒，scrollTop 一律被夹成 0，
     * 于是每发一条消息、每来一条消息，窗口就"复位"到顶部（真机反馈 2026-09-14）。
     * 另外把"人本来就在底部"也记下来：那种情况应该是**跟随最新**，而不是死守像素位置。
     */
    function scrollAnchorOf(node) {
      if (!node) return { top: 0, stick: true }
      var gap = node.scrollHeight - node.scrollTop - node.clientHeight
      // 24px 容差：贴着底部就不跟人较劲 —— 聊天窗口里"跟随最新"比"精确保留像素"更像人想要的
      return { top: node.scrollTop, stick: gap <= 24 }
    }

    function applyScrollAnchor(node, anchor) {
      if (!node || !anchor) return
      node.scrollTop = anchor.stick ? node.scrollHeight : anchor.top
    }

    function loadPanelPos() {
      try {
        var p = JSON.parse(window.localStorage.getItem(POS_KEY) || 'null')
        if (p && typeof p.left === 'number' && typeof p.top === 'number') return p
      } catch (e) {}
      return null
    }
    function savePanelPos(pos) {
      try { window.localStorage.setItem(POS_KEY, JSON.stringify(pos)) } catch (e) {}
    }
    /** 夹进视口：别让面板被拖到屏幕外再也抓不回来。 */
    function clampPos(left, top) {
      var maxLeft = Math.max(8, window.innerWidth - 388)
      var maxTop = Math.max(8, window.innerHeight - 64)
      return { left: Math.min(Math.max(8, left), maxLeft), top: Math.min(Math.max(8, top), maxTop) }
    }

    var VERDICT_LABEL = {
      unaffected: '不受影响',
      'catch-up': '我要跟上',
      retest: '我要重跑测试',
      'need-info': '需要更多信息',
    }

    /** 短号 —— 与宿主侧 rooms.js 的 shortId 保持同一套规则（两种前缀都剥）。 */
    function shortOf(id) {
      var s = String(id || '')
      if (s.indexOf('session-') === 0 || s.indexOf('session_') === 0) s = s.slice(8)
      return s.slice(0, 8)
    }

    /** 相对时间。够用即可，不引本地化框架。 */
    function ago(ts) {
      if (typeof ts !== 'number') return ''
      var d = Date.now() - ts
      if (d < 60000) return '刚刚'
      if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前'
      if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前'
      return Math.floor(d / 86400000) + ' 天前'
    }

    /**
     * 「欠一次表态」的文案 —— **必须带上 seq**（真机 #1348）。
     *
     * 为什么要这么细：靶子（targetSeq）只是**最新**那条产生义务的消息，
     * 而义务会积压 —— 一条更晚的、@ 了别人的消息会把靶子挪走，
     * 于是「谁还欠着 #1236」在只报靶子的面板上彻底消失，
     * 两个人只能各自推理「已读停在 N」算不算 N（真机 #1279 的交叉推理）。
     * 返回 '' 表示这个人什么都不欠。
     */
    function owedLabel(m, targetSeq) {
      var seqs = m && m.owedSeqs ? m.owedSeqs : []
      if (seqs.length === 0) {
        // 宿主还没重启时快照里没有 owedSeqs：退回旧文案（只说欠、不说哪条）——
        // 但不许把「欠」这件事本身吞掉，那比不精确更糟。
        return m && m.owed ? (m.overdue ? ' · ⚠ 逾时未表态' : ' · 欠一次表态') : ''
      }
      var refs = function (list) {
        return list.slice(0, 3).map(function (s) { return '#' + s }).join(' ') + (list.length > 3 ? ' …' : '')
      }
      var onTarget = seqs.indexOf(targetSeq) >= 0
      var older = seqs.filter(function (s) { return s !== targetSeq })
      if (onTarget) {
        return ' · ' + (m.overdue ? '⚠ 逾时未表态 ' : '欠一次表态 ') + '#' + targetSeq
          + (older.length > 0 ? '（另 ' + older.length + ' 条更早未回: ' + refs(older) + '）' : '')
      }
      // 只在更早的几条上欠：它**不会被重新唤醒**（投递是靶子驱动的），
      // 所以文案不许写成「必须回」—— 那是把背景当成了义务。
      return ' · ' + (m.overdue ? '⚠ ' : '') + '还欠更早的 ' + refs(seqs) + '（当前靶子 #' + targetSeq + ' 不欠）'
    }

    /**
     * 成员行上的「方向 / 边界」两行文案（纯函数，面板测试直接喂）。
     *
     * 为什么分成两行：direction 是散文（给人读，可能很长），paths 是**机器读的边界**
     * —— 唤醒谁、算不算越界只看后者。真机 2026-09-16：散文被静默截断到 200 字，
     * 本房间 6 人里 3 人顶格（「不碰 dashboard.css」只剩 dashbo），
     * 于是"面板上看着有方向"与"机器手里有边界"第一次有了可见的差别。
     */
    function directionLineOf(m) {
      var text = String((m && m.selfDescription) || '')
      var paths = (m && m.paths) || []
      var excludes = (m && m.excludes) || []
      var shown = text.length > 240 ? text.slice(0, 240) + '…（共 ' + text.length + ' 字）' : text
      var bound = ''
      if (paths.length > 0) {
        bound = '边界 ' + paths.slice(0, 3).join(' ') + (paths.length > 3 ? ' …共 ' + paths.length + ' 条' : '')
          + (excludes.length > 0 ? '（不碰 ' + excludes.slice(0, 2).join(' ') + '）' : '')
      } else if (text !== '') {
        bound = '边界靠散文猜（会误报/漏报）'
      }
      return { text: shown === '' ? '' : '方向：' + shown, bound: bound }
    }

    /**
     * 待表态的逐行文案：谁 · 欠哪几条（真机 #1348）。
     * 分两栏：靶子上欠的（**会被重新唤醒**）与更早的旧账（不会再被唤醒）。
     * 宿主没重启时没有 pendingDetail → 退回旧的「只报人」。
     */
    function pendingRows(room) {
      var detail = room && room.pendingDetail && room.pendingDetail.length > 0 ? room.pendingDetail : null
      if (detail === null) {
        var flat = room && room.pending ? room.pending : []
        // 退回时也要用短号：`.slice(-8)` 取的是 UUID 的**尾巴**，跟别处的短号对不上号
        return { target: flat.map(shortOf), older: [] }
      }
      var target = room.targetSeq
      var head = []
      var tail = []
      detail.forEach(function (d) {
        var seqs = d.seqs || []
        var name = d.shortId || String(d.sessionId || '').slice(-8)
        if (seqs.indexOf(target) >= 0) {
          head.push(name + '  #' + target + (seqs.length > 1 ? '　另 ' + (seqs.length - 1) + ' 条更早未回' : ''))
        } else if (seqs.length > 0) {
          tail.push(name + '  ' + seqs.slice(0, 4).map(function (s) { return '#' + s }).join(' ')
            + (seqs.length > 4 ? ' …' : ''))
        }
      })
      return { target: head, older: tail }
    }

    // ---- Markdown 渲染（零依赖）------------------------------------------
    //
    // 为什么自己写：面板是插件自己的 DOM 表面，会话视图那套渲染器管不到这儿；
    // 而引 DSH 内部的 Markdown 组件会把插件和宿主内部结构绑死（本插件坚持零依赖）。
    //
    // **安全前提**：消息体是 agent 写的 —— 属于不可信内容。
    // 所以一律先转义 < > & "，再套上我们自己插入的标签；绝不把原文直接塞进 innerHTML。
    // 否则一个会话往房间里发一句 <img onerror=...> 就能在别人的面板里执行代码。

    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
    }

    // 直接写 CSS 变量，**不引用 JS 常量**：Markdown 渲染器要自包含，
    // 否则加载时序（var 赋值）会给它一个 undefined 底色，提取测试也会当场炸。
    var CODE_INLINE = 'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;' +
      'padding:1px 4px;border-radius:4px;background:var(--dsw-alias-markdown-code-block,rgba(128,128,128,.16));'

    /** 行内格式：先转义，再只插入我们自己造的标签。 */
    function inlineMd(text) {
      var out = escapeHtml(text)
      out = out.replace(/\u0060([^\u0060]+)\u0060/g, '<code style="' + CODE_INLINE + '">$1</code>')
      out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      out = out.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      out = out.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:underline;">$1</a>')
      return out
    }

    /** 代码块：面板只有 380px 宽，所以横向滚动 + 语言标签 + 复制按钮。 */
    function codeBlock(lang, code) {
      var wrap = el('div', 'margin:4px 0;border-radius:6px;overflow:hidden;' +
        'border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.20));')
      var bar = el('div', 'display:flex;justify-content:space-between;align-items:center;gap:6px;' +
        'padding:2px 6px;font-size:10px;background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14));' +
        'color:var(--dsw-alias-label-secondary,#a8a8a8);')
      bar.appendChild(el('span', '', lang || 'text'))
      var copy = el('button', 'border:0;background:transparent;color:inherit;font-size:10px;cursor:pointer;padding:0 2px;', '复制')
      copy.addEventListener('click', function () {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(code)
            copy.textContent = '已复制'
            window.setTimeout(function () { copy.textContent = '复制' }, 1200)
          }
        } catch (e) {}
      })
      bar.appendChild(copy)
      wrap.appendChild(bar)
      var pre = el('pre', 'margin:0;padding:6px 8px;overflow-x:auto;font-size:11px;line-height:1.5;' +
        'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;')
      pre.textContent = code
      wrap.appendChild(pre)
      return wrap
    }

    /** 把 Markdown 渲染进容器。支持的子集够 agent 的实际输出用：围栏代码、行内代码、
     *  粗斜体、标题、列表、引用、分隔线、链接、段落。 */
    function renderMarkdown(container, text) {
      var lines = String(text === undefined || text === null ? '' : text).split('\n')
      var i = 0
      var para = []

      function flush() {
        if (para.length === 0) return
        var p = el('div', 'margin:2px 0;')
        p.innerHTML = inlineMd(para.join(' '))
        container.appendChild(p)
        para = []
      }

      while (i < lines.length) {
        var line = lines[i]
        var fence = /^\s*\u0060\u0060\u0060(\w*)\s*$/.exec(line)
        if (fence !== null) {
          flush()
          var lang = fence[1]
          var buf = []
          i++
          while (i < lines.length && !/^\s*\u0060\u0060\u0060\s*$/.test(lines[i])) { buf.push(lines[i]); i++ }
          i++
          container.appendChild(codeBlock(lang, buf.join('\n')))
          continue
        }
        if (/^\s*$/.test(line)) { flush(); i++; continue }
        var h = /^(#{1,4})\s+(.*)$/.exec(line)
        if (h !== null) {
          flush()
          var size = [0, 14, 13, 12, 12][h[1].length]
          var head = el('div', 'margin:4px 0 2px;font-weight:700;font-size:' + size + 'px;')
          head.innerHTML = inlineMd(h[2])
          container.appendChild(head)
          i++
          continue
        }
        if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
          flush()
          container.appendChild(el('div', 'height:1px;margin:6px 0;background:var(--dsw-alias-border-l1,rgba(128,128,128,.20));'))
          i++
          continue
        }
        if (/^\s*>\s?/.test(line)) {
          flush()
          var quote = []
          while (i < lines.length && /^\s*>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^\s*>\s?/, '')); i++ }
          var q = el('div', 'margin:3px 0;padding:2px 8px;border-left:2px solid var(--dsw-alias-border-l2,rgba(128,128,128,.32));' +
            'color:var(--dsw-alias-label-secondary,#a8a8a8);')
          q.innerHTML = inlineMd(quote.join(' '))
          container.appendChild(q)
          continue
        }
        var ul = /^\s*[-*+]\s+(.*)$/.exec(line)
        var ol = /^\s*\d+[.)]\s+(.*)$/.exec(line)
        if (ul !== null || ol !== null) {
          flush()
          var ordered = ol !== null
          var list = el(ordered ? 'ol' : 'ul', 'margin:2px 0 2px 16px;padding:0;')
          while (i < lines.length) {
            var hit = ordered ? /^\s*\d+[.)]\s+(.*)$/.exec(lines[i]) : /^\s*[-*+]\s+(.*)$/.exec(lines[i])
            if (hit === null) break
            var li = el('li', 'margin:1px 0;')
            li.innerHTML = inlineMd(hit[1])
            list.appendChild(li)
            i++
          }
          container.appendChild(list)
          continue
        }
        para.push(line)
        i++
      }
      flush()
    }

    // ---- 群聊式渲染的小工具 ----------------------------------------------

    /** 同一个人的连续消息归为一组：键必须稳定，否则头像/名字会每轮闪。 */
    function senderKey(m) {
      if (m.sender && m.sender.user === true) return 'user'
      return (m.sender && m.sender.sessionId) ? String(m.sender.sessionId) : 'unknown'
    }

    /** 会话 id → 稳定色相。同一个人永远同一个颜色，换个房间也不会变。 */
    function hueOf(key) {
      var h = 0
      var s = String(key)
      for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360
      return h
    }

    /** 头像文字：角色名首字优先，否则短号前两位。 */
    function initialsOf(m) {
      var role = m.sender && m.sender.roleName ? String(m.sender.roleName) : ''
      if (role !== '') return role.slice(0, 1)
      var key = senderKey(m)
      if (key === 'user') return '你'
      return shortOf(key).slice(0, 2)
    }

    /** 圆头像。用色相派生，深浅主题下都靠 alpha 站得住。 */
    function avatarEl(m) {
      var key = senderKey(m)
      var isUser = key === 'user'
      var hue = isUser ? 38 : hueOf(key)
      var node = el('div', 'flex:none;width:22px;height:22px;border-radius:50%;' +
        'display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:600;' +
        'background:hsl(' + hue + ',52%,42%);color:#fff;')
      node.textContent = initialsOf(m)
      return node
    }

    /** 显示名：用户=你，否则角色名 > 会话标题 > 短号。 */
    function displayNameOf(m, room) {
      if (m.sender && m.sender.user === true) return '你'
      if (m.sender && m.sender.roleName) return m.sender.roleName
      var id = m.sender && m.sender.sessionId
      if (id) {
        var members = (room && room.members) || []
        for (var i = 0; i < members.length; i++) {
          if (members[i].sessionId === id && members[i].title) return members[i].title
        }
      }
      return id ? shortOf(id) : '?'
    }

    /** 超过这个间隔就插一条时间分隔线。 */
    var GROUP_GAP_MS = 5 * 60 * 1000

    /** git 校验三态的视觉：已证实=绿、与事实不符=红、未证实=中性。 */
    function verdictChip(verdict) {
      if (verdict === 'verified') return { text: '✓ 已证实', color: T.ok, bg: tint(T.ok) }
      if (verdict === 'contradicted') return { text: '✗ 与事实不符', color: T.bad, bg: tint(T.bad) }
      return { text: '? 未证实', color: T.text2, bg: 'background:' + T.hover + ';' }
    }

    // ---- Host 通道（与 dsh-raw-html 同构）--------------------------------

    function makeHostRpc(ctx) {
      try {
        var connection = (ctx && (ctx.get ? ctx.get('connection') : undefined)) || (ctx && ctx.connection)
        if (connection && connection.rpc && connection.rpc.call) {
          return connection.rpc.call.bind(connection.rpc)
        }
      } catch (e) {}
      return null
    }

    /** 调一次宿主端点。宿主返回的就是 RpcResult。 */
    function rpc(endpoint, payload) {
      if (!hostRpc) return Promise.resolve({ ok: false, error: { message: '宿主通道不可用' } })
      return hostRpc(CHANNEL, endpoint, payload || {}).then(function (res) {
        if (res && res.ok === true) return res
        var msg = res && res.error && res.error.message ? res.error.message : '调用失败'
        return { ok: false, error: { message: msg } }
      }).catch(function (e) {
        return { ok: false, error: { message: String(e && e.message ? e.message : e) } }
      })
    }

    /**
     * 在 DSH 里打开某个会话。
     * 只给 shortId 等于没给身份 —— 人认不出、也点不进去（真机反馈）。
     */
    function openSession(sessionId) {
      try {
        var sessions = clientCtx && (clientCtx.get ? clientCtx.get('sessions') : undefined)
        if (sessions && typeof sessions.open === 'function') {
          sessions.open(sessionId)
          closePanel()
          return
        }
      } catch (e) {}
      window.alert('无法定位会话（运行时 sessions 服务不可用）：' + sessionId)
    }

    // ---- 入口按钮（会话头部动作区）----------------------------------------
    //
    // 原来它挂在 composer 尾部（发送按钮旁边）。那是全应用最贵的一行，
    // 而"房间入口"是**会话级**的东西 —— 语义上就该和会话标题在一起。
    // 真机反馈："入口位置是不是换个位置比较好？" —— 是的。

    /** 角标数：所有房间「需要人管」的事之和。让不打开面板也知道有事。 */
    var entryAttention = 0

    /**
     * 头部动作区的入口按钮。
     * 用 React 只是为了坐进座位；按钮本身是原生 DOM，点击后锚定它自己开浮窗。
     */
    function makeRoomEntry(React) {
      return function RoomEntry() {
        var hostRef = React.useRef(null)
        React.useEffect(function () {
          var alive = true
          function paint() {
            var host = hostRef.current
            if (host === null) return
            while (host.firstChild !== null) host.removeChild(host.firstChild)
            var btn = document.createElement('button')
            btn.id = BTN_ID
            btn.type = 'button'
            btn.textContent = entryAttention > 0 ? '房 ●' + entryAttention : '房'
            btn.title = '会话聊天室：' + (entryAttention > 0 ? entryAttention + ' 件需要处理' : '当前无待处理')
            btn.style.cssText =
              'flex:none;height:22px;padding:0 8px;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;' +
              'background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14));' +
              'color:' + (entryAttention > 0 ? 'var(--dsw-alias-state-warn-primary,#d29922)' : 'var(--dsw-alias-label-secondary,#a8a8a8)') + ';' +
              'border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.20));'
            btn.addEventListener('click', function (e) {
              e.stopPropagation()
              togglePanel(btn)
            })
            host.appendChild(btn)
          }
          function pull() {
            // 后台标签页不拉（角标只是个数，回来时补一次就够）
            if (POLLS_ENABLED !== true || document.hidden === true) return
            // 面板开着时不必它也拉：面板每 2 秒拉的是同一份 state，两个轮询叠起来只是把载荷翻倍
            if (document.getElementById(PANEL_ID) !== null) return
            rpc('state').then(function (res) {
              if (!alive || res.ok !== true) return
              var total = 0
              for (var i = 0; i < res.value.rooms.length; i++) total += attentionOf(res.value.rooms[i]).total
              if (total !== entryAttention) {
                entryAttention = total
                paint()
              }
            })
          }
          paint()
          pull()
          // 15 秒一次（原来是 5 秒）：角标只是"有没有事"的一个数，
          // 而每次拉的是整份 state（真机 1.55 MB / 1001 条消息）—— 1000 倍的成本换一个计数，不值。
          var timer = window.setInterval(pull, 15000)
          return function () {
            alive = false
            window.clearInterval(timer)
          }
        }, [])
        return React.createElement('span', { ref: hostRef, style: { display: 'inline-flex', alignItems: 'center' } })
      }
    }

    // ---- 面板 ------------------------------------------------------------

    function el(tag, css, text) {
      var n = document.createElement(tag)
      if (css) n.style.cssText = css
      if (text !== undefined) n.textContent = text
      return n
    }

    // ---- DSH 语义色令牌 --------------------------------------------------
    //
    // 为什么必须用令牌：之前这里拿 label-tertiary（三级文字，**本来就该是最弱的**）
    // 当正文和元信息用，整个面板就发灰；三态徽章还是硬编码色值，深色主题下完全不跟随。
    // 令牌化之后两种主题自动成立，我也不再需要猜背景是深是浅。
    //
    // 后备值原则：文字类退回 inherit（继承页面主题色），状态色退回一组在深浅底上都还看得清的色。
    var T = {
      text: 'var(--dsw-alias-label-primary,inherit)',
      text2: 'var(--dsw-alias-label-secondary,#a8a8a8)',
      text3: 'var(--dsw-alias-label-tertiary,#8a8a8a)',
      caption: 'var(--dsw-alias-label-caption,#909090)',
      bg: 'var(--dsw-alias-bg-overlay,rgba(28,28,30,.98))',
      hover: 'var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14))',
      border: 'var(--dsw-alias-border-l2,rgba(128,128,128,.32))',
      borderSoft: 'var(--dsw-alias-border-l1,rgba(128,128,128,.20))',
      code: 'var(--dsw-alias-markdown-code-block,rgba(128,128,128,.16))',
      ok: 'var(--dsw-alias-state-success-primary,#3fb950)',
      bad: 'var(--dsw-alias-state-error-primary,#f85149)',
      warn: 'var(--dsw-alias-state-warn-primary,#d29922)',
      biz: 'var(--dsw-alias-state-business-primary,#58a6ff)',
    }
    // 徽章底色：先给一个中性半透明底（color-mix 不支持时就是它），再叠 color-mix 版本。
    function tint(token) {
      return 'background:rgba(128,128,128,.16);background:color-mix(in srgb, ' + token + ' 18%, transparent);'
    }

    var S = {
      // resize:both 是浏览器原生的调节手柄（零 JS）；配 overflow:auto 才生效。
      // ⚠ 尺寸必须在 swap() 里跟着走，否则每 2 秒的重渲染会把它重置回默认值。
      // **面板本体不再滚动**（真机反馈 2026-09-14：滚动容器就是面板 → 拖动手柄随内容滚出视野，
      // 滚到新消息处就抓不住窗口）。改成 flex 列：头部固定，内容区自己滚。
      panel: 'position:fixed;z-index:99999;box-sizing:border-box;width:380px;min-width:300px;' +
        'max-height:80vh;min-height:200px;resize:both;overflow:hidden;display:flex;flex-direction:column;' +
        'background:' + T.bg + ';border:1px solid ' + T.border + ';border-radius:12px;' +
        'box-shadow:0 12px 34px rgba(0,0,0,.34);font-family:inherit;' +
        'color:' + T.text + ';font-size:12px;line-height:1.55;',
      // z-index 必须高于抽屉：抽屉是 top:0 的覆盖层，压住头部的话「☰」和「×」就点不到了
      head: 'flex:none;position:relative;z-index:2;background:inherit;display:flex;align-items:center;' +
        'justify-content:space-between;gap:8px;cursor:move;' +
        'user-select:none;touch-action:none;font-size:12px;font-weight:600;' +
        'color:' + T.text + ';padding:10px 12px 8px;border-bottom:1px solid ' + T.borderSoft + ';',
      body: 'flex:1;min-height:0;overflow:auto;padding:10px 14px 12px;',
      // 侧面抽屉：成员 / 邀请 / 设置项从聊天流里搬出来，不再和消息抢同一列
      drawer: 'position:absolute;z-index:1;top:0;right:0;bottom:0;width:84%;max-width:330px;box-sizing:border-box;' +
        'overflow:auto;padding:10px 14px 12px;background:' + T.bg + ';' +
        'border-left:1px solid ' + T.border + ';box-shadow:-10px 0 26px rgba(0,0,0,.30);' +
        'transition:transform .16s ease;',
      drawerHead: 'display:flex;align-items:center;justify-content:space-between;gap:8px;' +
        'font-size:12px;font-weight:600;padding-bottom:6px;margin-bottom:2px;' +
        'border-bottom:1px solid ' + T.borderSoft + ';color:' + T.text + ';',
      grip: 'opacity:.55;font-size:11px;font-weight:400;color:' + T.text2 + ';',
      section: 'font-size:10px;letter-spacing:.1em;color:' + T.text2 + ';margin:10px 2px 4px;',
      row: 'display:flex;align-items:center;gap:6px;padding:5px 6px;border-radius:8px;' +
        'background:' + T.hover + ';margin-bottom:4px;',
      mono: 'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:' + T.text + ';',
      dim: 'color:' + T.text2 + ';font-size:11px;',
      weak: 'color:' + T.text3 + ';font-size:10px;',
      warn: 'color:' + T.warn + ';font-size:11px;',
      btn: 'flex:none;height:22px;padding:0 8px;border-radius:6px;font-size:11px;cursor:pointer;' +
        'background:' + T.hover + ';color:' + T.text2 + ';border:1px solid ' + T.borderSoft + ';',
      // 下拉：半透明底 + 一层实边框，保证在深色面板上"看得出是个控件"（原来只有很淡的描边）
      select: 'flex:1;min-width:0;height:22px;box-sizing:border-box;padding:0 4px;border-radius:6px;' +
        'font-size:11px;font-family:inherit;cursor:pointer;' +
        'background:' + T.hover + ';color:' + T.text + ';border:1px solid ' + T.border + ';',
      icon: 'flex:none;width:18px;height:18px;padding:0;border-radius:5px;font-size:14px;line-height:16px;' +
        'cursor:pointer;background:transparent;color:' + T.text2 + ';border:1px solid transparent;',
      primary: 'flex:none;height:24px;padding:0 10px;border-radius:6px;font-size:11px;cursor:pointer;' +
        'background:var(--dsw-alias-button-primary-fill,#2563eb);color:var(--dsw-alias-label-primary-inverted,#fff);' +
        'border:1px solid transparent;',
    }

    /**
     * 一个房间「有没有事」的汇总。**纯函数**，所以能被 tests/panel.mjs 直接测。
     * 面板顶部状态行与标签角标都用它 —— 两处算法必须是同一个，否则数字会对不上。
     */
    function attentionOf(room) {
      var out = { bad: 0, overdue: 0, pending: 0, attentionOnly: 0, total: 0 }
      if (room === null || room === undefined) return out
      var changes = room.changes || []
      for (var i = 0; i < changes.length; i++) {
        if (changes[i].verdict === 'contradicted') out.bad++
      }
      var members = room.members || []
      for (var j = 0; j < members.length; j++) {
        if (members[j].inRoom === false) out.attentionOnly++
        if (members[j].overdue === true) out.overdue++
      }
      out.pending = (room.pending || []).length
      // 逾时的人本来就在待表态里，角标不该把他算两次
      out.total = out.bad + out.overdue + Math.max(0, out.pending - out.overdue)
      return out
    }

    /** 变更声明的详情块（默认折叠）：核验依据、HEAD、diff、相关成员及其表态。 */
    function changeDetail(c, verdicts) {
      var wrap = el('div', 'margin-top:4px;')
      var body = el('div', 'display:none;margin-top:4px;padding:5px 7px;border-radius:6px;background:' + T.hover + ';')
      var more = el('button', S.btn, '详情')
      more.addEventListener('click', function () {
        var open = body.style.display !== 'none'
        body.style.display = open ? 'none' : 'block'
        more.textContent = open ? '详情' : '收起'
      })
      var related = Array.isArray(c.related) ? c.related : []
      body.appendChild(el('div', S.weak, '核验依据：' + (c.reason || '-') + (c.head ? ' · HEAD ' + c.head : '')))
      if (c.diffStat) {
        body.appendChild(el('div', S.weak, 'diff：' + String(c.diffStat).split('\n').filter(Boolean).slice(0, 4).join('  |  ')))
      }
      body.appendChild(el('div', S.weak, related.length === 0
        ? '未判定任何成员可能受影响（未打扰任何人）'
        : '相关成员：' + related.map(function (id) {
          var got = verdicts === undefined ? undefined : verdicts[id]
          return shortOf(id) + (got ? '[' + (VERDICT_LABEL[got] || got) + ']' : '[待表态]')
        }).join('  ')))
      wrap.appendChild(more)
      wrap.appendChild(body)
      return wrap
    }

    /**
     * 渲染指纹挂在**当前那个面板节点**上（panel._signature 属性），不是模块级变量。
     * 理由：openPanel() 每次都新建一具空壳，模块级的「我画过什么」会把新空壳误判成已画过 ——
     * 于是「关掉再打开」永远停在空白（真机反馈 2026-09-12）。挂到节点上，新节点天然没有指纹。
     */

    /** 作废当前浮窗的指纹：下一次 refresh 必定重画（交互后要立刻有反馈时用）。 */
    function invalidatePanel() {
      var panel = document.getElementById(PANEL_ID)
      if (panel !== null) panel._signature = ''
    }

    /**
     * 该不该重画？指纹挂在**节点**上，所以刚新建的空壳天然没有指纹 → 必画。
     * 这就是 2026-09-12 那个「关掉再打开永远空白」的守卫：指纹原本是模块级变量，
     * 新空壳被误判成"已经画过了"，于是它一直空着，直到数据变化才突然出现内容。
     * 纯函数 —— tests/panel.mjs 直接测它。
     */
    function shouldRepaint(node, sig) {
      if (node === null || node === undefined) return false
      return node._signature !== sig
    }

    /**
     * 候选里出现过的工作区，按会话数降序。纯函数 → tests/panel.mjs 直接测。
     * 键用完整 cwd（同名的两个工作区不能混成一个），显示名用 basename。
     */
    function workspaceBuckets(cands) {
      var byKey = new Map()
      var list = Array.isArray(cands) ? cands : []
      for (var i = 0; i < list.length; i++) {
        var c = list[i]
        var key = String(c.cwd || '')
        var bucket = byKey.get(key)
        if (bucket === undefined) {
          byKey.set(key, { cwd: key, label: String(c.workspace || '') || '(未知工作区)', count: 1 })
        } else {
          bucket.count++
        }
      }
      return Array.from(byKey.values()).sort(function (a, b) { return b.count - a.count })
    }

    /**
     * 当前主题是深还是浅 —— 由**实际渲染出来的**背景亮度算，不去猜主题名。
     * 量不到（透明背景）就退回量 body，再量不到才默认深色。
     */
    function schemeOf(node) {
      var lumOf = function (css) {
        var m = String(css === undefined || css === null ? '' : css).match(/[\d.]+/g)
        if (m === null || m.length < 3) return null
        if (m.length >= 4 && Number(m[3]) === 0) return null // 全透明 = 量不到，别当成黑
        return 0.299 * Number(m[0]) + 0.587 * Number(m[1]) + 0.114 * Number(m[2])
      }
      try {
        var lum = node === null || node === undefined ? null : lumOf(window.getComputedStyle(node).backgroundColor)
        if (lum === null) lum = lumOf(window.getComputedStyle(document.body).backgroundColor)
        if (lum === null) return 'dark'
        return lum > 140 ? 'light' : 'dark'
      } catch (err) {
        return 'dark'
      }
    }

    /**
     * 造一个 <option>（原生下拉，输入法 / 键盘 / 无障碍都自带，不自己造轮子）。
     *
     * **弹出列表不认 CSS 变量**：深色面板里会弹出一张惨白的系统菜单（真机反馈 2026-09-12 截图）。
     * 所以两件事一起做：控件上给 color-scheme（让浏览器用深色渲染弹出层），
     * 选项上显式写背景与字色（弹出层的底色取它）。
     */
    function optionEl(value, label) {
      var o = document.createElement('option')
      o.value = value
      o.textContent = label
      o.style.background = 'var(--dsw-alias-bg-overlay,#1c1c1e)'
      o.style.color = T.text
      return o
    }

    /**
     * 候选排序。纯函数 → tests/panel.mjs 直接测。
     * 时间缺失时一律退回 createdAt，保证任何一条都有序可排（不会出现"排到一半散架"）。
     */
    function sortCandidates(cands, mode) {
      var list = (Array.isArray(cands) ? cands : []).slice()
      var at = function (c) { return (typeof c.lastActivityAt === 'number' && c.lastActivityAt > 0 ? c.lastActivityAt : c.createdAt) || 0 }
      var created = function (c) { return c.createdAt || 0 }
      if (mode === 'activity-asc') return list.sort(function (a, b) { return at(a) - at(b) })
      if (mode === 'created-desc') return list.sort(function (a, b) { return created(b) - created(a) })
      if (mode === 'title-asc') {
        return list.sort(function (a, b) {
          return String(a.title || '').localeCompare(String(b.title || ''), 'zh-Hans-CN')
        })
      }
      return list.sort(function (a, b) { return at(b) - at(a) }) // activity-desc（默认）
    }

    /**
     * 候选过滤：工作区（精确匹配 cwd，空串 = 全部）AND 关键词（标题 / 工作区 / 短号）。
     * 纯函数 → tests/panel.mjs 直接测。
     */
    function filterCandidates(cands, query, workspace) {
      var list = Array.isArray(cands) ? cands : []
      var q = String(query === undefined || query === null ? '' : query).trim().toLowerCase()
      var ws = workspace === undefined || workspace === null ? '' : workspace
      return list.filter(function (c) {
        if (ws !== '' && String(c.cwd || '') !== ws) return false
        if (q === '') return true
        // 短号要**显式**匹配：列表里给人看的就是短号，而 cwd/标题都可能不含它。
        // （真机上短号恰好是 sessionId 的前 8 位，靠子串碰巧能中 —— 但那是巧合，不是保证。）
        var hay = String(c.title || '') + ' ' + String(c.workspace || '') + ' ' + String(c.shortId || '') + ' ' + String(c.sessionId)
        return hay.toLowerCase().indexOf(q) >= 0
      })
    }

    /**
     * 状态指纹。**只有真变了才重渲染**：
     * 面板每 2 秒轮询一次，若无条件重建，正在输入的草稿、光标、选区会被一次次冲掉
     * （真机反馈：「信息一会消失一会出现」——一半是半份数据渲染，一半就是这种刷新抖动）。
     */
    function signatureOf(st) {
      if (!st) return ''
      var parts = []
      var rooms = st.rooms || []
      for (var i = 0; i < rooms.length; i++) {
        var r = rooms[i]
        parts.push(r.room.id + '#' + r.lastSeq + '#' + r.messages.length + '#' + (r.changes || []).length + '#'
          + (r.members || []).map(function (m) {
            return m.shortId + (m.inRoom ? '1' : '0') + (m.owed ? 'o' : '') + (m.overdue ? '!' : '')
              + (m.owedSeqs || []).join('.') + (m.verdict || '-')
          }).join(','))
      }
      // 标题必须进指纹：标题是**后台预热**出来的，补到之后若指纹没变就不会重画 ——
      // 真机表现就是「整屏 (无标题会话) 一直不变」（2026-09-12）。
      // 「最近活动」按分钟入指纹：既让「x 分钟前」保持新鲜，又不至于每轮都重建 DOM。
      parts.push('cand:' + (st.candidates || []).map(function (c) {
        return c.shortId + (c.live ? '1' : '0') + (c.status || '') + '#' + (c.title || '')
          + '@' + Math.round((c.lastActivityAt || 0) / 60000)
      }).join(','))
      parts.push('cur:' + String(currentRoom))
      return parts.join('|')
    }

    /** 抓取用户在面板里正在输入的草稿与焦点，重建后原样还回去。 */
    function captureDrafts(panel) {
      var out = { fields: {}, focus: null }
      try {
        var nodes = panel.querySelectorAll('[data-draft]')
        for (var i = 0; i < nodes.length; i++) {
          var name = nodes[i].getAttribute('data-draft')
          out.fields[name] = nodes[i].value
          if (document.activeElement === nodes[i]) out.focus = name
        }
      } catch (e) {}
      return out
    }

    function restoreDrafts(draft) {
      restoreDraftsInto(document.getElementById(PANEL_ID), draft)
    }

    /** 把草稿还进给定容器 —— 浮动面板与副页共用（副页没有 PANEL_ID 可查）。 */
    function restoreDraftsInto(panel, draft) {
      if (draft === undefined || draft === null || panel === null || panel === undefined) return
      try {
        var nodes = panel.querySelectorAll('[data-draft]')
        for (var i = 0; i < nodes.length; i++) {
          var name = nodes[i].getAttribute('data-draft')
          if (draft.fields !== undefined && draft.fields[name] !== undefined && draft.fields[name] !== '') {
            nodes[i].value = draft.fields[name]
          }
          if (draft.focus === name) nodes[i].focus()
        }
      } catch (e) {}
    }

    /** 浏览器端下载（审计导出用，不经过宿主）。 */
    function downloadText(filename, text) {
      try {
        var blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
        var url = window.URL.createObjectURL(blob)
        var a = document.createElement('a')
        a.href = url
        a.download = filename
        document.body.appendChild(a)
        a.click()
        a.remove()
        window.setTimeout(function () { window.URL.revokeObjectURL(url) }, 1000)
      } catch (e) { window.alert('下载失败：' + e) }
    }

    // ---- 推送：只弹「有事」（真机定调：你基本不看面板，所以打断权必须交给推送）----
    //
    // 弹：与事实不符 / 有人逾时 / 有人在消息里 @ 用户。
    // 不弹：有人表态 —— 那是正常运转的噪音，弹它等于训练用户忽略弹窗。
    // 同一条只弹一次（localStorage 记键）；**首帧只做基线**，不把历史问题一次性糊你脸上。

    var TOAST_ID = 'dsh-chatroom-toast'
    var NOTIFIED_KEY = 'dsh.chatroom.notified'
    var notifyPrimed = false

    function loadNotified() {
      try { return JSON.parse(window.localStorage.getItem(NOTIFIED_KEY) || '[]') } catch (e) { return [] }
    }
    function saveNotified(list) {
      try { window.localStorage.setItem(NOTIFIED_KEY, JSON.stringify(list.slice(-300))) } catch (e) {}
    }

    /** 扫一遍所有房间，收集「值得打扰人」的事。纯只读，所以可测。 */
    function collectProblems(rooms) {
      var out = []
      for (var r = 0; r < (rooms || []).length; r++) {
        var room = rooms[r]
        var changes = room.changes || []
        for (var c = 0; c < changes.length; c++) {
          if (changes[c].verdict !== 'contradicted') continue
          out.push({
            key: room.room.id + '|bad|' + changes[c].seq,
            roomId: room.room.id,
            roomName: room.room.name,
            kind: 'bad',
            text: '变更声明与 git 事实不符：' + ((changes[c].files || []).join('、') || '未声明文件'),
          })
        }
        var members = room.members || []
        for (var m = 0; m < members.length; m++) {
          if (members[m].overdue !== true) continue
          out.push({
            key: room.room.id + '|overdue|' + room.targetSeq + '|' + members[m].shortId,
            roomId: room.room.id,
            roomName: room.room.name,
            kind: 'overdue',
            text: (members[m].title || members[m].shortId) + ' 逾时未表态',
          })
        }
        var msgs = room.messages || []
        for (var g = 0; g < msgs.length; g++) {
          var body = String(msgs[g].body || '')
          if (body.indexOf('@用户') < 0 && body.indexOf('@user') < 0 && body.indexOf('@你') < 0) continue
          out.push({
            key: room.room.id + '|at|' + msgs[g].seq,
            roomId: room.room.id,
            roomName: room.room.name,
            kind: 'at',
            text: '有人在房间里 @ 你：' + body.slice(0, 90),
          })
        }
      }
      return out
    }

    function closeToast() {
      var t = document.getElementById(TOAST_ID)
      if (t !== null) t.remove()
    }

    function showToast(items) {
      closeToast()
      var wrap = el('div', 'position:fixed;z-index:100000;right:16px;top:16px;width:290px;' +
        'display:flex;flex-direction:column;gap:6px;')
      wrap.id = TOAST_ID
      items.slice(0, 4).forEach(function (it) {
        var color = it.kind === 'bad' ? T.bad : it.kind === 'overdue' ? T.warn : T.biz
        var title = it.kind === 'bad' ? '✗ 与事实不符' : it.kind === 'overdue' ? '⚠ 逾时未表态' : '@ 提到你'
        var card = el('div', 'padding:8px 10px;border-radius:10px;cursor:pointer;font-size:12px;line-height:1.5;' +
          'background:' + T.bg + ';color:' + T.text + ';border:1px solid ' + color + ';' +
          'box-shadow:0 8px 24px rgba(0,0,0,.34);')
        card.appendChild(el('div', 'font-size:10px;font-weight:600;margin-bottom:2px;color:' + color + ';',
          title + ' · ' + it.roomName))
        card.appendChild(el('div', '', it.text))
        card.addEventListener('click', function () {
          currentRoom = it.roomId
          closeToast()
          // 入口按钮在"没有会话"时不存在，openPanel 已能处理无锚点（退回右上角）
          var anchor = document.getElementById(BTN_ID)
          if (document.getElementById(PANEL_ID) === null) openPanel(anchor)
          else { invalidatePanel(); refresh() }
        })
        wrap.appendChild(card)
      })
      var close = el('button', S.btn, '知道了')
      close.style.alignSelf = 'flex-end'
      close.addEventListener('click', closeToast)
      wrap.appendChild(close)
      document.body.appendChild(wrap)
      window.setTimeout(closeToast, 20000)
    }

    /** 只弹没弹过的。首帧（silent）只登记不打扰。 */
    function notifyProblems(rooms, options) {
      var found = collectProblems(rooms)
      if (found.length === 0) return
      var seen = loadNotified()
      var seenSet = {}
      for (var i = 0; i < seen.length; i++) seenSet[seen[i]] = true
      var fresh = []
      for (var j = 0; j < found.length; j++) {
        if (seenSet[found[j].key] === true) continue
        fresh.push(found[j])
        seen.push(found[j].key)
      }
      if (fresh.length === 0) return
      saveNotified(seen)
      if (options !== undefined && options.silent === true) return
      showToast(fresh)
    }

    /** 按住标题栏拖动面板；用 pointer 事件，鼠标与触屏同一条路径。 */
    function makeDraggable(panel, handle) {
      handle.addEventListener('pointerdown', function (e) {
        if (e.button !== 0 && e.pointerType === 'mouse') return
        var rect = panel.getBoundingClientRect()
        var offX = e.clientX - rect.left
        var offY = e.clientY - rect.top
        dragging = true
        try { handle.setPointerCapture(e.pointerId) } catch (err) {}

        function move(ev) {
          var p = clampPos(ev.clientX - offX, ev.clientY - offY)
          panel.style.left = Math.round(p.left) + 'px'
          panel.style.top = Math.round(p.top) + 'px'
        }
        function done() {
          dragging = false
          try { handle.releasePointerCapture(e.pointerId) } catch (err) {}
          handle.removeEventListener('pointermove', move)
          handle.removeEventListener('pointerup', done)
          handle.removeEventListener('pointercancel', done)
          panelPos = {
            left: parseInt(panel.style.left, 10) || 0,
            top: parseInt(panel.style.top, 10) || 0,
            width: parseInt(panel.style.width, 10) || 0,
            height: parseInt(panel.style.height, 10) || 0,
          }
          savePanelPos(panelPos)
          refresh() // 拖动期间刷新被暂停了，结束后补一次
        }
        handle.addEventListener('pointermove', move)
        handle.addEventListener('pointerup', done)
        handle.addEventListener('pointercancel', done)
        e.preventDefault()
      })
    }

    /**
     * 抽屉开合。**只改 transform / visibility，不重渲染** ——
     * 重渲染会换掉整个节点，不值当（而且那正是滚动位置最容易出事的时刻）。
     */
    function applyDrawer(panel, open) {
      var drawer = panel._drawer
      if (!drawer) return
      var isOpen = open === undefined ? panel._drawerOpen === true : open === true
      panel._drawerOpen = isOpen
      drawer.style.transform = isOpen ? 'translateX(0)' : 'translateX(101%)'
      // 关着的时候不能接走点击与 tab（否则"看不见的东西"会吃掉落到那一侧的交互）
      drawer.style.visibility = isOpen ? 'visible' : 'hidden'
    }

    function createPanel() {
      var panel = el('div', S.panel)
      panel.id = PANEL_ID
      panel.setAttribute('role', 'dialog')
      var head = el('div', S.head)
      // 标题吃掉剩余宽度，把「抽屉」「拖动」「关闭」一起挤到右边
      head.appendChild(el('span', 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', '会话聊天室'))
      // 自诊断：只在"最近 5 分钟里有异常"时出现（平时一个字都不占）
      var diagBits = []
      var diagRepaint = recentMax('repaint')
      if (diagRepaint >= 100) diagBits.push('重绘 ' + Math.round(diagRepaint) + 'ms')
      var diagRpc = recentMax('rpc')
      if (diagRpc >= 500) diagBits.push('拉取 ' + Math.round(diagRpc) + 'ms')
      // 停摆：显示的是**最近 5 分钟窗口内**的次数与最坏值，并带上最近一次是什么时候 ——
      // "17.5s×3/5分 · 4 分钟前" 能直接回答"还在发生吗"；旧的累计计数回答不了。
      var jank = recentJank(jankLog)
      if (jank.count > 0 && jank.ms >= 600) {
        diagBits.push('停摆 ' + (jank.ms / 1000).toFixed(1) + 's×' + jank.count + '/5分'
          + (jank.mine === true ? '(重建中)' : '(非我)') + ' · ' + ago(jank.at))
      }
      // 重绘频率：正常是每分钟十几次（轮询间隔 4 秒）。几十上百 = 有环在转。
      var rate = renderRate()
      if (rate > 20) diagBits.push('重绘 ' + rate + '次/分')
      if (diagBits.length > 0) {
        var warnEl = el('span', 'color:' + T.warn + ';font-size:10px;white-space:nowrap;',
          '⚠ ' + diagBits.join(' · '))
        // 悬停看"这辈子一共几次、最坏多久" —— 窗口值回答"现在还在发生吗"，
        // 累计值回答"这是新问题还是老问题"，两个问题不一样，别混成一个数。
        warnEl.title = '自本页加载以来共 ' + jankTotal + ' 次停摆，最坏 '
          + (jankAllWorstMs / 1000).toFixed(1) + 's；上面显示的是最近 5 分钟'
        head.appendChild(warnEl)
      }
      head.appendChild(el('span', S.grip, '⠿ 拖动'))
      // 侧面抽屉开关（真机反馈 2026-09-14：成员/邀请和聊天混在一起不好用）
      var drawerBtn = el('button', S.icon, '☰')
      drawerBtn.type = 'button'
      drawerBtn.title = '成员与邀请（侧面抽屉）'
      drawerBtn.setAttribute('aria-label', '打开成员与邀请抽屉')
      drawerBtn.addEventListener('pointerdown', function (e) { e.stopPropagation() })
      drawerBtn.addEventListener('click', function (e) {
        e.stopPropagation()
        applyDrawer(panel, panel._drawerOpen !== true)
        // 抽屉里放着"邀请加入"，打开时把候选拉一次新的（收起时不再轮询它）
        if (panel._drawerOpen === true) reload()
      })
      head.appendChild(drawerBtn)
      // 关闭按钮（真机反馈 2026-09-12：原来只能按 Esc 或点面板外面，没人找得到）
      var closeBtn = el('button', S.icon, '×')
      closeBtn.type = 'button'
      closeBtn.title = '关闭（Esc）'
      closeBtn.setAttribute('aria-label', '关闭聊天室面板')
      // 头部同时是拖动把手 —— 不放行 pointerdown 的话，按「关闭」会变成「拖一下」
      closeBtn.addEventListener('pointerdown', function (e) { e.stopPropagation() })
      closeBtn.addEventListener('click', function (e) { e.stopPropagation(); closePanel() })
      head.appendChild(closeBtn)
      panel.appendChild(head)
      head.title = '成员自己决定回不回；只有「人的发言」和「@ 提及」才要求每个在房间的成员回一句判断。'
      // 头部**不再随内容滚动**（它是壳的第一个子节点、壳自己不滚）—— 这就是"滚到新消息处抓不住窗口"的修法
      makeDraggable(panel, head)

      var body = el('div', S.body)
      panel.appendChild(body)
      panel._content = body

      var drawer = el('div', S.drawer)
      var drawerHead = el('div', S.drawerHead)
      drawerHead.appendChild(el('span', 'flex:1;min-width:0;', '成员与邀请'))
      var drawerClose = el('button', S.icon, '×')
      drawerClose.type = 'button'
      drawerClose.title = '收起抽屉'
      drawerClose.addEventListener('click', function () { applyDrawer(panel, false) })
      drawerHead.appendChild(drawerClose)
      drawer.appendChild(drawerHead)
      panel.appendChild(drawer)
      panel._drawer = drawer
      applyDrawer(panel, false)
      return panel
    }

    function openPanel(anchor) {
      closePanel()
      var panel = createPanel()
      document.body.appendChild(panel)
      // 没有锚点（比如从弹窗打开、或当前没有会话）时退回右上角
      var rect = anchor !== null && anchor !== undefined && typeof anchor.getBoundingClientRect === 'function'
        ? anchor.getBoundingClientRect()
        : { left: window.innerWidth - 400, width: 0, bottom: 52, top: 0 }
      // 拖动过的面板要回到它被放下的地方，而不是每次弹回按钮旁边。
      var saved = panelPos || loadPanelPos()
      var left = saved !== null ? saved.left
        : Math.min(Math.max(8, rect.left + rect.width / 2 - 190), Math.max(8, window.innerWidth - 388))
      var top = saved !== null ? saved.top : rect.bottom + 6
      if (saved === null && top + 320 > window.innerHeight) top = Math.max(8, rect.top - 330)
      var placed = clampPos(left, top)
      panel.style.top = Math.round(placed.top) + 'px'
      panel.style.left = Math.round(placed.left) + 'px'
      // 记住用户拖出来的尺寸（CSS resize 改的是 style.width/height）
      if (saved !== null && saved.width > 0) panel.style.width = saved.width + 'px'
      if (saved !== null && saved.height > 0) panel.style.height = saved.height + 'px'

      var outside = function (e) {
        if (panel.contains(e.target)) return
        if (e.target === anchor || anchor.contains(e.target)) return
        closePanel()
      }
      var key = function (e) { if (e.key === 'Escape') closePanel() }
      panel._outside = outside
      panel._key = key
      window.setTimeout(function () { document.addEventListener('click', outside) }, 0)
      document.addEventListener('keydown', key)

      // createPanel() 给的是一具空壳，而 refresh() 有指纹闸门（数据没变就不重画）——
      // 所以先用手里那份快照立刻画一帧，别让人盯着空白等下一次数据变化。
      if (lastState !== null) render()
      refresh()
      // 4 秒（原来 2 秒）：真机 2026-09-14 那次 17.8 秒的主线程停摆之后，
      // 先把它自己的重活减半 —— 房间消息是给人看的，4 秒的新鲜度足够。
      pollTimer = window.setInterval(refresh, 4000)
    }

    function closePanel() {
      if (pollTimer !== null) { window.clearInterval(pollTimer); pollTimer = null }
      var p = document.getElementById(PANEL_ID)
      if (!p) return
      if (p._outside) document.removeEventListener('click', p._outside)
      if (p._key) document.removeEventListener('keydown', p._key)
      p.remove()
    }

    function togglePanel(anchor) {
      if (document.getElementById(PANEL_ID)) { closePanel(); return }
      openPanel(anchor)
    }

    // ---- 渲染 ------------------------------------------------------------

    /** 分开存：谁先回来谁先画（房间是主内容，候选只影响「邀请」那一块）。 */
    var lastRooms = null
    var lastCandidates = null

    /**
     * 画一帧（用当前手上的 rooms + candidates）。
     * rooms 为 null 表示还没拿到过房间数据 —— 那就不画，免得出现「还没有房间」的假象。
     */
    function paint() {
      var old = document.getElementById(PANEL_ID)
      if (!old || lastRooms === null) return
      var next = lastRooms
      next.candidates = lastCandidates === null ? [] : lastCandidates.candidates
      // hidden 也要带上：它是「为什么少了几个」的说明（子代理 / 归档各隐藏了多少）
      next.hidden = lastCandidates === null ? undefined : lastCandidates.hidden
      // 推送判定要在渲染闸门**之前** —— 否则「没变化就不重渲染」会把通知一起吞掉
      notifyProblems(next.rooms || [], { silent: notifyPrimed !== true })
      notifyPrimed = true
      // 指纹挂在**这一个 DOM 节点**上，不再是模块级变量：
      // openPanel() 每次都新建一具空壳，模块级的「我画过什么」会把新空壳误判成已画过 ——
      // 于是「关掉再打开」永远停在空白，直到数据变化（真机反馈 2026-09-12）。
      if (!shouldRepaint(old, signatureOf(next))) return // 数据没变 → 一个节点都不动
      lastState = next
      render()
    }

    function refresh() {
      // 自愈：组字**冻住**会把每一次重画（render/refresh）都挡掉，表现与"按钮按不了"一模一样。
      // 组字中的元素一旦被换掉/移除，浏览器不保证再补 compositionend —— 所以这里兜一道：
      // 元素已经不在文档里 = 那次组字不可能还在继续。
      if (composing === true && composingEl !== null && !document.contains(composingEl)) {
        composing = false
        composingEl = null
      }
      // **看不见的窗口不轮询**（真机反馈 2026-09-14：会话内发消息要等近 10 秒）。
      // 页面在后台时没人看这份画面，没有理由每 2 秒拉一次整份 state（1.5 MB）；
      // 回到前台由 visibilitychange 补一次，不丢任何东西。
      if (POLLS_ENABLED !== true) return
      if (document.hidden === true) return
      // 你正在打字/正要发送 → 让路（见 userIsTyping 的注释：用户自测关掉面板延迟就消失）
      if (userIsTyping()) return
      // 拖动 / 输入法组字期间不重渲染：swap() 会换掉整个 DOM 节点 ——
      // 拖到一半的面板会当场断手，打到一半的字会当场丢。
      if (renderBlocked(dragging, composing)) return
      // **分开取、谁先到谁先画**。原来是 Promise.all 等齐再画一次 ——
      // 结果 candidates 一慢（真机 20 秒：它要为几百个会话取标题），整个面板就跟着空白 20 秒，
      // 看上去跟"坏了"没区别。房间是主内容，候选只影响「邀请」那一块，没有理由拖着房间一起等。
      // （「半份数据」那条老教训针对的是"有候选、没房间"——所以这里仍然要求 rooms 先到才画。）
      var diagRpcT0 = performance.now()
      rpc('state').then(function (stateRes) {
        noteDiag('rpc', performance.now() - diagRpcT0)
        if (!document.getElementById(PANEL_ID)) return
        if (stateRes.ok !== true) return // 取失败就保留上一次的画面，不闪
        lastRooms = stateRes.value
        paint()
      })
      // 候选（唯一会扫会话目录、读标题的接口）**只在真的要看时才拉**：
      // 抽屉开着、或邀请那块展开了、或还没有过一份。收起来的抽屉里没有理由每 2 秒扫一次磁盘。
      var liveNode = document.getElementById(PANEL_ID)
      var wantsCandidates = lastCandidates === null ||
        (liveNode !== null && liveNode._drawerOpen === true) ||
        pick.open === true
      if (!wantsCandidates) return
      rpc('candidates').then(function (candRes) {
        if (!document.getElementById(PANEL_ID)) return
        lastCandidates = candRes.ok === true ? candRes.value : null
        paint()
      })
    }

    /** 最近一分钟内的重绘次数（诊断：循环重绘会把这个数打到几十上百）。 */
    var renderTimes = []
    function noteRenderTime() {
      var now = Date.now()
      renderTimes.push(now)
      while (renderTimes.length > 0 && now - renderTimes[0] > 60000) renderTimes.shift()
      return renderTimes.length
    }
    /** 上一分钟重绘次数。 */
    function renderRate() {
      var now = Date.now()
      while (renderTimes.length > 0 && now - renderTimes[0] > 60000) renderTimes.shift()
      return renderTimes.length
    }

    function render() {
      var diagT0 = performance.now()
      // **重绘节流**：400 ms 内不重复重建。任何"重绘触发重绘"的环都会在这里被切断 ——
      // 真机 2026-09-14 那次几分钟的主线程占满，形态就是这类环。
      if (lastRenderAt !== 0 && diagT0 - lastRenderAt < 400) {
        return
      }
      lastRenderAt = diagT0
      noteRenderTime()
      renderInFlight = true
      // 直接重画（切房间、交互回执）也走同一道闸门：组字期间换节点 = 输入法当场断掉
      if (renderBlocked(dragging, composing)) { renderInFlight = false; return }
      var old = document.getElementById(PANEL_ID)
      if (!old) { renderInFlight = false; return }
      // old 正挂在 DOM 上 —— 此刻量它的背景色才是真实渲染色（新节点还没进树）
      themeScheme = schemeOf(old)
      var draft = captureDrafts(old)
      var panel = createPanel()
      panel.style.colorScheme = themeScheme
      // 抽屉开着吗？状态**挂在节点上**（同 _signature 的道理）：重渲染换节点时跟着走，
      // 否则每 2 秒的轮询重画都会把抽屉弹回去。
      panel._drawerOpen = old._drawerOpen === true
      applyDrawer(panel)
      var st = lastState

      if (!st || !st.rooms || st.rooms.length === 0) {
        var empty = panel._content || panel
        empty.appendChild(el('div', S.section, '还没有房间'))
        var mk0 = el('button', S.primary, '新建房间')
        mk0.addEventListener('click', function () {
          var name = window.prompt('房间名称', '变更同步')
          if (name) rpc('create-room', { name: name }).then(reload)
        })
        empty.appendChild(mk0)
        swap(panel, old)
        restoreDrafts(draft)
        panel._signature = signatureOf(lastState) // 记下「我画的是什么」，避免下次轮询白重建一次
        renderInFlight = false
        return
      }

      buildRoom(panel, st)
      swap(panel, old)
      restoreDrafts(draft)
      // 记下「我画的是什么」：currentRoom 可能在 buildRoom 里被纠正过，指纹要以画完的为准。
      panel._signature = signatureOf(lastState)
      // 自己花的这份时间记下来 —— 出问题时"是不是我在占主线程"要能自证
      renderInFlight = false
      noteDiag('repaint', performance.now() - diagT0)
    }

    /**
     * 把当前房间的内容画进给定容器。
     *
     * **浮动面板与会话内的「聊天室」副页共用这一份** —— 两处必须是同一套渲染，
     * 否则「副页里看到的」和「浮窗里看到的」会随着改动慢慢分叉，而那种分叉没人会发现。
     */
    function buildRoom(panel, st) {
      // 两个落点：**聊天流**进内容区，**成员/邀请这类信息**进侧面抽屉。
      // 浮窗是 flex 壳（头部固定、内容区自己滚）+ 抽屉；副页（React 座位）没有这两样，
      // 于是 content = host、drawer = null —— 全部照旧落在它身上，副页一行都不用改。
      // 实现上只是把局部变量 panel 指过去：下面各块的 appendChild 一个字不用动。
      var shell = panel
      var content = panel._content || panel
      var drawer = panel._drawer || null
      panel = content

      var rooms = st.rooms
      var room = null
      for (var i = 0; i < rooms.length; i++) if (rooms[i].room.id === currentRoom) room = rooms[i]
      if (!room) { room = rooms[0]; currentRoom = room.room.id }

      // 顶部状态行 —— 面板最贵的位置只回答一个问题：「现在有没有事」。
      // 只列非零项：全是零的时候它安静成一行「运转中」。
      var attention = attentionOf(room)
      var bar = el('div', 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:4px 6px;margin-bottom:8px;' +
        'border-radius:8px;font-size:11px;background:' + T.hover + ';')
      if (attention.total === 0) {
        bar.appendChild(el('span', 'color:' + T.ok + ';', '● 运转中'))
        bar.appendChild(el('span', S.dim, '无待处理'))
      } else {
        bar.appendChild(el('span', 'color:' + (attention.bad > 0 ? T.bad : T.warn) + ';', '●'))
        if (attention.bad > 0) bar.appendChild(el('span', 'color:' + T.bad + ';', '✗ ' + attention.bad + ' 条与事实不符'))
        if (attention.overdue > 0) bar.appendChild(el('span', 'color:' + T.warn + ';', '⚠ ' + attention.overdue + ' 人逾时'))
        if (attention.pending > 0) bar.appendChild(el('span', S.dim, attention.pending + ' 待表态'))
        if (attention.attentionOnly > 0) bar.appendChild(el('span', S.dim, attention.attentionOnly + ' 人不在房间'))
      }
      // 人数**与上限一起**说：这个上限原来只在撞到 room is full 时才被看见（真机反馈 2026-09-14）
      bar.appendChild(el('span', S.dim,
        room.members.filter(function (m) { return m.inRoom }).length + '/' + room.room.policy.maxMembers + ' 名成员'))
      panel.appendChild(bar)

      // 房间切换（带角标：不用点开就知道哪个房间有事）
      var tabs = el('div', 'display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px;')
      rooms.forEach(function (r) {
        var n = attentionOf(r).total
        var b = el('button', S.btn, r.room.name + (n > 0 ? ' ●' + n : ''))
        if (r.room.id === currentRoom) {
          b.style.fontWeight = '700'
          b.style.color = T.text
          b.style.borderColor = T.border
        }
        if (n > 0) b.style.color = attentionOf(r).bad > 0 ? T.bad : T.warn
        b.addEventListener('click', function () { currentRoom = r.room.id; render() })
        tabs.appendChild(b)
      })
      var add = el('button', S.btn, '＋')
      add.title = '新建房间'
      add.addEventListener('click', function () {
        var name = window.prompt('房间名称', '变更同步')
        if (!name) return
        rpc('create-room', { name: name }).then(function (res) {
          if (res.ok !== true) { reportFailure('新建房间', res); return }
          reload()
        })
      })
      tabs.appendChild(add)
      var exp = el('button', S.btn, '导出')
      exp.title = '把房间历史（成员 / 变更与核验 / 完整时间线）导出为 Markdown'
      exp.addEventListener('click', function () {
        rpc('export', { roomId: room.room.id }).then(function (res) {
          if (res.ok !== true) { window.alert('导出失败：' + (res.error && res.error.message)); return }
          downloadText((res.value.name || 'chatroom') + '.md', res.value.markdown)
        })
      })
      tabs.appendChild(exp)
      var del = el('button', S.btn, '删除')
      del.style.color = T.bad
      del.title = '删除当前房间'
      del.addEventListener('click', function () {
        if (!window.confirm('删除房间「' + room.room.name + '」？\n\n'
          + '成员与已读游标会一并移除；已写进各成员会话日志的房间消息不受影响。')) return
        rpc('remove-room', { roomId: room.room.id }).then(function (res) {
          if (res.ok !== true) { window.alert('删除失败：' + (res.error && res.error.message)); return }
          currentRoom = null
          reload()
        })
      })
      tabs.appendChild(del)
      panel.appendChild(tabs)

      // 成员与邀请**搬进抽屉**（真机反馈 2026-09-14：这两块和聊天流混在一起不好用）。
      // 没抽屉的副页就留在流里 —— 行为与从前逐字相同。
      if (drawer !== null) panel = drawer
      panel.appendChild(el('div', S.section, '成员（' + room.members.length + '）'))
      room.members.forEach(function (m) {
        var row = el('div', S.row)
        var left = el('div', 'flex:1;min-width:0;')
        left.appendChild(el('div', '', m.title || '(无标题会话)'))
        // 成员自述的「设计方向」独立成行：问「谁改了文件」之前，先看「谁在负责什么」。
        var dir = directionLineOf(m)
        if (dir.text !== '') {
          left.appendChild(el('div', 'font-size:11px;line-height:1.45;margin-top:1px;color:' + T.biz + ';', dir.text))
        }
        // 机器读的边界单独一行：它才是「改动会不会叫醒这个人」的依据
        // （方向散文曾被静默截断到 200 字，本房间 6 人里 3 人顶格 —— 真机 2026-09-16）
        if (dir.bound !== '') {
          left.appendChild(el('div', 'font-size:10px;line-height:1.4;color:' + T.text3 + ';', dir.bound))
        }
        if (dir.text === '' && dir.bound === '') {
          // 没有边界的成员要显眼：它是「谁负责什么」这张图上的一个洞，
          // 也正是别人可能越界的原因（真机反馈 2026-09-12）。
          left.appendChild(el('div', S.warn, '⚠ 未声明边界 —— 任何同工作区改动都会叫醒它；它也说不清该不该动'))
        }
        left.appendChild(el('div', S.weak, '[' + (m.roleName ? m.roleName + ' · ' : '') + m.shortId + ']'
          + ' 已读 ' + m.lastReadSeq
          + owedLabel(m, room.targetSeq)
          + (m.verdict ? ' · 已表态 ' + (VERDICT_LABEL[m.verdict] || m.verdict) : '')))
        if (!m.inRoom) left.appendChild(el('div', S.warn, '⚠ 未在房间（用户已关闭）— 不要等它的回执'))
        row.appendChild(left)
        var locM = el('button', S.btn, '定位')
        locM.title = '在 DSH 里打开这个会话'
        locM.addEventListener('click', function () { openSession(m.sessionId) })
        row.appendChild(locM)
        var tg = el('button', S.btn, m.inRoom ? '移出' : '加入')
        tg.addEventListener('click', function () {
          rpc('set-enabled', { roomId: room.room.id, sessionId: m.sessionId, enabled: !m.inRoom }).then(function (res) {
            if (res.ok !== true) { reportFailure(m.inRoom ? '移出成员' : '重新启用成员', res); return }
            reload()
          })
        })
        row.appendChild(tg)
        panel.appendChild(row)
      })

      // 房间策略：上限在抽屉里可见可改（真机反馈 2026-09-14：撞到 room is full 才发现有个上限）
      panel.appendChild(el('div', S.section, '房间策略'))
      var policyRow = el('div', 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:4px;')
      var numField = function (label, value, title) {
        var wrap = el('label', 'display:flex;align-items:center;gap:4px;font-size:11px;color:' + T.text2 + ';')
        wrap.appendChild(el('span', '', label))
        var input = el('input', 'width:54px;height:22px;box-sizing:border-box;padding:0 4px;border-radius:6px;' +
          'border:1px solid ' + T.borderSoft + ';background:transparent;color:inherit;font-family:inherit;font-size:11px;')
        input.type = 'number'
        input.min = '1'
        input.value = String(value)
        input.title = title
        input.setAttribute('data-draft', label) // 重渲染时不冲掉正在输的值
        wrap.appendChild(input)
        return { wrap: wrap, input: input }
      }
      var maxField = numField('成员上限', room.room.policy.maxMembers, '一间房最多几个会话（1..64）')
      var budgetField = numField('线程预算', room.room.policy.threadBudget, '一条线程最多几跳（1..32）')
      policyRow.appendChild(maxField.wrap)
      policyRow.appendChild(budgetField.wrap)
      var savePolicy = el('button', S.btn, '保存')
      savePolicy.title = '改完立即生效'
      savePolicy.addEventListener('click', function () {
        savePolicy.disabled = true
        rpc('set-policy', {
          roomId: room.room.id,
          maxMembers: maxField.input.value,
          threadBudget: budgetField.input.value,
        }).then(function (res) {
          savePolicy.disabled = false
          // 非法值由服务端拒绝（不夹取）—— 原话带出来，别让人以为设上了
          if (res.ok !== true) { reportFailure('改房间策略', res); return }
          reload()
        })
      })
      policyRow.appendChild(savePolicy)
      panel.appendChild(policyRow)
      panel.appendChild(el('div', S.weak,
        '成员上限 = 一间房最多几个会话；线程预算 = 一条线程最多几跳。把上限调到低于当前人数不会踢人，只是暂时加不进新成员。'))

      // 邀请成员：**默认收起**。
      // 原先把整个会话语料平铺出来是偷懒 —— 几十个会话糊满一屏，真正要选的那个反而找不到。
      // 现在是一颗按钮 + 一个可搜索的选择器，一次只露几条。
      var cands = (st.candidates || []).filter(function (c) {
        return !room.members.some(function (m) { return m.sessionId === c.sessionId })
      })
      var addRow = el('div', 'display:flex;gap:6px;align-items:center;margin:6px 0 2px;')
      var openBtn = el('button', S.btn, (pick.open ? '▾ ' : '▸ ') + '邀请会话加入（' + cands.length + ' 个可选）')
      openBtn.addEventListener('click', function () {
        pick.open = !pick.open
        // 收起即清筛选（排序保留 —— 那是偏好，不是临时筛选）
        if (!pick.open) { pick.query = ''; pick.workspace = '' }
        redraw()
      })
      addRow.appendChild(openBtn)
      panel.appendChild(addRow)

      if (pick.open) {
        var search = el('input', 'width:100%;box-sizing:border-box;height:24px;padding:0 6px;margin:4px 0 6px;' +
          'border-radius:6px;border:1px solid ' + T.borderSoft + ';background:transparent;color:inherit;' +
          'font-family:inherit;font-size:12px;')
        search.setAttribute('data-draft', 'pick')
        search.placeholder = '按标题 / 工作区 / 短号筛选…'
        search.value = pick.query
        search.addEventListener('input', function (e) {
          pick.query = search.value
          // 组字中（候选窗还开着）绝不重建：节点一换，输入法就断在这里。
          // 组字结束后由 compositionend 的 reload() 把过滤结果补上。
          if (composing === true || (e !== undefined && e.isComposing === true)) return
          redraw()
        })
        panel.appendChild(search)

        // 工作区筛选：候选常常横跨十几个工作区，光靠搜索框得先知道那个工作区叫什么名字。
        // 用**下拉**而不是芯片：工作区一多芯片就把面板顶部糊满了（真机反馈 2026-09-12）。
        var spaces = workspaceBuckets(cands)
        // 选中的工作区可能已经不在候选里了（会话被加进房间 / 归档 / 换了房间）→ 自动回到「全部」
        if (pick.workspace !== '' && !spaces.some(function (s) { return s.cwd === pick.workspace })) pick.workspace = ''
        var ctrlRow = el('div', 'display:flex;gap:6px;align-items:center;margin:0 0 6px;')
        var wsSel = el('select', S.select)
        wsSel.style.colorScheme = themeScheme // 不给它，弹出的就是系统默认浅色菜单
        wsSel.setAttribute('data-draft', 'ws')
        wsSel.title = '按工作区筛选'
        wsSel.appendChild(optionEl('', '全部工作区（' + cands.length + '）'))
        spaces.forEach(function (w) {
          wsSel.appendChild(optionEl(w.cwd, w.label + '（' + w.count + '）'))
        })
        wsSel.value = pick.workspace
        wsSel.addEventListener('change', function () { pick.workspace = wsSel.value; redraw() })
        ctrlRow.appendChild(wsSel)
        var sortSel = el('select', S.select)
        sortSel.style.colorScheme = themeScheme
        sortSel.setAttribute('data-draft', 'sort')
        sortSel.title = '排序方式'
        SORTS.forEach(function (s) { sortSel.appendChild(optionEl(s.id, s.label)) })
        sortSel.value = pick.sort
        sortSel.addEventListener('change', function () { pick.sort = sortSel.value; redraw() })
        ctrlRow.appendChild(sortSel)
        panel.appendChild(ctrlRow)

        var q = pick.query.trim().toLowerCase()
        var hits = sortCandidates(filterCandidates(cands, pick.query, pick.workspace), pick.sort)
        // 选了工作区就等于缩小了范围，这时多露几条；纯关键词仍然只露 12 条
        var limit = pick.workspace !== '' ? 12 : (q === '' ? 5 : 12)
        if (hits.length === 0) {
          panel.appendChild(el('div', S.weak, '没有匹配的会话。'))
        } else {
          hits.slice(0, limit).forEach(function (c) {
            var row = el('div', S.row)
            row.appendChild(avatarEl({ sender: { sessionId: c.sessionId } }))
            var left = el('div', 'flex:1;min-width:0;')
            left.appendChild(el('div', '', c.title || '(无标题会话)'))
            var state = c.live ? (c.status === 'running' ? '运行中' : '空闲') : '休眠'
            // 「最近活动」= 最后一次 prompt 的距今时间 —— DSH 自己的会话列表就在名字旁边显示它
            var when = ago(typeof c.lastActivityAt === 'number' && c.lastActivityAt > 0 ? c.lastActivityAt : c.createdAt)
            left.appendChild(el('div', S.weak,
              (c.workspace ? c.workspace + ' · ' : '') + c.shortId + ' · ' + state + (when === '' ? '' : ' · ' + when)))
            row.appendChild(left)
            var locC = el('button', S.btn, '定位')
            locC.title = '在 DSH 里打开这个会话'
            locC.addEventListener('click', function () { openSession(c.sessionId) })
            row.appendChild(locC)
            var j = el('button', S.btn, '加入')
            j.addEventListener('click', function () {
              rpc('join', { roomId: room.room.id, sessionId: c.sessionId }).then(function (res) {
                if (res.ok !== true) { reportFailure('加入会话', res); return }
                reload()
              })
            })
            row.appendChild(j)
            panel.appendChild(row)
          })
          if (hits.length > limit) {
            panel.appendChild(el('div', S.weak, '还有 ' + (hits.length - limit) + ' 个 —— 输入关键词缩小范围。'))
          }
        }
        // 「为什么少了几个」要说出来：东西不见了却不知道为什么，是最难查的那种反馈。
        var hidden = st.hidden
        if (hidden !== undefined && hidden !== null && (hidden.subagents > 0 || hidden.archived > 0)) {
          var bits = []
          if (hidden.subagents > 0) bits.push(hidden.subagents + ' 个子代理会话')
          if (hidden.archived > 0) bits.push(hidden.archived + ' 个已归档会话')
          panel.appendChild(el('div', S.weak, '已隐藏 ' + bits.join('、') + '（子代理在 DSH 自己的会话列表里也看不到）'))
        }
      }

      // 抽屉到此为止：下面是聊天流（消息 / 待表态 / 发言）
      panel = content

      // 变更**不再是独立区块** —— 它就是消息流里的一种消息（真机反馈后定的第三条路）。
      // 原来同一件事在「变更」区和消息流里各出现一次，两处信息还不一样（一处有三态+diff，
      // 一处有 markdown 正文），人得自己在脑子里拼起来。现在只剩一条可读的对话。
      var changeBySeq = {}
      ;(room.changes || []).forEach(function (c) { changeBySeq[c.seq] = c })
      var judgedBySeq = {}
      ;(room.judgments || []).forEach(function (j) {
        judgedBySeq[j.seq] = judgedBySeq[j.seq] || {}
        judgedBySeq[j.seq][j.sessionId] = j.verdict
      })

      // 消息 —— 群聊式：同一个人的连续消息归成一组，组头（头像 + 名字 + 时刻）只出现一次。
      // 原来每条都挂「序号 · 类型 · 终端」，读起来像日志；群聊里那些是噪声，
      // 只在真有额外信息（终端回执 / 预算耗尽）时才提一句。
      var shown = room.messages.slice(-40)
      var readSeq = readSeqOf(room.room.id)
      // 计数按**全部消息**算（不是这 40 条切片）：未读 12 条、切片里只装得下 40 条时，
      // 说"3 条未读"就是在骗人。分界线只画在切片里，切不到的由计数代表。
      var unread = unreadOf(room.messages, readSeq)
      var newestSeq = shown.length > 0 ? Number(shown[shown.length - 1].seq) || 0 : 0
      var firstUnreadSeq = unread.length > 0 ? Number(unread[0].seq) || 0 : 0
      var titleEl = el('div', S.section, '消息（最近 ' + shown.length + ' 条'
        + (unread.length > 0 ? ' · ' + unread.length + ' 条未读' : '') + '）')
      panel.appendChild(titleEl)
      // 未读分界：只在真有未读时插一条，位置就在第一条未读之前
      var divider = unread.length > 0
        ? el('div', 'display:flex;align-items:center;gap:8px;margin:10px 0 4px;')
        : null
      if (divider !== null) {
        divider.appendChild(el('div', 'flex:1;height:1px;background:' + T.bad + ';opacity:.5;'))
        divider.appendChild(el('div', 'font-size:10px;font-weight:600;color:' + T.bad + ';',
          '以下 ' + unread.length + ' 条未读'))
        divider.appendChild(el('div', 'flex:1;height:1px;background:' + T.bad + ';opacity:.5;'))
      }
      var lastKey = null
      var lastTs = 0
      shown.forEach(function (m) {
        var key = senderKey(m)
        var isUser = key === 'user'
        // 未读分界线：落在"第一条未读"之前（时间断层线之后也照样插，两者不冲突）
        if (divider !== null && firstUnreadSeq !== 0 && Number(m.seq) === firstUnreadSeq) {
          panel.appendChild(divider)
          lastKey = null
        }
        // 变更声明在流里也是一个气泡 —— 它的核验结论决定这条的视觉重量
        var changeRec = m.kind === 'change-notice' ? changeBySeq[m.seq] : undefined
        var isBad = changeRec !== undefined && changeRec.verdict === 'contradicted'

        // 时间断层：间隔够大就插一条分隔线，长流里这是唯一的时间感
        if (lastTs !== 0 && m.ts - lastTs > 30 * 60 * 1000) {
          var sep = el('div', 'display:flex;align-items:center;gap:8px;margin:12px 0 8px;')
          sep.appendChild(el('div', 'flex:1;height:1px;background:' + T.borderSoft + ';'))
          sep.appendChild(el('div', S.weak, clockOf(m.ts)))
          sep.appendChild(el('div', 'flex:1;height:1px;background:' + T.borderSoft + ';'))
          panel.appendChild(sep)
          lastKey = null
        }

        var grouped = key === lastKey && m.ts - lastTs <= GROUP_GAP_MS && m.kind !== 'alert'
        lastKey = key
        lastTs = m.ts

        var row = el('div', 'display:flex;gap:7px;' + (isUser ? 'flex-direction:row-reverse;' : '') +
          (grouped ? 'margin-bottom:1px;' : 'margin:9px 0 1px;'))
        row.appendChild(grouped ? el('div', 'flex:none;width:22px;') : avatarEl(m))
        var col = el('div', 'flex:1;min-width:0;display:flex;flex-direction:column;' + (isUser ? 'align-items:flex-end;' : ''))
        if (!grouped) {
          var head = el('div', 'display:flex;gap:6px;align-items:baseline;margin-bottom:2px;')
          head.appendChild(el('span', 'font-size:11px;font-weight:600;color:' + T.text + ';', displayNameOf(m, room)))
          head.appendChild(el('span', S.weak, clockOf(m.ts)))
          col.appendChild(head)
        }

        // 紧急打断整条横幅 —— 它不该缩在气泡里跟闲聊混在一起
        if (m.kind === 'alert') {
          var banner = el('div', 'width:100%;box-sizing:border-box;padding:5px 8px;border-radius:8px;font-size:12px;' +
            'color:' + T.warn + ';border:1px solid ' + T.warn + ';' + tint(T.warn))
          banner.appendChild(el('div', 'font-size:10px;font-weight:600;margin-bottom:1px;', '⚡ 紧急打断 · 尽力而为、不保证送达'))
          var abody = el('div', 'color:' + T.text + ';')
          renderMarkdown(abody, m.body)
          banner.appendChild(abody)
          col.appendChild(banner)
          row.appendChild(col)
          panel.appendChild(row)
          return
        }

        var box = el('div', 'max-width:88%;box-sizing:border-box;padding:5px 9px;border-radius:10px;' +
          'font-size:12px;line-height:1.55;overflow-wrap:anywhere;' +
          (isBad ? tint(T.bad) + 'border:1px solid ' + T.bad + ';color:' + T.text + ';'
            : isUser ? tint(T.biz) + 'color:' + T.text + ';'
              : 'background:' + T.hover + ';color:' + T.text + ';'))

        // 变更声明：三态徽章 + 文件放最上，正文照常渲染，细节折叠（默认不占地方）
        if (changeRec !== undefined) {
          var v = verdictChip(changeRec.verdict)
          var chipRow = el('div', 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:3px;')
          chipRow.appendChild(el('span', 'font-size:10px;padding:1px 6px;border-radius:999px;white-space:nowrap;' +
            'color:' + v.color + ';' + v.bg, v.text))
          chipRow.appendChild(el('span', S.mono,
            (changeRec.files && changeRec.files.length ? changeRec.files.join('、') : '(未声明文件)').slice(0, 60)))
          box.appendChild(chipRow)
        }

        var body = el('div', 'font-size:12px;line-height:1.55;overflow-wrap:anywhere;color:' + T.text + ';')
        if (m.kind === 'judgment') {
          // 表态体是 "verdict: note"（ASCII 冒号）—— 拆成徽章 + 正文，
          // 注意 note 里可能还有全角「：」，不能拿来当分隔符。
          var raw = String(m.body)
          var cut = raw.indexOf(':')
          var verdict = cut > 0 ? raw.slice(0, cut).trim() : ''
          var note = cut > 0 ? raw.slice(cut + 1).trim() : raw
          if (VERDICT_LABEL[verdict] !== undefined) {
            box.appendChild(el('span', 'display:inline-block;margin-bottom:3px;font-size:10px;padding:1px 6px;' +
              'border-radius:999px;color:' + T.ok + ';' + tint(T.ok), VERDICT_LABEL[verdict]))
          }
          renderMarkdown(body, note)
        } else {
          renderMarkdown(body, m.body)
        }
        box.appendChild(body)
        if (changeRec !== undefined) box.appendChild(changeDetail(changeRec, judgedBySeq[m.seq] || {}))
        // 元信息降级：只在真有额外信息时出现；序号留着供引用，但不再是每条的抬头
        var extra = []
        if (m.terminal) extra.push('终端')
        if (m.budgetStopped) extra.push('预算耗尽')
        if (extra.length > 0) {
          box.appendChild(el('div', 'font-size:10px;margin-top:2px;color:' + T.text3 + ';',
            extra.join(' · ') + ' · #' + m.seq))
        }
        col.appendChild(box)
        row.appendChild(col)
        panel.appendChild(row)
      })

      /**
       * 推进用户侧已读游标，并把"未读"的视觉一次性收掉。
       * 注意它**不改渲染**（只改几个已存在节点的文字/显隐）—— 重渲染会换掉整个面板节点，
       * 那正是滚动位置最容易出事的地方，而这里是"人正看着"的时刻，最不该抖一下。
       */
      function markSeen() {
        if (newestSeq > readSeqOf(room.room.id)) saveReadSeq(room.room.id, newestSeq)
        readSeq = newestSeq
        if (unread.length === 0) return
        unread = []
        titleEl.textContent = '消息（最近 ' + shown.length + ' 条）'
        if (divider !== null) divider.style.display = 'none'
        jump.textContent = '↓ 跳到最新'
      }

      // 「跳到最新」：position:sticky —— 滚上去时钉在窗口底部，已经在底部时自己藏起来。
      // 不用 position:fixed 是因为面板本身可以被拖动/缩放，fixed 得自己去追它的矩形。
      var jump = el('button', S.btn + 'position:sticky;bottom:8px;margin:8px 0 0 auto;display:none;' +
        // width:fit-content 是必需的：块级元素 width:auto 会占满整行，那样 margin-left:auto 就不右对齐了
        'width:fit-content;z-index:5;height:26px;padding:0 12px;border-radius:999px;' +
        'box-shadow:0 2px 10px rgba(0,0,0,.22);background:' + T.text3 + ';color:#fff;font-weight:600;')
      jump.textContent = unread.length > 0 ? '↓ ' + unread.length + ' 条新消息' : '↓ 跳到最新'
      jump.title = '跳到最新消息（到底部即标记为已读）'
      jump.addEventListener('click', function () {
        panel.scrollTop = panel.scrollHeight
        markSeen()
      })
      panel.appendChild(jump)

      // 接线**推迟到挂树之后**：挂树前 scrollHeight/clientHeight 全是 0，"我在上面看历史"
      // 会被误判成"在底部"，未读就被一次性标掉了。所以这里只登记回调。
      // ⚠ 挂在**壳**上，不是内容区：swap() 拿到的是壳。此刻局部变量 panel 已经指向内容区，
      // 所以这里必须用 shell —— 挂错了的表现是"未读永远不会推进/推进了不该推进的"。
      shell._afterMount = function () {
        var update = function () {
          var gap = content.scrollHeight - content.scrollTop - content.clientHeight
          var atBottom = gap <= 24
          jump.style.display = atBottom ? 'none' : 'block'
          if (atBottom) markSeen()
        }
        content.addEventListener('scroll', update)
        update()
      }

      // 待表态要说清「欠的是哪一条」（真机 #1348）：只报人，读的人就只能去猜 seq，
      // 猜不出来就只能再问一次 —— 而重问是主动唤醒别人的高成本动作。
      var pend = pendingRows(room)
      if (pend.target.length > 0) {
        panel.appendChild(el('div', S.section, '待表态（靶子 #' + room.targetSeq + ' —— 会被重新唤醒）'))
        pend.target.forEach(function (line) { panel.appendChild(el('div', S.dim, line)) })
      }
      if (pend.older.length > 0) {
        panel.appendChild(el('div', S.section, '旧账（更早那些没回 —— 不会再被唤醒，补不补由你和用户定）'))
        pend.older.forEach(function (line) { panel.appendChild(el('div', S.dim, line)) })
      }

      // 发言
      panel.appendChild(el('div', S.section, '以「用户」身份发言（@ 短号只叫被点的人；不 @ 则全体必须回一句）'))
      var input = el('textarea', 'width:100%;height:52px;box-sizing:border-box;resize:vertical;padding:6px;' +
        'border-radius:8px;border:1px solid ' + T.borderSoft + ';' +
        'background:transparent;color:inherit;font-family:inherit;font-size:12px;')
      input.setAttribute('data-draft', 'say') // 草稿靠这个标记找回，重渲染不冲掉
      panel.appendChild(input)
      var send = el('button', S.primary, '发送')
      send.style.marginTop = '6px'
      send.addEventListener('click', function () {
        var text = input.value.trim()
        if (text === '') return
        send.disabled = true
        rpc('say', { roomId: room.room.id, text: text }).then(function (res) {
          send.disabled = false
          // 失败时**别清空输入框**：那句话还在人手里，重试不用重打
          if (res.ok !== true) { reportFailure('发送', res); return }
          input.value = ''
          reload()
        })
      })
      panel.appendChild(send)

      // ⚡ 紧急通道（steer）：尽力而为，不保证送达，也不需要回执。
      var alertRow = el('div', 'display:flex;gap:6px;margin-top:8px;align-items:center;')
      var alertInput = el('input', 'flex:1;min-width:0;height:24px;box-sizing:border-box;padding:0 6px;' +
        'border-radius:6px;border:1px solid ' + T.borderSoft + ';' +
        'background:transparent;color:inherit;font-family:inherit;font-size:12px;')
      alertInput.setAttribute('data-draft', 'alert')
      alertInput.placeholder = '⚡ 紧急打断（steer，尽力而为）'
      var alertBtn = el('button', S.btn, '叫停')
      alertBtn.style.color = '#b45309'
      alertBtn.title = '插进所有成员的当前轮次；可能不达，不需要回执'
      alertBtn.addEventListener('click', function () {
        var text = alertInput.value.trim()
        if (text === '') return
        rpc('alert', { roomId: room.room.id, text: text }).then(function (res) {
          alertInput.value = ''
          if (res.ok === true) {
            var ok = res.value.delivered.filter(function (d) { return d.delivered }).length
            alertInput.placeholder = '⚡ 已尽力投出 ' + ok + '/' + res.value.delivered.length + '（不保证送达）'
          }
          reload()
        })
      })
      alertRow.appendChild(alertInput)
      alertRow.appendChild(alertBtn)
      panel.appendChild(alertRow)

      return room
    }

    /** 用新面板替换旧面板，保留滚动位置。 */
    function swap(panel, old) {
      panel.style.top = old.style.top
      panel.style.left = old.style.left
      // 用户拖出来的尺寸要跟着新节点走，否则下一次重渲染就被重置
      if (old.style.width !== '') panel.style.width = old.style.width
      if (old.style.height !== '') panel.style.height = old.style.height
      // 量旧的、进树后再恢复（挂树前赋值会被夹成 0 —— 真机反馈 2026-09-14 的"复位"就是这个）。
      // 滚动容器现在是**内容区**（壳自己不滚），所以量的是它的 _content。
      var anchor = scrollAnchorOf(old._content || old)
      if (old._outside) document.removeEventListener('click', old._outside)
      if (old._key) document.removeEventListener('keydown', old._key)
      var outside = old._outside
      var key = old._key
      panel._outside = outside
      panel._key = key
      old.replaceWith(panel)
      applyScrollAnchor(panel._content || panel, anchor)
      // 挂树之后再跑渲染期的接线（未读游标要在**能量出高度**之后才敢推进）
      if (typeof panel._afterMount === 'function') panel._afterMount()
    }

    // ---- 应用 ------------------------------------------------------------

    /** 副页自己的状态副本（与浮动面板的 lastState 分开，避免互相顶掉）。 */
    var viewState = null
    /** 同上：副页也分开存 rooms / candidates，谁先回来谁先画。 */
    var viewRooms = null
    var viewCandidates = null

    /**
     * 会话内的「聊天室」副页 —— 与 chat / trajectory / waterfall 并列的一个视图标签。
     *
     * 用 React **只是为了拿到座位与生命周期**；内容仍然交给 buildRoom() 画。
     * 为 React 重写一遍渲染就等于维护两份实现，而它们一定会分叉。
     */
    function makeRoomView(React) {
      return function RoomView() {
        var hostRef = React.useRef(null)
        React.useEffect(function () {
          var alive = true
          function draw() {
            var host = hostRef.current
            if (host === null) return
            themeScheme = schemeOf(host) // 副页在 app 里，量它的实际背景（透明时 schemeOf 会退回 body）
            var draft = captureDrafts(host)
            var anchor = scrollAnchorOf(host)
            while (host.firstChild !== null) host.removeChild(host.firstChild)
            if (viewState === null || !viewState.rooms || viewState.rooms.length === 0) {
              host.appendChild(el('div', S.section, '还没有房间'))
              var mk = el('button', S.primary, '新建房间')
              mk.addEventListener('click', function () {
                var name = window.prompt('房间名称', '变更同步')
                if (name) rpc('create-room', { name: name }).then(pull)
              })
              host.appendChild(mk)
              return
            }
            buildRoom(host, viewState)
            restoreDraftsInto(host, draft)
            applyScrollAnchor(host, anchor)
            if (typeof host._afterMount === 'function') host._afterMount()
          }
          function paintView() {
            if (!alive || viewRooms === null) return
            var next = viewRooms
            next.candidates = viewCandidates === null ? [] : viewCandidates.candidates
            next.hidden = viewCandidates === null ? undefined : viewCandidates.hidden
            viewState = next
            notifyProblems(next.rooms || [], { silent: notifyPrimed !== true })
            notifyPrimed = true
            draw()
          }
          function pull() {
            if (POLLS_ENABLED !== true) return // 诊断总闸
            if (document.hidden === true) return // 后台标签页不拉
            if (renderBlocked(dragging, composing)) return // 组字中：别把输入框连同它的组字会话一起换掉
            // 与浮窗同样的道理：分开取，别让慢的 candidates 拖着整个副页不画
            rpc('state').then(function (stateRes) {
              if (!alive || stateRes.ok !== true) return
              viewRooms = stateRes.value
              paintView()
            })
            rpc('candidates').then(function (candRes) {
              if (!alive) return
              viewCandidates = candRes.ok === true ? candRes.value : null
              paintView()
            })
          }
          viewDraw = draw // 让 redraw() 也能驱动副页（切标签、筛选、展开选择器要立刻有反馈）
          viewPull = pull
          pull()
          var timer = window.setInterval(pull, 2000)
          return function () {
            alive = false
            if (viewDraw === draw) viewDraw = null
            if (viewPull === pull) viewPull = null
            window.clearInterval(timer)
          }
        }, [])
        return React.createElement('div', {
          ref: hostRef,
          style: { padding: '10px 14px', height: '100%', overflowY: 'auto', boxSizing: 'border-box' },
        })
      }
    }

    function apply(ctx) {
      clientCtx = ctx
      hostRpc = makeHostRpc(ctx)
      clientLog('apply 已运行：hostRpc=' + (hostRpc !== null ? 'ok' : 'null'))

      // 副页座位：conversation.view（list / session 作用域）——
      // 与 chat、trajectory、waterfall 并列的一个视图标签。
      // 参考实现见 @deepseek-ai/dsh-client-ui-trajectory/lib/client.js:7341。
      try {
        // 注意：不能写 ctx.slots —— cordis 会抛 "cannot get property \"slots\" without inject"。
        // 属性访问受 inject 守卫，而 ctx.get(name) 不受（connection 就是这么拿到的一直能用）。
        var slots
        try {
          slots = ctx.get ? ctx.get('slots') : undefined
        } catch (err) {
          slots = undefined
        }
        if (slots === undefined) {
          try { slots = ctx.slots } catch (err) { slots = undefined }
        }
        var React
        try {
          React = typeof require === 'function' ? require('react') : undefined
        } catch (err) {
          React = undefined
        }
        clientLog('副页诊断：slots=' + (slots === undefined ? 'undefined' : typeof slots)
          + ' hasInject=' + (slots !== undefined && typeof slots.inject === 'function')
          + ' hasRegister=' + (slots !== undefined && typeof slots.register === 'function')
          + ' react=' + (React === undefined || React === null ? 'missing' : typeof React))
        if (slots !== undefined && typeof slots.inject === 'function' && React !== undefined && React !== null) {
          slots.inject('conversation.view', function () {
            return slots.register({
              name: 'conversation.view',
              id: 'chatroom',
              order: 50,
              label: function () { return '聊天室' },
            }, makeRoomView(React))
          })
          clientLog('副页座位已注册：conversation.view#chatroom')
        } else {
          clientLog('副页座位不可用：slots=' + (slots !== undefined) + ' react=' + (React !== undefined && React !== null)
            + '（浮动面板不受影响）')
        }
      } catch (e) {
        // 座位拿不到不影响浮动面板 —— 它是主入口，副页是加成。
        clientLog('副页座位注册失败：' + (e && e.message ? e.message : e))
      }

      // 入口：会话头部动作区（不再挂 composer —— 那是发送按钮的位置）
      try {
        var slotsForEntry = ctx.get ? ctx.get('slots') : undefined
        var ReactForEntry = typeof require === 'function' ? require('react') : undefined
        if (slotsForEntry !== undefined && typeof slotsForEntry.inject === 'function'
          && ReactForEntry !== undefined && ReactForEntry !== null) {
          slotsForEntry.inject('conversation.session.header.actions', function () {
            return slotsForEntry.register({
              name: 'conversation.session.header.actions',
              id: 'chatroom-entry',
              order: 40,
            }, makeRoomEntry(ReactForEntry))
          })
          clientLog('入口已注册：conversation.session.header.actions#chatroom-entry')
        }
      } catch (e) {
        clientLog('入口注册失败：' + (e && e.message ? e.message : e))
      }

      // 主线程卡顿探针：一直开着（每 250 ms 一次，代价可忽略），记录页面停摆的时长与时刻。
      startJankProbe()

      // ⚠ 这里原来挂了一个 focusout → reload()："失焦后补一次刷新"。
      // 它**可能自激**：重绘会换掉整个面板节点 → 若焦点本来在面板里（搜索框/发言框），那次替换就制造
      // 一次 focusout → 又 reload → 又重绘 …… 于是变成几秒～几分钟的主线程占满。
      // 真机 2026-09-14"关掉窗口就秒发、开着窗口卡几分钟"就是这个形状。
      // 让路本身留着（打字时不重绘），但**不再用失焦去触发重画** —— 下一次轮询自然会补上。

      // 输入法组字：开始即冻结重建，结束补一次重画（组字期间被挡掉的过滤结果在这里追上）。
      // 挂 document + 捕获阶段 —— 组字的输入框可能在浮窗里，也可能在副页里，两处都要管。
      document.addEventListener('compositionstart', function (e) {
        composing = true
        composingEl = e.target || null // 记下是谁在组字：它被换掉时要能自愈（见 refresh）
      }, true)
      document.addEventListener('compositionend', function () {
        composing = false
        composingEl = null
        reload()
      }, true)

      // 从后台回来补一次（上面跳过的那些轮询在这里追上）
      document.addEventListener('visibilitychange', function () {
        if (document.hidden !== true) reload()
      })

      window.addEventListener('pagehide', function () {
        closePanel()
        closeToast()
      })
    }

    exports.apply = apply
    // DSH 原生客户端插件都导出 inject 列表（见 ui-jobs/lib/client.js:275）。
    // 声明后 ctx.slots 的属性访问才合法 —— 但**座位访问仍走 ctx.get**，
    // 因为实测 ctx.get(name) 不受 inject 守卫限制，多一条降级路径没有坏处。
    exports.inject = ['slots']
    return module.exports
  },
})
