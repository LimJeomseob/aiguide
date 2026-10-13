/**
 * GNU 생성형 AI 윤리교육 이수 LMS — Google Apps Script 백엔드
 *
 * 배포 방법(요약, 자세한 내용은 README.md):
 *  1) 새 구글시트 생성 → 확장 프로그램 > Apps Script
 *  2) 이 파일 내용을 Code.gs 에 붙여넣고, appsscript.json 을 교체
 *  3) setup() 실행(권한 승인) → 시트 탭·설정·영상 목록·집계 수식 자동 생성
 *  4) 배포 > 새 배포 > 웹 앱 (실행: 나, 액세스: 모든 사용자)
 *  5) 웹 앱 URL 과 config 탭의 event_token 을 프론트엔드 assets/config.js 에 입력
 *
 * 엔드포인트
 *  GET  ?action=config                 공개 설정(영상 목록·기준 비율 등)
 *  POST {action:'register', ...}       신원 등록·영상 선택·세션 생성(이어보기 포함)
 *  POST {action:'heartbeat', ...}      시청 이벤트·하트비트 일괄 기록
 *  POST {action:'complete', ...}       이수 판정(서버 최종 확정)
 *  POST {action:'lookup', ...}         본인 이수 조회
 *  GET  ?action=lookup&token=&member_no=&name=   본인 이수 조회(PRD 6.3 GET 방식 호환)
 *
 * 동시성 설계
 *  - 참가자·세션·이수 상태 변경은 스크립트 락(withLock_) 안에서 처리한다.
 *  - watch_logs 행 추가는 별도 락(withLogLock_: 문서 락, 없으면 스크립트 락)으로 분리해
 *    상태 락 점유 시간을 줄인다(PRD 5.1 동시 100명 대응).
 *  - 세션 행 번호는 CacheService에 보관해 매 하트비트의 전체 검색을 생략한다.
 */

var GAS_VERSION = '1.2.0';

var SHEETS = {
  config: ['key', 'value', 'description'],
  videos: ['video_no', 'video_id', 'title', 'principle_no', 'duration_sec', 'enabled'],
  participants: ['participant_id', 'member_type', 'name', 'affiliation', 'member_no', 'phone',
    'consent_at', 'first_seen_at', 'user_agent'],
  sessions: ['session_id', 'participant_id', 'video_id', 'video_duration_sec', 'started_at', 'origin_started_at', 'last_heartbeat_at',
    'watched_sec', 'coverage_ratio', 'covered_ranges', 'last_position_sec', 'last_seq',
    'hb_count', 'hb_short_count', 'last_hb_client_at', 'status', 'flag', 'user_agent'],
  watch_logs: ['session_id', 'seq', 'event_type', 'player_time_sec', 'watched_sec', 'coverage_ratio',
    'client_at', 'received_at'],
  completions: ['completion_no', 'participant_id', 'session_id', 'video_id', 'video_title', 'completed_at', 'member_type',
    'masked_name', 'affiliation', 'watched_sec', 'elapsed_sec', 'video_duration_sec',
    'coverage_ratio', 'decision', 'flag_reason', 'manual_review']
};

var CONFIG_DEFAULTS = [
  ['event_code', 'FAIR26', '이수번호 접두어 (예: FAIR26-20261112-0001)'],
  ['event_name', '교육과정 박람회 GNU 생성형 AI 윤리교육', '화면에 표시되는 교육명'],
  ['organizer', '경상국립대학교 AI융합원', '주관 부서'],
  ['period_check', 'FALSE', 'TRUE 이면 event_start~event_end 밖의 신규 등록을 차단'],
  ['event_start', '2026-11-01 00:00', '교육 시작 일시 (YYYY-MM-DD HH:mm)'],
  ['event_end', '2026-11-30 23:59', '교육 종료 일시 (YYYY-MM-DD HH:mm)'],
  ['grace_days', 7, '종료 후 이어보기·미전송 기록 재전송을 허용하는 일수'],
  ['playlist_url', 'https://www.youtube.com/playlist?list=PLWHIHuOG5gKydLHOJjB8cJzRQpHpJmPuq', '교육 영상 재생목록(안내용). 개별 영상은 videos 탭에서 관리'],
  ['pass_ratio', 0.9, '이수 기준 커버리지 비율 (0~1)'],
  ['heartbeat_sec', 30, '하트비트 주기(초). 부하가 크면 60으로 상향'],
  ['id_pattern_staff', '^[0-9A-Za-z]{4,12}$', '교원·교직원 교번(직번) 형식 정규식'],
  ['id_pattern_student', '^[0-9]{8,10}$', '학생 학번 형식 정규식'],
  ['lookup_limit_per_min', 5, '교번·학번당 분당 이수 조회 허용 횟수'],
  ['event_token', '', '프론트엔드 요청 검증 토큰 (setup 시 자동 생성, 외부 공개 금지)'],
  ['frontend_version', '', '배포된 프론트엔드 버전(기록용)'],
  ['gas_version', GAS_VERSION, '배포된 GAS 버전(기록용)']
];

/**
 * 교육 영상 기본 목록(8대 핵심원칙별 단편). setup() 시 videos 탭이 비어 있으면 채워 넣는다.
 * duration_sec 은 재생목록 표시 길이(초). 정확한 길이는 시트 메뉴 "영상 길이 동기화"로 갱신하거나 직접 수정한다.
 * [video_no, video_id, title, principle_no, duration_sec, enabled]
 */
var VIDEO_DEFAULTS = [
  [1, '3EPBXR9M-1k', '데이터 프라이버시 및 보안 최우선', 1, 91, 'TRUE'],
  [2, 'HjYZStVLhjk', '콘텐츠 정확성 및 책임성 확보', 2, 136, 'TRUE'],
  [3, '19AmAq9JCHk', '민감 정보나 기밀정보 입력 금지', 3, 153, 'TRUE'],
  [4, 'r3C289FLRAI', '브레인스토밍에 창의적 활용 및 비판적 사고 증진', 4, 89, 'TRUE'],
  [5, 'osXne5b_jXc', '생성형 AI 사용 투명성: AI 사용 여부 명확히 공개 및 출처 인용 제시', 5, 89, 'TRUE'],
  [6, 'yDShwCyJ5eg', '완전 자율 사용 금지: 인간에 의한 최종 판단 및 책임성 유지', 6, 113, 'TRUE'],
  [7, '3X-4fTi-wrQ', '윤리적 포용적 사용: 공정성 확보 및 편향성 검증', 7, 123, 'TRUE'],
  [8, 'hUeZk6KXJ48', '올바른 AI 도구 선택 및 사용', 8, 113, 'TRUE']
];

var MEMBER_TYPES = ['교원', '교직원', '학생'];
var CONFIG_CACHE_KEY = 'cfg_v1';
var VIDEOS_CACHE_KEY = 'videos_v1';

/* ------------------------------------------------------------------ */
/* 진입점                                                              */
/* ------------------------------------------------------------------ */

function doGet(e) {
  try {
    var action = (e && e.parameter && e.parameter.action) || 'config';
    if (action === 'config') return json_({ ok: true, config: publicConfig_(getConfig_()) });
    if (action === 'ping') return json_({ ok: true, version: GAS_VERSION, server_time: now_().toISOString() });
    if (action === 'lookup') {
      var cfg = getConfig_();
      assertToken_(cfg, e.parameter.token);
      return json_(lookup_(e.parameter, cfg));
    }
    return json_({ ok: false, code: 'UNKNOWN_ACTION', error: '알 수 없는 요청입니다.' });
  } catch (err) {
    return json_(errorBody_(err));
  }
}

function doPost(e) {
  try {
    var body = parseBody_(e);
    var cfg = getConfig_();
    assertToken_(cfg, body.token);
    switch (body.action) {
      case 'register': return json_(register_(body, cfg));
      case 'heartbeat': return json_(heartbeat_(body, cfg));
      case 'complete': return json_(complete_(body, cfg));
      case 'lookup': return json_(lookup_(body, cfg));
      default: throw appError_('UNKNOWN_ACTION', '알 수 없는 요청입니다.');
    }
  } catch (err) {
    return json_(errorBody_(err));
  }
}

function assertToken_(cfg, token) {
  if (!cfg.event_token || String(token || '') !== String(cfg.event_token)) {
    throw appError_('BAD_TOKEN', '요청 검증에 실패했습니다. 페이지를 새로고침해 주세요.');
  }
}

/* ------------------------------------------------------------------ */
/* 액션                                                                */
/* ------------------------------------------------------------------ */

function register_(p, cfg) {
  assertPeriod_(cfg, 'register');

  var memberType = clean_(p.member_type, 10);
  var name = clean_(p.name, 30);
  var affiliation = clean_(p.affiliation, 60);
  var memberNo = clean_(p.member_no, 20).replace(/\s+/g, '');
  var phone = clean_(p.phone || '', 20);

  if (MEMBER_TYPES.indexOf(memberType) < 0) throw appError_('INVALID_INPUT', '구분을 선택해 주세요.', 'member_type');
  if (!name) throw appError_('INVALID_INPUT', '성명을 입력해 주세요.', 'name');
  if (!affiliation) throw appError_('INVALID_INPUT', '소속을 입력해 주세요.', 'affiliation');
  var pattern = memberType === '학생' ? cfg.id_pattern_student : cfg.id_pattern_staff;
  if (!memberNo || (pattern && !new RegExp(pattern).test(memberNo))) {
    throw appError_('INVALID_INPUT', (memberType === '학생' ? '학번' : '교번(직번)') + ' 형식이 올바르지 않습니다.', 'member_no');
  }
  if (phone && !/^[0-9+\- ]{8,20}$/.test(phone)) throw appError_('INVALID_INPUT', '연락처 형식이 올바르지 않습니다.', 'phone');
  if (p.consent !== true) throw appError_('INVALID_INPUT', '개인정보 수집·이용에 동의해야 교육을 진행할 수 있습니다.', 'consent');

  var video = findVideo_(clean_(p.video_id, 20));
  if (!video) throw appError_('INVALID_INPUT', '시청할 영상을 선택해 주세요.', 'video_id');

  var ua = clean_(p.user_agent || '', 300);

  var startLog = null;
  var result = withLock_(function () {
    var now = now_();
    var participant;
    var pRow = findRows_('participants', 'member_no', memberNo)[0];
    if (pRow) {
      participant = readRow_('participants', pRow);
      if (normName_(participant.name) !== normName_(name)) {
        throw appError_('NAME_MISMATCH', '이미 등록된 ' + (memberType === '학생' ? '학번' : '교번') +
          '입니다. 처음 등록한 성명과 같은지 확인해 주세요.', 'name');
      }
    } else {
      participant = {
        participant_id: 'P-' + Utilities.getUuid().slice(0, 8).toUpperCase(),
        member_type: memberType,
        name: name,
        affiliation: affiliation,
        member_no: memberNo,
        phone: phone,
        consent_at: now,
        first_seen_at: now,
        user_agent: ua
      };
      appendRows_('participants', [participant]);
    }

    var completion = findCompletion_(participant.participant_id);
    if (completion) {
      return { ok: true, already_completed: true, participant: participantView_(participant), completion: completionView_(completion) };
    }

    // 같은 영상의 기존 세션(다른 기기·탭)에서 진행 상태를 이어받고, 활성 세션은 모두 대체 처리
    // (참가자당 활성 세션 1개). 다른 영상의 진행 기록은 이어받지 않는다.
    var prev = null;
    var otherVideo = null;
    var sRows = findRows_('sessions', 'participant_id', participant.participant_id);
    sRows.forEach(function (r) {
      var s = readRow_('sessions', r);
      if (s.status === 'active') {
        s.status = 'superseded';
        writeRow_('sessions', r, s);
      }
      if (s.status === 'completed') return;
      if (String(s.video_id) === video.video_id) {
        if (!prev || num_(s.watched_sec) >= num_(prev.watched_sec)) prev = s;
      } else if (num_(s.watched_sec) > 0 && (!otherVideo || num_(s.watched_sec) > num_(otherVideo.watched_sec))) {
        otherVideo = s;
      }
    });

    var session = {
      session_id: 'S-' + Utilities.getUuid(),
      participant_id: participant.participant_id,
      video_id: video.video_id,
      video_duration_sec: num_(video.duration_sec),
      started_at: now,
      origin_started_at: prev ? prev.origin_started_at : now,
      last_heartbeat_at: now,
      watched_sec: prev ? num_(prev.watched_sec) : 0,
      coverage_ratio: prev ? num_(prev.coverage_ratio) : 0,
      covered_ranges: prev ? String(prev.covered_ranges || '') : '',
      last_position_sec: prev ? num_(prev.last_position_sec) : 0,
      last_seq: 0,
      hb_count: prev ? num_(prev.hb_count) : 0,
      hb_short_count: prev ? num_(prev.hb_short_count) : 0,
      last_hb_client_at: '',
      status: 'active',
      flag: '',
      user_agent: ua
    };
    var sRow = appendRows_('sessions', [session]);
    rememberSessionRow_(session.session_id, sRow);
    startLog = {
      session_id: session.session_id, seq: 0, event_type: prev ? 'session_resume' : 'session_start',
      player_time_sec: session.last_position_sec, watched_sec: session.watched_sec,
      coverage_ratio: session.coverage_ratio, client_at: '', received_at: now
    };

    return {
      ok: true,
      already_completed: false,
      resumed: !!prev && num_(prev.watched_sec) > 0,
      participant: participantView_(participant),
      session_id: session.session_id,
      video: videoView_(video),
      previous_video: otherVideo ? { video_id: String(otherVideo.video_id), watched_sec: num_(otherVideo.watched_sec) } : null,
      progress: {
        watched_sec: num_(session.watched_sec),
        covered_ranges: parseRanges_(session.covered_ranges),
        last_position_sec: num_(session.last_position_sec)
      }
    };
  });
  if (startLog) appendLogs_([startLog]);
  return result;
}

function heartbeat_(p, cfg) {
  assertPeriod_(cfg, 'sync');
  var sid = clean_(p.session_id, 60);
  var logs = [];
  var result = withLock_(function () {
    var found = loadSession_(sid);
    if (!found) throw appError_('SESSION_NOT_FOUND', '세션 정보를 찾을 수 없습니다. 처음부터 다시 등록해 주세요.');
    var s = found.s;
    if (s.status === 'superseded') return { ok: true, valid: false, reason: 'SUPERSEDED', acked_seq: num_(s.last_seq) };
    if (s.status === 'completed') return { ok: true, valid: true, completed: true, acked_seq: num_(s.last_seq) };

    logs = applyEvents_(s, p.events, cfg);
    applyState_(s, p.state, cfg);
    writeRow_('sessions', found.row, s);
    return { ok: true, valid: true, acked_seq: num_(s.last_seq), coverage_ratio: num_(s.coverage_ratio) };
  });
  appendLogs_(logs);
  return result;
}

function complete_(p, cfg) {
  assertPeriod_(cfg, 'sync');
  var sid = clean_(p.session_id, 60);
  var logs = [];
  var result = withLock_(function () {
    var found = loadSession_(sid);
    if (!found) throw appError_('SESSION_NOT_FOUND', '세션 정보를 찾을 수 없습니다. 처음부터 다시 등록해 주세요.');
    var row = found.row;
    var s = found.s;

    var existing = findCompletion_(s.participant_id);
    if (existing) return { ok: true, result: existing.decision === '이수' ? 'passed' : 'held', completion: completionView_(existing) };
    if (s.status === 'superseded') {
      throw appError_('SUPERSEDED', '다른 기기 또는 창에서 같은 교번·학번으로 교육이 진행 중입니다.');
    }

    logs = applyEvents_(s, p.events, cfg);
    applyState_(s, p.state, cfg);

    var duration = videoDuration_(s, p.state && p.state.duration);
    if (!duration) throw appError_('NO_DURATION', '영상 길이를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.');

    var watched = num_(s.watched_sec);
    var covered = coveredSeconds_(parseRanges_(s.covered_ranges), duration);
    var effective = Math.min(covered, watched);
    var ratio = effective / duration;
    var passRatio = num_(cfg.pass_ratio) || 0.9;
    s.coverage_ratio = round_(ratio, 4);

    if (ratio + 1e-9 < passRatio) {
      writeRow_('sessions', row, s);
      return {
        ok: true,
        result: 'rejected',
        coverage_ratio: round_(ratio, 4),
        remaining_sec: Math.ceil(passRatio * duration - effective),
        message: '이수 기준(' + Math.round(passRatio * 100) + '%)에 도달하지 않았습니다.'
      };
    }

    var now = now_();
    var origin = toDate_(s.origin_started_at) || toDate_(s.started_at) || now;
    var elapsed = Math.max(0, (now.getTime() - origin.getTime()) / 1000);
    var hbSec = num_(cfg.heartbeat_sec) || 30;
    var flags = [];
    if (watched > elapsed + 15) flags.push('누적 시청 시간이 경과 시간보다 큼');
    if (num_(s.hb_short_count) >= 3) flags.push('하트비트 간격 비정상(' + num_(s.hb_short_count) + '회)');
    var expectedHb = Math.floor(watched / hbSec);
    if (expectedHb >= 2 && num_(s.hb_count) < expectedHb * 0.5) {
      flags.push('하트비트 누락 과다(' + num_(s.hb_count) + '/' + expectedHb + ')');
    }
    if (elapsed < duration * passRatio * 0.9) flags.push('세션 소요 시간이 비정상적으로 짧음');

    var participant = readRow_('participants', findRows_('participants', 'participant_id', s.participant_id)[0]);
    var video = findVideo_(String(s.video_id || ''), true) || {};
    var decision = flags.length ? '보류' : '이수';
    var completion = {
      completion_no: nextCompletionNo_(cfg, now),
      participant_id: s.participant_id,
      session_id: s.session_id,
      video_id: String(s.video_id || ''),
      video_title: String(video.title || ''),
      completed_at: now,
      member_type: participant.member_type,
      masked_name: maskName_(participant.name),
      affiliation: participant.affiliation,
      watched_sec: Math.round(watched),
      elapsed_sec: Math.round(elapsed),
      video_duration_sec: duration,
      coverage_ratio: round_(ratio, 4),
      decision: decision,
      flag_reason: flags.join('; '),
      manual_review: ''
    };
    appendRows_('completions', [completion]);
    s.status = 'completed';
    s.flag = flags.length ? '검토 필요: ' + flags.join('; ') : '정상';
    writeRow_('sessions', row, s);

    return { ok: true, result: decision === '이수' ? 'passed' : 'held', completion: completionView_(completion) };
  });
  appendLogs_(logs);
  return result;
}

function lookup_(p, cfg) {
  var memberNo = clean_(p.member_no, 20).replace(/\s+/g, '');
  var name = clean_(p.name, 30);
  if (!memberNo || !name) throw appError_('INVALID_INPUT', '교번·학번과 성명을 모두 입력해 주세요.');

  var cache = CacheService.getScriptCache();
  var key = 'lk_' + memberNo;
  var count = num_(cache.get(key)) + 1;
  cache.put(key, String(count), 60);
  if (count > (num_(cfg.lookup_limit_per_min) || 5)) {
    throw appError_('RATE_LIMITED', '조회 요청이 너무 많습니다. 1분 뒤 다시 시도해 주세요.');
  }

  var pRow = findRows_('participants', 'member_no', memberNo)[0];
  if (!pRow) return { ok: true, found: false };
  var participant = readRow_('participants', pRow);
  if (normName_(participant.name) !== normName_(name)) return { ok: true, found: false };

  var completion = findCompletion_(participant.participant_id);
  if (completion) return { ok: true, found: true, completed: true, completion: completionView_(completion) };

  var best = 0;
  findRows_('sessions', 'participant_id', participant.participant_id).forEach(function (r) {
    best = Math.max(best, num_(readRow_('sessions', r).coverage_ratio));
  });
  return { ok: true, found: true, completed: false, participant: participantView_(participant), coverage_ratio: round_(best, 4) };
}

/* ------------------------------------------------------------------ */
/* 시청 기록 처리                                                       */
/* ------------------------------------------------------------------ */

var EVENT_TYPES = ['play', 'pause', 'seek', 'heartbeat', 'ended', 'hidden', 'visible', 'rate_reset',
  'complete_request', 'player_error', 'resume'];

/** 새 이벤트를 세션 상태에 반영하고, 기록할 로그 행 목록을 돌려준다(쓰기는 호출자가 appendLogs_로). */
function applyEvents_(s, events, cfg) {
  if (!events || !events.length) return [];
  var hbMs = (num_(cfg.heartbeat_sec) || 30) * 1000;
  var lastSeq = num_(s.last_seq);
  var received = now_();
  var list = events.slice(0, 300).filter(function (ev) {
    return ev && num_(ev.seq) > lastSeq && EVENT_TYPES.indexOf(String(ev.type)) >= 0;
  }).sort(function (a, b) { return num_(a.seq) - num_(b.seq); });

  var logs = [];
  list.forEach(function (ev) {
    var seq = num_(ev.seq);
    if (seq <= lastSeq) return; // 같은 배치 안의 중복 seq 방지
    lastSeq = seq;
    var clientAt = num_(ev.client_at);
    if (ev.type === 'heartbeat') {
      var prevHb = num_(s.last_hb_client_at);
      if (prevHb && clientAt && clientAt - prevHb < hbMs * 0.5) s.hb_short_count = num_(s.hb_short_count) + 1;
      s.hb_count = num_(s.hb_count) + 1;
      if (clientAt) s.last_hb_client_at = clientAt;
    }
    logs.push({
      session_id: s.session_id,
      seq: seq,
      event_type: String(ev.type),
      player_time_sec: round_(num_(ev.player_time), 1),
      watched_sec: round_(num_(ev.watched_sec), 1),
      coverage_ratio: round_(num_(ev.coverage), 4),
      client_at: clientAt ? new Date(clientAt) : '',
      received_at: received
    });
  });
  s.last_seq = lastSeq;
  return logs;
}

function applyState_(s, state, cfg) {
  s.last_heartbeat_at = now_();
  if (!state) return;
  var duration = videoDuration_(s, state.duration) || 0;
  var watched = Math.max(0, num_(state.watched_sec));
  if (watched > num_(s.watched_sec)) s.watched_sec = round_(watched, 1);
  var merged = mergeRanges_(parseRanges_(s.covered_ranges).concat(sanitizeRanges_(state.ranges, duration)));
  s.covered_ranges = formatRanges_(merged);
  if (state.position !== undefined) s.last_position_sec = round_(Math.max(0, num_(state.position)), 1);
  if (duration) {
    var effective = Math.min(coveredSeconds_(merged, duration), num_(s.watched_sec));
    s.coverage_ratio = round_(effective / duration, 4);
  }
}

/**
 * 판정에 쓰는 영상 길이(초). 세션에 저장된 videos 탭 값을 기준으로 하되,
 * 플레이어가 보고한 길이가 그 값과 3% 이내로 다르면(재생목록 표시 길이의 반올림 오차) 플레이어 값을 쓴다.
 * 시트 값이 비어 있으면 플레이어 값을 그대로 쓴다.
 */
function videoDuration_(s, clientDuration) {
  var d = num_(s && s.video_duration_sec);
  var c = Math.round(num_(clientDuration));
  var cOk = c >= 10 && c <= 4 * 3600;
  if (d > 0) {
    if (cOk && Math.abs(c - d) <= Math.max(2, d * 0.03)) {
      if (c !== d) s.video_duration_sec = c;
      return c;
    }
    return d;
  }
  if (cOk) { s.video_duration_sec = c; return c; }
  return 0;
}

/* ------------------------------------------------------------------ */
/* 영상 목록                                                            */
/* ------------------------------------------------------------------ */

/** videos 탭 전체(캐시 60초). includeDisabled 가 아니면 enabled=TRUE 인 영상만 */
function getVideos_(includeDisabled) {
  var cache = CacheService.getScriptCache();
  var cached = cache.get(VIDEOS_CACHE_KEY);
  var all = null;
  if (cached) {
    try { all = JSON.parse(cached); } catch (e) { all = null; }
  }
  if (!all) {
    var sh = sheet_('videos');
    var last = sh.getLastRow();
    all = [];
    if (last >= 2) {
      sh.getRange(2, 1, last - 1, SHEETS.videos.length).getValues().forEach(function (r) {
        if (!r[1]) return;
        all.push({
          video_no: num_(r[0]),
          video_id: String(r[1]).trim(),
          title: String(r[2] || '').trim(),
          principle_no: num_(r[3]),
          duration_sec: num_(r[4]),
          enabled: String(r[5]).toUpperCase() !== 'FALSE'
        });
      });
    }
    cache.put(VIDEOS_CACHE_KEY, JSON.stringify(all), 60);
  }
  return includeDisabled ? all : all.filter(function (v) { return v.enabled; });
}

function findVideo_(videoId, includeDisabled) {
  if (!videoId) return null;
  var list = getVideos_(includeDisabled);
  for (var i = 0; i < list.length; i++) if (list[i].video_id === videoId) return list[i];
  return null;
}

function videoView_(v) {
  return {
    video_no: v.video_no,
    video_id: v.video_id,
    title: v.title,
    principle_no: v.principle_no,
    duration_sec: v.duration_sec
  };
}

/**
 * [시트 메뉴] videos 탭의 duration_sec 을 YouTube 페이지의 lengthSeconds 로 갱신한다.
 * API 키 없이 동작하지만 YouTube 페이지 구조가 바뀌면 실패할 수 있다(그 경우 직접 입력).
 */
function syncVideoDurations() {
  var sh = sheet_('videos');
  var last = sh.getLastRow();
  if (last < 2) return;
  var col = colIndex_('videos', 'duration_sec');
  var ids = sh.getRange(2, colIndex_('videos', 'video_id'), last - 1, 1).getValues();
  var updated = 0;
  ids.forEach(function (r, i) {
    var id = String(r[0] || '').trim();
    if (!id) return;
    try {
      var html = UrlFetchApp.fetch('https://www.youtube.com/watch?v=' + encodeURIComponent(id) + '&hl=ko', { muteHttpExceptions: true }).getContentText();
      var m = /"lengthSeconds":"(\d+)"/.exec(html);
      if (m) { sh.getRange(2 + i, col).setValue(Number(m[1])); updated++; }
    } catch (e) {
      console.error('길이 조회 실패 ' + id + ': ' + e);
    }
  });
  CacheService.getScriptCache().remove(VIDEOS_CACHE_KEY);
  try { SpreadsheetApp.getUi().alert('영상 ' + updated + '개의 길이를 갱신했습니다.'); } catch (e) { Logger.log('갱신: ' + updated); }
}

/** "0-120,150-300" (끝 미포함) ↔ [[0,120],[150,300]] */
function parseRanges_(str) {
  if (!str) return [];
  return String(str).split(',').map(function (part) {
    var m = /^\s*(\d+)-(\d+)\s*$/.exec(part);
    return m ? [Number(m[1]), Number(m[2])] : null;
  }).filter(function (r) { return r && r[1] > r[0]; });
}

function formatRanges_(ranges) {
  return ranges.map(function (r) { return r[0] + '-' + r[1]; }).join(',');
}

function sanitizeRanges_(ranges, duration) {
  if (!ranges || !ranges.length) return [];
  var max = duration ? Math.ceil(duration) : 4 * 3600;
  return ranges.slice(0, 1000).map(function (r) {
    if (!r || r.length < 2) return null;
    var a = Math.max(0, Math.floor(num_(r[0])));
    var b = Math.min(max, Math.floor(num_(r[1])));
    return b > a ? [a, b] : null;
  }).filter(Boolean);
}

function mergeRanges_(ranges) {
  var sorted = ranges.slice().sort(function (a, b) { return a[0] - b[0]; });
  var out = [];
  sorted.forEach(function (r) {
    var last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  });
  return out;
}

function coveredSeconds_(ranges, duration) {
  var max = Math.ceil(duration);
  return mergeRanges_(ranges).reduce(function (sum, r) {
    var a = Math.max(0, r[0]), b = Math.min(max, r[1]);
    return sum + Math.max(0, b - a);
  }, 0);
}

/* ------------------------------------------------------------------ */
/* 설정                                                                */
/* ------------------------------------------------------------------ */

function getConfig_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get(CONFIG_CACHE_KEY);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* 무시하고 다시 읽음 */ }
  }
  var sh = sheet_('config');
  var last = sh.getLastRow();
  var cfg = {};
  if (last >= 2) {
    sh.getRange(2, 1, last - 1, 2).getValues().forEach(function (r) {
      if (!r[0]) return;
      var v = r[1];
      cfg[String(r[0]).trim()] = v instanceof Date ? v.toISOString() : v;
    });
  }
  cache.put(CONFIG_CACHE_KEY, JSON.stringify(cfg), 60);
  return cfg;
}

function publicConfig_(cfg) {
  var period = periodState_(cfg);
  return {
    event_code: String(cfg.event_code || ''),
    event_name: String(cfg.event_name || ''),
    organizer: String(cfg.organizer || ''),
    event_start: period.start ? period.start.toISOString() : '',
    event_end: period.end ? period.end.toISOString() : '',
    period_status: period.status,
    playlist_url: String(cfg.playlist_url || ''),
    videos: getVideos_(false).map(videoView_),
    pass_ratio: num_(cfg.pass_ratio) || 0.9,
    heartbeat_sec: num_(cfg.heartbeat_sec) || 30,
    id_pattern_staff: String(cfg.id_pattern_staff || ''),
    id_pattern_student: String(cfg.id_pattern_student || ''),
    server_time: now_().toISOString(),
    gas_version: GAS_VERSION
  };
}

/** status: open | before | after(유예기간 중) | closed */
function periodState_(cfg) {
  var start = parseDateTime_(cfg.event_start);
  var end = parseDateTime_(cfg.event_end);
  var check = String(cfg.period_check).toUpperCase() === 'TRUE';
  if (!check) return { status: 'open', start: start, end: end };
  var now = now_().getTime();
  var grace = (num_(cfg.grace_days) || 0) * 86400000;
  var status = 'open';
  if (start && now < start.getTime()) status = 'before';
  else if (end && now > end.getTime() + grace) status = 'closed';
  else if (end && now > end.getTime()) status = 'after';
  return { status: status, start: start, end: end };
}

function assertPeriod_(cfg, kind) {
  var st = periodState_(cfg).status;
  if (st === 'open') return;
  if (kind === 'sync' && st === 'after') return; // 종료 후 유예기간에는 기존 세션의 전송·이수만 허용
  throw appError_('OUT_OF_PERIOD', '지금은 교육 기간이 아닙니다.');
}

/** "2026-11-12 09:00" 형식은 한국 시간(+09:00)으로 해석 */
function parseDateTime_(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  var s = String(v).trim();
  var m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(s);
  if (m) return new Date(m[1] + '-' + m[2] + '-' + m[3] + 'T' + (m[4] || '00') + ':' + (m[5] || '00') + ':00+09:00');
  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/* ------------------------------------------------------------------ */
/* 시트 접근                                                            */
/* ------------------------------------------------------------------ */

// 한 번의 실행 안에서 스프레드시트·시트 객체를 재사용(openById 반복 호출 비용 절감)
var SS_MEMO_ = null;
var SHEET_MEMO_ = {};

function ss_() {
  if (SS_MEMO_) return SS_MEMO_;
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  SS_MEMO_ = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  return SS_MEMO_;
}

function sheet_(name) {
  if (SHEET_MEMO_[name]) return SHEET_MEMO_[name];
  var sh = ss_().getSheetByName(name);
  if (!sh) throw appError_('NOT_SETUP', '시트 "' + name + '" 이(가) 없습니다. setup()을 먼저 실행해 주세요.');
  SHEET_MEMO_[name] = sh;
  return sh;
}

/** 세션 행을 캐시된 행 번호로 바로 읽고, 어긋나면 전체 검색으로 되찾는다. */
function loadSession_(sid) {
  if (!sid) return null;
  var cache = CacheService.getScriptCache();
  var cached = num_(cache.get('sr_' + sid));
  if (cached >= 2) {
    var s = readRow_('sessions', cached);
    if (String(s.session_id) === sid) return { row: cached, s: s };
  }
  var row = findRows_('sessions', 'session_id', sid)[0];
  if (!row) return null;
  rememberSessionRow_(sid, row);
  return { row: row, s: readRow_('sessions', row) };
}

function rememberSessionRow_(sid, row) {
  if (sid && row) CacheService.getScriptCache().put('sr_' + sid, String(row), 21600);
}

function colIndex_(name, col) {
  var i = SHEETS[name].indexOf(col);
  if (i < 0) throw new Error('알 수 없는 열: ' + name + '.' + col);
  return i + 1;
}

function findRows_(name, col, value) {
  if (value === '' || value === null || value === undefined) return [];
  var sh = sheet_(name);
  var last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, colIndex_(name, col), last - 1, 1)
    .createTextFinder(String(value)).matchEntireCell(true).findAll()
    .map(function (r) { return r.getRow(); });
}

function readRow_(name, row) {
  var headers = SHEETS[name];
  var vals = sheet_(name).getRange(row, 1, 1, headers.length).getValues()[0];
  var obj = {};
  headers.forEach(function (h, i) { obj[h] = vals[i]; });
  return obj;
}

function toRow_(name, obj) {
  return SHEETS[name].map(function (h) {
    var v = obj[h];
    if (v === undefined || v === null) return '';
    return typeof v === 'string' ? safeCell_(v) : v;
  });
}

function writeRow_(name, row, obj) {
  sheet_(name).getRange(row, 1, 1, SHEETS[name].length).setValues([toRow_(name, obj)]);
}

/** 여러 행을 한 번에 추가하고 첫 행 번호를 돌려준다. 반드시 해당 시트를 보호하는 락 안에서 호출한다. */
function appendRows_(name, objs) {
  if (!objs.length) return 0;
  var sh = sheet_(name);
  var start = sh.getLastRow() + 1;
  sh.getRange(start, 1, objs.length, SHEETS[name].length).setValues(objs.map(function (o) { return toRow_(name, o); }));
  return start;
}

/** watch_logs 추가 전용. 상태 락(withLock_) 밖에서 호출한다. 실패해도 시청 상태는 이미 저장되어 있다. */
function appendLogs_(logs) {
  if (!logs || !logs.length) return;
  try {
    withLogLock_(function () { appendRows_('watch_logs', logs); });
  } catch (err) {
    console.error('watch_logs 기록 실패: ' + (err && err.message));
  }
}

function findCompletion_(participantId) {
  var row = findRows_('completions', 'participant_id', participantId)[0];
  return row ? readRow_('completions', row) : null;
}

function nextCompletionNo_(cfg, now) {
  var ymd = Utilities.formatDate(now, 'Asia/Seoul', 'yyyyMMdd');
  var props = PropertiesService.getScriptProperties();
  var key = 'seq_' + ymd;
  var next = num_(props.getProperty(key)) + 1;
  props.setProperty(key, String(next));
  return String(cfg.event_code || 'EDU') + '-' + ymd + '-' + ('000' + next).slice(-4);
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw appError_('BUSY', '접속이 많아 처리가 지연되고 있습니다. 잠시 후 자동으로 다시 시도합니다.');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/** watch_logs 전용 락: 컨테이너 바인딩이면 문서 락, 아니면 스크립트 락. withLock_ 안에서 호출하지 않는다. */
function withLogLock_(fn) {
  var lock = null;
  try { lock = LockService.getDocumentLock(); } catch (e) { lock = null; }
  if (!lock) lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw appError_('BUSY', '접속이 많아 처리가 지연되고 있습니다.');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ */
/* 표시용 변환                                                          */
/* ------------------------------------------------------------------ */

function participantView_(p) {
  return {
    participant_id: p.participant_id,
    masked_name: maskName_(p.name),
    member_type: p.member_type,
    affiliation: p.affiliation
  };
}

function completionView_(c) {
  var at = toDate_(c.completed_at);
  return {
    completion_no: String(c.completion_no),
    video_id: String(c.video_id || ''),
    video_title: String(c.video_title || ''),
    completed_at: at ? Utilities.formatDate(at, 'Asia/Seoul', 'yyyy-MM-dd HH:mm') : String(c.completed_at),
    masked_name: String(c.masked_name),
    member_type: String(c.member_type),
    affiliation: String(c.affiliation),
    decision: String(c.decision)
  };
}

function maskName_(name) {
  var chars = Array.from ? Array.from(String(name || '')) : String(name || '').split('');
  if (chars.length <= 1) return '*';
  if (chars.length === 2) return chars[0] + '*';
  return chars[0] + new Array(chars.length - 1).join('*') + chars[chars.length - 1];
}

/* ------------------------------------------------------------------ */
/* 유틸                                                                */
/* ------------------------------------------------------------------ */

function now_() { return new Date(); }

function num_(v) {
  var n = Number(v);
  return isFinite(n) ? n : 0;
}

function round_(v, d) {
  var f = Math.pow(10, d || 0);
  return Math.round(num_(v) * f) / f;
}

function toDate_(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  var d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function clean_(v, max) {
  return String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u001f]/g, '').trim().slice(0, max || 100);
}

function normName_(v) { return String(v || '').replace(/^'/, '').replace(/\s+/g, ''); }

/** 수식 주입 방지: =, +, -, @ 로 시작하는 문자열은 텍스트로 강제 */
function safeCell_(s) { return /^[=+\-@]/.test(s) ? "'" + s : s; }

function parseBody_(e) {
  var raw = e && e.postData && e.postData.contents;
  if (!raw) throw appError_('BAD_REQUEST', '요청 본문이 비어 있습니다.');
  try { return JSON.parse(raw); } catch (err) { throw appError_('BAD_REQUEST', '요청 형식이 올바르지 않습니다.'); }
}

function appError_(code, message, field) {
  var err = new Error(message);
  err.code = code;
  err.field = field;
  return err;
}

function errorBody_(err) {
  if (err && err.code) return { ok: false, code: err.code, error: err.message, field: err.field || null };
  console.error(err && err.stack ? err.stack : err);
  return { ok: false, code: 'SERVER_ERROR', error: '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' };
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ------------------------------------------------------------------ */
/* 관리 기능 (시트 메뉴)                                                */
/* ------------------------------------------------------------------ */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('윤리교육 LMS')
    .addItem('초기 설정(setup)', 'setup')
    .addItem('설정·영상 목록 변경 즉시 반영(캐시 비우기)', 'clearConfigCache')
    .addItem('영상 길이 동기화(YouTube)', 'syncVideoDurations')
    .addSeparator()
    .addItem('수기 확인 이수 처리(폴백 건)', 'manualCompleteUi')
    .addItem('보류 건 이수 승인', 'approveHeldUi')
    .addSeparator()
    .addItem('시청 로그 보관 시트로 옮기기', 'archiveWatchLogs')
    .addItem('보관 기간 종료: 개인정보 파기', 'purgePersonalData')
    .addToUi();
}

/** 시트 탭·헤더·설정 기본값·집계 수식을 만든다. 여러 번 실행해도 기존 데이터는 유지된다. */
function setup() {
  var ss = ss_();
  try { ss.setSpreadsheetTimeZone('Asia/Seoul'); } catch (e) { /* 권한 없는 환경 무시 */ }

  Object.keys(SHEETS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var headers = SHEETS[name];
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#1f3a6e').setFontColor('#ffffff');
    sh.setFrozenRows(1);
  });

  // 식별번호·연락처 열은 텍스트 서식(앞자리 0 보존)
  [['participants', 'member_no'], ['participants', 'phone'], ['participants', 'participant_id']].forEach(function (pair) {
    var sh = ss.getSheetByName(pair[0]);
    sh.getRange(2, colIndex_(pair[0], pair[1]), sh.getMaxRows() - 1, 1).setNumberFormat('@');
  });

  // 설정 기본값(없는 키만 추가)
  var cfgSheet = ss.getSheetByName('config');
  var last = cfgSheet.getLastRow();
  var existing = {};
  if (last >= 2) cfgSheet.getRange(2, 1, last - 1, 1).getValues().forEach(function (r) { existing[String(r[0])] = true; });
  var add = CONFIG_DEFAULTS.filter(function (r) { return !existing[r[0]]; }).map(function (r) {
    if (r[0] === 'event_token') return [r[0], Utilities.getUuid().replace(/-/g, ''), r[2]];
    return r.slice();
  });
  if (add.length) {
    cfgSheet.getRange(cfgSheet.getLastRow() + 1, 1, add.length, 3).setValues(add);
  }
  cfgSheet.getRange(2, 2, Math.max(1, cfgSheet.getLastRow() - 1), 1).setNumberFormat('@');
  setConfigValue_('gas_version', GAS_VERSION);

  // 영상 목록 기본값(비어 있을 때만)
  var vSheet = ss.getSheetByName('videos');
  if (vSheet.getLastRow() < 2) {
    vSheet.getRange(2, 1, VIDEO_DEFAULTS.length, SHEETS.videos.length).setValues(VIDEO_DEFAULTS.map(function (r) { return r.slice(); }));
  }
  vSheet.getRange(2, colIndex_('videos', 'video_id'), Math.max(1, vSheet.getMaxRows() - 1), 1).setNumberFormat('@');

  buildSummarySheets_(ss);
  clearConfigCache();

  var token = getConfig_().event_token;
  Logger.log('설정 완료. event_token = ' + token + '  (프론트엔드 assets/config.js 의 EVENT_TOKEN 에 입력)');
  return token;
}

function setConfigValue_(key, value) {
  var sh = sheet_('config');
  var row = findRows_('config', 'key', key)[0];
  if (row) sh.getRange(row, 2).setValue(value);
}

function buildSummarySheets_(ss) {
  var summary = ss.getSheetByName('summary') || ss.insertSheet('summary');
  summary.clear();
  var rows = [
    ['구분별 현황', '', '', '', '', ''],
    ['구분', '등록자', '이수', '보류', '이수율', '평균 소요(분)']
  ];
  MEMBER_TYPES.forEach(function (t, i) {
    var r = i + 3;
    rows.push([t,
      '=COUNTIF(participants!B:B,A' + r + ')',
      '=COUNTIFS(completions!G:G,A' + r + ',completions!N:N,"이수")',
      '=COUNTIFS(completions!G:G,A' + r + ',completions!N:N,"보류")',
      '=IFERROR(C' + r + '/B' + r + ',0)',
      '=IFERROR(ROUND(AVERAGEIFS(completions!K:K,completions!G:G,A' + r + ',completions!N:N,"이수")/60,1),"")'
    ]);
  });
  rows.push(['합계', '=SUM(B3:B5)', '=SUM(C3:C5)', '=SUM(D3:D5)', '=IFERROR(C6/B6,0)',
    '=IFERROR(ROUND(AVERAGEIFS(completions!K:K,completions!N:N,"이수")/60,1),"")']);
  summary.getRange(1, 1, rows.length, 6).setValues(rows);
  summary.getRange(3, 5, 4, 1).setNumberFormat('0.0%');
  summary.getRange(1, 1).setFontWeight('bold');
  summary.getRange(2, 1, 1, 6).setFontWeight('bold').setBackground('#e8eef8');

  summary.getRange(8, 1).setValue('소속별 이수자 수').setFontWeight('bold');
  summary.getRange(9, 1).setFormula('=IFERROR(QUERY(completions!A:P,"select I, count(A) where N = \'이수\' group by I order by count(A) desc label I \'소속\', count(A) \'이수자 수\'",1),"데이터 없음")');

  summary.getRange(8, 4).setValue('시간대별 이수 건수').setFontWeight('bold');
  summary.getRange(9, 4).setFormula('=IFERROR(QUERY(ARRAYFORMULA(IF(LEN(completions!F2:F),TEXT(completions!F2:F,"yyyy-mm-dd hh")&"시",)),"select Col1, count(Col1) where Col1 <> \'\' group by Col1 label Col1 \'시간대\', count(Col1) \'이수 건수\'",0),"데이터 없음")');

  summary.getRange(8, 7).setValue('영상별 이수 건수').setFontWeight('bold');
  summary.getRange(9, 7).setFormula('=IFERROR(QUERY(completions!A:P,"select E, count(A) where N = \'이수\' group by E order by count(A) desc label E \'영상\', count(A) \'이수자 수\'",1),"데이터 없음")');

  // 현장 스태프용 실시간 이수자 목록(최근 순, 성명 마스킹)
  var live = ss.getSheetByName('live') || ss.insertSheet('live');
  live.clear();
  live.getRange(1, 1, 1, 7).setValues([['이수번호', '이수 일시', '구분', '성명', '소속', '시청 영상', '판정']])
    .setFontWeight('bold').setBackground('#1f3a6e').setFontColor('#ffffff');
  live.getRange(2, 1).setFormula('=IFERROR(SORT(FILTER({completions!A2:A,completions!F2:F,completions!G2:G,completions!H2:H,completions!I2:I,completions!E2:E,completions!N2:N},completions!A2:A<>""),2,FALSE),"아직 이수자가 없습니다")');
  live.getRange(2, 2, live.getMaxRows() - 1, 1).setNumberFormat('yyyy-mm-dd hh:mm');
  live.setFrozenRows(1);

  // 검토 필요(보류) 목록
  var review = ss.getSheetByName('review') || ss.insertSheet('review');
  review.clear();
  review.getRange(1, 1, 1, 8).setValues([['이수번호', '이수 일시', '구분', '성명', '소속', '시청 영상', '보류 사유', '수기 확인 메모']])
    .setFontWeight('bold').setBackground('#8a1c1c').setFontColor('#ffffff');
  review.getRange(2, 1).setFormula('=IFERROR(FILTER({completions!A2:A,completions!F2:F,completions!G2:G,completions!H2:H,completions!I2:I,completions!E2:E,completions!O2:O,completions!P2:P},completions!N2:N="보류"),"검토 필요 건이 없습니다")');
  review.getRange(2, 2, review.getMaxRows() - 1, 1).setNumberFormat('yyyy-mm-dd hh:mm');
  review.setFrozenRows(1);
}

/* ------------------------------------------------------------------ */
/* 스태프 수기 처리 (FR-9.2, FR-8.4)                                     */
/* ------------------------------------------------------------------ */

/** [시트 메뉴] 외부(YouTube) 재생 등으로 측정이 불가했던 참가자를 스태프 확인으로 이수 처리한다. */
function manualCompleteUi() {
  var ui = SpreadsheetApp.getUi();
  var r1 = ui.prompt('수기 확인 이수 처리', '참가자의 교번(직번) 또는 학번을 입력하세요. (참가자 정보 등록이 먼저 되어 있어야 합니다)', ui.ButtonSet.OK_CANCEL);
  if (r1.getSelectedButton() !== ui.Button.OK) return;
  var r2 = ui.prompt('수기 확인 이수 처리', '확인 메모 (예: 스태프 홍길동, 부스 B, YouTube 외부 시청 확인)', ui.ButtonSet.OK_CANCEL);
  if (r2.getSelectedButton() !== ui.Button.OK) return;
  var r3 = ui.prompt('수기 확인 이수 처리', '시청한 영상 번호(1~8). 모르면 비워 두세요.', ui.ButtonSet.OK_CANCEL);
  if (r3.getSelectedButton() !== ui.Button.OK) return;
  try {
    var res = manualComplete_(r1.getResponseText(), r2.getResponseText(), r3.getResponseText());
    ui.alert(res.created ? '이수 처리 완료: ' + res.completion.completion_no : '이미 이수 기록이 있습니다: ' + res.completion.completion_no);
  } catch (err) {
    ui.alert('처리 실패: ' + err.message);
  }
}

function manualComplete_(memberNo, memo, videoNo) {
  memberNo = clean_(memberNo, 20).replace(/\s+/g, '');
  memo = clean_(memo, 200);
  if (!memberNo) throw appError_('INVALID_INPUT', '교번·학번을 입력해 주세요.');
  if (!memo) throw appError_('INVALID_INPUT', '확인 메모를 입력해 주세요.');
  var cfg = getConfig_();
  return withLock_(function () {
    var pRow = findRows_('participants', 'member_no', memberNo)[0];
    if (!pRow) throw appError_('NOT_FOUND', '등록된 참가자가 없습니다. 참가자가 먼저 화면에서 정보를 등록해야 합니다.');
    var participant = readRow_('participants', pRow);
    var existing = findCompletion_(participant.participant_id);
    if (existing) {
      if (existing.decision !== '이수') {
        var row = findRows_('completions', 'completion_no', String(existing.completion_no))[0];
        existing.decision = '이수';
        existing.manual_review = memo;
        writeRow_('completions', row, existing);
      }
      return { created: false, completion: existing };
    }
    // 가장 최근 세션(있으면)에서 영상·시청 정보를 가져온다
    var session = null;
    findRows_('sessions', 'participant_id', participant.participant_id).forEach(function (r) {
      var sx = readRow_('sessions', r);
      if (!session || num_(sx.watched_sec) >= num_(session.watched_sec)) session = sx;
      if (sx.status === 'active') { sx.status = 'completed'; writeRow_('sessions', r, sx); }
    });
    var video = null;
    var vn = num_(videoNo);
    if (vn) getVideos_(true).forEach(function (v) { if (num_(v.video_no) === vn) video = v; });
    if (!video && session) video = findVideo_(String(session.video_id || ''), true);
    var now = now_();
    var completion = {
      completion_no: nextCompletionNo_(cfg, now),
      participant_id: participant.participant_id,
      session_id: session ? session.session_id : '',
      video_id: video ? video.video_id : '',
      video_title: video ? video.title : '',
      completed_at: now,
      member_type: participant.member_type,
      masked_name: maskName_(participant.name),
      affiliation: participant.affiliation,
      watched_sec: session ? Math.round(num_(session.watched_sec)) : 0,
      elapsed_sec: 0,
      video_duration_sec: video ? num_(video.duration_sec) : 0,
      coverage_ratio: session ? num_(session.coverage_ratio) : 0,
      decision: '이수',
      flag_reason: '수기 확인(측정 불가)',
      manual_review: memo
    };
    appendRows_('completions', [completion]);
    return { created: true, completion: completion };
  });
}

/** [시트 메뉴] "보류"로 판정된 이수 건을 스태프 확인 후 "이수"로 바꾼다. */
function approveHeldUi() {
  var ui = SpreadsheetApp.getUi();
  var r1 = ui.prompt('보류 건 이수 승인', '승인할 이수번호를 입력하세요. (예: FAIR26-20261112-0137)', ui.ButtonSet.OK_CANCEL);
  if (r1.getSelectedButton() !== ui.Button.OK) return;
  var r2 = ui.prompt('보류 건 이수 승인', '확인 메모 (예: 스태프 홍길동, 화면 대조 확인)', ui.ButtonSet.OK_CANCEL);
  if (r2.getSelectedButton() !== ui.Button.OK) return;
  try {
    var c = approveHeld_(r1.getResponseText(), r2.getResponseText());
    ui.alert('승인 완료: ' + c.completion_no + ' → 이수');
  } catch (err) {
    ui.alert('처리 실패: ' + err.message);
  }
}

function approveHeld_(completionNo, memo) {
  completionNo = clean_(completionNo, 40);
  memo = clean_(memo, 200);
  if (!completionNo) throw appError_('INVALID_INPUT', '이수번호를 입력해 주세요.');
  if (!memo) throw appError_('INVALID_INPUT', '확인 메모를 입력해 주세요.');
  return withLock_(function () {
    var row = findRows_('completions', 'completion_no', completionNo)[0];
    if (!row) throw appError_('NOT_FOUND', '해당 이수번호를 찾을 수 없습니다.');
    var c = readRow_('completions', row);
    if (c.decision === '이수') throw appError_('ALREADY', '이미 "이수"로 판정된 건입니다.');
    c.decision = '이수';
    c.manual_review = memo;
    writeRow_('completions', row, c);
    var sRow = findRows_('sessions', 'session_id', String(c.session_id))[0];
    if (sRow) { var sx = readRow_('sessions', sRow); sx.flag = '스태프 승인: ' + memo; writeRow_('sessions', sRow, sx); }
    return c;
  });
}

function clearConfigCache() {
  var cache = CacheService.getScriptCache();
  cache.remove(CONFIG_CACHE_KEY);
  cache.remove(VIDEOS_CACHE_KEY);
}

/** watch_logs 를 날짜가 붙은 보관 시트로 옮기고 원본을 비운다(행 수 관리). */
function archiveWatchLogs() {
  withLock_(function () {
    var ss = ss_();
    var src = sheet_('watch_logs');
    var last = src.getLastRow();
    if (last < 2) return;
    var width = SHEETS.watch_logs.length;
    var values = src.getRange(2, 1, last - 1, width).getValues();
    var name = 'watch_logs_' + Utilities.formatDate(now_(), 'Asia/Seoul', 'yyyyMMdd_HHmm');
    var dst = ss.insertSheet(name);
    dst.getRange(1, 1, 1, width).setValues([SHEETS.watch_logs]);
    dst.getRange(2, 1, values.length, width).setValues(values);
    src.getRange(2, 1, last - 1, width).clearContent();
  });
}

/** 보관 기간 종료 시: 로그·세션 삭제, 참가자 성명 마스킹·연락처/UA 삭제. 되돌릴 수 없다. */
function purgePersonalData() {
  var ui = SpreadsheetApp.getUi();
  var ans = ui.alert('개인정보 파기', '시청 로그·세션을 삭제하고 참가자 성명을 마스킹, 연락처·기기정보를 삭제합니다. 되돌릴 수 없습니다. 진행할까요?', ui.ButtonSet.YES_NO);
  if (ans !== ui.Button.YES) return;
  withLock_(function () {
    ['watch_logs', 'sessions'].forEach(function (name) {
      var sh = sheet_(name);
      var last = sh.getLastRow();
      if (last >= 2) sh.getRange(2, 1, last - 1, SHEETS[name].length).clearContent();
    });
    var sh = sheet_('participants');
    var last = sh.getLastRow();
    if (last >= 2) {
      var width = SHEETS.participants.length;
      var rows = sh.getRange(2, 1, last - 1, width).getValues().map(function (r) {
        var o = {};
        SHEETS.participants.forEach(function (h, i) { o[h] = r[i]; });
        o.name = maskName_(o.name);
        o.phone = '';
        o.user_agent = '';
        return toRow_('participants', o);
      });
      sh.getRange(2, 1, rows.length, width).setValues(rows);
    }
  });
}
