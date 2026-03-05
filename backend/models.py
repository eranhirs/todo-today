from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field, model_validator


def _id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def _now() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


TodoStatus = Literal["next", "in_progress", "completed", "consider", "waiting", "stale"]


# ── Stored models ──────────────────────────────────────────────


class Project(BaseModel):
    id: str = Field(default_factory=lambda: _id("proj"))
    name: str
    source_path: str = ""
    created_at: str = Field(default_factory=_now)


class Todo(BaseModel):
    id: str = Field(default_factory=lambda: _id("todo"))
    project_id: str
    text: str
    status: TodoStatus = "next"
    source: Literal["claude", "user"] = "user"
    created_at: str = Field(default_factory=_now)
    completed_at: Optional[str] = None

    @model_validator(mode="before")
    @classmethod
    def _migrate_completed(cls, data: Any) -> Any:
        if isinstance(data, dict) and "status" not in data:
            completed = data.pop("completed", False)
            data["status"] = "completed" if completed else "next"
        elif isinstance(data, dict) and "completed" in data:
            data.pop("completed", None)
        return data


class TodoStore(BaseModel):
    projects: List[Project] = []
    todos: List[Todo] = []


# ── Metadata ───────────────────────────────────────────────────


class Insight(BaseModel):
    id: str = Field(default_factory=lambda: _id("ins"))
    project_id: str = ""
    text: str
    source_analysis_timestamp: str = ""
    dismissed: bool = False
    created_at: str = Field(default_factory=_now)


class AnalysisEntry(BaseModel):
    timestamp: str = Field(default_factory=_now)
    duration_seconds: float = 0.0
    sessions_analyzed: int = 0
    todos_added: int = 0
    todos_completed: int = 0
    todos_modified: int = 0
    summary: str = ""
    model: str = ""
    cost_usd: float = 0.0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    error: Optional[str] = None
    completed_todo_ids: List[str] = []
    completed_todo_texts: List[str] = []
    added_todos_active: List[str] = []
    added_todos_completed: List[str] = []
    modified_todos: List[str] = []
    new_project_names: List[str] = []
    insights: List[str] = []
    prompt_length: int = 0
    prompt_text: str = ""
    claude_response: str = ""
    claude_reasoning: str = ""


class Metadata(BaseModel):
    last_analysis: Optional[AnalysisEntry] = None
    history: List[AnalysisEntry] = []
    scheduler_status: str = "running"
    heartbeat: str = Field(default_factory=_now)
    project_summaries: Dict[str, str] = {}
    total_cost_usd: float = 0.0
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    total_analyses: int = 0
    last_session_mtime: float = 0.0
    session_mtimes: Dict[str, float] = {}
    analysis_interval_minutes: int = 5
    analysis_model: str = "haiku"
    insights: List[Insight] = []


# ── API request/response helpers ───────────────────────────────


class ProjectCreate(BaseModel):
    name: str
    source_path: str = ""


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    source_path: Optional[str] = None


class TodoCreate(BaseModel):
    project_id: str
    text: str
    status: TodoStatus = "next"


class TodoUpdate(BaseModel):
    text: Optional[str] = None
    status: Optional[TodoStatus] = None
    project_id: Optional[str] = None
    source: Optional[Literal["claude", "user"]] = None


class FullState(BaseModel):
    projects: List[Project]
    todos: List[Todo]
    metadata: Metadata


# ── Claude analysis result (what Claude returns) ───────────────


class ClaudeNewTodo(BaseModel):
    project_id: str = ""
    text: str
    status: TodoStatus = "next"

    @model_validator(mode="before")
    @classmethod
    def _migrate_completed(cls, data: Any) -> Any:
        """Accept old `completed: bool` from Claude responses for backward compat."""
        if isinstance(data, dict) and "status" not in data:
            completed = data.pop("completed", False)
            data["status"] = "completed" if completed else "next"
        elif isinstance(data, dict) and "completed" in data:
            data.pop("completed", None)
        return data


class ClaudeNewProject(BaseModel):
    name: str
    source_path: str


class ClaudeInsight(BaseModel):
    project_id: str = ""
    text: str


class ClaudeTodoStatusUpdate(BaseModel):
    id: str
    status: TodoStatus


class ClaudeTodoUpdate(BaseModel):
    id: str
    text: Optional[str] = None
    project_id: Optional[str] = None
    status: Optional[TodoStatus] = None


class ClaudeAnalysisResult(BaseModel):
    completed_todo_ids: List[str] = []
    status_updates: List[ClaudeTodoStatusUpdate] = []
    new_todos: List[ClaudeNewTodo] = []
    modified_todos: List[ClaudeTodoUpdate] = []
    project_summaries: Dict[str, str] = {}
    new_projects: List[ClaudeNewProject] = []
    insights: List[ClaudeInsight] = []
