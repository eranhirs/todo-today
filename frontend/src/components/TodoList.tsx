import { useState, useMemo, useRef, useCallback, useEffect, type KeyboardEvent, type FormEvent } from "react";
import { isUnread, type Project, type Todo } from "../types";
import { api } from "../api";
import { AddTodo } from "./AddTodo";
import { TodoItem } from "./TodoItem";
import { parseTags } from "../utils/tags";
import { type CommandInfo } from "../utils/commands";
import { getDisplayName, setDisplayName } from "../utils/displayNames";
import { matchesTodo } from "../utils/todoSearch";

interface Props {
  todos: Todo[];
  projects: Project[];
  selectedProjectId: string | null;
  projectSummaries: Record<string, string>;
  onRefresh: () => void;
  addToast: (text: string, type?: "info" | "warning" | "success" | "error", options?: { onUndo?: () => void; duration?: number }) => void;
  onOptimisticUpdate: (fn: (todos: Todo[]) => Todo[]) => void;
  focusedTodoId?: string | null;
  editingTodoId?: string | null;
  addInputRef?: React.RefObject<HTMLTextAreaElement | null>;
  isOffline?: boolean;
  completedTotal?: number;
  hasMoreCompleted?: boolean;
  onLoadMoreCompleted?: (projectId?: string | null) => void;
  loadingMoreCompleted?: boolean;
}

export function TodoList({ todos, projects, selectedProjectId, projectSummaries, onRefresh, addToast, onOptimisticUpdate, focusedTodoId, editingTodoId, addInputRef, isOffline = false, completedTotal = 0, hasMoreCompleted = false, onLoadMoreCompleted, loadingMoreCompleted = false }: Props) {
  const [showUpNext, setShowUpNext] = useState(true);
  const [showBacklog, setShowBacklog] = useState(true);
  const [showDone, setShowDone] = useState(true);
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [excludedTags, setExcludedTags] = useState<Set<string>>(new Set());
  const [filterUnread, setFilterUnread] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Todo[] | null>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [filterCommands, setFilterCommands] = useState(false);
  const [allCommands, setAllCommands] = useState<CommandInfo[]>([]);
  const completedSentinelRef = useRef<HTMLDivElement>(null);
  // When unread filter is active and the user opens a todo's output (marking it read),
  // keep that todo visible until a different output is opened.
  const [stickyTodoId, setStickyTodoId] = useState<string | null>(null);

  // Project title rename state
  const [renamingTitle, setRenamingTitle] = useState(false);
  const [titleRenameValue, setTitleRenameValue] = useState("");
  const titleRenameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renamingTitle && titleRenameRef.current) {
      titleRenameRef.current.focus();
      titleRenameRef.current.select();
    }
  }, [renamingTitle]);

  // Fetch available commands/skills scoped to the selected project
  useEffect(() => {
    api.getCommands(selectedProjectId ?? undefined).then(setAllCommands).catch(() => {});
  }, [selectedProjectId]);

  const commitTitleRename = useCallback(() => {
    if (!selectedProjectId) return;
    const trimmed = titleRenameValue.trim();
    if (trimmed) {
      setDisplayName(selectedProjectId, trimmed);
      onRefresh();
    }
    setRenamingTitle(false);
  }, [selectedProjectId, titleRenameValue, onRefresh]);

  // Tag rename state
  const [renamingTag, setRenamingTag] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

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

  const toggleTag = useCallback((tag: string, exclude?: boolean) => {
    if (exclude) {
      // Alt+click: toggle exclusion (and remove from selected if present)
      setSelectedTags((prev) => { const next = new Set(prev); next.delete(tag); return next; });
      setExcludedTags((prev) => {
        const next = new Set(prev);
        if (next.has(tag)) next.delete(tag);
        else next.add(tag);
        return next;
      });
    } else {
      // Normal click: toggle selection (and remove from excluded if present)
      setExcludedTags((prev) => { const next = new Set(prev); next.delete(tag); return next; });
      setSelectedTags((prev) => {
        const next = new Set(prev);
        if (next.has(tag)) next.delete(tag);
        else next.add(tag);
        return next;
      });
    }
  }, []);

  const clearTags = useCallback(() => { setSelectedTags(new Set()); setExcludedTags(new Set()); }, []);

  const startRenameTag = useCallback((tag: string) => {
    setRenamingTag(tag);
    setRenameValue(tag);
  }, []);

  const commitRenameTag = useCallback(async () => {
    if (!renamingTag) return;
    const newTag = renameValue.trim().toLowerCase();
    if (!newTag || newTag === renamingTag) {
      setRenamingTag(null);
      return;
    }
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(newTag)) {
      addToast("Invalid tag format — must start with a letter and contain only letters, numbers, hyphens, or underscores", "error");
      setRenamingTag(null);
      return;
    }
    try {
      const result = await api.renameTag(renamingTag, newTag);
      // Update selected/excluded tags if the renamed tag was in either set
      setSelectedTags((prev) => {
        if (!prev.has(renamingTag)) return prev;
        const next = new Set(prev);
        next.delete(renamingTag);
        next.add(newTag);
        return next;
      });
      setExcludedTags((prev) => {
        if (!prev.has(renamingTag)) return prev;
        const next = new Set(prev);
        next.delete(renamingTag);
        next.add(newTag);
        return next;
      });
      addToast(`Renamed #${renamingTag} → #${newTag} (${result.updated} todo${result.updated === 1 ? "" : "s"})`, "success");
      onRefresh();
    } catch {
      addToast("Failed to rename tag", "error");
    }
    setRenamingTag(null);
  }, [renamingTag, renameValue, addToast, onRefresh]);

  const cancelRenameTag = useCallback(() => setRenamingTag(null), []);

  // Focus rename input when it appears
  useEffect(() => {
    if (renamingTag && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingTag]);

  // Backend search: debounce search queries to search ALL todos (including paginated completed)
  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    const q = searchQuery.trim();
    if (!q) {
      setSearchResults(null);
      return;
    }
    searchDebounceRef.current = setTimeout(async () => {
      try {
        const results = await api.searchTodos(q, selectedProjectId || undefined);
        setSearchResults(results);
      } catch {
        // Fall back to client-side filtering on error
        setSearchResults(null);
      }
    }, 300);
    return () => { if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current); };
  }, [searchQuery, selectedProjectId]);

  // Infinite scroll: observe sentinel at bottom of completed section
  useEffect(() => {
    if (!hasMoreCompleted || !onLoadMoreCompleted) return;
    const sentinel = completedSentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !loadingMoreCompleted) {
          onLoadMoreCompleted(selectedProjectId);
        }
      },
      { rootMargin: "200px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMoreCompleted, onLoadMoreCompleted, loadingMoreCompleted, selectedProjectId]);

  // Clear sticky todo when unread filter is turned off
  useEffect(() => {
    if (!filterUnread) setStickyTodoId(null);
  }, [filterUnread]);

  const handleOutputOpen = useCallback((todoId: string) => {
    if (filterUnread) setStickyTodoId(todoId);
  }, [filterUnread]);

  // Count unread todos
  const unreadCount = useMemo(() =>
    projectFiltered.filter(isUnread).length,
    [projectFiltered]
  );

  // Count command/skill todos
  const commandCount = useMemo(() =>
    projectFiltered.filter((t) => t.is_command).length,
    [projectFiltered]
  );

  // Apply search + tag + unread filters
  // When searching, use backend results (searches ALL todos including unpaginated completed)
  const filtered = useMemo(() => {
    let result: Todo[];
    if (searchQuery.trim() && searchResults !== null) {
      // Use backend search results — they already cover all completed todos
      result = searchResults;
      // Still apply project filter for safety (backend does it too, but just in case)
      if (selectedProjectId) {
        result = result.filter((t) => t.project_id === selectedProjectId);
      }
    } else {
      result = projectFiltered;
      if (searchQuery.trim()) {
        // Fallback: client-side search while backend is loading
        const q = searchQuery.trim();
        result = result.filter((t) => matchesTodo(t, q));
      }
    }
    if (selectedTags.size > 0) {
      result = result.filter((t) => {
        const todoTags = parseTags(t.text);
        return Array.from(selectedTags).every((st) => todoTags.includes(st));
      });
    }
    if (excludedTags.size > 0) {
      result = result.filter((t) => {
        const todoTags = parseTags(t.text);
        return Array.from(excludedTags).every((et) => !todoTags.includes(et));
      });
    }
    if (filterUnread) {
      result = result.filter((t) => isUnread(t) || t.id === stickyTodoId);
    }
    if (filterCommands) {
      result = result.filter((t) => t.is_command);
    }
    return result;
  }, [projectFiltered, searchQuery, searchResults, selectedProjectId, selectedTags, excludedTags, filterUnread, stickyTodoId, filterCommands]);

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

  const projectName = (id: string) => getDisplayName(id) ?? projects.find((p) => p.id === id)?.name ?? "Unknown";

  const summary = selectedProjectId ? projectSummaries[selectedProjectId] : null;

  // Compute quota info for the selected project
  const selectedProject = useMemo(() =>
    selectedProjectId ? projects.find((p) => p.id === selectedProjectId) ?? null : null,
    [selectedProjectId, projects]
  );
  const runsInWindow = useMemo(() => {
    if (!selectedProjectId) return 0;
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    return todos.filter(
      (t) => t.project_id === selectedProjectId && t.run_started_at && t.run_started_at >= cutoff
    ).length;
  }, [selectedProjectId, todos]);
  const atRunQuotaLimit = selectedProject ? selectedProject.todo_quota > 0 && runsInWindow >= selectedProject.todo_quota : false;

  // Compute when the next quota slot opens (earliest run in window + 24h)
  const nextQuotaResetMs = useMemo(() => {
    if (!selectedProjectId || !selectedProject || selectedProject.todo_quota <= 0) return null;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const runTimesInWindow = todos
      .filter((t) => t.project_id === selectedProjectId && t.run_started_at && new Date(t.run_started_at).getTime() >= cutoff)
      .map((t) => new Date(t.run_started_at!).getTime())
      .sort((a, b) => a - b);
    if (runTimesInWindow.length === 0) return null;
    // The earliest run ages out at its start time + 24h
    return runTimesInWindow[0] + 24 * 60 * 60 * 1000;
  }, [selectedProjectId, selectedProject, todos]);

  // Live countdown string that updates every minute
  const [quotaCountdown, setQuotaCountdown] = useState("");
  useEffect(() => {
    if (nextQuotaResetMs === null) { setQuotaCountdown(""); return; }
    const update = () => {
      const remaining = nextQuotaResetMs - Date.now();
      if (remaining <= 0) { setQuotaCountdown("now"); return; }
      const h = Math.floor(remaining / 3_600_000);
      const m = Math.ceil((remaining % 3_600_000) / 60_000);
      if (h > 0) setQuotaCountdown(`${h}h ${m}m`);
      else setQuotaCountdown(`${m}m`);
    };
    update();
    const id = setInterval(update, 60_000);
    return () => clearInterval(id);
  }, [nextQuotaResetMs]);

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
        <TodoItem todo={t} allTags={allTags} allTodos={projectFiltered} allCommands={allCommands} onRefresh={onRefresh} addToast={addToast} onOptimisticUpdate={onOptimisticUpdate} isFocused={focusedTodoId === t.id} triggerEdit={editingTodoId === t.id} projectBusy={busyProjects.has(t.project_id) && t.run_status !== "running"} atRunQuotaLimit={atRunQuotaLimit} quotaCountdown={quotaCountdown} disabled={isOffline} onOutputOpen={handleOutputOpen} />
      </div>
    ));

  return (
    <div className="todo-list">
      {selectedProjectId && renamingTitle ? (
        <h2>
          <input
            ref={titleRenameRef}
            className="project-title-rename-input"
            value={titleRenameValue}
            onChange={(e) => setTitleRenameValue(e.target.value)}
            onBlur={commitTitleRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitTitleRename();
              if (e.key === "Escape") setRenamingTitle(false);
            }}
          />
        </h2>
      ) : (
        <h2
          onDoubleClick={selectedProjectId ? () => {
            setRenamingTitle(true);
            setTitleRenameValue(projectName(selectedProjectId));
          } : undefined}
          title={selectedProjectId ? "Double-click to rename" : undefined}
          style={selectedProjectId ? { cursor: "default" } : undefined}
        >
          {selectedProjectId ? projectName(selectedProjectId) : "All Projects"}
        </h2>
      )}
      {selectedProject?.source_path && (
        <p className="project-source-path">{selectedProject.source_path}</p>
      )}
      {summary && <p className="project-summary">{summary}</p>}

      {selectedProject && (
        <div className="project-settings-bar">
          <label className="project-settings-item">
            <span className="project-settings-label">Daily run limit</span>
            <span
              className="help-tooltip"
              title={"Limits how many todos can be run (executed by Claude) within a 24-hour sliding window. " +
                "Todos can always be added freely. Follow-ups on already-run todos don't count against the limit. " +
                "Set to \"none\" for unlimited."}
            >?</span>
            <select
              className={`project-settings-select${selectedProject.todo_quota > 0 ? " quota-active" : ""}`}
              value={selectedProject.todo_quota}
              onChange={async (e) => {
                await api.updateProject(selectedProject.id, { todo_quota: Number(e.target.value) });
                onRefresh();
              }}
            >
              <option value={0}>none</option>
              {[1, 2, 3, 5, 10, 15, 20, 30, 50].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
            {selectedProject.todo_quota > 0 && (
              <span className={`quota-usage${atRunQuotaLimit ? " quota-full" : ""}`}>
                {runsInWindow}/{selectedProject.todo_quota}
                {atRunQuotaLimit && quotaCountdown && (
                  <span className="quota-countdown"> ({quotaCountdown})</span>
                )}
              </span>
            )}
          </label>
        </div>
      )}

      {selectedProjectId ? (
        <AddTodo projectId={selectedProjectId} allTags={allTags} allTodos={projectFiltered} allCommands={allCommands} onRefresh={onRefresh} addToast={addToast} onOptimisticUpdate={onOptimisticUpdate} inputRef={addInputRef} isOffline={isOffline} />
      ) : (
        <AddTodo projects={projects} allTags={allTags} allTodos={todos} allCommands={allCommands} onRefresh={onRefresh} addToast={addToast} onOptimisticUpdate={onOptimisticUpdate} inputRef={addInputRef} isOffline={isOffline} />
      )}

      <div className="search-bar">
        <input
          type="text"
          className="search-input"
          placeholder="Search todos…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") setSearchQuery(""); }}
        />
        {searchQuery && (
          <button className="search-clear" onClick={() => setSearchQuery("")} title="Clear search">×</button>
        )}
      </div>

      {(allTags.length > 0 || unreadCount > 0 || filterUnread || commandCount > 0 || filterCommands) && (
        <div className="tag-filter-bar">
          {(unreadCount > 0 || filterUnread) && (
            <button
              className={`tag-filter-pill unread-filter${filterUnread ? " active" : ""}`}
              onClick={() => setFilterUnread((v) => !v)}
            >
              ⚡ Unread ({unreadCount})
            </button>
          )}
          {(commandCount > 0 || filterCommands) && (
            <button
              className={`tag-filter-pill command-filter${filterCommands ? " active" : ""}`}
              onClick={() => setFilterCommands((v) => !v)}
            >
              / Commands ({commandCount})
            </button>
          )}
          {allTags.map((tag) =>
            renamingTag === tag ? (
              <form
                key={tag}
                className="tag-rename-form"
                onSubmit={(e: FormEvent) => { e.preventDefault(); commitRenameTag(); }}
              >
                <span className="tag-rename-hash">#</span>
                <input
                  ref={renameInputRef}
                  className="tag-rename-input"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={commitRenameTag}
                  onKeyDown={(e: KeyboardEvent) => { if (e.key === "Escape") cancelRenameTag(); }}
                />
              </form>
            ) : (
              <button
                key={tag}
                className={`tag-filter-pill${selectedTags.has(tag) ? " active" : ""}${excludedTags.has(tag) ? " excluded" : ""}`}
                onClick={(e) => toggleTag(tag, e.altKey)}
                onDoubleClick={(e) => { e.preventDefault(); startRenameTag(tag); }}
                title="Click to include, Alt+click to exclude"
              >
                {excludedTags.has(tag) ? "−" : "#"}{tag}
              </button>
            )
          )}
          {(selectedTags.size > 0 || excludedTags.size > 0 || filterUnread || filterCommands) && (
            <button className="tag-filter-clear" onClick={() => { clearTags(); setFilterUnread(false); setFilterCommands(false); }}>Clear</button>
          )}
        </div>
      )}

      {/* Up Next */}
      <div className="up-next-header-row">
        <button className="btn-link section-header" onClick={() => setShowUpNext(!showUpNext)}>
          {(showUpNext || searchQuery) ? "▾" : "▸"} Up Next ({upNext.length})
        </button>
        {selectedProject && (
          <label className="autopilot-inline" title={selectedProject.auto_run_quota > 0 ? `Autopilot: will auto-run ${selectedProject.auto_run_quota} todo(s) on next analysis, then stop` : "Autopilot off"}>
            <span className="autopilot-inline-label">🚀 Autopilot</span>
            <select
              className={`autopilot-inline-select${selectedProject.auto_run_quota > 0 ? " autopilot-active" : ""}`}
              value={selectedProject.auto_run_quota}
              onChange={async (e) => {
                await api.updateProject(selectedProject.id, { auto_run_quota: Number(e.target.value) });
                onRefresh();
              }}
            >
              <option value={0}>off</option>
              {(() => {
                const presets = [1, 2, 3, 5, 10, 20, 50];
                const current = selectedProject.auto_run_quota;
                const all = current > 0 && !presets.includes(current) ? [...presets, current].sort((a, b) => a - b) : presets;
                return all.map((n) => (
                  <option key={n} value={n}>{n === current && current > 0 ? `${n} left` : String(n)}</option>
                ));
              })()}
            </select>
          </label>
        )}
      </div>
      {(showUpNext || searchQuery) && (
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
            {(showBacklog || searchQuery) ? "▾" : "▸"} Backlog ({backlog.length})
          </button>
          {(showBacklog || searchQuery) && renderTodoList(backlog, "backlog")}
        </>
      )}

      {/* Completed */}
      {(done.length > 0 || completedTotal > 0) && (
        <>
          <button className="btn-link" onClick={() => setShowDone(!showDone)}>
            {(showDone || searchQuery) ? "▾" : "▸"} Completed ({searchQuery ? done.length : completedTotal || done.length})
          </button>
          {(showDone || searchQuery) && (() => {
            const groups = new Map<string, Todo[]>();
            for (const t of done) {
              const day = t.completed_at
                ? new Date(t.completed_at).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })
                : "Unknown";
              if (!groups.has(day)) groups.set(day, []);
              groups.get(day)!.push(t);
            }
            return (
              <>
                {Array.from(groups.entries()).map(([day, items]) => (
                  <div key={day} className="done-group">
                    <div className="done-group-header">{day}</div>
                    {items.map((t) => (
                      <div key={t.id}>
                        {!selectedProjectId && <span className="todo-project-label">{projectName(t.project_id)}</span>}
                        <TodoItem todo={t} allTags={allTags} allTodos={projectFiltered} allCommands={allCommands} onRefresh={onRefresh} addToast={addToast} onOptimisticUpdate={onOptimisticUpdate} isFocused={focusedTodoId === t.id} triggerEdit={editingTodoId === t.id} projectBusy={busyProjects.has(t.project_id) && t.run_status !== "running"} atRunQuotaLimit={atRunQuotaLimit} quotaCountdown={quotaCountdown} disabled={isOffline} onOutputOpen={handleOutputOpen} />
                      </div>
                    ))}
                  </div>
                ))}
                {!searchQuery && hasMoreCompleted && (
                  <div ref={completedSentinelRef} className="load-more-sentinel">
                    {loadingMoreCompleted ? (
                      <span className="load-more-text">Loading more…</span>
                    ) : (
                      <span className="load-more-text">Scroll for more</span>
                    )}
                  </div>
                )}
              </>
            );
          })()}
        </>
      )}
    </div>
  );
}
