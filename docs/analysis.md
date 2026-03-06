# Todo Today — Claude Analysis Pipeline

## How Analysis Works

1. **Staleness Check** — two-tier:
   - **Coarse**: compares the latest session file mtime against `metadata.last_session_mtime`. If nothing changed, skip entirely.
   - **Per-session**: `metadata.session_mtimes` maps each `"project_dir/session_id"` to its last-analyzed mtime. Only sessions whose file mtime exceeds the stored value are included. This avoids re-sending unchanged sessions to Claude, saving tokens/cost.
   - When `force=True`, both checks are bypassed.
2. **Session Discovery** — scans `~/.claude/projects/` for JSONL session files modified in the last 24 hours (configurable via `max_age` param; `None` = no cutoff). Self-generated sessions (from `claude -p` subprocess calls) are excluded.
3. **Message Extraction** — reads the last 20 user/assistant messages from each session (truncated to 2000 chars each)
4. **Session → Project Matching** (`_match_sessions_to_projects`):
   - Each session's `source_path` is matched against `Project.source_path` in the store
   - Unmatched sessions trigger auto-creation of a new project (name derived from the directory basename)
   - Returns `{project_id: [sessions...]}` grouping
5. **Per-Project Prompt** (`_build_project_prompt`) — for each project with changed sessions, builds a scoped prompt containing:
   - Only that project's existing todos
   - Active insights (project-specific + general)
   - Only that project's session transcripts
   - Simplified instructions: `project_id` is fixed (no `new_projects` needed), todos are auto-assigned
6. **Sequential Claude Calls** (no storage lock held) — one `claude -p --output-format json --model <model>` call per project. Each call is cheap because the prompt only contains one project's context.
7. **Per-Project Apply** (`_apply_result`, short storage lock) — for each successful response, applies changes scoped to the target project:
   - Mark existing todos complete (via `completed_todo_ids` backward compat)
   - Apply status transitions (via `status_updates`) — scoped to project's todos only
   - Add new todos with the project_id set automatically (waiting todos for non-actionable sessions are filtered out)
   - Update project summary, persist new insights
   - Repair orphaned todos with invalid project IDs (done once before the loop)
8. **Aggregate Entry** — a single `AnalysisEntry` is recorded per `run_analysis` call, summing metrics from all per-project calls. Prompts/responses are concatenated (delimited by project headers) for debugging via "Copy Prompt"/"Copy Response".

## Todo Statuses

Each todo has a `status` field (replaces the old `completed` boolean):

| Status | Meaning | UI Section | Icon |
|---|---|---|---|
| `next` | Actionable upcoming task | Up Next | → |
| `in_progress` | Actively being worked on | Up Next (sorted first) | ● |
| `completed` | Done | Completed | ✓ |
| `consider` | Idea worth evaluating | Backlog | ? |
| `waiting` | Blocked / needs user input | Backlog (sorted first) | ⏸ |
| `stale` | Possibly no longer relevant | Backlog | ✗ |

### Migration

Old data with `completed: bool` is auto-migrated via Pydantic `model_validator(mode="before")`:
- If `status` absent: `completed=true` → `"completed"`, else → `"next"`
- The `completed` field is dropped from data on load

### Claude Prompt (Per-Project)

Each project gets its own Claude call. The prompt tells Claude the fixed `project_id`, so `new_todos` don't need a `project_id` field — it's set automatically by `_apply_result`. Claude can still return `status_updates` and `completed_todo_ids` (backward compat), but these are scoped: IDs not belonging to the target project are rejected as a safety guard.

Leftover "Next:"/"Consider:" prefixes in todo text are stripped defensively.

## Analysis Entry Fields

Each analysis records:
- `duration_seconds` — wall-clock time
- `sessions_analyzed` — number of sessions found
- `todos_added` / `todos_completed` / `todos_modified` — counts of changes
- `cost_usd` — API cost from Claude CLI
- `input_tokens` / `output_tokens` / `cache_read_tokens` — token usage
- `model` — which model was used (e.g. "haiku", "sonnet")
- `error` — error message if analysis failed
- `prompt_length` — character count of prompt sent

### Change Detail Fields

- `completed_todo_ids` — IDs of existing todos marked done
- `completed_todo_texts` — readable text of those same todos (so history is human-readable)
- `added_todos_active` — text of new next-step todos (not yet done)
- `added_todos_completed` — text of new completed-work records (things already accomplished)
- `modified_todos` — text of existing todos whose text, project, or status was updated
- `new_project_names` — names of newly discovered projects
- `insights` — meta-level observations about workflow or patterns

## Cumulative Usage

Metadata tracks running totals:
- `total_analyses` — number of analyses run
- `total_cost_usd` — cumulative API cost
- `total_input_tokens` / `total_output_tokens` — cumulative token usage

These are displayed in the ClaudeStatus component below the Wake button.

## Per-Project Insights

Insights are tied to specific projects via `project_id`. Claude returns insights as `{project_id, text}` objects. The `project_id` is resolved using the same fuzzy matching as todos. An empty `project_id` means the insight is general (not project-specific).

In the frontend, insights are displayed within the TodoList component, filtered by the selected project. When a specific project is selected, only that project's insights plus general insights (empty `project_id`) are shown. When "All Projects" is selected, all insights are shown.

## Project ID Resolution

Claude (Haiku) sometimes returns project **names** or directory names instead of actual `proj_*` IDs in `new_todos`. The `_resolve_project_id()` helper handles this with a fuzzy matching fallback:

1. **Exact ID** — if the value is already a valid `proj_*` ID, use it directly
2. **Project name** — case-insensitive match against `project.name`
3. **Directory name** — case-insensitive match against the last component of `project.source_path`

If none match, the todo is skipped and a warning is logged.

On each analysis run, existing todos with invalid `project_id` values are also repaired using the same resolution logic.

## Session End-State Detection

`_detect_session_state(path)` reads the last ~10 entries of a session JSONL file (to capture `permissionMode` and recent user/assistant context) and classifies the session's current state:

| State | Meaning | Trigger |
|---|---|---|
| `ended` | Normal completion | Assistant `end_turn` with text (not a question) |
| `waiting_for_user` | Needs user reply | Assistant `end_turn` with text ending in `?` |
| `waiting_for_tool_approval` | Needs user to approve a tool | Assistant `stop_reason=tool_use` + tool needs approval + entry age >60s |
| `tool_running` | Tool is executing | Assistant `stop_reason=tool_use` + tool auto-approves or entry is recent |
| `waiting_for_response` | Tool ran, Claude continuing | Last entry is user `tool_result` |
| `unknown` | Other | File-history-snapshot, progress entries, etc. |

### Tool Approval Classification

`_tool_needs_approval(tool_name, permission_mode)` determines whether a tool call is likely waiting for user approval:

- **Auto-approve tools** (never need approval): Read, Glob, Grep, Edit, Write, Task*, EnterPlanMode, NotebookEdit, TodoRead, TodoWrite
- **Always-approval tools** (always need user action): ExitPlanMode, AskUserQuestion
- **Permission-mode-dependent** (e.g. Bash): auto-approves in `bypassPermissions`, needs approval in `default`/`acceptEdits`

For tools that *could* need approval, a timestamp-based heuristic confirms: if the entry is >60 seconds old with no follow-up, it's classified as `waiting_for_tool_approval`; otherwise `tool_running`.

### Actionable vs Active States

States are grouped for the analysis prompt and waiting-todo logic:
- **Actionable** (`waiting_for_user`, `waiting_for_tool_approval`): user must act to continue. Claude may create "waiting" todos for these.
- **Active** (`tool_running`, `waiting_for_response`): session is progressing on its own. Claude must NOT create "waiting" todos for these — they are filtered out in `_apply_result`.

The state (plus a `last_assistant_text` snippet) is:
- Included in `discover_sessions()` results as `state` and `state_info` fields
- Included in `list_all_sessions()` results as a `state` field
- Appended after each session's messages in the analysis prompt, e.g.:
  `[Session state: waiting_for_user — last assistant message: "Do you want me to proceed?"]`
  `[Session state: active — Claude wants to use Bash. Tool is currently executing, NO user action needed]`

## Session Picker & Targeted Analysis

- `GET /api/claude/sessions` returns lightweight metadata for **all** sessions (no age cutoff): `{key, project_dir, source_path, project_name, session_id, mtime, message_count, last_analyzed_mtime}`
- The frontend ClaudeStatus component has a "Sessions" button that opens an inline picker showing all sessions grouped by project
- Sessions show a "changed" badge when their `mtime` exceeds `last_analyzed_mtime`, indicating new activity since last analysis
- Users can multi-select sessions and click "Analyze Selected" to analyze only those sessions
- When `session_keys` is passed to `POST /api/claude/wake`, only those sessions are discovered (no age cutoff) and analyzed, bypassing staleness checks

## User Todo Protection

Todos with `source="user"` are protected from Claude agent modifications. This is enforced at two levels:

1. **Prompt**: Claude is instructed that user-created todos are protected and the only allowed action is setting status to `"stale"` via `status_updates`.
2. **Code guards** in `apply_changes` (3 locations):
   - `completed_todo_ids`: skips user todos
   - `status_updates`: only allows `status="stale"` for user todos, all other status changes are rejected
   - `modified_todos`: skips user todos entirely (no text/project/status changes)

When a user edits a Claude-created todo in the frontend (double-click to edit), the todo's `source` is changed from `"claude"` to `"user"`, activating this protection.

## Triggers

- **Automatic**: APScheduler runs analysis every N minutes (configurable, default 5)
- **Manual**: "Wake Up Claude" button calls `POST /api/claude/wake`
- **Targeted**: "Analyze Selected" sends `session_keys` to analyze specific sessions

## Concurrency

An `asyncio.Lock` prevents concurrent analyses. If a manual wake is triggered while a scheduled analysis is running, it returns `{ "status": "busy" }`.

`run_analysis` uses a 3-phase approach to minimize lock contention:
1. **Phase 1** (short lock): read current state, build per-project snapshots
2. **Phase 2** (no lock): invoke Claude for each project sequentially
3. **Phase 3** (short lock): apply all results back to the store
