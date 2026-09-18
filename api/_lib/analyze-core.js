/**
 * /api/analyze 의 순수 로직. (HTTP 어댑터는 api/analyze.js)
 * 테스트에서 이 함수를 직접 호출해 골든 5종을 검증한다.
 */
import { detectRawPII } from '../../src/lib/mask.js';
import { buildResult } from '../../src/lib/normalize.js';
import { SYSTEM_PROMPT, buildUserMessage } from './prompt.js';
import { buildMockAnalysis } from '../../src/lib/mock.js';

export const MAX_INPUT_CHARS = 800;
/** /api/verify-live?probe=1 로 이 계정에서 실제 접근 가능한 모델을 직접
 *  확인했다 — groq-typescript 타입 정의에 나열된 llama-3.3-70b-versatile,
 *  llama-3.1-8b-instant, moonshotai/kimi-k2-instruct, qwen/qwen3-32b 는
 *  전부 404 model_not_found, gemma2-9b-it 은 model_decommissioned 였다.
 *  openai/gpt-oss-20b/120b 만 실제로 응답했다. 다른 모델로 바꾸고 싶으면
 *  GROQ_MODEL 환경변수로 덮어쓰기 전에 반드시 ?probe=1 로 먼저 확인할 것. */
export const DEFAULT_MODEL = 'openai/gpt-oss-20b';

/**
 * SDK 는 타임아웃도 재시도한다 — 최악의 벽시계 시간이 timeout × (maxRetries + 1) 이다.
 * 이 값이 vercel.json 의 maxDuration 을 넘으면 우리 JSON 에러 대신 플랫폼이 함수를
 * 죽여 불투명한 504 가 나가고, 클라이언트의 "로컬 룰엔진 폴백" 경로도 지저분해진다.
 * 9s × 2회 = 18s < maxDuration 25s 로 맞춰둔다.
 */
const CALL_TIMEOUT_MS = 9_000;
const MAX_RETRIES = 1;

/** 구조화된 JSON(답장 3개 포함) 출력 기준으로 넉넉히 잡은 상한. Groq 무료 티어 모델의
 *  컨텍스트 한도를 넘지 않도록 Opus 시절(16,000)보다 보수적으로 낮췄다. */
const MAX_OUTPUT_TOKENS = 4_000;

export class AnalyzeError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function shouldUseMock(env = process.env) {
  return env.OFW_FORCE_MOCK === '1' || !env.GROQ_API_KEY;
}

/** 추론 모델(qwen3, gpt-oss 등)이 reasoning_format 설정을 무시하고 <think> 블록을
 *  content 에 흘려보내는 경우에 대비한 방어선. API 레벨에서 이미 막지만(reasoning_format:
 *  'hidden') 이중 안전장치로 남겨둔다 — 실제 겪었던 사고(사고 과정이 답변에 그대로
 *  노출됨)를 재발시키지 않기 위함. */
export function stripReasoning(text) {
  return String(text).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
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
  const { default: Groq } = await import('groq-sdk');
  return new Groq({ apiKey: env.GROQ_API_KEY, maxRetries: MAX_RETRIES });
}

/**
 * 모델 응답(OpenAI 호환 chat.completions 형식) → 파싱된 객체.
 * 실호출 없이 단위 테스트할 수 있도록 분리했다.
 */
export function parseModelResponse(response) {
  const choice = response?.choices?.[0];
  const text = stripReasoning(choice?.message?.content || '');

  if (!text.trim()) {
    throw new AnalyzeError(502, 'EMPTY_MODEL_OUTPUT', '모델이 빈 응답을 반환했습니다.');
  }

  try {
    return extractJSON(text);
  } catch (err) {
    // 출력 상한에 걸려 JSON 이 잘린 경우는 원인을 명확히 구분해 둔다.
    if (choice?.finish_reason === 'length') {
      throw new AnalyzeError(502, 'MODEL_OUTPUT_TRUNCATED', '모델 응답이 출력 상한에서 잘렸습니다.');
    }
    throw err;
  }
}

async function callGroq(maskedText, context, env, clientFactory = defaultClientFactory) {
  const client = await clientFactory(env);
  const model = env.GROQ_MODEL || DEFAULT_MODEL;

  const response = await client.chat.completions.create(
    {
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserMessage(maskedText, context) },
      ],
      response_format: { type: 'json_object' },
      // qwen3/gpt-oss 계열은 추론 모델이라 사고 과정이 그대로 노출된 사고가 있었다 —
      // API 레벨에서 아예 숨긴다(문서화된 파라미터). 지원하지 않는 모델에서는 무시된다.
      reasoning_format: 'hidden',
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
    const result = await callGroq(maskedText, context, env, deps.clientFactory || defaultClientFactory);
    aiOut = result.parsed;
    usage = {
      input_tokens: result.usage.prompt_tokens ?? 0,
      output_tokens: result.usage.completion_tokens ?? 0,
      // Groq 는 Anthropic 식 프롬프트 캐싱이 없다 — 필드는 하위 호환을 위해 유지.
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
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
