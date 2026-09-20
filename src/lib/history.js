/**
 * 나의 방어 기록 — 실행 결과를 이 브라우저에만 남긴다.
 *
 * "오늘 내가 무슨 얘기 들었는지 알아?" 하고 털어놓고 싶을 때, 또는 상황·관계상
 * 반발 없이 그대로 받아들여야 할 때도 "이게 실제로 몇 번이나 있었는지, 얼마나
 * 위험한 신호였는지" 를 스스로 확인할 수 있게 남겨두는 기록이다.
 *
 * 저장하는 건 목록에 쓸 카테고리(직군·빌런 유형·방어 모드)와 점수, 그리고
 * **결과 화면을 되살리는 데 필요한 스냅샷**이다. 기록을 눌렀을 때 점수만
 * 다시 보여 주면 "그때 뭐라고 답하기로 했더라"에 답하지 못한다.
 *
 * 스냅샷에도 **원문은 들어가지 않는다.** 애초에 이 모듈이 원문을 받은 적이
 * 없다(render 가 넘기지 않는다). 담기는 건 이미 마스킹된 해석(subtext)·규칙이
 * 뽑은 신호·생성된 답장뿐이라, 화면의 "원문·실명은 남기지 않습니다"는 그대로
 * 사실이다. 되살린 화면에서 입력칸이 비어 있는 것도 같은 이유다.
 *
 * 서버로 전송되지 않고, 계정과도 무관하다(로그인이 없다) — 브라우저를 바꾸거나
 * 데이터를 지우면 사라진다.
 */
import { villainType, defenseModeLabel } from './receipt.js';

export const HISTORY_KEY = 'ofw_history_v1';
export const MAX_ENTRIES = 200;

/**
 * 스냅샷을 들고 있을 최근 기록 수.
 *
 * 통계(총 건수·평균·자주 만난 유형)는 200건 전부로 내야 하지만, 스냅샷까지
 * 200개를 들고 있으면 항목당 1~2KB 라 수백 KB 가 된다. localStorage 가 꽉
 * 차면 새 기록 저장이 조용히 실패하고(아래 addEntry 의 catch), 그때 잃는 건
 * 오래된 스냅샷이 아니라 **방금 만든 기록**이다. 오래된 쪽부터 스냅샷을
 * 떼어내 그 상황을 막는다 — 떼어낸 기록도 목록과 통계에는 그대로 남는다.
 */
export const MAX_SNAPSHOTS = 30;

function safeLocalStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * xray/risk/context 스냅샷에서 저장할 값만 뽑는다 — 원문 필드는 아예 읽지 않는다.
 *
 * 목록용 요약값은 평평하게 두고(정렬·통계가 바로 읽는다), 결과 화면을 되살릴
 * 값은 snapshot 아래로 모은다. replies 는 **마스킹된 상태 그대로** 담는다.
 * 토큰 맵은 세션 안에만 있어서 되살릴 때 복호화가 안 되는데, 그렇다고 저장
 * 시점에 실명을 되돌려 넣으면 이 모듈이 실명을 갖게 된다. 남은 토큰은 화면에서
 * 중립 표기로 바꿔 보여 준다(main.js showText).
 */
export function entryFromResult(xray, risk, context, extra = {}, now = new Date()) {
  return {
    ts: now.getTime(),
    score: risk?.score ?? 0,
    level: risk?.level || 'green',
    scoreLabel: risk?.label || '',
    villain: villainType(xray, context),
    defenseMode: defenseModeLabel(context?.goal, context?.tone),
    job: context?.job || '-',
    counterpart: context?.counterpart || '-',
    snapshot: { xray, risk, context, replies: extra.replies || [], meta: { mode: extra.mode || 'mock' } },
  };
}

/** 오래된 기록에서 스냅샷만 떼어낸다 — 목록·통계에 쓰는 값은 건드리지 않는다. */
function stripSnapshot(entry) {
  if (!entry?.snapshot) return entry;
  const { snapshot, ...rest } = entry;
  return rest;
}

export function getHistory(storage = safeLocalStorage()) {
  if (!storage) return [];
  try {
    const raw = JSON.parse(storage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

/** 최신이 앞에 오도록 추가하고, MAX_ENTRIES 를 넘으면 오래된 것부터 버린다. */
export function addEntry(entry, storage = safeLocalStorage()) {
  const list = [entry, ...getHistory(storage)]
    .slice(0, MAX_ENTRIES)
    .map((e, i) => (i < MAX_SNAPSHOTS ? e : stripSnapshot(e)));
  if (storage) {
    try {
      storage.setItem(HISTORY_KEY, JSON.stringify(list));
    } catch {
      // 저장 공간이 꽉 찼거나 프라이빗 브라우징이어도 기록 실패가 분석 자체를
      // 막으면 안 된다 — 조용히 무시한다.
    }
  }
  return list;
}

/**
 * 고른 기록만 지운다.
 *
 * 전체 삭제밖에 없으면, 한 건이 거슬려도 전부 버리거나 전부 안고 가는 수밖에
 * 없다. 기록의 값어치가 "쌓여서 패턴이 되는 것"인데 전부 버리게 만들면 그
 * 값어치를 같이 버린다.
 *
 * 인덱스로 받는 이유: 엔트리에는 고유 id 가 없고 ts 는 같은 밀리초에 두 건이
 * 들어오면 겹칠 수 있다. 화면은 매번 getHistory() 로 다시 그리므로 그 한 번의
 * 렌더 안에서는 인덱스가 곧 그 줄이다.
 */
export function removeEntries(indexes, storage = safeLocalStorage()) {
  const drop = new Set(indexes);
  const list = getHistory(storage).filter((_, i) => !drop.has(i));
  if (storage) {
    try {
      storage.setItem(HISTORY_KEY, JSON.stringify(list));
    } catch {
      // 저장 실패가 화면을 막지 않게 한다 — 남은 목록은 그대로 돌려준다.
    }
  }
  return list;
}

export function clearHistory(storage = safeLocalStorage()) {
  if (!storage) return;
  try {
    storage.removeItem(HISTORY_KEY);
  } catch {
    // 무시
  }
}

/** 목록 화면 상단에 보여줄 요약 통계. */
export function summarize(history) {
  if (!history.length) return { count: 0, avgScore: 0, topVillain: null };
  const count = history.length;
  const avgScore = Math.round(history.reduce((sum, e) => sum + (e.score || 0), 0) / count);
  const counts = new Map();
  for (const e of history) counts.set(e.villain, (counts.get(e.villain) || 0) + 1);
  const [topVillain] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || [null];
  return { count, avgScore, topVillain };
}
