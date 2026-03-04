import { useEffect, useState, useCallback } from "react";
import type { FullState } from "./types";
import { api } from "./api";
import { ProjectList } from "./components/ProjectList";
import { TodoList } from "./components/TodoList";
import { ClaudeStatus } from "./components/ClaudeStatus";
import { UpdateHistory } from "./components/UpdateHistory";
import "./App.css";

const POLL_INTERVAL = 10_000;

function App() {
  const [state, setState] = useState<FullState | null>(null);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api.getState();
      setState(data);
    } catch (err) {
      console.error("Failed to fetch state:", err);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [refresh]);

  if (!state) return <div className="loading">Loading...</div>;

  return (
    <div className="app">
      <aside className="sidebar">
        <h1 className="app-title">Todo Today</h1>
        <ClaudeStatus metadata={state.metadata} onRefresh={refresh} />
        <ProjectList
          projects={state.projects}
          selectedId={selectedProject}
          onSelect={setSelectedProject}
          onRefresh={refresh}
        />
        <UpdateHistory history={state.metadata.history} />
      </aside>
      <main className="main">
        <TodoList
          todos={state.todos}
          projects={state.projects}
          selectedProjectId={selectedProject}
          projectSummaries={state.metadata.project_summaries}
          onRefresh={refresh}
        />
      </main>
    </div>
  );
}

export default App;
