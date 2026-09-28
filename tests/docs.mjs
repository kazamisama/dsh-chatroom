/**
 * 文档 lint —— 给"会漂的数与清单"装网（审计席 837e0518 #5415 的形态）：
 *
 * 他指出的三处漂移，共同点是**同一件事实被抄进了第二个地方**：
 *  · 测试条数（"七套共 1071"）—— 每加一个用例就过期（本仓已有先例：`addopts` 由测试钉、词表由 AST 扫）；
 *  · 「谁必须回」的档位清单 —— 抄进 README 就是**第三个落点**（当时 enum／散文／TIERS／TIER_MARK 已有四份）；
 *  · 「改完要不要重启」—— 只写结论、不写**判别**，读的人只能靠记住它（本仓那条：判不了 ≠ 否）。
 *
 * 所以这一套不测渲染，测**文档的形状**：数字不许手写、清单不许抄第二份、结论不许没有判别。
 *
 * ⚠ 一条必须做对的区分（第一版我就写错了、当场被自己咬红）：**历史标注里引旧说法是合法的**
 * （"这里原来写'六套共 271 条'"正是本仓要求保留的取证），要判的是**现时声称**。
 * 所以下面先把带〔…更正/原来…〕的行剔掉，再对剩下的正文做形状检查。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.join(here, '..')

let pass = 0
let fail = 0
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label) } else { fail++; console.log('  FAIL  ' + label + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra))) }
}

const readme = await fs.readFile(path.join(repo, 'README.md'), 'utf8')
const allmjs = await fs.readFile(path.join(repo, 'tests', 'all.mjs'), 'utf8')

/** 只留"现时声称"：剔掉历史标注行（以〔开头，或含"更正 / 原来写"）。 */
const liveLines = (text) => text.split('\n').filter((l) => {
  const t = l.trim()
  if (t.startsWith('〔')) return false
  return !/(更正|原来写)/.test(t)
})
const readmeLive = liveLines(readme).join('\n')
const allLive = liveLines(allmjs).join('\n')

console.log('1. 会漂的数不许手写（要数就照命令跑；要写就连口径与时刻一起写）')
check('README 的**现时正文**不写手测条数（历史标注里引旧说法是合法的，已剔除）',
  (readmeLive.match(/\d+\s*条断言/g) || []).length === 0, readmeLive.match(/\d+\s*条断言/g) || [])
const suiteHits = (readmeLive.match(/[六七八九十]\s*套/g) || []).concat(allLive.match(/[六七八九十]\s*套/g) || [])
check('README 与 tests/all.mjs 的现时正文都不写套件数（名单以 all.mjs 的 SUITES 为唯一源）',
  suiteHits.length === 0, suiteHits)
check('README 写清了"怎么跑"（否则读者拿不到数）',
  readme.includes('npm test') || readme.includes('tests/all.mjs'))

console.log('2. 清单不许抄第二份（一处当源，文案当渲染）')
// 档位那三个枚举值**可以**在 README 出现（说明用途），但必须**指向**档位表 —— 否则下一次改档位就是第三个落点。
check('README 提到档位时给出指针（指向 BLUEPRINT §11.55 那份表）',
  /BLUEPRINT[^\n]*11\.55/.test(readmeLive))
const tierWords = ['routine', 'contract', 'irreversible'].filter((w) => readmeLive.includes(w))
check('  且不把三档的**判据**复述一遍（只留指针；复述就会漂）',
  !(tierWords.length >= 2 && /(接口|删数据|改 schema|进历史)/u.test(readmeLive)), tierWords)

console.log('3. 结论不许没有判别（本仓那条：判不了 ≠ 否）')
check('README 的"要不要重启"带**判别**（客户端侧热更新的前提写出来了）',
  readmeLive.includes('热更新') && readmeLive.includes('必须重启'))
check('  且给了"判不了时怎么办"（否则读者只能靠记住它）',
  /判不了|不确定/.test(readmeLive))

console.log('')
console.log('RESULT  ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
