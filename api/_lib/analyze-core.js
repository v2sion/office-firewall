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
const CALL_TIMEOUT_MS = 12_000;

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

async function callAnthropic(maskedText, context, env) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const model = env.OFW_MODEL || DEFAULT_MODEL;

  const base = {
    model,
    max_tokens: 2048,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: buildUserMessage(maskedText, context) }],
  };

  let response;
  try {
    response = await client.messages.create(
      { ...base, output_config: { effort: 'low' } },
      { timeout: CALL_TIMEOUT_MS },
    );
  } catch (err) {
    // output_config 를 지원하지 않는 배포 환경이면 옵션 없이 1회 재시도한다.
    if (err?.status === 400) {
      response = await client.messages.create(base, { timeout: CALL_TIMEOUT_MS });
    } else {
      throw err;
    }
  }

  const text = (response.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  return { parsed: extractJSON(text), usage: response.usage || {}, model };
}

/**
 * @param {{ maskedText: string, context: object }} input
 * @param {object} [env]
 */
export async function runAnalyze(input, env = process.env) {
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
    const result = await callAnthropic(maskedText, context, env);
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
