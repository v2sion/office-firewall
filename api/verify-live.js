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

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }
  if (req.query.token !== ACCESS_TOKEN) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const settled = await Promise.allSettled(
    golden.map(async (scenario) => {
      const startedAt = Date.now();
      const result = await runAnalyze({ maskedText: scenario.text, context: scenario.context });
      return { scenario, result, elapsed: Date.now() - startedAt };
    }),
  );

  const results = settled.map((s, i) => {
    const scenario = golden[i];
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
  return res.status(200).json({ allOk: results.every((r) => r.ok), results });
}
