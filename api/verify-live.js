/**
 * 임시 진단 엔드포인트 — STEP 3 LIVE 실측을 배포 환경 안에서(GET으로) 실행한다.
 *
 * 개발 세션 자체가 배포 URL로 POST를 보낼 방법이 없어서(네트워크 정책상 GET 조회
 * 도구만 사용 가능) 골든 5종 호출을 서버 안에서 실행하고 결과만 GET으로 반환한다.
 * 검증이 끝나면 반드시 삭제할 것 — 인증 없이 LLM을 호출시킬 수 있는 엔드포인트를
 * 프로덕션에 남겨두지 않는다.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runAnalyze } from './_lib/analyze-core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(path.join(__dirname, '../src/data/golden.json'), 'utf-8'));

// 아무나 우연히 호출해도 곤란하지 않게 최소한의 문턱만 둔다(진짜 비밀은 아님 — 짧게 쓰고 지울 것).
const ACCESS_TOKEN = 'ofw-verify-2026';

function checkExpect(result, expect) {
  const problems = [];
  const score = result?.risk?.score;
  if (typeof expect.minScore === 'number' && score < expect.minScore) problems.push(`score ${score} < minScore ${expect.minScore}`);
  if (typeof expect.maxScore === 'number' && score > expect.maxScore) problems.push(`score ${score} > maxScore ${expect.maxScore}`);
  if (expect.urgency && result?.xray?.urgencyType !== expect.urgency) problems.push(`urgencyType "${result?.xray?.urgencyType}" !== "${expect.urgency}"`);
  if (expect.ambiguity && result?.xray?.ambiguityType !== expect.ambiguity) problems.push(`ambiguityType "${result?.xray?.ambiguityType}" !== "${expect.ambiguity}"`);
  if (typeof expect.minAiSlop === 'number' && (result?.xray?.aiSlopScore ?? 0) < expect.minAiSlop) problems.push(`aiSlopScore ${result?.xray?.aiSlopScore} < minAiSlop ${expect.minAiSlop}`);
  if (expect.mustBeGreen && result?.risk?.level !== 'green') problems.push(`level "${result?.risk?.level}" !== "green"`);
  return problems;
}

// Groq 실제 지원 모델 후보 — groq/groq-typescript 타입 정의에서 확인했지만 그중
// 어떤 게 실제로 이 계정에서 접근 가능한지는 라이브 호출 전엔 알 수 없다(위 사건 참고).
const MODEL_CANDIDATES = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
  'moonshotai/kimi-k2-instruct',
  'qwen/qwen3-32b',
  'gemma2-9b-it',
];

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }
  if (req.query.token !== ACCESS_TOKEN) {
    return res.status(403).json({ error: 'forbidden' });
  }

  if (req.query.probe === '1') {
    const probeScenario = golden.find((g) => g.id === 'normal');
    const settled = await Promise.allSettled(
      MODEL_CANDIDATES.map(async (model) => {
        const startedAt = Date.now();
        const result = await runAnalyze(
          { maskedText: probeScenario.text, context: probeScenario.context },
          { ...process.env, GROQ_MODEL: model },
        );
        return { model, score: result.risk.score, elapsed: Date.now() - startedAt, usage: result.usage };
      }),
    );
    const probeResults = settled.map((s, i) => (
      s.status === 'fulfilled'
        ? { model: MODEL_CANDIDATES[i], ok: true, ...s.value }
        : { model: MODEL_CANDIDATES[i], ok: false, error: s.reason?.message || String(s.reason) }
    ));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ probe: true, results: probeResults });
  }

  const overrideModel = typeof req.query.model === 'string' ? req.query.model : null;
  const env = overrideModel ? { ...process.env, GROQ_MODEL: overrideModel } : process.env;

  // Groq 무료 티어는 8,000 TPM 이라 5종 병렬 실행이 한도를 넘긴다(429).
  // ?only=<id> 로 한 건씩 나눠 호출할 수 있게 해서 호출 간격을 바깥에서 제어한다.
  const onlyId = typeof req.query.only === 'string' ? req.query.only : null;
  const scenarios = onlyId ? golden.filter((g) => g.id === onlyId) : golden;
  if (onlyId && !scenarios.length) {
    return res.status(400).json({ error: `unknown scenario id: ${onlyId}` });
  }

  const settled = await Promise.allSettled(
    scenarios.map(async (scenario) => {
      const startedAt = Date.now();
      const result = await runAnalyze({ maskedText: scenario.text, context: scenario.context }, env);
      return { scenario, result, elapsed: Date.now() - startedAt };
    }),
  );

  const results = settled.map((s, i) => {
    const scenario = scenarios[i];
    if (s.status === 'rejected') {
      return { id: scenario.id, title: scenario.title, ok: false, error: s.reason?.message || String(s.reason) };
    }
    const { result, elapsed } = s.value;
    const problems = checkExpect(result, scenario.expect);
    return {
      id: scenario.id,
      title: scenario.title,
      ok: problems.length === 0,
      problems,
      score: result.risk.score,
      level: result.risk.level,
      mode: result.meta.mode,
      model: result.meta.model,
      elapsedMs: elapsed,
      usage: result.usage,
    };
  });

  res.setHeader('Cache-Control', 'no-store');
  // 어느 빌드에서 잰 수치인지 응답만 보고 알 수 있어야 한다 — 배포가 여러 개
  // 겹치면서 "직전 커밋 기준"이라고 착각한 측정으로 잘못된 결론을 냈었다.
  return res.status(200).json({
    commit: (process.env.VERCEL_GIT_COMMIT_SHA || 'unknown').slice(0, 7),
    allOk: results.every((r) => r.ok),
    results,
  });
}
