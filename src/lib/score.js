/**
 * Social Risk Index — 규칙 기반 점수 계산 (설계원칙 1.1)
 * AI 는 riskScore 를 만들지 않는다. 이 파일만이 점수의 단일 출처다.
 */
import { countSentences } from './cliche.js';

/**
 * 결여율 지표 on/off (가이드 §11 컷 우선순위 1번: 3중 → 2중 축소 시 avoidsDecision 만 끈다)
 */
export const SUBSTANCE_METRICS = {
  clicheDensity: true,
  missingSpec: true,
  avoidsDecision: true,
};

/** 클리셰 밀도가 이 값 이상이면 만점(1.0)으로 본다: 두 문장에 한 번 = 포화 */
const CLICHE_DENSITY_CAP = 0.5;

/** 정상 업무 판정 상한 — 골든 ⑤ 대조군이 반드시 Green 이어야 한다 */
export const GREEN_CAP = 20;

/**
 * 알맹이 결여율 0~1
 * @param {object} xray  clicheHits / hasNumbers / hasDeadline / avoidsDecision / sentenceCount
 * @param {string} [maskedText] 문장 수 계산용(xray.sentenceCount 가 없을 때)
 */
export function substanceGap(xray, maskedText) {
  const sentences = xray?.sentenceCount || countSentences(maskedText || '');
  const hits = Array.isArray(xray?.clicheHits) ? xray.clicheHits.length : 0;

  // 알맹이(수치·기한)가 실제로 있으면 클리셰 밀도는 세지 않는다.
  // 클리셰 밀도는 "알맹이가 없다"의 대리 지표인데, 알맹이가 확인된 이상 그
  // 대리 지표는 무효다. 게이트가 없을 때는 "9/22 14시까지 배너 2종, 1200x600"
  // 처럼 규격이 다 적힌 요청도 완곡어만 씌우면 밀도가 만점으로 튀었다.
  // (cliche.js 의 SUBSTANCE_GATE 주석과 같은 원칙)
  const specPresent = Boolean(xray?.hasNumbers || xray?.hasDeadline);

  const parts = [];
  if (SUBSTANCE_METRICS.clicheDensity) {
    parts.push(specPresent ? 0 : Math.min(1, hits / sentences / CLICHE_DENSITY_CAP));
  }
  if (SUBSTANCE_METRICS.missingSpec) {
    parts.push(xray?.hasNumbers || xray?.hasDeadline ? 0 : 1);
  }
  if (SUBSTANCE_METRICS.avoidsDecision) {
    parts.push(xray?.avoidsDecision ? 1 : 0);
  }
  if (!parts.length) return 0;
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}

/**
 * Social Risk Index 0~100 (가이드 §6.2)
 *   권력 비대칭 0~40 · 시간적 긴급도 0~20 · 요구 모호성 0~20 · 알맹이 결여율 0~20
 */
export function calcRisk(xray, maskedText) {
  const power = clamp(Number(xray?.powerAsymmetry) || 0, 0, 5) * 8;      // 0~40
  // 긴급성은 위험을 키우는 요소가 아니라 **정당화하는 요소**다(고용노동부
  // 매뉴얼의 근무시간 외 연락 판단 요소: 업무 관련성·필요성·긴급성·빈도).
  // 장애·사고처럼 지금 대응하지 않으면 손해가 커지는 사유가 본문에 적혀
  // 있으면 시간대 가산을 하지 않는다. cliche.js 의 URGENCY_JUSTIFIER 참고.
  const ambiguous = isPresent(xray?.ambiguityType) ? 20 : 0;             // 0~20
  const gap = substanceGap(xray, maskedText) * 20;                       // 0~20
  // 촉박한 마감 **자체**는 문제가 아니다.
  //
  // 매뉴얼은 이렇게 본다 — "업무량이 많거나 마감이 촉박한 것 자체는, 특정인을
  // 겨냥한 부당한 배분이라는 사정이 없는 한 괴롭힘으로 보기 어렵다."
  // 그리고 당일 마감은 야간(제56조)·휴일(제55조)과 달리 **법이 시간대를 지정한
  // 보호구간이 아니다.** 정규 근무시간 안의 마감이다.
  //
  // 그래서 당일 마감은 홀로 서면 가산하지 않고, 모호성이나 알맹이 결여와
  // 겹칠 때만 센다. "무엇을 언제까지 할지 다 적힌 오늘 18시"와 "뭘 해야
  // 하는지도 모르는데 오늘까지"를 같은 점수로 내보내면 그건 판정이 아니다.
  const sameDayAlone = xray?.urgencyType === '당일 마감' && !ambiguous && gap === 0;
  const urgent = isPresent(xray?.urgencyType) && !xray?.urgencyJustified && !sameDayAlone ? 20 : 0; // 0~20
  const raw = Math.min(100, Math.round(power + urgent + ambiguous + gap));

  // 정상 업무 가드: 기한·수치가 명확하고 긴급 침범도 모호성도 없으면 Green 을 넘지 않는다.
  // (과잉 방어는 제품 신뢰를 깎는다 — 가이드 §6.2 검증 조건)
  if (!urgent && !ambiguous && gap === 0) return Math.min(raw, GREEN_CAP);
  return raw;
}

function isPresent(v) {
  return Boolean(v) && v !== '없음' && v !== 'none';
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/**
 * 점수 → 등급/헤더 카피
 *
 * 세 값의 역할을 분리한다.
 *   label  = 지금 몇 단계인가 (상태)
 *   header = 화면 최상단 경보 문구
 *   action = 사용자가 할 일 (유일한 명령문)
 *
 * 예전 label 은 앞 두 개가 상태('정상 업무 범위'·'경미한 압박'), 뒤 세 개가
 * 행동('조건 확인 필요'·'방어 필요'·'즉각 승인 금지')이라 5단계가 하나의
 * 눈금으로 읽히지 않았고, 바로 옆 action 과도 의미가 겹쳤다. 다섯을 전부
 * 상태로 통일하고 행동은 action 에만 남긴다. 눈금은 재난 위기경보와 같은
 * 순서(주의→경계→심각)를 빌려 설명 없이도 방향이 읽히게 했다.
 */
export function riskLabel(score) {
  if (score <= 20) return { level: 'green', label: '정상', header: '정상 업무 신호', action: '그대로 진행해도 좋습니다' };
  if (score <= 40) return { level: 'lime', label: '경미', header: '경미한 압박 감지', action: '가볍게 확인만 하세요' };
  if (score <= 60) return { level: 'amber', label: '주의', header: '모호한 요구 경보', action: '범위와 기한을 먼저 확정하세요' };
  if (score <= 80) return { level: 'orange', label: '경계', header: '과업 전가 경보', action: '수락 전 조건을 서면화하세요' };
  return { level: 'red', label: '심각', header: '고위험 독박 경보', action: '즉답하지 말고 조건부로 회신하세요' };
}

/** 결여율 지표별 상세 (리포트 표시용) */
export function substanceBreakdown(xray, maskedText) {
  const sentences = xray?.sentenceCount || countSentences(maskedText || '');
  const hits = Array.isArray(xray?.clicheHits) ? xray.clicheHits.length : 0;
  // calcRisk 와 **같은 게이트**를 태운다. 한쪽에만 넣으면 근거 표가 1.00 을
  // 보여주는데 점수에는 0 으로 들어가, "근거를 그대로 펼쳐 보여준다"는 이
  // 제품의 주장이 화면에서 깨진다.
  const specPresent = Boolean(xray?.hasNumbers || xray?.hasDeadline);
  const rawDensity = Math.min(1, hits / sentences / CLICHE_DENSITY_CAP);

  return [
    {
      key: 'clicheDensity',
      label: '클리셰 밀도',
      value: specPresent ? 0 : rawDensity,
      detail: specPresent ? `${hits}개 / ${sentences}문장 (수치·기한이 있어 미집계)` : `${hits}개 / ${sentences}문장`,
      enabled: SUBSTANCE_METRICS.clicheDensity,
    },
    { key: 'missingSpec', label: '수치·기한 부재', value: xray?.hasNumbers || xray?.hasDeadline ? 0 : 1, detail: xray?.hasNumbers || xray?.hasDeadline ? '수치/기한 명시됨' : '수치·기한 없음', enabled: SUBSTANCE_METRICS.missingSpec },
    { key: 'avoidsDecision', label: '의사결정 회피', value: xray?.avoidsDecision ? 1 : 0, detail: xray?.avoidsDecision ? '결정을 미루는 표현 있음' : '없음', enabled: SUBSTANCE_METRICS.avoidsDecision },
  ].filter((m) => m.enabled);
}
