import test from 'node:test';
import assert from 'node:assert/strict';
import { calcRisk, substanceGap, riskLabel, GREEN_CAP, SUBSTANCE_METRICS } from '../src/lib/score.js';
import { extractSubstanceSignals, findCliches, hasDeadline, hasNumbers, avoidsDecision } from '../src/lib/cliche.js';
import { normalizeXray } from '../src/lib/normalize.js';

const base = {
  powerAsymmetry: 1,
  urgencyType: '없음',
  ambiguityType: '없음',
  clicheHits: [],
  sentenceCount: 3,
  hasNumbers: true,
  hasDeadline: true,
  avoidsDecision: false,
};

test('가이드 §6.2 공식대로 가중치가 적용된다', () => {
  // 권력 4(32) + 주말 침범(20) + R&R 미지정(20) + 결여율 1.0(20) = 92
  const xray = {
    ...base,
    powerAsymmetry: 4,
    urgencyType: '주말 침범',
    ambiguityType: 'R&R 미지정',
    clicheHits: ['시간 날 때', '가볍게', '급한 건 아니'],
    hasNumbers: false,
    hasDeadline: false,
    avoidsDecision: true,
  };
  assert.equal(substanceGap(xray), 1);
  assert.equal(calcRisk(xray), 92);
});

test('권력 비대칭만 높고 나머지가 깨끗하면 Green 상한을 넘지 않는다', () => {
  const xray = { ...base, powerAsymmetry: 5 };
  assert.equal(substanceGap(xray), 0);
  assert.ok(calcRisk(xray) <= GREEN_CAP, '정상 업무 대조군에 과잉 경보가 붙었다');
  assert.equal(riskLabel(calcRisk(xray)).level, 'green');
});

test('결여율은 0~1 범위를 벗어나지 않는다', () => {
  const many = { ...base, clicheHits: new Array(20).fill('가볍게'), sentenceCount: 1, hasNumbers: false, hasDeadline: false, avoidsDecision: true };
  assert.equal(substanceGap(many), 1);
  assert.ok(calcRisk(many) <= 100);
});

test('점수는 같은 입력에 항상 같은 값을 낸다 (재현성)', () => {
  const xray = { ...base, powerAsymmetry: 3, urgencyType: '당일 마감', clicheHits: ['가볍게'], sentenceCount: 4 };
  const runs = new Set(Array.from({ length: 50 }, () => calcRisk(xray)));
  assert.equal(runs.size, 1);
});

test('등급 경계', () => {
  assert.equal(riskLabel(20).level, 'green');
  assert.equal(riskLabel(21).level, 'lime');
  assert.equal(riskLabel(60).level, 'amber');
  assert.equal(riskLabel(81).level, 'red');
});

test('신호 추출기: 정상 업무 메시지', () => {
  const t = '안녕하세요. 9/15(월) 14시 스프린트 리뷰 안건으로 로그인 개선안 공유드립니다. 의견은 9/14(일) 18시까지 코멘트로 남겨주시면 반영하겠습니다.';
  const s = extractSubstanceSignals(t);
  assert.deepEqual(s.clicheHits, []);
  assert.equal(s.hasNumbers, true);
  assert.equal(s.hasDeadline, true);
  assert.equal(s.avoidsDecision, false);
  assert.equal(substanceGap(s), 0);
});

test('신호 추출기: "월요일 오전 보고"는 기한이 아니다', () => {
  assert.equal(hasDeadline('월요일 오전에 대표님 보고가 잡혀서요'), false);
  assert.equal(hasDeadline('내일까지 보내주세요'), true);
  assert.equal(hasNumbers('숫자 없는 문장'), false);
  assert.equal(hasNumbers('{{PHONE_1}} 만 있는 문장'), false, '마스킹 토큰 내부 숫자를 세면 안 된다');
});

test('한글 음절 조합을 넘어 어간으로 매칭한다', () => {
  // "아니" 는 "아닙니다" 의 부분문자열이 아니다 — 자모 분해 매칭이 없으면 놓친다
  assert.ok(findCliches('급한 건 아닙니다!').includes('급한 건 아니'));
  assert.ok(findCliches('급한 건 아니에요').includes('급한 건 아니'));
  assert.equal(avoidsDecision('검토해보았습니다'), true);
});

test('신호 추출기: 클리셰/의사결정 회피', () => {
  assert.deepEqual(findCliches('시간 날 때 가볍게 봐주세요').sort(), ['가볍게', '시간 날 때']);
  assert.equal(avoidsDecision('검토해보고 말씀드리겠습니다'), true);
  assert.equal(avoidsDecision('9/15까지 완료하겠습니다'), false);
});

test('컷 우선순위 §11 1번: 의사결정 회피율 지표를 끄면 3중 → 2중 결여율로 축소된다', () => {
  const xray = {
    ...base,
    hasNumbers: false,
    hasDeadline: false,
    avoidsDecision: true, // 결정 회피 표현이 있지만
  };
  const before = substanceGap(xray); // 3중: (0 + 1 + 1) / 3
  assert.equal(before, 2 / 3);

  SUBSTANCE_METRICS.avoidsDecision = false; // 시간 부족 시 1순위 컷 (§11)
  try {
    const after = substanceGap(xray); // 2중: (0 + 1) / 2
    assert.equal(after, 0.5);
    assert.ok(after < before, '컷 이후 결여율이 낮아져야 한다(회피 신호가 더 이상 반영되지 않음)');
  } finally {
    SUBSTANCE_METRICS.avoidsDecision = true; // 다른 테스트에 영향 주지 않게 원복
  }
});

/* ── AI 환각 교차검증: "기한 불명" 주장 ─────────────────────────────
   점수를 20점 움직이는 ambiguityType 은 그동안 AI 값을 그대로 썼다.
   "기한 불명"만은 원문에 날짜·시각이 있는지로 사실 확인이 되므로,
   규칙이 기한을 찾았는데 AI 가 기한 불명이라 하면 환각으로 보고 버린다.
   (LIVE 실측에서 정상 업무 메시지가 실행마다 green ↔ lime 으로 뒤집혔다) */

test('원문에 기한이 있는데 AI 가 "기한 불명"이라 하면 무시한다', () => {
  const text = '9월 15일 14시까지 배너 시안 2종 부탁드립니다. 사이즈는 1200x600 입니다.';
  const xray = normalizeXray({ ambiguityType: '기한 불명', powerAsymmetry: 2 }, text);
  assert.equal(xray.ambiguityType, '없음');
  assert.equal(xray.aiReported.ambiguityType, '기한 불명', 'AI 원본은 감사용으로 남아야 한다');
});

test('기한 불명 환각을 걸러내면 정상 업무 메시지가 Green 을 유지한다', () => {
  const text = '9월 15일 14시까지 배너 시안 2종 부탁드립니다. 사이즈는 1200x600 입니다.';
  const xray = normalizeXray({ ambiguityType: '기한 불명', powerAsymmetry: 2 }, text);
  assert.ok(calcRisk(xray, text) <= GREEN_CAP);
});

test('원문에 기한이 없으면 "기한 불명"을 그대로 존중한다', () => {
  const text = '추가적인 논의를 통해 더 나은 결과를 도출할 수 있을 것으로 사료됩니다.';
  const xray = normalizeXray({ ambiguityType: '기한 불명', powerAsymmetry: 2 }, text);
  assert.equal(xray.ambiguityType, '기한 불명');
});

test('규칙으로 검증 못 하는 "범위 불명"·"R&R 미지정"은 AI 판단을 그대로 둔다', () => {
  const text = '9월 15일 14시까지 부탁드립니다.';
  for (const label of ['범위 불명', 'R&R 미지정']) {
    const xray = normalizeXray({ ambiguityType: label, powerAsymmetry: 2 }, text);
    assert.equal(xray.ambiguityType, label);
  }
});

/**
 * 정중함 역설 회귀 테스트 (cliche.js 의 SUBSTANCE_GATE)
 *
 * 전문가 리뷰에서 "정중하게 말할수록 위험도가 높아지는 역설"로 지적된 부분이다.
 * 게이팅 전에는 산출물·기한·규격이 전부 동일한 같은 요청이 말투만 바꿔도
 * 16점(건조) ↔ 65점(정중)으로 갈렸다. 완곡어가 클리셰 밀도·모호성·의사결정
 * 회피 세 신호를 한꺼번에 발화시켰기 때문이다.
 */
const POLITE_SPECIFIC =
  '{{PERSON_1}}님, 바쁘신데 죄송해요! 시간 날 때 가볍게 한번만 봐주시면 좋을 것 같아요. ' +
  '9월 22일 14시까지 배너 시안 2종, 사이즈는 1200x600, 문구는 첨부 3페이지 기준입니다. 급한 건 아닙니다!';
const DRY_SPECIFIC =
  '9월 22일 14시까지 배너 시안 2종 부탁드립니다. 사이즈는 1200x600, 문구는 첨부 파일 3페이지 기준입니다.';

const scoreOf = (text) => {
  const signals = extractSubstanceSignals(text);
  return calcRisk({ ...signals, powerAsymmetry: 4, urgencyType: '없음', ambiguityType: '없음' }, text);
};

test('같은 요청은 말투가 정중해도 건조할 때와 같은 등급에 머문다', () => {
  const polite = scoreOf(POLITE_SPECIFIC);
  const dry = scoreOf(DRY_SPECIFIC);
  assert.ok(
    Math.abs(polite - dry) <= 10,
    `완곡어만으로 점수가 갈린다: 정중 ${polite} vs 건조 ${dry}`,
  );
  assert.equal(riskLabel(polite).level, riskLabel(dry).level);
});

test('산출물·기한이 명시되면 완곡어는 모호성·의사결정 회피로 세지 않는다', () => {
  const s = extractSubstanceSignals(POLITE_SPECIFIC);
  assert.equal(s.hasNumbers, true);
  assert.equal(s.hasDeadline, true);
  assert.equal(s.avoidsDecision, false, '"좋을 것 같아요"는 완충어지 결정 회피가 아니다');
  assert.ok(s.clicheHits.length > 0, '클리셰는 여전히 탐지되어야 한다(표시용)');
  assert.equal(substanceGap(s, POLITE_SPECIFIC), 0, '알맹이가 있으면 결여율 0');
});

test('알맹이가 없으면 게이트가 열리지 않는다 — 완곡어로 포장된 주말 요구는 그대로 고위험', () => {
  // 골든 ① 과 같은 문장. 이 제품의 논지 자체라 절대 낮아지면 안 된다.
  const weekend =
    '{{PERSON_1}}님 주말에 미안한데, 월요일 오전에 대표님 보고가 잡혀서요. ' +
    '시간 날 때 가볍게 한번 봐주시면 좋을 것 같아요. 급한 건 아닙니다!';
  const s = extractSubstanceSignals(weekend);
  assert.equal(s.hasNumbers, false);
  assert.equal(s.hasDeadline, false);
  assert.equal(s.avoidsDecision, true, '알맹이가 없으면 약한 마커도 회피 신호로 센다');
  assert.equal(substanceGap(s, weekend), 1, '결여율 만점 유지');
});

test('"알아서" 류 강한 범위 신호는 알맹이가 있어도 모호성으로 남는다', () => {
  const text = '9월 22일 14시까지 알아서 적당히 정리해서 주세요.';
  const s = extractSubstanceSignals(text);
  assert.equal(s.hasDeadline, true);
  assert.equal(avoidsDecision(text, s), false);
  // 강한 신호는 게이트를 통과하지 못한다 — detectAmbiguity 는 cliche.js 에서 검증
});
