/**
 * 고용노동부 기준 코퍼스 회귀.
 *
 * 커뮤니티 코퍼스가 "사람들이 실제로 받는 메시지"를 본다면, 이쪽은
 * **판단 기준 쪽**을 본다. 고용노동부 「직장 내 괴롭힘 판단 및 예방·대응
 * 매뉴얼」의 행위 예시와 판단 유형을 메시지 한 통으로 옮겨, 인정형은 신호가
 * 잡히는지 · 불인정형은 **과잉경보가 붙지 않는지**를 같이 본다.
 *
 * 불인정형이 이 코퍼스의 핵심이다. 우리 대조군은 여태 우리가 쓴 "정상 업무
 * 메시지" 두 개뿐이었다. 고용노동부가 "괴롭힘 아님"으로 본 유형에서 가져오면,
 * 과잉방어를 막는 기준이 우리 취향이 아니라 행정 기준이 된다.
 *
 * 이 코퍼스가 실제로 잡아낸 것:
 *  ① 긴급성을 위험으로만 봤다 — 장애 대응 야간 연락과 단순 야간 지시가
 *     똑같이 52점이었다. 매뉴얼은 긴급성을 **정당화 요소**로 본다.
 *  ② "오늘 18시까지"를 당일 마감으로 못 잡았다 ("오늘까지"만 찾고 있었다).
 *  ③ 촉박한 마감 자체에 20점을 얹고 있었다 — 매뉴얼은 "마감이 촉박한 것
 *     자체는 괴롭힘으로 보기 어렵다"고 한다.
 *
 * @see test/fixtures/moel-corpus.json
 * @see src/lib/legal-basis.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mask } from '../src/lib/mask.js';
import { buildMockAnalysis } from '../src/lib/mock.js';
import { buildResult } from '../src/lib/normalize.js';
import { hasUrgencyJustification, detectUrgency } from '../src/lib/cliche.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const corpus = JSON.parse(readFileSync(join(root, 'test/fixtures/moel-corpus.json'), 'utf8'));
const testable = corpus.cases.filter((c) => c.testable !== false);

function analyze(c, over = {}) {
  const { maskedText } = mask(c.text);
  return buildResult(buildMockAnalysis(maskedText, {
    job: '기획·PM/PO', level: '주니어', counterpart: c.counterpart,
    goal: '시간벌기', tone: '보통맛', ...over,
  }), maskedText);
}

test('고용노동부 기준 코퍼스가 기대 구간 안에 든다', () => {
  for (const c of testable) {
    const r = analyze(c);
    const [lo, hi] = c.expect.band;
    assert.ok(r.risk.score >= lo && r.risk.score <= hi,
      `${c.id}(${c.type}): ${r.risk.score}점 — 기대 ${lo}~${hi}\n  근거: ${c.basis}`);
    if (c.expect.urgency) assert.equal(r.xray.urgencyType, c.expect.urgency, `${c.id}: 긴급도`);
    if (c.expect.justified !== undefined)
      assert.equal(Boolean(r.xray.urgencyJustified), c.expect.justified, `${c.id}: 긴급 사유 인정`);
  }
});

test('불인정형(정당한 업무지시)에는 어떤 대응 방향에서도 경보를 올리지 않는다', () => {
  // 과잉방어는 이 제품의 신뢰를 가장 빠르게 깎는다. 고용노동부가 "괴롭힘
  // 아님"으로 본 유형이 경계(61점) 위로 올라가면 그건 우리 눈금이 틀린 것이다.
  for (const c of testable.filter((x) => x.type === '불인정형'))
    for (const goal of ['칼차단', '시간벌기', '공넘기기', '관계보존'])
      for (const counterpart of ['직속상사', '임원', '클라이언트']) {
        const score = analyze(c, { goal, counterpart }).risk.score;
        assert.ok(score <= 60, `${c.id}/${goal}/${counterpart}: ${score}점 — 과잉경보\n  ${c.manual}`);
      }
});

/* ── ① 긴급성은 정당화 요소다 ─────────────────────────────── */

test('장애 대응 야간 연락과 단순 야간 지시를 구분한다', () => {
  const incident = '밤 11시에 죄송합니다. 결제 서버 장애로 지금 고객 결제가 전부 실패하고 있습니다. 로그만 확인해 주실 수 있을까요?';
  const errand = '밤 11시인데 미안해요. 지난번 그 자료 지금 한번 봐줄 수 있어요? 내일 오전에 쓸 것 같아서요.';
  // 둘 다 야간 침범이다 — 다른 것은 **왜 지금이어야 하는지**다.
  assert.equal(detectUrgency(incident), '야간 침범');
  assert.equal(detectUrgency(errand), '야간 침범');
  assert.equal(hasUrgencyJustification(incident), true);
  assert.equal(hasUrgencyJustification(errand), false);

  const ctx = { job: '기획·PM/PO', level: '주니어', counterpart: '직속상사', goal: '시간벌기', tone: '보통맛' };
  const s = (t) => buildResult(buildMockAnalysis(mask(t).maskedText, ctx), mask(t).maskedText).risk.score;
  assert.ok(s(incident) < s(errand), `장애 대응이 더 높게 나온다: ${s(incident)} vs ${s(errand)}`);
  assert.ok(s(incident) <= 20, `정당한 장애 대응 연락이 정상 구간을 넘는다: ${s(incident)}`);
});

test('내부 일정은 긴급 사유가 아니다', () => {
  // "대표님 보고가 잡혀서"는 보내는 쪽의 편의이지, 받는 쪽이 밤·주말에 일할
  // 이유가 아니다. 매뉴얼이 말하는 긴급성도 그런 뜻이 아니다.
  for (const t of [
    '주말에 미안한데, 월요일 오전에 대표님 보고가 잡혀서요. 시간 날 때 한번 봐주시면 좋을 것 같아요.',
    '밤 11시인데 내일 아침에 제가 먼저 봐야 해서요. 지금 정리해서 올려두세요.',
  ]) assert.equal(hasUrgencyJustification(t), false, t);
});

test('부정형은 긴급 사유로 세지 않는다', () => {
  // 사유를 인정하면 점수가 **깎이므로**, 여기서의 오탐은 과소경보가 된다.
  assert.equal(hasUrgencyJustification('밤 12시인데 장애 없이 잘 돌아가는지 그냥 한번 봐줄래요?'), false);
  assert.equal(hasUrgencyJustification('주말에 미안한데 오류는 없는지만 확인해 줄 수 있어요?'), false);
  assert.equal(hasUrgencyJustification('서버가 다운돼서 서비스가 중단됐습니다.'), true);
});

/* ── ②③ 당일 마감 ────────────────────────────────────────── */

test('"오늘 18시까지"처럼 시각이 붙은 당일 마감을 잡는다', () => {
  for (const t of ['오늘 18시까지 견적서 주세요', '금일 15시까지 부탁드립니다', '오늘 6시까지요', '오늘까지 부탁해요'])
    assert.equal(detectUrgency(t), '당일 마감', t);
  // 날짜어가 있다고 무조건 붙이지는 않는다.
  assert.notEqual(detectUrgency('오늘 회의에서 나온 내용은 다음 주까지 정리해 주세요'), '당일 마감');
});

test('촉박한 마감 자체는 가산하지 않고, 모호성과 겹칠 때만 센다', () => {
  const ctx = { job: '기획·PM/PO', level: '주니어', counterpart: '직속상사', goal: '시간벌기', tone: '보통맛' };
  const s = (t) => buildResult(buildMockAnalysis(mask(t).maskedText, ctx), mask(t).maskedText).risk.score;
  // 무엇을 언제까지 할지 다 적힌 당일 마감 — 매뉴얼상 불인정 유형이다.
  const clear = '오늘 18시까지 견적서 1종만 먼저 주세요. 양식은 지난번 것 그대로 쓰시면 됩니다.';
  // 뭘 해야 하는지도 모르는 당일 마감 — 이건 다르다.
  const vague = '오늘 중으로 다시 작업해서 보내주세요. 뭔가 좀 아닌 것 같아요.';
  assert.ok(s(clear) <= 20, `구체적인 당일 마감에 경보가 붙는다: ${s(clear)}`);
  assert.ok(s(vague) > 60, `기준 없는 당일 마감을 놓친다: ${s(vague)}`);
});

test('판정 근거 화면이 긴급 사유 미집계를 밝힌다', () => {
  // 점수가 안 붙은 이유를 말해 주지 않으면, 밤 11시 장애 연락에 경보가 없는
  // 것이 고장으로 읽힌다.
  const mainJs = readFileSync(join(root, 'src/main.js'), 'utf8');
  assert.match(mainJs, /긴급 사유 명시 · 미집계/);
  assert.match(mainJs, /긴급 사유가 본문에 있어 시간대 가산을 하지 않았습니다/);
});

test('판정 불가 유형은 이유와 함께 남겨 둔다', () => {
  // 감시·배제처럼 기간에 걸친 행위는 메시지 한 통으로 볼 수 없다. 못 본다는
  // 사실을 코퍼스에 적어 두지 않으면 "커버한다"는 착각이 남는다.
  const skipped = corpus.cases.filter((c) => c.testable === false);
  assert.ok(skipped.length >= 2, '판정 불가 유형이 기록돼 있지 않다');
  for (const c of skipped) assert.ok(c.why && c.why.length > 20, `${c.id}: 왜 못 보는지가 없다`);
});

test('LIVE 지시문도 긴급 사유와 내부 일정을 구분하게 한다', () => {
  const prompt = readFileSync(join(root, 'api/_lib/prompt.js'), 'utf8');
  assert.match(prompt, /밤·주말 연락이라고 무조건 문제로 보지 마라/);
  assert.match(prompt, /내부\s*\*\*\s*일정|내부\n  일정|\*\*내부\n  일정\*\*|내부\*\*\n  \*\*일정|내부/);
  assert.match(prompt, /오늘 18시까지/, '시각이 붙은 당일 마감 예시가 없다');
});
