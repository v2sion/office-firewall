/**
 * AI(또는 목) 출력 → 최종 응답 객체 정규화.
 * 서버(api/_lib/analyze-core.js)와 클라이언트 폴백이 같은 코드를 쓰도록 여기 둔다.
 */
import { extractSubstanceSignals, containsKo } from './cliche.js';
import { calcRisk, riskLabel, substanceBreakdown } from './score.js';

export const URGENCY_VALUES = ['주말 침범', '야간 침범', '당일 마감', '없음'];
export const AMBIGUITY_VALUES = ['R&R 미지정', '범위 불명', '기한 불명', '없음'];
export const REPLY_LABELS = ['목적 맞춤형 정밀 방어', '선제적 아젠다 요구', '속마음 분노 세탁 버전'];

function pickEnum(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

/**
 * 규칙으로 결정 가능한 항목(클리셰·수치·기한·회피 표현)은 규칙값을 채택한다.
 * AI 가 보고한 원본은 aiReported 에 남겨 검증 가능하게 둔다. (설계원칙 1.1)
 */
export function normalizeXray(aiOut, maskedText) {
  const signals = extractSubstanceSignals(maskedText);
  const ai = aiOut || {};

  // AI 가 찾은 클리셰 중 원문에 실제로 존재하는 것만 규칙 결과에 더한다(환각 차단)
  const aiCliches = Array.isArray(ai.clicheHits)
    ? ai.clicheHits.filter((c) => typeof c === 'string' && c.length > 1 && containsKo(maskedText, c))
    : [];
  const clicheHits = Array.from(new Set([...signals.clicheHits, ...aiCliches]));

  // "기한 불명"은 원문에 날짜·시각이 있는지로 사실 확인이 되는 주장이다.
  // 규칙이 기한을 찾았는데 AI 가 기한 불명이라고 하면 그건 환각이므로 버린다 —
  // clicheHits 환각 차단과 같은 원리다. 이 한 줄이 점수 20점을 좌우하고,
  // 정상 업무 메시지가 실행마다 green ↔ lime 으로 뒤집히던 원인이기도 했다.
  // (범위 불명·R&R 미지정은 규칙으로 검증할 수 없어 AI 판단을 그대로 둔다)
  const rawAmbiguity = pickEnum(ai.ambiguityType, AMBIGUITY_VALUES, '없음');
  const ambiguityType = rawAmbiguity === '기한 불명' && signals.hasDeadline ? '없음' : rawAmbiguity;

  return {
    subtext: typeof ai.subtext === 'string' && ai.subtext.trim()
      ? scrubSchemaLeak(ai.subtext)
      : '분석 결과를 요약하지 못했습니다.',
    powerAsymmetry: Math.max(1, Math.min(5, Math.round(Number(ai.powerAsymmetry) || 3))),
    urgencyType: pickEnum(ai.urgencyType, URGENCY_VALUES, '없음'),
    ambiguityType,
    aiSlopScore: Math.max(0, Math.min(100, Math.round(Number(ai.aiSlopScore) || 0))),
    clicheHits,
    sentenceCount: signals.sentenceCount,
    hasNumbers: signals.hasNumbers,
    hasDeadline: signals.hasDeadline,
    avoidsDecision: signals.avoidsDecision,
    aiReported: {
      clicheHits: Array.isArray(ai.clicheHits) ? ai.clicheHits : [],
      ambiguityType: rawAmbiguity,
      hasNumbers: Boolean(ai.hasNumbers),
      hasDeadline: Boolean(ai.hasDeadline),
      avoidsDecision: Boolean(ai.avoidsDecision),
    },
  };
}

/**
 * 모델이 **스키마의 필드 이름을 문장 속에 흘리는** 경우를 막는다.
 *
 * 실제로 이런 문장이 화면에 나왔다:
 *   "maskedText는 담당자에게 맡기는 내용이지만, 사용자는 수용 여부를…"
 *
 * 우리가 JSON 키로 쓰는 말(maskedText·hiddenContext·subtext…)은 사용자에게
 * 아무 뜻도 없는 내부 용어다. 모델이 지시문을 읽다가 그 단어를 본문으로
 * 끌어오면 결과가 통째로 고장 난 것처럼 보인다.
 *
 * 프롬프트로도 막지만(SYSTEM_PROMPT), 프롬프트는 부탁이고 이건 보장이다.
 */
const SCHEMA_WORDS = /\b(maskedText|hiddenContext|subtext|powerAsymmetry|urgencyType|ambiguityType|aiSlopScore|clicheHits|hasNumbers|hasDeadline|avoidsDecision|riskScore|replies)\b/g;

export function scrubSchemaLeak(text) {
  return String(text ?? '')
    // "maskedText는" 처럼 조사가 붙어 나오므로 단어만 자연스러운 말로 바꾼다.
    .replace(SCHEMA_WORDS, '받은 메시지')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * 보낼 수 있는 답장인가.
 *
 * 모델이 지시문을 글자 그대로 따라가다 뼈대만 남기는 일이 있었다.
 *   "1. 산출물 범위는? 2. 확인 포인트는? 3. 마감 시각은? 4. 담당자는? 하겠습니다."
 *   "이미 잡힌 일정 때문에 이 요청이 부담스럽습니다. 요구합니다."
 *
 * 둘 다 형식은 맞지만 **그대로 보낼 수 없는 문장**이다. 이런 답장은 없는 것만
 * 못하므로, 걸러내고 규칙 엔진이 만든 답장으로 대신한다.
 */
export function isUsableReply(text) {
  const t = String(text ?? '').trim();
  if (t.length < 40) return false; // 한국어 업무 답장이 40자 미만이면 뼈대다
  // 지시문의 동사를 그대로 옮겨 적은 흔적
  if (/(요구합니다|통보합니다|결론을 냅니다)\.?$/.test(t)) return false;
  // 항목만 나열하고 문장으로 맺지 못한 경우
  if (/\?\s*(하겠습니다|입니다)\.?$/.test(t)) return false;
  return true;
}

export function normalizeReplies(aiReplies) {
  const list = Array.isArray(aiReplies) ? aiReplies : [];
  return REPLY_LABELS.map((label, i) => {
    const found = list.find((r) => r && r.label === label) || list[i];
    return {
      label,
      text: found && typeof found.text === 'string' && found.text.trim()
        ? scrubSchemaLeak(found.text)
        : '(답장 생성에 실패했습니다. 다시 시도해 주세요)',
    };
  });
}

/** 최종 응답 조립 — 점수는 여기서(규칙으로) 계산된다. */
export function buildResult(aiOut, maskedText, meta = {}) {
  const xray = normalizeXray(aiOut, maskedText);
  const replies = normalizeReplies(aiOut?.replies);
  const score = calcRisk(xray, maskedText);
  return {
    xray,
    replies,
    risk: { score, ...riskLabel(score), breakdown: substanceBreakdown(xray, maskedText) },
    usage: meta.usage || { input_tokens: 0, output_tokens: 0 },
    meta: { mode: meta.mode || 'mock', model: meta.model || 'mock', latencyMs: meta.latencyMs ?? 0 },
  };
}
