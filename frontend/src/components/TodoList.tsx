import { useState, useMemo, useRef, useCallback, useEffect, type KeyboardEvent, type FormEvent } from "react";
import { isUnread, type AnalysisEntry, type Project, type Todo } from "../types";
import { api } from "../api";
import { AddTodo } from "./AddTodo";
import { TodoItem } from "./TodoItem";
import { parseTags, PRIORITY_INFO } from "../utils/tags";
import { type CommandInfo } from "../utils/commands";
import { getDisplayName, setDisplayName } from "../utils/displayNames";
import { getSectionExpanded, setSectionExpanded } from "../utils/sectionState";
import { buildReferencedByMap, matchesTodo } from "../utils/todoSearch";
import { useAppContext } from "../contexts/AppContext";

interface Props {
  todos: Todo[];
  projects: Project[];
  selectedProjectId: string | null;
  viewLabel?: string | null;
  projectsForAdd?: Project[];
  projectSummaries: Record<string, string>;
  focusedTodoId?: string | null;
  editingTodoId?: string | null;
  addInputRef?: React.RefObject<HTMLTextAreaElement | null>;
  completedTotal?: number;
  hasMoreCompleted?: boolean;
  onLoadMoreCompleted?: (projectId?: string | null) => void;
  loadingMoreCompleted?: boolean;
  unreadCounts?: Record<string, number>;
  globalRunModel?: string;
  sessionAutopilot?: Record<string, number>;
  analysisHistory?: AnalysisEntry[];
  onNavigateToTodo?: (todoId: string, projectId: string) => void;
  pendingScrollTodoId?: string | null;
  onPendingScrollHandled?: () => void;
  openedFromFocus?: boolean;
}

export function TodoList({ todos, projects, selectedProjectId, viewLabel, projectsForAdd, projectSummaries, focusedTodoId, editingTodoId, addInputRef, completedTotal = 0, hasMoreCompleted = false, onLoadMoreCompleted, loadingMoreCompleted = false, unreadCounts = {}, globalRunModel = "opus", sessionAutopilot = {}, analysisHistory = [], onNavigateToTodo, pendingScrollTodoId, onPendingScrollHandled, openedFromFocus = false }: Props) {
  const { addToast, onRefresh, onOptimisticUpdate, optimistic, isOffline } = useAppContext();
  // When the tab was opened by a parent-jump fallback (?focus=<id>), force every
  // section open on first render so the target todo is actually in the DOM,
  // regardless of the user's persisted collapse state.
  const [showActive, setShowActiveRaw] = useState(() => openedFromFocus ? true : getSectionExpanded("active", true));
  const [showUpNext, setShowUpNextRaw] = useState(() => openedFromFocus ? true : getSectionExpanded("upnext", true));
  const [showBacklog, setShowBacklogRaw] = useState(() => openedFromFocus ? true : getSectionExpanded("backlog", true));
  const [showDone, setShowDoneRaw] = useState(() => openedFromFocus ? true : getSectionExpanded("done", true));
  const setShowActive = (v: boolean) => { setShowActiveRaw(v); setSectionExpanded("active", v); };
  const setShowUpNext = (v: boolean) => { setShowUpNextRaw(v); setSectionExpanded("upnext", v); };
  const setShowBacklog = (v: boolean) => { setShowBacklogRaw(v); setSectionExpanded("backlog", v); };
  const setShowDone = (v: boolean) => { setShowDoneRaw(v); setSectionExpanded("done", v); };
  const [selectedTags, setSelectedTags] = useState<Set<string>>(() => {
    const p = new URLSearchParams(window.location.search).get("tags");
    return p ? new Set(p.split(",").filter(Boolean)) : new Set();
  });
  const [excludedTags, setExcludedTags] = useState<Set<string>>(() => {
    const p = new URLSearchParams(window.location.search).get("exclude");
    return p ? new Set(p.split(",").filter(Boolean)) : new Set();
  });
  const [filterUnread, setFilterUnread] = useState(() => {
    return new URLSearchParams(window.location.search).has("unread");
  });
  const [searchQuery, setSearchQuery] = useState(() => {
    return new URLSearchParams(window.location.search).get("search") ?? "";
  });
  const [searchResults, setSearchResults] = useState<Todo[] | null>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [filterCommands, setFilterCommands] = useState(() => {
    return new URLSearchParams(window.location.search).has("commands");
  });
  const [filterManual, setFilterManual] = useState(() => {
    return new URLSearchParams(window.location.search).has("manual");
  });
  const [selectedPriorities, setSelectedPriorities] = useState<Set<number>>(() => {
    const p = new URLSearchParams(window.location.search).get("priorities");
    return p ? new Set(p.split(",").map(Number).filter((n) => !isNaN(n))) : new Set();
  });
  const [allCommands, setAllCommands] = useState<CommandInfo[]>([]);
  const completedSentinelRef = useRef<HTMLDivElement>(null);
  // When unread filter is active and the user opens a todo's output (marking it read),
  // keep that todo visible until a different output is opened.
  const [stickyTodoId, setStickyTodoId] = useState<string | null>(null);

  // Autopilot optimistic update pending state
  const [autopilotPending, setAutopilotPending] = useState(false);

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

  // Keep todos accessible to the pending-scroll effect's fallback path without
  // making the effect re-run on every poll.
  const todosRef = useRef(todos);
  useEffect(() => { todosRef.current = todos; }, [todos]);

  // After project switch, scroll to the pending todo. If it's not in the DOM
  // after a few rAF retries, the target is hidden — usually by active filters,
  // sometimes by pagination (completed pages not loaded yet).
  //
  // Two recovery paths:
  // - In a normal tab: surface a toast with an "Open in new tab" action so the
  //   user opts in explicitly. Click-driven open avoids popup blockers and
  //   can't infinite-loop.
  // - In a focus-opened tab (`openedFromFocus`): fetch the todo by id, then
  //   drive the existing search bar with its text. The backend search scans
  //   every todo (incl. paginated-away completed) so this surfaces the target
  //   when nothing else does. We poll for the row to appear post-search, then
  //   scroll. The action-button fallback is suppressed in this mode so a
  //   focus-opened tab can't recursively spawn more tabs.
  useEffect(() => {
    if (!pendingScrollTodoId) return;
    const targetId = pendingScrollTodoId;
    let cancelled = false;
    let attempts = 0;
    const maxAttempts = 5;
    let recoveryStarted = false;

    const finish = (el: Element) => {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.remove("todo-highlight-flash");
      void (el as HTMLElement).offsetWidth;
      el.classList.add("todo-highlight-flash");
      setTimeout(() => el.classList.remove("todo-highlight-flash"), 2000);
      onPendingScrollHandled?.();
    };

    const pollForElement = () => {
      let polls = 0;
      const maxPolls = 25; // ~5s total at 200ms intervals
      const tick = () => {
        if (cancelled) return;
        const el = document.querySelector(`[data-todo-id="${targetId}"]`);
        if (el) { finish(el); return; }
        if (polls++ >= maxPolls) {
          addToast("Couldn't reach this todo", "warning");
          onPendingScrollHandled?.();
          return;
        }
        setTimeout(tick, 200);
      };
      // Initial wait covers search debounce (300ms) + network round trip
      setTimeout(tick, 500);
    };

    const startRecovery = () => {
      if (recoveryStarted) return;
      recoveryStarted = true;
      if (openedFromFocus) {
        // Drive the search bar with the todo's own text so the backend search
        // surfaces it even if it's paginated away from the loaded list.
        api.getTodo(targetId).then((todo) => {
          if (cancelled) return;
          setSearchQuery(todo.text);
          pollForElement();
        }).catch(() => {
          if (cancelled) return;
          addToast("Couldn't fetch this todo", "warning");
          onPendingScrollHandled?.();
        });
        return;
      }
      const target = todosRef.current.find((t) => t.id === targetId);
      if (!target) {
        onPendingScrollHandled?.();
        return;
      }
      addToast("Parent is hidden by your current filters", "info", {
        action: {
          label: "Open in new tab",
          handler: () => {
            const url = new URL(window.location.origin + window.location.pathname);
            url.searchParams.set("project", target.project_id);
            url.searchParams.set("focus", targetId);
            window.open(url.toString(), "_blank", "noopener");
          },
        },
      });
      onPendingScrollHandled?.();
    };

    const tryScroll = () => {
      if (cancelled) return;
      const el = document.querySelector(`[data-todo-id="${targetId}"]`);
      if (el) { finish(el); return; }
      if (attempts < maxAttempts) {
        attempts++;
        requestAnimationFrame(tryScroll);
        return;
      }
      startRecovery();
    };

    requestAnimationFrame(tryScroll);
    return () => { cancelled = true; };
  }, [pendingScrollTodoId, onPendingScrollHandled, addToast, openedFromFocus]);

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

  // Build session_id → todo lookup so children can find their parent todo
  const sessionToTodo = useMemo(() => {
    const map = new Map<string, Todo>();
    for (const t of todos) {
      if (t.session_id) map.set(t.session_id, t);
    }
    return map;
  }, [todos]);

  // Build id → todo lookup so manual parent_todo_id references can resolve
  const todoById = useMemo(() => {
    const map = new Map<string, Todo>();
    for (const t of todos) map.set(t.id, t);
    return map;
  }, [todos]);

  const resolveParent = useCallback((t: Todo): Todo | null => {
    if (t.parent_todo_id) return todoById.get(t.parent_todo_id) ?? null;
    if (t.source_session_id) return sessionToTodo.get(t.source_session_id) ?? null;
    return null;
  }, [todoById, sessionToTodo]);

  // Reverse map: referenced_todo_id → todos whose text contains @[...](referenced_todo_id).
  // Surfaces backlinks so a todo's metadata lists every other todo that mentions it.
  const referencedByMap = useMemo(() => buildReferencedByMap(todos), [todos]);
  const resolveReferencedBy = useCallback(
    (t: Todo): Todo[] => referencedByMap.get(t.id) ?? [],
    [referencedByMap]
  );

  const projectFiltered = selectedProjectId
    ? todos.filter((t) => t.project_id === selectedProjectId)
    : todos;

  // projectFiltered narrowed by the current search query. Used as the base for
  // every filter-bar facet so chip counts and tag pills update as the user types.
  const searchBase = useMemo(() => {
    const q = searchQuery.trim();
    if (!q) return projectFiltered;
    if (searchResults !== null) {
      return selectedProjectId
        ? searchResults.filter((t) => t.project_id === selectedProjectId)
        : searchResults;
    }
    return projectFiltered.filter((t) => matchesTodo(t, q));
  }, [projectFiltered, searchQuery, searchResults, selectedProjectId]);

  // Apply every active filter except the one identified by `skip`. Each chip's
  // count is computed against this so it answers "if I add this filter, how
  // many would I see, given my other filters" — i.e. proper faceted drill-down.
  const applyFilters = useCallback((base: Todo[], skip?: "tags" | "unread" | "commands" | "manual" | "priorities") => {
    let result = base;
    if (skip !== "tags") {
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
    }
    if (skip !== "unread" && filterUnread) {
      result = result.filter((t) => isUnread(t) || t.id === stickyTodoId);
    }
    if (skip !== "commands" && filterCommands) {
      result = result.filter((t) => t.is_command);
    }
    if (skip !== "manual" && filterManual) {
      result = result.filter((t) => t.manual);
    }
    if (skip !== "priorities" && selectedPriorities.size > 0) {
      result = result.filter((t) => t.priority !== null && selectedPriorities.has(t.priority));
    }
    return result;
  }, [selectedTags, excludedTags, filterUnread, filterCommands, filterManual, selectedPriorities, stickyTodoId]);

  const filteredWithoutTags = useMemo(() => applyFilters(searchBase, "tags"), [searchBase, applyFilters]);
  const filteredWithoutUnread = useMemo(() => applyFilters(searchBase, "unread"), [searchBase, applyFilters]);
  const filteredWithoutCommands = useMemo(() => applyFilters(searchBase, "commands"), [searchBase, applyFilters]);
  const filteredWithoutManual = useMemo(() => applyFilters(searchBase, "manual"), [searchBase, applyFilters]);
  const filteredWithoutPriorities = useMemo(() => applyFilters(searchBase, "priorities"), [searchBase, applyFilters]);

  // All tags in the current project — used for autocomplete in editors so users
  // can complete tags that exist anywhere, even if currently hidden by filters.
  const allTags = useMemo(() => {
    const tagSet = new Set<string>();
    for (const t of projectFiltered) {
      for (const tag of parseTags(t.text)) tagSet.add(tag);
    }
    return Array.from(tagSet).sort();
  }, [projectFiltered]);

  // Tags shown in the filter bar — narrowed by every other active filter/search.
  // Always includes currently selected/excluded tags so they stay clickable.
  const filterBarTags = useMemo(() => {
    const tagSet = new Set<string>();
    for (const t of filteredWithoutTags) {
      for (const tag of parseTags(t.text)) tagSet.add(tag);
    }
    for (const t of selectedTags) tagSet.add(t);
    for (const t of excludedTags) tagSet.add(t);
    return Array.from(tagSet).sort();
  }, [filteredWithoutTags, selectedTags, excludedTags]);

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

  // Sync filter state to URL params
  useEffect(() => {
    const url = new URL(window.location.href);
    const set = (key: string, value: string | null) => {
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    };
    set("search", searchQuery.trim() || null);
    set("tags", selectedTags.size > 0 ? Array.from(selectedTags).join(",") : null);
    set("exclude", excludedTags.size > 0 ? Array.from(excludedTags).join(",") : null);
    set("unread", filterUnread ? "1" : null);
    set("commands", filterCommands ? "1" : null);
    set("manual", filterManual ? "1" : null);
    set("priorities", selectedPriorities.size > 0 ? Array.from(selectedPriorities).join(",") : null);
    window.history.replaceState({}, "", url.toString());
  }, [searchQuery, selectedTags, excludedTags, filterUnread, filterCommands, filterManual, selectedPriorities]);

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

  // Filter bar counts answer "if you added this filter, how many would you see"
  // — each is computed against every other active filter (including search).
  // For unread, we keep the backend count when no other filter narrows the view
  // (it covers paginated-away completed todos that the loaded list misses), and
  // switch to a client-side count once any other filter is active.
  const unreadCount = useMemo(() => {
    const otherFiltersActive = !!(
      searchQuery.trim() ||
      selectedTags.size ||
      excludedTags.size ||
      filterCommands ||
      filterManual ||
      selectedPriorities.size
    );
    if (!otherFiltersActive) {
      if (selectedProjectId) return unreadCounts[selectedProjectId] ?? 0;
      return unreadCounts["_total"] ?? 0;
    }
    return filteredWithoutUnread.filter((t) => isUnread(t)).length;
  }, [searchQuery, selectedTags, excludedTags, filterCommands, filterManual, selectedPriorities, selectedProjectId, unreadCounts, filteredWithoutUnread]);

  const commandCount = useMemo(() =>
    filteredWithoutCommands.filter((t) => t.is_command).length,
    [filteredWithoutCommands]
  );

  const manualCount = useMemo(() =>
    filteredWithoutManual.filter((t) => t.manual).length,
    [filteredWithoutManual]
  );

  const priorityCounts = useMemo(() => {
    const counts: Record<number, number> = {};
    for (const t of filteredWithoutPriorities) {
      if (t.priority !== null && t.status !== "completed") {
        counts[t.priority] = (counts[t.priority] ?? 0) + 1;
      }
    }
    return counts;
  }, [filteredWithoutPriorities]);

  // Show priority chips when priorities exist among current results — but
  // always show them while a priority filter is active so the user can clear it.
  const hasPriorities = selectedPriorities.size > 0 || filteredWithoutPriorities.some((t) => t.priority !== null);

  const togglePriority = useCallback((level: number) => {
    setSelectedPriorities((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  }, []);

  const filtered = useMemo(() => applyFilters(searchBase), [searchBase, applyFilters]);

  // Sort helper: pending ("not sent") items first so the user notices them,
  // then pinned (user_ordered) items by sort_order,
  // then unpinned items by priority (lower number = higher priority, null = lowest),
  // then by created_at descending (newest first)
  const sortByOrder = (a: Todo, b: Todo) => {
    const aPending = a.id.startsWith("temp-");
    const bPending = b.id.startsWith("temp-");
    if (aPending !== bPending) return aPending ? -1 : 1;
    if (a.user_ordered !== b.user_ordered) return a.user_ordered ? -1 : 1;
    if (a.user_ordered) return a.sort_order - b.sort_order;
    // Priority sorting: items with priority come before those without;
    // among prioritized items, lower number (higher urgency) comes first
    const pa = a.priority ?? 999;
    const pb = b.priority ?? 999;
    if (pa !== pb) return pa - pb;
    return b.created_at.localeCompare(a.created_at);
  };

  // Active: in_progress + waiting + any queued todo. Queued items first, then in_progress, then waiting.
  const activeOrder = { in_progress: 0, waiting: 1 } as const;
  const active = filtered
    .filter((t) => t.run_status === "queued" || t.status === "in_progress" || t.status === "waiting")
    .sort((a, b) => {
      const aQueued = a.run_status === "queued" ? 0 : 1;
      const bQueued = b.run_status === "queued" ? 0 : 1;
      if (aQueued !== bQueued) return aQueued - bQueued;
      const oa = activeOrder[a.status as keyof typeof activeOrder] ?? 2;
      const ob = activeOrder[b.status as keyof typeof activeOrder] ?? 2;
      if (oa !== ob) return oa - ob;
      return sortByOrder(a, b);
    });

  // Up Next: only "next" status, excluding queued (those moved to Active).
  const upNext = filtered
    .filter((t) => t.status === "next" && t.run_status !== "queued")
    .sort(sortByOrder);

  // Backlog: consider, then stale, then rejected. Excludes queued (those moved to Active).
  const backlogOrder = { consider: 0, stale: 1, rejected: 2 } as const;
  const backlog = filtered
    .filter((t) => (t.status === "consider" || t.status === "stale" || t.status === "rejected") && t.run_status !== "queued")
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
  const projectSourcePath = (id: string) => projects.find((p) => p.id === id)?.source_path ?? "";
  const projectRunModel = (id: string) => projects.find((p) => p.id === id)?.run_model || globalRunModel;

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

    // Optimistic update: assign new sort_order values, pin only the moved item.
    // Also register overrides so polling doesn't flash old order back.
    const reorderOverrides: Array<[string, Partial<Todo>]> = [];
    onOptimisticUpdate((allTodos) =>
      allTodos.map((t) => {
        const newIdx = ids.indexOf(t.id);
        if (newIdx !== -1) {
          const fields: Partial<Todo> = { sort_order: newIdx, ...(t.id === dragId ? { user_ordered: true } : {}) };
          reorderOverrides.push([t.id, fields]);
          return { ...t, ...fields };
        }
        return t;
      })
    );
    for (const [id, fields] of reorderOverrides) {
      optimistic.addOptimisticOverride(id, fields);
    }

    // Persist to backend
    const clearOverrides = () => {
      for (const [id] of reorderOverrides) {
        optimistic.removeOptimisticOverride(id);
      }
    };
    api.reorderTodos(ids, dragId).then(() => {
      clearOverrides();
      onRefresh();
    }).catch(() => {
      clearOverrides();
      addToast("Failed to reorder todos", "error");
      onRefresh();
    });
  }, [dropTargetId, dropPosition, onOptimisticUpdate, onRefresh, addToast, optimistic]);

  const handleDragEnd = useCallback(() => {
    dragItemId.current = null;
    dragSection.current = null;
    setDropTargetId(null);
    setDropPosition(null);
  }, []);

  const renderTodoItem = (t: Todo, items: Todo[], section: string) => (
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
      data-todo-id={t.id}
    >
      <TodoItem todo={t} allTags={allTags} allTodos={projectFiltered} allCommands={allCommands} isFocused={focusedTodoId === t.id} triggerEdit={editingTodoId === t.id} projectBusy={busyProjects.has(t.project_id) && t.run_status !== "running"} atRunQuotaLimit={atRunQuotaLimit} quotaCountdown={quotaCountdown} disabled={isOffline} sourcePath={projectSourcePath(t.project_id)} onOutputOpen={handleOutputOpen} runModel={projectRunModel(t.project_id)} sessionAutopilot={sessionAutopilot} parentTodo={resolveParent(t)} referencedBy={resolveReferencedBy(t)} analysisHistory={analysisHistory} onNavigateToTodo={onNavigateToTodo} />
    </div>
  );

  const renderTodoList = (items: Todo[], section: string) => {
    // In "All Projects" view, group todos by project
    if (!selectedProjectId && items.length > 0) {
      const groups = new Map<string, Todo[]>();
      for (const t of items) {
        if (!groups.has(t.project_id)) groups.set(t.project_id, []);
        groups.get(t.project_id)!.push(t);
      }
      // If only one project, no need for grouping headers
      if (groups.size <= 1) {
        return items.map((t) => renderTodoItem(t, items, section));
      }
      return Array.from(groups.entries()).map(([pid, groupItems]) => (
        <div key={pid} className="project-group">
          <div className="project-group-header">{projectName(pid)}</div>
          {groupItems.map((t) => renderTodoItem(t, items, section))}
        </div>
      ));
    }
    return items.map((t) => renderTodoItem(t, items, section));
  };

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
          {selectedProjectId ? projectName(selectedProjectId) : (viewLabel ?? "All Projects")}
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
          <label className="project-settings-item">
            <span className="project-settings-label">Run model</span>
            <span
              className="help-tooltip"
              title={"Override the global run model for this project. Use \"global\" to inherit the global setting. " +
                "Sonnet and Haiku are cheaper but less capable than Opus."}
            >?</span>
            <select
              className={`project-settings-select${selectedProject.run_model ? " quota-active" : ""}`}
              value={selectedProject.run_model || ""}
              onChange={async (e) => {
                const val = e.target.value;
                if (val === "") {
                  await api.updateProject(selectedProject.id, { clear_run_model: true });
                } else {
                  await api.updateProject(selectedProject.id, { run_model: val });
                }
                onRefresh();
              }}
            >
              <option value="">global</option>
              <option value="opus">opus</option>
              <option value="sonnet">sonnet</option>
              <option value="haiku">haiku</option>
            </select>
          </label>
        </div>
      )}

      {selectedProjectId ? (
        <AddTodo projectId={selectedProjectId} allTags={allTags} allTodos={projectFiltered} allCommands={allCommands} inputRef={addInputRef} />
      ) : (
        <AddTodo projects={projectsForAdd ?? projects} allTags={allTags} allTodos={todos} allCommands={allCommands} inputRef={addInputRef} />
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

      <div className="tag-filter-bar">
        {hasPriorities && ([1, 2, 3, 4] as const).map((level) => {
            const info = PRIORITY_INFO[level];
            const count = priorityCounts[level] ?? 0;
            const isActive = selectedPriorities.has(level);
            const isFaded = count === 0 && !isActive;
            return (
              <button
                key={`p${level}`}
                className={`tag-filter-pill priority-filter priority-${level}${isActive ? " active" : ""}${isFaded ? " faded" : ""}`}
                onClick={() => togglePriority(level)}
                style={isActive ? { borderColor: info.color, background: info.color + "18" } : {}}
              >
                {info.short} {info.label} ({count})
              </button>
            );
          })}
          <button
            className={`tag-filter-pill unread-filter${filterUnread ? " active" : ""}${unreadCount === 0 && !filterUnread ? " faded" : ""}`}
            onClick={() => setFilterUnread((v) => !v)}
          >
            ⚡ Unread ({unreadCount})
          </button>
          <button
            className={`tag-filter-pill command-filter${filterCommands ? " active" : ""}${commandCount === 0 && !filterCommands ? " faded" : ""}`}
            onClick={() => setFilterCommands((v) => !v)}
          >
            / Commands ({commandCount})
          </button>
          <button
            className={`tag-filter-pill manual-filter${filterManual ? " active" : ""}${manualCount === 0 && !filterManual ? " faded" : ""}`}
            onClick={() => setFilterManual((v) => !v)}
            title="Show only manual (human-only) tasks"
          >
            ✋ Manual ({manualCount})
          </button>
          {filterBarTags.length > 0 && <span className="tag-filter-divider" aria-hidden="true" />}
          {filterBarTags.map((tag) =>
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
        {(selectedTags.size > 0 || excludedTags.size > 0 || filterUnread || filterCommands || filterManual || selectedPriorities.size > 0) && (
          <button className="tag-filter-clear" onClick={() => { clearTags(); setFilterUnread(false); setFilterCommands(false); setFilterManual(false); setSelectedPriorities(new Set()); }}>Clear</button>
        )}
      </div>

      {/* Active */}
      {active.length > 0 && (
        <>
          <button className="btn-link section-header" onClick={() => setShowActive(!showActive)}>
            {(showActive || searchQuery) ? "▾" : "▸"} Active ({active.length})
          </button>
          {(showActive || searchQuery) && renderTodoList(active, "active")}
        </>
      )}

      {/* Up Next */}
      <div className="up-next-header-row">
        <button className="btn-link section-header" onClick={() => setShowUpNext(!showUpNext)}>
          {(showUpNext || searchQuery) ? "▾" : "▸"} Up Next ({upNext.length})
        </button>
        {selectedProject && (
          <div className={`autopilot-inline-wrapper${autopilotPending ? " autopilot-pending" : ""}`}>
            <label className="autopilot-inline" title={
              selectedProject.auto_run_quota > 0
                ? `Autopilot: will auto-run ${selectedProject.auto_run_quota} todo(s) on next analysis, then stop`
                : selectedProject.scheduled_auto_run_quota > 0
                  ? `Autopilot: ${selectedProject.scheduled_auto_run_quota} todo(s) scheduled for ${selectedProject.autopilot_starts_at ? new Date(selectedProject.autopilot_starts_at).toLocaleString() : "next quota reset"}`
                  : "Autopilot off"
            }>
              <span className="autopilot-inline-label">🚀 Autopilot</span>
              <select
                className={`autopilot-inline-select${selectedProject.auto_run_quota > 0 ? " autopilot-active" : ""}${selectedProject.scheduled_auto_run_quota > 0 && selectedProject.auto_run_quota === 0 ? " autopilot-scheduled" : ""}`}
                disabled={autopilotPending}
                value={
                  selectedProject.auto_run_quota > 0
                    ? String(selectedProject.auto_run_quota)
                    : selectedProject.scheduled_auto_run_quota > 0
                      ? `sched_${selectedProject.scheduled_auto_run_quota}`
                      : "0"
                }
                onChange={async (e) => {
                  const val = e.target.value;
                  const pid = selectedProject.id;
                  setAutopilotPending(true);
                  try {
                    if (val.startsWith("sched_")) {
                      const n = Number(val.slice(6));
                      const now = new Date();
                      const next2am = new Date(now);
                      next2am.setUTCHours(2, 0, 0, 0);
                      if (next2am <= now) next2am.setUTCDate(next2am.getUTCDate() + 1);
                      const startsAt = next2am.toISOString().replace(/\.\d{3}Z$/, "Z");
                      optimistic.addOptimisticProjectOverride(pid, { auto_run_quota: 0, scheduled_auto_run_quota: n, autopilot_starts_at: startsAt });
                      await api.updateProject(pid, { auto_run_quota: 0, scheduled_auto_run_quota: n, autopilot_starts_at: startsAt });
                    } else {
                      const n = Number(val);
                      optimistic.addOptimisticProjectOverride(pid, { auto_run_quota: n, scheduled_auto_run_quota: 0, autopilot_starts_at: null });
                      await api.updateProject(pid, { auto_run_quota: n, clear_scheduled_autopilot: true });
                    }
                  } finally {
                    optimistic.removeOptimisticProjectOverride(pid);
                    setAutopilotPending(false);
                    onRefresh();
                  }
                }}
              >
                <option value="0">off</option>
                <optgroup label="Start now">
                  {(() => {
                    const presets = [1, 2, 3, 5, 10, 20, 50];
                    const current = selectedProject.auto_run_quota;
                    const all = current > 0 && !presets.includes(current) ? [...presets, current].sort((a, b) => a - b) : presets;
                    return all.map((n) => (
                      <option key={n} value={String(n)}>{n === current && current > 0 ? `${n} left` : String(n)}</option>
                    ));
                  })()}
                </optgroup>
                <optgroup label="Schedule">
                  {(() => {
                    const presets = [1, 2, 3, 5, 10, 20, 50];
                    const current = selectedProject.scheduled_auto_run_quota;
                    const all = current > 0 && !presets.includes(current) ? [...presets, current].sort((a, b) => a - b) : presets;
                    return all.map((n) => (
                      <option key={`sched_${n}`} value={`sched_${n}`}>{n === current && current > 0 ? `${n} scheduled` : String(n)}</option>
                    ));
                  })()}
                </optgroup>
              </select>
            </label>
            {selectedProject.scheduled_auto_run_quota > 0 && selectedProject.autopilot_starts_at && (
              <span className="autopilot-schedule-info">
                <input
                  type="datetime-local"
                  className="autopilot-schedule-time"
                  disabled={autopilotPending}
                  value={(() => {
                    const d = new Date(selectedProject.autopilot_starts_at!);
                    const pad = (n: number) => String(n).padStart(2, "0");
                    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
                  })()}
                  onChange={async (e) => {
                    if (!e.target.value) return;
                    const local = new Date(e.target.value);
                    const startsAt = local.toISOString().replace(/\.\d{3}Z$/, "Z");
                    const pid = selectedProject.id;
                    setAutopilotPending(true);
                    optimistic.addOptimisticProjectOverride(pid, { autopilot_starts_at: startsAt });
                    try {
                      await api.updateProject(pid, { autopilot_starts_at: startsAt });
                    } finally {
                      optimistic.removeOptimisticProjectOverride(pid);
                      setAutopilotPending(false);
                      onRefresh();
                    }
                  }}
                />
                <button
                  className="autopilot-schedule-cancel"
                  title="Cancel scheduled autopilot"
                  disabled={autopilotPending}
                  onClick={async () => {
                    const pid = selectedProject.id;
                    setAutopilotPending(true);
                    optimistic.addOptimisticProjectOverride(pid, { scheduled_auto_run_quota: 0, autopilot_starts_at: null });
                    try {
                      await api.updateProject(pid, { clear_scheduled_autopilot: true });
                    } finally {
                      optimistic.removeOptimisticProjectOverride(pid);
                      setAutopilotPending(false);
                      onRefresh();
                    }
                  }}
                >x</button>
              </span>
            )}
          </div>
        )}
      </div>
      {(showUpNext || searchQuery) && (
        <>
          {active.length === 0 && upNext.length === 0 && backlog.length === 0 && done.length === 0 && (
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
                {Array.from(groups.entries()).map(([day, items]) => {
                  // In "All Projects" view, sub-group completed todos by project within each date
                  if (!selectedProjectId) {
                    const projGroups = new Map<string, Todo[]>();
                    for (const t of items) {
                      if (!projGroups.has(t.project_id)) projGroups.set(t.project_id, []);
                      projGroups.get(t.project_id)!.push(t);
                    }
                    return (
                      <div key={day} className="done-group">
                        <div className="done-group-header">{day}</div>
                        {Array.from(projGroups.entries()).map(([pid, projItems]) => (
                          <div key={pid} className="project-group">
                            {projGroups.size > 1 && <div className="project-group-header project-group-header-sub">{projectName(pid)}</div>}
                            {projItems.map((t) => (
                              <div key={t.id}>
                                <TodoItem todo={t} allTags={allTags} allTodos={projectFiltered} allCommands={allCommands} isFocused={focusedTodoId === t.id} triggerEdit={editingTodoId === t.id} projectBusy={busyProjects.has(t.project_id) && t.run_status !== "running"} atRunQuotaLimit={atRunQuotaLimit} quotaCountdown={quotaCountdown} disabled={isOffline} sourcePath={projectSourcePath(t.project_id)} onOutputOpen={handleOutputOpen} runModel={projectRunModel(t.project_id)} sessionAutopilot={sessionAutopilot} parentTodo={resolveParent(t)} referencedBy={resolveReferencedBy(t)} analysisHistory={analysisHistory} onNavigateToTodo={onNavigateToTodo} />
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    );
                  }
                  return (
                    <div key={day} className="done-group">
                      <div className="done-group-header">{day}</div>
                      {items.map((t) => (
                        <div key={t.id}>
                          <TodoItem todo={t} allTags={allTags} allTodos={projectFiltered} allCommands={allCommands} isFocused={focusedTodoId === t.id} triggerEdit={editingTodoId === t.id} projectBusy={busyProjects.has(t.project_id) && t.run_status !== "running"} atRunQuotaLimit={atRunQuotaLimit} quotaCountdown={quotaCountdown} disabled={isOffline} sourcePath={projectSourcePath(t.project_id)} onOutputOpen={handleOutputOpen} runModel={projectRunModel(t.project_id)} sessionAutopilot={sessionAutopilot} parentTodo={resolveParent(t)} referencedBy={resolveReferencedBy(t)} analysisHistory={analysisHistory} onNavigateToTodo={onNavigateToTodo} />
                        </div>
                      ))}
                    </div>
                  );
                })}
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
