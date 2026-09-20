/**
 * 결과 화면에서 사용자가 실제로 쓸 수 있는 것만 남긴다.
 *
 * 같은 약속을 여러 곳에서 되풀이하거나, 우리 쪽 사정(모델 연동 여부·내부 필드
 * 이름)을 본문에 적으면 읽어야 할 것만 늘어난다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scrubSchemaLeak, isUsableReply } from '../src/lib/normalize.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const mainJs = readFileSync(join(root, 'src/main.js'), 'utf8');

/**
 * 모델이 우리 JSON 키를 문장 속에 흘린 적이 있다.
 *   "maskedText는 담당자에게 맡기는 내용이지만, 사용자는 수용 여부를…"
 * 프롬프트로도 막지만 프롬프트는 부탁이고 이건 보장이다.
 */
test('내부 필드 이름이 화면 문장으로 새지 않는다', () => {
  const leaked = 'maskedText는 담당자에게 맡기는 내용이지만, 사용자는 수용 여부를 명확히 하고 싶어한다.';
  const clean = scrubSchemaLeak(leaked);
  assert.ok(!clean.includes('maskedText'), '필드 이름이 그대로 남았다');
  assert.match(clean, /^받은 메시지는/, '사람이 쓰는 말로 바뀌지 않았다');
  for (const key of ['hiddenContext', 'subtext', 'powerAsymmetry', 'riskScore']) {
    assert.ok(!scrubSchemaLeak(`${key} 값이 높습니다`).includes(key), `${key} 가 남는다`);
  }
});

/**
 * 모델이 지시문을 글자 그대로 따라가다 뼈대만 남긴 실제 출력들.
 * 형식은 맞지만 그대로 보낼 수 없는 문장이라, 없는 것만 못하다.
 */
test('보낼 수 없는 답장은 걸러낸다', () => {
  const broken = [
    '1. 산출물 범위는? 2. 확인 포인트는? 3. 마감 시각은? 4. 담당자는? 하겠습니다.',
    '이미 잡힌 일정 때문에 이 요청이 부담스럽습니다. 요구합니다.',
    '이번 건은 수용이 어렵습니다. 기존 일정에 맞춰 진행하겠습니다.',
  ];
  for (const t of broken) assert.equal(isUsableReply(t), false, `걸러지지 않았다: ${t}`);
});

test('멀쩡한 답장은 통과시킨다', () => {
  assert.equal(
    isUsableReply('주말에는 대응이 어렵습니다. 조정이 어려운 선약이 이미 잡혀 있습니다. 월요일 오전 업무 시작 직후 최우선으로 확인하겠습니다.'),
    true,
  );
});

test('같은 약속을 푸터에서 되풀이하지 않는다', () => {
  // 입력칸 배지·진입 스토리·배지 설명에서 이미 세 번 말한다. 정작 필요한
  // 순간에 있는 건 배지이고, 푸터는 아무도 그 시점에 보지 않는다.
  // 주석은 왜 뺐는지 설명하며 그 문장을 인용하므로 걷어내고 본다.
  const footer = html
    .slice(html.indexOf('<footer'), html.indexOf('</footer>'))
    .replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(!/원문은 서버에 저장되지 않습니다/.test(footer), '푸터에 같은 약속이 남아 있다');
  assert.match(html, /전송 전 자동 가림/, '정작 필요한 자리의 배지가 사라졌다');
});

test('이직 자리는 경계·심각에서만 꺼낸다', () => {
  // 정상 범위인 메시지 하나에 이직을 권하면 부추기는 쪽으로 읽힌다.
  const fn = mainJs.slice(mainJs.indexOf('function renderCare'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /el\.careJobs\.hidden = risk\.score <= 60/, '항상 보이거나 조건이 사라졌다');
  assert.match(body, /el\.careJobs\.open = false/, '펼친 채로 남아 답장을 밀어낸다');
});

test('이직 영역은 상담 창구와 따로 선다', () => {
  assert.match(html, /id="care-jobs"/, '이직 영역이 없다');
  assert.ok(html.indexOf('id="care-links"') < html.indexOf('id="care-jobs"'), '상담보다 위에 있다');
  // 링크는 내 연차·직군에 맞춰 나간다.
  assert.match(mainJs, /el\.careWanted\.href = wantedUrl\(context\)/, '조건이 반영되지 않는다');
});

/* ── 내부 용어를 화면에서 몰아낸다 ─────────────────────────────
 * 제보: "토큰 맵 / 어떤 토큰이 누구인지라는 표현은 유저가 이해할 수 없다."
 * 맞는 지적이다. "토큰"은 우리가 마스킹을 구현한 방식의 이름이지,
 * 화면 앞의 사람이 알아야 할 것이 아니다. 그 사람이 궁금한 것은 하나다 —
 * 가린 이름이 어디로 가는가.
 * ──────────────────────────────────────────────────────────── */
test('화면 문구에 "토큰"이라는 내부 용어가 없다', () => {
  // 주석은 코드를 읽는 사람을 위한 것이라 검사 대상이 아니다.
  const visible = html.replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(!visible.includes('토큰 맵'), '"토큰 맵"이 화면 문구에 남아 있다');
  assert.ok(!/토큰이 누구인지/.test(visible), '"어떤 토큰이 누구인지"가 화면 문구에 남아 있다');
});

test('마스킹 안내는 "가린 것이 어디로 가는가"를 사람 말로 답한다', () => {
  const note = html.match(/<p class="mask-note">([\s\S]*?)<\/p>/)?.[1] ?? '';
  assert.ok(note, 'mask-note 문구를 찾지 못했다');
  assert.ok(/브라우저/.test(note), '어디에 남는지가 없다');
  assert.ok(/저장/.test(note) && /보내/.test(note), '전송·저장하지 않는다는 약속이 없다');
});

test('피드백 팝업 문구 — 이메일 칸과 수신 동의는 무엇을 하는지 문장으로 말한다', () => {
  // placeholder 로 두면 390px 폭에서 잘린다 — 화면에 남는 문장으로 둔다.
  assert.ok(
    html.includes('>답변이나 업데이트 소식을 받고 싶으시면 이메일 주소를 남겨주세요.</p>'),
    '이메일 칸 안내 문장이 화면에 없다',
  );
  assert.ok(!/placeholder="이메일 주소 \(/.test(html), '괄호 설명 placeholder 가 남아 있다');
  assert.ok(
    html.includes('업데이트 소식을 받아볼래요.') && html.includes('(소식 전달 외 목적으로 사용하지 않습니다.)'),
    '수신 동의 문구가 "무엇에 쓰지 않는지"를 말하지 않는다',
  );
});
