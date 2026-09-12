/**
 * Office Firewall — 클라이언트
 *
 * 흐름: 입력 → (브라우저) 선-마스킹 → /api/analyze → (브라우저) 역치환 → 렌더
 * 토큰 맵(sessionTokenMap)은 이 모듈의 지역 변수로만 존재한다. 저장·전송하지 않는다.
 */
import { toPng, toBlob } from 'html-to-image';
import { maskFields, unmask, summarizeMask } from './lib/mask.js';
import { buildMockAnalysis } from './lib/mock.js';
import { buildResult } from './lib/normalize.js';
import { buildReceiptData } from './lib/receipt.js';
import { looksLikeMultiTurnThread } from './lib/thread-hint.js';
import { matchSituationId } from './lib/situation-match.js';
import { entryFromResult, addEntry, getHistory, clearHistory, summarize } from './lib/history.js';
import golden from './data/golden.json';
import presetWeekend from './data/presets/weekend.json';
import presetAislop from './data/presets/aislop.json';
import presetPingpong from './data/presets/pingpong.json';
import presetClient from './data/presets/client.json';

/**
 * 가이드 §9 데모 안전장치: 입력이 상황 카드 원본과 정확히 같으면
 * 네트워크·룰엔진 계산 없이 미리 구운 JSON 을 그대로 렌더링한다.
 * (0.1초 · $0 — 시연 중 API/룰엔진에 무슨 일이 생겨도 흔들리지 않는다)
 * scripts/gen-presets.mjs 로 생성/갱신한다.
 */
const PRESET_CACHE = { weekend: presetWeekend, aislop: presetAislop, pingpong: presetPingpong, client: presetClient };

const MAX_CHARS = 800;
const COOLDOWN_MS = 5000;
const SUGGEST_MIN_CHARS = 8;
const SUGGEST_DEBOUNCE_MS = 350;

const OPTIONS = {
  job: ['기획·PM/PO', '개발(Dev)', '디자인', '비즈니스'],
  level: ['주니어(1~3년)', '시니어(4~7년)', '리드·팀장(8년+)'],
  counterpart: ['직속상사', '타부서 동료', '팀원(AI복붙)', '클라이언트'],
  goal: ['🛑 칼차단', '⏳ 시간벌기', '🏓 공넘기기', '🕊️ 관계보존'],
  tone: ['🟢 순한맛', '🟡 보통맛', '🔴 매운맛'],
};

/** 화면 표기 → API 계약값 */
const VALUE_OF = {
  '주니어(1~3년)': '주니어',
  '시니어(4~7년)': '시니어',
  '리드·팀장(8년+)': '리드·팀장',
};
const strip = (s) => s.replace(/^[^\p{L}\p{N}]+/u, '').trim();
const apiValue = (raw) => VALUE_OF[raw] || strip(raw);

/**
 * 구체적인 상황 카드 — 예시 문구를 담고 있을 뿐, 폼을 채우지 않는다
 * (applyPreset 참고). 골든 4종(weekend/aislop/pingpong/client)은 텍스트를
 * 자동화 테스트 코퍼스(src/data/golden.json)와 같은 문구를 쓰지만, 이제는
 * 순수 UI 예시 갤러리라서 골든 데이터에 종속되지 않는다 — 새 카드를
 * 추가할 때 테스트 픽스처를 함께 만들 필요가 없다.
 */
const PRESETS = [
  {
    id: 'weekend',
    emoji: '📅',
    label: '상사의 주말 업무',
    text: '박지훈님 주말에 미안한데, 월요일 오전에 대표님 보고가 잡혀서요. 시간 날 때 가볍게 한번 봐주시면 좋을 것 같아요. 급한 건 아닙니다!',
  },
  {
    id: 'aislop',
    emoji: '🤖',
    label: '무지성 AI 복붙',
    text: '안녕하세요! 말씀해주신 사항에 대해 검토해보았습니다. 전반적으로 긍정적인 방향으로 보이며, 추가적인 논의를 통해 더 나은 결과를 도출할 수 있을 것으로 사료됩니다. 관련하여 지속적인 커뮤니케이션을 이어가면 좋겠습니다. 감사합니다.',
  },
  {
    id: 'pingpong',
    emoji: '🏓',
    label: '타부서 R&R 핑퐁',
    text: '이 건은 저희 쪽 R&R은 아닌 것 같은데요, 아무래도 기획 단계에서 정리되는 게 맞을 것 같습니다. 혹시 먼저 정리해서 공유해주실 수 있을까요? 저희는 그거 받고 나서 진행하겠습니다.',
  },
  {
    id: 'client',
    emoji: '👑',
    label: '클라이언트 갑질',
    text: '이거 처음 얘기했던 거랑 좀 다른데요? 저희가 원한 건 이게 아니었습니다. 내일까지 다시 작업해서 보내주세요. 추가 비용 얘기는 없던 걸로 알고 있습니다.',
  },
  {
    id: 'nightowl',
    emoji: '🌙',
    label: '퇴근 후 야간 톡',
    text: '이렇게 늦은 시간에 톡해서 미안한데 자기 전에 하나만 부탁해도 될까요? 내일 오전 회의자료에 지난달 지표 슬라이드 하나만 껴주면 좋을 것 같아요. 급한 건 아니니까 편하실 때 봐주세요~',
  },
  {
    id: 'emailcreep',
    emoji: '✉️',
    label: '이메일 무한 수정요청',
    text: '안녕하세요, 지난번에 말씀드린 배너 시안 관련해서요. 죄송한데 색감을 조금만 더 밝게, 폰트도 살짝 키워주시고, 로고 위치도 다시 한 번 검토 부탁드려요. 예산 안에서 진행 가능할 것 같아서 말씀드립니다!',
  },
  {
    id: 'groupchat',
    emoji: '📢',
    label: '단톡방 공개 저격',
    text: '다들 보고 계시죠? 이번 프로젝트 일정 늦어진 거 이 자리에서 한번 정리하고 갑시다. 담당자분 답변 부탁드려요.',
  },
  {
    id: 'passthebuck',
    emoji: '🤐',
    label: '책임 떠넘기는 지시',
    text: '이 부분은 담당자님이 알아서 잘 판단해서 진행해 주세요. 저는 큰 그림만 보고 있어서 세부적인 건 믿고 맡기겠습니다. 결과만 잘 나오면 될 것 같아요!',
  },
];

const state = {
  job: OPTIONS.job[0],
  level: OPTIONS.level[0],
  counterpart: OPTIONS.counterpart[0],
  goal: OPTIONS.goal[0],
  tone: OPTIONS.tone[1], // 보통맛 기본값
};

/** 세션 메모리 토큰 맵 — localStorage 금지, 서버 전송 금지 */
let sessionTokenMap = Object.create(null);
let cooldownUntil = 0;
let busy = false;
let suggestTimer = null;

const $ = (id) => document.getElementById(id);
const el = {
  presetGrid: $('preset-grid'),
  message: $('message'),
  charCount: $('char-count'),
  hiddenContext: $('hidden-context'),
  toneWarning: $('tone-warning'),
  togglePreview: $('toggle-preview'),
  maskPreview: $('mask-preview'),
  maskPreviewBody: $('mask-preview-body'),
  maskSummary: $('mask-summary'),
  threadWarning: $('thread-warning'),
  run: $('run'),
  runHint: $('run-hint'),
  standby: $('standby'),
  result: $('result'),
  errorBox: $('error-box'),
  xray: $('xray'),
  alertHeader: $('alert-header'),
  modeBadge: $('mode-badge'),
  scoreValue: $('score-value'),
  scoreLabel: $('score-label'),
  scoreAction: $('score-action'),
  scoreBarFill: $('score-bar-fill'),
  subtext: $('subtext'),
  stats: $('stats'),
  evidenceBody: $('evidence-body'),
  replies: $('replies'),
  repliesModeNote: $('replies-mode-note'),
  usageLine: $('usage-line'),
  receiptOpen: $('receipt-open'),
  receiptModal: $('receipt-modal'),
  receiptBackdrop: $('receipt-backdrop'),
  receiptClose: $('receipt-close'),
  receiptCard: $('receipt-card'),
  receiptSave: $('receipt-save'),
  receiptCopy: $('receipt-copy'),
  receiptStatus: $('receipt-status'),
  rcIssued: $('rc-issued'),
  rcJob: $('rc-job'),
  rcVillain: $('rc-villain'),
  rcScore: $('rc-score'),
  rcMode: $('rc-mode'),
  rcHours: $('rc-hours'),
  rcHp: $('rc-hp'),
  rcRisk: $('rc-risk'),
  rcCount: $('rc-count'),
  historyOpen: $('history-open'),
  historyModal: $('history-modal'),
  historyBackdrop: $('history-backdrop'),
  historyClose: $('history-close'),
  historySummary: $('history-summary'),
  historyCount: $('history-count'),
  historyAvg: $('history-avg'),
  historyTop: $('history-top'),
  historyEmpty: $('history-empty'),
  historyList: $('history-list'),
  historyClear: $('history-clear'),
};

/** 마지막으로 렌더링된 결과 — 영수증은 이 스냅샷에서만 값을 읽는다(원문 재접근 없음). */
let lastReceiptSource = null;

/* ── 셀렉터 / 프리셋 렌더 ───────────────────────────── */

function renderChips() {
  document.querySelectorAll('.selector').forEach((wrap) => {
    const field = wrap.dataset.field;
    const box = wrap.querySelector('.chips');
    box.innerHTML = '';
    for (const opt of OPTIONS[field]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip';
      btn.role = 'radio';
      btn.dataset.value = apiValue(opt);
      btn.textContent = opt;
      btn.setAttribute('aria-checked', String(state[field] === opt));
      btn.addEventListener('click', () => {
        state[field] = opt;
        box.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-checked', 'false'));
        btn.setAttribute('aria-checked', 'true');
        if (field === 'tone') el.toneWarning.hidden = apiValue(opt) !== '매운맛';
        if (field === 'counterpart') updateSituationSuggestion();
      });
      box.appendChild(btn);
    }
  });
}

/** id → 카드 버튼. ③ 입력 내용 기반 추천 표시(updateSituationSuggestion)에 쓴다. */
const presetButtons = new Map();

function renderPresets() {
  for (const p of PRESETS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'preset';
    btn.dataset.id = p.id;
    btn.setAttribute('aria-pressed', 'false');
    btn.innerHTML = `<span class="emoji">${p.emoji}</span><span>${p.label}</span><span class="suggested-badge">✨ 비슷해요</span>`;
    btn.addEventListener('click', () => applyPreset(p, btn));
    el.presetGrid.appendChild(btn);
    presetButtons.set(p.id, btn);
  }
}

/**
 * ③ 입력창에 실제로 타이핑된(마스킹 전, 로컬 판단용) 내용을 규칙 기반으로
 * 분석해 ②의 카드 중 하나에 "추천" 표시만 얹는다. 값을 채우거나 강제로
 * 선택하지 않는다 — 사용자가 이미 손에 든 메시지를 붙여넣는 흐름에 맞춰,
 * 카드를 먼저 고르지 않아도 자연스럽게 비슷한 상황을 알아볼 수 있게 하는
 * 힌트일 뿐이다.
 */
function updateSituationSuggestion() {
  const text = el.message.value;
  const matchedId = text.trim().length >= SUGGEST_MIN_CHARS
    ? matchSituationId(text, apiValue(state.counterpart))
    : null;
  presetButtons.forEach((btn, id) => btn.classList.toggle('suggested', id === matchedId));
}

/**
 * 상황 카드는 실제로 아무 값도 채우지 않는다 — ③ 입력창의 placeholder 를
 * 예시 문구로 바꿔서 "이런 느낌의 내용" 을 미리 보여줄 뿐이다. 입력을
 * 시작하는 순간 브라우저가 알아서 지워준다(placeholder 의 기본 동작).
 *
 * 전에는 메시지를 실제로 채워 넣었는데, 그래도 여전히 "프리셋처럼 다
 * 채워지는 느낌" 이라는 피드백을 받았다 — 예시는 예시일 뿐, 사용자가
 * 직접 자기 상황을 입력하게 유도하는 편이 이 도구의 실제 사용 방식에
 * 더 가깝다. ① 맥락 매트릭스·④ 숨은 속사정·⑤ 방어 목적·⑥ 완곡도는
 * 여전히 손대지 않는다(이전 수정 그대로).
 */
function applyPreset(p, btn) {
  el.presetGrid.querySelectorAll('.preset').forEach((b) => {
    b.classList.toggle('selected', b === btn);
    b.setAttribute('aria-pressed', String(b === btn));
  });

  el.message.placeholder = p.text;

  el.message.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.message.classList.remove('just-filled');
  // 리플로우를 강제해 같은 카드를 연속 클릭해도 애니메이션이 다시 재생되게 한다.
  void el.message.offsetWidth;
  el.message.classList.add('just-filled');
  setHint('예시를 참고해 실제 내용을 입력한 뒤 실행 버튼을 눌러주세요.');
}

/**
 * 현재 폼이 상황 카드 원본과 완전히 같은지 확인한다 — 하나라도 수정했으면
 * 사용자의 편집을 반영해야 하므로 캐시를 쓰지 않고 정상 분석 경로로 보낸다.
 * @returns {string|null} 일치하는 프리셋 id, 없으면 null
 */
function matchPresetId(text, hiddenContextRaw, ctx) {
  for (const id of Object.keys(PRESET_CACHE)) {
    const g = golden.find((x) => x.id === id);
    if (!g) continue;
    const sameContext = ['job', 'level', 'counterpart', 'goal', 'tone'].every((k) => g.context[k] === ctx[k]);
    if (g.text === text && (g.context.hiddenContext || '') === hiddenContextRaw && sameContext) {
      return id;
    }
  }
  return null;
}

/* ── 입력 ───────────────────────────── */

function onInput() {
  const len = el.message.value.length;
  el.charCount.textContent = String(len);
  const counter = el.charCount.parentElement;
  counter.classList.toggle('warn', len > MAX_CHARS * 0.9 && len <= MAX_CHARS);
  counter.classList.toggle('over', len > MAX_CHARS);
  el.threadWarning.hidden = !looksLikeMultiTurnThread(el.message.value);
  if (!el.maskPreview.hidden) updateMaskPreview();
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(updateSituationSuggestion, SUGGEST_DEBOUNCE_MS);
}

function updateMaskPreview() {
  // ④ 나의 숨은 속사정도 자유 입력 필드라서 여기 실명·연락처를 적으면
  // 마스킹 우회 경로가 된다 — 메시지와 함께 마스킹해 실제 전송본을 그대로 보여준다.
  const { maskedMessage, maskedHiddenContext, counts } = maskFields(el.message.value, el.hiddenContext.value.trim());
  const parts = [maskedMessage || '(입력 없음)'];
  if (maskedHiddenContext) parts.push(`\n— 숨은 속사정 —\n${maskedHiddenContext}`);
  el.maskPreviewBody.textContent = parts.join('');
  el.maskSummary.textContent = summarizeMask(counts);
}

/* ── 실행 ───────────────────────────── */

function contextFields() {
  return {
    job: apiValue(state.job),
    level: apiValue(state.level),
    counterpart: apiValue(state.counterpart),
    goal: apiValue(state.goal),
    tone: apiValue(state.tone),
  };
}

async function run() {
  if (busy) return;
  const now = Date.now();
  if (now < cooldownUntil) {
    setHint(`${Math.ceil((cooldownUntil - now) / 1000)}초 후에 다시 실행할 수 있습니다.`);
    return;
  }
  const text = el.message.value.trim();
  if (!text) {
    showError('분석할 내용을 먼저 입력해 주세요. 상황 카드는 예시일 뿐, 직접 입력해야 분석됩니다.');
    return;
  }
  if (text.length > MAX_CHARS) {
    showError(`메시지는 ${MAX_CHARS}자까지 분석합니다. 현재 ${text.length}자입니다.`);
    return;
  }

  // 선-마스킹: 이 시점 이후로 원문(메시지 + 숨은 속사정)은 네트워크를 타지 않는다.
  const hiddenContextRaw = el.hiddenContext.value.trim();
  const { maskedMessage, maskedHiddenContext, map } = maskFields(text, hiddenContextRaw);
  sessionTokenMap = map;

  busy = true;
  setBusy(true);
  hideError();
  const startedAt = Date.now();

  try {
    let result;
    const context = contextFields();
    const presetId = matchPresetId(text, hiddenContextRaw, context);

    if (presetId) {
      // 상황 카드 원본 그대로 — 네트워크·룰엔진 계산 없이 캐시를 바로 렌더링한다.
      result = buildResult(PRESET_CACHE[presetId], maskedMessage, {
        mode: 'cached',
        model: 'preset-cache',
        latencyMs: Date.now() - startedAt,
      });
      result.meta.note = '캐시된 프리셋 — API 호출 없음, 비용 $0';
    } else {
      const payload = { maskedText: maskedMessage, context: { ...context, hiddenContext: maskedHiddenContext } };
      try {
        result = await postAnalyze(payload);
      } catch (err) {
        // 시연 안전장치: 서버리스 함수가 없거나(vite 단독 실행) 실패하면 로컬 룰엔진으로 폴백한다.
        if (err.recoverable) {
          result = localFallback(payload, startedAt);
          result.meta.note = err.message;
        } else {
          throw err;
        }
      }
    }
    render(result, Date.now() - startedAt, context);
    cooldownUntil = Date.now() + COOLDOWN_MS;
    startCooldownTimer();
  } catch (err) {
    showError(err.message || '분석에 실패했습니다. 잠시 후 다시 시도하거나 좌측 상황 카드를 사용하세요.');
  } finally {
    busy = false;
    setBusy(false);
  }
}

async function postAnalyze(payload) {
  let res;
  try {
    res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    throw recoverable('서버에 연결하지 못해 로컬 룰엔진으로 분석했습니다.');
  }
  if (res.status === 404 || res.status === 405) {
    throw recoverable('/api/analyze 가 없어 로컬 룰엔진으로 분석했습니다. (vercel dev 로 실행하세요)');
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw recoverable('서버 응답을 해석하지 못해 로컬 룰엔진으로 분석했습니다.');
  }
  if (!res.ok) {
    const message = body?.error?.message || '분석에 실패했습니다.';
    if (body?.error?.code === 'UPSTREAM_FAILED') throw recoverable('모델 호출이 실패해 로컬 룰엔진으로 분석했습니다.');
    throw new Error(message);
  }
  return body;
}

function recoverable(message) {
  const e = new Error(message);
  e.recoverable = true;
  return e;
}

function localFallback(payload, startedAt) {
  const aiOut = buildMockAnalysis(payload.maskedText, payload.context);
  return buildResult(aiOut, payload.maskedText, {
    mode: 'local',
    model: 'rule-engine',
    latencyMs: Date.now() - startedAt,
  });
}

/* ── 렌더 ───────────────────────────── */

function render(result, elapsedMs, context) {
  const { xray, replies, risk, meta, usage } = result;

  // 영수증은 이 스냅샷(xray/risk/context)에서만 값을 읽는다 — 원문·마스킹 토큰과는 무관하다.
  lastReceiptSource = { xray, risk, context };
  // 나의 방어 기록에도 같은 원칙으로 카테고리·점수만 남긴다(원문 없음).
  addEntry(entryFromResult(xray, risk, context));

  el.standby.hidden = true;
  el.result.hidden = false;

  el.xray.className = `xray level-${risk.level}`;
  el.alertHeader.textContent = risk.header;
  el.modeBadge.textContent = { live: 'LIVE', mock: 'MOCK', local: 'LOCAL', cached: 'PRESET · $0' }[meta.mode] || meta.mode;
  el.modeBadge.title = meta.note || `model: ${meta.model}`;

  animateScore(risk.score);
  el.scoreLabel.textContent = risk.label;
  el.scoreAction.textContent = risk.action;
  el.scoreBarFill.style.width = `${risk.score}%`;
  el.subtext.textContent = unmask(xray.subtext, sessionTokenMap);

  renderStats(xray);
  renderEvidence(xray, risk);
  renderReplies(replies);
  renderRepliesModeNote(meta.mode);

  const tokens = usage?.input_tokens || usage?.output_tokens
    ? ` · in ${usage.input_tokens} / out ${usage.output_tokens} tokens`
    : '';
  el.usageLine.textContent = `${meta.model} · ${elapsedMs}ms${tokens}`;
  // 결과 패널이 아니라 X-Ray 카드(점수·경보) 기준으로 스크롤한다 — 'nearest' 로
  // 패널 전체를 기준 삼으면 가장 중요한 점수/경보가 화면 위로 잘려 나갈 수 있다.
  el.xray.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function animateScore(target) {
  const node = el.scoreValue;
  const start = Number(node.textContent) || 0;
  const t0 = performance.now();
  const step = (t) => {
    const p = Math.min(1, (t - t0) / 450);
    node.textContent = String(Math.round(start + (target - start) * (1 - (1 - p) ** 3)));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderStats(xray) {
  const pips = (n, total) =>
    `<div class="stat-meter">${Array.from({ length: total }, (_, i) => `<span class="stat-pip${i < n ? ' on' : ''}"></span>`).join('')}</div>`;

  const cards = [
    {
      name: '권력 비대칭',
      value: `Lv.${xray.powerAsymmetry}`,
      extra: pips(xray.powerAsymmetry, 5),
      sub: ['거절해도 무방', '부담 적음', '보통', '거절 비용 큼', '사실상 거절 불가'][xray.powerAsymmetry - 1],
    },
    {
      name: '시간적 긴급도',
      value: xray.urgencyType,
      extra: '',
      sub: xray.urgencyType === '없음' ? '업무 시간 내 요청' : '경계 침범 신호',
    },
    {
      name: '요구 모호성',
      value: xray.ambiguityType,
      extra: '',
      sub: xray.hasDeadline ? '기한 명시됨' : '기한 없음',
    },
    {
      name: 'AI 복붙 냄새',
      value: `${xray.aiSlopScore}%`,
      extra: pips(Math.round(xray.aiSlopScore / 20), 5),
      sub: xray.aiSlopScore >= 60 ? '정형구 과다' : '사람이 쓴 문장',
    },
  ];

  el.stats.innerHTML = cards
    .map(
      (c) => `<div class="stat">
        <span class="stat-name">${c.name}</span>
        <span class="stat-value">${escapeHtml(c.value)}</span>
        ${c.extra}
        <span class="stat-sub">${escapeHtml(c.sub)}</span>
      </div>`,
    )
    .join('');
}

function renderEvidence(xray, risk) {
  const rows = risk.breakdown
    .map((m) => `<tr><td>${m.label}</td><td>${escapeHtml(m.detail)}</td><td>${m.value.toFixed(2)}</td></tr>`)
    .join('');
  const cliches = xray.clicheHits.length
    ? `<div class="chip-list">${xray.clicheHits.map((c) => `<span class="cliche-tag">${escapeHtml(c)}</span>`).join('')}</div>`
    : '<p class="evidence-formula">검출된 클리셰 없음</p>';

  el.evidenceBody.innerHTML = `
    <table class="evidence-table">
      <thead><tr><th>알맹이 결여 지표</th><th>검출</th><th>0~1</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${cliches}
    <p class="evidence-formula">
      점수 = 권력 비대칭(${xray.powerAsymmetry}×8) + 긴급도(${xray.urgencyType === '없음' ? 0 : 20})
      + 모호성(${xray.ambiguityType === '없음' ? 0 : 20}) + 결여율×20 = <b>${risk.score}</b>
    </p>
    <p class="evidence-formula">이 점수는 AI가 아니라 코드가 계산합니다. 같은 입력이면 항상 같은 값이 나옵니다.</p>
  `;
}

/**
 * LIVE(실제 Claude 호출) 가 아니면 답장이 메시지 내용을 깊이 읽고 쓴 게 아니라
 * 목적×완곡도로 갈라지는 규칙 기반 근사치라는 걸 명시한다. 이 설명이 없으면
 * "답장이 왜 내 메시지를 다르게 표현한 것처럼 느껴지지" 하고 오해하기 쉽다.
 */
function renderRepliesModeNote(mode) {
  if (mode === 'live') {
    el.repliesModeNote.hidden = true;
    return;
  }
  el.repliesModeNote.hidden = false;
  el.repliesModeNote.textContent = mode === 'cached'
    ? 'ℹ️ 캐시된 예시 답장입니다 — 상황 카드 원본 그대로일 때만 나오는 미리 준비된 결과예요.'
    : 'ℹ️ 지금은 규칙 기반 예시 답장입니다(모델 미연동/MOCK). 목적·완곡도에 따라 갈라지긴 하지만 메시지 내용을 세세히 읽고 쓰진 않아요 — 그대로 보내기보다 초안으로 참고해 다듬어 주세요.';
}

function renderReplies(replies) {
  el.replies.innerHTML = '';
  replies.forEach((r, i) => {
    const text = unmask(r.text, sessionTokenMap);
    const card = document.createElement('div');
    card.className = 'reply';
    card.innerHTML = `
      <div class="reply-head">
        <span class="reply-label">[추천 ${i + 1}] ${escapeHtml(r.label)}</span>
        <span class="reply-index">${text.length}자</span>
      </div>
      <p class="reply-text"></p>
      <button type="button" class="copy">복사</button>`;
    card.querySelector('.reply-text').textContent = text;
    const btn = card.querySelector('.copy');
    btn.addEventListener('click', () => copyText(text, btn));
    el.replies.appendChild(card);
  });
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  btn.textContent = '복사됨 ✓';
  btn.classList.add('done');
  setTimeout(() => {
    btn.textContent = '복사';
    btn.classList.remove('done');
  }, 1600);
}

/* ── 상태 표시 ───────────────────────────── */

function setBusy(on) {
  el.run.disabled = on;
  el.run.textContent = on ? '분석 중…' : '방화벽 X-Ray 분석 & 카운터 답장 생성';
  document.body.classList.toggle('is-loading', on);
}

function setHint(msg) {
  el.runHint.textContent = msg;
}

function startCooldownTimer() {
  const tick = () => {
    const left = Math.ceil((cooldownUntil - Date.now()) / 1000);
    if (left > 0) {
      el.run.disabled = true;
      setHint(`${left}초 후 다시 실행할 수 있습니다.`);
      setTimeout(tick, 250);
    } else {
      el.run.disabled = busy;
      setHint('분석은 5초에 한 번 실행됩니다.');
    }
  };
  tick();
}

function showError(message) {
  el.errorBox.hidden = false;
  el.errorBox.textContent = message;
}

function hideError() {
  el.errorBox.hidden = true;
  el.errorBox.textContent = '';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ── 오피스 방어 영수증 ───────────────────────────── *
 * 원문·실명·탐지값(clicheHits, subtext 등)은 절대 참조하지 않는다.
 * lastReceiptSource 에 담긴 xray/risk/context 중 receipt.js 가 실제로
 * 읽는 필드(카테고리·점수)만 사용한다. */

const RECEIPT_COUNT_KEY = 'ofw_receipt_count';

/** 이번 달 발급 건수 — 브라우저 로컬에만 남는다. 서버로 전송되지 않고,
 * 계정·기기 간 동기화도 되지 않는다(로그인이 없으므로). */
function bumpMonthlyReceiptCount() {
  const monthKey = new Date().toISOString().slice(0, 7); // "2026-09"
  let store;
  try {
    store = JSON.parse(localStorage.getItem(RECEIPT_COUNT_KEY) || '{}');
  } catch {
    store = {};
  }
  store[monthKey] = (store[monthKey] || 0) + 1;
  try {
    localStorage.setItem(RECEIPT_COUNT_KEY, JSON.stringify(store));
  } catch {
    // 프라이빗 브라우징 등으로 저장이 막혀도 발급 자체는 계속 동작해야 한다.
  }
  return store[monthKey];
}

function openReceiptModal() {
  if (!lastReceiptSource) return;
  const { xray, risk, context } = lastReceiptSource;
  const data = buildReceiptData(xray, risk, context);
  const count = bumpMonthlyReceiptCount();

  el.rcIssued.textContent = data.issuedAt;
  el.rcJob.textContent = data.job;
  el.rcVillain.textContent = data.villain;
  el.rcScore.textContent = `${data.score} / 100`;
  el.rcMode.textContent = data.defenseMode;
  el.rcHours.textContent = `+${data.hoursSaved} Hours`;
  el.rcHp.textContent = `+${data.mentalHp} HP`;
  el.rcRisk.textContent = `${data.politicalRiskPercent}% (${data.politicalRiskNote})`;
  el.rcCount.textContent = String(count);

  el.receiptStatus.textContent = '';
  el.receiptModal.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeReceiptModal() {
  el.receiptModal.hidden = true;
  document.body.style.overflow = '';
}

async function captureReceiptPng() {
  // 폰트 로딩 등으로 인한 첫 캡처 오차를 줄이기 위해 한 프레임 양보한다.
  await new Promise((r) => requestAnimationFrame(r));
  return toPng(el.receiptCard, { pixelRatio: 2, cacheBust: true });
}

async function saveReceiptImage() {
  setReceiptStatus('이미지 생성 중…');
  try {
    const dataUrl = await captureReceiptPng();
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `office-firewall-receipt-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setReceiptStatus('저장했습니다.');
  } catch (err) {
    setReceiptStatus('이미지 생성에 실패했습니다. 잠시 후 다시 시도해 주세요.');
  }
}

async function copyReceiptImage() {
  setReceiptStatus('이미지 생성 중…');
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
      throw new Error('clipboard-unsupported');
    }
    await new Promise((r) => requestAnimationFrame(r));
    const blob = await toBlob(el.receiptCard, { pixelRatio: 2, cacheBust: true });
    if (!blob) throw new Error('blob-failed');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    setReceiptStatus('클립보드에 복사했습니다.');
  } catch {
    setReceiptStatus('이 브라우저에서는 이미지 복사가 지원되지 않습니다. "이미지로 저장"을 이용해 주세요.');
  }
}

function setReceiptStatus(msg) {
  el.receiptStatus.textContent = msg;
}

/* ── 나의 방어 기록 ───────────────────────────── */

const LEVEL_COLOR = { green: 'var(--green)', lime: 'var(--lime)', amber: 'var(--amber)', orange: 'var(--orange)', red: 'var(--red)' };

function openHistoryModal() {
  renderHistory();
  el.historyModal.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeHistoryModal() {
  el.historyModal.hidden = true;
  document.body.style.overflow = '';
}

function renderHistory() {
  const history = getHistory();
  const hasEntries = history.length > 0;

  el.historySummary.hidden = !hasEntries;
  el.historyEmpty.hidden = hasEntries;
  el.historyClear.hidden = !hasEntries;

  if (hasEntries) {
    const s = summarize(history);
    el.historyCount.textContent = String(s.count);
    el.historyAvg.textContent = String(s.avgScore);
    el.historyTop.textContent = s.topVillain || '—';
  }

  el.historyList.innerHTML = history
    .map((e) => {
      const date = new Date(e.ts);
      const dateStr = `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
      return `<div class="history-item">
        <span class="history-item-score" style="color:${LEVEL_COLOR[e.level] || 'var(--text-dim)'}">${e.score}</span>
        <div class="history-item-body">
          <div class="history-item-villain">${escapeHtml(e.villain)}</div>
          <div class="history-item-meta">${dateStr} · ${escapeHtml(e.job)} · ${escapeHtml(e.defenseMode)}</div>
        </div>
      </div>`;
    })
    .join('');
}

function onClearHistory() {
  // eslint-disable-next-line no-alert
  if (!window.confirm('나의 방어 기록을 전부 삭제할까요? 이 작업은 되돌릴 수 없습니다.')) return;
  clearHistory();
  renderHistory();
}

/* ── 초기화 ───────────────────────────── */

renderChips();
renderPresets();
el.message.addEventListener('input', onInput);
el.run.addEventListener('click', () => run());
el.togglePreview.addEventListener('click', () => {
  const show = el.maskPreview.hidden;
  el.maskPreview.hidden = !show;
  el.togglePreview.setAttribute('aria-expanded', String(show));
  el.togglePreview.textContent = show ? '전송될 내용 닫기' : '전송될 내용 확인';
  if (show) updateMaskPreview();
});
el.receiptOpen.addEventListener('click', openReceiptModal);
el.receiptClose.addEventListener('click', closeReceiptModal);
el.receiptBackdrop.addEventListener('click', closeReceiptModal);
el.receiptSave.addEventListener('click', saveReceiptImage);
el.receiptCopy.addEventListener('click', copyReceiptImage);
el.historyOpen.addEventListener('click', openHistoryModal);
el.historyClose.addEventListener('click', closeHistoryModal);
el.historyBackdrop.addEventListener('click', closeHistoryModal);
el.historyClear.addEventListener('click', onClearHistory);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!el.receiptModal.hidden) closeReceiptModal();
  if (!el.historyModal.hidden) closeHistoryModal();
});
onInput();
