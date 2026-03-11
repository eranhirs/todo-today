import { useState, useMemo } from "react";
import type { Project, Todo } from "../types";
import { api } from "../api";

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
}

export function ProjectList({ projects, todos, selectedId, onSelect, onRefresh }: Props) {
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);

  const countsByProject = useMemo(() => {
    const counts: Record<string, ProjectCounts> = {};
    for (const t of todos) {
      if (t.status === "completed" || t.status === "rejected") continue;
      if (!counts[t.project_id]) counts[t.project_id] = { total: 0, inProgress: 0, waiting: 0, running: 0 };
      const c = counts[t.project_id];
      c.total++;
      if (t.status === "in_progress") c.inProgress++;
      if (t.status === "waiting") c.waiting++;
      if (t.run_status === "running") c.running++;
    }
    return counts;
  }, [todos]);

  const totalActive = useMemo(() => todos.filter((t) => t.status !== "completed" && t.status !== "rejected").length, [todos]);

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
        {totalActive > 0 && <span className="project-count-badge">{totalActive}</span>}
      </div>
      {projects.length === 0 && !adding && (
        <div className="empty-state empty-state-compact">
          <p className="empty-state-hint">No projects yet. Click + to create one.</p>
        </div>
      )}
      {projects.map((p) => {
        const c = countsByProject[p.id];
        return (
          <div
            key={p.id}
            className={`project-item ${selectedId === p.id ? "active" : ""}`}
            onClick={() => onSelect(p.id)}
          >
            <span className="project-name">
              {p.name}
              {c && c.running > 0 && <span className="project-indicator indicator-running" title={`${c.running} running`}>&#9679;</span>}
              {c && c.inProgress > 0 && !c.running && <span className="project-indicator indicator-in-progress" title={`${c.inProgress} in progress`}>&#9679;</span>}
              {c && c.waiting > 0 && <span className="project-indicator indicator-waiting" title={`${c.waiting} waiting`}>&#9679;</span>}
            </span>
            {c && c.total > 0 && <span className="project-count-badge">{c.total}</span>}
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
