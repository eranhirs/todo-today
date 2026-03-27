import { createContext, useContext, type ReactNode } from "react";
import type { Todo } from "../types";
import type { OptimisticActions } from "../hooks/useOptimistic";

export type ToastType = "info" | "warning" | "success" | "error";

export interface AppContextValue {
  addToast: (text: string, type?: ToastType, options?: { onUndo?: () => void; duration?: number }) => void;
  onRefresh: () => void;
  onOptimisticUpdate: (fn: (todos: Todo[]) => Todo[]) => void;
  optimistic: OptimisticActions;
  isOffline: boolean;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ value, children }: { value: AppContextValue; children: ReactNode }) {
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useAppContext(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useAppContext must be used within AppProvider");
  return ctx;
}
