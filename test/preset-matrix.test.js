/**
 * 상황 카드 × 상대방 매트릭스.
 *
 * 카드 하나가 여러 관계(fits)에 걸리면서, 예전에는 관계를 무엇으로 고르든
 * 같은 예시 문구가 나왔다. 임원으로 고르든 선배로 고르든 "대표님 보고가
 * 잡혀서요"가 뜨는 식인데, 선배는 그렇게 말하지 않는다. 그래서 관계별
 * 변형(byCounterpart)을 넣었다.
 *
 * 변형은 **문구만 바꾸는 게 아니라 신호까지 바꾼다.** 실제로 처음 써 본
 * 11개 변형 중 5개가 자기 카드로 매칭되지 않았다 — "이렇게 늦은 시간에"를
 * "이 밤에"로 줄이자 야간 침범 신호가 사라졌고, 상투어를 덜어낸 AI 복붙
 * 변형은 슬롭 점수가 기준선 아래로 내려갔다. 그 상태로 두면 카드에서 예시를
 * 적용한 순간 "이런 상황인가요?" 힌트가 **다른 카드**를 가리킨다.
 *
 * 그래서 문구를 고칠 때마다 전 조합을 다시 확인한다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS } from '../src/data/presets.js';
import { matchSituationId } from '../src/lib/situation-match.js';

/** 화면(main.js presetText)과 같은 해석 규칙. */
const textFor = (p, who) => p.byCounterpart?.[who] || p.text;

test('모든 (상황 × 관계) 조합이 자기 자신의 카드로 매칭된다', () => {
  const misses = [];
  let combos = 0;
  for (const p of PRESETS) {
    for (const who of p.fits) {
      combos++;
      const got = matchSituationId(textFor(p, who), who);
      if (got !== p.id) misses.push(`${p.id}/${who} -> ${got}`);
    }
  }
  assert.ok(combos >= 21, `조합이 줄었다 (${combos}건)`);
  assert.deepEqual(misses, [], `자기 카드로 안 잡히는 조합: ${misses.join(', ')}`);
});

test('변형은 기본 문구와 실제로 다르다 (같은 문구를 복사만 해 두지 않았는지)', () => {
  for (const p of PRESETS) {
    for (const [who, text] of Object.entries(p.byCounterpart || {})) {
      assert.notEqual(text, p.text, `${p.id}/${who} 변형이 기본과 같다`);
      assert.ok(p.fits.includes(who), `${p.id} 의 변형 '${who}' 가 fits 에 없다`);
    }
  }
});

test('예시 문구에 실명·줄표가 들어가지 않는다', () => {
  for (const p of PRESETS) {
    for (const text of [p.text, ...Object.values(p.byCounterpart || {})]) {
      assert.ok(!/[—–]/.test(text), `${p.id}: 줄표가 들어 있다`);
      assert.ok(!/(박지훈|김민수|이영희)/.test(text), `${p.id}: 실명이 들어 있다`);
    }
  }
});
