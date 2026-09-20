import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addEntry, getHistory, clearHistory, summarize, entryFromResult, MAX_ENTRIES, HISTORY_KEY,
} from '../src/lib/history.js';

/** localStorage 를 흉내 내는 최소 인메모리 목 — Node 에는 전역 localStorage 가 없다. */
function fakeStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    _dump: () => Object.fromEntries(store),
  };
}

test('storage 가 없으면(Node 등) 조용히 빈 배열을 반환한다 — 크래시하지 않는다', () => {
  assert.deepEqual(getHistory(undefined), []);
  assert.doesNotThrow(() => addEntry({ ts: 1 }, undefined));
  assert.doesNotThrow(() => clearHistory(undefined));
});

test('추가한 항목이 맨 앞에 온다 (최신순)', () => {
  const s = fakeStorage();
  addEntry({ ts: 1, score: 10 }, s);
  addEntry({ ts: 2, score: 20 }, s);
  const list = getHistory(s);
  assert.equal(list.length, 2);
  assert.equal(list[0].ts, 2);
  assert.equal(list[1].ts, 1);
});

test(`${MAX_ENTRIES}개를 넘으면 오래된 것부터 버린다`, () => {
  const s = fakeStorage();
  for (let i = 0; i < MAX_ENTRIES + 10; i += 1) addEntry({ ts: i, score: i }, s);
  const list = getHistory(s);
  assert.equal(list.length, MAX_ENTRIES);
  assert.equal(list[0].ts, MAX_ENTRIES + 9); // 가장 최근
  assert.equal(list[list.length - 1].ts, 10); // 가장 오래된 것 10개가 잘려나감
});

test('clearHistory 로 완전히 비운다', () => {
  const s = fakeStorage();
  addEntry({ ts: 1 }, s);
  clearHistory(s);
  assert.deepEqual(getHistory(s), []);
});

test('저장된 JSON 이 깨져 있어도(수동 편집 등) 크래시 없이 빈 배열을 준다', () => {
  const s = fakeStorage();
  s.setItem(HISTORY_KEY, '{이건 JSON 이 아님');
  assert.deepEqual(getHistory(s), []);
});

test('summarize: 빈 기록', () => {
  assert.deepEqual(summarize([]), { count: 0, avgScore: 0, topVillain: null });
});

test('summarize: 평균 점수와 최다 빌런 유형을 계산한다', () => {
  const history = [
    { score: 90, villain: '주말 도둑형 상사' },
    { score: 50, villain: '주말 도둑형 상사' },
    { score: 70, villain: '영혼 없이 복붙형 동료' },
  ];
  const s = summarize(history);
  assert.equal(s.count, 3);
  assert.equal(s.avgScore, 70); // (90+50+70)/3
  assert.equal(s.topVillain, '주말 도둑형 상사');
});

/**
 * 기록을 눌러 결과 화면을 되살릴 수 있게 되면서 스냅샷(xray/risk/context)이
 * 엔트리에 들어왔다. 예전 이 테스트는 "xray 의 값이 엔트리에 하나도 없어야
 * 한다"를 지켰는데, 그건 목적이 아니라 당시의 구현이었다.
 *
 * 지켜야 할 불변식은 **원문과 실명이 들어가지 않는다**는 것이다. 그리고 그건
 * 구현이 아니라 구조가 보장한다 — 이 함수는 원문도 토큰 맵도 인자로 받지
 * 않는다. 받지 않는 값은 저장될 수 없다. 아래는 그 구조를 고정한다.
 */
test('entryFromResult: 목록용 카테고리와 되살리기용 스냅샷을 함께 뽑는다', () => {
  const xray = { urgencyType: '주말 침범', ambiguityType: '범위 불명', aiSlopScore: 0, avoidsDecision: true, subtext: '{{PERSON_1}}님이 보낸 요청은 범위가 비어 있습니다' };
  const risk = { score: 92, level: 'red', label: '심각' };
  const context = { job: '기획·PM/PO', level: '주니어', counterpart: '직속상사', goal: '칼차단', tone: '매운맛' };
  const entry = entryFromResult(xray, risk, context, {}, new Date(2026, 8, 12, 10, 0, 0));

  assert.equal(entry.score, 92);
  assert.equal(entry.level, 'red');
  assert.equal(entry.villain, '주말 도둑형 상사');
  assert.equal(entry.defenseMode, '🛑 여지없는 칼차단');
  assert.equal(entry.job, '기획·PM/PO');

  // 되살리기에 필요한 것은 전부 snapshot 아래에만 있다 (목록 필드와 섞지 않는다).
  assert.ok(!('subtext' in entry));
  assert.deepEqual(entry.snapshot.risk, risk);
  assert.deepEqual(entry.snapshot.context, context);
  assert.equal(entry.snapshot.xray.subtext, xray.subtext);
});

test('entryFromResult: 원문도 토큰 맵도 인자로 받지 않는다 (구조가 유출을 막는다)', () => {
  // 기본값이 있는 now 는 length 에서 빠진다 — 필수 인자는 xray/risk/context 셋뿐이고,
  // 원문이나 토큰 맵을 넘길 자리 자체가 없다.
  assert.equal(entryFromResult.length, 3);
});

test('저장된 사람 이름은 마스킹 토큰 상태 그대로다 (실명이 복원돼 담기지 않는다)', () => {
  const xray = { subtext: '{{PERSON_1}}님의 요청입니다', replies: [{ label: 'a', text: '{{PERSON_1}}님께 회신드립니다' }] };
  const entry = entryFromResult(xray, { score: 10 }, { counterpart: '선배' }, { replies: xray.replies });
  const json = JSON.stringify(entry);
  assert.ok(json.includes('{{PERSON_1}}'), '토큰이 그대로 남아 있어야 한다');
  assert.ok(!/[가-힣]{2,4}님의 요청/.test(json), '실명으로 복원된 흔적이 없어야 한다');
});
