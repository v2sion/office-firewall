/**
 * 다 고른 영역 접기.
 *
 * 입력 폼이 세로로 길다. 칩 그리드만 다섯 벌(직군 9 · 연차 5 · 관계 9 ·
 * 대응 방향 4 · 말투 3)이라, 다 고르고 나서도 그 자리가 그대로 남아 있으면
 * "내가 지금 뭘 하고 있는 거지"가 된다.
 *
 * 규칙은 하나뿐이다. **접힘 ⟺ 그 블록을 다 골랐다.**
 *
 * 처음에는 "변경"을 누르면 펼친 채로 고정했었다(pinned). 그러면 세 번째
 * 상태가 생긴다 — 다 골랐는데 펼쳐져 있는 블록. 화면만 보고는 아직 고르는
 * 중인지 이미 정한 건지 구분이 안 되고, 실행 직전에 전체를 훑는 경험도
 * 깨진다. 지금은 **"변경"이 그 블록의 선택을 지운다.** 지우면 미완성이라
 * 펼쳐지고, 다시 고르면 다시 접힌다. 상태가 둘뿐이라 화면이 곧 진행 상황이다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mainJs = readFileSync(join(root, 'src/main.js'), 'utf8');
const css = readFileSync(join(root, 'src/styles.css'), 'utf8');
const html = readFileSync(join(root, 'index.html'), 'utf8');

const bodyOf = (name) => {
  const at = mainJs.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} 을 찾지 못했다`);
  return mainJs.slice(at, mainJs.indexOf('\n}', at));
};

test('접힘 상태는 둘뿐이다 — 펼친 채 고정하는 세 번째 상태가 없다', () => {
  // 주석은 왜 고정을 없앴는지 설명하며 그 이름을 인용하므로 걷어내고 본다.
  const code = mainJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/pinned/.test(code), '고정(pinned) 상태가 되살아났다');
});

test('"변경"은 그 블록의 선택을 지운다 (펼치기만 하지 않는다)', () => {
  const body = bodyOf('resetBlock');
  assert.match(body, /state\[field\] = ''/, '선택값을 지우지 않는다');
  assert.match(body, /aria-checked', 'false'/, '칩의 선택 표시를 떼지 않는다');
  assert.match(mainJs, /summary\.addEventListener\('click', \(\) => resetBlock\(key\)\)/, '"변경"이 초기화로 이어지지 않는다');
});

test('접기 대상은 명시한 세 블록뿐이다', () => {
  const keys = [...html.matchAll(/data-fold="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(keys, ['me', 'them', 'reply']);
});

test('쓰는 값이 든 블록은 접지 않는다 (메시지·속사정이 숨으면 안 된다)', () => {
  // data-fold 가 붙은 블록 안에 textarea·input 이 있으면 접힐 때 함께 숨는다.
  for (const m of html.matchAll(/<div class="block" data-fold="\w+">([\s\S]*?)\n        <\/div>/g)) {
    assert.ok(!/<textarea|<input/.test(m[1]), '접히는 블록에 입력칸이 들어 있다');
  }
});

test('관계와 상황 카드가 한 블록이다', () => {
  const at = html.indexOf('data-fold="them"');
  const block = html.slice(at, html.indexOf('<!-- 받은 메시지 -->', at));
  assert.match(block, /data-field="counterpart"/, '관계가 없다');
  assert.match(block, /id="preset-grid"/, '상황 카드가 없다');
});

test('대응 방향과 말투 세기가 한 블록이다', () => {
  const at = html.indexOf('data-fold="reply"');
  const block = html.slice(at, html.indexOf('나의 숨은 속사정', at));
  assert.match(block, /data-field="goal"/, '대응 방향이 없다');
  assert.match(block, /data-field="tone"/, '말투 세기가 없다');
});

test('선택 항목(숨은 속사정)은 고르는 것들 아래에 있다', () => {
  // 맨 위에 있으면 먼저 채워야 하는 칸으로 읽힌다.
  assert.ok(html.indexOf('data-field="tone"') < html.indexOf('나의 숨은 속사정'), '속사정이 말투 세기보다 위에 있다');
});

/**
 * 2구역은 관계와 상황을 고른 **그 자리에서** 접는다.
 *
 * 한때 메시지가 채워질 때까지 기다렸다 접었는데, 카드를 고르고 한참 지난 뒤에
 * 화면이 접혀서 어색했다. 관계와 상황을 다 골랐으면 이 구역에서 정할 것은
 * 끝난 것이다.
 *
 * 대신 조건이 하나 붙는다. **"그대로 적용하기" 버튼이 이 블록 밖에 있어야
 * 한다.** 안에 있으면 카드를 누른 순간 버튼도 같이 접혀 누를 기회가 없다.
 * 둘은 한 몸이라 따로 고쳐서는 안 된다.
 */
test('2구역은 카드를 고른 그 자리에서 접힌다', () => {
  const at = mainJs.indexOf('them: {');
  const spec = mainJs.slice(at, mainJs.indexOf('},', at));
  assert.match(spec, /done: \(\) => Boolean\(activePreset\)/, '카드 선택으로 접지 않는다');
  // 카드를 안 고르고 직접 쓰는 사람도 같은 시점에 접혀야 한다.
  assert.match(spec, /el\.message\.value\.trim\(\)\.length > 0/, '직접 입력하면 영영 안 접힌다');
  assert.match(bodyOf('applyPreset'), /syncFolding\(\)/, '카드를 골라도 접힘이 갱신되지 않는다');
});

test('"그대로 적용하기"는 접히는 블록 밖에 있다', () => {
  const at = html.indexOf('data-fold="them"');
  const block = html.slice(at, html.indexOf('<!-- 받은 메시지 -->', at));
  const foldEnd = block.indexOf('\n        </div>');
  assert.ok(foldEnd > 0, '블록의 끝을 찾지 못했다');
  assert.ok(
    !block.slice(0, foldEnd).includes('id="preset-run"'),
    '적용 버튼이 블록 안에 있다 — 카드를 누르는 순간 같이 접혀 누를 수 없다',
  );
  assert.ok(block.includes('id="preset-run"'), '적용 버튼이 2구역에서 사라졌다');
});

test('메시지를 고치면 접힘 여부도 따라간다', () => {
  assert.match(bodyOf('onInput'), /syncFolding\(\)/, '입력 변화가 접힘에 반영되지 않는다');
});

test('접힌 줄은 무엇을 골랐는지 보여주고 누를 수 있다', () => {
  const body = bodyOf('syncFolding');
  assert.match(body, /block-folded-value/, '고른 값을 보여주지 않는다');
  assert.match(body, /aria-label/, '스크린리더가 읽을 설명이 없다');
});

test('접힌 블록은 요약 줄만 남긴다', () => {
  assert.match(css, /\.block\.is-folded > :not\(\.block-folded\) \{ display: none; \}/, '접어도 내용이 남는다');
});

test('접힌 줄의 값이 길어도 레이아웃을 밀지 않는다', () => {
  const at = css.indexOf('.block-folded-value');
  const rule = css.slice(at, css.indexOf('}', at));
  assert.match(rule, /text-overflow: ellipsis/);
  assert.match(rule, /white-space: nowrap/);
});

/* ── 실행 버튼 잠금 ───────────────────────────────────────────
 * 예전에는 버튼이 늘 파랗게 활성이었고, 누르면 그제야 "상대방과의 관계를
 * 먼저 골라 주세요"가 떴다. 누를 수 있게 생긴 버튼을 눌렀더니 혼나는
 * 구조라, 무엇이 비었는지도 누른 뒤에야 알 수 있었다.
 * ──────────────────────────────────────────────────────── */

test('실행 버튼의 disabled 를 건드리는 곳은 한 군데뿐이다', () => {
  // 바쁨·쿨다운·필수 입력이 서로 다른 곳에서 버튼을 건드리면, 쿨다운이
  // 끝나는 순간 필수 입력이 비었는데도 버튼이 살아나는 식으로 어긋난다.
  const hits = mainJs.match(/el\.run\.disabled\s*=/g) || [];
  assert.equal(hits.length, 1, `el.run.disabled 를 쓰는 곳이 ${hits.length}군데다 — syncRunButton 하나로 모아야 한다`);
  assert.match(mainJs, /function syncRunButton\(\)/);
});

test('필수는 답장을 바꾸는 네 가지다 — 직군·연차는 아니다', () => {
  // 처음에는 "점수를 움직이는가"로 갈라 관계와 메시지만 필수로 뒀다.
  // 틀린 기준이었다. 이 버튼은 "분석하고 **답장 만들기**"이고, 대응 방향과
  // 말투 세기는 답장을 통째로 바꾼다. 안 고르면 '관계보존'(= 수용)이
  // 조용히 적용돼, 거절하러 온 사람에게 수용 답장이 나갔다.
  const fn = mainJs.slice(mainJs.indexOf('function requiredMissing()'), mainJs.indexOf('function syncRunButton()'));
  for (const required of ['state.counterpart', '!text', 'state.goal', 'state.tone'])
    assert.ok(fn.includes(required), `${required} 이 필수에서 빠져 있다`);
  // 직군·연차는 판정에도 답장에도 들어가지 않고 prefs 에 저장된다.
  for (const optional of ['state.job', 'state.level'])
    assert.ok(!fn.includes(optional), `${optional} 이 필수로 들어가 있다`);
});

test('안 고른 대응 방향을 기본값으로 메우지 않는다', () => {
  // 규칙 엔진·LIVE 양쪽에 '관계보존' 기본값이 살아 있다(프로그램 경로 방어용).
  // 그 기본값이 사용자에게 보이는 경로로 새지 않게 하는 것이 이 잠금의 목적이다.
  const guard = mainJs.slice(mainJs.indexOf('async function run()'), mainJs.indexOf('async function postAnalyze('));
  assert.match(guard, /const missing = requiredMissing\(\)/, 'run() 이 같은 필수 목록을 쓰지 않는다');
  assert.match(guard, /if \(missing\.length\)/);
});

test('무엇이 비었는지를 누르기 전에 말한다', () => {
  const fn = mainJs.slice(mainJs.indexOf('function syncRunButton()'));
  assert.match(fn, /하나만 더 채우면 실행할 수 있어요/);
  assert.match(fn, /실행하려면 \$\{missing\.length\}가지가 더 필요해요/);
});

test('단계 진행바가 실행 조건과 같은 것을 센다', () => {
  // 진행바가 100%인데 버튼이 잠겨 있으면, 둘 중 하나는 거짓말을 하는 것이다.
  const fn = mainJs.slice(mainJs.indexOf('function zoneProgress()'), mainJs.indexOf('function renderStepBars()'));
  assert.match(fn, /run: \(\(hasMessage \? 1 : 0\) \+ count\('counterpart', 'goal', 'tone'\)\) \/ 4/);
});

test('선택·입력·초기화·블록 해제가 모두 버튼 상태를 다시 맞춘다', () => {
  // 한 경로라도 빠지면 그 경로에서만 버튼이 옛 상태로 남는다.
  const calls = (mainJs.match(/syncRunButton\(\)/g) || []).length;
  assert.ok(calls >= 6, `syncRunButton 호출이 ${calls}군데뿐이다 — 입력·칩·변경·바쁨·쿨다운·초기화를 모두 덮어야 한다`);
  // 관계를 비우는 '변경'에서도 다시 잠겨야 한다.
  const reset = mainJs.slice(mainJs.indexOf('function resetBlock('), mainJs.indexOf('function syncFolding('));
  assert.match(reset, /syncRunButton\(\)/, "'변경'으로 관계를 비웠는데 버튼이 안 잠긴다");
});

test('잠긴 버튼은 회색이고 커서로도 눌리지 않음을 알린다', () => {
  assert.match(css, /\.run:disabled\s*\{[^}]*cursor:\s*not-allowed/);
  assert.match(css, /\.run:disabled\s*\{[^}]*background:\s*var\(--line\)/);
});

/* ── 접힌 뒤에도 "어떤 답장이 나올지"가 남는다 ────────────────
 * 답장 설정 블록은 마지막 칸(말투 세기)을 고르는 순간 접힌다. 그래서 그
 * 설명이 뜨자마자 같이 사라졌다 — 대응 방향을 먼저 고르는 사람이 대부분이라
 * 순서상 **말투 세기 설명은 사실상 아무도 못 봤다.**
 *
 * 접는 정책을 되돌리는 대신(완료된 칸을 펼쳐 두면 폼이 다시 길어진다)
 * 요약 줄에 한 줄 설명을 얹는다.
 * ──────────────────────────────────────────────────────── */

test('답장 설정 요약에 어떤 답장이 나올지 한 줄이 붙는다', () => {
  const spec = mainJs.slice(mainJs.indexOf('reply: { title:'), mainJs.indexOf('reply: { title:') + 200);
  assert.match(spec, /note: replyBrief/, '요약에 설명을 붙이는 note 가 없다');
  assert.match(mainJs, /class="block-folded-note"/, '설명을 그리는 자리가 없다');
});

test('목적 4 × 말투 3 = 12조합 전부 한 문장으로 이어진다', () => {
  const goal = bodyOf('replyBrief');
  assert.match(goal, /GOAL_BRIEF\[apiValue\(state\.goal\)\]/);
  assert.match(goal, /TONE_BRIEF\[apiValue\(state\.tone\)\]/);
  // 하나라도 비면 반쪽 문장이 남는다 — 둘 다 있을 때만 만든다.
  assert.match(goal, /goal && tone \?/);

  const pick = (name) => {
    const at = mainJs.indexOf(`const ${name} = {`);
    return mainJs.slice(at, mainJs.indexOf('\n};', at));
  };
  const goals = pick('GOAL_BRIEF');
  const tones = pick('TONE_BRIEF');
  for (const g of ['칼차단', '시간벌기', '공넘기기', '관계보존'])
    assert.ok(goals.includes(`'${g}'`), `GOAL_BRIEF 에 ${g} 가 없다`);
  for (const t of ['순한맛', '보통맛', '매운맛'])
    assert.ok(tones.includes(`'${t}'`), `TONE_BRIEF 에 ${t} 가 없다`);
  // 앞은 "~하고" 로 이어지고 뒤는 "~씁니다." 로 맺어야 한 문장이 된다.
  for (const line of goals.match(/'[^']*하고'/g) || []) assert.ok(line.endsWith("하고'"), line);
  for (const line of tones.match(/: '[^']*'/g) || []) assert.ok(line.endsWith("씁니다.'"), line);
});

test('설명은 스크린리더에도 읽힌다', () => {
  // 요약은 버튼 하나라, 안쪽 텍스트가 늘어나면 aria-label 도 같이 늘어야 한다.
  const fn = bodyOf('syncFolding');
  assert.match(fn, /note \? ` \$\{note\}` : ''/);
});
