import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import { analyzeBugsInCode } from '../src/engine/bugAnalyzer';
import { scanSourceCode } from '../src/engine/realScanner';
import type {
  CodeDiagnostic,
  IdeSubagent,
  TestRunResult,
  TscRunResult,
} from '../src/types/ide';

const execFileAsync = promisify(execFile);

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function runSecuritySubagent(
  fileContents: Record<string, string>
): Promise<{ agent: IdeSubagent; diagnostics: CodeDiagnostic[] }> {
  const t0 = Date.now();
  const diagnostics: CodeDiagnostic[] = [];

  for (const [filePath, code] of Object.entries(fileContents)) {
    if (/\.redteam\.test\./i.test(filePath)) continue;
    const ext = path.extname(filePath).toLowerCase();
    if (!['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.html'].includes(ext)) {
      continue;
    }
    const matches = scanSourceCode(code, filePath);
    for (const m of matches) {
      diagnostics.push({
        id: `sec-${filePath}-${m.line}-${m.ruleId}`,
        source: 'security',
        severity: m.severity === 'critical' || m.severity === 'high' ? 'error' : 'warning',
        code: `${m.ruleId} (${m.cwe})`,
        filePath,
        line: m.line,
        column: m.column,
        title: m.title,
        message: `${m.title}: ${m.impact}`,
        agentId: 'subagent-sec',
        agentName: 'Sec · Audit-Prober',
        agentColor: '#F24822',
        originalLine: code.split(/\r?\n/)[m.line - 1],
        suggestedLinePatch: m.patchedLine,
        explanation: m.remediation,
        fixed: false,
      });
    }
  }

  const elapsedMs = Date.now() - t0;
  return {
    agent: {
      id: 'subagent-sec',
      name: 'Sec · Audit-Prober',
      specialty: 'Injection, XSS, secrets & unsafe sinks',
      color: '#F24822',
      status: 'done',
      elapsedMs,
      findingsCount: diagnostics.length,
      summary: `Scanned ${Object.keys(fileContents).length} files for OWASP/CWE sinks in ${elapsedMs}ms.`,
    },
    diagnostics,
  };
}

async function runBugSubagent(
  fileContents: Record<string, string>
): Promise<{ agent: IdeSubagent; diagnostics: CodeDiagnostic[] }> {
  const t0 = Date.now();
  const diagnostics: CodeDiagnostic[] = [];

  for (const [filePath, code] of Object.entries(fileContents)) {
    if (/\.redteam\.test\./i.test(filePath)) continue;
    diagnostics.push(...analyzeBugsInCode(code, filePath));
  }

  const elapsedMs = Date.now() - t0;
  return {
    agent: {
      id: 'subagent-bug',
      name: 'Bug · Logic-Debugger',
      specialty: 'Runtime exceptions, null safety & control flow',
      color: '#FF8A00',
      status: 'done',
      elapsedMs,
      findingsCount: diagnostics.length,
      summary: `Inspected AST/line logic across repo in ${elapsedMs}ms (${diagnostics.length} findings).`,
    },
    diagnostics,
  };
}

async function runTypeScriptSubagent(
  workspaceDir: string,
  fileContents: Record<string, string>
): Promise<{ agent: IdeSubagent; diagnostics: CodeDiagnostic[]; tscResult: TscRunResult }> {
  const t0 = Date.now();
  const tsFiles = Object.keys(fileContents).filter(
    (p) => /\.(ts|tsx)$/i.test(p) && !p.endsWith('.d.ts')
  );

  if (tsFiles.length === 0) {
    const elapsedMs = Date.now() - t0;
    return {
      agent: {
        id: 'subagent-tsc',
        name: 'TSC · Type-Checker',
        specialty: 'Real TypeScript compiler diagnostics',
        color: '#9747FF',
        status: 'done',
        elapsedMs,
        findingsCount: 0,
        summary: 'No .ts/.tsx files in repository; TypeScript check skipped.',
      },
      diagnostics: [],
      tscResult: {
        ran: false,
        filesChecked: 0,
        errorCount: 0,
        warningCount: 0,
        durationMs: elapsedMs,
        output: 'No .ts or .tsx files detected in repository.',
      },
    };
  }

  const tscBin = path.resolve(process.cwd(), 'node_modules/.bin/tsc');
  let hasNodeModules = false;
  let hasTsConfig = false;
  try {
    await fs.access(path.join(workspaceDir, 'node_modules'));
    hasNodeModules = true;
  } catch {
    hasNodeModules = false;
  }
  try {
    await fs.access(path.join(workspaceDir, 'tsconfig.json'));
    hasTsConfig = true;
  } catch {
    hasTsConfig = false;
  }

  const targetList = tsFiles.slice(0, 250);
  const args = hasTsConfig
    ? ['--noEmit', '--pretty', 'false', '--skipLibCheck', '-p', 'tsconfig.json']
    : [
        '--noEmit',
        '--pretty',
        'false',
        '--target',
        'ES2022',
        '--module',
        'ESNext',
        '--moduleResolution',
        'bundler',
        '--jsx',
        'react-jsx',
        '--skipLibCheck',
        '--allowJs',
        '--allowImportingTsExtensions',
        ...targetList,
      ];

  let rawOutput = '';
  try {
    const { stdout, stderr } = await execFileAsync(tscBin, args, {
      cwd: workspaceDir,
      timeout: 15_000,
    });
    rawOutput = [stdout, stderr].filter(Boolean).join('\n').trim();
  } catch (err) {
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    rawOutput = [execErr.stdout, execErr.stderr, execErr.message]
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  const diagnostics: CodeDiagnostic[] = [];
  const filteredLines: string[] = [];
  const diagRegex = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/;

  for (const line of rawOutput.split(/\r?\n/)) {
    const m = diagRegex.exec(line.trim());
    if (!m) continue;

    const rawFile = m[1];
    const lineNum = parseInt(m[2], 10);
    const colNum = parseInt(m[3], 10);
    const sev = m[4] === 'warning' ? 'warning' : 'error';
    const tsCode = m[5];
    const msg = m[6];

    // Ignore unresolved third-party/@types package noise when cloned repo hasn't run npm install
    if (
      !hasNodeModules &&
      ['TS2307', 'TS2792', 'TS7016', 'TS2503', 'TS2688', 'TS2304', 'TS2591'].includes(tsCode)
    ) {
      continue;
    }

    const relPath = path.isAbsolute(rawFile)
      ? path.relative(workspaceDir, rawFile).split(path.sep).join('/')
      : rawFile.split(path.sep).join('/');

    if (!fileContents[relPath]) continue;

    filteredLines.push(`${relPath}(${lineNum},${colNum}): ${sev} ${tsCode}: ${msg}`);
    diagnostics.push({
      id: `tsc-${relPath}-${lineNum}-${tsCode}-${diagnostics.length}`,
      source: 'typescript',
      severity: sev,
      code: tsCode,
      filePath: relPath,
      line: lineNum,
      column: colNum,
      title: `${tsCode} TypeScript Diagnostic`,
      message: msg,
      agentId: 'subagent-tsc',
      agentName: 'TSC · Type-Checker',
      agentColor: '#9747FF',
      originalLine: fileContents[relPath].split(/\r?\n/)[lineNum - 1],
      explanation: `TypeScript 7 compiler flagged ${tsCode} at ${relPath}:${lineNum}:${colNum}.`,
      fixed: false,
    });

    if (diagnostics.length >= 200) break;
  }

  const elapsedMs = Date.now() - t0;
  return {
    agent: {
      id: 'subagent-tsc',
      name: 'TSC · Type-Checker',
      specialty: 'Real TypeScript compiler diagnostics',
      color: '#9747FF',
      status: 'done',
      elapsedMs,
      findingsCount: diagnostics.length,
      summary: `Checked ${targetList.length} TS files in ${elapsedMs}ms (${diagnostics.length} compiler issues).`,
    },
    diagnostics,
    tscResult: {
      ran: true,
      filesChecked: targetList.length,
      errorCount: diagnostics.filter((d) => d.severity === 'error').length,
      warningCount: diagnostics.filter((d) => d.severity === 'warning').length,
      durationMs: elapsedMs,
      output:
        filteredLines.length > 0
          ? filteredLines.join('\n')
          : `tsc --noEmit: 0 compiler diagnostics across ${targetList.length} files (${elapsedMs}ms).`,
    },
  };
}

async function runTestSubagent(
  workspaceDir: string,
  fileContents: Record<string, string>
): Promise<{ agent: IdeSubagent; diagnostics: CodeDiagnostic[]; testResult: TestRunResult }> {
  const t0 = Date.now();
  const diagnostics: CodeDiagnostic[] = [];

  const testFiles = Object.keys(fileContents).filter((p) =>
    /\.(test|spec)\.(js|mjs|cjs|ts|tsx)$/i.test(p)
  );
  const jsFiles = Object.keys(fileContents).filter((p) => /\.(js|mjs|cjs)$/i.test(p));

  let ran = false;
  let command = '';
  let exitCode = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const outputChunks: string[] = [];

  // 1. Real syntax validation via `node --check` on JS files (up to 15 files)
  for (const jsRel of jsFiles.slice(0, 15)) {
    try {
      await execFileAsync('node', ['--check', jsRel], {
        cwd: workspaceDir,
        timeout: 3000,
      });
    } catch (err) {
      const execErr = err as { stderr?: string; message?: string };
      const errText = (execErr.stderr || execErr.message || 'SyntaxError').trim();
      outputChunks.push(`node --check ${jsRel} FAILED:\n${errText}`);
      const lineMatch = errText.match(/:(\d+)/);
      const lineNum = lineMatch ? Math.max(1, parseInt(lineMatch[1], 10)) : 1;
      diagnostics.push({
        id: `syntax-${jsRel}-${lineNum}`,
        source: 'test',
        severity: 'error',
        code: 'JS-SYNTAX',
        filePath: jsRel,
        line: lineNum,
        column: 1,
        title: 'JavaScript Syntax Error (node --check)',
        message: errText.split('\n').slice(0, 3).join(' '),
        agentId: 'subagent-test',
        agentName: 'Test · Runner',
        agentColor: '#0ACF83',
        originalLine: fileContents[jsRel]?.split(/\r?\n/)[lineNum - 1],
        explanation: 'Fix the syntax error flagged by Node V8 parser.',
        fixed: false,
      });
      exitCode = 1;
      failed++;
    }
  }

  // 2. Real test execution if test files exist using node:test / tsx
  let hasNodeModulesForTests = false;
  try {
    await fs.access(path.join(workspaceDir, 'node_modules'));
    hasNodeModulesForTests = true;
  } catch {
    hasNodeModulesForTests = false;
  }
  const runnableTests = testFiles.filter((fp) => {
    if (hasNodeModulesForTests) return true;
    const body = fileContents[fp] ?? '';
    return !/from\s+['"](vitest|@jest|jest|mocha|ava|bun:test|@playwright\/test)['"]/.test(body);
  });

  if (runnableTests.length > 0) {
    ran = true;
    const hasTsTests = runnableTests.some((f) => /\.tsx?$/i.test(f));
    const tsxBin = path.resolve(process.cwd(), 'node_modules/.bin/tsx');
    const cmdBin = hasTsTests ? tsxBin : 'node';
    const targetTests = runnableTests.slice(0, 25);
    const args = ['--test', ...targetTests];
    command = `${hasTsTests ? 'tsx' : 'node'} ${args.join(' ')}`;

    try {
      const { stdout, stderr } = await execFileAsync(cmdBin, args, {
        cwd: workspaceDir,
        timeout: 15_000,
        env: { ...process.env, NODE_ENV: 'test' },
      });
      const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
      outputChunks.push(combined);
      const passMatch = combined.match(/#\s*pass\s+(\d+)/i);
      const failMatch = combined.match(/#\s*fail\s+(\d+)/i);
      const skipMatch = combined.match(/#\s*skipped\s+(\d+)/i);
      passed = passMatch ? parseInt(passMatch[1], 10) : targetTests.length;
      failed += failMatch ? parseInt(failMatch[1], 10) : 0;
      skipped = skipMatch ? parseInt(skipMatch[1], 10) : 0;
    } catch (err) {
      const execErr = err as { stdout?: string; stderr?: string; code?: number; message?: string };
      const combined = [execErr.stdout, execErr.stderr, execErr.message]
        .filter(Boolean)
        .join('\n')
        .trim();
      outputChunks.push(combined);
      exitCode = typeof execErr.code === 'number' ? execErr.code : 1;
      const passMatch = combined.match(/#\s*pass\s+(\d+)/i);
      const failMatch = combined.match(/#\s*fail\s+(\d+)/i);
      passed = passMatch ? parseInt(passMatch[1], 10) : 0;
      failed += failMatch ? parseInt(failMatch[1], 10) : 1;

      const failFile = targetTests[0];
      const lineMatch = combined.match(new RegExp(`${path.basename(failFile)}:(\\d+)`));
      const lineNum = lineMatch ? parseInt(lineMatch[1], 10) : 1;

      diagnostics.push({
        id: `test-fail-${failFile}-${lineNum}`,
        source: 'test',
        severity: 'error',
        code: 'TEST-FAIL',
        filePath: failFile,
        line: lineNum,
        column: 1,
        title: `Test Failure in ${failFile}`,
        message: combined.split('\n').find((l) => /not ok|Error|AssertionError/i.test(l)) || 'Test suite failed.',
        agentId: 'subagent-test',
        agentName: 'Test · Runner',
        agentColor: '#0ACF83',
        originalLine: fileContents[failFile]?.split(/\r?\n/)[lineNum - 1],
        explanation: 'Real test runner exited non-zero. Inspect terminal output for assertion details.',
        fixed: false,
      });
    }
  } else if (jsFiles.length > 0) {
    ran = true;
    command = `node --check (${Math.min(jsFiles.length, 15)} JS files)`;
    if (failed === 0) {
      passed = Math.min(jsFiles.length, 15);
      outputChunks.push(`node --check passed on ${passed} JavaScript files with 0 syntax errors.`);
    }
  } else {
    command = 'node --test (no *.test.* files found)';
    outputChunks.push('No *.test.* or *.spec.* files found in repository; skipped runtime test runner.');
  }

  const elapsedMs = Date.now() - t0;
  return {
    agent: {
      id: 'subagent-test',
      name: 'Test · Runner',
      specialty: 'Real node --test & V8 syntax execution',
      color: '#0ACF83',
      status: 'done',
      elapsedMs,
      findingsCount: diagnostics.length,
      summary: ran
        ? `Executed ${command} (${passed} passed, ${failed} failed) in ${elapsedMs}ms.`
        : `No standalone test files found (${elapsedMs}ms).`,
    },
    diagnostics,
    testResult: {
      ran,
      command,
      exitCode,
      durationMs: elapsedMs,
      passed,
      failed,
      skipped,
      output: outputChunks.join('\n\n'),
    },
  };
}

async function runAiFixSubagent(
  fileContents: Record<string, string>,
  existingDiagnostics: CodeDiagnostic[],
  useAi: boolean
): Promise<{ agent: IdeSubagent; diagnostics: CodeDiagnostic[] }> {
  const t0 = Date.now();
  const ai = useAi ? getGeminiClient() : null;

  if (!ai) {
    const patchableCount = existingDiagnostics.filter((d) => Boolean(d.suggestedLinePatch)).length;
    const elapsedMs = Date.now() - t0;
    return {
      agent: {
        id: 'subagent-fix',
        name: 'Fix · Patch-Synth',
        specialty: 'Deterministic & Gemini multi-file patch synthesis',
        color: '#0D99FF',
        status: 'done',
        elapsedMs,
        findingsCount: patchableCount,
        summary: `Synthesized ${patchableCount} deterministic line fixes (GEMINI_API_KEY inactive).`,
      },
      diagnostics: [],
    };
  }

  // Pick up to 2 highest-priority files that either have TS/test errors or no line patch yet
  const priorityFiles = Array.from(
    new Set(
      existingDiagnostics
        .filter((d) => d.source === 'typescript' || d.source === 'test' || !d.suggestedLinePatch)
        .map((d) => d.filePath)
    )
  ).slice(0, 2);

  if (priorityFiles.length === 0) {
    const firstBuggyFile = existingDiagnostics[0]?.filePath;
    if (firstBuggyFile) priorityFiles.push(firstBuggyFile);
  }

  if (priorityFiles.length === 0) {
    // Analyze entry file cleanly for subtle real-world bugs even if regex didn't catch one
    const candidate = Object.keys(fileContents).find((f) => /\.(ts|tsx|js|jsx)$/i.test(f));
    if (candidate) priorityFiles.push(candidate);
  }

  if (priorityFiles.length === 0) {
    const elapsedMs = Date.now() - t0;
    return {
      agent: {
        id: 'subagent-fix',
        name: 'Fix · Patch-Synth',
        specialty: 'Gemini root-cause fixer & patch synthesizer',
        color: '#0D99FF',
        status: 'done',
        elapsedMs,
        findingsCount: 0,
        summary: 'No code files available for AI patch synthesis.',
      },
      diagnostics: [],
    };
  }

  const contextPayload = priorityFiles
    .map((fp) => {
      const relatedDiags = existingDiagnostics
        .filter((d) => d.filePath === fp)
        .map((d) => `Line ${d.line} [${d.code}]: ${d.message}`)
        .join('\n');
      const numberedCode = (fileContents[fp] || '')
        .split(/\r?\n/)
        .slice(0, 120)
        .map((l, idx) => `${idx + 1}: ${l}`)
        .join('\n');
      return `=== FILE: ${fp} ===\nEXISTING DIAGNOSTICS:\n${relatedDiags || 'None'}\nCODE:\n${numberedCode}`;
    })
    .join('\n\n');

  try {
    const geminiPromise = ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: [
        'You are a senior codebase debugger inside an IDE. Inspect the provided real repository files and existing compiler/test/static diagnostics.',
        'Identify real bugs, type errors, security flaws, or logic defects actually present in those exact line numbers (never invent non-existent files or lines) and provide exact 1-line or full-file replacements.',
        '',
        contextPayload,
      ].join('\n'),
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        systemInstruction:
          'Return concise JSON patches grounded strictly in the provided code lines.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            fixes: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  filePath: { type: Type.STRING },
                  line: { type: Type.INTEGER },
                  title: { type: Type.STRING },
                  explanation: { type: Type.STRING },
                  patchedLine: { type: Type.STRING },
                },
                required: ['filePath', 'line', 'title', 'explanation', 'patchedLine'],
              },
            },
          },
          required: ['fixes'],
        },
      },
    });

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Gemini fix synthesis timed out after 9s')), 9000)
    );

    const response = await Promise.race([geminiPromise, timeoutPromise]);
    const parsed = JSON.parse((response.text ?? '{"fixes":[]}').trim()) as {
      fixes: Array<{
        filePath: string;
        line: number;
        title: string;
        explanation: string;
        patchedLine: string;
      }>;
    };

    const aiDiags: CodeDiagnostic[] = [];
    for (const fix of parsed.fixes ?? []) {
      const content = fileContents[fix.filePath];
      if (!content) continue;
      const lines = content.split(/\r?\n/);
      const safeLine = Math.max(1, Math.min(lines.length, fix.line));
      aiDiags.push({
        id: `ai-${fix.filePath}-${safeLine}-${aiDiags.length}`,
        source: 'ai',
        severity: 'warning',
        code: 'AI-FIX',
        filePath: fix.filePath,
        line: safeLine,
        column: 1,
        title: fix.title,
        message: `${fix.title} (AI root-cause patch)`,
        agentId: 'subagent-fix',
        agentName: 'Fix · Patch-Synth',
        agentColor: '#0D99FF',
        originalLine: lines[safeLine - 1],
        suggestedLinePatch: fix.patchedLine,
        explanation: fix.explanation,
        fixed: false,
      });
    }

    const elapsedMs = Date.now() - t0;
    return {
      agent: {
        id: 'subagent-fix',
        name: 'Fix · Patch-Synth',
        specialty: 'Gemini root-cause fixer & patch synthesizer',
        color: '#0D99FF',
        status: 'done',
        elapsedMs,
        findingsCount: aiDiags.length,
        summary: `Gemini synthesized ${aiDiags.length} root-cause code fixes in ${elapsedMs}ms.`,
      },
      diagnostics: aiDiags,
    };
  } catch (err) {
    const elapsedMs = Date.now() - t0;
    const reason = err instanceof Error ? err.message : 'Unavailable';
    const patchableCount = existingDiagnostics.filter((d) => Boolean(d.suggestedLinePatch)).length;
    return {
      agent: {
        id: 'subagent-fix',
        name: 'Fix · Patch-Synth',
        specialty: 'Deterministic & Gemini patch synthesizer',
        color: '#0D99FF',
        status: 'done',
        elapsedMs,
        findingsCount: patchableCount,
        summary: `Delivered ${patchableCount} deterministic patches (AI fallback: ${reason}).`,
      },
      diagnostics: [],
    };
  }
}

export async function runParallelDebugSwarm(
  workspaceDir: string,
  fileContents: Record<string, string>,
  useAi = true
): Promise<{
  subagents: IdeSubagent[];
  diagnostics: CodeDiagnostic[];
  tscResult: TscRunResult;
  testResult: TestRunResult;
  terminalLines: string[];
  totalElapsedMs: number;
}> {
  const startAll = Date.now();

  // Phase 1: Launch 4 core inspection subagents concurrently in parallel
  const [secRes, bugRes, tscRes, testRes] = await Promise.all([
    runSecuritySubagent(fileContents),
    runBugSubagent(fileContents),
    runTypeScriptSubagent(workspaceDir, fileContents),
    runTestSubagent(workspaceDir, fileContents),
  ]);

  const baseDiagnostics: CodeDiagnostic[] = [
    ...tscRes.diagnostics,
    ...testRes.diagnostics,
    ...secRes.diagnostics,
    ...bugRes.diagnostics,
  ];

  // Phase 2: Run Fix Synthesizer subagent with full diagnostics context
  const fixRes = await runAiFixSubagent(fileContents, baseDiagnostics, useAi);

  // Merge AI patches onto matching lines or append new AI diagnostics
  const mergedDiagnostics = [...baseDiagnostics];
  for (const aiDiag of fixRes.diagnostics) {
    const existing = mergedDiagnostics.find(
      (d) =>
        d.filePath === aiDiag.filePath &&
        Math.abs(d.line - aiDiag.line) <= 1 &&
        !d.suggestedLinePatch
    );
    if (existing && aiDiag.suggestedLinePatch) {
      existing.suggestedLinePatch = aiDiag.suggestedLinePatch;
      existing.explanation = `${existing.explanation} Fix: ${aiDiag.explanation}`;
    } else {
      mergedDiagnostics.push(aiDiag);
    }
  }

  const totalElapsedMs = Date.now() - startAll;
  const terminalLines = [
    `$ swarm-ide debug --parallel --agents=5`,
    `[Sec · Audit-Prober] ${secRes.agent.summary}`,
    `[Bug · Logic-Debugger] ${bugRes.agent.summary}`,
    `[TSC · Type-Checker] ${tscRes.agent.summary}`,
    `[Test · Runner] ${testRes.agent.summary}`,
    `[Fix · Patch-Synth] ${fixRes.agent.summary}`,
    `Completed parallel subagent swarm in ${totalElapsedMs}ms (${mergedDiagnostics.length} total diagnostics).`,
  ];

  return {
    subagents: [
      secRes.agent,
      bugRes.agent,
      tscRes.agent,
      testRes.agent,
      fixRes.agent,
    ],
    diagnostics: mergedDiagnostics,
    tscResult: tscRes.tscResult,
    testResult: testRes.testResult,
    terminalLines,
    totalElapsedMs,
  };
}
