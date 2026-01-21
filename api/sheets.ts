export const config = {
  runtime: 'edge'
};

const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 15000;
const ALLOWED_HOSTS = new Set(['docs.google.com', 'googleusercontent.com']);

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

const isAllowedHost = (host: string): boolean => {
  const normalized = host.toLowerCase();
  return ALLOWED_HOSTS.has(normalized) || normalized.endsWith('.googleusercontent.com');
};

export default async function handler(request: Request): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405 });
  }

  const requestUrl = new URL(request.url);
  const rawUrl = requestUrl.searchParams.get('url');
  if (!rawUrl) {
    return new Response('Missing url param', { status: 400 });
  }

  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return new Response('Invalid url', { status: 400 });
  }

  if (target.protocol !== 'https:') {
    return new Response('URL protocol not allowed', { status: 400 });
  }

  if (!isAllowedHost(target.hostname)) {
    return new Response('URL host not allowed', { status: 400 });
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const upstream = await fetch(target.toString(), {
      method: request.method,
      signal: controller.signal
    });
    const upstreamType = upstream.headers.get('content-type') || 'text/plain; charset=utf-8';
    const contentType = upstreamType.includes('text/csv')
      ? 'text/csv; charset=utf-8'
      : 'text/plain; charset=utf-8';

    if (request.method === 'HEAD') {
      return new Response(null, {
        status: upstream.status,
        headers: {
          'content-type': contentType,
          'cache-control': 'no-store'
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
        'cache-control': 'no-store'
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
