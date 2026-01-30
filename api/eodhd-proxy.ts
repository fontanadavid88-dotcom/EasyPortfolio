const proc = (globalThis as any).process;
const isDev = proc?.env?.NODE_ENV !== 'production';
const devLog = (...args: unknown[]) => {
  if (!isDev) return;
  console.log('[eodhd-proxy]', ...args);
};

const readHeader = (req: any, name: string): string => {
  if (!req) return '';
  const headers = req.headers;
  if (!headers) return '';
  if (typeof headers.get === 'function') {
    return headers.get(name) || '';
  }
  const direct = headers[name];
  if (direct) return String(direct);
  const lower = headers[name.toLowerCase()];
  return lower ? String(lower) : '';
};

const buildJsonResponse = (payload: unknown, status = 200): Response => {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
};

const getRequestUrl = (req: any): URL => {
  const raw = req?.url || '';
  const full = raw.startsWith('http') ? raw : `http://localhost${raw}`;
  return new URL(full);
};

export default async function handler(req?: unknown, res?: any): Promise<Response | void> {
  const requestId = Math.random().toString(36).slice(2, 10);
  let aborted = false;
  if (req && typeof (req as any).on === 'function') {
    (req as any).on('aborted', () => {
      aborted = true;
    });
    (req as any).on('close', () => {
      aborted = true;
    });
  }

  const requestUrl = getRequestUrl(req);
  const path = requestUrl.searchParams.get('path') || '';
  if (!path || !path.startsWith('/')) {
    const body = JSON.stringify({ error: 'Missing or invalid path' });
    if (res && typeof res.status === 'function' && typeof res.send === 'function') {
      if (aborted || res.writableEnded) return;
      try {
        res.status(400).setHeader('content-type', 'application/json; charset=utf-8');
        res.send(body);
      } catch (err) {
        devLog('write_error', { requestId, err });
      }
      return;
    }
    if (res && typeof res.setHeader === 'function' && typeof res.end === 'function') {
      if (aborted || res.writableEnded) return;
      try {
        res.statusCode = 400;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(body);
      } catch (err) {
        devLog('write_error', { requestId, err });
      }
      return;
    }
    return buildJsonResponse({ error: 'Missing or invalid path' }, 400);
  }

  const headerKey = readHeader(req, 'x-eodhd-key') || readHeader(req, 'x-eodhd-api-key');
  const envNames = ['EODHD_API_KEY', 'VITE_EODHD_API_KEY'] as const;
  const envKey = envNames.map(name => proc?.env?.[name] as string | undefined).find(Boolean);
  const apiKey = (headerKey || envKey || '').trim();
  if (!apiKey) {
    const body = JSON.stringify({ error: 'Missing EODHD key', checkedEnv: envNames });
    if (res && typeof res.status === 'function' && typeof res.send === 'function') {
      if (aborted || res.writableEnded) return;
      try {
        res.status(400).setHeader('content-type', 'application/json; charset=utf-8');
        res.send(body);
      } catch (err) {
        devLog('write_error', { requestId, err });
      }
      return;
    }
    if (res && typeof res.setHeader === 'function' && typeof res.end === 'function') {
      if (aborted || res.writableEnded) return;
      try {
        res.statusCode = 400;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(body);
      } catch (err) {
        devLog('write_error', { requestId, err });
      }
      return;
    }
    return buildJsonResponse({ error: 'Missing EODHD key' }, 400);
  }

  const upstreamUrl = new URL(`https://eodhd.com${path}`);
  requestUrl.searchParams.forEach((value, key) => {
    if (key === 'path') return;
    if (key === 'api_token') return;
    upstreamUrl.searchParams.append(key, value);
  });
  upstreamUrl.searchParams.set('api_token', apiKey);

  devLog('req', { requestId, path, url: upstreamUrl.toString() });
  const upstream = await fetch(upstreamUrl.toString(), {
    method: 'GET'
  });
  devLog('status', { requestId, upstreamStatus: upstream.status });
  const upstreamType = upstream.headers.get('content-type') || '';
  const contentType = upstreamType || 'application/octet-stream';
  const isText = contentType.includes('application/json') || contentType.startsWith('text/');
  let textBody = '';
  let binBody: Uint8Array | null = null;
  if (isText) {
    textBody = await upstream.text();
    devLog('payload', { requestId, mode: 'text', contentType, len: textBody.length, aborted });
  } else {
    const buffer = await upstream.arrayBuffer();
    binBody = new Uint8Array(buffer);
    devLog('payload', { requestId, mode: 'binary', contentType, len: binBody.byteLength, aborted });
  }

  if (res && typeof res.status === 'function' && typeof res.send === 'function') {
    if (aborted || res.writableEnded) return;
    try {
      res.status(upstream.status);
      res.setHeader('content-type', contentType);
      if (isText) {
        res.send(textBody);
      } else {
        res.send(binBody ? Buffer.from(binBody) : Buffer.alloc(0));
      }
    } catch (err) {
      devLog('write_error', { requestId, err });
    }
    return;
  }

  if (res && typeof res.setHeader === 'function' && typeof res.end === 'function') {
    if (aborted || res.writableEnded) return;
    try {
      res.statusCode = upstream.status;
      res.setHeader('content-type', contentType);
      if (isText) {
        res.end(textBody);
      } else {
        res.end(binBody ? Buffer.from(binBody) : Buffer.alloc(0));
      }
    } catch (err) {
      devLog('write_error', { requestId, err });
    }
    return;
  }

  return new Response(isText ? textBody : (binBody ? Buffer.from(binBody) : Buffer.alloc(0)), {
    status: upstream.status,
    headers: {
      'content-type': contentType
    }
  });
}
