// POST /api/students
//  공개:  {action:'ping', id, name, mgr, ev, detail}  -> {status}   (ev: open|check|register|out|back|late)
//  관리자(토큰): list / set {id,status,wins} / setglobal {wins} / remove {id}
const crypto = require('crypto');
const R_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const R_TOK = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const KEY = 'epx:students';
const RULES = 'epx:rules'; // 전체 외출 제한 시간 + 기록
const SECRET = process.env.ADMIN_SECRET || process.env.ADMIN_PASSWORD || '';
const STATUS = ['active', 'paused', 'banned'];
const LOG_EV = ['register', 'out', 'back', 'late'];

async function rc(cmd) {
  if (!R_URL || !R_TOK) throw new Error('storage');
  const r = await fetch(R_URL, { method: 'POST', headers: { Authorization: `Bearer ${R_TOK}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error('storage');
  return j.result;
}
const parse = (v) => { try { return v ? JSON.parse(v) : null; } catch (e) { return null; } };
async function all() {
  const a = (await rc(['HGETALL', KEY])) || [], out = [];
  for (let i = 1; i < a.length; i += 2) { const r = parse(a[i]); if (r) out.push(r); }
  return out;
}
const sign = (exp) => crypto.createHmac('sha256', SECRET).update(String(exp)).digest('hex');
function okToken(t) {
  if (!SECRET || !t) return false;
  const [exp, sig] = String(t).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const a = Buffer.from(sig), b = Buffer.from(sign(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const cut = (s, n) => String(s || '').trim().slice(0, n);
const T = /^([01]\d|2[0-3]):[0-5]\d$/;
const cleanWins = (a) => (Array.isArray(a) ? a : []).filter(w => w && T.test(w.s) && T.test(w.e) && w.s !== w.e).slice(0, 8).map(w => ({ s: w.s, e: w.e }));
const fmtWins = (w) => w.length ? w.map(x => x.s + '~' + x.e).join(', ') : '제한 없음';
const wOf = (g, r) => (g.wins || []).concat((r && r.wins) || []);

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const id = String(b.id || '');

    if (b.action === 'ping') {
      if (!/^[\w-]{8,64}$/.test(id)) return res.status(400).json({ error: 'id' });
      let [rec, g] = await Promise.all([rc(['HGET', KEY, id]).then(parse), rc(['GET', RULES]).then(parse)]);
      g = g || {};
      if (b.ev === 'check') return res.status(200).json({ status: rec ? rec.status : 'active', wins: wOf(g, rec) });
      const now = Date.now();
      if (!rec) rec = { id, first: now, status: 'active', logs: [] };
      if (b.name) rec.name = cut(b.name, 40);
      if (b.mgr) rec.mgr = cut(b.mgr, 40);
      rec.last = now;
      if (b.ev === 'register' && rec.status === 'active' && rec.name) {
        // 같은 이름이 차단돼 있으면 새 기기로 등록해도 차단 유지
        if ((await all()).some(r => r.id !== id && r.name === rec.name && r.status === 'banned')) rec.status = 'banned';
      }
      if (b.ev === 'blocked') rec.hist = (rec.hist || []).concat({ t: now, a: 'blocked', d: cut(b.detail, 120) }).slice(-50);
      if (LOG_EV.includes(b.ev)) rec.logs = (rec.logs || []).concat({ t: now, k: b.ev, d: cut(b.detail, 120) }).slice(-100);
      await rc(['HSET', KEY, id, JSON.stringify(rec)]);
      return res.status(200).json({ status: rec.status, wins: wOf(g, rec) });
    }

    if (!okToken((req.headers.authorization || '').replace('Bearer ', ''))) return res.status(401).json({ error: '다시 로그인해주세요' });

    if (b.action === 'list') {
      const students = (await all()).sort((x, y) => (y.last || 0) - (x.last || 0)).map(r => ({ ...r, logs: (r.logs || []).slice(-30), hist: (r.hist || []).slice(-30) }));
      const g = parse(await rc(['GET', RULES])) || {};
      return res.status(200).json({ students, global: { wins: g.wins || [], hist: (g.hist || []).slice(-30) } });
    }
    if (b.action === 'set') {
      const rec = parse(await rc(['HGET', KEY, id]));
      if (!rec) return res.status(404).json({ error: '학생을 찾을 수 없어요' });
      const now = Date.now(); rec.hist = rec.hist || [];
      if (b.status !== undefined) {
        if (!STATUS.includes(b.status)) return res.status(400).json({ error: 'status' });
        if (rec.status !== b.status) { rec.hist.push({ t: now, a: b.status }); rec.status = b.status; }
      }
      if (b.wins !== undefined) {
        const w = cleanWins(b.wins);
        if (JSON.stringify(w) !== JSON.stringify(rec.wins || [])) { rec.wins = w; rec.hist.push({ t: now, a: 'win', d: fmtWins(w) }); }
      }
      rec.hist = rec.hist.slice(-50);
      await rc(['HSET', KEY, id, JSON.stringify(rec)]);
      return res.status(200).json({ ok: true });
    }
    if (b.action === 'setglobal') {
      const g = parse(await rc(['GET', RULES])) || {}, w = cleanWins(b.wins);
      if (JSON.stringify(w) !== JSON.stringify(g.wins || [])) {
        g.wins = w; g.hist = (g.hist || []).concat({ t: Date.now(), a: 'win', d: fmtWins(w) }).slice(-100);
        await rc(['SET', RULES, JSON.stringify(g)]);
      }
      return res.status(200).json({ ok: true });
    }
    if (b.action === 'remove') { await rc(['HDEL', KEY, id]); return res.status(200).json({ ok: true }); }
    return res.status(400).json({ error: 'action' });
  } catch (e) {
    return res.status(500).json({ error: e.message === 'storage' ? 'Redis(Upstash) 연결이 필요해요' : '서버 오류' });
  }
};
