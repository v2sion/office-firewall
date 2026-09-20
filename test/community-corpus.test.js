/**
 * 직장인 커뮤니티 사연 코퍼스 회귀.
 *
 * 골든 5종은 설계 단계에서 우리가 고른 시나리오라, 우리가 생각한 모양의
 * 메시지만 들어 있다. 실제로 사람들이 사연으로 올리는 메시지는 결이 다르다 —
 * 요구가 아예 없거나(되받기), 기한만 있고 산출물이 없거나, 업무가 아닌 지시다.
 *
 * 이 코퍼스에서 실제로 두 가지가 잡혔다.
 *  ① 기한이 적혀 있다는 이유만으로 "범위 불명"이 꺼졌다 (밤 11시 수정 요청)
 *  ② 룰엔진이 "모호성 없음"이라 판정한 메시지에도 답장이 "조건이 명확하지
 *     않아…"로 시작했다 — 화면의 판정과 답장이 정면으로 어긋났다
 *
 * @see test/fixtures/community-corpus.json
 * @see scripts/live-corpus.mjs  (같은 코퍼스를 실제 LIVE 로 돌리는 러너)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mask } from '../src/lib/mask.js';
import { buildMockAnalysis } from '../src/lib/mock.js';
import { buildResult } from '../src/lib/normalize.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const corpus = JSON.parse(readFileSync(join(root, 'test/fixtures/community-corpus.json'), 'utf8'));

function analyze(c, over = {}) {
  const { maskedText } = mask(c.text);
  const context = { job: '기획·PM/PO', level: '주니어', counterpart: c.counterpart, goal: '시간벌기', tone: '보통맛', ...over };
  return buildResult(buildMockAnalysis(maskedText, context), maskedText);
}

test('커뮤니티 사연 12종이 기대 구간 안에 든다', () => {
  for (const c of corpus.cases) {
    const r = analyze(c);
    const [lo, hi] = c.expect.band;
    assert.ok(r.risk.score >= lo && r.risk.score <= hi,
      `${c.id}(${c.label}): ${r.risk.score}점 — 기대 ${lo}~${hi}`);
    if (c.expect.urgency) assert.equal(r.xray.urgencyType, c.expect.urgency, `${c.id}: 긴급도`);
    if (c.expect.ambiguity) assert.equal(r.xray.ambiguityType, c.expect.ambiguity, `${c.id}: 모호성`);
  }
});

test('기한이 있어도 산출물이 비면 범위 불명이 켜진다', () => {
  // 기한이 적혀 있다는 사실은 **무엇을 해야 하는지**가 정해졌다는 뜻이 아니다.
  // 예전에는 알맹이 게이트가 둘을 같은 것으로 취급해, 어느 숫자가 왜 이상한지
  // 없이 "지금 한 번만 봐달라"는 밤 11시 메시지가 모호성 없음으로 빠졌다.
  const night = corpus.cases.find((c) => c.id === 'night-call');
  const r = analyze(night);
  assert.equal(r.xray.ambiguityType, '범위 불명');
  assert.ok(r.risk.score > 60, `야간 + 범위 불명이면 경계 이상이어야 한다: ${r.risk.score}`);
});

test('정상 업무 대조군은 어떤 대응 방향에서도 Green 을 넘지 않는다', () => {
  const normal = corpus.cases.filter((c) => c.id.startsWith('normal-'));
  for (const c of normal)
    for (const goal of ['칼차단', '시간벌기', '공넘기기', '관계보존'])
      assert.ok(analyze(c, { goal }).risk.score <= 40, `${c.id}/${goal}`);
});

/* ── 판정과 답장이 어긋나지 않는다 ─────────────────────────────
 * 화면에는 "요구 모호성: 없음 · 범위·기한 명확"이 뜨는데 바로 아래 답장이
 * "세부 조건이 명확하지 않아…"로 시작하면, 둘 중 맞는 쪽이 무엇이든 둘 다
 * 못 믿게 된다. 없는 결함을 지어내 요구의 근거로 쓰지 않는다.
 * ──────────────────────────────────────────────────────── */
const CLAIMS_EMPTY = /(명확하지 않아|정해지지 않은|아직 안 정해진|아직 정해지지 않아|빠진 채로|비어 있)/;

test('모호성 "없음" 판정에는 답장이 "비어 있다"고 말하지 않는다', () => {
  for (const c of corpus.cases)
    for (const tone of ['순한맛', '보통맛', '매운맛'])
      for (const goal of ['칼차단', '시간벌기', '공넘기기', '관계보존']) {
        const r = analyze(c, { tone, goal });
        if (r.xray.ambiguityType !== '없음') continue;
        for (const reply of r.replies) {
          assert.ok(!CLAIMS_EMPTY.test(reply.text),
            `${c.id}/${tone}/${goal} "${reply.label}": 모호성 없음인데 비어 있다고 말한다 — ${reply.text}`);
        }
      }
});

test('답장 3종은 이 코퍼스 전체에서 첫 문장이 서로 다르다', () => {
  for (const c of corpus.cases)
    for (const tone of ['순한맛', '보통맛', '매운맛']) {
      const firsts = analyze(c, { tone }).replies.map((r) => r.text.split(/(?<=[.!?])\s/)[0]);
      assert.equal(new Set(firsts).size, 3, `${c.id}/${tone}: ${JSON.stringify(firsts)}`);
    }
});

test('LIVE 지시문도 같은 규칙을 싣는다 (판정과 답장이 어긋나지 않게)', () => {
  const prompt = readFileSync(join(root, 'api/_lib/prompt.js'), 'utf8');
  assert.match(prompt, /네가 방금 내린 판정과 어긋나는 말을 답장에 쓰지 마라/);
});
