const proc = (globalThis as any).process;

const buildPayload = () => ({
  ok: true,
  time: new Date().toISOString(),
  node: proc?.version ?? '',
  execArgv: proc?.execArgv ?? [],
  nodeOptions: proc?.env?.NODE_OPTIONS ?? ''
});

export default function handler(_req?: unknown, res?: any): Response | void {
  void _req;
  const body = JSON.stringify(buildPayload());

  if (res && typeof res.status === 'function' && typeof res.send === 'function') {
    res.status(200).send(body);
    return;
  }

  if (res && typeof res.setHeader === 'function' && typeof res.end === 'function') {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(body);
    return;
  }

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}
