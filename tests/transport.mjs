/**
 * dsh-chatroom 面板通道传输层测试。
 *
 * 存在的理由（2026-09-11 真机事故）：DSH 升级后 client-connection 把 inject 收缩为
 * ['credentials']，connection.rpc.handle() 内部访问 owner.webServer 必抛异常 ——
 * 通道静默挂不上，浏览器侧只看到 405（请求掉进静态兜底处理器），而宿主日志一片安静。
 * 这个文件把「挂上、且逐分支符合 Connection /api 语义」钉成断言。
 *
 * 不需要启动 DSH：用假 ctx + 假 req/res 驱动真实 apply() 注册出来的路由。
 */
import { Readable } from 'node:stream'
import os from 'node:os'
import path from 'node:path'

process.env.DSH_CHATROOM_HOME = path.join(os.tmpdir(), 'dsh-chatroom-transport-' + Date.now())

const { apply } = await import('../lib/index.js')

let pass = 0
let fail = 0
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra))) }
}

// ---- 假 DSH 服务 ---------------------------------------------------------

const CHANNEL = '/dsh-chatroom'

function fakeReq({ method = 'POST', url = CHANNEL + '/state', headers = { 'content-type': 'application/json' }, body = '', remoteAddress = '127.0.0.1' } = {}) {
  const req = Readable.from(body === '' ? [] : [Buffer.from(body, 'utf8')])
  req.method = method
  req.url = url
  req.headers = headers
  req.socket = { remoteAddress }
  return req
}

function fakeRes() {
  const state = { statusCode: 0, headers: {}, body: '', ended: false }
  return {
    state,
    writeHead(status, headers) { state.statusCode = status; if (headers) Object.assign(state.headers, headers) },
    end(text) { if (text !== undefined && text !== null) state.body += String(text); state.ended = true },
  }
}

function envelope(endpoint, payload = {}, rpcId = 'rpc-1') {
  return JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload })
}

function buildCtx({ withWebServer = true, rejection, loopback = true } = {}) {
  const routes = []
  const legacy = { channel: null, handler: null, options: null }
  const webServer = { register(route) { routes.push(route); return () => {} } }
  const connection = {
    rpc: { handle(channel, handler, options) { legacy.channel = channel; legacy.handler = handler; legacy.options = options; return async () => {} } },
  }
  if (rejection !== undefined) connection.requestRejection = () => rejection
  const ctx = {
    get: (k) => ({
      tools: { register() { return () => {} } },
      systemPrompt: { section() { return () => {} } },
      agents: { get: () => undefined, list: () => [] },
      sessionQuery: { listSessions: async () => [], readTitleSnapshots: async () => [] },
      agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek', model: 'v4' }) },
      agentPresets: { resolve: async () => ({ id: 'standard' }), mount: async () => ({ id: 'standard' }) },
      sessionPersistence: { list: async () => [] },
      connection,
      webServer: withWebServer ? webServer : undefined,
    })[k],
    effect: (fn) => fn(),
    inject: (deps, cb) => { if (deps.includes('connection')) cb({ connection }) },
  }
  if (!loopback) ctx.get = ((orig) => (k) => (k === 'connection' ? { rpc: connection.rpc } : orig(k)))(ctx.get)
  return { ctx, routes, legacy, webServer }
}

// ---- 1. 新版路径：直挂 webServer -----------------------------------------

console.log('1. 新版（≥0.1.5）：通道直挂 webServer，不走 rpc.handle')
const h = buildCtx()
apply(h.ctx)
check('注册了一条路由', h.routes.length === 1, h.routes.length)
check('kind=prefix', h.routes[0] && h.routes[0].kind === 'prefix')
check('path 是通道名', h.routes[0] && h.routes[0].path === CHANNEL)
check('没有调用 rpc.handle（新版那条会抛）', h.legacy.channel === null)

const route = h.routes[0]
async function call(req) { const res = fakeRes(); await route.handler(req, res); return res.state }

console.log('2. 请求分支（逐条对齐 Connection /api 语义）')

const okState = await call(fakeReq({ body: envelope('state') }))
check('POST /state -> 200', okState.statusCode === 200, okState.statusCode)
const okBody = JSON.parse(okState.body)
check('信封 type=server-response', okBody.type === 'server-response')
check('rpcId 原样回带', okBody.rpcId === 'rpc-1')
check('result.ok=true', okBody.result && okBody.result.ok === true)
check('返回 JSON content-type', String(okState.headers['content-type']).startsWith('application/json'))

const wrongMethod = JSON.parse((await call(fakeReq({ body: envelope('nope') }))).body)
check('未知 endpoint -> 仍是 200 + ok:false（与 dsh 同：业务失败不进 4xx）', wrongMethod.result.ok === false)
check('  error.details 是对象（新版客户端解析不了就抛 TypeError）',
  wrongMethod.result.error && typeof wrongMethod.result.error.details === 'object' && wrongMethod.result.error.details !== null,
  wrongMethod.result.error)

const mismatch = await call(fakeReq({ url: CHANNEL + '/state', body: envelope('judge') }))
check('method 与路径不一致 -> ok:false', JSON.parse(mismatch.body).result.ok === false)

const notJson = await call(fakeReq({ body: 'not json' }))
check('非 JSON 体 -> 400', notJson.statusCode === 400, notJson.statusCode)
check('  兜底 rpcId=invalid-request', JSON.parse(notJson.body).rpcId === 'invalid-request')

const badEnvelope = await call(fakeReq({ body: JSON.stringify({ hello: 'world' }) }))
check('信封缺字段 -> 400', badEnvelope.statusCode === 400, badEnvelope.statusCode)

const badType = await call(fakeReq({ headers: { 'content-type': 'text/plain' }, body: envelope('state') }))
check('content-type 不是 json -> 415', badType.statusCode === 415, badType.statusCode)

const getReq = await call(fakeReq({ method: 'GET', body: '' }))
check('GET -> 404（不是 405：405 意味着请求掉进了静态兜底）', getReq.statusCode === 404, getReq.statusCode)

const wrongPath = await call(fakeReq({ url: '/dsh-chatroom-other/state', body: envelope('state') }))
check('路径前缀不匹配 -> 404', wrongPath.statusCode === 404, wrongPath.statusCode)

// 多段 endpoint 在 dsh 的规则里合法（每段非空且字符合法即可）——必须与它一致，
// 否则「复刻 Connection 语义」就变成了自创语义。未知 endpoint 仍按业务失败返回 ok:false。
const multiSegment = await call(fakeReq({ url: CHANNEL + '/a/b', body: envelope('a/b') }))
check('多段 endpoint 合法（与 dsh 一致）-> 200 + ok:false', multiSegment.statusCode === 200 && JSON.parse(multiSegment.body).result.ok === false, multiSegment.statusCode)

const badSegment = await call(fakeReq({ url: CHANNEL + '/bad!seg', body: envelope('bad!seg') }))
check('endpoint 段字符非法 -> 404', badSegment.statusCode === 404, badSegment.statusCode)

console.log('3. 认证栅栏')
const auth = buildCtx({ rejection: 401 })
apply(auth.ctx)
const denied = fakeRes()
await auth.routes[0].handler(fakeReq({ body: envelope('state') }), denied)
check('requestRejection 返回 401 -> 401', denied.state.statusCode === 401, denied.state.statusCode)
check('  拒绝时不返回信封', denied.state.body === 'unauthorized', denied.state.body)

console.log('4. 旧版回退：没有 webServer 时仍走 rpc.handle')
const old = buildCtx({ withWebServer: false })
apply(old.ctx)
check('回退到 rpc.handle', old.legacy.channel === CHANNEL, old.legacy.channel)
check('  沿用 authority=loopback', old.legacy.options && old.legacy.options.authority === 'loopback')
check('  回退路径的 handler 可用', typeof old.legacy.handler === 'function')
const legacyState = await old.legacy.handler('state', {})
check('  回退 handler 返回 ok:true', legacyState.ok === true)

console.log('')
console.log('RESULT  ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
