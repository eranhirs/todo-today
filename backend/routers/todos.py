from typing import Optional

from fastapi import APIRouter, HTTPException

from ..models import Todo, TodoCreate, TodoUpdate, _now
from ..storage import StorageContext

router = APIRouter(prefix="/api/todos", tags=["todos"])


@router.get("")
def list_todos(project_id: Optional[str] = None) -> list[Todo]:
    with StorageContext() as ctx:
        todos = ctx.store.todos
        if project_id:
            todos = [t for t in todos if t.project_id == project_id]
        return todos


@router.post("", status_code=201)
def create_todo(body: TodoCreate) -> Todo:
    todo = Todo(project_id=body.project_id, text=body.text, status=body.status, source="user")
    if todo.status == "completed":
        todo.completed_at = _now()
    with StorageContext() as ctx:
        if not any(p.id == body.project_id for p in ctx.store.projects):
            raise HTTPException(404, "Project not found")
        ctx.store.todos.append(todo)
    return todo


@router.get("/{todo_id}")
def get_todo(todo_id: str) -> Todo:
    with StorageContext() as ctx:
        for t in ctx.store.todos:
            if t.id == todo_id:
                return t
    raise HTTPException(404, "Todo not found")


@router.put("/{todo_id}")
def update_todo(todo_id: str, body: TodoUpdate) -> Todo:
    with StorageContext() as ctx:
        for t in ctx.store.todos:
            if t.id == todo_id:
                if body.text is not None:
                    t.text = body.text
                if body.project_id is not None:
                    t.project_id = body.project_id
                if body.status is not None:
                    was_completed = t.status == "completed"
                    t.status = body.status
                    if body.status == "completed" and not was_completed:
                        t.completed_at = _now()
                    elif body.status != "completed" and was_completed:
                        t.completed_at = None
                if body.source is not None:
                    t.source = body.source
                return t
    raise HTTPException(404, "Todo not found")


@router.delete("/{todo_id}", status_code=204)
def delete_todo(todo_id: str) -> None:
    with StorageContext() as ctx:
        before = len(ctx.store.todos)
        ctx.store.todos = [t for t in ctx.store.todos if t.id != todo_id]
        if len(ctx.store.todos) == before:
            raise HTTPException(404, "Todo not found")
