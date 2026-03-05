import { useState } from "react";
import type { Insight, Project, Todo } from "../types";
import { AddTodo } from "./AddTodo";
import { Insights } from "./Insights";
import { TodoItem } from "./TodoItem";

interface Props {
  todos: Todo[];
  projects: Project[];
  selectedProjectId: string | null;
  projectSummaries: Record<string, string>;
  insights: Insight[];
  onRefresh: () => void;
}

export function TodoList({ todos, projects, selectedProjectId, projectSummaries, insights, onRefresh }: Props) {
  const [showUpNext, setShowUpNext] = useState(true);
  const [showBacklog, setShowBacklog] = useState(true);
  const [showDone, setShowDone] = useState(true);

  const filtered = selectedProjectId
    ? todos.filter((t) => t.project_id === selectedProjectId)
    : todos;

  const filteredInsights = selectedProjectId
    ? insights.filter((i) => i.project_id === selectedProjectId || i.project_id === "")
    : insights;

  // Up Next: waiting (first), then in_progress, then next
  const upNextOrder = { waiting: 0, in_progress: 1, next: 2 } as const;
  const upNext = filtered
    .filter((t) => t.status === "waiting" || t.status === "in_progress" || t.status === "next")
    .sort((a, b) => {
      const oa = upNextOrder[a.status as keyof typeof upNextOrder] ?? 2;
      const ob = upNextOrder[b.status as keyof typeof upNextOrder] ?? 2;
      if (oa !== ob) return oa - ob;
      return b.created_at.localeCompare(a.created_at);
    });

  // Backlog: consider, then stale
  const backlog = filtered
    .filter((t) => t.status === "consider" || t.status === "stale")
    .sort((a, b) => {
      if (a.status === "consider" && b.status === "stale") return -1;
      if (a.status === "stale" && b.status === "consider") return 1;
      return b.created_at.localeCompare(a.created_at);
    });

  // Completed: grouped by date
  const done = filtered
    .filter((t) => t.status === "completed")
    .sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""));

  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? "Unknown";

  const summary = selectedProjectId ? projectSummaries[selectedProjectId] : null;

  const renderTodoList = (items: Todo[]) =>
    items.map((t) => (
      <div key={t.id}>
        {!selectedProjectId && <span className="todo-project-label">{projectName(t.project_id)}</span>}
        <TodoItem todo={t} onRefresh={onRefresh} />
      </div>
    ));

  return (
    <div className="todo-list">
      <h2>{selectedProjectId ? projectName(selectedProjectId) : "All Projects"}</h2>
      {summary && <p className="project-summary">{summary}</p>}

      <Insights insights={filteredInsights} onRefresh={onRefresh} />

      {selectedProjectId && <AddTodo projectId={selectedProjectId} onRefresh={onRefresh} />}

      {/* Up Next */}
      <button className="btn-link section-header" onClick={() => setShowUpNext(!showUpNext)}>
        {showUpNext ? "▾" : "▸"} Up Next ({upNext.length})
      </button>
      {showUpNext && (
        <>
          {upNext.length === 0 && backlog.length === 0 && done.length === 0 && (
            <p className="empty">No todos yet. {selectedProjectId ? "Add one above!" : "Select a project to add todos."}</p>
          )}
          {renderTodoList(upNext)}
        </>
      )}

      {/* Backlog */}
      {backlog.length > 0 && (
        <>
          <button className="btn-link section-header" onClick={() => setShowBacklog(!showBacklog)}>
            {showBacklog ? "▾" : "▸"} Backlog ({backlog.length})
          </button>
          {showBacklog && renderTodoList(backlog)}
        </>
      )}

      {/* Completed */}
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
