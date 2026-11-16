import 'dotenv/config';
import express from 'express';
import { createServer as createHttpServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeWorkspaceGitDiff,
  getWorkspaceFileStatuses,
  getWorkspaceMeta,
  importBuggyDemoWorkspace,
  importCustomFilesWorkspace,
  importGitHubWorkspace,
  importLocalWorkspace,
  readAllTextFiles,
  revertWorkspaceChanges,
  runSafeWorkspaceCommand,
  writeWorkspaceFile,
} from './server/repoManager';
import { runParallelDebugSwarm } from './server/subagentRunner';
import { runAutonomousFeatureBuild } from './server/swarmComposer';
import { runAutonomousSwarmFix } from './server/swarmFixer';
import {
  applyAllFixesToFiles,
  applyDiagnosticFixToContent,
} from './src/engine/bugAnalyzer';
import type { CodeDiagnostic, CursorSpeed } from './src/types/ide';

function parseSpeed(val: unknown): CursorSpeed {
  return val === 'normal' || val === 'fast' ? val : 'slow';
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '2mb' }));

app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  const allowed = new Set([
    'https://swarm-ide-demo.vercel.app',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
  ]);
  const envOrigins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const o of envOrigins) allowed.add(o);
  if (origin && (allowed.has(origin) || /\.vercel\.app$/.test(new URL(origin).hostname))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/repo/import', async (req, res) => {
  try {
    const { source, repoUrl, name, files } = req.body as {
      source?: 'github' | 'workspace' | 'custom' | 'demo';
      repoUrl?: string;
      name?: string;
      files?: Array<{ path: string; content: string }>;
    };

    if (source === 'workspace') {
      const snapshot = await importLocalWorkspace(__dirname);
      return res.json(snapshot);
    }

    if (source === 'demo') {
      const snapshot = await importBuggyDemoWorkspace();
      return res.json(snapshot);
    }

    if (source === 'custom' && Array.isArray(files) && files.length > 0) {
      const snapshot = await importCustomFilesWorkspace(name || 'custom/project', files);
      return res.json(snapshot);
    }

    if (!repoUrl || typeof repoUrl !== 'string') {
      return res.status(400).json({ error: 'Provide a GitHub URL or owner/repo slug.' });
    }

    const snapshot = await importGitHubWorkspace(repoUrl);
    return res.json(snapshot);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to import repository.';
    return res.status(400).json({ error: message });
  }
});

app.post('/api/repo/:workspaceId/debug', async (req, res) => {
  try {
    const meta = getWorkspaceMeta(req.params.workspaceId);
    if (!meta) {
      return res.status(404).json({ error: 'Workspace session expired or not found. Re-import the repository.' });
    }
    const { useAi = true } = (req.body || {}) as { useAi?: boolean };
    const { fileContents } = await readAllTextFiles(meta.dir);
    const result = await runParallelDebugSwarm(meta.dir, fileContents, useAi);
    const [gitDiff, fileStatuses] = await Promise.all([
      computeWorkspaceGitDiff(meta.dir),
      getWorkspaceFileStatuses(meta.dir),
    ]);
    return res.json({
      workspaceId: meta.workspaceId,
      ...result,
      gitDiff,
      fileStatuses,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Subagent debug run failed.';
    return res.status(500).json({ error: message });
  }
});

app.post('/api/repo/:workspaceId/swarm-fix', async (req, res) => {
  const meta = getWorkspaceMeta(req.params.workspaceId);
  if (!meta) {
    return res.status(404).json({ error: 'Workspace session expired or not found.' });
  }

  const { useAi = true, speed } = (req.body || {}) as {
    agentCount?: number;
    useAi?: boolean;
    speed?: CursorSpeed;
  };
  const agentCount = 10;

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  let closed = false;
  res.on('close', () => {
    closed = true;
  });

  try {
    await runAutonomousSwarmFix({
      workspaceId: meta.workspaceId,
      workspaceDir: meta.dir,
      agentCount,
      speed: parseSpeed(speed),
      useAi,
      emit: (event) => {
        if (!closed) {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      },
    });
  } catch (err) {
    if (!closed) {
      const message = err instanceof Error ? err.message : 'Autonomous swarm fix failed.';
      res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
    }
  } finally {
    if (!closed) {
      res.end();
    }
  }
});

app.post('/api/repo/:workspaceId/composer', async (req, res) => {
  const meta = getWorkspaceMeta(req.params.workspaceId);
  if (!meta) {
    return res.status(404).json({ error: 'Workspace session expired or not found.' });
  }

  const { prompt, useAi = true, speed } = (req.body || {}) as {
    prompt?: string;
    agentCount?: number;
    useAi?: boolean;
    speed?: CursorSpeed;
  };
  const agentCount = 10;

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 3) {
    return res.status(400).json({ error: 'Enter a feature or code instruction for the Cursor swarm.' });
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  let closed = false;
  res.on('close', () => {
    closed = true;
  });

  try {
    await runAutonomousFeatureBuild({
      workspaceId: meta.workspaceId,
      workspaceDir: meta.dir,
      prompt: prompt.trim(),
      agentCount,
      speed: parseSpeed(speed),
      useAi,
      emit: (event) => {
        if (!closed) {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      },
    });
  } catch (err) {
    if (!closed) {
      const message = err instanceof Error ? err.message : 'Swarm feature build failed.';
      res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
    }
  } finally {
    if (!closed) {
      res.end();
    }
  }
});

app.post('/api/repo/:workspaceId/create-file', async (req, res) => {
  try {
    const meta = getWorkspaceMeta(req.params.workspaceId);
    if (!meta) {
      return res.status(404).json({ error: 'Workspace session not found.' });
    }
    const { filePath, content = '' } = req.body as { filePath?: string; content?: string };
    if (!filePath || typeof filePath !== 'string' || !filePath.trim()) {
      return res.status(400).json({ error: 'Provide a valid relative file path.' });
    }
    const cleanPath = filePath.trim().replace(/^\/+/, '');
    await writeWorkspaceFile(meta.dir, cleanPath, content);
    const [{ files, fileContents }, gitDiff, fileStatuses] = await Promise.all([
      readAllTextFiles(meta.dir),
      computeWorkspaceGitDiff(meta.dir),
      getWorkspaceFileStatuses(meta.dir),
    ]);
    return res.json({
      workspaceId: meta.workspaceId,
      filePath: cleanPath,
      files,
      fileContents,
      gitDiff,
      fileStatuses,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to create file.';
    return res.status(400).json({ error: message });
  }
});

app.post('/api/repo/:workspaceId/run-command', async (req, res) => {
  try {
    const meta = getWorkspaceMeta(req.params.workspaceId);
    if (!meta) {
      return res.status(404).json({ error: 'Workspace session not found.' });
    }
    const { command } = req.body as { command?: string };
    if (!command || typeof command !== 'string') {
      return res.status(400).json({ error: 'Provide a terminal command.' });
    }
    const result = await runSafeWorkspaceCommand(meta.dir, command);
    return res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Command execution failed.';
    return res.status(500).json({ error: message });
  }
});

app.post('/api/repo/:workspaceId/apply-fix', async (req, res) => {
  try {
    const meta = getWorkspaceMeta(req.params.workspaceId);
    if (!meta) {
      return res.status(404).json({ error: 'Workspace session not found.' });
    }

    const {
      diagnostics = [],
      diagnosticId,
      applyAll = false,
      manualEdit,
      useAi = false,
    } = req.body as {
      diagnostics?: CodeDiagnostic[];
      diagnosticId?: string;
      applyAll?: boolean;
      manualEdit?: { filePath: string; content: string };
      useAi?: boolean;
    };

    const before = await readAllTextFiles(meta.dir);
    const fileContents = before.fileContents;
    const updatedFiles: Record<string, string> = {};
    let requestedPatchCount = 0;

    if (manualEdit && typeof manualEdit.filePath === 'string') {
      const prev = fileContents[manualEdit.filePath];
      if (prev !== manualEdit.content) {
        await writeWorkspaceFile(meta.dir, manualEdit.filePath, manualEdit.content);
        updatedFiles[manualEdit.filePath] = manualEdit.content;
        requestedPatchCount = 1;
      }
    } else if (applyAll) {
      const resAll = applyAllFixesToFiles(fileContents, diagnostics);
      for (const [fp, nextContent] of Object.entries(resAll.updatedFiles)) {
        if (fileContents[fp] !== undefined && nextContent !== fileContents[fp]) {
          await writeWorkspaceFile(meta.dir, fp, nextContent);
          updatedFiles[fp] = nextContent;
        }
      }
      requestedPatchCount = resAll.appliedIds.size;
    } else if (diagnosticId) {
      const targetDiag = diagnostics.find((d) => d.id === diagnosticId);
      if (targetDiag && fileContents[targetDiag.filePath] !== undefined) {
        const hasPatch = Boolean(targetDiag.suggestedLinePatch || targetDiag.suggestedFilePatch);
        if (hasPatch) {
          const nextContent = applyDiagnosticFixToContent(fileContents[targetDiag.filePath], targetDiag);
          if (nextContent !== fileContents[targetDiag.filePath]) {
            await writeWorkspaceFile(meta.dir, targetDiag.filePath, nextContent);
            updatedFiles[targetDiag.filePath] = nextContent;
            requestedPatchCount = 1;
          }
        }
      }
    }

    // Truthful post-fix state: recompute diff/status and re-scan/verify. Do not mark fixed without evidence.
    const after = await readAllTextFiles(meta.dir);
    const verification = await runParallelDebugSwarm(meta.dir, after.fileContents, Boolean(useAi));
    const [gitDiff, fileStatuses] = await Promise.all([
      computeWorkspaceGitDiff(meta.dir),
      getWorkspaceFileStatuses(meta.dir),
    ]);

    const remainingErrors = verification.diagnostics.filter((d) => d.severity === 'error').length;
    console.log(
      `[apply-fix] workspace=${meta.workspaceId} appliedReal=${Object.keys(updatedFiles).length} requested=${requestedPatchCount} remaining=${verification.diagnostics.length} remainingErrors=${remainingErrors} tscErrors=${verification.tscResult.errorCount} testsFailed=${verification.testResult.failed}`
    );

    return res.json({
      workspaceId: meta.workspaceId,
      appliedCount: Object.keys(updatedFiles).length,
      updatedFiles,
      gitDiff,
      fileStatuses,
      diagnostics: verification.diagnostics,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to apply fix to workspace.';
    return res.status(500).json({ error: message });
  }
});

app.post('/api/repo/:workspaceId/reset', async (req, res) => {
  try {
    const meta = getWorkspaceMeta(req.params.workspaceId);
    if (!meta) {
      return res.status(404).json({ error: 'Workspace session not found.' });
    }
    await revertWorkspaceChanges(meta.dir);
    const { files, fileContents } = await readAllTextFiles(meta.dir);
    return res.json({
      workspaceId: meta.workspaceId,
      files,
      fileContents,
      gitDiff: '',
      fileStatuses: {},
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to reset workspace.';
    return res.status(500).json({ error: message });
  }
});

async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';
  const httpServer = createHttpServer(app);

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const hmrDisabled = process.env.DISABLE_HMR === 'true';
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: hmrDisabled ? false : undefined,
        ws: { server: httpServer },
        allowedHosts: true,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Swarm Code IDE running at http://localhost:${PORT}`);
  });
}

startServer();
