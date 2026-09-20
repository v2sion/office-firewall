/**
 * 알맹이 결여율 신호 추출기 (규칙 — AI 아님)
 * 여기서 나온 신호를 score.js 가 Social Risk Index 로 환산한다.
 */

import { NIGHT_START_HOUR, NIGHT_END_HOUR } from './legal-basis.js';

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

/**
 * 본문에 적힌 시각을 24시간제로 모은다.
 *
 * 예전에는 "22시"와 "23시"만 문자열로 찾았다. 그래서 **법이 야간근로라고
 * 정한 구간의 대부분을 놓쳤다** — "오후 10시", "밤 11시", "새벽 2시",
 * "00:30" 이 전부 통과했다. 근로기준법 제56조 제3항이 오후 10시부터 다음 날
 * 오전 6시까지를 야간근로로 정의하고 있으므로, 그 구간을 실제로 덮는다.
 *
 * **확실할 때만 센다.** "9시"처럼 오전·오후 표시가 없는 시각은 넣지 않는다 —
 * 추측해서 야간으로 몰면 정상 업무 메시지에 경보가 붙는다.
 */
const CLOCK_RE = /(오전|오후|새벽|밤|아침|저녁|정오)?\s*(\d{1,2})\s*(?::\s*\d{2}|시)/g;

export function clockHours(text) {
  const out = [];
  CLOCK_RE.lastIndex = 0;
  let m;
  while ((m = CLOCK_RE.exec(text))) {
    const marker = m[1];
    const n = Number(m[2]);
    if (n > 24) continue;
    // 표시가 없어도 24시간제로만 읽히는 표기는 센다: "23:30" 의 콜론 형식과
    // 13 이상의 숫자("22시" 는 오전·오후를 따질 것도 없이 밤 10시다).
    const explicit24 = !marker && (/:/.test(m[0]) || (n >= 13 && n <= 24));
    if (marker === '오전' || marker === '아침') out.push(n === 12 ? 0 : n);
    else if (marker === '새벽') out.push(n === 12 ? 0 : n);
    else if (marker === '오후' || marker === '저녁') out.push(n === 12 ? 12 : (n % 12) + 12);
    else if (marker === '밤') out.push(n === 12 ? 0 : n >= 9 ? n + 12 : n);
    else if (explicit24) out.push(n === 24 ? 0 : n);
    // 표시가 없는 "9시" 는 오전인지 오후인지 알 수 없으므로 세지 않는다.
  }
  return out.filter((h) => h >= 0 && h < 24);
}

/**
 * 지금이어야 하는 **사유가 본문에 적혀 있는가.**
 *
 * 고용노동부 매뉴얼과 행정해석은 근무시간 외 연락을 두고 "업무 관련성,
 * 필요성, **긴급성**, 연락의 빈도와 시간"을 종합해 판단하라고 한다. 즉
 * 긴급성은 위험을 키우는 요소가 아니라 **정당화하는 요소**다. 근로기준법
 * 제56조도 야간근로를 금지하지 않는다 — 가산수당 대상으로 정할 뿐이다.
 *
 * 그런데 우리 엔진은 야간·주말이면 무조건 20점을 얹고 있었다. 실측하면
 * 이렇게 나왔다.
 *
 *   "밤 11시에 죄송합니다. 결제 서버 장애로 고객 결제가 전부 실패하고
 *    있습니다. 로그 확인 가능하실까요?"                      → 52점
 *   "밤 11시인데 미안해요. 그 자료 지금 한번 봐줄 수 있어요?"  → 52점
 *
 * 앞은 정당한 장애 대응 연락이고 뒤는 아니다. 둘을 같은 점수로 내보내면
 * 그건 판정이 아니라 시계 보기다.
 *
 * **좁게 잡는다.** 여기 드는 것은 지금 대응하지 않으면 손해가 커지는 사유다.
 * "대표님 보고가 잡혀서", "내일 오전에 쓸 거라" 같은 **내부 일정**은 사유가
 * 아니다 — 그건 보내는 쪽의 편의이지 받는 쪽이 밤에 일할 이유가 아니고,
 * 매뉴얼이 말하는 긴급성도 그런 뜻이 아니다.
 */
const URGENCY_JUSTIFIER =
  /(장애|먹통|다운|중단|멈춰|마비|사고|유출|해킹|보안\s*사고|긴급\s*복구|오류가|에러가|결제가\s*(안|실패)|서비스가\s*(안|중단)|고객\s*(피해|불편|이탈)|안전|부상|응급|리콜|법적\s*기한|제출\s*마감이\s*오늘)/;

/**
 * 부정형은 사유가 아니다.
 *
 *   "밤 12시인데 미안해요. **장애 없이** 잘 돌아가는지 그냥 한번 봐줄래요?"
 *
 * 단어만 세면 이 문장이 장애 대응 연락으로 잡힌다. 사유를 인정하는 쪽은
 * 점수를 **깎는** 방향이라, 오탐이 곧 과소경보가 된다. 사유 단어 바로 뒤에
 * 부정이 오면 먼저 지운 다음에 찾는다.
 */
const NEGATED_JUSTIFIER = /(장애|오류|에러|사고|중단|문제|이슈)\s*(?:는|은|가|이)?\s*(없|아니|아닌)\S*/g;

export function hasUrgencyJustification(text) {
  return URGENCY_JUSTIFIER.test(String(text ?? '').replace(NEGATED_JUSTIFIER, ''));
}

/** 근로기준법 제56조 제3항의 야간근로 시간대에 드는가 (22:00~05:59) */
export function isLegalNightHour(hour) {
  return hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR;
}

/**
 * 요청 시점의 긴급성 유형 (규칙 기반).
 *
 * 세 값의 근거는 전부 근로기준법이다(src/lib/legal-basis.js 참고).
 *   · 주말 침범 — 제55조(휴일). 유급휴일에 대응을 요구한다.
 *   · 야간 침범 — 제56조 제3항. 오후 10시~다음 날 오전 6시.
 *   · 당일 마감 — 제50조·제53조. 24시간 안의 결과물 요구는 정규 근로시간
 *     안에서 소화할 수 없어 연장근로를 전제한다.
 */
export function detectUrgency(t) {
  if (/(주말|토요일|일요일|토욜|일욜)/.test(t)) return '주말 침범';
  // 어휘로 드러나는 야간 신호
  if (/(새벽|퇴근\s*후|야근|자정|늦은\s*시간)/.test(t)) return '야간 침범';
  // 시각으로 드러나는 야간 신호 — 법정 구간(22:00~05:59)에 드는 시각이 있으면
  if (clockHours(t).some(isLegalNightHour)) return '야간 침범';
  // "오늘까지"만 문자열로 찾던 탓에 **시각이 붙으면 전부 놓쳤다** —
  // "오늘 18시까지", "금일 15시까지", "오늘 6시까지"가 모두 통과했다.
  // 고용노동부 코퍼스에서 잡힌 구멍이다. 날짜어와 "까지" 사이에 짧은 시각
  // 표기 하나까지만 허용한다(공백을 넘지 않으므로 "오늘 회의에서 … 다음 주까지"
  // 같은 문장은 걸리지 않는다).
  if (/(오늘|금일)\s*\S{0,5}\s*까지/.test(t)) return '당일 마감';
  if (/(오늘\s*중|내일까지|당일|금일\s*중|퇴근\s*전까지)/.test(t)) return '당일 마감';
  return '없음';
}

/** 무엇이 비어 있는지에 대한 모호성 유형 (규칙 기반) */
/** 범위가 실제로 비어 있음을 가리키는 표현 — 알맹이가 있어도 모호하다. */
/*
 * 기준을 대지 않고 다시 하라고 요구하는 표현.
 *
 * 커뮤니티 사연 코퍼스(test/fixtures/community-corpus.json)에서 드러난 구멍이다.
 *   "숫자가 좀 이상한 것 같아요. 내일 오전에 쓸 거라 지금 한 번만 봐줄 수 있을까요?"
 * 어느 숫자가 왜 이상한지, 무엇이 맞는 상태인지가 없다. 그런데 **기한이 적혀
 * 있다는 이유로** 아래 WEAK 경로의 게이트에 막혀 "모호성 없음"이 나왔다.
 * 기한이 있다는 사실은 산출물이 특정됐다는 뜻이 아니다 — 그래서 이 표현들은
 * 게이트를 타지 않는 STRONG 쪽에 둔다.
 *
 * 고용노동부 매뉴얼이 말하는 "업무상 필요성이 인정되기 어려운 행위"가
 * 업무 메시지에서 드러나는 전형적인 형태이기도 하다.
 */
const SCOPE_VAGUE_STRONG = /(알아서|적당히|대략|보완해서|다시 작업|이상한\s*것\s*같|(?:뭔가|어딘가)\s*(?:좀\s*)?(?:이상|아닌))/;
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
    urgencyJustified: hasUrgencyJustification(maskedText),
    ...spec,
    avoidsDecision: avoidsDecision(maskedText, spec),
  };
}
