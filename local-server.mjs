import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.PORT || 8787);
const root = dirname(fileURLToPath(import.meta.url));
const rakutenEndpoint = 'https://openapi.rakuten.co.jp/engine/api/Gora/GoraGolfCourseSearch/20170623';
const applicationUrl = 'https://junjun5429-debug.github.io/UEX-GOLF-CLUB/';
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function sendJson(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function normalizeCourseName(value) {
  return String(value || '').normalize('NFKC').replace(/[\s　・･]/g, '').toLocaleLowerCase('ja');
}

async function searchRakuten(requestUrl, response) {
  const applicationId = process.env.RAKUTEN_APPLICATION_ID;
  const accessKey = process.env.RAKUTEN_ACCESS_KEY;
  if (!applicationId || !accessKey) {
    sendJson(response, 503, { error: 'RAKUTEN_APPLICATION_ID and RAKUTEN_ACCESS_KEY are required' });
    return;
  }

  const keyword = requestUrl.searchParams.get('keyword')?.trim() || '';
  if (keyword.length < 2) {
    sendJson(response, 400, { error: 'keyword must contain at least two characters' });
    return;
  }

  const params = new URLSearchParams({
    accessKey,
    applicationId,
    format: 'json',
    formatVersion: '2',
    hits: '10',
    keyword,
  });
  const upstream = await fetch(`${rakutenEndpoint}?${params}`, {
    headers: {
      Accept: 'application/json',
      Origin: new URL(applicationUrl).origin,
      Referer: applicationUrl,
    },
    signal: AbortSignal.timeout(8000),
  });
  const data = await upstream.json().catch(() => null);
  if (!upstream.ok) {
    sendJson(response, upstream.status, {
      error: data?.error || 'rakuten_api_error',
      description: data?.error_description || `Rakuten API returned ${upstream.status}`,
    });
    return;
  }

  const items = data?.Items || data?.items || [];
  const courses = items.map((entry) => entry.Item || entry.item || entry)
    .map((course) => ({ id: course.golfCourseId, name: course.golfCourseName }))
    .filter((course) => course.id && course.name)
    .filter((course) => normalizeCourseName(course.name).includes(normalizeCourseName(keyword)));
  sendJson(response, 200, { courses });
}

async function serveStatic(requestUrl, response) {
  const pathname = requestUrl.pathname === '/' ? '/index.html' : decodeURIComponent(requestUrl.pathname);
  const filePath = resolve(root, `.${pathname}`);
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
    response.writeHead(403).end();
    return;
  }

  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': contentTypes[extname(filePath)] || 'application/octet-stream',
    });
    response.end(content);
  } catch (error) {
    response.writeHead(error.code === 'ENOENT' ? 404 : 500).end();
  }
}

createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  try {
    if (requestUrl.pathname === '/api/course-search') {
      await searchRakuten(requestUrl, response);
      return;
    }
    await serveStatic(requestUrl, response);
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: 'local_proxy_error' });
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`UEX GOLF local server: http://127.0.0.1:${port}`);
});