/**
 * 홈 화면·앱 목록 아이콘을 굽는다 → public/icon-*.png, public/apple-touch-icon.png
 *
 *   npm i -D playwright && node scripts/make-icons.mjs
 *
 * playwright 는 의존성에 넣지 않았다(scripts/make-og.mjs 와 같은 이유). 아이콘은
 * 로고를 바꿀 때만 다시 굽는다.
 *
 * 용도마다 투명도 규칙이 다르다 — 한 벌로 찍으면 어딘가는 반드시 어색해진다.
 *
 *  · purpose="any" (icon-192 / icon-512)
 *      모서리가 둥근 아이콘을 **그대로** 쓴다. 둥근 바깥은 투명이어야 한다.
 *      예전에 흰 배경째로 캡처해서, 윈도우 바탕화면에 흰 네 귀퉁이가 그대로
 *      드러났다(제보). 알파 없이 구우면 그 사고가 다시 난다.
 *
 *  · purpose="maskable" (icon-maskable-512)
 *      안드로이드가 원형·스퀘어클 등으로 **잘라낸다.** 잘릴 것을 전제로 사방을
 *      꽉 채운 정사각이라야 하고, 투명한 부분이 있으면 잘린 자리에 구멍으로
 *      보인다. 그래서 여기만 배경을 칠한다.
 *
 *  · apple-touch-icon
 *      iOS 가 알아서 둥글린다. 여기서 또 둥글리면 모서리가 두 번 깎이고,
 *      투명한 부분은 iOS 가 **검정으로** 채운다. 둥글리지 않은 불투명 정사각.
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 상단 로고·파비콘과 같은 도형(방패 + 벽돌). 세 자산의 인상을 한 벌로 맞춘다. */
const shield = `<g transform="translate(4.2 2.6) scale(0.735)">
  <path d="M16 1.6l13 4.6v10.3c0 8-5.3 14.9-13 16.9C8.3 31.4 3 24.5 3 16.5V6.2z" fill="#2b7fff"/>
  <g fill="#0b0d12">
    <rect x="7.6" y="11.2" width="7.4" height="3.6" rx="1"/><rect x="16.6" y="11.2" width="7.8" height="3.6" rx="1"/>
    <rect x="7.6" y="16.4" width="11" height="3.6" rx="1"/><rect x="20.2" y="16.4" width="4.2" height="3.6" rx="1"/>
    <rect x="7.6" y="21.6" width="5.4" height="3.6" rx="1"/><rect x="14.6" y="21.6" width="9.8" height="3.6" rx="1"/>
  </g></g>`;

const JOBS = [
  // [파일명, 크기, 판(plate), 투명 배경]
  ['icon-192.png', 192, `<rect width="32" height="32" rx="7" fill="#0b0d12"/>${shield}`, true],
  ['icon-512.png', 512, `<rect width="32" height="32" rx="7" fill="#0b0d12"/>${shield}`, true],
  // 잘려도 로고가 살아남도록 사방에 여백(safe zone)을 두고 배경을 꽉 채운다.
  ['icon-maskable-512.png', 512,
    `<rect width="32" height="32" fill="#0b0d12"/><g transform="translate(16 16) scale(0.62) translate(-16 -16)">${shield}</g>`, false],
  ['apple-touch-icon.png', 180, `<rect width="32" height="32" fill="#0b0d12"/>${shield}`, false],
];

const browser = await chromium.launch();
for (const [name, size, plate, transparent] of JOBS) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<body style="margin:0;background:transparent">
       <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">${plate}</svg>
     </body>`,
  );
  await page.locator('svg').screenshot({ path: join(root, 'public', name), omitBackground: transparent });
  await page.close();
  console.log(`${name}  ${size}px  ${transparent ? '투명 배경' : '불투명'}`);
}
await browser.close();
