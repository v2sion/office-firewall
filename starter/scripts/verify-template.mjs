#!/usr/bin/env node
/**
 * 브라우저 검증 템플릿 — **다음 프로젝트에 복사해서 쓴다.**
 *
 *   node scripts/verify-template.mjs [URL]
 *
 * 왜 템플릿으로 두는가:
 *
 * 이 프로젝트에서 함수 두 개가 파일에 저장되지 않은 채 배포될 뻔했다.
 * 검증 스크립트는 "통과"라고 했다 — 페이지가 그려졌기 때문이다. 실제로는
 * ReferenceError 가 나고 있었는데 **아무도 듣고 있지 않았다.**
 *
 * 그래서 이 템플릿의 핵심은 화려한 검증이 아니라 아래 두 가지다.
 *   ① 에러를 반드시 듣는다 (listen)
 *   ② 측정값과 에러를 **같이** 출력한다 — 따로 두면 안 본다
 *
 * 나머지(CASES/check)는 프로젝트마다 갈아 끼우는 자리다.
 *
 * @see CLAUDE.md §1(재기) · §2(에러를 듣기)
 */
import pw from 'playwright';

const BASE = process.argv[2] || 'http://localhost:5173';

/**
 * 무시할 에러 — **가능한 한 비워 둔다.**
 *
 * 외부 폰트·분석 스크립트처럼 내 코드와 무관한 요청이 매번 뜨면, 얼마 안 가
 * 경고를 통째로 무시하게 된다. 그게 바로 원래 버그(ReferenceError)가 살아남은
 * 방식이다. 여기 한 줄 넣을 때마다 "이게 정말 내 코드와 무관한가"를 묻는다.
 */
const IGNORE = [
  /fonts\.googleapis|fonts\.gstatic|cdn\.jsdelivr/,   // 외부 폰트 CDN
];

/** 재고 싶은 화면 크기. 고치기 전/후를 **같은 방법으로** 재야 의미가 있다. */
const VIEWPORTS = [
  [390, 844, '모바일'],
  [768, 1024, '태블릿'],
  [1440, 900, '노트북'],
  [2560, 1440, '큰 모니터'],
];

/**
 * 여기에 프로젝트별 측정을 넣는다.
 * **숫자로 돌려준다** — "좋아 보인다"는 근거가 아니다.
 */
async function measure(page) {
  return page.evaluate(() => {
    const n = (sel) => document.querySelector(sel);
    const box = (sel) => { const e = n(sel); return e ? e.getBoundingClientRect() : null; };

    // 예) 줄 채움 비율 — 문단 마지막 줄이 얼마나 찼는가.
    // 0.2 면 마지막 줄에 글자가 거의 없다는 뜻이라 줄바꿈이 어색하다.
    const fillRatio = (sel) => {
      const e = n(sel);
      if (!e) return null;
      const r = document.createRange();
      r.selectNodeContents(e);
      const lines = [...r.getClientRects()];
      if (lines.length < 2) return 1;
      return +(lines.at(-1).width / Math.max(...lines.map((l) => l.width))).toFixed(2);
    };

    return {
      // 어떤 프로젝트에서나 물어야 하는 것
      가로스크롤: document.documentElement.scrollWidth > window.innerWidth + 1,
      // 아래는 프로젝트별로 갈아 끼우는 자리 — 선택자를 실제 것으로 바꾼다
      // 본문폭: Math.round(box('.layout')?.width ?? 0),   // 큰 화면에서 너무 비지 않는지
      // 문단채움: fillRatio('.lead'),                      // 0.2 면 줄바꿈이 어색하다
      // 폼높이: Math.round(box('form')?.height ?? 0),      // 고치기 전/후 비교용
    };
  });
}

/** 측정 전에 화면을 원하는 상태로 만든다(로그인·입력·실행 등). */
async function setup(page) {
  // 예: await page.fill('#message', '…'); await page.click('#run');
  //     await page.waitForSelector('#result:not([hidden])');
}

const browser = await pw.chromium.launch();
let failed = 0;

for (const [w, h, label] of VIEWPORTS) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });

  // ── 핵심 ① 에러를 듣는다. 이 세 줄을 지우지 말 것. ──────────────
  const errs = [];
  const keep = (t) => { if (!IGNORE.some((re) => re.test(t))) errs.push(t); };
  page.on('pageerror', (e) => errs.push(`pageerror: ${e}`));  // 이건 절대 거르지 않는다
  // 콘솔 에러 문구에는 URL 이 안 담긴다("Failed to load resource: …").
  // 어떤 자원에서 났는지는 location() 에 있으므로 둘을 합쳐서 걸러야 한다.
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const where = m.location()?.url || '';
    keep(`console: ${m.text()}${where ? ` @ ${where.slice(0, 60)}` : ''}`);
  });
  page.on('requestfailed', (r) => keep(`request: ${r.url().slice(0, 80)}`));
  // ────────────────────────────────────────────────────────────

  try {
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await setup(page);
    await page.waitForTimeout(400); // CSS 전환이 끝난 뒤에 잰다
    const m = await measure(page);

    // ── 핵심 ② 측정값과 에러를 같이 출력한다 ──────────────────────
    const bad = errs.length > 0 || m.가로스크롤;
    if (bad) failed += 1;
    console.log(
      `${bad ? '⚠' : ' '} ${label.padEnd(8)} ${String(w).padStart(4)}×${String(h).padEnd(4)}`,
      JSON.stringify(m),
      errs.length ? `\n    에러 ${errs.length}건: ${errs.slice(0, 3).join(' / ')}` : '',
    );
  } catch (e) {
    failed += 1;
    console.log(`⚠ ${label.padEnd(8)} 실패: ${String(e).slice(0, 120)}`);
  }
  await page.close();
}

await browser.close();
console.log(failed ? `\n문제 있는 화면 ${failed}개` : '\n전부 통과 · 에러 없음');
process.exit(failed ? 1 : 0);
