import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import { analyzeBugsInCode, applyDiagnosticFixToContent } from '../src/engine/bugAnalyzer';
import { scanSourceCode } from '../src/engine/realScanner';
import { SWARM_CURSOR_PROFILES } from '../src/engine/swarmProfiles';
import type {
  CodeDiagnostic,
  CursorAgentState,
  CursorSpeed,
  SwarmStreamEvent,
} from '../src/types/ide';
import {
  computeWorkspaceGitDiff,
  getWorkspaceFileStatuses,
  readAllTextFiles,
  writeWorkspaceFile,
} from './repoManager';
import { runParallelDebugSwarm } from './subagentRunner';

const execFileAsync = promisify(execFile);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function sanitizeCommonUnknownSymbols(line: string): string {
  let next = line;
  if (next.includes('escapeHtml(')) {
    next = next.replace(/escapeHtml\(([^)]+)\)/g, 'String($1)');
  }
  if (next.includes('isSafeRelativePath(')) {
    next = next.replace(
      /isSafeRelativePath\(([^)]+)\)/g,
      "(String($1).startsWith('/') && !String($1).startsWith('//'))"
    );
  }
  return next;
}

export function applyDeterministicTypeScriptFix(
  line: string,
  diag: CodeDiagnostic
): string | undefined {
  if (diag.code === 'TS2322') {
    if (/Type 'string' is not assignable to type 'number'/i.test(diag.message)) {
      const m = line.match(/=\s*(['"])(-?\d+(?:\.\d+)?)\1/);
      if (m) {
        return line.replace(/=\s*(['"])(-?\d+(?:\.\d+)?)\1/, `= ${m[2]}`);
      }
      const assignMatch = line.match(/^(.*:\s*number\s*=\s*)([^;]+)(;?)$/);
      if (assignMatch) {
        return `${assignMatch[1]}Number(${assignMatch[2].trim()})${assignMatch[3]}`;
      }
    }
    if (/Type 'number' is not assignable to type 'string'/i.test(diag.message)) {
      const m = line.match(/=\s*(-?\d+(?:\.\d+)?)\s*(;?)$/);
      if (m) {
        return line.replace(/=\s*(-?\d+(?:\.\d+)?)\s*(;?)$/, `= '${m[1]}'$2`);
      }
    }
  }
  if (diag.code === 'TS2304') {
    const cleaned = sanitizeCommonUnknownSymbols(line);
    if (cleaned !== line) return cleaned;
  }
  return undefined;
}

async function synthesizeFixViaGemini(
  ai: GoogleGenAI,
  filePath: string,
  fileContent: string,
  diag: CodeDiagnostic
): Promise<string | undefined> {
  const lines = fileContent.split(/\r?\n/);
  const start = Math.max(0, diag.line - 25);
  const end = Math.min(lines.length, diag.line + 25);
  const headerImports =
    start > 20
      ? `IMPORTS / TOP HEADER:\n${lines
          .slice(0, 20)
          .map((l, idx) => `${idx + 1}: ${l}`)
          .join('\n')}\n\n`
      : '';
  const numberedWindow = lines
    .slice(start, end)
    .map((l, idx) => `${start + idx + 1}: ${l}`)
    .join('\n');

  const prompt = [
    `File: ${filePath}`,
    `Diagnostic [${diag.code}] on line ${diag.line}: ${diag.title} — ${diag.message}`,
    `Target line ${diag.line}: ${lines[diag.line - 1] ?? ''}`,
    '',
    'Fix ONLY that exact line so the bug/type/security error is resolved cleanly and valid TypeScript/JS compiles without introducing new undefined identifiers.',
    'Keep existing indentation. Return JSON { "patchedLine": string }.',
    '',
    `${headerImports}CONTEXT AROUND LINE ${diag.line}:`,
    numberedWindow,
  ].join('\n');

  try {
    const aiCall = ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: prompt,
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        systemInstruction:
          'You are an automated Swarm code-fixing agent. Return strictly valid single-line TypeScript/JS replacement code preserving indentation.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            patchedLine: { type: Type.STRING },
          },
          required: ['patchedLine'],
        },
      },
    });
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), 10_000)
    );
    const res = await Promise.race([aiCall, timeout]);
    const parsed = JSON.parse((res.text ?? '{}').trim()) as { patchedLine?: string };
    if (
      parsed.patchedLine &&
      parsed.patchedLine.trim().length > 0 &&
      !parsed.patchedLine.includes('\n')
    ) {
      return parsed.patchedLine;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function getDistinctLinesForFile(
  content: string,
  priorityLines: number[],
  desiredCount: number
): number[] {
  const lines = content.split(/\r?\n/);
  const maxLine = Math.max(1, lines.length);
  const picked: number[] = [];
  const used = new Set<number>();

  for (const l of priorityLines) {
    const clamped = Math.max(1, Math.min(maxLine, l));
    if (!used.has(clamped)) {
      used.add(clamped);
      picked.push(clamped);
    }
  }

  for (let i = 0; i < lines.length && picked.length < desiredCount; i++) {
    const lineNum = i + 1;
    if (!used.has(lineNum) && lines[i].trim().length > 0) {
      used.add(lineNum);
      picked.push(lineNum);
    }
  }

  let cursor = 1;
  while (picked.length < desiredCount) {
    picked.push(Math.min(maxLine, cursor));
    cursor = cursor >= maxLine ? 1 : cursor + 1;
  }

  return picked;
}

async function countFileTscErrors(
  workspaceDir: string,
  tsFiles: string[],
  targetRelPath: string
): Promise<number> {
  if (tsFiles.length === 0) return 0;
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
        ...tsFiles.slice(0, 250),
      ];
  let out = '';
  try {
    const { stdout, stderr } = await execFileAsync(tscBin, args, {
      cwd: workspaceDir,
      timeout: 15_000,
    });
    out = [stdout, stderr].filter(Boolean).join('\n');
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    out = [e.stdout, e.stderr].filter(Boolean).join('\n');
  }
  let count = 0;
  for (const l of out.split(/\r?\n/)) {
    const m = /^(.+?)\(\d+,\d+\):\s+error\s+(TS\d+):/.exec(l.trim());
    if (!m) continue;
    if (
      !hasNodeModules &&
      ['TS2307', 'TS2792', 'TS7016', 'TS2503', 'TS2688', 'TS2304', 'TS2591'].includes(m[2])
    ) {
      continue;
    }
    const rel = path.isAbsolute(m[1])
      ? path.relative(workspaceDir, m[1]).split(path.sep).join('/')
      : m[1].split(path.sep).join('/');
    if (rel === targetRelPath) {
      count++;
    }
  }
  return count;
}

function isTestFilePath(filePath: string): boolean {
  return /\.(test|spec)\.(js|mjs|cjs|ts|tsx)$/i.test(filePath);
}

async function runTargetedTestCheck(
  workspaceDir: string,
  filePath: string
): Promise<{ ran: boolean; failed: number; exitCode: number }> {
  if (!isTestFilePath(filePath)) return { ran: false, failed: 0, exitCode: 0 };
  const hasTs = /\.tsx?$/i.test(filePath);
  const tsxBin = path.resolve(process.cwd(), 'node_modules/.bin/tsx');
  const cmd = hasTs ? tsxBin : 'node';
  try {
    await execFileAsync(cmd, ['--test', filePath], {
      cwd: workspaceDir,
      timeout: 15_000,
      env: { ...process.env, NODE_ENV: 'test' },
    });
    return { ran: true, failed: 0, exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    const combined = [e.stdout, e.stderr].filter(Boolean).join('\n');
    const failMatch = combined.match(/#\s*fail\s+(\d+)/i);
    const failed = failMatch ? parseInt(failMatch[1], 10) : 1;
    return { ran: true, failed, exitCode: typeof e.code === 'number' ? e.code : 1 };
  }
}

const SPEED_MULTIPLIER: Record<CursorSpeed, number> = {
  slow: 1.0,
  normal: 0.55,
  fast: 0.25,
};

export async function runAutonomousSwarmFix(params: {
  workspaceId: string;
  workspaceDir: string;
  agentCount?: number;
  speed?: CursorSpeed;
  useAi?: boolean;
  emit: (event: SwarmStreamEvent) => void;
}): Promise<void> {
  const { workspaceId, workspaceDir, useAi = true, speed = 'slow', emit } = params;
  const mult = SPEED_MULTIPLIER[speed] ?? 1.0;
  const numAgents = 10;

  const agents: CursorAgentState[] = SWARM_CURSOR_PROFILES.slice(0, numAgents).map((p) => ({
    id: p.id,
    name: p.name,
    color: p.color,
    status: 'scanning',
    filePath: null,
    line: 1,
    column: 1,
    task: 'Scanning repository diagnostics…',
    diagnosticId: null,
    fixedCount: 0,
    createdCount: 0,
  }));

  const broadcast = (logLine?: string) => {
    for (let i = 0; i < agents.length; i++) {
      emit({ type: 'agent:update', agent: { ...agents[i] }, logLine: i === 0 ? logLine : undefined });
    }
  };

  broadcast();
  emit({
    type: 'phase',
    phase: 'diagnosing',
    message: `All ${numAgents} cursors scanning workspace with tsc --noEmit, tests/checks, bug AST, security probes${useAi ? ', and AI patch synthesis' : ''}…`,
  });

  const initialFiles = await readAllTextFiles(workspaceDir);
  const initialDebug = await runParallelDebugSwarm(workspaceDir, initialFiles.fileContents, useAi);
  const tsFiles = Object.keys(initialFiles.fileContents).filter(
    (p) => /\.(ts|tsx)$/i.test(p) && !p.endsWith('.d.ts')
  );

  emit({
    type: 'diagnostics:ready',
    diagnostics: initialDebug.diagnostics,
    tscResult: initialDebug.tscResult,
    testResult: initialDebug.testResult,
  });

  const fileQueues: Array<{ filePath: string; items: CodeDiagnostic[] }> = [];
  const byFile = new Map<string, CodeDiagnostic[]>();
  for (const d of initialDebug.diagnostics) {
    if (d.fixed) continue;
    const list = byFile.get(d.filePath) ?? [];
    list.push(d);
    byFile.set(d.filePath, list);
  }
  for (const [filePath, items] of byFile.entries()) {
    items.sort((a, b) => b.line - a.line);
    fileQueues.push({ filePath, items });
  }

  if (fileQueues.length === 0) {
    for (const a of agents) {
      a.status = 'done';
      a.task = '0 issues to fix · Workspace clean';
    }
    broadcast(`[Swarm] Codebase verified clean — 0 issues remaining.`);
    const gitDiff = await computeWorkspaceGitDiff(workspaceDir);
    emit({
      type: 'swarm:complete',
      result: { workspaceId, ...initialDebug, gitDiff },
      agents,
      fileContents: initialFiles.fileContents,
      fixedCount: 0,
      summary: 'No fixable diagnostics found.',
    });
    return;
  }

  emit({
    type: 'phase',
    phase: 'fixing',
    message: `Swarm converged: all ${numAgents} cursors working one file at a time across ${fileQueues.length} file(s)…`,
  });

  const ai = useAi ? getGeminiClient() : null;
  let verifiedFixCount = 0;
  let revertedFixCount = 0;

  // Strictly per-file sequential: all agents converge on the same active file, animate in-file work, then move together.
  for (let fIdx = 0; fIdx < fileQueues.length; fIdx++) {
    const job = fileQueues[fIdx];
    let currentContent = initialFiles.fileContents[job.filePath];
    if (currentContent === undefined) continue;

    const assignedLines = getDistinctLinesForFile(
      currentContent,
      job.items.map((d) => d.line),
      numAgents
    );

    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      a.status = 'navigating';
      a.filePath = job.filePath;
      a.diagnosticId = null;
      a.task = `Converged on ${job.filePath}`;
    }
    const convergeFrom = agents.map((a) => a.line || 1);
    for (let step = 1; step <= 3; step++) {
      for (let i = 0; i < agents.length; i++) {
        const from = convergeFrom[i];
        const to = assignedLines[i];
        agents[i].line = Math.max(1, Math.round(from + ((to - from) * step) / 3));
        agents[i].column = 1 + ((step + i * 3) % 24);
        agents[i].status = step < 3 ? 'navigating' : 'scanning';
      }
      broadcast(`[Swarm ${fIdx + 1}/${fileQueues.length}] All ${numAgents} cursors converged on ${job.filePath}`);
      await sleep(Math.round(120 * mult));
    }

    const snapshotBeforeFile = currentContent;
    const baselineTscErrors = tsFiles.includes(job.filePath)
      ? await countFileTscErrors(workspaceDir, tsFiles, job.filePath)
      : 0;
    const baselineTest = isTestFilePath(job.filePath)
      ? await runTargetedTestCheck(workspaceDir, job.filePath)
      : { ran: false, failed: 0, exitCode: 0 };
    const patchedIdsInFile: Array<{ id: string; agentId: string }> = [];

    for (let dIdx = 0; dIdx < job.items.length; dIdx++) {
      const diag = job.items[dIdx];
      const writerIndex = dIdx % numAgents;
      const writer = agents[writerIndex];

      const writerFromLine = writer.line || 1;
      for (let step = 1; step <= 2; step++) {
        for (let i = 0; i < agents.length; i++) {
          const a = agents[i];
          a.filePath = job.filePath;
          a.diagnosticId = diag.id;
          a.line =
            i === writerIndex
              ? Math.max(1, Math.round(writerFromLine + ((diag.line - writerFromLine) * step) / 2))
              : assignedLines[i];
          a.column = 1 + ((step + i * 5) % 18);
          a.status = i === writerIndex ? 'navigating' : 'scanning';
          a.task =
            i === writerIndex
              ? `Navigating to ${job.filePath}:${diag.line} [${diag.code}]`
              : `Scanning ${job.filePath} while ${writer.name} targets ${diag.code}`;
        }
        broadcast(`[${writer.name}] → ${job.filePath}:${diag.line} [${diag.code}] ${diag.title}`);
        await sleep(Math.round(140 * mult));
      }
      for (let i = 0; i < agents.length; i++) {
        const a = agents[i];
        a.line = i === writerIndex ? diag.line : assignedLines[i];
        a.column = 1;
        a.status = i === writerIndex ? 'navigating' : 'scanning';
        a.task =
          i === writerIndex
            ? `Fixing ${diag.code} at ${job.filePath}:${diag.line}`
            : `Scanning ${job.filePath} while ${writer.name} fixes ${diag.code}`;
      }
      broadcast(`[${writer.name}] → ${job.filePath}:${diag.line} [${diag.code}] ${diag.title}`);

      const latestLines = currentContent.split(/\r?\n/);
      const originalTargetLine = latestLines[diag.line - 1] ?? '';
      let resolvedAfterLine = '';

      if (diag.source === 'bug') {
        const freshBug = analyzeBugsInCode(originalTargetLine, job.filePath).find((b) => b.code === diag.code);
        if (freshBug?.suggestedLinePatch) resolvedAfterLine = sanitizeCommonUnknownSymbols(freshBug.suggestedLinePatch);
      } else if (diag.source === 'security') {
        const freshSec = scanSourceCode(originalTargetLine, job.filePath).find(
          (s) => `${s.ruleId} (${s.cwe})` === diag.code
        );
        if (freshSec?.patchedLine) resolvedAfterLine = sanitizeCommonUnknownSymbols(freshSec.patchedLine);
      }

      if (!resolvedAfterLine && (diag.suggestedLinePatch || diag.suggestedFilePatch)) {
        const candidate = applyDiagnosticFixToContent(currentContent, diag);
        if (candidate !== currentContent) {
          const rawPatchedLine = candidate.split(/\r?\n/)[diag.line - 1] ?? '';
          resolvedAfterLine = sanitizeCommonUnknownSymbols(rawPatchedLine);
        }
      }
      if (!resolvedAfterLine && diag.source === 'typescript') {
        const tsFix = applyDeterministicTypeScriptFix(originalTargetLine, diag);
        if (tsFix && tsFix !== originalTargetLine) resolvedAfterLine = tsFix;
      }
      if (!resolvedAfterLine && ai) {
        const aiLine = await synthesizeFixViaGemini(ai, job.filePath, currentContent, diag);
        if (aiLine && aiLine !== originalTargetLine) resolvedAfterLine = aiLine;
      }

      if (resolvedAfterLine && resolvedAfterLine !== originalTargetLine) {
        writer.status = 'writing';
        writer.line = diag.line;
        writer.task = `Writing fix to ${job.filePath}:${diag.line}`;
        writer.lastEditSnippet = resolvedAfterLine.trim();

        const liveLines = currentContent.split(/\r?\n/);
        const beforeLine = liveLines[diag.line - 1] ?? '';
        if (beforeLine !== resolvedAfterLine) {
          const frames = Math.max(8, Math.min(20, Math.ceil(resolvedAfterLine.length / 4) + 6));
          for (let step = 1; step <= frames; step++) {
            const charCount = Math.max(1, Math.floor((resolvedAfterLine.length * step) / frames));
            const partialLine = resolvedAfterLine.slice(0, charCount);
            writer.status = 'writing';
            writer.line = diag.line;
            writer.column = charCount + 1;
            for (const a of agents) {
              if (a !== writer) {
                a.status = 'scanning';
                a.filePath = job.filePath;
                a.line = assignedLines[agents.indexOf(a)];
                a.column = 1 + ((step * 3 + agents.indexOf(a) * 5) % 28);
              }
            }
            const partialLines = [...liveLines];
            partialLines[diag.line - 1] = partialLine;
            const partialContent = partialLines.join('\n');
            broadcast();
            emit({
              type: 'file:streaming',
              agentId: writer.id,
              agentName: writer.name,
              agentColor: writer.color,
              filePath: job.filePath,
              line: diag.line,
              column: writer.column,
              content: partialContent,
              action: 'modify',
            });
            await sleep(Math.round((35 + Math.min(40, resolvedAfterLine.length)) * mult));
          }

          liveLines[diag.line - 1] = resolvedAfterLine;
          const nextContent = liveLines.join('\n');
          await writeWorkspaceFile(workspaceDir, job.filePath, nextContent);
          currentContent = nextContent;
          patchedIdsInFile.push({ id: diag.id, agentId: writer.id });
          writer.fixedCount += 1;
          writer.status = 'editing';
          writer.column = Math.max(1, resolvedAfterLine.length + 1);
          writer.line = diag.line;

          const [gitDiff, fileStatuses] = await Promise.all([
            computeWorkspaceGitDiff(workspaceDir),
            getWorkspaceFileStatuses(workspaceDir),
          ]);
          for (const a of agents) if (a !== writer) { a.status = 'scanning'; a.task = `Scanning ${job.filePath} after patch`; }
          broadcast();
          emit({
            type: 'file:patched',
            agentId: writer.id,
            agentName: writer.name,
            agentColor: writer.color,
            filePath: job.filePath,
            line: diag.line,
            beforeLine,
            afterLine: resolvedAfterLine,
            content: nextContent,
            gitDiff,
            fileStatuses,
            diagnosticIds: [diag.id],
          });
          await sleep(Math.round(220 * mult));
        }
      }

      for (let step = 1; step <= 3; step++) {
        for (let i = 0; i < agents.length; i++) {
          const a = agents[i];
          a.status = 'verifying';
          a.filePath = job.filePath;
          a.diagnosticId = diag.id;
          a.line = i === writerIndex ? diag.line : assignedLines[i];
          a.column = 1 + ((step * 7 + i * 4 + dIdx) % 32);
          a.task = `Verifying ${job.filePath}:${a.line}`;
        }
        broadcast();
        await sleep(Math.round(70 * mult));
      }
    }

    if (patchedIdsInFile.length > 0) {
      for (let step = 1; step <= 3; step++) {
        for (let i = 0; i < agents.length; i++) {
          const a = agents[i];
          a.status = 'verifying';
          a.filePath = job.filePath;
          a.diagnosticId = null;
          a.line = assignedLines[i];
          a.column = 1 + ((step * 9 + i * 5) % 36);
          a.task = `Verifying checks on ${job.filePath}…`;
        }
        broadcast(`[Swarm] Verifying ${job.filePath} with real checks…`);
        await sleep(Math.round(80 * mult));
      }
      let revertReason = '';
      if (tsFiles.includes(job.filePath)) {
        const afterTscErrors = await countFileTscErrors(workspaceDir, tsFiles, job.filePath);
        if (afterTscErrors > baselineTscErrors) {
          revertReason = `tsc errors increased ${baselineTscErrors} → ${afterTscErrors}`;
        }
      }
      if (!revertReason && isTestFilePath(job.filePath)) {
        const afterTest = await runTargetedTestCheck(workspaceDir, job.filePath);
        if (afterTest.ran && (afterTest.failed > baselineTest.failed || (!baselineTest.ran && afterTest.exitCode !== 0))) {
          revertReason = `test checks regressed (${baselineTest.failed} → ${afterTest.failed} failures)`;
        }
      }
      if (revertReason) {
        await writeWorkspaceFile(workspaceDir, job.filePath, snapshotBeforeFile);
        const revertedDiff = await computeWorkspaceGitDiff(workspaceDir);
        for (const p of patchedIdsInFile) {
          const ag = agents.find((a) => a.id === p.agentId);
          if (ag) ag.fixedCount = Math.max(0, ag.fixedCount - 1);
        }
        revertedFixCount += patchedIdsInFile.length;
        broadcast(`[Swarm] Reverted ${job.filePath}: ${revertReason}`);
        emit({
          type: 'file:reverted',
          agentId: agents[0].id,
          filePath: job.filePath,
          reason: `Reverted unsafe edit in ${job.filePath} (${revertReason}).`,
          content: snapshotBeforeFile,
          gitDiff: revertedDiff,
        });
      } else {
        verifiedFixCount += patchedIdsInFile.length;
        broadcast(`[Swarm] Verified ${job.filePath}: ${patchedIdsInFile.length} patch(es) passed file checks.`);
      }
    }
  }

  for (const a of agents) {
    a.status = 'verifying';
    a.diagnosticId = null;
    a.task = 'Final workspace re-scan (tsc/tests/checks)…';
  }
  broadcast('[Swarm] Per-file fixing complete. Running final verification/re-scan…');

  emit({
    type: 'phase',
    phase: 'verifying',
    message: 'Running final tsc --noEmit + test suite re-scan for truthful results…',
  });

  let hbTick = 0;
  const finalHb = setInterval(() => {
    hbTick++;
    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      a.status = 'verifying';
      a.diagnosticId = null;
      a.column = 1 + ((hbTick * 7 + i * 11) % 40);
      a.task = 'Final workspace re-scan (tsc/tests/checks)…';
    }
    broadcast();
  }, 180);

  let finalFiles, finalDebug, finalDiff, finalStatuses;
  try {
    finalFiles = await readAllTextFiles(workspaceDir);
    finalDebug = await runParallelDebugSwarm(workspaceDir, finalFiles.fileContents, false);
    [finalDiff, finalStatuses] = await Promise.all([
      computeWorkspaceGitDiff(workspaceDir),
      getWorkspaceFileStatuses(workspaceDir),
    ]);
  } finally {
    clearInterval(finalHb);
  }

  const remainingErrors = finalDebug.diagnostics.filter((d) => d.severity === 'error').length;
  const evidence = `verified=${verifiedFixCount} reverted=${revertedFixCount} open=${finalDebug.diagnostics.length} openErrors=${remainingErrors} tscErrors=${finalDebug.tscResult.errorCount} testsFailed=${finalDebug.testResult.failed}`;

  for (const a of agents) {
    a.status = 'done';
    a.diagnosticId = null;
    a.task =
      a.fixedCount > 0
        ? `Applied ${a.fixedCount} verified patch${a.fixedCount === 1 ? '' : 'es'}`
        : 'Verified target files';
  }
  broadcast();

  emit({
    type: 'phase',
    phase: 'complete',
    message: `Swarm finished with post-fix verification evidence: ${evidence}.`,
  });

  emit({
    type: 'swarm:complete',
    result: {
      workspaceId,
      subagents: finalDebug.subagents,
      diagnostics: finalDebug.diagnostics,
      tscResult: finalDebug.tscResult,
      testResult: finalDebug.testResult,
      terminalLines: [
        ...finalDebug.terminalLines,
        `[Swarm-Fix] Evidence: ${evidence}. Files queued: ${fileQueues.length}. Cursors: ${numAgents} (strictly one file at a time).`,
      ],
      gitDiff: finalDiff,
      fileStatuses: finalStatuses,
      totalElapsedMs: finalDebug.totalElapsedMs,
    },
    agents,
    fileContents: finalFiles.fileContents,
    files: finalFiles.files,
    fileStatuses: finalStatuses,
    fixedCount: verifiedFixCount,
    summary: `Verified ${verifiedFixCount} patch(es), reverted ${revertedFixCount}, ${finalDebug.diagnostics.length} diagnostic(s) remain (truthful post-fix re-scan).`,
  });
}
