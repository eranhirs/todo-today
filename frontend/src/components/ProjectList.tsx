import { useState } from "react";
import type { Project } from "../types";
import { api } from "../api";

interface Props {
  projects: Project[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onRefresh: () => void;
}

export function ProjectList({ projects, selectedId, onSelect, onRefresh }: Props) {
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);

  const handleAdd = async () => {
    if (!name.trim()) return;
    await api.createProject(name.trim());
    setName("");
    setAdding(false);
    onRefresh();
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await api.deleteProject(id);
    if (selectedId === id) onSelect(null);
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
        All Projects
      </div>
      {projects.map((p) => (
        <div
          key={p.id}
          className={`project-item ${selectedId === p.id ? "active" : ""}`}
          onClick={() => onSelect(p.id)}
        >
          <span className="project-name">{p.name}</span>
          <select
            className="autopilot-select"
            value={p.auto_run_quota}
            onClick={(e) => e.stopPropagation()}
            onChange={async (e) => {
              e.stopPropagation();
              await api.updateProject(p.id, { auto_run_quota: Number(e.target.value) });
              onRefresh();
            }}
            title={p.auto_run_quota > 0 ? `Autopilot: ${p.auto_run_quota} todo(s) per cycle` : "Autopilot off"}
          >
            <option value={0}>off</option>
            {[1, 2, 3, 5].map((n) => (
              <option key={n} value={n}>🤖 {n}</option>
            ))}
          </select>
          <button className="btn-icon btn-delete" onClick={(e) => handleDelete(p.id, e)} title="Delete">×</button>
        </div>
      ))}
    </div>
  );
}
