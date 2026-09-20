/**
 * "이 결과, 어떻게 나왔나요?"
 *
 * 결과 화면 곳곳에서 처리 방식을 설명하고 있었다. 답장 위에는 "규칙 기반 예시
 * 답장입니다(모델 미연동). 목적·말투에 따라 갈라지긴 하지만 메시지 내용을
 * 세세히 읽고 쓰진 않아요." 가 떠 있었다.
 *
 * 사실이긴 한데 **사용자가 그 문장으로 할 수 있는 일이 없다.** 모델이 붙었는지는
 * 우리 사정이지 답장을 쓰는 사람의 관심사가 아니다. 본문은 행동으로 옮길 수
 * 있는 것만 남기고, 처리 방식은 **궁금해진 사람만** 배지를 눌러 보게 했다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const mainJs = readFileSync(join(root, 'src/main.js'), 'utf8');

test('배지를 눌러 설명을 열 수 있다', () => {
  const at = html.indexOf('id="mode-badge"');
  const tag = html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
  assert.match(tag, /^<button/, '배지가 버튼이 아니다 — 눌러도 열리지 않는다');
  assert.match(tag, /aria-haspopup="dialog"/, '무엇이 열리는지 알리지 않는다');
  assert.match(mainJs, /el\.modeBadge\.addEventListener\('click', openHowModal\)/, '배선이 없다');
});

test('설명은 처리 순서를 네 단계로 보여준다', () => {
  const modal = html.slice(html.indexOf('id="how-modal"'), html.indexOf('id="history-modal"'));
  assert.equal((modal.match(/<li>/g) || []).length, 4, '단계 수가 달라졌다');
  // 이 서비스의 주장이 여기 다 들어 있어야 한다.
  assert.match(modal, /가립니다/, '마스킹 설명이 없다');
  assert.match(modal, /AI는 점수를 매기지 않습니다/, 'AI 가 하지 않는 일이 빠졌다');
  assert.match(modal, /코드가 계산/, '점수를 누가 계산하는지가 없다');
});

test('"지금 결과"는 경로마다 다른 문장을 보여준다', () => {
  const at = mainJs.indexOf('const HOW_NOW = {');
  const map = mainJs.slice(at, mainJs.indexOf('};', at));
  for (const mode of ['live', 'mock', 'local', 'cached']) {
    assert.ok(map.includes(`${mode}:`), `${mode} 경로의 설명이 없다`);
  }
});

test('답장 위 안내에 구현 사정을 적지 않는다', () => {
  const fn = mainJs.slice(mainJs.indexOf('function renderRepliesModeNote'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  const shown = [...body.matchAll(/'([^']*ℹ️[^']*)'/g)].map((m) => m[1]).join(' ');
  assert.ok(shown, '안내 문구를 찾지 못했다');
  for (const jargon of ['모델 미연동', '규칙 기반', '룰엔진', '캐시']) {
    assert.ok(!shown.includes(jargon), `본문에 구현 사정("${jargon}")이 남아 있다`);
  }
  // 대신 사용자가 할 수 있는 일이 적혀 있어야 한다.
  assert.match(shown, /고쳐서 쓰/, '사용자가 무엇을 하면 되는지가 없다');
});
