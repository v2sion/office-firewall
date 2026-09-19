/**
 * 알맹이 결여율 신호 추출기 (규칙 — AI 아님)
 * 여기서 나온 신호를 score.js 가 Social Risk Index 로 환산한다.
 */

export const CLICHES = [
  '시간 될 때', '시간 날 때', '가볍게', '간단히', '빠르게',
  '급한 건 아니', '잠깐만', '조율해서', '챙겨주세요',
  '잘 부탁', '적극 검토', '긍정적인 방향', '사료됩니다',
  '지속적인 커뮤니케이션', '추가적인 논의',
];

/** 의사결정 회피 패턴 (결여율 3번 지표 · 컷 우선순위 1순위) */
/**
 * 의사결정 회피 마커.
 *
 * STRONG 은 그 자체로 "지금 정하지 않겠다"는 뜻이라 알맹이가 있어도 회피다.
 * WEAK 은 **완충어와 구별되지 않는다** — "좋을 것 같아요"는 결정을 미루는
 * 말이 아니라 부탁을 부드럽게 만드는 한국어 관용구다. 그래서 WEAK 은
 * 알맹이(수치·기한)가 없을 때만 회피 신호로 센다. 아래 SUBSTANCE_GATE 주석 참고.
 */
export const DECISION_AVOIDANCE_STRONG = [
  '검토해보', '검토 후', '논의해서', '논의 후', '확인 후', '확인해보고',
  '조율해서', '협의해서', '정리되는 게 맞', '받고 나서', '추후', '차차',
];
export const DECISION_AVOIDANCE_WEAK = ['것 같', '보는 게 좋을'];

/** @deprecated 강·약 구분 이전의 통합 목록 — 외부 참조 호환용으로만 남긴다. */
export const DECISION_AVOIDANCE = [...DECISION_AVOIDANCE_STRONG, ...DECISION_AVOIDANCE_WEAK];

/** 숫자(마스킹 토큰 내부 숫자는 제외) */
const TOKEN_STRIP = /\{\{[A-Z]+_\d+\}\}/g;
const NUMBER_RE = /\d/;

/** 날짜·시각이 "기한"으로 명시된 경우만 인정한다 ("월요일 오전에 보고가 있어서" 는 기한이 아니다) */
const DEADLINE_RES = [
  /\d{1,2}\s*\/\s*\d{1,2}/,                       // 9/15
  /\d{4}\s*[-.]\s*\d{1,2}\s*[-.]\s*\d{1,2}/,      // 2026-09-15
  /\d{1,2}\s*월\s*\d{1,2}\s*일/,                  // 9월 15일
  /\d{1,2}\s*:\s*\d{2}/,                          // 18:00
  /\d{1,2}\s*시(\s*\d{1,2}\s*분)?/,               // 14시
  /(오늘|내일|모레|금일|익일|당일|이번\s*주|금주|차주)[^.!?\n]{0,8}까지/,
];

/**
 * 한글 음절은 조합 문자라서 "아니" 가 "아닙니다" 의 부분문자열이 아니다.
 * 사전 매칭 전에 NFD(자모 분해)로 정규화하면 어간 단위로 잡힌다.
 */
export const toJamo = (s) => String(s).normalize('NFD');

export function containsKo(haystack, needle) {
  return toJamo(haystack).includes(toJamo(needle));
}

/** AI 슬롭(무내용 정형구) 마커 — 사람이 쓰는 구어체 클리셰와는 구분한다 */
export const AI_SLOP_MARKERS = [
  '사료됩니다', '전반적으로', '긍정적인 방향', '추가적인 논의', '지속적인 커뮤니케이션',
  '말씀해주신', '관련하여', '도출할 수 있을', '다음과 같습니다', '검토해보았습니다',
  '적극적으로 검토', '원활한 진행', '유기적으로',
];

/** 문장 수 (종결부호 기준, 최소 1) */
export function countSentences(text) {
  const parts = String(text)
    .split(/[.!?\n。]+|다\s*$/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
  return Math.max(1, parts.length);
}

export function findCliches(text) {
  const t = toJamo(text);
  return CLICHES.filter((c) => t.includes(toJamo(c)));
}

export function hasNumbers(text) {
  return NUMBER_RE.test(String(text).replace(TOKEN_STRIP, ''));
}

export function hasDeadline(text) {
  const t = String(text).replace(TOKEN_STRIP, '');
  return DEADLINE_RES.some((re) => re.test(t));
}

/**
 * SUBSTANCE_GATE — 이 파일 전체를 관통하는 원칙
 *
 * 완곡어(가볍게·한번만·좋을 것 같아요)는 **공허함의 대리 지표**일 뿐이다.
 * 산출물·수치·기한이 실제로 적혀 있으면 그 대리 지표는 무효다. 완곡어는
 * 예의이지 알맹이 없음이 아니다.
 *
 * 게이팅 전에는 같은 요청을 말투만 바꿔 넣으면 점수가 16점(건조) ↔ 65점(정중)
 * 으로 갈렸다 — 산출물·기한·규격이 전부 동일한데도. "정중할수록 위험하다"는
 * 역설이 생기고, 한국 직장 메시지 상당수가 정중체라 거짓양성이 쏟아진다.
 *
 * 반대로 알맹이가 **없는** 메시지에서는 게이트가 열리지 않으므로, 완곡어로
 * 포장된 주말 요구(골든 ①)는 그대로 고위험으로 남는다. 이 제품의 논지를
 * 지키면서 거짓양성만 걷어내는 지점이 여기다.
 *
 * @param {object} signals hasNumbers / hasDeadline
 */
export function hasSubstance(signals) {
  return Boolean(signals?.hasNumbers || signals?.hasDeadline);
}

/**
 * @param {string} text
 * @param {object} [signals] hasNumbers/hasDeadline. 주면 약한 마커를 게이팅한다.
 */
export function avoidsDecision(text, signals) {
  const t = toJamo(text);
  if (DECISION_AVOIDANCE_STRONG.some((p) => t.includes(toJamo(p)))) return true;
  if (signals && hasSubstance(signals)) return false; // 완충어는 회피가 아니다
  return DECISION_AVOIDANCE_WEAK.some((p) => t.includes(toJamo(p)));
}

/** 요청 시점의 긴급성 유형 (규칙 기반) */
export function detectUrgency(t) {
  if (/(주말|토요일|일요일|토욜|일욜)/.test(t)) return '주말 침범';
  if (/(새벽|밤\s*\d|퇴근\s*후|야근|자정|23시|22시|늦은\s*시간)/.test(t)) return '야간 침범';
  if (/(오늘\s*중|오늘까지|내일까지|당일|금일\s*중|퇴근\s*전까지)/.test(t)) return '당일 마감';
  return '없음';
}

/** 무엇이 비어 있는지에 대한 모호성 유형 (규칙 기반) */
/** 범위가 실제로 비어 있음을 가리키는 표현 — 알맹이가 있어도 모호하다. */
const SCOPE_VAGUE_STRONG = /(알아서|적당히|대략|보완해서|다시 작업)/;
/** 완충어와 구분되지 않는 표현 — 알맹이가 없을 때만 모호성으로 센다. */
const SCOPE_VAGUE_WEAK = /(가볍게|간단히|한번\s*봐|전반적으로)/;

export function detectAmbiguity(t, signals) {
  if (/(R&R|알앤알|롤앤롤|담당이|누가 하|소관|저희 쪽은)/i.test(t)) return 'R&R 미지정';
  if (SCOPE_VAGUE_STRONG.test(t)) return '범위 불명';
  // "가볍게 한번 봐주세요" 라도 산출물·기한이 적혀 있으면 범위가 비어 있지 않다.
  if (SCOPE_VAGUE_WEAK.test(t) && !hasSubstance(signals)) return '범위 불명';
  if (!signals.hasDeadline && /(부탁|주세요|해주실|요청|보내주)/.test(t)) return '기한 불명';
  return '없음';
}

/** AI 슬롭(무내용 정형구) 밀도 점수 (규칙 기반) */
export function aiSlopScore(t, signals) {
  const hits = AI_SLOP_MARKERS.filter((m) => containsKo(t, m)).length;
  if (!hits) return 0;
  const base = hits * 15;
  const bonus = (!signals.hasNumbers && !signals.hasDeadline ? 20 : 0) + (signals.avoidsDecision ? 10 : 0);
  return Math.min(100, base + bonus);
}

/**
 * 마스킹된 본문에서 결여율 신호를 한 번에 추출한다.
 * @param {string} maskedText
 */
export function extractSubstanceSignals(maskedText) {
  const spec = { hasNumbers: hasNumbers(maskedText), hasDeadline: hasDeadline(maskedText) };
  return {
    clicheHits: findCliches(maskedText),
    sentenceCount: countSentences(maskedText),
    ...spec,
    avoidsDecision: avoidsDecision(maskedText, spec),
  };
}
