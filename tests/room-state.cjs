const fs = require("node:fs");
const p = process.argv[2];
const raw = fs.readFileSync(p, "utf8");
console.log("file bytes:", Buffer.byteLength(raw), "chars:", raw.length);
let o;
try { o = JSON.parse(raw); } catch (e) { console.log("parse error:", e.message); process.exit(1); }
const rooms = o.result.value.rooms;
console.log("rooms:", rooms.map(r => r.room.name + "(" + r.room.id + ")").join(", "));
for (const r of rooms) {
  console.log("");
  console.log("== " + r.room.name + " ==");
  console.log("  消息 " + r.messages.length + " / 表态 " + r.judgments.length + " / 待表态 " + r.pending.length);
  for (const m of r.messages) {
    const who = m.sender.user ? "用户" : "成员 " + String(m.sender.sessionId).slice(-8) + (m.sender.roleName ? "「" + m.sender.roleName + "」" : "");
    console.log("  #" + m.seq + " " + who + " [" + m.kind + (m.terminal ? "·终端" : "") + "] " + String(m.body).slice(0, 100));
  }
  console.log("  成员: " + r.members.map(m => (m.title || m.shortId) + (m.owed ? "[欠表态]" : "[已表态:" + (m.verdict || "-") + "]")).join(" | "));
}