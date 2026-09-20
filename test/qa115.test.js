/**
 * 115건 QA 코퍼스 — 실사용 패턴 회귀.
 *
 * 이 코퍼스는 **점수 일치율을 지키는 테스트가 아니다.** 등급 눈금을 어디에
 * 그을지는 제품 결정이고, 여기서 고정하면 그 결정을 코드가 대신해 버린다.
 * 대신 이 코퍼스가 실제로 찾아낸 **탐지 결함**만 붙잡는다.
 *
 * 찾아낸 것:
 *  ① 수치가 있으면 권력 비대칭을 2로 낮추던 규칙 — "예산 30% 깎았지만
 *     퀄리티는 똑같이"가 숫자 하나 때문에 정상(16점)으로 나왔다.
 *     GREEN_CAP 이 이미 같은 일을 하고 있어 중복이었고 부작용만 컸다.
 *  ② "오늘 오후 1시까지"처럼 시각이 여러 어절로 흩어진 당일 마감을 놓쳤다.
 *  ③ 휴가·연차 중 연락을 휴일 침범으로 보지 않았다.
 *  ④ "밤늦게", "퇴근하셨죠", "주무실"처럼 시각 없이 드러나는 야간 신호를
 *     놓쳤다.
 *  ⑤ "느낌 알지?", "뭔가 좀 아쉬운데" 같은 **느낌형 지시**를 범위 불명으로
 *     보지 않았다 — 실사용에서 가장 흔한 모호성 패턴인데 사전에 없었다.
 *  ⑥ "저희 법무팀은 사후 검토만 합니다"처럼 부서를 주어로 세워 책임을
 *     옮기는 형태를 R&R 미지정으로 보지 않았다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mask } from '../src/lib/mask.js';
import { buildMockAnalysis } from '../src/lib/mock.js';
import { buildResult } from '../src/lib/normalize.js';
import { detectUrgency, detectAmbiguity, extractSubstanceSignals } from '../src/lib/cliche.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const corpus = JSON.parse(readFileSync(join(root, 'test/fixtures/qa-community-115.json'), 'utf8'));

const analyze = (text, counterpart, over = {}) => {
  const { maskedText } = mask(text);
  return buildResult(buildMockAnalysis(maskedText, {
    job: '기획·PM/PO', level: '주니어', counterpart, goal: '시간벌기', tone: '보통맛', ...over,
  }), maskedText);
};
const find = (id) => corpus.cases.find((c) => c.id === id);
const ambiguityOf = (t) => detectAmbiguity(t, extractSubstanceSignals(t));

test('115건 전부 오류 없이 끝까지 처리된다', () => {
  for (const c of corpus.cases) {
    const r = analyze(c.raw_text, c.counterpart);
    assert.ok(Number.isInteger(r.risk.score) && r.risk.score >= 0 && r.risk.score <= 100, c.id);
    assert.equal(r.replies.length, 3, `${c.id}: 답장 3개가 안 나온다`);
    for (const reply of r.replies) assert.ok(reply.text.length > 20, `${c.id}: ${reply.label}`);
  }
});

test('① 거절 비용은 관계가 정한다 — 메시지에 수치가 있다고 낮추지 않는다', () => {
  const c = find('CASE_009'); // "예산은 30% 깎았지만 퀄리티는 똑같이 맞춰주셔야"
  const r = analyze(c.raw_text, c.counterpart);
  assert.equal(r.xray.powerAsymmetry, 5, '클라이언트 거절 비용이 수치 때문에 깎였다');
  // 같은 관계면 수치 유무와 무관하게 같은 거절 비용이어야 한다.
  assert.equal(analyze('시안 다시 부탁드려요.', '클라이언트').xray.powerAsymmetry, 5);
  assert.equal(analyze('9월 15일 14시까지 배너 2종, 1200x600 부탁드립니다.', '직속상사').xray.powerAsymmetry, 4);
});

test('정상 업무 대조군은 그래도 Green 을 넘지 않는다 (GREEN_CAP 이 지킨다)', () => {
  // ① 을 되돌린 뒤에도 과잉경보가 생기지 않아야 한다. 권력 강등이 없어도
  // 긴급도·모호성·알맹이가 모두 0이면 상한 20점이다.
  for (const cp of ['직속상사', '임원', '클라이언트'])
    for (const goal of ['칼차단', '시간벌기', '공넘기기', '관계보존'])
      assert.ok(
        analyze('9월 15일 14시까지 배너 시안 2종 부탁드립니다. 사이즈는 1200x600, 문구는 첨부 3페이지 기준입니다.', cp, { goal }).risk.score <= 20,
        `${cp}/${goal}`,
      );
});

test('② 시각이 흩어진 당일 마감을 잡는다', () => {
  assert.equal(detectUrgency('오늘 오후 1시까지 시장 조사 보고서 완성해서 가져와'), '당일 마감');
  assert.equal(detectUrgency('내일 아침 9시 오픈 전까지 세팅 다 끝내주세요'), '당일 마감');
  // 기한이 뒤로 밀린 문장은 그대로 둔다.
  assert.notEqual(detectUrgency('오늘 말씀하신 건은 다음주까지 부탁드려요'), '당일 마감');
  assert.notEqual(detectUrgency('오늘 회의에서 나온 내용은 다음 주까지 정리해 주세요'), '당일 마감');
});

test('③ 휴가·연차 중 연락은 휴일 침범이다 (제55조)', () => {
  for (const t of ['휴가 중에 미안~ 파일 위치 좀 알려줄 수 있어?', '지금 휴가 중인 거 아는데 딱 5분이면 돼', '연차 중에 미안한데 이것만 봐줄래?'])
    assert.equal(detectUrgency(t), '주말 침범', t);
});

test('④ 시각 없이 드러나는 야간 신호를 잡는다', () => {
  for (const t of ['밤늦게 톡해서 미안한데 내일 아침에 이 방향으로 수정해봅시다', '퇴근하셨죠? 오늘 밤에 수정 반영만 쓱 해놓고 주무실 수 있을까요?'])
    assert.equal(detectUrgency(t), '야간 침범', t);
});

test('⑤ 느낌형 지시를 범위 불명으로 본다 — 실사용에서 가장 흔한 모호성', () => {
  for (const t of [
    '디자인이 좀 밋밋한데 요즘 애들 좋아하는 그런 느낌 알지? 느낌 느낌!',
    '뭔가 좀 아쉬운데 더 임팩트 있게 갈 수 없을까?',
    '뭔가 부족한데 뭐가 부족한지는 나도 딱 꼬집어 말을 못 하겠네',
    '내가 무슨 말 하는지 알지? 그 느낌 살려서 내일 오전에 봅시다',
  ]) assert.equal(ambiguityOf(t), '범위 불명', t);
  // 기준이 적힌 수정 요청은 그대로 둔다.
  assert.equal(ambiguityOf('수정 포인트는 공유 문서 2페이지에 정리해 뒀습니다. 9월 22일 14시까지 부탁드립니다.'), '없음');
});

test('⑥ 부서를 주어로 세운 책임 전가를 R&R 미지정으로 본다', () => {
  for (const t of [
    '저희 법무팀은 사후 검토만 합니다. 개발팀에서 자체적으로 하시는 거 아닌가요?',
    '저희 팀은 인력이 부족해서요. 기획팀에서 이벤트 운영까지 맡아주시는 게 맞지 않을까요?',
  ]) assert.equal(ambiguityOf(t), 'R&R 미지정', t);
});

test('범위 밖 6유형은 못 본다는 사실을 코퍼스가 기록한다', () => {
  // 요구가 없는 메시지(인격 공격·감시·공 가로채기·배제·비꼬기·사생활)는
  // 네 축이 구조적으로 보지 못한다. 점수를 맞추려고 축을 늘리는 대신
  // 못 본다는 사실을 남겨 둔다.
  const out = corpus.cases.filter((c) => c.out_of_scope);
  assert.ok(out.length >= 40, `범위 밖 표시가 너무 적다: ${out.length}`);
  assert.ok(corpus._scope_note.includes('구조적으로 보이지 않는다'));
});
