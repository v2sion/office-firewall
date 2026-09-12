# OFFICE FIREWALL

> 직장에서 받은 애매한 메시지를 넣으면, AI가 그 안의 실제 요구와 빠진 알맹이를 진단하고,
> 원하는 톤으로 답장을 만들어 주는 도구.

원티드 AI CHAMPIONSHIP 2026 · 팀 **90od**

---

## 설계 원칙

| # | 원칙 | 구현 위치 |
|---|---|---|
| 1 | **AI는 추출, 판정은 규칙** — AI는 점수를 만들지 않는다 | `src/lib/score.js` 가 점수의 단일 출처. `api/_lib/prompt.js` 는 `riskScore` 생성을 금지한다 |
| 2 | **원문을 AI에 먼저 보내지 않는다** — 브라우저 선-마스킹 | `src/lib/mask.js`. 토큰 맵은 `src/main.js` 의 지역 변수에만 존재하며 저장·전송하지 않는다 |
| 3 | **진단 먼저, 답장 나중** — X-Ray가 위, 답장이 아래 | `index.html` 결과 패널 순서 |

서버는 마스킹되지 않은 전화번호·이메일이 섞인 요청을 `RAW_PII_DETECTED` 로 거부한다.
로그에는 본문을 남기지 않고 길이·지연시간·토큰 사용량·점수만 기록한다.

---

## 실행

```bash
npm install

# 프론트만 (서버리스 함수 없음 → 로컬 룰엔진 폴백으로 동작)
npm run dev

# 프론트 + /api/analyze  (권장: 배포와 같은 환경)
npx vercel dev

# vercel CLI 없이 풀스택 확인
npm run build && npm run serve:local   # http://localhost:5180

# 테스트 (마스킹 round-trip · 룰엔진 · 골든 5종)
npm test
```

### 환경 변수

`.env.example` 참고. **`ANTHROPIC_API_KEY` 가 없으면 자동으로 MOCK 모드**로 동작한다
(규칙 기반 근사치 응답). 키 없이도 마스킹 → 룰엔진 → 렌더링 전 구간을 검증할 수 있고,
시연 중 모델 호출이 실패해도 화면이 비지 않는 폴백이 된다.

| 변수 | 설명 |
|---|---|
| `ANTHROPIC_API_KEY` | 비어 있으면 MOCK 모드 |
| `OFW_MODEL` | 기본 `claude-opus-5` |
| `OFW_FORCE_MOCK` | `1` 이면 키가 있어도 LLM 을 호출하지 않는다 |

---

## 구조

```
api/
  analyze.js            POST /api/analyze (HTTP 어댑터)
  _lib/analyze-core.js  검증 · 모델 호출 · 응답 조립
  _lib/prompt.js        시스템 프롬프트 / 톤·목적 분기
src/lib/
  mask.js               4단계 선-마스킹 · 역치환 · 원시 PII 탐지
  cliche.js             클리셰 사전 · 수치/기한/의사결정 회피 신호 추출
  score.js              Social Risk Index (규칙) · 알맹이 결여율
  normalize.js          AI 출력 정규화 (서버·클라이언트 공용)
  mock.js               키 없을 때의 규칙 기반 응답 + 시연 폴백
src/data/golden.json    골든 5종
scripts/dev-server.mjs  vercel CLI 없이 쓰는 로컬 풀스택 서버
```

---

## 데이터 계약 — `POST /api/analyze`

**Request**

```json
{
  "maskedText": "{{PERSON_1}}님 주말에 미안한데, ...",
  "context": {
    "job": "기획·PM/PO", "level": "주니어", "counterpart": "직속상사",
    "goal": "칼차단", "tone": "보통맛", "hiddenContext": "가족 행사로 외지에 있음"
  }
}
```

**Response**

```json
{
  "xray": {
    "subtext": "...", "powerAsymmetry": 4,
    "urgencyType": "주말 침범", "ambiguityType": "범위 불명",
    "aiSlopScore": 0, "clicheHits": ["시간 날 때", "가볍게", "급한 건 아니"],
    "sentenceCount": 3, "hasNumbers": false, "hasDeadline": false, "avoidsDecision": true,
    "aiReported": { "...": "AI가 보고한 원본 (검증용)" }
  },
  "replies": [{ "label": "목적 맞춤형 정밀 방어", "text": "{{PERSON_1}}님, ..." }],
  "risk": { "score": 92, "level": "red", "label": "즉각 승인 금지", "header": "🚨 고위험 독박 경보", "breakdown": [] },
  "usage": { "input_tokens": 0, "output_tokens": 0 },
  "meta": { "mode": "mock", "model": "mock", "latencyMs": 3 }
}
```

- **AI는 `riskScore` 를 반환하지 않는다.** `risk` 는 서버의 룰엔진이 계산한 값이고,
  클라이언트도 같은 모듈(`src/lib/score.js`)로 재현할 수 있다.
- 클리셰·수치·기한·의사결정 회피는 **규칙 계산값을 채택**하고, AI가 보고한 값은
  `xray.aiReported` 에 남겨 대조할 수 있게 둔다. AI가 지어낸 클리셰는 원문 대조로 걸러진다.
- 답장 텍스트에는 마스킹 토큰이 그대로 들어 있고, 브라우저가 렌더링 직전에 역치환한다.

---

## 룰엔진

```
Social Risk Index = 권력 비대칭(0~40) + 시간적 긴급도(0~20) + 요구 모호성(0~20) + 알맹이 결여율(0~20)
  권력 비대칭 = powerAsymmetry(1~5) × 8
  시간적 긴급도 = urgencyType ≠ "없음" → 20
  요구 모호성 = ambiguityType ≠ "없음" → 20
  알맹이 결여율 = (클리셰 밀도 + 수치·기한 부재 + 의사결정 회피) / 3 × 20
```

**정상 업무 가드**: 긴급도·모호성이 모두 "없음" 이고 결여율이 0이면 점수는 Green 상한(20)을
넘지 않는다. 과잉 방어는 제품 신뢰를 깎기 때문이다 (골든 ⑤ 대조군 검증 조건).

한글 사전 매칭은 NFD(자모 분해) 기준이다. `"아니"` 는 `"아닙니다"` 의 부분문자열이 아니라서
음절 그대로 비교하면 사전이 헛돈다.

---

## 골든 5종 (Sprint 0 Exit Criteria)

MOCK 모드 실측 (`npm test`):

| # | 케이스 | 점수 | 등급 | 긴급도 | 모호성 | AI 슬롭 |
|---|---|---|---|---|---|---|
| ① | 주말 침범 | 92 | red | 주말 침범 | 범위 불명 | 0% |
| ② | AI 슬롭 | 56 | amber | 없음 | 범위 불명 | 100% |
| ③ | R&R 핑퐁 | 57 | amber | 없음 | R&R 미지정 | 0% |
| ④ | 클라이언트 갑질 | 80 | orange | 당일 마감 | 범위 불명 | 0% |
| ⑤ | **정상 업무 (대조군)** | **16** | **green** | 없음 | 없음 | 0% |

브라우저 실측: 프리셋 클릭 → 결과 렌더링까지 **459ms** (MOCK 모드).
LIVE 모드 실측치는 API 키 투입 후 갱신한다.
