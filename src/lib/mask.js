/**
 * 4단계 선-마스킹 / 역치환 (설계원칙 1.2 — 원문을 AI에 먼저 보내지 않는다)
 *
 * - 마스킹은 전적으로 브라우저에서 수행한다.
 * - 토큰 맵은 호출자가 받아 세션 메모리(JS 객체)에만 보관한다.
 *   localStorage 저장 금지, 서버 전송 금지.
 * - 같은 값은 항상 같은 번호로 매핑한다(deterministic).
 * - unmask(mask(x).maskedText, map) === x 를 항상 만족한다(round-trip 무결성).
 */

export const PATTERNS = {
  EMAIL: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  PHONE: /01[016789]-?\d{3,4}-?\d{4}/g,
  ACCOUNT: /\b\d{2,6}-\d{2,6}-\d{2,8}\b/g,
  AMOUNT: /\d{1,3}(?:,\d{3})+\s?(?:원|만원|억|억원)|\d+\s?(?:만원|억원|억)/g,
  PERSON: /([가-힣]{2,4})(님|팀장님|책임님|프로님|매니저님|선임님|수석님|대리님|과장님|차장님|부장님|이사님|대표님)/g,
  QUOTED: /["'“”‘’]([^"'“”‘’]{2,30})["'“”‘’]|「([^「」]{2,30})」|『([^『』]{2,30})』/g,
};

/** 이미 마스킹 토큰처럼 생긴 문자열(원문에 우연히 존재하면 round-trip 이 깨진다) */
const TOKEN_LIKE = /\{\{[A-Z]+_\d+\}\}/g;
const TOKEN_RE = /\{\{(LITERAL|PERSON|PHONE|EMAIL|AMOUNT|ACCOUNT|ORG|PROJECT)_(\d+)\}\}/g;

const SEP = String.fromCharCode(1);

/**
 * 이름이 아니라 직위·역할을 가리키는 말 — 마스킹하지 않는다.
 * ("대표님 보고" 를 {{PERSON_2}}님으로 지우면 권력 비대칭 신호까지 함께 사라진다)
 */
const ROLE_WORDS = new Set([
  '대표', '사장', '회장', '부사장', '전무', '상무', '이사', '본부장', '실장', '소장',
  '팀장', '부장', '차장', '과장', '대리', '주임', '선임', '책임', '수석', '매니저',
  '담당자', '고객', '사수', '선배', '후배', '동료', '기획자', '개발자', '디자이너',
]);

/** 날짜(2026-09-12)를 계좌번호로 오탐하지 않도록 걸러낸다 */
function looksLikeDate(s) {
  return /^(19|20)\d{2}-\d{1,2}-\d{1,2}$/.test(s);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {string} text 원문
 * @param {{ customTerms?: string[] }} [opts] 사용자 지정 조직/프로젝트 고유명
 * @returns {{ maskedText: string, map: Record<string,string>, counts: Record<string,number> }}
 */
export function mask(text, opts = {}) {
  const customTerms = (opts.customTerms || []).filter((t) => t && t.trim().length >= 2);

  /** @type {Record<string,string>} 토큰 -> 원래 값 */
  const map = Object.create(null);
  /** @type {Record<string,string>} `TYPE|값` -> 토큰 (같은 값 = 같은 번호) */
  const seen = Object.create(null);
  const counters = Object.create(null);

  const tokenFor = (type, value) => {
    const key = type + SEP + value;
    if (seen[key]) return seen[key];
    counters[type] = (counters[type] || 0) + 1;
    const token = `{{${type}_${counters[type]}}}`;
    seen[key] = token;
    map[token] = value;
    return token;
  };

  let out = String(text);

  // 0단계: 원문에 이미 존재하는 토큰 형태 문자열을 보호(round-trip 무결성)
  out = out.replace(TOKEN_LIKE, (m) => tokenFor('LITERAL', m));

  // 2단계: 전화번호 · 이메일 (이메일 먼저 — 전화번호 패턴이 이메일 내부를 먹지 않도록)
  out = out.replace(PATTERNS.EMAIL, (m) => tokenFor('EMAIL', m));
  out = out.replace(PATTERNS.PHONE, (m) => tokenFor('PHONE', m));

  // 3단계: 계좌번호 · 금액
  out = out.replace(PATTERNS.ACCOUNT, (m) => (looksLikeDate(m) ? m : tokenFor('ACCOUNT', m)));
  out = out.replace(PATTERNS.AMOUNT, (m) => tokenFor('AMOUNT', m));

  // 4단계: 조직·프로젝트 고유명 (사용자 지정어 → 따옴표 안 명사)
  for (const term of customTerms) {
    out = out.replace(new RegExp(escapeRegExp(term.trim()), 'g'), (m) => tokenFor('ORG', m));
  }
  out = out.replace(PATTERNS.QUOTED, (full, g1, g2, g3) => {
    const inner = g1 ?? g2 ?? g3;
    if (!inner || /\{\{[A-Z]+_\d+\}\}/.test(inner)) return full;
    return full.replace(inner, tokenFor('PROJECT', inner));
  });

  // 1단계: 사람 이름 (호칭은 남기고 이름만 치환 — "{{PERSON_1}}님" 형태가 유지된다)
  out = out.replace(PATTERNS.PERSON, (full, name, honorific) =>
    (ROLE_WORDS.has(name) ? full : tokenFor('PERSON', name) + honorific));

  const counts = {};
  for (const [type, n] of Object.entries(counters)) counts[type] = n;
  return { maskedText: out, map, counts };
}

/**
 * 역치환. 맵에 없는 토큰은 그대로 둔다(모델이 임의로 만들어낸 토큰 방어).
 * @param {string} text
 * @param {Record<string,string>} map
 */
export function unmask(text, map) {
  if (!map) return String(text);
  return String(text).replace(TOKEN_RE, (token) => (token in map ? map[token] : token));
}

/**
 * 서버측 가드: 마스킹되지 않은 원시 PII 가 남아 있는지 검사한다.
 * @returns {string[]} 검출된 유형 목록 (비어 있으면 통과)
 */
export function detectRawPII(text) {
  const hits = [];
  if (new RegExp(PATTERNS.EMAIL.source).test(text)) hits.push('EMAIL');
  if (new RegExp(PATTERNS.PHONE.source).test(text)) hits.push('PHONE');
  return hits;
}

/** 화면에 노출되지 않는 구분자. 정규식 패턴(숫자·한글·이메일 등) 어디와도 겹치지 않는다. */
const FIELD_SEP = '\n␞\n';

/**
 * 메시지와 "숨은 속사정"을 한 번에 마스킹한다 (설계원칙 1.2).
 *
 * ④ 나의 숨은 속사정은 자유 입력 필드라서 사용자가 실명·연락처를 적을 수 있는데,
 * 이 필드만 마스킹을 거치지 않고 그대로 서버로 보내면 원문 우회 경로가 된다.
 * 두 필드를 한 번에 마스킹해 토큰 번호도 공유되게 한다
 * (메시지와 속사정에 같은 이름이 나오면 같은 {{PERSON_n}} 이 된다).
 *
 * @param {string} message
 * @param {string} hiddenContext
 * @param {{ customTerms?: string[] }} [opts]
 */
export function maskFields(message, hiddenContext, opts = {}) {
  if (!hiddenContext) {
    const { maskedText, map, counts } = mask(message, opts);
    return { maskedMessage: maskedText, maskedHiddenContext: '', map, counts };
  }
  const combined = `${message}${FIELD_SEP}${hiddenContext}`;
  const { maskedText, map, counts } = mask(combined, opts);
  // FIELD_SEP 은 숫자·한글·이메일 패턴 어디와도 겹치지 않으므로 마스킹을 그대로 통과한다.
  const idx = maskedText.indexOf(FIELD_SEP);
  const maskedMessage = idx === -1 ? maskedText : maskedText.slice(0, idx);
  const maskedHiddenContext = idx === -1 ? '' : maskedText.slice(idx + FIELD_SEP.length);
  return { maskedMessage, maskedHiddenContext, map, counts };
}

/** 마스킹 결과 요약 배지용 문자열 */
export function summarizeMask(counts) {
  const labels = {
    PERSON: '이름', PHONE: '전화', EMAIL: '이메일', AMOUNT: '금액',
    ACCOUNT: '계좌', ORG: '조직', PROJECT: '고유명', LITERAL: '토큰',
  };
  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([type, n]) => `${labels[type] || type} ${n}`);
  return parts.length ? parts.join(' · ') : '검출 없음';
}
