// GET  /api/config                      -> 공개 설정 (index.html이 사용)
// POST /api/config {action:'login'}     -> 비밀번호 확인 후 토큰 발급
// POST /api/config {action:'save'}      -> 토큰 확인 후 설정 저장
const crypto = require('crypto');

const R_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const R_TOK = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const KEY = 'epx:config';
const SECRET = process.env.ADMIN_SECRET || process.env.ADMIN_PASSWORD || '';

const DEFAULTS = {
  managers: ['😭잘 모름😭', '김소희Ⓜ️', '김혜리Ⓜ️', '송유진Ⓜ️', '엄혜령Ⓜ️', '정준환Ⓜ️', '김진주Ⓜ️', '이명호Ⓜ️', '심예지™️', '윤현식™️'],
  sheets: [{ name: '기본 응답 시트', id: '1tokX8tWX0I02U4GwVRqX2EqF6bVquctKfV3YsqDpA1k', gid: '', active: true }]
};

async function rGet() {
  if (!R_URL || !R_TOK) return null;
  const r = await fetch(`${R_URL}/get/${KEY}`, { headers: { Authorization: `Bearer ${R_TOK}` } });
  const j = await r.json();
  return j.result ? JSON.parse(j.result) : null;
}
async function rSet(v) {
  if (!R_URL || !R_TOK) throw new Error('storage');
  const r = await fetch(R_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${R_TOK}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(['SET', KEY, JSON.stringify(v)])
  });
  if (!r.ok) throw new Error('storage');
}

const sign = (exp) => crypto.createHmac('sha256', SECRET).update(String(exp)).digest('hex');
function makeToken() { const exp = Date.now() + 12 * 3600 * 1000; return exp + '.' + sign(exp); }
function okToken(t) {
  if (!SECRET || !t) return false;
  const [exp, sig] = String(t).split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const a = Buffer.from(sig), b = Buffer.from(sign(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function safeEq(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function clean(c) {
  const managers = [...new Set((c.managers || []).map(s => String(s).trim()).filter(Boolean))].slice(0, 100);
  const sheets = (c.sheets || []).slice(0, 30).map(s => ({
    name: String(s.name || '').trim().slice(0, 40),
    id: String(s.id || '').trim(),
    gid: String(s.gid || '').trim(),
    active: s.active !== false
  })).filter(s => /^[\w-]{20,}$/.test(s.id) && /^\d*$/.test(s.gid));
  return { managers, sheets };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      return res.status(200).json((await rGet()) || DEFAULTS);
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

    if (body.action === 'login') {
      if (!process.env.ADMIN_PASSWORD) return res.status(500).json({ error: 'ADMIN_PASSWORD 환경변수가 없어요' });
      if (!safeEq(body.password || '', process.env.ADMIN_PASSWORD)) {
        await new Promise(r => setTimeout(r, 600));
        return res.status(401).json({ error: '비밀번호가 맞지 않아요' });
      }
      return res.status(200).json({ token: makeToken() });
    }

    if (body.action === 'save') {
      const t = (req.headers.authorization || '').replace('Bearer ', '');
      if (!okToken(t)) return res.status(401).json({ error: '다시 로그인해주세요' });
      const next = clean(body.config || {});
      if (!next.managers.length) return res.status(400).json({ error: '매니저를 1명 이상 남겨주세요' });
      await rSet(next);
      return res.status(200).json(next);
    }
    return res.status(400).json({ error: 'action' });
  } catch (e) {
    return res.status(500).json({ error: e.message === 'storage' ? 'Redis(Upstash) 연결이 필요해요' : '서버 오류' });
  }
};
