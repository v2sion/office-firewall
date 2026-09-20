/**
 * 배점의 법적 근거를 고정한다.
 *
 * "가중치는 누가 무슨 근거로 정했나"는 이 제품이 받는 가장 날카로운 질문이다.
 * 근거를 문서에만 적어 두면 코드가 조용히 어긋나도 아무도 모른다. 그래서
 * 근거 모듈(legal-basis.js)과 실제 계산(score.js)·탐지(cliche.js)가 같은
 * 기준을 쓰는지를 테스트가 붙잡는다.
 *
 * 근거:
 *  · 근로기준법 제76조의2 — 직장 내 괴롭힘 성립 3요건
 *  · 근로기준법 제56조 제3항 — 야간근로 = 오후 10시 ~ 다음 날 오전 6시
 *  · 근로기준법 제50조·제53조·제55조 — 근로시간·연장 한도·유급휴일
 *  · 고용노동부 「직장 내 괴롭힘 판단 및 예방·대응 매뉴얼」 — 업무상 적정범위
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { LEGAL_BASIS, LEGAL_DISCLAIMER, TOTAL_POINTS, NIGHT_START_HOUR, NIGHT_END_HOUR } from '../src/lib/legal-basis.js';
import { detectUrgency, clockHours, isLegalNightHour } from '../src/lib/cliche.js';
import { calcRisk } from '../src/lib/score.js';
import { buildMockAnalysis } from '../src/lib/mock.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('네 축의 배점 합이 100이고, 근거 없는 축이 없다', () => {
  assert.equal(TOTAL_POINTS, 100);
  for (const [key, basis] of Object.entries(LEGAL_BASIS)) {
    assert.ok(basis.source, `${key}: 근거 출처가 없다`);
    assert.ok(basis.quote, `${key}: 인용할 문언이 없다`);
    assert.ok(basis.why.length > 40, `${key}: 왜 그 배점인지 설명이 없다`);
    assert.match(basis.source, /근로기준법|고용노동부/, `${key}: 출처가 법령·행정 기준이 아니다`);
  }
});

test('선언한 배점이 실제 계산과 일치한다 (문서와 코드가 갈라지지 않는다)', () => {
  // 권력 비대칭만 최대로, 나머지는 0 → 40점이어야 한다.
  // (정상 업무 가드 GREEN_CAP 을 피하려고 긴급도를 함께 켠다)
  const onlyPowerAndUrgent = calcRisk(
    { powerAsymmetry: 5, urgencyType: '주말 침범', ambiguityType: '없음', hasNumbers: true, hasDeadline: true, clicheHits: [], sentenceCount: 3 },
    '9월 15일 14시까지 배너 2종, 1200x600 으로 부탁드립니다.',
  );
  assert.equal(onlyPowerAndUrgent, LEGAL_BASIS.power.max + LEGAL_BASIS.urgency.max);

  // 네 축이 모두 최대면 100점.
  const all = calcRisk(
    { powerAsymmetry: 5, urgencyType: '주말 침범', ambiguityType: '범위 불명', hasNumbers: false, hasDeadline: false, avoidsDecision: true, clicheHits: ['가볍게', '시간 날 때'], sentenceCount: 2 },
    '주말에 시간 날 때 가볍게 한번 봐주세요.',
  );
  assert.equal(all, TOTAL_POINTS);
});

test('야간 침범은 근로기준법 제56조 제3항의 시간대(22:00~06:00)를 덮는다', () => {
  assert.equal(NIGHT_START_HOUR, 22);
  assert.equal(NIGHT_END_HOUR, 6);

  // 법정 야간 구간 — 전부 잡혀야 한다.
  const night = [
    '오후 10시인데 죄송합니다. 확인 한번 부탁드려요.',
    '밤 11시에 죄송한데 이것만 봐주세요.',
    '23:30에 보냅니다. 내용 확인 부탁드립니다.',
    '새벽 2시에 올린 건 확인 부탁드립니다.',
    '22시까지 회신 부탁드립니다.',
  ];
  for (const t of night) assert.equal(detectUrgency(t), '야간 침범', `놓쳤다: ${t}`);

  // 주간 — 붙으면 안 된다.
  const day = [
    '오후 3시까지 회신 부탁드립니다.',
    '오전 9시 회의 전까지만 보면 됩니다.',
    '9월 15일 14시까지 배너 시안 2종 부탁드립니다. 사이즈는 1200x600입니다.',
  ];
  for (const t of day) assert.notEqual(detectUrgency(t), '야간 침범', `과잉 경보: ${t}`);
});

test('오전·오후 표시가 없는 한 자리 시각은 추측하지 않는다', () => {
  // "9시"는 오전인지 오후인지 알 수 없다. 추측해서 야간으로 몰면 정상
  // 업무 메시지에 경보가 붙는다.
  assert.deepEqual(clockHours('9시까지 부탁드립니다'), []);
  // 13 이상은 24시간제로만 읽히므로 센다.
  assert.deepEqual(clockHours('22시까지 부탁드립니다'), [22]);
  assert.ok(isLegalNightHour(22) && isLegalNightHour(5) && !isLegalNightHour(6) && !isLegalNightHour(21));
});

test('판정 근거 화면이 네 축의 조문을 그대로 펼친다', () => {
  const mainJs = readFileSync(join(root, 'src/main.js'), 'utf8');
  assert.match(mainJs, /legalBasisTable/, '배점 근거를 그리는 코드가 없다');
  assert.match(mainJs, /LEGAL_DISCLAIMER/, '법적 판단이 아니라는 선 긋기가 화면에 없다');
});

test('우리가 하지 않는 일을 분명히 밝힌다 (괴롭힘 성립 여부 판단 아님)', () => {
  assert.match(LEGAL_DISCLAIMER, /법적 판단이 아닙니다/);
  assert.match(LEGAL_DISCLAIMER, /근로기준법/);
  assert.match(LEGAL_DISCLAIMER, /고용노동부/);
});

/* ── 없는 약속을 지어내지 않는다 ─────────────────────────────
 * 답장에 입력에 없던 시각이 박히면 사용자는 자기가 한 적 없는 약속을
 * 그대로 보내게 된다. LIVE 는 프롬프트로 막고, 규칙 엔진 답장은 아예
 * 절대 시각을 쓰지 않는 것으로 구조적으로 막는다.
 * ──────────────────────────────────────────────────────── */
test('규칙 엔진 답장은 어떤 조합에서도 절대 시각을 만들지 않는다', () => {
  const samples = [
    '주말에 미안한데 이거 월요일 보고 전에 가볍게 한번 봐줄 수 있을까요?',
    '이 건은 저희 쪽 R&R은 아닌 것 같은데요, 먼저 정리해서 공유해주실 수 있을까요?',
    '검토해봤습니다. 추가적인 논의를 통해 더 나은 결과를 도출할 수 있을 것으로 사료됩니다.',
  ];
  for (const text of samples)
    for (const counterpart of ['직속상사', '후배', '클라이언트'])
      for (const tone of ['순한맛', '보통맛', '매운맛'])
        for (const goal of ['칼차단', '시간벌기', '공넘기기', '관계보존']) {
          const ctx = { job: '기획·PM/PO', level: '주니어', counterpart, tone, goal };
          for (const reply of buildMockAnalysis(text, ctx).replies) {
            assert.ok(
              !/\d{1,2}\s*(시|:\d{2})/.test(reply.text),
              `${counterpart}/${tone}/${goal}: 입력에 없던 시각을 지어냈다 — ${reply.text}`,
            );
          }
        }
});

test('LIVE 지시문이 날짜·시각 날조와 빈칸을 함께 금지한다', () => {
  const prompt = readFileSync(join(root, 'api/_lib/prompt.js'), 'utf8');
  assert.match(prompt, /입력에 없는 날짜·시각·수치·업무명·사람 이름을 지어내지 마라/);
  // 빈칸으로 도망가는 것도 막아야 한다 — "그대로 복사해 보낼 수 있는 답장"이
  // 이 제품의 약속이라, [날짜] 가 남으면 그 약속이 깨진다.
  assert.match(prompt, /빈칸\(\[날짜\] 등\)으로 남기지도 마라/);
  assert.match(prompt, /오후 10시부터 다음 날 오전 6시 사이/, '야간 정의가 조문과 맞지 않는다');
});
