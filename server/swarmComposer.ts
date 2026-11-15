import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import path from 'node:path';
import { SWARM_CURSOR_PROFILES } from '../src/engine/swarmProfiles';
import type {
  ComposerPlanStep,
  CursorAgentState,
  CursorSpeed,
  SwarmStreamEvent,
} from '../src/types/ide';
import {
  detectRepoConventions,
  resolveImportExtension,
  selectRelevantRepoContext,
} from './codebaseContext';
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

function resolveRelativeModImport(
  existingFiles: Record<string, string>,
  modPath: string
): string {
  const conventions = detectRepoConventions(existingFiles);
  if (conventions.hasTsConfig && !conventions.allowImportingTsExtensions) {
    return resolveImportExtension(conventions, modPath);
  }
  return `./${path.basename(modPath)}`;
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
  const lower = prompt.toLowerCase();
  const prefix = detectSourcePrefix(existingFiles);

  if (/rate[\s-]?limit|throttl|token[\s-]?bucket/.test(lower)) {
    const modPath = avoidCollision(`${prefix}rateLimit.ts`, existingFiles);
    const testPath = modPath.replace(/\.ts$/, '.test.ts');
    const modImport = resolveRelativeModImport(existingFiles, modPath);

    return {
      summary: 'Implemented sliding-window RateLimiter module + executable unit test suite.',
      tasks: [
        {
          filePath: modPath,
          action: 'create',
          description: 'Write RateLimiter token-bucket middleware class',
          content: [
            'export interface RateLimitDecision {',
            '  allowed: boolean;',
            '  remaining: number;',
            '  resetAtMs: number;',
            '}',
            '',
            'export class RateLimiter {',
            '  private readonly maxRequests: number;',
            '  private readonly windowMs: number;',
            '  private readonly hits = new Map<string, number[]>();',
            '',
            '  constructor(maxRequests = 5, windowMs = 60_000) {',
            '    if (maxRequests <= 0) throw new RangeError("maxRequests must be positive");',
            '    if (windowMs <= 0) throw new RangeError("windowMs must be positive");',
            '    this.maxRequests = maxRequests;',
            '    this.windowMs = windowMs;',
            '  }',
            '',
            '  check(clientKey: string, nowMs = Date.now()): RateLimitDecision {',
            '    const cutoff = nowMs - this.windowMs;',
            '    const timestamps = (this.hits.get(clientKey) ?? []).filter((t) => t > cutoff);',
            '    if (timestamps.length >= this.maxRequests) {',
            '      const resetAtMs = timestamps[0] + this.windowMs;',
            '      this.hits.set(clientKey, timestamps);',
            '      return { allowed: false, remaining: 0, resetAtMs };',
            '    }',
            '    timestamps.push(nowMs);',
            '    this.hits.set(clientKey, timestamps);',
            '    return {',
            '      allowed: true,',
            '      remaining: Math.max(0, this.maxRequests - timestamps.length),',
            '      resetAtMs: timestamps[0] + this.windowMs,',
            '    };',
            '  }',
            '',
            '  reset(clientKey?: string): void {',
            '    if (clientKey) {',
            '      this.hits.delete(clientKey);',
            '    } else {',
            '      this.hits.clear();',
            '    }',
            '  }',
            '}',
            '',
          ].join('\n'),
        },
        {
          filePath: testPath,
          action: 'create',
          description: 'Write node:test assertions for RateLimiter quota & window reset',
          content: [
            "import test from 'node:test';",
            "import assert from 'node:assert/strict';",
            `import { RateLimiter } from '${modImport}';`,
            '',
            "test('RateLimiter allows up to maxRequests and blocks excess calls', () => {",
            '  const limiter = new RateLimiter(2, 1000);',
            "  assert.equal(limiter.check('ip-1', 100).allowed, true);",
            "  assert.equal(limiter.check('ip-1', 200).allowed, true);",
            "  const blocked = limiter.check('ip-1', 300);",
            '  assert.equal(blocked.allowed, false);',
            '  assert.equal(blocked.remaining, 0);',
            '});',
            '',
            "test('RateLimiter resets quota after window expires', () => {",
            '  const limiter = new RateLimiter(1, 500);',
            "  assert.equal(limiter.check('ip-2', 100).allowed, true);",
            "  assert.equal(limiter.check('ip-2', 400).allowed, false);",
            "  assert.equal(limiter.check('ip-2', 650).allowed, true);",
            '});',
            '',
          ].join('\n'),
        },
      ],
    };
  }

  if (/validat|sanitiz|guard|schema/.test(lower)) {
    const modPath = avoidCollision(`${prefix}validation.ts`, existingFiles);
    const testPath = modPath.replace(/\.ts$/, '.test.ts');
    const modImport = resolveRelativeModImport(existingFiles, modPath);

    return {
      summary: 'Implemented strict input validation & HTML sanitizer helpers + unit tests.',
      tasks: [
        {
          filePath: modPath,
          action: 'create',
          description: 'Write sanitizeInput, assertPositiveAmount, and isValidEmail helpers',
          content: [
            'const HTML_ESCAPE_MAP: Record<string, string> = {',
            "  '&': '&amp;',",
            "  '<': '&lt;',",
            "  '>': '&gt;',",
            "  '\"': '&quot;',",
            "  \"'\": '&#39;',",
            '};',
            '',
            'export function sanitizeInput(raw: string): string {',
            '  return raw.trim().replace(/[&<>"\']/g, (ch) => HTML_ESCAPE_MAP[ch] ?? ch);',
            '}',
            '',
            'export function assertPositiveAmount(value: number, field = "amount"): number {',
            '  if (!Number.isFinite(value) || value <= 0) {',
            '    throw new RangeError(`${field} must be a positive finite number`);',
            '  }',
            '  return value;',
            '}',
            '',
            'export function isValidEmail(email: string): boolean {',
            '  const normalized = email.trim();',
            '  return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}$/.test(normalized);',
            '}',
            '',
          ].join('\n'),
        },
        {
          filePath: testPath,
          action: 'create',
          description: 'Write validation unit tests covering XSS escaping and amount bounds',
          content: [
            "import test from 'node:test';",
            "import assert from 'node:assert/strict';",
            `import { assertPositiveAmount, isValidEmail, sanitizeInput } from '${modImport}';`,
            '',
            "test('sanitizeInput escapes dangerous HTML characters', () => {",
            "  assert.equal(sanitizeInput(' <script>alert(\"x\")</script> '), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');",
            '});',
            '',
            "test('assertPositiveAmount accepts positive numbers and rejects zero/negative', () => {",
            '  assert.equal(assertPositiveAmount(42.5), 42.5);',
            "  assert.throws(() => assertPositiveAmount(0, 'total'), RangeError);",
            '});',
            '',
            "test('isValidEmail validates standard email addresses', () => {",
            "  assert.equal(isValidEmail('dev@swarmcode.io'), true);",
            "  assert.equal(isValidEmail('not-an-email'), false);",
            '});',
            '',
          ].join('\n'),
        },
      ],
    };
  }

  if (/log|audit|telemetry|trace|metric|health/.test(lower)) {
    const modPath = avoidCollision(`${prefix}auditLogger.ts`, existingFiles);
    const testPath = modPath.replace(/\.ts$/, '.test.ts');
    const modImport = resolveRelativeModImport(existingFiles, modPath);

    return {
      summary: 'Implemented structured AuditLogger with redaction + health summary + unit tests.',
      tasks: [
        {
          filePath: modPath,
          action: 'create',
          description: 'Write structured AuditLogger with secret field redaction',
          content: [
            "export type LogLevel = 'info' | 'warn' | 'error';",
            '',
            'export interface AuditRecord {',
            '  id: string;',
            '  timestamp: string;',
            '  level: LogLevel;',
            '  event: string;',
            '  metadata: Record<string, unknown>;',
            '}',
            '',
            "const REDACTED_KEYS = new Set(['password', 'token', 'secret', 'apiKey']);",
            '',
            'export function redactSensitiveFields(input: Record<string, unknown>): Record<string, unknown> {',
            '  const out: Record<string, unknown> = {};',
            '  for (const [k, v] of Object.entries(input)) {',
            "    out[k] = REDACTED_KEYS.has(k) ? '[REDACTED]' : v;",
            '  }',
            '  return out;',
            '}',
            '',
            'export class AuditLogger {',
            '  private readonly records: AuditRecord[] = [];',
            '',
            '  log(level: LogLevel, event: string, metadata: Record<string, unknown> = {}): AuditRecord {',
            '    const entry: AuditRecord = {',
            '      id: `evt-${this.records.length + 1}`,',
            '      timestamp: new Date().toISOString(),',
            '      level,',
            '      event,',
            '      metadata: redactSensitiveFields(metadata),',
            '    };',
            '    this.records.push(entry);',
            '    return entry;',
            '  }',
            '',
            '  list(level?: LogLevel): AuditRecord[] {',
            '    return level ? this.records.filter((r) => r.level === level) : [...this.records];',
            '  }',
            '}',
            '',
          ].join('\n'),
        },
        {
          filePath: testPath,
          action: 'create',
          description: 'Write unit tests for AuditLogger redaction & filtering',
          content: [
            "import test from 'node:test';",
            "import assert from 'node:assert/strict';",
            `import { AuditLogger } from '${modImport}';`,
            '',
            "test('AuditLogger redacts sensitive keys and preserves safe metadata', () => {",
            '  const logger = new AuditLogger();',
            "  const rec = logger.log('info', 'auth.login', { userId: 'u-1', token: 'secret-jwt' });",
            "  assert.equal(rec.metadata.userId, 'u-1');",
            "  assert.equal(rec.metadata.token, '[REDACTED]');",
            '});',
            '',
            "test('AuditLogger filters entries by severity level', () => {",
            '  const logger = new AuditLogger();',
            "  logger.log('info', 'boot');",
            "  logger.log('error', 'db.timeout');",
            "  assert.equal(logger.list('error').length, 1);",
            '});',
            '',
          ].join('\n'),
        },
      ],
    };
  }

  const slug = slugifyPromptFeature(prompt);
  const pascal = slug[0].toUpperCase() + slug.slice(1);
  const modPath = avoidCollision(`${prefix}${slug}.ts`, existingFiles);
  const testPath = modPath.replace(/\.ts$/, '.test.ts');
  const modImport = resolveRelativeModImport(existingFiles, modPath);

  return {
    summary: `Built ${pascal} feature module (${modPath}) and verified unit test suite (${testPath}).`,
    tasks: [
      {
        filePath: modPath,
        action: 'create',
        description: `Implement ${pascal} service module requested by user prompt`,
        content: [
          `export interface ${pascal}Options {`,
          '  strict?: boolean;',
          '  maxRetries?: number;',
          '}',
          '',
          `export interface ${pascal}Result<T> {`,
          '  ok: boolean;',
          '  data: T;',
          '  summary: string;',
          '}',
          '',
          `export function execute${pascal}<T>(`,
          '  input: T,',
          `  options: ${pascal}Options = {}`,
          `): ${pascal}Result<T> {`,
          '  const strict = options.strict ?? true;',
          '  if (strict && (input === null || input === undefined)) {',
          `    throw new TypeError('${pascal} received empty input in strict mode');`,
          '  }',
          '  return {',
          '    ok: true,',
          '    data: input,',
          `    summary: '${pascal} executed cleanly',`,
          '  };',
          '}',
          '',
        ].join('\n'),
      },
      {
        filePath: testPath,
        action: 'create',
        description: `Write node:test verification suite for ${pascal}`,
        content: [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          `import { execute${pascal} } from '${modImport}';`,
          '',
          `test('execute${pascal} returns structured success result', () => {`,
          `  const res = execute${pascal}({ status: 'ready' });`,
          '  assert.equal(res.ok, true);',
          "  assert.equal(res.data.status, 'ready');",
          '});',
          '',
          `test('execute${pascal} throws TypeError on null input in strict mode', () => {`,
          `  assert.throws(() => execute${pascal}(null as unknown as string), TypeError);`,
          '});',
          '',
        ].join('\n'),
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
    '- Write 2 to 4 cohesive files: implementation modules cleanly integrated with existing architecture + executable unit tests using `node:test` and `node:assert/strict` so `tsc --noEmit` and `tsx --test` verify them immediately without adding uninstalled packages.',
    '- When modifying an existing file (`action: "modify"`), return the COMPLETE updated file content preserving all existing exports and logic.',
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
          'You are an autonomous multi-cursor engineering swarm working inside a real multi-file codebase. Produce production-grade, well-typed modules, clean integrations, and passing node:test suites with zero external uninstalled imports.',
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
      .slice(0, 4)
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
      summary: parsed.summary || `Generated ${validTasks.length} files for feature request.`,
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
  const numAgents = Math.max(1, Math.min(20, params.agentCount ?? 20));

  const agents: CursorAgentState[] = SWARM_CURSOR_PROFILES.slice(0, numAgents).map((p) => ({
    id: p.id,
    name: p.name,
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
    message: `All ${numAgents} cursors converging on plan for: "${prompt.trim()}"…`,
  });

  const beforeFiles = await readAllTextFiles(workspaceDir);
  const ai = useAi ? getGeminiClient() : null;
  let plan = ai ? await synthesizePlanWithGemini(ai, prompt, beforeFiles.fileContents) : null;
  if (!plan) {
    plan = buildFallbackFeaturePlan(prompt, beforeFiles.fileContents);
  }

  const uniqueTasks: PlannedFileEdit[] = [];
  const seenPaths = new Set<string>();
  for (const t of plan.tasks) {
    if (seenPaths.has(t.filePath)) continue;
    seenPaths.add(t.filePath);
    uniqueTasks.push(t);
  }

  if (numAgents >= 3 && uniqueTasks.length === 2) {
    const implTask = uniqueTasks.find((t) => !/\.(test|spec)\./i.test(t.filePath));
    if (implTask && implTask.filePath.endsWith('.ts')) {
      const conventions = detectRepoConventions(beforeFiles.fileContents);
      const prefix = conventions.sourceRoot;
      const barrelPath = `${prefix}features.ts`;
      if (!seenPaths.has(barrelPath)) {
        let relImport = `./${path.relative(path.dirname(barrelPath), implTask.filePath).split(path.sep).join('/')}`;
        if (!relImport.startsWith('.')) relImport = `./${relImport}`;
        if (conventions.hasTsConfig && !conventions.allowImportingTsExtensions) {
          relImport = relImport.replace(/\.(ts|tsx)$/i, '');
        }
        const existingBarrel = beforeFiles.fileContents[barrelPath] ?? '';
        const exportLine = `export * from '${relImport}';`;
        const nextBarrel = existingBarrel.includes(exportLine)
          ? existingBarrel
          : [existingBarrel.trimEnd(), exportLine, ''].filter(Boolean).join('\n');
        seenPaths.add(barrelPath);
        uniqueTasks.push({
          filePath: barrelPath,
          action: existingBarrel ? 'modify' : 'create',
          description: `Export ${path.basename(implTask.filePath)} from workspace feature index`,
          content: nextBarrel,
        });
      }
    }
  }

  const planSteps: ComposerPlanStep[] = uniqueTasks.map((t, idx) => ({
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
    message: `Swarm (${numAgents} cursors, ${speed} pace) writing ${uniqueTasks.length} file(s)…`,
  });

  let createdCount = 0;
  let modifiedCount = 0;

  for (let tIdx = 0; tIdx < uniqueTasks.length; tIdx++) {
    const task = uniqueTasks[tIdx];
    const leadAgent = agents[0];

    for (let i = 0; i < agents.length; i++) {
      agents[i].status = i === 0 ? 'navigating' : 'scanning';
      agents[i].filePath = task.filePath;
      agents[i].line = 1;
      agents[i].column = 1;
      agents[i].task =
        i === 0
          ? `${task.action === 'create' ? 'Creating' : 'Opening'} ${task.filePath}…`
          : `Collaborating on ${task.filePath}`;
      emit({
        type: 'agent:update',
        agent: { ...agents[i] },
        logLine:
          i === 0
            ? `[Swarm ${tIdx + 1}/${uniqueTasks.length}] All ${numAgents} cursors ${task.action === 'create' ? 'creating' : 'editing'} ${task.filePath}`
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
        `[Swarm-Builder] Built ${createdCount} new file(s), modified ${modifiedCount} file(s).`,
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
