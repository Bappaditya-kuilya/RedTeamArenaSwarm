import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExplorerTree,
  collectAllFolderPaths,
  searchWorkspaceFiles,
} from './fileTree';
import type { RepoFileNode } from '../types/ide';

test('buildExplorerTree sorts folders before files and aggregates diagnostics & git badges', () => {
  const files: RepoFileNode[] = [
    { path: 'package.json', name: 'package.json', language: 'json', size: 10, lineCount: 5, diagnosticCount: 0 },
    { path: 'src/pricing.ts', name: 'pricing.ts', language: 'typescript', size: 50, lineCount: 15, diagnosticCount: 0 },
    { path: 'src/utils/validate.ts', name: 'validate.ts', language: 'typescript', size: 40, lineCount: 12, diagnosticCount: 0 },
  ];
  const diagMap = new Map<string, number>([['src/pricing.ts', 2]]);
  const tree = buildExplorerTree(files, diagMap, { 'src/utils/validate.ts': 'A' });

  assert.equal(tree[0]?.kind, 'folder');
  assert.equal(tree[0]?.name, 'src');
  if (tree[0]?.kind === 'folder') {
    assert.equal(tree[0].errorCount, 2);
    assert.equal(tree[0].hasAdded, true);
    assert.equal(tree[0].children[0]?.kind, 'folder');
    assert.equal(tree[0].children[0]?.name, 'utils');
    assert.equal(tree[0].children[1]?.kind, 'file');
    assert.equal(tree[0].children[1]?.name, 'pricing.ts');
  }
  assert.equal(tree[1]?.kind, 'file');
  assert.equal(tree[1]?.name, 'package.json');

  const folderPaths = collectAllFolderPaths(tree);
  assert.deepEqual(folderPaths, ['src', 'src/utils']);
});

test('searchWorkspaceFiles finds accurate 1-indexed line & column matches across files', () => {
  const matches = searchWorkspaceFiles(
    {
      'src/a.ts': 'export const taxRate = 0.08;\nreturn taxRate;',
      'src/b.ts': 'console.log("hello");',
    },
    'taxrate',
    false
  );

  assert.equal(matches.length, 2);
  assert.equal(matches[0].filePath, 'src/a.ts');
  assert.equal(matches[0].line, 1);
  assert.equal(matches[0].column, 14);
  assert.equal(matches[1].line, 2);
});
