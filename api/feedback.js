/**
 * POST /api/feedback — 사용자 의견 수집.
 *
 * 왜 이 방식인가
 * ─────────────
 * 이 프로젝트의 원칙은 "메시지 원문은 서버에 남기지 않는다"이고, 피드백은
 * 그 원칙의 예외가 아니라 **완전히 다른 데이터**다. 사용자가 우리에게
 * 보내려고 직접 쓴 글이라 저장해도 되지만, 그래도 두 가지를 지킨다.
 *  - 분석한 메시지 원문·점수·토큰 맵은 이 요청에 아예 실리지 않는다
 *    (클라이언트가 보내지 않는다. main.js 의 sendFeedback 참고).
 *  - 연락처는 선택이고, 안 적어도 제출된다.
 *
 * 전달 경로는 두 겹이다.
 *  1) **구조화 로그** — 항상 남는다. Vercel 대시보드의 Logs 에서
 *     `tag: "feedback"` 으로 검색하면 전부 보인다. 외부 서비스도, 추가
 *     비용도, API 키도 필요 없다. 마감 직전에 새 의존성을 들이지 않으려는
 *     선택이기도 하다.
 *  2) **웹훅(선택)** — `FEEDBACK_WEBHOOK_URL` 환경변수가 있으면 그쪽으로도
 *     보낸다. Slack/Discord 수신 웹훅 URL 을 그대로 넣으면 바로 알림이 오고,
 *     메일로 받고 싶으면 Zapier·Make 같은 릴레이의 훅 주소를 넣으면 된다.
 *     값은 **Vercel 대시보드에서만** 설정한다(이 저장소와 채팅에 키를 남기지
 *     않는다는 기존 원칙과 같다). 없으면 로그만 남고 요청은 정상 처리된다.
 *
 * 웹훅 실패가 사용자 경험을 깨면 안 되므로, 실패해도 200 을 돌려준다.
 * 의견은 이미 로그에 남아 있어 유실되지 않는다.
 */
import { checkRateLimit, clientIp } from './_lib/rate-limit.js';

export const MAX_MESSAGE_CHARS = 1000;
export const MAX_CONTACT_CHARS = 200;

/** 웹훅 호출이 서버리스 함수 수명을 잡아먹지 않게 짧게 끊는다. */
const WEBHOOK_TIMEOUT_MS = 3000;

/**
 * 저장 전에 한 번 더 걸러낸다.
 *
 * 화면에서 "메시지 원문은 넣지 마세요"라고 안내하지만 안내는 안내일 뿐이다.
 * 전화번호·주민번호처럼 명백한 식별자가 섞여 들어오면 우리가 그걸 로그에
 * 남기게 되므로, 눈에 띄는 형태만이라도 마스킹해서 기록한다.
 * (analyze 쪽 detectRawPII 와 달리 여기서는 거절하지 않는다 — 의견을 쓰다
 *  숫자가 들어갔다고 돌려보내면 그 사람은 다시 쓰지 않는다.)
 */
export function scrubObvious(text) {
  return String(text)
    .replace(/\d{6}[-\s]?[1-4]\d{6}/g, '[주민번호]')
    .replace(/01[016-9][-\s]?\d{3,4}[-\s]?\d{4}/g, '[전화번호]')
    .replace(/\b\d{2,3}-\d{3,4}-\d{4}\b/g, '[전화번호]');
}

export function validate(body) {
  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  const contact = typeof body?.contact === 'string' ? body.contact.trim() : '';
  const wantsUpdates = body?.wantsUpdates === true;

  if (!message) return { ok: false, code: 'EMPTY_FEEDBACK', message: '의견을 입력해 주세요.' };
  if (message.length > MAX_MESSAGE_CHARS) {
    return { ok: false, code: 'TOO_LONG', message: `의견은 ${MAX_MESSAGE_CHARS}자까지 보낼 수 있어요.` };
  }
  if (contact.length > MAX_CONTACT_CHARS) {
    return { ok: false, code: 'TOO_LONG', message: '연락처가 너무 깁니다.' };
  }
  return { ok: true, message, contact, wantsUpdates };
}

async function notifyWebhook(url, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Slack·Discord 수신 웹훅은 `text` 를 그대로 본문으로 읽는다.
      // Make·Zapier 같은 릴레이는 반대로 필드를 하나씩 매핑하므로,
      // 의견 본문을 `text` 안에만 두면 거기서 잘라 써야 한다. 사람이 읽을
      // `text` 와 기계가 매핑할 `message` 를 **둘 다** 보낸다.
      body: JSON.stringify({ text: payload.text, ...payload.fields }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'POST 만 허용합니다.' } });
  }

  // 의견 폼도 공개 엔드포인트라 스팸 유입 경로가 된다. analyze 와 같은 창을 쓴다.
  const limit = checkRateLimit(clientIp(req));
  if (!limit.ok) {
    res.setHeader('Retry-After', String(limit.retryAfterSec));
    return res.status(429).json({
      error: { code: 'RATE_LIMITED', message: '잠시 후 다시 보내주세요.', retryAfterSec: limit.retryAfterSec },
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

  const checked = validate(body);
  if (!checked.ok) {
    return res.status(400).json({ error: { code: checked.code, message: checked.message } });
  }

  const message = scrubObvious(checked.message);
  const contact = scrubObvious(checked.contact);
  const receivedAt = new Date().toISOString();

  // (1) 항상 남는 기록. Vercel Logs 에서 tag=feedback 으로 찾는다.
  console.log(JSON.stringify({ tag: 'feedback', receivedAt, message, contact, wantsUpdates: checked.wantsUpdates }));

  // (2) 설정돼 있으면 알림까지. 실패해도 사용자에겐 성공이다(이미 로그에 있다).
  const hook = process.env.FEEDBACK_WEBHOOK_URL;
  if (hook) {
    try {
      await notifyWebhook(hook, {
        text: `[Office Firewall 의견]\n${message}${contact ? `\n\n연락처: ${contact}` : ''}`,
        fields: { source: 'office-firewall', receivedAt, message, contact, wantsUpdates: checked.wantsUpdates },
      });
    } catch (err) {
      console.error(JSON.stringify({ tag: 'feedback_webhook_failed', name: err?.name, message: err?.message }));
    }
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ ok: true });
}
