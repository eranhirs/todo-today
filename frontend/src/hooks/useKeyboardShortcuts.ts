import { useCallback, useEffect, useRef, useState } from "react";
import { type FullState, type Todo, PINNED_VIEW_ID } from "../types";
import { api } from "../api";
import type { ToastType } from "./useNotifications";
import type { OptimisticActions } from "./useOptimistic";

const STATUS_KEYS: Record<string, Todo["status"]> = {
  "1": "next",
  "2": "in_progress",
  "3": "completed",
  "4": "consider",
  "5": "waiting",
  "6": "rejected",
};

interface UseKeyboardShortcutsOptions {
  state: FullState | null;
  view: "list" | "dashboard" | "skills";
  selectedProject: string | null;
  setState: React.Dispatch<React.SetStateAction<FullState | null>>;
  refresh: () => Promise<void>;
  addToast: (text: string, type?: ToastType) => void;
  isOffline?: boolean;
  optimistic: OptimisticActions;
}

export function useKeyboardShortcuts({
  state,
  view,
  selectedProject,
  setState,
  refresh,
  addToast,
  isOffline = false,
  optimistic,
}: UseKeyboardShortcutsOptions) {
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [focusedTodoId, setFocusedTodoId] = useState<string | null>(null);
  const [editingTodoId, setEditingTodoId] = useState<string | null>(null);
  const addInputRef = useRef<HTMLTextAreaElement | null>(null);

  // Clear focus when the selected project changes (e.g., sidebar click)
  useEffect(() => {
    setFocusedTodoId(null);
    setEditingTodoId(null);
  }, [selectedProject]);

  // Build flat ordered list of visible todos (mirrors TodoList render order)
  const getVisibleTodos = useCallback((): Todo[] => {
    if (!state || view !== "list") return [];
    let filtered: Todo[];
    if (selectedProject === PINNED_VIEW_ID) {
      const pinnedIds = new Set(state.projects.filter((p) => p.pinned).map((p) => p.id));
      filtered = state.todos.filter((t) => pinnedIds.has(t.project_id));
    } else if (selectedProject) {
      filtered = state.todos.filter((t) => t.project_id === selectedProject);
    } else {
      filtered = state.todos;
    }

    const sortByOrder = (a: Todo, b: Todo) => {
      const aPending = a.id.startsWith("temp-");
      const bPending = b.id.startsWith("temp-");
      if (aPending !== bPending) return aPending ? -1 : 1;
      if (a.user_ordered !== b.user_ordered) return a.user_ordered ? -1 : 1;
      if (a.user_ordered) return a.sort_order - b.sort_order;
      return b.created_at.localeCompare(a.created_at);
    };

    const activeOrder = { in_progress: 0, waiting: 1 } as const;
    const active = filtered
      .filter((t) => t.status === "in_progress" || t.status === "waiting")
      .sort((a, b) => {
        const oa = activeOrder[a.status as keyof typeof activeOrder] ?? 2;
        const ob = activeOrder[b.status as keyof typeof activeOrder] ?? 2;
        if (oa !== ob) return oa - ob;
        return sortByOrder(a, b);
      });

    const upNext = filtered
      .filter((t) => t.status === "next")
      .sort(sortByOrder);

    const backlogOrder = { consider: 0, stale: 1, rejected: 2 } as const;
    const backlog = filtered
      .filter((t) => t.status === "consider" || t.status === "stale" || t.status === "rejected")
      .sort((a, b) => {
        const oa = backlogOrder[a.status as keyof typeof backlogOrder] ?? 1;
        const ob = backlogOrder[b.status as keyof typeof backlogOrder] ?? 1;
        if (oa !== ob) return oa - ob;
        return sortByOrder(a, b);
      });

    const done = filtered
      .filter((t) => t.status === "completed")
      .sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""));

    return [...active, ...upNext, ...backlog, ...done];
  }, [state, view, selectedProject]);

  // Global keyboard shortcut handler
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const isInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";

      // ? always toggles overlay
      if (e.key === "?" && !e.metaKey && !e.ctrlKey) {
        if (isInput) return;
        e.preventDefault();
        setShowShortcuts((v) => !v);
        return;
      }

      // Escape: close overlay, clear focus, or blur input
      if (e.key === "Escape") {
        if (showShortcuts) {
          setShowShortcuts(false);
          return;
        }
        if (isInput) {
          (e.target as HTMLElement).blur();
          return;
        }
        setFocusedTodoId(null);
        setEditingTodoId(null);
        return;
      }

      // Skip other shortcuts when typing in an input
      if (isInput) return;
      // Skip when overlay is showing
      if (showShortcuts) return;

      const todos = getVisibleTodos();

      if (e.key === "n") {
        e.preventDefault();
        addInputRef.current?.focus();
        setFocusedTodoId(null);
        return;
      }

      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        if (todos.length === 0) return;
        setEditingTodoId(null);
        if (focusedTodoId === null) {
          setFocusedTodoId(todos[0].id);
        } else {
          const idx = todos.findIndex((t) => t.id === focusedTodoId);
          if (idx < todos.length - 1) {
            setFocusedTodoId(todos[idx + 1].id);
          }
        }
        return;
      }

      if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        if (todos.length === 0) return;
        setEditingTodoId(null);
        if (focusedTodoId === null) {
          setFocusedTodoId(todos[todos.length - 1].id);
        } else {
          const idx = todos.findIndex((t) => t.id === focusedTodoId);
          if (idx > 0) {
            setFocusedTodoId(todos[idx - 1].id);
          }
        }
        return;
      }

      // Block mutation shortcuts when offline
      if (isOffline && focusedTodoId && (STATUS_KEYS[e.key] || e.key === "e" || e.key === "x" || e.key === "r")) {
        e.preventDefault();
        addToast("You're offline — changes aren't available right now", "warning");
        return;
      }

      // Status shortcuts 1-6
      if (STATUS_KEYS[e.key] && focusedTodoId) {
        e.preventDefault();
        const newStatus = STATUS_KEYS[e.key];
        const tid = focusedTodoId;
        const prevStatus = todos.find((t) => t.id === tid)?.status ?? "next";
        optimistic.applyTodoUpdate({
          todoId: tid,
          fields: { status: newStatus },
          apiCall: () => api.updateTodo(tid, { status: newStatus }),
          revertFields: { status: prevStatus },
          setState,
          onRefresh: refresh,
        });
        return;
      }

      if (e.key === "e" && focusedTodoId) {
        e.preventDefault();
        setEditingTodoId(focusedTodoId);
        setTimeout(() => setEditingTodoId(null), 100);
        return;
      }

      if (e.key === "x" && focusedTodoId) {
        e.preventDefault();
        const idToDelete = focusedTodoId;
        const idx = todos.findIndex((t) => t.id === idToDelete);
        const nextId = idx < todos.length - 1 ? todos[idx + 1].id : (idx > 0 ? todos[idx - 1].id : null);
        setFocusedTodoId(nextId);
        optimistic.addPendingDelete(idToDelete);
        setState((prev) => {
          if (!prev) return prev;
          return { ...prev, todos: prev.todos.filter((t) => t.id !== idToDelete) };
        });
        api.deleteTodo(idToDelete).then(() => {
          optimistic.removePendingDelete(idToDelete);
          refresh();
        }).catch(() => {
          optimistic.removePendingDelete(idToDelete);
          refresh();
        });
        return;
      }

      if (e.key === "r" && focusedTodoId) {
        e.preventDefault();
        api.runTodo(focusedTodoId).then(() => {
          addToast(`Started running todo with Claude`, "info");
          refresh();
        });
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [showShortcuts, focusedTodoId, getVisibleTodos, refresh, addToast, setState, isOffline, optimistic]);

  return {
    showShortcuts,
    setShowShortcuts,
    focusedTodoId,
    editingTodoId,
    addInputRef,
  };
}
