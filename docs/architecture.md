# Claude Todos — Architecture

## Overview

Claude Todos is a Claude-integrated todo app that bridges your Claude Code sessions to a persistent task list. It automatically discovers what you're working on and suggests/completes tasks.

## How It Works

1. **Hooks** (recommended) — Claude Code lifecycle hooks trigger analysis instantly when sessions end or need attention. On startup, missed hook events (from server downtime) are caught up automatically via the event log.
2. **Scheduler** — periodic fallback (default 30m) scans recent Claude Code sessions from `~/.claude/projects/`
3. **Claude analyzer** extracts session transcripts and asks Claude (via CLI) to identify completed work and suggest new tasks
4. Results are applied to the todo store — marking todos complete, adding new ones, discovering new projects
5. **Autopilot** — after each analysis, projects with `auto_run_quota > 0` start one "next" todo per project. When a run finishes, the next eligible todo auto-starts and the quota decrements by one. No queueing — each run triggers the next on completion. The cycle repeats: analysis discovers todos → Autopilot runs them → next analysis picks up the results.
6. **Event Bus** — centralized pub/sub system propagates events (hook updates, analysis completions, run lifecycle, queue drains) to all consumers. An SSE endpoint (`/api/events`) streams events to the frontend in real time, supplementing the 3s poll with instant updates.
7. **Frontend** polls every 3 seconds as a baseline, with SSE event stream triggering immediate refreshes when state changes
8. **Run with Claude** — users can click a play button on any todo to spawn a `claude -p` session that works on the task in the project directory. The background process updates the todo with output on completion. After the run finishes, analysis is triggered directly (bypassing hooks) via `queue_run_session_analysis`, ensuring reliable analysis even if hook delivery fails.

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
│   ├── models.py            # Pydantic models (Project, Todo, AnalysisEntry, Metadata, Settings)
│   ├── storage.py           # Thread-safe JSON file persistence
│   ├── scheduler.py         # APScheduler (periodic + hook-triggered analysis)
│   ├── claude_analyzer.py   # Main analysis orchestrator (coordinates the modules below)
│   ├── session_discovery.py # Discover sessions from ~/.claude/projects/
│   ├── session_state.py     # Detect session state (hook-based + JSONL heuristic)
│   ├── run_manager.py       # ProcessManager class — subprocess lifecycle, PID/zombie detection, thread tracking, queue logic
│   ├── prompt_builder.py    # Build per-project analysis prompts, invoke Claude CLI
│   ├── result_applier.py    # Apply Claude analysis results to the todo store
│   ├── hook_state.py        # Reader for hook-based session state
│   ├── event_bus.py         # Centralized event/message bus with SSE fan-out
│   └── routers/
│       ├── projects.py      # CRUD /api/projects
│       ├── todos.py         # CRUD /api/todos + /run endpoint
│       └── claude.py        # /api/claude/wake, /settings, /status, /history, /insights, /hooks
├── frontend/
│   └── src/
│       ├── App.tsx           # Root component, composes custom hooks
│       ├── api.ts            # Fetch-based API client
│       ├── types.ts          # TypeScript interfaces
│       ├── hooks/
│       │   ├── useAppState.ts        # State polling, project/view selection, refresh
│       │   ├── useNotifications.ts   # Toasts, browser notifications, event tracking
│       │   ├── useEventBus.ts       # SSE client for real-time event stream
│       │   └── useKeyboardShortcuts.ts # Global keyboard shortcut handler
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

## Event Bus

The event bus (`backend/event_bus.py`) is an in-process pub/sub system that decouples event producers from consumers.

### Event Types

| Category | Events | Emitted From |
|----------|--------|-------------|
| Hook | `hook.session_update` | `routers/claude.py` (when hook fires) |
| Analysis | `analysis.queued`, `analysis.started`, `analysis.completed`, `analysis.skipped` | `scheduler.py` |
| Run | `run.started`, `run.progress`, `run.completed`, `run.failed`, `run.stopped`, `run.queued` | `run_manager.py`, `routers/todos.py` |
| Queue | `queue.drain_started`, `queue.drain_completed` | `scheduler.py`, `run_manager.py` |
| Autopilot | `autopilot.started`, `autopilot.completed` | `scheduler.py` |
| Data | `todo.created`, `todo.updated`, `todo.deleted`, `project.created`, `project.updated`, `project.deleted` | `routers/todos.py`, `routers/projects.py` |

### SSE Endpoint

`GET /api/events` opens a Server-Sent Events stream. Each event is formatted as:

```
event: <event_type>
data: {"type": "<event_type>", "data": {...}, "ts": <unix_timestamp>}
```

A keepalive comment (`: keepalive`) is sent every 15 seconds to prevent connection timeout. The frontend `useEventBus` hook auto-reconnects on disconnect with a 3-second backoff.

### Thread Safety

Background threads (run workers) emit events via `bus.emit_sync()` / `bus.emit_event_sync()`, which schedules the emission on the main asyncio event loop using `call_soon_threadsafe`. Async code uses `await bus.emit()` / `await bus.emit_event()` directly.

### Debug Endpoints

- `GET /api/events/recent?limit=50` — ring buffer of recent events
- `GET /api/events/status` — subscriber count and event buffer size

## Hooks Integration

Optional real-time session state detection via Claude Code hooks. See [hooks.md](hooks.md) for full details, event payloads, and testing instructions.
