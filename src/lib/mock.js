/**
 * MOCK 경로 — ANTHROPIC_API_KEY 가 없거나 OFW_FORCE_MOCK=1 일 때 사용한다.
 *
 * 목적은 두 가지다.
 *  1) 키 없이도 마스킹 → 룰엔진 → 렌더링 전 구간을 검증할 수 있게 한다.
 *  2) 시연 중 API 가 느리거나 실패해도 화면이 비지 않게 하는 폴백이 된다.
 *
 * 여기서 만드는 값은 "AI가 추출했을 법한 값"의 규칙 기반 근사치다.
 * 점수는 여기서도 만들지 않는다 — score.js 가 계산한다.
 */
import { extractSubstanceSignals, containsKo } from './cliche.js';

/** AI 슬롭(무내용 정형구) 마커 — 사람이 쓰는 구어체 클리셰와는 구분한다 */
const AI_SLOP_MARKERS = [
  '사료됩니다', '전반적으로', '긍정적인 방향', '추가적인 논의', '지속적인 커뮤니케이션',
  '말씀해주신', '관련하여', '도출할 수 있을', '다음과 같습니다', '검토해보았습니다',
  '적극적으로 검토', '원활한 진행', '유기적으로',
];

const POWER_BY_COUNTERPART = {
  '직속상사': 4,
  '클라이언트': 5,
  '타부서 동료': 3,
  '팀원(AI복붙)': 2,
};

function detectUrgency(t) {
  if (/(주말|토요일|일요일|토욜|일욜)/.test(t)) return '주말 침범';
  if (/(새벽|밤\s*\d|퇴근\s*후|야근|자정|23시|22시|늦은\s*시간)/.test(t)) return '야간 침범';
  if (/(오늘\s*중|오늘까지|내일까지|당일|금일\s*중|퇴근\s*전까지)/.test(t)) return '당일 마감';
  return '없음';
}

function detectAmbiguity(t, signals) {
  if (/(R&R|알앤알|롤앤롤|담당이|누가 하|소관|저희 쪽은)/i.test(t)) return 'R&R 미지정';
  if (/(가볍게|간단히|한번 봐|전반적으로|대략|알아서|적당히|보완해서|다시 작업)/.test(t)) return '범위 불명';
  if (!signals.hasDeadline && /(부탁|주세요|해주실|요청|보내주)/.test(t)) return '기한 불명';
  return '없음';
}

function aiSlopScore(t, signals) {
  const hits = AI_SLOP_MARKERS.filter((m) => containsKo(t, m)).length;
  if (!hits) return 0;
  const base = hits * 15;
  const bonus = (!signals.hasNumbers && !signals.hasDeadline ? 20 : 0) + (signals.avoidsDecision ? 10 : 0);
  return Math.min(100, base + bonus);
}

function buildSubtext(ctx, urgency, ambiguity, slop, signals) {
  if (slop >= 60) {
    return '내용 없는 정형구로 채워진 메시지입니다. 결론·수치·기한 중 어느 것도 제시되지 않아, 사실상 판단과 정리 부담을 수신자에게 넘기고 있습니다. 회신 전에 무엇을 결정해 달라는 것인지부터 되물어야 합니다.';
  }
  if (urgency === '주말 침범') {
    return '겉으로는 "급하지 않다"고 하지만, 월요일 일정이 이미 고정된 이상 실질적으로는 주말 안에 1차 결과물을 요구하는 비공식 과업입니다. 요청 범위와 기한이 모두 비어 있어 수락하는 순간 기준이 상대에게 넘어갑니다.';
  }
  if (ambiguity === 'R&R 미지정') {
    return '표면적으로는 협조 요청이지만, 실제로는 선행 작업의 소유권을 상대에게 이전하려는 메시지입니다. "먼저 정리해 주면 받고 진행하겠다"는 구조는 일정 지연의 책임까지 함께 넘깁니다.';
  }
  if (ctx.counterpart === '클라이언트') {
    return '합의 범위 밖의 재작업을 추가 비용 없이 요구하고 있습니다. 최초 요구사항과의 차이를 문서로 확인하지 않으면, 범위 확대가 기본값으로 굳어집니다.';
  }
  if (!signals.clicheHits.length && (signals.hasNumbers || signals.hasDeadline)) {
    return '요청 범위·확인 지점·기한이 모두 명시된 정상적인 업무 메시지입니다. 숨은 요구나 과업 전가 신호는 발견되지 않았습니다.';
  }
  return '요구의 핵심은 드러나 있으나 범위와 기한이 비어 있습니다. 수락 전에 무엇을 어디까지 언제까지 할지 먼저 확정하는 편이 안전합니다.';
}

const TONE_OPEN = {
  '순한맛': { greet: '안녕하세요, 말씀 주셔서 감사합니다. ', close: ' 혹시 제가 잘못 이해한 부분이 있다면 편하게 말씀해 주세요.' },
  '보통맛': { greet: '', close: '' },
  '매운맛': { greet: '', close: '' },
};

/**
 * 룰엔진이 이미 진단한 ambiguityType 을 "무엇이 비어 있는지"를 가리키는
 * 명사구로 바꾼다. 답장이 subtext 의 진단 문구("범위와 기한이 비어 있다")를
 * 그대로 반복하면 "내 메시지를 다르게 표현한 것" 처럼 읽힌다 — 그래서 답장
 * 쪽은 항상 이 구체적인 명사구를 쓰고, subtext 의 문장을 그대로 재사용하지
 * 않는다.
 */
function ambiguityFocus(ambiguityType) {
  if (ambiguityType === 'R&R 미지정') return '담당 범위';
  if (ambiguityType === '범위 불명') return '작업 범위';
  if (ambiguityType === '기한 불명') return '마감 기한';
  return '세부 조건';
}

/** 마지막 음절에 받침이 있는지 (한글 완성형 코드포인트 기준). 조사 선택용. */
function hasBatchim(word) {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  if (code < 0 || code > 11171) return true; // 한글이 아니면 안전하게 받침 있는 쪽 취급
  return code % 28 !== 0;
}
const josaI = (w) => (hasBatchim(w) ? '이' : '가');
const josaEul = (w) => (hasBatchim(w) ? '을' : '를');

function replyTemplates(ctx, maskedText, urgency, ambiguity) {
  const focus = ambiguityFocus(ambiguity);
  const focusI = focus + josaI(focus); // 예: "담당 범위가", "마감 기한이"
  const focusEul = focus + josaEul(focus); // 예: "담당 범위를", "마감 기한을"
  const tone = TONE_OPEN[ctx.tone] || TONE_OPEN['보통맛'];
  const spicy = ctx.tone === '매운맛';
  const mild = ctx.tone === '순한맛';

  const weekend = urgency === '주말 침범';
  const blockOff = weekend
    ? {
        spicy: '해당 요청은 수용이 어렵습니다. 업무 시간 외 작업은 진행하지 않습니다. 월요일 보고가 확정된 일정이라면 보고 범위를 조정하거나 일정을 다시 잡는 쪽이 맞다고 봅니다. 필요한 자료 목록을 주시면 업무일 기준으로 처리하겠습니다.',
        mild: '주말 중에는 확인이 어려울 것 같아 미리 말씀드립니다. 대신 월요일 업무 시작과 동시에 최우선으로 보겠습니다. 보고까지 시간이 빠듯하다면, 보고에 꼭 필요한 항목만 먼저 알려주시면 그 부분부터 처리하겠습니다.',
        plain: '주말에는 대응이 어렵습니다. 월요일 오전 업무 시작 직후 최우선으로 확인하겠습니다. 보고 시각이 고정되어 있다면 필요한 항목을 먼저 지정해 주시면 그 범위로 한정해 처리하겠습니다.',
      }
    : {
        spicy: '이번 요청은 수용이 어렵습니다. 현재 확정된 일정이 있어 추가 과업을 받을 여력이 없습니다. 우선순위 조정이 필요하다면 어떤 일정을 뒤로 미룰지 먼저 정해 주십시오.',
        mild: '말씀 주신 건은 이번에는 맡기 어려울 것 같습니다. 지금 진행 중인 일정이 먼저 잡혀 있어서요. 다른 일정과의 우선순위를 정해 주시면 그에 맞춰 다시 조정해 보겠습니다.',
        plain: '이번 요청은 수용이 어렵습니다. 선행 일정이 확정되어 있어 추가 과업을 받기 어렵습니다. 우선순위 조정이 필요하면 어떤 일정을 미룰지 알려 주시면 그 기준으로 다시 조정하겠습니다.',
      };

  const defense = {
    '칼차단': spicy ? blockOff.spicy : mild ? blockOff.mild : blockOff.plain,
    '시간벌기': spicy
      ? '판단에 필요한 정보가 빠져 있습니다. 무엇을 어디까지 보라는 것인지, 기한이 언제인지 먼저 알려 주십시오. 기준이 오면 소요 시간을 산정해 회신하겠습니다.'
      : mild
        ? '요청 주신 내용 확인했습니다. 정확히 보려면 범위를 조금만 좁혀 주시면 좋겠습니다. 확인이 필요한 항목과 희망 기한을 알려 주시면, 가능한 일정으로 회신드리겠습니다.'
        : '요청 확인했습니다. 검토 범위와 기한을 먼저 확정하고 싶습니다. 확인이 필요한 항목과 마감 시각을 알려 주시면 소요 일정을 산정해 회신하겠습니다.',
    '공넘기기': spicy
      ? `이 건은 ${focusI} 정리되어야 저희가 착수할 수 있습니다. ${focusEul} 확정해 문서로 공유해 주시면 그 시점 기준으로 일정을 회신하겠습니다.`
      : mild
        ? `말씀 주신 방향은 이해했습니다. 다만 저희가 착수하려면 ${focus}부터 먼저 정리되어야 할 것 같아요. 해당 부분 정리해서 공유해 주시면 바로 이어받아 진행할게요.`
        : `요청 확인했습니다. 다만 ${focusI} 아직 정리되지 않아 저희 쪽에서 바로 착수하기는 어렵습니다. ${focusEul} 먼저 정리해 공유해 주시면 수령 시점 기준으로 일정을 산정해 회신하겠습니다.`,
    '관계보존': spicy
      ? '진행하겠습니다. 다만 범위를 한정하겠습니다. 요청하신 항목 중 핵심 지표만 우선 확인하고, 나머지는 다음 차수로 넘기겠습니다.'
      : mild
        ? '네, 확인하겠습니다. 다만 일정이 겹쳐 있어 이번에는 핵심 항목 위주로 먼저 보고 공유드려도 괜찮을까요? 나머지는 이어서 정리해 드리겠습니다.'
        : '확인하겠습니다. 현재 일정상 핵심 항목을 우선 확인해 공유드리고, 나머지 항목은 이어서 정리해 전달하겠습니다.',
  };

  // 상대 이름이 마스킹되어 있으면 호칭을 붙인다(역치환 경로를 실제로 태운다)
  const addressee = /\{\{PERSON_1\}\}/.test(maskedText) ? '{{PERSON_1}}님, ' : '';
  const first = addressee + tone.greet + (defense[ctx.goal] || defense['관계보존']) + tone.close;

  const agenda = spicy
    ? `특히 ${focusI} 불명확해 진행 전에 기준부터 맞추겠습니다. (1) 이번 요청의 최종 산출물, (2) 확인 범위, (3) 마감 시각, (4) 이 건의 담당 주체 — 네 가지를 명확히 해 주십시오. 기준이 정해지면 그에 맞춰 일정을 회신하겠습니다.`
    : mild
      ? `요청 주신 건, ${focusI} 아직 안 정해진 것 같아서 몇 가지만 확인하면 좋을 것 같습니다. (1) 최종 산출물이 무엇인지, (2) 어디까지 보면 되는지, (3) 언제까지 필요한지, (4) 이 건의 담당은 어느 쪽인지 — 알려 주시면 그 기준으로 바로 진행하겠습니다.`
      : `${focusI} 명확하지 않아 진행 전 네 가지만 확정하고 싶습니다. (1) 최종 산출물, (2) 확인 범위, (3) 마감 시각, (4) 담당 주체. 위 항목이 정해지면 그 기준으로 일정을 회신하겠습니다.`;

  const laundered = spicy
    ? `이번 요청은 ${focusI} 정해지지 않은 상태로 전달됐습니다. 이 상태로 착수하면 결과물이 어긋날 가능성이 높고, 그 비용은 다시 저희가 부담하게 됩니다. ${focus}부터 먼저 정해 주시면 그에 맞춰 정확히 진행하겠습니다.`
    : mild
      ? `이번 요청, ${focusI} 아직 정해지지 않아서 저도 어디서부터 시작해야 할지 조금 막막했어요. 편하실 때 ${focus}만 살짝 알려주시면 그 안에서 최대한 맞춰서 진행해볼게요.`
      : `이번 요청은 ${focusI} 정해지지 않은 채로 왔습니다. 이대로 진행하면 나중에 다시 손봐야 할 가능성이 커서, 서로 시간을 아끼는 차원에서 ${focus}부터 여쭤봅니다. 알려주시면 그 안에서 정확히 처리하겠습니다.`;

  return [
    { label: '목적 맞춤형 정밀 방어', text: first },
    { label: '선제적 아젠다 요구', text: agenda },
    { label: '속마음 분노 세탁 버전', text: laundered },
  ];
}

/**
 * @param {string} maskedText
 * @param {object} context
 * @returns {object} AI 응답과 동일한 형태 (riskScore 없음)
 */
export function buildMockAnalysis(maskedText, context = {}) {
  const ctx = {
    job: context.job || '기획·PM/PO',
    level: context.level || '주니어',
    counterpart: context.counterpart || '직속상사',
    goal: context.goal || '관계보존',
    tone: context.tone || '보통맛',
    hiddenContext: context.hiddenContext || '',
  };
  const signals = extractSubstanceSignals(maskedText);
  const urgencyType = detectUrgency(maskedText);
  const ambiguityType = detectAmbiguity(maskedText, signals);
  const slop = aiSlopScore(maskedText, signals);

  let powerAsymmetry = POWER_BY_COUNTERPART[ctx.counterpart] ?? 3;
  // 정상 업무 신호가 뚜렷하면 거절 비용이 낮다고 본다
  if (urgencyType === '없음' && ambiguityType === '없음' && (signals.hasNumbers || signals.hasDeadline) && !signals.clicheHits.length) {
    powerAsymmetry = Math.min(powerAsymmetry, 2);
  }

  return {
    subtext: buildSubtext(ctx, urgencyType, ambiguityType, slop, signals),
    powerAsymmetry,
    urgencyType,
    ambiguityType,
    aiSlopScore: slop,
    clicheHits: signals.clicheHits,
    hasNumbers: signals.hasNumbers,
    hasDeadline: signals.hasDeadline,
    avoidsDecision: signals.avoidsDecision,
    replies: replyTemplates(ctx, maskedText, urgencyType, ambiguityType),
  };
}
