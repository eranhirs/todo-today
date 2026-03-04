from __future__ import annotations

import uuid
from datetime import datetime
from typing import Dict, List, Literal, Optional

from pydantic import BaseModel, Field


def _id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def _now() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


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
    completed: bool = False
    source: Literal["claude", "user"] = "user"
    created_at: str = Field(default_factory=_now)
    completed_at: Optional[str] = None


class TodoStore(BaseModel):
    projects: List[Project] = []
    todos: List[Todo] = []


# ── Metadata ───────────────────────────────────────────────────


class AnalysisEntry(BaseModel):
    timestamp: str = Field(default_factory=_now)
    duration_seconds: float = 0.0
    sessions_analyzed: int = 0
    todos_added: int = 0
    todos_completed: int = 0
    summary: str = ""
    cost_usd: float = 0.0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    error: Optional[str] = None
    completed_todo_ids: List[str] = []
    added_todos: List[str] = []
    new_project_names: List[str] = []
    suggestions: List[str] = []
    prompt_length: int = 0


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
    analysis_interval_minutes: int = 5


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


class TodoUpdate(BaseModel):
    text: Optional[str] = None
    completed: Optional[bool] = None
    project_id: Optional[str] = None


class FullState(BaseModel):
    projects: List[Project]
    todos: List[Todo]
    metadata: Metadata


# ── Claude analysis result (what Claude returns) ───────────────


class ClaudeNewTodo(BaseModel):
    project_id: str
    text: str


class ClaudeNewProject(BaseModel):
    name: str
    source_path: str


class ClaudeAnalysisResult(BaseModel):
    completed_todo_ids: List[str] = []
    new_todos: List[ClaudeNewTodo] = []
    project_summaries: Dict[str, str] = {}
    new_projects: List[ClaudeNewProject] = []
    suggestions: List[str] = []
