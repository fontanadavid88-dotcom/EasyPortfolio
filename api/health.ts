const proc = (globalThis as any).process;
console.log('[health] execArgv:', proc?.execArgv ?? '(n/a)');
console.log('[health] NODE_OPTIONS:', proc?.env?.NODE_OPTIONS ?? '(n/a)');
console.log('[health] cwd:', proc?.cwd?.() ?? '(n/a)');
console.log('[health] version:', proc?.version ?? '(n/a)');

export const config = {
  runtime: 'nodejs'
};

export default function handler(): Response {
  const hasKey = Boolean((globalThis as any).process?.env?.EODHD_API_KEY);
  const hasNodeOptions = Boolean((globalThis as any).process?.env?.NODE_OPTIONS);
  const payload = {
    ok: true,
    time: new Date().toISOString(),
    hasEodhdKey: hasKey,
    hasNodeOptions
  };
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}
