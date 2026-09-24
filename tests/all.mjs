/**
 * 一次跑完六套。**先打印这棵树的状态**。
 *
 * 为什么要有这一行（真机 2026-09-16）：审计（f008c4f2）在我往 panel.mjs 写 #1640 的过程中
 * 跑了这个仓库，看到 panel.mjs = 187 passed / 1 failed，差点报"并行聚合下偶发失败"；
 * 它自己撤回时判为"采样时机不对" —— **判断是对的**，但那条信息当时**只有它知道**。
 * 现在由套件自己说出来：跑之前先显示 HEAD 与工作树是否干净，TOTAL 也会带上警告。
 *
 * 用法：node tests/all.mjs（或 npm test）
 */
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(here, '..')
const SUITES = ['smoke', 'host', 'panel', 'gitcheck', 'markdown', 'transport', 'invariants']

async function git(args) {
  try {
    const { stdout } = await run('git', ['-C', repo, ...args], { windowsHide: true })
    return stdout.trim()
  } catch { return '' }
}

const head = await git(['rev-parse', '--short', 'HEAD'])
const dirty = (await git(['status', '--porcelain'])).split('\n').map((s) => s.trim()).filter((s) => s !== '')
console.log('仓库 ' + repo)
console.log('HEAD ' + (head === '' ? '(不是 git 仓库)' : head)
  + (dirty.length === 0
    ? '  工作树干净'
    : '  ⚠ 工作树有 ' + dirty.length + ' 处未提交改动 —— 下面的结果可能来自半成品：' + dirty.slice(0, 4).join(' | ')))
console.log('')

let pass = 0
let fail = 0
for (const name of SUITES) {
  const file = path.join(here, name + '.mjs')
  let out = ''
  try {
    const res = await run(process.execPath, [file], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
    out = res.stdout
  } catch (err) {
    out = String((err && err.stdout) || '') + '\n' + String((err && err.stderr) || '')
  }
  const m = /RESULT\s+(\d+) passed, (\d+) failed/.exec(out)
  if (m === null) { fail++; console.log(name.padEnd(11) + '读不到 RESULT（崩了？）'); continue }
  pass += Number(m[1])
  fail += Number(m[2])
  console.log(name.padEnd(11) + m[1].padStart(4) + ' passed' + (m[2] === '0' ? '' : '   ' + m[2] + ' FAILED'))
}
console.log('')
console.log('TOTAL ' + pass + ' passed, ' + fail + ' failed' + (dirty.length > 0 ? '  ⚠（工作树不干净，先 git status 再下结论）' : ''))
process.exit(fail === 0 ? 0 : 1)
