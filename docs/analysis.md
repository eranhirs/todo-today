# Todo Today — Claude Analysis Pipeline

## How Analysis Works

1. **Session Discovery** — scans `~/.claude/projects/` for JSONL session files modified in the last 24 hours
2. **Message Extraction** — reads the last 20 user/assistant messages from each session (truncated to 2000 chars each)
3. **Prompt Building** — combines current todos/projects state + session transcripts into a structured prompt
4. **Claude Invocation** — calls `claude -p --output-format json --model haiku` via subprocess
5. **Result Parsing** — extracts JSON response with completed todos, new todos, project summaries, new projects, insights
6. **Apply Changes** — atomically updates the store (mark completed, add todos, create projects, update summaries)
7. **Record Metadata** — saves analysis entry with duration, cost, token counts, what changed

## Analysis Entry Fields

Each analysis records:
- `duration_seconds` — wall-clock time
- `sessions_analyzed` — number of sessions found
- `todos_added` / `todos_completed` — count of changes
- `cost_usd` — API cost from Claude CLI
- `input_tokens` / `output_tokens` / `cache_read_tokens` — token usage
- `error` — error message if analysis failed
- `completed_todo_ids` — IDs of todos marked done
- `added_todos` — text of new todos created
- `new_project_names` — names of newly discovered projects
- `insights` — meta-level observations about workflow or patterns (text only in history entries)
- `prompt_length` — character count of prompt sent

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

On each analysis run, existing todos with invalid `project_id` values are also repaired using the same resolution logic. This fixes orphaned todos that were created before this safeguard existed.

## Triggers

- **Automatic**: APScheduler runs analysis every 5 minutes
- **Manual**: "Wake Up Claude" button calls `POST /api/claude/wake`

## Concurrency

An `asyncio.Lock` prevents concurrent analyses. If a manual wake is triggered while a scheduled analysis is running, it returns `{ "status": "busy" }`.
