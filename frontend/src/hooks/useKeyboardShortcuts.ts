import { useCallback, useEffect, useRef, useState } from "react";
import type { FullState, Todo } from "../types";
import { api } from "../api";
import type { ToastType } from "./useNotifications";

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
  view: "list" | "dashboard";
  selectedProject: string | null;
  setState: React.Dispatch<React.SetStateAction<FullState | null>>;
  refresh: () => Promise<void>;
  addToast: (text: string, type?: ToastType) => void;
}

export function useKeyboardShortcuts({
  state,
  view,
  selectedProject,
  setState,
  refresh,
  addToast,
}: UseKeyboardShortcutsOptions) {
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [focusedTodoId, setFocusedTodoId] = useState<string | null>(null);
  const [editingTodoId, setEditingTodoId] = useState<string | null>(null);
  const addInputRef = useRef<HTMLTextAreaElement | null>(null);

  // Build flat ordered list of visible todos (mirrors TodoList render order)
  const getVisibleTodos = useCallback((): Todo[] => {
    if (!state || view !== "list") return [];
    const filtered = selectedProject
      ? state.todos.filter((t) => t.project_id === selectedProject)
      : state.todos;

    const sortByOrder = (a: Todo, b: Todo) => {
      if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
      return b.created_at.localeCompare(a.created_at);
    };

    const upNextOrder = { waiting: 0, in_progress: 1, next: 2 } as const;
    const upNext = filtered
      .filter((t) => t.status === "waiting" || t.status === "in_progress" || t.status === "next")
      .sort((a, b) => {
        const oa = upNextOrder[a.status as keyof typeof upNextOrder] ?? 2;
        const ob = upNextOrder[b.status as keyof typeof upNextOrder] ?? 2;
        if (oa !== ob) return oa - ob;
        return sortByOrder(a, b);
      });

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

    return [...upNext, ...backlog, ...done];
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

      // Status shortcuts 1-6
      if (STATUS_KEYS[e.key] && focusedTodoId) {
        e.preventDefault();
        const newStatus = STATUS_KEYS[e.key];
        setState((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            todos: prev.todos.map((t) =>
              t.id === focusedTodoId ? { ...t, status: newStatus } : t
            ),
          };
        });
        api.updateTodo(focusedTodoId, { status: newStatus }).then(() => refresh());
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
        setState((prev) => {
          if (!prev) return prev;
          return { ...prev, todos: prev.todos.filter((t) => t.id !== idToDelete) };
        });
        api.deleteTodo(idToDelete).then(() => refresh());
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
  }, [showShortcuts, focusedTodoId, getVisibleTodos, refresh, addToast, setState]);

  return {
    showShortcuts,
    setShowShortcuts,
    focusedTodoId,
    editingTodoId,
    addInputRef,
  };
}
