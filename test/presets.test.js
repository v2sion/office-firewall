import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mask } from '../src/lib/mask.js';
import { buildMockAnalysis } from '../src/lib/mock.js';
import weekend from '../src/data/presets/weekend.json' with { type: 'json' };
import aislop from '../src/data/presets/aislop.json' with { type: 'json' };
import pingpong from '../src/data/presets/pingpong.json' with { type: 'json' };
import client from '../src/data/presets/client.json' with { type: 'json' };

const golden = JSON.parse(readFileSync(new URL('../src/data/golden.json', import.meta.url), 'utf8'));
const CACHES = { weekend, aislop, pingpong, client };

/**
 * 가이드 §9: "프리셋은 API 호출 없이 미리 만든 응답을 즉시 렌더링한다."
 * 캐시 파일(src/data/presets/*.json)은 mock.js 출력의 스냅샷이다.
 * mock.js 의 문구를 바꾸고 `node scripts/gen-presets.mjs` 를 다시 안 돌리면
 * 화면에 나오는 프리셋 결과가 조용히 낡아버린다 — 이 테스트가 그 드리프트를 잡는다.
 */
for (const id of Object.keys(CACHES)) {
  test(`프리셋 캐시 드리프트 가드 — ${id}`, () => {
    const g = golden.find((x) => x.id === id);
    assert.ok(g, `golden.json 에 ${id} 없음`);
    const { maskedText } = mask(g.text);
    const fresh = buildMockAnalysis(maskedText, g.context);
    assert.deepEqual(
      CACHES[id],
      fresh,
      `src/data/presets/${id}.json 이 mock.js 최신 출력과 다르다 — node scripts/gen-presets.mjs 로 재생성하세요.`,
    );
  });
}

test('캐시 파일에는 riskScore 가 없다 (AI/캐시는 추출만, 판정은 항상 규칙)', () => {
  for (const cache of Object.values(CACHES)) {
    assert.equal(cache.riskScore, undefined);
  }
});
