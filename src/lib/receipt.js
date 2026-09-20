/**
 * 오피스 방어 영수증 — 공유용 카드에 들어갈 값을 계산한다 (가이드 §3.3).
 *
 * 원칙: 카드에는 원문·실명·탐지된 세부값(clicheHits, subtext 등)이 절대 들어가지
 * 않는다. 여기서 다루는 건 카테고리(직군·연차·빌런 유형·방어 모드)와 이미
 * score.js 가 계산해 둔 위험 지수뿐이다.
 *
 * 한때 "막아낸 야근 / 지킨 멘탈 / 사내 정치 리스크"를 함께 계산했다. 결정론적
 * 이긴 했지만 **근거가 화면 어디에도 없었고**, 무엇보다 답장과 무관했다 —
 * 실제로 답장을 보냈는지, 셋 중 무엇을 골랐는지와 관계없이 점수와 말투만으로
 * 나오는 값이라 아무것도 하지 않아도 "+5.5 Hours"가 찍혔다. "계산 과정을 그대로
 * 펼쳐 보여준다"는 이 서비스의 주장과 정면으로 어긋나서 카드에서 걷어냈다.
 * 면책 문구를 달아야 했다는 것 자체가 신호였다.
 */

const WHO_LABEL = {
  '직속상사': '상사',
  '임원': '임원',
  '선배': '선배',
  '후배': '후배',
  '동기': '동기',
  '타부서 동료': '동료',
  '클라이언트': '클라이언트',
  '민원인': '민원인',
};

/**
 * "상대 빌런 유형" — xray 신호(이미 규칙으로 계산된 값)로부터 결정하는
 * 순수 함수. AI 가 새로 판단하지 않는다.
 */
export function villainType(xray, context) {
  const who = WHO_LABEL[context?.counterpart] || '상대';
  const { urgencyType, ambiguityType, aiSlopScore, avoidsDecision } = xray || {};

  // aiSlopScore 가 실제로 재는 건 "누가 썼나"가 아니라 "알맹이가 몇 % 비었나"다
  // (score.js·스탯카드의 '내용 공허도'와 같은 값). '복붙'이라는 행동 묘사는
  // 남기되 AI 단정만 뺐다 — 사람이 쓴 성의 없는 메일에 붙어도 억울하지 않다.
  if ((aiSlopScore ?? 0) >= 60) return `영혼 없이 복붙형 ${who}`;
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

/** "적용 방어 모드" — 목적×말투 세기 조합을 사람이 읽는 라벨로. */
export function defenseModeLabel(goal, tone) {
  const emoji = GOAL_EMOJI[goal] || '🛡️';
  const adj = TONE_ADJ[tone] || '담백한';
  return `${emoji} ${adj} ${goal || '방어'}`;
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
  return {
    issuedAt: formatIssuedAt(now),
    job: `${context?.job || '-'} (${context?.level || '-'})`,
    villain: villainType(xray, context),
    score: risk?.score ?? 0,
    scoreLabel: risk?.label || '',
    defenseMode: defenseModeLabel(context?.goal, context?.tone),
  };
}
