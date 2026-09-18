import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  villainType, defenseModeLabel, hoursSaved, mentalHpSaved,
  politicalRisk, formatIssuedAt, buildReceiptData,
} from '../src/lib/receipt.js';

test('빌런 유형: 골든 ① 주말 침범 → "주말 도둑형 상사" (가이드 §3.3 예시와 일치)', () => {
  const xray = { urgencyType: '주말 침범', ambiguityType: '범위 불명', aiSlopScore: 0, avoidsDecision: true };
  assert.equal(villainType(xray, { counterpart: '직속상사' }), '주말 도둑형 상사');
});

test('빌런 유형: AI 슬롭이 가장 먼저 판정된다 (다른 신호보다 우선)', () => {
  const xray = { urgencyType: '주말 침범', ambiguityType: 'R&R 미지정', aiSlopScore: 80, avoidsDecision: true };
  assert.equal(villainType(xray, { counterpart: '팀원(AI복붙)' }), 'AI 복붙형 동료');
});

test('빌런 유형: 신호가 전혀 없으면 "평범한 ○○"', () => {
  const xray = { urgencyType: '없음', ambiguityType: '없음', aiSlopScore: 0, avoidsDecision: false };
  assert.equal(villainType(xray, { counterpart: '타부서 동료' }), '평범한 동료');
});

test('빌런 유형: counterpart 가 없거나 알 수 없어도 죽지 않는다', () => {
  assert.doesNotThrow(() => villainType({}, {}));
  assert.equal(villainType({}, {}), '평범한 상대');
});

test('방어 모드 라벨: 칼차단+매운맛 → "🛑 여지없는 칼차단" (가이드 §3.3 예시와 정확히 일치)', () => {
  assert.equal(defenseModeLabel('칼차단', '매운맛'), '🛑 여지없는 칼차단');
});

test('방어 모드 라벨: 4목적 × 3톤 = 12개 조합이 전부 다르다', () => {
  const goals = ['칼차단', '시간벌기', '공넘기기', '관계보존'];
  const tones = ['순한맛', '보통맛', '매운맛'];
  const labels = new Set();
  for (const g of goals) for (const t of tones) labels.add(defenseModeLabel(g, t));
  assert.equal(labels.size, 12);
});

test('절약 시간: 가이드 예시(주말 침범, 점수 92) 근방에서 4.5h대가 나온다', () => {
  const h = hoursSaved(92, '주말 침범');
  assert.ok(h >= 4 && h <= 6, `${h}h 가 기대 범위(4~6h) 밖`);
});

test('절약 시간: 점수 0 이어도 최소 0.5h 은 보장한다 (0으로 안 떨어짐)', () => {
  assert.equal(hoursSaved(0, '없음'), 0.5);
});

test('절약 시간: 긴급도가 강할수록(주말>당일>야간>없음) 절약 시간도 크다 (같은 점수 기준)', () => {
  const score = 80;
  const weekend = hoursSaved(score, '주말 침범');
  const deadline = hoursSaved(score, '당일 마감');
  const night = hoursSaved(score, '야간 침범');
  const none = hoursSaved(score, '없음');
  assert.ok(weekend > deadline);
  assert.ok(deadline > night);
  assert.ok(night > none);
});

test('멘탈 HP: 가이드 예시 그대로 score=92 → 85 (계수를 예시에 맞춰 검증)', () => {
  assert.equal(mentalHpSaved(92), 85);
});

test('멘탈 HP: 0~100 점수 전 구간에서 10~99 범위를 벗어나지 않는다', () => {
  for (let s = 0; s <= 100; s += 5) {
    const hp = mentalHpSaved(s);
    assert.ok(hp >= 10 && hp <= 99, `score=${s} → hp=${hp}`);
  }
});

test('사내 정치 리스크: 매운맛만 위험을 인정한다 — 앱 자체의 "관계 비용 경고"와 같은 맥락', () => {
  assert.equal(politicalRisk('매운맛').percent, 15);
  assert.equal(politicalRisk('순한맛').percent, 0);
  assert.equal(politicalRisk('보통맛').percent, 5);
});

test('ISSUED AT 포맷: YYYY-MM-DD HH:mm:ss', () => {
  const d = new Date(2026, 8, 12, 17, 5, 9); // 월은 0-index → 9월
  assert.equal(formatIssuedAt(d), '2026-09-12 17:05:09');
});

test('buildReceiptData: 골든 ①(주말 침범, 점수 92) 조합으로 가이드 §3.3 예시 카드값을 그대로 재현한다', () => {
  const xray = { urgencyType: '주말 침범', ambiguityType: '범위 불명', aiSlopScore: 0, avoidsDecision: true };
  const risk = { score: 92, label: '심각' };
  const context = { job: '기획·PM/PO', level: '주니어', counterpart: '직속상사', goal: '칼차단', tone: '매운맛' };
  const r = buildReceiptData(xray, risk, context, new Date(2026, 8, 12, 17, 35, 0));

  assert.equal(r.issuedAt, '2026-09-12 17:35:00');
  assert.equal(r.job, '기획·PM/PO (주니어)');
  assert.equal(r.villain, '주말 도둑형 상사');
  assert.equal(r.score, 92);
  assert.equal(r.defenseMode, '🛑 여지없는 칼차단');
  assert.ok(r.hoursSaved >= 4 && r.hoursSaved <= 6);
  assert.equal(r.mentalHp, 85);
  assert.equal(r.politicalRiskPercent, 15); // 매운맛이라 앱과 같은 맥락의 긴장도를 인정
});

test('buildReceiptData: xray/context 가 비어 있어도 죽지 않는다(방어적 기본값)', () => {
  assert.doesNotThrow(() => buildReceiptData(undefined, undefined, undefined));
  const r = buildReceiptData(undefined, undefined, undefined);
  assert.equal(r.score, 0);
});

test('receipt.js 는 원문 관련 필드에 실제로 접근(.property)하지 않는다 (정적 검사)', () => {
  // 설명 주석에는 "이런 필드는 안 쓴다"는 언급이 있을 수 있으니, 실제 프로퍼티
  // 접근 패턴(.subtext 등)만 금지한다 — 단어 자체를 금지하면 그 설명 주석까지 걸린다.
  const src = readFileSync(new URL('../src/lib/receipt.js', import.meta.url), 'utf8');
  for (const banned of ['.subtext', '.clicheHits', '.maskedText', '.replies']) {
    assert.ok(!src.includes(banned), `receipt.js 가 ${banned} 에 접근하면 안 된다`);
  }
});
