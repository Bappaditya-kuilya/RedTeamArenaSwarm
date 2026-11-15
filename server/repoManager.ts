import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { RepoFileNode, WorkspaceSnapshot } from '../src/types/ide';

const execFileAsync = promisify(execFile);

const WORKSPACES_ROOT = '/tmp/swarm-workspaces';

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.cache',
  '.playwright-cli',
  'coverage',
  '__pycache__',
  '.venv',
  'vendor',
]);

const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.html',
  '.css',
  '.scss',
  '.py',
  '.go',
  '.rs',
  '.md',
  '.yml',
  '.yaml',
  '.env',
]);

export interface ActiveWorkspaceMeta {
  workspaceId: string;
  dir: string;
  repoName: string;
  repoUrl: string;
  sourceType: 'github' | 'workspace' | 'custom' | 'demo';
  branch: string;
  createdAt: number;
}

const activeWorkspaces = new Map<string, ActiveWorkspaceMeta>();

export function getWorkspaceMeta(workspaceId: string): ActiveWorkspaceMeta | undefined {
  return activeWorkspaces.get(workspaceId);
}

export function inferLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.ts':
    case '.tsx':
      return 'typescript';
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.json':
      return 'json';
    case '.html':
      return 'html';
    case '.css':
    case '.scss':
      return 'css';
    case '.py':
      return 'python';
    case '.go':
      return 'go';
    case '.rs':
      return 'rust';
    default:
      return 'text';
  }
}

export function parseGitHubInput(rawInput: string): {
  owner: string;
  repo: string;
  branch?: string;
  cloneUrl: string;
  displayUrl: string;
} {
  let cleaned = rawInput.trim();
  cleaned = cleaned.replace(/\.git$/i, '');

  const urlMatch = cleaned.match(
    /^https?:\/\/github\.com\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)(?:\/tree\/([a-zA-Z0-9_.-/]+))?/i
  );
  if (urlMatch) {
    const owner = urlMatch[1];
    const repo = urlMatch[2];
    const branch = urlMatch[3];
    return {
      owner,
      repo,
      branch,
      cloneUrl: `https://github.com/${owner}/${repo}.git`,
      displayUrl: `https://github.com/${owner}/${repo}`,
    };
  }

  const slugMatch = cleaned.match(/^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/);
  if (slugMatch) {
    const owner = slugMatch[1];
    const repo = slugMatch[2];
    return {
      owner,
      repo,
      cloneUrl: `https://github.com/${owner}/${repo}.git`,
      displayUrl: `https://github.com/${owner}/${repo}`,
    };
  }

  throw new Error('Enter a valid GitHub repository URL or owner/repo slug (e.g. califa/swarm-site).');
}

async function ensureGitBaseline(dir: string): Promise<string> {
  try {
    await fs.access(path.join(dir, '.git'));
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: dir,
      timeout: 5000,
    });
    return stdout.trim() || 'main';
  } catch {
    await execFileAsync('git', ['init'], { cwd: dir, timeout: 5000 });
    await execFileAsync('git', ['config', 'user.email', 'swarm@local'], { cwd: dir, timeout: 5000 });
    await execFileAsync('git', ['config', 'user.name', 'Swarm IDE'], { cwd: dir, timeout: 5000 });
    await execFileAsync('git', ['add', '-A'], { cwd: dir, timeout: 5000 });
    await execFileAsync('git', ['commit', '-m', 'Initial baseline'], { cwd: dir, timeout: 5000 });
    return 'main';
  }
}

export async function readAllTextFiles(dir: string): Promise<{
  files: RepoFileNode[];
  fileContents: Record<string, string>;
}> {
  const files: RepoFileNode[] = [];
  const fileContents: Record<string, string> = {};

  async function walk(currentDir: string) {
    if (files.length >= 900) return;
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (files.length >= 900) break;
      if (IGNORED_DIRS.has(entry.name)) continue;

      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.relative(dir, fullPath).split(path.sep).join('/');

      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (
        entry.name.endsWith('-lock.json') ||
        entry.name === 'yarn.lock' ||
        entry.name === 'pnpm-lock.yaml' ||
        /\.min\.(js|css)$/i.test(entry.name) ||
        entry.name.endsWith('.map')
      ) {
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();
      if (!TEXT_EXTENSIONS.has(ext)) continue;

      const stat = await fs.stat(fullPath);
      if (stat.size > 260_000) continue;

      const content = await fs.readFile(fullPath, 'utf-8');
      if (content.includes('\u0000')) continue;

      const lineCount = content.split(/\r?\n/).length;
      files.push({
        path: relPath,
        name: entry.name,
        language: inferLanguage(relPath),
        size: stat.size,
        lineCount,
        diagnosticCount: 0,
      });
      fileContents[relPath] = content;
    }
  }

  await walk(dir);
  return { files, fileContents };
}

async function fetchViaGitHubRestFallback(
  owner: string,
  repo: string,
  targetDir: string,
  preferredBranch?: string
): Promise<string> {
  const repoResp = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: { 'User-Agent': 'swarm-ide-debugger', Accept: 'application/vnd.github+json' },
  });
  if (!repoResp.ok) {
    throw new Error(`GitHub returned HTTP ${repoResp.status} for ${owner}/${repo}.`);
  }
  const repoJson = (await repoResp.json()) as { default_branch?: string };
  const branch = preferredBranch || repoJson.default_branch || 'main';

  const treeResp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    {
      headers: { 'User-Agent': 'swarm-ide-debugger', Accept: 'application/vnd.github+json' },
    }
  );
  if (!treeResp.ok) {
    throw new Error(`Unable to read GitHub file tree (${treeResp.status}).`);
  }
  const treeJson = (await treeResp.json()) as {
    tree?: Array<{ path: string; type: string; size?: number }>;
  };

  const candidates = (treeJson.tree ?? [])
    .filter(
      (item) =>
        item.type === 'blob' &&
        (item.size ?? 0) < 260_000 &&
        TEXT_EXTENSIONS.has(path.extname(item.path).toLowerCase()) &&
        !/\.min\.(js|css)$/i.test(item.path) &&
        !item.path.split('/').some((seg) => IGNORED_DIRS.has(seg))
    )
    .sort((a, b) => {
      const aSrc = /^(src|lib|server|app|packages|package\.json|tsconfig\.json)/i.test(a.path) ? 0 : 1;
      const bSrc = /^(src|lib|server|app|packages|package\.json|tsconfig\.json)/i.test(b.path) ? 0 : 1;
      return aSrc - bSrc || a.path.localeCompare(b.path);
    })
    .slice(0, 240);

  for (let i = 0; i < candidates.length; i += 20) {
    const batch = candidates.slice(i, i + 20);
    await Promise.all(
      batch.map(async (item) => {
        const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${item.path}`;
        const res = await fetch(rawUrl);
        if (!res.ok) return;
        const text = await res.text();
        const dest = path.resolve(targetDir, item.path);
        if (!dest.startsWith(targetDir + path.sep)) return;
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, text, 'utf-8');
      })
    );
  }

  return ensureGitBaseline(targetDir);
}

export async function importGitHubWorkspace(rawUrl: string): Promise<WorkspaceSnapshot> {
  const parsed = parseGitHubInput(rawUrl);
  const workspaceId = `gh-${parsed.repo}-${randomUUID().slice(0, 8)}`;
  const targetDir = path.join(WORKSPACES_ROOT, workspaceId);
  await fs.mkdir(WORKSPACES_ROOT, { recursive: true });

  let branch = parsed.branch || 'main';
  try {
    const cloneArgs = ['clone', '--depth', '1'];
    if (parsed.branch) {
      cloneArgs.push('--branch', parsed.branch);
    }
    cloneArgs.push(parsed.cloneUrl, targetDir);
    await execFileAsync('git', cloneArgs, {
      timeout: 45_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: targetDir,
      timeout: 5000,
    });
    branch = stdout.trim() || branch;
  } catch {
    await fs.rm(targetDir, { recursive: true, force: true });
    await fs.mkdir(targetDir, { recursive: true });
    branch = await fetchViaGitHubRestFallback(
      parsed.owner,
      parsed.repo,
      targetDir,
      parsed.branch
    );
  }

  const meta: ActiveWorkspaceMeta = {
    workspaceId,
    dir: targetDir,
    repoName: `${parsed.owner}/${parsed.repo}`,
    repoUrl: parsed.displayUrl,
    sourceType: 'github',
    branch,
    createdAt: Date.now(),
  };
  activeWorkspaces.set(workspaceId, meta);

  const { files, fileContents } = await readAllTextFiles(targetDir);
  return {
    workspaceId,
    repoName: meta.repoName,
    repoUrl: meta.repoUrl,
    sourceType: 'github',
    branch,
    files,
    fileContents,
  };
}

export async function importLocalWorkspace(projectRoot: string): Promise<WorkspaceSnapshot> {
  const workspaceId = `local-${randomUUID().slice(0, 8)}`;
  const targetDir = path.join(WORKSPACES_ROOT, workspaceId);
  await fs.mkdir(targetDir, { recursive: true });

  const copyTargets = ['src', 'server', 'package.json', 'tsconfig.json', 'index.html', 'server.ts'];
  for (const rel of copyTargets) {
    const srcPath = path.join(projectRoot, rel);
    try {
      await fs.access(srcPath);
      await fs.cp(srcPath, path.join(targetDir, rel), {
        recursive: true,
        filter: (p) => !IGNORED_DIRS.has(path.basename(p)),
      });
    } catch {
      // Skip optional files
    }
  }

  const branch = await ensureGitBaseline(targetDir);
  const meta: ActiveWorkspaceMeta = {
    workspaceId,
    dir: targetDir,
    repoName: 'local/workspace-app',
    repoUrl: 'local://app/applet',
    sourceType: 'workspace',
    branch,
    createdAt: Date.now(),
  };
  activeWorkspaces.set(workspaceId, meta);

  const { files, fileContents } = await readAllTextFiles(targetDir);
  return {
    workspaceId,
    repoName: meta.repoName,
    repoUrl: meta.repoUrl,
    sourceType: 'workspace',
    branch,
    files,
    fileContents,
  };
}

export async function importCustomFilesWorkspace(
  name: string,
  inputFiles: Array<{ path: string; content: string }>
): Promise<WorkspaceSnapshot> {
  const workspaceId = `custom-${randomUUID().slice(0, 8)}`;
  const targetDir = path.join(WORKSPACES_ROOT, workspaceId);
  await fs.mkdir(targetDir, { recursive: true });

  for (const f of inputFiles) {
    const cleanRel = f.path.replace(/^\/+/, '');
    const dest = path.resolve(targetDir, cleanRel);
    if (!dest.startsWith(targetDir + path.sep)) {
      throw new Error(`Invalid file path: ${f.path}`);
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, f.content, 'utf-8');
  }

  const branch = await ensureGitBaseline(targetDir);
  const meta: ActiveWorkspaceMeta = {
    workspaceId,
    dir: targetDir,
    repoName: name || 'custom/uploaded-files',
    repoUrl: 'local://uploaded',
    sourceType: 'custom',
    branch,
    createdAt: Date.now(),
  };
  activeWorkspaces.set(workspaceId, meta);

  const { files, fileContents } = await readAllTextFiles(targetDir);
  return {
    workspaceId,
    repoName: meta.repoName,
    repoUrl: meta.repoUrl,
    sourceType: 'custom',
    branch,
    files,
    fileContents,
  };
}

export async function importBuggyDemoWorkspace(): Promise<WorkspaceSnapshot> {
  const workspaceId = `demo-${randomUUID().slice(0, 8)}`;
  const targetDir = path.join(WORKSPACES_ROOT, workspaceId);
  await fs.mkdir(targetDir, { recursive: true });

  const demoFiles: Array<{ path: string; content: string }> = [
    {
      path: 'package.json',
      content: JSON.stringify(
        {
          name: 'billing-service-sandbox',
          version: '1.0.0',
          type: 'module',
        },
        null,
        2
      ),
    },
    {
      path: 'src/pricing.ts',
      content: [
        'export function calculateInvoiceTotal(rawQty: string, unitPrice: number): number {',
        "  const taxRate: number = '0.08';",
        '  const qty = parseInt(rawQty);',
        '  if (qty == 0) throw "Quantity must be positive";',
        '  return Number((qty * unitPrice * (1 + taxRate)).toFixed(2));',
        '}',
        '',
        'export function formatCurrencyCents(centsInput: string): string {',
        '  const cents = parseInt(centsInput);',
        '  if (Number.isNaN(cents)) {',
        '    throw "Invalid cents value";',
        '  }',
        '  return `$${(cents / 100).toFixed(2)}`;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/pricing.test.ts',
      content: [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { calculateInvoiceTotal, formatCurrencyCents } from './pricing.ts';",
        '',
        "test('calculateInvoiceTotal computes qty * unitPrice with 8% tax', () => {",
        "  assert.equal(calculateInvoiceTotal('2', 50), 108);",
        '});',
        '',
        "test('formatCurrencyCents formats USD dollars accurately', () => {",
        "  assert.equal(formatCurrencyCents('1250'), '$12.50');",
        '});',
        '',
      ].join('\n'),
    },
    {
      path: 'src/users.ts',
      content: [
        'export interface DbClient {',
        '  query: (sql: string, params?: unknown[]) => Promise<unknown[]>;',
        '}',
        '',
        'export async function findUserByEmail(db: DbClient, email: string) {',
        '  const rows = await db.query("SELECT id, email FROM users WHERE email = " + email);',
        '  return rows[0] ?? null;',
        '}',
        '',
        'export function parseUserMetadata(rawJson: string): Record<string, unknown> | null {',
        '  const parsed = JSON.parse(rawJson);',
        '  try {',
        '    if (parsed == null) return null;',
        '    return parsed as Record<string, unknown>;',
        '  } catch (err) {}',
        '  return null;',
        '}',
        '',
      ].join('\n'),
    },
    {
      path: 'src/render.ts',
      content: [
        'export function renderProfileCard(container: { textContent: string | null; innerHTML: string }, bio: string) {',
        '  debugger;',
        '  container.innerHTML = bio;',
        '}',
        '',
        'export function externalLinkMarkup(url: string, label: string): string {',
        '  const safeHref: string = 404;',
        '  void safeHref;',
        '  return `<a href="${url}" target="_blank">${label}</a>`;',
        '}',
        '',
      ].join('\n'),
    },
  ];

  for (const f of demoFiles) {
    const dest = path.resolve(targetDir, f.path);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, f.content, 'utf-8');
  }

  const branch = await ensureGitBaseline(targetDir);
  const meta: ActiveWorkspaceMeta = {
    workspaceId,
    dir: targetDir,
    repoName: 'demo/billing-ts-service',
    repoUrl: 'local://demo-billing-ts',
    sourceType: 'demo',
    branch,
    createdAt: Date.now(),
  };
  activeWorkspaces.set(workspaceId, meta);

  const { files, fileContents } = await readAllTextFiles(targetDir);
  return {
    workspaceId,
    repoName: meta.repoName,
    repoUrl: meta.repoUrl,
    sourceType: 'demo',
    branch,
    files,
    fileContents,
  };
}

export function resolveSafeFilePath(workspaceDir: string, relPath: string): string {
  const resolved = path.resolve(workspaceDir, relPath.replace(/^\/+/, ''));
  if (resolved !== workspaceDir && !resolved.startsWith(workspaceDir + path.sep)) {
    throw new Error('Blocked unsafe workspace file path.');
  }
  return resolved;
}

export async function writeWorkspaceFile(
  workspaceDir: string,
  relPath: string,
  content: string
): Promise<void> {
  const fullPath = resolveSafeFilePath(workspaceDir, relPath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf-8');
}

export async function getWorkspaceFileStatuses(
  workspaceDir: string
): Promise<Record<string, 'M' | 'A'>> {
  const statuses: Record<string, 'M' | 'A'> = {};
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd: workspaceDir,
      timeout: 5000,
    });
    for (const rawLine of stdout.split(/\r?\n/)) {
      if (!rawLine || rawLine.length < 4) continue;
      const code = rawLine.slice(0, 2);
      const rel = rawLine.slice(3).trim().replace(/^"(.*)"$/, '$1');
      if (!rel) continue;
      if (code.includes('?') || code.includes('A')) {
        statuses[rel] = 'A';
      } else if (code.includes('M') || code.includes('R')) {
        statuses[rel] = 'M';
      }
    }
  } catch {
    // Ignore git status failures
  }
  return statuses;
}

export async function computeWorkspaceGitDiff(workspaceDir: string): Promise<string> {
  try {
    // Stage untracked files with intent-to-add so newly built files appear in `git diff`
    await execFileAsync('git', ['add', '-N', '.'], {
      cwd: workspaceDir,
      timeout: 5000,
    }).catch(() => {});

    const { stdout } = await execFileAsync('git', ['diff', '--no-color'], {
      cwd: workspaceDir,
      timeout: 5000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return '';
  }
}

export async function revertWorkspaceChanges(workspaceDir: string): Promise<void> {
  await execFileAsync('git', ['reset', '--hard', 'HEAD'], {
    cwd: workspaceDir,
    timeout: 5000,
  });
  await execFileAsync('git', ['clean', '-fd'], {
    cwd: workspaceDir,
    timeout: 5000,
  });
}

export async function runSafeWorkspaceCommand(
  workspaceDir: string,
  rawCommand: string
): Promise<{ exitCode: number; output: string }> {
  const trimmed = rawCommand.trim();
  const { files } = await readAllTextFiles(workspaceDir);

  if (trimmed === 'help') {
    return {
      exitCode: 0,
      output: [
        'Available real workspace commands:',
        '  tsc --noEmit     Run TypeScript 7 compiler across workspace .ts/.tsx files',
        '  tsx --test       Execute unit tests with Node test runner + tsx',
        '  node --test      Execute JS/MJS test suite',
        '  git status       Show modified and newly added files',
        '  git diff         Show unified diff against baseline commit',
        '  ls               List workspace source files',
      ].join('\n'),
    };
  }

  if (trimmed === 'ls' || trimmed === 'dir') {
    return {
      exitCode: 0,
      output: files.map((f) => `${f.path} (${f.lineCount} lines)`).join('\n') || '(empty)',
    };
  }

  if (trimmed === 'git status') {
    const { stdout } = await execFileAsync('git', ['status', '-s'], {
      cwd: workspaceDir,
      timeout: 5000,
    });
    return { exitCode: 0, output: stdout.trim() || 'On branch main\nnothing to commit, working tree clean' };
  }

  if (trimmed === 'git diff') {
    const diff = await computeWorkspaceGitDiff(workspaceDir);
    return { exitCode: 0, output: diff.trim() || '(no changes in working tree)' };
  }

  if (trimmed.startsWith('tsc')) {
    const tsFiles = files
      .map((f) => f.path)
      .filter((p) => /\.(ts|tsx)$/i.test(p) && !p.endsWith('.d.ts'))
      .slice(0, 250);
    if (tsFiles.length === 0) {
      return { exitCode: 0, output: 'No TypeScript files found in workspace.' };
    }
    const tscBin = path.resolve(process.cwd(), 'node_modules/.bin/tsc');
    let hasTsConfig = false;
    try {
      await fs.access(path.join(workspaceDir, 'tsconfig.json'));
      hasTsConfig = true;
    } catch {
      hasTsConfig = false;
    }
    const tscArgs = hasTsConfig
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
          ...tsFiles,
        ];
    try {
      const { stdout, stderr } = await execFileAsync(tscBin, tscArgs, {
        cwd: workspaceDir,
        timeout: 15_000,
      });
      return {
        exitCode: 0,
        output: [stdout, stderr].filter(Boolean).join('\n').trim() || `tsc --noEmit: 0 errors (${tsFiles.length} files checked).`,
      };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number };
      return {
        exitCode: typeof e.code === 'number' ? e.code : 1,
        output: [e.stdout, e.stderr].filter(Boolean).join('\n').trim() || 'TypeScript check reported errors.',
      };
    }
  }

  if (trimmed.startsWith('tsx --test') || trimmed.startsWith('node --test')) {
    const testFiles = files
      .map((f) => f.path)
      .filter((p) => /\.(test|spec)\.(ts|tsx|js|mjs|cjs)$/i.test(p))
      .slice(0, 25);
    if (testFiles.length === 0) {
      return { exitCode: 0, output: 'No *.test.* or *.spec.* files found in workspace.' };
    }
    const tsxBin = path.resolve(process.cwd(), 'node_modules/.bin/tsx');
    const useTsx = trimmed.startsWith('tsx') || testFiles.some((f) => /\.tsx?$/i.test(f));
    try {
      const { stdout, stderr } = await execFileAsync(
        useTsx ? tsxBin : 'node',
        ['--test', ...testFiles],
        { cwd: workspaceDir, timeout: 10_000, env: { ...process.env, NODE_ENV: 'test' } }
      );
      return {
        exitCode: 0,
        output: [stdout, stderr].filter(Boolean).join('\n').trim(),
      };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number };
      return {
        exitCode: typeof e.code === 'number' ? e.code : 1,
        output: [e.stdout, e.stderr].filter(Boolean).join('\n').trim() || 'Test suite failed.',
      };
    }
  }

  return {
    exitCode: 127,
    output: `Command "${trimmed}" not permitted in sandbox terminal. Type "help" for real tsc, tsx --test, git, and ls commands.`,
  };
}

