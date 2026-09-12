/**
 * /api/analyze 의 순수 로직. (HTTP 어댑터는 api/analyze.js)
 * 테스트에서 이 함수를 직접 호출해 골든 5종을 검증한다.
 */
import { detectRawPII } from '../../src/lib/mask.js';
import { buildResult } from '../../src/lib/normalize.js';
import { SYSTEM_PROMPT, buildUserMessage } from './prompt.js';
import { buildMockAnalysis } from '../../src/lib/mock.js';

export const MAX_INPUT_CHARS = 800;
export const DEFAULT_MODEL = 'claude-opus-5';

/**
 * SDK 는 타임아웃도 재시도한다 — 최악의 벽시계 시간이 timeout × (maxRetries + 1) 이다.
 * 이 값이 vercel.json 의 maxDuration 을 넘으면 우리 JSON 에러 대신 플랫폼이 함수를
 * 죽여 불투명한 504 가 나가고, 클라이언트의 "로컬 룰엔진 폴백" 경로도 지저분해진다.
 * 9s × 2회 = 18s < maxDuration 25s 로 맞춰둔다.
 */
const CALL_TIMEOUT_MS = 9_000;
const MAX_RETRIES = 1;

/**
 * Opus 5 는 thinking 이 기본으로 켜져 있고(adaptive), thinking 토큰도 max_tokens 를
 * 함께 소진한다. 기존 값(2048)이면 JSON 이 중간에 잘려 BAD_MODEL_OUTPUT 으로 떨어질
 * 수 있다 — 출력 상한은 "잘리지 않을 만큼" 넉넉히 두고, 실제 길이는 effort 로 조인다.
 */
const MAX_OUTPUT_TOKENS = 16_000;

export class AnalyzeError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function shouldUseMock(env = process.env) {
  return env.OFW_FORCE_MOCK === '1' || !env.ANTHROPIC_API_KEY;
}

/** 모델이 코드펜스나 잡담을 섞어 보내도 첫 번째 JSON 객체만 뽑아낸다 */
export function extractJSON(raw) {
  const text = String(raw).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = text.indexOf('{');
  if (start === -1) throw new AnalyzeError(502, 'BAD_MODEL_OUTPUT', '모델 응답에서 JSON 을 찾지 못했습니다.');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch (e) {
          throw new AnalyzeError(502, 'BAD_MODEL_OUTPUT', `JSON 파싱 실패: ${e.message}`);
        }
      }
    }
  }
  throw new AnalyzeError(502, 'BAD_MODEL_OUTPUT', '모델 응답의 JSON 이 닫히지 않았습니다.');
}

/** 기본 클라이언트 팩토리. 테스트에서 가짜 클라이언트를 주입하려고 분리해 둔다. */
async function defaultClientFactory(env) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: MAX_RETRIES });
}

/**
 * 모델 응답 → 파싱된 객체. 실호출 없이 단위 테스트할 수 있도록 분리했다.
 * stop_reason 을 content 보다 먼저 본다 — 거절(refusal)이면 content 가 비어 있어서
 * 곧장 파싱에 들어가면 "JSON 을 찾지 못했습니다" 라는 엉뚱한 원인으로 보고된다.
 */
export function parseModelResponse(response) {
  if (response?.stop_reason === 'refusal') {
    throw new AnalyzeError(502, 'MODEL_REFUSED', '모델이 이 메시지의 분석을 거절했습니다.');
  }

  const text = (response?.content || [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('');

  if (!text.trim()) {
    throw new AnalyzeError(502, 'EMPTY_MODEL_OUTPUT', '모델이 빈 응답을 반환했습니다.');
  }

  try {
    return extractJSON(text);
  } catch (err) {
    // 출력 상한에 걸려 JSON 이 잘린 경우는 원인을 명확히 구분해 둔다.
    if (response?.stop_reason === 'max_tokens') {
      throw new AnalyzeError(502, 'MODEL_OUTPUT_TRUNCATED', '모델 응답이 출력 상한에서 잘렸습니다.');
    }
    throw err;
  }
}

async function callAnthropic(maskedText, context, env, clientFactory = defaultClientFactory) {
  const client = await clientFactory(env);
  const model = env.OFW_MODEL || DEFAULT_MODEL;

  // effort 는 GA 파라미터다(output_config 안에 들어간다). 이 추출 작업은 정형화돼
  // 있어서 low 로 충분하고, thinking 깊이도 같이 줄어 응답이 빨라진다.
  const response = await client.messages.create(
    {
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: buildUserMessage(maskedText, context) }],
      output_config: { effort: 'low' },
    },
    { timeout: CALL_TIMEOUT_MS },
  );

  return { parsed: parseModelResponse(response), usage: response.usage || {}, model };
}

/**
 * @param {{ maskedText: string, context: object }} input
 * @param {object} [env]
 * @param {{ clientFactory?: Function }} [deps] 테스트에서 모델 호출을 대체하기 위한 주입점
 */
export async function runAnalyze(input, env = process.env, deps = {}) {
  const startedAt = Date.now();
  const maskedText = typeof input?.maskedText === 'string' ? input.maskedText.trim() : '';
  const context = input?.context && typeof input.context === 'object' ? input.context : {};

  if (!maskedText) throw new AnalyzeError(400, 'EMPTY_INPUT', '분석할 메시지가 비어 있습니다.');
  if (maskedText.length > MAX_INPUT_CHARS) {
    throw new AnalyzeError(400, 'TOO_LONG', `메시지는 ${MAX_INPUT_CHARS}자까지 분석합니다.`);
  }

  // 설계원칙 1.2 가드 — 브라우저 선-마스킹을 통과하지 않은 원시 PII 는 받지 않는다.
  // ④ 나의 숨은 속사정(context.hiddenContext)도 자유 입력 필드라 마스킹 우회 경로가 될 수 있어 함께 검사한다.
  const rawInMessage = detectRawPII(maskedText);
  const rawInHiddenContext = detectRawPII(typeof context.hiddenContext === 'string' ? context.hiddenContext : '');
  const raw = Array.from(new Set([...rawInMessage, ...rawInHiddenContext]));
  if (raw.length) {
    throw new AnalyzeError(400, 'RAW_PII_DETECTED', `마스킹되지 않은 개인정보가 감지되었습니다(${raw.join(', ')}). 브라우저 마스킹을 거쳐 다시 요청하세요.`);
  }

  const useMock = shouldUseMock(env);
  let aiOut;
  let usage = { input_tokens: 0, output_tokens: 0 };
  let model = 'mock';

  if (useMock) {
    aiOut = buildMockAnalysis(maskedText, context);
  } else {
    const result = await callAnthropic(maskedText, context, env, deps.clientFactory || defaultClientFactory);
    aiOut = result.parsed;
    usage = {
      input_tokens: result.usage.input_tokens ?? 0,
      output_tokens: result.usage.output_tokens ?? 0,
      cache_creation_input_tokens: result.usage.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: result.usage.cache_read_input_tokens ?? 0,
    };
    model = result.model;
  }

  return buildResult(aiOut, maskedText, {
    usage,
    model,
    mode: useMock ? 'mock' : 'live',
    latencyMs: Date.now() - startedAt,
  });
}
