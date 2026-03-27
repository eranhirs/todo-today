import { useCallback, useEffect, useMemo, useState } from "react";
import type { Project, Todo } from "../types";
import { api } from "../api";
import { apiErrorMessage } from "../errors";
import { TodoOutput } from "./TodoOutput";
import { useAppContext } from "../contexts/AppContext";

interface SkillDef {
  name: string;
  description: string;
  type: "command" | "skill";
}

interface Props {
  todos: Todo[];
  projects: Project[];
  selectedProjectId: string | null;
}

export function SkillList({ todos, projects, selectedProjectId }: Props) {
  const { addToast, onRefresh } = useAppContext();
  const [skills, setSkills] = useState<SkillDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [runningSkill, setRunningSkill] = useState<string | null>(null);

  // Fetch available skills/commands
  const fetchSkills = useCallback(async () => {
    try {
      const cmds = await api.getCommands(selectedProjectId ?? undefined);
      // Filter out /manual (noop command)
      setSkills(cmds.filter((c) => c.name !== "manual"));
    } catch (err) {
      console.error("Failed to fetch skills:", err);
    } finally {
      setLoading(false);
    }
  }, [selectedProjectId]);

  useEffect(() => {
    setLoading(true);
    fetchSkills();
  }, [fetchSkills]);

  // Skill run history: command todos, newest first
  const history = useMemo(() => {
    let filtered = todos.filter((t) => t.is_command);
    if (selectedProjectId) {
      filtered = filtered.filter((t) => t.project_id === selectedProjectId);
    }
    return [...filtered].sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
  }, [todos, selectedProjectId]);

  const projectMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of projects) m[p.id] = p.name;
    return m;
  }, [projects]);

  const runSkill = useCallback(async (skillName: string) => {
    if (!selectedProjectId) {
      addToast("Select a project first", "warning");
      return;
    }
    setRunningSkill(skillName);
    try {
      const todo = await api.createTodo(selectedProjectId, `/${skillName}`);
      onRefresh();
      await api.runTodo(todo.id);
      onRefresh();
      addToast(`Started /${skillName}`, "success");
    } catch (err) {
      addToast(apiErrorMessage(err), "error");
    } finally {
      setRunningSkill(null);
    }
  }, [selectedProjectId, onRefresh, addToast]);

  const formatTime = (iso: string) => {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return "just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return `${diffDay}d ago`;
    return d.toLocaleDateString();
  };

  const statusIcon = (t: Todo) => {
    if (t.run_status === "running") return "⟳";
    if (t.run_status === "queued") return "⏳";
    if (t.status === "completed") return "✓";
    if (t.run_status === "error") return "✗";
    if (t.run_status === "stopped") return "⏹";
    return "•";
  };

  const statusClass = (t: Todo) => {
    if (t.run_status === "running") return "skill-status-running";
    if (t.run_status === "queued") return "skill-status-queued";
    if (t.status === "completed") return "skill-status-done";
    if (t.run_status === "error") return "skill-status-error";
    if (t.run_status === "stopped") return "skill-status-stopped";
    return "";
  };

  return (
    <div className="skills-view">
      <section className="skills-available">
        <h2>Available Skills</h2>
        {loading ? (
          <div className="skills-loading">Loading skills...</div>
        ) : skills.length === 0 ? (
          <div className="skills-empty">
            No skills found{selectedProjectId ? " for this project" : ""}.
            <br />
            <span className="skills-hint">
              Add skills in <code>.claude/skills/</code> or commands in <code>.claude/commands/</code>
            </span>
          </div>
        ) : (
          <div className="skills-grid">
            {skills.map((s) => (
              <div key={s.name} className="skill-card">
                <div className="skill-card-header">
                  <span className="skill-name">/{s.name}</span>
                  <span className={`skill-type skill-type-${s.type}`}>{s.type}</span>
                </div>
                {s.description && <p className="skill-desc">{s.description}</p>}
                <button
                  className="skill-run-btn"
                  onClick={() => runSkill(s.name)}
                  disabled={runningSkill === s.name || !selectedProjectId}
                  title={!selectedProjectId ? "Select a project first" : `Run /${s.name}`}
                >
                  {runningSkill === s.name ? "Starting..." : "Run"}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="skills-history">
        <h2>Run History ({history.length})</h2>
        {history.length === 0 ? (
          <div className="skills-empty">No skill runs yet.</div>
        ) : (
          <div className="skills-history-list">
            {history.map((t) => (
              <div key={t.id} className="skill-history-item">
                <div
                  className="skill-history-header"
                  onClick={() => setExpandedRunId(expandedRunId === t.id ? null : t.id)}
                >
                  <span className={`skill-status-icon ${statusClass(t)}`}>
                    {statusIcon(t)}
                  </span>
                  <span className="skill-history-text">{t.text}</span>
                  <span className="skill-history-meta">
                    {!selectedProjectId && projectMap[t.project_id] && (
                      <span className="skill-history-project">{projectMap[t.project_id]}</span>
                    )}
                    <span className="skill-history-time">{formatTime(t.created_at)}</span>
                  </span>
                  <span className="skill-history-chevron">
                    {expandedRunId === t.id ? "▾" : "▸"}
                  </span>
                </div>
                {expandedRunId === t.id && (
                  <div className="skill-history-output">
                    {t.run_output ? (
                      <TodoOutput
                        todo={t}
                        showOutput={true}
                      />
                    ) : t.run_status === "running" ? (
                      <div className="skills-loading">Running...</div>
                    ) : (
                      <div className="skills-empty">No output</div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
