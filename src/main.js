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
import { loadPrefs, savePrefs } from './lib/prefs.js';
import { substanceGap, GREEN_CAP } from './lib/score.js';
import golden from './data/golden.json';
import presetWeekend from './data/presets/weekend.json';
import presetAislop from './data/presets/aislop.json';
import presetPingpong from './data/presets/pingpong.json';
import presetClient from './data/presets/client.json';
import { PRESETS } from './data/presets.js';

/**
 * 가이드 §9 데모 안전장치: 입력이 상황 카드 원본과 정확히 같으면
 * 네트워크·룰엔진 계산 없이 미리 구운 JSON 을 그대로 렌더링한다.
 * (0.1초 · $0 — 시연 중 API/룰엔진에 무슨 일이 생겨도 흔들리지 않는다)
 * scripts/gen-presets.mjs 로 생성/갱신한다.
 */
const PRESET_CACHE = { weekend: presetWeekend, aislop: presetAislop, pingpong: presetPingpong, client: presetClient };

/** 결과가 어떤 경로로 나왔는지 알리는 배지 문구. 값은 meta.mode 와 1:1 이다. */
const MODE_BADGE = {
  live: 'AI 분석',        // 실제 모델 호출
  mock: '규칙 분석',      // 서버에 모델 미연동 — 서버측 룰엔진
  local: '오프라인 분석', // 서버 도달 실패 — 브라우저 룰엔진 폴백
  cached: '저장된 예시',  // 상황 카드 프리셋 캐시(호출 없음)
};

const MAX_CHARS = 800;
const COOLDOWN_MS = 5000;
const SUGGEST_MIN_CHARS = 8;
const SUGGEST_DEBOUNCE_MS = 350;

const OPTIONS = {
  /**
   * 직군은 점수에 전혀 관여하지 않는다 — 모델에 넘기는 맥락과 영수증·기록
   * 표시에만 쓰인다(점수를 움직이는 건 counterpart 뿐이다. score.js 참고).
   * 그래서 선택지를 늘려도 판정 회귀 위험이 없다.
   *
   * 예전 4종(기획·개발·디자인·비즈니스)은 IT/스타트업 직군 세트라, 영업·
   * 인사·회계·상담·의료·교육 종사자는 첫 화면에서 자기 직군을 못 찾았다.
   * 기능이 아니라 "이건 내 도구가 아니다"라는 배제 신호가 문제였다.
   * 한국 직장인 전반을 덮도록 넓히되, 칩이 너무 잘게 쪼개지지 않게 묶었다.
   */
  job: ['기획·PM/PO', '개발(Dev)', '디자인', '마케팅·영업', '경영지원', '고객·CS', '전문직', '기타'],
  /**
   * 연차 구간은 **원티드 채용 필터와 같은 눈금**을 쓴다(신입 / 1~10년 / 10년+).
   * 예전 3종(주니어·시니어·리드)은 구간이 넓어 1년차와 3년차가 같은 칸에
   * 들어갔고, 무엇보다 직책(리드·팀장)과 연차가 한 축에 섞여 있었다.
   * 원티드 눈금을 따르면 결과 화면의 채용 공고 링크에 years 파라미터를
   * 그대로 넘길 수 있다(WANTED_YEARS 참고) — 화면의 선택과 링크가 어긋나지
   * 않는다. 점수에는 관여하지 않는 표시·맥락 전용 값이라 넓혀도 회귀 없음.
   */
  level: ['신입 (1년 미만)', '1~3년', '4~6년', '7~9년', '10년 이상'],
  /**
   * 예전 4종(직속상사·타부서 동료·팀원(AI복붙)·클라이언트)에서 "팀원(AI복붙)"은
   * 관계가 아니라 증상이었다 — 다른 세 값은 전부 "누구와의 관계"인데 이것만
   * "어떤 문제가 있는 팀원"이라 범주가 달랐다. 게다가 AI 슬롭 판정(aiSlopScore)
   * 은 메시지 내용 자체에서 나오는 신호라 이 관계를 고르지 않아도 이미
   * 정확히 잡힌다(score.js·cliche.js) — 관계 선택지로 존재할 이유가 없었다.
   *
   * 대신 실제 직장에서 자주 부딪히는 관계 축(직급 상하·같은 급·외부인)을
   * 넓혔다. 순서는 첫 화면 기본값이 바뀌지 않도록 '직속상사'를 그대로
   * 맨 앞에 둔다.
   */
  counterpart: ['직속상사', '임원', '선배', '후배', '동기', '타부서 동료', '클라이언트', '민원인'],
  goal: ['🛑 칼차단', '⏳ 시간벌기', '🏓 공넘기기', '🕊️ 관계보존'],
  tone: ['🟢 순한맛', '🟡 보통맛', '🔴 매운맛'],
};

/**
 * 목적·말투를 고르면 답장이 어떻게 달라지는지 한 줄로 알려준다.
 *
 * 예전에는 "칼차단 / 시간벌기 / 공넘기기 / 관계보존" 이름만 있고 결과를
 * 가늠할 단서가 없어서, 12가지 조합 중 뭘 골라야 하는지 찍어야 했다.
 * 모델에 보내는 지시문(api/_lib/prompt.js 의 GOAL_RULES·TONE_RULES)은
 * 이미 같은 내용을 담고 있지만 그건 "모델에게 시키는 명령문"이라 사용자가
 * 읽을 문장이 아니다 — 같은 규칙을 사용자 입장("내 답장이 어떻게 되나")
 * 으로 다시 쓴 것이 아래 문구다. 둘 중 하나를 고치면 다른 쪽도 맞출 것.
 */
const GOAL_NOTE = {
  '칼차단': '수용할 수 없다는 걸 분명히 합니다.\n대안은 하나만 남기고, 일정 재협상 여지는 두지 않습니다.',
  '시간벌기': '즉답을 피하고 판단에 필요한 정보를 먼저 요구합니다.\n회신 시점을 내가 정합니다.',
  '공넘기기': '선행 조건과 책임 소재를 짚어 공을 상대에게 돌려보냅니다.\n내가 먼저 착수하지 않습니다.',
  '관계보존': '요구는 받되 범위와 기한을 좁혀 다시 정의합니다.\n관계 비용을 가장 적게 씁니다.',
};
const TONE_NOTE = {
  '순한맛': '쿠션어를 문장마다 넣고, 거절도 제안 형태로 바꿉니다.\n상대 체면을 먼저 세웁니다.',
  '보통맛': '사실과 일정 중심의 표준 업무 어조입니다.\n감정 표현 없이 담백하게 씁니다.',
  '매운맛': '완곡어를 걷어내고 모호한 부분을 직접 지적합니다.\n범위·기한·담당을 명시적으로 요구합니다.',
};

/**
 * 입력칸 예시 문구 — 고른 관계에 따라 바뀐다.
 *
 * 예전에는 두 칸 모두 고정 문구였다. 위에서 "클라이언트"를 골라도 입력칸은
 * 여전히 일반론("카카오톡 메시지, 이메일, 회의 대화록 등…")을 보여줘서,
 * 무엇을 넣으라는 건지 감이 오지 않았다. 관계마다 실제로 듣는 말투가
 * 다르므로 예시도 그에 맞춰 바뀌어야 한다.
 *
 * 개인정보가 전송 전에 가려진다는 안내는 여기서 뺐다 — 바로 위 "전송 전
 * 자동 가림" 배지와 아래 "전송될 내용 확인하기"가 이미 같은 말을 하고
 * 있어서, 예시 자리를 세 번째 사본으로 쓰는 건 낭비였다.
 */
/**
 * 관계를 아직 고르지 않았을 때. 고르면 그 관계의 예시로 바뀐다.
 *
 * 예전에는 8종 모두 "상대방이 보낸 내용을 그대로 붙여넣으세요."로 **똑같이
 * 시작**하고 변하는 예시는 빈 줄 아래에 있었다. 그래서 관계를 바꿔도 첫
 * 줄만 눈에 들어와 "고정 문구"로 읽혔다. 안내 문장은 여기(미선택 상태)와
 * 입력칸 아래 힌트가 이미 하고 있으므로, 관계를 고른 뒤에는 **예시만**
 * 남겨 변화가 바로 보이게 한다.
 */
const MESSAGE_PLACEHOLDER_EMPTY = '상대방이 보낸 내용을 그대로 붙여넣으세요.\n\n위에서 상대방과의 관계를 고르면 그 관계에서 흔한 예시를 보여드려요.';

const MESSAGE_PLACEHOLDER = {
  '직속상사': '예) 주말에 미안한데, 월요일 오전 보고 전까지 한 번만 봐주면 좋을 것 같아요. 급한 건 아닙니다!',
  '임원': '예) 이번 건 대표님도 보고 계시니까, 오늘 중으로 결과 한번 보여주시죠.',
  '선배': '예) 후배야 미안한데 이것도 좀 봐줄 수 있어? 다들 바빠서 그런데 편할 때 확인 부탁해~',
  '후배': '예) 선배님 저 이거 도저히 모르겠어서요… 내일까지 드려야 하는데 대신 좀 봐주시면 안 될까요?ㅠㅠ',
  '동기': '예) 검토해봤는데 전반적으로 좋아 보여요. 추가적으로 논의하면서 진행하시죠!',
  '타부서 동료': '예) 이 건은 저희 쪽 R&R은 아닌 것 같은데요, 먼저 정리해서 공유해주실 수 있을까요?',
  '클라이언트': '예) 이거 처음 얘기했던 거랑 좀 다른데요? 내일까지 다시 작업해서 보내주세요.',
  '민원인': '예) 지금 몇 시간째 기다리는 줄 아세요? 오늘 중으로 처리 안 되면 책임자 나오라고 하세요.',
};

/** 숨은 속사정도 관계에 따라 쓸 만한 카드가 다르다. */
const HIDDEN_CONTEXT_PLACEHOLDER = {
  '직속상사': '예) 주말엔 가족 행사로 외지에 있음',
  '임원': '예) 이미 다른 임원 지시로 우선순위가 밀려 있음',
  '선배': '예) 이 건은 예전에 한 번 처리해준 적 있음',
  '후배': '예) 이 업무는 후배 본인 담당으로 배정된 지 얼마 안 됨',
  '동기': '예) 같은 피드백을 이미 두 번 줬음',
  '타부서 동료': '예) 우리 팀 스프린트 마감이 같은 날임',
  '클라이언트': '예) 계약서상 수정은 2회까지',
  '민원인': '예) 사내 응대 매뉴얼상 환불 기준을 벗어남',
};

/** 화면 표기 → API 계약값 */
/**
 * 화면 표기 → API 계약값. 지금은 이모지만 떼면 되는 값뿐이라 비어 있다
 * (연차는 '1~3년'처럼 표기 그대로 보낸다). strip() 이 기본 처리를 한다.
 */
const VALUE_OF = {};
const strip = (s) => s.replace(/^[^\p{L}\p{N}]+/u, '').trim();
const apiValue = (raw) => VALUE_OF[raw] || strip(raw);


/**
 * 선택값은 **아무것도 미리 고르지 않은 상태**로 시작한다.
 *
 * 예전에는 각 항목의 첫 값이 선택돼 있었다. 화면이 채워져 보이는 대신,
 * 사용자가 고른 값과 그냥 기본값으로 남은 값을 구분할 수 없었다. 특히
 * counterpart 는 **점수에 직접 관여하는 유일한 컨텍스트**(POWER_BY_COUNTERPART)
 * 라, 고르지도 않은 '직속상사'로 권력 비대칭 4점이 잡히는 건 사실과 다른
 * 판정이다. 비워 두고 사용자가 고르게 한다.
 *
 * 직군·연차는 지난 방문 값이 있으면 그것만 복원한다(내 정보는 안 바뀐다).
 */
const state = {
  job: '',
  level: '',
  counterpart: '',
  goal: '',
  tone: '',
  ...loadPrefs(OPTIONS),
};

/** 세션 메모리 토큰 맵 — localStorage 금지, 서버 전송 금지 */
let sessionTokenMap = Object.create(null);

/**
 * 기록에서 되살린 화면인지.
 *
 * 되살린 결과에는 이 세션의 토큰 맵이 없다(저장하지 않으니까). unmask 는
 * 맵에 없는 토큰을 그대로 두므로, 그냥 두면 답장에 "{{PERSON_1}}님"이 날것으로
 * 찍힌다. 저장 시점에 실명을 되돌려 넣는 건 기록이 실명을 갖게 되는 일이라
 * 하지 않는다 — 대신 보여줄 때 중립 표기로 바꾼다.
 */
let restoredView = false;

const TOKEN_LABEL = {
  PERSON: '○○', ORG: '○○사', PROJECT: '○○ 건',
  PHONE: '연락처', EMAIL: '메일 주소', AMOUNT: '금액', ACCOUNT: '계좌', LITERAL: '○○',
};

/** 화면에 내보낼 문자열 — 평소엔 토큰을 실명으로 되돌리고, 복원 화면에선 중립 표기로 바꾼다. */
function showText(text) {
  if (!restoredView) return unmask(text, sessionTokenMap);
  return String(text ?? '').replace(/\{\{([A-Z]+)_\d+\}\}/g, (_, kind) => TOKEN_LABEL[kind] || '○○');
}
let cooldownUntil = 0;
let busy = false;
let suggestTimer = null;

const $ = (id) => document.getElementById(id);
const el = {
  presetGrid: $('preset-grid'),
  presetHint: $('preset-hint'),
  presetToggle: $('preset-toggle'),
  presetRun: $('preset-run'),
  message: $('message'),
  charCount: $('char-count'),
  hiddenContext: $('hidden-context'),
  toneWarning: $('tone-warning'),
  goalNote: $('goal-note'),
  care: $('care'),
  careTitle: $('care-title'),
  careBody: $('care-body'),
  careWanted: $('care-wanted'),
  careWantedText: document.querySelector('#care-wanted .care-link-text'),
  toneNote: $('tone-note'),
  togglePreview: $('toggle-preview'),
  maskPreview: $('mask-preview'),
  maskPreviewBody: $('mask-preview-body'),
  maskSummary: $('mask-summary'),
  threadWarning: $('thread-warning'),
  run: $('run'),
  runHint: $('run-hint'),
  standby: $('standby'),
  progress: $('progress'),
  standbyTitle: $('standby-title'),
  intro: $('intro'),
  introSlides: $('intro-slides'),
  introProgress: $('intro-progress'),
  introSkip: $('intro-skip'),
  introBack: $('intro-back'),
  introNext: $('intro-next'),
  introReplay: $('intro-replay'),
  result: $('result'),
  errorBox: $('error-box'),
  busyNote: $('busy-note'),
  feedbackForm: $('feedback-form'),
  feedbackModal: $('feedback-modal'),
  feedbackBackdrop: $('feedback-backdrop'),
  feedbackOpen: $('feedback-open'),
  feedbackClose: $('feedback-close'),
  toTop: $('to-top'),
  feedbackFloat: $('feedback-float'),
  fbMessage: $('fb-message'),
  fbContact: $('fb-contact'),
  fbUpdates: $('fb-updates'),
  fbSubmit: $('fb-submit'),
  fbStatus: $('fb-status'),
  busyNoteBody: $('busy-note-body'),
  restoredNote: $('restored-note'),
  restoredNoteBody: $('restored-note-body'),
  restoredExit: $('restored-exit'),
  installBanner: $('install-banner'),
  installBannerTitle: $('install-banner-title'),
  installBannerSub: $('install-banner-sub'),
  installAccept: $('install-accept'),
  installDismiss: $('install-dismiss'),
  installOpen: $('install-open'),
  receiptWantedLink: $('receipt-wanted-link'),
  receiptWantedText: $('receipt-wanted-text'),
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
  rcJob: $('rc-job'),
  rcVillain: $('rc-villain'),
  rcHook: $('rc-hook'),
  rcBar: $('rc-bar'),
  rcScore: $('rc-score'),
  rcScoreLabel: $('rc-score-label'),
  rcMode: $('rc-mode'),
  rcCount: $('rc-count'),
  historyOpen: $('history-open'),
  historyBadge: $('history-badge'),
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

/* ── 다 고른 영역은 접는다 ─────────────────────────────

   입력 폼이 세로로 길다. 칩 그리드만 네 벌(직군 9 · 연차 5 · 관계 9 ·
   대응 방향 4 · 말투 3)이라, 다 고르고 나서도 그 자리가 그대로 남아 있으면
   "내가 지금 뭘 하고 있는 거지"가 된다. 고른 값은 이미 정해진 것이라 계속
   펼쳐 둘 이유가 없다.

   그래서 **한 블록의 항목을 다 고르면 그 블록을 한 줄 요약으로 접는다.**
   줄이는 건 선택지가 아니라 이미 끝난 일이 차지하는 자리다.

   접는 단위를 블록으로 잡은 이유가 있다. 구역(zone) 단위로 접으면 2구역이
   통째로 사라지는데, 거기엔 메시지 입력칸이 들어 있다. 반대로 셀렉터 하나
   단위로 접으면 "내 직군"과 "내 연차"가 따로 접혔다 펴져 산만하다. 블록은
   화면에서 한 덩어리로 읽히는 단위라 여기가 맞다.

   입력칸(textarea·input)이 있는 블록은 접지 않는다 — 메시지와 속사정은
   "고르는" 값이 아니라 쓰는 값이고, 접으면 쓰던 글이 숨는다.
*/
let foldables = [];

function initFolding() {
  foldables = [...document.querySelectorAll('.zone .block')]
    .filter((b) => b.querySelector('.selector[data-field]') && !b.querySelector('textarea, input'))
    .map((block) => {
      const fields = [...block.querySelectorAll('.selector[data-field]')].map((sel) => sel.dataset.field);
      // 접힌 줄에 쓸 제목: 블록 제목이 있으면 그것, 없으면 각 셀렉터의 라벨.
      const title =
        block.querySelector('.block-title')?.childNodes[0]?.textContent.trim() ||
        [...block.querySelectorAll('.selector-label')].map((n) => n.textContent.trim()).join(' · ');

      const summary = document.createElement('button');
      summary.type = 'button';
      summary.className = 'block-folded';
      summary.hidden = true;
      summary.addEventListener('click', () => unfold(block));
      block.prepend(summary);

      return { block, fields, title, summary, pinned: false };
    });
}

/** 사용자가 직접 펼친 블록은 다시 채워져도 자동으로 접지 않는다. */
function unfold(block) {
  const f = foldables.find((x) => x.block === block);
  if (!f) return;
  f.pinned = true;
  f.block.classList.remove('is-folded');
  f.summary.hidden = true;
  f.block.querySelector('.chip')?.focus({ preventScroll: true });
}

function syncFolding() {
  for (const f of foldables) {
    const done = f.fields.every((k) => state[k]);
    // 다 고르지 못한 상태로 돌아오면 다시 접을 수 있게 고정을 푼다.
    if (!done) f.pinned = false;
    const fold = done && !f.pinned;
    f.block.classList.toggle('is-folded', fold);
    f.summary.hidden = !fold;
    if (fold) {
      f.summary.innerHTML = `<span class="block-folded-title">${escapeHtml(f.title)}</span>`
        + `<span class="block-folded-value">${escapeHtml(f.fields.map((k) => strip(state[k])).join(' · '))}</span>`
        + '<span class="block-folded-edit" aria-hidden="true">변경</span>';
      f.summary.setAttribute('aria-label', `${f.title}: ${f.fields.map((k) => strip(state[k])).join(', ')}. 눌러서 다시 고르기`);
    }
  }
}

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
        if (field === 'counterpart') {
          // 관계가 바뀌면 이전에 고른 예시 카드는 더 이상 맞지 않는다.
          // 선택을 풀어야 예시 문구도 새 관계 기준으로 돌아간다.
          clearPresetSelection();
          presetsExpanded = false; // 관계를 다시 고르면 필터도 그 관계로 리셋한다
          updateSituationSuggestion();
          applyPresetFilter();
          updatePlaceholders();
        }
        if (field === 'goal' || field === 'tone') updateChoiceNotes();
        renderStepBars();
        syncFolding();
        savePrefs(state);
        resetResult();
      });
      box.appendChild(btn);
    }
  });
}

/**
 * 고른 관계에 맞춰 두 입력칸의 예시 문구를 갈아끼운다.
 * 예시 카드를 눌러 미리보기가 떠 있는 동안에는 메시지 칸을 건드리지 않는다.
 */
function updatePlaceholders() {
  const who = apiValue(state.counterpart);
  el.hiddenContext.placeholder = HIDDEN_CONTEXT_PLACEHOLDER[who] || '예) 이 건을 거절하기 어려운 사정이 따로 있다면 적어주세요';
  if (activePreset) return;
  // 관계 미선택이면 빈 칸이 아니라 "고르면 예시가 나온다"를 알린다.
  el.message.placeholder = MESSAGE_PLACEHOLDER[who] || MESSAGE_PLACEHOLDER_EMPTY;
}

/** 지금 고른 목적·말투가 답장을 어떻게 바꾸는지 칩 아래에 적어둔다. */
function updateChoiceNotes() {
  // 고르기 전에는 빈 줄 대신 무엇을 고르는 자리인지 알려 준다.
  el.goalNote.textContent = GOAL_NOTE[apiValue(state.goal)] || '고르면 답장이 어떤 방향으로 쓰일지 여기에 설명이 나옵니다.';
  el.toneNote.textContent = TONE_NOTE[apiValue(state.tone)] || '고르면 말투가 어떻게 달라질지 여기에 설명이 나옵니다.';
}

/** id → 카드 버튼. 입력 내용 기반 추천 표시(updateSituationSuggestion)에 쓴다. */
const presetButtons = new Map();

/** "다른 상황도 보기" 를 눌러 전체 목록을 펼친 상태인가. 관계를 바꾸면 다시 접는다. */
let presetsExpanded = false;

/** 마지막으로 누른 예시 카드 — "예시 그대로 결과 보기" 가 이 값을 쓴다. */
let activePreset = null;

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
  applyPresetFilter();
}

/**
 * 같은 상황이라도 **누가 보냈는지**에 따라 문장이 달라진다.
 *
 * 예전에는 카드 하나에 text 가 하나뿐이라, fits 에 묶인 관계 2~3종이 전부
 * 똑같은 문구를 봤다. "주말 업무 요청"을 임원으로 고르든 선배로 고르든
 * "대표님 보고가 잡혀서요"가 나오는 식인데, 선배가 그렇게 말하지는 않는다.
 * 예시가 자기 상황처럼 읽히지 않으면 카드를 눌러 볼 이유도 사라진다.
 *
 * byCounterpart 에 해당 관계의 변형이 있으면 그걸 쓰고, 없으면 기본 text 를
 * 쓴다. 관계를 아직 고르지 않았을 때도 기본 text 다 — 빈 값으로 조회하면
 * 어차피 없다.
 *
 * 변형 문구는 **골든 캐시(matchPresetId)와 일부러 어긋나게 둔다.** 캐시는
 * golden.json 의 원문과 정확히 일치할 때만 맞고, 변형을 고른 사용자는 그냥
 * 정상 분석 경로로 간다. 변형마다 골든 픽스처를 새로 뜨는 비용을 지우기
 * 위한 선택이다.
 */
function presetText(preset, who = apiValue(state.counterpart)) {
  return preset?.byCounterpart?.[who] || preset?.text || '';
}

/**
 * 고른 관계에 맞는 예시만 남기고 나머지는 숨긴다.
 *
 * 예전엔 CSS order 로 "정렬"만 했다 — 카드 10장이 관계와 무관하게 항상
 * 전부 보였고, 관계당 매칭 카드가 1장뿐인 경우(8종 중 6종)엔 순서가
 * 거의 안 바뀌어서 힌트 문구("OO 관련 상황을 먼저 보여드려요")가 과장한
 * 약속처럼 느껴졌다. fits 를 배열로 바꾸고(관계당 2~4장으로 늘어남),
 * 정렬 대신 실제로 안 맞는 카드를 hidden 처리한다.
 *
 * "다른 상황도 보기"로 언제든 전체를 펼칠 수 있다 — 관계 선택이 완벽하지
 * 않을 수 있으니 숨긴 카드를 아예 못 보게 막지는 않는다.
 */
function applyPresetFilter() {
  const who = apiValue(state.counterpart);
  // 관계를 아직 고르지 않았으면 거를 기준이 없다. 전부 보여준다 —
  // 여기서 fits 로 거르면 매칭 0건이라 빈 목록이 뜬다.
  if (!who) {
    for (const p of PRESETS) {
      const btn = presetButtons.get(p.id);
      if (btn) btn.hidden = false;
    }
    el.presetHint.textContent = '상황 10가지';
    el.presetToggle.hidden = true;
    return;
  }

  const matches = PRESETS.filter((p) => p.fits.includes(who));
  const hiddenCount = PRESETS.length - matches.length;

  for (const p of PRESETS) {
    const btn = presetButtons.get(p.id);
    if (!btn) continue;
    const show = presetsExpanded || matches.includes(p);
    btn.hidden = !show;
  }

  el.presetHint.textContent = presetsExpanded
    ? '전체 상황 보기'
    : `${who} 관련 상황 ${matches.length}가지`;

  el.presetToggle.hidden = hiddenCount === 0;
  el.presetToggle.textContent = presetsExpanded
    ? '관련 상황만 보기'
    : `다른 상황도 보기 (+${hiddenCount})`;
}

/**
 * ③ 입력창에 실제로 타이핑된(마스킹 전, 로컬 판단용) 내용을 규칙 기반으로
 * 분석해 ②의 카드 중 하나에 "추천" 표시만 얹는다. 값을 채우거나 강제로
 * 선택하지 않는다 — 사용자가 이미 손에 든 메시지를 붙여넣는 흐름에 맞춰,
 * 카드를 먼저 고르지 않아도 자연스럽게 비슷한 상황을 알아볼 수 있게 하는
 * 힌트일 뿐이다.
 *
 * 텍스트로 찾은 카드가 지금 관계 필터에 가려져 있으면 필터를 펼친다 —
 * "내용을 보니 이거다"가 "관계로 짐작한 목록"보다 더 확실한 신호라서다.
 */
function updateSituationSuggestion() {
  const text = el.message.value;
  const matchedId = text.trim().length >= SUGGEST_MIN_CHARS
    ? matchSituationId(text, apiValue(state.counterpart))
    : null;
  if (matchedId && !presetsExpanded) {
    const btn = presetButtons.get(matchedId);
    if (btn?.hidden) {
      presetsExpanded = true;
      applyPresetFilter();
    }
  }
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
 * 더 가깝다. ① 내 상황·④ 숨은 속사정·⑤ 방어 목적·⑥ 말투 세기는
 * 여전히 손대지 않는다(이전 수정 그대로).
 */
/** 예시 카드 선택을 푼다 — 관계가 바뀌면 이전 카드는 더 이상 맞지 않는다. */
function clearPresetSelection() {
  if (!activePreset) return;
  activePreset = null;
  el.presetGrid.querySelectorAll('.preset').forEach((b) => {
    b.classList.remove('selected');
    b.setAttribute('aria-pressed', 'false');
  });
  el.presetRun.hidden = true;
}

/**
 * 입력칸의 내용이 **예시를 그대로 적용한 것**인지 판별한다.
 *
 * 카드를 바꿨을 때 이전 예시 문장이 그대로 남아 있으면, 화면의 선택(새 카드)과
 * 입력칸의 내용(옛 카드)이 어긋난다. 그렇다고 무조건 비우면 직접 쓰던 글을
 * 말없이 지우게 된다. 그래서 "예시에서 온 문장일 때만" 비운다.
 *
 * 어느 관계 변형에서 왔는지 모르므로 모든 변형과 대조한다.
 */
function isPresetText(value) {
  const v = String(value || '').trim();
  if (!v) return false;
  return PRESETS.some((p) => [p.text, ...Object.values(p.byCounterpart || {})].some((t) => t.trim() === v));
}

function applyPreset(p, btn) {
  el.presetGrid.querySelectorAll('.preset').forEach((b) => {
    b.classList.toggle('selected', b === btn);
    b.setAttribute('aria-pressed', String(b === btn));
  });

  el.message.placeholder = presetText(p);

  // 다른 카드로 옮겼는데 입력칸에 옛 예시가 남아 있으면 선택과 내용이 어긋난다.
  // 예시에서 온 문장일 때만 비우고, 직접 쓴 글은 건드리지 않는다.
  if (isPresetText(el.message.value)) {
    el.message.value = '';
    onInput();
  }

  // 스크롤을 옮기지 않는다. 카드를 훑어보는 중인 사람을 입력칸으로 끌어내리면
  // 다음 카드를 보려고 다시 올라와야 한다. 카드를 눌렀을 때 실제로 바뀌는 건
  // 아래 안내 문구와 적용 버튼이고, 둘 다 카드 바로 밑에 있다.
  el.message.classList.remove('just-filled');
  // 리플로우를 강제해 같은 카드를 연속 클릭해도 애니메이션이 다시 재생되게 한다.
  void el.message.offsetWidth;
  el.message.classList.add('just-filled');
  setHint('예시를 참고해 실제 내용을 입력한 뒤 실행 버튼을 눌러주세요.');

  activePreset = p;
  el.presetRun.hidden = false;
  el.presetRun.textContent = `“${p.label}” 예시 메시지 그대로 적용하기`;
}

/**
 * 고른 예시의 메시지를 입력칸에 그대로 채운다.
 *
 * 카드를 눌러도 placeholder 만 바뀌기 때문에, 결과 화면이 어떻게 생겼는지
 * 보려면 반드시 진짜 직장 메시지를 붙여넣어야 했다. 심리적 비용이 큰
 * 행동인데 대가가 뭔지 모르는 채로 먼저 치르라는 구조였다.
 *
 * 채우는 건 **메시지 하나뿐**이다. 예전에는 골든 맥락(직군·연차·관계·
 * 목적·말투·숨은 속사정)까지 맞추고 곧바로 분석까지 돌렸는데, 폼 중간에
 * 있는 버튼이 갑자기 최종 결과를 띄우는 흐름이 어색했고 사용자가 고른
 * 값을 말없이 덮어쓰기도 했다. 이제는 메시지만 채우고, 나머지 선택과
 * 실행은 사용자 몫으로 남긴다 — 3구역 답장 설정을 거쳐 4구역 실행
 * 버튼을 누르는 원래 흐름이 그대로 유지된다.
 */
function applyPresetMessage() {
  const p = activePreset;
  if (!p || busy) return;

  el.message.value = presetText(p);
  onInput();

  el.message.focus({ preventScroll: true });
  el.message.scrollIntoView({ behavior: 'smooth', block: 'center' });
  // 안내 문구는 띄우지 않는다 — 입력칸이 예시 문장으로 채워지고 그 자리로
  // 스크롤까지 되므로 무슨 일이 일어났는지 이미 보인다. 실행 버튼 아래에
  // 한 줄을 더 얹으면 설명만 늘어난다.
  setHint('');
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

/**
 * 구역별 진행 바.
 *
 * 기본 선택을 없앤 뒤로는 "고른 값이 있는가"가 곧 진행률이다(예전에는 칩이
 * 항상 하나 선택돼 있어 처음부터 100% 였고, 그래서 '손댔는지'를 따로
 * 추적해야 했다).
 *
 * 2·4구역은 메시지 입력까지 함께 본다 — 메시지가 없으면 분석 자체가 안 된다.
 */
function zoneProgress() {
  const hasMessage = el.message.value.trim().length > 0;
  const count = (...fields) => fields.filter((f) => state[f]).length;
  return {
    me: count('job', 'level') / 2,
    them: (count('counterpart') + (hasMessage ? 1 : 0)) / 2,
    reply: count('goal', 'tone') / 2,
    // 실행 조건은 메시지와 관계 두 가지다(관계는 점수를 움직이므로 필수).
    run: ((hasMessage ? 1 : 0) + (state.counterpart ? 1 : 0)) / 2,
  };
}

function renderStepBars() {
  const progress = zoneProgress();
  for (const node of document.querySelectorAll('.step-divider[data-step]')) {
    const value = progress[node.dataset.step] ?? 0;
    node.querySelector('.step-bar i').style.width = `${Math.round(value * 100)}%`;
    node.classList.toggle('is-done', value >= 1);
  }
}

function onInput() {
  const len = el.message.value.length;
  el.charCount.textContent = String(len);
  const counter = el.charCount.parentElement;
  counter.classList.toggle('warn', len > MAX_CHARS * 0.9 && len <= MAX_CHARS);
  counter.classList.toggle('over', len > MAX_CHARS);
  el.threadWarning.hidden = !looksLikeMultiTurnThread(el.message.value);
  renderStepBars();
  resetResult();
  if (!el.maskPreview.hidden) updateMaskPreview();
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(updateSituationSuggestion, SUGGEST_DEBOUNCE_MS);
}

function updateMaskPreview() {
  // ④ 나의 숨은 속사정도 자유 입력 필드라서 여기 실명·연락처를 적으면
  // 마스킹 우회 경로가 된다 — 메시지와 함께 마스킹해 실제 전송본을 그대로 보여준다.
  const { maskedMessage, maskedHiddenContext, counts } = maskFields(el.message.value, el.hiddenContext.value.trim());
  const parts = [maskedMessage || '(입력 없음)'];
  if (maskedHiddenContext) parts.push(`\n[나의 숨은 속사정]\n${maskedHiddenContext}`);
  el.maskPreviewBody.textContent = parts.join('');
  el.maskSummary.textContent = summarizeMask(counts);
}

/* ── 실행 ───────────────────────────── */

/**
 * 서버로 보낼 컨텍스트.
 *
 * 고르지 않은 값은 빈 문자열로 간다. 서버(prompt.js)·MOCK(mock.js) 모두
 * `context.x || 기본값` 으로 받고 있어 그대로 동작한다. counterpart 만은
 * 실행 전에 선택을 강제하므로 여기까지 빈 값으로 오지 않는다.
 */
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
  // counterpart 는 점수를 움직이는 유일한 컨텍스트라 비어 있으면 임의값으로
  // 채우지 않고 물어본다. 나머지는 없어도 판정이 달라지지 않는다.
  if (!state.counterpart) {
    showError('상대방과의 관계를 먼저 골라 주세요. 이 선택이 위험 지수의 권력 비대칭을 결정합니다.');
    document.querySelector('.selector[data-field="counterpart"]')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
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
  // 마스킹은 위에서 이미 끝났다 — 사용자에겐 그 사실 자체가 정보라 한 박자 보여준다.
  setProgress('mask');
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
      result.meta.note = '캐시된 프리셋. API 호출 없음, 비용 $0';
    } else {
      setProgress('analyze');
      const payload = { maskedText: maskedMessage, context: { ...context, hiddenContext: maskedHiddenContext } };
      try {
        result = await postAnalyze(payload);
      } catch (err) {
        // 시연 안전장치: 서버리스 함수가 없거나(vite 단독 실행) 실패하면 로컬 룰엔진으로 폴백한다.
        if (err.recoverable) {
          result = localFallback(payload, startedAt);
          result.meta.note = err.message;
          if (err.busySec) result.meta.busySec = err.busySec;
        } else {
          throw err;
        }
      }
    }
    setProgress('reply');
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
    // 429 는 실패가 아니라 "줄을 섰다"는 뜻이다. 제출 후 공개되면 무료 티어
    // 한도(서비스 전체 분당 ~3건)에 자주 걸리는데, 그때 화면이 에러로 끝나면
    // 처음 온 사람은 고장난 서비스로 읽는다. 로컬 룰엔진으로 결과는 그대로
    // 내주고, 왜 AI 분석이 빠졌는지와 언제 다시 오면 되는지를 함께 알린다.
    if (res.status === 429) {
      const sec = Number(body?.error?.retryAfterSec) || Number(res.headers.get('Retry-After')) || 60;
      const e = recoverable(message);
      e.busySec = sec;
      throw e;
    }
    // 400대(EMPTY_INPUT·TOO_LONG·RAW_PII_DETECTED)는 사용자가 고칠 수 있는 문제라
    // 메시지를 그대로 보여준다. 500대는 모델·인프라 쪽 실패이므로 화면을 비우지 않고
    // 로컬 룰엔진으로 넘긴다 — 코드가 늘어나도(MODEL_REFUSED, MODEL_OUTPUT_TRUNCATED 등)
    // 목록을 따라 고칠 필요가 없게 상태코드로 판단한다.
    if (res.status >= 500) throw recoverable('모델 호출이 실패해 로컬 룰엔진으로 분석했습니다.');
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

/**
 * 케어 안내 — 근로복지공단 EAP, 그리고 원티드.
 *
 * 이 두 가지는 지금까지 공유용 영수증 안에만 있었다. 영수증을 발급하지
 * 않은 사람은 끝까지 못 보는 구조였는데, 이 제품이 실제로 하려는 말
 * ("혼자 감당하지 마세요")이 거기 담겨 있다. 결과를 본 직후 자리로
 * 끌어올린다.
 *
 * 다만 문구는 위험도에 따라 다르게 간다. "정상 업무 신호"가 뜬 화면에
 * "힘든 날엔 혼자 참지 마세요"를 띄우면 앱이 상황을 과장하는 것으로
 * 읽히고, 그 순간 진단 자체의 신뢰가 깎인다.
 *
 * 이직 링크(원티드)는 경계·심각 구간에서만 붙인다. 순서도 항상 상담이
 * 먼저다 — 직장 문제를 먼저 "그만두라"로 받으면 조언이 아니라 떠밀기로
 * 들린다.
 */
/**
 * 연차 선택 → 원티드 채용 필터의 years 파라미터.
 *
 * 원티드는 years 를 **개별 연차마다 하나씩** 반복해 받는다
 * (예: 6~7년 = `years=6&years=7`). 신입은 0, 10년 이상은 10 하나로 묶인다.
 * OPTIONS.level 을 원티드와 같은 눈금으로 맞춰 둔 덕에 1:1 로 떨어진다.
 */
const WANTED_YEARS = {
  '신입 (1년 미만)': [0],
  '1~3년': [1, 2, 3],
  '4~6년': [4, 5, 6],
  '7~9년': [7, 8, 9],
  '10년 이상': [10],
};

/**
 * 내 정보(연차)에 맞춘 원티드 채용 공고 링크를 만든다.
 *
 * 직군까지 맞추려면 원티드의 직무 카테고리 ID(`/wdlist/<그룹>` 과 `selected`)가
 * 필요한데, 그 ID 는 원티드 페이지에서 확인해야만 알 수 있는 값이라 여기서
 * 임의로 채우지 않는다 — 틀린 ID 는 엉뚱한 직군 공고로 보내서 링크가 없는
 * 것보다 나쁘다. WANTED_JOB_GROUP 에 확인된 값이 채워지면 자동으로 직군
 * 필터까지 붙는다.
 */
const WANTED_JOB_GROUP = {
  // '개발(Dev)': { group: 518, selected: [] },   ← 확인 후 채울 자리
};

function wantedUrl(context) {
  const years = WANTED_YEARS[context?.level] || [];
  const params = new URLSearchParams({ country: 'kr', job_sort: 'job.latest_order', locations: 'all' });
  for (const y of years) params.append('years', String(y));

  const jobGroup = WANTED_JOB_GROUP[context?.job];
  for (const sel of jobGroup?.selected || []) params.append('selected', String(sel));

  const path = jobGroup ? `/wdlist/${jobGroup.group}` : '/wdlist';
  return `https://www.wanted.co.kr${path}?${params.toString()}`;
}

/**
 * 상단 버튼의 기록 개수 배지.
 *
 * 기록이 0건이면 배지를 숨긴다 — 첫 방문자에게 "0"을 보여줄 이유가 없고,
 * 쌓이기 시작하면 숫자 자체가 다시 들어올 이유가 된다.
 */
/**
 * 혼잡 안내 (무료 티어 한도).
 *
 * 한도는 서비스 전체 기준 분당 3건 남짓이라, 공개 직후에는 내 차례가 아니어도
 * 걸린다. 그래서 문구가 "당신이 너무 많이 눌렀다"로 읽히면 안 되고, 결과가
 * 없는 것처럼 보여서도 안 된다 — 규칙 엔진 결과는 이미 화면에 떠 있다.
 * 빠진 것(AI 분석)과 다시 올 시점만 정확히 말한다.
 */
function renderBusyNote(meta) {
  const sec = Number(meta?.busySec) || 0;
  el.busyNote.hidden = !sec;
  if (!sec) return;
  const wait = sec >= 60 ? `${Math.round(sec / 60)}분` : `${sec}초`;
  el.busyNoteBody.textContent =
    `지금은 AI 분석 대신 규칙 엔진으로 계산해서 알려드려요.\n`
    + `점수와 판정 근거는 그대로이고, 답장만 예시 문구입니다.\n`
    + `${wait} 뒤에 다시 실행하면 AI가 쓴 답장까지 받아볼 수 있어요.`;
}

function renderHistoryBadge() {
  const n = getHistory().length;
  el.historyBadge.hidden = n === 0;
  el.historyBadge.textContent = n > 99 ? '99+' : String(n);
}

function renderCare(risk, context) {
  const serious = risk.score > 40; // 주의 이상
  // 문구만 주지 말고 내 연차에 맞는 공고 목록으로 바로 보낸다.
  el.careWanted.href = wantedUrl(context);
  // 링크 안에 라벨 span 이 함께 있어서 통째로 갈아끼우면 구조가 날아간다.
  el.careWantedText.textContent = `${context?.level || ''} 경력으로 열려 있는 채용 보기`.trim();
  el.care.classList.toggle('care-serious', serious);
  el.careWanted.hidden = risk.score <= 60; // 경계·심각에서만

  if (serious) {
    el.careTitle.textContent = '혼자 참지 않아도 됩니다';
    el.careBody.textContent =
      '이런 신호가 반복되면 기록으로 남겨 두세요.\n사내 고충처리나 외부 상담을 이용할 때 근거가 됩니다. '
      + "'나의 방어 기록'에 이 브라우저에만 남습니다.";
  } else {
    el.careTitle.textContent = '이번 건은 정상 범위입니다';
    el.careBody.textContent =
      "같은 상대와의 기록이 쌓이면 흐름이 보입니다. '나의 방어 기록'에서 확인해 보세요.\n"
      + '혼자 감당하기 어려운 일이 생기면 아래 상담도 무료로 이용할 수 있습니다.';
  }
}

/* ── 의견 보내기 ───────────────────────────── */

/**
 * 사용자 의견을 /api/feedback 으로 보낸다.
 *
 * **분석 상태는 아무것도 싣지 않는다.** 메시지 원문·점수·컨텍스트·토큰 맵은
 * 이 요청에 들어가지 않고, 사용자가 이 폼에 직접 쓴 글만 간다. "원문은
 * 서버에 저장되지 않는다"는 약속이 의견 폼 때문에 깨지면 안 된다.
 *
 * 서버가 없는 환경(vite 단독 실행)에서는 404/405 가 온다. 그때 "실패"라고만
 * 하면 쓴 글이 사라진 것처럼 보이므로, 입력은 남겨 두고 상태만 알린다.
 */
async function sendFeedback(e) {
  e.preventDefault();
  const message = el.fbMessage.value.trim();
  if (!message) {
    setFeedbackStatus('의견을 입력해 주세요.', 'is-error');
    el.fbMessage.focus();
    return;
  }

  el.fbSubmit.disabled = true;
  el.fbSubmit.textContent = '보내는 중…';
  setFeedbackStatus('');

  try {
    const res = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        contact: el.fbContact.value.trim(),
        wantsUpdates: el.fbUpdates.checked,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error?.message || '의견을 보내지 못했습니다. 잠시 후 다시 시도해 주세요.');
    }
    // 성공했을 때만 비운다 — 실패했는데 지워버리면 쓴 글이 날아간다.
    el.feedbackForm.reset();
    setFeedbackStatus('보내주셔서 고맙습니다. 읽고 반영하겠습니다.', 'is-ok');
    // 바로 닫으면 보냈는지 확인할 틈이 없다. 감사 문구를 읽을 만큼만 두고 닫는다.
    setTimeout(() => {
      if (!el.feedbackModal.hidden) closeFeedbackModal();
    }, 1600);
  } catch (err) {
    setFeedbackStatus(err.message || '의견을 보내지 못했습니다.', 'is-error');
  } finally {
    el.fbSubmit.disabled = false;
    el.fbSubmit.textContent = '의견 보내기';
  }
}

function openFeedbackModal() {
  el.feedbackModal.hidden = false;
  document.body.style.overflow = 'hidden';
  setFeedbackStatus('');
  el.fbMessage.focus();
}

function closeFeedbackModal() {
  el.feedbackModal.hidden = true;
  document.body.style.overflow = '';
  el.feedbackOpen.focus();
}

function setFeedbackStatus(text, cls = '') {
  el.fbStatus.className = `feedback-status ${cls}`.trim();
  el.fbStatus.textContent = text;
}

/* ── 첫 진입 스토리 ───────────────────────────── */

/**
 * 이 도구를 왜 만들었는지를 기능 설명이 아니라 장면으로 먼저 전한다.
 *
 * 처음 오는 사람에게 "AI는 추출하고 규칙이 판정한다"는 설계 원칙은 아무
 * 의미가 없다. 필요한 건 "내가 겪는 그 일이 맞다"는 확인이고, 그다음이
 * 도구다. 순서를 문제 → 고립 → 기술 → 행동으로 잡았고, 마지막 장이
 * 핵심이다 (진단 자체가 목적이 아니라 상담·이직 같은 실제 행동으로 가는
 * 근거라는 것).
 *
 * 1회만 자동으로 뜬다. 바로 쓰려는 사람을 막으면 안 되므로 건너뛰기를 항상
 * 열어 두고, 읽고 싶은 사람을 위해 '작동 방식' 섹션에 다시 보기를 둔다.
 * 저장하는 건 "봤다"는 사실뿐이라 prefs/history 와 같은 원칙을 지킨다.
 */
const INTRO_KEY = 'ofw_intro_seen_v1';
const introSlides = [...el.introSlides.querySelectorAll('.intro-slide')];
let introAt = 0;

function introSeen() {
  try {
    return globalThis.localStorage?.getItem(INTRO_KEY) === '1';
  } catch {
    return false; // 프라이빗 브라우징 등. 못 읽으면 그냥 보여준다.
  }
}

function markIntroSeen() {
  try {
    globalThis.localStorage?.setItem(INTRO_KEY, '1');
  } catch {
    // 저장 실패가 진입 자체를 막으면 안 된다.
  }
}

function renderIntro() {
  introSlides.forEach((node, i) => node.classList.toggle('is-active', i === introAt));
  el.introProgress.innerHTML = introSlides
    .map((_, i) => `<span class="${i <= introAt ? 'on' : ''}"></span>`)
    .join('');
  el.introBack.hidden = introAt === 0;
  const last = introAt === introSlides.length - 1;
  el.introNext.textContent = last ? '시작하기' : '다음';
  el.introSkip.hidden = last; // 마지막 장에서는 건너뛸 게 없다
}

function openIntro() {
  introAt = 0;
  renderIntro();
  el.intro.hidden = false;
  document.body.style.overflow = 'hidden';
  el.introNext.focus();
}

function closeIntro() {
  el.intro.hidden = true;
  document.body.style.overflow = '';
  markIntroSeen();
  // 스토리에 가려 밀어 뒀던 설치 제안이 있으면 이제 띄운다.
  flushPendingInstall();
}

function maybeShowIntro() {
  if (!introSeen()) openIntro();
}

function stepIntro(delta) {
  const next = introAt + delta;
  if (next >= introSlides.length) {
    closeIntro();
    return;
  }
  introAt = Math.max(0, next);
  renderIntro();
}

/* ── 렌더 ───────────────────────────── */

function render(result, elapsedMs, context, { restored = false, restoredAt = null } = {}) {
  const { xray, replies, risk, meta, usage } = result;

  restoredView = restored;

  // 영수증은 이 스냅샷(xray/risk/context)에서만 값을 읽는다 — 원문·마스킹 토큰과는 무관하다.
  lastReceiptSource = { xray, risk, context };
  // 되살린 결과를 기록에 다시 쌓으면 한 번 겪은 일이 볼 때마다 늘어난다.
  if (!restored) {
    addEntry(entryFromResult(xray, risk, context, { replies, mode: meta.mode }));
    renderHistoryBadge();
  }
  renderRestoredNote(restored, restoredAt);

  el.standby.hidden = true;
  el.result.hidden = false;

  el.xray.className = `xray level-${risk.level}`;
  el.alertHeader.textContent = risk.header;
  // 배지는 개발 모드가 아니라 "이 결과가 어떻게 나왔는지"를 알리는 사용자 문구다.
  // 예전엔 LIVE/MOCK/LOCAL 을 그대로 노출했는데, MOCK 은 정상 폴백인데도
  // "아직 안 만들어진 데모"로 읽히고 LIVE 는 생방송으로 읽힐 소지가 있었다.
  // 상세(모델명·비용·폴백 사유)는 title 툴팁에 그대로 남는다.
  el.modeBadge.textContent = MODE_BADGE[meta.mode] || meta.mode;
  el.modeBadge.title = meta.note || `model: ${meta.model}`;

  animateScore(risk.score);
  renderCare(risk, context);
  el.scoreLabel.textContent = risk.label;
  el.scoreAction.textContent = risk.action;
  el.scoreBarFill.style.width = `${risk.score}%`;
  el.subtext.textContent = showText(xray.subtext);

  renderBusyNote(meta);
  renderStats(xray);
  renderEvidence(xray, risk);
  renderReplies(replies);
  renderRepliesModeNote(meta.mode);

  // 모델명·지연시간·토큰 수는 화면에 띄우지 않는다.
  //
  // 예전에는 공유 CTA 아래에 "openai/gpt-oss-20b · 1908ms · in 2485 / out 630
  // tokens" 가 그대로 노출됐다. 개발자에겐 투명성이지만 일반 사용자에겐 읽을
  // 이유가 없는 문자열이고, 무엇보다 답장 품질에 대한 인상을 "작은 모델이라
  // 그런가"로 끌고 간다. 모델 정보는 상단 배지의 title 툴팁에 남아 있어
  // 확인하려는 사람은 여전히 볼 수 있다.
  el.usageLine.hidden = true;
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

/** 모호성 유형별 한 줄 풀이 — 값과 1:1 이다(normalize.js AMBIGUITY_VALUES). */
const AMBIGUITY_HINT = {
  'R&R 미지정': '담당자가 정해지지 않음',
  '범위 불명': '어디까지인지 불명확',
  '기한 불명': '언제까지인지 없음',
  '없음': '범위·기한 명확',
};

function renderStats(xray) {
  // substanceGap 의 두 번째 인자는 sentenceCount 가 없을 때의 폴백인데,
  // 여기 오는 xray 는 normalize.js 를 거쳐 sentenceCount 를 항상 갖고 있다.
  const gap = substanceGap(xray);
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
      // 표시되는 값 자체가 풀이 없이는 안 읽힌다 — 특히 'R&R 미지정' 은
      // 직군에 따라 아예 모르는 말이고 화면 어디에도 설명이 없었다.
      // 기존 하위 문구는 표시된 값과 무관한 "기한 명시됨/없음" 이라
      // '범위 불명' 옆에 '기한 명시됨' 이 붙는 식으로 오히려 헷갈렸다.
      sub: AMBIGUITY_HINT[xray.ambiguityType] || '',
    },
    {
      // 이 카드는 **점수 계산에 실제로 들어가는 값**(substanceGap)을 보여준다.
      //
      // 예전에는 aiSlopScore 를 "내용 공허도"라는 이름으로 띄웠는데, 바로 아래
      // 판정 근거 표와 계산식은 substanceGap 을 같은 이름으로 쓰고 있었다.
      // 둘은 다른 지표라(정형구 마커 비율 vs 알맹이 결여 신호) 골든 ① 에서
      // 카드는 "0% · 구체적 내용 있음", 표는 세 지표 전부 1.00, 계산식은
      // "공허도×20" 으로 20점 가산 — 한 화면 안에서 서로를 부정했다.
      // "판정 근거를 그대로 펼쳐 보여준다"가 이 제품의 핵심 주장이라
      // 근거 화면의 자가당착은 그 주장을 직접 깎는다. 계산에 쓰이는 값으로
      // 통일한다. aiSlopScore 는 영수증 빌런 유형·상황 매칭에서 계속 쓴다.
      // "내용 공허도"는 한자어 조어라 읽고 나서 한 번 더 생각해야 했다.
      // 이 값이 재는 건 "요구는 있는데 그걸 실행할 정보가 비어 있다"이므로,
      // 제품이 첫 문장부터 쓰는 말("빠진 알맹이")을 그대로 쓴다.
      name: '알맹이 없음',
      value: `${Math.round(gap * 100)}%`,
      extra: pips(Math.round(gap * 5), 5),
      sub: gap >= 0.6 ? '알맹이 거의 없음' : '구체적 내용 있음',
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
  // 정상 업무 가드(GREEN_CAP)가 걸리면 합계와 표시 점수가 달라진다. 이걸
  // 숨기면 계산식이 "32 + 0 + 0 + 0 = 20" 이라는 틀린 산수로 읽힌다 —
  // 근거를 펼쳐 보여주는 화면에서 가장 하면 안 되는 일이다. 가드가 걸렸다는
  // 사실 자체를 한 줄로 드러낸다.
  const gapPts = Math.round(substanceGap(xray) * 20);
  const urgentPts = xray.urgencyType === '없음' ? 0 : 20;
  const ambiguousPts = xray.ambiguityType === '없음' ? 0 : 20;
  const rawSum = xray.powerAsymmetry * 8 + urgentPts + ambiguousPts + gapPts;
  const capped = rawSum > GREEN_CAP && risk.score === GREEN_CAP;

  const rows = risk.breakdown
    .map((m) => `<tr><td>${m.label}</td><td>${escapeHtml(m.detail)}</td><td>${m.value.toFixed(2)}</td></tr>`)
    .join('');
  const cliches = xray.clicheHits.length
    ? `<div class="chip-list">${xray.clicheHits.map((c) => `<span class="cliche-tag">${escapeHtml(c)}</span>`).join('')}</div>`
    : '<p class="evidence-formula">검출된 클리셰 없음</p>';

  el.evidenceBody.innerHTML = `
    <table class="evidence-table">
      <thead><tr><th>무엇이 비어 있나</th><th>검출</th><th>0~1</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${cliches}
    <p class="evidence-formula">
      점수 = 권력 비대칭(${xray.powerAsymmetry}×8) + 긴급도(${xray.urgencyType === '없음' ? 0 : 20})
      + 모호성(${xray.ambiguityType === '없음' ? 0 : 20}) + 알맹이 없음(${Math.round(substanceGap(xray) * 20)})
      = <b>${capped ? GREEN_CAP : risk.score}</b>
    </p>
    ${
      capped
        ? `<p class="evidence-formula">정상 업무 가드 적용. 긴급도·모호성·알맹이 없음이 모두 0이면
           권력 비대칭만으로 경보를 올리지 않는다(상한 ${GREEN_CAP}점). 가드 전 합계는 ${rawSum}점.</p>`
        : ''
    }
    <p class="evidence-formula">이 점수는 AI가 아니라 코드가 계산합니다. 같은 입력이면 항상 같은 값이 나옵니다.</p>
  `;
}

/**
 * LIVE(실제 LLM 호출) 가 아니면 답장이 메시지 내용을 깊이 읽고 쓴 게 아니라
 * 목적×말투 세기로 갈라지는 규칙 기반 근사치라는 걸 명시한다. 이 설명이 없으면
 * "답장이 왜 내 메시지를 다르게 표현한 것처럼 느껴지지" 하고 오해하기 쉽다.
 */
function renderRepliesModeNote(mode) {
  if (mode === 'live') {
    el.repliesModeNote.hidden = true;
    return;
  }
  el.repliesModeNote.hidden = false;
  el.repliesModeNote.textContent = mode === 'cached'
    ? 'ℹ️ 캐시된 예시 답장입니다.\n상황 카드 원본 그대로일 때만 나오는 미리 준비된 결과예요.'
    : 'ℹ️ 지금은 규칙 기반 예시 답장입니다(모델 미연동).\n목적·말투에 따라 갈라지긴 하지만 메시지 내용을 세세히 읽고 쓰진 않아요.\n그대로 보내기보다 초안으로 참고해 다듬어 주세요.';
}

function renderReplies(replies) {
  el.replies.innerHTML = '';
  replies.forEach((r, i) => {
    const text = showText(r.text);
    const card = document.createElement('div');
    card.className = 'reply';
    card.innerHTML = `
      <div class="reply-head">
        <span class="reply-label">[추천 ${i + 1}] ${escapeHtml(r.label)}</span>
        <span class="reply-index">${text.length}자</span>
      </div>
      <p class="reply-text"></p>
      <button type="button" class="copy">복사하기</button>`;
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
    btn.textContent = '복사하기';
    btn.classList.remove('done');
  }, 1600);
}

/* ── 상태 표시 ───────────────────────────── */

function setBusy(on) {
  el.run.disabled = on;
  el.run.textContent = on ? '분석 중…' : '분석하고 답장 만들기';
  document.body.classList.toggle('is-loading', on);
  el.progress.hidden = !on;
  // 진행 표시가 도는데 제목이 "대기 중"이면 서로 어긋난다.
  el.standbyTitle.textContent = on ? '방화벽 가동 중' : '방화벽 대기 중';
  if (!on) setProgress(null);
}

/**
 * 진행 단계 표시.
 *
 * 예전에는 버튼 글자만 "분석 중…"으로 바뀌고 결과 패널은 "방화벽 대기 중"
 * 그대로였다. LIVE 에서 1~3초가 걸리는데 화면이 안 변하니 눌렸는지조차
 * 확인이 안 됐다. 단계 이름을 보여주면 기다리는 시간이 "멈춘 것"이 아니라
 * "진행 중"으로 읽힌다 — 특히 첫 단계가 '이름·연락처 가리는 중'이라,
 * 전송 전에 가린다는 이 제품의 약속이 기다리는 동안 눈에 들어온다.
 *
 * @param {'mask'|'analyze'|'reply'|null} step  null 이면 전부 초기화
 */
const PROGRESS_ORDER = ['mask', 'analyze', 'reply'];
function setProgress(step) {
  const at = PROGRESS_ORDER.indexOf(step);
  for (const node of el.progress.querySelectorAll('.progress-step')) {
    const i = PROGRESS_ORDER.indexOf(node.dataset.step);
    node.classList.toggle('active', i === at);
    node.classList.toggle('done', at >= 0 && i < at);
  }
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

/**
 * 입력이 하나라도 바뀌면 화면에 남아 있던 결과를 치우고 대기 상태로 돌린다.
 *
 * 예전에는 결과가 뜬 뒤 직군·관계·말투를 바꿔도 이전 결과가 그대로 남아
 * 있었다. 바뀐 선택과 화면의 점수가 어긋나는데 사용자는 그걸 "방금 바꾼 게
 * 반영된 점수"로 읽는다. 영수증도 옛 스냅샷(lastReceiptSource)으로 발급되어
 * 화면과 다른 값이 찍혔다.
 *
 * 실행 중에는 건드리지 않는다 — 분석이 끝나면 어차피 새 결과로 덮인다.
 */
function resetResult() {
  if (busy) return;
  if (el.result.hidden && el.errorBox.hidden) return;
  el.result.hidden = true;
  el.standby.hidden = false;
  hideError();
  lastReceiptSource = null;
  // 되살린 화면도 같이 치운다 — 배너만 남으면 "불러온 결과"라는 안내가
  // 대기 화면 위에 떠 있게 된다.
  restoredView = false;
  renderRestoredNote(false, null);
}

/**
 * 되살린 결과라는 표시.
 *
 * 점수·답장이 똑같이 보이기 때문에, 표시가 없으면 방금 분석한 결과로 읽힌다.
 * 언제 받은 메시지였는지와 **입력칸이 비어 있는 이유**를 같이 적는다.
 */
function renderRestoredNote(restored, restoredAt) {
  el.restoredNote.hidden = !restored;
  if (!restored) return;
  const when = restoredAt ? new Date(restoredAt) : null;
  const stamp = when
    ? `${when.getMonth() + 1}월 ${when.getDate()}일 ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
    : '이전';
  // 입력칸은 건드리지 않는다 — 쓰다 만 메시지를 말없이 지우는 게 더 나쁘다.
  // 대신 지금 화면이 입력칸 내용의 결과가 아니라는 걸 분명히 적는다.
  el.restoredNoteBody.textContent =
    `${stamp}에 분석한 결과입니다. 아래 입력칸의 내용과는 무관합니다.\n메시지 원문은 저장하지 않아 답장에 있던 이름은 ○○로 표시됩니다.`;
}

/**
 * 기록 항목을 눌러 그때의 결과 화면으로 돌아간다.
 *
 * 되살릴 수 있는 건 **분석 결과뿐이다.** 원문을 저장한 적이 없어서 입력칸은
 * 채우지 못한다(그게 이 도구의 약속이다). 그래서 "다시 분석"이 아니라
 * "그때 화면을 다시 펼치기"에 가깝다 — 재분석하면 같은 값이 안 나올 수도
 * 있는데, 기록은 그때 내린 판정을 보존하는 쪽이 맞다.
 */
function restoreFromHistory(entry) {
  const snap = entry?.snapshot;
  if (!snap) return;
  closeHistoryModal();
  render({ ...snap, replies: snap.replies || [], meta: snap.meta || { mode: 'mock' } }, null, snap.context, {
    restored: true,
    restoredAt: entry.ts,
  });
  el.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
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

/* ── 모달 포커스 관리 (접근성) ─────────────────────────────
 * 다이얼로그가 떠 있는데 Tab 이 배경으로 빠져나가면, 키보드·스크린리더 사용자는
 * 오버레이에 가려 보이지도 않는 컨트롤을 조작하게 된다. 실측으로 세 가지가
 * 확인돼서 함께 고친다: (1) 열어도 포커스가 안으로 안 들어감,
 * (2) Tab 이 배경으로 탈출, (3) 닫은 뒤 호출한 버튼으로 안 돌아옴. */

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
let lastFocusedBeforeModal = null;

function focusablesIn(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((n) => !n.hidden && n.offsetParent !== null);
}

function openModal(modal) {
  lastFocusedBeforeModal = document.activeElement;
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  const first = focusablesIn(modal)[0];
  if (first) first.focus();
}

function closeModal(modal) {
  modal.hidden = true;
  document.body.style.overflow = '';
  // 열기 전 위치로 포커스를 돌려준다 — 안 그러면 문서 맨 앞으로 튄다.
  if (lastFocusedBeforeModal && document.contains(lastFocusedBeforeModal)) {
    lastFocusedBeforeModal.focus();
  }
  lastFocusedBeforeModal = null;
}

/** 열려 있는 모달 안에 Tab 순환을 가둔다. */
function trapTabInModal(e) {
  if (e.key !== 'Tab') return;
  const modal = [el.intro, el.receiptModal, el.historyModal, el.feedbackModal].find((m) => !m.hidden);
  if (!modal) return;
  const items = focusablesIn(modal);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  const onFirst = document.activeElement === first;
  const onLast = document.activeElement === last;
  const outside = !modal.contains(document.activeElement);
  if (e.shiftKey && (onFirst || outside)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (onLast || outside)) {
    e.preventDefault();
    first.focus();
  }
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

/**
 * 공유 카드의 첫 줄.
 *
 * 카드에서 가장 큰 글자가 점수가 아니라 이 문장이다. 받는 사람이 0.5초 안에
 * 읽는 건 숫자가 아니라 문장이고, 이 도구가 주는 감정적 값어치는 "내가 겪은
 * 게 기분 탓이 아니었다"는 확인이기 때문이다.
 *
 * **메시지 원문에서 만들지 않는다.** 카드에 원문이 들어가지 않는다는 원칙은
 * 그대로라, 후킹은 이미 계산된 위험 등급에서만 끌어온다.
 */
function receiptHook(risk) {
  const level = risk?.level || 'green';
  if (level === 'red') return '이건 참을 일이 아니었습니다';
  if (level === 'orange') return '혼자 판단하지 않아도 됩니다';
  if (level === 'amber') return '넘기기 전에 한 번 짚고 갈 일이었습니다';
  if (level === 'lime') return '예민한 게 아니라 애매한 요청이었습니다';
  return '이번 건은 정상 범위였습니다';
}

function openReceiptModal() {
  if (!lastReceiptSource) return;
  const { xray, risk, context } = lastReceiptSource;
  const data = buildReceiptData(xray, risk, context);
  const count = bumpMonthlyReceiptCount();

  el.rcJob.textContent = data.job;
  el.rcVillain.textContent = data.villain;
  el.rcScore.textContent = String(data.score);
  el.rcScoreLabel.textContent = data.scoreLabel;
  el.rcHook.textContent = receiptHook(risk);
  el.rcBar.style.width = `${Math.max(4, data.score)}%`;
  el.rcMode.textContent = data.defenseMode;
  el.rcCount.textContent = String(count);
  // 카드 안의 "원티드 커리어 세이프"는 이미지라 누를 수 없다. 아래 링크가
  // 그 제안을 실제로 눌러지게 하고, 주소는 케어 블록과 같은 규칙(연차·직군)으로 맞춘다.
  el.receiptWantedLink.href = wantedUrl(context);
  el.receiptWantedText.textContent = `${context?.level || ''} 경력으로 열려 있는 채용 보기`.trim();

  el.receiptStatus.textContent = '';
  openModal(el.receiptModal);
}

function closeReceiptModal() {
  closeModal(el.receiptModal);
}

/**
 * 내보낼 때 배경색을 반드시 칠한다.
 *
 * 카드에 둥근 모서리가 있어서, 배경을 지정하지 않으면 네 귀퉁이가 투명하게
 * 남는다. 공유받은 쪽의 대화방 배경(밝은 테마면 흰색, 어두운 테마면 검정)이
 * 거기로 비치면 카드가 잘못 잘린 것처럼 보인다. 카드와 같은 색으로 칠해
 * 투명 픽셀 자체를 없앤다.
 */
const RECEIPT_BG = '#ffffff';

async function captureReceiptPng() {
  // 폰트 로딩 등으로 인한 첫 캡처 오차를 줄이기 위해 한 프레임 양보한다.
  await new Promise((r) => requestAnimationFrame(r));
  return toPng(el.receiptCard, { pixelRatio: 2, cacheBust: true, backgroundColor: RECEIPT_BG });
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
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    setReceiptStatus('이 브라우저에서는 이미지 복사가 지원되지 않습니다. "이미지로 저장하기"를 이용해 주세요.');
    return;
  }
  setReceiptStatus('이미지 생성 중…');
  try {
    // Safari/iOS 는 클립보드 쓰기가 사용자 제스처와 "같은 턴"에서 시작돼야 한다.
    // blob 을 await 한 뒤에 write() 를 부르면 제스처 컨텍스트가 끊겨
    // NotAllowedError 로 실패한다 — 화면에는 "브라우저 미지원"으로 잘못 표시된다.
    // ClipboardItem 에 Promise 를 그대로 넘기면 생성이 동기적으로 일어나 이를 피한다.
    const png = new Promise((resolve) => requestAnimationFrame(resolve))
      .then(() => toBlob(el.receiptCard, { pixelRatio: 2, cacheBust: true, backgroundColor: RECEIPT_BG }))
      .then((blob) => {
        if (!blob) throw new Error('blob-failed');
        return blob;
      });
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    setReceiptStatus('클립보드에 복사했습니다.');
  } catch {
    // 미지원과 실패를 구분한다 — 전자는 위에서 이미 걸러졌다.
    setReceiptStatus('이미지 복사에 실패했습니다. "이미지로 저장하기"를 이용해 주세요.');
  }
}

function setReceiptStatus(msg) {
  el.receiptStatus.textContent = msg;
}

/* ── 나의 방어 기록 ───────────────────────────── */

// amber/red 는 흰 배경 위 작은 텍스트로 쓰면 대비가 약하다(styles.css :root 주석 참고) —
// 틴트 배경용 원색 대신 accent.foreground 변형(--amber-text/--red-text)을 쓴다.
const LEVEL_COLOR = { green: 'var(--green)', lime: 'var(--lime)', amber: 'var(--amber-text)', orange: 'var(--orange)', red: 'var(--red-text)' };

function openHistoryModal() {
  renderHistory();
  openModal(el.historyModal);
}

function closeHistoryModal() {
  closeModal(el.historyModal);
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
    el.historyTop.textContent = s.topVillain || '-';
  }

  // 스냅샷이 남아 있는 기록만 누를 수 있다. 오래된 기록은 용량 때문에
  // 스냅샷을 떼어냈으므로(history.js MAX_SNAPSHOTS), 누르면 아무 일도
  // 일어나지 않는 버튼으로 두지 않고 처음부터 버튼이 아니게 그린다.
  el.historyList.innerHTML = history
    .map((e, i) => {
      const date = new Date(e.ts);
      const dateStr = `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
      const body = `<span class="history-item-score" style="color:${LEVEL_COLOR[e.level] || 'var(--text-dim)'}">${escapeHtml(e.score)}</span>
        <div class="history-item-body">
          <div class="history-item-villain">${escapeHtml(e.villain)}</div>
          <div class="history-item-meta">${dateStr} · ${escapeHtml(e.job)} · ${escapeHtml(e.defenseMode)}</div>
        </div>`;
      return e.snapshot
        ? `<button type="button" class="history-item is-openable" data-index="${i}">${body}<span class="history-item-go" aria-hidden="true">›</span><span class="sr-only">이 결과 다시 보기</span></button>`
        : `<div class="history-item">${body}</div>`;
    })
    .join('');

  el.historyList.querySelectorAll('.history-item.is-openable').forEach((btn) => {
    btn.addEventListener('click', () => restoreFromHistory(history[Number(btn.dataset.index)]));
  });
}

function onClearHistory() {
  // eslint-disable-next-line no-alert
  if (!window.confirm('나의 방어 기록을 전부 삭제할까요? 이 작업은 되돌릴 수 없습니다.')) return;
  clearHistory();
  renderHistory();
  renderHistoryBadge();
}

/* ── 어떻게 작동하나요 (스텝 탭) ───────────────── */

function initHowItWorks() {
  const tabs = Array.from(document.querySelectorAll('.hiw-tab'));
  const panels = Array.from(document.querySelectorAll('.hiw-panel'));
  if (!tabs.length) return;

  function activate(index) {
    tabs.forEach((tab, i) => {
      const on = i === index;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      panels[i].hidden = !on;
    });
  }

  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => activate(i));
    // role="tablist" 표준 동작 — 화살표로 탭 이동, 포커스도 같이 옮긴다.
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      const next = e.key === 'ArrowRight' ? (i + 1) % tabs.length : (i - 1 + tabs.length) % tabs.length;
      activate(next);
      tabs[next].focus();
    });
  });
}

/* ── 초기화 ───────────────────────────── */

renderChips();
// 칩을 다 그린 뒤에 접기를 준비한다. 지난 방문의 직군·연차가 복원돼 있으면
// 이 시점에 이미 완성이라 바로 접힌 상태로 시작한다(돌아온 사람은 다시 고를
// 이유가 없다).
initFolding();
syncFolding();
updateChoiceNotes();
updatePlaceholders();
renderPresets();
initHowItWorks();
el.message.addEventListener('input', onInput);
// 숨은 속사정은 그동안 리스너가 없어서, 전송본 미리보기를 열어둔 채 이 칸을
// 고쳐도 미리보기가 갱신되지 않았다. 결과 초기화와 함께 여기서 처리한다.
el.hiddenContext.addEventListener('input', () => {
  resetResult();
  if (!el.maskPreview.hidden) updateMaskPreview();
});
el.run.addEventListener('click', () => run());
el.presetRun.addEventListener('click', () => applyPresetMessage());
// 되살린 화면에서 빠져나오는 유일한 경로. 입력칸이 비어 있으니 그쪽으로 보낸다.
el.restoredExit.addEventListener('click', () => {
  restoredView = false;
  el.result.hidden = true;
  el.standby.hidden = false;
  renderRestoredNote(false, null);
  lastReceiptSource = null;
  el.message.focus({ preventScroll: true });
  el.message.scrollIntoView({ behavior: 'smooth', block: 'center' });
});
el.presetToggle.addEventListener('click', () => {
  presetsExpanded = !presetsExpanded;
  applyPresetFilter();
});
el.togglePreview.addEventListener('click', () => {
  const show = el.maskPreview.hidden;
  el.maskPreview.hidden = !show;
  el.togglePreview.setAttribute('aria-expanded', String(show));
  el.togglePreview.textContent = show ? '전송될 내용 닫기' : '전송될 내용 확인하기';
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
el.introNext.addEventListener('click', () => stepIntro(1));
el.introBack.addEventListener('click', () => stepIntro(-1));
el.introSkip.addEventListener('click', closeIntro);
el.introReplay.addEventListener('click', openIntro);
el.feedbackForm.addEventListener('submit', sendFeedback);
el.feedbackOpen.addEventListener('click', openFeedbackModal);
el.feedbackFloat.addEventListener('click', openFeedbackModal);
el.feedbackClose.addEventListener('click', closeFeedbackModal);
el.feedbackBackdrop.addEventListener('click', closeFeedbackModal);

/**
 * 맨 위로.
 *
 * 페이지가 입력 → 결과 → 작동 방식 → 푸터로 길어서 아래에서 위로 돌아오는
 * 비용이 크다. 한 화면 넘게 내려갔을 때만 띄운다 — 항상 떠 있으면 모바일에서
 * 영수증 발급 버튼 같은 실제 조작을 가린다.
 */
const TO_TOP_AT = () => window.innerHeight * 0.9;

/**
 * 떠 있는 버튼이 실제 조작을 가리면 안 된다.
 *
 * 모바일 실측에서 맨 위로 버튼이 '분석하고 답장 만들기'를 덮고 있었다 —
 * 화면 폭을 꽉 채우는 주요 CTA 라 우하단 어디에 둬도 겹친다. 위치를 옮기는
 * 대신, 그 버튼들이 화면에 있는 동안에는 맨 위로를 숨긴다. 위로 갈 길은
 * 스크롤로도 열려 있지만 실행 버튼을 못 누르는 건 대안이 없다.
 */
function wouldCover(floatBtn) {
  const t = floatBtn.getBoundingClientRect();
  // 푸터의 두 버튼도 가림 대상이다 — 페이지 끝까지 내려가면 떠 있는 버튼이
  // 정확히 그 자리에 앉는다(실측으로 '앱으로 설치'가 눌리지 않았다).
  return [el.run, el.receiptOpen, el.feedbackOpen, el.installOpen].some((node) => {
    if (!node || !node.offsetParent) return false;
    const r = node.getBoundingClientRect();
    return r.bottom > t.top && r.top < t.bottom && r.right > t.left && r.left < t.right;
  });
}

/**
 * 떠 있는 버튼 두 개(맨 위로 · 의견 보내기)의 노출.
 *
 * 의견 보내기는 푸터까지 내려가야만 보였다. 한 번 써본 뒤에 쓸 말이
 * 생기는 성격이라, 결과를 본 시점부터 손에 닿는 곳에 둔다. 다만 둘 다
 * 실행 버튼을 덮으면 안 되므로 같은 가림 판정을 공유한다.
 */
const syncToTop = () => {
  const scrolled = window.scrollY > TO_TOP_AT();
  el.toTop.classList.toggle('is-on', scrolled && !wouldCover(el.toTop));
  el.feedbackFloat.classList.toggle('is-on', scrolled && !wouldCover(el.feedbackFloat));
};
window.addEventListener('scroll', syncToTop, { passive: true });
el.toTop.addEventListener('click', () => {
  window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
});
syncToTop();

document.addEventListener('keydown', (e) => {
  trapTabInModal(e);
  // 스토리는 좌우 키로도 넘길 수 있게 한다(읽는 흐름을 끊지 않는다).
  if (!el.intro.hidden) {
    if (e.key === 'ArrowRight') stepIntro(1);
    if (e.key === 'ArrowLeft') stepIntro(-1);
  }
  if (e.key !== 'Escape') return;
  if (!el.intro.hidden) closeIntro();
  if (!el.feedbackModal.hidden) closeFeedbackModal();
  if (!el.receiptModal.hidden) closeReceiptModal();
  if (!el.historyModal.hidden) closeHistoryModal();
});
onInput();
// 재방문자는 첫 화면에서 바로 쌓인 기록 수를 본다.
renderHistoryBadge();
maybeShowIntro();


/* ── 홈 화면에 추가 (PWA) ─────────────────────────────

   설치 경로는 플랫폼마다 다르다.

   - 안드로이드/크롬: manifest + fetch 핸들러가 있는 서비스 워커가 갖춰지면
     브라우저가 beforeinstallprompt 를 던진다. 그 이벤트를 잡아 뒀다가
     사용자가 버튼을 눌렀을 때 prompt() 를 부른다. 이벤트 없이 prompt 를
     띄울 방법은 없다.
   - iOS 사파리: 설치 프롬프트 API 자체가 없다. 공유 시트에서 직접
     "홈 화면에 추가"를 눌러야 해서, 버튼 대신 그 경로를 문장으로 알려 준다.
   - 이미 설치해서 열었으면(standalone) 배너를 띄우지 않는다.

   한 번 닫으면 다시 띄우지 않는다. 설치 배너는 거절당한 뒤에도 계속 뜨면
   그 자체가 이 도구에 대한 인상이 된다.
*/
const INSTALL_DISMISSED_KEY = 'ofw_install_dismissed_v1';
const INSTALL_DONE_KEY = 'ofw_installed_v1';

/**
 * "닫았다"와 "설치했다"는 다른 상태다.
 *
 * 예전에는 설치가 끝났을 때도 닫힘 키를 함께 세웠다. 그래서 한 번 설치하고 나면
 * 그 브라우저에서는 배너가 **영영 다시 뜨지 않았다.** 앱을 지우고 다시 깔고
 * 싶어도, 배너가 왜 안 나오는지 알 방법조차 없었다. 두 상태를 나눠 둔다.
 *
 * 설치 여부는 beforeinstallprompt 가 알려 준다 — 이 이벤트는 "지금 설치할 수
 * 있다"는 뜻이라, 이벤트가 왔다는 건 설치돼 있지 않다는 뜻이다. 그때 설치 키를
 * 지워 상태를 사실에 맞춘다.
 */
function flag(key) {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function setFlag(key, on) {
  try {
    if (on) localStorage.setItem(key, '1');
    else localStorage.removeItem(key);
  } catch {
    // 프라이빗 브라우징이면 이번 세션에만 유지된다 — 배너를 막을 이유는 아니다.
  }
}

/**
 * 닫힘은 **만료된다.**
 *
 * 예전에는 ✕ 를 한 번 누르면 그 브라우저에서 배너가 영영 돌아오지 않았다.
 * "성가시게 하지 않는다"는 의도였지만, 처음엔 관심이 없다가 나중에 자주 쓰게
 * 되는 게 이 도구의 자연스러운 흐름이라 영구 차단은 과했다. 실제로 "배너가
 * 안 뜬다"는 제보의 원인이 이것이었다.
 *
 * 7일이 지나면 한 번 더 묻는다. 값으로 시각을 저장하므로, 예전에 '1' 이
 * 저장된 브라우저는 1ms 에포크로 읽혀 곧바로 만료된 것으로 처리된다
 * (배너가 다시 돌아온다는 뜻이다).
 */
const INSTALL_DISMISS_DAYS = 7;

function installDismissed() {
  try {
    const at = Number(localStorage.getItem(INSTALL_DISMISSED_KEY));
    if (!at) return false;
    return Date.now() - at < INSTALL_DISMISS_DAYS * 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

function markInstallDismissed() {
  try {
    localStorage.setItem(INSTALL_DISMISSED_KEY, String(Date.now()));
  } catch {
    // 프라이빗 브라우징이면 이번 세션에만 닫힌다 — 배너를 막을 이유는 아니다.
  }
}

/** 이미 홈 화면에서 실행 중인가. iOS 는 표준 matchMedia 대신 navigator.standalone 을 쓴다. */
function isInstalled() {
  return window.matchMedia?.('(display-mode: standalone)').matches === true || navigator.standalone === true;
}

const isIosSafari =
  /iPad|iPhone|iPod/.test(navigator.userAgent) &&
  !/CriOS|FxiOS|EdgiOS/.test(navigator.userAgent);

/**
 * 브라우저마다 설치 경로가 다르다 — 그리고 아예 불가능한 곳도 있다.
 *
 * `beforeinstallprompt` 는 크로미움 계열 일부에만 있는 비표준 이벤트다. 그
 * 이벤트가 오지 않는 브라우저에서 "설치" 버튼을 띄워 두면 **눌러도 아무 일도
 * 일어나지 않는 버튼**이 된다. 그래서 이벤트를 받지 못한 경우에는 버튼 대신
 * 그 브라우저의 실제 경로를 문장으로 알려 준다.
 *
 * 한국에서 특히 중요한 게 **인앱 브라우저**다. 카카오톡으로 링크를 공유하면
 * 대부분 카카오 인앱 브라우저에서 열리는데, 여기서는 설치가 아예 불가능하다.
 * 이때 필요한 안내는 설치 방법이 아니라 "기본 브라우저로 열어라"다.
 *
 * 삼성 인터넷은 한 겹 더 있다. 크로미움 기반이라 설치는 되지만, 삼성이 직접
 * 만드는 WebAPK 가 구형 targetSdkVersion 으로 서명돼 최신 안드로이드의
 * **Google Play Protect 가 "Unsafe app blocked" 로 막는 사례**가 확인됐다.
 * (실제 문구: "This app was built for an older version of Android and doesn't
 * include the latest privacy protections.")
 *
 * 이건 웹에서 고칠 수 있는 값이 아니다. targetSdkVersion 은 브라우저가 만드는
 * APK 안에 있고 웹 매니페스트에는 그런 필드가 없다. 그래서 고치는 대신,
 * 막힐 수 있다는 사실과 **크롬으로 열면 된다**는 우회로를 먼저 알려 준다.
 */
function installEnv(ua = navigator.userAgent) {
  // 인앱 브라우저를 먼저 본다 — UA 에 Chrome/Safari 표기가 함께 들어 있어서
  // 아래 브라우저 판정보다 뒤에 두면 영영 걸리지 않는다.
  if (/KAKAOTALK/i.test(ua)) return { kind: 'inapp', label: '카카오톡' };
  if (/NAVER\(inapp|NAVER /i.test(ua)) return { kind: 'inapp', label: '네이버 앱' };
  if (/DaumApps/i.test(ua)) return { kind: 'inapp', label: '다음 앱' };
  if (/Instagram|FBAN|FBAV|Line\//i.test(ua)) return { kind: 'inapp', label: '인앱 브라우저' };

  if (/SamsungBrowser/i.test(ua)) return { kind: 'samsung', label: '삼성 인터넷' };
  if (/FxiOS/i.test(ua)) return { kind: 'ios-other', label: '파이어폭스' };
  if (/CriOS|EdgiOS/i.test(ua)) return { kind: 'ios-other', label: '크롬' };
  if (/iPad|iPhone|iPod/.test(ua)) return { kind: 'ios-safari', label: '사파리' };
  if (/Firefox/i.test(ua)) return { kind: 'firefox', label: '파이어폭스' };
  if (/Whale/i.test(ua)) return { kind: 'chromium', label: '웨일' };
  if (/Edg/i.test(ua)) return { kind: 'chromium', label: '엣지' };
  if (/Chrome/i.test(ua)) return { kind: 'chromium', label: '크롬' };
  return { kind: 'unknown', label: '이 브라우저' };
}

/** 설치 프롬프트를 띄울 수 없을 때 대신 보여줄 경로 안내. */
function installHowTo(env) {
  switch (env.kind) {
    case 'inapp':
      return `${env.label} 안에서는 앱 설치를 지원하지 않습니다. 오른쪽 위 메뉴에서 "다른 브라우저로 열기"를 눌러 크롬이나 삼성 인터넷에서 열어 주세요.`;
    case 'ios-safari':
      return '아래 공유 버튼을 누르고 "홈 화면에 추가"를 선택하세요.';
    case 'ios-other':
      return `아이폰에서는 ${env.label}이 아니라 사파리에서만 홈 화면에 추가할 수 있습니다. 사파리로 열어 공유 버튼을 눌러 주세요.`;
    case 'samsung':
      return '삼성 인터넷에서는 설치가 Play Protect 에 차단될 수 있습니다. 크롬으로 열어 설치하시면 정상 동작합니다. (삼성 인터넷에서 계속하려면 메뉴 → "현재 페이지 추가" → "홈 화면")';
    case 'firefox':
      return '오른쪽 위 메뉴(⋮)를 누르고 "홈 화면에 추가"를 선택하세요.';
    case 'chromium':
      return '메뉴(⋮)를 누르고 "앱 설치" 또는 "홈 화면에 추가"를 선택하세요.';
    default:
      return '브라우저 메뉴에서 "홈 화면에 추가"를 찾아 선택하세요.';
  }
}

let installPrompt = null;

/**
 * 진입 스토리가 열려 있는 동안 밀어 둔 설치 제안.
 *
 * 첫 방문자는 스토리 모달을 먼저 본다. 그 뒤에 배너를 띄우면 모달에 가려
 * 보이지도 않고(실측), 무엇보다 **순서가 틀렸다.** 이 도구가 뭘 해주는지
 * 보기도 전에 설치부터 권하는 꼴이다. 스토리를 닫은 뒤로 미룬다.
 *
 * 크롬의 beforeinstallprompt 는 이른 시점에 한 번만 오지만, 이벤트를 들고
 * 있으면 나중에 prompt() 를 부를 수 있어서 미뤄도 잃는 게 없다.
 */
let pendingInstall = null;

function showInstallBanner({ force = false } = {}) {
  // force 는 푸터에서 직접 부른 경우다 — 이미 닫았더라도 열어 준다.
  if (!force && (installDismissed() || flag(INSTALL_DONE_KEY))) return;
  if (isInstalled()) return;
  if (!el.intro.hidden) {
    pendingInstall = { force };
    return;
  }
  pendingInstall = null;
  el.installBanner.classList.remove('is-done');

  const env = installEnv();
  // 프롬프트를 실제로 띄울 수 있을 때만 버튼을 남긴다. 누를 수 없는 버튼은
  // 없는 것만 못하다 — 눌러 보고 아무 일도 안 일어나면 그게 고장으로 읽힌다.
  const canPrompt = installPrompt !== null;
  el.installAccept.hidden = !canPrompt;

  if (env.kind === 'inapp') {
    // 설치가 불가능한 곳이라 "설치하세요"로 시작하면 안 된다.
    el.installBannerTitle.textContent = '브라우저에서 열면 앱으로 설치할 수 있어요';
  } else {
    // 데스크톱에는 홈 화면이 없다. 거기서 "홈 화면에 두고 쓰세요"는 틀린 약속이다.
    el.installBannerTitle.textContent = isMobile ? '앱처럼 홈 화면에 두고 쓰세요' : '앱처럼 창으로 띄워 두고 쓰세요';
  }
  el.installBannerSub.textContent = canPrompt ? '설치해도 용량을 거의 쓰지 않습니다.' : installHowTo(env);
  el.installBanner.hidden = false;
}

/** 진입 스토리를 닫는 순간 호출된다 (closeIntro). */
function flushPendingInstall() {
  if (pendingInstall) showInstallBanner(pendingInstall);
}

function hideInstallBanner() {
  el.installBanner.hidden = true;
  el.installBanner.classList.remove('is-done');
}

window.addEventListener('beforeinstallprompt', (e) => {
  // 기본 미니 인포바를 막고, 우리 배너의 버튼에 시점을 넘긴다.
  e.preventDefault();
  installPrompt = e;
  // 이 이벤트가 왔다는 건 지금 설치할 수 있다는 뜻이다 = 설치돼 있지 않다.
  setFlag(INSTALL_DONE_KEY, false);
  el.installOpen.hidden = false; // 배너를 닫아도 푸터로 다시 들어올 수 있게
  showInstallBanner();
});

/**
 * 설치가 끝난 뒤 **어디로 갔는지** 알려 준다.
 *
 * 아이콘이 어디에 놓이는지는 브라우저와 OS 가 정한다. 웹에서 위치를 지정할
 * 방법은 없다. 그래서 "설치했는데 안 보인다"가 생기는데, 실제로는 플랫폼마다
 * 간 곳이 다르다.
 *
 *  - 안드로이드 크롬: 홈 화면 + 앱 서랍. 런처 설정에 따라 앱 서랍에만 들어간다.
 *  - 데스크톱 크롬/엣지: 홈 화면이라는 개념이 없다. 앱 목록·작업 표시줄에 앉는다.
 *  - iOS 사파리: 공유 시트로 직접 추가하므로 항상 홈 화면이다(appinstalled 이벤트
 *    자체가 오지 않아 이 경로를 타지 않는다).
 *
 * 위치를 바꿔 줄 수는 없으니, 찾는 곳이라도 정확히 말해 준다.
 */
// 두 신호를 OR 로 본다. userAgentData 는 크로미움에만 있고(iOS 사파리엔 없다),
// ?? 로 묶으면 userAgentData 가 있는 순간 UA 문자열은 영영 보지 않는다.
const isMobile =
  navigator.userAgentData?.mobile === true || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

function showInstalledNote() {
  el.installBanner.classList.add('is-done');
  el.installAccept.hidden = true;
  el.installBannerTitle.textContent = '설치를 마쳤습니다';
  el.installBannerSub.textContent = isMobile
    ? '홈 화면에 "방화벽"이 추가됩니다. 안 보이면 앱 서랍(전체 앱)에서 찾아 홈 화면으로 끌어다 놓으세요.'
    : '홈 화면 대신 앱 목록에 설치됩니다. 크롬 주소창의 앱 아이콘이나 시작 메뉴에서 "방화벽"을 찾으세요.';
  el.installBanner.hidden = false;
}

window.addEventListener('appinstalled', () => {
  installPrompt = null;
  setFlag(INSTALL_DONE_KEY, true);
  showInstalledNote();
});

el.installAccept.addEventListener('click', async () => {
  if (!installPrompt) return;
  hideInstallBanner();
  installPrompt.prompt();
  await installPrompt.userChoice;
  // prompt 는 이벤트당 한 번만 쓸 수 있다. 결과와 무관하게 버린다.
  installPrompt = null;
});

el.installDismiss.addEventListener('click', () => {
  markInstallDismissed();
  hideInstallBanner();
});

/**
 * 푸터의 "앱으로 설치" — 배너를 닫았거나 못 본 사람에게 남는 입구.
 *
 * 이게 없으면 배너를 한 번 닫은 순간 설치할 방법이 화면에서 사라진다(브라우저
 * 메뉴를 아는 사람만 설치할 수 있게 된다). force 로 열어 닫힘 기록을 무시한다.
 */
el.installOpen.addEventListener('click', () => {
  if (isInstalled()) {
    showInstalledNote();
    return;
  }
  setFlag(INSTALL_DISMISSED_KEY, false);
  showInstallBanner({ force: true });
  el.installBanner.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

/**
 * beforeinstallprompt 가 오지 않는 환경.
 *
 * iOS 사파리·파이어폭스·삼성 인터넷(일부 버전)·인앱 브라우저가 여기 해당한다.
 * 푸터 입구는 **항상** 열어 둔다 — 이벤트가 없다고 설치가 불가능한 건 아니고,
 * 불가능한 인앱 브라우저에서도 "기본 브라우저로 여세요"라는 할 말이 있다.
 *
 * 자동 배너는 iOS 사파리에서만 띄운다. 나머지는 브라우저 자체 UI 가 있거나
 * (크롬·엣지) 안내가 배너를 띄울 만큼 급하지 않아서, 필요한 사람이 푸터에서
 * 열게 둔다.
 */
el.installOpen.hidden = false;
if (isIosSafari) showInstallBanner();

/**
 * 서비스 워커 등록.
 *
 * 등록 실패가 앱을 막으면 안 된다 — 서비스 워커는 설치 가능 조건일 뿐,
 * 서비스 동작에 필요하지 않다. 그래서 실패는 조용히 넘긴다.
 * 개발 서버(vite)에서는 /sw.js 가 없으므로 자연히 실패하고, 그대로 둔다.
 */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
