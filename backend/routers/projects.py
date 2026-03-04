from fastapi import APIRouter, HTTPException

from ..models import Project, ProjectCreate, ProjectUpdate
from ..storage import StorageContext

router = APIRouter(prefix="/api/projects", tags=["projects"])


@router.get("")
def list_projects() -> list[Project]:
    with StorageContext() as ctx:
        return ctx.store.projects


@router.post("", status_code=201)
def create_project(body: ProjectCreate) -> Project:
    proj = Project(name=body.name, source_path=body.source_path)
    with StorageContext() as ctx:
        ctx.store.projects.append(proj)
    return proj


@router.get("/{project_id}")
def get_project(project_id: str) -> Project:
    with StorageContext() as ctx:
        for p in ctx.store.projects:
            if p.id == project_id:
                return p
    raise HTTPException(404, "Project not found")


@router.put("/{project_id}")
def update_project(project_id: str, body: ProjectUpdate) -> Project:
    with StorageContext() as ctx:
        for p in ctx.store.projects:
            if p.id == project_id:
                if body.name is not None:
                    p.name = body.name
                if body.source_path is not None:
                    p.source_path = body.source_path
                return p
    raise HTTPException(404, "Project not found")


@router.delete("/{project_id}", status_code=204)
def delete_project(project_id: str) -> None:
    with StorageContext() as ctx:
        before = len(ctx.store.projects)
        ctx.store.projects = [p for p in ctx.store.projects if p.id != project_id]
        if len(ctx.store.projects) == before:
            raise HTTPException(404, "Project not found")
        ctx.store.todos = [t for t in ctx.store.todos if t.project_id != project_id]
