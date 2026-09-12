/**
 * Office Firewall — 클라이언트
 *
 * 흐름: 입력 → (브라우저) 선-마스킹 → /api/analyze → (브라우저) 역치환 → 렌더
 * 토큰 맵(sessionTokenMap)은 이 모듈의 지역 변수로만 존재한다. 저장·전송하지 않는다.
 */
import { mask, unmask, summarizeMask } from './lib/mask.js';
import { buildMockAnalysis } from './lib/mock.js';
import { buildResult } from './lib/normalize.js';
import golden from './data/golden.json';

const MAX_CHARS = 800;
const COOLDOWN_MS = 5000;

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

const PRESETS = [
  { id: 'weekend', emoji: '📅', label: '상사의 주말 업무' },
  { id: 'aislop', emoji: '🤖', label: '무지성 AI 복붙' },
  { id: 'pingpong', emoji: '🏓', label: '타부서 R&R 핑퐁' },
  { id: 'client', emoji: '👑', label: '클라이언트 갑질' },
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
  usageLine: $('usage-line'),
};

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
      });
      box.appendChild(btn);
    }
  });
}

function renderPresets() {
  for (const p of PRESETS) {
    const g = golden.find((x) => x.id === p.id);
    if (!g) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'preset';
    btn.dataset.id = p.id;
    btn.setAttribute('aria-pressed', 'false');
    btn.innerHTML = `<span class="emoji">${p.emoji}</span><span>${p.label}</span>`;
    btn.addEventListener('click', () => applyPreset(g, btn));
    el.presetGrid.appendChild(btn);
  }
}

/**
 * 상황 카드는 폼 값(맥락·메시지)만 채운다. 결과로 바로 넘어가지 않고
 * 사용자가 ③ 받은 메시지에서 내용을 확인·수정한 뒤 ⑦ 버튼으로 직접 실행한다.
 */
function applyPreset(g, btn) {
  el.presetGrid.querySelectorAll('.preset').forEach((b) => {
    b.classList.toggle('selected', b === btn);
    b.setAttribute('aria-pressed', String(b === btn));
  });

  el.message.value = g.text;
  el.hiddenContext.value = g.context.hiddenContext || '';
  selectByApiValue('job', g.context.job);
  selectByApiValue('level', g.context.level);
  selectByApiValue('counterpart', g.context.counterpart);
  selectByApiValue('goal', g.context.goal);
  selectByApiValue('tone', g.context.tone);
  onInput();

  // 바로 실행하지 않는다 — 사용자가 채워진 내용을 눈으로 확인/수정하게 한다.
  el.message.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.message.classList.remove('just-filled');
  // 리플로우를 강제해 같은 프리셋을 연속 클릭해도 애니메이션이 다시 재생되게 한다.
  void el.message.offsetWidth;
  el.message.classList.add('just-filled');
  setHint('메시지를 확인한 뒤 실행 버튼을 눌러주세요.');
}

function selectByApiValue(field, value) {
  const match = OPTIONS[field].find((o) => apiValue(o) === value);
  if (!match) return;
  state[field] = match;
  const wrap = document.querySelector(`.selector[data-field="${field}"]`);
  wrap?.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-checked', String(c.dataset.value === value)));
  if (field === 'tone') el.toneWarning.hidden = value !== '매운맛';
}

/* ── 입력 ───────────────────────────── */

function onInput() {
  const len = el.message.value.length;
  el.charCount.textContent = String(len);
  const counter = el.charCount.parentElement;
  counter.classList.toggle('warn', len > MAX_CHARS * 0.9 && len <= MAX_CHARS);
  counter.classList.toggle('over', len > MAX_CHARS);
  if (!el.maskPreview.hidden) updateMaskPreview();
}

function updateMaskPreview() {
  const { maskedText, counts } = mask(el.message.value);
  el.maskPreviewBody.textContent = maskedText || '(입력 없음)';
  el.maskSummary.textContent = summarizeMask(counts);
}

/* ── 실행 ───────────────────────────── */

function currentContext() {
  return {
    job: apiValue(state.job),
    level: apiValue(state.level),
    counterpart: apiValue(state.counterpart),
    goal: apiValue(state.goal),
    tone: apiValue(state.tone),
    hiddenContext: el.hiddenContext.value.trim(),
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
    showError('분석할 메시지를 먼저 붙여넣어 주세요.');
    return;
  }
  if (text.length > MAX_CHARS) {
    showError(`메시지는 ${MAX_CHARS}자까지 분석합니다. 현재 ${text.length}자입니다.`);
    return;
  }

  // 선-마스킹: 이 시점 이후로 원문은 네트워크를 타지 않는다.
  const { maskedText, map } = mask(text);
  sessionTokenMap = map;

  busy = true;
  setBusy(true);
  hideError();
  const startedAt = Date.now();

  try {
    const payload = { maskedText, context: currentContext() };
    let result;
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
    render(result, Date.now() - startedAt);
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

function render(result, elapsedMs) {
  const { xray, replies, risk, meta, usage } = result;

  el.standby.hidden = true;
  el.result.hidden = false;

  el.xray.className = `xray level-${risk.level}`;
  el.alertHeader.textContent = risk.header;
  el.modeBadge.textContent = { live: 'LIVE', mock: 'MOCK', local: 'LOCAL' }[meta.mode] || meta.mode;
  el.modeBadge.title = meta.note || `model: ${meta.model}`;

  animateScore(risk.score);
  el.scoreLabel.textContent = risk.label;
  el.scoreAction.textContent = risk.action;
  el.scoreBarFill.style.width = `${risk.score}%`;
  el.subtext.textContent = unmask(xray.subtext, sessionTokenMap);

  renderStats(xray);
  renderEvidence(xray, risk);
  renderReplies(replies);

  const tokens = usage?.input_tokens || usage?.output_tokens
    ? ` · in ${usage.input_tokens} / out ${usage.output_tokens} tokens`
    : '';
  el.usageLine.textContent = `${meta.model} · ${elapsedMs}ms${tokens}`;
  el.result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
onInput();
