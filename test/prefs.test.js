import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPrefs, savePrefs, clearPrefs, PREFS_KEY, PREF_FIELDS } from '../src/lib/prefs.js';

/**
 * 직전 선택 기억 — 재방문 시 폼을 다시 고르지 않게 한다.
 *
 * 핵심 회귀 포인트 두 개:
 *  1) 저장된 값이 현재 선택지에 없으면 버려야 한다. 그대로 state 에 넣으면
 *     칩이 하나도 선택되지 않은 화면이 나온다(선택지 목록은 실제로 바뀐 적이
 *     있다 — "비즈니스"가 사라지고 8종으로 확장됐다).
 *  2) 자유 입력(메시지·숨은 속사정)은 절대 저장되지 않아야 한다.
 */

const OPTIONS = {
  job: ['기획·PM/PO', '개발(Dev)', '기타'],
  level: ['주니어(1~3년)', '시니어(4~7년)'],
  counterpart: ['직속상사', '클라이언트'],
  goal: ['🛑 칼차단', '⏳ 시간벌기'],
  tone: ['🟢 순한맛', '🟡 보통맛'],
};

/** localStorage 흉내 — 실패 주입도 할 수 있게 직접 만든다. */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: (k) => map.delete(k),
    _dump: () => Object.fromEntries(map),
  };
}

test('저장한 선택을 그대로 복원한다', () => {
  const s = fakeStorage();
  savePrefs({ job: '개발(Dev)', level: '시니어(4~7년)', counterpart: '클라이언트', goal: '⏳ 시간벌기', tone: '🟡 보통맛' }, s);
  assert.deepEqual(loadPrefs(OPTIONS, s), {
    job: '개발(Dev)',
    level: '시니어(4~7년)',
    counterpart: '클라이언트',
    goal: '⏳ 시간벌기',
    tone: '🟡 보통맛',
  });
});

test('현재 선택지에 없는 값은 버린다 (선택지 목록이 바뀐 경우)', () => {
  // '비즈니스'는 실제로 제거된 옛 직군이다.
  const s = fakeStorage({ [PREFS_KEY]: JSON.stringify({ job: '비즈니스', counterpart: '직속상사' }) });
  const loaded = loadPrefs(OPTIONS, s);
  assert.equal(loaded.job, undefined, '없어진 직군이 그대로 복원되면 칩이 하나도 안 켜진다');
  assert.equal(loaded.counterpart, '직속상사', '살아 있는 값은 유지돼야 한다');
});

test('자유 입력 필드는 저장하지 않는다 (원문·숨은 속사정 유출 방지)', () => {
  const s = fakeStorage();
  savePrefs({ job: '기타', message: '실제 메시지 원문', hiddenContext: '가족 행사로 외지에 있음' }, s);
  const saved = JSON.parse(s._dump()[PREFS_KEY]);
  assert.deepEqual(Object.keys(saved), ['job']);
  for (const leaked of ['message', 'hiddenContext']) {
    assert.equal(saved[leaked], undefined, `${leaked} 가 저장되면 안 된다`);
  }
  assert.ok(PREF_FIELDS.every((f) => f !== 'message' && f !== 'hiddenContext'));
});

test('저장된 값이 깨져 있어도 기본값으로 떨어진다', () => {
  assert.deepEqual(loadPrefs(OPTIONS, fakeStorage({ [PREFS_KEY]: '{not json' })), {});
  assert.deepEqual(loadPrefs(OPTIONS, fakeStorage({ [PREFS_KEY]: 'null' })), {});
  assert.deepEqual(loadPrefs(OPTIONS, fakeStorage({ [PREFS_KEY]: '["배열"]' })), {});
});

test('저장소가 없어도(프라이빗 브라우징 등) 예외를 던지지 않는다', () => {
  assert.deepEqual(loadPrefs(OPTIONS, undefined), {});
  assert.doesNotThrow(() => savePrefs({ job: '기타' }, undefined));
  assert.doesNotThrow(() => clearPrefs(undefined));
});

test('저장소가 setItem 에서 던져도 삼킨다 (쿼터 초과)', () => {
  const s = fakeStorage();
  s.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.doesNotThrow(() => savePrefs({ job: '기타' }, s));
});

test('clearPrefs 후에는 빈 객체가 나온다', () => {
  const s = fakeStorage();
  savePrefs({ job: '기타' }, s);
  clearPrefs(s);
  assert.deepEqual(loadPrefs(OPTIONS, s), {});
});
