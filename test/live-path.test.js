/**
 * LIVE(실모델) 경로 테스트.
 *
 * 이 경로는 API 키가 없으면 아예 실행되지 않아서 그동안 한 번도 검증된 적이 없었다.
 * 실제 호출 대신 가짜 클라이언트를 주입해 "모델이 이렇게 답했을 때 우리가 어떻게
 * 되는가"를 고정한다 — 시연 당일 처음 겪으면 안 되는 경우들이다.
 *
 * Groq(OpenAI 호환 chat.completions) 기준. finish_reason 에는 Anthropic 의
 * stop_reason: 'refusal' 같은 구조화된 거절 신호가 없다 — 모델이 거절하면 그냥
 * 평범한 텍스트로 답하고, JSON 추출에 실패해 BAD_MODEL_OUTPUT 으로 떨어진다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAnalyze, extractJSON, parseModelResponse, stripReasoning, DEFAULT_MODEL } from '../api/_lib/analyze-core.js';

const LIVE_ENV = { GROQ_API_KEY: 'test-key-not-used' };

/** 모델이 돌려줄 법한 정상 응답 본문 */
const VALID_AI_JSON = {
  subtext: '표면적으로는 협조 요청이지만 실제로는 판단 부담을 넘기고 있습니다.',
  powerAsymmetry: 4,
  urgencyType: '주말 침범',
  ambiguityType: '범위 불명',
  aiSlopScore: 0,
  clicheHits: ['가볍게'],
  hasNumbers: false,
  hasDeadline: false,
  avoidsDecision: true,
  replies: [
    { label: '목적 맞춤형 정밀 방어', text: '주말에는 대응이 어렵습니다.' },
    { label: '선제적 아젠다 요구', text: '범위와 기한을 먼저 확정하고 싶습니다.' },
    { label: '속마음 분노 세탁 버전', text: '작업 범위가 정해지지 않은 채로 왔습니다.' },
  ],
};

/** client.chat.completions.create 를 흉내내는 가짜. 호출 파라미터를 캡처해 둔다. */
function fakeClient(response, capture = {}) {
  return async () => ({
    chat: {
      completions: {
        create: async (params, opts) => {
          capture.params = params;
          capture.opts = opts;
          return response;
        },
      },
    },
  });
}

const chatResponse = (content, extra = {}) => ({
  choices: [{ message: { content }, finish_reason: 'stop', ...extra }],
  usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 },
});

/* ── stripReasoning ───────────────────────────── */

test('stripReasoning: <think> 블록을 제거한다', () => {
  assert.equal(stripReasoning('<think>이렇게 생각했다</think>{"a":1}'), '{"a":1}');
});

test('stripReasoning: <think> 블록이 없으면 그대로 둔다', () => {
  assert.equal(stripReasoning('{"a":1}'), '{"a":1}');
});

/* ── extractJSON ───────────────────────────── */

test('extractJSON: 순수 JSON 을 그대로 파싱한다', () => {
  assert.deepEqual(extractJSON('{"a":1}'), { a: 1 });
});

test('extractJSON: 코드펜스로 감싸도 파싱한다', () => {
  assert.deepEqual(extractJSON('```json\n{"a":1}\n```'), { a: 1 });
});

test('extractJSON: 앞에 잡담이 붙어도 첫 JSON 객체만 뽑는다', () => {
  assert.deepEqual(extractJSON('알겠습니다. 결과는 다음과 같습니다:\n{"a":1}\n도움이 되셨길!'), { a: 1 });
});

test('extractJSON: 문자열 안의 중괄호에 속지 않는다', () => {
  const out = extractJSON('{"text":"여기 {중괄호} 와 \\" 따옴표가 있다","n":2}');
  assert.equal(out.n, 2);
  assert.match(out.text, /중괄호/);
});

test('extractJSON: JSON 이 없으면 BAD_MODEL_OUTPUT', () => {
  assert.throws(() => extractJSON('죄송하지만 도와드릴 수 없습니다.'), (e) => e.code === 'BAD_MODEL_OUTPUT');
});

test('extractJSON: 중간에 잘린 JSON 은 BAD_MODEL_OUTPUT', () => {
  assert.throws(() => extractJSON('{"subtext":"어쩌구 저쩌'), (e) => e.code === 'BAD_MODEL_OUTPUT');
});

/* ── parseModelResponse: finish_reason 분기 ───────────────────────────── */

test('빈 응답은 EMPTY_MODEL_OUTPUT 으로 구분된다', () => {
  assert.throws(() => parseModelResponse(chatResponse('   ')), (e) => e.code === 'EMPTY_MODEL_OUTPUT');
});

test('출력 상한에 걸려 잘린 응답은 MODEL_OUTPUT_TRUNCATED 로 구분된다', () => {
  const res = chatResponse('{"subtext":"여기서 잘림', { finish_reason: 'length' });
  assert.throws(() => parseModelResponse(res), (e) => e.code === 'MODEL_OUTPUT_TRUNCATED');
});

test('reasoning 모델이 <think> 블록을 흘려도 JSON 은 정상 파싱된다', () => {
  const res = chatResponse(`<think>점수를 매겨볼까... 아니 규칙이 한다고 했지</think>${JSON.stringify(VALID_AI_JSON)}`);
  const parsed = parseModelResponse(res);
  assert.equal(parsed.subtext, VALID_AI_JSON.subtext);
});

/* ── runAnalyze LIVE 경로 ───────────────────────────── */

test('LIVE: 모델 응답이 정상이면 mode=live 로 결과를 조립한다', async () => {
  const capture = {};
  const res = await runAnalyze(
    { maskedText: '{{PERSON_1}}님 주말에 가볍게 한번 봐주세요.', context: { tone: '보통맛' } },
    LIVE_ENV,
    { clientFactory: fakeClient(chatResponse(JSON.stringify(VALID_AI_JSON)), capture) },
  );

  assert.equal(res.meta.mode, 'live');
  assert.equal(res.meta.model, DEFAULT_MODEL);
  assert.equal(res.usage.input_tokens, 1200);
  assert.equal(res.replies.length, 3);
  assert.equal(typeof res.risk.score, 'number');
});

test('LIVE: 요청 파라미터가 규약대로 나간다 (JSON 모드·reasoning 숨김·타임아웃)', async () => {
  const capture = {};
  await runAnalyze(
    { maskedText: '확인 부탁드립니다.', context: {} },
    LIVE_ENV,
    { clientFactory: fakeClient(chatResponse(JSON.stringify(VALID_AI_JSON)), capture) },
  );

  assert.ok(capture.params.max_tokens >= 2000, `max_tokens 가 너무 작다: ${capture.params.max_tokens}`);
  assert.equal(capture.params.response_format.type, 'json_object');
  assert.equal(capture.params.reasoning_format, 'hidden');
  // 타임아웃은 vercel maxDuration(25s)보다 반드시 작아야 한다.
  assert.ok(capture.opts.timeout < 25_000, '타임아웃이 함수 제한을 넘는다');
});

test('LIVE: 모델이 riskScore 를 우겨넣어도 점수는 규칙이 계산한다 (설계원칙 1.1)', async () => {
  const hijacked = { ...VALID_AI_JSON, riskScore: 3, risk: { score: 3 } };
  const res = await runAnalyze(
    { maskedText: '{{PERSON_1}}님 주말에 가볍게 한번 봐주세요.', context: {} },
    LIVE_ENV,
    { clientFactory: fakeClient(chatResponse(JSON.stringify(hijacked))) },
  );
  // 모델이 보낸 3점이 아니라, 규칙엔진이 신호로 계산한 점수여야 한다.
  assert.notEqual(res.risk.score, 3);
  assert.ok(res.risk.score > 20, `주말 침범 신호가 있는데 점수가 너무 낮다: ${res.risk.score}`);
});

test('LIVE: 모델이 필드를 빠뜨려도 정규화 폴백으로 응답 형태는 유지된다', async () => {
  const res = await runAnalyze(
    { maskedText: '확인 부탁드립니다.', context: {} },
    LIVE_ENV,
    { clientFactory: fakeClient(chatResponse('{"subtext":"설명만 있고 나머지는 없음"}')) },
  );
  assert.equal(res.replies.length, 3);
  assert.ok(res.xray.urgencyType);
  assert.ok(res.xray.ambiguityType);
  assert.equal(typeof res.risk.score, 'number');
});

test('LIVE: 모델이 환각으로 지어낸 클리셰는 원문 대조로 걸러진다', async () => {
  const lying = { ...VALID_AI_JSON, clicheHits: ['원문에 절대 없는 표현입니다'] };
  const res = await runAnalyze(
    { maskedText: '확인 부탁드립니다.', context: {} },
    LIVE_ENV,
    { clientFactory: fakeClient(chatResponse(JSON.stringify(lying))) },
  );
  assert.ok(!res.xray.clicheHits.includes('원문에 절대 없는 표현입니다'));
});

test('LIVE 경로에서도 마스킹 안 된 원문 PII 는 모델 호출 전에 막힌다', async () => {
  let called = false;
  await assert.rejects(
    () => runAnalyze(
      { maskedText: '010-1234-5678 로 연락주세요', context: {} },
      LIVE_ENV,
      { clientFactory: async () => { called = true; return { chat: { completions: { create: async () => chatResponse('{}') } } }; } },
    ),
    (e) => e.code === 'RAW_PII_DETECTED',
  );
  assert.equal(called, false, 'PII 가드는 모델 호출 이전에 동작해야 한다');
});
