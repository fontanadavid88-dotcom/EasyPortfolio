// api/health.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(200).send(
    JSON.stringify({
      ok: true,
      time: new Date().toISOString(),
      node: process.version,
      execArgv: process.execArgv,
      nodeOptions: process.env.NODE_OPTIONS ?? '',
    })
  );
}
