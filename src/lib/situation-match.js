/**
 * ③ 입력창 내용을 분석해 ② 상황 카드 중 어느 것과 닮았는지 힌트를 준다.
 *
 * "AI는 추출, 판정은 규칙" 원칙을 그대로 따른다 — 여기서도 새 판단을
 * 만들지 않고, mock.js/receipt.js 가 이미 쓰는 규칙 기반 신호
 * (urgencyType/ambiguityType/aiSlopScore 등)를 재사용해 카드 id 하나를
 * 고르거나, 뚜렷한 신호가 없으면 null 을 돌려준다. 입력은 항상 마스킹 전
 * 원문이지만 브라우저 밖으로 나가지 않는다(네트워크 호출 없음).
 */
import { extractSubstanceSignals, detectUrgency, detectAmbiguity, aiSlopScore } from './cliche.js';

const GROUPCHAT_RE = /(다들|단톡방|이 자리에서|전체\s*공지|공유방)/;

/**
 * @param {string} text 원문 메시지 (마스킹 전, 로컬 판단용)
 * @param {string} [counterpart] API 계약값 (예: '클라이언트')
 * @returns {string|null} PRESETS 의 id 중 하나, 매칭 없으면 null
 */
export function matchSituationId(text, counterpart) {
  const t = String(text || '');
  if (!t.trim()) return null;

  const signals = extractSubstanceSignals(t);
  const urgencyType = detectUrgency(t);
  const ambiguityType = detectAmbiguity(t, signals);
  const slop = aiSlopScore(t, signals);

  if (slop >= 60) return 'aislop';
  if (urgencyType === '주말 침범') return 'weekend';
  if (urgencyType === '야간 침범') return 'nightowl';
  // 당일 마감 + 관계 조합으로 같은 신호를 다른 카드로 나눈다. '민원인'을
  // '클라이언트'보다 먼저 확인해야 한다 — 둘 다 해당하는 counterpart 값은
  // 없지만, 관계가 늘어난 순서에 의존하지 않도록 명시적으로 분리해 둔다.
  if (urgencyType === '당일 마감' && counterpart === '민원인') return 'complainant';
  if (urgencyType === '당일 마감' && counterpart === '클라이언트') return 'client';
  if (urgencyType === '당일 마감' && counterpart === '후배') return 'juniordump';
  if (ambiguityType === 'R&R 미지정') return 'pingpong';
  if (GROUPCHAT_RE.test(t)) return 'groupchat';
  if ((ambiguityType === '범위 불명' || ambiguityType === '기한 불명') && counterpart === '클라이언트') return 'emailcreep';
  if (signals.avoidsDecision && counterpart === '후배') return 'juniordump';
  if (signals.avoidsDecision) return 'passthebuck';

  return null;
}
