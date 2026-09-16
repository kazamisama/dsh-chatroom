/**
 * git 事实校验的测试 —— 用真 git 仓库跑（git 2.51 在本机可用）。
 * 建临时仓库、造各种真实状态，验证三态判定与「查不到 ≠ 撒谎」的分寸。
 */
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { verifyDeclaration, describeVerification, toRelative, resolveWorktree } from '../lib/gitcheck.js'

const run = promisify(execFile)

let pass = 0
let fail = 0
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra))) }
}

async function git(cwd, args) {
  const { stdout } = await run('git', ['-C', cwd, ...args], { windowsHide: true })
  return stdout
}

const root = path.join(os.tmpdir(), 'dsh-chatroom-git-' + Date.now())
const repo = path.join(root, 'repo')
const plain = path.join(root, 'plain')
await fs.mkdir(repo, { recursive: true })
await fs.mkdir(plain, { recursive: true })

// 建仓：app.py / util.py 已提交
await git(repo, ['init', '-q', '-b', 'main'])
await git(repo, ['config', 'user.email', 'test@example.com'])
await git(repo, ['config', 'user.name', 'test'])
await fs.writeFile(path.join(repo, 'app.py'), 'def parse_cfg():\n    return 1\n', 'utf8')
await fs.writeFile(path.join(repo, 'util.py'), 'def helper():\n    return 2\n', 'utf8')
await git(repo, ['add', '.'])
await git(repo, ['commit', '-q', '-m', 'init'])

console.log('1. verified —— 有未提交改动')
await fs.writeFile(path.join(repo, 'app.py'), 'def parse_cfg():\n    return 42\n', 'utf8')
let r = await verifyDeclaration({ workspace: repo, files: ['app.py'] })
check('判定 verified', r.verdict === 'verified', r)
check('该文件标记有证据', r.files[0].evidence === true && r.files[0].dirty === true, r.files[0])
check('带出 head', r.head !== '', r.head)
check('描述含「已证实」', describeVerification(r).includes('已证实'), describeVerification(r))

console.log('2. verified —— 未跟踪的新文件')
await fs.writeFile(path.join(repo, 'newfile.py'), 'x = 1\n', 'utf8')
r = await verifyDeclaration({ workspace: repo, files: ['newfile.py'] })
check('未跟踪文件算已证实', r.verdict === 'verified', r)

console.log('3. verified —— 刚提交过（工作区干净）')
await fs.writeFile(path.join(repo, 'util.py'), 'def helper():\n    return 3\n', 'utf8')
await git(repo, ['add', 'util.py'])
await git(repo, ['commit', '-q', '-m', 'change helper'])
r = await verifyDeclaration({ workspace: repo, files: ['util.py'] })
check('靠近期提交也算已证实', r.verdict === 'verified', r)
check('标记为 recentCommit', r.files[0].recentCommit === true, r.files[0])

console.log('4. contradicted —— 仓库正常，但声明对不上')
// 让工作区彻底干净
await git(repo, ['add', '-A'])
await git(repo, ['commit', '-q', '-m', 'settle'])
await fs.writeFile(path.join(repo, 'app.py'), 'def parse_cfg():\n    return 1\n', 'utf8')
await git(repo, ['add', '-A'])
await git(repo, ['commit', '-q', '-m', 'revert app'])
r = await verifyDeclaration({ workspace: repo, files: ['app.py'] })
// 刚提交过 → 其实算 verified；用一个从未动过的文件来测 contradicted
await fs.writeFile(path.join(repo, 'untouched.py'), 'never = True\n', 'utf8')
await git(repo, ['add', 'untouched.py'])
await git(repo, ['commit', '-q', '-m', 'add untouched'])
// 等 1 秒确保时间窗判断走的是「近期提交」，再看一个从未出现在任何提交里的路径
// 锚点 = 本次会话开始时间。用"现在"表示"这些提交都发生在我这次会话之前"——
// 没有锚点就不许判撒谎（宁可少判），所以这一段的每个 contradicted 都必须带锚点。
const ANCHOR_NOW = Date.now()
r = await verifyDeclaration({ workspace: repo, files: ['ghost.py'], anchorMs: ANCHOR_NOW })
check('声明一个不存在的文件 → contradicted', r.verdict === 'contradicted', r)
check('原因写明「查无改动」', r.reason === 'no-declared-file-shows-any-change', r.reason)
check('描述含「与事实不符」', describeVerification(r).includes('与事实不符'), describeVerification(r))

console.log('5. contradicted —— 部分对不上（多文件声明）')
await fs.writeFile(path.join(repo, 'app.py'), 'def parse_cfg():\n    return 99\n', 'utf8')
r = await verifyDeclaration({ workspace: repo, files: ['app.py', 'ghost.py'], anchorMs: ANCHOR_NOW })
check('一个有一个没有 → contradicted', r.verdict === 'contradicted', r)
check('原因写明「部分对不上」', r.reason === 'some-declared-files-show-no-change', r.reason)
check('描述点名对不上的那个', describeVerification(r).includes('ghost.py'), describeVerification(r))

console.log('6. unverified —— 查不到 ≠ 撒谎')
r = await verifyDeclaration({ workspace: plain, files: ['app.py'] })
check('非 git 目录 → unverified', r.verdict === 'unverified', r)
check('原因 = not-a-git-worktree', r.reason === 'not-a-git-worktree', r.reason)
check('描述里明说「查不到不等于撒谎」', describeVerification(r).includes('查不到不等于撒谎'), describeVerification(r))
check('不给任何文件扣帽子', r.files.every((f) => f.evidence === false), r.files)

r = await verifyDeclaration({ workspace: path.join(root, 'nope'), files: ['a.py'] })
check('工作区不存在 → unverified', r.verdict === 'unverified' && r.reason === 'workspace-missing', r)

r = await verifyDeclaration({ workspace: repo, files: [] })
check('没声明文件 → unverified', r.verdict === 'unverified' && r.reason === 'no-files-declared', r)

console.log('7. 路径处理')
check('绝对路径被还原为相对', toRelative(repo, path.join(repo, 'app.py')) === 'app.py', toRelative(repo, path.join(repo, 'app.py')))
check('相对路径原样', toRelative(repo, 'sub/x.py') === path.normalize('sub/x.py'))
r = await verifyDeclaration({ workspace: repo, files: [path.join(repo, 'app.py')] })
check('声明绝对路径也能核验', r.verdict === 'verified', r)

console.log('8. 基线（sinceRef）：有参照物才算「与事实不符」')
// 参照点必须是「util.py 那次改动之前」的提交 —— 用根提交。
// （用 HEAD~1 会得到一个在改动之后的点，diff 当然是空的：这正是要测的语义边界。）
const beforeUtil = (await git(repo, ['rev-list', '--max-parents=0', 'HEAD'])).trim()
let rb = await verifyDeclaration({ workspace: repo, files: ['util.py'], sinceRef: beforeUtil })
check('自参照点以来有提交 → verified', rb.verdict === 'verified' && rb.comparedTo !== null, rb)
check('带出 comparedTo', rb.comparedTo === beforeUtil, rb.comparedTo)
const nowHead = (await git(repo, ['rev-parse', 'HEAD'])).trim()
rb = await verifyDeclaration({ workspace: repo, files: ['util.py'], sinceRef: nowHead, anchorMs: ANCHOR_NOW })
check('自称改过、但自参照点以来纹丝未动 → contradicted', rb.verdict === 'contradicted', rb)
check('描述里点明参照点', describeVerification(rb).includes('自房间上次记录'), describeVerification(rb))
rb = await verifyDeclaration({ workspace: repo, files: ['util.py'], sinceRef: 'deadbeefdeadbeef' })
check('无效参照点自动退回时间窗（宁可少判）', rb.comparedTo === null, rb.comparedTo)
await fs.writeFile(path.join(repo, 'util.py'), 'def helper(): return 777', 'utf8')
rb = await verifyDeclaration({ workspace: repo, files: ['util.py'], sinceRef: nowHead })
check('工作区脏了照样 verified（参照点不会掩盖真实改动）', rb.verdict === 'verified', rb)

console.log('9. 锚点：会话生命周期内的提交不能被判成撒谎（2026-09-12 #32 真机事故）')
// 那次事故：提交在 13:02、声明在 14:56、房间 14:54 才建 —— 既没有参照点、又超出 30 分钟窗口，
// 于是被判成「与事实不符」（撒谎档）。根因是**锚点选错了**：该锚的是"本次会话什么时候开始的"，
// 而那次提交确实发生在这个会话的生命周期内。
const threeHoursAgo = Date.now() - 3 * 3600 * 1000
await fs.writeFile(path.join(repo, 'during.py'), 'y = 1\n', 'utf8')
await git(repo, ['add', 'during.py'])
await git(repo, ['commit', '-q', '-m', 'work during session'])
let rl = await verifyDeclaration({ workspace: repo, files: ['during.py'], anchorMs: threeHoursAgo, anchorLabel: '本次会话开始' })
check('提交在本会话开始之后 → verified（超出 30 分钟窗口也算）', rl.verdict === 'verified', rl)
check('证据标记 commitSinceAnchor', rl.files[0].commitSinceAnchor === true, rl.files[0])
check('描述点明锚点', describeVerification(rl).includes('本次会话开始之后有提交'), describeVerification(rl))

rl = await verifyDeclaration({ workspace: repo, files: ['during.py'], anchorMs: Date.now() + 60000, anchorLabel: '本次会话开始' })
check('锚点在提交之后（本会话期间它没动过）→ contradicted', rl.verdict === 'contradicted', rl)

const refHead = (await git(repo, ['rev-parse', 'HEAD'])).trim()
rl = await verifyDeclaration({ workspace: repo, files: ['during.py'], anchorMs: Date.now() + 60000, ref: refHead })
check('给了覆盖该文件的 commit → verified（与时间无关）', rl.verdict === 'verified', rl)
check('证据标记 refCovers', rl.files[0].refCovers === true, rl.files[0])
rl = await verifyDeclaration({ workspace: repo, files: ['during.py'], anchorMs: Date.now() + 60000, ref: 'deadbeefdeadbeef' })
check('假的 ref 不算证据（仍 contradicted）', rl.verdict === 'contradicted', rl)

rl = await verifyDeclaration({ workspace: repo, files: ['ghost.py'] })
check('没有锚点 → unverified，绝不判撒谎', rl.verdict === 'unverified' && rl.reason === 'no-anchor-cannot-contradict', rl)
check('原因说清「没有锚点」', describeVerification(rl).includes('没有可用的时间锚点'), describeVerification(rl))

console.log('10. 回溯：会话 cwd 是「几个仓库的父目录」时，事实该去哪问（真机 2026-09-12）')
// 真机形状：会话 cwd = D:\dsh_dev（不是仓库），声明 dsh-chatroom/lib/rooms.js。
// 那时 `git -C cwd` 直接 not a git repository —— 插件自己刚建了仓，声明照样只能判未证实。
const parent = path.join(root, 'parent')       // 不是仓库
const plug = path.join(parent, 'plugin')       // 是仓库
await fs.mkdir(plug, { recursive: true })
await git(plug, ['init', '-q', '-b', 'main'])
await git(plug, ['config', 'user.email', 'test@example.com'])
await git(plug, ['config', 'user.name', 'test'])
await fs.writeFile(path.join(plug, 'app.py'), 'def f():\n    return 1\n', 'utf8')
await git(plug, ['add', 'app.py'])
await git(plug, ['commit', '-q', '-m', 'init'])

let w = await resolveWorktree({ workspace: parent, files: ['plugin/app.py'] })
check('cwd 不是仓库 → 回溯到声明文件所属仓库', w.fallback === true && w.workspace === plug, w)
check('  声明路径改写成仓库内相对路径', w.files.join() === 'app.py', w.files)
check('  原因写明是会话工作区不在 git 里', w.reason === 'session-workspace-not-a-worktree', w.reason)

// 端到端：回溯前判不出来，回溯后拿得到事实
const beforeFallback = await verifyDeclaration({ workspace: parent, files: ['plugin/app.py'] })
check('回溯前：未证实（不在 git 仓库内）',
  beforeFallback.verdict === 'unverified' && beforeFallback.reason === 'not-a-git-worktree', beforeFallback)
await fs.writeFile(path.join(plug, 'app.py'), 'def f():\n    return 42\n', 'utf8')
const afterFallback = await verifyDeclaration({ workspace: w.workspace, files: w.files })
check('回溯后：拿得到事实 → 已证实', afterFallback.verdict === 'verified', afterFallback)
const described = describeVerification({ ...afterFallback, workspaceUsed: w.workspace, repoFallback: true })
check('  描述里写明「git 事实取自哪个仓库」', described.includes('git 事实取自') && described.includes('按声明文件定位'), described)
check('  没回溯就不加这句（不制造无谓的噪音）',
  !describeVerification(afterFallback).includes('git 事实取自'), describeVerification(afterFallback))

// 反例 1：cwd 自己就是仓库 → 原样返回，绝不改写路径
w = await resolveWorktree({ workspace: plug, files: ['app.py'] })
check('cwd 本身是仓库 → 不做回溯、路径原样', w.fallback === false && w.files.join() === 'app.py', w)

// 反例 2：声明横跨两个仓库 → 整份放弃（宁可判未证实，不拼两个仓库的结论）
const plug2 = path.join(parent, 'plugin2')
await fs.mkdir(plug2, { recursive: true })
await git(plug2, ['init', '-q', '-b', 'main'])
await git(plug2, ['config', 'user.email', 'test@example.com'])
await git(plug2, ['config', 'user.name', 'test'])
await fs.writeFile(path.join(plug2, 'b.py'), 'z = 1\n', 'utf8')
await git(plug2, ['add', 'b.py'])
await git(plug2, ['commit', '-q', '-m', 'init'])
w = await resolveWorktree({ workspace: parent, files: ['plugin/app.py', 'plugin2/b.py'] })
check('声明跨两个仓库 → 不回溯（宁可少判）', w.fallback === false && w.workspace === parent, w)

// 反例 3：哪一层都不是仓库 → 老实说找不到，仍是未证实
const nowhere = path.join(root, 'nowhere')
await fs.mkdir(nowhere, { recursive: true })
w = await resolveWorktree({ workspace: nowhere, files: ['a.py'] })
check('哪儿都不是仓库 → fallback=false', w.fallback === false && w.reason === 'no-worktree-found', w)
const rn = await verifyDeclaration({ workspace: w.workspace, files: w.files })
check('  结论仍是未证实（查不到 ≠ 撒谎）', rn.verdict === 'unverified', rn)
check('  但理由说清「两边都找过了」', describeVerification({ ...rn, reason: 'no-worktree-found' }).includes('都不是 git 工作区'),
  describeVerification({ ...rn, reason: 'no-worktree-found' }))

console.log('10b. 路径少写了一级 → 结论自己要说清「少写的是哪一级」（真机 2026-09-16，我自己撞的）')
// 真机形状：会话 cwd = D:\dsh_dev（几个仓库的父目录），我把声明写成了仓库相对的 `BLUEPRINT.md`
// ⇒ 解析成 D:\dsh_dev\BLUEPRINT.md：文件不存在、目录也不是仓库 ⇒ 未证实，
// 而结论里没有一个字说明「你少写了一级」，只能自己去翻 store。
const slipParent = path.join(root, 'slip')
const slipRepo = path.join(slipParent, 'plugin')
await fs.mkdir(slipRepo, { recursive: true })
await git(slipRepo, ['init', '-q', '-b', 'main'])
await git(slipRepo, ['config', 'user.email', 'test@example.com'])
await git(slipRepo, ['config', 'user.name', 'test'])
await fs.writeFile(path.join(slipRepo, 'BLUEPRINT.md'), '# blueprint\n', 'utf8')
await git(slipRepo, ['add', '.'])
await git(slipRepo, ['commit', '-q', '-m', 'init'])
const slip = await resolveWorktree({ workspace: slipParent, files: ['BLUEPRINT.md'] })
check('路径少了一级 → 不自动改路径（仍判不出仓库）',
  slip.fallback === false && slip.reason === 'no-worktree-found', slip)
check('  但记下了「同名文件在哪个子目录里」',
  slip.nearMiss.candidates.length === 1 && slip.nearMiss.candidates[0].dir === 'plugin', slip.nearMiss)
const slipV = await verifyDeclaration({ workspace: slip.workspace, files: slip.files })
const slipText = describeVerification({ ...slipV, nearMiss: slip.nearMiss })
check('  结论里给出可操作的那一句（连例子一起）',
  slipText.includes('plugin/BLUEPRINT.md') && slipText.includes('会话工作目录相对'), slipText)
check('  并且说清「没有替你改路径」', slipText.includes('没有替你改路径'), slipText)
const slipOk = await resolveWorktree({ workspace: slipParent, files: ['plugin/BLUEPRINT.md'] })
check('  正对照：带上那一级 → 正常回溯到那个仓库',
  slipOk.fallback === true && path.normalize(slipOk.workspace) === path.normalize(slipRepo), slipOk)
const slipNone = await resolveWorktree({ workspace: slipParent, files: ['nope.py'] })
check('同名文件找不到 → 至少列出这个目录下面的仓库',
  slipNone.nearMiss.candidates.length === 0 && slipNone.nearMiss.subrepos.includes('plugin'), slipNone.nearMiss)
const slipNoText = describeVerification({ ...(await verifyDeclaration({ workspace: slipNone.workspace, files: slipNone.files })), nearMiss: slipNone.nearMiss })
check('  提示里点名那个仓库，且不编造同名文件',
  slipNoText.includes('plugin') && !slipNoText.includes('同名文件'), slipNoText)
check('没路径问题时不加这段噪音（正常未证实结论里没有「路径提示」）',
  !describeVerification(rn).includes('路径提示'), describeVerification(rn))

console.log('11. ref 无效不许静默退回（真机 #623 报的：随便写个 ref 也拿到了「已证实」）')
// 真机形状：声明里给了 ref，而那个 hash 在仓库里**根本不存在**；核验却退回
// 「文件覆盖 + 会话时间」那条路判成「已证实」—— 于是 ref 只是个装饰。
await fs.writeFile(path.join(repo, 'refcheck.py'), 'r = 1\n', 'utf8') // 未跟踪 → 文件层面有证据
const ghost11 = '0123456789abcdef0123456789abcdef01234567'
let r11 = await verifyDeclaration({ workspace: repo, files: ['refcheck.py'], ref: ghost11 })
check('仓库里没有的 ref → 与事实不符（不是"退回文件覆盖"）', r11.verdict === 'contradicted', r11)
check('  理由点名 ref 无效', r11.reason === 'ref-not-found', r11.reason)
check('  refState 落在结论里', r11.refState === 'not-found', r11.refState)
const d11 = describeVerification(r11)
check('  描述说清是 ref 的问题、并点名是哪个 ref', d11.includes('ref 无效') && d11.includes(ghost11), d11)
check('  给了改法', d11.includes('重新声明'), d11)
check('  文件层面的证据照样报出来（不是"你的文件没动"）', d11.includes('有未提交改动'), d11)

// 解析得到、但不是 commit（指到了 tree）→ 判不出来，不判撒谎
r11 = await verifyDeclaration({ workspace: repo, files: ['refcheck.py'], ref: 'HEAD^{tree}' })
check('ref 指向 tree → 未证实（不判撒谎）', r11.verdict === 'unverified' && r11.reason === 'ref-not-a-commit', r11)
check('  描述点出解析到的是什么', describeVerification(r11).includes('tree'), describeVerification(r11))
check('  仍不退回文件覆盖：文件明明有证据也没判已证实', r11.files[0].dirty === true && r11.verdict !== 'verified', r11.files[0])

// 存在、但不是 HEAD 的祖先（在别的分支上）
await git(repo, ['checkout', '-q', '-b', 'side-branch'])
await fs.writeFile(path.join(repo, 'side.py'), 's = 1\n', 'utf8')
await git(repo, ['add', 'side.py'])
await git(repo, ['commit', '-q', '-m', 'side work'])
const sideHead11 = (await git(repo, ['rev-parse', 'HEAD'])).trim()
await git(repo, ['checkout', '-q', 'main'])
r11 = await verifyDeclaration({ workspace: repo, files: ['refcheck.py'], ref: sideHead11 })
check('ref 不是 HEAD 的祖先 → 未证实', r11.verdict === 'unverified' && r11.reason === 'ref-not-ancestor', r11)
check('  描述说清"可能在别的分支"', describeVerification(r11).includes('别的分支'), describeVerification(r11))

// 反向对照 1：有效 ref 覆盖该文件 → 照旧已证实
await git(repo, ['add', 'refcheck.py'])
await git(repo, ['commit', '-q', '-m', 'refcheck'])
const goodHead11 = (await git(repo, ['rev-parse', 'HEAD'])).trim()
r11 = await verifyDeclaration({ workspace: repo, files: ['refcheck.py'], ref: goodHead11 })
check('有效 ref 覆盖该文件 → 已证实（refState=ok）',
  r11.verdict === 'verified' && r11.refState === 'ok' && r11.files[0].refCovers === true, r11)

// 反向对照 2：没给 ref → 分层证据那条路完全不受影响
r11 = await verifyDeclaration({ workspace: repo, files: ['refcheck.py'], anchorMs: Date.now() - 60000, anchorLabel: '本次会话开始' })
check('没给 ref → 照旧走分层证据', r11.verdict === 'verified' && r11.refState === null, r11)

console.log('9. 声明落在**另一个仓库**里（真机 2026-09-16 #1454/#1455：一份诚实声明被判「ref 无效」）')
// 真机形状：会话 cwd 是 ulysses 仓，改的却是隔壁 dsh-ulysses-mcp 仓。
// 旧实现在"会话工作区本身是仓库"时直接拿它核验 ⇒ ref 在那个仓库里当然查不到 ⇒ 判「ref 无效 ⇒ 声明不成立」。
const aRepo = path.join(root, 'aRepo')
const bRepo = path.join(root, 'bRepo')
await fs.mkdir(aRepo, { recursive: true })
await fs.mkdir(path.join(bRepo, 'src'), { recursive: true })
await fs.mkdir(path.join(bRepo, 'tests'), { recursive: true })
await git(aRepo, ['init', '-q', '-b', 'main'])
await git(aRepo, ['config', 'user.email', 'test@example.com'])
await git(aRepo, ['config', 'user.name', 'test'])
await fs.writeFile(path.join(aRepo, 'only-a.py'), 'a = 1\n', 'utf8')
await git(aRepo, ['add', '.'])
await git(aRepo, ['commit', '-q', '-m', 'a-init'])
await git(bRepo, ['init', '-q', '-b', 'main'])
await git(bRepo, ['config', 'user.email', 'test@example.com'])
await git(bRepo, ['config', 'user.name', 'test'])
await fs.writeFile(path.join(bRepo, 'src', 'x.py'), 'x = 1\n', 'utf8')
await fs.writeFile(path.join(bRepo, 'tests', 'y.py'), 'y = 1\n', 'utf8')
await git(bRepo, ['add', '.'])
await git(bRepo, ['commit', '-q', '-m', 'b-init'])
const bHead = (await git(bRepo, ['rev-parse', 'HEAD'])).trim()
const aHead = (await git(aRepo, ['rev-parse', 'HEAD'])).trim()

const rw = await resolveWorktree({ workspace: aRepo, files: ['../bRepo/src/x.py', '../bRepo/tests/y.py'] })
check('回溯到**声明文件**所在的仓库（不是会话那个）',
  path.normalize(rw.workspace) === path.normalize(bRepo) && rw.fallback === true, rw)
check('  理由写明"文件不在会话工作区的仓库里"',
  rw.reason === 'declared-files-outside-session-workspace', rw.reason)
check('  文件改写成该仓库内的相对路径（跨两个目录 —— 顺带覆盖"多目录回溯"那条修正）',
  rw.files.join() === 'src/x.py,tests/y.py', rw.files)

let rB9 = await verifyDeclaration({ workspace: rw.workspace, files: rw.files, ref: bHead })
check('该仓库里的 ref → 已证实（修复前：判「ref 无效 ⇒ 与事实不符」）',
  rB9.verdict === 'verified' && rB9.refState === 'ok', rb)
check('  每个文件都标了 ref 覆盖', rB9.files.every((f) => f.refCovers === true), rB9.files)
check('  描述写明 git 事实取自哪个仓库', describeVerification({ ...rB9, workspaceUsed: bRepo, repoFallback: true, repoReason: rw.reason })
  .includes('git 事实取自 bRepo 仓库') &&
  describeVerification({ ...rB9, workspaceUsed: bRepo, repoFallback: true, repoReason: rw.reason })
    .includes('不在会话工作区那个仓库里'),
  describeVerification({ ...rB9, workspaceUsed: bRepo, repoFallback: true, repoReason: rw.reason }))

// 反向对照：**不许**放宽成"ref 在哪个仓库里都算数"
rB9 = await verifyDeclaration({ workspace: bRepo, files: ['src/x.py'], ref: aHead })
check('别的仓库的 commit 仍不算数（ref-not-found）', rB9.verdict !== 'verified' && rB9.reason === 'ref-not-found', rB9.reason)
check('  而且说清查的是哪个仓库（下次一眼看得出来）',
  describeVerification({ ...rB9, workspaceUsed: bRepo }).includes('查的是 bRepo 仓库'),
  describeVerification({ ...rB9, workspaceUsed: bRepo }))

// 跨仓库的一份声明 → 不把两个仓库的结论拼成一句（宁可未证实）
const rw2 = await resolveWorktree({ workspace: aRepo, files: ['only-a.py', '../bRepo/src/x.py'] })
check('一份声明横跨两个仓库 → 不回溯', rw2.fallback === false && rw2.workspace === aRepo, rw2)
// 会话 cwd 是几个仓库的父目录（老兜底路径）仍然有效
const rw3 = await resolveWorktree({ workspace: root, files: ['bRepo/src/x.py'] })
check('父目录兜底那条第仍成立（bRepo/src/x.py → bRepo 仓）',
  path.normalize(rw3.workspace) === path.normalize(bRepo) && rw3.files.join() === 'src/x.py', rw3)

await fs.rm(root, { recursive: true, force: true })
console.log('')
console.log('RESULT  ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
