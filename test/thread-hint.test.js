import test from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeMultiTurnThread } from '../src/lib/thread-hint.js';

test('빈 문자열/공백은 감지되지 않는다', () => {
  assert.equal(looksLikeMultiTurnThread(''), false);
  assert.equal(looksLikeMultiTurnThread('   \n  '), false);
});

test('평범한 단일 메시지는 감지되지 않는다', () => {
  assert.equal(looksLikeMultiTurnThread('이번 주 안에 데이터 스펙 공유 부탁드립니다.'), false);
});

test('시각 표기(14:00, 오전 9시:)는 화자 라벨로 오탐하지 않는다', () => {
  assert.equal(looksLikeMultiTurnThread('회의는 14:00 에 시작합니다.'), false);
  assert.equal(looksLikeMultiTurnThread('안건: 로그인 개선안 공유'), false); // 라벨 1개뿐 — 임계치 미달
});

test('"나:" 자기 발화 마커가 있으면 즉시 감지된다', () => {
  assert.equal(looksLikeMultiTurnThread('나: 확인해볼게요\n상대방: 네 감사합니다'), true);
  assert.equal(looksLikeMultiTurnThread('내가: 그건 좀 어려운데요'), true);
  assert.equal(looksLikeMultiTurnThread('Me: sure, will check'), true);
});

test('서로 다른 화자 라벨이 2개 이상이면 감지된다', () => {
  assert.equal(looksLikeMultiTurnThread('김철수: 이거 확인 부탁드려요\n박영희: 네 확인하겠습니다'), true);
});

test('사용자가 실제로 겪은 재현 사례: 내 발화가 섞인 대화 붙여넣기', () => {
  const t = '나: 그 건 이번주까지 될까요?\n상대방: 이번 주 안에 데이터 스펙 공유 부탁드립니다. 다음 주 회의 전까지 반영해야 해서요.\n나: 확인해볼게요';
  assert.equal(looksLikeMultiTurnThread(t), true);
});
