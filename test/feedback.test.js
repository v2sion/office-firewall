/**
 * /api/feedback 검증·스크러빙.
 *
 * 이 엔드포인트는 사용자가 우리에게 보내려고 직접 쓴 글을 받는다. 분석한
 * 메시지 원문과는 성격이 다르지만, 그래도 기록에 식별자가 그대로 남는 일은
 * 막아야 한다. 화면의 "원문·실명은 넣지 마세요" 안내는 안내일 뿐이라
 * 서버에서 한 번 더 걸러낸다.
 *
 * 다만 analyze 쪽 detectRawPII 와 달리 **거절하지 않는다** — 의견을 쓰다
 * 숫자가 들어갔다고 돌려보내면 그 사람은 다시 쓰지 않는다. 마스킹해서
 * 받는 쪽을 택했고, 그 차이를 여기서 고정한다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validate, scrubObvious, MAX_MESSAGE_CHARS } from '../api/feedback.js';

test('의견이 비어 있으면 거절한다', () => {
  for (const body of [{}, { message: '' }, { message: '   ' }, { message: 42 }]) {
    const r = validate(body);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'EMPTY_FEEDBACK');
  }
});

test('길이 상한을 넘으면 거절한다', () => {
  assert.equal(validate({ message: 'ㄱ'.repeat(MAX_MESSAGE_CHARS) }).ok, true);
  assert.equal(validate({ message: 'ㄱ'.repeat(MAX_MESSAGE_CHARS + 1) }).code, 'TOO_LONG');
  assert.equal(validate({ message: '정상', contact: 'a'.repeat(201) }).code, 'TOO_LONG');
});

test('연락처와 업데이트 수신은 선택값이다 (없어도 제출된다)', () => {
  const r = validate({ message: '관계에 파견/협력사도 있으면 좋겠어요.' });
  assert.equal(r.ok, true);
  assert.equal(r.contact, '');
  assert.equal(r.wantsUpdates, false);
});

test('업데이트 수신은 true 일 때만 켜진다 (문자열 "false" 등에 속지 않는다)', () => {
  assert.equal(validate({ message: 'x', wantsUpdates: true }).wantsUpdates, true);
  assert.equal(validate({ message: 'x', wantsUpdates: 'false' }).wantsUpdates, false);
  assert.equal(validate({ message: 'x', wantsUpdates: 1 }).wantsUpdates, false);
});

test('기록 전에 눈에 띄는 식별자는 마스킹한다', () => {
  assert.equal(scrubObvious('연락처는 010-1234-5678 입니다'), '연락처는 [전화번호] 입니다');
  assert.equal(scrubObvious('01012345678 로 주세요'), '[전화번호] 로 주세요');
  assert.equal(scrubObvious('900101-1234567'), '[주민번호]');
  assert.equal(scrubObvious('02-123-4567 사무실'), '[전화번호] 사무실');
});

test('마스킹이 평범한 숫자까지 지우지는 않는다', () => {
  const text = '답장 3개 중 2번이 제일 좋았어요. 9월 22일에도 써볼게요.';
  assert.equal(scrubObvious(text), text);
});
