import { useState, useMemo, useRef, useCallback } from "react";
import type { Project, Todo } from "../types";
import { api } from "../api";
import { AddTodo } from "./AddTodo";
import { TodoItem } from "./TodoItem";
import { parseTags } from "../utils/tags";

interface Props {
  todos: Todo[];
  projects: Project[];
  selectedProjectId: string | null;
  projectSummaries: Record<string, string>;
  onRefresh: () => void;
  addToast: (text: string, type?: "info" | "warning" | "success" | "error") => void;
  onOptimisticUpdate: (fn: (todos: Todo[]) => Todo[]) => void;
  focusedTodoId?: string | null;
  editingTodoId?: string | null;
  addInputRef?: React.RefObject<HTMLTextAreaElement | null>;
  isOffline?: boolean;
}

export function TodoList({ todos, projects, selectedProjectId, projectSummaries, onRefresh, addToast, onOptimisticUpdate, focusedTodoId, editingTodoId, addInputRef, isOffline = false }: Props) {
  const [showUpNext, setShowUpNext] = useState(true);
  const [showBacklog, setShowBacklog] = useState(true);
  const [showDone, setShowDone] = useState(true);
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());

  // Drag-and-drop state
  const dragItemId = useRef<string | null>(null);
  const dragSection = useRef<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [dropPosition, setDropPosition] = useState<"above" | "below" | null>(null);

  // Track which projects have a running todo (for disabling the play button on siblings)
  const busyProjects = useMemo(() => {
    const set = new Set<string>();
    for (const t of todos) {
      if (t.run_status === "running") set.add(t.project_id);
    }
    return set;
  }, [todos]);

  const projectFiltered = selectedProjectId
    ? todos.filter((t) => t.project_id === selectedProjectId)
    : todos;

  // Collect all tags from visible todos for the filter bar
  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    for (const t of projectFiltered) {
      for (const tag of parseTags(t.text)) tagSet.add(tag);
    }
    return Array.from(tagSet).sort();
  }, [projectFiltered]);

  const toggleTag = useCallback((tag: string) => {
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  }, []);

  const clearTags = useCallback(() => setSelectedTags(new Set()), []);

  // Apply tag filter
  const filtered = useMemo(() => {
    if (selectedTags.size === 0) return projectFiltered;
    return projectFiltered.filter((t) => {
      const todoTags = parseTags(t.text);
      return Array.from(selectedTags).every((st) => todoTags.includes(st));
    });
  }, [projectFiltered, selectedTags]);

  // Sort helper: sort_order ascending, then created_at descending as tiebreaker
  const sortByOrder = (a: Todo, b: Todo) => {
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
    return b.created_at.localeCompare(a.created_at);
  };

  // Up Next: waiting (first), then in_progress, then next — within same status, by sort_order
  const upNextOrder = { waiting: 0, in_progress: 1, next: 2 } as const;
  const upNext = filtered
    .filter((t) => t.status === "waiting" || t.status === "in_progress" || t.status === "next")
    .sort((a, b) => {
      const oa = upNextOrder[a.status as keyof typeof upNextOrder] ?? 2;
      const ob = upNextOrder[b.status as keyof typeof upNextOrder] ?? 2;
      if (oa !== ob) return oa - ob;
      return sortByOrder(a, b);
    });

  // Backlog: consider, then stale, then rejected
  const backlogOrder = { consider: 0, stale: 1, rejected: 2 } as const;
  const backlog = filtered
    .filter((t) => t.status === "consider" || t.status === "stale" || t.status === "rejected")
    .sort((a, b) => {
      const oa = backlogOrder[a.status as keyof typeof backlogOrder] ?? 1;
      const ob = backlogOrder[b.status as keyof typeof backlogOrder] ?? 1;
      if (oa !== ob) return oa - ob;
      return sortByOrder(a, b);
    });

  // Completed: grouped by date
  const done = filtered
    .filter((t) => t.status === "completed")
    .sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""));

  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? "Unknown";

  const summary = selectedProjectId ? projectSummaries[selectedProjectId] : null;

  // Drag-and-drop handlers
  const handleDragStart = useCallback((todoId: string, section: string) => {
    dragItemId.current = todoId;
    dragSection.current = section;
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, todoId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    setDropTargetId(todoId);
    setDropPosition(e.clientY < midY ? "above" : "below");
  }, []);

  const handleDragLeave = useCallback(() => {
    setDropTargetId(null);
    setDropPosition(null);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, sectionItems: Todo[], section: string) => {
    e.preventDefault();
    setDropTargetId(null);
    setDropPosition(null);

    const dragId = dragItemId.current;
    const fromSection = dragSection.current;
    dragItemId.current = null;
    dragSection.current = null;

    if (!dragId || !dropTargetId || fromSection !== section) return;
    if (dragId === dropTargetId) return;

    // Build new order
    const ids = sectionItems.map((t) => t.id);
    const fromIdx = ids.indexOf(dragId);
    if (fromIdx === -1) return;

    // Remove dragged item
    ids.splice(fromIdx, 1);

    // Find target position
    let toIdx = ids.indexOf(dropTargetId);
    if (toIdx === -1) return;
    if (dropPosition === "below") toIdx += 1;

    // Insert at new position
    ids.splice(toIdx, 0, dragId);

    // Optimistic update: assign new sort_order values, pin only the moved item
    onOptimisticUpdate((allTodos) =>
      allTodos.map((t) => {
        const newIdx = ids.indexOf(t.id);
        if (newIdx !== -1) {
          return { ...t, sort_order: newIdx, ...(t.id === dragId ? { user_ordered: true } : {}) };
        }
        return t;
      })
    );

    // Persist to backend
    api.reorderTodos(ids, dragId).then(() => onRefresh()).catch(() => {
      addToast("Failed to reorder todos", "error");
      onRefresh();
    });
  }, [dropTargetId, dropPosition, onOptimisticUpdate, onRefresh, addToast]);

  const handleDragEnd = useCallback(() => {
    dragItemId.current = null;
    dragSection.current = null;
    setDropTargetId(null);
    setDropPosition(null);
  }, []);

  const renderTodoList = (items: Todo[], section: string) =>
    items.map((t) => (
      <div
        key={t.id}
        draggable={!isOffline}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", t.id);
          handleDragStart(t.id, section);
        }}
        onDragOver={(e) => handleDragOver(e, t.id)}
        onDragLeave={handleDragLeave}
        onDrop={(e) => handleDrop(e, items, section)}
        onDragEnd={handleDragEnd}
        className={`todo-drag-wrapper${dropTargetId === t.id && dragSection.current === section ? ` drop-${dropPosition}` : ""}`}
      >
        {!selectedProjectId && <span className="todo-project-label">{projectName(t.project_id)}</span>}
        <TodoItem todo={t} allTags={allTags} onRefresh={onRefresh} addToast={addToast} onOptimisticUpdate={onOptimisticUpdate} isFocused={focusedTodoId === t.id} triggerEdit={editingTodoId === t.id} projectBusy={busyProjects.has(t.project_id) && t.run_status !== "running"} disabled={isOffline} />
      </div>
    ));

  return (
    <div className="todo-list">
      <h2>{selectedProjectId ? projectName(selectedProjectId) : "All Projects"}</h2>
      {summary && <p className="project-summary">{summary}</p>}

      {selectedProjectId ? (
        <AddTodo projectId={selectedProjectId} allTags={allTags} onRefresh={onRefresh} addToast={addToast} onOptimisticUpdate={onOptimisticUpdate} inputRef={addInputRef} isOffline={isOffline} />
      ) : (
        <AddTodo projects={projects} allTags={allTags} onRefresh={onRefresh} addToast={addToast} onOptimisticUpdate={onOptimisticUpdate} inputRef={addInputRef} isOffline={isOffline} />
      )}

      {allTags.length > 0 && (
        <div className="tag-filter-bar">
          {allTags.map((tag) => (
            <button
              key={tag}
              className={`tag-filter-pill${selectedTags.has(tag) ? " active" : ""}`}
              onClick={() => toggleTag(tag)}
            >
              #{tag}
            </button>
          ))}
          {selectedTags.size > 0 && (
            <button className="tag-filter-clear" onClick={clearTags}>Clear</button>
          )}
        </div>
      )}

      {/* Up Next */}
      <button className="btn-link section-header" onClick={() => setShowUpNext(!showUpNext)}>
        {showUpNext ? "▾" : "▸"} Up Next ({upNext.length})
      </button>
      {showUpNext && (
        <>
          {upNext.length === 0 && backlog.length === 0 && done.length === 0 && (
            <div className="empty-state">
              <div className="empty-state-icon">📋</div>
              <p className="empty-state-title">No todos yet</p>
              <p className="empty-state-hint">
                {selectedProjectId
                  ? "Type a task above and press Enter to get started."
                  : projects.length === 0
                    ? "Create a project first, then add todos to it."
                    : "Select a project or type a task above to get started."}
              </p>
            </div>
          )}
          {renderTodoList(upNext, "upnext")}
        </>
      )}

      {/* Backlog */}
      {backlog.length > 0 && (
        <>
          <button className="btn-link section-header" onClick={() => setShowBacklog(!showBacklog)}>
            {showBacklog ? "▾" : "▸"} Backlog ({backlog.length})
          </button>
          {showBacklog && renderTodoList(backlog, "backlog")}
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
                    <TodoItem todo={t} allTags={allTags} onRefresh={onRefresh} addToast={addToast} onOptimisticUpdate={onOptimisticUpdate} isFocused={focusedTodoId === t.id} triggerEdit={editingTodoId === t.id} projectBusy={busyProjects.has(t.project_id) && t.run_status !== "running"} disabled={isOffline} />
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
