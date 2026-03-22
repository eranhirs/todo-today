# Claude Todos — Architecture

## Overview

Claude Todos is a Claude-integrated todo app that bridges your Claude Code sessions to a persistent task list. It automatically discovers what you're working on and suggests/completes tasks.

## How It Works

1. **Hooks** (recommended) — Claude Code lifecycle hooks trigger analysis instantly when sessions end or need attention. On startup, missed hook events (from server downtime) are caught up automatically via the event log.
2. **Scheduler** — periodic fallback (default 30m) scans recent Claude Code sessions from `~/.claude/projects/`
3. **Claude analyzer** extracts session transcripts and asks Claude (via CLI) to identify completed work and suggest new tasks
4. Results are applied to the todo store — marking todos complete, adding new ones, discovering new projects
5. **Autopilot** — after each analysis, projects with `auto_run_quota > 0` start one "next" todo per project. When a run finishes, the next eligible todo auto-starts and the quota decrements by one. No queueing — each run triggers the next on completion. The cycle repeats: analysis discovers todos → Autopilot runs them → next analysis picks up the results.
5b. **Daily Run Limits** — each project has an optional `todo_quota` (0 = unlimited). When set, no more than N todos can be run (executed by Claude) within a 24-hour sliding window. Todos can always be created freely. Follow-ups on already-run todos don't count against the limit. The quota is enforced at queue-insertion time only — changing the limit does not affect items already in the queue.
6. **Event Bus** — centralized pub/sub system propagates events (hook updates, analysis completions, run lifecycle, queue drains) to all consumers. An SSE endpoint (`/api/events`) streams events to the frontend in real time, supplementing the 3s poll with instant updates.
7. **Frontend** polls every 3 seconds as a baseline, with SSE event stream triggering immediate refreshes when state changes
8. **Run with Claude** — users can click a play button on any todo to spawn a `claude -p` session that works on the task in the project directory. Todos containing `/manual` in their text are flagged as human-only tasks — they cannot be run by Claude, are skipped by autopilot, and the run controls are hidden in the UI. The `/manual` command is stripped from the display text but preserved in the stored text so it can be removed by editing. The background process updates the todo with output on completion. After the run finishes, analysis is triggered directly (bypassing hooks) via `queue_run_session_analysis`, ensuring reliable analysis even if hook delivery fails.
8b. **BTW Messages** — while a run is in progress, users can send `/btw` messages that spawn a concurrent, independent Claude session running in parallel alongside the main run. The btw session operates as an ephemeral side-channel in the same project directory, with its output stored separately (`btw_output`/`btw_status`). The frontend displays a tabbed UI (Run | /btw) so users can view both outputs side by side.

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

## Offline Behavior

When the backend is unreachable (polling fails with a network error), the frontend enters offline mode:

- **Adding todos**: Still allowed — items are created as optimistic placeholders with `temp-` IDs. They appear greyed out with a "not sent" badge so the user can copy the text if needed. These are not persisted and will be lost on page reload.
- **Mutations blocked**: Status changes, deletions, edits, run controls, and follow-ups show a warning toast explaining the action isn't available while offline.
- **Banner**: A red banner at the top indicates the server is unreachable.
- **Recovery**: When polling succeeds again, the offline flag clears and all controls re-enable. Pending items remain visible but won't be synced — the user should re-add them.

## Run Lifecycle

When a todo is executed via the play button or autopilot, `run_manager.py` manages the full subprocess lifecycle.

### Execution Flow

1. Todo status → `in_progress`, `run_status` → `running`
2. A background thread spawns `claude -p --output-format stream-json --dangerously-skip-permissions`
3. Output is tailed from a JSONL file in `data/runs/` and flushed to the todo store every 5 seconds
4. On completion, `_finalize_run` applies the result: sets `run_status`, detects plan files, scans for coping phrases

### Plan Mode Auto-Accept

Claude may enter plan mode during a run. When it calls `ExitPlanMode`, the auto-accept loop detects this and resumes with "Plan accepted. Now implement it fully." This repeats up to 3 times (`_MAX_PLAN_RETRIES`).

**ExitPlanMode and permission denials**: In headless (`-p`) mode, `ExitPlanMode` requires user confirmation that can't be obtained. The CLI returns the tool result with `is_error: true` and records it as a `permission_denial`. This is **expected behavior**, not a real error — it's simply the CLI's way of signaling that plan mode exit needs acknowledgment. The auto-accept loop handles this by resuming the session. `ExitPlanMode` and `EnterPlanMode` denials are filtered out of the error check so they don't incorrectly mark runs as failed.

### Plan File Detection

When Claude writes a file to `.claude/plans/` during a run, `_detect_plan_file` scans the stream objects for `Write` tool calls targeting that path. The detected path is stored in `todo.plan_file`. Stream objects are accumulated across all auto-accept retry iterations so the plan file isn't lost when the second invocation replaces `stream_objects`. Plan files are also preserved on the todo even when the run ends in error — the plan itself may still be valid.

### Error Detection

Runs can fail in several ways, each producing different user-visible output:

| Condition | `run_status` | Output contains |
|-----------|-------------|-----------------|
| Non-zero exit code | `error` | `--- ERROR ---\nExit code N` |
| `final_result.is_error` is true | `error` | `--- RUN ERROR ---\nis_error: <details>` |
| Real `permission_denials` (not ExitPlanMode/EnterPlanMode) | `error` | `--- RUN ERROR ---\npermission_denials: <list>` |
| Quota/rate-limit patterns in output | reset to `next` | `[Quota/rate-limit error — will retry]` |
| Python exception in run thread | `error` | Exception string |

### Plan-Only Runs

When `plan_only: true`, the run restricts tools (disallows `Edit`, `Bash`, `NotebookEdit`) and prefixes the prompt with planning instructions. On success, `run_status` → `done` but `status` stays `next` (not completed). Non-zero exit codes are suppressed if a plan file was successfully written.

## Todo Sorting

Todos are sorted within their section (Up Next, Backlog, Completed) using a two-tier scheme:

1. **Pinned items first** — todos with `user_ordered=true` (set by drag-and-drop) sort by `sort_order` ascending
2. **Unpinned items second** — todos with `user_ordered=false` sort by `created_at` descending (newest first)

This logic is applied consistently in three places: `TodoList.tsx` (UI rendering), `useKeyboardShortcuts.ts` (arrow key navigation), and `scheduler.py` (autopilot candidate selection).

Within each section, todos are further grouped by status priority (e.g., Up Next: waiting → in_progress → next; Backlog: consider → stale → rejected).

When a todo is **unpinned** (via the pin toggle), the backend recalculates `sort_order` for all unpinned siblings by `created_at`, slotting them around pinned items that keep their positions.

## Hooks Integration

Optional real-time session state detection via Claude Code hooks. See [hooks.md](hooks.md) for full details, event payloads, and testing instructions.
