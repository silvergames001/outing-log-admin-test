/* 학생 등록/외출 기록을 관리자 페이지로 보내고, 일시정지·차단 상태를 확인한다. index.html 맨 끝에서 불러옴 */
(function () {
  var K = 'epx_sid', id = '';
  try { id = dualGet(K) || ''; } catch (e) { }
  if (!id) {
    id = (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2)).replace(/[^\w-]/g, '');
    try { dualSet(K, id); } catch (e) { }
  }
  var blocked = null, box = null, wins = [];
  var MSG = {
    banned: ['Access Banned', '관리자에게 문의해주세요.'],
    paused: ['이용이 잠시 중지됐어요', '관리자가 확인 중이에요. 잠시 후 다시 확인해주세요.']
  };

  function hideBlock() { blocked = null; if (box) { var b = box; box = null; b.style.opacity = 0; setTimeout(function () { b.remove(); }, 350); } }
  function showBlock(st) {
    blocked = st;
    var m = MSG[st]; if (!m) return;
    if (!box) {
      box = document.createElement('div');
      box.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#fbfbfb;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:32px;text-align:center;font-family:inherit;opacity:0;transition:opacity .35s ease';
      document.body.appendChild(box);
      requestAnimationFrame(function () { requestAnimationFrame(function () { if (box) box.style.opacity = 1; }); });
    }
    var ic = st === 'banned' ? '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#f04452" stroke-width="2.6" stroke-linecap="round" aria-hidden="true" style="flex-shrink:0"><circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/></svg>' : '';
    box.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;gap:8px;font-size:22px;font-weight:700;color:#333d4b;letter-spacing:-.02em">' + ic + '<span>' + m[0] + '</span></div>' +
      '<div style="font-size:14px;font-weight:500;color:#8b95a1;line-height:1.55">' + m[1] + '</div>' +
      (st === 'paused' ? '<button type="button" id="stuRetry" style="margin-top:14px;border:none;border-radius:16px;background:#3182f6;color:#fff;font:700 16px inherit;font-family:inherit;padding:15px 28px">다시 확인</button>' : '');
    var r = box.querySelector('#stuRetry'); if (r) r.onclick = function () { ping('open'); };
  }
  function toM(t) { return +t.slice(0, 2) * 60 + +t.slice(3); }
  function activeWin() {  // 한국 시간 기준으로 제한 시간에 걸리는지 확인
    var d = new Date(Date.now() + 9 * 3600e3), n = d.getUTCHours() * 60 + d.getUTCMinutes();
    for (var i = 0; i < wins.length; i++) {
      var a = toM(wins[i].s), b = toM(wins[i].e);
      if (a < b ? (n >= a && n < b) : (n >= a || n < b)) return wins[i];
    }
    return null;
  }
  function apply(st) { if (st === 'banned' || st === 'paused') showBlock(st); else if (blocked) hideBlock(); }

  function ping(ev, detail, n, m) {
    var name = n || store.name, mgr = m || store.mgr;
    if (!name || !mgr) return Promise.resolve();
    return fetch('/api/students', {
      method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'ping', id: id, name: name, mgr: mgr, ev: ev, detail: detail || '' })
    }).then(function (r) { return r.json(); }).then(function (j) { wins = j.wins || []; apply(j.status); }).catch(function () { });
  }

  var _save = store.save;
  store.save = function (n, m) { _save.call(store, n, m); ping('register', '', n, m); };

  /* 제출 직전에 서버의 최신 밴 상태를 확인 (최대 2.5초 기다리고, 응답이 없으면 그대로 진행) */
  var verifying = false;
  function verify() {
    return Promise.race([ping('check'), new Promise(function (r) { setTimeout(r, 2500); })]);
  }
  var _post = post;
  post = function (btn, fields, ph, done) {
    if (blocked) { showBlock(blocked); return; }
    if (verifying) return;
    verifying = true;
    try { btn.disabled = true; btn.classList.add('sending'); } catch (e) { }
    verify().then(function () {
      verifying = false;
      try { btn.disabled = false; btn.classList.remove('sending'); } catch (e) { }
      if (blocked) { try { closeConfirm(); } catch (e) { } showBlock(blocked); return; }
      go(btn, fields, ph, done);
    });
  };
  function go(btn, fields, ph, done) {
    if (fields[E.mode] === '외출') {
      var w = activeWin();
      if (w) {
        try { closeConfirm(); } catch (e) { }
        try { showToast('지금은 외출할 수 없는 시간이에요 (' + w.s + ' ~ ' + w.e + ')'); } catch (e) { }
        ping('blocked', w.s + ' ~ ' + w.e);
        return;
      }
    }
    _post(btn, fields, ph, done);
    try {
      var g = function (k) { return fields[E[k]] || ''; };
      var ev = g('mode') === '외출' ? 'out' : g('backKind') === '지각' ? 'late' : 'back';
      var d = ev === 'out' ? g('purpose') + (g('etcReason') ? ' · ' + g('etcReason') : '') + ' · 복귀예정 ' + g('returnTime')
        : ev === 'late' ? '사유: ' + g('lateReason') : '복귀';
      ping(ev, d);
    } catch (e) { }
  }

  ping('open');
  document.addEventListener('visibilitychange', function () { if (!document.hidden) ping('check'); });
  window.addEventListener('focus', function () { ping('check'); });
  window.addEventListener('pageshow', function () { ping('check'); });
  window.addEventListener('online', function () { ping('check'); });
  setInterval(function () { if (!document.hidden) ping('check'); }, 15000);
})();
