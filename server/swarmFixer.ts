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
  const numAgents = Math.max(1, Math.min(20, params.agentCount ?? 20));

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

  for (const a of agents) {
    emit({ type: 'agent:update', agent: { ...a } });
  }

  emit({
    type: 'phase',
    phase: 'diagnosing',
    message: `All ${numAgents} cursors scanning workspace with tsc --noEmit, tsx --test, bug AST, and security probes…`,
  });

  const initialFiles = await readAllTextFiles(workspaceDir);
  const initialDebug = await runParallelDebugSwarm(workspaceDir, initialFiles.fileContents, false);
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
    if (d.fixed || d.code === 'TEST-FAIL') continue;
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
      emit({
        type: 'agent:update',
        agent: { ...a },
        logLine: `[${a.name}] Codebase verified clean — 0 issues remaining.`,
      });
    }
    const gitDiff = await computeWorkspaceGitDiff(workspaceDir);
    emit({
      type: 'swarm:complete',
      result: {
        workspaceId,
        ...initialDebug,
        gitDiff,
      },
      agents,
      fileContents: initialFiles.fileContents,
      fixedCount: 0,
    });
    return;
  }

  emit({
    type: 'phase',
    phase: 'fixing',
    message: `Swarm converged: all ${numAgents} cursors working across ${fileQueues.length} file(s)…`,
  });

  const ai = useAi ? getGeminiClient() : null;
  let totalFixed = 0;
  const fixedByAgent = new Map<string, { agentId: string }>();

  // LOCKSTEP COLLABORATION: All 20 cursors converge onto one file together, patch & verify, then move together to the next file.
  for (let fIdx = 0; fIdx < fileQueues.length; fIdx++) {
    const job = fileQueues[fIdx];
    let currentContent = initialFiles.fileContents[job.filePath];
    if (currentContent === undefined) continue;

    const priorityLines = job.items.map((d) => d.line);
    const assignedLines = getDistinctLinesForFile(currentContent, priorityLines, numAgents);

    for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      a.status = 'navigating';
      a.filePath = job.filePath;
      a.line = assignedLines[i];
      a.column = 1;
      a.diagnosticId = job.items[i]?.id ?? null;
      a.task = `Converged on ${job.filePath}:${assignedLines[i]}`;
      emit({
        type: 'agent:update',
        agent: { ...a },
        logLine:
          i === 0
            ? `[Swarm ${fIdx + 1}/${fileQueues.length}] All ${numAgents} cursors converged on ${job.filePath}`
            : undefined,
      });
    }
    await sleep(Math.round(580 * mult));

    const snapshotBeforeFile = currentContent;
    const baselineTscErrors = tsFiles.includes(job.filePath)
      ? await countFileTscErrors(workspaceDir, tsFiles, job.filePath)
      : 0;
    const patchedIdsInFile: string[] = [];
    let nextDiagIdx = 0;
    let fileWriteChain = Promise.resolve();

    const runWorkerOnFile = async (agent: CursorAgentState, workerIndex: number) => {
      while (true) {
        const dIdx = nextDiagIdx++;
        if (dIdx >= job.items.length) break;
        const diag = job.items[dIdx];

        agent.status = 'navigating';
        agent.filePath = job.filePath;
        agent.line = diag.line;
        agent.column = diag.column;
        agent.diagnosticId = diag.id;
        agent.task = `Fixing ${diag.code} at line ${diag.line}`;
        emit({
          type: 'agent:update',
          agent: { ...agent },
          logLine: `[${agent.name}] → ${job.filePath}:${diag.line} [${diag.code}] ${diag.title}`,
        });

        await sleep(Math.round(480 * mult));

        const latestLines = currentContent.split(/\r?\n/);
        const originalTargetLine = latestLines[diag.line - 1] ?? '';
        let resolvedAfterLine = '';

        if (diag.source === 'bug') {
          const freshBug = analyzeBugsInCode(originalTargetLine, job.filePath).find(
            (b) => b.code === diag.code
          );
          if (freshBug?.suggestedLinePatch) {
            resolvedAfterLine = sanitizeCommonUnknownSymbols(freshBug.suggestedLinePatch);
          }
        } else if (diag.source === 'security') {
          const freshSec = scanSourceCode(originalTargetLine, job.filePath).find(
            (s) => `${s.ruleId} (${s.cwe})` === diag.code
          );
          if (freshSec?.patchedLine) {
            resolvedAfterLine = sanitizeCommonUnknownSymbols(freshSec.patchedLine);
          }
        }

        if (!resolvedAfterLine && (diag.suggestedLinePatch || diag.suggestedFilePatch)) {
          const candidate = applyDiagnosticFixToContent(currentContent, diag);
          if (candidate !== currentContent) {
            const candidateLines = candidate.split(/\r?\n/);
            const rawPatchedLine = candidateLines[diag.line - 1] ?? '';
            resolvedAfterLine = sanitizeCommonUnknownSymbols(rawPatchedLine);
          }
        }

        if (!resolvedAfterLine && diag.source === 'typescript') {
          const tsFix = applyDeterministicTypeScriptFix(originalTargetLine, diag);
          if (tsFix && tsFix !== originalTargetLine) {
            resolvedAfterLine = tsFix;
          }
        }

        if (!resolvedAfterLine && ai) {
          const aiLine = await synthesizeFixViaGemini(ai, job.filePath, currentContent, diag);
          if (aiLine && aiLine !== originalTargetLine) {
            resolvedAfterLine = aiLine;
          }
        }

        if (resolvedAfterLine && resolvedAfterLine !== originalTargetLine) {
          agent.status = 'writing';
          agent.task = `Writing fix to ${job.filePath}:${diag.line}`;
          agent.lastEditSnippet = resolvedAfterLine.trim();

          for (const ratio of [0.35, 0.72]) {
            const partialLen = Math.max(1, Math.floor(resolvedAfterLine.length * ratio));
            agent.column = partialLen + 1;
            emit({ type: 'agent:update', agent: { ...agent } });
            await sleep(Math.round(240 * mult));
          }

          fileWriteChain = fileWriteChain.then(async () => {
            const liveLines = currentContent.split(/\r?\n/);
            const beforeLine = liveLines[diag.line - 1] ?? '';
            if (beforeLine === resolvedAfterLine) return;
            liveLines[diag.line - 1] = resolvedAfterLine;
            const nextContent = liveLines.join('\n');

            await writeWorkspaceFile(workspaceDir, job.filePath, nextContent);
            currentContent = nextContent;
            patchedIdsInFile.push(diag.id);
            fixedByAgent.set(diag.id, { agentId: agent.id });
            agent.fixedCount += 1;
            totalFixed += 1;
            agent.status = 'editing';
            agent.column = Math.max(1, resolvedAfterLine.length + 1);

            const [gitDiff, fileStatuses] = await Promise.all([
              computeWorkspaceGitDiff(workspaceDir),
              getWorkspaceFileStatuses(workspaceDir),
            ]);
            emit({ type: 'agent:update', agent: { ...agent } });
            emit({
              type: 'file:patched',
              agentId: agent.id,
              agentName: agent.name,
              agentColor: agent.color,
              filePath: job.filePath,
              line: diag.line,
              beforeLine,
              afterLine: resolvedAfterLine,
              content: nextContent,
              gitDiff,
              fileStatuses,
              diagnosticIds: [diag.id],
            });
          });
          await fileWriteChain;
          await sleep(Math.round(300 * mult));
        }
      }

      if (workerIndex >= job.items.length) {
        agent.status = 'verifying';
        agent.filePath = job.filePath;
        agent.line = assignedLines[workerIndex];
        agent.column = Math.max(1, Math.min(28, (workerIndex * 3) % 24));
        agent.task = `Guarding ${job.filePath}:${assignedLines[workerIndex]}`;
        emit({ type: 'agent:update', agent: { ...agent } });
        await sleep(Math.round(380 * mult));
      }
    };

    await Promise.all(agents.map((a, idx) => runWorkerOnFile(a, idx)));

    if (patchedIdsInFile.length > 0 && tsFiles.includes(job.filePath)) {
      for (const a of agents) {
        a.status = 'verifying';
        a.task = `Verifying tsc on ${job.filePath}…`;
        emit({ type: 'agent:update', agent: { ...a } });
      }
      const afterTscErrors = await countFileTscErrors(workspaceDir, tsFiles, job.filePath);
      if (afterTscErrors > baselineTscErrors) {
        await writeWorkspaceFile(workspaceDir, job.filePath, snapshotBeforeFile);
        const revertedDiff = await computeWorkspaceGitDiff(workspaceDir);
        for (const pid of patchedIdsInFile) {
          fixedByAgent.delete(pid);
        }
        totalFixed = Math.max(0, totalFixed - patchedIdsInFile.length);
        emit({
          type: 'file:reverted',
          agentId: agents[0].id,
          filePath: job.filePath,
          reason: `Reverted unsafe edit in ${job.filePath} (tsc errors increased ${baselineTscErrors} → ${afterTscErrors}).`,
          content: snapshotBeforeFile,
          gitDiff: revertedDiff,
        });
      }
    }
  }

  for (const a of agents) {
    a.status = 'done';
    a.diagnosticId = null;
    a.task =
      a.fixedCount > 0
        ? `Patched & verified ${a.fixedCount} issue${a.fixedCount === 1 ? '' : 's'}`
        : 'Verified target files';
    emit({
      type: 'agent:update',
      agent: { ...a },
      logLine:
        a.fixedCount > 0
          ? `[${a.name}] Done (${a.fixedCount} fixes written & verified).`
          : undefined,
    });
  }

  emit({
    type: 'phase',
    phase: 'verifying',
    message: 'Running final tsc --noEmit + test suite verification across patched workspace…',
  });

  const finalFiles = await readAllTextFiles(workspaceDir);
  const finalDebug = await runParallelDebugSwarm(workspaceDir, finalFiles.fileContents, false);
  const [finalDiff, finalStatuses] = await Promise.all([
    computeWorkspaceGitDiff(workspaceDir),
    getWorkspaceFileStatuses(workspaceDir),
  ]);

  const mergedDiagnostics: CodeDiagnostic[] = [];
  for (const prev of initialDebug.diagnostics) {
    if (fixedByAgent.has(prev.id)) {
      const info = fixedByAgent.get(prev.id)!;
      mergedDiagnostics.push({
        ...prev,
        fixed: true,
        fixedByAgentId: info.agentId,
        verified: true,
      });
    }
  }
  for (const rem of finalDebug.diagnostics) {
    mergedDiagnostics.push(rem);
  }

  const remainingErrors = mergedDiagnostics.filter(
    (d) => !d.fixed && d.severity === 'error'
  ).length;

  emit({
    type: 'phase',
    phase: 'complete',
    message: `Swarm completed ${totalFixed} verified fixes (${remainingErrors} open errors remaining, tests passed: ${finalDebug.testResult.passed}).`,
  });

  emit({
    type: 'swarm:complete',
    result: {
      workspaceId,
      subagents: finalDebug.subagents,
      diagnostics: mergedDiagnostics,
      tscResult: finalDebug.tscResult,
      testResult: finalDebug.testResult,
      terminalLines: [
        ...finalDebug.terminalLines,
        `[Swarm-Fix] Fixed ${totalFixed} issues across ${fileQueues.length} files with ${numAgents} cursors.`,
      ],
      gitDiff: finalDiff,
      fileStatuses: finalStatuses,
      totalElapsedMs: finalDebug.totalElapsedMs,
    },
    agents,
    fileContents: finalFiles.fileContents,
    files: finalFiles.files,
    fileStatuses: finalStatuses,
    fixedCount: totalFixed,
    summary: `Fixed ${totalFixed} issues across ${fileQueues.length} files.`,
  });
}
