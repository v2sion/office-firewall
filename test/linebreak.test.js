/**
 * 줄바꿈은 손으로 잡지 않는다.
 *
 * 짧은 문단들을 `<br>` 로 끊어 왔는데, **최적 위치가 폭마다 다르다.** 모바일에
 * 맞추면 데스크톱이 어긋나고 데스크톱을 고치면 다시 모바일이 어긋나는 왕복이
 * 계속됐다. 실측 표본이 그 왕복을 그대로 보여준다.
 *
 *   .standby-copy  데스크톱 612 / 92        (뒷줄이 앞줄의 15%)
 *   Step 01        데스크톱 743 / 106       (14%)
 *   Step 02        모바일   264 / 288 / 85  (30%)
 *
 * `text-wrap: balance` 는 브라우저가 줄 길이를 고르게 맞추도록 줄바꿈을 다시
 * 계산한다. 폭이 바뀌면 그때마다 다시 계산하므로 분기가 필요 없다. 적용 후
 * 같은 문단들이 양쪽에서 0.76~1.00 으로 고르게 잡혔다.
 *
 * `<br>` 은 **뜻이 있는 자리에만** 남긴다 — 헤드라인, 인용된 메시지, 라벨과
 * 본문을 가르는 줄. 그 셋은 짧은 줄이 의도다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const css = readFileSync(join(root, 'src/styles.css'), 'utf8');

/** balance 가 줄바꿈을 맡는 블록들. 여기엔 손수 넣은 <br> 이 있으면 안 된다. */
const BALANCED = ['standby-copy', 'standby-sub', 'field-hint', 'feedback-lead', 'history-note'];

test('본문 문단은 balance 가 줄바꿈을 맡는다', () => {
  const at = css.indexOf('줄바꿈을 손으로 잡지 않는다');
  assert.ok(at > 0, '적용 근거를 적은 자리가 사라졌다');
  const rule = css.slice(at, css.indexOf('}', at));
  for (const cls of [...BALANCED, 'hiw-panel p', 'hiw-intro p', 'care-body']) {
    assert.ok(rule.includes(cls), `${cls} 가 balance 대상에서 빠졌다`);
  }
  assert.match(rule, /text-wrap: balance/);
});

test('balance 가 맡는 문단에는 손수 넣은 줄바꿈이 없다', () => {
  for (const cls of BALANCED) {
    for (const m of html.matchAll(new RegExp(`<p class="${cls}"[^>]*>([\\s\\S]*?)</p>`, 'g'))) {
      assert.ok(!/<br/.test(m[1]), `.${cls} 에 <br> 이 남아 있다 — balance 와 싸운다`);
    }
  }
  const panels = html.slice(html.indexOf('<article class="hiw-panel"'), html.indexOf('</section>', html.indexOf('<article class="hiw-panel"')));
  assert.ok(!/<p>[^<]*<br/.test(panels), '설명 문단에 <br> 이 남아 있다');
});

test('폭별로 따로 끊을 수 있는 짝이 둘 다 있다', () => {
  // 한쪽만 있으면 "모바일에만 필요한 줄바꿈"을 표현할 방법이 없어진다.
  // 그게 없던 동안 고치면 반대쪽이 깨지는 왕복이 났다.
  assert.match(css, /br\.br-wide \{ display: none; \}/, '데스크톱 전용 줄바꿈이 없다');
  assert.match(css, /@media \(min-width: 481px\) \{\s*br\.br-narrow \{ display: none; \}/, '모바일 전용 줄바꿈이 없다');
});

test('남은 <br> 은 뜻이 있는 자리뿐이다', () => {
  // 헤드라인·인용문·라벨 구분자·영수증 카드(고정 폭 이미지) 안.
  const body = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const m of body.matchAll(/<br \/>/g)) {
    const before = body.slice(Math.max(0, m.index - 260), m.index);
    const ok = /(intro-headline|intro-quote|<b>[^<]*<\/b>\s*$|receipt-)/.test(before);
    assert.ok(ok, `뜻 없는 자리의 <br>: …${before.slice(-60)}`);
  }
});
