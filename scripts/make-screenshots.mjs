#!/usr/bin/env node
/**
 * 제출 폼에 올릴 스크린샷 5장(16:9) + 모바일 1장을 찍는다.
 *
 *   node scripts/make-screenshots.mjs                      # 로컬 (npm run dev 먼저)
 *   node scripts/make-screenshots.mjs https://<배포주소>    # 배포본
 *
 * **제출용은 반드시 배포본에서 찍을 것.** 로컬에는 GROQ_API_KEY 가 없어
 * 모드 배지가 "오프라인 분석"으로 나온다. 제출물에 그 배지가 박히면
 * "AI를 실제로 쓰는가"라는 질문을 스스로 만드는 셈이다.
 *
 * 필요: playwright (npx playwright install chromium)
 */
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'docs/assets/screenshots');
const BASE = process.argv[2] || 'http://localhost:5175';
mkdirSync(OUT, { recursive: true });

const { chromium } = await import('playwright').catch(() =>
  import('/opt/node22/lib/node_modules/playwright/index.js'));

const HIGH = '박지훈 팀장님 주말에 미안한데, 월요일 오전에 대표님 보고가 잡혀서요.\n시간 날 때 가볍게 한번 봐주시면 좋을 것 같아요. 급한 건 아닙니다!';
const HIDDEN = '김수진 대리한테 010-1234-5678 로 이미 확인함';

const browser = await chromium.launch();
const errs = [];

async function fresh(w = 1600, h = 900) {
  const p = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(BASE, { waitUntil: 'networkidle' });
  await p.evaluate(() => localStorage.setItem('ofw_intro_seen_v1', '1'));
  await p.reload({ waitUntil: 'networkidle' });
  return p;
}
async function fill(p) {
  await p.click('.selector[data-field="job"] .chip');
  await p.click('.selector[data-field="level"] .chip');
  await p.click('.selector[data-field="counterpart"] .chip');
  await p.fill('#message', HIGH);
  await p.fill('#hidden-context', HIDDEN);
}
async function analyze(p) {
  await p.click('#run');
  await p.waitForSelector('#result:not([hidden])', { timeout: 30000 });
  await p.waitForTimeout(900);
}
/** 고정 상단바(72px) 아래로 섹션 머리가 들어오게 여유를 준다. */
async function frame(p, sel) {
  await p.evaluate((s) => {
    const el = document.querySelector(s);
    window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 96, behavior: 'instant' });
  }, sel);
  await p.waitForTimeout(400);
}

// 01 — 전송 전 마스킹 확인 (개인정보 약속을 눈으로 보여주는 화면)
{ const p = await fresh(); await fill(p);
  await p.click('#toggle-preview'); await p.waitForTimeout(400);
  await p.screenshot({ path: `${OUT}/01-masking.png` }); await p.close(); }

// 02 — X-Ray 결과 (대표 이미지 후보)
{ const p = await fresh(); await fill(p); await analyze(p);
  await frame(p, '#xray');
  await p.screenshot({ path: `${OUT}/02-xray.png` }); await p.close(); }

// 03 — 판정 근거 + 배점의 법령 근거 (가장 강한 차별점)
{ const p = await fresh(); await fill(p); await analyze(p);
  await p.evaluate(() => { document.querySelector('.evidence').open = true; });
  await p.waitForTimeout(200);
  await p.evaluate(() => { document.querySelector('.evidence-basis').open = true; });
  await frame(p, '.evidence');
  await p.screenshot({ path: `${OUT}/03-legal-basis.png` }); await p.close(); }

// 04 — 추천 답장 3종
{ const p = await fresh(); await fill(p); await analyze(p);
  await frame(p, '.replies');
  await p.screenshot({ path: `${OUT}/04-replies.png` }); await p.close(); }

// 05 — 공유용 영수증
{ const p = await fresh(); await fill(p); await analyze(p);
  await p.click('#receipt-open'); await p.waitForTimeout(900);
  await p.screenshot({ path: `${OUT}/05-receipt.png` }); await p.close(); }

// 06 — 모바일 (16:9 아님. 폼에 넣을지는 선택)
{ const p = await fresh(390, 844); await fill(p); await analyze(p);
  await p.screenshot({ path: `${OUT}/06-mobile.png` }); await p.close(); }

// 모드 배지 확인 — 제출물에 "오프라인 분석"이 박히면 안 된다.
{ const p = await fresh(); await fill(p); await analyze(p);
  const badge = await p.$eval('#mode-badge', (n) => n.firstChild.textContent.trim());
  console.log(`\n모드 배지: ${badge}`);
  if (badge !== 'AI 분석') {
    console.log('⚠ 제출용 스크린샷은 배포본에서 다시 찍을 것 — 로컬에는 API 키가 없어 LIVE 가 아니다.');
    console.log(`   node scripts/make-screenshots.mjs https://office-firewall.vercel.app`);
  }
  await p.close(); }

console.log('페이지 에러:', errs.length ? errs : '없음');
console.log(`저장 위치: docs/assets/screenshots/`);
await browser.close();
