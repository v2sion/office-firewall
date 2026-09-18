/**
 * 보안 검토에서 나온 항목들의 회귀 테스트.
 *
 * 이 제품의 핵심 주장은 "원문은 브라우저를 벗어나지 않는다" 이므로,
 * 마스킹 커버리지와 남용 방지는 기능이 아니라 신뢰의 전제다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mask, unmask, maskFields } from '../src/lib/mask.js';
import { checkRateLimit, _resetRateLimit, PER_IP_MAX, GLOBAL_MAX } from '../api/_lib/rate-limit.js';

/* ── 이름 마스킹 커버리지 ───────────────────────────── */

test('호칭 "님" 없이 직급만 붙는 실명도 가린다 (검토 전 누출되던 형태)', () => {
  for (const [input, shouldHide] of [
    ['박지훈 책임이 검토 중입니다', '박지훈'],
    ['이수진 팀장 보고 건', '이수진'],
    ['김수진 대리에게 전달했습니다', '김수진'],
    ['최영호 부장님께 보고드렸습니다', '최영호'],
  ]) {
    const { maskedText } = mask(input);
    assert.ok(!maskedText.includes(shouldHide), `실명이 남았다: ${maskedText}`);
  }
});

test('"씨" 호칭도 가린다', () => {
  const { maskedText } = mask('김철수씨 이거 언제까지 되나요');
  assert.ok(!maskedText.includes('김철수'), maskedText);
});

test('직급은 남긴다 — 권력 비대칭 신호가 지워지면 안 된다', () => {
  const { maskedText } = mask('이수진 팀장 보고 건');
  assert.ok(maskedText.includes('팀장'), maskedText);
});

test('직급·역할어 자체는 이름으로 오인해 가리지 않는다', () => {
  for (const s of ['대표님 보고가 잡혀서요', '담당자님께 문의드립니다']) {
    const { maskedText } = mask(s);
    assert.equal(maskedText, s, `역할어를 이름으로 오인했다: ${maskedText}`);
  }
});

test('일반 명사를 이름으로 오탐하지 않는다', () => {
  for (const s of ['오늘 날씨가 좋네요', '마케팅 대리점 문의', '고객사 미팅 일정']) {
    const { maskedText } = mask(s);
    assert.equal(maskedText, s, `오탐: ${maskedText}`);
  }
});

test('확대된 패턴에서도 역치환 round-trip 이 깨지지 않는다', () => {
  for (const s of ['박지훈 책임이 검토 중', '김철수씨와 이수진 팀장', '최영호 부장님께 보고']) {
    const { maskedText, map } = mask(s);
    assert.equal(unmask(maskedText, map), s);
  }
});

test('숨은 속사정 필드도 같은 커버리지로 가려진다 (우회 경로 차단)', () => {
  const { maskedMessage, maskedHiddenContext } = maskFields(
    '확인 부탁드립니다',
    '김철수 팀장이 이미 승인했다고 함',
  );
  assert.ok(!maskedHiddenContext.includes('김철수'), maskedHiddenContext);
  assert.ok(maskedHiddenContext.includes('팀장'));
  assert.equal(maskedMessage, '확인 부탁드립니다');
});

/* ── 남용 방지 ───────────────────────────── */

test('IP 당 상한을 넘으면 429 대상이 된다', () => {
  _resetRateLimit();
  const now = Date.now();
  for (let i = 0; i < PER_IP_MAX; i += 1) {
    assert.equal(checkRateLimit('1.2.3.4', now).ok, true, `${i}번째는 통과해야 한다`);
  }
  const blocked = checkRateLimit('1.2.3.4', now);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.scope, 'ip');
  assert.ok(blocked.retryAfterSec > 0);
});

test('다른 IP 는 서로 영향을 주지 않는다', () => {
  _resetRateLimit();
  const now = Date.now();
  for (let i = 0; i < PER_IP_MAX; i += 1) checkRateLimit('1.1.1.1', now);
  assert.equal(checkRateLimit('2.2.2.2', now).ok, true);
});

test('시간 창이 지나면 다시 허용된다', () => {
  _resetRateLimit();
  const now = Date.now();
  for (let i = 0; i < PER_IP_MAX; i += 1) checkRateLimit('3.3.3.3', now);
  assert.equal(checkRateLimit('3.3.3.3', now).ok, false);
  assert.equal(checkRateLimit('3.3.3.3', now + 61_000).ok, true);
});

test('분산된 다수 IP 도 인스턴스 전체 상한에 걸린다 (예산 보호)', () => {
  _resetRateLimit();
  const now = Date.now();
  let allowed = 0;
  for (let i = 0; i < GLOBAL_MAX + 50; i += 1) {
    if (checkRateLimit(`10.0.0.${i}`, now).ok) allowed += 1;
  }
  assert.equal(allowed, GLOBAL_MAX);
});

test('오래된 기록은 정리된다 — 카운터가 무한히 자라면 그 자체가 고갈 경로다', () => {
  _resetRateLimit();
  const now = Date.now();
  for (let i = 0; i < 50; i += 1) checkRateLimit(`172.16.0.${i}`, now);
  // 창이 지난 뒤 새 요청이 들어오면 옛 엔트리는 비워지고 정상 통과해야 한다.
  assert.equal(checkRateLimit('172.16.0.99', now + 120_000).ok, true);
});

/* ── 데모 준비 중 발견한 오탐/누락 (회귀 고정) ───────────────────────────── */

test('시간·지시어에 조사가 붙은 말을 이름으로 오인하지 않는다', () => {
  // "월요일 오전에 대표님" 의 "오전에" 가 {{PERSON_2}} 로 가려지던 버그
  const { maskedText } = mask('박지훈 팀장님 주말에 미안한데, 월요일 오전에 대표님 보고가 잡혀서요.');
  assert.ok(!maskedText.includes('{{PERSON_2}}'), `오탐: ${maskedText}`);
  assert.ok(maskedText.includes('오전에'), `시간 표현이 지워졌다: ${maskedText}`);
  assert.ok(!maskedText.includes('박지훈'), `실명이 남았다: ${maskedText}`);
});

test('직급 뒤에 한테·에게·에서가 와도 이름을 가린다', () => {
  for (const [input, name] of [
    ['김수진 대리한테 이미 확인함', '김수진'],
    ['이수진 팀장에게 전달했습니다', '이수진'],
    ['최영호 부장에서 승인', '최영호'],
  ]) {
    const { maskedText } = mask(input);
    assert.ok(!maskedText.includes(name), `실명이 남았다: ${maskedText}`);
  }
});

test('은/는 로 끝나는 실제 이름은 계속 가린다 (지은·하은·다은)', () => {
  for (const name of ['지은', '하은', '다은']) {
    const { maskedText } = mask(`${name} 팀장이 확인했습니다`);
    assert.ok(!maskedText.includes(name), `실명이 남았다: ${maskedText}`);
  }
});

test('시간·지시어 자체는 직급 앞에 와도 가리지 않는다', () => {
  for (const s of ['오늘 오후 대표님 보고', '이번 주 팀장 회의', '지난 분기 이사 보고']) {
    const { maskedText } = mask(s);
    assert.equal(maskedText, s, `오탐: ${maskedText}`);
  }
});
