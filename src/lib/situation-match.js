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
 * 클라이언트·민원인은 카드 세 장(client·emailcreep·complainant)을 공유한다.
 * 관계만으로는 이 셋을 가를 수 없어서, 예전에는 "당일 마감"이 잡히면 관계로만
 * 갈랐다 — 민원인이면 무조건 complainant 였다. 카드에서 "말 바뀐 재작업 요구"를
 * 고른 민원인에게 힌트가 "격앙된 항의"를 가리키는 모순이 여기서 나왔다.
 *
 * 그래서 관계 규칙보다 **먼저** 내용을 본다. 두 카드의 정체는 마감이 아니라
 * 각각 "말이 바뀌고 추가 비용을 부정한다"와 "책임자를 호출하며 격앙돼 있다"에
 * 있기 때문이다. 어느 쪽 표지도 없으면 아래의 관계 규칙으로 그대로 내려간다.
 */
const SCOPE_CHANGE_RE = /(처음.{0,6}(얘기|말씀|설명).{0,8}(다르|아니)|원한 건 이게|추가\s*비용|추가로 돈)/;
const OUTRAGE_RE = /(책임자|책임지실|가만\s*안|몇\s*시간째|몇\s*번째인지|당장)/;

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
  const isCustomerSide = counterpart === '클라이언트' || counterpart === '민원인';
  if (isCustomerSide && OUTRAGE_RE.test(t)) return 'complainant';
  if (isCustomerSide && SCOPE_CHANGE_RE.test(t)) return 'client';
  if (urgencyType === '당일 마감' && counterpart === '민원인') return 'complainant';
  if (urgencyType === '당일 마감' && counterpart === '클라이언트') return 'client';
  if (urgencyType === '당일 마감' && counterpart === '후배') return 'juniordump';
  if (ambiguityType === 'R&R 미지정') return 'pingpong';
  if (GROUPCHAT_RE.test(t)) return 'groupchat';
  // emailcreep 도 카드가 클라이언트·민원인 양쪽에 걸려 있다(fits). 예전엔 이
  // 분기만 클라이언트로 좁혀져 있어서, 같은 잔 수정 요청이 민원인일 때만
  // 힌트가 사라졌다.
  if ((ambiguityType === '범위 불명' || ambiguityType === '기한 불명') && isCustomerSide) return 'emailcreep';
  if (signals.avoidsDecision && counterpart === '후배') return 'juniordump';
  if (signals.avoidsDecision) return 'passthebuck';

  return null;
}
