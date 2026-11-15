import assert from 'node:assert/strict';
import test from 'node:test';
import { SWARM_CURSOR_PROFILES } from '../src/engine/swarmProfiles';
import type { CodeDiagnostic } from '../src/types/ide';
import { applyDeterministicTypeScriptFix, getDistinctLinesForFile } from './swarmFixer';

test('SWARM_CURSOR_PROFILES defines 20 unique cursor agents with valid hex colors', () => {
  assert.equal(SWARM_CURSOR_PROFILES.length, 20);
  const ids = new Set(SWARM_CURSOR_PROFILES.map((p) => p.id));
  const names = new Set(SWARM_CURSOR_PROFILES.map((p) => p.name));
  assert.equal(ids.size, 20);
  assert.equal(names.size, 20);
  for (const p of SWARM_CURSOR_PROFILES) {
    assert.match(p.color, /^#[0-9A-Fa-f]{6}$/);
  }
});

test('applyDeterministicTypeScriptFix repairs TS2322 string-to-number mismatches', () => {
  const diag: CodeDiagnostic = {
    id: 'ts-1',
    source: 'typescript',
    severity: 'error',
    code: 'TS2322',
    filePath: 'src/pricing.ts',
    line: 2,
    column: 9,
    title: 'TS2322 TypeScript Diagnostic',
    message: "Type 'string' is not assignable to type 'number'.",
    agentId: 'subagent-tsc',
    agentName: 'TSC',
    agentColor: '#9747FF',
    explanation: 'Numeric type expected',
    fixed: false,
  };
  const fixed = applyDeterministicTypeScriptFix("  const taxRate: number = '0.08';", diag);
  assert.equal(fixed, '  const taxRate: number = 0.08;');
});

test('getDistinctLinesForFile assigns all 20 cursors to valid lines prioritizing diagnostics', () => {
  const sample = Array.from({ length: 12 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n');
  const assigned = getDistinctLinesForFile(sample, [10, 4], 20);
  assert.equal(assigned.length, 20);
  assert.equal(assigned[0], 10);
  assert.equal(assigned[1], 4);
  for (const ln of assigned) {
    assert.ok(ln >= 1 && ln <= 12);
  }
});
