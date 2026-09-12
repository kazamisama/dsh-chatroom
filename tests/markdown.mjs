/**
 * 面板 Markdown 渲染器的测试。
 *
 * 为什么这么测：渲染代码在浏览器 bundle 里，我（agent）看不到浏览器。
 * 所以直接从 lib/client.js 源码中**抽出真实实现**，配一个极小的 DOM shim 跑 ——
 * 不是复制一份逻辑来测（那样测的是副本，不是产品）。
 *
 * 重点覆盖两件事：**格式对不对**，以及**能不能被消息体注入**。
 * 消息体是 agent 写的，属于不可信内容 —— 一个会话发 <img onerror=...>
 * 就能在别人的面板里执行代码，这条必须钉死。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = await fs.readFile(path.join(here, '..', 'lib', 'client.js'), 'utf8')

const START = '// ---- Markdown 渲染（零依赖）'
const END = '/** git 校验三态的视觉'
const start = src.indexOf(START)
const end = src.indexOf(END)
if (start < 0 || end < 0 || end <= start) {
  console.log('FAIL  无法从 client.js 中定位 Markdown 渲染段（源码结构变了？）')
  process.exit(1)
}
const region = src.slice(start, end)

// ---- 极小 DOM shim -------------------------------------------------------
function makeEl(tag) {
  return {
    tagName: tag,
    children: [],
    style: { cssText: '' },
    textContent: '',
    innerHTML: '',
    setAttribute() {},
    appendChild(c) { this.children.push(c); return c },
    addEventListener() {},
  }
}

// 必须复刻 bundle 里 el() 的三参数契约：el(tag, css, text) —— 第三个参数设 textContent。
// （第一版 shim 漏了它，于是「语言标签」「复制」这些文字全丢，测试把自己判失败了。）
function el(tag, css, text) {
  const n = makeEl(tag)
  if (css) n.style.cssText = css
  if (text !== undefined) n.textContent = String(text)
  return n
}

const api = new Function('el', region + '\nreturn { escapeHtml, inlineMd, renderMarkdown, codeBlock }')(el)

let pass = 0
let fail = 0
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra))) }
}

/** 把渲染出来的节点树摊平成文本，用于断言。 */
function flatten(node) {
  if (node === null || node === undefined) return ''
  let out = ''
  // 渲染器用的是 textContent（代码块/标签）与 innerHTML（行内格式），读这两个。
  if (typeof node.textContent === 'string') out += node.textContent
  if (typeof node.innerHTML === 'string') out += node.innerHTML
  for (const c of node.children || []) out += flatten(c)
  return out
}
function tags(node, acc = []) {
  acc.push(node.tagName)
  for (const c of node.children || []) tags(c, acc)
  return acc
}
function render(text) {
  const host = makeEl('div')
  api.renderMarkdown(host, text)
  return host
}

console.log('1. 转义 —— 不可信内容的第一道闸')
check('尖括号被转义', api.escapeHtml('<b>') === '&lt;b&gt;', api.escapeHtml('<b>'))
check('引号被转义', api.escapeHtml('"x"') === '&quot;x&quot;', api.escapeHtml('"x"'))
check('和号被转义（防实体绕过）', api.escapeHtml('&lt;') === '&amp;lt;', api.escapeHtml('&lt;'))

console.log('2. 行内格式')
check('行内代码', api.inlineMd('a ' + String.fromCharCode(96) + 'x=1' + String.fromCharCode(96) + ' b').includes('<code style='),
  api.inlineMd('a ' + String.fromCharCode(96) + 'x=1' + String.fromCharCode(96) + ' b'))
check('粗体', api.inlineMd('**b**').includes('<strong>b</strong>'), api.inlineMd('**b**'))
check('斜体', api.inlineMd('*i*').includes('<em>i</em>'), api.inlineMd('*i*'))
check('链接', api.inlineMd('[t](https://e.com)').includes('<a href="https://e.com"'), api.inlineMd('[t](https://e.com)'))

console.log('3. 注入防护 —— 消息体归 agent 写，不能让它执行代码')
const evil = api.inlineMd('<img src=x onerror="alert(1)">')
check('行内：HTML 标签被转义', evil.includes('&lt;img') && !evil.includes('<img'), evil)
const evilBlock = render('<script>alert(1)</script>')
check('段落：script 被转义', !flatten(evilBlock).includes('<script>'), flatten(evilBlock))
const evilLink = api.inlineMd('[x](javascript:alert(1))')
check('javascript: 协议不被链接化', !evilLink.includes('<a href="javascript'), evilLink)
const evilFence = render(String.fromCharCode(96).repeat(3) + '\n<img src=x onerror=alert(1)>\n' + String.fromCharCode(96).repeat(3))
check('代码块内容原样（且不解析为 HTML）', flatten(evilFence).includes('<img src=x onerror=alert(1)>'))

console.log('4. 块级结构')
const fence = String.fromCharCode(96).repeat(3)
const cb = render(fence + 'python\ndef f():\n    return 1\n' + fence)
check('围栏代码块生成 pre', tags(cb).includes('pre'), tags(cb))
check('语言标签被保留', flatten(cb).includes('python'), flatten(cb))
check('代码内容原样（含缩进）', flatten(cb).includes('def f():') && flatten(cb).includes('    return 1'), flatten(cb))

const unclosed = render(fence + 'js\nconst a = 1\n')
check('未闭合的围栏也不吞内容', flatten(unclosed).includes('const a = 1'), flatten(unclosed))

const h = render('## 标题\n正文')
check('标题渲染成加粗块', flatten(h).includes('标题'), flatten(h))
check('标题不残留井号', !flatten(h).includes('##'), flatten(h))

const list = render('- 甲\n- 乙')
check('无序列表生成 ul/li', tags(list).includes('ul') && tags(list).includes('li'), tags(list))
const olist = render('1. 甲\n2. 乙')
check('有序列表生成 ol', tags(olist).includes('ol'), tags(olist))
const quote = render('> 引用')
check('引用生成块', tags(quote).includes('div') && flatten(quote).includes('引用'), flatten(quote))
const hr = render('a\n\n---\n\nb')
check('分隔线不吞内容', flatten(hr).includes('a') && flatten(hr).includes('b'), flatten(hr))
check('空输入不炸', render('').children.length === 0)
check('undefined 输入不炸', render(undefined).children.length === 0)

console.log('')
console.log('RESULT  ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
