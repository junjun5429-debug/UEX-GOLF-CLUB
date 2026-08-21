const searchEndpoint = 'https://openapi.rakuten.co.jp/engine/api/Gora/GoraGolfCourseSearch/20170623';
const detailEndpoint = 'https://openapi.rakuten.co.jp/engine/api/Gora/GoraGolfCourseDetail/20170623';
const applicationUrl = 'https://junjun5429-debug.github.io/UEX-GOLF-CLUB/';
const allowedOrigins = new Set([new URL(applicationUrl).origin, 'http://localhost:8787', 'http://127.0.0.1:8787', 'http://localhost:8788', 'http://127.0.0.1:8788']);

function corsHeaders(origin: string | null) {
  return {
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Origin': origin && allowedOrigins.has(origin) ? origin : new URL(applicationUrl).origin,
    'Vary': 'Origin',
  };
}

function jsonResponse(status: number, value: unknown, origin: string | null) {
  return new Response(JSON.stringify(value), { status, headers: { ...corsHeaders(origin), 'Content-Type': 'application/json; charset=utf-8' } });
}

function normalizeCourseName(value: unknown) {
  return String(value || '').normalize('NFKC').replace(/[\s　・･]/g, '').toLocaleLowerCase('ja');
}

function htmlText(value: string) {
  return value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
}

type HoleDetail = { par?: number; handicap?: number; yards: Array<{ tee: string; value: number }> };

function parseHoleDetails(html: string) {
  const courses: Array<{ name: string; holes: HoleDetail[] }> = [];
  const coursePattern = /<h3\b[^>]*class="[^"]*course-name[^"]*"[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<table\b[^>]*class="[^"]*course-details-table[^"]*"[^>]*>([\s\S]*?)<\/table>/gi;
  for (const courseMatch of html.matchAll(coursePattern)) {
    const holes: HoleDetail[] = Array.from({ length: 9 }, () => ({ yards: [] }));
    for (const rowMatch of courseMatch[2].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const headerMatch = rowMatch[1].match(/<th\b[^>]*>([\s\S]*?)<\/th>/i);
      if (!headerMatch) continue;
      const label = htmlText(headerMatch[1]).toUpperCase();
      const values = [...rowMatch[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].slice(0, 9).map((cell) => Number(htmlText(cell[1]).match(/\d+/)?.[0]));
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

function rakutenParameters(applicationId: string, accessKey: string, extra: Record<string, string>) {
  return new URLSearchParams({ applicationId, accessKey, format: 'json', formatVersion: '2', ...extra });
}

function rakutenOptions() {
  return { headers: { Accept: 'application/json', Origin: new URL(applicationUrl).origin, Referer: applicationUrl }, signal: AbortSignal.timeout(10000) };
}

async function searchCourses(requestUrl: URL, applicationId: string, accessKey: string, origin: string | null) {
  const keyword = requestUrl.searchParams.get('keyword')?.trim() || '';
  if (keyword.length < 2) return jsonResponse(400, { error: 'ゴルフ場名を 2 文字以上入力してください。' }, origin);
  const upstream = await fetch(`${searchEndpoint}?${rakutenParameters(applicationId, accessKey, { hits: '20', keyword })}`, rakutenOptions());
  const data = await upstream.json().catch(() => null);
  if (!upstream.ok) return jsonResponse(upstream.status, { error: data?.error_description || data?.error || 'Rakuten GORA API がエラーを返しました。' }, origin);
  const normalizedKeyword = normalizeCourseName(keyword);
  const courses = (data?.Items || data?.items || [])
    .map((entry: Record<string, unknown>) => entry.Item || entry.item || entry)
    .map((course: Record<string, unknown>) => ({ id: String(course.golfCourseId || ''), name: String(course.golfCourseName || ''), address: String(course.address || ''), imageUrl: course.golfCourseImageUrl ? String(course.golfCourseImageUrl) : undefined }))
    .filter((course: { id: string; name: string }) => course.id && course.name)
    .filter((course: { name: string; address: string }) => normalizeCourseName(course.name).includes(normalizedKeyword) || normalizeCourseName(course.address).includes(normalizedKeyword));
  return jsonResponse(200, { courses }, origin);
}

async function getLayout(courseId: string, applicationId: string, accessKey: string, origin: string | null) {
  const upstream = await fetch(`${detailEndpoint}?${rakutenParameters(applicationId, accessKey, { golfCourseId: courseId })}`, rakutenOptions());
  const data = await upstream.json().catch(() => null);
  if (!upstream.ok) return jsonResponse(upstream.status, { error: data?.error_description || data?.error || 'コース情報を取得できませんでした。' }, origin);
  const detail = data?.Item || data?.item || data;
  return jsonResponse(200, { name: String(detail.golfCourseName || ''), courseName: String(detail.courseName || ''), holeCount: Number(detail.holeCount) || undefined, parCount: Number(detail.parCount) || undefined, layoutUrl: detail.layoutUrl ? String(detail.layoutUrl) : undefined, detailUrl: detail.golfCourseDetailUrl ? String(detail.golfCourseDetailUrl) : undefined }, origin);
}

async function getHoles(courseId: string, origin: string | null) {
  const mediaUrl = `https://booking.gora.golf.rakuten.co.jp/guide/course_info/drone/disp/c_id/${courseId}`;
  const upstream = await fetch(mediaUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
  if (!upstream.ok) return jsonResponse(502, { error: `コース情報ページが HTTP ${upstream.status} を返しました。` }, origin);
  const html = await upstream.text();
  const details = parseHoleDetails(html);
  const pattern = new RegExp(`https://image\\.gora\\.golf\\.rakuten\\.co\\.jp/img/golf/${courseId}/new_hole_info/([^/"'\\\\]+?)_(\\d+)\\.(png|jpe?g|webp)`, 'gi');
  const groups = new Map<string, Map<number, string>>();
  for (const match of html.matchAll(pattern)) {
    const [, groupId, holeNumber, extension] = match;
    if (!groups.has(groupId)) groups.set(groupId, new Map());
    groups.get(groupId)?.set(Number(holeNumber), `${match[0].slice(0, -extension.length)}${extension.toLowerCase()}`);
  }
  const holes = [...groups.values()].flatMap((group, courseIndex) => [...group.entries()].sort(([left], [right]) => left - right).map(([holeNumber, imageUrl]) => ({ courseIndex, courseName: details[courseIndex]?.name, holeNumber, imageUrl, ...details[courseIndex]?.holes[holeNumber - 1] })));
  return jsonResponse(200, { holes }, origin);
}

async function getLayoutPage(courseId: string, origin: string | null) {
  const layoutUrl = `https://booking.gora.golf.rakuten.co.jp/guide/layout_disp/c_id/${courseId}`;
  const upstream = await fetch(layoutUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
  if (!upstream.ok) return new Response('コース図ページを取得できませんでした。', { status: 502, headers: corsHeaders(origin) });
  const html = (await upstream.text()).replace(/<head([^>]*)>/i, `<head$1><base href="${layoutUrl}/">`);
  return new Response(html, { headers: { ...corsHeaders(origin), 'Content-Type': 'text/html; charset=utf-8' } });
}

Deno.serve(async (request) => {
  const origin = request.headers.get('origin');
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (request.method !== 'GET') return jsonResponse(405, { error: 'method_not_allowed' }, origin);
  if (origin && !allowedOrigins.has(origin)) return jsonResponse(403, { error: 'origin_not_allowed' }, origin);
  const applicationId = Deno.env.get('RAKUTEN_APPLICATION_ID');
  const accessKey = Deno.env.get('RAKUTEN_ACCESS_KEY');
  if (!applicationId || !accessKey) return jsonResponse(503, { error: 'rakuten_credentials_missing' }, origin);
  const requestUrl = new URL(request.url);
  const action = requestUrl.searchParams.get('action') || 'courses';
  const courseId = requestUrl.searchParams.get('courseId') || '';
  if (action !== 'courses' && !/^\d+$/.test(courseId)) return jsonResponse(400, { error: 'ゴルフ場 ID が不正です。' }, origin);
  try {
    if (action === 'courses') return await searchCourses(requestUrl, applicationId, accessKey, origin);
    if (action === 'layout') return await getLayout(courseId, applicationId, accessKey, origin);
    if (action === 'holes') return await getHoles(courseId, origin);
    if (action === 'layout-page') return await getLayoutPage(courseId, origin);
    return jsonResponse(400, { error: 'invalid_action' }, origin);
  } catch (error) {
    const timeout = error instanceof DOMException && error.name === 'TimeoutError';
    return jsonResponse(timeout ? 504 : 500, { error: timeout ? 'upstream_timeout' : 'course_request_failed' }, origin);
  }
});