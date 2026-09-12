const fs = require("node:fs");
const zlib = require("node:zlib");
const buf = fs.readFileSync(process.argv[2]);
const offs = [];
for (let i = 0; i + 4 <= buf.length; i++) if (buf[i]===0x28 && buf[i+1]===0xB5 && buf[i+2]===0x2F && buf[i+3]===0xFD) offs.push(i);
const parts = [];
for (let i = 0; i < offs.length; i++) { const s = offs[i], e = (i+1<offs.length)?offs[i+1]:buf.length; try { parts.push(zlib.zstdDecompressSync(buf.slice(s,e)).toString("utf8")); } catch {} }
const recs = parts.join("").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const hits = recs.filter(r => r.type === "agent-preset/selected");
console.log("日志里的 preset 选择事件:", hits.length);
for (const h of hits.slice(-4)) console.log("  seq " + h.seq + " -> " + JSON.stringify(h.data));
const header = recs.find(r => r.type === "session");
console.log("会话 header:", JSON.stringify(header));