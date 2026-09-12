import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mask, unmask, detectRawPII } from '../src/lib/mask.js';

const golden = JSON.parse(readFileSync(new URL('../src/data/golden.json', import.meta.url), 'utf8'));

const SAMPLES = [
  '박지훈님 주말에 미안한데, 월요일 오전에 대표님 보고가 잡혀서요.',
  '김민수팀장님 010-1234-5678 로 전화 주시고 abc.d@corp.co.kr 로도 공유 부탁드립니다.',
  '이번 건 1,200,000원 입금은 110-234-567890 계좌로, 2026-09-15 까지 부탁드립니다.',
  '"오피스방화벽" 프로젝트는 박지훈님이 담당입니다. 박지훈님께 문의하세요.',
  '토큰처럼 생긴 문자열 {{PERSON_1}} 이 원문에 있어도 깨지면 안 됩니다.',
  '특수문자 없이 평범한 한 줄.',
  '',
];

test('round-trip: unmask(mask(x)) === x — 샘플', () => {
  for (const s of SAMPLES) {
    const { maskedText, map } = mask(s, { customTerms: ['원티드'] });
    assert.equal(unmask(maskedText, map), s, `round-trip 실패: ${s}`);
  }
});

test('round-trip: 골든 5종 전부 100% 일치', () => {
  for (const g of golden) {
    const { maskedText, map } = mask(g.text);
    assert.equal(unmask(maskedText, map), g.text, `round-trip 실패: ${g.id}`);
  }
});

test('deterministic: 같은 이름은 항상 같은 번호', () => {
  const { maskedText, map } = mask('박지훈님과 박지훈님, 그리고 김서연님');
  assert.equal((maskedText.match(/\{\{PERSON_1\}\}/g) || []).length, 2);
  assert.ok(maskedText.includes('{{PERSON_2}}'));
  assert.equal(map['{{PERSON_1}}'], '박지훈');
  assert.equal(map['{{PERSON_2}}'], '김서연');
});

test('호칭은 남기고 이름만 치환한다', () => {
  const { maskedText } = mask('박지훈팀장님 안녕하세요');
  assert.equal(maskedText, '{{PERSON_1}}팀장님 안녕하세요');
});

test('직위·역할어는 이름으로 오탐하지 않는다', () => {
  const { maskedText } = mask('박지훈님, 월요일 오전에 대표님 보고가 잡혀서요. 담당자님께도 공유했습니다.');
  assert.ok(maskedText.includes('대표님'), '대표님은 이름이 아니다');
  assert.ok(maskedText.includes('담당자님'), '담당자님은 이름이 아니다');
  assert.ok(maskedText.includes('{{PERSON_1}}님'));
});

test('날짜를 계좌번호로 오탐하지 않는다', () => {
  const { maskedText } = mask('2026-09-15 회의');
  assert.equal(maskedText, '2026-09-15 회의');
});

test('전화번호/이메일이 서로를 먹지 않는다', () => {
  const { map } = mask('a01012345678b@x.com 과 010-1111-2222');
  assert.equal(map['{{EMAIL_1}}'], 'a01012345678b@x.com');
  assert.equal(map['{{PHONE_1}}'], '010-1111-2222');
});

test('마스킹 결과에는 원시 PII 가 남지 않는다', () => {
  const src = '김민수팀장님 010-1234-5678 / abc@corp.co.kr';
  const { maskedText } = mask(src);
  assert.deepEqual(detectRawPII(maskedText), []);
  assert.ok(detectRawPII(src).length >= 2);
});

test('맵에 없는 토큰은 그대로 둔다 (모델 환각 방어)', () => {
  assert.equal(unmask('{{PERSON_9}}님 안녕', { '{{PERSON_1}}': '박지훈' }), '{{PERSON_9}}님 안녕');
});
