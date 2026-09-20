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

/**
 * 영수증 모달에 무엇을 두고 무엇을 빼는가.
 *
 * 둘의 성격이 다르다. **상담 창구**는 대상·조건 설명이 함께 있어야 뜻이 통하고
 * (그게 없으면 해당 없는 사람이 헛걸음한다), 그만한 공간은 모달에 없다. 반면
 * **채용 링크**는 한 줄로 끝나고, 카드 안의 "원티드 커리어 세이프" 문구가
 * 이미지라 누를 수 없어서 실제 링크가 바로 옆에 필요하다.
 *
 * 자리도 중요하다. 영수증 카드는 세로로 길어서 모달 맨 끝에 두면 작은 화면에서
 * 스크롤을 끝까지 내려야 보인다. 저장·복사 버튼 바로 아래여야 한다.
 */
test('영수증 모달에는 채용 링크만 두고 상담 창구는 본문에 남긴다', () => {
  const modal = html.slice(html.indexOf('<div class="receipt-modal"'), html.indexOf('<div class="history-modal"'));
  const hrefs = [...modal.matchAll(/<a[^>]*href="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(hrefs.length, 1, `모달 링크가 ${hrefs.length}개다 — 채용 링크 하나만 둔다`);
  assert.match(hrefs[0], /wanted\.co\.kr/, '모달에 남은 링크가 채용 링크가 아니다');
  // 상담 창구는 설명이 붙어야 해서 모달에 두지 않는다.
  assert.ok(!/comwel|gabjil|tel:/.test(modal), '모달에 상담 창구가 들어와 있다');
});

test('영수증의 채용 링크는 저장·복사 버튼 아래에 있다 (모달 맨 끝이 아니라)', () => {
  const modal = html.slice(html.indexOf('<div class="receipt-modal"'), html.indexOf('<div class="history-modal"'));
  const actions = modal.indexOf('class="receipt-actions"');
  const link = modal.indexOf('id="receipt-wanted-link"');
  const status = modal.indexOf('id="receipt-status"');
  assert.ok(actions >= 0 && link >= 0 && status >= 0, '모달 구조를 찾지 못했다');
  assert.ok(actions < link, '링크가 동작 버튼보다 위에 있다');
  assert.ok(link < status, '링크가 상태 문구보다 아래로 밀렸다');
});

test('영수증의 채용 링크는 새 창으로 열린다', () => {
  const link = html.slice(html.indexOf('id="receipt-wanted-link"') - 200);
  const tag = link.slice(0, link.indexOf('</a>'));
  assert.match(tag, /target="_blank"/, '새 창으로 열리지 않는다');
  // 새 창을 열 때 rel 을 빼면 열린 쪽에서 window.opener 로 이 페이지를 건드릴 수 있다.
  assert.match(tag, /rel="noopener noreferrer"/);
});

test('공유되는 영수증 카드의 상담 안내도 조건 없는 창구다', () => {
  const card = html.slice(html.indexOf('class="receipt-eap"'), html.indexOf('receipt-disclaimer'));
  assert.ok(!/comwel|EAP/.test(card), '이미지에 조건부 창구가 남아 있다');
  assert.match(card, /1350/);
  assert.match(card, /1577-0199/);
});
