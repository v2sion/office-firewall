/**
 * docs/assets/og.html → public/og.png (1200×630).
 *
 * 공유 카드 이미지는 실행 중에 만들 수 없다. 카카오톡·슬랙·트위터의 크롤러는
 * JavaScript 를 실행하지 않고 정적 HTML 의 og:image 주소만 읽어 가므로,
 * 결과물이 빌드 전에 파일로 존재해야 한다. 그래서 굽는 단계를 따로 둔다.
 *
 *   npm i -D playwright && node scripts/make-og.mjs
 *
 * playwright 는 의존성에 넣지 않았다. 이 스크립트는 이미지를 바꿀 때만 쓰는데,
 * 배포할 때마다 Vercel 이 브라우저까지 내려받게 만들 이유가 없다.
 *
 * 문구나 색을 바꿨으면 다시 돌리고 public/og.png 를 커밋해야 한다. 굽지 않으면
 * 배포된 카드만 옛 이미지로 남는다.
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.goto('file://' + join(root, 'docs/assets/og.html'), { waitUntil: 'networkidle' });
await page.screenshot({ path: join(root, 'public/og.png') });
await browser.close();
console.log('public/og.png ← docs/assets/og.html (1200×630)');
