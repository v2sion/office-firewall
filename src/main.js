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
  level: ['주니어(1~3년)', '시니어(4~7년)', '리드·팀장(8년+)'],
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
  '칼차단': '수용할 수 없다는 걸 분명히 합니다. 대안은 하나만 남기고, 일정 재협상 여지는 두지 않습니다.',
  '시간벌기': '즉답을 피하고 판단에 필요한 정보를 먼저 요구합니다. 회신 시점을 내가 정합니다.',
  '공넘기기': '선행 조건과 책임 소재를 짚어 공을 상대에게 돌려보냅니다. 내가 먼저 착수하지 않습니다.',
  '관계보존': '요구는 받되 범위와 기한을 좁혀 다시 정의합니다. 관계 비용을 가장 적게 씁니다.',
};
const TONE_NOTE = {
  '순한맛': '쿠션어를 문장마다 넣고, 거절도 제안 형태로 바꿉니다. 상대 체면을 먼저 세웁니다.',
  '보통맛': '사실과 일정 중심의 표준 업무 어조입니다. 감정 표현 없이 담백하게 씁니다.',
  '매운맛': '완곡어를 걷어내고 모호한 부분을 직접 지적합니다. 범위·기한·담당을 명시적으로 요구합니다.',
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
const MESSAGE_PLACEHOLDER = {
  '직속상사': '상대방이 보낸 내용을 그대로 붙여넣으세요.\n\n예) 주말에 미안한데, 월요일 오전 보고 전까지 한 번만 봐주면 좋을 것 같아요. 급한 건 아닙니다!',
  '임원': '상대방이 보낸 내용을 그대로 붙여넣으세요.\n\n예) 이번 건 대표님도 보고 계시니까, 오늘 중으로 결과 한번 보여주시죠.',
  '선배': '상대방이 보낸 내용을 그대로 붙여넣으세요.\n\n예) 후배야 미안한데 이것도 좀 봐줄 수 있어? 다들 바빠서 그런데 편할 때 확인 부탁해~',
  '후배': '상대방이 보낸 내용을 그대로 붙여넣으세요.\n\n예) 선배님 저 이거 도저히 모르겠어서요… 내일까지 드려야 하는데 대신 좀 봐주시면 안 될까요?ㅠㅠ',
  '동기': '상대방이 보낸 내용을 그대로 붙여넣으세요.\n\n예) 검토해봤는데 전반적으로 좋아 보여요. 추가적으로 논의하면서 진행하시죠!',
  '타부서 동료': '상대방이 보낸 내용을 그대로 붙여넣으세요.\n\n예) 이 건은 저희 쪽 R&R은 아닌 것 같은데요, 먼저 정리해서 공유해주실 수 있을까요?',
  '클라이언트': '상대방이 보낸 내용을 그대로 붙여넣으세요.\n\n예) 이거 처음 얘기했던 거랑 좀 다른데요? 내일까지 다시 작업해서 보내주세요.',
  '민원인': '상대방이 보낸 내용을 그대로 붙여넣으세요.\n\n예) 지금 몇 시간째 기다리는 줄 아세요? 오늘 중으로 처리 안 되면 책임자 나오라고 하세요.',
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
const VALUE_OF = {
  '주니어(1~3년)': '주니어',
  '시니어(4~7년)': '시니어',
  '리드·팀장(8년+)': '리드·팀장',
};
const strip = (s) => s.replace(/^[^\p{L}\p{N}]+/u, '').trim();
const apiValue = (raw) => VALUE_OF[raw] || strip(raw);

/**
 * 상황 예시 카드("이런 상황인가요?") — 예시 문구를 담고 있을 뿐, 폼을
 * 채우지 않는다(applyPreset 참고). 골든 4종(weekend/aislop/pingpong/client)은
 * 텍스트를 자동화 테스트 코퍼스(src/data/golden.json)와 같은 문구로 쓰지만,
 * 이제는 순수 UI 예시 갤러리라서 골든 데이터에 종속되지 않는다 — 새 카드를
 * 추가할 때 테스트 픽스처를 함께 만들 필요가 없다.
 *
 * fits 는 배열이다 — 한 상황이 여러 관계에서 나올 수 있다.
 * "주말 업무 눈치보기"는 직속상사만이 아니라 임원·선배도 시킨다. 예전에
 * 값 하나만 받던 시절엔 관계 8종 중 6종이 매칭 카드 1장뿐이었다(실측).
 *
 * 라벨에서 관계 이름을 뺐다("상사의 주말 업무"→"주말 갑질"). fits 가
 * 배열이 된 이상 카드 하나를 특정 관계에 고정해 부르면 다른 매칭 관계와
 * 모순된다 — "후배의 업무 떠넘기기"가 상사 화면에도 뜨면 이상하다.
 *
 * 대신 "갑질" 로 통일했다 — 이건 관계 이름이 아니라 권력 우위를 이용한
 * 행위를 가리키는 말이라 여러 관계에 걸쳐도 어긋나지 않는다(영수증의
 * "주말 도둑형"·"벼락 마감형" 같은 빌런 네이밍과 같은 결). 다만 아래
 * 세 장(무지성 AI 복붙·R&R 핑퐁·대신 해달라는 요청)은 동기·타부서 동료·
 * 후배처럼 대등하거나 낮은 위치에서 나오는 상황이라 "갑질"을 붙이지
 * 않았다 — 후배가 갑질을 할 수는 없다.
 */
const PRESETS = [
  {
    id: 'weekend',
    emoji: '📅',
    fits: ['직속상사', '임원', '선배'],
    label: '주말 갑질',
    text: '박지훈님 주말에 미안한데, 월요일 오전에 대표님 보고가 잡혀서요. 시간 날 때 가볍게 한번 봐주시면 좋을 것 같아요. 급한 건 아닙니다!',
  },
  {
    id: 'aislop',
    emoji: '🤖',
    fits: ['동기', '타부서 동료', '후배'],
    label: '무지성 AI 복붙',
    text: '안녕하세요! 말씀해주신 사항에 대해 검토해보았습니다. 전반적으로 긍정적인 방향으로 보이며, 추가적인 논의를 통해 더 나은 결과를 도출할 수 있을 것으로 사료됩니다. 관련하여 지속적인 커뮤니케이션을 이어가면 좋겠습니다. 감사합니다.',
  },
  {
    id: 'pingpong',
    emoji: '🏓',
    fits: ['타부서 동료', '동기'],
    label: 'R&R 핑퐁',
    text: '이 건은 저희 쪽 R&R은 아닌 것 같은데요, 아무래도 기획 단계에서 정리되는 게 맞을 것 같습니다. 혹시 먼저 정리해서 공유해주실 수 있을까요? 저희는 그거 받고 나서 진행하겠습니다.',
  },
  {
    id: 'client',
    emoji: '👑',
    fits: ['클라이언트', '민원인'],
    label: '무상 재작업 갑질',
    text: '이거 처음 얘기했던 거랑 좀 다른데요? 저희가 원한 건 이게 아니었습니다. 내일까지 다시 작업해서 보내주세요. 추가 비용 얘기는 없던 걸로 알고 있습니다.',
  },
  {
    id: 'nightowl',
    emoji: '🌙',
    fits: ['직속상사', '선배'],
    label: '야간 갑질',
    text: '이렇게 늦은 시간에 톡해서 미안한데 자기 전에 하나만 부탁해도 될까요? 내일 오전 회의자료에 지난달 지표 슬라이드 하나만 껴주면 좋을 것 같아요. 급한 건 아니니까 편하실 때 봐주세요~',
  },
  {
    id: 'emailcreep',
    emoji: '✉️',
    fits: ['클라이언트', '민원인'],
    label: '수정 갑질',
    text: '안녕하세요, 지난번에 말씀드린 배너 시안 관련해서요. 죄송한데 색감을 조금만 더 밝게, 폰트도 살짝 키워주시고, 로고 위치도 다시 한 번 검토 부탁드려요. 예산 안에서 진행 가능할 것 같아서 말씀드립니다!',
  },
  {
    id: 'groupchat',
    emoji: '📢',
    fits: ['임원', '직속상사'],
    label: '단톡방 갑질',
    text: '다들 보고 계시죠? 이번 프로젝트 일정 늦어진 거 이 자리에서 한번 정리하고 갑시다. 담당자분 답변 부탁드려요.',
  },
  {
    id: 'passthebuck',
    emoji: '🤐',
    fits: ['직속상사', '임원'],
    label: '위임 갑질',
    text: '이 부분은 담당자님이 알아서 잘 판단해서 진행해 주세요. 저는 큰 그림만 보고 있어서 세부적인 건 믿고 맡기겠습니다. 결과만 잘 나오면 될 것 같아요!',
  },
  {
    id: 'juniordump',
    emoji: '🙇',
    fits: ['후배'],
    label: '대신 해달라는 요청',
    text: '선배님 죄송한데 저 이거 도저히 감이 안 잡혀서요… 내일까지 드려야 하는데 대신 좀 봐주시면 안 될까요? 선배님이 하시면 훨씬 빠를 것 같아서요ㅠㅠ',
  },
  {
    id: 'complainant',
    emoji: '😤',
    fits: ['민원인', '클라이언트'],
    label: '진상 갑질',
    text: '지금 몇 시간째 기다리는 줄 아세요? 당장 책임자 나오라고 하세요. 오늘 중으로 처리 안 되면 가만 안 있을 겁니다.',
  },
];

const state = {
  job: OPTIONS.job[0],
  level: OPTIONS.level[0],
  counterpart: OPTIONS.counterpart[0],
  goal: OPTIONS.goal[0],
  tone: OPTIONS.tone[1], // 보통맛 기본값
  // 지난 방문에서 고른 값이 있으면 그걸로 덮는다. 현재 선택지에 없는 값은
  // loadPrefs 가 걸러내므로 기본값이 유지된다.
  ...loadPrefs(OPTIONS),
};

/** 세션 메모리 토큰 맵 — localStorage 금지, 서버 전송 금지 */
let sessionTokenMap = Object.create(null);
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
  toneNote: $('tone-note'),
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
  el.hiddenContext.placeholder = HIDDEN_CONTEXT_PLACEHOLDER[who] || '';
  if (activePreset) return;
  el.message.placeholder = MESSAGE_PLACEHOLDER[who] || '';
}

/** 지금 고른 목적·말투가 답장을 어떻게 바꾸는지 칩 아래에 적어둔다. */
function updateChoiceNotes() {
  el.goalNote.textContent = GOAL_NOTE[apiValue(state.goal)] || '';
  el.toneNote.textContent = TONE_NOTE[apiValue(state.tone)] || '';
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
  const matches = PRESETS.filter((p) => p.fits.includes(who));
  const hiddenCount = PRESETS.length - matches.length;

  for (const p of PRESETS) {
    const btn = presetButtons.get(p.id);
    if (!btn) continue;
    const show = presetsExpanded || matches.includes(p);
    btn.hidden = !show;
  }

  el.presetHint.textContent = presetsExpanded
    ? '예시 — 전체 상황'
    : `예시 — ${who} 관련 상황 ${matches.length}가지`;

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

  el.message.value = p.text;
  onInput();

  el.message.focus({ preventScroll: true });
  el.message.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setHint('예시 메시지를 넣었습니다. 답장 설정을 고른 뒤 실행해 보세요.');
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
function renderCare(risk) {
  const serious = risk.score > 40; // 주의 이상
  el.care.classList.toggle('care-serious', serious);
  el.careWanted.hidden = risk.score <= 60; // 경계·심각에서만

  if (serious) {
    el.careTitle.textContent = '혼자 참지 않아도 됩니다';
    el.careBody.textContent =
      '이런 신호가 반복되면 기록으로 남겨 두세요. 사내 고충처리나 외부 상담을 이용할 때 근거가 됩니다. '
      + "'나의 방어 기록'에 이 브라우저에만 남습니다.";
  } else {
    el.careTitle.textContent = '이번 건은 정상 범위입니다';
    el.careBody.textContent =
      "같은 상대와의 기록이 쌓이면 흐름이 보입니다. '나의 방어 기록'에서 확인해 보세요. "
      + '혼자 감당하기 어려운 일이 생기면 아래 상담도 무료로 이용할 수 있습니다.';
  }
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
  // 배지는 개발 모드가 아니라 "이 결과가 어떻게 나왔는지"를 알리는 사용자 문구다.
  // 예전엔 LIVE/MOCK/LOCAL 을 그대로 노출했는데, MOCK 은 정상 폴백인데도
  // "아직 안 만들어진 데모"로 읽히고 LIVE 는 생방송으로 읽힐 소지가 있었다.
  // 상세(모델명·비용·폴백 사유)는 title 툴팁에 그대로 남는다.
  el.modeBadge.textContent = MODE_BADGE[meta.mode] || meta.mode;
  el.modeBadge.title = meta.note || `model: ${meta.model}`;

  animateScore(risk.score);
  renderCare(risk);
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

/** 모호성 유형별 한 줄 풀이 — 값과 1:1 이다(normalize.js AMBIGUITY_VALUES). */
const AMBIGUITY_HINT = {
  'R&R 미지정': '담당자가 정해지지 않음',
  '범위 불명': '어디까지인지 불명확',
  '기한 불명': '언제까지인지 없음',
  '없음': '범위·기한 명확',
};

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
      // 표시되는 값 자체가 풀이 없이는 안 읽힌다 — 특히 'R&R 미지정' 은
      // 직군에 따라 아예 모르는 말이고 화면 어디에도 설명이 없었다.
      // 기존 하위 문구는 표시된 값과 무관한 "기한 명시됨/없음" 이라
      // '범위 불명' 옆에 '기한 명시됨' 이 붙는 식으로 오히려 헷갈렸다.
      sub: AMBIGUITY_HINT[xray.ambiguityType] || '',
    },
    {
      // 이 값(aiSlopScore)이 실제로 재는 건 "누가 썼나"가 아니라 "알맹이(숫자·기한·
      // 산출물·담당)가 몇 % 비었나"다. 예전 이름 'AI 복붙 냄새'는 AI 를 지목해서,
      // 사람이 쓴 영혼 없는 메일도 AI 탓으로 읽히게 만들었다. 이름을 정의에 맞춘다.
      name: '내용 공허도',
      value: `${xray.aiSlopScore}%`,
      extra: pips(Math.round(xray.aiSlopScore / 20), 5),
      sub: xray.aiSlopScore >= 60 ? '알맹이 거의 없음' : '구체적 내용 있음',
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
      <thead><tr><th>내용 공허도 지표</th><th>검출</th><th>0~1</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${cliches}
    <p class="evidence-formula">
      점수 = 권력 비대칭(${xray.powerAsymmetry}×8) + 긴급도(${xray.urgencyType === '없음' ? 0 : 20})
      + 모호성(${xray.ambiguityType === '없음' ? 0 : 20}) + 공허도×20 = <b>${risk.score}</b>
    </p>
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
    ? 'ℹ️ 캐시된 예시 답장입니다 — 상황 카드 원본 그대로일 때만 나오는 미리 준비된 결과예요.'
    : 'ℹ️ 지금은 규칙 기반 예시 답장입니다(모델 미연동). 목적·말투에 따라 갈라지긴 하지만 메시지 내용을 세세히 읽고 쓰진 않아요 — 그대로 보내기보다 초안으로 참고해 다듬어 주세요.';
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
  const modal = [el.receiptModal, el.historyModal].find((m) => !m.hidden);
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
  openModal(el.receiptModal);
}

function closeReceiptModal() {
  closeModal(el.receiptModal);
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
      .then(() => toBlob(el.receiptCard, { pixelRatio: 2, cacheBust: true }))
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
    el.historyTop.textContent = s.topVillain || '—';
  }

  el.historyList.innerHTML = history
    .map((e) => {
      const date = new Date(e.ts);
      const dateStr = `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
      return `<div class="history-item">
        <span class="history-item-score" style="color:${LEVEL_COLOR[e.level] || 'var(--text-dim)'}">${escapeHtml(e.score)}</span>
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
document.addEventListener('keydown', (e) => {
  trapTabInModal(e);
  if (e.key !== 'Escape') return;
  if (!el.receiptModal.hidden) closeReceiptModal();
  if (!el.historyModal.hidden) closeHistoryModal();
});
onInput();
