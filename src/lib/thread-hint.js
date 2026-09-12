/**
 * "여러 턴이 오간 대화를 그대로 붙여넣었는지" 감지하는 가벼운 휴리스틱.
 *
 * 실제로 확인된 문제: 대화 전체(내 발화 포함)를 붙여넣으면 내 발화가
 * 신호를 희석시켜 위험 지수가 실제보다 크게 낮아진다 — 룰엔진은 "누가
 * 한 말인지" 구분하지 않고 텍스트 전체를 하나로 본다. 완벽한 화자 분리는
 * 하지 않고(오탐 위험이 크다), 대신 "이거 여러 명 대화 같은데요?" 라고
 * 미리 알려주는 정도로만 개입한다 — 차단하지 않고 참고용 배너만 띄운다.
 */

/** "나:", "저는:", "Me:" 처럼 사용자 자신의 발화를 표시하는 마커 — 가장 신뢰도 높은 신호 */
const SELF_TURN_RE = /(^|\n)\s*(나|내가|저는|본인|Me|I)\s*[:：]/u;

/** "이름:", "닉네임:" 처럼 줄 맨 앞에 화자 라벨이 붙은 패턴 (숫자로 시작하는 라벨은 시각 표기로 보고 제외) */
const SPEAKER_LINE_RE = /(^|\n)[ \t]*([^\s:：\d][^\s:：]{0,11})[ \t]*[:：][ \t]*\S/gu;

/**
 * @param {string} text
 * @returns {boolean} 여러 턴의 대화(내 발화 포함 가능성)로 보이면 true
 */
export function looksLikeMultiTurnThread(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  if (SELF_TURN_RE.test(t)) return true;

  const labels = new Set();
  const re = new RegExp(SPEAKER_LINE_RE.source, 'gu');
  let m;
  while ((m = re.exec(t))) labels.add(m[2].trim());
  return labels.size >= 2;
}
