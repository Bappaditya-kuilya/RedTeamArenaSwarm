import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { RepoFileNode, WorkspaceSnapshot } from '../src/types/ide';

const execFileAsync = promisify(execFile);
const GITHUB_FETCH_TIMEOUT_MS = 15_000;

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = GITHUB_FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function describeGitHubHttpError(status: number, context: string): string {
  if (status === 403) return `${context}: GitHub API rate limit or access forbidden (HTTP 403).`;
  if (status === 429) return `${context}: GitHub API rate limited (HTTP 429). Retry later.`;
  return `${context}: GitHub returned HTTP ${status}.`;
}

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

export interface WorkspaceImportMeta {
  method: 'git-clone' | 'github-rest' | 'local-copy' | 'custom-write' | 'demo';
  partial?: boolean;
  note?: string;
  filesFetched?: number;
  filesCapped?: boolean;
  dependencyInstall?: {
    attempted: boolean;
    packageManager?: 'npm' | 'pnpm' | 'yarn' | 'bun';
    command?: string;
    success?: boolean;
    exitCode?: number;
    output?: string;
  };
}

export interface ActiveWorkspaceMeta {
  workspaceId: string;
  dir: string;
  repoName: string;
  repoUrl: string;
  sourceType: 'github' | 'workspace' | 'custom' | 'demo';
  branch: string;
  createdAt: number;
  importMeta?: WorkspaceImportMeta;
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
  const execGit = (args: string[]) =>
    execFileAsync('git', args, { cwd: dir, timeout: 5000 });

  let hasGitDir = false;
  try {
    await fs.access(path.join(dir, '.git'));
    hasGitDir = true;
  } catch {
    hasGitDir = false;
  }

  if (hasGitDir) {
    try {
      const { stdout } = await execGit(['rev-parse', '--abbrev-ref', 'HEAD']);
      const branch = stdout.trim();
      if (branch && branch !== 'HEAD') return branch;
      // Unborn HEAD or detached/unresolved: try to discover a branch name.
      try {
        const { stdout: sym } = await execGit(['symbolic-ref', '--short', 'HEAD']);
        const symBranch = sym.trim();
        if (symBranch) return symBranch;
      } catch {
        // ignore
      }
      return 'main';
    } catch {
      // Existing .git but HEAD unreadable; fall through to initialize baseline.
    }
  }

  try {
    await execGit(['init']);
    await execGit(['config', 'user.email', 'swarm@local']);
    await execGit(['config', 'user.name', 'Swarm IDE']);
    await execGit(['add', '-A']);
    try {
      await execGit(['commit', '-m', 'Initial baseline', '--allow-empty']);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // "nothing to commit" / existing baseline cases are non-fatal for baseline setup.
      if (!/nothing to commit|nothing added to commit|already exists|previous cherry-pick/i.test(msg)) {
        // If commit failed for another reason but repo is initialized, continue with resolved branch.
      }
    }
    try {
      const { stdout } = await execGit(['rev-parse', '--abbrev-ref', 'HEAD']);
      const branch = stdout.trim();
      if (branch && branch !== 'HEAD') return branch;
    } catch {
      // Unborn HEAD after init (e.g. empty commit disallowed in some envs) is acceptable.
    }
    return 'main';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/not found|ENOENT|spawn git/i.test(msg)) {
      throw new Error(`Git is required but unavailable in this environment: ${msg}`);
    }
    throw new Error(`Failed to initialize workspace git baseline: ${msg}`);
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

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

async function detectPackageManager(workspaceDir: string): Promise<PackageManager | null> {
  const checks: Array<[PackageManager, string[]]> = [
    ['pnpm', ['pnpm-lock.yaml']],
    ['yarn', ['yarn.lock']],
    ['bun', ['bun.lockb', 'bun.lock']],
    ['npm', ['package-lock.json', 'npm-shrinkwrap.json']],
  ];
  for (const [pm, lockfiles] of checks) {
    for (const lf of lockfiles) {
      try {
        await fs.access(path.join(workspaceDir, lf));
        return pm;
      } catch {
        // continue
      }
    }
  }
  try {
    await fs.access(path.join(workspaceDir, 'package.json'));
    return 'npm';
  } catch {
    return null;
  }
}

function installCommandForPackageManager(pm: PackageManager): { cmd: string; args: string[]; label: string } {
  switch (pm) {
    case 'pnpm':
      return { cmd: 'pnpm', args: ['install', '--ignore-scripts', '--frozen-lockfile=false'], label: 'pnpm install --ignore-scripts' };
    case 'yarn':
      return { cmd: 'yarn', args: ['install', '--ignore-scripts'], label: 'yarn install --ignore-scripts' };
    case 'bun':
      return { cmd: 'bun', args: ['install', '--ignore-scripts'], label: 'bun install --ignore-scripts' };
    case 'npm':
    default:
      return { cmd: 'npm', args: ['install', '--ignore-scripts', '--no-audit', '--no-fund'], label: 'npm install --ignore-scripts --no-audit --no-fund' };
  }
}

async function bootstrapDependenciesIfNeeded(
  workspaceDir: string
): Promise<NonNullable<WorkspaceImportMeta['dependencyInstall']>> {
  let hasPackageJson = false;
  try {
    await fs.access(path.join(workspaceDir, 'package.json'));
    hasPackageJson = true;
  } catch {
    hasPackageJson = false;
  }
  if (!hasPackageJson) {
    return { attempted: false, output: 'No package.json; dependency install skipped.' };
  }
  try {
    await fs.access(path.join(workspaceDir, 'node_modules'));
    return { attempted: false, output: 'node_modules already present; dependency install skipped.' };
  } catch {
    // proceed
  }

  const pm = await detectPackageManager(workspaceDir);
  if (!pm) {
    return { attempted: false, output: 'Could not detect package manager; dependency install skipped.' };
  }
  const spec = installCommandForPackageManager(pm);
  try {
    const { stdout, stderr } = await execFileAsync(spec.cmd, spec.args, {
      cwd: workspaceDir,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, CI: '1', npm_config_ignore_scripts: 'true' },
    });
    const output = [stdout, stderr].filter(Boolean).join('\n').trim().slice(0, 4000) || '(no output)';
    return {
      attempted: true,
      packageManager: pm,
      command: spec.label,
      success: true,
      exitCode: 0,
      output,
    };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
    const output = [e.stdout, e.stderr, e.message].filter(Boolean).join('\n').trim().slice(0, 4000) || 'Install failed.';
    return {
      attempted: true,
      packageManager: pm,
      command: spec.label,
      success: false,
      exitCode: typeof e.code === 'number' ? e.code : 1,
      output,
    };
  }
}

async function fetchViaGitHubRestFallback(
  owner: string,
  repo: string,
  targetDir: string,
  preferredBranch?: string
): Promise<{ branch: string; importMeta: WorkspaceImportMeta }> {
  const ghHeaders = { 'User-Agent': 'swarm-ide-debugger', Accept: 'application/vnd.github+json' };
  const repoResp = await fetchWithTimeout(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: ghHeaders,
  });
  if (!repoResp.ok) {
    throw new Error(describeGitHubHttpError(repoResp.status, `Failed to read repository metadata for ${owner}/${repo}`));
  }
  const repoJson = (await repoResp.json()) as { default_branch?: string };
  const branch = preferredBranch || repoJson.default_branch || 'main';

  const treeResp = await fetchWithTimeout(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    { headers: ghHeaders }
  );
  if (!treeResp.ok) {
    throw new Error(describeGitHubHttpError(treeResp.status, `Unable to read GitHub file tree for ${owner}/${repo}@${branch}`));
  }
  const treeJson = (await treeResp.json()) as {
    tree?: Array<{ path: string; type: string; size?: number }>;
  };

  const filtered = (treeJson.tree ?? []).filter(
    (item) =>
      item.type === 'blob' &&
      (item.size ?? 0) < 260_000 &&
      TEXT_EXTENSIONS.has(path.extname(item.path).toLowerCase()) &&
      !/\.min\.(js|css)$/i.test(item.path) &&
      !item.path.split('/').some((seg) => IGNORED_DIRS.has(seg))
  );
  const candidates = filtered
    .sort((a, b) => {
      const aSrc = /^(src|lib|server|app|packages|package\.json|tsconfig\.json)/i.test(a.path) ? 0 : 1;
      const bSrc = /^(src|lib|server|app|packages|package\.json|tsconfig\.json)/i.test(b.path) ? 0 : 1;
      return aSrc - bSrc || a.path.localeCompare(b.path);
    })
    .slice(0, 240);

  let filesFetched = 0;
  let rateLimited = false;
  let forbidden = false;
  for (let i = 0; i < candidates.length; i += 20) {
    const batch = candidates.slice(i, i + 20);
    const results = await Promise.all(
      batch.map(async (item) => {
        const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${item.path}`;
        try {
          const res = await fetchWithTimeout(rawUrl, {}, GITHUB_FETCH_TIMEOUT_MS);
          if (res.status === 429) { rateLimited = true; return false; }
          if (res.status === 403) { forbidden = true; return false; }
          if (!res.ok) return false;
          const text = await res.text();
          const dest = resolveSafeFilePath(targetDir, item.path);
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.writeFile(dest, text, 'utf-8');
          return true;
        } catch {
          return false;
        }
      })
    );
    filesFetched += results.filter(Boolean).length;
  }

  const baselineBranch = await ensureGitBaseline(targetDir);
  const warnings = [
    rateLimited ? 'rate limited (HTTP 429) while fetching some files' : null,
    forbidden ? 'access forbidden (HTTP 403) while fetching some files' : null,
  ].filter(Boolean);
  return {
    branch: baselineBranch,
    importMeta: {
      method: 'github-rest',
      partial: true,
      filesFetched,
      filesCapped: filtered.length > candidates.length,
      note: `REST fallback import (no git history); fetched ${filesFetched}/${candidates.length} selected text files${filtered.length > candidates.length ? `, capped from ${filtered.length}` : ''}${warnings.length ? `. ${warnings.join('; ')}` : ''}.`,
    },
  };
}

export async function importGitHubWorkspace(rawUrl: string): Promise<WorkspaceSnapshot & { importMeta?: WorkspaceImportMeta }> {
  const parsed = parseGitHubInput(rawUrl);
  const workspaceId = `gh-${parsed.repo}-${randomUUID().slice(0, 8)}`;
  const targetDir = path.join(WORKSPACES_ROOT, workspaceId);
  await fs.mkdir(WORKSPACES_ROOT, { recursive: true });

  let branch = parsed.branch || 'main';
  let importMeta: WorkspaceImportMeta = { method: 'git-clone', note: 'Shallow git clone (depth=1).' };
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
    try {
      const fallback = await fetchViaGitHubRestFallback(parsed.owner, parsed.repo, targetDir, parsed.branch);
      branch = fallback.branch;
      importMeta = fallback.importMeta;
    } catch (fallbackErr) {
      await fs.rm(targetDir, { recursive: true, force: true }).catch(() => {});
      throw fallbackErr;
    }
  }

  const dependencyInstall = await bootstrapDependenciesIfNeeded(targetDir);
  importMeta = {
    ...importMeta,
    dependencyInstall,
    note: [importMeta.note, dependencyInstall.attempted ? `Deps: ${dependencyInstall.command} (${dependencyInstall.success ? 'ok' : `failed${dependencyInstall.exitCode != null ? ` ${dependencyInstall.exitCode}` : ''}`})` : dependencyInstall.output]
      .filter(Boolean)
      .join(' '),
  };

  const meta: ActiveWorkspaceMeta = {
    workspaceId,
    dir: targetDir,
    repoName: `${parsed.owner}/${parsed.repo}`,
    repoUrl: parsed.displayUrl,
    sourceType: 'github',
    branch,
    createdAt: Date.now(),
    importMeta,
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
    importMeta,
  };
}

export async function importLocalWorkspace(projectRoot: string): Promise<WorkspaceSnapshot & { importMeta?: WorkspaceImportMeta }> {
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
  const importMeta: WorkspaceImportMeta = { method: 'local-copy', note: 'Copied selected local workspace files into isolated snapshot.' };
  const meta: ActiveWorkspaceMeta = {
    workspaceId,
    dir: targetDir,
    repoName: 'local/workspace-app',
    repoUrl: 'local://app/applet',
    sourceType: 'workspace',
    branch,
    createdAt: Date.now(),
    importMeta,
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
    importMeta,
  };
}

export async function importCustomFilesWorkspace(
  name: string,
  inputFiles: Array<{ path: string; content: string }>
): Promise<WorkspaceSnapshot & { importMeta?: WorkspaceImportMeta }> {
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
  const importMeta: WorkspaceImportMeta = { method: 'custom-write', note: `Wrote ${inputFiles.length} uploaded files.` };
  const meta: ActiveWorkspaceMeta = {
    workspaceId,
    dir: targetDir,
    repoName: name || 'custom/uploaded-files',
    repoUrl: 'local://uploaded',
    sourceType: 'custom',
    branch,
    createdAt: Date.now(),
    importMeta,
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
    importMeta,
  };
}

export async function importBuggyDemoWorkspace(): Promise<WorkspaceSnapshot & { importMeta?: WorkspaceImportMeta }> {
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
  const importMeta: WorkspaceImportMeta = { method: 'demo', note: 'Generated local demo workspace.' };
  const meta: ActiveWorkspaceMeta = {
    workspaceId,
    dir: targetDir,
    repoName: 'demo/billing-ts-service',
    repoUrl: 'local://demo-billing-ts',
    sourceType: 'demo',
    branch,
    createdAt: Date.now(),
    importMeta,
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
    importMeta,
  };
}

export function resolveSafeFilePath(workspaceDir: string, relPath: string): string {
  if (typeof relPath !== 'string') {
    throw new Error('Invalid workspace file path: expected a string.');
  }
  if (relPath.includes('\0')) {
    throw new Error('Invalid workspace file path: null bytes are not allowed.');
  }
  const cleaned = relPath.replace(/^\/+/, '').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    throw new Error('Invalid workspace file path: path must not be empty.');
  }
  const segments = cleaned.split(/[\\/]+/);
  if (segments.some((seg) => seg === '..' || seg === '')) {
    throw new Error(`Blocked unsafe workspace file path (traversal): ${relPath}`);
  }
  const resolved = path.resolve(workspaceDir, cleaned);
  const base = path.resolve(workspaceDir);
  if (resolved === base || !(resolved === base || resolved.startsWith(base + path.sep))) {
    throw new Error(`Blocked unsafe workspace file path: ${relPath}`);
  }
  return resolved;
}

export async function writeWorkspaceFile(
  workspaceDir: string,
  relPath: string,
  content: string
): Promise<void> {
  if (typeof content !== 'string') {
    throw new Error(`Invalid file content for ${relPath}: expected UTF-8 string.`);
  }
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
  try {
    await fs.access(path.join(workspaceDir, '.git'));
  } catch {
    throw new Error('Cannot reset workspace: git repository not found.');
  }
  try {
    await execFileAsync('git', ['reset', '--hard', 'HEAD'], {
      cwd: workspaceDir,
      timeout: 5000,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Unborn HEAD / no commits yet: treat as already-clean baseline when possible.
    if (/unknown revision|ambiguous argument 'HEAD'|needed a single revision|does not have any commits yet/i.test(msg)) {
      // best effort: still clean untracked files below
    } else if (/not found|ENOENT|spawn git/i.test(msg)) {
      throw new Error(`Cannot reset workspace: git is unavailable (${msg}).`);
    } else {
      throw new Error(`Failed to reset workspace to HEAD: ${msg}`);
    }
  }
  try {
    await execFileAsync('git', ['clean', '-fd'], {
      cwd: workspaceDir,
      timeout: 5000,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/not found|ENOENT|spawn git/i.test(msg)) {
      throw new Error(`Cannot clean workspace: git is unavailable (${msg}).`);
    }
    throw new Error(`Failed to clean workspace: ${msg}`);
  }
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
        '  npm install|ci   Install dependencies (safe flags/args only)',
        '  pnpm install     Install dependencies (safe flags/args only)',
        '  yarn install     Install dependencies (safe flags/args only)',
        '  bun install      Install dependencies (safe flags/args only)',
        '  git status       Show modified and newly added files',
        '  git diff         Show unified diff against baseline commit',
        '  ls               List workspace source files',
      ].join('\n'),
    };
  }

  const allowedInstallPatterns: Array<{ re: RegExp; cmd: string }> = [
    { re: /^npm\s+(ci|install)(\s+(--ignore-scripts|--no-audit|--no-fund|--prefer-offline|--legacy-peer-deps))*\s*$/i, cmd: 'npm' },
    { re: /^pnpm\s+install(\s+(--ignore-scripts|--frozen-lockfile|--frozen-lockfile=false|--no-frozen-lockfile|--prefer-offline))*\s*$/i, cmd: 'pnpm' },
    { re: /^yarn(\s+install)?(\s+(--ignore-scripts|--frozen-lockfile|--prefer-offline|--immutable))*\s*$/i, cmd: 'yarn' },
    { re: /^bun\s+install(\s+(--ignore-scripts|--frozen-lockfile|--no-save))*\s*$/i, cmd: 'bun' },
  ];
  for (const p of allowedInstallPatterns) {
    if (p.re.test(trimmed)) {
      const parts = trimmed.split(/\s+/);
      try {
        const { stdout, stderr } = await execFileAsync(parts[0], parts.slice(1), {
          cwd: workspaceDir,
          timeout: 120_000,
          maxBuffer: 2 * 1024 * 1024,
          env: { ...process.env, CI: '1' },
        });
        return {
          exitCode: 0,
          output: [stdout, stderr].filter(Boolean).join('\n').trim() || `${parts.join(' ')} completed.`,
        };
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
        return {
          exitCode: typeof e.code === 'number' ? e.code : 1,
          output: [e.stdout, e.stderr, e.message].filter(Boolean).join('\n').trim() || `${parts.join(' ')} failed.`,
        };
      }
    }
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

