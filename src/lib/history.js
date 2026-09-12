/**
 * 나의 방어 기록 — 실행 결과를 이 브라우저에만 남긴다.
 *
 * "오늘 내가 무슨 얘기 들었는지 알아?" 하고 털어놓고 싶을 때, 또는 상황·관계상
 * 반발 없이 그대로 받아들여야 할 때도 "이게 실제로 몇 번이나 있었는지, 얼마나
 * 위험한 신호였는지" 를 스스로 확인할 수 있게 남겨두는 기록이다.
 *
 * 원칙은 영수증(receipt.js)과 같다: 원문·실명·탐지된 세부값은 저장하지 않는다.
 * 저장하는 건 카테고리(직군·빌런 유형·방어 모드)와 이미 계산된 점수뿐이다.
 * 서버로 전송되지 않고, 계정과도 무관하다(로그인이 없다) — 브라우저를 바꾸거나
 * 데이터를 지우면 사라진다.
 */
import { villainType, defenseModeLabel } from './receipt.js';

export const HISTORY_KEY = 'ofw_history_v1';
export const MAX_ENTRIES = 200;

function safeLocalStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** xray/risk/context 스냅샷에서 저장할 값만 뽑는다 — 원문 필드는 아예 읽지 않는다. */
export function entryFromResult(xray, risk, context, now = new Date()) {
  return {
    ts: now.getTime(),
    score: risk?.score ?? 0,
    level: risk?.level || 'green',
    scoreLabel: risk?.label || '',
    villain: villainType(xray, context),
    defenseMode: defenseModeLabel(context?.goal, context?.tone),
    job: context?.job || '—',
    counterpart: context?.counterpart || '—',
  };
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
  const list = [entry, ...getHistory(storage)].slice(0, MAX_ENTRIES);
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
