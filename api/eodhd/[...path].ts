export const config = {
  runtime: 'edge'
};

const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 15000;

const readLimitedBody = async (
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number
): Promise<ArrayBuffer | null> => {
  if (!stream) return new Uint8Array().buffer;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) return null;
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
};

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405 });
  }

  const requestUrl = new URL(request.url);
  const prefix = '/api/eodhd/';
  if (!requestUrl.pathname.startsWith(prefix)) {
    return new Response('Not found', { status: 404 });
  }

  const rawPath = requestUrl.pathname.slice(prefix.length);
  if (!rawPath || rawPath.includes('..')) {
    return new Response('Invalid path', { status: 400 });
  }

  const apiKey = (globalThis as any).process?.env?.EODHD_API_KEY as string | undefined;
  if (!apiKey) {
    return new Response('EODHD_API_KEY not configured', { status: 500 });
  }

  const upstreamUrl = new URL(`https://eodhd.com/${rawPath}`);
  requestUrl.searchParams.forEach((value, key) => {
    if (key !== 'api_token') upstreamUrl.searchParams.append(key, value);
  });
  upstreamUrl.searchParams.set('api_token', apiKey);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const upstream = await fetch(upstreamUrl.toString(), {
      method: request.method,
      signal: controller.signal
    });
    const contentType = upstream.headers.get('content-type') || 'application/json';
    const cacheControl = upstream.headers.get('cache-control') || 'no-store';

    if (request.method === 'HEAD') {
      return new Response(null, {
        status: upstream.status,
        headers: {
          'content-type': contentType,
          'cache-control': cacheControl
        }
      });
    }

    const body = await readLimitedBody(upstream.body, MAX_BYTES);
    if (body === null) {
      return new Response('Response too large', { status: 413 });
    }

    return new Response(body, {
      status: upstream.status,
      headers: {
        'content-type': contentType,
        'cache-control': cacheControl
      }
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      return new Response('Upstream timeout', { status: 504 });
    }
    return new Response('Upstream fetch failed', { status: 502 });
  } finally {
    clearTimeout(timeoutId);
  }
}
