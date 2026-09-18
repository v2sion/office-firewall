/**
 * STEP 3 LIVE 실측 자동화 — 골든 5종을 배포된 /api/analyze 에 실제로 쏴 보고
 * 점수 구간·모델·지연시간·토큰 사용량을 한 번에 확인한다.
 *
 * 개발 세션(Claude Code)의 네트워크 정책이 배포 URL을 막고 있어 이 검증은
 * 세션 밖(로컬 머신 또는 CI)에서 실행해야 한다.
 *
 * 실행: node scripts/verify-live.mjs [배포 URL]
 * 기본 URL: https://office-firewall.vercel.app
 */
import golden from '../src/data/golden.json' with { type: 'json' };

const BASE_URL = process.argv[2] || 'https://office-firewall.vercel.app';

function checkExpect(result, expect) {
  const problems = [];
  const score = result?.risk?.score;
  if (typeof expect.minScore === 'number' && score < expect.minScore) {
    problems.push(`score ${score} < minScore ${expect.minScore}`);
  }
  if (typeof expect.maxScore === 'number' && score > expect.maxScore) {
    problems.push(`score ${score} > maxScore ${expect.maxScore}`);
  }
  if (expect.urgency && result?.xray?.urgencyType !== expect.urgency) {
    problems.push(`urgencyType "${result?.xray?.urgencyType}" !== "${expect.urgency}"`);
  }
  if (expect.ambiguity && result?.xray?.ambiguityType !== expect.ambiguity) {
    problems.push(`ambiguityType "${result?.xray?.ambiguityType}" !== "${expect.ambiguity}"`);
  }
  if (typeof expect.minAiSlop === 'number' && (result?.xray?.aiSlopScore ?? 0) < expect.minAiSlop) {
    problems.push(`aiSlopScore ${result?.xray?.aiSlopScore} < minAiSlop ${expect.minAiSlop}`);
  }
  if (expect.mustBeGreen && result?.risk?.level !== 'green') {
    problems.push(`level "${result?.risk?.level}" !== "green"`);
  }
  return problems;
}

let allOk = true;

for (const scenario of golden) {
  const started = Date.now();
  let res, body;
  try {
    res = await fetch(`${BASE_URL}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maskedText: scenario.text, context: scenario.context }),
    });
    body = await res.json();
  } catch (err) {
    console.log(`[FAIL] ${scenario.title}: 요청 자체가 실패했습니다 — ${err.message}`);
    allOk = false;
    continue;
  }
  const elapsed = Date.now() - started;

  if (!res.ok) {
    console.log(`[FAIL] ${scenario.title}: HTTP ${res.status} — ${JSON.stringify(body?.error)}`);
    allOk = false;
    continue;
  }

  const problems = checkExpect(body, scenario.expect);
  const tag = problems.length ? 'FAIL' : 'OK';
  if (problems.length) allOk = false;

  console.log(
    `[${tag}] ${scenario.title} — score=${body.risk?.score} level=${body.risk?.level} ` +
      `mode=${body.meta?.mode} model=${body.meta?.model} ${elapsed}ms ` +
      `in=${body.usage?.input_tokens} out=${body.usage?.output_tokens}`,
  );
  if (problems.length) console.log(`       기대 불일치: ${problems.join(', ')}`);
}

console.log(allOk ? '\n모든 골든 시나리오 통과.' : '\n일부 시나리오가 기대 범위를 벗어났습니다 — 위 로그 참고.');
process.exit(allOk ? 0 : 1);
