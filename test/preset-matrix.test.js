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

/**
 * 카드를 고르는 동작과 예시를 적용하는 동작은 다르다.
 *
 * 카드를 고르는 건 **훑어보는 중**이다. 여기서 입력칸으로 스크롤을 끌어내리면
 * 다음 카드를 보려고 다시 올라와야 한다. 반대로 "그대로 적용하기"는 사용자가
 * 명시적으로 요청한 동작이라, 채워진 입력칸으로 데려가는 게 맞다.
 *
 * 둘이 섞이기 쉬운 자리라 소스에서 고정한다.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const mainJs = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src/main.js'), 'utf8');
const bodyOf = (name) => {
  const at = mainJs.indexOf(`function ${name}(`);
  return mainJs.slice(at, mainJs.indexOf('\n}', at));
};

test('카드를 고를 때는 스크롤을 옮기지 않는다', () => {
  assert.ok(!/scrollIntoView/.test(bodyOf('applyPreset')), 'applyPreset 이 스크롤을 옮긴다');
});

test('"그대로 적용하기"는 채워진 입력칸으로 데려간다', () => {
  assert.match(bodyOf('applyPresetMessage'), /scrollIntoView/, '적용 후 입력칸으로 가지 않는다');
});

/**
 * 카드를 바꿨는데 입력칸에 옛 예시가 남아 있으면, 화면의 선택(새 카드)과
 * 내용(옛 카드)이 어긋난다. 그렇다고 무조건 비우면 직접 쓰던 글을 말없이
 * 지우게 된다. 예시에서 온 문장일 때만 비운다.
 */
test('예시 문장인지 판별할 때 관계별 변형까지 본다', () => {
  const body = bodyOf('isPresetText');
  assert.match(body, /byCounterpart/, '변형을 보지 않으면 변형 예시가 안 지워진다');
  assert.match(body, /PRESETS\.some/, '카드 전체와 대조하지 않는다');
});

test('카드를 바꿀 때 예시 문장만 비운다', () => {
  assert.match(bodyOf('applyPreset'), /isPresetText\(el\.message\.value\)/, '예시 여부를 확인하지 않고 비운다');
});
