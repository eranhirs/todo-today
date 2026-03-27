from __future__ import annotations

from ..storage import run_in_thread

from fastapi import APIRouter, HTTPException

from ..event_bus import EventType, bus
from ..models import Project, ProjectCreate, ProjectUpdate
from ..storage import StorageContext

router = APIRouter(prefix="/api/projects", tags=["projects"])


@router.get("")
async def list_projects() -> list[Project]:
    def _do():
        with StorageContext(read_only=True) as ctx:
            return ctx.store.projects
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
                if p.id == project_id:
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
                if p.id == project_id:
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
                    bus.emit_event_sync(EventType.PROJECT_UPDATED, project_id=p.id)
                    return p
        return None
    result = await run_in_thread(_do)
    if result is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return result


@router.delete("/{project_id}", status_code=204)
async def delete_project(project_id: str) -> None:
    def _do():
        with StorageContext() as ctx:
            before = len(ctx.store.projects)
            ctx.store.projects = [p for p in ctx.store.projects if p.id != project_id]
            if len(ctx.store.projects) == before:
                return None
            # Collect image filenames from todos being deleted
            image_filenames = []
            remaining = []
            for t in ctx.store.todos:
                if t.project_id == project_id:
                    image_filenames.extend(img.filename for img in t.images)
                else:
                    remaining.append(t)
            ctx.store.todos = remaining
        return image_filenames
    result = await run_in_thread(_do)
    if result is None:
        raise HTTPException(status_code=404, detail="Project not found")
    # Delete associated image files outside the lock
    if result:
        from .todos import _get_image_dir
        image_dir = _get_image_dir()
        for fname in result:
            fp = image_dir / fname
            if fp.exists():
                fp.unlink(missing_ok=True)
    bus.emit_event_sync(EventType.PROJECT_DELETED, project_id=project_id)
