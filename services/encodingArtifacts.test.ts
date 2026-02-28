import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOTS = [
  'App.tsx',
  'pages',
  'components',
  'services',
  'docs'
];

const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.md']);

const FORBIDDEN = [
  { name: 'replacement-char', regex: /\uFFFD/ },
  { name: 'mojibake-utf8', regex: /\u00C3/ },
  { name: 'mojibake-quote', regex: /\u00E2\u20AC/ },
  { name: 'mojibake-nbsp', regex: /\u00C2/ },
  { name: 'mojibake-efbfbd', regex: /\u00EF\u00BF\u00BD/ },
  { name: 'nbsp', regex: /\u00A0/ },
  { name: 'u2028', regex: /\u2028/ },
  { name: 'u2029', regex: /\u2029/ }
];

const shouldScan = (filePath: string) => EXTENSIONS.has(path.extname(filePath));

const walk = (entry: string): string[] => {
  const results: string[] = [];
  if (!fs.existsSync(entry)) return results;
  const stat = fs.statSync(entry);
  if (stat.isFile()) return shouldScan(entry) ? [entry] : [];
  const items = fs.readdirSync(entry);
  for (const item of items) {
    if (['node_modules', 'dist', '.git', '.vite', 'coverage'].includes(item)) continue;
    const full = path.join(entry, item);
    const sub = walk(full);
    results.push(...sub);
  }
  return results;
};

describe('encodingArtifacts', () => {
  it('does not contain mojibake or forbidden unicode artifacts', () => {
    const files: string[] = [];
    ROOTS.forEach(root => {
      files.push(...walk(root));
    });

    const findings: string[] = [];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split(/\r?\n/);
      lines.forEach((line, idx) => {
        for (const rule of FORBIDDEN) {
          if (rule.regex.test(line)) {
            findings.push(`${file}:${idx + 1} [${rule.name}] ${line.trim()}`);
          }
        }
      });
    }

    expect(findings).toEqual([]);
  });
});
