import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mask, unmask, maskFields } from '../src/lib/mask.js';
import { runAnalyze } from '../api/_lib/analyze-core.js';
import { calcRisk } from '../src/lib/score.js';

const golden = JSON.parse(readFileSync(new URL('../src/data/golden.json', import.meta.url), 'utf8'));
const MOCK_ENV = { OFW_FORCE_MOCK: '1' };
const BUDGET_MS = 3500; // Sprint 0 Exit: 버튼 클릭 → 3.5초 이내

/** 실제 클라이언트 경로와 동일하게: 마스킹 → 분석 → 역치환 */
async function pipeline(g) {
  const { maskedText, map } = mask(g.text);
  const started = Date.now();
  const res = await runAnalyze({ maskedText, context: g.context }, MOCK_ENV);
  const elapsed = Date.now() - started;
  const replies = res.replies.map((r) => ({ ...r, text: unmask(r.text, map) }));
  return { res, replies, elapsed, maskedText, map };
}

for (const g of golden) {
  test(`골든 ${g.id} — 스키마/점수/지연 검증`, async () => {
    const { res, replies, elapsed, maskedText } = await pipeline(g);

    assert.ok(elapsed < BUDGET_MS, `${g.id}: ${elapsed}ms — 3.5초 예산 초과`);

    // 스키마
    assert.equal(typeof res.xray.subtext, 'string');
    assert.ok(res.xray.subtext.length > 10);
    assert.ok(res.xray.powerAsymmetry >= 1 && res.xray.powerAsymmetry <= 5);
    assert.ok(['주말 침범', '야간 침범', '당일 마감', '없음'].includes(res.xray.urgencyType));
    assert.ok(['R&R 미지정', '범위 불명', '기한 불명', '없음'].includes(res.xray.ambiguityType));
    assert.ok(res.xray.aiSlopScore >= 0 && res.xray.aiSlopScore <= 100);
    assert.equal(replies.length, 3);
    for (const r of replies) assert.ok(r.text.length > 20, `${g.id}: 답장이 너무 짧다`);

    // AI 는 riskScore 를 만들지 않는다 (설계원칙 1.1)
    assert.equal(res.xray.riskScore, undefined);

    // 점수는 규칙이 계산하고 재현 가능해야 한다
    assert.equal(res.risk.score, calcRisk(res.xray, maskedText));
    assert.ok(res.risk.score >= (g.expect.minScore ?? 0), `${g.id}: ${res.risk.score}점 — 하한 미달`);
    assert.ok(res.risk.score <= (g.expect.maxScore ?? 100), `${g.id}: ${res.risk.score}점 — 상한 초과`);

    if (g.expect.mustBeGreen) {
      assert.equal(res.risk.level, 'green', `${g.id}: 정상 업무에 과잉 경보(${res.risk.score}점)`);
    }
    if (g.expect.urgency) assert.equal(res.xray.urgencyType, g.expect.urgency);
    if (g.expect.ambiguity) assert.equal(res.xray.ambiguityType, g.expect.ambiguity);
    if (g.expect.minAiSlop) assert.ok(res.xray.aiSlopScore >= g.expect.minAiSlop, `${g.id}: aiSlopScore ${res.xray.aiSlopScore}`);
  });
}

test('역치환: 답장 속 토큰이 원래 값으로 복구된다', async () => {
  const g = golden[0];
  const { maskedText, map } = mask(g.text);
  assert.ok(maskedText.includes('{{PERSON_1}}'), '이름이 마스킹되지 않았다');
  const restored = unmask(`${maskedText} / {{PERSON_1}}님께`, map);
  assert.ok(restored.includes('박지훈님께'));
  assert.ok(!restored.includes('{{PERSON_'));
});

test('원시 PII 가 섞이면 서버가 거부한다', async () => {
  await assert.rejects(
    () => runAnalyze({ maskedText: '연락처는 010-1234-5678 입니다.', context: {} }, MOCK_ENV),
    (e) => e.code === 'RAW_PII_DETECTED',
  );
});

test('④ 숨은 속사정(context.hiddenContext)에 원시 PII 가 섞여도 서버가 거부한다', async () => {
  // 마스킹 우회 경로 방지 — 메시지는 깨끗해도 hiddenContext 에 원시 연락처가 있으면 막는다.
  await assert.rejects(
    () => runAnalyze(
      { maskedText: '{{PERSON_1}}님 확인 부탁드립니다.', context: { hiddenContext: '급하면 010-1234-5678 로 연락주세요.' } },
      MOCK_ENV,
    ),
    (e) => e.code === 'RAW_PII_DETECTED',
  );
});

test('마스킹된 hiddenContext 는 정상적으로 통과한다', async () => {
  const g = golden.find((x) => x.id === 'weekend');
  const { maskedMessage, maskedHiddenContext } = maskFields(g.text, '박지훈 팀장이 저번에도 이랬어요.');
  const res = await runAnalyze(
    { maskedText: maskedMessage, context: { ...g.context, hiddenContext: maskedHiddenContext } },
    MOCK_ENV,
  );
  assert.ok(res.risk.score > 0);
});

test('800자 초과 입력은 거부한다', async () => {
  await assert.rejects(
    () => runAnalyze({ maskedText: '가'.repeat(801), context: {} }, MOCK_ENV),
    (e) => e.code === 'TOO_LONG',
  );
});
