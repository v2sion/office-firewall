/**
 * MOCK 경로 — GROQ_API_KEY 가 없거나 OFW_FORCE_MOCK=1 일 때 사용한다.
 *
 * 목적은 두 가지다.
 *  1) 키 없이도 마스킹 → 룰엔진 → 렌더링 전 구간을 검증할 수 있게 한다.
 *  2) 시연 중 API 가 느리거나 실패해도 화면이 비지 않게 하는 폴백이 된다.
 *
 * 여기서 만드는 값은 "AI가 추출했을 법한 값"의 규칙 기반 근사치다.
 * 점수는 여기서도 만들지 않는다 — score.js 가 계산한다.
 */
import { extractSubstanceSignals, detectUrgency, detectAmbiguity, aiSlopScore } from './cliche.js';

/**
 * 거절 비용 기본값 — "직책이 아니라 거절 비용으로 매긴다"는 판정 기준
 * (api/_lib/prompt.js 의 powerAsymmetry 앵커)을 이 폴백 경로에도 맞췄다.
 * 임원·클라이언트처럼 거절 시 실질 불이익이 큰 관계를 5로, 후배처럼
 * 거절해도 잃을 게 적은 관계를 1로 둔다.
 */
const POWER_BY_COUNTERPART = {
  '임원': 5,
  '클라이언트': 5,
  '직속상사': 4,
  '민원인': 4,
  '선배': 3,
  '타부서 동료': 3,
  '동기': 2,
  '후배': 1,
};

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
  // 정상 업무 판정은 **룰엔진이 내린 판정값**을 따른다. 예전에는 여기에
  // !clicheHits.length 조건이 붙어 있어서, 완곡어가 하나라도 있으면 아무리
  // 범위·기한이 명시돼도 이 문장에 도달하지 못하고 아래 "범위와 기한이 비어
  // 있습니다" 로 떨어졌다. 그 결과 카드에는 "요구 모호성 없음 / 범위·기한
  // 명확"이 뜨는데 바로 위 해설은 비어 있다고 말하는 자가당착이 생겼다.
  // (cliche.js 의 SUBSTANCE_GATE 와 같은 원칙 — 완곡어는 공허함이 아니다)
  if (urgency === '없음' && ambiguity === '없음') {
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

/**
 * 숨은 속사정을 답장의 **근거 한 문장**으로 바꾼다.
 *
 * 이 값은 ctx 에 담겨만 있고 어디서도 쓰이지 않았다. 사용자가 "주말엔 가족
 * 행사로 외지에 있음"이라고 적어도 답장은 한 글자도 달라지지 않았다는 뜻이다.
 * 적은 것이 결과에 나타나지 않으면 그 칸은 없는 것과 같다.
 *
 * 다만 **적은 문장을 그대로 옮기지는 않는다.** 상대에게 내 사생활을 알릴
 * 이유는 없고, 그래서 화면에서도 "숨은" 속사정이라 부른다. 거절·지연에
 * 무게를 싣는 일반화된 근거로만 쓴다(prompt.js 의 LIVE 지시와 같은 규칙이다).
 */
function groundsFor(ctx) {
  if (!ctx.hiddenContext) return '';
  if (ctx.tone === '매운맛') return '조율이 어려운 일정이 이미 잡혀 있습니다.';
  if (ctx.tone === '순한맛') return '사실 미리 잡아둔 개인 일정이 있어서요.';
  return '조정이 어려운 선약이 이미 잡혀 있습니다.';
}

/**
 * 근거를 **첫 문장 뒤**에 끼운다.
 *
 * 앞에 붙였더니 "이번 주말에는 선약이 있습니다. 주말에는 대응이 어렵습니다."
 * 처럼 같은 말이 두 번 나왔다. 답장의 첫 문장은 결론(수용·거절)이고 근거는
 * 그 뒤에 오는 게 한국어 업무 메시지의 순서이기도 하다.
 */
function withGrounds(text, grounds) {
  if (!grounds) return text;
  const at = text.indexOf('. ');
  if (at < 0) return `${text} ${grounds}`;
  return `${text.slice(0, at + 1)} ${grounds}${text.slice(at + 1)}`;
}

function replyTemplates(ctx, maskedText, urgency, ambiguity) {
  const focus = ambiguityFocus(ambiguity);
  const focusI = focus + josaI(focus); // 예: "담당 범위가", "마감 기한이"
  const focusEul = focus + josaEul(focus); // 예: "담당 범위를", "마감 기한을"
  const tone = TONE_OPEN[ctx.tone] || TONE_OPEN['보통맛'];
  const spicy = ctx.tone === '매운맛';
  const mild = ctx.tone === '순한맛';

  // 매운맛은 **보통맛보다 짧다.** 단호함은 말을 더 얹어서가 아니라 덜어내서
  // 나온다. 예전 매운맛은 보통맛보다 오히려 길어서(칼차단 126자 vs 100자,
  // 실측) 세기 차이가 아니라 장황함 차이가 되어 있었다.
  //
  // 세 톤 모두 존댓말과 비즈니스 매너 안에 있다. 갈리는 건 세 가지뿐이다.
  //   · 첫 문장에 결론이 오는가 (매운맛) / 사정 설명이 먼저인가 (순한맛)
  //   · 쿠션어를 쓰는가
  //   · 기준을 "요청"하는가 (~주시면) / "요구"하는가 (~주십시오)
  const weekend = urgency === '주말 침범';
  // 상대가 후배일 때는 "우선순위를 정해 달라"는 요청이 성립하지 않는다.
  // 그 결정은 내 쪽에 있고, 후배는 받아도 처리할 권한이 없다. 그래서 같은
  // 거절이라도 **내가 판단해서 알려 주는** 문장으로 방향을 뒤집는다.
  // (LIVE 경로의 prompt.js DIRECTION_RULES 와 같은 규칙이다.)
  const downward = ctx.counterpart === '후배';
  const blockOff = weekend
    ? {
        spicy: '주말 업무는 받지 않습니다. 월요일 업무 시작 후 처리하겠습니다. 보고 일정이 고정이라면 보고 범위를 조정해 주십시오.',
        mild: '주말 중에는 확인이 어려울 것 같아 미리 말씀드립니다. 대신 월요일 업무 시작과 동시에 최우선으로 보겠습니다. 보고까지 시간이 빠듯하다면, 보고에 꼭 필요한 항목만 먼저 알려주시면 그 부분부터 처리하겠습니다.',
        plain: '주말에는 대응이 어렵습니다. 월요일 오전 업무 시작 직후 최우선으로 확인하겠습니다. 보고 시각이 고정되어 있다면 필요한 항목을 먼저 지정해 주시면 그 범위로 한정해 처리하겠습니다.',
      }
    : downward
      ? {
          spicy: '이번 건은 지금 받기 어렵습니다. 선행 일정이 확정되어 있습니다. 더 급한 사정이 있으면 근거를 정리해 주십시오.',
          mild: '말씀해 준 건은 이번에는 맡기 어려울 것 같습니다. 지금 진행 중인 일정이 먼저 잡혀 있어서요. 많이 급한 건이면 어떤 점이 급한지만 알려 주시면, 제가 순서를 다시 보고 알려 드릴게요.',
          plain: '이번 요청은 지금 일정으로는 받기 어렵습니다. 선행 일정이 확정되어 있어 추가 과업을 받기 어렵습니다. 더 급한 사정이 있으면 어떤 점이 급한지 알려 주시면, 제가 순서를 다시 보고 회신하겠습니다.',
        }
      : {
          spicy: '이번 건은 맡지 않겠습니다. 선행 일정이 확정되어 있습니다. 우선순위를 바꾸시려면 어떤 일정을 미룰지 먼저 정해 주십시오.',
          mild: '말씀 주신 건은 이번에는 맡기 어려울 것 같습니다. 지금 진행 중인 일정이 먼저 잡혀 있어서요. 다른 일정과의 우선순위를 정해 주시면 그에 맞춰 다시 조정해 보겠습니다.',
          plain: '이번 요청은 수용이 어렵습니다. 선행 일정이 확정되어 있어 추가 과업을 받기 어렵습니다. 우선순위 조정이 필요하면 어떤 일정을 미룰지 알려 주시면 그 기준으로 다시 조정하겠습니다.',
        };

  const defense = {
    '칼차단': spicy ? blockOff.spicy : mild ? blockOff.mild : blockOff.plain,
    '시간벌기': spicy
      ? '지금 상태로는 판단할 수 없습니다. 범위와 기한을 먼저 알려 주십시오. 기준이 오면 소요 일정을 회신하겠습니다.'
      : mild
        ? '요청 주신 내용 확인했습니다. 정확히 보려면 범위를 조금만 좁혀 주시면 좋겠습니다. 확인이 필요한 항목과 희망 기한을 알려 주시면, 가능한 일정으로 회신드리겠습니다.'
        : '요청 확인했습니다. 검토 범위와 기한을 먼저 확정하고 싶습니다. 확인이 필요한 항목과 마감 시각을 알려 주시면 소요 일정을 산정해 회신하겠습니다.',
    '공넘기기': spicy
      ? `${focus} 정리 전에는 착수하지 않습니다. ${focusEul} 확정해 문서로 주십시오. 받는 시점부터 일정을 잡겠습니다.`
      : mild
        ? `말씀 주신 방향은 이해했습니다. 다만 저희가 착수하려면 ${focus}부터 먼저 정리되어야 할 것 같아요. 해당 부분 정리해서 공유해 주시면 바로 이어받아 진행할게요.`
        : `요청 확인했습니다. 다만 ${focusI} 아직 정리되지 않아 저희 쪽에서 바로 착수하기는 어렵습니다. ${focusEul} 먼저 정리해 공유해 주시면 수령 시점 기준으로 일정을 산정해 회신하겠습니다.`,
    '관계보존': spicy
      ? '진행하겠습니다. 범위는 핵심 지표로 한정합니다. 나머지는 다음 차수로 넘기겠습니다.'
      : mild
        ? '네, 확인하겠습니다. 다만 일정이 겹쳐 있어 이번에는 핵심 항목 위주로 먼저 보고 공유드려도 괜찮을까요? 나머지는 이어서 정리해 드리겠습니다.'
        : '확인하겠습니다. 현재 일정상 핵심 항목을 우선 확인해 공유드리고, 나머지 항목은 이어서 정리해 전달하겠습니다.',
  };

  // 답장에 상대 이름을 붙이지 않는다.
  //
  // 예전에는 {{PERSON_1}} 이 있으면 "{{PERSON_1}}님, " 으로 답장을 열었다.
  // 그 코드는 PERSON_1 을 "상대(=발신자) 이름"으로 가정했는데, 틀린 가정이었다.
  // **발신자는 자기 이름을 자기 메시지에 쓰지 않는다.** 받은 메시지에 등장하는
  // 사람 이름은 (a) 호칭 대상 = 사용자 본인이거나 (b) 제3자다. 한국 직장
  // 메시지는 호칭으로 시작하는 게 기본이라 실제로는 대부분 (a)였고, 그래서
  // "박지훈님 주말에 미안한데…" 를 넣으면 답장이 "박지훈님, …" 으로 시작해
  // **사용자가 자기 자신에게 답장을 쓰는 꼴**이 됐다. 제품의 핵심 산출물이
  // 틀리는 버그라 호칭을 아예 뺀다 — 발신자 이름은 입력 어디에도 없으므로
  // 지어낼 수도 없고, 한국어 비즈니스 답장은 호칭 없이 시작해도 자연스럽다.
  // 속사정이 있으면 거절·지연의 근거로 한 문장 앞세운다. 목적이 '관계보존'
  // (수용하는 쪽)일 때는 거절 근거가 필요 없어 붙이지 않는다.
  const grounds = ctx.goal === '관계보존' ? '' : groundsFor(ctx);
  const first = tone.greet + withGrounds(defense[ctx.goal] || defense['관계보존'], grounds) + tone.close;

  const agenda = spicy
    ? `진행 전에 네 가지를 확정해 주십시오. (1) 최종 산출물, (2) 확인 범위, (3) 마감 시각, (4) 담당 주체. 정해지면 일정을 회신하겠습니다.`
    : mild
      ? `요청 주신 건, ${focusI} 아직 안 정해진 것 같아서 몇 가지만 확인하면 좋을 것 같습니다. (1) 최종 산출물이 무엇인지, (2) 어디까지 보면 되는지, (3) 언제까지 필요한지, (4) 이 건의 담당은 어느 쪽인지 알려 주시면, 그 기준으로 바로 진행하겠습니다.`
      : `${focusI} 명확하지 않아 진행 전 네 가지만 확정하고 싶습니다. (1) 최종 산출물, (2) 확인 범위, (3) 마감 시각, (4) 담당 주체. 위 항목이 정해지면 그 기준으로 일정을 회신하겠습니다.`;

  const laundered = spicy
    ? `${focusI} 빠진 채로 요청이 왔습니다. 이대로 진행하면 다시 작업해야 하고 그 시간은 저희가 씁니다. ${focusEul} 먼저 정해 주십시오.`
    : mild
      ? `이번 요청, ${focusI} 아직 정해지지 않아서 저도 어디서부터 시작해야 할지 조금 막막했어요. 편하실 때 ${focus}만 살짝 알려주시면 그 안에서 최대한 맞춰서 진행해볼게요.`
      : `이번 요청은 ${focusI} 정해지지 않은 채로 왔습니다. 이대로 진행하면 나중에 다시 손봐야 할 가능성이 커서, 서로 시간을 아끼는 차원에서 ${focus}부터 여쭤봅니다. 알려주시면 그 안에서 정확히 처리하겠습니다.`;

  // 3번은 "나에게 생기는 부담"을 말하는 자리라, 속사정이 있으면 그게 왜
  // 부담인지가 여기 들어가는 게 맞다. 1번과 다른 문장을 쓴다.
  const burden = ctx.hiddenContext
    ? (urgency === '주말 침범'
        ? ' 이번 주말은 이미 개인 일정이 잡혀 있어, 그 일정을 취소해야 가능한 요청입니다.'
        : ' 지금 일정이 이미 차 있어, 이 건을 받으면 다른 약속을 미뤄야 합니다.')
    : '';

  return [
    { label: '목적 맞춤형 정밀 방어', text: first },
    { label: '선제적 아젠다 요구', text: agenda },
    { label: '속마음 분노 세탁 버전', text: laundered + burden },
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
  // 정상 업무 신호가 뚜렷하면 거절 비용이 낮다고 본다.
  // 여기서도 클리셰 유무는 보지 않는다 — 정중하게 쓴 정상 요청이 완곡어
  // 때문에 거절 비용 4로 남으면, 같은 요청을 건조하게 쓴 경우(2)와 점수가
  // 갈린다. 판단 근거는 urgency/ambiguity 판정값과 알맹이 유무다.
  if (urgencyType === '없음' && ambiguityType === '없음' && (signals.hasNumbers || signals.hasDeadline)) {
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
