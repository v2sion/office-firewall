/**
 * 가이드 §9 "프리셋 = API 미호출·즉시 렌더링" 을 위한 캐시 스냅샷 생성기.
 *
 * 각 프리셋의 원문을 마스킹한 뒤 buildMockAnalysis() 로 한 번 계산해
 * src/data/presets/<id>.json 에 저장한다. 이후 런타임에는 이 파일을
 * 그대로 읽어 렌더링만 하므로 네트워크·모델 호출·룰엔진 재계산이 전혀
 * 없다 — 시연 중 무엇이 죽어도 프리셋은 항상 0.1초 안에, $0 로 동작한다.
 *
 * 가이드 원문: "프리셋 JSON은 실제 API 응답을 한 번 받아서 저장하면 된다
 * (형식이 자동으로 일치한다)". GROQ_API_KEY 가 없는 지금은 buildMockAnalysis
 * (규칙 기반 근사치)의 출력을 스냅샷으로 쓴다 — 형식은 실제 API 응답과 동일하다.
 * LIVE 키가 생기면 이 스크립트에 --live 를 더해 실제 캡처로 교체할 수 있다.
 *
 * 실행: node scripts/gen-presets.mjs
 * mock.js 의 템플릿 문구를 바꿨다면 반드시 다시 실행해 캐시를 갱신해야 한다
 * (test/presets.test.js 가 캐시와 현재 mock.js 출력이 어긋나면 실패로 잡아준다).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mask } from '../src/lib/mask.js';
import { buildMockAnalysis } from '../src/lib/mock.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const golden = JSON.parse(readFileSync(join(ROOT, 'src/data/golden.json'), 'utf8'));

// UI 상황 카드 4개만 캐싱한다 (⑤ 정상 업무는 카드가 아니라 대조군 테스트용).
const PRESET_IDS = ['weekend', 'aislop', 'pingpong', 'client'];

for (const id of PRESET_IDS) {
  const g = golden.find((x) => x.id === id);
  if (!g) throw new Error(`golden.json 에 ${id} 없음`);
  const { maskedText } = mask(g.text);
  const aiOut = buildMockAnalysis(maskedText, g.context);
  const out = join(ROOT, 'src/data/presets', `${id}.json`);
  writeFileSync(out, `${JSON.stringify(aiOut, null, 2)}\n`);
  console.log(`✓ ${out}`);
}
