/**
 * 진입 스토리 네 장의 분량 균형.
 *
 * 3장이 218자까지 자라 있었다(1·2장은 122자). 작은 화면에서 세로로 길어져
 * **읽기 전에 지치는 장**이 됐고, 읽히지 않는 설명은 없느니만 못하다.
 *
 * 문제는 길이 자체가 아니라 **한 장만 튀는 것**이었다. 스토리는 넘기면서 읽는
 * 형식이라 장마다 호흡이 비슷해야 하고, 한 장이 두 배면 거기서 흐름이 끊긴다.
 * 그래서 절대 상한이 아니라 장 사이의 편차를 고정한다.
 *
 * 줄인 방법도 기록해 둔다. 분량을 쳐낸 게 아니라 **중복**을 걷어냈다 —
 * 3장의 첫 문장은 다음 문장의 요약이었고 마지막 문장은 '다음' 버튼이 이미
 * 하는 말이었다. 4장은 "진단은 목적이 아닙니다"와 "…이 도구의 목적입니다"가
 * 같은 말을 앞뒤로 두 번 하고 있었다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');

/** 각 슬라이드의 본문 글자 수 (태그·주석·공백 제외). */
function slideLengths() {
  const out = [];
  for (const m of html.matchAll(/<section class="intro-slide[^"]*" data-slide="(\d)">([\s\S]*?)<\/section>/g)) {
    const text = m[2]
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, '');
    out.push({ slide: Number(m[1]) + 1, chars: text.length });
  }
  return out;
}

test('스토리는 네 장이다', () => {
  assert.equal(slideLengths().length, 4);
});

test('어느 한 장도 다른 장의 두 배가 되지 않는다', () => {
  const lens = slideLengths();
  const max = Math.max(...lens.map((s) => s.chars));
  const min = Math.min(...lens.map((s) => s.chars));
  const worst = lens.find((s) => s.chars === max);
  assert.ok(
    max / min < 1.6,
    `${worst.slide}장이 ${max}자로 가장 짧은 장(${min}자)의 ${(max / min).toFixed(1)}배다`,
  );
});

test('한 장이 160자를 넘지 않는다 (작은 화면에서 세로로 넘친다)', () => {
  for (const s of slideLengths()) {
    assert.ok(s.chars <= 160, `${s.slide}장이 ${s.chars}자다`);
  }
});

test('줄인 뒤에도 각 장의 핵심 주장은 남아 있다', () => {
  const body = html.slice(html.indexOf('class="intro"'), html.indexOf('</div>\n\n      <div class="intro-actions"'));
  // 3장: 이 도구가 무엇인지 + 재현되는 판정 + 전송 전 마스킹
  assert.match(body, /커뮤니케이션 문제를 해석해 드립니다/, '3장: 도구 소개가 사라졌다');
  assert.match(body, /같은 메시지면 늘 같은 점수/, '3장: 재현성 주장이 사라졌다');
  assert.match(body, /보내기 전에 브라우저에서 가려집니다/, '3장: 마스킹 약속이 사라졌다');
  // 4장: 기록이 근거가 된다 + 참는 것 말고도 선택지
  assert.match(body, /기분 탓이 아니라 패턴/, '4장: 패턴 주장이 사라졌다');
  assert.match(body, /참는 것 말고도 선택지/, '4장: 이 도구의 목적이 사라졌다');
});

/**
 * 스토리에서 뺀 문장이 **버려진 게 아니라 옮겨진** 것인지.
 *
 * "이제, 커뮤니케이션도 기술적으로 해결해 보세요"는 3장 끝에서 바로 아래
 * '다음' 버튼과 겹쳐서 뺐다. 다만 문장 자체는 이 도구의 태도를 한 줄로
 * 말하는 것이라 버리지 않고 대기 화면으로 옮겼다 — 왼쪽에서 메시지를 넣고
 * 실행을 누르기 직전에 읽는 자리라 "해결해 보세요"가 실제 다음 행동을
 * 가리킨다.
 *
 * 스토리를 손대다 이 줄이 같이 사라지기 쉬워서 자리를 고정한다.
 */
test('스토리에서 옮긴 권유 문장이 대기 화면에 살아 있다', () => {
  assert.match(html, /class="standby-cta"/, '대기 화면에 자리가 없다');
  const at = html.indexOf('class="standby-cta"');
  assert.match(html.slice(at, at + 200), /커뮤니케이션도 기술적으로 해결해 보세요/, '문장이 사라졌다');
  // 스토리 **본문**에는 남아 있지 않아야 한다 ('다음' 버튼과 겹친다).
  // 주석은 왜 옮겼는지를 설명하며 이 문장을 인용하므로 걷어내고 본다.
  const story = html
    .slice(html.indexOf('class="intro"'), html.indexOf('<div class="intro-actions"'))
    .replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(!/기술적으로 해결해 보세요/.test(story), '스토리 본문에 다시 들어왔다');
});
