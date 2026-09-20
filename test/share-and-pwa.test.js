/**
 * 공유 카드(OG)와 홈 화면 추가(PWA)의 정적 조건.
 *
 * 이 둘은 **런타임에 확인할 방법이 없다.** 카카오톡·슬랙의 크롤러는
 * JavaScript 를 실행하지 않고 정적 HTML 만 읽어 가고, 크롬의 설치 제안은
 * manifest 와 서비스 워커가 조건을 만족할 때만 브라우저가 알아서 띄운다.
 * 조건이 깨져도 화면에는 아무 증상이 없고, 공유했을 때 이미지가 안 뜨거나
 * 설치 버튼이 영영 안 나올 뿐이다.
 *
 * 그래서 파일 내용으로 직접 고정한다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const manifest = JSON.parse(readFileSync(join(root, 'public/manifest.webmanifest'), 'utf8'));
const sw = readFileSync(join(root, 'public/sw.js'), 'utf8');

const meta = (prop) => (html.match(new RegExp(`<meta property="${prop}" content="([^"]*)"`)) || [])[1];
const named = (name) => (html.match(new RegExp(`<meta name="${name}" content="([^"]*)"`)) || [])[1];

/** PNG 헤더(IHDR)에서 실제 크기를 읽는다 — 별도 의존성 없이. */
function pngSize(path) {
  const buf = readFileSync(path);
  assert.equal(buf.toString('ascii', 1, 4), 'PNG', `${path} 가 PNG 가 아니다`);
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

test('og:image 는 절대 URL 이다 (카카오톡은 상대 경로를 풀지 못한다)', () => {
  const src = meta('og:image');
  assert.ok(src, 'og:image 가 없다');
  assert.match(src, /^https:\/\//, 'http 가 아닌 https 절대 URL 이어야 한다');
  assert.equal(meta('og:image:secure_url'), src);
  assert.equal(named('twitter:image'), src);
});

test('og:image 에 적은 크기가 실제 파일 크기와 같다', () => {
  const { w, h } = pngSize(join(root, 'public/og.png'));
  assert.equal(String(w), meta('og:image:width'));
  assert.equal(String(h), meta('og:image:height'));
  // 1.91:1 근처여야 카카오톡·슬랙에서 위아래가 잘리지 않는다.
  assert.ok(Math.abs(w / h - 1.91) < 0.05, `비율이 ${(w / h).toFixed(2)}:1 이다`);
});

test('크롤러가 읽어야 할 태그가 정적 HTML 안에 있다', () => {
  for (const p of ['og:type', 'og:title', 'og:description', 'og:url', 'og:site_name', 'og:locale']) {
    assert.ok(meta(p), `${p} 가 없다`);
  }
  assert.equal(named('twitter:card'), 'summary_large_image');
  // 런타임에 채우면 크롤러가 못 본다 — 자리표시자가 남아 있지 않은지 확인.
  assert.ok(!/content="\s*"/.test(html.match(/<meta property="og:[^>]+>/g)?.join('') || ''), '빈 og 태그가 있다');
});

test('manifest 가 설치 조건을 갖췄다', () => {
  assert.ok(manifest.name && manifest.short_name);
  assert.equal(manifest.start_url, '/');
  assert.ok(['standalone', 'fullscreen', 'minimal-ui'].includes(manifest.display));
  const sizes = manifest.icons.map((i) => i.sizes);
  assert.ok(sizes.includes('192x192'), '192 아이콘이 필요하다');
  assert.ok(sizes.includes('512x512'), '512 아이콘이 필요하다');
  // 안드로이드는 아이콘을 원형 등으로 잘라낸다. maskable 이 없으면 로고가 잘린다.
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'), 'maskable 아이콘이 필요하다');
});

test('manifest 가 가리키는 아이콘이 실제로 있고 크기가 맞다', () => {
  for (const icon of manifest.icons) {
    const path = join(root, 'public', icon.src.replace(/^\//, ''));
    assert.ok(existsSync(path), `${icon.src} 가 없다`);
    const { w, h } = pngSize(path);
    assert.equal(`${w}x${h}`, icon.sizes, `${icon.src} 의 실제 크기가 다르다`);
  }
  assert.ok(existsSync(join(root, 'public/apple-touch-icon.png')), 'iOS 홈 화면 아이콘이 없다');
});

test('index.html 이 manifest 와 iOS 아이콘을 연결한다', () => {
  assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png"/);
  assert.ok(named('theme-color'), 'theme-color 가 없다');
});

test('서비스 워커에 fetch 핸들러가 있다 (없으면 크롬이 설치를 제안하지 않는다)', () => {
  assert.match(sw, /addEventListener\(\s*'fetch'/);
});

test('서비스 워커가 API 응답을 캐시하지 않는다', () => {
  // 캐시된 분석 결과를 다른 입력에 돌려주면 그건 오답이다.
  assert.match(sw, /pathname\.startsWith\('\/api\/'\)\s*\)\s*return/);
});

test('HTML 은 네트워크 우선이다 (배포한 내용이 캐시에 막히지 않게)', () => {
  const nav = sw.slice(sw.indexOf("request.mode === 'navigate'"));
  const fetchAt = nav.indexOf('fetch(request)');
  const cacheAt = nav.indexOf('caches.match');
  assert.ok(fetchAt >= 0 && cacheAt >= 0, '내비게이션 분기를 찾지 못했다');
  assert.ok(fetchAt < cacheAt, '캐시를 네트워크보다 먼저 보고 있다');
});
