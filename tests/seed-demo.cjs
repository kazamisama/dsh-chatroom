const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const file = path.join(os.homedir(), ".dsh", "dsh-chatroom", "rooms.json");
const raw = fs.readFileSync(file, "utf8");
fs.writeFileSync(file + ".bak", raw, "utf8");
const st = JSON.parse(raw);
const roomId = "room-demo01";
const now = Date.now();
const A = "session-f2502e87-ad61-42e5-a557-3dad9e18f0f7";
const B = "session-demo0001-1111-2222-3333-444455556666";
st.rooms.push({ id: roomId, name: "变更视图演示（可删）", createdBy: "user", createdAt: now, policy: { maxMembers: 5, threadBudget: 4 } });
st.members.push({ roomId, sessionId: A, roleName: "实现者", enabled: true, joinedAt: now, subscriptions: [], selfDescription: "在改 parse_cfg" });
st.members.push({ roomId, sessionId: B, roleName: "审计员", enabled: false, joinedAt: now, subscriptions: [], selfDescription: "" });
const seqs = [st.nextSeq, st.nextSeq + 1, st.nextSeq + 2];
st.nextSeq += 3;
const bodies = [
  "把 parse_cfg 改成从环境变量读 [app.py] — 给引擎侧留配置口  git 校验 ✓ 已证实：app.py（有改动）",
  "顺手清了一下 util.py 的死代码 [util.py]  git 校验 ✗ 与事实不符：util.py 在仓库里自房间上次记录（491818e）以来无改动痕迹（no-declared-file-shows-any-change）",
  "我改了 engine 里的调度逻辑 [scheduler.py] — 不在 git 仓库里  git 校验 ? 未证实（不在 git 仓库内）—— 查不到不等于撒谎，自行判断",
];
for (let i = 0; i < 3; i++) {
  st.messages.push({ seq: seqs[i], roomId, sender: { sessionId: A, roleName: "实现者" }, kind: "change-notice", body: bodies[i], refs: i === 0 ? ["app.py"] : i === 1 ? ["util.py"] : ["scheduler.py"], terminal: false, threadId: null, mentions: [B], ts: now - (3 - i) * 60000 });
}
st.changes.push({ id: "chg-" + seqs[0], seq: seqs[0], roomId, workspaceId: "C:\\Users\\chiriu\\Documents\\workspace\\ulysses", files: ["app.py"], symbols: ["parse_cfg"], declaredBy: A, verdict: "verified", reason: "all-declared-files-have-evidence", head: "491818e", diffStat: "12\t3\tapp.py", perFile: [{ path: "app.py", dirty: true, staged: false, recentCommit: false, evidence: true }], related: [B], ts: now - 120000 });
st.changes.push({ id: "chg-" + seqs[1], seq: seqs[1], roomId, workspaceId: "C:\\Users\\chiriu\\Documents\\workspace\\ulysses", files: ["util.py"], symbols: [], declaredBy: A, verdict: "contradicted", reason: "no-declared-file-shows-any-change", head: "491818e", diffStat: "", perFile: [{ path: "util.py", dirty: false, staged: false, recentCommit: false, evidence: false }], related: [B], ts: now - 60000 });
st.changes.push({ id: "chg-" + seqs[2], seq: seqs[2], roomId, workspaceId: "D:\\dsh_dev", files: ["scheduler.py"], symbols: [], declaredBy: A, verdict: "unverified", reason: "not-a-git-worktree", head: "", diffStat: "", perFile: [{ path: "scheduler.py", dirty: false, staged: false, recentCommit: false, evidence: false }], related: [B], ts: now - 10000 });
st.judgments.push({ roomId, seq: seqs[0], sessionId: B, verdict: "catch-up", note: "我依赖 parse_cfg，马上跟", ts: now - 60000 });
st.messages.push({ seq: (st.nextSeq++), roomId, sender: { sessionId: B, roleName: "审计员" }, kind: "judgment", body: "catch-up: 我依赖 parse_cfg，马上跟", refs: [], terminal: true, threadId: "re:" + seqs[0], ts: now - 60000 });
fs.writeFileSync(file, JSON.stringify(st, null, 2), "utf8");
console.log("演示房已写入: " + roomId + "  seq=" + seqs.join(",") + "  备份: rooms.json.bak");