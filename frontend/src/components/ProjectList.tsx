import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { type Project, type Todo, PINNED_VIEW_ID } from "../types";
import { api } from "../api";
import { getDisplayName, setDisplayName } from "../utils/displayNames";

interface Props {
  projects: Project[];
  todos: Todo[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onRefresh: () => void;
  unreadCounts: Record<string, number>;
}

interface ProjectCounts {
  total: number;
  inProgress: number;
  waiting: number;
  running: number;
  next: number;
  unreadRuns: number;
}

const COLLAPSED_KEY = "projects-section-collapsed";

export function ProjectList({ projects, todos, selectedId, onSelect, onRefresh, unreadCounts }: Props) {
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(COLLAPSED_KEY) === "true"; } catch { return false; }
  });

  useEffect(() => {
    try { localStorage.setItem(COLLAPSED_KEY, String(collapsed)); } catch { /* ignore */ }
  }, [collapsed]);

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
      if (t.status === "completed" || t.status === "rejected") continue;
      if (!counts[t.project_id]) counts[t.project_id] = { total: 0, inProgress: 0, waiting: 0, running: 0, next: 0, unreadRuns: 0 };
      const c = counts[t.project_id];
      c.total++;
      if (t.status === "in_progress") c.inProgress++;
      if (t.status === "waiting") c.waiting++;
      if (t.run_status === "running") c.running++;
      if (t.status === "next") c.next++;
    }
    // Use backend-provided unread counts (covers ALL todos, not just loaded page)
    for (const [projectId, count] of Object.entries(unreadCounts)) {
      if (projectId === "_total") continue;
      if (!counts[projectId]) counts[projectId] = { total: 0, inProgress: 0, waiting: 0, running: 0, next: 0, unreadRuns: 0 };
      counts[projectId].unreadRuns = count;
    }
    return counts;
  }, [todos, unreadCounts]);

  // Map of project_id -> { resetMs, runsInWindow } for projects with a quota
  const quotaInfoByProject = useMemo(() => {
    const info = new Map<string, { runsInWindow: number; resetMs: number | null }>();
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
      info.set(p.id, {
        runsInWindow,
        resetMs: runsInWindow >= p.todo_quota && earliestRun !== Infinity ? earliestRun + 24 * 60 * 60 * 1000 : null,
      });
    }
    return info;
  }, [projects, todos]);

  // Derived: which projects are quota-blocked
  const quotaBlockedProjects = useMemo(() => {
    const blocked = new Map<string, number>();
    for (const [id, info] of quotaInfoByProject) {
      if (info.resetMs !== null) blocked.set(id, info.resetMs);
    }
    return blocked;
  }, [quotaInfoByProject]);

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
    for (const t of todos) {
      if (t.status === "completed" || t.status === "rejected") continue;
      if (t.status === "next") next++;
    }
    return { next, unreadRuns: unreadCounts["_total"] ?? 0 };
  }, [todos, unreadCounts]);

  const pinnedProjects = useMemo(() => projects.filter((p) => p.pinned), [projects]);
  const unpinnedProjects = useMemo(() => projects.filter((p) => !p.pinned), [projects]);

  const pinnedCounts = useMemo(() => {
    const pinnedIds = new Set(pinnedProjects.map((p) => p.id));
    let next = 0;
    let unreadRuns = 0;
    for (const t of todos) {
      if (!pinnedIds.has(t.project_id)) continue;
      if (t.status === "completed" || t.status === "rejected") continue;
      if (t.status === "next") next++;
    }
    for (const [projectId, count] of Object.entries(unreadCounts)) {
      if (projectId === "_total") continue;
      if (pinnedIds.has(projectId)) unreadRuns += count;
    }
    return { next, unreadRuns };
  }, [pinnedProjects, todos, unreadCounts]);

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

  const handleTogglePin = async (e: React.MouseEvent, p: Project) => {
    e.stopPropagation();
    await api.updateProject(p.id, { pinned: !p.pinned });
    onRefresh();
  };

  const renderProjectItem = (p: Project) => {
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
          {isQuotaBlocked && (
            <span className="project-indicator indicator-quota-blocked" title={`Daily run limit reached — next slot in ${formatCountdown(quotaResetMs!)}`}>
              ⏸ <span className="quota-countdown-inline">{formatCountdown(quotaResetMs!)}</span>
            </span>
          )}
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
        {(() => {
          const qi = quotaInfoByProject.get(p.id);
          if (qi && p.todo_quota > 0) {
            const atLimit = qi.resetMs !== null;
            return (
              <span className={`sidebar-quota-usage${atLimit ? " quota-full" : ""}`} title={`${qi.runsInWindow}/${p.todo_quota} daily runs used`}>
                {qi.runsInWindow}/{p.todo_quota}
              </span>
            );
          }
          return null;
        })()}
        {c && c.unreadRuns > 0 ? (
          <span className="project-count-badge badge-unread-runs" title={`${c.unreadRuns} unread run${c.unreadRuns !== 1 ? "s" : ""}`}>{c.unreadRuns}</span>
        ) : c && c.next > 0 ? (
          <span className="project-count-badge badge-up-next" title={`${c.next} up next`}>{c.next}</span>
        ) : null}
        <button
          className={`btn-icon btn-pin${p.pinned ? " pinned" : ""}`}
          onClick={(e) => handleTogglePin(e, p)}
          title={p.pinned ? "Unpin project" : "Pin project"}
          aria-label={p.pinned ? "Unpin project" : "Pin project"}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1 0 .707c-.48.48-1.072.588-1.503.588-.177 0-.335-.018-.46-.039l-3.134 3.134a5.9 5.9 0 0 1 .16 1.013c.046.702-.032 1.687-.72 2.375a.5.5 0 0 1-.707 0l-2.829-2.828-3.182 3.182c-.195.195-1.219.902-1.414.707-.195-.195.512-1.22.707-1.414l3.182-3.182-2.828-2.829a.5.5 0 0 1 0-.707c.688-.688 1.673-.767 2.375-.72a5.9 5.9 0 0 1 1.013.16l3.134-3.133a2.8 2.8 0 0 1-.04-.461c0-.43.108-1.022.589-1.503a.5.5 0 0 1 .353-.146z"/>
          </svg>
        </button>
        <button className="btn-icon btn-delete" onClick={(e) => handleDeleteClick(p.id, p.name, e)} title="Delete">&times;</button>
      </div>
    );
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
      {projects.length === 0 && !adding && (
        <div className="empty-state empty-state-compact">
          <p className="empty-state-hint">No projects yet. Click + to create one.</p>
        </div>
      )}
      {pinnedProjects.length > 0 && (
        <>
          <div className="project-section-header project-section-header-static">
            <span className="project-section-title">Pinned</span>
          </div>
          <div
            className={`project-item ${selectedId === PINNED_VIEW_ID ? "active" : ""}`}
            onClick={() => onSelect(PINNED_VIEW_ID)}
          >
            <span className="project-name">All Pinned Projects</span>
            {pinnedCounts.unreadRuns > 0 ? (
              <span className="project-count-badge badge-unread-runs" title={`${pinnedCounts.unreadRuns} unread run${pinnedCounts.unreadRuns !== 1 ? "s" : ""}`}>{pinnedCounts.unreadRuns}</span>
            ) : pinnedCounts.next > 0 ? (
              <span className="project-count-badge badge-up-next" title={`${pinnedCounts.next} up next`}>{pinnedCounts.next}</span>
            ) : null}
          </div>
          {pinnedProjects.map(renderProjectItem)}
        </>
      )}
      {(unpinnedProjects.length > 0 || projects.length > 0) && (
        <>
          <button
            className="project-section-header project-section-header-toggle"
            onClick={() => setCollapsed((v) => !v)}
            aria-expanded={!collapsed}
            title={collapsed ? "Expand projects" : "Collapse projects"}
          >
            <span className="project-section-caret">{collapsed ? "▸" : "▾"}</span>
            <span className="project-section-title">All ({unpinnedProjects.length})</span>
          </button>
          {!collapsed && (
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
          )}
          {collapsed
            ? unpinnedProjects.filter((p) => p.id === selectedId).map(renderProjectItem)
            : unpinnedProjects.map(renderProjectItem)}
        </>
      )}
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
