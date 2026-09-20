#!/usr/bin/env node
/**
 * 커뮤니티 사연 코퍼스를 실제 파이프라인에 태워 본다.
 *
 *   node scripts/live-corpus.mjs                      # 로컬 규칙 엔진(MOCK)
 *   node scripts/live-corpus.mjs https://<배포주소>    # 실제 LIVE (/api/analyze)
 *
 * LIVE 로 돌릴 때는 무료 티어 처리량(8,000 TPM ≈ 분당 3건)을 넘지 않도록
 * 호출 사이에 간격을 둔다. 429 가 나면 그 건만 '혼잡'으로 표시하고 넘어간다.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mask } from '../src/lib/mask.js';
import { buildResult } from '../src/lib/normalize.js';
import { buildMockAnalysis } from '../src/lib/mock.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const base = args.find((a) => a.startsWith('http')) || '';
const which = args.find((a) => !a.startsWith('http')) || 'community';
const FILES = { community: 'community-corpus.json', moel: 'moel-corpus.json' };
if (!FILES[which]) { console.error(`알 수 없는 코퍼스: ${which} (community | moel)`); process.exit(1); }
const corpus = JSON.parse(readFileSync(join(root, 'test/fixtures', FILES[which]), 'utf8'));
corpus.cases = corpus.cases.filter((c) => c.testable !== false);
const GAP_MS = base ? 21_000 : 0; // 분당 3건

const ctxFor = (c) => ({
  job: '기획·PM/PO', level: '주니어', counterpart: c.counterpart,
  goal: '시간벌기', tone: '보통맛', hiddenContext: '',
});

async function runLive(maskedText, context) {
  const res = await fetch(`${base.replace(/\/$/, '')}/api/analyze`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ maskedText, context }),
  });
  if (res.status === 429) return { busy: true };
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 160)}`);
  return res.json();
}

const rows = [];
for (const c of corpus.cases) {
  const { maskedText } = mask(c.text);
  const context = ctxFor(c);
  let result;
  try {
    result = base ? await runLive(maskedText, context) : buildResult(buildMockAnalysis(maskedText, context), maskedText);
  } catch (err) {
    rows.push({ id: c.id, err: err.message });
    continue;
  }
  if (result?.busy) { rows.push({ id: c.id, err: '429 혼잡' }); continue; }

  const [lo, hi] = c.expect.band;
  const score = result.risk.score;
  rows.push({
    id: c.id, label: c.label, score, level: result.risk.level,
    urgency: result.xray.urgencyType, ambiguity: result.xray.ambiguityType,
    justified: Boolean(result.xray.urgencyJustified),
    slop: result.xray.aiSlopScore,
    band: `${lo}~${hi}`, ok: score >= lo && score <= hi,
    urgencyOk: (!c.expect.urgency || result.xray.urgencyType === c.expect.urgency)
      && (c.expect.justified === undefined || Boolean(result.xray.urgencyJustified) === c.expect.justified),
    ambiguityOk: !c.expect.ambiguity || result.xray.ambiguityType === c.expect.ambiguity,
    replies: result.replies.map((r) => r.text),
  });
  if (GAP_MS) await new Promise((r) => setTimeout(r, GAP_MS));
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`\n코퍼스: ${which}   ·   모드: ${base ? `LIVE (${base})` : '로컬 규칙 엔진'}   ·   ${rows.length}건\n`);
console.log(pad('케이스', 22), pad('점수', 6), pad('등급', 8), pad('기대', 8), pad('긴급도', 10), pad('모호성', 10), 'slop');
console.log('-'.repeat(84));
for (const r of rows) {
  if (r.err) { console.log(pad(r.id, 22), '오류:', r.err); continue; }
  const flag = r.ok && r.urgencyOk && r.ambiguityOk ? ' ' : '⚠';
  console.log(flag, pad(r.id, 20), pad(r.score, 6), pad(r.level, 8), pad(r.band, 8),
    pad(r.urgency + (r.justified ? '(정당)' : '') + (r.urgencyOk ? '' : '✗'), 14),
    pad(r.ambiguity + (r.ambiguityOk ? '' : '✗'), 10), r.slop);
}
const bad = rows.filter((r) => r.err || !r.ok || !r.urgencyOk || !r.ambiguityOk);
console.log(`\n기대와 어긋남: ${bad.length}건${bad.length ? ' — ' + bad.map((b) => b.id).join(', ') : ''}`);

if (process.env.OFW_SHOW_REPLIES) {
  for (const r of rows) {
    if (r.err) continue;
    console.log(`\n── ${r.label} (${r.score}점) ──`);
    r.replies.forEach((t, i) => console.log(`  ${i + 1}) ${t}`));
  }
}
