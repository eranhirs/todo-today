# Claude Todos

A self-managing todo app powered by Claude. It watches your [Claude Code](https://docs.anthropic.com/en/docs/claude-code) sessions and automatically discovers what you're working on — marking tasks complete, suggesting next steps, and tracking new projects.

![Claude Todos screenshot](docs/images/screenshot.jpeg)

## How It Works

1. A background scheduler scans your Claude Code sessions every 5 minutes (`~/.claude/projects/`)
2. It sends recent session transcripts to Claude, asking it to identify completed work and suggest new tasks
3. Results are applied to your todo list — completing tasks, adding new ones, discovering new projects
4. A web UI shows everything in real time, with full analysis history and usage tracking

## Quick Start

**Prerequisites:** Python 3.9+, Node.js 20.19+, [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed

### Option 1: Let Claude do it

Clone the repo and open Claude Code inside it:

```bash
git clone https://github.com/eranhirs/claude-todos.git
cd claude-todos
claude
```

Then just ask Claude to install and run the project. It has all the context it needs.

### Option 2: Run it yourself

```bash
git clone https://github.com/eranhirs/claude-todos.git
cd claude-todos
./start.sh
```

Open http://localhost:5151.

### Option 3: Development mode (with hot reload)

```bash
# Terminal 1
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m uvicorn backend.main:app --port 5151

# Terminal 2
cd frontend && npm install && npm run dev
```

Open http://localhost:5173.

## Features

- **Auto-discovery** — finds your Claude Code projects and sessions automatically
- **Smart analysis** — Claude reads session transcripts to understand what was done and what's next
- **Manual trigger** — "Wake Up Claude" button for on-demand analysis
- **Usage tracking** — cost, tokens, and analysis history with expandable detail per entry
- **Multi-project** — organize todos across all your projects
- **Two sources** — todos from Claude (auto-detected) and from you (manually added)

## Tech Stack

| Layer    | Tech                         |
|----------|------------------------------|
| Backend  | FastAPI + APScheduler        |
| Frontend | React 19 + TypeScript + Vite |
| Storage  | JSON files                   |
| AI       | Claude CLI (`claude -p`)     |

## Documentation

- [Architecture](docs/architecture.md) — system overview and directory structure
- [Setup & Operations](docs/setup.md) — installation, running, auto-start on login
- [Analysis Pipeline](docs/analysis.md) — how Claude analyzes sessions
- [API Reference](docs/api.md) — all REST endpoints

## License

MIT
