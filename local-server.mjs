import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.PORT || 8787);
const root = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(root, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
const rakutenEndpoint = 'https://openapi.rakuten.co.jp/engine/api/Gora/GoraGolfCourseSearch/20170623';
const rakutenDetailEndpoint = 'https://openapi.rakuten.co.jp/engine/api/Gora/GoraGolfCourseDetail/20170623';
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

function htmlText(value) {
  return String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseHoleDetails(html) {
  const courses = [];
  const coursePattern = /<h3\b[^>]*class="[^"]*course-name[^"]*"[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<table\b[^>]*class="[^"]*course-details-table[^"]*"[^>]*>([\s\S]*?)<\/table>/gi;
  for (const courseMatch of html.matchAll(coursePattern)) {
    const holes = Array.from({ length: 9 }, () => ({ yards: [] }));
    for (const rowMatch of courseMatch[2].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const headerMatch = rowMatch[1].match(/<th\b[^>]*>([\s\S]*?)<\/th>/i);
      if (!headerMatch) continue;
      const label = htmlText(headerMatch[1]).toUpperCase();
      const values = [...rowMatch[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
        .slice(0, 9)
        .map((cell) => Number(htmlText(cell[1]).match(/\d+/)?.[0]));
      if (values.length !== 9 || values.some((value) => !Number.isFinite(value))) continue;
      values.forEach((value, index) => {
        if (label === 'PAR') holes[index].par = value;
        else if (label === 'HDCP') holes[index].handicap = value;
        else if (label !== 'HOLE') holes[index].yards.push({ tee: label, value });
      });
    }
    courses.push({ name: htmlText(courseMatch[1]), holes });
  }
  return courses;
}

function rakutenParameters(extra = {}) {
  return new URLSearchParams({
    accessKey: process.env.RAKUTEN_ACCESS_KEY || '',
    applicationId: process.env.RAKUTEN_APPLICATION_ID || '',
    format: 'json',
    formatVersion: '2',
    ...extra,
  });
}

function rakutenOptions() {
  return {
    headers: { Accept: 'application/json', Origin: new URL(applicationUrl).origin, Referer: applicationUrl },
    signal: AbortSignal.timeout(10000),
  };
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

  const params = rakutenParameters({ hits: '20', keyword });
  const upstream = await fetch(`${rakutenEndpoint}?${params}`, rakutenOptions());
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
    .map((course) => ({
      id: String(course.golfCourseId || ''),
      name: String(course.golfCourseName || ''),
      address: String(course.address || ''),
      imageUrl: course.golfCourseImageUrl ? String(course.golfCourseImageUrl) : undefined,
    }))
    .filter((course) => course.id && course.name)
    .filter((course) => normalizeCourseName(course.name).includes(normalizeCourseName(keyword)));
  sendJson(response, 200, { courses });
}

async function getCourseLayout(courseId, response) {
  if (!process.env.RAKUTEN_APPLICATION_ID || !process.env.RAKUTEN_ACCESS_KEY) {
    sendJson(response, 503, { error: 'Rakuten GORA API の認証情報が未設定です。' });
    return;
  }
  const upstream = await fetch(`${rakutenDetailEndpoint}?${rakutenParameters({ golfCourseId: courseId })}`, rakutenOptions());
  const data = await upstream.json().catch(() => null);
  if (!upstream.ok) {
    sendJson(response, upstream.status, { error: data?.error_description || data?.error || 'コース情報を取得できませんでした。' });
    return;
  }
  const detail = data?.Item || data?.item || data;
  sendJson(response, 200, {
    name: String(detail.golfCourseName || ''),
    courseName: String(detail.courseName || ''),
    holeCount: Number(detail.holeCount) || undefined,
    parCount: Number(detail.parCount) || undefined,
    layoutUrl: detail.layoutUrl ? String(detail.layoutUrl) : undefined,
    detailUrl: detail.golfCourseDetailUrl ? String(detail.golfCourseDetailUrl) : undefined,
  });
}

async function getHoleLayouts(courseId, response) {
  const mediaUrl = `https://booking.gora.golf.rakuten.co.jp/guide/course_info/drone/disp/c_id/${courseId}`;
  const upstream = await fetch(mediaUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
  if (!upstream.ok) {
    sendJson(response, 502, { error: `コース情報ページが HTTP ${upstream.status} を返しました。` });
    return;
  }
  const html = await upstream.text();
  const details = parseHoleDetails(html);
  const pattern = new RegExp(`https://image\\.gora\\.golf\\.rakuten\\.co\\.jp/img/golf/${courseId}/new_hole_info/([^/"'\\\\]+?)_(\\d+)\\.(png|jpe?g|webp)`, 'gi');
  const groups = new Map();
  for (const match of html.matchAll(pattern)) {
    const [, groupId, holeNumber, extension] = match;
    if (!groups.has(groupId)) groups.set(groupId, new Map());
    groups.get(groupId).set(Number(holeNumber), `${match[0].slice(0, -extension.length)}${extension.toLowerCase()}`);
  }
  const holes = [...groups.values()].flatMap((group, courseIndex) => [...group.entries()]
    .sort(([left], [right]) => left - right)
    .map(([holeNumber, imageUrl]) => ({
      courseIndex,
      courseName: details[courseIndex]?.name,
      holeNumber,
      imageUrl,
      ...details[courseIndex]?.holes[holeNumber - 1],
    })));
  sendJson(response, 200, { holes });
}

async function getLayoutPage(courseId, response) {
  const layoutUrl = `https://booking.gora.golf.rakuten.co.jp/guide/layout_disp/c_id/${courseId}`;
  const upstream = await fetch(layoutUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
  if (!upstream.ok) {
    response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }).end('コース図ページを取得できませんでした。');
    return;
  }
  const html = (await upstream.text()).replace(/<head([^>]*)>/i, `<head$1><base href="${layoutUrl}/">`);
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
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
    const layoutMatch = requestUrl.pathname.match(/^\/api\/gora\/courses\/(\d+)\/layout$/);
    const holesMatch = requestUrl.pathname.match(/^\/api\/gora\/courses\/(\d+)\/holes$/);
    const layoutPageMatch = requestUrl.pathname.match(/^\/api\/gora\/courses\/(\d+)\/layout-page$/);
    if (requestUrl.pathname === '/api/gora/courses') {
      await searchRakuten(requestUrl, response);
      return;
    }
    if (layoutMatch) {
      await getCourseLayout(layoutMatch[1], response);
      return;
    }
    if (holesMatch) {
      await getHoleLayouts(holesMatch[1], response);
      return;
    }
    if (layoutPageMatch) {
      await getLayoutPage(layoutPageMatch[1], response);
      return;
    }
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