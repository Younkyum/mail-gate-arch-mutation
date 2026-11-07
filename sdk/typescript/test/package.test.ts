/**
 * Package metadata the published tarball relies on: the version constant equals `package.json` (and the Python package),
 * the license is MIT and shipped, and `exports`/`files` point at the built `dist` only.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SDK_VERSION, VERSION } from '../src/index.js';

const read = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
const pkg = JSON.parse(read('../package.json')) as Record<string, unknown>;

describe('package metadata', () => {
  it('VERSION equals package.json and the Python package', () => {
    expect(VERSION).toBe(SDK_VERSION);
    expect(VERSION).toBe(pkg['version']);
    const pyproject = /^version\s*=\s*"([^"]+)"/m.exec(read('../../python/pyproject.toml'))?.[1];
    expect(pyproject).toBe(VERSION);
  });

  it('is a public MIT package that ships dist, README and LICENSE only', () => {
    expect(pkg).toMatchObject({
      name: 'atmark-sdk',
      private: false,
      license: 'MIT',
      type: 'module',
      sideEffects: false,
      publishConfig: { access: 'public' },
      main: './dist/index.js',
      types: './dist/index.d.ts',
      exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
      files: ['dist', 'README.md', 'LICENSE'],
    });
    expect(pkg['repository']).toBeUndefined();
    expect((pkg['scripts'] as Record<string, string>)['prepack']).toBeDefined();
    expect(existsSync(fileURLToPath(new URL('../LICENSE', import.meta.url)))).toBe(true);
    expect(read('../LICENSE')).toContain('MIT License');
  });

  it('keywords name no third-party products', () => {
    const text = JSON.stringify([pkg['keywords'], pkg['description']]).toLowerCase();
    for (const banned of ['claude', 'codex', 'cursor', 'openai', 'anthropic', 'gpt']) expect(text, banned).not.toContain(banned);
  });
});
