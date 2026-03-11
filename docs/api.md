# Claude Todos — API Reference

Base URL: `http://localhost:5152`

## Error Responses

All endpoints return errors in a consistent format:

```json
{ "detail": "Human-readable error message", "error_code": null }
```

- `detail` (string): Always present. Describes the error.
- `error_code` (string | null): Optional machine-readable code. Set for validation errors (`"VALIDATION_ERROR"`) and unhandled server errors (`"INTERNAL_ERROR"`).

Common HTTP status codes: 400 (bad request), 403 (forbidden/demo mode), 404 (not found), 409 (conflict/already running), 422 (validation error), 500 (internal server error).

## State

### `GET /api/state`
Returns full application state (projects, todos, metadata) in one call.
The frontend polls this every 3 seconds.

## Projects

### `GET /api/projects`
List all projects.

### `POST /api/projects`
Create a project.
```json
{ "name": "my-project", "source_path": "/path/to/repo" }
```

### `GET /api/projects/{project_id}`
Get a single project.

### `PUT /api/projects/{project_id}`
Update project name, source_path, or autopilot quota.
```json
{ "name": "new-name", "auto_run_quota": 2 }
```
`auto_run_quota`: 0 = Autopilot disabled, 1+ = max todos to auto-run per cycle for this project.

### `DELETE /api/projects/{project_id}`
Delete a project and all its todos.

## Todos

### `GET /api/todos?project_id={id}`
List todos, optionally filtered by project.

### `POST /api/todos`
Create a todo.
```json
{ "project_id": "proj_abc123", "text": "Fix the bug" }
```

### `GET /api/todos/{todo_id}`
Get a single todo.

### `PUT /api/todos/{todo_id}`
Update todo fields. Valid statuses: `next`, `in_progress`, `completed`, `consider`, `waiting`, `stale`, `rejected`.
```json
{ "status": "rejected" }
```
Setting status to `"rejected"` records `rejected_at` timestamp. Rejected todos are shown to the Claude analyzer so it avoids re-suggesting the same ideas.

### `DELETE /api/todos/{todo_id}`
Delete a todo.

### `POST /api/todos/{todo_id}/run`
Kick off a background Claude Code session to complete the todo. Claude runs in the project's `source_path` directory using `claude -p`. The todo is immediately set to `in_progress` with `run_status: "running"`.

Returns `{ "status": "started" }`.

When Claude finishes, the todo is marked `completed` with `run_status: "done"` and `run_output` containing Claude's response. On failure, `run_status` is set to `"error"` and `run_output` contains the error message.

Returns 409 if the todo is already running, 400 if the project has no `source_path`.

## Settings

### `GET /api/claude/settings`
Returns the current settings object:
```json
{
  "analysis_interval_minutes": 30,
  "analysis_model": "haiku",
  "run_model": "opus",
  "heartbeat_enabled": true,
  "hook_analysis_enabled": true
}
```

### `PUT /api/claude/settings`
Partial update — only supplied fields are changed. Returns the full updated settings object.
```json
{ "analysis_interval_minutes": 15, "heartbeat_enabled": false }
```
If `analysis_interval_minutes` is changed, the scheduler is automatically rescheduled.

The `run_model` field is read-only and cannot be changed via this endpoint.

The settings object is also included in the `GET /api/state` response as `state.settings`.

## Claude Analysis

### `POST /api/claude/wake`
Manually trigger a Claude analysis. Returns `{ "status": "ok"|"busy", "entry": AnalysisEntry }`.

### `GET /api/claude/status`
Returns scheduler status, heartbeat, and last analysis entry.

### `GET /api/claude/history`
Returns list of past analysis entries (up to 50).

### `GET /api/claude/sessions`
Returns lightweight metadata for all sessions: `{key, project_dir, source_path, project_name, session_id, mtime, message_count, last_analyzed_mtime, state, state_source}`.
`last_analyzed_mtime` is the mtime at which the session was last analyzed (null if never).
`state` is the detected session state (e.g. `"ended"`, `"waiting_for_user"`, `"tool_running"`).
`state_source` is `"hook"` if detected via hooks, or `"jsonl"` if estimated from JSONL heuristics.

### `PUT /api/claude/insights/{id}/dismiss`
Dismiss an insight so it no longer appears in the UI.
Returns `{ "status": "ok" }` on success, 404 if insight not found.

## Event Bus

### `GET /api/events`
SSE (Server-Sent Events) stream of real-time events from the event bus. Events include hook updates, analysis lifecycle, run lifecycle, queue drains, autopilot, and data mutations.

Each event is sent as:
```
event: <event_type>
data: {"type": "<event_type>", "data": {...}, "ts": <unix_timestamp>}
```

A keepalive comment is sent every 15 seconds. The connection auto-reconnects on the frontend side.

### `GET /api/events/recent?limit=50`
Returns the last N events from the in-memory ring buffer (for debugging).

### `GET /api/events/status`
Returns `{ "subscribers": <int>, "recent_events": <int> }` — number of active SSE connections and buffered events.

## Hooks

See [hooks.md](hooks.md) for full documentation, example payloads, and testing.

| Endpoint | Method | Description |
|---|---|---|
| `/api/claude/hooks/status` | GET | Check if hooks are installed |
| `/api/claude/hooks/install` | POST | Install hook entries into `~/.claude/settings.json` |
| `/api/claude/hooks/uninstall` | POST | Remove hook entries |
| `/api/claude/hooks/events` | GET | Sessions in notifiable states (polled for real-time notifications) |
