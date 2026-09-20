/**
 * 다 고른 영역 접기.
 *
 * 입력 폼이 세로로 길다. 칩 그리드만 다섯 벌(직군 9 · 연차 5 · 관계 9 ·
 * 대응 방향 4 · 말투 3)이라, 다 고르고 나서도 그 자리가 그대로 남아 있으면
 * "내가 지금 뭘 하고 있는 거지"가 된다.
 *
 * 줄이는 건 선택지가 아니라 **이미 끝난 일이 차지하는 자리**다. 실측하면
 * 전부 고른 뒤 폼 높이가 2413px → 1589px 로 줄어든다.
 *
 * 접는 단위가 중요하다. 구역(zone) 단위로 접으면 2구역이 통째로 사라지는데
 * 거기엔 **메시지 입력칸**이 들어 있고, 셀렉터 하나 단위로 접으면 "내 직군"과
 * "내 연차"가 따로 접혔다 펴져 산만하다. 블록이 화면에서 한 덩어리로 읽히는
 * 단위라 거기에 맞췄다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mainJs = readFileSync(join(root, 'src/main.js'), 'utf8');
const css = readFileSync(join(root, 'src/styles.css'), 'utf8');

const bodyOf = (name) => {
  const at = mainJs.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} 을 찾지 못했다`);
  return mainJs.slice(at, mainJs.indexOf('\n}', at));
};

test('쓰는 값이 든 블록은 접지 않는다 (메시지·속사정이 숨으면 안 된다)', () => {
  assert.match(
    bodyOf('initFolding'),
    /!b\.querySelector\('textarea, input'\)/,
    'textarea·input 이 있는 블록을 제외하지 않는다',
  );
});

test('블록의 항목을 전부 골랐을 때만 접는다', () => {
  assert.match(bodyOf('syncFolding'), /f\.fields\.every\(\(k\) => state\[k\]\)/, '완성 여부를 보지 않는다');
});

test('사용자가 직접 펼친 블록은 다시 접히지 않는다', () => {
  // 값을 바꾸려고 펼쳤는데 고르는 순간 도로 접히면 확인할 틈이 없다.
  assert.match(bodyOf('unfold'), /pinned = true/, '펼친 상태를 기억하지 않는다');
  assert.match(bodyOf('syncFolding'), /!f\.pinned/, '고정을 무시하고 접는다');
});

test('다 고르지 못한 상태로 돌아오면 다시 접을 수 있다', () => {
  assert.match(bodyOf('syncFolding'), /if \(!done\) f\.pinned = false/, '고정이 영원히 남는다');
});

test('접힌 줄은 무엇을 골랐는지 보여주고 누를 수 있다', () => {
  const body = bodyOf('syncFolding');
  assert.match(body, /block-folded-value/, '고른 값을 보여주지 않는다');
  assert.match(body, /aria-label/, '스크린리더가 읽을 설명이 없다');
  assert.match(mainJs, /summary\.addEventListener\('click', \(\) => unfold\(block\)\)/, '눌러도 펼쳐지지 않는다');
});

test('접힌 블록은 요약 줄만 남긴다', () => {
  assert.match(css, /\.block\.is-folded > :not\(\.block-folded\) \{ display: none; \}/, '접어도 내용이 남는다');
});

test('접힌 줄의 값이 길어도 레이아웃을 밀지 않는다', () => {
  // "기획·PM/PO · 4~6년" 처럼 값이 길 수 있다. 줄바꿈 대신 말줄임으로 흡수한다.
  const at = css.indexOf('.block-folded-value');
  const rule = css.slice(at, css.indexOf('}', at));
  assert.match(rule, /text-overflow: ellipsis/);
  assert.match(rule, /white-space: nowrap/);
});
