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

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function resolveBin(workspaceDir: string, name: 'tsc' | 'tsx'): Promise<string> {
  const local = path.join(workspaceDir, 'node_modules', '.bin', name);
  if (await pathExists(local)) return local;
  return path.resolve(process.cwd(), 'node_modules', '.bin', name);
}

function hasExternalTestFramework(code: string): string | null {
  const m = code.match(/from\s+['"](vitest|@jest\/globals|jest|mocha|ava|bun:test|@playwright\/test)['"]/);
  return m ? m[1] : null;
}

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
    const lines = code.split(/\r?\n/);
    const matches = scanSourceCode(code, filePath);
    for (const m of matches) {
      const matchedLine = lines[m.line - 1] ?? m.matchedLine;
      const patch = m.patchedLine;
      const functionalPatch =
        matchedLine !== undefined &&
        patch !== matchedLine &&
        !patch.trim().startsWith('//') &&
        !/^\/\*[\s\S]*\*\/$/.test(patch.trim()) &&
        !(/TODO|FIXME/i.test(patch) && /\/[/*]/.test(patch));
      diagnostics.push({
        id: `sec-${filePath}-${m.line}-${m.ruleId}`,
        source: 'security',
        severity: m.severity === 'critical' || m.severity === 'high' ? 'error' : 'warning',
        code: `${m.ruleId} (${m.cwe})`,
        filePath,
        line: m.line,
        column: m.column,
        title: `[Heuristic] ${m.title}`,
        message: `Heuristic pattern finding (${m.ruleId}, ${m.severity}): ${m.impact}`,
        agentId: 'subagent-sec',
        agentName: 'Sec · Audit-Prober',
        agentColor: '#F24822',
        originalLine: matchedLine,
        suggestedLinePatch: functionalPatch ? patch : undefined,
        explanation: `Evidence: rule ${m.ruleId} (${m.cwe}) matched ${filePath}:${m.line}${matchedLine ? `: ${matchedLine.trim()}` : ''}. ${m.remediation}`,
        fixed: false,
      });
    }
  }

  const elapsedMs = Date.now() - t0;
  return {
    agent: {
      id: 'subagent-sec',
      name: 'Sec · Audit-Prober',
      specialty: 'Heuristic OWASP/CWE pattern scan (not proof of exploitability)',
      color: '#F24822',
      status: 'done',
      elapsedMs,
      findingsCount: diagnostics.length,
      summary: `Heuristic scan: ${diagnostics.length} pattern findings across ${Object.keys(fileContents).length} files in ${elapsedMs}ms.`,
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
    for (const d of analyzeBugsInCode(code, filePath)) {
      diagnostics.push({
        ...d,
        title: `[Heuristic] ${d.title}`,
        message: `Heuristic pattern finding (${d.code}): ${d.title} at ${filePath}:${d.line}`,
        explanation: `Evidence: rule ${d.code} matched ${filePath}:${d.line}${d.originalLine ? `: ${d.originalLine.trim()}` : ''}. ${d.explanation}`,
      });
    }
  }

  const elapsedMs = Date.now() - t0;
  return {
    agent: {
      id: 'subagent-bug',
      name: 'Bug · Logic-Debugger',
      specialty: 'Heuristic runtime/logic pattern scan (not compiler-verified)',
      color: '#FF8A00',
      status: 'done',
      elapsedMs,
      findingsCount: diagnostics.length,
      summary: `Heuristic bug scan: ${diagnostics.length} pattern findings in ${elapsedMs}ms.`,
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
        summary: 'No .ts/.tsx files; TypeScript check skipped.',
      },
      diagnostics: [],
      tscResult: {
        ran: false,
        filesChecked: 0,
        errorCount: 0,
        warningCount: 0,
        durationMs: elapsedMs,
        output: 'Skipped: no .ts/.tsx source files found in workspace snapshot.',
      },
    };
  }

  const tscBin = await resolveBin(workspaceDir, 'tsc');
  const hasNodeModules = await pathExists(path.join(workspaceDir, 'node_modules'));
  const hasTsConfig = await pathExists(path.join(workspaceDir, 'tsconfig.json'));
  const usingLocalTsc = tscBin.startsWith(workspaceDir + path.sep);
  const targetList = tsFiles.slice(0, 250);
  const fileCapNote = tsFiles.length > targetList.length ? ` (capped ${targetList.length}/${tsFiles.length} files)` : '';

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
      timeout: 20_000,
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
  const reportedLines: string[] = [];
  const diagRegex = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/;
  const missingDepCodes = new Set(['TS2307', 'TS2792', 'TS7016', 'TS2503', 'TS2688', 'TS2304', 'TS2591']);
  let suppressedOutOfSnapshot = 0;

  for (const line of rawOutput.split(/\r?\n/)) {
    const m = diagRegex.exec(line.trim());
    if (!m) continue;

    const rawFile = m[1];
    const lineNum = parseInt(m[2], 10);
    const colNum = parseInt(m[3], 10);
    const sev = m[4] === 'warning' ? 'warning' : 'error';
    const tsCode = m[5];
    const msg = m[6];

    const relPath = path.isAbsolute(rawFile)
      ? path.relative(workspaceDir, rawFile).split(path.sep).join('/')
      : rawFile.split(path.sep).join('/');
    let originalLine: string | undefined = fileContents[relPath]?.split(/\r?\n/)[lineNum - 1];
    if (originalLine === undefined) {
      const abs = path.resolve(workspaceDir, relPath);
      const inWorkspace = abs === workspaceDir || abs.startsWith(workspaceDir + path.sep);
      if (!inWorkspace) {
        suppressedOutOfSnapshot++;
        continue;
      }
      try {
        const diskText = await fs.readFile(abs, 'utf-8');
        originalLine = diskText.split(/\r?\n/)[lineNum - 1];
      } catch {
        originalLine = undefined;
      }
    }

    const missingDepLikely = !hasNodeModules && missingDepCodes.has(tsCode);
    const note = missingDepLikely ? ' (workspace deps not installed; likely missing dependency/type resolution)' : '';
    const outsideSnapshotNote = !fileContents[relPath] ? ' [reported from workspace file outside snapshot]' : '';
    reportedLines.push(`${relPath}(${lineNum},${colNum}): ${sev} ${tsCode}: ${msg}${note}${outsideSnapshotNote}`);
    diagnostics.push({
      id: `tsc-${relPath}-${lineNum}-${tsCode}-${diagnostics.length}`,
      source: 'typescript',
      severity: sev,
      code: tsCode,
      filePath: relPath,
      line: lineNum,
      column: colNum,
      title: `Verified compiler: ${tsCode}`,
      message: `${msg}${note}${outsideSnapshotNote}`,
      agentId: 'subagent-tsc',
      agentName: 'TSC · Type-Checker',
      agentColor: '#9747FF',
      originalLine,
      explanation: `Verified by running real tsc (${usingLocalTsc ? 'workspace bin' : 'host bin'}) in ${workspaceDir}${hasTsConfig ? ' with tsconfig.json' : ' with fallback compiler options'}${note}${outsideSnapshotNote}.`,
      fixed: false,
    });
    if (diagnostics.length >= 250) break;
  }

  const elapsedMs = Date.now() - t0;
  const limitationNotes = [
    `ran real tsc (${usingLocalTsc ? 'workspace' : 'host'} bin)`,
    hasTsConfig ? 'used tsconfig.json' : 'no tsconfig.json (fallback options)',
    hasNodeModules ? 'node_modules present' : 'node_modules missing: module/type resolution may be incomplete',
    fileCapNote ? `file cap${fileCapNote}` : null,
    suppressedOutOfSnapshot ? `${suppressedOutOfSnapshot} diagnostics outside workspace omitted` : null,
  ].filter(Boolean);
  const header = `tsc --noEmit: ${diagnostics.length} diagnostics, ${limitationNotes.join('; ')} (${elapsedMs}ms).`;
  return {
    agent: {
      id: 'subagent-tsc',
      name: 'TSC · Type-Checker',
      specialty: 'Real TypeScript compiler diagnostics',
      color: '#9747FF',
      status: 'done',
      elapsedMs,
      findingsCount: diagnostics.length,
      summary: `Verified tsc run: ${diagnostics.length} issues in ${elapsedMs}ms${!hasNodeModules ? ' (deps not installed)' : ''}.`,
    },
    diagnostics,
    tscResult: {
      ran: true,
      filesChecked: hasTsConfig ? tsFiles.length : targetList.length,
      errorCount: diagnostics.filter((d) => d.severity === 'error').length,
      warningCount: diagnostics.filter((d) => d.severity === 'warning').length,
      durationMs: elapsedMs,
      output: [header, ...(reportedLines.length > 0 ? reportedLines : ['No compiler diagnostics in workspace snapshot files.'])].join('\n'),
    },
  };
}

async function detectPackageManagerForTests(workspaceDir: string): Promise<'npm' | 'pnpm' | 'yarn' | 'bun' | null> {
  const checks: Array<['npm' | 'pnpm' | 'yarn' | 'bun', string[]]> = [
    ['pnpm', ['pnpm-lock.yaml']],
    ['yarn', ['yarn.lock']],
    ['bun', ['bun.lockb', 'bun.lock']],
    ['npm', ['package-lock.json', 'npm-shrinkwrap.json']],
  ];
  for (const [pm, lockfiles] of checks) {
    for (const lf of lockfiles) {
      if (await pathExists(path.join(workspaceDir, lf))) return pm;
    }
  }
  return (await pathExists(path.join(workspaceDir, 'package.json'))) ? 'npm' : null;
}

function projectTestCommand(pm: 'npm' | 'pnpm' | 'yarn' | 'bun'): { cmd: string; args: string[]; label: string } {
  if (pm === 'yarn') return { cmd: 'yarn', args: ['run', 'test'], label: 'yarn run test' };
  if (pm === 'pnpm') return { cmd: 'pnpm', args: ['run', 'test'], label: 'pnpm run test' };
  if (pm === 'bun') return { cmd: 'bun', args: ['run', 'test'], label: 'bun run test' };
  return { cmd: 'npm', args: ['run', 'test', '--if-present'], label: 'npm run test --if-present' };
}

async function runTestSubagent(
  workspaceDir: string,
  fileContents: Record<string, string>
): Promise<{ agent: IdeSubagent; diagnostics: CodeDiagnostic[]; testResult: TestRunResult }> {
  const t0 = Date.now();
  const diagnostics: CodeDiagnostic[] = [];

  const testFiles = Object.keys(fileContents).filter((p) => /\.(test|spec)\.(js|mjs|cjs|ts|tsx)$/i.test(p));
  const jsFiles = Object.keys(fileContents).filter((p) => /\.(js|mjs|cjs)$/i.test(p));
  const jsCheckCap = 20;
  const testCap = 25;

  let ran = false;
  let command = '';
  let exitCode = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const outputChunks: string[] = [];
  const limitations: string[] = [];

  // 1. Real syntax validation via `node --check` on JS files
  for (const jsRel of jsFiles.slice(0, jsCheckCap)) {
    try {
      await execFileAsync('node', ['--check', jsRel], { cwd: workspaceDir, timeout: 4000 });
      outputChunks.push(`node --check ${jsRel}: ok`);
    } catch (err) {
      const execErr = err as { stderr?: string; message?: string };
      const errText = (execErr.stderr || execErr.message || 'SyntaxError').trim();
      outputChunks.push(`node --check ${jsRel}: FAIL\n${errText}`);
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
        title: 'Verified syntax error (node --check)',
        message: errText.split('\n').slice(0, 3).join(' '),
        agentId: 'subagent-test',
        agentName: 'Test · Runner',
        agentColor: '#0ACF83',
        originalLine: fileContents[jsRel]?.split(/\r?\n/)[lineNum - 1],
        explanation: 'Verified by running `node --check` in workspace; V8 parser reported a syntax error.',
        fixed: false,
      });
      exitCode = 1;
      failed++;
    }
  }
  if (jsFiles.length > jsCheckCap) limitations.push(`node --check capped at ${jsCheckCap}/${jsFiles.length} JS files`);

  // 2. Real test discovery/execution
  const hasNodeModules = await pathExists(path.join(workspaceDir, 'node_modules'));
  const tsxBin = await resolveBin(workspaceDir, 'tsx');
  const hasTsxBin = await pathExists(tsxBin);
  const runnableTests: string[] = [];
  const skippedReasons: string[] = [];

  for (const fp of testFiles) {
    const body = fileContents[fp] ?? '';
    const framework = hasExternalTestFramework(body);
    if (framework && !hasNodeModules) {
      skippedReasons.push(`${fp}: skipped (${framework} test runner/framework; workspace deps not installed)`);
      continue;
    }
    if (/\.tsx?$/i.test(fp) && !hasTsxBin) {
      skippedReasons.push(`${fp}: skipped (TS test requires tsx; tsx not available)`);
      continue;
    }
    runnableTests.push(fp);
  }
  if (testFiles.length > testCap) limitations.push(`test execution capped at ${testCap}/${testFiles.length} discovered tests`);
  if (skippedReasons.length) outputChunks.push(`Skipped tests:\n${skippedReasons.join('\n')}`);

  let projectTestRan = false;
  let projectTestScript: string | undefined;
  try {
    const pkgRaw = await fs.readFile(path.join(workspaceDir, 'package.json'), 'utf-8');
    const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };
    projectTestScript = pkg.scripts?.test?.trim();
  } catch {
    projectTestScript = undefined;
  }
  const hasRealProjectTestScript = Boolean(
    projectTestScript &&
      !/^echo\s+["']?\s*error\s*:?\s*no test specified/i.test(projectTestScript) &&
      projectTestScript !== 'exit 1'
  );
  if (hasRealProjectTestScript && hasNodeModules) {
    const pm = await detectPackageManagerForTests(workspaceDir);
    if (pm) {
      const spec = projectTestCommand(pm);
      ran = true;
      projectTestRan = true;
      command = spec.label;
      try {
        const { stdout, stderr } = await execFileAsync(spec.cmd, spec.args, {
          cwd: workspaceDir,
          timeout: 45_000,
          maxBuffer: 2 * 1024 * 1024,
          env: { ...process.env, NODE_ENV: 'test', CI: '1' },
        });
        const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
        outputChunks.push(`$ ${command} (package.json scripts.test)\n${combined || '(no output)'}`);
        const passMatch = combined.match(/#\s*pass\s+(\d+)/i);
        const failMatch = combined.match(/#\s*fail\s+(\d+)/i);
        const skipMatch = combined.match(/#\s*skip(?:ped)?\s+(\d+)/i);
        passed = passMatch ? parseInt(passMatch[1], 10) : (combined ? 0 : 0);
        failed += failMatch ? parseInt(failMatch[1], 10) : 0;
        skipped = skipMatch ? parseInt(skipMatch[1], 10) : 0;
        if (!passMatch && !failMatch && /pass/i.test(combined) && !/fail/i.test(combined)) {
          limitations.push('project test script ran; pass/fail counts not parsed from output');
        }
      } catch (err) {
        const execErr = err as { stdout?: string; stderr?: string; code?: number; message?: string };
        const combined = [execErr.stdout, execErr.stderr, execErr.message].filter(Boolean).join('\n').trim();
        outputChunks.push(`$ ${command} (package.json scripts.test)\n${combined || '(no output)'}`);
        exitCode = typeof execErr.code === 'number' ? execErr.code : 1;
        const passMatch = combined.match(/#\s*pass\s+(\d+)/i);
        const failMatch = combined.match(/#\s*fail\s+(\d+)/i);
        const skipMatch = combined.match(/#\s*skip(?:ped)?\s+(\d+)/i);
        passed = passMatch ? parseInt(passMatch[1], 10) : 0;
        failed += failMatch ? parseInt(failMatch[1], 10) : 1;
        skipped = skipMatch ? parseInt(skipMatch[1], 10) : 0;
        diagnostics.push({
          id: `test-script-fail`,
          source: 'test',
          severity: 'error',
          code: 'TEST-FAIL',
          filePath: 'package.json',
          line: 1,
          column: 1,
          title: 'Verified project test script failure',
          message: combined.split('\n').find((l) => /not ok|Error|AssertionError|FAIL/i.test(l)) || 'Project test script exited non-zero.',
          agentId: 'subagent-test',
          agentName: 'Test · Runner',
          agentColor: '#0ACF83',
          originalLine: projectTestScript,
          explanation: `Verified by running \`${command}\` in workspace (real project test script).`,
          fixed: false,
        });
      }
    } else {
      limitations.push('package.json has a test script but package manager could not be detected');
    }
  } else if (hasRealProjectTestScript && !hasNodeModules) {
    limitations.push('package.json has a test script but workspace node_modules missing');
  }

  if (!projectTestRan && runnableTests.length > 0) {
    ran = true;
    const targetTests = runnableTests.slice(0, testCap);
    const hasTsTests = targetTests.some((f) => /\.tsx?$/i.test(f));
    const cmdBin = hasTsTests ? tsxBin : 'node';
    const args = ['--test', ...targetTests];
    command = `${hasTsTests ? 'tsx' : 'node'} ${args.join(' ')}`;
    try {
      const { stdout, stderr } = await execFileAsync(cmdBin, args, {
        cwd: workspaceDir,
        timeout: 20_000,
        env: { ...process.env, NODE_ENV: 'test' },
      });
      const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
      outputChunks.push(`$ ${command}\n${combined || '(no output)'}`);
      const passMatch = combined.match(/#\s*pass\s+(\d+)/i);
      const failMatch = combined.match(/#\s*fail\s+(\d+)/i);
      const skipMatch = combined.match(/#\s*skip(?:ped)?\s+(\d+)/i);
      passed = passMatch ? parseInt(passMatch[1], 10) : 0;
      failed += failMatch ? parseInt(failMatch[1], 10) : 0;
      skipped = skipMatch ? parseInt(skipMatch[1], 10) : 0;
      if (combined.includes('TAP version')) {
        // if counts missing, infer conservatively
        if (!passMatch && !failMatch && !skipMatch) passed = targetTests.length;
      }
    } catch (err) {
      const execErr = err as { stdout?: string; stderr?: string; code?: number; message?: string };
      const combined = [execErr.stdout, execErr.stderr, execErr.message].filter(Boolean).join('\n').trim();
      outputChunks.push(`$ ${command}\n${combined || '(no output)'}`);
      exitCode = typeof execErr.code === 'number' ? execErr.code : 1;
      const passMatch = combined.match(/#\s*pass\s+(\d+)/i);
      const failMatch = combined.match(/#\s*fail\s+(\d+)/i);
      const skipMatch = combined.match(/#\s*skip(?:ped)?\s+(\d+)/i);
      passed = passMatch ? parseInt(passMatch[1], 10) : 0;
      failed += failMatch ? parseInt(failMatch[1], 10) : Math.max(1, failed || 0);
      skipped = skipMatch ? parseInt(skipMatch[1], 10) : skipped;

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
        title: `Verified test failure in ${failFile}`,
        message: combined.split('\n').find((l) => /not ok|Error|AssertionError/i.test(l)) || 'Test command exited non-zero.',
        agentId: 'subagent-test',
        agentName: 'Test · Runner',
        agentColor: '#0ACF83',
        originalLine: fileContents[failFile]?.split(/\r?\n/)[lineNum - 1],
        explanation: 'Verified by running real test command in workspace; see terminal output for details.',
        fixed: false,
      });
    }
  } else if (!projectTestRan && jsFiles.length > 0) {
    ran = true;
    command = command || `node --check (${Math.min(jsFiles.length, jsCheckCap)} JS files)`;
    if (!outputChunks.some((c) => c.includes('FAIL')) && !projectTestRan) {
      passed = Math.min(jsFiles.length, jsCheckCap);
    }
  } else if (!projectTestRan) {
    command = command || 'none (no runnable *.test/*spec* files, no JS files for syntax check)';
    outputChunks.push('Skipped: no *.test.*/*.spec.* files discovered and no JS files for `node --check`.');
  }

  if (!hasNodeModules) limitations.push('workspace node_modules missing (some tests/frameworks may be unrunnable)');
  if (limitations.length) outputChunks.push(`Limitations: ${limitations.join('; ')}`);

  const elapsedMs = Date.now() - t0;
  return {
    agent: {
      id: 'subagent-test',
      name: 'Test · Runner',
      specialty: 'Real node --check, project test script & node/tsx --test execution',
      color: '#0ACF83',
      status: 'done',
      elapsedMs,
      findingsCount: diagnostics.length,
      summary: `Tests/checks: discovered ${testFiles.length}, runnable ${runnableTests.length}, skipped ${skippedReasons.length}, projectScript=${projectTestRan}; ${passed} passed, ${failed} failed (${elapsedMs}ms).`,
    },
    diagnostics,
    testResult: {
      ran,
      command: command || 'none',
      exitCode,
      durationMs: elapsedMs,
      passed,
      failed,
      skipped: skipped + skippedReasons.length,
      output: outputChunks.join('\n\n').trim() || 'No output.',
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

  if (!useAi) {
    const elapsedMs = Date.now() - t0;
    return {
      agent: {
        id: 'subagent-fix',
        name: 'Fix · Patch-Synth',
        specialty: 'AI patch suggestions (disabled unless enabled)',
        color: '#0D99FF',
        status: 'done',
        elapsedMs,
        findingsCount: 0,
        summary: 'AI patch suggestions disabled (useAi=false); no suggested AI patches generated.',
      },
      diagnostics: [],
    };
  }

  if (!ai) {
    const patchableCount = existingDiagnostics.filter((d) => Boolean(d.suggestedLinePatch)).length;
    const elapsedMs = Date.now() - t0;
    return {
      agent: {
        id: 'subagent-fix',
        name: 'Fix · Patch-Synth',
        specialty: 'AI patch suggestions (requires GEMINI_API_KEY)',
        color: '#0D99FF',
        status: 'done',
        elapsedMs,
        findingsCount: patchableCount,
        summary: `AI suggestions unavailable (GEMINI_API_KEY not configured). ${patchableCount} deterministic heuristic patches already attached to findings.`,
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
        code: 'AI-SUGGESTED-FIX',
        filePath: fix.filePath,
        line: safeLine,
        column: 1,
        title: `[Suggested] ${fix.title}`,
        message: `Suggested AI patch (unverified): ${fix.title}`,
        agentId: 'subagent-fix',
        agentName: 'Fix · Patch-Synth',
        agentColor: '#0D99FF',
        originalLine: lines[safeLine - 1],
        suggestedLinePatch: fix.patchedLine,
        explanation: `Suggested by AI (not compiler/test-verified). ${fix.explanation}`,
        fixed: false,
      });
    }

    const elapsedMs = Date.now() - t0;
    return {
      agent: {
        id: 'subagent-fix',
        name: 'Fix · Patch-Synth',
        specialty: 'Suggested AI patch synthesis (enabled)',
        color: '#0D99FF',
        status: 'done',
        elapsedMs,
        findingsCount: aiDiags.length,
        summary: `Generated ${aiDiags.length} suggested AI patches in ${elapsedMs}ms (review before applying).`,
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
        specialty: 'AI patch suggestions (fallback on error)',
        color: '#0D99FF',
        status: 'done',
        elapsedMs,
        findingsCount: patchableCount,
        summary: `AI suggestions failed (${reason}); ${patchableCount} deterministic heuristic patches remain available.`,
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

  // Phase 2: Run Fix Synthesizer subagent with full diagnostics context (AI suggestions only when enabled)
  const fixRes = await runAiFixSubagent(fileContents, baseDiagnostics, useAi);

  // Merge suggested AI patches onto matching lines or append new AI diagnostics
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
      existing.explanation = `${existing.explanation} Suggested fix: ${aiDiag.explanation}`;
    } else {
      mergedDiagnostics.push(aiDiag);
    }
  }

  const totalElapsedMs = Date.now() - startAll;
  const verifiedCount = tscRes.diagnostics.length + testRes.diagnostics.length;
  const heuristicCount = secRes.diagnostics.length + bugRes.diagnostics.length;
  const aiCount = fixRes.diagnostics.length;
  const terminalLines = [
    `$ swarm-ide debug --parallel --agents=5`,
    `[Coverage] verified compiler/test: ${verifiedCount}; heuristic pattern: ${heuristicCount}; suggested AI: ${aiCount}.`,
    `[Sec · Audit-Prober] ${secRes.agent.summary}`,
    `[Bug · Logic-Debugger] ${bugRes.agent.summary}`,
    `[TSC · Type-Checker] ${tscRes.agent.summary}`,
    `[Test · Runner] ${testRes.agent.summary}`,
    `[Fix · Patch-Synth] ${fixRes.agent.summary}`,
    `--- tsc output ---`,
    tscRes.tscResult.output || '(no tsc output)',
    `--- test/check output ---`,
    testRes.testResult.output || '(no test output)',
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
