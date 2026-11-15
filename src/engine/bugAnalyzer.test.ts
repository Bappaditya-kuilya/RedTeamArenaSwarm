import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeBugsInCode,
  applyAllFixesToFiles,
  applyDiagnosticFixToContent,
} from './bugAnalyzer.ts';

test('analyzeBugsInCode finds real logic defects and synthesizes line fixes', () => {
  const code = [
    'export function parseUser(raw: string, age: string) {',
    '  const num = parseInt(age);',
    '  if (num == 0) throw "Invalid age";',
    '  try { return JSON.parse(raw); } catch (err) {}',
    '}',
  ].join('\n');

  const findings = analyzeBugsInCode(code, 'src/user.ts');
  const codes = findings.map((f) => f.code);
  assert.ok(codes.includes('BUG-PARSEINT-RADIX'));
  assert.ok(codes.includes('BUG-LOOSE-EQ'));
  assert.ok(codes.includes('BUG-THROW-LITERAL'));
  assert.ok(codes.includes('BUG-EMPTY-CATCH'));

  const parseIntDiag = findings.find((f) => f.code === 'BUG-PARSEINT-RADIX')!;
  const patched = applyDiagnosticFixToContent(code, parseIntDiag);
  assert.ok(patched.includes('parseInt(age, 10)'));
});

test('applyAllFixesToFiles patches multiple findings in a file cleanly', () => {
  const original = [
    'const n = parseInt(x);',
    'debugger;',
    'if (a == b) throw "mismatch";',
  ].join('\n');
  const findings = analyzeBugsInCode(original, 'app.ts');
  const { updatedFiles, appliedIds } = applyAllFixesToFiles(
    { 'app.ts': original },
    findings
  );

  assert.ok(appliedIds.size >= 3);
  assert.ok(updatedFiles['app.ts'].includes('parseInt(x, 10)'));
  assert.ok(updatedFiles['app.ts'].includes('a === b'));
  assert.ok(updatedFiles['app.ts'].includes('throw new Error("mismatch")'));
});

test('BUG-UNSAFE-JSON-PARSE synthesizes a valid try/catch inline wrapper', () => {
  const code = 'const parsed = JSON.parse(rawJson);';
  const findings = analyzeBugsInCode(code, 'src/users.ts');
  const jsonDiag = findings.find((f) => f.code === 'BUG-UNSAFE-JSON-PARSE');
  assert.ok(jsonDiag?.suggestedLinePatch);
  const patched = applyDiagnosticFixToContent(code, jsonDiag!);
  assert.ok(patched.includes('try { return JSON.parse(rawJson); } catch { return null; }'));
});

