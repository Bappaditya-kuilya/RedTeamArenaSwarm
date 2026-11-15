# Swarm IDE (RedTeamArenaSwarm)

A VS Code–style, web-based multi-agent coding/debugging workbench. It imports real GitHub repositories (or local/custom files), scans for issues with real tools, and runs a 10-cursor swarm to help analyze and apply fixes in a single active file at a time.

> **Showcase/hackathon project:** best run as a full Node server (real clone, `tsc`, tests, file edits, git). Static/frontend-only hosting can show the UI but not the full backend workflow.

## Highlights

- **VS Code–inspired UI**: activity bar, explorer, tabs/editor, problems/output/terminal/diff panels, status bar, and dark workbench styling.
- **10-cursor swarm (no name labels):** cursors follow swarm-style motion and, during scan/fix, work in the **active file one file at a time** with purposeful navigation/typing/verification progress (streamed via SSE).
- **Real repository import:** clone/import GitHub repos (`URL` or `owner/repo`, optional branch path) into isolated workspaces under `/tmp/swarm-workspaces`.
- **Real diagnostics (where possible):**
  - TypeScript checks via `tsc` (`tsconfig`-aware when present; in-workspace diagnostics reported, including files outside the in-memory snapshot when inside workspace)
  - JS checks via `node --check`
  - Tests via project `package.json` test scripts (when deps available) and/or `node --test` / `tsx --test` discovery
  - Heuristic security/bug analyzers with evidence (reported separately from verified tool failures)
  - Optional AI-assisted patch suggestions/synthesis when `GEMINI_API_KEY` is configured
- **Fix flows:** swarm auto-fix and apply-fix write real file changes, recompute git diff/status, and verify with re-scan/checks (with rollback on regression where applicable). Results are reported from post-fix verification (not optimistic “fixed”).
- **Workspace tooling:** file editing, sandboxed terminal commands, git diff/status/reset for imported workspaces.
- **Deploy-ready configs:** `render.yaml` for Render Blueprint and `vercel.json` for frontend/showcase deploy.

## Tech Stack

- **Frontend:** React 19, TypeScript, Vite, Tailwind CSS v4, Lucide icons, Motion
- **Backend:** Node.js, Express, Server-Sent Events (SSE)
- **Analysis/Fix:** `tsc`, `node --check`, `node/tsx --test`, project test scripts, git, heuristic analyzers, optional Gemini (`@google/genai`)
- **Runtime:** ESM (`"type": "module"`), `tsx` for running `server.ts`

## Project Structure

```text
.
├─ server.ts                  # Express + Vite middleware (dev) / static dist (prod) + API routes
├─ server/
│  ├─ repoManager.ts          # Import/clone, workspace files, git, safe commands, bootstrap
│  ├─ subagentRunner.ts       # Parallel debug/scan (tsc, tests, heuristics, optional AI)
│  ├─ swarmFixer.ts           # Autonomous swarm fix stream + verification/rollback
│  ├─ swarmComposer.ts        # Feature/composer swarm stream
│  └─ codebaseContext.ts      # Repo conventions/context helpers
├─ src/
│  ├─ App.tsx                 # Client orchestration, API/SSE handling, state
│  ├─ components/             # IDE UI, editor, overlay, explorer, panels
│  ├─ engine/                 # Analyzers, swarm profiles, utilities
│  ├─ types/ide.ts            # Shared frontend types/contracts
│  └─ utils/                  # Highlighting/helpers
├─ render.yaml                # Render Blueprint
├─ vercel.json                # Vercel SPA/showcase config
└─ .env.example               # Environment variable template
```

## Prerequisites

- **Node.js** (22+ recommended)
- **npm** or **Bun** (repo includes `bun.lock`; Bun works well locally)
- **git** (required for GitHub clone/import, diff/reset/status, baselines)
- For best real-world scans/fixes on imported repos: network access, project dependencies/toolchains as needed, and sufficient CPU/RAM/time for installs/tests.

## Local Development

```bash
# install
bun install
# or
npm ci

# configure env
cp .env.example .env
# edit .env and set GEMINI_API_KEY (optional but recommended for AI-assisted fixes)

# run dev server (Express + Vite middleware)
bun run dev
# or
npm run dev
```

Open: **http://localhost:3000**

## Environment Variables

Create `.env` from `.env.example`:

| Variable | Required | Description |
|---|---|---|
| `GEMINI_API_KEY` | Optional | Enables Gemini-powered AI patch suggestions/synthesis/repair. If missing/placeholder, the app falls back to deterministic/heuristic behavior. **Keep secret; do not commit.** |
| `APP_URL` | Optional | Public/app URL for callbacks/links when needed. |
| `PORT` | Optional | Server port (defaults to `3000`; Render/hosts may provide this). |
| `NODE_ENV` | Optional | `production` serves built frontend from `dist/` and SPA fallback. |
| `DISABLE_HMR` | Optional | Set `true` to disable Vite HMR/file watching in dev. |

## Build & Production

```bash
# typecheck
bun run lint
# or: npm run lint

# build frontend
bun run build
# or: npm run build

# start production server
npm start
# (NODE_ENV=production tsx server.ts; serves dist/ + API)
```

> `server.ts` is TypeScript and started via `tsx` (included in dependencies for deploy/runtime).

## How to Use

1. **Start the app** and open the UI.
2. **Import a repository/workspace:**
   - **Clone Repo:** GitHub URL or `owner/repo` (optionally branch/path form supported by parser)
   - **This Workspace / Demo / Upload:** depending on UI options (demo is useful for showcase, not proof of real-repo bugs)
3. **Scan / Find bugs:** runs real checks (tsc/tests/node checks) plus heuristic analyzers and optional AI suggestions; results shown in Problems/Output/Terminal with evidence/provenance.
4. **Repair / Fix:** swarm-fix streams progress (10 cursors, one active file at a time), applies real patches, verifies/re-scans, and reports truthful outcomes (verified/reverted/open). Apply-fix/manual edits also persist to the workspace.
5. **Inspect changes:** use Diff/SCM, file editor, and sandboxed terminal.

### Sandboxed terminal (allowlisted)
Supports a limited set of commands inside the imported workspace, including (environment-dependent): `help`, `ls/dir`, `git status`, `git diff`, `tsc`, `tsx --test` / `node --test`, and safe package-manager install commands (e.g. `npm ci/install`, `pnpm/yarn/bun install` with approved flags) for bootstrapping.

## API Overview (main routes)

- `GET /api/health`
- `POST /api/repo/import`
- `POST /api/repo/:workspaceId/debug`
- `POST /api/repo/:workspaceId/swarm-fix` (SSE)
- `POST /api/repo/:workspaceId/composer` (SSE)
- `POST /api/repo/:workspaceId/create-file`
- `POST /api/repo/:workspaceId/run-command`
- `POST /api/repo/:workspaceId/apply-fix`
- `POST /api/repo/:workspaceId/reset`

## Deployment

### Render (recommended for full functionality)
This repo includes `render.yaml` (Blueprint).

- **Build:** `npm ci && npm run build`
- **Start:** `npm start`
- **Health check:** `/api/health`
- **Env vars:** `NODE_ENV=production`, `GEMINI_API_KEY` (secret), `APP_URL` (optional)
- **Auto-deploy from GitHub:** connect repo/branch in Render and enable Auto-Deploy (Blueprint sets `autoDeploy: true`).

### Vercel (UI/showcase only)
`vercel.json` is included for a static SPA frontend deploy.

- Vercel can serve the **UI/build output**, but **real backend actions** (clone, git, `tsc`/tests, installs, swarm fix, SSE workspace operations) require the Node server and **won’t work** on Vercel serverless.
- For hackathon/demo: use Vercel for visual showcase, and a Node host (Render/Koyeb/VM) for full functionality.

### Other options
- **Koyeb / Railway / Fly.io / VPS (Docker or Node):** good fits for a persistent server.
- **Oracle Always Free VM:** reliable truly-free option with more manual setup.
- Requires `git`, Node, network access, and sufficient resources/time for installs and checks.

## Limitations & Notes

- **Not a magic fixer:** real bug detection/fixing depends on the target repo’s toolchain, dependencies, configs, and test environment. Some issues may be unfixable automatically or require manual setup.
- **Verification-first behavior:** fixes are applied to workspace files and checked/re-scanned; regressions may be reverted. Results should be read from reported diagnostics/check outputs.
- **AI optional:** without a valid `GEMINI_API_KEY`, AI patch synthesis/repair is unavailable (deterministic/heuristic fallback only).
- **Ephemeral workspaces:** imported workspaces are stored under `/tmp/swarm-workspaces` (cleared on restart/host cleanup).
- **Security:** if exposed publicly, add authentication/access controls. The app can clone repos and execute allowlisted commands/installs inside workspaces.
- **Large/partial imports:** snapshot/scan coverage may be limited by file/type/size/count filters and environment constraints; see scan output for coverage notes.

## Scripts

- `npm run dev` — start dev server (`tsx server.ts`)
- `npm run build` — build frontend (`vite build`)
- `npm start` — production start (`NODE_ENV=production tsx server.ts`)
- `npm run lint` — typecheck (`tsc --noEmit`)
- `npm run preview` — preview Vite build
- `npm run clean` — remove `dist`/`server.js`

## License

No license file is included in this repository. Add one if you plan to distribute or accept contributions.
