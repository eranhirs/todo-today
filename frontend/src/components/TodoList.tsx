import { useState } from "react";
import type { Project, Todo } from "../types";
import { AddTodo } from "./AddTodo";
import { TodoItem } from "./TodoItem";

interface Props {
  todos: Todo[];
  projects: Project[];
  selectedProjectId: string | null;
  projectSummaries: Record<string, string>;
  onRefresh: () => void;
}

export function TodoList({ todos, projects, selectedProjectId, projectSummaries, onRefresh }: Props) {
  const [showDone, setShowDone] = useState(false);

  const filtered = selectedProjectId
    ? todos.filter((t) => t.project_id === selectedProjectId)
    : todos;

  const active = filtered.filter((t) => !t.completed);
  const done = filtered.filter((t) => t.completed);

  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? "Unknown";

  const summary = selectedProjectId ? projectSummaries[selectedProjectId] : null;

  return (
    <div className="todo-list">
      <h2>{selectedProjectId ? projectName(selectedProjectId) : "All Projects"}</h2>
      {summary && <p className="project-summary">{summary}</p>}

      {selectedProjectId && <AddTodo projectId={selectedProjectId} onRefresh={onRefresh} />}

      {active.length === 0 && done.length === 0 && (
        <p className="empty">No todos yet. {selectedProjectId ? "Add one above!" : "Select a project to add todos."}</p>
      )}

      {active.map((t) => (
        <div key={t.id}>
          {!selectedProjectId && <span className="todo-project-label">{projectName(t.project_id)}</span>}
          <TodoItem todo={t} onRefresh={onRefresh} />
        </div>
      ))}

      {done.length > 0 && (
        <>
          <button className="btn-link" onClick={() => setShowDone(!showDone)}>
            {showDone ? "▾" : "▸"} Completed ({done.length})
          </button>
          {showDone && (() => {
            const groups = new Map<string, Todo[]>();
            for (const t of done) {
              const day = t.completed_at
                ? new Date(t.completed_at).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })
                : "Unknown";
              if (!groups.has(day)) groups.set(day, []);
              groups.get(day)!.push(t);
            }
            return Array.from(groups.entries()).map(([day, items]) => (
              <div key={day} className="done-group">
                <div className="done-group-header">{day}</div>
                {items.map((t) => (
                  <div key={t.id}>
                    {!selectedProjectId && <span className="todo-project-label">{projectName(t.project_id)}</span>}
                    <TodoItem todo={t} onRefresh={onRefresh} />
                  </div>
                ))}
              </div>
            ));
          })()}
        </>
      )}
    </div>
  );
}
