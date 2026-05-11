from __future__ import annotations

from datetime import datetime

from ..storage import run_in_thread

from fastapi import APIRouter, HTTPException

from ..event_bus import EventType, bus
from ..image_storage import delete_image_files
from ..models import Project, ProjectCreate, ProjectUpdate, _now
from ..storage import StorageContext

router = APIRouter(prefix="/api/projects", tags=["projects"])


@router.get("")
async def list_projects() -> list[Project]:
    def _do():
        with StorageContext(read_only=True) as ctx:
            return [p for p in ctx.store.projects if not p.deleted_at]
    return await run_in_thread(_do)


@router.get("/trash")
async def list_trashed_projects() -> list[Project]:
    """List soft-deleted projects (the trash). Sorted newest-deleted first."""
    def _do():
        with StorageContext(read_only=True) as ctx:
            trashed = [p for p in ctx.store.projects if p.deleted_at]
        trashed.sort(key=lambda p: p.deleted_at or "", reverse=True)
        return trashed
    return await run_in_thread(_do)


@router.post("", status_code=201)
async def create_project(body: ProjectCreate) -> Project:
    proj = Project(name=body.name, source_path=body.source_path)
    def _do():
        with StorageContext() as ctx:
            ctx.store.projects.append(proj)
    await run_in_thread(_do)
    bus.emit_event_sync(EventType.PROJECT_CREATED, project_id=proj.id, name=proj.name)
    return proj


@router.get("/{project_id}")
async def get_project(project_id: str) -> Project:
    def _do():
        with StorageContext(read_only=True) as ctx:
            for p in ctx.store.projects:
                if p.id == project_id and not p.deleted_at:
                    return p
        return None
    result = await run_in_thread(_do)
    if result is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return result


@router.put("/{project_id}")
async def update_project(project_id: str, body: ProjectUpdate) -> Project:
    def _do():
        with StorageContext() as ctx:
            for p in ctx.store.projects:
                if p.id == project_id and not p.deleted_at:
                    if body.name is not None:
                        p.name = body.name
                    if body.source_path is not None:
                        p.source_path = body.source_path
                    if body.auto_run_quota is not None:
                        p.auto_run_quota = max(0, min(50, body.auto_run_quota))
                    if body.clear_scheduled_autopilot:
                        p.scheduled_auto_run_quota = 0
                        p.autopilot_starts_at = None
                    else:
                        if body.scheduled_auto_run_quota is not None:
                            p.scheduled_auto_run_quota = max(0, min(50, body.scheduled_auto_run_quota))
                        if body.autopilot_starts_at is not None:
                            p.autopilot_starts_at = body.autopilot_starts_at
                    if body.todo_quota is not None:
                        p.todo_quota = max(0, body.todo_quota)
                    if body.clear_run_model:
                        p.run_model = None
                    elif body.run_model is not None:
                        if body.run_model in ("opus", "sonnet", "haiku"):
                            p.run_model = body.run_model
                    if body.pinned is not None:
                        p.pinned = body.pinned
                    bus.emit_event_sync(EventType.PROJECT_UPDATED, project_id=p.id)
                    return p
        return None
    result = await run_in_thread(_do)
    if result is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return result


@router.delete("/{project_id}", status_code=204)
async def delete_project(project_id: str, permanent: bool = False) -> None:
    """Soft-delete a project (marks it as trashed, preserving todos for undo).

    With ``?permanent=true``, hard-deletes the project and its todos and purges
    associated images from disk. Permanent deletion bypasses the trash —
    intended for the trash UI's "delete forever" action.
    """
    if permanent:
        def _do_permanent():
            with StorageContext() as ctx:
                before = len(ctx.store.projects)
                ctx.store.projects = [p for p in ctx.store.projects if p.id != project_id]
                if len(ctx.store.projects) == before:
                    return None
                image_filenames = []
                remaining = []
                for t in ctx.store.todos:
                    if t.project_id == project_id:
                        image_filenames.extend(img.filename for img in t.images)
                    else:
                        remaining.append(t)
                ctx.store.todos = remaining
            return image_filenames
        result = await run_in_thread(_do_permanent)
        if result is None:
            raise HTTPException(status_code=404, detail="Project not found")
        delete_image_files(result)
        bus.emit_event_sync(EventType.PROJECT_DELETED, project_id=project_id, permanent=True)
        return

    # Soft delete: mark with deleted_at; keep all todos intact for undo.
    def _do_soft():
        with StorageContext() as ctx:
            for p in ctx.store.projects:
                if p.id == project_id:
                    if p.deleted_at:
                        return "already_deleted"
                    p.deleted_at = _now()
                    return "ok"
        return None
    result = await run_in_thread(_do_soft)
    if result is None:
        raise HTTPException(status_code=404, detail="Project not found")
    if result == "already_deleted":
        # Idempotent — return success without re-emitting events.
        return
    bus.emit_event_sync(EventType.PROJECT_DELETED, project_id=project_id, permanent=False)


@router.post("/{project_id}/restore")
async def restore_project(project_id: str) -> Project:
    """Restore a soft-deleted project. Returns 404 if not in trash."""
    def _do():
        with StorageContext() as ctx:
            for p in ctx.store.projects:
                if p.id == project_id:
                    if not p.deleted_at:
                        return "not_deleted"
                    p.deleted_at = None
                    return p
        return None
    result = await run_in_thread(_do)
    if result is None:
        raise HTTPException(status_code=404, detail="Project not found")
    if result == "not_deleted":
        raise HTTPException(status_code=400, detail="Project is not in trash")
    bus.emit_event_sync(EventType.PROJECT_UPDATED, project_id=project_id, restored=True)
    return result


def purge_old_trashed_projects(retention_days: int = 30) -> int:
    """Permanently remove soft-deleted projects whose ``deleted_at`` is older
    than ``retention_days`` days. Returns the number of projects purged.

    Called from the app lifespan startup so the trash doesn't grow unbounded.
    Image files for purged projects are also cleaned up.
    """
    cutoff = datetime.utcnow().timestamp() - retention_days * 86400
    purge_ids: list[str] = []
    image_filenames: list[str] = []
    with StorageContext() as ctx:
        keep_projects = []
        for p in ctx.store.projects:
            if p.deleted_at:
                try:
                    ts = datetime.fromisoformat(p.deleted_at.rstrip("Z")).timestamp()
                except ValueError:
                    ts = cutoff  # malformed — purge
                if ts <= cutoff:
                    purge_ids.append(p.id)
                    continue
            keep_projects.append(p)
        if not purge_ids:
            return 0
        ctx.store.projects = keep_projects
        purge_set = set(purge_ids)
        keep_todos = []
        for t in ctx.store.todos:
            if t.project_id in purge_set:
                image_filenames.extend(img.filename for img in t.images)
            else:
                keep_todos.append(t)
        ctx.store.todos = keep_todos
    delete_image_files(image_filenames)
    return len(purge_ids)
