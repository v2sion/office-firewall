import test from 'node:test';
import assert from 'node:assert/strict';
import { mask } from '../src/lib/mask.js';
import { buildMockAnalysis } from '../src/lib/mock.js';
import { isUsableReply } from '../src/lib/normalize.js';
import { DIRECTION_RULES, buildUserMessage } from '../api/_lib/prompt.js';

/**
 * 실사용 피드백: "유관부서가 보낸 메시지를 넣었더니 답장이 그 내용에 대한
 * 응답이 아니라 내가 넣은 메시지를 다르게 표현한 것 같다."
 *
 * 원인: MOCK 답장 템플릿이 목적×말투 세기로만 갈라지고, 감지된 ambiguityType 을
 * 반영하지 않은 채 "범위와 기한이 비어 있다"는 subtext 의 진단 문구를 답장에도
 * 그대로 반복해서 썼다. 이 테스트는 (1) 답장이 subtext 의 문구를 그대로
 * 복사하지 않는지, (2) 서로 다른 ambiguityType 을 감지한 메시지끼리는 답장도
 * 달라지는지를 확인한다.
 */

function analyze(text, context) {
  const { maskedText } = mask(text);
  return buildMockAnalysis(maskedText, context);
}

test('실사용 재현: 유관부서 메시지에 "마감 기한" 등 구체적인 초점 명사가 답장에 들어간다', () => {
  const ctx = { job: '개발(Dev)', level: '시니어', counterpart: '타부서 동료', goal: '공넘기기', tone: '보통맛' };
  const result = analyze('이번 주 안에 데이터 스펙 공유 부탁드립니다. 다음 주 회의 전까지 반영해야 해서요.', ctx);

  assert.equal(result.ambiguityType, '기한 불명');
  const agenda = result.replies.find((r) => r.label === '선제적 아젠다 요구').text;
  const laundered = result.replies.find((r) => r.label === '속마음 분노 세탁 버전').text;
  assert.ok(agenda.includes('마감 기한'), `아젠다 답장이 감지된 이슈(마감 기한)를 언급하지 않는다: ${agenda}`);
  assert.ok(laundered.includes('마감 기한'), `분노 세탁 답장이 감지된 이슈(마감 기한)를 언급하지 않는다: ${laundered}`);
});

test('답장이 subtext 의 진단 문장을 그대로 복사하지 않는다 (재진술처럼 보이지 않게)', () => {
  const ctx = { job: '개발(Dev)', level: '시니어', counterpart: '타부서 동료', goal: '공넘기기', tone: '보통맛' };
  const result = analyze('이번 주 안에 데이터 스펙 공유 부탁드립니다. 다음 주 회의 전까지 반영해야 해서요.', ctx);

  // subtext 의 핵심 진단 문구("범위와 기한이 비어 있습니다")가 답장 어디에도
  // 토씨 하나 안 틀리고 그대로 등장하면 안 된다 — 지금은 감지된 focus 명사구로
  // 바꿔 쓴다.
  const verbatimDiagnosis = '범위와 기한이 비어 있';
  for (const r of result.replies) {
    assert.ok(!r.text.includes(verbatimDiagnosis), `[${r.label}] 이 subtext 문구를 그대로 반복한다: ${r.text}`);
  }
});

test('서로 다른 ambiguityType 을 유발하는 메시지는 아젠다/분노세탁 답장의 초점 명사도 달라진다', () => {
  const ctx = { job: '개발(Dev)', level: '시니어', counterpart: '타부서 동료', goal: '공넘기기', tone: '보통맛' };
  const rr = analyze('이 건은 저희 쪽 R&R은 아닌 것 같은데요, 먼저 정리해서 공유해주실 수 있을까요?', ctx);
  const deadline = analyze('이번 주 안에 데이터 스펙 공유 부탁드립니다. 다음 주 회의 전까지 반영해야 해서요.', ctx);

  assert.equal(rr.ambiguityType, 'R&R 미지정');
  assert.equal(deadline.ambiguityType, '기한 불명');

  const rrAgenda = rr.replies.find((r) => r.label === '선제적 아젠다 요구').text;
  const deadlineAgenda = deadline.replies.find((r) => r.label === '선제적 아젠다 요구').text;
  assert.ok(rrAgenda.includes('담당 범위'));
  assert.ok(deadlineAgenda.includes('마감 기한'));
  assert.notEqual(rrAgenda, deadlineAgenda);
});

test('이름이 없는 유관부서 메시지도 첫 번째 답장이 인사/확인 없이 허공에 뜬 문장으로 끝나지 않는다', () => {
  // 정밀 방어 답장은 addressee({{PERSON_1}}) 가 없을 때도 "요청 확인했습니다"류의
  // 승인 프레임 없이 defense[goal] 텍스트 자체가 이미 응답체로 시작해야 한다.
  const ctx = { job: '개발(Dev)', level: '시니어', counterpart: '타부서 동료', goal: '시간벌기', tone: '보통맛' };
  const result = analyze('스펙 공유 부탁드립니다.', ctx);
  const first = result.replies[0].text;
  assert.ok(!first.startsWith('{{'), '토큰으로 시작하면 안 된다(주소 대상이 없을 때)');
  assert.ok(/^(요청|판단|검토)/.test(first), `응답체 프레이밍 없이 시작한다: ${first}`);
});

/**
 * 화자·수신자 고정 회귀 테스트
 *
 * 받은 메시지가 "{{PERSON_1}}님 …" 으로 시작하면 PERSON_1 은 **사용자 본인**이다
 * (발신자가 사용자를 부른 것). 예전 mock.js 는 PERSON_1 을 "상대 이름"으로
 * 가정해 답장을 "{{PERSON_1}}님, " 으로 열었고, 그 결과 사용자가 자기 자신에게
 * 답장을 쓰는 출력이 나왔다. 제품의 핵심 산출물이 틀리는 버그라 고정해 둔다.
 */
test('받은 메시지의 호칭 대상(=사용자 본인)을 답장의 호칭으로 되돌려 쓰지 않는다', () => {
  const ctx = { job: '기획·PM/PO', level: '주니어', counterpart: '직속상사', tone: '보통맛' };
  const received = '{{PERSON_1}}님 주말에 미안한데, 월요일 오전에 대표님 보고가 잡혀서요. 시간 날 때 가볍게 한번 봐주시면 좋을 것 같아요. 급한 건 아닙니다!';

  for (const goal of ['칼차단', '시간벌기', '공넘기기', '관계보존']) {
    for (const tone of ['순한맛', '보통맛', '매운맛']) {
      const result = analyze(received, { ...ctx, goal, tone });
      for (const reply of result.replies) {
        assert.ok(
          !reply.text.includes('{{PERSON_1}}'),
          `${goal}/${tone} "${reply.label}" 이 사용자 본인을 호칭했다: ${reply.text.slice(0, 60)}`,
        );
      }
    }
  }
});

test('답장은 어떤 조합에서도 사람 토큰 호칭으로 시작하지 않는다', () => {
  // 발신자 이름은 입력 어디에도 없으므로 답장 호칭은 지어낼 수 없다.
  const received = '{{PERSON_1}}님, {{PERSON_2}} 대리 건은 어떻게 되고 있나요? 확인 부탁드려요.';
  for (const counterpart of ['직속상사', '임원', '후배', '클라이언트', '민원인']) {
    const result = analyze(received, { job: '기타', level: '주니어', counterpart, goal: '칼차단', tone: '보통맛' });
    for (const reply of result.replies) {
      assert.ok(!/^\{\{PERSON_\d+\}\}/.test(reply.text), `${counterpart}: ${reply.text.slice(0, 40)}`);
    }
  }
});

/* ────────────────────────────────────────────────────────────────
 * 실사용 제보 2: 상대를 "후배"로 골랐는데 상사에게 보내는 답장이 나왔다.
 *
 *   [추천 1] "이번 건은 수용이 어렵습니다. 이미 잡힌 일정이 있어요.
 *             다른 동료에게 맡기거나 일정 조정 부탁드립니다. 해 주십시오."
 *   [추천 2] "먼저, 산출물 범위와 확인 포인트를 명확히 해 주십시오.
 *             1. 산출물 범위 2. 확인 포인트 3. 마감 시각 4. 담당 주체.
 *             이 정보를 주시면 일정 조정 가능하겠습니다."
 *   [추천 3] "이 요청이 제 일정에 큰 부담을 주고 있습니다. 이미 다른
 *             프로젝트가 겹쳐 있어요. 따라서 다른 사람에게 맡겨 주시거나
 *             일정 재조정 부탁드립니다."
 *
 * 세 가지가 겹쳐 있었다.
 *   (a) "해 주십시오." — 목적어 없이 어미만 남은 꼬리 문장
 *   (b) "있어요" 와 "습니다" 가 한 답장 안에 섞인 종결(보통맛 규칙 위반)
 *   (c) 목록에 쓸 항목을 바로 앞 문장에서 미리 읊은 되풀이
 *
 * 셋 다 형식은 통과하던 답장이라, isUsableReply 가 잡지 못하고 그대로
 * 화면까지 갔다. 이 테스트가 그 세 문장을 고정해 둔다.
 * ──────────────────────────────────────────────────────────────── */

const REPORTED_BAD_REPLIES = [
  '이번 건은 수용이 어렵습니다. 이미 잡힌 일정이 있어요. 다른 동료에게 맡기거나 일정 조정 부탁드립니다. 해 주십시오.',
  '먼저, 산출물 범위와 확인 포인트를 명확히 해 주십시오. 1. 산출물 범위 2. 확인 포인트 3. 마감 시각 4. 담당 주체. 이 정보를 주시면 일정 조정 가능하겠습니다.',
  '이 요청이 제 일정에 큰 부담을 주고 있습니다. 이미 다른 프로젝트가 겹쳐 있어요. 따라서 다른 사람에게 맡겨 주시거나 일정 재조정 부탁드립니다.',
];

test('제보된 후배 답장 3종은 전부 걸러진다 (그대로 보낼 수 없는 문장)', () => {
  for (const text of REPORTED_BAD_REPLIES) {
    assert.equal(
      isUsableReply(text, { tone: '보통맛' }), false,
      `그대로 통과했다: ${text}`,
    );
  }
});

test('꼬리 문장·종결 혼용·목록 되풀이를 각각 잡는다', () => {
  const dangling = '말씀 주신 일정은 이번 주에는 어렵습니다. 다음 주 월요일에 회신드리겠습니다. 해 주십시오.';
  const mixed = '이번 요청은 수용이 어렵습니다. 선행 일정이 이미 잡혀 있어요. 다음 주에 다시 보겠습니다.';
  const echoed = '먼저 작업 범위와 마감 시각과 담당 주체를 정해 주십시오. 1. 작업 범위 2. 마감 시각 3. 담당 주체. 정해지면 일정을 회신하겠습니다.';

  assert.equal(isUsableReply(dangling, { tone: '보통맛' }), false, '꼬리 문장을 놓쳤다');
  assert.equal(isUsableReply(mixed, { tone: '보통맛' }), false, '종결 혼용을 놓쳤다');
  assert.equal(isUsableReply(echoed, { tone: '보통맛' }), false, '목록 되풀이를 놓쳤다');
});

test('순한맛은 종결이 부드러운 게 규칙이라 해요체를 섞어도 통과한다', () => {
  const mild = '말씀 주신 건은 이번에는 맡기 어려울 것 같습니다. 지금 진행 중인 일정이 먼저 잡혀 있어서요. 급한 부분만 알려주시면 그 안에서 먼저 보고 공유드릴게요.';
  assert.equal(isUsableReply(mild, { tone: '순한맛' }), true, `순한맛 답장이 걸러졌다: ${mild}`);
  // 같은 문장이라도 보통맛이면 규칙 위반이다 — 톤에 따라 판정이 갈린다.
  assert.equal(isUsableReply(mild, { tone: '보통맛' }), false);
});

test('규칙 엔진이 만든 답장은 전 조합에서 이 검사를 통과한다 (폴백이 스스로를 어기면 안 된다)', () => {
  // 걸러낸 답장의 자리는 MOCK 답장이 대신한다. 그 대체품이 같은 검사에
  // 걸리면 고장 난 답장을 고장 난 답장으로 바꾸는 셈이다.
  const samples = [
    '주말에 미안한데 이거 월요일 보고 전에 가볍게 한번 봐줄 수 있을까요?',
    '이 건은 저희 쪽 R&R은 아닌 것 같은데요, 먼저 정리해서 공유해주실 수 있을까요?',
    '내일까지 다시 작업해서 보내주세요.',
  ];
  let checked = 0;
  for (const text of samples)
    for (const counterpart of ['직속상사', '임원', '선배', '후배', '동기', '타부서 동료', '클라이언트', '민원인'])
      for (const tone of ['순한맛', '보통맛', '매운맛'])
        for (const goal of ['칼차단', '시간벌기', '공넘기기', '관계보존']) {
          const ctx = { job: '기획·PM/PO', level: '주니어', counterpart, tone, goal, hiddenContext: '' };
          for (const reply of analyze(text, ctx).replies) {
            checked += 1;
            assert.ok(
              isUsableReply(reply.text, { tone }),
              `${counterpart}/${tone}/${goal} "${reply.label}" 이 자기 검사에 걸린다: ${reply.text}`,
            );
          }
        }
  assert.ok(checked >= 288, `검사한 답장이 너무 적다: ${checked}`);
});

test('상대가 후배면 재배정을 부탁하지 않는다 — 그 결정권은 내 쪽에 있다', () => {
  const text = '이거 내일까지 다시 정리해서 보내주실 수 있을까요?';
  const base = { job: '기획·PM/PO', level: '시니어', goal: '칼차단' };
  for (const tone of ['순한맛', '보통맛', '매운맛']) {
    const junior = analyze(text, { ...base, tone, counterpart: '후배' }).replies[0].text;
    const boss = analyze(text, { ...base, tone, counterpart: '직속상사' }).replies[0].text;
    assert.notEqual(junior, boss, `${tone}: 후배와 직속상사에게 같은 답장이 나간다`);
    for (const ask of ['우선순위를 바꾸시려면', '우선순위 조정이 필요하면', '다른 일정과의 우선순위를 정해']) {
      assert.ok(!junior.includes(ask), `${tone}: 후배에게 우선순위 결정을 떠넘긴다 — ${junior}`);
    }
  }
});

test('상대방 관계 8종 모두 말하기 방향 지시가 있다 (LIVE 경로)', () => {
  // src/main.js OPTIONS.counterpart 와 같은 목록이어야 한다. 관계를 추가하고
  // 방향 지시를 빠뜨리면 그 관계만 지시 없이 LIVE 로 나간다.
  const COUNTERPARTS = ['직속상사', '임원', '선배', '후배', '동기', '타부서 동료', '클라이언트', '민원인'];
  for (const counterpart of COUNTERPARTS) {
    assert.ok(DIRECTION_RULES[counterpart], `${counterpart} 의 말하기 방향 지시가 없다`);
    const msg = buildUserMessage('내일까지 부탁드려요', { counterpart, tone: '보통맛', goal: '칼차단' });
    assert.ok(
      msg.includes('[상대방과의 관계 · 말하기 방향]') && msg.includes(DIRECTION_RULES[counterpart]),
      `${counterpart}: 지시가 사용자 메시지에 실리지 않는다`,
    );
  }
});
