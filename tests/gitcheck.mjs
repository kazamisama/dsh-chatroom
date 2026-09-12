/**
 * git 事实校验的测试 —— 用真 git 仓库跑（git 2.51 在本机可用）。
 * 建临时仓库、造各种真实状态，验证三态判定与「查不到 ≠ 撒谎」的分寸。
 */
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { verifyDeclaration, describeVerification, toRelative } from '../lib/gitcheck.js'

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

await fs.rm(root, { recursive: true, force: true })
console.log('')
console.log('RESULT  ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
