export interface Project {
  id: string;
  name: string;
  source_path: string;
  created_at: string;
}

export interface Todo {
  id: string;
  project_id: string;
  text: string;
  completed: boolean;
  source: "claude" | "user";
  created_at: string;
  completed_at: string | null;
}

export interface AnalysisEntry {
  timestamp: string;
  duration_seconds: number;
  sessions_analyzed: number;
  todos_added: number;
  todos_completed: number;
  summary: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  error: string | null;
  completed_todo_ids: string[];
  added_todos: string[];
  new_project_names: string[];
  prompt_length: number;
}

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
}

export interface FullState {
  projects: Project[];
  todos: Todo[];
  metadata: Metadata;
}
