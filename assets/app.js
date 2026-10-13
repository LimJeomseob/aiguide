/*
 * GNU 생성형 AI 윤리교육 이수 LMS — 프론트엔드
 * 화면: 랜딩 → 영상 선택(8대 원칙 단편 중 1편) → 신원 등록 → 영상 시청(실재생 시간·구간 커버리지 측정) → 이수 완료 / 이수 조회
 * 저장: GAS 웹앱 → 구글시트. GAS_URL 이 비어 있으면 브라우저 안의 데모 백엔드 사용.
 */
(function () {
  'use strict';

  var CFG = window.APP_CONFIG || {};
  var DEMO = !CFG.GAS_URL;
  var EVENT_KEY = CFG.EVENT_CODE || 'default';
  var LS_KEY = 'fairEthics.v1.' + EVENT_KEY;
  var DEMO_DB_KEY = 'fairEthics.demoDb.' + EVENT_KEY;
  var LOCK_NAME = 'fairEthics-video-' + EVENT_KEY;
  var TICK_MS = 250;
  var PERSIST_MS = 2000;
  var REQUEST_TIMEOUT_MS = 20000;

  var PRINCIPLES = [
    ['데이터 프라이버시 및 보안 중점', '생성형 AI 도구 사용에서 데이터 프라이버시와 보안의 최우선 고려. 데이터 보호 정책 및 관련 법률 준수, 데이터 저장과 공유 등 관리'],
    ['콘텐츠 정확성 및 책임', '생성형 AI의 결과물에 대한 교육 주체의 검토 및 수정. 부정확하거나 허구적인 콘텐츠의 확인 및 정확한 출처와 인용 제시'],
    ['민감 데이터 입력 금지', '공용 AI 도구 활용에서 민감한 정보 입력 유의. 교육 주체별 승인된 보안 플랫폼에서 민감 데이터 입력 및 사용'],
    ['브레인스토밍에 생성형 AI 활용 권장', '생성형 AI 도구의 교육 및 학습 유용성 활용. 교육 주체별 생성된 결과물에 대한 교육 목적에 따른 검토 수정'],
    ['생성형 AI 사용 투명성', '교육 주체별 생성형 AI 사용 여부의 공지, 관련 자료 및 출처 공개. 생성형 AI 활용의 설명을 통한 신뢰 확보'],
    ['완전 자율적 사용 금지', '교육과 학습의 보조 도구로서 생성형 AI 사용. 교육 및 학습에서 생성형 AI의 자율성에 대한 교수자의 지도와 감독'],
    ['윤리적 및 포용적 사용', '생성형 AI 활용에서 접근 기회 불평등, 편향과 차별, 저작권 등의 윤리적 문제 검토와 GNU 교육공동체 구성원의 포용성 확보'],
    ['도구 관리 및 환류', '생성형 AI 활용을 위한 관련 부서의 지원(생성형 AI 추천 도구의 목록화 및 배포 등). 윤리가이드라인 교육, 교수자 지원 및 평가, 환류 등 제도적 개선 노력']
  ];

  /* ================================================================ */
  /* 공통 유틸                                                         */
  /* ================================================================ */

  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtClock(sec) {
    sec = Math.max(0, Math.floor(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ':' + pad2(m) : pad2(m)) + ':' + pad2(s);
  }
  function fmtMinSec(sec) {
    sec = Math.max(0, Math.ceil(sec));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m ? m + '분' + (s ? ' ' + s + '초' : '') : s + '초';
  }
  function round(v, d) { var f = Math.pow(10, d); return Math.round(v * f) / f; }
  function esc(s) {
    return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function loadStore() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) { return {}; }
  }
  function saveStore() {
    if (T.dormant) return; // 다른 탭에 넘겨준 뒤에는 기록하지 않음
    try { localStorage.setItem(LS_KEY, JSON.stringify(store)); } catch (e) { /* 저장 불가 환경 */ }
  }

  var store = loadStore();
  var conf = null;

  var toastTimer = null;
  function toast(msg, ms) {
    var el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, ms || 4000);
  }

  function modal(opts) {
    return new Promise(function (resolve) {
      $('#modal-title').textContent = opts.title || '';
      $('#modal-body').textContent = opts.body || '';
      var ok = $('#modal-ok'), cancel = $('#modal-cancel');
      ok.textContent = opts.ok || '확인';
      cancel.textContent = opts.cancel || '취소';
      cancel.hidden = !opts.cancel;
      $('#modal').hidden = false;
      ok.focus();
      function done(v) {
        $('#modal').hidden = true;
        ok.onclick = cancel.onclick = null;
        resolve(v);
      }
      ok.onclick = function () { done(true); };
      cancel.onclick = function () { done(false); };
    });
  }

  function show(id) {
    $all('.view').forEach(function (v) { v.hidden = v.id !== 'view-' + id; });
    window.scrollTo(0, 0);
    var main = $('#main');
    if (main && id !== 'loading') main.focus({ preventScroll: true });
  }

  /* ================================================================ */
  /* API (GAS 또는 데모)                                               */
  /* ================================================================ */

  function ApiError(code, message, field, network) {
    this.code = code; this.message = message; this.field = field || null; this.network = !!network;
  }

  var demoEnv = null;
  var demoSaveTimer = null;

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = function () { reject(new Error('스크립트 로드 실패: ' + src)); };
      document.head.appendChild(s);
    });
  }

  var api = {
    token: CFG.EVENT_TOKEN || '',

    init: function () {
      if (!DEMO) return Promise.resolve();
      return loadScript('assets/mock-gas.js').then(function () {
        demoEnv = window.MockGas.createEnv({
          load: function () { try { return JSON.parse(localStorage.getItem(DEMO_DB_KEY)); } catch (e) { return null; } },
          save: function (db) {
            clearTimeout(demoSaveTimer);
            demoSaveTimer = setTimeout(function () {
              try { localStorage.setItem(DEMO_DB_KEY, JSON.stringify(db)); } catch (e) { /* 용량 초과 등 */ }
            }, 30);
          }
        });
        ['SpreadsheetApp', 'LockService', 'CacheService', 'PropertiesService', 'Session', 'Utilities', 'ContentService', 'Logger']
          .forEach(function (k) { window[k] = demoEnv[k]; });
        return loadScript('gas/Code.js');
      }).then(function () {
        if (!demoEnv.SpreadsheetApp.getActiveSpreadsheet().getSheetByName('config')) window.setup();
        api.token = window.getConfig_().event_token;
      });
    },

    getConfig: function () {
      if (DEMO) return demoCall(function () { return window.doGet({ parameter: { action: 'config' } }); });
      return request(CFG.GAS_URL + '?action=config', { method: 'GET' });
    },

    post: function (action, body) {
      var payload = Object.assign({}, body, { action: action, token: api.token });
      if (DEMO) {
        return demoCall(function () { return window.doPost({ postData: { contents: JSON.stringify(payload) } }); });
      }
      return request(CFG.GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // CORS 사전요청 없이 전송
        body: JSON.stringify(payload)
      });
    },

    /** 화면을 떠날 때 응답 없이 마지막 상태를 보낸다 */
    beacon: function (action, body) {
      var payload = Object.assign({}, body, { action: action, token: api.token });
      if (DEMO) {
        try { window.doPost({ postData: { contents: JSON.stringify(payload) } }); } catch (e) { /* 무시 */ }
        return;
      }
      try {
        if (navigator.sendBeacon) {
          navigator.sendBeacon(CFG.GAS_URL, new Blob([JSON.stringify(payload)], { type: 'text/plain;charset=utf-8' }));
        }
      } catch (e) { /* 무시 */ }
    }
  };

  function demoCall(fn) {
    if (navigator.onLine === false) return Promise.reject(new ApiError('NETWORK', '네트워크에 연결되어 있지 않습니다.', null, true));
    return sleep(120 + Math.random() * 180).then(function () {
      var res = JSON.parse(fn().getContent());
      if (!res.ok) throw new ApiError(res.code, res.error, res.field);
      return res;
    });
  }

  function request(url, init) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, REQUEST_TIMEOUT_MS);
    init.redirect = 'follow';
    if (ctrl) init.signal = ctrl.signal;
    return fetch(url, init).then(function (r) {
      if (!r.ok) throw new ApiError('HTTP_' + r.status, '서버 응답 오류(' + r.status + ')', null, true);
      return r.json();
    }, function () {
      throw new ApiError('NETWORK', '네트워크 연결을 확인해 주세요.', null, true);
    }).then(function (res) {
      clearTimeout(timer);
      if (!res || !res.ok) throw new ApiError(res && res.code, (res && res.error) || '알 수 없는 오류', res && res.field);
      return res;
    }, function (err) {
      clearTimeout(timer);
      throw err instanceof ApiError ? err : new ApiError('NETWORK', '네트워크 연결을 확인해 주세요.', null, true);
    });
  }

  function isRetryable(err) { return err && (err.network || err.code === 'BUSY' || err.code === 'SERVER_ERROR'); }

  /* ================================================================ */
  /* 시청 측정기                                                       */
  /* ================================================================ */

  var T = {
    duration: 0,
    covered: null,      // Uint8Array, 1초 단위 시청 여부
    coveredCount: 0,
    watched: 0,         // 실재생 누적 초
    sinceHb: 0,
    lastPos: 0,
    lastTick: 0,
    playing: false,
    pausedByHide: false,
    eligible: false,
    milestone: 0,
    dormant: false,     // 다른 탭·기기에 넘겨준 상태
    lastPersist: 0
  };

  var player = null;
  var playerReady = false;
  var tickTimer = null;
  var flushTimer = null;
  var flushing = false;
  var completing = false;
  var completeRetryTimer = null;
  var releaseLock = null;

  function passRatio() { return (conf && conf.pass_ratio) || 0.9; }
  function hbSec() { return (conf && conf.heartbeat_sec) || 30; }
  /** 현재 세션의 영상(서버가 register 응답으로 확정한 값) */
  function currentVideo() { return store.video || null; }
  function videoDuration() { var v = currentVideo(); return (v && Number(v.duration_sec)) || 0; }
  function videoById(id) {
    var list = (conf && conf.videos) || [];
    for (var i = 0; i < list.length; i++) if (list[i].video_id === id) return list[i];
    return null;
  }
  function youtubeUrl(id) {
    return id ? 'https://www.youtube.com/watch?v=' + encodeURIComponent(id)
      : (conf && conf.playlist_url) || 'https://www.youtube.com/playlist?list=PLWHIHuOG5gKydLHOJjB8cJzRQpHpJmPuq';
  }

  function initTracker(duration) {
    T.duration = duration;
    T.covered = new Uint8Array(Math.ceil(duration));
    T.coveredCount = 0;
    (store.ranges || []).forEach(function (r) { markBins(r[0], r[1]); });
    T.watched = Math.max(T.watched, Number(store.watched) || 0);
    T.sinceHb = 0;
    T.milestone = Math.floor(effectiveRatio() * 4);
  }

  function markBins(from, to) {
    var a = Math.max(0, Math.floor(from)), b = Math.min(T.covered.length, Math.floor(to));
    for (var i = a; i < b; i++) {
      if (!T.covered[i]) { T.covered[i] = 1; T.coveredCount++; }
    }
  }

  function toRanges() {
    var out = [], start = -1, c = T.covered;
    if (!c) return store.ranges || [];
    for (var i = 0; i <= c.length; i++) {
      if (i < c.length && c[i]) { if (start < 0) start = i; }
      else if (start >= 0) { out.push([start, i]); start = -1; }
    }
    return out;
  }

  function effectiveRatio() {
    if (!T.duration) return 0;
    return Math.min(T.coveredCount, T.watched) / T.duration;
  }

  function firstGap() {
    if (!T.covered) return 0;
    for (var i = 0; i < T.covered.length; i++) if (!T.covered[i]) return i;
    return -1;
  }

  function currentPos() {
    try { return player && playerReady ? player.getCurrentTime() || 0 : Number(store.position) || 0; } catch (e) { return 0; }
  }

  function currentState() {
    return {
      watched_sec: round(T.covered ? T.watched : Number(store.watched) || 0, 1),
      ranges: toRanges(),
      position: round(currentPos(), 1),
      duration: T.duration || videoDuration() || 0
    };
  }

  function persist() {
    if (T.covered) {
      store.watched = round(T.watched, 1);
      store.ranges = toRanges();
      store.position = round(currentPos(), 1);
    }
    T.lastPersist = Date.now();
    saveStore();
  }

  function enqueue(type) {
    if (!store.session_id || T.dormant) return;
    store.seq = (store.seq || 1);
    store.queue = store.queue || [];
    store.queue.push({
      seq: store.seq++,
      type: type,
      player_time: round(currentPos(), 1),
      watched_sec: round(T.watched, 1),
      coverage: round(effectiveRatio(), 4),
      client_at: Date.now()
    });
    if (store.queue.length > 600) store.queue = store.queue.slice(-600);
    persist();
    renderSync();
  }

  function tick() {
    if (!player || !playerReady || T.dormant || !T.covered) return;
    var now = performance.now();
    var state = -1;
    try { state = player.getPlayerState(); } catch (e) { /* 무시 */ }
    var visible = document.visibilityState === 'visible';

    if (state === 1 /* PLAYING */ && visible) {
      var pos = currentPos();
      if (!T.playing) {
        // 재생 시작 직후: 기준점만 잡는다
        T.playing = true;
        T.lastPos = pos;
      } else {
        var dt = (now - T.lastTick) / 1000;
        var adv = pos - T.lastPos;
        if (dt > 0 && dt < 5) {
          var add = Math.min(dt, 2);
          T.watched += add;
          T.sinceHb += add;
          if (adv > 0 && adv <= dt * 1.5 + 0.6) markBins(T.lastPos, pos);
          else if (adv > dt * 1.5 + 0.6 || adv < -1.5) enqueue('seek');
        }
        T.lastPos = pos;
        if (T.sinceHb >= hbSec()) {
          T.sinceHb -= hbSec();
          enqueue('heartbeat');
        }
      }
    } else {
      T.playing = false;
    }
    T.lastTick = now;

    renderProgress();
    if (Date.now() - T.lastPersist > PERSIST_MS) persist();
  }

  /* ================================================================ */
  /* 서버 동기화                                                       */
  /* ================================================================ */

  function flush() {
    if (flushing || T.dormant || !store.session_id) return Promise.resolve();
    var events = (store.queue || []).slice(0, 150);
    flushing = true;
    renderSync();
    return api.post('heartbeat', { session_id: store.session_id, events: events, state: currentState() })
      .then(function (r) {
        if (r.valid === false) return onSuperseded();
        store.queue = (store.queue || []).filter(function (e) { return e.seq > r.acked_seq; });
        store.lastSyncAt = Date.now();
        store.syncError = '';
        saveStore();
        if (store.queue.length >= 150) setTimeout(flush, 500);
      })
      .catch(function (err) {
        if (err.code === 'SESSION_NOT_FOUND') {
          store.syncError = '세션이 만료되었습니다. 다시 등록해 주세요.';
        } else {
          store.syncError = isRetryable(err) ? 'network' : err.message;
        }
        saveStore();
      })
      .then(function () { flushing = false; renderSync(); });
  }

  function flushBeacon() {
    if (T.dormant || !store.session_id) return;
    persist();
    api.beacon('heartbeat', { session_id: store.session_id, events: (store.queue || []).slice(0, 150), state: currentState() });
  }

  function startTimers() {
    stopTimers();
    T.lastTick = performance.now();
    tickTimer = setInterval(tick, TICK_MS);
    flushTimer = setInterval(function () {
      if ((store.queue && store.queue.length) || T.playing) flush();
    }, hbSec() * 1000);
  }
  function stopTimers() {
    clearInterval(tickTimer); clearInterval(flushTimer);
    tickTimer = flushTimer = null;
  }

  /* ================================================================ */
  /* 이수 요청                                                         */
  /* ================================================================ */

  function doComplete(auto) {
    if (completing || T.dormant || !store.session_id) return;
    if (T.covered && effectiveRatio() + 1e-9 < passRatio()) {
      if (!auto) toast('아직 이수 기준에 도달하지 않았습니다.');
      return;
    }
    completing = true;
    clearTimeout(completeRetryTimer);
    if (!store.pending_complete) enqueue('complete_request');
    store.pending_complete = true;
    persist();
    var btn = $('#btn-complete');
    btn.classList.add('loading');
    btn.textContent = '이수 확인 중…';

    api.post('complete', { session_id: store.session_id, events: (store.queue || []).slice(0, 300), state: currentState() })
      .then(function (r) {
        if (r.result === 'rejected') {
          store.pending_complete = false;
          saveStore();
          toast(r.message + ' 남은 시청 시간 약 ' + fmtMinSec(r.remaining_sec) + '.', 6000);
          return;
        }
        finishWith(r.completion, r.result);
      })
      .catch(function (err) {
        if (err.code === 'SUPERSEDED') { store.pending_complete = false; saveStore(); return onSuperseded(); }
        if (isRetryable(err)) {
          store.syncError = 'network';
          saveStore();
          renderSync();
          completeRetryTimer = setTimeout(function () { doComplete(true); }, 5000);
          return;
        }
        store.pending_complete = false;
        saveStore();
        toast(err.message, 6000);
      })
      .then(function () {
        completing = false;
        btn.classList.remove('loading');
        btn.textContent = '이수 완료';
      });
  }

  function finishWith(completion, result) {
    store = { completion: completion, completion_result: result };
    saveStore();
    teardownVideo();
    renderDone();
    location.hash = '';
    show('done');
  }

  /* ================================================================ */
  /* 탭 중복 방지                                                      */
  /* ================================================================ */

  function acquireTabLock(steal) {
    if (!navigator.locks || !navigator.locks.request) return Promise.resolve(true);
    return new Promise(function (resolve) {
      var opts = steal ? { steal: true } : { ifAvailable: true };
      navigator.locks.request(LOCK_NAME, opts, function (lock) {
        if (!lock) { resolve(false); return undefined; }
        resolve(true);
        return new Promise(function (rel) { releaseLock = rel; });
      }).catch(function () {
        // 다른 탭이 잠금을 가져감
        onTabTakenOver();
      });
    });
  }

  function onTabTakenOver() {
    if (T.dormant) return;
    T.dormant = true;
    releaseLock = null;
    try { if (player && playerReady) player.pauseVideo(); } catch (e) { /* 무시 */ }
    stopTimers();
    showCover('다른 탭(창)에서 교육을 이어서 진행합니다. 이 탭은 닫아 주세요.', '이 탭에서 계속하기', function () {
      location.reload();
    });
  }

  function onSuperseded() {
    if (T.dormant) return;
    T.dormant = true;
    stopTimers();
    try { if (player && playerReady) player.pauseVideo(); } catch (e) { /* 무시 */ }
    showCover('다른 기기 또는 창에서 같은 교번·학번으로 교육을 시작해 이 화면의 기록이 멈췄습니다.', '이 기기에서 이어서 하기', function () {
      reRegister();
    });
  }

  function reRegister() {
    if (!store.reg) { resetToLanding(); return; }
    var vid = currentVideo();
    api.post('register', Object.assign({}, store.reg, { consent: true, user_agent: navigator.userAgent, video_id: vid ? vid.video_id : '' }))
      .then(function (r) {
        if (r.already_completed) return finishWith(r.completion, r.completion.decision === '이수' ? 'passed' : 'held');
        store.session_id = r.session_id;
        store.video = r.video || store.video;
        store.seq = 1;
        store.queue = [];
        store.pending_complete = false;
        // 서버 진행 상태와 이 기기의 기록을 합친다(다음 동기화 때 서버에도 합쳐짐)
        mergeProgress(r.progress);
        T.dormant = false;
        saveStore();
        hideCover();
        startTimers();
        enqueue('resume');
        flush();
      })
      .catch(function (err) { toast(err.message, 6000); });
  }

  function mergeProgress(progress) {
    if (!progress) return;
    T.watched = Math.max(T.watched, Number(progress.watched_sec) || 0);
    store.watched = Math.max(Number(store.watched) || 0, Number(progress.watched_sec) || 0);
    var ranges = (store.ranges || []).concat(progress.covered_ranges || []);
    store.ranges = ranges;
    if (T.covered) ranges.forEach(function (r) { markBins(r[0], r[1]); });
    if (!store.position) store.position = Number(progress.last_position_sec) || 0;
  }

  /* ================================================================ */
  /* 플레이어                                                          */
  /* ================================================================ */

  var ytApiPromise = null;
  function loadYouTubeApi() {
    if (ytApiPromise) return ytApiPromise;
    ytApiPromise = new Promise(function (resolve, reject) {
      if (window.YT && window.YT.Player) return resolve();
      var prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = function () { if (prev) prev(); resolve(); };
      var s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = function () { reject(new Error('YT_API_LOAD_FAILED')); };
      document.head.appendChild(s);
    });
    return ytApiPromise;
  }

  function startPosition() {
    var pos = Math.floor(Number(store.position) || 0);
    var d = T.duration || videoDuration() || 0;
    if (d && pos >= d - 5) {
      var gap = firstGap();
      return gap > 0 ? gap : 0;
    }
    return pos;
  }

  function createPlayer() {
    var readyTimeout = setTimeout(function () {
      if (!playerReady) goFallback('timeout');
    }, 15000);

    var vid = currentVideo();
    if (!vid || !vid.video_id) { clearTimeout(readyTimeout); resetToLanding(); return Promise.resolve(); }
    return loadYouTubeApi().then(function () {
      if (videoDuration() && !T.covered) initTracker(videoDuration());
      player = new window.YT.Player('player', {
        videoId: vid.video_id,
        host: 'https://www.youtube-nocookie.com',
        playerVars: {
          playsinline: 1, rel: 0, modestbranding: 1, cc_load_policy: 1, cc_lang_pref: 'ko', hl: 'ko',
          start: startPosition()
        },
        events: {
          onReady: function () {
            clearTimeout(readyTimeout);
            playerReady = true;
            var d = Math.round(player.getDuration() || 0);
            if (!T.covered) {
              if (!d) return goFallback('duration');
              initTracker(d);
            } else if (d && d !== T.duration && Math.abs(d - T.duration) <= Math.max(2, T.duration * 0.03)) {
              // 재생목록 표시 길이(반올림)와 실제 길이의 오차 보정 — 서버도 같은 기준으로 판정한다
              var keepWatched = T.watched, keepRanges = toRanges();
              T.duration = d;
              T.covered = new Uint8Array(Math.ceil(d));
              T.coveredCount = 0;
              keepRanges.forEach(function (r) { markBins(r[0], r[1]); });
              T.watched = keepWatched;
            }
            renderProgress();
            startTimers();
            if (store.pending_complete) doComplete(true);
          },
          onStateChange: onPlayerState,
          onPlaybackRateChange: function (e) {
            if (e.data !== 1) {
              try { player.setPlaybackRate(1); } catch (err) { /* 무시 */ }
              enqueue('rate_reset');
              toast('재생 속도는 1배속으로 고정됩니다.');
            }
          },
          onError: function (e) {
            enqueue('player_error');
            goFallback('error-' + e.data);
          }
        }
      });
    }).catch(function () {
      clearTimeout(readyTimeout);
      goFallback('api');
    });
  }

  function onPlayerState(e) {
    if (T.dormant) return;
    var s = e.data;
    if (s === 1) {
      T.playing = false; // 다음 tick 에서 기준점을 다시 잡는다
      T.pausedByHide = false;
      setNotice('건너뛴 구간과 일시정지·화면 이탈 시간은 시청 시간에 포함되지 않습니다.');
      try { if (player.getPlaybackRate() !== 1) player.setPlaybackRate(1); } catch (err) { /* 무시 */ }
      enqueue('play');
    } else if (s === 2) {
      T.playing = false;
      enqueue('pause');
      flush();
    } else if (s === 0) {
      T.playing = false;
      enqueue('ended');
      if (effectiveRatio() + 1e-9 >= passRatio()) {
        doComplete(true);
      } else {
        var remain = passRatio() * T.duration - Math.min(T.coveredCount, T.watched);
        setNotice('영상이 끝났지만 건너뛴 구간이 있어 기준에 약 ' + fmtMinSec(remain) + ' 부족합니다. "안 본 구간으로 이동"을 눌러 이어서 시청해 주세요.', true);
        flush();
      }
    } else {
      T.playing = false;
    }
    renderProgress();
  }

  function goVideo() {
    show('video');
    var vid = currentVideo();
    $('#video-title').textContent = vid ? '원칙 ' + vid.principle_no + '. ' + vid.title : '';
    $('#link-youtube').href = youtubeUrl(vid && vid.video_id);
    $('#who').textContent = store.participant
      ? store.participant.member_type + ' · ' + store.participant.affiliation + ' · ' + store.participant.masked_name + ' 님'
      : '';
    acquireTabLock(false).then(function (got) {
      if (got) return beginVideo();
      showCover('이미 다른 탭(창)에서 교육 화면이 열려 있습니다.', '이 탭에서 계속하기', function () {
        acquireTabLock(true).then(function () {
          store = loadStore(); // 다른 탭이 저장한 최신 상태로 시작
          hideCover();
          beginVideo();
        });
      });
    });
  }

  function beginVideo() {
    T.dormant = false;
    renderSync();
    if (player) { startTimers(); return; }
    createPlayer();
    flush();
  }

  function teardownVideo() {
    stopTimers();
    clearTimeout(completeRetryTimer);
    try { if (player) player.destroy(); } catch (e) { /* 무시 */ }
    player = null;
    playerReady = false;
    T.covered = null; T.coveredCount = 0; T.watched = 0; T.duration = 0; T.playing = false; T.eligible = false;
    if (releaseLock) { releaseLock(); releaseLock = null; }
    var host = $('.player-wrap');
    if (host && !$('#player')) {
      var div = document.createElement('div');
      div.id = 'player';
      host.insertBefore(div, host.firstChild);
    }
  }

  function goFallback(reason) {
    if (T.dormant) return;
    stopTimers();
    persist();
    console.warn('player fallback:', reason);
    show('fallback');
  }

  /* ================================================================ */
  /* 화면 렌더링                                                       */
  /* ================================================================ */

  function showCover(text, btnText, onClick) {
    $('#player-cover-text').textContent = text;
    var b = $('#btn-cover-action');
    b.textContent = btnText;
    b.onclick = onClick;
    $('#player-cover').hidden = false;
    $('#btn-complete').disabled = true;
  }
  function hideCover() { $('#player-cover').hidden = true; }

  function setNotice(text, warn) {
    var el = $('#video-notice');
    el.textContent = text;
    el.classList.toggle('warn', !!warn);
  }

  function renderProgress() {
    var ratio = effectiveRatio();
    var pass = passRatio();
    var needSec = Math.max(0, pass * T.duration - Math.min(T.coveredCount, T.watched));
    $('#stat-watched').textContent = fmtClock(T.watched);
    $('#stat-ratio').textContent = Math.floor(ratio * 100) + '%';
    $('#stat-remaining').textContent = !T.duration ? '-' : ratio + 1e-9 >= pass ? '충족' : fmtClock(needSec);
    $('#bar-fill').style.width = Math.min(100, ratio * 100).toFixed(1) + '%';
    var bar = $('#bar');
    bar.setAttribute('aria-valuenow', String(Math.floor(ratio * 100)));
    bar.classList.toggle('ok', ratio + 1e-9 >= pass);

    var eligible = ratio + 1e-9 >= pass;
    var btn = $('#btn-complete');
    if (!completing) btn.disabled = !eligible || T.dormant;
    btn.classList.toggle('btn-pulse', eligible && !completing);
    if (eligible && !T.eligible) {
      T.eligible = true;
      announce('이수 기준을 충족했습니다. 이수 완료 버튼을 눌러 주세요.');
      setNotice('이수 기준을 충족했습니다. 아래 "이수 완료"를 눌러 주세요. 영상을 끝까지 보면 자동으로 처리됩니다.');
    }
    var m = Math.floor(ratio * 4);
    if (m > T.milestone && m < 4) { T.milestone = m; announce('진행률 ' + m * 25 + '퍼센트'); }

    var gap = firstGap();
    $('#btn-gap').hidden = !(T.covered && !eligible && gap >= 0 && !T.playing && T.watched > 0 && Math.abs(currentPos() - gap) > 3);
  }

  function announce(text) { $('#milestone').textContent = text; }

  function renderSync() {
    var el = $('#sync-status');
    if (!el) return;
    var n = (store.queue || []).length;
    el.classList.remove('pending', 'bad');
    if (T.dormant) { el.textContent = '이 화면의 기록이 중지되었습니다'; el.classList.add('bad'); return; }
    if (store.syncError && store.syncError !== 'network') { el.textContent = store.syncError; el.classList.add('bad'); return; }
    if (store.syncError === 'network' || navigator.onLine === false) {
      el.textContent = '전송 대기 ' + n + '건 · 연결되면 자동으로 저장됩니다';
      el.classList.add('pending');
      return;
    }
    if (flushing) { el.textContent = '기록 저장 중…'; return; }
    if (store.lastSyncAt) {
      var d = new Date(store.lastSyncAt);
      el.textContent = '기록 저장됨 ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) + (n ? ' · 대기 ' + n + '건' : '');
    } else {
      el.textContent = '시청 기록은 자동으로 저장됩니다';
    }
  }

  function renderPrinciples(target) {
    target.innerHTML = PRINCIPLES.map(function (p) {
      return '<li><b>' + esc(p[0]) + '</b><span>' + esc(p[1]) + '</span></li>';
    }).join('');
  }

  function renderDone() {
    var c = store.completion || {};
    var held = store.completion_result === 'held' || c.decision === '보류';
    $('#done-card').classList.toggle('held', held);
    $('#done-badge').textContent = held ? '확인 대기' : '이수 완료';
    $('#done-title').textContent = (conf && conf.event_name) || 'GNU 생성형 AI 윤리교육';
    $('#done-no').textContent = c.completion_no || '-';
    $('#done-at').textContent = c.completed_at || '-';
    var dv = videoById(c.video_id);
    $('#done-video').textContent = c.video_title ? ((dv ? '원칙 ' + dv.principle_no + '. ' : '') + c.video_title) : '-';
    if (conf && conf.playlist_url) $('#link-playlist').href = conf.playlist_url;
    $('#done-name').textContent = c.masked_name || '-';
    $('#done-aff').textContent = [c.member_type, c.affiliation].filter(Boolean).join(' · ') || '-';
    $('#done-msg').textContent = held
      ? '시청 기록 확인이 필요합니다. 부스 스태프에게 이 화면을 보여 주세요.'
      : '이 화면을 캡처해 보관하고, 필요하면 부스 스태프에게 보여 주세요.';
  }

  function applyConfig() {
    conf.videos = (conf.videos || []).slice().sort(function (a, b) { return (a.video_no || 0) - (b.video_no || 0); });
    if (conf.event_name) { $('#event-name').textContent = conf.event_name; document.title = conf.event_name; }
    if (conf.organizer) $('#organizer').textContent = conf.organizer;
    var durs = conf.videos.map(function (v) { return Number(v.duration_sec) || 0; }).filter(Boolean);
    if (durs.length) {
      var mn = Math.min.apply(null, durs), mx = Math.max.apply(null, durs);
      $('#fact-duration').textContent = '약 ' + Math.ceil((mx + 30) / 60) + '분 (영상 ' + fmtMinSec(mn) + '~' + fmtMinSec(mx) + ' 중 1편)';
    }
    var pct = Math.round(passRatio() * 100);
    $('#fact-pass').textContent = '선택한 영상 ' + pct + '% 이상 시청';
    $('#bar-mark').style.left = pct + '%';
    $('#bar-mark-label').textContent = '기준 ' + pct + '%';
    $('#link-youtube').href = youtubeUrl('');
    renderVideoList();
  }

  /* ================================================================ */
  /* 영상 선택                                                         */
  /* ================================================================ */

  function renderVideoList() {
    var list = (conf && conf.videos) || [];
    var picked = store.pick || '';
    $('#video-list').innerHTML = list.map(function (v) {
      return '<label><input type="radio" name="video_id" value="' + esc(v.video_id) + '"' + (v.video_id === picked ? ' checked' : '') + '>' +
        '<span class="video-card"><span class="no" aria-hidden="true">' + esc(v.principle_no || v.video_no) + '</span>' +
        '<span class="title">' + esc(v.title) + '</span>' +
        '<span class="dur">' + (v.duration_sec ? esc(fmtMinSec(v.duration_sec)) : '') + '</span></span></label>';
    }).join('');
    if (!list.length) $('#video-list').innerHTML = '<p class="muted">등록된 교육 영상이 없습니다. 스태프에게 문의해 주세요.</p>';
  }

  function onSelectSubmit(ev) {
    ev.preventDefault();
    var input = ev.target.querySelector('input[name=video_id]:checked');
    setFieldError('video_id', '');
    if (!input) { setFieldError('video_id', '시청할 영상을 하나 선택해 주세요.'); return; }
    var v = videoById(input.value);
    if (!v) { setFieldError('video_id', '선택할 수 없는 영상입니다. 새로고침 후 다시 시도해 주세요.'); return; }
    store.pick = v.video_id;
    saveStore();
    $('#picked-video').textContent = '선택한 영상: 원칙 ' + v.principle_no + '. ' + v.title + (v.duration_sec ? ' (' + fmtMinSec(v.duration_sec) + ')' : '');
    show('register');
  }

  /* ================================================================ */
  /* 신원 등록                                                         */
  /* ================================================================ */

  function updateMemberNoLabel() {
    var type = ($('input[name=member_type]:checked') || {}).value;
    var label = type === '학생' ? '학번' : type ? '교번(직번)' : '교번(직번) 또는 학번';
    $('#label-member-no').textContent = label;
    $('#f-member-no').placeholder = type === '학생' ? '예: 2026012345' : type ? '예: 202301' : '';
  }

  function setFieldError(field, msg) {
    var el = document.querySelector('[data-err="' + field + '"]');
    if (el) el.textContent = msg || '';
    var input = document.querySelector('[name="' + field + '"]');
    if (input && input.type !== 'radio') input.setAttribute('aria-invalid', msg ? 'true' : 'false');
  }

  function validateRegister(data) {
    var errors = {};
    if (!data.member_type) errors.member_type = '구분을 선택해 주세요.';
    if (!data.name) errors.name = '성명을 입력해 주세요.';
    if (!data.affiliation) errors.affiliation = '소속을 입력해 주세요.';
    var pattern = data.member_type === '학생' ? conf.id_pattern_student : conf.id_pattern_staff;
    var label = data.member_type === '학생' ? '학번' : '교번(직번)';
    if (!data.member_no) errors.member_no = label + '을(를) 입력해 주세요.';
    else if (pattern) {
      try { if (!new RegExp(pattern).test(data.member_no)) errors.member_no = label + ' 형식이 올바르지 않습니다.'; } catch (e) { /* 잘못된 정규식은 서버가 판단 */ }
    }
    if (data.phone && !/^[0-9+\- ]{8,20}$/.test(data.phone)) errors.phone = '연락처 형식이 올바르지 않습니다.';
    if (!data.consent) errors.consent = '개인정보 수집·이용에 동의해야 교육을 진행할 수 있습니다.';
    return errors;
  }

  function onRegisterSubmit(ev) {
    ev.preventDefault();
    var f = ev.target;
    var data = {
      member_type: (f.querySelector('input[name=member_type]:checked') || {}).value || '',
      name: f.name.value.trim(),
      affiliation: f.affiliation.value.trim(),
      member_no: f.member_no.value.replace(/\s+/g, ''),
      phone: f.phone.value.trim(),
      consent: f.consent.checked
    };
    ['member_type', 'name', 'affiliation', 'member_no', 'phone', 'consent'].forEach(function (k) { setFieldError(k, ''); });
    var errors = validateRegister(data);
    var keys = Object.keys(errors);
    if (keys.length) {
      keys.forEach(function (k) { setFieldError(k, errors[k]); });
      var first = f.querySelector('[name="' + keys[0] + '"]');
      if (first) first.focus();
      return;
    }
    var picked = videoById(store.pick);
    if (!picked) { toast('시청할 영상을 먼저 선택해 주세요.'); show('select'); return; }
    var btn = $('#btn-register');
    btn.classList.add('loading');
    btn.textContent = '확인 중…';
    api.post('register', Object.assign({}, data, { user_agent: navigator.userAgent, video_id: picked.video_id }))
      .then(function (r) {
        if (r.already_completed) {
          store = { completion: r.completion, completion_result: r.completion.decision === '이수' ? 'passed' : 'held' };
          saveStore();
          renderDone();
          show('done');
          toast('이미 이수하셨습니다. 기존 이수 정보를 보여 드립니다.', 5000);
          return;
        }
        store = {
          reg: { member_type: data.member_type, name: data.name, affiliation: data.affiliation, member_no: data.member_no, phone: data.phone },
          participant: r.participant,
          video: r.video || picked,
          pick: (r.video || picked).video_id,
          session_id: r.session_id,
          seq: 1,
          queue: [],
          watched: 0,
          ranges: [],
          position: 0
        };
        mergeProgress(r.progress);
        store.position = Number(r.progress && r.progress.last_position_sec) || 0;
        saveStore();
        f.reset();
        updateMemberNoLabel();
        if (r.resumed) toast('이전 시청 기록을 이어서 진행합니다.', 4000);
        else if (r.previous_video) {
          var pv = videoById(r.previous_video.video_id);
          toast('이전에 보던 영상' + (pv ? '(' + pv.title + ')' : '') + ' 기록은 이어받지 않고, 선택한 영상을 처음부터 시청합니다.', 6000);
        }
        goVideo();
      })
      .catch(function (err) {
        if (err.field) {
          setFieldError(err.field, err.message);
          var el = f.querySelector('[name="' + err.field + '"]');
          if (el) el.focus();
        } else {
          toast(err.message, 6000);
        }
      })
      .then(function () {
        btn.classList.remove('loading');
        btn.textContent = '다음: 영상 시청';
      });
  }

  /* ================================================================ */
  /* 이수 조회                                                         */
  /* ================================================================ */

  function onLookupSubmit(ev) {
    ev.preventDefault();
    var f = ev.target;
    var memberNo = f.member_no.value.replace(/\s+/g, '');
    var name = f.name.value.trim();
    var box = $('#lookup-result');
    if (!memberNo || !name) { toast('교번·학번과 성명을 모두 입력해 주세요.'); return; }
    box.hidden = false;
    box.className = 'card';
    box.textContent = '조회 중…';
    api.post('lookup', { member_no: memberNo, name: name })
      .then(function (r) {
        if (!r.found) {
          box.className = 'card result-none';
          box.innerHTML = '<p><b>이수 기록이 없습니다.</b></p><p class="muted">교번·학번과 성명을 정확히 입력했는지 확인해 주세요.</p>';
        } else if (r.completed) {
          var c = r.completion, held = c.decision === '보류';
          box.className = 'card ' + (held ? 'result-warn' : 'result-ok');
          box.innerHTML = '<p><b>' + (held ? '확인 대기 중입니다' : '이수 완료') + '</b></p>' +
            '<p>' + esc(c.masked_name) + ' · ' + esc(c.member_type) + ' · ' + esc(c.affiliation) + '<br>' +
            '이수번호 <b>' + esc(c.completion_no) + '</b><br>이수 일시 ' + esc(c.completed_at) +
            (c.video_title ? '<br>시청 영상 ' + esc(c.video_title) : '') + '</p>' +
            (held ? '<p class="muted">시청 기록 확인이 필요합니다. 부스 스태프에게 문의해 주세요.</p>' : '');
        } else {
          box.className = 'card result-warn';
          box.innerHTML = '<p><b>아직 이수하지 않았습니다.</b></p><p>현재 진행률 ' + Math.floor((r.coverage_ratio || 0) * 100) +
            '%</p><p class="muted">처음 화면에서 같은 정보로 등록하면 이어서 시청할 수 있습니다.</p>';
        }
      })
      .catch(function (err) {
        box.className = 'card result-none';
        box.textContent = err.message;
      });
  }

  /* ================================================================ */
  /* 데모 관리 화면                                                    */
  /* ================================================================ */

  var adminTab = 'completions';
  function renderAdmin() {
    if (!DEMO) {
      $('#admin-intro').textContent = '운영 데이터는 구글시트(participants·sessions·watch_logs·completions·summary·live·review 탭)에서 확인합니다.';
      $('#form-admin-cfg').hidden = true;
      $('#admin-tabs').innerHTML = '';
      $('#admin-table').innerHTML = '';
      return;
    }
    var db = demoEnv.__db;
    var names = db.order.filter(function (n) { return ['summary', 'live', 'review'].indexOf(n) < 0; });
    $('#admin-tabs').innerHTML = names.map(function (n) {
      var rows = Math.max(0, (db.sheets[n] || []).filter(function (r) { return r.some(function (v) { return v !== ''; }); }).length - 1);
      return '<button type="button" role="tab" data-tab="' + esc(n) + '" aria-selected="' + (n === adminTab) + '">' + esc(n) + ' (' + rows + ')</button>';
    }).join('');
    var data = db.sheets[adminTab] || [];
    var html = '<table><thead><tr>' + (data[0] || []).map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>';
    data.slice(1).reverse().slice(0, 300).forEach(function (row) {
      if (!row.some(function (v) { return v !== ''; })) return;
      html += '<tr>' + row.map(function (v) {
        if (v && typeof v === 'object' && v.__d) v = new Date(v.__d).toLocaleString('ko-KR');
        if (adminTab === 'config' && row[0] === 'event_token' && v === row[1]) v = '••••••••';
        return '<td>' + esc(v) + '</td>';
      }).join('') + '</tr>';
    });
    html += '</tbody></table>';
    $('#admin-table').innerHTML = html;
    var cfg = window.getConfig_();
    var form = $('#form-admin-cfg');
    form.pass_ratio.value = cfg.pass_ratio;
    form.heartbeat_sec.value = cfg.heartbeat_sec;
  }

  /* ================================================================ */
  /* 앱 내 브라우저 안내                                                */
  /* ================================================================ */

  function detectInApp() {
    var ua = navigator.userAgent || '';
    if (!/KAKAOTALK|Instagram|FBAN|FBAV|NAVER\(inapp|Line\/|DaumApps|everytimeApp|BAND\//i.test(ua)) return;
    $('#inapp-banner').hidden = false;
    var isIOS = /iPhone|iPad|iPod/i.test(ua);
    var isKakao = /KAKAOTALK/i.test(ua);
    var url = location.href;
    if (isIOS && !isKakao) $('#inapp-ios-hint').hidden = false;
    $('#btn-open-external').onclick = function () {
      if (isKakao) {
        location.href = 'kakaotalk://web/openExternal?url=' + encodeURIComponent(url);
      } else if (!isIOS) {
        location.href = 'intent://' + url.replace(/^https?:\/\//, '') + '#Intent;scheme=https;package=com.android.chrome;end';
      } else {
        $('#inapp-ios-hint').hidden = false;
      }
    };
    $('#btn-copy-link').onclick = function () {
      if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { toast('링크를 복사했습니다. 기본 브라우저에 붙여 넣어 주세요.'); });
      else toast(url, 8000);
    };
  }

  /* ================================================================ */
  /* 라우팅·이벤트                                                     */
  /* ================================================================ */

  function resetToLanding() {
    teardownVideo();
    T.dormant = false;
    hideCover();
    store = {};
    saveStore();
    route();
  }

  function route() {
    var hash = location.hash.replace('#', '');
    if (hash === 'lookup') return show('lookup');
    if (hash === 'admin') { renderAdmin(); return show('admin'); }
    if ($('#view-video').hidden === false && store.session_id && !T.dormant) return; // 시청 중에는 유지
    if (store.completion) { renderDone(); return show('done'); }
    if (conf.period_status === 'before' || conf.period_status === 'closed') {
      var s = conf.event_start ? new Date(conf.event_start).toLocaleString('ko-KR') : '';
      var e = conf.event_end ? new Date(conf.event_end).toLocaleString('ko-KR') : '';
      $('#closed-period').textContent = s && e ? '교육 기간: ' + s + ' ~ ' + e : '';
      if (!(conf.period_status === 'closed' && store.session_id)) return show('closed');
    }
    if (store.session_id && store.pending_complete) return goVideo();
    $('#btn-resume').hidden = !store.session_id;
    var cv = currentVideo();
    $('#btn-resume').textContent = cv ? '이어서 시청하기: ' + cv.title : '이어서 시청하기';
    $('#btn-start').textContent = store.session_id ? '다른 영상 또는 새 참가자로 시작하기' : '교육 시작하기';
    $('#btn-start').classList.toggle('btn-primary', !store.session_id);
    show('landing');
  }

  function bindEvents() {
    $('#btn-start').addEventListener('click', function () {
      if (conf.period_status === 'after') { toast('교육 기간이 종료되어 새로 등록할 수 없습니다.'); return; }
      renderVideoList();
      show('select');
    });
    $('#btn-resume').addEventListener('click', goVideo);
    $('#form-select').addEventListener('submit', onSelectSubmit);
    $all('[data-go=landing]').forEach(function (b) { b.addEventListener('click', function () { show('landing'); }); });
    $all('[data-go=select]').forEach(function (b) { b.addEventListener('click', function () { renderVideoList(); show('select'); }); });
    $all('[data-action=reload]').forEach(function (b) { b.addEventListener('click', function () { location.reload(); }); });
    $all('input[name=member_type]').forEach(function (r) { r.addEventListener('change', updateMemberNoLabel); });
    $('#form-register').addEventListener('submit', onRegisterSubmit);
    $('#form-lookup').addEventListener('submit', onLookupSubmit);
    $('#btn-complete').addEventListener('click', function () { doComplete(false); });
    $('#btn-gap').addEventListener('click', function () {
      var gap = firstGap();
      if (gap >= 0 && player) { player.seekTo(gap, true); player.playVideo(); }
    });
    $('#btn-fallback').addEventListener('click', function () { goFallback('user'); });
    $('#btn-new-person').addEventListener('click', function () {
      modal({ title: '다른 참가자로 시작', body: '이 기기에 저장된 이수 화면이 지워집니다. 이수 기록은 서버에 남아 있어 언제든 조회할 수 있습니다.', ok: '새로 시작', cancel: '취소' })
        .then(function (yes) { if (yes) resetToLanding(); });
    });
    $('#form-admin-cfg').addEventListener('submit', function (ev) {
      ev.preventDefault();
      window.setConfigValue_('pass_ratio', Number(ev.target.pass_ratio.value));
      window.setConfigValue_('heartbeat_sec', Number(ev.target.heartbeat_sec.value));
      window.clearConfigCache();
      toast('설정을 저장했습니다. 새로고침 후 적용됩니다.');
      renderAdmin();
    });
    $('#btn-demo-reset').addEventListener('click', function () {
      modal({ title: '데모 데이터 초기화', body: '데모 시트와 이 기기의 진행 기록을 모두 지웁니다.', ok: '초기화', cancel: '취소' }).then(function (yes) {
        if (!yes) return;
        localStorage.removeItem(DEMO_DB_KEY);
        localStorage.removeItem(LS_KEY);
        location.hash = '';
        location.reload();
      });
    });
    $('#admin-tabs').addEventListener('click', function (ev) {
      var t = ev.target.closest('[data-tab]');
      if (t) { adminTab = t.getAttribute('data-tab'); renderAdmin(); }
    });
    window.addEventListener('hashchange', route);

    document.addEventListener('visibilitychange', function () {
      if (!store.session_id || T.dormant || !player || !playerReady) return;
      var state = -1;
      try { state = player.getPlayerState(); } catch (e) { /* 무시 */ }
      if (document.visibilityState === 'hidden') {
        if (state === 1) { try { player.pauseVideo(); } catch (e) { /* 무시 */ } T.pausedByHide = true; }
        T.playing = false;
        enqueue('hidden');
        flushBeacon();
      } else {
        enqueue('visible');
        if (T.pausedByHide) setNotice('화면을 벗어나 일시정지했습니다. 재생 버튼을 눌러 이어서 시청해 주세요.', true);
        flush();
      }
    });
    window.addEventListener('pagehide', flushBeacon);
    window.addEventListener('online', function () {
      $('#net-status').hidden = true;
      store.syncError = '';
      renderSync();
      flush();
      if (store.pending_complete) doComplete(true);
    });
    window.addEventListener('offline', function () {
      $('#net-status').hidden = false;
      renderSync();
    });
  }

  /* ================================================================ */
  /* 시작                                                              */
  /* ================================================================ */

  function boot() {
    detectInApp();
    $('#demo-badge').hidden = !DEMO;
    $('#net-status').hidden = navigator.onLine !== false;
    renderPrinciples($('#principles-landing'));
    renderPrinciples($('#principles-done'));
    updateMemberNoLabel();
    bindEvents();

    api.init()
      .then(function () { return api.getConfig(); })
      .then(function (r) {
        conf = r.config;
        applyConfig();
        route();
        // 지난 접속에서 못 보낸 기록이 있으면 조용히 전송
        if (store.session_id && store.queue && store.queue.length && $('#view-video').hidden) flush();
      })
      .catch(function (err) {
        $('#error-message').textContent = (err && err.message) || '서버에 연결하지 못했습니다.';
        show('error');
      });
  }

  // 디버그·테스트용 읽기 전용 노출
  window.__lms = {
    state: function () { return { T: Object.assign({}, T, { covered: undefined }), store: store, conf: conf, demo: DEMO }; },
    player: function () { return player; }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
