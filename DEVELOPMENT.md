# Development

This guide covers setting up a development environment with hot reload for working on Claude Todos.

## Development Mode (with hot reload)

Run the backend and frontend separately for live reloading during development:

```bash
# Terminal 1 — Backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m uvicorn backend.main:app --port 5151

# Terminal 2 — Frontend
cd frontend && npm install && npm run dev
```

Open http://localhost:5173.

The frontend dev server proxies API requests to the backend on port 5151, so both must be running.

## Local Build (no hot reload)

To build the frontend and run everything as a single server (closer to production), use:

```bash
bash start-local.sh
```

This builds the frontend, copies it to `backend/static`, installs Python dependencies, and restarts the uvicorn server in a tmux session (`claude-todos`) on port 5152. See the [project instructions](.claude/CLAUDE.md) for details.

## Tech Stack

| Layer    | Tech                         |
|----------|------------------------------|
| Backend  | FastAPI + APScheduler        |
| Frontend | React 19 + TypeScript + Vite |
| Storage  | JSON files (atomic writes)   |
| AI       | Claude CLI (`claude -p`)     |

## Documentation

- [Architecture](docs/architecture.md) — system overview and directory structure
- [Setup & Operations](docs/setup.md) — installation, running, auto-start on login
- [Analysis Pipeline](docs/analysis.md) — how Claude analyzes sessions
- [Hooks](docs/hooks.md) — real-time session monitoring via Claude Code hooks
- [API Reference](docs/api.md) — all REST endpoints
