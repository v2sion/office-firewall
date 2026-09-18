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

test('entryFromResult: 원문 관련 필드를 전혀 참조하지 않고 카테고리만 뽑는다', () => {
  const xray = { urgencyType: '주말 침범', ambiguityType: '범위 불명', aiSlopScore: 0, avoidsDecision: true, subtext: '원문 유출되면 안 되는 문장' };
  const risk = { score: 92, level: 'red', label: '심각' };
  const context = { job: '기획·PM/PO', level: '주니어', counterpart: '직속상사', goal: '칼차단', tone: '매운맛' };
  const entry = entryFromResult(xray, risk, context, new Date(2026, 8, 12, 10, 0, 0));

  assert.equal(entry.score, 92);
  assert.equal(entry.level, 'red');
  assert.equal(entry.villain, '주말 도둑형 상사');
  assert.equal(entry.defenseMode, '🛑 여지없는 칼차단');
  assert.equal(entry.job, '기획·PM/PO');
  assert.ok(!('subtext' in entry));
  assert.ok(!JSON.stringify(entry).includes('원문 유출'));
});
