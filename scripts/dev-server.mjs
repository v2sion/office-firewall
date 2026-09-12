/**
 * vercel CLI 없이 프론트 + /api/analyze 를 한 포트에서 띄우는 로컬 서버.
 *   node scripts/dev-server.mjs            # dist/ 를 서빙 (npm run build 후)
 *   PORT=5180 node scripts/dev-server.mjs
 *
 * 배포 동작의 기준은 vercel dev / Vercel 이다. 이 스크립트는 테스트·시연 편의용이다.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import handler from '../api/analyze.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');
const PORT = Number(process.env.PORT || 5180);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Vercel 의 req/res 헬퍼를 최소한으로 흉내 낸다 */
function adapt(req, res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (obj) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
    return res;
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/analyze') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    req.body = chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
    adapt(req, res);
    try {
      await handler(req, res);
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { code: 'SERVER_ERROR', message: String(err?.message || err) } }));
    }
    return;
  }

  const rel = url.pathname === '/' ? 'index.html' : normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
  const file = join(DIST, rel);
  if (!file.startsWith(DIST) || !existsSync(file)) {
    res.statusCode = 404;
    res.end('Not found. dist/ 가 없다면 먼저 `npm run build` 를 실행하세요.');
    return;
  }
  res.setHeader('Content-Type', MIME[extname(file)] || 'application/octet-stream');
  res.end(await readFile(file));
});

server.listen(PORT, () => {
  const mode = process.env.ANTHROPIC_API_KEY && process.env.OFW_FORCE_MOCK !== '1' ? 'LIVE' : 'MOCK';
  console.log(`office-firewall local server → http://localhost:${PORT}  (analyze: ${mode})`);
});
