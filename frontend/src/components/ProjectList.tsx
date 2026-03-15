import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import type { Project, Todo } from "../types";
import { api } from "../api";
import { getDisplayName, setDisplayName } from "../utils/displayNames";

interface Props {
  projects: Project[];
  todos: Todo[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onRefresh: () => void;
}

interface ProjectCounts {
  total: number;
  inProgress: number;
  waiting: number;
  running: number;
  next: number;
  unreadRuns: number;
}

export function ProjectList({ projects, todos, selectedId, onSelect, onRefresh }: Props) {
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  const commitRename = (projectId: string) => {
    const trimmed = renameValue.trim();
    if (trimmed) {
      setDisplayName(projectId, trimmed);
    }
    setRenamingId(null);
    onRefresh(); // trigger re-render so display name updates everywhere
  };

  const countsByProject = useMemo(() => {
    const counts: Record<string, ProjectCounts> = {};
    for (const t of todos) {
      // Count unread runs across ALL todos (including completed)
      if (!t.is_read && (t.run_status === "done" || t.run_status === "error")) {
        if (!counts[t.project_id]) counts[t.project_id] = { total: 0, inProgress: 0, waiting: 0, running: 0, next: 0, unreadRuns: 0 };
        counts[t.project_id].unreadRuns++;
      }
      if (t.status === "completed" || t.status === "rejected") continue;
      if (!counts[t.project_id]) counts[t.project_id] = { total: 0, inProgress: 0, waiting: 0, running: 0, next: 0, unreadRuns: 0 };
      const c = counts[t.project_id];
      c.total++;
      if (t.status === "in_progress") c.inProgress++;
      if (t.status === "waiting") c.waiting++;
      if (t.run_status === "running") c.running++;
      if (t.status === "next") c.next++;
    }
    return counts;
  }, [todos]);

  // Map of project_id -> earliest run reset time (ms) for quota-blocked projects
  const quotaBlockedProjects = useMemo(() => {
    const blocked = new Map<string, number>();
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const p of projects) {
      if (p.todo_quota <= 0) continue;
      let runsInWindow = 0;
      let earliestRun = Infinity;
      for (const t of todos) {
        if (t.project_id === p.id && t.run_started_at && new Date(t.run_started_at).getTime() >= cutoff) {
          runsInWindow++;
          const runTime = new Date(t.run_started_at).getTime();
          if (runTime < earliestRun) earliestRun = runTime;
        }
      }
      if (runsInWindow >= p.todo_quota) {
        blocked.set(p.id, earliestRun + 24 * 60 * 60 * 1000);
      }
    }
    return blocked;
  }, [projects, todos]);

  // Live countdown for sidebar tooltips — updates every minute
  const [, setTick] = useState(0);
  useEffect(() => {
    if (quotaBlockedProjects.size === 0) return;
    const id = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, [quotaBlockedProjects.size]);

  const formatCountdown = useCallback((resetMs: number) => {
    const remaining = resetMs - Date.now();
    if (remaining <= 0) return "now";
    const h = Math.floor(remaining / 3_600_000);
    const m = Math.ceil((remaining % 3_600_000) / 60_000);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }, []);

  const globalCounts = useMemo(() => {
    let next = 0;
    let unreadRuns = 0;
    for (const t of todos) {
      // Unread runs count across all statuses
      if (!t.is_read && (t.run_status === "done" || t.run_status === "error")) unreadRuns++;
      if (t.status === "completed" || t.status === "rejected") continue;
      if (t.status === "next") next++;
    }
    return { next, unreadRuns };
  }, [todos]);

  const handleAdd = async () => {
    if (!name.trim()) return;
    await api.createProject(name.trim());
    setName("");
    setAdding(false);
    onRefresh();
  };

  const handleDeleteClick = (id: string, projectName: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete({ id, name: projectName });
  };

  const handleDeleteConfirm = async () => {
    if (!confirmDelete) return;
    await api.deleteProject(confirmDelete.id);
    if (selectedId === confirmDelete.id) onSelect(null);
    setConfirmDelete(null);
    onRefresh();
  };

  return (
    <div className="project-list">
      <div className="section-header">
        <h2>Projects</h2>
        <button className="btn-icon" onClick={() => setAdding(!adding)} title="Add project">+</button>
      </div>
      {adding && (
        <div className="add-form">
          <input
            autoFocus
            placeholder="Project name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          />
          <button onClick={handleAdd}>Add</button>
        </div>
      )}
      <div
        className={`project-item ${selectedId === null ? "active" : ""}`}
        onClick={() => onSelect(null)}
      >
        <span className="project-name">All Projects</span>
        {globalCounts.unreadRuns > 0 ? (
          <span className="project-count-badge badge-unread-runs" title={`${globalCounts.unreadRuns} unread run${globalCounts.unreadRuns !== 1 ? "s" : ""}`}>{globalCounts.unreadRuns}</span>
        ) : globalCounts.next > 0 ? (
          <span className="project-count-badge badge-up-next" title={`${globalCounts.next} up next`}>{globalCounts.next}</span>
        ) : null}
      </div>
      {projects.length === 0 && !adding && (
        <div className="empty-state empty-state-compact">
          <p className="empty-state-hint">No projects yet. Click + to create one.</p>
        </div>
      )}
      {projects.map((p) => {
        const c = countsByProject[p.id];
        const isQuotaBlocked = quotaBlockedProjects.has(p.id);
        const quotaResetMs = quotaBlockedProjects.get(p.id);
        return (
          <div
            key={p.id}
            className={`project-item ${selectedId === p.id ? "active" : ""} ${isQuotaBlocked ? "quota-blocked" : ""}`}
            onClick={() => onSelect(p.id)}
          >
            <span className="project-name">
              {isQuotaBlocked && <span className="project-indicator indicator-quota-blocked" title={`Daily run limit reached — next slot in ${formatCountdown(quotaResetMs!)}`}>⏸</span>}
              {renamingId === p.id ? (
                <input
                  ref={renameInputRef}
                  className="project-rename-input"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={() => commitRename(p.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename(p.id);
                    if (e.key === "Escape") setRenamingId(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setRenamingId(p.id);
                    setRenameValue(getDisplayName(p.id) ?? p.name);
                  }}
                  title="Double-click to rename"
                >
                  {getDisplayName(p.id) ?? p.name}
                </span>
              )}
              {c && c.running > 0 && <span className="project-indicator indicator-running" title={`${c.running} running`}>&#9679;</span>}
              {c && c.inProgress > 0 && !c.running && <span className="project-indicator indicator-in-progress" title={`${c.inProgress} in progress`}>&#9679;</span>}
              {c && c.waiting > 0 && <span className="project-indicator indicator-waiting" title={`${c.waiting} waiting`}>&#9679;</span>}
            </span>
            {c && c.unreadRuns > 0 ? (
              <span className="project-count-badge badge-unread-runs" title={`${c.unreadRuns} unread run${c.unreadRuns !== 1 ? "s" : ""}`}>{c.unreadRuns}</span>
            ) : c && c.next > 0 ? (
              <span className="project-count-badge badge-up-next" title={`${c.next} up next`}>{c.next}</span>
            ) : null}
            <select
              className={`autopilot-select ${p.auto_run_quota > 0 ? "autopilot-active" : ""}`}
              value={p.auto_run_quota}
              onClick={(e) => e.stopPropagation()}
              onChange={async (e) => {
                e.stopPropagation();
                await api.updateProject(p.id, { auto_run_quota: Number(e.target.value) });
                onRefresh();
              }}
              title={p.auto_run_quota > 0 ? `Autopilot: will auto-run ${p.auto_run_quota} todo(s) on next analysis, then stop` : "Autopilot off"}
            >
              <option value={0}>off</option>
              {(() => {
                const presets = [1, 2, 3, 5, 10, 20];
                const current = p.auto_run_quota;
                const all = current > 0 && !presets.includes(current) ? [...presets, current].sort((a, b) => a - b) : presets;
                return all.map((n) => (
                  <option key={n} value={n}>{n === current && current > 0 ? `🚀 ${n} left` : `🚀 ${n}`}</option>
                ));
              })()}
            </select>
            <button className="btn-icon btn-delete" onClick={(e) => handleDeleteClick(p.id, p.name, e)} title="Delete">&times;</button>
          </div>
        );
      })}
      {confirmDelete && (
        <div className="confirm-overlay" onClick={() => setConfirmDelete(null)}>
          <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
            <p>Delete project <strong>{confirmDelete.name}</strong>?</p>
            <p className="confirm-warning">This will delete all todos in this project.</p>
            <div className="confirm-actions">
              <button className="btn-cancel" onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button className="btn-danger" onClick={handleDeleteConfirm}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
