import path from 'node:path';

export interface RepoConventions {
  sourceRoot: string;
  usesNodeTest: boolean;
  usesVitest: boolean;
  usesJest: boolean;
  allowImportingTsExtensions: boolean;
  isTypeScript: boolean;
  hasTsConfig: boolean;
  packageName: string;
}

export interface ScoredRepoFile {
  filePath: string;
  score: number;
  exports: string[];
}

export function extractExportedSymbols(content: string): string[] {
  const symbols: string[] = [];
  const re =
    /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (!symbols.includes(m[1])) symbols.push(m[1]);
    if (symbols.length >= 12) break;
  }
  return symbols;
}

export function detectRepoConventions(fileContents: Record<string, string>): RepoConventions {
  const paths = Object.keys(fileContents);
  const pkgRaw = fileContents['package.json'] ?? '{}';
  let pkg: {
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  } = {};
  try {
    pkg = JSON.parse(pkgRaw) as typeof pkg;
  } catch {
    pkg = {};
  }

  const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const testScript = pkg.scripts?.test ?? '';
  const usesVitest = Boolean(allDeps.vitest) || /\bvitest\b/.test(testScript);
  const usesJest = Boolean(allDeps.jest) || /\bjest\b/.test(testScript);
  const usesNodeTest =
    !usesVitest &&
    !usesJest &&
    (/\bnode\s+--test\b|\btsx\s+--test\b/.test(testScript) ||
      paths.some((p) => (fileContents[p] ?? '').includes("'node:test'") || (fileContents[p] ?? '').includes('"node:test"')));

  const tsConfigRaw = fileContents['tsconfig.json'] ?? '';
  const hasTsConfig = Boolean(fileContents['tsconfig.json']);
  const allowImportingTsExtensions =
    /allowImportingTsExtensions["']?\s*:\s*true/.test(tsConfigRaw) ||
    paths.some((p) => /from\s+['"]\.[^'"]+\.ts['"]/.test(fileContents[p] ?? ''));

  const isTypeScript = hasTsConfig || paths.some((p) => /\.(ts|tsx)$/i.test(p));

  // Infer main source directory from frequency
  const dirCounts = new Map<string, number>();
  for (const p of paths) {
    if (!/\.(ts|tsx|js|jsx|mjs)$/i.test(p)) continue;
    const top = p.includes('/') ? `${p.split('/')[0]}/` : '';
    dirCounts.set(top, (dirCounts.get(top) ?? 0) + 1);
  }
  let sourceRoot = '';
  if (dirCounts.has('src/')) sourceRoot = 'src/';
  else if (dirCounts.has('lib/')) sourceRoot = 'lib/';
  else if (dirCounts.has('app/')) sourceRoot = 'app/';
  else if (dirCounts.has('packages/')) sourceRoot = 'packages/';

  return {
    sourceRoot,
    usesNodeTest,
    usesVitest,
    usesJest,
    allowImportingTsExtensions,
    isTypeScript,
    hasTsConfig,
    packageName: pkg.name || 'workspace',
  };
}

export function selectRelevantRepoContext(
  prompt: string,
  fileContents: Record<string, string>,
  maxFiles = 18,
  maxTotalChars = 24_000
): {
  treeOverview: string;
  selectedFiles: Array<{ filePath: string; content: string; exports: string[] }>;
  conventions: RepoConventions;
} {
  const conventions = detectRepoConventions(fileContents);
  const tokens = prompt
    .toLowerCase()
    .replace(/[^a-z0-9_./-]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3);

  const allPaths = Object.keys(fileContents).sort();
  const scored: ScoredRepoFile[] = allPaths.map((filePath) => {
    const content = fileContents[filePath] ?? '';
    const lowerPath = filePath.toLowerCase();
    const exports = extractExportedSymbols(content);
    let score = 0;

    // Prioritize key manifests & entrypoints
    if (filePath === 'package.json' || filePath === 'tsconfig.json') score += 45;
    if (/^(src|lib|app|server)\/(index|main|app|server|router)\.(ts|tsx|js|jsx)$/i.test(filePath)) {
      score += 35;
    }
    if (/\.(ts|tsx|js|jsx)$/i.test(filePath)) score += 10;
    if (/\.min\.(js|css)$/.test(lowerPath) || /lock/.test(lowerPath)) score -= 50;

    // Score prompt keyword overlap against path, exports, and content
    for (const tok of tokens) {
      if (lowerPath.includes(tok)) score += 28;
      if (exports.some((sym) => sym.toLowerCase().includes(tok))) score += 22;
      if (content.slice(0, 3000).toLowerCase().includes(tok)) score += 10;
    }

    // Penalize giant vendor/minified files
    if (content.length > 40_000) score -= 25;

    return { filePath, score, exports };
  });

  scored.sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath));

  // Build compact symbol tree of the entire codebase (up to 250 files)
  const treeOverview = scored
    .slice(0, 250)
    .map((item) => {
      const exp = item.exports.length > 0 ? `  [exports: ${item.exports.join(', ')}]` : '';
      return `${item.filePath}${exp}`;
    })
    .join('\n');

  const selectedFiles: Array<{ filePath: string; content: string; exports: string[] }> = [];
  let charBudget = maxTotalChars;

  for (const item of scored) {
    if (selectedFiles.length >= maxFiles || charBudget <= 300) break;
    const raw = fileContents[item.filePath] ?? '';
    const snippet = raw.slice(0, Math.min(3500, charBudget));
    if (!snippet) continue;
    selectedFiles.push({
      filePath: item.filePath,
      content: snippet,
      exports: item.exports,
    });
    charBudget -= snippet.length;
  }

  return { treeOverview, selectedFiles, conventions };
}

export function resolveImportExtension(conventions: RepoConventions, targetPath: string): string {
  const base = path.basename(targetPath);
  if (conventions.allowImportingTsExtensions) return `./${base}`;
  return `./${base.replace(/\.(ts|tsx|js|jsx)$/i, '')}`;
}
