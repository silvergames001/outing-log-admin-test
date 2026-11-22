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
// 시작=종료는 '무기한'(00:00~00:00) 표시일 때만 허용
const cleanWins = (a) => (Array.isArray(a) ? a : []).filter(w => w && T.test(w.s) && T.test(w.e) && (w.s !== w.e || w.s === '00:00')).slice(0, 8).map(w => ({ s: w.s, e: w.e }));
const fmtWins = (w) => w.length ? w.map(x => x.s + '~' + x.e).join(', ') : '제한 없음';
const wOf = (g, r) => (g.wins || []).concat((r && r.wins) || []);

// ---- 같은 이름 + 같은 매니저 = 같은 학생 (기기·브라우저가 달라도 한 명으로 취급) ----
const IDX = 'epx:idx'; // '이름|매니저' -> 대표 id
const nk = (s) => String(s || '').normalize('NFC').replace(/\s+/g, '').toLowerCase();
const keyOf = (n, m) => nk(n) + '|' + nk(m);
const SEV = { active: 0, paused: 1, banned: 2 };
// 대표 기록 우선순위: 차단된 기록 먼저, 그다음 가장 오래된 기록
const rank = (a, b) => (SEV[b.status] === 2) - (SEV[a.status] === 2) || (a.first || 0) - (b.first || 0);

async function canon(name, mgr, id, create) {
  if (!name || !mgr) return { rec: parse(await rc(['HGET', KEY, id])) };
  const k = keyOf(name, mgr), same = (r) => r && r.name && keyOf(r.name, r.mgr) === k;
  let cid = await rc(['HGET', IDX, k]);
  let rec = cid ? parse(await rc(['HGET', KEY, cid])) : null;
  if (same(rec)) return { rec };
  // 인덱스가 없거나 깨졌으면 기존 기록(예전에 만들어진 중복 포함)에서 찾는다
  const cand = (await all()).filter(same).sort(rank);
  if (cand.length) { await rc(['HSET', IDX, k, cand[0].id]); return { rec: cand[0] }; }
  if (!create) return { rec: null };
  // 새 학생: 동시에 들어와도 먼저 선점한 한 기록만 대표가 된다
  if ((await rc(['HSETNX', IDX, k, id])) !== 1) {
    cid = await rc(['HGET', IDX, k]);
    rec = cid ? parse(await rc(['HGET', KEY, cid])) : null;
    if (same(rec)) return { rec };
    await rc(['HSET', IDX, k, id]);
  }
  return { rec: parse(await rc(['HGET', KEY, id])) };
}

// 이미 생겨 있는 중복 기록을 하나로 합친다 (기록·밴 내역은 모두 보존)
async function mergeDupes(list) {
  const groups = new Map(), gone = new Set();
  for (const r of list) { if (!r.name || !r.mgr) continue; const k = keyOf(r.name, r.mgr); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const byT = (a, b) => (a.t || 0) - (b.t || 0);
  for (const [k, arr] of groups) {
    if (arr.length < 2) continue;
    arr.sort(rank);
    const main = arr[0], rest = arr.slice(1);
    for (const r of rest) {
      main.logs = (main.logs || []).concat(r.logs || []);
      main.hist = (main.hist || []).concat(r.hist || []);
      main.first = Math.min(main.first || Infinity, r.first || Infinity);
      main.last = Math.max(main.last || 0, r.last || 0);
      if ((SEV[r.status] || 0) > (SEV[main.status] || 0)) { main.status = r.status; main.wins = r.wins || []; }
    }
    main.logs = main.logs.sort(byT).slice(-100);
    main.hist = main.hist.sort(byT).slice(-50);
    await rc(['HSET', KEY, main.id, JSON.stringify(main)]);
    await rc(['HSET', IDX, k, main.id]);
    for (const r of rest) { await rc(['HDEL', KEY, r.id]); gone.add(r.id); }
  }
  return list.filter((r) => !gone.has(r.id));
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const id = String(b.id || '');

    if (b.action === 'ping') {
      if (!/^[\w-]{8,64}$/.test(id)) return res.status(400).json({ error: 'id' });
      const name = cut(b.name, 40), mgr = cut(b.mgr, 40), isCheck = b.ev === 'check';
      const g = (await rc(['GET', RULES]).then(parse)) || {};
      let { rec } = await canon(name, mgr, id, !isCheck);
      if (isCheck) return res.status(200).json({ status: rec ? rec.status : 'active', wins: wOf(g, rec) });
      const now = Date.now();
      if (!rec) rec = { id, first: now, status: 'active', logs: [] };
      // 같은 학생으로 매칭된 경우엔 기존 표기를 유지 (다른 기기의 띄어쓰기·대소문자 차이로 이름이 바뀌지 않게)
      if (name && mgr && (!rec.name || !rec.mgr || keyOf(rec.name, rec.mgr) !== keyOf(name, mgr))) { rec.name = name; rec.mgr = mgr; }
      else { if (!rec.name && name) rec.name = name; if (!rec.mgr && mgr) rec.mgr = mgr; }
      rec.last = now;
      if ((b.ev === 'register' || b.ev === 'open') && rec.status === 'active' && rec.name) {
        // 같은 이름이 차단돼 있으면 새 기기로 등록해도 차단 유지
        if ((await all()).some(r => r.id !== rec.id && nk(r.name) === nk(rec.name) && r.status === 'banned')) rec.status = 'banned';
      }
      if (b.ev === 'blocked') rec.hist = (rec.hist || []).concat({ t: now, a: 'blocked', d: cut(b.detail, 120) }).slice(-50);
      if (LOG_EV.includes(b.ev)) rec.logs = (rec.logs || []).concat({ t: now, k: b.ev, d: cut(b.detail, 120) }).slice(-100);
      await rc(['HSET', KEY, rec.id, JSON.stringify(rec)]);
      return res.status(200).json({ status: rec.status, wins: wOf(g, rec) });
    }

    if (!okToken((req.headers.authorization || '').replace('Bearer ', ''))) return res.status(401).json({ error: '다시 로그인해주세요' });

    if (b.action === 'list') {
      const students = (await mergeDupes(await all())).sort((x, y) => (y.last || 0) - (x.last || 0)).map(r => ({ ...r, logs: (r.logs || []).slice(-30), hist: (r.hist || []).slice(-30) }));
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
    if (b.action === 'remove') {
      const old = parse(await rc(['HGET', KEY, id]));
      await rc(['HDEL', KEY, id]);
      if (old && old.name && old.mgr) await rc(['HDEL', IDX, keyOf(old.name, old.mgr)]);
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'action' });
  } catch (e) {
    return res.status(500).json({ error: e.message === 'storage' ? 'Redis(Upstash) 연결이 필요해요' : '서버 오류' });
  }
};
