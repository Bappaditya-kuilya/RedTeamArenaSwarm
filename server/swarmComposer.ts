import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import path from 'node:path';
import { SWARM_CURSOR_PROFILES } from '../src/engine/swarmProfiles';
import type {
  ComposerPlanStep,
  CursorAgentState,
  CursorSpeed,
  SwarmStreamEvent,
} from '../src/types/ide';
import { detectRepoConventions, selectRelevantRepoContext } from './codebaseContext';
import {
  computeWorkspaceGitDiff,
  getWorkspaceFileStatuses,
  readAllTextFiles,
  writeWorkspaceFile,
} from './repoManager';
import { runParallelDebugSwarm } from './subagentRunner';

export interface PlannedFileEdit {
  filePath: string;
  action: 'create' | 'modify';
  description: string;
  content: string;
}

export interface FeaturePlan {
  summary: string;
  tasks: PlannedFileEdit[];
}

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

export function slugifyPromptFeature(prompt: string): string {
  const stopWords = new Set([
    'add',
    'build',
    'create',
    'implement',
    'make',
    'write',
    'new',
    'extra',
    'feature',
    'with',
    'and',
    'for',
    'the',
    'a',
    'an',
    'unit',
    'test',
    'tests',
    'helper',
    'module',
    'plus',
  ]);
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !stopWords.has(w))
    .slice(0, 3);

  if (words.length === 0) return 'featureModule';
  return words
    .map((w, idx) => (idx === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join('');
}

function detectSourcePrefix(existingFiles: Record<string, string>): string {
  return detectRepoConventions(existingFiles).sourceRoot;
}

function avoidCollision(desiredPath: string, existingFiles: Record<string, string>): string {
  if (!existingFiles[desiredPath]) return desiredPath;
  const ext = path.extname(desiredPath);
  const base = desiredPath.slice(0, -ext.length);
  let i = 2;
  while (existingFiles[`${base}${i}${ext}`]) {
    i++;
  }
  return `${base}${i}${ext}`;
}

export function buildFallbackFeaturePlan(
  prompt: string,
  existingFiles: Record<string, string>
): FeaturePlan {
  const summaryLine = prompt.trim().replace(/\s+/g, ' ').slice(0, 120) || 'requested change';
  const existingPaths = Object.keys(existingFiles).filter((p) => !p.includes('node_modules/'));
  const preferred =
    existingPaths.find((p) => /\.(ts|tsx|js|jsx|py|go|rs|java)$/i.test(p)) ?? existingPaths[0];

  if (preferred && existingFiles[preferred] != null) {
    const current = existingFiles[preferred];
    const marker = `// TODO: ${summaryLine}`;
    const next = current.includes(marker)
      ? current
      : `${current.replace(/\s*$/, '')}\n\n${marker}\n`;
    return {
      summary: `Queued one-file follow-up for: ${summaryLine}`,
      tasks: [
        {
          filePath: preferred,
          action: 'modify',
          description: `Record requested change in ${preferred}`,
          content: next,
        },
      ],
    };
  }

  const prefix = detectSourcePrefix(existingFiles);
  const slug = slugifyPromptFeature(prompt) || 'requestedChange';
  const modPath = avoidCollision(`${prefix}${slug}.ts`, existingFiles);
  return {
    summary: `Queued one-file placeholder for: ${summaryLine}`,
    tasks: [
      {
        filePath: modPath,
        action: 'create',
        description: `Add minimal placeholder for "${summaryLine}"`,
        content: [`// TODO: ${summaryLine}`, ''].join('\n'),
      },
    ],
  };
}

async function synthesizePlanWithGemini(
  ai: GoogleGenAI,
  prompt: string,
  existingFiles: Record<string, string>
): Promise<FeaturePlan | null> {
  const ctx = selectRelevantRepoContext(prompt, existingFiles, 18, 24_000);
  const importRule =
    ctx.conventions.hasTsConfig && !ctx.conventions.allowImportingTsExtensions
      ? 'Use extensionless relative imports (e.g., `./myModule`, NOT `./myModule.ts`) matching tsconfig.json.'
      : 'Use explicit `.ts` relative imports (e.g., `./myModule.ts`).';

  const fileSummary = ctx.selectedFiles
    .map(
      (f) =>
        `--- ${f.filePath}${f.exports.length > 0 ? ` (exports: ${f.exports.join(', ')})` : ''} ---\n${f.content}`
    )
    .join('\n\n');

  const fullPrompt = [
    `USER INSTRUCTION: ${prompt}`,
    '',
    'ENGINEERING GUIDELINES:',
    '- Produce exactly 1 file change (create or modify) that makes concrete, repo-aware progress on the request.',
    '- Work one file at a time: return only the single most relevant file to change now.',
    '- When modifying an existing file (`action: "modify"`), return the COMPLETE updated file content preserving all existing exports and behavior unless the request requires changing them.',
    '- If adding tests, keep them in the same file only when idiomatic for this repo; otherwise prefer integrating into an existing relevant file.',
    '- Do not fabricate demo/template modules unrelated to the request.',
    '',
    `REPOSITORY CONVENTIONS (${ctx.conventions.packageName}):`,
    `- Source root: ${ctx.conventions.sourceRoot || '(workspace root)'}`,
    `- TypeScript: ${ctx.conventions.isTypeScript ? 'yes' : 'no'}, tsconfig.json present: ${ctx.conventions.hasTsConfig ? 'yes' : 'no'}`,
    `- Import style: ${importRule}`,
    '',
    'CODEBASE SYMBOL MAP:',
    ctx.treeOverview,
    '',
    'MOST RELEVANT EXISTING FILES:',
    fileSummary,
  ].join('\n');

  try {
    const aiCall = ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: fullPrompt,
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        systemInstruction:
          'You are an autonomous multi-cursor engineering swarm working inside a real codebase. Produce one concrete, repo-aware file change at a time with natural, staged progress. Avoid fabricated demo/template behavior and do not add uninstalled dependencies.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            summary: { type: Type.STRING },
            tasks: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  filePath: { type: Type.STRING },
                  action: { type: Type.STRING },
                  description: { type: Type.STRING },
                  content: { type: Type.STRING },
                },
                required: ['filePath', 'action', 'description', 'content'],
              },
            },
          },
          required: ['summary', 'tasks'],
        },
      },
    });

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Gemini composer timeout')), 18_000)
    );
    const res = await Promise.race([aiCall, timeout]);
    const parsed = JSON.parse((res.text ?? '{}').trim()) as FeaturePlan;
    if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) return null;

    const validTasks: PlannedFileEdit[] = parsed.tasks
      .filter((t) => t.filePath && t.content && !t.filePath.includes('..'))
      .slice(0, 1)
      .map((t) => {
        const normalizedPath = t.filePath.replace(/^\/+/, '');
        return {
          filePath: normalizedPath,
          action: t.action === 'modify' && existingFiles[normalizedPath] ? 'modify' : 'create',
          description: t.description || `Write ${normalizedPath}`,
          content: t.content,
        };
      });

    if (validTasks.length === 0) return null;
    return {
      summary: parsed.summary || `Prepared 1 file change for the request.`,
      tasks: validTasks,
    };
  } catch {
    return null;
  }
}

async function repairFileWithGemini(
  ai: GoogleGenAI,
  filePath: string,
  content: string,
  errorsText: string
): Promise<string | null> {
  try {
    const aiCall = ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: [
        `File: ${filePath}`,
        'Compiler errors reported by tsc --noEmit:',
        errorsText,
        '',
        'Fix all TypeScript compiler errors in this file while preserving its public exports and behavior. Return JSON { "content": string } with the FULL corrected file.',
        '',
        'CURRENT FILE CONTENT:',
        content,
      ].join('\n'),
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        systemInstruction:
          'Return strictly compiling TypeScript code in JSON { "content": string }.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            content: { type: Type.STRING },
          },
          required: ['content'],
        },
      },
    });
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Gemini repair timeout')), 12_000)
    );
    const res = await Promise.race([aiCall, timeout]);
    const parsed = JSON.parse((res.text ?? '{}').trim()) as { content?: string };
    if (parsed.content && parsed.content.trim().length > 10) {
      return parsed.content;
    }
  } catch {
    return null;
  }
  return null;
}

const SPEED_MULTIPLIER: Record<CursorSpeed, number> = {
  slow: 1.0,
  normal: 0.55,
  fast: 0.25,
};

export async function runAutonomousFeatureBuild(params: {
  workspaceId: string;
  workspaceDir: string;
  prompt: string;
  agentCount?: number;
  speed?: CursorSpeed;
  useAi?: boolean;
  emit: (event: SwarmStreamEvent) => void;
}): Promise<void> {
  const { workspaceId, workspaceDir, prompt, useAi = true, speed = 'slow', emit } = params;
  const mult = SPEED_MULTIPLIER[speed] ?? 1.0;
  const numAgents = 10;

  const agents: CursorAgentState[] = SWARM_CURSOR_PROFILES.slice(0, numAgents).map((p) => ({
    id: p.id,
    name: '',
    color: p.color,
    status: 'scanning',
    filePath: null,
    line: 1,
    column: 1,
    task: 'Analyzing repository architecture…',
    diagnosticId: null,
    fixedCount: 0,
    createdCount: 0,
  }));

  for (const a of agents) {
    emit({ type: 'agent:update', agent: { ...a } });
  }

  emit({
    type: 'phase',
    phase: 'planning',
    message: `${numAgents} cursors converging on a one-file plan for: "${prompt.trim()}"…`,
  });

  const beforeFiles = await readAllTextFiles(workspaceDir);
  const ai = useAi ? getGeminiClient() : null;
  let plan = ai ? await synthesizePlanWithGemini(ai, prompt, beforeFiles.fileContents) : null;
  if (!plan) {
    plan = buildFallbackFeaturePlan(prompt, beforeFiles.fileContents);
  }

  const uniqueTasks: PlannedFileEdit[] = [];
  const seenUnique = new Set<string>();
  for (const t of plan.tasks) {
    if (seenUnique.has(t.filePath)) continue;
    seenUnique.add(t.filePath);
    uniqueTasks.push(t);
  }

  const activeTasks = uniqueTasks.slice(0, 1);
  const seenPaths = new Set(activeTasks.map((t) => t.filePath));

  const planSteps: ComposerPlanStep[] = activeTasks.map((t, idx) => ({
    id: `step-${idx + 1}`,
    filePath: t.filePath,
    action: t.action,
    description: t.description,
    agentId: agents[idx % agents.length].id,
    status: 'pending',
  }));

  emit({
    type: 'composer:plan',
    prompt,
    summary: plan.summary,
    steps: planSteps,
  });

  emit({
    type: 'phase',
    phase: 'writing',
    message: `${numAgents} cursors working one file at a time: ${activeTasks[0]?.filePath ?? 'no target file'}…`,
  });

  let createdCount = 0;
  let modifiedCount = 0;

  for (let tIdx = 0; tIdx < activeTasks.length; tIdx++) {
    const task = activeTasks[tIdx];
    const leadAgent = agents[0];

    for (let i = 0; i < agents.length; i++) {
      agents[i].status = i === 0 ? 'navigating' : 'scanning';
      agents[i].filePath = task.filePath;
      agents[i].line = 1;
      agents[i].column = 1;
      agents[i].task =
        i === 0
          ? `${task.action === 'create' ? 'Creating' : 'Opening'} ${task.filePath}…`
          : `Assisting in ${task.filePath}`;
      emit({
        type: 'agent:update',
        agent: { ...agents[i] },
        logLine:
          i === 0
            ? `[swarm] ${numAgents} cursors ${task.action === 'create' ? 'creating' : 'editing'} ${task.filePath}`
            : undefined,
      });
    }
    await sleep(Math.round(620 * mult));

    const allLines = task.content.split(/\r?\n/);
    const chunkSteps = Math.min(14, Math.max(5, Math.ceil(allLines.length / 3)));

    for (let step = 1; step <= chunkSteps; step++) {
      const endLine = Math.min(
        allLines.length,
        Math.ceil((allLines.length * step) / chunkSteps)
      );
      const partialContent = allLines.slice(0, endLine).join('\n');
      const activeLineText = allLines[Math.max(0, endLine - 1)] ?? '';

      leadAgent.status = 'writing';
      leadAgent.line = endLine;
      leadAgent.column = Math.max(1, activeLineText.length + 1);
      leadAgent.task = `Writing ${task.filePath}:${endLine} (${task.description})`;
      leadAgent.lastEditSnippet = activeLineText.trim();

      for (let i = 1; i < agents.length; i++) {
        const companionLine = Math.max(1, Math.min(endLine, Math.ceil((endLine * i) / agents.length)));
        agents[i].status = 'verifying';
        agents[i].filePath = task.filePath;
        agents[i].line = companionLine;
        agents[i].column = Math.max(1, Math.min(28, (i * 2) % 24));
        agents[i].task = `Auditing ${task.filePath}:${companionLine}`;
        emit({ type: 'agent:update', agent: { ...agents[i] } });
      }

      await writeWorkspaceFile(workspaceDir, task.filePath, partialContent);
      const midFiles = step === 1 ? (await readAllTextFiles(workspaceDir)).files : undefined;

      emit({ type: 'agent:update', agent: { ...leadAgent } });
      emit({
        type: 'file:streaming',
        agentId: leadAgent.id,
        agentName: leadAgent.name,
        agentColor: leadAgent.color,
        filePath: task.filePath,
        line: endLine,
        column: leadAgent.column,
        content: partialContent,
        action: task.action,
        files: midFiles,
      });
      await sleep(Math.round(380 * mult));
    }

    await writeWorkspaceFile(workspaceDir, task.filePath, task.content);
    const snapshot = await readAllTextFiles(workspaceDir);
    const gitDiff = await computeWorkspaceGitDiff(workspaceDir);
    const fileStatuses = await getWorkspaceFileStatuses(workspaceDir);

    if (task.action === 'create') {
      createdCount++;
      leadAgent.createdCount = (leadAgent.createdCount ?? 0) + 1;
      emit({
        type: 'file:created',
        agentId: leadAgent.id,
        agentName: leadAgent.name,
        agentColor: leadAgent.color,
        filePath: task.filePath,
        content: task.content,
        files: snapshot.files,
        fileStatuses,
        gitDiff,
      });
    } else {
      modifiedCount++;
      leadAgent.fixedCount += 1;
      emit({
        type: 'file:patched',
        agentId: leadAgent.id,
        agentName: leadAgent.name,
        agentColor: leadAgent.color,
        filePath: task.filePath,
        line: allLines.length,
        beforeLine: '',
        afterLine: allLines[allLines.length - 1] ?? '',
        content: task.content,
        gitDiff,
        fileStatuses,
        diagnosticIds: [],
      });
    }
    await sleep(Math.round(360 * mult));
  }

  for (const a of agents) {
    a.status = 'verifying';
    a.task = 'Checking tsc & tests…';
    emit({ type: 'agent:update', agent: { ...a } });
  }

  emit({
    type: 'phase',
    phase: 'verifying',
    message: 'Running real tsc --noEmit and tsx --test across built workspace…',
  });

  let finalFiles = await readAllTextFiles(workspaceDir);
  let finalDebug = await runParallelDebugSwarm(workspaceDir, finalFiles.fileContents, false);

  const touchedTsErrors = finalDebug.diagnostics.filter(
    (d) => !d.fixed && d.source === 'typescript' && seenPaths.has(d.filePath)
  );
  if (touchedTsErrors.length > 0 && ai) {
    emit({
      type: 'phase',
      phase: 'verifying',
      message: `Detected ${touchedTsErrors.length} TypeScript error(s) in generated files — running auto-repair pass…`,
    });
    const byTouchedFile = new Map<string, string[]>();
    for (const d of touchedTsErrors) {
      const list = byTouchedFile.get(d.filePath) ?? [];
      list.push(`Line ${d.line} [${d.code}]: ${d.message}`);
      byTouchedFile.set(d.filePath, list);
    }

    const verifierAgent = agents[agents.length - 1];
    let repairedAny = false;
    for (const [fp, errMsgs] of byTouchedFile.entries()) {
      const cur = finalFiles.fileContents[fp];
      if (!cur) continue;
      verifierAgent.status = 'editing';
      verifierAgent.filePath = fp;
      verifierAgent.line = 1;
      verifierAgent.task = `Auto-repairing ${errMsgs.length} tsc error(s) in ${fp}…`;
      emit({
        type: 'agent:update',
        agent: { ...verifierAgent },
        logLine: `[${verifierAgent.name}] Auto-repairing ${fp}: ${errMsgs[0]}`,
      });
      await sleep(Math.round(450 * mult));

      const fixedContent = await repairFileWithGemini(ai, fp, cur, errMsgs.join('\n'));
      if (fixedContent && fixedContent !== cur) {
        await writeWorkspaceFile(workspaceDir, fp, fixedContent);
        repairedAny = true;
        const [gitDiff, fileStatuses] = await Promise.all([
          computeWorkspaceGitDiff(workspaceDir),
          getWorkspaceFileStatuses(workspaceDir),
        ]);
        const fixedLines = fixedContent.split(/\r?\n/);
        emit({
          type: 'file:patched',
          agentId: verifierAgent.id,
          agentName: verifierAgent.name,
          agentColor: verifierAgent.color,
          filePath: fp,
          line: fixedLines.length,
          beforeLine: '',
          afterLine: fixedLines[fixedLines.length - 1] ?? '',
          content: fixedContent,
          gitDiff,
          fileStatuses,
          diagnosticIds: [],
        });
      }
    }
    if (repairedAny) {
      finalFiles = await readAllTextFiles(workspaceDir);
      finalDebug = await runParallelDebugSwarm(workspaceDir, finalFiles.fileContents, false);
    }
  }

  const finalDiff = await computeWorkspaceGitDiff(workspaceDir);
  const finalStatuses = await getWorkspaceFileStatuses(workspaceDir);

  for (const a of agents) {
    a.status = 'done';
    a.task =
      (a.createdCount ?? 0) > 0 || a.fixedCount > 0
        ? `Built ${a.createdCount ?? 0} file(s), verified ${finalDebug.testResult.passed} test(s)`
        : 'Verification complete';
    emit({ type: 'agent:update', agent: { ...a } });
  }

  emit({
    type: 'phase',
    phase: 'complete',
    message: `${plan.summary} (tsc errors: ${finalDebug.tscResult.errorCount}, tests passed: ${finalDebug.testResult.passed}).`,
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
        `[swarm] Active file complete: ${createdCount} created, ${modifiedCount} modified.`,
      ],
      gitDiff: finalDiff,
      fileStatuses: finalStatuses,
      totalElapsedMs: finalDebug.totalElapsedMs,
    },
    agents,
    fileContents: finalFiles.fileContents,
    files: finalFiles.files,
    fileStatuses: finalStatuses,
    fixedCount: modifiedCount,
    createdCount,
    summary: plan.summary,
  });
}
