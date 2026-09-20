/**
 * 다 고른 영역 접기.
 *
 * 입력 폼이 세로로 길다. 칩 그리드만 다섯 벌(직군 9 · 연차 5 · 관계 9 ·
 * 대응 방향 4 · 말투 3)이라, 다 고르고 나서도 그 자리가 그대로 남아 있으면
 * "내가 지금 뭘 하고 있는 거지"가 된다.
 *
 * 규칙은 하나뿐이다. **접힘 ⟺ 그 블록을 다 골랐다.**
 *
 * 처음에는 "변경"을 누르면 펼친 채로 고정했었다(pinned). 그러면 세 번째
 * 상태가 생긴다 — 다 골랐는데 펼쳐져 있는 블록. 화면만 보고는 아직 고르는
 * 중인지 이미 정한 건지 구분이 안 되고, 실행 직전에 전체를 훑는 경험도
 * 깨진다. 지금은 **"변경"이 그 블록의 선택을 지운다.** 지우면 미완성이라
 * 펼쳐지고, 다시 고르면 다시 접힌다. 상태가 둘뿐이라 화면이 곧 진행 상황이다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mainJs = readFileSync(join(root, 'src/main.js'), 'utf8');
const css = readFileSync(join(root, 'src/styles.css'), 'utf8');
const html = readFileSync(join(root, 'index.html'), 'utf8');

const bodyOf = (name) => {
  const at = mainJs.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} 을 찾지 못했다`);
  return mainJs.slice(at, mainJs.indexOf('\n}', at));
};

test('접힘 상태는 둘뿐이다 — 펼친 채 고정하는 세 번째 상태가 없다', () => {
  // 주석은 왜 고정을 없앴는지 설명하며 그 이름을 인용하므로 걷어내고 본다.
  const code = mainJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/pinned/.test(code), '고정(pinned) 상태가 되살아났다');
});

test('"변경"은 그 블록의 선택을 지운다 (펼치기만 하지 않는다)', () => {
  const body = bodyOf('resetBlock');
  assert.match(body, /state\[field\] = ''/, '선택값을 지우지 않는다');
  assert.match(body, /aria-checked', 'false'/, '칩의 선택 표시를 떼지 않는다');
  assert.match(mainJs, /summary\.addEventListener\('click', \(\) => resetBlock\(key\)\)/, '"변경"이 초기화로 이어지지 않는다');
});

test('접기 대상은 명시한 세 블록뿐이다', () => {
  const keys = [...html.matchAll(/data-fold="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(keys, ['me', 'them', 'reply']);
});

test('쓰는 값이 든 블록은 접지 않는다 (메시지·속사정이 숨으면 안 된다)', () => {
  // data-fold 가 붙은 블록 안에 textarea·input 이 있으면 접힐 때 함께 숨는다.
  for (const m of html.matchAll(/<div class="block" data-fold="\w+">([\s\S]*?)\n        <\/div>/g)) {
    assert.ok(!/<textarea|<input/.test(m[1]), '접히는 블록에 입력칸이 들어 있다');
  }
});

test('관계와 상황 카드가 한 블록이다', () => {
  const at = html.indexOf('data-fold="them"');
  const block = html.slice(at, html.indexOf('<!-- 받은 메시지 -->', at));
  assert.match(block, /data-field="counterpart"/, '관계가 없다');
  assert.match(block, /id="preset-grid"/, '상황 카드가 없다');
});

test('대응 방향과 말투 세기가 한 블록이다', () => {
  const at = html.indexOf('data-fold="reply"');
  const block = html.slice(at, html.indexOf('나의 숨은 속사정', at));
  assert.match(block, /data-field="goal"/, '대응 방향이 없다');
  assert.match(block, /data-field="tone"/, '말투 세기가 없다');
});

test('선택 항목(숨은 속사정)은 고르는 것들 아래에 있다', () => {
  // 맨 위에 있으면 먼저 채워야 하는 칸으로 읽힌다.
  assert.ok(html.indexOf('data-field="tone"') < html.indexOf('나의 숨은 속사정'), '속사정이 말투 세기보다 위에 있다');
});

/**
 * 2구역은 관계와 상황을 고른 **그 자리에서** 접는다.
 *
 * 한때 메시지가 채워질 때까지 기다렸다 접었는데, 카드를 고르고 한참 지난 뒤에
 * 화면이 접혀서 어색했다. 관계와 상황을 다 골랐으면 이 구역에서 정할 것은
 * 끝난 것이다.
 *
 * 대신 조건이 하나 붙는다. **"그대로 적용하기" 버튼이 이 블록 밖에 있어야
 * 한다.** 안에 있으면 카드를 누른 순간 버튼도 같이 접혀 누를 기회가 없다.
 * 둘은 한 몸이라 따로 고쳐서는 안 된다.
 */
test('2구역은 카드를 고른 그 자리에서 접힌다', () => {
  const at = mainJs.indexOf('them: {');
  const spec = mainJs.slice(at, mainJs.indexOf('},', at));
  assert.match(spec, /done: \(\) => Boolean\(activePreset\)/, '카드 선택으로 접지 않는다');
  // 카드를 안 고르고 직접 쓰는 사람도 같은 시점에 접혀야 한다.
  assert.match(spec, /el\.message\.value\.trim\(\)\.length > 0/, '직접 입력하면 영영 안 접힌다');
  assert.match(bodyOf('applyPreset'), /syncFolding\(\)/, '카드를 골라도 접힘이 갱신되지 않는다');
});

test('"그대로 적용하기"는 접히는 블록 밖에 있다', () => {
  const at = html.indexOf('data-fold="them"');
  const block = html.slice(at, html.indexOf('<!-- 받은 메시지 -->', at));
  const foldEnd = block.indexOf('\n        </div>');
  assert.ok(foldEnd > 0, '블록의 끝을 찾지 못했다');
  assert.ok(
    !block.slice(0, foldEnd).includes('id="preset-run"'),
    '적용 버튼이 블록 안에 있다 — 카드를 누르는 순간 같이 접혀 누를 수 없다',
  );
  assert.ok(block.includes('id="preset-run"'), '적용 버튼이 2구역에서 사라졌다');
});

test('메시지를 고치면 접힘 여부도 따라간다', () => {
  assert.match(bodyOf('onInput'), /syncFolding\(\)/, '입력 변화가 접힘에 반영되지 않는다');
});

test('접힌 줄은 무엇을 골랐는지 보여주고 누를 수 있다', () => {
  const body = bodyOf('syncFolding');
  assert.match(body, /block-folded-value/, '고른 값을 보여주지 않는다');
  assert.match(body, /aria-label/, '스크린리더가 읽을 설명이 없다');
});

test('접힌 블록은 요약 줄만 남긴다', () => {
  assert.match(css, /\.block\.is-folded > :not\(\.block-folded\) \{ display: none; \}/, '접어도 내용이 남는다');
});

test('접힌 줄의 값이 길어도 레이아웃을 밀지 않는다', () => {
  const at = css.indexOf('.block-folded-value');
  const rule = css.slice(at, css.indexOf('}', at));
  assert.match(rule, /text-overflow: ellipsis/);
  assert.match(rule, /white-space: nowrap/);
});
