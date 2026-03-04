import type { FullState, Project, SessionInfo, Todo } from "./types";

const BASE = "/api";

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  getState: () => request<FullState>("/state"),

  createProject: (name: string, source_path = "") =>
    request<Project>("/projects", {
      method: "POST",
      body: JSON.stringify({ name, source_path }),
    }),

  deleteProject: (id: string) =>
    request<void>(`/projects/${id}`, { method: "DELETE" }),

  createTodo: (project_id: string, text: string) =>
    request<Todo>("/todos", {
      method: "POST",
      body: JSON.stringify({ project_id, text }),
    }),

  updateTodo: (id: string, data: { text?: string; completed?: boolean }) =>
    request<Todo>(`/todos/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  deleteTodo: (id: string) =>
    request<void>(`/todos/${id}`, { method: "DELETE" }),

  wakeUpClaude: (model?: string, force?: boolean, sessionKeys?: string[]) =>
    request<{ status: string; message?: string }>("/claude/wake", {
      method: "POST",
      body: JSON.stringify({
        ...(model ? { model } : {}),
        ...(force ? { force } : {}),
        ...(sessionKeys ? { session_keys: sessionKeys } : {}),
      }),
    }),

  getSessions: () => request<SessionInfo[]>("/claude/sessions"),

  setAnalysisInterval: (minutes: number) =>
    request<{ minutes: number }>("/claude/interval", {
      method: "PUT",
      body: JSON.stringify({ minutes }),
    }),

  setAnalysisModel: (model: string) =>
    request<{ model: string }>("/claude/model", {
      method: "PUT",
      body: JSON.stringify({ model }),
    }),

  dismissInsight: (id: string) =>
    request<{ status: string }>(`/claude/insights/${id}/dismiss`, {
      method: "PUT",
    }),
};
