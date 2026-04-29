# Claude Todos — Architecture

## Overview

Claude Todos is a Claude-integrated todo app that bridges your Claude Code sessions to a persistent task list. It automatically discovers what you're working on and suggests/completes tasks.

## How It Works

1. **Hooks** (recommended) — Claude Code lifecycle hooks trigger analysis instantly when sessions end or need attention. On startup, missed hook events (from server downtime) are caught up automatically via the event log.
2. **Scheduler** — periodic fallback (default 30m) scans recent Claude Code sessions from `~/.claude/projects/`
3. **Claude analyzer** extracts session transcripts and asks Claude (via CLI) to identify completed work and suggest new tasks
4. Results are applied to the todo store — marking todos complete, adding new ones, discovering new projects
5. **Autopilot** — after each analysis, projects with `auto_run_quota > 0` start one "next" todo per project. When a run finishes, the next eligible todo auto-starts and the quota decrements by one. No queueing — each run triggers the next on completion. The cycle repeats: analysis discovers todos → Autopilot runs them → next analysis picks up the results. Users can also schedule autopilot for a specific time (e.g., quota reset at 2AM) by setting `scheduled_auto_run_quota` + `autopilot_starts_at` — the quota activates when the timestamp is reached, preventing autopilot from consuming quota during the current billing window. A dedicated 1-minute activation job ensures scheduled autopilot fires even when the analysis heartbeat is disabled.
5a. **Scheduled Todos** — individual todos can have a `run_after` timestamp set via the schedule control. When the time passes, a dedicated pass in the autopilot loop starts them automatically without requiring project-level autopilot quota. The schedule is cleared once the run starts. The 1-minute activation job detects ready scheduled todos and triggers the autopilot loop.
5d. **Session Keep-Alive Autopilot (per-todo)** — individual todos can have an `autopilot` flag (set via the 🚁 badge on a todo or by writing `#autopilot` in the todo text). After each analysis cycle, the analyzer always produces a `followups` field in its JSON response: for each todo whose run has finished but whose work isn't fully done, it suggests a short next message to send (e.g. "Now add tests for the new function"). The suggestion is stored on the todo as `suggested_followup` regardless of the flag — the UI shows it as a banner above the follow-up input with Use/Send/Dismiss actions. When `autopilot=True` on a todo, `_dispatch_autopilot_followups()` in `claude_analyzer.py` auto-sends the suggestion via `run_manager.start_followup()` after the storage lock is released, transitioning the todo back to `in_progress` and running a follow-up in the same session. This creates a "keep session alive" loop: analyzer decides there's more to do → autopilot sends the follow-up → run completes → analyzer reviews again. The user can disable it per-todo, remove `#autopilot` from the text, or flip the badge off to regain control.

5c. **Session-Scoped Autopilot** — enables autopilot on a specific session's descendants rather than the whole project. Each todo stores a permanent `source_session_id` linking it to the session that created it. When session autopilot is enabled (via `POST /api/todos/{id}/session-autopilot`), the system walks up the ancestor chain at runtime to check eligibility. This allows the "ralph loop" pattern: keep running all work spawned by a root task until the chain is exhausted or quota runs out. Session autopilot runs as a second pass after project-level autopilot — independent, no double-counting. The `session_autopilot` dict (session_id → remaining quota) is stored in metadata and exposed in the frontend state.
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
│   ├── output_parser.py     # Stream-JSON parsing: extract text, detect plan mode, parse output files, extract costs
│   ├── btw_manager.py       # BTW (by-the-way) concurrent side-channel session management
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
│           ├── ProjectList.tsx     # Sidebar project selector (pinned section + collapsible All section)
│           ├── TodoList.tsx        # Main todo view (active + completed)
│           ├── TodoItem.tsx        # Single todo with checkbox/delete + inline analysis view
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

### Run Queue

When a manual run is requested while another non-plan-only todo in the same project is running, the new todo is queued (`run_status="queued"`) and auto-started by `_process_queue` once the project becomes free. Queued todos can be removed via the dequeue control (✗) or bumped to run immediately via the run-now control (⚡): `POST /api/todos/{id}/run-now` calls `run_queued_now`, which bypasses the project's single-flight check and starts the queued todo concurrently with whatever is already running. The user explicitly opts into the conflict risk (two Claude sessions editing the same project at once). Plan-only runs are always concurrent-safe and never queue.

### Execution Flow

1. Todo status → `in_progress`, `run_status` → `running`
2. A background thread spawns `claude -p --output-format stream-json --dangerously-skip-permissions`
3. Output is tailed from a JSONL file in `data/runs/` and flushed to the todo store every 5 seconds
4. On completion, `_finalize_run` applies the result: sets `run_status` to `done` and `status` to `waiting` (not immediately completed), detects plan files, scans for coping phrases / surprise (`!`) / strategy pivots (`Wait`), and extracts cost/token usage from stream-json `result` events. Coping/surprise scanning runs over a *prose-only* projection of the output: fenced code blocks, inline code spans, tool-use summary lines (`$ command`, `[Read: ...]`), markdown tables/headers, and short label lines are stripped before pattern matching, so exclamations inside code (`array[i]!`, `console.log("hi!")`) don't trigger the surprise flag. The analyzer then promotes the todo to `completed` only when the session is truly done AND there is no ongoing discussion — if the user's last messages raise questions, express uncertainty, or continue discussing the topic, the todo stays as `waiting` even if the run succeeded. Plan-only runs are an exception: they complete immediately since the deliverable (the plan) is already produced.

### Plan Mode Auto-Accept

Claude may enter plan mode during a run. When it calls `ExitPlanMode`, the auto-accept loop detects this and resumes with "Plan accepted. Now implement it fully." This repeats up to 3 times (`_MAX_PLAN_RETRIES`).

**ExitPlanMode and permission denials**: In headless (`-p`) mode, `ExitPlanMode` requires user confirmation that can't be obtained. The CLI returns the tool result with `is_error: true` and records it as a `permission_denial`. This is **expected behavior**, not a real error — it's simply the CLI's way of signaling that plan mode exit needs acknowledgment. The auto-accept loop handles this by resuming the session. `ExitPlanMode` and `EnterPlanMode` denials are filtered out of the error check so they don't incorrectly mark runs as failed.

### Plan File Detection

In plan-only runs, `Bash` and `NotebookEdit` are blocked via `--disallowedTools`, while `Write` and `Edit` remain conditionally allowed: a `PreToolUse` hook (`hooks/plan-mode-write-filter.py`) is injected via a per-run `--settings` temp file that blocks any Write/Edit whose `file_path` is not under the project's `plans/` directory. Claude can still write and refine its plan file (so `_detect_plan_file` finds it as usual), but cannot use Write/Edit to implement code. The hook is scoped to the single invocation, so it does not affect other Claude Code sessions.

Plans are stored at `{project_root}/plans/` rather than `.claude/plans/` because the Claude CLI has a hardcoded block on writes under `.claude/` that not even a hook's `allow` decision overrides.

When Claude writes a file to the project's `plans/` directory during a run, `_detect_plan_file` scans the stream objects for `Write` tool calls targeting that path (via `_is_plan_path`, which matches absolute paths rooted at `source_path` as well as relative `plans/` paths). The detected path is stored in `todo.plan_file`. Stream objects are accumulated across all auto-accept retry iterations so the plan file isn't lost when the second invocation replaces `stream_objects`. Plan files are also preserved on the todo even when the run ends in error — the plan itself may still be valid.

When stream-object detection returns nothing (e.g. reconnect captured only a tail of output, or the stream objects were lost), `_detect_plan_file` falls back to scanning the filesystem at `{source_path}/plans/` for files modified after the todo's `run_started_at` timestamp, returning the most recently modified match. Both `source_path` and `run_started_at` are threaded through `_finalize_run` and the startup recovery path in `_cleanup_stale_runs`.

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

When `plan_only: true`, the run restricts tools (disallows `Bash`, `NotebookEdit`; gates `Write`/`Edit` to the project's `plans/` directory via a PreToolUse hook) and prefixes the prompt with planning instructions. On success, `run_status` → `done` but `status` stays `next` (not completed). Non-zero exit codes are suppressed if a plan file was successfully written.

## Todo Sorting

Todos are sorted within their section (Active, Up Next, Backlog, Completed) using a four-tier scheme:

1. **Pending ("not sent") items first** — optimistic placeholders with `temp-` IDs (added while the API request is still in flight or while offline) float to the top of their section so the user notices them. Once the server confirms the todo, the temp ID is replaced and normal ordering resumes.
2. **Pinned items** — todos with `user_ordered=true` (set by drag-and-drop) sort by `sort_order` ascending. Pinning overrides priority.
3. **By priority** — unpinned todos with a priority (`priority` field: 1=critical, 2=high, 3=medium, 4=low) sort higher-priority first. Todos without a priority sort after all prioritized items.
4. **By creation date** — within the same priority level, todos sort by `created_at` descending (newest first)

This logic is applied consistently in three places: `TodoList.tsx` (UI rendering), `useKeyboardShortcuts.ts` (arrow key navigation), and `scheduler.py` (autopilot candidate selection).

Within each section, todos are further grouped by status priority (e.g., Active: in_progress → waiting; Backlog: consider → stale → rejected).

When a todo is **unpinned** (via the pin toggle), the backend recalculates `sort_order` for all unpinned siblings by `created_at`, slotting them around pinned items that keep their positions.

### Priority System

Priorities are set via hashtag keywords in todo text:

| Keyword | Level | Label |
|---------|-------|-------|
| `#p1` or `#critical` | 1 | Critical |
| `#p2` or `#high` | 2 | High |
| `#p3` or `#medium` | 3 | Medium |
| `#p4` or `#low` | 4 | Low |

Priority keywords are **not** treated as regular tags — they appear as colored priority badges instead of tag pills. Any other `#word` token remains a regular hashtag/tag. The priority is derived from the text on creation and update, stored in the `priority` field on the Todo model. The filter bar shows priority filter pills when any active todos have priorities set.

### Faceted Filter Bar

The filter bar above the todo list (search input, priority/unread/commands/manual chips, tag pills) behaves as a faceted drill-down. Each chip's count and the set of visible tag pills update with every other active filter and the search query, so the chips answer "if I add this filter, how many would I see, given my current view".

Implementation in `TodoList.tsx`:

- `searchBase` = `projectFiltered` narrowed by the current search query (using backend `searchResults` when available, with a client-side fallback while debouncing).
- `applyFilters(base, skip)` applies every active filter except the one named by `skip`.
- `filteredWithoutTags`, `filteredWithoutUnread`, `filteredWithoutCommands`, `filteredWithoutManual`, `filteredWithoutPriorities` are the per-facet bases used to compute chip counts and the tag pill set.
- `filtered` = `applyFilters(searchBase)` — the fully narrowed list shown in the sections.
- The tag pill set always includes any currently selected/excluded tag, and priority chips are kept visible while a priority filter is active, so the user can always click a filter off even if no result currently matches.
- Unread count keeps using the backend-provided `unreadCounts` when no other filter/search is active (so it covers paginated-away completed todos); once any other filter is applied it switches to a client-side count.

### Parent Todo Visibility

Todos that were spawned from another todo's run are linked via `source_session_id` — the child's `source_session_id` matches the parent's `session_id`. Users can also **manually set a parent** via a dropdown in the expanded metadata, which stores a direct todo-id reference in `parent_todo_id`. When both are set, `parent_todo_id` takes precedence.

The UI surfaces this relationship in two places:

1. **List view** — a small "↑ parent" badge appears on child todos. Clicking it scrolls to and briefly highlights the parent todo.
2. **Expanded metadata** — when a child todo's output is expanded, a "Parent:" row shows the parent's text (truncated) and status, plus a dropdown (scoped to the same project) for manually picking a parent and a clear button to drop the manual link. Clicking the parent text scrolls to the parent.

When the parent isn't visible in the current view — typically because the user has filters active (search/tags/etc.) that hide it, or because it's in a different project where filters still hide it after the project switch — the click surfaces a toast with an "Open in new tab" action button. Clicking the button opens a fresh tab pointed at the parent with cleared filters: the URL includes `project=<parent_project>` and `focus=<parent_id>`. On load, App reads `focus` and scrolls to the todo, then strips the param so a refresh doesn't re-trigger the scroll. Tabs opened this way (`openedFromFocus`) also force every section open on first render so collapsed-section state can't hide the target, and they suppress the action-button fallback so a focus-opened tab can't recursively spawn more tabs.

Parent resolution is computed client-side from the loaded todo list: `parent_todo_id → id-lookup`, then fallback to `source_session_id → session_id-lookup`. If the parent is in a different project or not loaded (e.g., paginated away), the badge won't appear. Child lookup follows the same precedence — a todo with a manual `parent_todo_id` is counted as a child of that specific todo and no longer as a session-based child.

### Referenced-by Backlinks

Todos can reference other todos inline via `@[title](todo_id)` mentions (inserted through the `@` autocomplete in the add and edit inputs). The UI surfaces the inverse relationship on the referenced todo:

1. **List view** — an `↗ ref N` badge appears showing how many other todos link to this one. Clicking the badge expands the metadata.
2. **Expanded metadata** — a "Referenced by (N)" section lists every referencing todo with its status; clicking an entry scrolls to it.

The map is computed client-side in `TodoList.tsx` via `buildReferencedByMap(todos)` (see `utils/todoSearch.ts`), which scans each todo's `text` for `@[...](id)` patterns and indexes them by referenced id. Self-references are ignored. The backlink badge only appears if the referencing todo is in the loaded list (paginated-away completed todos won't contribute).

When the analyzer creates a new todo, only `source_session_id` is pre-populated (pointing to the parent session). `session_id` represents the todo's *own* run session and is left unset until the todo actually runs — except for new todos with status `waiting`, which stand in for an existing external session that needs user action (follow-ups must resume that session). Setting `session_id` on other new todos would cause them to appear as their own parent in the UI, since `sessionToTodo` would resolve `source_session_id → self`.

## Token Counting & Cost Tracking

Token usage and costs are extracted from Claude CLI's `stream-json` output. During a run, the CLI writes a JSONL file to `data/runs/` containing one JSON object per line. Each object has a `type` field.

### Event Types in Run JSONL

| Type | Purpose | Contains token data? |
|------|---------|---------------------|
| `system` | System prompt, session config | No |
| `user` | User message (prompt, follow-up) | No |
| `assistant` | Claude's response (text, tool_use, tool_result) | No |
| `rate_limit_event` | Rate-limit backoff signal | No |
| `result` | Final session summary — **this is where all cost/token data lives** | **Yes** |

Only `result` events contain token usage. All intermediate events (including tool calls like file reads, edits, bash commands) do **not** carry per-turn token counts.

### What Gets Counted

The `result` event's `usage` field reports **cumulative API-level token counts** for the entire session:

- **`input_tokens`** — tokens sent to the model that were NOT in the prompt cache (cache misses). This is typically very small when the cache is warm.
- **`cache_read_input_tokens`** — tokens sent to the model that WERE in the prompt cache (cache hits). This is the bulk of input during an active session.
- **`cache_creation_input_tokens`** — tokens written into the cache for the first time. Relevant on the first turn or after cache expiry.
- **`output_tokens`** — tokens generated by Claude (responses, tool calls, thinking).

The **total context size** at the end of a session is approximately `input_tokens + cache_read_input_tokens`. This includes everything in the conversation window:

- System prompt
- All user messages (the original task, follow-ups)
- All assistant responses
- **All tool call results** — file contents from Read/Glob/Grep, command output from Bash, edit confirmations, etc.

So yes, every file read, every grep result, every bash command's stdout — all of it contributes to the context size and token count.

### Example `result` Event

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "duration_ms": 610199,
  "duration_api_ms": 598952,
  "num_turns": 51,
  "result": "I've implemented the feature...",
  "session_id": "59cba782-6eff-4311-9ae6-c4a3bd1dad5c",
  "total_cost_usd": 2.41,
  "usage": {
    "input_tokens": 50,
    "cache_creation_input_tokens": 62060,
    "cache_read_input_tokens": 2548756,
    "output_tokens": 23207
  },
  "modelUsage": {
    "claude-opus-4-6": {
      "inputTokens": 50,
      "outputTokens": 23207,
      "cacheReadInputTokens": 2548756,
      "cacheCreationInputTokens": 62060,
      "costUSD": 2.24
    },
    "claude-haiku-4-5-20251001": {
      "inputTokens": 72,
      "outputTokens": 5519,
      "cacheReadInputTokens": 718165,
      "cacheCreationInputTokens": 54007,
      "costUSD": 0.17
    }
  }
}
```

In this example: the session used ~2.5M cached input tokens (context was warm) and only 50 uncached tokens. The `modelUsage` breakdown shows costs split across models (Opus for main work, Haiku for background tasks like tool permission checks).

### How Costs Are Stored

`extract_run_costs()` in `output_parser.py` sums across all `result` events in the JSONL file (there can be multiple if plan-mode auto-accept retries occurred):

```python
cost += obj.get("total_cost_usd", obj.get("cost_usd", 0.0))
input_tokens += usage.get("input_tokens", 0)
output_tokens += usage.get("output_tokens", 0)
cache_read_tokens += usage.get("cache_read_input_tokens", 0)
```

These are then stored on the todo model (`run_cost_usd`, `run_input_tokens`, `run_output_tokens`, `run_cache_read_tokens`) via `_accumulate_costs_on_todo()`, which **sums across follow-ups** — so these fields reflect lifetime totals for the todo, not just the last run.

### Idle Session Warning

When a session has been idle for 1+ hour, the prompt cache has likely expired (Claude's cache TTL is ~5 minutes). The frontend shows a warning above the follow-up input estimating the context size (`run_input_tokens + run_cache_read_tokens`) that would need to be re-read at full input price instead of the discounted cache-read price. Large contexts (200K+ tokens) get a stronger visual warning since the cost difference is significant.

Note: because token counts accumulate across follow-ups, the displayed context size is an upper bound — the actual context at the end of the last turn may be smaller if earlier content was compacted.

## Sidebar Project List

The sidebar renders projects in two sections:

1. **Pinned** — projects with `pinned=true`, always visible (not collapsible). Hidden entirely when empty. When at least one project is pinned, an **All Pinned Projects** aggregate row is shown above the pinned items; selecting it filters the main view to todos from pinned projects only (selection encoded as `?project=__pinned__` in the URL via the `PINNED_VIEW_ID` sentinel in `frontend/src/types.ts`).
2. **All** — remaining projects, under a collapsible header. Collapse state is persisted per-browser in `localStorage` (key `projects-section-collapsed`).

Each project row has a star toggle (☆ / ★) that calls `PUT /api/projects/{id}` with `{pinned: bool}` to move the project between sections. "All Projects" (the aggregate view across every project) stays above both sections.

## Hooks Integration

Optional real-time session state detection via Claude Code hooks. See [hooks.md](hooks.md) for full details, event payloads, and testing instructions.
