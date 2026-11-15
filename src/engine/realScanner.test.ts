import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPatchedCodeFromFindings,
  generateSarifReport,
  generateUnifiedDiff,
  scanSourceCode,
} from './realScanner';

test('scanSourceCode detects SQLi, XSS, Open Redirect, and Hardcoded Secrets with accurate line numbers', () => {
  const sample = [
    "const API_SECRET = 'sk_live_9988776655443322';",
    'app.get("/user", async (req, res) => {',
    '  const rows = await db.query("SELECT * FROM users WHERE id = " + req.query.id);',
    '  previewEl.innerHTML = req.query.bio;',
    '  res.redirect(req.query.next);',
    '});',
  ].join('\n');

  const findings = scanSourceCode(sample, 'routes/user.ts');
  const cwes = new Set(findings.map((f) => f.cwe));

  assert.ok(cwes.has('CWE-798'), 'Expected CWE-798 hardcoded secret');
  assert.ok(cwes.has('CWE-89'), 'Expected CWE-89 SQL injection');
  assert.ok(cwes.has('CWE-79'), 'Expected CWE-79 DOM XSS');
  assert.ok(cwes.has('CWE-601'), 'Expected CWE-601 Open Redirect');

  const sqli = findings.find((f) => f.cwe === 'CWE-89');
  assert.equal(sqli?.line, 3);
});

test('buildPatchedCodeFromFindings and generateUnifiedDiff emit valid unified patch format', () => {
  const original = `previewEl.innerHTML = req.query.note;\nres.redirect(req.query.next);`;
  const findings = scanSourceCode(original, 'checkout.ts');
  const patched = buildPatchedCodeFromFindings(original, findings);
  const diff = generateUnifiedDiff('checkout.ts', original, patched);

  assert.ok(diff.includes('--- a/checkout.ts'));
  assert.ok(diff.includes('+++ b/checkout.ts'));
  assert.ok(diff.includes('-previewEl.innerHTML = req.query.note;'));
  assert.ok(diff.includes('+previewEl.textContent = escapeHtml(req.query.note);'));
  assert.ok(diff.includes('isSafeRelativePath'));

  const withAddedImport = generateUnifiedDiff(
    'app.ts',
    'const x = 1;\nconst y = 2;\nconst z = 3;',
    "import { guard } from './guard';\nconst x = 1;\nconst y = 99;\nconst z = 3;"
  );
  assert.ok(withAddedImport.includes(' const x = 1;'));
  assert.ok(withAddedImport.includes('-const y = 2;'));
  assert.ok(withAddedImport.includes('+const y = 99;'));
  assert.ok(withAddedImport.includes(' const z = 3;'));
});

test('generateSarifReport conforms to SARIF 2.1.0 structure', () => {
  const sarif = generateSarifReport('FinPay', 'src/routes/checkout.ts', [
    {
      id: 'fp-xss',
      ruleId: 'RTA-XSS-002',
      title: 'Reflected DOM XSS',
      cwe: 'CWE-79',
      severity: 'critical',
      line: 14,
      impactSummary: 'Unsanitized innerHTML assignment.',
    },
  ]);

  assert.equal(sarif.version, '2.1.0');
  assert.equal(sarif.runs.length, 1);
  assert.equal(sarif.runs[0].results[0].ruleId, 'RTA-XSS-002');
  assert.equal(sarif.runs[0].results[0].level, 'error');
  assert.equal(sarif.runs[0].results[0].locations[0].physicalLocation.region.startLine, 14);
});
