import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectRepoConventions,
  extractExportedSymbols,
  selectRelevantRepoContext,
} from './codebaseContext';

test('extractExportedSymbols extracts functions, classes, interfaces, and types', () => {
  const code = [
    'export interface AuthUser { id: string; }',
    'export class SessionStore {}',
    'export async function verifyToken(t: string) { return t; }',
  ].join('\n');
  assert.deepEqual(extractExportedSymbols(code), ['AuthUser', 'SessionStore', 'verifyToken']);
});

test('detectRepoConventions identifies vitest vs node:test and tsconfig extensions', () => {
  const conventions = detectRepoConventions({
    'package.json': JSON.stringify({ name: 'real-api', devDependencies: { vitest: '^2.0.0' } }),
    'tsconfig.json': '{ "compilerOptions": { "strict": true } }',
    'lib/router.ts': 'export function createRouter() {}',
  });
  assert.equal(conventions.packageName, 'real-api');
  assert.equal(conventions.usesVitest, true);
  assert.equal(conventions.sourceRoot, 'lib/');
  assert.equal(conventions.allowImportingTsExtensions, false);
});

test('selectRelevantRepoContext prioritizes matching files across large codebases', () => {
  const files: Record<string, string> = {
    'package.json': '{"name":"big-app"}',
    'README.md': '# Big App',
    'src/index.ts': 'export const app = true;',
    'src/auth/jwtMiddleware.ts': 'export function verifyJwt() {}',
  };
  for (let i = 0; i < 60; i++) {
    files[`src/unrelated/mod${i}.ts`] = `export const v${i} = ${i};`;
  }

  const ctx = selectRelevantRepoContext('Update jwt middleware verification', files, 6, 12000);
  const topPaths = ctx.selectedFiles.map((f) => f.filePath);
  assert.equal(topPaths.includes('src/auth/jwtMiddleware.ts'), true);
  assert.equal(topPaths.includes('package.json'), true);
  assert.match(ctx.treeOverview, /src\/auth\/jwtMiddleware\.ts\s+\[exports: verifyJwt\]/);
});
