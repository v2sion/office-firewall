/**
 * "도움받을 수 있는 곳" 창구 구성.
 *
 * 예전에는 근로복지공단 EAP 하나만 걸어 뒀다. 그 프로그램은 중소기업 재직자 등
 * **대상이 정해져 있어서**, 해당되지 않는 사람이 누르면 "대상이 아닙니다"로
 * 끝난다. 힘들어서 누른 사람에게 그 경험을 주면 안 된다.
 *
 * 그래서 지켜야 할 규칙은 둘이다.
 *  1) 조건 없이 누구나 쓸 수 있는 창구가 **먼저** 나온다.
 *  2) 조건이 있는 창구는 누르기 **전에** 그 사실이 보인다.
 *
 * 링크를 손볼 때 이 순서가 조용히 뒤집히기 쉬워서 고정해 둔다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');

/** #care-links 안의 링크를 순서대로 뽑는다. */
function careLinks() {
  const block = html.slice(html.indexOf('<div class="care-links"'), html.indexOf('</aside>'));
  return [...block.matchAll(/<a class="care-link([^"]*)"[^>]*href="([^"]+)"[\s\S]*?<\/a>/g)].map((m) => ({
    cls: m[1],
    href: m[2],
    conditional: /care-tag-cond/.test(m[0]),
    universal: /care-tag">누구나</.test(m[0]),
    body: m[0],
  }));
}

test('조건 없는 창구가 조건 있는 창구보다 먼저 나온다', () => {
  const links = careLinks().filter((l) => !/care-link-wanted/.test(l.cls));
  const firstConditional = links.findIndex((l) => l.conditional);
  const lastUniversal = links.map((l) => l.universal).lastIndexOf(true);
  assert.ok(firstConditional > 0, '조건부 창구를 찾지 못했다');
  assert.ok(lastUniversal < firstConditional, '조건 있는 창구가 조건 없는 창구보다 앞에 있다');
});

test('누구나 쓸 수 있는 창구가 최소 둘 이상이다', () => {
  const universal = careLinks().filter((l) => l.universal);
  assert.ok(universal.length >= 2, `현재 ${universal.length}개 — EAP 하나만 남던 상태로 돌아갔다`);
});

test('EAP 는 조건이 있다는 사실이 라벨과 설명에 드러난다', () => {
  const eap = careLinks().find((l) => l.href.includes('comwel'));
  assert.ok(eap, 'EAP 링크가 없다');
  assert.ok(eap.conditional, 'EAP 에 조건 라벨이 없다');
  assert.match(eap.body, /대상/, '누가 쓸 수 있는지 설명이 없다');
});

test('전화 상담은 tel: 로 바로 걸린다 (번호를 옮겨 적게 하지 않는다)', () => {
  const tels = careLinks().filter((l) => l.href.startsWith('tel:'));
  assert.ok(tels.length >= 2, '전화 바로걸기가 부족하다');
  for (const t of tels) assert.match(t.href, /^tel:[\d-]+$/, `${t.href} 형식이 이상하다`);
});

test('상담·채용 바로가기는 영수증 모달이 아니라 본문에 있다', () => {
  // 모달 맨 아래는 작은 화면에서 잘리거나 시선이 닿지 않는 자리다.
  const modal = html.slice(html.indexOf('<div class="receipt-modal"'), html.indexOf('<div class="history-modal"'));
  assert.ok(!/<a\s/.test(modal), '영수증 모달에 링크가 남아 있다');
});

test('공유되는 영수증 카드의 상담 안내도 조건 없는 창구다', () => {
  const card = html.slice(html.indexOf('class="receipt-eap"'), html.indexOf('receipt-disclaimer'));
  assert.ok(!/comwel|EAP/.test(card), '이미지에 조건부 창구가 남아 있다');
  assert.match(card, /1350/);
  assert.match(card, /1577-0199/);
});
