const fs = require("node:fs");
const zlib = require("node:zlib");
const p = process.argv[2];
const n = Number(process.argv[3] || 12);
const buf = fs.readFileSync(p);
const offs = [];
for (let i = 0; i + 4 <= buf.length; i++) if (buf[i]===0x28 && buf[i+1]===0xB5 && buf[i+2]===0x2F && buf[i+3]===0xFD) offs.push(i);
const parts = [];
for (let i = 0; i < offs.length; i++) { const s = offs[i], e = (i+1<offs.length)?offs[i+1]:buf.length; try { parts.push(zlib.zstdDecompressSync(buf.slice(s,e)).toString("utf8")); } catch {} }
const recs = parts.join("").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
console.log("records:", recs.length);
for (const o of recs.slice(-n)) {
  const s = JSON.stringify(o);
  console.log("--- " + o.type + " (seq " + o.seq + ") " + (s.length > 700 ? s.slice(0,700) + " ..." : s));
}