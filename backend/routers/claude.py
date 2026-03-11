from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..event_bus import EventType, bus
from ..session_discovery import list_all_sessions
from ..hook_state import get_actionable_sessions, load_event_log
from ..models import AnalysisEntry, Metadata, Settings, SettingsUpdate
from ..scheduler import queue_hook_analysis, set_interval, trigger_analysis
from ..storage import StorageContext

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/claude", tags=["claude"])


class IntervalUpdate(BaseModel):
    minutes: int = Field(ge=1, le=60)


class WakeRequest(BaseModel):
    model: Optional[str] = None
    force: bool = False
    session_keys: Optional[List[str]] = None


class ModelUpdate(BaseModel):
    model: str


@router.post("/wake")
async def wake(body: WakeRequest = WakeRequest()) -> dict:
    return await trigger_analysis(
        model=body.model, force=body.force, session_keys=body.session_keys,
    )


@router.get("/sessions")
def sessions() -> list[dict]:
    all_sessions = list_all_sessions()
    with StorageContext(read_only=True) as ctx:
        mtimes = ctx.metadata.session_mtimes
    for s in all_sessions:
        s["last_analyzed_mtime"] = mtimes.get(s["key"])
    return all_sessions


@router.put("/model")
def update_model(body: ModelUpdate) -> dict:
    with StorageContext() as ctx:
        ctx.metadata.analysis_model = body.model
    return {"model": body.model}


@router.get("/settings")
def get_settings() -> Settings:
    with StorageContext(read_only=True) as ctx:
        return ctx.metadata.get_settings()


@router.put("/settings")
def update_settings(body: SettingsUpdate) -> Settings:
    """Update one or more settings fields. Only supplied fields are changed."""
    reschedule = body.analysis_interval_minutes is not None
    with StorageContext() as ctx:
        new_settings = ctx.metadata.apply_settings(body)
    if reschedule and body.analysis_interval_minutes is not None:
        set_interval(body.analysis_interval_minutes)
    return new_settings


@router.get("/status")
def status() -> dict:
    with StorageContext(read_only=True) as ctx:
        return {
            "scheduler_status": ctx.metadata.scheduler_status,
            "heartbeat": ctx.metadata.heartbeat,
            "last_analysis": ctx.metadata.last_analysis.model_dump() if ctx.metadata.last_analysis else None,
        }


@router.put("/interval")
def update_interval(body: IntervalUpdate) -> dict:
    set_interval(body.minutes)
    return {"minutes": body.minutes}


@router.get("/history")
def history() -> list[AnalysisEntry]:
    with StorageContext(read_only=True) as ctx:
        return ctx.metadata.history


@router.put("/heartbeat/enabled")
def set_heartbeat_enabled(body: dict) -> dict:
    enabled = body.get("enabled", True)
    with StorageContext() as ctx:
        ctx.metadata.heartbeat_enabled = enabled
    return {"heartbeat_enabled": enabled}


@router.put("/hook-analysis/enabled")
def set_hook_analysis_enabled(body: dict) -> dict:
    enabled = body.get("enabled", True)
    with StorageContext() as ctx:
        ctx.metadata.hook_analysis_enabled = enabled
    return {"hook_analysis_enabled": enabled}



@router.put("/insights/{insight_id}/dismiss")
def dismiss_insight(insight_id: str) -> dict:
    with StorageContext() as ctx:
        for insight in ctx.metadata.insights:
            if insight.id == insight_id:
                insight.dismissed = True
                return {"status": "ok"}
    raise HTTPException(status_code=404, detail="Insight not found")


# ── Hooks management ──────────────────────────────────────────

_SETTINGS_PATH = Path.home() / ".claude" / "settings.json"
_HOOK_SCRIPT = str((Path(__file__).resolve().parent.parent.parent / "hooks" / "claude-todos-hook.py"))
_HOOK_EVENTS = ["PermissionRequest", "Stop", "SessionStart", "SessionEnd"]


def _make_hook_entry() -> dict:
    return {
        "matcher": "",
        "hooks": [{
            "type": "command",
            "command": _HOOK_SCRIPT,
            "timeout": 5,
        }],
    }


def _is_our_hook(entry: dict) -> bool:
    """Check if a hook entry was installed by us (by matching the command path)."""
    hooks = entry.get("hooks", [])
    return any(h.get("command") == _HOOK_SCRIPT for h in hooks)


def _load_settings() -> dict:
    if not _SETTINGS_PATH.exists():
        return {}
    with open(_SETTINGS_PATH) as f:
        return json.load(f)


def _save_settings(settings: dict) -> None:
    _SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(_SETTINGS_PATH, "w") as f:
        json.dump(settings, f, indent=2)


class HookAnalyzeRequest(BaseModel):
    session_key: str


@router.post("/hooks/analyze")
async def hooks_analyze(body: HookAnalyzeRequest) -> dict:
    """Queue a session for analysis, triggered by a hook event."""
    # Skip analysis subprocess sessions — they contain our own prompts, not user work
    session_id = body.session_key.split("/")[-1] if "/" in body.session_key else ""
    if session_id:
        with StorageContext(read_only=True) as ctx:
            if session_id in set(ctx.metadata.analysis_session_ids):
                return {"status": "skipped", "message": "Analysis subprocess session"}
    await bus.emit_event(EventType.HOOK_SESSION_UPDATE, session_key=body.session_key)
    return await queue_hook_analysis(body.session_key)


@router.get("/hooks/events")
def hooks_events() -> dict:
    """Return sessions in notifiable states, excluding analysis/run subprocesses."""
    with StorageContext(read_only=True) as ctx:
        exclude = set(ctx.metadata.analysis_session_ids)
    return get_actionable_sessions(exclude_session_ids=exclude)


@router.get("/hooks/log")
def hooks_log(limit: int = 100) -> list:
    """Return recent hook events for debugging."""
    return load_event_log(limit=min(limit, 500))


@router.get("/hooks/status")
def hooks_status() -> dict:
    settings = _load_settings()
    hooks = settings.get("hooks", {})
    installed_events = []
    for event in _HOOK_EVENTS:
        entries = hooks.get(event, [])
        if any(_is_our_hook(e) for e in entries):
            installed_events.append(event)
    return {
        "installed": len(installed_events) == len(_HOOK_EVENTS),
        "installed_events": installed_events,
        "hook_script": _HOOK_SCRIPT,
    }


@router.post("/hooks/install")
def install_hooks() -> dict:
    settings = _load_settings()
    hooks = settings.setdefault("hooks", {})
    installed = []
    for event in _HOOK_EVENTS:
        entries = hooks.setdefault(event, [])
        if not any(_is_our_hook(e) for e in entries):
            entries.append(_make_hook_entry())
            installed.append(event)
    _save_settings(settings)
    log.info("Installed hooks for events: %s", installed or "(already installed)")
    return {"status": "ok", "installed_events": installed}


@router.post("/hooks/uninstall")
def uninstall_hooks() -> dict:
    settings = _load_settings()
    hooks = settings.get("hooks", {})
    removed = []
    for event in _HOOK_EVENTS:
        entries = hooks.get(event, [])
        before = len(entries)
        entries = [e for e in entries if not _is_our_hook(e)]
        if len(entries) < before:
            removed.append(event)
        if entries:
            hooks[event] = entries
        else:
            hooks.pop(event, None)
    if not hooks:
        settings.pop("hooks", None)
    _save_settings(settings)
    log.info("Uninstalled hooks for events: %s", removed or "(none found)")
    return {"status": "ok", "removed_events": removed}
