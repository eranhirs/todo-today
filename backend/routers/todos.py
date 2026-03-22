from __future__ import annotations

from ..storage import run_in_thread
import logging
import mimetypes
import os
import re
import uuid
import yaml
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ..event_bus import EventType, bus
from ..models import ImageAttachment, Todo, TodoCreate, TodoReorder, TodoUpdate, _now
from ..tags import collect_all_tags, rename_tag_in_text, parse_tags
from ..run_manager import (
    OUTPUT_MAX_CHARS,
    _followup_claude_for_todo,
    _process_queue,
    cancel_pending_followup,
    cap_output,
    dequeue_todo_run,
    is_btw_running,
    is_project_busy,
    is_todo_running,
    process_manager,
    start_btw,
    start_todo_run,
)
from ..storage import StorageContext

_DEMO_MODE = os.environ.get("TODO_DEMO", "").lower() in ("1", "true", "yes")

# Image storage: either local (next to todos.json) or ephemeral (/tmp)
_TMP_IMAGE_DIR = Path("/tmp/claude-todos-images")


def _get_image_dir() -> Path:
    """Return the image directory based on the local_image_storage setting."""
    from ..storage import DATA_DIR, load_metadata
    try:
        meta = load_metadata()
        if meta.local_image_storage:
            d = DATA_DIR / "images"
            d.mkdir(parents=True, exist_ok=True)
            return d
    except Exception:
        pass
    _TMP_IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    return _TMP_IMAGE_DIR

_ALLOWED_IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"}
_MAX_IMAGE_SIZE = 20 * 1024 * 1024  # 20 MB

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/todos", tags=["todos"])

from ..command_registry import get_all_registry_commands


def _parse_skill_frontmatter(path: Path) -> dict | None:
    """Parse YAML frontmatter from a SKILL.md or command .md file."""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    if not text.startswith("---"):
        return None
    end = text.find("---", 3)
    if end == -1:
        return None
    try:
        fm = yaml.safe_load(text[3:end])
    except yaml.YAMLError:
        return None
    if not isinstance(fm, dict) or "name" not in fm:
        return None
    return fm


def _scan_claude_dir(claude_dir: Path, results: list[dict], seen_names: set[str]) -> None:
    """Scan a single .claude directory for skills and commands."""
    # Skills: .claude/skills/*/SKILL.md
    skills_dir = claude_dir / "skills"
    if skills_dir.is_dir():
        for skill_dir in skills_dir.iterdir():
            if not skill_dir.is_dir():
                continue
            skill_file = skill_dir / "SKILL.md"
            if not skill_file.exists():
                continue
            fm = _parse_skill_frontmatter(skill_file)
            if fm and fm["name"] not in seen_names:
                seen_names.add(fm["name"])
                results.append({
                    "name": fm["name"],
                    "description": fm.get("description", ""),
                    "type": "skill",
                })

    # Commands: .claude/commands/*.md
    commands_dir = claude_dir / "commands"
    if commands_dir.is_dir():
        for cmd_file in commands_dir.iterdir():
            if cmd_file.suffix != ".md":
                continue
            fm = _parse_skill_frontmatter(cmd_file)
            if fm and fm["name"] not in seen_names:
                seen_names.add(fm["name"])
                results.append({
                    "name": fm["name"],
                    "description": fm.get("description", ""),
                    "type": "command",
                })
            elif not fm:
                # Commands without frontmatter: use filename as name
                name = cmd_file.stem
                if name not in seen_names:
                    seen_names.add(name)
                    results.append({
                        "name": name,
                        "description": "",
                        "type": "command",
                    })


def _discover_commands(project_id: str | None = None) -> list[dict]:
    """Discover skills and commands scoped to one project (+ user-level ~/.claude)."""
    registry_cmds = get_all_registry_commands()
    results: list[dict] = list(registry_cmds)
    seen_names: set[str] = {c["name"] for c in registry_cmds}

    # If a project_id is given, only scan that project's source_path
    if project_id:
        try:
            with StorageContext(read_only=True) as ctx:
                for p in ctx.store.projects:
                    if p.id == project_id and p.source_path:
                        _scan_claude_dir(Path(p.source_path) / ".claude", results, seen_names)
                        break
        except Exception:
            pass
    else:
        # No project selected: scan all projects
        try:
            with StorageContext(read_only=True) as ctx:
                for p in ctx.store.projects:
                    if p.source_path:
                        _scan_claude_dir(Path(p.source_path) / ".claude", results, seen_names)
        except Exception:
            pass

    # Always include user-level ~/.claude
    _scan_claude_dir(Path.home() / ".claude", results, seen_names)

    return results


def _is_command_todo(text: str, project_id: str | None = None) -> bool:
    """Check if text contains any /command token (excluding /manual).

    Any /word is treated as a command — it will be proxied to Claude CLI.
    """
    from ..command_registry import get_command
    # Any slash token counts, unless it's /manual (noop)
    for m in re.finditer(r'(?:^|\s)/([A-Za-z][A-Za-z0-9_-]*)(?=\s|$)', text):
        cmd_name = m.group(1).lower()
        registered = get_command(cmd_name)
        if registered and registered.strategy == "noop":
            continue
        return True
    return False


@router.get("/commands")
async def list_commands(project_id: Optional[str] = None) -> list[dict]:
    """Return slash commands and skills scoped to a project (+ user-level)."""
    def _do():
        return _discover_commands(project_id)
    return await run_in_thread(_do)


@router.get("/tags")
async def list_tags() -> list[str]:
    """Return all unique tags found across all todo texts."""
    def _do():
        with StorageContext(read_only=True) as ctx:
            return collect_all_tags([t.text for t in ctx.store.todos])
    return await run_in_thread(_do)


class TagRename(BaseModel):
    old_tag: str
    new_tag: str


@router.put("/tags/rename")
async def rename_tag(body: TagRename) -> dict:
    """Rename a tag across all todos that contain it."""
    old = body.old_tag.lower().strip()
    new = body.new_tag.lower().strip()
    if not old or not new:
        raise HTTPException(status_code=400, detail="Tags must not be empty")
    if old == new:
        return {"status": "ok", "updated": 0}
    # Validate new tag format
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]*", new):
        raise HTTPException(status_code=400, detail="Invalid tag format")
    def _do():
        updated = 0
        with StorageContext() as ctx:
            for t in ctx.store.todos:
                tags = parse_tags(t.text)
                if old in tags:
                    t.text = rename_tag_in_text(t.text, old, new)
                    updated += 1
        return updated
    updated = await run_in_thread(_do)
    return {"status": "ok", "updated": updated}


@router.get("")
async def list_todos(project_id: Optional[str] = None) -> list[Todo]:
    def _do():
        with StorageContext(read_only=True) as ctx:
            todos = ctx.store.todos
            if project_id:
                todos = [t for t in todos if t.project_id == project_id]
            return todos
    return await run_in_thread(_do)


@router.get("/completed")
async def load_more_completed(offset: int = 0, limit: int = 50, project_id: Optional[str] = None):
    """Load completed todos with pagination. Used for infinite scroll."""
    def _do():
        with StorageContext(read_only=True) as ctx:
            completed = sorted(
                [t for t in ctx.store.todos if t.status == "completed" and (not project_id or t.project_id == project_id)],
                key=lambda t: t.completed_at or "",
                reverse=True,
            )
            total = len(completed)
            page = completed[offset:offset + limit]
            return {"todos": page, "total": total, "has_more": offset + limit < total}
    return await run_in_thread(_do)


@router.get("/search")
async def search_todos(q: str, project_id: Optional[str] = None):
    """Search across ALL todos (including completed) regardless of pagination caps."""
    def _do():
        with StorageContext(read_only=True) as ctx:
            query = q.strip().lower()
            if not query:
                return []
            results = []
            for t in ctx.store.todos:
                if project_id and t.project_id != project_id:
                    continue
                if query in t.text.lower() or (t.run_output and query in t.run_output.lower()):
                    results.append(t)
            return results
    return await run_in_thread(_do)


@router.post("/images", status_code=201)
async def upload_image(file: UploadFile) -> dict:
    """Upload an image to be attached to a todo. Returns the filename."""
    if file.content_type not in _ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=400, detail=f"Unsupported image type: {file.content_type}")
    ext = mimetypes.guess_extension(file.content_type) or ".png"
    if ext == ".jpe":
        ext = ".jpg"
    filename = f"{uuid.uuid4().hex[:16]}{ext}"
    filepath = _get_image_dir() / filename
    data = await file.read()
    if len(data) > _MAX_IMAGE_SIZE:
        raise HTTPException(status_code=400, detail="Image too large (max 20 MB)")
    await run_in_thread(filepath.write_bytes, data)
    return {"filename": filename}


@router.get("/images/{filename}")
async def get_image(filename: str) -> FileResponse:
    """Serve an uploaded image."""
    # Prevent path traversal
    if "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")
    filepath = _get_image_dir() / filename
    if not filepath.exists():
        raise HTTPException(status_code=404, detail="Image not found")
    return FileResponse(filepath)


@router.delete("/images/{filename}", status_code=204)
async def delete_image(filename: str) -> None:
    """Delete an uploaded image."""
    if "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")
    filepath = _get_image_dir() / filename
    if filepath.exists():
        await run_in_thread(filepath.unlink)


@router.post("", status_code=201)
async def create_todo(body: TodoCreate) -> Todo:
    image_attachments = [ImageAttachment(filename=f, source="creation") for f in body.images]
    # Derive manual flag from /manual command in text (text is kept as-is)
    is_manual = bool(re.search(r'(?:^|\s)/manual(?:\s|$)', body.text))
    is_cmd = _is_command_todo(body.text, body.project_id)
    todo = Todo(project_id=body.project_id, text=body.text, status=body.status, source="user", plan_only=body.plan_only, manual=is_manual, is_command=is_cmd, images=image_attachments)
    if todo.status == "completed":
        todo.completed_at = _now()
    def _do():
        with StorageContext() as ctx:
            project = None
            for p in ctx.store.projects:
                if p.id == body.project_id:
                    project = p
                    break
            if project is None:
                return "not_found"
            # Auto-assign sort_order: min existing - 1 so new todos appear at top
            min_order = min((t.sort_order for t in ctx.store.todos if t.project_id == body.project_id), default=1)
            todo.sort_order = min_order - 1
            ctx.store.todos.append(todo)
            return "ok"
    result = await run_in_thread(_do)
    if result == "not_found":
        raise HTTPException(status_code=404, detail="Project not found")
    bus.emit_event_sync(EventType.TODO_CREATED, todo_id=todo.id, project_id=todo.project_id, text=todo.text)
    return todo


@router.put("/reorder")
async def reorder_todos(body: TodoReorder) -> dict:
    """Update sort_order for a list of todo IDs (in desired order)."""
    def _do():
        with StorageContext() as ctx:
            id_to_todo = {t.id: t for t in ctx.store.todos}
            for idx, todo_id in enumerate(body.todo_ids):
                if todo_id in id_to_todo:
                    id_to_todo[todo_id].sort_order = idx
            # Only mark the actually-moved item as user_ordered
            if body.moved_id and body.moved_id in id_to_todo:
                id_to_todo[body.moved_id].user_ordered = True
    await run_in_thread(_do)
    return {"status": "ok"}


@router.get("/{todo_id}")
async def get_todo(todo_id: str) -> Todo:
    def _do():
        with StorageContext(read_only=True) as ctx:
            for t in ctx.store.todos:
                if t.id == todo_id:
                    return t
        return None
    result = await run_in_thread(_do)
    if result is None:
        raise HTTPException(status_code=404, detail="Todo not found")
    return result


@router.put("/{todo_id}")
async def update_todo(todo_id: str, body: TodoUpdate) -> Todo:
    def _do():
        with StorageContext() as ctx:
            for t in ctx.store.todos:
                if t.id == todo_id:
                    if body.text is not None:
                        t.text = body.text
                        t.original_text = None  # User chose this text — clear analyzer rename history
                        # Re-derive manual flag and is_command from text content
                        t.manual = bool(re.search(r'(?:^|\s)/manual(?:\s|$)', body.text))
                        t.is_command = _is_command_todo(body.text, t.project_id)
                    if body.project_id is not None:
                        t.project_id = body.project_id
                    if body.status is not None:
                        was_completed = t.status == "completed"
                        was_rejected = t.status == "rejected"
                        t.status = body.status
                        if body.status == "completed" and not was_completed:
                            t.completed_at = _now()
                        elif body.status != "completed" and was_completed:
                            t.completed_at = None
                        if body.status == "rejected" and not was_rejected:
                            t.rejected_at = _now()
                        elif body.status != "rejected" and was_rejected:
                            t.rejected_at = None
                    if body.source is not None:
                        t.source = body.source
                    if body.stale_reason is not None:
                        t.stale_reason = body.stale_reason
                    if body.is_read is not None:
                        t.is_read = body.is_read
                    if body.user_ordered is not None:
                        t.user_ordered = body.user_ordered
                        # When unpinning, recalculate sort_order for unpinned siblings by created_at
                        if not body.user_ordered:
                            siblings = [
                                s for s in ctx.store.todos
                                if s.project_id == t.project_id
                            ]
                            # Pinned items keep their sort_order; unpinned get re-slotted by created_at
                            pinned = sorted(
                                [s for s in siblings if s.user_ordered],
                                key=lambda s: s.sort_order,
                            )
                            unpinned = sorted(
                                [s for s in siblings if not s.user_ordered],
                                key=lambda s: s.created_at,
                            )
                            # Merge: pinned occupy their slots, unpinned fill remaining slots
                            pinned_slots = {s.sort_order for s in pinned}
                            slot = 0
                            for s in unpinned:
                                while slot in pinned_slots:
                                    slot += 1
                                s.sort_order = slot
                                slot += 1
                    # Clear stale_reason when moving away from stale
                    if body.status is not None and body.status != "stale":
                        t.stale_reason = None
                    bus.emit_event_sync(EventType.TODO_UPDATED, todo_id=t.id, status=t.status)
                    return t
        return None
    result = await run_in_thread(_do)
    if result is None:
        raise HTTPException(status_code=404, detail="Todo not found")
    return result


class RedFlagResolve(BaseModel):
    flag_index: int
    resolved: bool


@router.put("/{todo_id}/red_flags/{flag_index}")
async def resolve_red_flag(todo_id: str, flag_index: int, body: RedFlagResolve) -> Todo:
    """Toggle a red flag between resolved (green) and unresolved (red)."""
    def _do():
        with StorageContext() as ctx:
            for t in ctx.store.todos:
                if t.id == todo_id:
                    if flag_index < 0 or flag_index >= len(t.red_flags):
                        return "flag_not_found"
                    t.red_flags[flag_index]["resolved"] = body.resolved
                    if body.resolved:
                        t.red_flags[flag_index]["resolved_at"] = _now()
                    else:
                        t.red_flags[flag_index].pop("resolved_at", None)
                    return t
        return None
    result = await run_in_thread(_do)
    if result == "flag_not_found":
        raise HTTPException(status_code=404, detail="Red flag not found")
    if result is None:
        raise HTTPException(status_code=404, detail="Todo not found")
    return result


@router.delete("/{todo_id}/red_flags/{flag_index}")
async def dismiss_red_flag(todo_id: str, flag_index: int) -> Todo:
    """Remove a red flag entirely (user dismissal — flag was irrelevant)."""
    def _do():
        with StorageContext() as ctx:
            for t in ctx.store.todos:
                if t.id == todo_id:
                    if flag_index < 0 or flag_index >= len(t.red_flags):
                        return "flag_not_found"
                    t.red_flags.pop(flag_index)
                    return t
        return None
    result = await run_in_thread(_do)
    if result == "flag_not_found":
        raise HTTPException(status_code=404, detail="Red flag not found")
    if result is None:
        raise HTTPException(status_code=404, detail="Todo not found")
    return result


@router.delete("/{todo_id}", status_code=204)
async def delete_todo(todo_id: str) -> None:
    def _do():
        with StorageContext() as ctx:
            # Find the todo and collect its image filenames before removing
            image_filenames = []
            found = False
            remaining = []
            for t in ctx.store.todos:
                if t.id == todo_id:
                    found = True
                    image_filenames = [img.filename for img in t.images]
                else:
                    remaining.append(t)
            if not found:
                return None
            ctx.store.todos = remaining
        return image_filenames
    result = await run_in_thread(_do)
    if result is None:
        raise HTTPException(status_code=404, detail="Todo not found")
    # Delete associated image files outside the lock
    if result:
        image_dir = _get_image_dir()
        for fname in result:
            fp = image_dir / fname
            if fp.exists():
                fp.unlink(missing_ok=True)
    bus.emit_event_sync(EventType.TODO_DELETED, todo_id=todo_id)


@router.post("/{todo_id}/stop")
async def stop_todo(todo_id: str) -> dict:
    """Stop a running Claude Code session for a todo."""
    if _DEMO_MODE:
        raise HTTPException(status_code=403, detail="Disabled in demo mode")

    def _do():
        with StorageContext() as ctx:
            todo = None
            for t in ctx.store.todos:
                if t.id == todo_id:
                    todo = t
                    break
            if todo is None:
                return {"error": "not_found"}
            if todo.run_status != "running":
                return {"error": "not_running"}

            pid = todo.run_pid
            btw_pid = todo.btw_pid
            output_file_str = todo.run_output_file
            btw_output_file_str = todo.btw_output_file
            proj_id = todo.project_id

            # Update todo state — treat stop as a pause,
            # preserving session_id and run_output so follow-up can continue.
            todo.run_status = "stopped"
            todo.status = "waiting"
            todo.run_pid = None
            todo.run_output_file = None
            # Also stop any concurrent btw session
            if btw_pid:
                todo.btw_pid = None
                todo.btw_output_file = None
                if todo.btw_status == "running":
                    todo.btw_status = "error"
                    todo.btw_output = cap_output((todo.btw_output or "") + "\n\n--- Stopped ---")
            # Append interruption marker to output
            if todo.run_output:
                todo.run_output = cap_output(todo.run_output + "\n\n--- Paused ---")

        return {"pid": pid, "btw_pid": btw_pid, "output_file": output_file_str, "btw_output_file": btw_output_file_str, "proj_id": proj_id}

    info = await run_in_thread(_do)
    if info.get("error") == "not_found":
        raise HTTPException(status_code=404, detail="Todo not found")
    if info.get("error") == "not_running":
        raise HTTPException(status_code=409, detail="Todo is not running")

    pid = info["pid"]
    btw_pid = info["btw_pid"]

    # Kill the subprocess (and its process group) outside the lock
    if pid:
        process_manager.kill_process(pid)
    if btw_pid:
        process_manager.kill_process(btw_pid)

    # Clean up the thread tracker
    process_manager.unregister_thread(todo_id)

    # Clean up output files
    if info["output_file"]:
        process_manager.cleanup_output_file(Path(info["output_file"]))
    if info["btw_output_file"]:
        process_manager.cleanup_output_file(Path(info["btw_output_file"]))

    bus.emit_event_sync(EventType.RUN_STOPPED, todo_id=todo_id)
    log.info("Stopped (interrupted) claude run for todo %s (pid %s)", todo_id, pid)

    # Process queue — start next queued todo for this project
    _process_queue(info["proj_id"])

    return {"status": "stopped"}


class RunRequest(BaseModel):
    plan_only: Optional[bool] = None


@router.post("/{todo_id}/run")
async def run_todo(todo_id: str, body: RunRequest = RunRequest()) -> dict:
    """Kick off a Claude Code session to complete a todo, or queue it if the project is busy."""
    if _DEMO_MODE:
        raise HTTPException(status_code=403, detail="Disabled in demo mode")

    # If plan_only is explicitly set, update the todo before running
    if body.plan_only is not None:
        def _update_plan():
            with StorageContext() as ctx:
                for t in ctx.store.todos:
                    if t.id == todo_id:
                        t.plan_only = body.plan_only
                        break
        await run_in_thread(_update_plan)

    err = await run_in_thread(start_todo_run, todo_id)
    if err == "manual task":
        raise HTTPException(status_code=400, detail="This is a manual task — it can only be completed by a human")
    if err == "run_quota_exceeded":
        raise HTTPException(status_code=429, detail="Daily run limit reached for this project")
    if err == "already running":
        raise HTTPException(status_code=409, detail="This todo is already running")
    if err == "already queued":
        raise HTTPException(status_code=409, detail="This todo is already queued — it will run when the current task finishes")
    if err == "queued":
        return {"status": "queued"}
    if err == "todo not found":
        raise HTTPException(status_code=404, detail="Todo not found")
    if err == "no source_path":
        raise HTTPException(status_code=400, detail="Project has no source_path configured")
    if err:
        raise HTTPException(status_code=500, detail=err)

    return {"status": "started"}


@router.post("/{todo_id}/dequeue")
async def dequeue_todo(todo_id: str) -> dict:
    """Remove a todo from the run queue."""
    if _DEMO_MODE:
        raise HTTPException(status_code=403, detail="Disabled in demo mode")

    err = await run_in_thread(dequeue_todo_run, todo_id)
    if err == "not queued":
        raise HTTPException(status_code=409, detail="This todo is not queued")
    if err == "todo not found":
        raise HTTPException(status_code=404, detail="Todo not found")
    if err:
        raise HTTPException(status_code=500, detail=err)

    return {"status": "dequeued"}


class FollowupRequest(BaseModel):
    message: str
    images: List[str] = []
    plan_only: bool = False


class EditFollowupRequest(BaseModel):
    message: str


@router.patch("/{todo_id}/followup")
async def edit_queued_followup(todo_id: str, body: EditFollowupRequest) -> dict:
    """Edit a queued follow-up message before it starts running."""
    if _DEMO_MODE:
        raise HTTPException(status_code=403, detail="Disabled in demo mode")

    new_msg = body.message.strip()
    if not new_msg:
        raise HTTPException(status_code=400, detail="Message cannot be empty")

    def _do():
        with StorageContext() as ctx:
            for t in ctx.store.todos:
                if t.id == todo_id:
                    if not t.pending_followup:
                        return {"error": "not_queued"}
                    old_msg = t.pending_followup
                    t.pending_followup = new_msg
                    # Update the displayed message in run_output
                    if t.run_output:
                        # Compute image suffix from pending images
                        n_imgs = len(t.pending_followup_images)
                        old_suffix = f" [+{n_imgs} image{'s' if n_imgs != 1 else ''}]" if n_imgs else ""
                        old_line = f"\n\n--- Follow-up (queued) ---\n**You:** {old_msg}{old_suffix}\n"
                        new_line = f"\n\n--- Follow-up (queued) ---\n**You:** {new_msg}{old_suffix}\n"
                        t.run_output = t.run_output.replace(old_line, new_line)
                    return {"status": "updated"}
            return {"error": "not_found"}

    info = await run_in_thread(_do)
    if info.get("error") == "not_found":
        raise HTTPException(status_code=404, detail="Todo not found")
    if info.get("error") == "not_queued":
        raise HTTPException(status_code=409, detail="Follow-up is not queued or has already started")
    return info


@router.delete("/{todo_id}/followup")
async def cancel_followup(todo_id: str) -> dict:
    """Cancel a queued follow-up message."""
    if _DEMO_MODE:
        raise HTTPException(status_code=403, detail="Disabled in demo mode")

    err = cancel_pending_followup(todo_id)
    if err == "todo not found":
        raise HTTPException(status_code=404, detail="Todo not found")
    if err == "no pending followup":
        raise HTTPException(status_code=409, detail="No pending follow-up to cancel")
    return {"status": "cancelled"}


@router.post("/{todo_id}/followup")
async def followup_todo(todo_id: str, body: FollowupRequest) -> dict:
    """Send a follow-up message to a Claude session.

    If this todo is currently running, the follow-up is stored as a pending
    message and will auto-start when the current run finishes.
    If another todo in the same project is currently running, the follow-up
    is queued and will auto-start when the project becomes free.
    """
    if _DEMO_MODE:
        raise HTTPException(status_code=403, detail="Disabled in demo mode")

    def _do():
        with StorageContext() as ctx:
            todo = None
            source_path = None
            for t in ctx.store.todos:
                if t.id == todo_id:
                    todo = t
                    break
            if todo is None:
                return {"error": "not_found"}
            if todo.manual:
                return {"error": "manual"}
            if not todo.session_id:
                return {"error": "no_session"}

            img_suffix = f" [+{len(body.images)} image{'s' if len(body.images) != 1 else ''}]" if body.images else ""

            # If this todo is currently running, queue the follow-up to auto-start when it finishes
            if todo.run_status == "running" or process_manager.is_todo_running(todo_id):
                if todo.pending_followup:
                    return {"error": "followup_already_queued"}
                # Persist any new images on the todo
                if body.images:
                    new_attachments = [ImageAttachment(filename=f, source="followup") for f in body.images]
                    todo.images = list(todo.images) + new_attachments
                todo.pending_followup = body.message
                todo.pending_followup_images = list(body.images)
                todo.pending_followup_plan_only = body.plan_only
                return {"status": "queued"}

            session_id = todo.session_id

            for p in ctx.store.projects:
                if p.id == todo.project_id:
                    source_path = p.source_path
                    break
            if not source_path:
                return {"error": "no_source_path"}

            # Check if another todo in the same project is running.
            # Plan-only runs don't count — they can't edit files.
            project_busy = False
            for t in ctx.store.todos:
                if t.project_id == todo.project_id and t.id != todo_id and not t.plan_only and (is_todo_running(t.id) or t.run_status == "running"):
                    project_busy = True
                    break

            # Follow-up always moves the todo back to an active state
            todo.completed_at = None

            # Persist any new images on the todo
            if body.images:
                new_attachments = [ImageAttachment(filename=f, source="followup") for f in body.images]
                todo.images = list(todo.images) + new_attachments

            if project_busy:
                # Queue the follow-up; store the pending message so _process_queue can use it
                todo.status = "next"
                todo.run_status = "queued"
                todo.queued_at = _now()
                todo.pending_followup = body.message
                todo.pending_followup_images = list(body.images)
                todo.pending_followup_plan_only = body.plan_only
                # Immediately show the user's follow-up message in the output
                todo.run_output = (todo.run_output or "") + f"\n\n--- Follow-up (queued) ---\n**You:** {body.message}{img_suffix}\n"
                return {"status": "queued"}

            todo.run_status = "running"
            todo.status = "in_progress"
            # Immediately show the user's follow-up message in the output
            todo.run_output = (todo.run_output or "") + f"\n\n--- Follow-up ---\n**You:** {body.message}{img_suffix}\n"
            return {
                "status": "started",
                "session_id": session_id,
                "source_path": source_path,
                "proj_id": todo.project_id,
                "run_model": ctx.metadata.run_model,
                "followup_images": list(body.images),
                "plan_only": body.plan_only,
            }

    info = await run_in_thread(_do)
    if info.get("error") == "not_found":
        raise HTTPException(status_code=404, detail="Todo not found")
    if info.get("error") == "manual":
        raise HTTPException(status_code=400, detail="This is a manual task — it can only be completed by a human")
    if info.get("error") == "no_session":
        raise HTTPException(status_code=400, detail="No session to follow up on — run the todo first")
    if info.get("error") == "followup_already_queued":
        raise HTTPException(status_code=409, detail="A follow-up is already queued — wait for the current run to finish")
    if info.get("error") == "no_source_path":
        raise HTTPException(status_code=400, detail="Project has no source_path configured")

    if info["status"] == "queued":
        return {"status": "queued"}

    process_manager.spawn_thread(
        todo_id, _followup_claude_for_todo,
        (todo_id, body.message, info["session_id"], info["source_path"], info["run_model"], info["proj_id"], info["followup_images"], info.get("plan_only", False)),
    )
    return {"status": "started"}


class BtwRequest(BaseModel):
    message: str


@router.post("/{todo_id}/btw")
async def btw_todo(todo_id: str, body: BtwRequest) -> dict:
    """Send a /btw message as a concurrent side-channel Claude session.

    Spawns an independent parallel Claude call that runs alongside the main
    run. Output is stored separately in btw_output/btw_status fields and
    displayed in a tab UI next to the main run output.
    """
    if _DEMO_MODE:
        raise HTTPException(status_code=403, detail="Disabled in demo mode")

    if is_btw_running(todo_id):
        raise HTTPException(status_code=409, detail="A /btw session is already running — wait for it to finish")

    err = await run_in_thread(start_btw, todo_id, body.message)
    if err == "todo not found":
        raise HTTPException(status_code=404, detail="Todo not found")
    if err == "todo not running":
        raise HTTPException(status_code=409, detail="Todo is not currently running — use follow-up instead")
    if err == "no session":
        raise HTTPException(status_code=400, detail="No session to fork — the task hasn't started running yet")
    if err == "btw already running":
        raise HTTPException(status_code=409, detail="A /btw session is already running — wait for it to finish")
    if err == "no source_path":
        raise HTTPException(status_code=400, detail="Project has no source_path configured")
    if err:
        raise HTTPException(status_code=500, detail=err)

    return {"status": "started"}
