# Todo Today — Hooks Integration

## Overview

Claude Code supports [hooks](https://docs.anthropic.com/en/docs/claude-code/hooks) — lifecycle event callbacks that fire in real-time at key moments (permission prompts, session start/end, response completion). Todo Today can install hooks to get **accurate, real-time session state detection**, replacing the JSONL-based heuristic that estimates state from file timestamps and stop reasons.

## Design Principles

- **Opt-in**: hooks are off by default — zero behavior change until explicitly installed
- **Additive**: hook entries are merged into existing `~/.claude/settings.json`, never clobbering user hooks
- **Graceful fallback**: sessions without hook data use the existing JSONL heuristic
- **Visible**: session state badges in the UI show a green dot when sourced from hooks vs estimated from JSONL
- **Real-time notifications**: when a hook catches a waiting event (tool approval or user input), a toast and browser notification fire within 3 seconds — no need to wait for the analysis heartbeat

## How It Works

1. User clicks **Install** in the Hooks section of the Claude Status panel (or calls `POST /api/claude/hooks/install`)
2. The app adds entries to `~/.claude/settings.json` for four events: `PermissionRequest`, `Stop`, `SessionStart`, `SessionEnd`
3. Each event pipes JSON to `hooks/todo-today-hook.py`, which writes state to `data/hook_states.json` atomically (flock + temp file + rename)
4. The analyzer's `_detect_session_state()` checks hook state first, falling back to JSONL parsing only when no hook data exists
5. The frontend polls `GET /api/claude/hooks/events` every 3 seconds and shows notifications for newly waiting sessions

## Files

| File | Purpose |
|------|---------|
| `hooks/todo-today-hook.py` | Hook script — reads event JSON from stdin, writes to `data/hook_states.json` |
| `backend/hook_state.py` | Backend reader — `load_hook_states()`, `get_hook_state()`, `get_waiting_sessions()` |
| `backend/routers/claude.py` | API endpoints — install, uninstall, status, waiting |
| `backend/claude_analyzer.py` | `_detect_session_state()` — checks hook state before JSONL fallback |
| `data/hook_states.json` | State file (auto-generated, gitignored) |

## Hook Events

The hook script handles four Claude Code lifecycle events:

| Hook Event | State Written | Data Stored |
|---|---|---|
| `PermissionRequest` | `waiting_for_tool_approval` | tool name, command/file detail, project name, cwd |
| `Stop` | `ended` or `waiting_for_user` (if last message ends with `?`) | last message snippet, project name, cwd |
| `SessionStart` | *(clears stale state for the session)* | — |
| `SessionEnd` | `ended` | project name, cwd |

Entries older than 24 hours are expired on each write.

## Example Hook Event Payloads

These are the JSON objects Claude Code sends to hooks on stdin (from the [official docs](https://docs.anthropic.com/en/docs/claude-code/hooks)):

### PermissionRequest
```json
{
  "session_id": "abc123",
  "transcript_path": "/home/user/.claude/projects/-home-user-myproject/00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/home/user/myproject",
  "permission_mode": "default",
  "hook_event_name": "PermissionRequest",
  "tool_name": "Bash",
  "tool_input": {
    "command": "rm -rf node_modules",
    "description": "Remove node_modules directory"
  },
  "permission_suggestions": [
    { "type": "toolAlwaysAllow", "tool": "Bash" }
  ]
}
```

### Stop
```json
{
  "session_id": "abc123",
  "transcript_path": "/home/user/.claude/projects/-home-user-myproject/00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/home/user/myproject",
  "permission_mode": "default",
  "hook_event_name": "Stop",
  "stop_hook_active": true,
  "last_assistant_message": "I've completed the refactoring. Here's a summary..."
}
```

### SessionStart
```json
{
  "session_id": "abc123",
  "transcript_path": "/home/user/.claude/projects/-home-user-myproject/00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/home/user/myproject",
  "permission_mode": "default",
  "hook_event_name": "SessionStart",
  "source": "startup",
  "model": "claude-sonnet-4-6"
}
```

### SessionEnd
```json
{
  "session_id": "abc123",
  "transcript_path": "/home/user/.claude/projects/-home-user-myproject/00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
  "cwd": "/home/user/myproject",
  "permission_mode": "default",
  "hook_event_name": "SessionEnd",
  "reason": "other"
}
```

## State File Format

`data/hook_states.json` maps session keys to their current state:

```json
{
  "-home-user-myproject/00893aaf-19fa-41d2-8238-13269b9b3ca0": {
    "state": "waiting_for_tool_approval",
    "tool_name": "Bash",
    "detail": "npm run build",
    "project_name": "myproject",
    "cwd": "/home/user/myproject",
    "timestamp": "2026-03-07T10:30:00Z",
    "hook_event": "PermissionRequest"
  }
}
```

## API Endpoints

### `GET /api/claude/hooks/status`
Returns whether hooks are installed.
```json
{ "installed": true, "installed_events": ["PermissionRequest", "Stop", "SessionStart", "SessionEnd"], "hook_script": "/path/to/hooks/todo-today-hook.py" }
```

### `POST /api/claude/hooks/install`
Installs hook entries into `~/.claude/settings.json`. Merges with existing hooks.
```json
{ "status": "ok", "installed_events": ["PermissionRequest", "Stop", "SessionStart", "SessionEnd"] }
```

### `POST /api/claude/hooks/uninstall`
Removes Todo Today hook entries from settings.
```json
{ "status": "ok", "removed_events": ["PermissionRequest", "Stop", "SessionStart", "SessionEnd"] }
```

### `GET /api/claude/hooks/events`
Returns sessions in notifiable states (waiting or recently ended). The frontend polls this every 3 seconds, detects state transitions, and shows typed notifications.
```json
{
  "-home-user-myproject/session-id": {
    "state": "waiting_for_tool_approval",
    "tool_name": "Bash",
    "detail": "npm run build",
    "project_name": "myproject",
    "cwd": "/home/user/myproject",
    "timestamp": "2026-03-07T10:30:00Z",
    "hook_event": "PermissionRequest"
  }
}
```

## Notifications

Notifications fire within 3 seconds when a hook catches an event. Each event type has a distinct visual style:

| Hook Event | Condition | Toast Style | Example |
|---|---|---|---|
| `PermissionRequest` | Always | **Warning** (amber border) | `[myproject] Waiting for approval — Bash: npm run build` |
| `Stop` (question) | `last_assistant_message` ends with `?` | **Warning** (amber border) | `[myproject] Waiting for user input: Should I proceed?` |
| `Stop` (finished) | `last_assistant_message` does not end with `?` | **Success** (green border) | `[myproject] Session finished: Done with the refactoring.` |
| `SessionEnd` | Always | **Success** (green border) | `[myproject] Session finished` |

Events that do **not** trigger notifications:
- `SessionStart` (clears stale state, no notification)
- State transitions to the same state (deduplicated)

### Toast Styles

All notifications appear as both in-app toasts and browser notifications (if permission granted). Toasts are color-coded:

| Style | Border Color | Background | Used For |
|---|---|---|---|
| **Warning** | Amber | Dark warm | Waiting events (tool approval, user input) |
| **Success** | Green | Dark green | Session finished, run completed |
| **Error** | Red | Dark red | Run failures |
| **Info** | Blue | Card background | General notifications |

## Testing

### Manual test with simulated events

```bash
# Simulate a PermissionRequest
echo '{"hook_event_name":"PermissionRequest","session_id":"test","transcript_path":"/home/user/.claude/projects/-home-user-myproject/test.jsonl","tool_name":"Bash","tool_input":{"command":"npm run build"},"cwd":"/home/user/myproject"}' | python3 hooks/todo-today-hook.py

# Check the state file
cat data/hook_states.json

# Check via API
curl -s http://localhost:5152/api/claude/hooks/events | python3 -m json.tool
```

### End-to-end test

1. Install hooks via UI or `curl -s -X POST http://localhost:5152/api/claude/hooks/install`
2. Open a Claude Code session in any project (default permission mode)
3. Trigger a permission prompt (e.g. ask Claude to run a shell command)
4. Within 3 seconds, a toast notification should appear in the Todo Today UI
5. In the session picker, the session should show a state badge with a green dot

### Verify JSONL fallback

1. Uninstall hooks via UI or `curl -s -X POST http://localhost:5152/api/claude/hooks/uninstall`
2. Browse sessions — state badges should still appear but without the green dot (sourced from JSONL heuristics)

## Uninstalling

Click **Uninstall** in the Hooks section, or call `POST /api/claude/hooks/uninstall`. This removes only Todo Today's hook entries from `~/.claude/settings.json` — other hooks are left intact. The app falls back to JSONL-based state detection immediately.
