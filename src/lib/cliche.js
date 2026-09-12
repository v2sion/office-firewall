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
export const DECISION_AVOIDANCE = [
  '검토해보', '검토 후', '논의해서', '논의 후', '확인 후', '확인해보고',
  '조율해서', '협의해서', '정리되는 게 맞', '받고 나서', '추후', '차차',
  '것 같', '보는 게 좋을',
];

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

export function avoidsDecision(text) {
  const t = toJamo(text);
  return DECISION_AVOIDANCE.some((p) => t.includes(toJamo(p)));
}

/**
 * 마스킹된 본문에서 결여율 신호를 한 번에 추출한다.
 * @param {string} maskedText
 */
export function extractSubstanceSignals(maskedText) {
  return {
    clicheHits: findCliches(maskedText),
    sentenceCount: countSentences(maskedText),
    hasNumbers: hasNumbers(maskedText),
    hasDeadline: hasDeadline(maskedText),
    avoidsDecision: avoidsDecision(maskedText),
  };
}
