'use strict';
// MonoBow guest-room server. No dependencies. Server owns turns, scores and results.
const http = require('http'), https = require('https'), fs = require('fs'), crypto = require('crypto');

// ---- game rules (must match Rules.java) ----
const BX = 190, BY = 450, TX = 1400, V = 1500, G = 1200, CY = 450, MAXA = 55, ARROWS = 5;
const ZR = [20, 42, 75, 115], ZS = [10, 7, 4, 2];
const impactY = d => { const r = d * Math.PI / 180, t = (TX - BX) / (V * Math.cos(r));
  return BY - V * Math.sin(r) * t + 0.5 * G * t * t; };
const zone = dy => { const a = Math.abs(dy); for (let i = 0; i < 4; i++) if (a <= ZR[i]) return ZS[i]; return 0; };

// ---- limits ----
const AWAY_MS = 20000, ABANDON_MS = 60000, ROOM_TTL = 30 * 60000, MAX_ROOMS = 2000, MAX_BODY = 2048;
const RATE = 90, RATE_WIN = 60000;               // requests per IP per minute
const rooms = new Map(), hits = new Map();
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const rid = n => { let s = ''; for (let i = 0; i < n; i++) s += ALPHA[crypto.randomInt(ALPHA.length)]; return s; };
const clean = s => String(s || 'GUEST').replace(/[^\w \-]/g, '').trim().slice(0, 12).toUpperCase() || 'GUEST';
const validCode = c => typeof c === 'string' && /^[A-Z2-9]{4}$/.test(c);

function newRoom(name) {
  let code; do { code = rid(4); } while (rooms.has(code));
  const r = { code, status: 'waiting', turn: 0, seq: 0, scores: [0, 0], left: [ARROWS, ARROWS], names: [clean(name), ''],
    tokens: [rid(24), null], seen: [Date.now(), 0], last: null, winner: -1, created: Date.now() };
  rooms.set(code, r); return r;
}
function refresh(r) {                              // disconnect handling
  const now = Date.now();
  if (r.status === 'playing' || r.status === 'waiting') {
    for (let i = 0; i < 2; i++) if (r.tokens[i] && now - r.seen[i] > ABANDON_MS && r.status !== 'done') {
      r.status = 'abandoned'; r.winner = 1 - i; }
  }
}
function view(r, pid) {
  const opp = 1 - pid;
  return { code: r.code, status: r.status, turn: r.turn, seq: r.seq, scores: r.scores, left: r.left,
    names: r.names, last: r.last, winner: r.winner, pid,
    oppAway: r.status === 'playing' && Date.now() - r.seen[opp] > AWAY_MS };
}
function auth(r, token) {
  if (!r || typeof token !== 'string') return -1;
  for (let i = 0; i < 2; i++) if (r.tokens[i] && token.length === r.tokens[i].length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(r.tokens[i]))) return i;
  return -1;
}
function shoot(r, pid, angle, clientSeq) {
  if (r.status !== 'playing') return [409, 'NOT PLAYING'];
  if (r.turn !== pid) return [409, 'NOT YOUR TURN'];
  if (clientSeq !== r.seq) return [409, 'STALE'];     // blocks duplicate / replayed shots
  if (typeof angle !== 'number' || !isFinite(angle)) return [400, 'BAD ANGLE'];
  angle = Math.max(0, Math.min(MAXA, angle));
  const score = zone(impactY(angle) - CY);
  r.scores[pid] += score; r.left[pid]--; r.seq++;
  r.last = { pid, angle, score };
  if (r.left[0] === 0 && r.left[1] === 0) {
    if (r.scores[0] === r.scores[1]) { r.left = [1, 1]; r.turn = 0; }     // sudden death
    else { r.status = 'done'; r.winner = r.scores[0] > r.scores[1] ? 0 : 1; }
  } else r.turn = 1 - pid;
  return [200, null];
}

function handle(req, res, body) {
  const u = new URL(req.url, 'http://x'); const send = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const err = (c, m) => send(c, { error: m });
  const now = Date.now();
  if (u.pathname === '/health') return send(200, { ok: true });
  let b = {};
  if (req.method === 'POST') { try { b = JSON.parse(body || '{}'); } catch (e) { return err(400, 'BAD JSON'); } }
  if (req.method === 'POST' && u.pathname === '/room/create') {
    if (rooms.size >= MAX_ROOMS) return err(503, 'SERVER FULL');
    const r = newRoom(b.name); return send(200, { code: r.code, token: r.tokens[0], pid: 0 });
  }
  const code = req.method === 'GET' ? u.searchParams.get('code') : b.code;
  if (!validCode(code)) return err(400, 'BAD CODE');
  const r = rooms.get(code); if (!r) return err(404, 'ROOM NOT FOUND');
  if (req.method === 'POST' && u.pathname === '/room/join') {
    if (r.tokens[1] || r.status !== 'waiting') return err(409, 'ROOM FULL');
    r.tokens[1] = rid(24); r.names[1] = clean(b.name); r.seen[1] = now; r.seen[0] = now; r.status = 'playing';
    return send(200, Object.assign(view(r, 1), { token: r.tokens[1] }));
  }
  const pid = auth(r, req.method === 'GET' ? u.searchParams.get('token') : b.token);
  if (pid < 0) return err(403, 'BAD TOKEN');
  r.seen[pid] = now; refresh(r);
  if (req.method === 'GET' && u.pathname === '/room/state') return send(200, view(r, pid));
  if (req.method === 'POST' && u.pathname === '/room/shoot') {
    const [c, m] = shoot(r, pid, b.angle, b.seq); return m ? err(c, m) : send(200, view(r, pid));
  }
  if (req.method === 'POST' && u.pathname === '/room/leave') {
    if (r.status !== 'done') { r.status = 'abandoned'; r.winner = 1 - pid; }
    return send(200, { ok: true });
  }
  err(404, 'NOT FOUND');
}

function server() {
  return (req, res) => {
    const ip = req.socket.remoteAddress, now = Date.now();
    const h = hits.get(ip) || { n: 0, t: now }; if (now - h.t > RATE_WIN) { h.n = 0; h.t = now; } h.n++; hits.set(ip, h);
    if (h.n > RATE) { res.writeHead(429, { 'Content-Type': 'application/json' }); return res.end('{"error":"SLOW DOWN"}'); }
    let body = '', big = false;
    req.on('data', d => { if (big) return; body += d; if (body.length > MAX_BODY) { big = true;
      res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close' }); res.end('{"error":"TOO LARGE"}'); } });
    req.on('end', () => { if (!big) try { handle(req, res, body); } catch (e) { res.writeHead(500); res.end('{"error":"SERVER ERROR"}'); } });
  };
}
setInterval(() => { const now = Date.now();
  for (const [k, r] of rooms) if (now - r.created > ROOM_TTL) rooms.delete(k);
  for (const [k, h] of hits) if (now - h.t > RATE_WIN) hits.delete(k); }, 30000).unref();

module.exports = { server, impactY, zone, rooms, shoot, newRoom };
if (require.main === module) {
  const port = +process.env.PORT || 8080;
  const s = process.env.TLS_KEY && process.env.TLS_CERT
    ? https.createServer({ key: fs.readFileSync(process.env.TLS_KEY), cert: fs.readFileSync(process.env.TLS_CERT) }, server())
    : http.createServer(server());   // plain HTTP only behind a TLS-terminating proxy (nginx, Caddy, Cloud Run...)
  s.listen(port, () => console.log('MonoBow server on :' + port));
}
