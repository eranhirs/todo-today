import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import type { Project, Todo } from "../types";
import { api } from "../api";
import { apiErrorMessage } from "../errors";
import { type CommandInfo, stripCommandsFromText } from "../utils/commands";
import { stripTagsFromText } from "../utils/tags";
import { filterMentionSuggestions } from "../utils/todoSearch";

type AddMode = "add" | "add-run" | "add-plan";

// Module-level draft storage: persists textarea content per project across tab switches
const addTodoDrafts = new Map<string, string>();

interface PendingImage {
  filename: string;  // server-side filename after upload
  previewUrl: string; // local blob URL for preview
}

interface Props {
  projectId?: string;
  projects?: Project[];
  allTags?: string[];
  allTodos?: Todo[];
  allCommands?: CommandInfo[];
  onRefresh: () => void;
  addToast: (text: string, type?: "info" | "warning" | "success" | "error") => void;
  onOptimisticUpdate: (fn: (todos: Todo[]) => Todo[]) => void;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  disabled?: boolean;
  isOffline?: boolean;
}

/** Extract the last Claude response from a todo's run_output (after the last follow-up separator, if any) */
function getLastClaudeMessage(todo: Todo): string | null {
  const output = todo.run_output;
  if (!output) return null;

  // Split by follow-up/btw separators to find the last section
  const separatorRe = /\n\n--- (?:Follow-up(?: \(queued\))?|BTW) ---\n\*\*You:\*\* .+\n/g;
  let lastSepEnd = 0;
  let match: RegExpExecArray | null;
  while ((match = separatorRe.exec(output)) !== null) {
    lastSepEnd = match.index + match[0].length;
  }

  const lastSection = output.slice(lastSepEnd).trim();
  if (!lastSection) return null;

  // Truncate to a reasonable length for context
  const maxLen = 2000;
  if (lastSection.length > maxLen) {
    return lastSection.slice(lastSection.length - maxLen) + "\n[...truncated]";
  }
  return lastSection;
}

/** Get a clean display title for a todo (strip tags and commands) */
function getTodoDisplayTitle(todo: Todo): string {
  return stripCommandsFromText(stripTagsFromText(todo.text)).trim();
}

export function AddTodo({ projectId, projects, allTags = [], allTodos = [], allCommands, onRefresh, addToast, onOptimisticUpdate, inputRef, disabled = false, isOffline = false }: Props) {
  const commands = allCommands ?? [];
  const draftKey = projectId ?? "__all__";
  const [text, setText] = useState(() => addTodoDrafts.get(draftKey) ?? "");
  const [selectedProject, setSelectedProject] = useState(projectId ?? "");

  // Keep refs for draft save without stale closures
  const textValueRef = useRef(text);
  textValueRef.current = text;
  const prevDraftKeyRef = useRef(draftKey);

  // On project switch (same component instance): save old draft, restore new
  useEffect(() => {
    if (prevDraftKeyRef.current !== draftKey) {
      addTodoDrafts.set(prevDraftKeyRef.current, textValueRef.current);
      setText(addTodoDrafts.get(draftKey) ?? "");
      prevDraftKeyRef.current = draftKey;
    }
  }, [draftKey]);

  // Save draft on unmount (covers branch switches, e.g. "All Projects" ↔ specific project)
  useEffect(() => {
    return () => {
      addTodoDrafts.set(prevDraftKeyRef.current, textValueRef.current);
    };
  }, []);
  const [mode, setMode] = useState<AddMode>("add");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);
  const [cmdSuggestions, setCmdSuggestions] = useState<CommandInfo[]>([]);
  const [todoSuggestions, setTodoSuggestions] = useState<Todo[]>([]);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const localRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = inputRef ?? localRef;
  const dropdownRef = useRef<HTMLDivElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const [modifierHeld, setModifierHeld] = useState(false);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [uploading, setUploading] = useState(false);

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
      const maxH = 150;
      const clamped = Math.min(el.scrollHeight, maxH);
      el.style.height = clamped + "px";
      el.style.overflowY = el.scrollHeight > maxH ? "auto" : "hidden";
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

  // Clean up blob URLs on unmount
  useEffect(() => {
    return () => {
      pendingImages.forEach((img) => URL.revokeObjectURL(img.previewUrl));
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Compute command suggestions based on cursor position
  const cmdFragment = useMemo(() => {
    const el = textareaRef.current;
    if (!el) return null;
    const cursorPos = el.selectionStart ?? text.length;
    const beforeCursor = text.slice(0, cursorPos);
    // Look for / that starts a command at/near cursor
    const match = beforeCursor.match(/(?:^|\s)\/([A-Za-z][A-Za-z0-9_-]*)$/);
    if (match) return match[1].toLowerCase();
    // Just typed /
    const slashMatch = beforeCursor.match(/(?:^|\s)\/$/);
    if (slashMatch) return "";
    return null;
  }, [text, textareaRef]);

  // Compute @ todo mention suggestions based on cursor position
  const mentionFragment = useMemo(() => {
    const el = textareaRef.current;
    if (!el) return null;
    const cursorPos = el.selectionStart ?? text.length;
    const beforeCursor = text.slice(0, cursorPos);
    // Look for @ followed by search text
    const match = beforeCursor.match(/(?:^|\s)@(.+)$/);
    if (match) return match[1].toLowerCase();
    // Just typed @
    const atMatch = beforeCursor.match(/(?:^|\s)@$/);
    if (atMatch) return "";
    return null;
  }, [text, textareaRef]);

  useEffect(() => {
    if (tagFragment === null) {
      setTagSuggestions([]);
      if (cmdFragment === null) setSelectedSuggestion(0);
      return;
    }
    const matches = allTags.filter((t) =>
      tagFragment === "" || t.startsWith(tagFragment)
    );
    setTagSuggestions(matches);
    setSelectedSuggestion(0);
  }, [tagFragment, allTags]);

  useEffect(() => {
    if (cmdFragment === null) {
      setCmdSuggestions([]);
      if (tagFragment === null && mentionFragment === null) setSelectedSuggestion(0);
      return;
    }
    const matches = commands.filter((c) =>
      cmdFragment === "" || c.name.startsWith(cmdFragment)
    );
    setCmdSuggestions(matches);
    setSelectedSuggestion(0);
  }, [cmdFragment, tagFragment, mentionFragment, commands]);

  // Compute todo mention suggestions
  useEffect(() => {
    if (mentionFragment === null) {
      setTodoSuggestions([]);
      if (tagFragment === null && cmdFragment === null) setSelectedSuggestion(0);
      return;
    }
    setTodoSuggestions(filterMentionSuggestions(allTodos, mentionFragment));
    setSelectedSuggestion(0);
  }, [mentionFragment, allTodos, tagFragment, cmdFragment]);

  const applyCmdSuggestion = (cmdName: string) => {
    const el = textareaRef.current;
    if (!el) return;
    const cursorPos = el.selectionStart ?? text.length;
    const beforeCursor = text.slice(0, cursorPos);
    const afterCursor = text.slice(cursorPos);
    const slashIdx = beforeCursor.lastIndexOf("/");
    if (slashIdx === -1) return;
    const newText = beforeCursor.slice(0, slashIdx) + "/" + cmdName + " " + afterCursor;
    setText(newText);
    setCmdSuggestions([]);
    setTimeout(() => {
      el.focus();
      const newCursorPos = slashIdx + 1 + cmdName.length + 1;
      el.setSelectionRange(newCursorPos, newCursorPos);
    }, 0);
  };

  const applyMentionSuggestion = (todo: Todo) => {
    const el = textareaRef.current;
    if (!el) return;
    const cursorPos = el.selectionStart ?? text.length;
    const beforeCursor = text.slice(0, cursorPos);
    const afterCursor = text.slice(cursorPos);
    // Find where the @ starts
    const atIdx = beforeCursor.lastIndexOf("@");
    if (atIdx === -1) return;
    const displayTitle = getTodoDisplayTitle(todo);
    // Replace @fragment with the todo reference marker
    const newText = beforeCursor.slice(0, atIdx) + `@[${displayTitle}](${todo.id}) ` + afterCursor;
    setText(newText);
    setTodoSuggestions([]);
    setTimeout(() => {
      el.focus();
      const newCursorPos = atIdx + `@[${displayTitle}](${todo.id}) `.length;
      el.setSelectionRange(newCursorPos, newCursorPos);
    }, 0);
  };

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

  const handleImageUpload = useCallback(async (files: File[]) => {
    const imageFiles = files.filter((f) => f.type.startsWith("image/"));
    if (imageFiles.length === 0) return;

    setUploading(true);
    try {
      for (const file of imageFiles) {
        try {
          const { filename } = await api.uploadImage(file);
          const previewUrl = URL.createObjectURL(file);
          setPendingImages((prev) => [...prev, { filename, previewUrl }]);
        } catch (err) {
          addToast(`Failed to upload image: ${apiErrorMessage(err)}`, "error");
        }
      }
    } finally {
      setUploading(false);
    }
  }, [addToast]);

  const removeImage = useCallback((idx: number) => {
    setPendingImages((prev) => {
      const removed = prev[idx];
      if (removed) {
        URL.revokeObjectURL(removed.previewUrl);
        api.deleteImage(removed.filename).catch(() => {});
      }
      return prev.filter((_, i) => i !== idx);
    });
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const imageFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }

    if (imageFiles.length > 0) {
      e.preventDefault(); // Don't paste image data as text
      handleImageUpload(imageFiles);
    }
  }, [handleImageUpload]);

  const switchMode = (m: AddMode) => {
    setMode(m);
    setDropdownOpen(false);
  };

  const handleAdd = async (overrideMode?: AddMode) => {
    const trimmed = text.trim();
    const pid = projectId ?? selectedProject;
    if ((!trimmed && pendingImages.length === 0) || !pid) {
      if (!pid) addToast("Select a project first", "warning");
      return;
    }

    const activeMode = overrideMode ?? mode;
    const shouldRun = activeMode === "add-run" || activeMode === "add-plan";
    const planOnly = activeMode === "add-plan";

    const imageFilenames = pendingImages.map((img) => img.filename);

    // Process @[title](id) references: extract context from referenced todos
    const mentionRe = /@\[([^\]]+)\]\(([^)]+)\)/g;
    let todoText = trimmed;
    const contextBlocks: string[] = [];
    let mentionMatch: RegExpExecArray | null;
    while ((mentionMatch = mentionRe.exec(trimmed)) !== null) {
      const refTitle = mentionMatch[1];
      const refId = mentionMatch[2];
      const refTodo = allTodos.find((t) => t.id === refId);
      if (refTodo) {
        const lastMsg = getLastClaudeMessage(refTodo);
        if (lastMsg) {
          contextBlocks.push(
            `--- Referenced todo: "${refTitle}" ---\n${lastMsg}\n--- End reference ---`
          );
        }
      }
      // Replace the @[title](id) with just @title in the displayed text
      todoText = todoText.replace(mentionMatch[0], `@${refTitle}`);
    }

    // Prepend context blocks if any references were found
    const finalText = contextBlocks.length > 0
      ? contextBlocks.join("\n\n") + "\n\n" + todoText
      : todoText;

    // Optimistic placeholder
    const tempId = `temp-${Date.now()}`;
    const placeholder: Todo = {
      id: tempId,
      project_id: pid,
      text: finalText || "(image attached)",
      status: "next",
      source: "user",
      completed_by_run: false,
      emoji: null,
      session_id: null,
      created_at: new Date().toISOString(),
      completed_at: null,
      original_text: null,
      run_output: null,
      run_status: shouldRun ? "queued" : null,
      run_trigger: shouldRun ? "manual" : null,
      btw_output: null,
      btw_status: null,
      run_started_at: null,
      is_read: true,
      plan_only: planOnly,
      plan_file: null,
      manual: false,
      is_command: false,
      sort_order: -Infinity,
      user_ordered: false,
      stale_reason: null,
      rejected_at: null,
      images: imageFilenames.map((f) => ({ filename: f, added_at: new Date().toISOString(), source: "creation" as const })),
      pending_followup: null,
      red_flags: [],
    };
    onOptimisticUpdate((todos) => [placeholder, ...todos]);
    setText("");
    addTodoDrafts.delete(draftKey);
    // Clean up preview URLs (server has the files now)
    pendingImages.forEach((img) => URL.revokeObjectURL(img.previewUrl));
    setPendingImages([]);

    // If offline, keep the placeholder visible but don't try the API
    if (isOffline) {
      addToast("You're offline — item shown but not saved (will be lost on refresh)", "warning");
      return;
    }

    try {
      const created = await api.createTodo(pid, finalText || "(image attached)", planOnly, imageFilenames);
      if (shouldRun) {
        try {
          const result = await api.runTodo(created.id);
          if (result.status === "queued") {
            addToast(`Added & queued "${todoText}"${planOnly ? " (plan only)" : ""}`, "info");
          } else {
            addToast(`Added & ${planOnly ? "planning" : "running"} "${todoText}"`, "info");
          }
        } catch (err) {
          addToast(`Added todo but failed to run: ${apiErrorMessage(err)}`, "error");
        }
      }
      onRefresh();
    } catch {
      onOptimisticUpdate((todos) => todos.filter((t) => t.id !== tempId));
      setText(trimmed);
      addToast(`Failed to add "${todoText}"`, "error");
    }
  };

  const needsProjectSelector = !projectId && projects && projects.length > 0;

  const effectiveMode = modifierHeld ? "add-run" : mode;
  const modeIcons: Record<AddMode, string> = { "add": "+", "add-run": "▶", "add-plan": "📋" };
  const modeLabels: Record<AddMode, string> = { "add": "Add", "add-run": "Add & Run", "add-plan": "Add & Plan" };
  const icon = modeIcons[effectiveMode];
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
          placeholder={isOffline ? "Add a todo (offline — not saved, will be lost on refresh)" : disabled ? "Server offline — changes disabled" : "Add a todo... (Ctrl+Enter to add & run, # for tags, @ to reference, paste images)"}
          value={text}
          rows={1}
          disabled={disabled && !isOffline}
          onChange={(e) => setText(e.target.value)}
          ref={textareaRef}
          onPaste={handlePaste}
          onKeyDown={(e) => {
            // Handle suggestion navigation (tags, commands, or todo mentions)
            const hasSuggestions = tagSuggestions.length > 0 || cmdSuggestions.length > 0 || todoSuggestions.length > 0;
            const suggestionCount = tagSuggestions.length || cmdSuggestions.length || todoSuggestions.length;
            if (hasSuggestions) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelectedSuggestion((s) => Math.min(s + 1, suggestionCount - 1));
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelectedSuggestion((s) => Math.max(s - 1, 0));
                return;
              }
              if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                if (tagSuggestions.length > 0 && tagSuggestions[selectedSuggestion]) {
                  e.preventDefault();
                  applySuggestion(tagSuggestions[selectedSuggestion]);
                  return;
                }
                if (cmdSuggestions.length > 0 && cmdSuggestions[selectedSuggestion]) {
                  e.preventDefault();
                  applyCmdSuggestion(cmdSuggestions[selectedSuggestion].name);
                  return;
                }
                if (todoSuggestions.length > 0 && todoSuggestions[selectedSuggestion]) {
                  e.preventDefault();
                  applyMentionSuggestion(todoSuggestions[selectedSuggestion]);
                  return;
                }
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setTagSuggestions([]);
                setCmdSuggestions([]);
                setTodoSuggestions([]);
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
        {pendingImages.length > 0 && (
          <div className="add-todo-images">
            {pendingImages.map((img, idx) => (
              <div key={img.filename} className="add-todo-image-thumb">
                <img src={img.previewUrl} alt={`Attachment ${idx + 1}`} />
                <button
                  className="add-todo-image-remove"
                  onClick={() => removeImage(idx)}
                  title="Remove image"
                >
                  ×
                </button>
              </div>
            ))}
            <div className="add-todo-images-warning">
              Images stored in /tmp — may be cleared on reboot
            </div>
          </div>
        )}
        {uploading && <div className="add-todo-uploading">Uploading image...</div>}
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
        {cmdSuggestions.length > 0 && (
          <div className="cmd-suggestions" ref={suggestionsRef}>
            {cmdSuggestions.map((cmd, i) => (
              <button
                key={cmd.name}
                className={`cmd-suggestion-item${i === selectedSuggestion ? " selected" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  applyCmdSuggestion(cmd.name);
                }}
              >
                <span className="cmd-suggestion-name">/{cmd.name}</span>
                <span className={`cmd-suggestion-type cmd-type-${cmd.type}`}>{cmd.type}</span>
                <span className="cmd-suggestion-desc">{cmd.description}</span>
              </button>
            ))}
          </div>
        )}
        {todoSuggestions.length > 0 && (
          <div className="mention-suggestions" ref={suggestionsRef}>
            {todoSuggestions.map((todo, i) => (
              <button
                key={todo.id}
                className={`mention-suggestion-item${i === selectedSuggestion ? " selected" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  applyMentionSuggestion(todo);
                }}
              >
                <span className="mention-suggestion-title">{getTodoDisplayTitle(todo)}</span>
                <span className="mention-suggestion-status">{todo.run_status ?? todo.status}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="add-todo-split-btn" ref={dropdownRef}>
        <button className="add-todo-main-btn" onClick={() => handleAdd(effectiveMode)} disabled={disabled && !isOffline} title={modeLabels[effectiveMode]}>{icon}</button>
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
              <button key={m} onClick={() => switchMode(m)}><span className="add-todo-dropdown-icon">{modeIcons[m]}</span> {modeLabels[m]}</button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
