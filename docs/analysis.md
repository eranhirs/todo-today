# Todo Today — Claude Analysis Pipeline

## How Analysis Works

1. **Staleness Check** — two-tier:
   - **Coarse**: compares the latest session file mtime against `metadata.last_session_mtime`. If nothing changed, skip entirely.
   - **Per-session**: `metadata.session_mtimes` maps each `"project_dir/session_id"` to its last-analyzed mtime. Only sessions whose file mtime exceeds the stored value are included. This avoids re-sending unchanged sessions to Claude, saving tokens/cost.
   - When `force=True`, both checks are bypassed.
2. **Session Discovery** — scans `~/.claude/projects/` for JSONL session files modified in the last 24 hours (configurable via `max_age` param; `None` = no cutoff). Self-generated sessions (from `claude -p` subprocess calls) are excluded.
3. **Message Extraction** — reads the last 20 user/assistant messages from each session (truncated to 2000 chars each)
4. **Prompt Building** — builds a **single prompt** containing:
   - Current todos and projects (JSON snapshot)
   - Active insights (to avoid duplicates)
   - All recent session transcripts (all sessions combined)
5. **Claude Invocation** — makes **one** `claude -p --output-format json --model <model>` call with the combined prompt
6. **Result Parsing** — extracts JSON response with: `completed_todo_ids`, `new_todos` (with `completed` flag), `modified_todos`, `project_summaries`, `new_projects`, `insights`
7. **Apply Changes** — atomically updates the store:
   - Mark existing todos complete (via `completed_todo_ids`)
   - Add new active todos (`completed: false`) and completed-work records (`completed: true`)
   - Create new projects, update summaries
   - Persist new insights (deduped by project + text)
   - Repair orphaned todos with invalid project IDs
8. **Record Metadata** — saves analysis entry with duration, cost, token counts, and categorized change lists

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
- `modified_todos` — text of existing todos whose text or project was updated
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

## Session Picker & Targeted Analysis

- `GET /api/claude/sessions` returns lightweight metadata for **all** sessions (no age cutoff): `{key, project_dir, source_path, project_name, session_id, mtime, message_count}`
- The frontend ClaudeStatus component has a "Sessions" button that opens an inline picker showing all sessions grouped by project
- Users can multi-select sessions and click "Analyze Selected" to analyze only those sessions
- When `session_keys` is passed to `POST /api/claude/wake`, only those sessions are discovered (no age cutoff) and analyzed, bypassing staleness checks

## Triggers

- **Automatic**: APScheduler runs analysis every N minutes (configurable, default 5)
- **Manual**: "Wake Up Claude" button calls `POST /api/claude/wake`
- **Targeted**: "Analyze Selected" sends `session_keys` to analyze specific sessions

## Concurrency

An `asyncio.Lock` prevents concurrent analyses. If a manual wake is triggered while a scheduled analysis is running, it returns `{ "status": "busy" }`.
