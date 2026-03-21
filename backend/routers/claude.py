from __future__ import annotations

from ..storage import run_in_thread
import json
import logging
from pathlib import Path
from typing import List, Optional

import httpx
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
async def sessions() -> list[dict]:
    def _do():
        all_sessions = list_all_sessions()
        with StorageContext(read_only=True) as ctx:
            mtimes = ctx.metadata.session_mtimes
        for s in all_sessions:
            s["last_analyzed_mtime"] = mtimes.get(s["key"])
        return all_sessions
    return await run_in_thread(_do)


@router.put("/model")
async def update_model(body: ModelUpdate) -> dict:
    def _do():
        with StorageContext() as ctx:
            ctx.metadata.analysis_model = body.model
    await run_in_thread(_do)
    return {"model": body.model}


@router.get("/settings")
async def get_settings() -> Settings:
    def _do():
        with StorageContext(read_only=True) as ctx:
            return ctx.metadata.get_settings()
    return await run_in_thread(_do)


@router.put("/settings")
async def update_settings(body: SettingsUpdate) -> Settings:
    """Update one or more settings fields. Only supplied fields are changed."""
    reschedule = body.analysis_interval_minutes is not None
    def _do():
        with StorageContext() as ctx:
            return ctx.metadata.apply_settings(body)
    new_settings = await run_in_thread(_do)
    if reschedule and body.analysis_interval_minutes is not None:
        set_interval(body.analysis_interval_minutes)
    return new_settings


@router.get("/status")
async def status() -> dict:
    def _do():
        with StorageContext(read_only=True) as ctx:
            return {
                "scheduler_status": ctx.metadata.scheduler_status,
                "heartbeat": ctx.metadata.heartbeat,
                "last_analysis": ctx.metadata.last_analysis.model_dump() if ctx.metadata.last_analysis else None,
            }
    return await run_in_thread(_do)


@router.put("/interval")
async def update_interval(body: IntervalUpdate) -> dict:
    set_interval(body.minutes)
    return {"minutes": body.minutes}


@router.get("/history")
async def history() -> list[AnalysisEntry]:
    def _do():
        with StorageContext(read_only=True) as ctx:
            return ctx.metadata.history
    return await run_in_thread(_do)


@router.put("/heartbeat/enabled")
async def set_heartbeat_enabled(body: dict) -> dict:
    enabled = body.get("enabled", True)
    def _do():
        with StorageContext() as ctx:
            ctx.metadata.heartbeat_enabled = enabled
    await run_in_thread(_do)
    return {"heartbeat_enabled": enabled}


@router.put("/hook-analysis/enabled")
async def set_hook_analysis_enabled(body: dict) -> dict:
    enabled = body.get("enabled", True)
    def _do():
        with StorageContext() as ctx:
            ctx.metadata.hook_analysis_enabled = enabled
    await run_in_thread(_do)
    return {"hook_analysis_enabled": enabled}



@router.put("/insights/{insight_id}/dismiss")
async def dismiss_insight(insight_id: str) -> dict:
    def _do():
        with StorageContext() as ctx:
            for insight in ctx.metadata.insights:
                if insight.id == insight_id:
                    insight.dismissed = True
                    return {"status": "ok"}
        return None
    result = await run_in_thread(_do)
    if result is None:
        raise HTTPException(status_code=404, detail="Insight not found")
    return result


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
        def _check():
            with StorageContext(read_only=True) as ctx:
                return session_id in set(ctx.metadata.analysis_session_ids)
        if await run_in_thread(_check):
            return {"status": "skipped", "message": "Analysis subprocess session"}
    await bus.emit_event(EventType.HOOK_SESSION_UPDATE, session_key=body.session_key)
    return await queue_hook_analysis(body.session_key)


@router.get("/hooks/events")
async def hooks_events() -> dict:
    """Return sessions in notifiable states, excluding analysis/run subprocesses."""
    def _do():
        with StorageContext(read_only=True) as ctx:
            exclude = set(ctx.metadata.analysis_session_ids)
        return get_actionable_sessions(exclude_session_ids=exclude)
    return await run_in_thread(_do)


@router.get("/hooks/log")
async def hooks_log(limit: int = 100) -> list:
    """Return recent hook events for debugging."""
    return await run_in_thread(load_event_log, min(limit, 500))


@router.get("/hooks/status")
async def hooks_status() -> dict:
    def _do():
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
    return await run_in_thread(_do)


@router.post("/hooks/install")
async def install_hooks() -> dict:
    def _do():
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
        # Hooks replace the heartbeat — disable it to avoid redundant analysis
        with StorageContext() as ctx:
            if ctx.metadata.heartbeat_enabled:
                ctx.metadata.heartbeat_enabled = False
                log.info("Auto-disabled heartbeat (hooks installed)")
        return {"status": "ok", "installed_events": installed}
    return await run_in_thread(_do)


@router.post("/hooks/uninstall")
async def uninstall_hooks() -> dict:
    def _do():
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
        # Re-enable heartbeat as fallback when hooks are removed
        with StorageContext() as ctx:
            if not ctx.metadata.heartbeat_enabled:
                ctx.metadata.heartbeat_enabled = True
                log.info("Auto-enabled heartbeat (hooks uninstalled)")
        return {"status": "ok", "removed_events": removed}
    return await run_in_thread(_do)


# ── Claude Code usage / rate limits ───────────────────────────
# WARNING: This endpoint calls a private Anthropic API (`/api/oauth/usage`)
# reverse-engineered from the Claude Code binary.  No public contract exists;
# any Claude Code update could silently change or remove this endpoint,
# breaking the usage widget without notice.

_CREDENTIALS_PATH = Path.home() / ".claude" / ".credentials.json"
_USAGE_API_URL = "https://api.anthropic.com/api/oauth/usage"
_OAUTH_BETA = "oauth-2025-04-20"


@router.get("/usage")
async def get_usage() -> dict:
    """Fetch Claude Code subscription usage (rate limits) from Anthropic API.

    Uses a private, undocumented endpoint discovered by inspecting the Claude
    Code binary.  May break without warning on CLI updates.
    """
    if not _CREDENTIALS_PATH.exists():
        return {"error": "No Claude credentials found"}
    try:
        with open(_CREDENTIALS_PATH) as f:
            creds = json.load(f)
        oauth = creds.get("claudeAiOauth", {})
        token = oauth.get("accessToken")
        if not token:
            return {"error": "No OAuth access token"}
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(
                _USAGE_API_URL,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                    "anthropic-beta": _OAUTH_BETA,
                },
            )
            if resp.status_code != 200:
                return {"error": f"API returned {resp.status_code}"}
            return resp.json()
    except Exception as e:
        log.warning("Failed to fetch Claude usage: %s", e)
        return {"error": str(e)}
