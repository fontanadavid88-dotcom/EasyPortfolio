import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const repoRoot = process.cwd();

const readFile = (relPath: string) => fs.readFileSync(path.join(repoRoot, relPath), 'utf-8');

const listFiles = (dir: string, ext: string) => {
  const out: string[] = [];
  const walk = (p: string) => {
    for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && full.endsWith(ext)) out.push(full);
    }
  };
  walk(path.join(repoRoot, dir));
  return out;
};

describe('uiAccentGuardrail', () => {
  it('accent line is not applied globally to ui-panel and is solid color', () => {
    const css = readFile('index.css');

    const forbiddenPanelAccent = [
      /\.ui-panel::before/,
      /\.ui-panel::after/,
      /\.ui-panel:hover::before/,
      /\.ui-panel:hover::after/,
      /\.ui-panel-dense::before/,
      /\.ui-panel-dense::after/,
      /\.ui-panel-dense:hover::before/,
      /\.ui-panel-dense:hover::after/,
      /\.ui-panel-subtle::before/,
      /\.ui-panel-subtle::after/,
      /\.ui-panel-subtle:hover::before/,
      /\.ui-panel-subtle:hover::after/
    ];

    for (const rx of forbiddenPanelAccent) {
      expect(rx.test(css)).toBe(false);
    }

    const accentBlock = css.match(/\.ui-accent-top::before\s*{[^}]*}/s);
    expect(accentBlock).not.toBeNull();
    if (accentBlock) {
      expect(/linear-gradient/.test(accentBlock[0])).toBe(false);
    }

    const pages = listFiles('pages', '.tsx');
    const components = listFiles('components', '.tsx');
    const allUi = [...pages, ...components].map(p => fs.readFileSync(p, 'utf-8')).join('\n');
    const globalAccentUsage = /\.ui-panel(::|:hover::)(before|after)/.test(allUi);
    expect(globalAccentUsage).toBe(false);
  });
});
