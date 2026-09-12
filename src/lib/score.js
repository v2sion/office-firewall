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

  const parts = [];
  if (SUBSTANCE_METRICS.clicheDensity) {
    parts.push(Math.min(1, hits / sentences / CLICHE_DENSITY_CAP));
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
  const urgent = isPresent(xray?.urgencyType) ? 20 : 0;                  // 0~20
  const ambiguous = isPresent(xray?.ambiguityType) ? 20 : 0;             // 0~20
  const gap = substanceGap(xray, maskedText) * 20;                       // 0~20
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

/** 점수 → 등급/헤더 카피 */
export function riskLabel(score) {
  if (score <= 20) return { level: 'green', label: '정상 업무 범위', header: '정상 업무 신호', action: '그대로 진행해도 좋습니다' };
  if (score <= 40) return { level: 'lime', label: '경미한 압박', header: '경미한 압박 감지', action: '가볍게 확인만 하세요' };
  if (score <= 60) return { level: 'amber', label: '조건 확인 필요', header: '모호한 요구 경보', action: '범위와 기한을 먼저 확정하세요' };
  if (score <= 80) return { level: 'orange', label: '방어 필요', header: '과업 전가 경보', action: '수락 전 조건을 서면화하세요' };
  return { level: 'red', label: '즉각 승인 금지', header: '고위험 독박 경보', action: '즉답하지 말고 조건부로 회신하세요' };
}

/** 결여율 지표별 상세 (리포트 표시용) */
export function substanceBreakdown(xray, maskedText) {
  const sentences = xray?.sentenceCount || countSentences(maskedText || '');
  const hits = Array.isArray(xray?.clicheHits) ? xray.clicheHits.length : 0;
  return [
    { key: 'clicheDensity', label: '클리셰 밀도', value: Math.min(1, hits / sentences / CLICHE_DENSITY_CAP), detail: `${hits}개 / ${sentences}문장`, enabled: SUBSTANCE_METRICS.clicheDensity },
    { key: 'missingSpec', label: '수치·기한 부재', value: xray?.hasNumbers || xray?.hasDeadline ? 0 : 1, detail: xray?.hasNumbers || xray?.hasDeadline ? '수치/기한 명시됨' : '수치·기한 없음', enabled: SUBSTANCE_METRICS.missingSpec },
    { key: 'avoidsDecision', label: '의사결정 회피', value: xray?.avoidsDecision ? 1 : 0, detail: xray?.avoidsDecision ? '결정을 미루는 표현 있음' : '없음', enabled: SUBSTANCE_METRICS.avoidsDecision },
  ].filter((m) => m.enabled);
}
