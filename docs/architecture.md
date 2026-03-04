# Todo Today — Architecture

## Overview

Todo Today is a Claude-integrated todo app that bridges your Claude Code sessions to a persistent task list. It automatically discovers what you're working on and suggests/completes tasks.

## How It Works

1. **Scheduler** runs every 5 minutes, scanning recent Claude Code sessions from `~/.claude/projects/`
2. **Claude analyzer** extracts session transcripts and asks Claude (via CLI) to identify completed work and suggest new tasks
3. Results are applied to the todo store — marking todos complete, adding new ones, discovering new projects
4. **Frontend** polls every 10 seconds, reflecting changes in real time

## Tech Stack

| Layer    | Tech                        |
|----------|-----------------------------|
| Backend  | FastAPI + APScheduler       |
| Frontend | React 19 + TypeScript + Vite |
| Storage  | JSON files (`data/`)        |
| AI       | Claude CLI (`claude -p`)    |

## Directory Structure

```
todo_today/
├── backend/
│   ├── main.py              # FastAPI app, lifespan, /api/state endpoint
│   ├── models.py            # Pydantic models (Project, Todo, AnalysisEntry, Metadata)
│   ├── storage.py           # Thread-safe JSON file persistence
│   ├── scheduler.py         # APScheduler (5-min interval analysis)
│   ├── claude_analyzer.py   # Session discovery, prompt building, Claude CLI invocation
│   └── routers/
│       ├── projects.py      # CRUD /api/projects
│       ├── todos.py         # CRUD /api/todos
│       └── claude.py        # /api/claude/wake, /status, /history, /insights
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
├── data/
│   ├── todos.json            # Projects + todos
│   └── metadata.json         # Analysis history, scheduler state, usage totals
├── logs/                     # Runtime logs (backend.log, frontend.log)
└── docs/                     # Documentation
```
