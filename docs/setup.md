# Claude Todos — Setup & Operations

## Prerequisites

- Python 3.9+
- Node.js 20.19+ or 22+
- [Claude CLI](https://docs.anthropic.com/en/docs/claude-code) installed and on your `PATH`

## Quick Start

The easiest way to get running:

```bash
./start.sh
```

This will install dependencies, build the frontend, and start the server on http://localhost:5151.

## Manual Setup

```bash
# Backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# Frontend
cd frontend
npm install
```

### Development Mode (two terminals)

```bash
# Terminal 1: Backend (port 5151)
.venv/bin/python -m uvicorn backend.main:app --port 5151

# Terminal 2: Frontend dev server (port 5173, proxies /api to backend)
cd frontend && npm run dev
```

### Production Mode (single process)

```bash
# Build frontend and serve everything from the backend
cd frontend && npm run build && cd ..
cp -r frontend/dist backend/static
.venv/bin/python -m uvicorn backend.main:app --host 0.0.0.0 --port 5151
```

## Auto-Start on Login (macOS)

To run Claude Todos automatically on login, create two launchd plists in `~/Library/LaunchAgents/`. Example templates are in [`docs/launchd/`](launchd/).

```bash
# Load them
launchctl load ~/Library/LaunchAgents/com.claudetodos.backend.plist
launchctl load ~/Library/LaunchAgents/com.claudetodos.frontend.plist

# Unload to stop
launchctl unload ~/Library/LaunchAgents/com.claudetodos.backend.plist
launchctl unload ~/Library/LaunchAgents/com.claudetodos.frontend.plist
```

Key things to configure in the plists:
- `ProgramArguments` — absolute paths to your Python/Node executables
- `WorkingDirectory` — absolute path to the project root
- `EnvironmentVariables.PATH` — must include the directory containing the `claude` CLI

## Data Storage

All runtime data is stored in `data/` (gitignored):
- `todos.json` — projects and todos
- `metadata.json` — analysis history, scheduler state, cumulative usage
- `hook_states.json` — real-time session states from Claude Code hooks (auto-generated when hooks are installed)

The `data/` directory is created automatically on first run.

## Hooks (Optional)

Claude Todos can install Claude Code hooks for real-time session state detection and instant notifications. See [hooks.md](hooks.md) for full details, example payloads, and testing instructions.

To install, click **Install** in the Hooks section of the Claude Status panel, or call `POST /api/claude/hooks/install`.

## Public Demo Deployment

Deploy the static demo to GitHub Pages at `https://eranhirs.github.io/claude-todos/`:

```bash
bash demo/deploy-gh-pages.sh
```

This builds a **fully static demo** — no backend required. The script:
1. Seeds demo data and starts a temporary local backend to capture state
2. Builds the frontend in `gh-pages` mode (base path `/claude-todos/`)
3. Injects the captured state into `index.html` as `window.__DEMO_STATE__`
4. Force-pushes the result to the `gh-pages` branch

The frontend detects `window.__DEMO_STATE__` and renders directly from the embedded data, with polling and SSE disabled.

After the first deploy, enable GitHub Pages in the repo settings: **Settings → Pages → Source → Deploy from branch → `gh-pages` / `/ (root)`**.

## Ports

| Service  | Port  | Notes |
|----------|-------|-------|
| Backend  | 5151  | FastAPI + scheduler |
| Frontend | 5173  | Vite dev server (development only) |

In production mode, only port 5151 is used (frontend is served as static files).
