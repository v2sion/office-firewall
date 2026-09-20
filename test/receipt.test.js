import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  villainType, defenseModeLabel, formatIssuedAt, buildReceiptData,
} from '../src/lib/receipt.js';

test('빌런 유형: 골든 ① 주말 침범 → "주말 도둑형 상사" (가이드 §3.3 예시와 일치)', () => {
  const xray = { urgencyType: '주말 침범', ambiguityType: '범위 불명', aiSlopScore: 0, avoidsDecision: true };
  assert.equal(villainType(xray, { counterpart: '직속상사' }), '주말 도둑형 상사');
});

test('빌런 유형: AI 슬롭이 가장 먼저 판정된다 (다른 신호보다 우선)', () => {
  const xray = { urgencyType: '주말 침범', ambiguityType: 'R&R 미지정', aiSlopScore: 80, avoidsDecision: true };
  assert.equal(villainType(xray, { counterpart: '동기' }), '영혼 없이 복붙형 동기');
});

test('빌런 유형: 신호가 전혀 없으면 "평범한 ○○"', () => {
  const xray = { urgencyType: '없음', ambiguityType: '없음', aiSlopScore: 0, avoidsDecision: false };
  assert.equal(villainType(xray, { counterpart: '타부서 동료' }), '평범한 동료');
});

test('빌런 유형: counterpart 가 없거나 알 수 없어도 죽지 않는다', () => {
  assert.doesNotThrow(() => villainType({}, {}));
  assert.equal(villainType({}, {}), '평범한 상대');
});

test('빌런 유형: 확장된 관계 8종이 전부 고유한 "who" 로 치환된다', () => {
  const xray = { urgencyType: '없음', ambiguityType: '없음', aiSlopScore: 0, avoidsDecision: false };
  const who = {
    '직속상사': '상사', '임원': '임원', '선배': '선배', '후배': '후배',
    '동기': '동기', '타부서 동료': '동료', '클라이언트': '클라이언트', '민원인': '민원인',
  };
  for (const [counterpart, label] of Object.entries(who)) {
    assert.equal(villainType(xray, { counterpart }), `평범한 ${label}`, counterpart);
  }
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
});

/**
 * 카드에는 근거를 댈 수 있는 값만 남긴다.
 *
 * "막아낸 야근 / 지킨 멘탈 / 사내 정치 리스크"가 여기 있었다. 결정론적이긴
 * 했지만 근거가 화면 어디에도 없었고, 무엇보다 **답장과 무관했다** — 실제로
 * 답장을 보냈는지, 셋 중 무엇을 골랐는지와 관계없이 점수와 말투만으로 나와서
 * 아무것도 하지 않아도 "+5.5 Hours"가 찍혔다.
 *
 * "계산 과정을 그대로 펼쳐 보여준다"가 이 서비스의 주장인데 저 숫자만 그
 * 규칙 밖에 있었다. 공유되는 이미지라 더 그렇다. 다시 들어오지 않게 고정한다.
 */
test('영수증 값에 근거 없는 환산 지표가 없다', () => {
  const r = buildReceiptData(
    { urgencyType: '주말 침범' },
    { score: 92, label: '심각' },
    { job: '기획·PM/PO', level: '주니어', counterpart: '직속상사', goal: '칼차단', tone: '매운맛' },
  );
  for (const key of ['hoursSaved', 'mentalHp', 'politicalRiskPercent', 'politicalRiskNote']) {
    assert.ok(!(key in r), `${key} 가 되살아났다`);
  }
  // 남는 건 전부 화면 어딘가에 근거가 있는 값이다.
  assert.deepEqual(Object.keys(r).sort(), ['defenseMode', 'issuedAt', 'job', 'score', 'scoreLabel', 'villain']);
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
