import test from 'node:test';
import assert from 'node:assert/strict';
import { matchSituationId } from '../src/lib/situation-match.js';

test('빈 문자열/공백은 매칭되지 않는다', () => {
  assert.equal(matchSituationId(''), null);
  assert.equal(matchSituationId('   \n  '), null);
});

test('신호가 없는 평범한 업무 메시지는 매칭되지 않는다', () => {
  assert.equal(matchSituationId('오늘 회의 3시에 진행할게요. 자료는 제가 준비하겠습니다.'), null);
});

test('상황 카드 8종 원문은 모두 자기 자신의 id로 매칭된다', () => {
  const cases = [
    ['weekend', undefined, '박지훈님 주말에 미안한데, 월요일 오전에 대표님 보고가 잡혀서요. 시간 날 때 가볍게 한번 봐주시면 좋을 것 같아요. 급한 건 아닙니다!'],
    ['aislop', undefined, '안녕하세요! 말씀해주신 사항에 대해 검토해보았습니다. 전반적으로 긍정적인 방향으로 보이며, 추가적인 논의를 통해 더 나은 결과를 도출할 수 있을 것으로 사료됩니다. 관련하여 지속적인 커뮤니케이션을 이어가면 좋겠습니다. 감사합니다.'],
    ['pingpong', undefined, '이 건은 저희 쪽 R&R은 아닌 것 같은데요, 아무래도 기획 단계에서 정리되는 게 맞을 것 같습니다. 혹시 먼저 정리해서 공유해주실 수 있을까요? 저희는 그거 받고 나서 진행하겠습니다.'],
    ['client', '클라이언트', '이거 처음 얘기했던 거랑 좀 다른데요? 저희가 원한 건 이게 아니었습니다. 내일까지 다시 작업해서 보내주세요. 추가 비용 얘기는 없던 걸로 알고 있습니다.'],
    ['nightowl', undefined, '이렇게 늦은 시간에 톡해서 미안한데 자기 전에 하나만 부탁해도 될까요? 내일 오전 회의자료에 지난달 지표 슬라이드 하나만 껴주면 좋을 것 같아요. 급한 건 아니니까 편하실 때 봐주세요~'],
    ['emailcreep', '클라이언트', '안녕하세요, 지난번에 말씀드린 배너 시안 관련해서요. 죄송한데 색감을 조금만 더 밝게, 폰트도 살짝 키워주시고, 로고 위치도 다시 한 번 검토 부탁드려요. 예산 안에서 진행 가능할 것 같아서 말씀드립니다!'],
    ['groupchat', undefined, '다들 보고 계시죠? 이번 프로젝트 일정 늦어진 거 이 자리에서 한번 정리하고 갑시다. 담당자분 답변 부탁드려요.'],
    ['passthebuck', undefined, '이 부분은 담당자님이 알아서 잘 판단해서 진행해 주세요. 저는 큰 그림만 보고 있어서 세부적인 건 믿고 맡기겠습니다. 결과만 잘 나오면 될 것 같아요!'],
  ];
  for (const [expected, counterpart, text] of cases) {
    assert.equal(matchSituationId(text, counterpart), expected, `expected ${expected} for: ${text.slice(0, 20)}...`);
  }
});

test('AI 슬롭 마커가 강하면 상대방/기타 신호보다 aislop 이 우선한다', () => {
  const t = '전반적으로 긍정적인 방향이며 추가적인 논의를 통해 도출할 수 있을 것으로 사료됩니다.';
  assert.equal(matchSituationId(t, '클라이언트'), 'aislop');
});

test('당일 마감 신호가 있어도 상대가 클라이언트/민원인/후배가 아니면 매칭하지 않는다', () => {
  const t = '내일까지 다시 작업해서 보내주세요.';
  assert.equal(matchSituationId(t, '직속상사'), null);
});

test('같은 "당일 마감" 신호도 관계에 따라 client·complainant·juniordump 로 갈린다', () => {
  const t = '내일까지 다시 작업해서 보내주세요.';
  assert.equal(matchSituationId(t, '클라이언트'), 'client');
  assert.equal(matchSituationId(t, '민원인'), 'complainant');
  assert.equal(matchSituationId(t, '후배'), 'juniordump');
});

test('신규 상황 카드(juniordump·complainant) 원문도 자기 자신의 id로 매칭된다', () => {
  const juniordump = '선배님 죄송한데 저 이거 도저히 감이 안 잡혀서요… 내일까지 드려야 하는데 대신 좀 봐주시면 안 될까요? 선배님이 하시면 훨씬 빠를 것 같아서요ㅠㅠ';
  const complainant = '지금 몇 시간째 기다리는 줄 아세요? 당장 책임자 나오라고 하세요. 오늘 중으로 처리 안 되면 가만 안 있을 겁니다.';
  assert.equal(matchSituationId(juniordump, '후배'), 'juniordump');
  assert.equal(matchSituationId(complainant, '민원인'), 'complainant');
});
