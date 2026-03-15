import { useState, useRef, useEffect, useMemo } from "react";
import type { Project, Todo } from "../types";
import { api } from "../api";
import { apiErrorMessage } from "../errors";

type AddMode = "add" | "add-run" | "add-plan";

interface Props {
  projectId?: string;
  projects?: Project[];
  allTags?: string[];
  onRefresh: () => void;
  addToast: (text: string, type?: "info" | "warning" | "success" | "error") => void;
  onOptimisticUpdate: (fn: (todos: Todo[]) => Todo[]) => void;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  disabled?: boolean;
  isOffline?: boolean;
}

export function AddTodo({ projectId, projects, allTags = [], onRefresh, addToast, onOptimisticUpdate, inputRef, disabled = false, isOffline = false }: Props) {
  const [text, setText] = useState("");
  const [selectedProject, setSelectedProject] = useState(projectId ?? "");
  const [mode, setMode] = useState<AddMode>("add");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const localRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = inputRef ?? localRef;
  const dropdownRef = useRef<HTMLDivElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const [modifierHeld, setModifierHeld] = useState(false);

  // Track Cmd/Ctrl held state for button label
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "Meta" || e.key === "Control") setModifierHeld(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "Meta" || e.key === "Control") setModifierHeld(false);
    };
    const blur = () => setModifierHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  // Auto-resize textarea to fit content
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 150) + "px";
    }
  }, [text, textareaRef]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [dropdownOpen]);

  // Compute tag suggestions based on cursor position
  const tagFragment = useMemo(() => {
    const el = textareaRef.current;
    if (!el) return null;
    const cursorPos = el.selectionStart ?? text.length;
    const beforeCursor = text.slice(0, cursorPos);
    // Look for a # that starts a tag at/near cursor
    const match = beforeCursor.match(/(?:^|\s)#([A-Za-z][A-Za-z0-9_-]*)$/);
    if (match) return match[1].toLowerCase();
    // Just typed #
    const hashMatch = beforeCursor.match(/(?:^|\s)#$/);
    if (hashMatch) return "";
    return null;
  }, [text, textareaRef]);

  useEffect(() => {
    if (tagFragment === null) {
      setTagSuggestions([]);
      setSelectedSuggestion(0);
      return;
    }
    const matches = allTags.filter((t) =>
      tagFragment === "" || t.startsWith(tagFragment)
    );
    setTagSuggestions(matches);
    setSelectedSuggestion(0);
  }, [tagFragment, allTags]);

  const applySuggestion = (tag: string) => {
    const el = textareaRef.current;
    if (!el) return;
    const cursorPos = el.selectionStart ?? text.length;
    const beforeCursor = text.slice(0, cursorPos);
    const afterCursor = text.slice(cursorPos);
    // Find where the # starts
    const hashIdx = beforeCursor.lastIndexOf("#");
    if (hashIdx === -1) return;
    const newText = beforeCursor.slice(0, hashIdx) + "#" + tag + " " + afterCursor;
    setText(newText);
    setTagSuggestions([]);
    // Restore focus
    setTimeout(() => {
      el.focus();
      const newCursorPos = hashIdx + 1 + tag.length + 1;
      el.setSelectionRange(newCursorPos, newCursorPos);
    }, 0);
  };

  const switchMode = (m: AddMode) => {
    setMode(m);
    setDropdownOpen(false);
  };

  const handleAdd = async (overrideMode?: AddMode) => {
    const trimmed = text.trim();
    const pid = projectId ?? selectedProject;
    if (!trimmed || !pid) {
      if (!pid) addToast("Select a project first", "warning");
      return;
    }

    const activeMode = overrideMode ?? mode;
    const shouldRun = activeMode === "add-run" || activeMode === "add-plan";
    const planOnly = activeMode === "add-plan";

    // Optimistic placeholder
    const tempId = `temp-${Date.now()}`;
    const placeholder: Todo = {
      id: tempId,
      project_id: pid,
      text: trimmed,
      status: "next",
      source: "user",
      completed_by_run: false,
      emoji: null,
      session_id: null,
      created_at: new Date().toISOString(),
      completed_at: null,
      run_output: null,
      run_status: shouldRun ? "queued" : null,
      run_trigger: shouldRun ? "manual" : null,
      btw_output: null,
      btw_status: null,
      run_started_at: null,
      is_read: true,
      plan_only: planOnly,
      sort_order: -Infinity,
      user_ordered: false,
      stale_reason: null,
      rejected_at: null,
    };
    onOptimisticUpdate((todos) => [placeholder, ...todos]);
    setText("");

    // If offline, keep the placeholder visible but don't try the API
    if (isOffline) {
      addToast("You're offline — item saved locally but not sent to server", "warning");
      return;
    }

    try {
      const created = await api.createTodo(pid, trimmed, planOnly);
      if (shouldRun) {
        try {
          const result = await api.runTodo(created.id);
          if (result.status === "queued") {
            addToast(`Added & queued "${trimmed}"${planOnly ? " (plan only)" : ""}`, "info");
          } else {
            addToast(`Added & ${planOnly ? "planning" : "running"} "${trimmed}"`, "info");
          }
        } catch (err) {
          addToast(`Added todo but failed to run: ${apiErrorMessage(err)}`, "error");
        }
      }
      onRefresh();
    } catch {
      onOptimisticUpdate((todos) => todos.filter((t) => t.id !== tempId));
      setText(trimmed);
      addToast(`Failed to add "${trimmed}"`, "error");
    }
  };

  const needsProjectSelector = !projectId && projects && projects.length > 0;

  const effectiveMode = modifierHeld ? "add-run" : mode;
  const modeLabels: Record<AddMode, string> = { "add": "Add", "add-run": "Add & Run", "add-plan": "Add & Plan" };
  const label = modeLabels[effectiveMode];
  // Show the other two modes in the dropdown
  const altModes = (["add", "add-run", "add-plan"] as AddMode[]).filter((m) => m !== effectiveMode);

  return (
    <div className="add-todo">
      {needsProjectSelector && (
        <select
          className="add-todo-project-select"
          value={selectedProject}
          onChange={(e) => setSelectedProject(e.target.value)}
          disabled={disabled}
        >
          <option value="">Project...</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      )}
      <div className="add-todo-input-wrapper">
        <textarea
          placeholder={isOffline ? "Add a todo (offline — will be saved locally)" : disabled ? "Server offline — changes disabled" : "Add a todo... (Ctrl+Enter to add & run, # for tags)"}
          value={text}
          rows={1}
          disabled={disabled && !isOffline}
          onChange={(e) => setText(e.target.value)}
          ref={textareaRef}
          onKeyDown={(e) => {
            // Handle tag suggestion navigation
            if (tagSuggestions.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelectedSuggestion((s) => Math.min(s + 1, tagSuggestions.length - 1));
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelectedSuggestion((s) => Math.max(s - 1, 0));
                return;
              }
              if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                if (tagSuggestions[selectedSuggestion]) {
                  e.preventDefault();
                  applySuggestion(tagSuggestions[selectedSuggestion]);
                  return;
                }
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setTagSuggestions([]);
                return;
              }
            }
            if (e.key === "Enter" && e.shiftKey) {
              return; // Allow newline
            }
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              handleAdd("add-run");
              return;
            }
            if (e.key === "Enter") {
              e.preventDefault();
              handleAdd();
            }
          }}
        />
        {tagSuggestions.length > 0 && (
          <div className="tag-suggestions" ref={suggestionsRef}>
            {tagSuggestions.map((tag, i) => (
              <button
                key={tag}
                className={`tag-suggestion-item${i === selectedSuggestion ? " selected" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault(); // prevent blur
                  applySuggestion(tag);
                }}
              >
                #{tag}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="add-todo-split-btn" ref={dropdownRef}>
        <button className="add-todo-main-btn" onClick={() => handleAdd(effectiveMode)} disabled={disabled && !isOffline}>{label}</button>
        <button
          className="add-todo-drop-toggle"
          onClick={() => setDropdownOpen((o) => !o)}
          disabled={disabled && !isOffline}
          aria-label="Switch add mode"
        >
          ▾
        </button>
        {dropdownOpen && (
          <div className="add-todo-dropdown">
            {altModes.map((m) => (
              <button key={m} onClick={() => switchMode(m)}>{modeLabels[m]}</button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
