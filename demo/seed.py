#!/usr/bin/env python3
"""Generate realistic demo data for Claude Todos screenshots.

Usage: python3 demo/seed.py [output_dir]
Default output_dir: demo/data/
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta
from pathlib import Path


def _ts(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


NOW = datetime.utcnow()

# ── Projects ────────────────────────────────────────────────────

PROJECTS = [
    {
        "id": "proj_claude_todos",
        "name": "claude-todos",
        "source_path": "/home/user/projects/claude-todos",
        "auto_run_quota": 0,
        "created_at": _ts(NOW - timedelta(days=5)),
    },
    {
        "id": "proj_webthinker",
        "name": "web-researcher",
        "source_path": "/home/user/projects/web-researcher",
        "auto_run_quota": 0,
        "created_at": _ts(NOW - timedelta(days=5)),
    },
    {
        "id": "proj_bench",
        "name": "eval-bench",
        "source_path": "/home/user/projects/eval-bench",
        "auto_run_quota": 0,
        "created_at": _ts(NOW - timedelta(days=4)),
    },
]

# ── Todos ───────────────────────────────────────────────────────

TODOS = [
    # ── claude-todos: active work ──
    {
        "id": "todo_demo_01",
        "project_id": "proj_claude_todos",
        "text": "Add lifecycle hooks for real-time session state detection via Claude Code events #backend #hooks",
        "status": "completed",
        "source": "claude",
        "created_at": _ts(NOW - timedelta(days=3)),
        "completed_at": _ts(NOW - timedelta(days=2)),
    },
    {
        "id": "todo_demo_02",
        "project_id": "proj_claude_todos",
        "text": "Implement toast notifications with type-based styling (warning/success/error/info) #frontend #ui",
        "status": "completed",
        "source": "claude",
        "created_at": _ts(NOW - timedelta(days=2)),
        "completed_at": _ts(NOW - timedelta(days=1, hours=18)),
        "completed_by_run": True,
        "is_read": True,
        "session_id": "sess_demo_02",
        "run_output": "Implemented toast notification system with four visual styles:\n\n1. Added ToastContainer component with auto-dismiss timers\n2. Created useToast hook for easy integration\n3. Styled variants: success (green), error (red), warning (amber), info (blue)\n4. Animations: slide-in from top-right, fade-out on dismiss\n\nFiles modified:\n- frontend/src/components/Toast.tsx (new)\n- frontend/src/hooks/useToast.ts (new)\n- frontend/src/App.tsx (integrated ToastContainer)",
        "run_status": "done",
        "run_trigger": "autopilot",
    },
    {
        "id": "todo_demo_03",
        "project_id": "proj_claude_todos",
        "text": "Add \"Run with Claude\" button to execute todos as autonomous Claude Code tasks #backend #frontend",
        "status": "completed",
        "source": "user",
        "created_at": _ts(NOW - timedelta(days=2, hours=6)),
        "completed_at": _ts(NOW - timedelta(days=1, hours=12)),
        "completed_by_run": True,
        "is_read": True,
        "session_id": "sess_demo_03",
        "run_output": "Successfully implemented the Run with Claude feature:\n\n1. Added POST /api/todos/{id}/run endpoint\n2. Spawns `claude -p` subprocess in project directory\n3. Tracks run_status (running/done/error) and stores output\n4. Frontend shows play button, spinner while running, collapsible output\n\nFiles modified:\n- backend/routers/todos.py (new endpoint + background runner)\n- frontend/src/components/TodoItem.tsx (play button + output viewer)\n- backend/models.py (run_output, run_status fields)",
        "run_status": "done",
        "run_trigger": "manual",
    },
    {
        "id": "todo_demo_04",
        "project_id": "proj_claude_todos",
        "text": "Hook-triggered analysis: auto-analyze sessions when Claude Code events fire #backend #hooks",
        "status": "completed",
        "source": "claude",
        "created_at": _ts(NOW - timedelta(days=1, hours=6)),
        "completed_at": _ts(NOW - timedelta(hours=8)),
        "completed_by_run": True,
        "is_read": False,
        "session_id": "sess_demo_04",
        "run_output": "Implemented hook-triggered analysis pipeline:\n\n1. Added Claude Code lifecycle hook registration (on session start/stop)\n2. Hook endpoint POST /api/hooks/claude-event receives events\n3. Debounces rapid events (5s window) to avoid duplicate analyses\n4. Reuses existing analysis engine — same prompt, same model\n5. Added hook_analysis_enabled toggle to pause without unregistering\n\nKey design decision: hooks share the analysis lock with scheduled heartbeat\nto prevent concurrent analyses from conflicting.\n\nFiles modified:\n- backend/hooks.py (new — hook registration + event handler)\n- backend/scheduler.py (shared analysis lock)\n- backend/routers/settings.py (hook_analysis_enabled toggle)\n- install-hooks.sh (new — registers hooks with Claude Code CLI)",
        "run_status": "done",
        "run_trigger": "manual",
    },
    {
        "id": "todo_demo_05",
        "project_id": "proj_claude_todos",
        "text": "Add toggles to temporarily pause scheduled heartbeat and hook-triggered analysis #frontend #ui",
        "status": "completed",
        "source": "user",
        "created_at": _ts(NOW - timedelta(hours=6)),
        "completed_at": _ts(NOW - timedelta(hours=3)),
        "completed_by_run": True,
        "is_read": False,
        "session_id": "sess_demo_05",
        "run_output": "Added pause/resume toggles for both analysis triggers:\n\n1. Two toggle switches in the Settings sidebar section\n2. Heartbeat toggle: pauses the periodic scheduler timer\n3. Hook toggle: ignores incoming hook events without unregistering\n4. Visual state: green dot = active, gray = paused\n5. State persists across server restarts (saved in metadata.json)\n\nFiles modified:\n- frontend/src/components/Sidebar.tsx (toggle UI)\n- backend/routers/settings.py (PATCH endpoints)\n- backend/scheduler.py (check enabled flags before analysis)",
        "run_status": "done",
        "run_trigger": "autopilot",
    },
    {
        "id": "todo_demo_06",
        "project_id": "proj_claude_todos",
        "text": "Create demo environment for screenshots without interfering with real data",
        "status": "in_progress",
        "source": "user",
        "created_at": _ts(NOW - timedelta(hours=1)),
    },
    {
        "id": "todo_demo_07",
        "project_id": "proj_claude_todos",
        "text": "Add dark/light theme toggle #frontend #ui",
        "status": "next",
        "source": "user",
        "created_at": _ts(NOW - timedelta(hours=2)),
    },
    {
        "id": "todo_demo_08",
        "project_id": "proj_claude_todos",
        "text": "Consider: Add per-project analysis cost breakdown chart to the sidebar",
        "status": "consider",
        "source": "claude",
        "created_at": _ts(NOW - timedelta(days=1)),
    },
    {
        "id": "todo_demo_09",
        "project_id": "proj_claude_todos",
        "text": "Waiting on user to test hook notifications with multiple concurrent Claude sessions #hooks",
        "status": "waiting",
        "source": "claude",
        "created_at": _ts(NOW - timedelta(hours=4)),
    },

    # ── WebThinker: research project ──
    {
        "id": "todo_demo_20",
        "project_id": "proj_webthinker",
        "text": "Improved subagent timeline display with task preview and duration metrics",
        "status": "completed",
        "source": "claude",
        "created_at": _ts(NOW - timedelta(days=4)),
        "completed_at": _ts(NOW - timedelta(days=3, hours=20)),
    },
    {
        "id": "todo_demo_21",
        "project_id": "proj_webthinker",
        "text": "Added variable access tracking to execution analysis sidebar",
        "status": "completed",
        "source": "claude",
        "created_at": _ts(NOW - timedelta(days=4)),
        "completed_at": _ts(NOW - timedelta(days=3, hours=18)),
    },
    {
        "id": "todo_demo_22",
        "project_id": "proj_webthinker",
        "text": "Fixed event ordering bug in timeline builder #bugfix",
        "status": "completed",
        "source": "claude",
        "created_at": _ts(NOW - timedelta(days=3)),
        "completed_at": _ts(NOW - timedelta(days=2, hours=16)),
        "completed_by_run": True,
        "is_read": False,
        "session_id": "sess_demo_22",
        "run_output": "Fixed the event ordering bug in the timeline builder:\n\nRoot cause: Events were sorted by creation time instead of logical sequence\norder. When two events had the same timestamp (sub-millisecond precision),\ntheir relative order was non-deterministic.\n\nFix: Added a stable sort key combining (timestamp, sequence_number) where\nsequence_number is assigned at insertion time. Also added a regression test\nwith 50 concurrent events to verify ordering stability.\n\nFiles modified:\n- src/timeline/builder.py (stable sort key)\n- tests/test_timeline.py (regression test)",
        "run_status": "done",
        "run_trigger": "manual",
    },
    {
        "id": "todo_demo_23",
        "project_id": "proj_webthinker",
        "text": "Refactor trace storage to use self-similar directory structure #refactor",
        "status": "in_progress",
        "source": "claude",
        "session_id": "sess_abc123",
        "created_at": _ts(NOW - timedelta(hours=5)),
    },
    {
        "id": "todo_demo_24",
        "project_id": "proj_webthinker",
        "text": "Add citation validation with source provenance tracking #research",
        "status": "next",
        "source": "user",
        "created_at": _ts(NOW - timedelta(days=1)),
    },
    {
        "id": "todo_demo_25",
        "project_id": "proj_webthinker",
        "text": "Consider: Add cost estimator that warns before expensive operations",
        "status": "consider",
        "source": "claude",
        "created_at": _ts(NOW - timedelta(days=2)),
    },

    # ── deep-research-bench ──
    {
        "id": "todo_demo_30",
        "project_id": "proj_bench",
        "text": "Created Streamlit dashboard with leaderboard and comparison charts #frontend #analytics",
        "status": "completed",
        "source": "claude",
        "created_at": _ts(NOW - timedelta(days=4)),
        "completed_at": _ts(NOW - timedelta(days=3, hours=12)),
        "completed_by_run": True,
        "is_read": True,
        "session_id": "sess_demo_30",
        "run_output": "Built the Streamlit evaluation dashboard:\n\n1. Leaderboard table with sortable columns (model, accuracy, latency, cost)\n2. Side-by-side comparison charts (bar + radar)\n3. Per-category breakdown with drill-down\n4. Auto-refresh from evaluation results directory\n\nFiles modified:\n- dashboard/app.py (main Streamlit app)\n- dashboard/charts.py (Plotly chart builders)\n- dashboard/data_loader.py (results ingestion)",
        "run_status": "done",
        "run_trigger": "manual",
    },
    {
        "id": "todo_demo_31",
        "project_id": "proj_bench",
        "text": "Implemented data download and ingestion pipeline",
        "status": "completed",
        "source": "claude",
        "created_at": _ts(NOW - timedelta(days=4)),
        "completed_at": _ts(NOW - timedelta(days=3, hours=14)),
    },
    {
        "id": "todo_demo_32",
        "project_id": "proj_bench",
        "text": "Added correlation matrix across quality metrics",
        "status": "completed",
        "source": "claude",
        "created_at": _ts(NOW - timedelta(days=3)),
        "completed_at": _ts(NOW - timedelta(days=2, hours=20)),
    },
    {
        "id": "todo_demo_33",
        "project_id": "proj_bench",
        "text": "Add per-question difficulty analysis and failure mode clustering #analytics",
        "status": "next",
        "source": "claude",
        "created_at": _ts(NOW - timedelta(days=2)),
    },
    {
        "id": "todo_demo_34",
        "project_id": "proj_bench",
        "text": "Run full evaluation sweep on the citation subset",
        "status": "waiting",
        "source": "user",
        "created_at": _ts(NOW - timedelta(days=1)),
    },
]

# Fill in defaults for optional fields
for t in TODOS:
    t.setdefault("session_id", None)
    t.setdefault("completed_at", None)
    t.setdefault("run_output", None)
    t.setdefault("run_status", None)
    t.setdefault("run_trigger", None)
    t.setdefault("source", "claude")
    t.setdefault("completed_by_run", False)
    t.setdefault("is_read", True)
    t.setdefault("plan_only", False)

TODOS_JSON = {"projects": PROJECTS, "todos": TODOS}


# ── Analysis history ────────────────────────────────────────────

def _make_entry(
    ago_hours: float,
    duration: float,
    sessions: int,
    added: int,
    completed: int,
    modified: int,
    summary: str,
    model: str = "haiku",
    cost: float = 0.02,
    input_tok: int = 8000,
    output_tok: int = 3000,
) -> dict:
    ts = NOW - timedelta(hours=ago_hours)
    return {
        "timestamp": _ts(ts),
        "duration_seconds": duration,
        "sessions_analyzed": sessions,
        "todos_added": added,
        "todos_completed": completed,
        "todos_modified": modified,
        "summary": summary,
        "model": model,
        "cost_usd": cost,
        "input_tokens": input_tok,
        "output_tokens": output_tok,
        "cache_read_tokens": int(input_tok * 0.6),
        "error": None,
        "completed_todo_ids": [],
        "completed_todo_texts": [],
        "added_todos_active": [],
        "added_todos_completed": [],
        "modified_todos": [],
        "new_project_names": [],
        "insights": [],
        "prompt_length": input_tok + 5000,
        "prompt_text": "",
        "claude_response": "",
        "claude_reasoning": "",
    }


HISTORY = [
    _make_entry(1, 18.3, 2, 1, 0, 1,
                "Analyzed 2 sessions across 2 projects: +1 todos, 0 completed, 1 modified",
                cost=0.031, input_tok=9200, output_tok=3800),
    _make_entry(3, 25.1, 3, 2, 1, 0,
                "Analyzed 3 sessions across 2 projects: +2 todos, 1 completed, 0 modified",
                cost=0.042, input_tok=12400, output_tok=4100),
    _make_entry(6, 15.7, 1, 0, 2, 0,
                "Analyzed 1 sessions across 1 projects: +0 todos, 2 completed, 0 modified",
                cost=0.018, input_tok=6800, output_tok=2200),
    _make_entry(12, 32.4, 4, 3, 0, 2,
                "Analyzed 4 sessions across 3 projects: +3 todos, 0 completed, 2 modified",
                cost=0.055, input_tok=16000, output_tok=5200),
    _make_entry(24, 22.0, 2, 1, 1, 0,
                "Analyzed 2 sessions across 2 projects: +1 todos, 1 completed, 0 modified",
                cost=0.028, input_tok=8500, output_tok=3100),
    _make_entry(36, 45.2, 5, 4, 2, 1,
                "Analyzed 5 sessions across 3 projects: +4 todos, 2 completed, 1 modified",
                model="sonnet", cost=0.12, input_tok=22000, output_tok=7500),
    _make_entry(48, 19.6, 2, 2, 0, 0,
                "Analyzed 2 sessions across 1 projects: +2 todos, 0 completed, 0 modified",
                cost=0.025, input_tok=7800, output_tok=2900),
    _make_entry(72, 28.5, 3, 3, 1, 0,
                "Analyzed 3 sessions across 2 projects: +3 todos, 1 completed, 0 modified",
                cost=0.038, input_tok=11200, output_tok=3800),
]

INSIGHTS = [
    {
        "id": "ins_demo_01",
        "project_id": "proj_claude_todos",
        "text": "The claude-todos project has had 12 commits in the last 3 days, mostly around hooks and notifications. Consider writing tests before the next feature push.",
        "source_analysis_timestamp": HISTORY[1]["timestamp"],
        "dismissed": False,
        "created_at": HISTORY[1]["timestamp"],
    },
    {
        "id": "ins_demo_02",
        "project_id": "proj_webthinker",
        "text": "The trace storage refactor is a recurring theme across sessions. The self-similar directory structure may be worth documenting as an architecture decision.",
        "source_analysis_timestamp": HISTORY[3]["timestamp"],
        "dismissed": False,
        "created_at": HISTORY[3]["timestamp"],
    },
]

total_cost = sum(h["cost_usd"] for h in HISTORY)
total_input = sum(h["input_tokens"] for h in HISTORY)
total_output = sum(h["output_tokens"] for h in HISTORY)

METADATA = {
    "last_analysis": HISTORY[0],
    "history": HISTORY,
    "scheduler_status": "running",
    "heartbeat": _ts(NOW - timedelta(minutes=2)),
    "project_summaries": {
        "proj_claude_todos": "Building a dashboard that tracks Claude Code sessions and auto-generates todo lists via periodic analysis.",
        "proj_webthinker": "Research tool for autonomous web research with agent orchestration and document synthesis.",
        "proj_bench": "Evaluation framework with leaderboard, scoring, and quality metrics.",
    },
    "total_cost_usd": round(total_cost, 4),
    "total_input_tokens": total_input,
    "total_output_tokens": total_output,
    "total_analyses": len(HISTORY),
    "last_session_mtime": (NOW - timedelta(minutes=10)).timestamp(),
    "session_mtimes": {},
    "analysis_interval_minutes": 5,
    "analysis_model": "haiku",
    "run_model": "opus",
    "insights": INSIGHTS,
    "analysis_session_ids": [],
    "heartbeat_enabled": True,
    "hook_analysis_enabled": True,
}


# ── Write files ─────────────────────────────────────────────────

def main() -> None:
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / "data"
    out_dir.mkdir(parents=True, exist_ok=True)

    (out_dir / "todos.json").write_text(json.dumps(TODOS_JSON, indent=2))
    (out_dir / "metadata.json").write_text(json.dumps(METADATA, indent=2))
    # Empty hook states — no live sessions in demo
    (out_dir / "hook_states.json").write_text("{}")

    print(f"Demo data written to {out_dir}/")
    print(f"  {len(PROJECTS)} projects, {len(TODOS)} todos, {len(HISTORY)} analysis entries, {len(INSIGHTS)} insights")


if __name__ == "__main__":
    main()
