# Claude Todos — Architecture

## Overview

Claude Todos is a Claude-integrated todo app that bridges your Claude Code sessions to a persistent task list. It automatically discovers what you're working on and suggests/completes tasks.

## How It Works

1. **Hooks** (recommended) — Claude Code lifecycle hooks trigger analysis instantly when sessions end or need attention
2. **Scheduler** — periodic fallback (default 30m) scans recent Claude Code sessions from `~/.claude/projects/`
3. **Claude analyzer** extracts session transcripts and asks Claude (via CLI) to identify completed work and suggest new tasks
4. Results are applied to the todo store — marking todos complete, adding new ones, discovering new projects
5. **Frontend** polls every 3 seconds, reflecting changes in real time
6. **Run with Claude** — users can click a play button on any todo to spawn a `claude -p` session that works on the task in the project directory. The background process updates the todo with output on completion.

## Tech Stack

| Layer    | Tech                        |
|----------|-----------------------------|
| Backend  | FastAPI + APScheduler       |
| Frontend | React 19 + TypeScript + Vite |
| Storage  | JSON files (`data/`) with atomic writes |
| AI       | Claude CLI (`claude -p`)    |

## Directory Structure

```
claude_todos/
├── backend/
│   ├── main.py              # FastAPI app, lifespan, /api/state endpoint
│   ├── models.py            # Pydantic models (Project, Todo, AnalysisEntry, Metadata)
│   ├── storage.py           # Thread-safe JSON file persistence
│   ├── scheduler.py         # APScheduler (periodic + hook-triggered analysis)
│   ├── claude_analyzer.py   # Session discovery, prompt building, Claude CLI invocation
│   ├── hook_state.py        # Reader for hook-based session state
│   └── routers/
│       ├── projects.py      # CRUD /api/projects
│       ├── todos.py         # CRUD /api/todos + /run endpoint
│       └── claude.py        # /api/claude/wake, /status, /history, /insights, /hooks
├── frontend/
│   └── src/
│       ├── App.tsx           # Root component, state polling
│       ├── api.ts            # Fetch-based API client
│       ├── types.ts          # TypeScript interfaces
│       └── components/
│           ├── ClaudeStatus.tsx    # Status indicator + Wake button + usage totals
│           ├── ProjectList.tsx     # Sidebar project selector
│           ├── TodoList.tsx        # Main todo view (active + completed)
│           ├── TodoItem.tsx        # Single todo with checkbox/delete
│           ├── AddTodo.tsx         # New todo input form
│           ├── Insights.tsx        # Dismissible insights banner above todos
│           └── UpdateHistory.tsx   # Expandable analysis history with detail view
├── hooks/
│   └── claude-todos-hook.py    # Claude Code hook script for real-time session state
├── data/
│   ├── todos.json            # Projects + todos
│   ├── metadata.json         # Analysis history, scheduler state, usage totals
│   └── hook_states.json      # Real-time session states from hooks (auto-generated)
├── logs/                     # Runtime logs (backend.log, frontend.log)
└── docs/                     # Documentation
```

## Hooks Integration

Optional real-time session state detection via Claude Code hooks. See [hooks.md](hooks.md) for full details, event payloads, and testing instructions.
