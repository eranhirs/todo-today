from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field, model_validator


def _id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def _now() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


TodoStatus = Literal["next", "in_progress", "completed", "consider", "waiting", "stale", "rejected"]


# ── Stored models ──────────────────────────────────────────────


class Project(BaseModel):
    id: str = Field(default_factory=lambda: _id("proj"))
    name: str
    source_path: str = ""
    auto_run_quota: int = 0  # 0 = autopilot disabled, 1+ = remaining todos to auto-run (decrements)
    todo_quota: int = 0  # 0 = unlimited, 1+ = max todo runs per 24h sliding window
    created_at: str = Field(default_factory=_now)


class Todo(BaseModel):
    id: str = Field(default_factory=lambda: _id("todo"))
    project_id: str
    text: str
    status: TodoStatus = "next"
    source: Literal["claude", "user"] = "user"
    completed_by_run: bool = False
    emoji: Optional[str] = None
    session_id: Optional[str] = None
    created_at: str = Field(default_factory=_now)
    completed_at: Optional[str] = None
    run_output: Optional[str] = None
    run_status: Optional[Literal["running", "done", "error", "stopped", "queued"]] = None
    run_trigger: Optional[Literal["manual", "autopilot"]] = None
    run_pid: Optional[int] = None
    run_output_file: Optional[str] = None
    queued_at: Optional[str] = None
    run_started_at: Optional[str] = None
    pending_followup: Optional[str] = None
    pending_btw: Optional[str] = None
    btw_output: Optional[str] = None
    btw_status: Optional[Literal["running", "done", "error"]] = None
    btw_pid: Optional[int] = None
    btw_output_file: Optional[str] = None
    is_read: bool = True  # Whether the user has seen the run output
    plan_only: bool = False  # When True, agent plans but cannot implement
    sort_order: int = 0
    user_ordered: bool = False
    stale_reason: Optional[str] = None
    rejected_at: Optional[str] = None

    @model_validator(mode="before")
    @classmethod
    def _migrate_completed(cls, data: Any) -> Any:
        if isinstance(data, dict) and "status" not in data:
            completed = data.pop("completed", False)
            data["status"] = "completed" if completed else "next"
        elif isinstance(data, dict) and "completed" in data:
            data.pop("completed", None)
        # Migrate legacy source="claude_run" to completed_by_run flag
        if isinstance(data, dict) and data.get("source") == "claude_run":
            data["source"] = "claude"
            data.setdefault("completed_by_run", True)
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
    trigger: str = ""  # "scheduled", "hook", "manual"
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


class Settings(BaseModel):
    """Centralized config: analysis interval, model selection, heartbeat & hook toggles."""
    analysis_interval_minutes: int = Field(default=30, ge=1, le=60)
    analysis_model: str = "haiku"
    run_model: str = "opus"
    heartbeat_enabled: bool = True
    hook_analysis_enabled: bool = True


class SettingsUpdate(BaseModel):
    """Partial update — only supplied fields are changed."""
    analysis_interval_minutes: Optional[int] = Field(default=None, ge=1, le=60)
    analysis_model: Optional[str] = None
    heartbeat_enabled: Optional[bool] = None
    hook_analysis_enabled: Optional[bool] = None


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
    analysis_interval_minutes: int = 30
    analysis_model: str = "haiku"
    run_model: str = "opus"
    insights: List[Insight] = []
    analysis_session_ids: List[str] = []
    heartbeat_enabled: bool = True
    hook_analysis_enabled: bool = True

    def get_settings(self) -> Settings:
        """Extract the settings subset from metadata."""
        return Settings(
            analysis_interval_minutes=self.analysis_interval_minutes,
            analysis_model=self.analysis_model,
            run_model=self.run_model,
            heartbeat_enabled=self.heartbeat_enabled,
            hook_analysis_enabled=self.hook_analysis_enabled,
        )

    def apply_settings(self, update: SettingsUpdate) -> Settings:
        """Apply a partial settings update and return the new settings."""
        if update.analysis_interval_minutes is not None:
            self.analysis_interval_minutes = update.analysis_interval_minutes
        if update.analysis_model is not None:
            self.analysis_model = update.analysis_model
        if update.heartbeat_enabled is not None:
            self.heartbeat_enabled = update.heartbeat_enabled
        if update.hook_analysis_enabled is not None:
            self.hook_analysis_enabled = update.hook_analysis_enabled
        return self.get_settings()


# ── API request/response helpers ───────────────────────────────


class ErrorResponse(BaseModel):
    """Consistent error response format used by all endpoints."""
    detail: str
    error_code: Optional[str] = None


class ProjectCreate(BaseModel):
    name: str
    source_path: str = ""


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    source_path: Optional[str] = None
    auto_run_quota: Optional[int] = None
    todo_quota: Optional[int] = None


class TodoCreate(BaseModel):
    project_id: str
    text: str
    status: TodoStatus = "next"
    plan_only: bool = False


class TodoUpdate(BaseModel):
    text: Optional[str] = None
    status: Optional[TodoStatus] = None
    project_id: Optional[str] = None
    source: Optional[Literal["claude", "user"]] = None
    stale_reason: Optional[str] = None
    user_ordered: Optional[bool] = None
    is_read: Optional[bool] = None


class TodoReorder(BaseModel):
    todo_ids: List[str]
    moved_id: Optional[str] = None


class FullState(BaseModel):
    projects: List[Project]
    todos: List[Todo]
    metadata: Metadata
    settings: Settings = Settings()
    analysis_locked: bool = False
    autopilot_running: bool = False


# ── Claude analysis result (what Claude returns) ───────────────


class ClaudeNewTodo(BaseModel):
    project_id: str = ""
    text: str
    status: TodoStatus = "next"
    session_id: Optional[str] = None

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
    reason: Optional[str] = None


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
    dismiss_insight_ids: List[str] = []
