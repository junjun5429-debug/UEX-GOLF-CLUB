const rakutenEndpoint = 'https://openapi.rakuten.co.jp/engine/api/Gora/GoraGolfCourseSearch/20170623';
const applicationUrl = 'https://junjun5429-debug.github.io/UEX-GOLF-CLUB/';
const allowedOrigins = new Set([
  new URL(applicationUrl).origin,
  'http://localhost:8787',
  'http://127.0.0.1:8787',
]);

function corsHeaders(origin: string | null) {
  return {
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Origin': origin && allowedOrigins.has(origin) ? origin : new URL(applicationUrl).origin,
    'Vary': 'Origin',
  };
}

function jsonResponse(status: number, value: unknown, origin: string | null) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...corsHeaders(origin),
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

function normalizeCourseName(value: unknown) {
  return String(value || '').normalize('NFKC').replace(/[\s　・･]/g, '').toLocaleLowerCase('ja');
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
  const keyword = requestUrl.searchParams.get('keyword')?.trim() || '';
  if (keyword.length < 2) return jsonResponse(400, { error: 'invalid_keyword' }, origin);

  const params = new URLSearchParams({
    accessKey,
    applicationId,
    format: 'json',
    formatVersion: '2',
    hits: '10',
    keyword,
  });

  try {
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
      return jsonResponse(upstream.status, {
        error: data?.error || 'rakuten_api_error',
        description: data?.error_description || `Rakuten API returned ${upstream.status}`,
      }, origin);
    }

    const items = data?.Items || data?.items || [];
    const normalizedKeyword = normalizeCourseName(keyword);
    const courses = items.map((entry: Record<string, unknown>) => entry.Item || entry.item || entry)
      .map((course: Record<string, unknown>) => ({ id: course.golfCourseId, name: course.golfCourseName }))
      .filter((course: { id: unknown; name: unknown }) => course.id && course.name)
      .filter((course: { name: unknown }) => normalizeCourseName(course.name).includes(normalizedKeyword));
    return jsonResponse(200, { courses }, origin);
  } catch (error) {
    const timeout = error instanceof DOMException && error.name === 'TimeoutError';
    return jsonResponse(timeout ? 504 : 500, { error: timeout ? 'rakuten_api_timeout' : 'course_search_failed' }, origin);
  }
});