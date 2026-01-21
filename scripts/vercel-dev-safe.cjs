const { spawn } = require('node:child_process');

const isWin = process.platform === 'win32';
const command = isWin ? 'cmd.exe' : 'npx';
const args = isWin
  ? ['/d', '/s', '/c', 'set NODE_OPTIONS=& set npm_config_node_options=& npx vercel dev']
  : ['vercel', 'dev'];

const env = { ...process.env, NODE_OPTIONS: '', npm_config_node_options: '' };
const child = spawn(command, args, { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 1));
child.on('error', (err) => {
  console.error('[vercel-dev-safe] spawn failed:', err);
  process.exit(1);
});
