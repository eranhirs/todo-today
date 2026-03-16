export type TodoStatus = "next" | "in_progress" | "completed" | "consider" | "waiting" | "stale" | "rejected";

export interface Project {
  id: string;
  name: string;
  source_path: string;
  auto_run_quota: number;
  todo_quota: number;
  created_at: string;
}

export interface Todo {
  id: string;
  project_id: string;
  text: string;
  status: TodoStatus;
  source: "claude" | "user";
  completed_by_run: boolean;
  emoji: string | null;
  session_id: string | null;
  created_at: string;
  completed_at: string | null;
  rejected_at: string | null;
  original_text: string | null;
  run_output: string | null;
  run_status: "running" | "done" | "error" | "stopped" | "queued" | null;
  run_trigger: "manual" | "autopilot" | null;
  btw_output: string | null;
  btw_status: "running" | "done" | "error" | null;
  run_started_at: string | null;
  is_read: boolean;
  plan_only: boolean;
  manual: boolean;
  sort_order: number;
  user_ordered: boolean;
  stale_reason: string | null;
  images: { filename: string; added_at: string; source: "creation" | "followup" }[];
  red_flags: { label: string; explanation: string; excerpt: string }[];
}

export interface Insight {
  id: string;
  project_id: string;
  text: string;
  source_analysis_timestamp: string;
  dismissed: boolean;
  created_at: string;
}

export interface AnalysisEntry {
  timestamp: string;
  duration_seconds: number;
  sessions_analyzed: number;
  todos_added: number;
  todos_completed: number;
  todos_modified: number;
  summary: string;
  model: string;
  trigger: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  error: string | null;
  completed_todo_ids: string[];
  completed_todo_texts: string[];
  added_todos_active: string[];
  added_todos_completed: string[];
  modified_todos: string[];
  new_project_names: string[];
  insights: string[];
  prompt_length: number;
  prompt_text: string;
  claude_response: string;
  claude_reasoning: string;
}

export interface Settings {
  analysis_interval_minutes: number;
  analysis_model: string;
  run_model: string;
  heartbeat_enabled: boolean;
  hook_analysis_enabled: boolean;
}

export type SettingsUpdate = Partial<Omit<Settings, "run_model">>;

export interface Metadata {
  last_analysis: AnalysisEntry | null;
  history: AnalysisEntry[];
  scheduler_status: string;
  heartbeat: string;
  project_summaries: Record<string, string>;
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_analyses: number;
  analysis_interval_minutes: number;
  analysis_model: string;
  insights: Insight[];
  heartbeat_enabled: boolean;
  hook_analysis_enabled: boolean;
}

export interface SessionInfo {
  key: string;
  project_dir: string;
  source_path: string;
  project_name: string;
  session_id: string;
  mtime: number;
  message_count: number;
  last_analyzed_mtime: number | null;
  state?: string;
  state_source?: string;
}

export interface FullState {
  projects: Project[];
  todos: Todo[];
  metadata: Metadata;
  settings: Settings;
  analysis_locked: boolean;
  autopilot_running: boolean;
}
