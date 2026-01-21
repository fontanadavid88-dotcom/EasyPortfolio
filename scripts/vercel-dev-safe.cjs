const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const isWin = process.platform === 'win32';

const rawNodeOptions = process.env.NODE_OPTIONS || '';
const rawNpmNodeOptions = process.env.npm_config_node_options || '';
const npmConfigResult = spawnSync(isWin ? 'npm.cmd' : 'npm', ['config', 'get', 'node-options'], {
  env: { ...process.env, NODE_OPTIONS: '' },
  encoding: 'utf8'
});
const npmNodeOptions = (npmConfigResult.stdout || '').trim();

console.log('[vercel-dev-safe] NODE_OPTIONS:', rawNodeOptions || '(empty)');
console.log('[vercel-dev-safe] npm_config_node_options:', rawNpmNodeOptions || '(empty)');
console.log('[vercel-dev-safe] npm config get node-options:', npmNodeOptions || '(empty)');

const hasRiskyOptions =
  /--require|--import/.test(rawNodeOptions) ||
  /--require|--import/.test(rawNpmNodeOptions) ||
  /--require|--import/.test(npmNodeOptions);
if (hasRiskyOptions) {
  console.warn('[vercel-dev-safe] Warning: detected node preload flags. This can break Vercel Functions on Windows.');
}

const env = { ...process.env, NODE_OPTIONS: '', npm_config_node_options: '' };

const pickSubstDrive = () => {
  const letters = ['V', 'W', 'X', 'Y', 'Z'];
  for (const letter of letters) {
    const drivePath = `${letter}:\\`;
    if (!fs.existsSync(drivePath)) {
      return letter;
    }
  }
  return null;
};

const normalizeWindowsPath = (value) => {
  let normalized = path.resolve(value);
  if (normalized.startsWith('\\\\?\\')) {
    normalized = normalized.slice(4);
  }
  if (/^\\[A-Za-z]:\\/.test(normalized)) {
    normalized = normalized.slice(1);
  }
  normalized = normalized.replace(/[\\/]+$/, '');
  return normalized;
};

const resolveSubstExe = () => {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const substExe = path.join(systemRoot, 'System32', 'subst.exe');
  return fs.existsSync(substExe) ? substExe : null;
};

const createSubstDrive = (rootPath) => {
  const letter = pickSubstDrive();
  if (!letter) {
    return null;
  }
  const normalizedRoot = normalizeWindowsPath(rootPath);
  console.log('[vercel-dev-safe] subst root:', normalizedRoot);
  console.log('[vercel-dev-safe] subst root (json):', JSON.stringify(normalizedRoot));
  if (!fs.existsSync(normalizedRoot)) {
    console.warn('[vercel-dev-safe] cwd does not exist:', normalizedRoot);
    return null;
  }
  const substExe = resolveSubstExe();
  const cmd = process.env.ComSpec || 'cmd.exe';
  const substCommand = `subst ${letter}: "${normalizedRoot.replace(/"/g, '""')}"`;
  console.log('[vercel-dev-safe] subst cmd:', substCommand);
  const result = substExe
    ? spawnSync(substExe, [`${letter}:`, normalizedRoot], { encoding: 'utf8' })
    : spawnSync(cmd, ['/d', '/s', '/c', substCommand], { encoding: 'utf8' });
  if (result.status !== 0) {
    if (result.stderr) {
      console.warn('[vercel-dev-safe] subst stderr:', result.stderr.trim());
    }
    if (result.stdout) {
      console.warn('[vercel-dev-safe] subst stdout:', result.stdout.trim());
    }
    return null;
  }
  const drivePath = `${letter}:\\`;
  const cleanup = () => {
    if (substExe) {
      spawnSync(substExe, [`${letter}:`, '/D'], { stdio: 'inherit' });
    } else {
      spawnSync(cmd, ['/d', '/s', '/c', `subst ${letter}: /d`], { stdio: 'inherit' });
    }
  };
  return { drivePath, cleanup };
};

const spawnChild = (command, commandArgs) => {
  const child = spawn(command, commandArgs, {
    stdio: 'inherit',
    env,
    shell: false
  });
  child.on('exit', (code) => process.exit(code ?? 1));
  child.on('error', (err) => {
    console.error('[vercel-dev-safe] spawn failed:', err);
    process.exit(1);
  });
};

if (isWin) {
  const cwd = process.cwd();
  const needsSubst = /\s/.test(cwd);
  let subst = null;
  if (needsSubst) {
    subst = createSubstDrive(cwd);
    if (subst) {
      process.on('exit', subst.cleanup);
      process.on('SIGINT', () => {
        subst.cleanup();
        process.exit(130);
      });
      process.on('SIGTERM', () => {
        subst.cleanup();
        process.exit(143);
      });
      console.log('[vercel-dev-safe] Using subst drive:', subst.drivePath);
    } else {
      console.warn('[vercel-dev-safe] Failed to create subst drive. Continuing with original path.');
    }
  }
  const effectiveCwd = subst?.drivePath || cwd;
  const safeCwd = effectiveCwd.replace(/'/g, "''");
  const origCwdEscaped = cwd.replace(/\"/g, '\"\"');
  const allowValue = [effectiveCwd, cwd].join('|');
  const allowEscaped = allowValue.replace(/\"/g, '\"\"');
  const psCommand = `Set-Location -LiteralPath '${safeCwd}'; $env:NODE_OPTIONS=\"\"; $env:npm_config_node_options=\"\"; $env:VITE_FS_ALLOW=\"${allowEscaped}\"; $env:VITE_PROJECT_ROOT=\"${safeCwd.replace(/\"/g, '\"\"')}\"; npx vercel dev`;
  spawnChild('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCommand]);
} else {
  spawnChild('npx', ['vercel', 'dev']);
}
