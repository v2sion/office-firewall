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
