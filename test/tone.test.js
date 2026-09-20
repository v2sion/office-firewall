import test from 'node:test';
import assert from 'node:assert/strict';
import { mask } from '../src/lib/mask.js';
import { buildMockAnalysis } from '../src/lib/mock.js';

/**
 * Sprint 1 Exit: "톤 3단계 차등 생성 확인".
 * 말투 세기(순한맛/보통맛/매운맛)를 바꾸면 답장 3개 전부 실제로 문구가 달라져야 한다.
 * 하나라도 두 톤에서 같은 문자열이 나오면 "차등 생성"이 아니라 착시다.
 */

const TONES = ['순한맛', '보통맛', '매운맛']; // main.js 의 apiValue() 가 실제로 넘기는 값 (이모지 제거됨)
const SAMPLE_TEXT = '{{PERSON_1}}님 주말에 미안한데, 월요일 오전에 대표님 보고가 잡혀서요. 시간 날 때 가볍게 한번 봐주시면 좋을 것 같아요.';

function analyzeWith(tone, goal = '칼차단') {
  const { maskedText } = mask(SAMPLE_TEXT);
  return buildMockAnalysis(maskedText, {
    job: '기획·PM/PO', level: '주니어', counterpart: '직속상사', goal, tone,
  });
}

test('말투 세기 3단계 — 답장 3개 전부 톤마다 문구가 다르다 (같은 목적 고정)', () => {
  for (const goal of ['칼차단', '시간벌기', '공넘기기', '관계보존']) {
    const byTone = Object.fromEntries(TONES.map((t) => [t, analyzeWith(t, goal)]));
    for (let i = 0; i < 3; i += 1) {
      const texts = TONES.map((t) => byTone[t].replies[i].text);
      const unique = new Set(texts);
      assert.equal(
        unique.size, 3,
        `목적=${goal}, 답장[${i}](${byTone[TONES[0]].replies[i].label}) 이 톤 3단계에서 구별되지 않는다: ${JSON.stringify(texts)}`,
      );
    }
  }
});

test('매운맛은 순한맛보다 쿠션어가 없고 더 직접적이다', () => {
  const mild = analyzeWith('순한맛');
  const spicy = analyzeWith('매운맛');
  const cushions = ['괜찮으', '편하게', '혹시', '조금', '살짝'];
  const mildHasCushion = cushions.some((c) => mild.replies[0].text.includes(c) || mild.replies[2].text.includes(c));
  const spicyHasCushion = cushions.some((c) => spicy.replies[0].text.includes(c) || spicy.replies[2].text.includes(c));
  assert.ok(mildHasCushion, '순한맛 답장에 쿠션어가 전혀 없다');
  assert.ok(!spicyHasCushion, '매운맛 답장에 쿠션어가 섞여 있다');
});

test('말투 세기를 바꿔도 목적(goal)별 차이는 유지된다 — 톤이 목적을 덮어쓰지 않는다', () => {
  const blockOff = analyzeWith('보통맛', '칼차단').replies[0].text;
  const buyTime = analyzeWith('보통맛', '시간벌기').replies[0].text;
  const passOn = analyzeWith('보통맛', '공넘기기').replies[0].text;
  const keep = analyzeWith('보통맛', '관계보존').replies[0].text;
  assert.equal(new Set([blockOff, buyTime, passOn, keep]).size, 4);
});

test('12개 조합(목적4 × 톤3) 모두 서로 다른 첫 번째 답장을 낸다', () => {
  const seen = new Set();
  for (const goal of ['칼차단', '시간벌기', '공넘기기', '관계보존']) {
    for (const tone of TONES) {
      seen.add(analyzeWith(tone, goal).replies[0].text);
    }
  }
  assert.equal(seen.size, 12, `중복된 조합이 있다 — 실제 서로 다른 문구는 ${seen.size}/12개`);
});

/**
 * 말투 세기가 **눈에 띄게** 갈리는가.
 *
 * 세 톤이 각자 규칙을 지켜도 결과가 비슷하면 이 선택지는 있으나 마나다.
 * 실제로 "매운맛을 골라도 보통맛과 차이가 없다"는 제보를 받았고, 재보니
 * 칼차단에서 매운맛(126자)이 보통맛(100자)보다 **길었다.** 단호함이 아니라
 * 장황함이 되어 있었다.
 *
 * 단호함은 말을 더 얹어서가 아니라 덜어내서 나온다. 그래서 세기를 길이와
 * 쿠션어 수로 잰다. 둘 다 세면 되는 값이라 "느낌상 강하다"로 넘어갈 수 없다.
 *
 * 무례함과는 구분한다. 실제로 보낼 메시지라 세 톤 모두 존댓말과 비즈니스
 * 매너 안에 있어야 하고, 아래 마지막 테스트가 그 선을 지킨다.
 */
const HEDGES = ['혹시', '죄송', '것 같', '면 감사', '부탁드립니다', '괜찮으', '조금만', '가능하시'];
const countHedges = (t) => HEDGES.reduce((n, h) => n + (t.split(h).length - 1), 0);
const GOALS = ['칼차단', '시간벌기', '공넘기기', '관계보존'];

function replyFor(goal, tone) {
  const { maskedText } = mask('주말에 미안한데, 월요일 오전에 대표님 보고가 잡혀서요. 시간 날 때 가볍게 한번 봐주시면 좋을 것 같아요. 급한 건 아닙니다!');
  const out = buildMockAnalysis(maskedText, {
    job: '기획·PM/PO', level: '4~6년', counterpart: '직속상사', goal, tone,
  });
  return out.replies[0].text;
}

test('세기가 올라갈수록 답장이 짧아진다 (순한맛 > 보통맛 > 매운맛)', () => {
  for (const goal of GOALS) {
    const mild = replyFor(goal, '순한맛').length;
    const plain = replyFor(goal, '보통맛').length;
    const spicy = replyFor(goal, '매운맛').length;
    assert.ok(mild > plain, `${goal}: 순한맛(${mild}) 이 보통맛(${plain}) 보다 길어야 한다`);
    assert.ok(plain > spicy, `${goal}: 보통맛(${plain}) 이 매운맛(${spicy}) 보다 길어야 한다`);
  }
});

test('매운맛에는 쿠션어가 없고, 순한맛에는 있다', () => {
  for (const goal of GOALS) {
    assert.equal(countHedges(replyFor(goal, '매운맛')), 0, `${goal}: 매운맛에 쿠션어가 있다`);
    assert.ok(countHedges(replyFor(goal, '순한맛')) >= 1, `${goal}: 순한맛에 쿠션어가 없다`);
  }
});

test('매운맛은 문장을 짧게 끊는다 (평균 문장 길이가 보통맛보다 짧다)', () => {
  const avg = (t) => t.length / t.split(/(?<=[.!?])\s+/).filter(Boolean).length;
  for (const goal of GOALS) {
    assert.ok(
      avg(replyFor(goal, '매운맛')) < avg(replyFor(goal, '보통맛')),
      `${goal}: 매운맛 문장이 보통맛보다 길다`,
    );
  }
});

test('세기를 올려도 존댓말과 비즈니스 매너를 벗어나지 않는다', () => {
  // 강한 것과 무례한 것은 다르다. 실제로 보낼 메시지라 이 선은 지켜야 한다.
  const RUDE = /(님이|당신|어이|말이 되|황당|어처구니|제정신|웃기|짜증|어이없)/;
  for (const goal of GOALS) {
    const t = replyFor(goal, '매운맛');
    assert.ok(/(습니다|십시오|합니다)/.test(t), `${goal}: 매운맛이 존댓말이 아니다`);
    assert.ok(!RUDE.test(t), `${goal}: 매운맛에 무례한 표현이 있다`);
    assert.ok(!/[!]{1,}/.test(t), `${goal}: 매운맛에 느낌표가 있다`);
  }
});
