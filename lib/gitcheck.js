/**
 * dsh-chatroom —— 变更声明的事实核验（BLUEPRINT §6.2）
 *
 * 为什么存在：房间的核心用途是「谁改了什么」。但成员嘴里的「我改了 app.py」
 * 会漏报、会误报、会含糊 —— 事实源不该是 agent 的嘴，应该是 git。
 * 这里只做一件事：把一份声明拿去和 git 对质，给出三态结论。
 *
 * 三态（照蓝图定义）：
 *   verified     每个声明文件都有事实支撑（未提交改动 / 暂存 / 近期提交）
 *   unverified   **查不到**——不在 git 仓库、git 不可用、命令失败。不算撒谎。
 *   contradicted 能查、查得到，但声明对不上（声明了 app.py，仓库里它纹丝未动）
 *
 * 刻意不做的：不因为「非 git 工作区」就把人判成撒谎。查不到 ≠ 骗人，
 * 这是蓝图 §6.2 写死的分寸，也是这套东西敢用的前提。
 */
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const VERIFIED = 'verified'
export const UNVERIFIED = 'unverified'
export const CONTRADICTED = 'contradicted'

/** 声明在多长时间内算「刚刚提交过」（毫秒转 git --since 用的相对时间）。 */
export const DEFAULT_RECENT_MINUTES = 30

/** 跑一条 git 命令。失败返回 null，绝不抛——核验失败不该拖垮房间。 */
async function git(cwd, args, timeoutMs = 8000) {
  try {
    const { stdout } = await run('git', ['-C', cwd, ...args], {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    })
    return stdout
  } catch {
    return null
  }
}

/**
 * 跑一条 git 命令，**连"为什么失败"一起带回来**（真机 #623）。
 *
 * git() 把两种情况压成同一个 null：**命令跑了但退出码非零**（git 明确告诉你"没有"）
 * 与 **git 根本没跑起来**（spawn ENOENT / 超时 —— 我们只是查不到）。多数判据不在乎这个差，
 * ref 在乎：cat-file -t <不存在的 sha> 是"查得到：没有"（声明的 commit 不存在 = 事实错误），
 * 而 ENOENT 是"查不到"（判不了，但不是撒谎）。
 *
 * 判据：spawn 类失败的 err.code 是字符串（ENOENT），非零退出的是数字。
 */
async function gitProbe(cwd, args, timeoutMs = 8000) {
  try {
    const { stdout, stderr } = await run('git', ['-C', cwd, ...args], {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    })
    return { ran: true, code: 0, stdout, stderr }
  } catch (err) {
    const code = err !== null && typeof err === 'object' ? err.code : null
    if (typeof code === 'number') {
      return { ran: true, code, stdout: String(err.stdout || ''), stderr: String(err.stderr || '') }
    }
    return { ran: false, code: null, stdout: '', stderr: err && err.message ? String(err.message) : String(err) }
  }
}

/** 把声明里的路径收敛成工作区相对路径（绝对路径会被还原成相对的）。 */
export function toRelative(workspace, file) {
  const raw = String(file).trim()
  if (raw === '') return ''
  const normalized = path.normalize(raw)
  if (path.isAbsolute(normalized)) {
    const rel = path.relative(path.resolve(workspace), normalized)
    return rel.startsWith('..') ? normalized : rel
  }
  return normalized
}

/** 这个路径存在吗（不抛）。 */
async function exists(p) {
  try { await fs.stat(p); return true } catch { return false }
}

/**
 * 声明的路径按会话工作目录找不到时，看看它是不是落在**子目录里的仓库**里。
 *
 * 真机形状（2026-09-16 我自己撞的）：会话 cwd 是 `D:\dsh_dev`（几个仓库的父目录），
 * 声明却写成了仓库相对的 `BLUEPRINT.md` —— 解析出来是 `D:\dsh_dev\BLUEPRINT.md`：
 * 文件不存在、那个目录也不是仓库 ⇒ 判「未证实（不在 git 仓库内）」，
 * 而**结论里没有一个字说明"你少写了一级"**（我得自己去翻 store 才知道）。
 *
 * 这里只做确定性的事：在工作区的每个**直接子目录**下找同名文件。
 * 全部声明文件都在某个子目录里找得到 ⇒ 那个子目录是嫌疑对象；
 * 一个都找不到 ⇒ 至少把"这个工作区下面有哪些仓库"列出来。
 * 它**只用来写提示**，能不能采用由声明者决定 —— 猜错仓库会把核验从「对质事实」变成「看着像就算」。
 */
async function subrepoCandidates(base, declared) {
  const rel = declared.map((f) => toRelative(base, f))
  const out = { base, rel, missing: [], candidates: [], subrepos: [] }
  let entries = []
  try { entries = await fs.readdir(base, { withFileTypes: true }) } catch { return out }
  const dirs = []
  for (const e of entries) {
    if (dirs.length >= 40) break
    if (e.isDirectory() !== true) continue
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    dirs.push(e.name)
  }
  for (const r of rel) if (!(await exists(path.resolve(base, r)))) out.missing.push(r)
  for (const name of dirs) {
    const sub = path.join(base, name)
    let all = true
    for (const r of rel) {
      if (!(await exists(path.join(sub, r)))) { all = false; break }
    }
    if (all) { out.candidates.push({ dir: name }); continue }
    if (await exists(path.join(sub, '.git'))) out.subrepos.push(name)
  }
  return out
}

/** 这个目录是不是 git 工作区（`rev-parse --is-inside-work-tree`）。 */
async function isWorktree(dir) {
  const out = await git(dir, ['rev-parse', '--is-inside-work-tree'])
  return out !== null && out.trim() === 'true'
}

/**
 * 决定这份声明该去**哪个仓库**里核验（BLUEPRINT §6.2.1）。
 *
 * 正常情形：会话 cwd 自己就是工作区 —— 原样返回，一个字节都不改。
 *
 * 兜底情形（真机 2026-09-12）：会话 cwd 是**几个仓库的父目录**（`D:\dsh_dev`），
 * 声明的是子目录里的文件（`dsh-chatroom/lib/rooms.js`）。那时 `git -C cwd` 直接
 * 「not a git repository」，核验永远只能判未证实 —— 插件自己刚建仓也照样判不出来。
 * 于是按**声明的文件自己**回溯：从文件所在目录往上找第一个工作区，
 * 并把声明路径改写成该仓库内的相对路径（`lib/rooms.js`）。
 *
 * 为什么这不是放宽判据：起点是文件自己的目录，所以找到的仓库**必然真的装着这些
 * 文件**；变的只是「事实该去哪问」。但**要求全部声明文件都落在同一个仓库里** ——
 * 有一个在外面就整份放弃（宁可判未证实，也不把两个仓库的结论拼成一句）。
 *
 * @returns {Promise<{workspace: string, files: string[], fallback: boolean, reason: string}>}
 *   fallback=true 时 workspace 是回溯到的仓库根，files 是**仓库内**的相对路径。
 */
export async function resolveWorktree({ workspace, files }) {
  const declared = (Array.isArray(files) ? files : []).map((f) => String(f).trim()).filter((f) => f !== '')
  const base = workspace === undefined || workspace === null ? '' : String(workspace)
  if (declared.length === 0) return { workspace: base, files: declared, fallback: false, reason: 'no-files-declared' }
  if (base === '') return { workspace: base, files: declared, fallback: false, reason: 'no-workspace' }
  const abs = (f) => path.resolve(base, toRelative(base, f))
  // 「这个仓库根装得下全部声明文件吗」—— 跨仓库的声明不拼结论（宁可未证实）
  const contains = (root) => declared
    .map((f) => path.relative(root, abs(f)))
    .every((rel) => rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel))

  const baseIsRepo = await isWorktree(base)
  // ① 会话工作区自己就是仓库、**且装得下全部声明文件** → 原样返回（正常情形，一个字节都不改）
  if (baseIsRepo && contains(base)) {
    return { workspace: base, files: declared, fallback: false, reason: 'session-workspace-is-worktree' }
  }

  // ② 否则按**声明文件自己的目录**回溯到它所在仓库的**根**。
  //
  // 两处修正（真机 2026-09-16，房间 #1454/#1455）：
  //  · ① 以前**不看装不装得下**：会话 cwd 只要是仓库就直接拿它核验。于是「会话在 ulysses 仓、
  //    改的却是隔壁 dsh-ulysses-mcp 仓」这种声明会被拿去 ulysses 里查 ref ⇒ cat-file 查不到
  //    ⇒ 判成「ref 无效 ⇒ 声明不成立」—— **一份诚实声明被打成红的**。
  //  · 回溯以前用 `--is-inside-work-tree` 判"找到仓库了"，而它在**任意子目录**里都是 true：
  //    于是走到文件的第一个子目录就停、发现装不下全部文件就放弃 ⇒ 多目录的声明永远回溯不出来。
  //    现在问 `--show-toplevel` 拿真正的仓库根。
  const tried = new Map()
  const rootOf = async (dir) => {
    if (!tried.has(dir)) tried.set(dir, await worktreeRoot(dir))
    return tried.get(dir)
  }
  const roots = []
  for (const file of declared) {
    const found = await rootOf(path.dirname(abs(file)))
    if (found !== null && !roots.includes(found)) roots.push(found)
  }
  for (const root of roots) {
    if (!contains(root)) continue
    return {
      workspace: root,
      files: declared.map((f) => path.relative(root, abs(f)).replace(/\\/g, '/')),
      fallback: true,
      reason: baseIsRepo ? 'declared-files-outside-session-workspace' : 'session-workspace-not-a-worktree',
    }
  }
  // 找不到仓库时**顺手看一眼子目录**：真机最常见的错法是「声明写成了仓库相对路径」
  // （会话 cwd 是几个仓库的父目录，声明 `BLUEPRINT.md` 而不是 `dsh-chatroom/BLUEPRINT.md`）。
  // 只用来写提示 —— **绝不自动采用**：猜错仓库就把「对质事实」变成「看着像就算」。
  const nearMiss = await subrepoCandidates(base, declared)
  return { workspace: base, files: declared, fallback: false, reason: 'no-worktree-found', nearMiss }
}

/** 这个目录所属仓库的**根**；不在任何工作区里就 null。 */
async function worktreeRoot(dir) {
  const out = await git(dir, ['rev-parse', '--show-toplevel'])
  const root = out === null ? '' : out.trim()
  return root === '' ? null : path.normalize(root)
}

/**
 * 核验一份变更声明。
 * @param workspace 声明者的工作区绝对路径（会话 cwd）
 * @param files 声明的工作区相对路径列表
 * @param recentMinutes 「刚刚提交过」的时间窗（**没有锚点时的退路**，只在没有任何正面证据时兜底）
 * @param sinceRef 参照提交（房间上次记下的 HEAD）。传了它就用 git diff <sinceRef> -- <file>，
 *   判定从「猜」变成「对」。但注意：它锚的是「上次声明」，比它更早提交、现在才声明的改动
 *   会被它漏掉 —— 所以它只是**证据之一**，不是唯一判据（见 anchorMs）。
 * @param anchorMs 锚点（毫秒时间戳）：**本次会话的开始时间**（host 传 exec.agent.session.header.createdAt），
 *   拿不到就退房间建立时间。判定规则变成「这次会话开始之后，这些文件到底动没动过」——
 *   真机事故（2026-09-12 #32）：一个 1 小时 54 分前提交、刚进房间才声明的改动，
 *   因为既没有 sinceRef、又超出 30 分钟窗口，被判成「与事实不符」（撒谎档）。
 *   锚在会话开始就对了：那次提交确实发生在该会话生命周期内。
 * @param ref 声明者给出的 commit（可选）。给了它就以 **commit 事实**为准，与时间无关：
 *   能解析成 commit + 是 HEAD 的祖先 + 该 commit 覆盖了声明的文件 → 证据成立。
 * @returns { verdict, reason, files: [{ path, dirty, staged, recentCommit, commitSinceAnchor, refCovers, evidence }], head, diffStat, comparedTo }
 */
export async function verifyDeclaration({
  workspace,
  files,
  recentMinutes = DEFAULT_RECENT_MINUTES,
  sinceRef = null,
  anchorMs = null,
  anchorLabel = '锚点',
  ref = null,
}) {
  const list = (Array.isArray(files) ? files : []).map((f) => toRelative(workspace, f)).filter((f) => f !== '')
  const perFile = list.map((f) => ({
    path: f,
    dirty: false,
    staged: false,
    recentCommit: false,
    commitSinceAnchor: false,
    refCovers: false,
    committedAt: 0,
    evidence: false,
  }))

  const empty = { verdict: UNVERIFIED, reason: 'no-files-declared', files: perFile, head: '', diffStat: '' }
  if (list.length === 0) return empty

  if (workspace === undefined || workspace === null || workspace === '') {
    return { ...empty, reason: 'no-workspace' }
  }
  try {
    const stat = await fs.stat(workspace)
    if (!stat.isDirectory()) return { ...empty, reason: 'workspace-not-a-directory' }
  } catch {
    return { ...empty, reason: 'workspace-missing' }
  }

  const inside = await git(workspace, ['rev-parse', '--is-inside-work-tree'])
  if (inside === null || inside.trim() !== 'true') {
    // 查不到 —— 不判撒谎，只标未证实。
    return { ...empty, reason: 'not-a-git-worktree' }
  }

  const head = ((await git(workspace, ['rev-parse', '--short', 'HEAD'])) || '').trim()
  const since = recentMinutes + ' minutes ago'
  const anchor = Number.isFinite(anchorMs) && anchorMs > 0 ? anchorMs : null
  /** 路径比较一律用正斜杠：git 输出的是 /，而我们这边 path.normalize 出的是 \。 */
  const norm = (p) => String(p).replace(/\\/g, '/')

  // 声明者给了 commit 吗？给了就以它为准 —— 这是与时间无关的硬事实。
  // 三步都成立才算数：能解析成 commit、是 HEAD 的祖先、该 commit 覆盖了声明的文件。
  //
  // **给了 ref 就必须以 ref 为准**（真机 #623）：解析不出来时**不许静默退回**文件覆盖检查 ——
  // 那等于"随便写个 ref 都能拿到已证实"，而 ref 存在的意义正是"与时间无关、最不容易被误判"。
  // 所以 ref 的解析状态本身是**独立一档判据**：
  //   not-found    仓库里没这个对象 → **与事实不符**（声明的 commit 不存在，是可核查的假话）
  //   not-a-commit 解析到了 tree/blob/tag 对象 → 未证实（可能只是指错了对象）
  //   not-ancestor 存在但不是 HEAD 的祖先（别的分支、或已被 rebase 掉）→ 未证实
  //   unavailable  git 没跑起来（ENOENT/超时）→ 未证实（这是"查不到"，不是"没有"）
  let refFiles = null
  let refState = null
  let refTip = ''
  const refText = typeof ref === 'string' ? ref.trim() : ''
  if (refText !== '') {
    const kind = await gitProbe(workspace, ['cat-file', '-t', refText])
    if (!kind.ran) {
      refState = 'unavailable'
    } else if (kind.code !== 0 || kind.stdout.trim() === '') {
      refState = 'not-found'
    } else if (kind.stdout.trim() !== 'commit') {
      refState = 'not-a-commit'
      refTip = kind.stdout.trim()
    } else {
      // merge-base --is-ancestor 成功时**没有输出**，所以只能看退出码。
      const anc = await gitProbe(workspace, ['merge-base', '--is-ancestor', refText, 'HEAD'])
      if (!anc.ran) {
        refState = 'unavailable'
      } else if (anc.code !== 0) {
        refState = 'not-ancestor'
      } else {
        refState = 'ok'
        const touched = await git(workspace, ['show', '--name-only', '--format=', refText])
        if (touched !== null) {
          refFiles = new Set(touched.split('\n').map((s) => norm(s.trim())).filter((s) => s !== ''))
        }
      }
    }
  }

  // 参照提交可用吗？不可用就老实退回时间窗 —— 宁可少判，不可错判。
  let comparedTo = null
  if (typeof sinceRef === 'string' && sinceRef !== '') {
    const probe = await git(workspace, ['rev-parse', '--verify', '--quiet', sinceRef + '^{commit}'])
    if (probe !== null && probe.trim() !== '') comparedTo = sinceRef
  }

  for (const entry of perFile) {
    const status = await git(workspace, ['status', '--porcelain', '--', entry.path])
    if (status !== null && status.trim() !== '') {
      // 未跟踪(??)/已修改(M)/已删除(D)/新增(A) 都算事实
      entry.dirty = true
      const staged = await git(workspace, ['diff', '--cached', '--name-only', '--', entry.path])
      entry.staged = staged !== null && staged.trim() !== ''
    }
    // 时间窗只在**既没有参照点、也没有锚点**时兜底：它是个猜测，有更好的判据时就该让位
    // （否则「刚提交过」会把真正的「这次会话里根本没动过」掩盖掉）。
    if (comparedTo !== null) {
      const diff = await git(workspace, ['diff', '--name-only', comparedTo, '--', entry.path])
      if (diff !== null && diff.trim() !== '') entry.recentCommit = true
    } else if (anchor === null) {
      const log = await git(workspace, ['log', '--since=' + since, '--name-only', '--pretty=format:', '--', entry.path])
      if (log !== null && log.trim() !== '') entry.recentCommit = true
    }

    // 这个文件**最后一次被提交的时间**（HEAD 可达）。锚点之后的提交 = 硬证据，
    // 与「上次声明」和「30 分钟窗口」都无关 —— 这正是 #32 那次被冤枉的地方。
    const lastCommit = await git(workspace, ['log', '-1', '--format=%ct', '--', entry.path])
    const ct = lastCommit === null || lastCommit.trim() === '' ? 0 : Number(lastCommit.trim()) * 1000
    entry.committedAt = Number.isFinite(ct) ? ct : 0
    if (anchor !== null && entry.committedAt > 0 && entry.committedAt >= anchor) entry.commitSinceAnchor = true

    if (refFiles !== null && refFiles.has(norm(entry.path))) entry.refCovers = true

    entry.evidence = entry.dirty || entry.recentCommit || entry.commitSinceAnchor || entry.refCovers
  }

  const diffStat = ((await git(workspace, ['diff', '--numstat', 'HEAD'])) || '').trim()

  const matched = perFile.filter((f) => f.evidence)
  const unmatched = perFile.filter((f) => !f.evidence)

  let verdict = VERIFIED
  let reason = 'all-declared-files-have-evidence'
  if (refState === 'not-found') {
    // 声明的 commit **不存在** —— 与文件动不动无关，这份声明本身不成立。
    verdict = CONTRADICTED
    reason = 'ref-not-found'
  } else if (refState !== null && refState !== 'ok') {
    // ref 用不上 ≠ 没有改动：不判撒谎，但**也不退回文件覆盖判定**（那正是 #623 报的洞）。
    verdict = UNVERIFIED
    reason = 'ref-' + refState
  } else if (matched.length === 0) {
    if (anchor === null) {
      // 没有锚点就没有资格说「与事实不符」——判不出来就老实说判不出来。
      verdict = UNVERIFIED
      reason = 'no-anchor-cannot-contradict'
    } else {
      verdict = CONTRADICTED
      reason = 'no-declared-file-shows-any-change'
    }
  } else if (unmatched.length > 0) {
    if (anchor === null) {
      verdict = UNVERIFIED
      reason = 'no-anchor-cannot-contradict'
    } else {
      verdict = CONTRADICTED
      reason = 'some-declared-files-show-no-change'
    }
  }

  return {
    verdict,
    reason,
    files: perFile,
    head,
    diffStat,
    comparedTo,
    anchorMs: anchor,
    anchorLabel,
    ref: refText === '' ? null : refText,
    refState,
    refTip,
  }
}

/** 逐文件的证据明细（「已证实」与「ref 无效」两种情况都要报它）。 */
function evidenceDetail(result) {
  return result.files
    .map((f) => f.path
      + (f.dirty ? '（有未提交改动）' : '')
      + (f.refCovers ? '（commit 覆盖）' : '')
      + (f.commitSinceAnchor ? '（' + (result.anchorLabel || '锚点') + '之后有提交）' : '')
      + (f.recentCommit ? '（近期有提交）' : ''))
    .join('、')
}

/** 路径写错时的提示：只说事实（哪个路径不存在、同名文件在哪个子目录、下面有哪些仓库）。 */
function nearMissNote(result) {
  const nm = result.nearMiss
  if (nm === undefined || nm === null || typeof nm !== 'object') return ''
  const base = typeof nm.base === 'string' ? nm.base : ''
  const rel = Array.isArray(nm.rel) ? nm.rel : []
  const missing = Array.isArray(nm.missing) ? nm.missing : []
  const cands = Array.isArray(nm.candidates) ? nm.candidates : []
  const repos = Array.isArray(nm.subrepos) ? nm.subrepos : []
  if (base === '' || rel.length === 0) return ''
  if (cands.length > 0) {
    const inside = (d) => d + '/' + rel[0]
    // cands 里是 { dir } 不是字符串 —— 直接 `map(inside)` 会印出 `[object Object]/BLUEPRINT.md`。
    // 真机照出来的（2026-09-17：我拿 D:\dsh_dev 那个真诱饵跑复现脚本，而当时的测试只断言了末尾的「例：」）。
    const list = cands.slice(0, 3).map((c) => inside(c.dir)).join('、')
    // 两种形状要分开说：**文件真的不存在** vs **同名文件在会话目录里也有一份**
    // （真机 2026-09-16：D:\dsh_dev\BLUEPRINT.md 是个 0 字节的残file，同名文件在子仓里）——
    // 后者不能说成"不存在"，那会把人带去删掉另一个文件。
    const why = missing.length > 0
      ? '，' + missing.join('、') + ' 不存在；但 ' + list + ' 存在'
      : '（这里不是 git 仓库）；这个名字的文件在 ' + list + ' 里也有一份'
    return '（路径提示：按会话工作目录 ' + base + ' 解析' + why
      + ' —— 声明的路径是**会话工作目录相对**的，要带上那一级（例：' + inside(cands[0].dir)
      + '）。这只是提示，核验没有替你改路径。）'
  }
  if (missing.length > 0 && repos.length > 0) {
    return '（路径提示：按会话工作目录 ' + base + ' 解析，' + missing.join('、') + ' 不存在；这个目录下面的仓库有：'
      + repos.slice(0, 5).join('、') + ' —— 若改动在其中一个里，声明要带上那一级。这只是提示，核验没有替你改路径。）'
  }
  return ''
}

/** 一句话给人看（进房间消息，成员据此决定要不要信）。 */
export function describeVerification(result) {
  // 回溯核验必须**说出来**：读的人要知道这份 git 事实取自哪个仓库，
  // 否则「已证实」看起来像是对会话工作区的判定（其实那个目录根本不是仓库）。
  const repoNote = result.repoFallback === true && typeof result.workspaceUsed === 'string' && result.workspaceUsed !== ''
    ? '（git 事实取自 ' + path.basename(result.workspaceUsed) + ' 仓库 —— '
      + (result.repoReason === 'declared-files-outside-session-workspace'
        ? '声明的文件不在会话工作区那个仓库里，按声明文件定位'
        : '会话工作区不在 git 里，按声明文件定位') + '）'
    : ''
  if (result.verdict === VERIFIED) {
    return 'git 校验 ✓ 已证实：' + evidenceDetail(result) + repoNote
  }
  if (result.verdict === CONTRADICTED) {
    // ref 无效是**独立一档**：错的是声明里那个 commit，不是文件层面。
    // 两件事必须分开说，否则读的人会以为「我的文件根本没动」（#623 的形状）。
    if (result.reason === 'ref-not-found') {
      return 'git 校验 ✗ ref 无效：' + String(result.ref) + ' 在仓库里不存在（不是对象）'
      + (typeof result.workspaceUsed === 'string' && result.workspaceUsed !== ''
        ? '（查的是 ' + path.basename(result.workspaceUsed) + ' 仓库）' : '') + '——'
        + '给了 ref 就以 ref 为准，它解析不出来这份声明就不成立。'
        + '（文件层面另计：' + evidenceDetail(result) + '）'
        + '用 git rev-parse 读回来的 hash 重新声明即可' + repoNote
    }
    const bad = result.files.filter((f) => !f.evidence).map((f) => f.path).join('、')
    // 措辞优先用更具体、可核对的那个：参照点（commit 号）> 锚点 > 时间窗
    let basis
    if (result.comparedTo !== null && result.comparedTo !== undefined) {
      basis = '自房间上次记录（' + result.comparedTo + '）以来无改动痕迹'
    } else if (result.anchorMs !== null && result.anchorMs !== undefined) {
      basis = '自' + (result.anchorLabel || '锚点') + '以来无改动痕迹'
    } else {
      basis = '近 ' + DEFAULT_RECENT_MINUTES + ' 分钟内无改动痕迹'
    }
    return 'git 校验 ✗ 与事实不符：' + bad + ' 在仓库里' + basis + '（' + result.reason + '）' + repoNote
  }
  // ref 用不上（不是 commit / 不是祖先 / git 没跑起来）：判不出来，但**不退回**文件覆盖判定。
  if (typeof result.reason === 'string' && result.reason.startsWith('ref-')) {
    const detail = {
      'ref-not-a-commit': '解析到的不是 commit' + (result.refTip ? '（是 ' + result.refTip + '）' : ''),
      'ref-not-ancestor': '不是 HEAD 的祖先（可能在别的分支上，或已被 rebase 掉）',
      'ref-unavailable': 'git 没能跑起来，判不了（这是"查不到"，不是"没有"）',
    }[result.reason] || result.reason
    return 'git 校验 ? 未证实（声明的 ref ' + String(result.ref) + ' ' + detail + '）——'
      + '给了 ref 就以 ref 为准、不退回文件覆盖判定；去掉 ref 或换一个有效 commit 重新声明。'
      + '（文件层面另计：' + evidenceDetail(result) + '）' + repoNote
  }
  const why = {
    'not-a-git-worktree': '不在 git 仓库内',
    'no-worktree-found': '会话工作区与声明文件所在目录都不是 git 工作区',
    'workspace-missing': '工作区不存在',
    'workspace-not-a-directory': '工作区不是目录',
    'no-workspace': '拿不到工作区路径',
    'no-files-declared': '没有声明任何文件',
    'no-anchor-cannot-contradict': '没有可用的时间锚点（会话开始时间与房间建立时间都拿不到）',
  }[result.reason] || result.reason
  return 'git 校验 ? 未证实（' + why + '）—— 查不到不等于撒谎，自行判断' + repoNote + nearMissNote(result)
}
