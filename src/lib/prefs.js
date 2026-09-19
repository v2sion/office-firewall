/**
 * 직전 선택 기억 — 재방문 비용을 없앤다.
 *
 * 기록(history.js)은 쌓이는데 정작 폼 선택은 매번 초기화돼서, 같은 상사에게
 * 또 시달린 사람이 직군·연차·관계를 처음부터 다시 골라야 했다. 이 도구는
 * "한 번 쓰고 마는" 성격이 아니라 같은 상황이 반복될 때 다시 열게 되는
 * 물건이라, 그 반복이 그대로 비용이 된다.
 *
 * 저장 원칙은 history.js·receipt.js 와 같다 — **카테고리 선택값만** 남긴다.
 * 메시지 원문·숨은 속사정·마스킹 토큰 맵은 절대 들어오지 않는다(그것들은
 * 세션 메모리에만 존재한다). 서버로 전송되지 않고 계정과도 무관하다.
 */

export const PREFS_KEY = 'ofw_prefs_v1';

/** 기억하는 필드. 자유 입력 필드는 의도적으로 제외한다. */
export const PREF_FIELDS = ['job', 'level', 'counterpart', 'goal', 'tone'];

function safeLocalStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * 저장된 선택을 읽는다. 값이 현재 선택지 목록에 없으면(옵션이 바뀌었거나
 * 손으로 고친 경우) 그 필드는 버린다 — 없는 값이 state 에 들어가면 칩이
 * 하나도 선택되지 않은 화면이 된다.
 * @param {Record<string, string[]>} options 현재 OPTIONS
 */
export function loadPrefs(options, storage = safeLocalStorage()) {
  if (!storage) return {};
  let raw;
  try {
    raw = JSON.parse(storage.getItem(PREFS_KEY) || '{}');
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object') return {};

  const out = {};
  for (const field of PREF_FIELDS) {
    const value = raw[field];
    if (typeof value === 'string' && options[field]?.includes(value)) out[field] = value;
  }
  return out;
}

/** 현재 선택을 저장한다. 실패해도 조용히 넘어간다(프라이빗 브라우징 등). */
export function savePrefs(state, storage = safeLocalStorage()) {
  if (!storage) return;
  const data = {};
  for (const field of PREF_FIELDS) {
    if (typeof state[field] === 'string') data[field] = state[field];
  }
  try {
    storage.setItem(PREFS_KEY, JSON.stringify(data));
  } catch {
    // 저장 실패가 분석 자체를 막으면 안 된다 — history.js 와 같은 원칙.
  }
}

export function clearPrefs(storage = safeLocalStorage()) {
  if (!storage) return;
  try {
    storage.removeItem(PREFS_KEY);
  } catch {
    // 무시
  }
}
