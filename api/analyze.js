/**
 * POST /api/analyze
 *
 * 입력은 반드시 브라우저에서 선-마스킹된 텍스트여야 한다.
 * 원문·토큰 맵은 서버에 저장하지 않고 로그에도 남기지 않는다.
 * 로그에 남기는 것은 길이·지연시간·토큰 사용량뿐이다.
 */
import { runAnalyze, AnalyzeError } from './_lib/analyze-core.js';
import { checkRateLimit, clientIp } from './_lib/rate-limit.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'POST 만 허용합니다.' } });
  }

  // 호출마다 모델 비용이 나가는 엔드포인트다 — 클라이언트 쿨다운은 curl 로 우회되므로
  // 서버에서도 막는다(자세한 한계는 _lib/rate-limit.js 주석 참고).
  const limit = checkRateLimit(clientIp(req));
  if (!limit.ok) {
    res.setHeader('Retry-After', String(limit.retryAfterSec));
    return res.status(429).json({
      error: {
        code: 'RATE_LIMITED',
        message: `요청이 너무 많습니다. ${limit.retryAfterSec}초 후에 다시 시도해 주세요.`,
      },
    });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: { code: 'BAD_JSON', message: '요청 본문이 JSON 이 아닙니다.' } });
    }
  }

  try {
    const result = await runAnalyze(body || {});
    // 실측 토큰/비용 근거용 로그 (본문은 절대 기록하지 않는다)
    console.log(
      JSON.stringify({
        tag: 'analyze',
        mode: result.meta.mode,
        model: result.meta.model,
        latencyMs: result.meta.latencyMs,
        chars: (body?.maskedText || '').length,
        usage: result.usage,
        score: result.risk.score,
      }),
    );
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof AnalyzeError) {
      // 혼잡(429)은 "언제 다시 오면 되는지"까지 알려 줘야 안내가 완성된다.
      if (err.retryAfterSec) res.setHeader('Retry-After', String(err.retryAfterSec));
      return res.status(err.status).json({
        error: { code: err.code, message: err.message, retryAfterSec: err.retryAfterSec },
      });
    }
    console.error(JSON.stringify({ tag: 'analyze_error', name: err?.name, status: err?.status, message: err?.message }));
    return res.status(502).json({
      error: { code: 'UPSTREAM_FAILED', message: '분석에 실패했습니다. 잠시 후 다시 시도하거나 좌측 퀵 프리셋을 사용하세요.' },
    });
  }
}
