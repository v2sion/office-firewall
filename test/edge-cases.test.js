import test from 'node:test';
import assert from 'node:assert/strict';
import { mask, unmask, maskFields, detectRawPII } from '../src/lib/mask.js';
import { runAnalyze, MAX_INPUT_CHARS } from '../api/_lib/analyze-core.js';
import { calcRisk } from '../src/lib/score.js';

const MOCK_ENV = { OFW_FORCE_MOCK: '1' };

/**
 * Sprint 2 엣지케이스 20건 (가이드 §10 Sprint 2 Exit).
 * 입력 검증 · 마스킹 경계 · 룰엔진 안정성을 다룬다. 상호작용성(더블클릭
 * 쿨다운, 상황 카드 클릭 중 진행 상태, 키보드 내비게이션 등)은 브라우저
 * DOM 이 필요해 Node 테스트로 못 담는다 — README "엣지케이스 20건" 절에
 * Playwright 실측 결과로 별도 기록했다.
 */

// 1. 빈 메시지
test('01. 빈 문자열 → EMPTY_INPUT', async () => {
  await assert.rejects(() => runAnalyze({ maskedText: '', context: {} }, MOCK_ENV), (e) => e.code === 'EMPTY_INPUT');
});

// 2. 공백만 있는 메시지
test('02. 공백/개행만 있는 메시지 → EMPTY_INPUT (trim 후 비어야 함)', async () => {
  await assert.rejects(() => runAnalyze({ maskedText: '   \n\t  ', context: {} }, MOCK_ENV), (e) => e.code === 'EMPTY_INPUT');
});

// 3. 정확히 800자 → 통과
test('03. 정확히 800자 → 통과(경계값)', async () => {
  const text = '가'.repeat(800);
  const res = await runAnalyze({ maskedText: text, context: {} }, MOCK_ENV);
  assert.ok(res.risk.score >= 0);
});

// 4. 801자 → 거부
test('04. 801자(경계+1) → TOO_LONG', async () => {
  await assert.rejects(
    () => runAnalyze({ maskedText: '가'.repeat(MAX_INPUT_CHARS + 1), context: {} }, MOCK_ENV),
    (e) => e.code === 'TOO_LONG',
  );
});

// 5. 극히 짧은 입력(1글자)
test('05. 1글자 입력도 죽지 않고 스키마를 채운다', async () => {
  const res = await runAnalyze({ maskedText: '네', context: {} }, MOCK_ENV);
  assert.equal(typeof res.xray.subtext, 'string');
  assert.equal(res.replies.length, 3);
});

// 6. 마스킹되지 않은 전화번호 → 서버 거부
test('06. 원시 전화번호가 message 에 섞이면 거부', async () => {
  await assert.rejects(
    () => runAnalyze({ maskedText: '010-9999-8888 로 연락주세요', context: {} }, MOCK_ENV),
    (e) => e.code === 'RAW_PII_DETECTED',
  );
});

// 7. 마스킹되지 않은 이메일 → 서버 거부
test('07. 원시 이메일이 message 에 섞이면 거부', async () => {
  await assert.rejects(
    () => runAnalyze({ maskedText: 'abc@corp.com 으로 보내주세요', context: {} }, MOCK_ENV),
    (e) => e.code === 'RAW_PII_DETECTED',
  );
});

// 8. hiddenContext 에 원시 PII → 서버 거부 (message 는 깨끗해도)
test('08. hiddenContext 에만 원시 PII 가 있어도 거부', async () => {
  await assert.rejects(
    () => runAnalyze({ maskedText: '{{PERSON_1}}님 확인 부탁드립니다.', context: { hiddenContext: '010-1111-2222 로 연락됨' } }, MOCK_ENV),
    (e) => e.code === 'RAW_PII_DETECTED',
  );
});

// 9. 원문에 우연히 {{PERSON_1}} 같은 토큰 형태 문자열이 있어도 round-trip 유지
test('09. 원문에 토큰처럼 생긴 문자열이 있어도 역치환 시 원래대로 복구된다', () => {
  const src = '이 문서엔 이미 {{PERSON_9}} 라는 표현이 그대로 적혀 있어요.';
  const { maskedText, map } = mask(src);
  assert.equal(unmask(maskedText, map), src);
});

// 10. hiddenContext 최대 길이(120자) 근처에서도 마스킹이 깨지지 않는다
test('10. 120자에 가까운 hiddenContext 도 마스킹/역치환이 정상 동작', () => {
  const longHidden = ('박지훈님이 예전에도 이런 식이었어요. '.repeat(4)).slice(0, 120);
  const { maskedMessage, maskedHiddenContext, map } = maskFields('확인 부탁드립니다', longHidden);
  assert.equal(unmask(maskedMessage, map), '확인 부탁드립니다');
  assert.equal(unmask(maskedHiddenContext, map), longHidden);
  assert.ok(!detectRawPII(maskedHiddenContext).length);
});

// 11. 영어 메시지도 크래시 없이 처리
test('11. 영어로만 된 메시지도 정상 처리된다 (한글 전용 로직 크래시 방지)', async () => {
  const res = await runAnalyze({ maskedText: 'Hi, can you review this by tomorrow morning? Thanks!', context: {} }, MOCK_ENV);
  assert.equal(typeof res.risk.score, 'number');
});

// 12. 이모지로만 된 메시지
test('12. 이모지로만 된 메시지도 크래시 없이 처리된다', async () => {
  const res = await runAnalyze({ maskedText: '😊🙏🔥💯👍', context: {} }, MOCK_ENV);
  assert.equal(typeof res.risk.score, 'number');
});

// 13. 같은 이름 반복 → 같은 토큰 번호, 다른 이름 → 다른 번호
test('13. 같은 이름 반복은 같은 토큰, 다른 이름은 다른 토큰', () => {
  const { maskedText } = mask('박지훈님 그리고 박지훈님, 또 김서연님도 참고해주세요.');
  assert.equal((maskedText.match(/\{\{PERSON_1\}\}/g) || []).length, 2);
  assert.ok(maskedText.includes('{{PERSON_2}}'));
});

// 14. 이름 + 역할어가 붙어 있어도 이름만 마스킹된다
test('14. "김민수 팀장님"처럼 이름+역할이 붙어도 이름만 마스킹된다', () => {
  const { maskedText, map } = mask('김민수팀장님께 여쭤보세요.');
  assert.equal(maskedText, '{{PERSON_1}}팀장님께 여쭤보세요.');
  assert.equal(map['{{PERSON_1}}'], '김민수');
});

// 15. 4개 마스킹 카테고리가 한 문장에 동시에 등장
test('15. 이름·전화·이메일·금액·고유명이 한 문장에 동시에 있어도 전부 마스킹된다', () => {
  const src = '박지훈님, 010-1234-5678 또는 park@corp.co.kr 로 연락주시고 "오피스방화벽" 건 1,500,000원 입금 확인 부탁드려요.';
  const { maskedText, map } = mask(src, { customTerms: [] });
  assert.equal(detectRawPII(maskedText).length, 0);
  assert.ok(maskedText.includes('{{PERSON_1}}'));
  assert.ok(maskedText.includes('{{PHONE_1}}'));
  assert.ok(maskedText.includes('{{EMAIL_1}}'));
  assert.ok(maskedText.includes('{{AMOUNT_1}}'));
  assert.ok(maskedText.includes('{{PROJECT_1}}'));
  assert.equal(unmask(maskedText, map), src);
});

// 16. context 필드가 전부 비어 있거나 이상한 값이어도 안전한 기본값으로 처리
test('16. context 필드가 없거나(undefined) 잘못된 값이어도 크래시하지 않는다', async () => {
  const res = await runAnalyze({ maskedText: '확인 부탁드립니다.', context: { goal: '없는목적', tone: '없는톤' } }, MOCK_ENV);
  assert.equal(typeof res.risk.score, 'number');
});

// 17. context 자체가 아예 없어도(undefined) 동작
test('17. context 를 아예 넘기지 않아도 EMPTY_INPUT 이 아니라면 정상 동작', async () => {
  const res = await runAnalyze({ maskedText: '확인 부탁드립니다.' }, MOCK_ENV);
  assert.equal(typeof res.risk.score, 'number');
});

// 18. 점수는 항상 0~100 범위 (모든 골든 케이스 재확인 — 극단 입력 포함)
test('18. 극단적으로 위험 신호가 몰려도 점수는 100을 넘지 않는다', () => {
  const xray = {
    powerAsymmetry: 5, urgencyType: '주말 침범', ambiguityType: 'R&R 미지정',
    clicheHits: new Array(50).fill('가볍게'), sentenceCount: 1,
    hasNumbers: false, hasDeadline: false, avoidsDecision: true,
  };
  assert.ok(calcRisk(xray) <= 100);
});

// 19. 마스킹 맵에 없는 토큰(모델이 지어낸 토큰)은 그대로 남는다 — 환각 방어
test('19. 맵에 없는 토큰(모델 환각)은 강제로 지우거나 깨지지 않고 그대로 보존된다', () => {
  const restored = unmask('{{PERSON_1}}님과 {{PERSON_9}}님 모두에게', { '{{PERSON_1}}': '박지훈' });
  assert.equal(restored, '박지훈님과 {{PERSON_9}}님 모두에게');
});

// 20. 마스킹 결과에 원시 PII 가 우연히도 재생성되지 않는다 (역치환 전 응답 검증)
test('20. AI/캐시 응답이 마스킹 토큰을 유지한 채로만 반환되면 서버가 그대로 통과시킨다', async () => {
  const res = await runAnalyze({ maskedText: '{{PERSON_1}}님, 010 필요 시 {{PHONE_1}} 로 연락', context: {} }, MOCK_ENV);
  // 서버 응답 자체(답장 텍스트)에 원시 전화번호 패턴이 새로 생기지 않아야 한다
  const allReplyText = res.replies.map((r) => r.text).join(' ');
  assert.equal(detectRawPII(allReplyText).length, 0);
});
