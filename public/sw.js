/**
 * 서비스 워커 — "홈 화면에 추가"를 가능하게 하는 최소 구현.
 *
 * 왜 있는가
 * ─────────
 * 안드로이드 크롬은 manifest 만으로는 설치를 제안하지 않는다. **fetch 핸들러를
 * 가진** 서비스 워커가 함께 있어야 beforeinstallprompt 가 발생한다. 이 파일의
 * 존재 이유는 오프라인 지원이 아니라 그 조건을 만족시키는 것이다.
 *
 * 그래서 캐시는 최소한으로만 쓴다
 * ──────────────────────────────
 * 서비스 워커가 잘못 캐시하면 배포를 해도 옛 화면이 계속 뜬다. 심사 기간에
 * 그런 일이 생기면 고칠 방법이 사용자 쪽에 없다(캐시를 직접 지워야 한다).
 * 그래서 두 가지 규칙을 지킨다.
 *
 *  1) **HTML 은 항상 네트워크 우선.** 네트워크가 되면 언제나 최신 화면을 준다.
 *     캐시는 오프라인일 때만 쓰인다. 배포한 내용이 캐시에 막히는 일이 없다.
 *  2) **API 는 절대 캐시하지 않는다.** /api/analyze 는 입력마다 결과가 다르고,
 *     캐시된 응답을 다른 입력에 돌려주면 그건 오답이다. /api/feedback 은
 *     캐시가 의미 없는 쓰기 요청이다.
 *
 * 해시가 붙은 정적 자산(/assets/index-XXXX.js)만 캐시 우선으로 둔다. 내용이
 * 바뀌면 파일 이름이 바뀌므로 낡은 것을 돌려줄 수가 없다.
 */
const VERSION = 'ofw-v1';
const SHELL = `${VERSION}-shell`;

self.addEventListener('install', (e) => {
  // 오프라인일 때 보여줄 최소한의 껍데기만 미리 받아 둔다.
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  // 이전 버전 캐시를 남겨두면 용량만 먹고 되살아날 위험만 남는다.
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  const url = new URL(request.url);

  // 우리 오리진의 GET 만 다룬다. 외부 CDN(글꼴)과 쓰기 요청은 그대로 통과시킨다.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  // HTML: 네트워크 우선 (배포한 내용이 캐시에 막히지 않게)
  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put('/', copy));
          return res;
        })
        .catch(() => caches.match('/').then((hit) => hit || Response.error())),
    );
    return;
  }

  // 해시가 붙은 정적 자산: 캐시 우선 (이름이 곧 버전이라 낡을 수 없다)
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((res) => {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put(request, copy));
            return res;
          }),
      ),
    );
  }
});
