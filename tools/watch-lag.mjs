/**
 * 延迟看门狗：守着抓「突然变慢」的现行（真机反馈 2026-09-14：会话内发消息偶发延迟，界面侧先卡几秒）。
 *
 * 为什么需要它：这个症状是**间歇的** —— 事后量什么都正常（我们量过三次：模型延迟几天不变、
 * 服务端每请求 0.3 ms、界面进程 29% 单核）。间歇症状只能靠**同时刻的多路采样**去对质：
 * 延迟发生时，到底是 DSH 进程被占住、还是整机被占住、还是两者都空着（那就是另外的原因）。
 *
 * 用法：node tools/watch-lag.mjs [秒数] [间隔ms]
 *   - 延迟期间 DSH CPU% 高（>100%）→ 进程被占住（多半是别的会话在跑重活）
 *   - 整机 CPU 高而 DSH 不高 → 机器被占住
 *   - 两者都低、3080 延迟却上千毫秒 → 不是负载，往下查浏览器/网络
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const seconds = Number(process.argv[2] || 120)
const interval = Number(process.argv[3] || 2000)

async function ps(cmd) {
  try {
    const { stdout } = await run('powershell', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', cmd], { timeout: 20000 })
    return stdout.trim()
  } catch { return '' }
}

const pid = Number(await ps('(Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess')) || 0
console.log('DSH(3080) PID = ' + pid + '；采样 ' + seconds + ' 秒，每 ' + interval + ' ms 一行')
console.log('时间        DSH-CPU%  3080延迟ms  整机CPU%  python  node  内存MB')

let lastCpu = null
const endAt = Date.now() + seconds * 1000
while (Date.now() < endAt) {
  const t0 = Date.now()
  const [cpuNow, lat, machine, counts, mem] = await Promise.all([
    ps('(Get-Process -Id ' + pid + ').CPU'),
    (async () => {
      let best = 1e9
      for (let i = 0; i < 3; i++) {
        const s = Date.now()
        try { const res = await fetch('http://127.0.0.1:3080/', { redirect: 'manual' }); await res.text() } catch {}
        best = Math.min(best, Date.now() - s)
      }
      return best
    })(),
    ps('(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average'),
    ps('("$(@(Get-Process -Name python -ErrorAction SilentlyContinue).Count) $(@(Get-Process -Name node -ErrorAction SilentlyContinue).Count)")'),
    ps('[math]::Round((Get-Process -Id ' + pid + ').WorkingSet64/1MB)'),
  ])
  const cpu = Number(cpuNow)
  const pct = lastCpu === null ? 0 : Math.round((cpu - lastCpu) / (interval / 1000) * 100)
  if (Number.isFinite(cpu)) lastCpu = cpu
  const latNum = Number(lat) || 0
  const row = [new Date().toLocaleTimeString(), (String(pct) + '%').padStart(9), String(latNum).padStart(11),
    (String(Number(machine) || 0) + '%').padStart(8), counts.padStart(8), (mem + 'MB').padStart(9)].join('  ')
  console.log(row + (latNum > 300 || pct > 120 ? '   <== 这一行有事' : ''))
  const rest = interval - (Date.now() - t0)
  if (rest > 0) await new Promise((r) => setTimeout(r, rest))
}

