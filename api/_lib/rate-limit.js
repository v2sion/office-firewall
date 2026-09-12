/**
 * /api/analyze 남용 방지.
 *
 * 이 엔드포인트는 호출할 때마다 실제 모델 비용이 나간다. 클라이언트에 5초 쿨다운이
 * 있지만 그건 UI 편의일 뿐 curl 한 줄이면 그냥 우회된다 — 배포 URL 을 아는 누구든
 * API 예산을 소진시킬 수 있다는 뜻이다. 그래서 서버에서도 막는다.
 *
 * 한계를 분명히 해둔다: 서버리스는 인스턴스마다 메모리가 따로라서 이 카운터는
 * 인스턴스 단위다(분산 카운터가 아니다). 스크립트 남용의 문턱을 크게 올리는 용도이지,
 * 엄밀한 전역 쿼터가 아니다. 엄밀한 제어가 필요해지면 외부 저장소(KV 등)가 필요하다.
 */

export const WINDOW_MS = 60_000;
/** 정상 사용자는 클라이언트 쿨다운(5초) 때문에 분당 12회를 넘기 어렵다 — 그 위로 잡는다. */
export const PER_IP_MAX = 20;
/** 인스턴스 전체 상한. 한 IP 가 아니라 분산된 다수로 들어와도 예산을 지킨다. */
export const GLOBAL_MAX = 200;

const perIp = new Map();
let globalHits = [];

const prune = (arr, cutoff) => arr.filter((t) => t > cutoff);

/**
 * @param {string} ip
 * @param {number} [now]
 * @returns {{ ok: boolean, scope?: 'ip'|'global', retryAfterSec?: number }}
 */
export function checkRateLimit(ip, now = Date.now()) {
  const cutoff = now - WINDOW_MS;
  const key = ip || 'unknown';

  globalHits = prune(globalHits, cutoff);
  // 오래된 IP 엔트리를 정리하지 않으면 맵이 무한히 자란다(그 자체가 메모리 고갈 경로다).
  for (const [k, list] of perIp) {
    const kept = prune(list, cutoff);
    if (kept.length) perIp.set(k, kept);
    else perIp.delete(k);
  }

  const mine = perIp.get(key) || [];
  const retryAfter = (list) => Math.max(1, Math.ceil((list[0] + WINDOW_MS - now) / 1000));

  if (mine.length >= PER_IP_MAX) return { ok: false, scope: 'ip', retryAfterSec: retryAfter(mine) };
  if (globalHits.length >= GLOBAL_MAX) return { ok: false, scope: 'global', retryAfterSec: retryAfter(globalHits) };

  perIp.set(key, [...mine, now]);
  globalHits.push(now);
  return { ok: true };
}

/** 요청에서 클라이언트 IP 를 뽑는다. Vercel 은 x-forwarded-for 를 채워준다. */
export function clientIp(req) {
  const fwd = req?.headers?.['x-forwarded-for'];
  const first = Array.isArray(fwd) ? fwd[0] : String(fwd || '').split(',')[0];
  return first.trim() || req?.socket?.remoteAddress || 'unknown';
}

/** 테스트용 — 카운터 초기화 */
export function _resetRateLimit() {
  perIp.clear();
  globalHits = [];
}
