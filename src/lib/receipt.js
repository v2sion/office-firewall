/**
 * 오피스 방어 영수증 — 공유용 카드에 들어갈 값을 계산한다 (가이드 §3.3).
 *
 * 원칙: 카드에는 원문·실명·탐지된 세부값(clicheHits, subtext 등)이 절대 들어가지
 * 않는다. 여기서 다루는 건 카테고리(직군·연차·빌런 유형·방어 모드)와 이미
 * score.js 가 계산해 둔 위험 지수뿐이다.
 *
 * "절약한 야근 시간 / 보존한 멘탈 에너지 / 사내 정치 리스크"는 실측치가 아니라
 * "심리적 체감 지표"다 — 방어 행동을 취한 뒤 체감할 수 있는 정도를 참고로
 * 환산한 값이라는 뜻이다("재미로 보는 지표"보다 EAP 심리상담 링크가 함께
 * 붙는 이 카드의 맥락에 더 맞는 표현으로 다듬었다). 감으로 매번 다르게
 * 부르는 게 아니라 risk.score·xray·context 로부터 결정론적으로 계산해,
 * 같은 입력이면 항상 같은 값이 나오게 했다("측정하지 않은 숫자를 약속하지
 * 않는다"는 원칙에 최대한 맞추기 위한 절충 — 카드에도 "심리적 체감 지표"
 * 라는 프레이밍을 섹션 라벨과 하단 문구로 함께 표시한다).
 */

const WHO_LABEL = {
  '직속상사': '상사',
  '타부서 동료': '동료',
  '팀원(AI복붙)': '동료',
  '클라이언트': '클라이언트',
};

/**
 * "상대 빌런 유형" — xray 신호(이미 규칙으로 계산된 값)로부터 결정하는
 * 순수 함수. AI 가 새로 판단하지 않는다.
 */
export function villainType(xray, context) {
  const who = WHO_LABEL[context?.counterpart] || '상대';
  const { urgencyType, ambiguityType, aiSlopScore, avoidsDecision } = xray || {};

  if ((aiSlopScore ?? 0) >= 60) return `AI 복붙형 ${who}`;
  if (urgencyType === '주말 침범') return `주말 도둑형 ${who}`;
  if (urgencyType === '야간 침범') return `야간 침입형 ${who}`;
  if (urgencyType === '당일 마감') return `벼락 마감형 ${who}`;
  if (ambiguityType === 'R&R 미지정') return `책임 전가형 ${who}`;
  if (ambiguityType === '범위 불명' && avoidsDecision) return `책임 회피형 ${who}`;
  if (ambiguityType === '범위 불명') return `요구 모호형 ${who}`;
  if (ambiguityType === '기한 불명') return `기한 불명형 ${who}`;
  return `평범한 ${who}`;
}

const GOAL_EMOJI = { '칼차단': '🛑', '시간벌기': '⏳', '공넘기기': '🏓', '관계보존': '🕊️' };
const TONE_ADJ = { '매운맛': '여지없는', '보통맛': '담백한', '순한맛': '정중한' };

/** "적용 방어 모드" — 목적×완곡도 조합을 사람이 읽는 라벨로. */
export function defenseModeLabel(goal, tone) {
  const emoji = GOAL_EMOJI[goal] || '🛡️';
  const adj = TONE_ADJ[tone] || '담백한';
  return `${emoji} ${adj} ${goal || '방어'}`;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/** 긴급도 유형별 "기본 절약 시간" — 침범 강도가 클수록 크다. */
const BASE_HOURS_BY_URGENCY = {
  '주말 침범': 6,
  '야간 침범': 3,
  '당일 마감': 4,
  '없음': 1.5,
};

/** "절약한 주말 야근 시간" — 위험 지수가 높을수록(=막았을 때 이득이 클수록) 늘어난다. */
export function hoursSaved(score, urgencyType) {
  const base = BASE_HOURS_BY_URGENCY[urgencyType] ?? BASE_HOURS_BY_URGENCY['없음'];
  const hours = base * (clamp(score, 0, 100) / 100);
  return Math.max(0.5, Math.round(hours * 10) / 10);
}

/** "보존한 멘탈 에너지" — score=92 대입 시 가이드 예시(+85 HP)와 일치하도록 계수를 맞췄다. */
export function mentalHpSaved(score) {
  return clamp(Math.round(30 + 0.6 * clamp(score, 0, 100)), 10, 99);
}

/**
 * "사내 정치 리스크" — 매운맛은 앱이 자체적으로 경고하는 "관계 비용"과
 * 같은 맥락이라, 그 신호를 그대로 재사용한다(새로 지어낸 숫자가 아니다).
 */
export function politicalRisk(tone) {
  if (tone === '매운맛') return { percent: 15, note: '약간의 긴장 감수' };
  if (tone === '순한맛') return { percent: 0, note: '평판 유지' };
  return { percent: 5, note: '평판 유지' };
}

/** ISSUED AT 타임스탬프 포맷 (로컬 타임존 기준). */
export function formatIssuedAt(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 영수증 카드에 필요한 값을 전부 계산한다. 원문·실명·clicheHits·subtext 등은
 * 절대 참조하지 않는다 — 넘겨받지도 않는다(호출부에서 xray 전체를 넘기지만
 * 이 함수가 실제로 읽는 필드는 urgencyType/ambiguityType/aiSlopScore/avoidsDecision 뿐).
 *
 * @param {object} xray  runAnalyze/buildResult 의 xray
 * @param {object} risk  runAnalyze/buildResult 의 risk (score 포함)
 * @param {object} context  job/level/counterpart/goal/tone
 * @param {Date} [now]
 */
export function buildReceiptData(xray, risk, context, now = new Date()) {
  const risk_ = politicalRisk(context?.tone);
  return {
    issuedAt: formatIssuedAt(now),
    job: `${context?.job || '—'} (${context?.level || '—'})`,
    villain: villainType(xray, context),
    score: risk?.score ?? 0,
    scoreLabel: risk?.label || '',
    defenseMode: defenseModeLabel(context?.goal, context?.tone),
    hoursSaved: hoursSaved(risk?.score ?? 0, xray?.urgencyType),
    mentalHp: mentalHpSaved(risk?.score ?? 0),
    politicalRiskPercent: risk_.percent,
    politicalRiskNote: risk_.note,
  };
}
