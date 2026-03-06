# Todo Today — API Reference

Base URL: `http://localhost:5152`

## State

### `GET /api/state`
Returns full application state (projects, todos, metadata) in one call.
The frontend polls this every 10 seconds.

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
Update project name or source_path.
```json
{ "name": "new-name" }
```

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
Update todo fields.
```json
{ "completed": true }
```

### `DELETE /api/todos/{todo_id}`
Delete a todo.

## Claude Analysis

### `POST /api/claude/wake`
Manually trigger a Claude analysis. Returns `{ "status": "ok"|"busy", "entry": AnalysisEntry }`.

### `GET /api/claude/status`
Returns scheduler status, heartbeat, and last analysis entry.

### `GET /api/claude/history`
Returns list of past analysis entries (up to 50).

### `GET /api/claude/sessions`
Returns lightweight metadata for all sessions: `{key, project_dir, source_path, project_name, session_id, mtime, message_count, last_analyzed_mtime}`.
`last_analyzed_mtime` is the mtime at which the session was last analyzed (null if never).

### `PUT /api/claude/insights/{id}/dismiss`
Dismiss an insight so it no longer appears in the UI.
Returns `{ "status": "ok" }` on success, 404 if insight not found.
