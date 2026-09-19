/**
 * 혼잡(429) 안내 경로.
 *
 * 무료 티어 한도는 8,000 TPM, 호출당 ~2,500 토큰이라 **서비스 전체가 분당
 * 3건**이다. 제출 후 공개되면 자주 걸리는 경로인데, 예전에는 Groq 의 429 가
 * 일반 catch 로 흘러 502 "분석에 실패했습니다"가 됐다. 실패가 아니라 줄을
 * 선 것이라 안내가 달라야 하고, 클라이언트도 이걸 폴백 가능한 상태로 받아야
 * 화면이 비지 않는다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAnalyze, AnalyzeError } from '../api/_lib/analyze-core.js';

const ENV = { GROQ_API_KEY: 'test-key' };
const INPUT = { maskedText: '{{PERSON_1}}님 주말에 확인 부탁드려요.', context: {} };

function groq429(headers) {
  return () => ({ chat: { completions: { create: async () => {
    const e = new Error('Rate limit reached'); e.status = 429; e.headers = headers; throw e;
  } } } });
}

test('Groq 429 는 502 실패가 아니라 429 혼잡으로 구분된다', async () => {
  await assert.rejects(
    () => runAnalyze(INPUT, ENV, { clientFactory: groq429(new Map()) }),
    (e) => e instanceof AnalyzeError && e.status === 429 && e.code === 'UPSTREAM_RATE_LIMITED',
  );
});

test('retry-after 헤더가 있으면 그 값을, 없으면 60초를 쓴다', async () => {
  const withHeader = new Map([['retry-after', '25']]);
  await assert.rejects(
    () => runAnalyze(INPUT, ENV, { clientFactory: groq429({ get: (k) => withHeader.get(k) }) }),
    (e) => e.retryAfterSec === 25,
  );
  await assert.rejects(
    () => runAnalyze(INPUT, ENV, { clientFactory: groq429(undefined) }),
    (e) => e.retryAfterSec === 60,
  );
});

test('429 가 아닌 업스트림 오류는 그대로 통과한다(혼잡으로 오인 금지)', async () => {
  const boom = () => ({ chat: { completions: { create: async () => { const e = new Error('nope'); e.status = 500; throw e; } } } });
  await assert.rejects(() => runAnalyze(INPUT, ENV, { clientFactory: boom }), (e) => e.code !== 'UPSTREAM_RATE_LIMITED');
});
