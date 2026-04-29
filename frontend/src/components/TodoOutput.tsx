import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import type { Todo } from "../types";
import { api } from "../api";
import { apiErrorMessage } from "../errors";
import { type CommandInfo } from "../utils/commands";
import { useAppContext } from "../contexts/AppContext";

interface Props {
  todo: Todo;
  showOutput: boolean;
  disabled?: boolean;
  allCommands?: CommandInfo[];
}

/** Must match backend OUTPUT_MAX_CHARS in run_manager.py */
const OUTPUT_MAX_CHARS = 500_000;
const OUTPUT_WARNING_THRESHOLD = 0.9; // warn at 90%

const FOLLOWUP_RE = /\n\n--- (?:Follow-up(?: \(queued\))?|BTW|Resumed in CLI) ---\n\*\*You:\*\* /;
/** Structured end-of-user-message marker used by the backend. */
const END_USER_MSG = "\n<<END_USER_MSG>>\n";

/**
 * Detect markdown pipe tables in text and render them as HTML <table> elements.
 * Non-table text is returned as-is in a fragment.
 */
function renderTextWithTables(text: string): React.ReactNode {
  const lines = text.split("\n");
  const segments: { type: "text" | "table"; lines: string[] }[] = [];
  let current: { type: "text" | "table"; lines: string[] } | null = null;

  for (const line of lines) {
    const isTableLine = /^\s*\|/.test(line);
    if (isTableLine) {
      if (current?.type === "table") {
        current.lines.push(line);
      } else {
        if (current) segments.push(current);
        current = { type: "table", lines: [line] };
      }
    } else {
      if (current?.type === "text") {
        current.lines.push(line);
      } else {
        if (current) segments.push(current);
        current = { type: "text", lines: [line] };
      }
    }
  }
  if (current) segments.push(current);

  // If no tables found, return original text
  if (!segments.some((s) => s.type === "table")) return text;

  return (
    <>
      {segments.map((seg, i) => {
        if (seg.type === "text") {
          // Preserve the newlines between text lines
          return <span key={i}>{seg.lines.join("\n")}</span>;
        }
        // Parse markdown table
        const rows = seg.lines
          .filter((l) => !/^\s*\|[\s\-:|]+\|\s*$/.test(l)) // skip separator rows like |---|---|
          .map((l) =>
            l.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim())
          );
        if (rows.length === 0) return <span key={i}>{seg.lines.join("\n")}</span>;
        const header = rows[0];
        const body = rows.slice(1);
        return (
          <span key={i}>
            {"\n"}
            <table className="output-table">
              <thead>
                <tr>{header.map((cell, j) => <th key={j}>{cell}</th>)}</tr>
              </thead>
              {body.length > 0 && (
                <tbody>
                  {body.map((row, ri) => (
                    <tr key={ri}>{row.map((cell, ci) => <td key={ci}>{cell}</td>)}</tr>
                  ))}
                </tbody>
              )}
            </table>
            {"\n"}
          </span>
        );
      })}
    </>
  );
}

function renderOutput(text: string) {
  const parts = text.split(FOLLOWUP_RE);
  if (parts.length === 1) return renderTextWithTables(text);

  const elements: (string | React.ReactNode)[] = [parts[0]];
  // After each split point, we have the user's message + rest of output
  let matchIndex = 0;
  let searchFrom = 0;
  for (let i = 1; i < parts.length; i++) {
    // Find which variant matched so we can reconstruct the header
    const queuedMatch = text.indexOf("\n\n--- Follow-up (queued) ---\n**You:** ", searchFrom);
    const normalMatch = text.indexOf("\n\n--- Follow-up ---\n**You:** ", searchFrom);
    const btwMatch = text.indexOf("\n\n--- BTW ---\n**You:** ", searchFrom);
    const cliMatch = text.indexOf("\n\n--- Resumed in CLI ---\n**You:** ", searchFrom);

    // Find the earliest match among all variants
    const candidates = [
      { pos: queuedMatch, header: "Follow-up (queued)", full: "\n\n--- Follow-up (queued) ---\n**You:** " },
      { pos: normalMatch, header: "Follow-up", full: "\n\n--- Follow-up ---\n**You:** " },
      { pos: btwMatch, header: "BTW", full: "\n\n--- BTW ---\n**You:** " },
      { pos: cliMatch, header: "Resumed in CLI", full: "\n\n--- Resumed in CLI ---\n**You:** " },
    ].filter(c => c.pos !== -1);
    candidates.sort((a, b) => a.pos - b.pos);
    const match = candidates[0];

    const headerText = match.header;
    searchFrom = match.pos + match.full.length;

    // Split the part into the user message and rest using the structured
    // <<END_USER_MSG>> marker. Falls back to first blank line for old data.
    const endMarkerIdx = parts[i].indexOf(END_USER_MSG);
    let userMsg: string;
    let rest: string;
    if (endMarkerIdx !== -1) {
      userMsg = parts[i].slice(0, endMarkerIdx);
      rest = parts[i].slice(endMarkerIdx + END_USER_MSG.length);
    } else {
      // Legacy fallback: split at first blank line
      const blankLineIdx = parts[i].indexOf("\n\n");
      userMsg = blankLineIdx === -1 ? parts[i] : parts[i].slice(0, blankLineIdx);
      rest = blankLineIdx === -1 ? "" : parts[i].slice(blankLineIdx);
    }

    // Extract image badge if present (e.g. " [+2 images]")
    const imgBadgeMatch = userMsg.match(/ \[\+\d+ images?\]$/);
    const msgText = imgBadgeMatch ? userMsg.slice(0, imgBadgeMatch.index) : userMsg;
    const imgBadge = imgBadgeMatch ? imgBadgeMatch[0].trim() : null;

    elements.push(
      <span key={`followup-${matchIndex}`} className="followup-marker">
        {"\n\n"}
        <span className="followup-header">{"── " + headerText + " ──"}</span>
        {"\n"}
        <span className="followup-user-msg">
          {"▶ You: " + msgText}
          {imgBadge && <span className="followup-img-badge">{" " + imgBadge}</span>}
        </span>
      </span>
    );
    if (rest) elements.push(rest);
    matchIndex++;
  }
  // Process string segments through table renderer
  const processed = elements.map((el, i) =>
    typeof el === "string" ? <span key={`txt-${i}`}>{renderTextWithTables(el)}</span> : el
  );
  return <>{processed}</>;
}

function renderBtwOutput(text: string) {
  // Normalize: prepend a BTW separator so renderOutput can handle the whole thing uniformly
  const normalized = "\n\n--- BTW ---\n" + text;
  return renderOutput(normalized);
}

type OutputTab = "run" | "btw";

// Drafts persist in localStorage so an in-progress follow-up/btw message survives
// status transitions (which can unmount/remount the TodoItem) and page reloads.
const FOLLOWUP_DRAFT_PREFIX = "claude-todos:followup-draft:";
const BTW_DRAFT_PREFIX = "claude-todos:btw-draft:";

function readDraft(prefix: string, todoId: string): string {
  try {
    return localStorage.getItem(prefix + todoId) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(prefix: string, todoId: string, text: string): void {
  try {
    if (text) localStorage.setItem(prefix + todoId, text);
    else localStorage.removeItem(prefix + todoId);
  } catch {
    // ignore quota / unavailable storage
  }
}

export function TodoOutput({ todo, showOutput, disabled = false, allCommands }: Props) {
  const { addToast, onRefresh } = useAppContext();
  const commands = allCommands ?? [];
  const [followupText, setFollowupText] = useState(() => readDraft(FOLLOWUP_DRAFT_PREFIX, todo.id));
  const [btwText, setBtwText] = useState(() => readDraft(BTW_DRAFT_PREFIX, todo.id));

  // Keep refs for synchronous reads in transfer effect
  const followupTextRef = useRef(followupText);
  followupTextRef.current = followupText;
  const btwTextRef = useRef(btwText);
  btwTextRef.current = btwText;

  // Persist drafts on every change so they survive remounts (e.g. analyzer
  // moving the todo from "waiting" to "completed" causes the TodoItem to
  // unmount in the active section and remount in the done-group).
  useEffect(() => {
    writeDraft(FOLLOWUP_DRAFT_PREFIX, todo.id, followupText);
  }, [followupText, todo.id]);
  useEffect(() => {
    writeDraft(BTW_DRAFT_PREFIX, todo.id, btwText);
  }, [btwText, todo.id]);
  const [activeTab, setActiveTab] = useState<OutputTab>("run");
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pendingImages, setPendingImages] = useState<{ filename: string; previewUrl: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);
  const btwOutputRef = useRef<HTMLPreElement>(null);
  const runPinnedToBottom = useRef(true);
  const btwPinnedToBottom = useRef(true);
  const followupRef = useRef<HTMLTextAreaElement>(null);
  const btwInputRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  const [altHeld, setAltHeld] = useState(false);

  // Track Alt key for follow-up button label
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.key === "Alt") setAltHeld(true); };
    const up = (e: KeyboardEvent) => { if (e.key === "Alt") setAltHeld(false); };
    const blur = () => setAltHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  const [editingFollowup, setEditingFollowup] = useState(false);
  const [editFollowupText, setEditFollowupText] = useState("");
  const editFollowupRef = useRef<HTMLTextAreaElement>(null);

  // Command autocomplete state (shared — only one input visible at a time)
  const [cmdSuggestions, setCmdSuggestions] = useState<CommandInfo[]>([]);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const suggestionsRef = useRef<HTMLDivElement>(null);

  const isRunning = todo.run_status === "running";
  const showFollowup = todo.session_id && !isRunning &&
    (todo.run_status === "done" || todo.run_status === "error" || todo.run_status === "stopped");
  // Track which input is "active" for suggestions: the text value that's currently being edited
  const activeInputText = showFollowup ? followupText : btwText;
  const showBtw = isRunning;
  const hasBtwOutput = !!todo.btw_output;
  const isBtwRunning = todo.btw_status === "running";
  const hasQueuedFollowup = !!todo.pending_followup;
  const isQueuedFollowup = (todo.run_status === "queued" || isRunning) && hasQueuedFollowup;

  // When run finishes/stops, transfer any in-progress BTW text to the follow-up input
  const prevRunStatusRef = useRef(todo.run_status);
  useEffect(() => {
    const prev = prevRunStatusRef.current;
    prevRunStatusRef.current = todo.run_status;
    if (prev === "running" && prev !== todo.run_status && btwTextRef.current) {
      setFollowupText(btwTextRef.current);
      setBtwText("");
    }
  }, [todo.run_status, todo.id]);

  // Reset edit state when the todo is no longer queued
  useEffect(() => {
    if (!isQueuedFollowup) setEditingFollowup(false);
  }, [isQueuedFollowup]);

  // Auto-focus edit input when entering edit mode
  useEffect(() => {
    if (editingFollowup && editFollowupRef.current) {
      editFollowupRef.current.focus();
    }
  }, [editingFollowup]);

  const startEditFollowup = () => {
    setEditFollowupText(todo.pending_followup ?? "");
    setEditingFollowup(true);
  };

  const saveEditFollowup = async () => {
    const trimmed = editFollowupText.trim();
    if (!trimmed) return;
    try {
      await api.editFollowup(todo.id, trimmed);
      setEditingFollowup(false);
      addToast("Queued follow-up updated", "success");
      onRefresh();
    } catch {
      addToast("Failed to update queued follow-up", "error");
    }
  };

  const cancelEditFollowup = () => {
    setEditingFollowup(false);
  };

  const deleteQueuedFollowup = async () => {
    try {
      await api.cancelFollowup(todo.id);
      setEditingFollowup(false);
      addToast("Queued follow-up removed", "success");
      onRefresh();
    } catch {
      addToast("Failed to remove queued follow-up", "error");
    }
  };

  // Auto-switch to btw tab when a new btw starts
  useEffect(() => {
    if (isBtwRunning && showOutput) {
      setActiveTab("btw");
    }
  }, [isBtwRunning, showOutput]);

  // Re-pin to bottom when output is first opened or tab switches
  useEffect(() => {
    if (showOutput) {
      runPinnedToBottom.current = true;
      btwPinnedToBottom.current = true;
      if (activeTab === "run" && outputRef.current) {
        outputRef.current.scrollTop = outputRef.current.scrollHeight;
      }
      if (activeTab === "btw" && btwOutputRef.current) {
        btwOutputRef.current.scrollTop = btwOutputRef.current.scrollHeight;
      }
    }
  }, [showOutput, activeTab]);

  // Auto-scroll output to bottom as it streams (only if pinned)
  useEffect(() => {
    if (showOutput && activeTab === "run" && outputRef.current && runPinnedToBottom.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [showOutput, activeTab, todo.run_output]);

  // Auto-scroll btw output (only if pinned)
  useEffect(() => {
    if (showOutput && activeTab === "btw" && btwOutputRef.current && btwPinnedToBottom.current) {
      btwOutputRef.current.scrollTop = btwOutputRef.current.scrollHeight;
    }
  }, [showOutput, activeTab, todo.btw_output]);

  // Auto-focus follow-up input when output is opened and follow-up bar is visible
  useEffect(() => {
    if (showOutput && showFollowup && followupRef.current) {
      followupRef.current.focus();
    }
  }, [showOutput, showFollowup]);

  // Command autocomplete: compute fragment from active input text
  const cmdFragment = useMemo(() => {
    const text = activeInputText;
    if (!text) return null;
    // Match / at start or after whitespace, followed by partial command name
    const match = text.match(/(?:^|\s)\/([A-Za-z][A-Za-z0-9_-]*)$/);
    if (match) return match[1].toLowerCase();
    // Just typed /
    const slashMatch = text.match(/(?:^|\s)\/$/);
    if (slashMatch) return "";
    return null;
  }, [activeInputText]);

  // Filter command suggestions when fragment changes
  useEffect(() => {
    if (cmdFragment === null) {
      setCmdSuggestions([]);
      setSelectedSuggestion(0);
      return;
    }
    const matches = commands.filter((c) =>
      cmdFragment === "" || c.name.startsWith(cmdFragment)
    );
    setCmdSuggestions(matches);
    setSelectedSuggestion(0);
  }, [cmdFragment, commands]);

  // Auto-resize helper for textarea elements
  const autoResize = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    const maxH = 150;
    const clamped = Math.min(el.scrollHeight, maxH);
    el.style.height = clamped + "px";
    el.style.overflowY = el.scrollHeight > maxH ? "auto" : "hidden";
  }, []);

  // Auto-resize follow-up textarea
  useEffect(() => { autoResize(followupRef.current); }, [followupText, autoResize]);
  // Auto-resize btw textarea
  useEffect(() => { autoResize(btwInputRef.current); }, [btwText, autoResize]);
  // Auto-resize edit follow-up textarea
  useEffect(() => { autoResize(editFollowupRef.current); }, [editFollowupText, autoResize]);

  type InputOrTextArea = HTMLInputElement | HTMLTextAreaElement;

  const applyCmdSuggestion = (cmdName: string, inputRef: React.RefObject<InputOrTextArea | null>, setText: (v: string) => void, text: string) => {
    const el = inputRef.current;
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

  const handleCmdKeyDown = (e: React.KeyboardEvent, inputRef: React.RefObject<InputOrTextArea | null>, setText: (v: string) => void, text: string): boolean => {
    if (cmdSuggestions.length === 0) return false;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedSuggestion((s) => Math.min(s + 1, cmdSuggestions.length - 1));
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedSuggestion((s) => Math.max(s - 1, 0));
      return true;
    }
    if (e.key === "Tab" || e.key === "Enter") {
      if (cmdSuggestions[selectedSuggestion]) {
        e.preventDefault();
        applyCmdSuggestion(cmdSuggestions[selectedSuggestion].name, inputRef, setText, text);
        return true;
      }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setCmdSuggestions([]);
      return true;
    }
    return false;
  };

  // Clean up blob URLs on unmount
  useEffect(() => {
    return () => {
      pendingImages.forEach((img) => URL.revokeObjectURL(img.previewUrl));
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  const handleFollowupPaste = useCallback((e: React.ClipboardEvent) => {
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
      e.preventDefault();
      handleImageUpload(imageFiles);
    }
  }, [handleImageUpload]);

  const sendFollowup = async (planOnly: boolean) => {
    if (disabled) {
      addToast("You're offline — follow-ups aren't available right now", "warning");
      return;
    }
    const msg = followupText.trim();
    if (!msg && pendingImages.length === 0) return;
    try {
      const imageFilenames = pendingImages.map((img) => img.filename);
      const result = await api.followupTodo(todo.id, msg, imageFilenames, planOnly);
      setFollowupText("");
      // Revoke preview URLs
      pendingImages.forEach((img) => URL.revokeObjectURL(img.previewUrl));
      setPendingImages([]);
      if (result.status === "queued") {
        addToast(`Follow-up queued — will ${planOnly ? "plan" : "run"} when the current task finishes`, "info");
      } else {
        addToast(planOnly ? "Plan-only follow-up sent" : "Follow-up sent", "info");
      }
      onRefresh();
    } catch {
      addToast("Failed to send follow-up", "error");
    }
  };

  const sendRunningMessage = async (planOnly = false) => {
    if (disabled) {
      addToast("You're offline — messages aren't available right now", "warning");
      return;
    }
    const raw = btwText.trim();
    if (!raw && pendingImages.length === 0) return;

    // When btw tab is active, all messages go to btw (no /btw prefix needed)
    const onBtwTab = activeTab === "btw";
    const isBtwMessage = onBtwTab || /^\/btw\b/i.test(raw);
    if (isBtwMessage) {
      const msg = onBtwTab ? raw : raw.replace(/^\/btw\s*/i, "").trim();
      if (!msg) return;
      try {
        await api.btwTodo(todo.id, msg);
        setBtwText("");
        addToast("/btw started — running in parallel", "info");
        onRefresh();
      } catch (err) {
        const detail = err instanceof Error ? err.message : "Failed to send /btw";
        addToast(detail, "error");
      }
    } else {
      // Default: queue as a follow-up that runs after the current run finishes
      try {
        const imageFilenames = pendingImages.map((img) => img.filename);
        const result = await api.followupTodo(todo.id, raw, imageFilenames, planOnly);
        setBtwText("");
        // Revoke preview URLs
        pendingImages.forEach((img) => URL.revokeObjectURL(img.previewUrl));
        setPendingImages([]);
        if (result.status === "queued") {
          addToast(`Follow-up queued — will ${planOnly ? "plan" : "run"} when the current task finishes`, "info");
        } else {
          addToast(planOnly ? "Plan-only follow-up sent" : "Follow-up sent", "info");
        }
        onRefresh();
      } catch (err) {
        const detail = err instanceof Error ? err.message : "Failed to queue follow-up";
        addToast(detail, "error");
      }
    }
  };

  const copyOutput = useCallback((text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, []);

  const outputLen = todo.run_output?.length ?? 0;
  const outputPct = outputLen / OUTPUT_MAX_CHARS;
  const isNearLimit = outputPct >= OUTPUT_WARNING_THRESHOLD;
  const isTruncated = todo.run_output?.includes("--- Output truncated ---") ?? false;

  if (!showOutput) return null;

  const showTabs = hasBtwOutput;

  return (
    <>
      {/* Tab bar — only shown when btw output exists */}
      {showTabs && (
        <div
          className="output-tabs"
          draggable={false}
          onMouseDown={(e) => e.stopPropagation()}
          onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
        >
          <button
            className={`output-tab${activeTab === "run" ? " active" : ""}`}
            onClick={() => setActiveTab("run")}
          >
            Run
          </button>
          <button
            className={`output-tab${activeTab === "btw" ? " active" : ""}${isBtwRunning ? " tab-running" : ""}`}
            onClick={() => setActiveTab("btw")}
          >
            /btw{isBtwRunning ? " ⟳" : ""}
            {todo.btw_status === "error" && " ✗"}
          </button>
        </div>
      )}

      {/* Red flags — coping phrase warnings and AI-raised flags */}
      {(!showTabs || activeTab === "run") && todo.red_flags && todo.red_flags.length > 0 && (() => {
        const unresolvedCount = todo.red_flags.filter((f) => !f.resolved).length;
        const resolvedCount = todo.red_flags.filter((f) => f.resolved).length;
        const unresolvedAi = todo.red_flags.filter((f) => !f.resolved && f.source === "ai").length;
        const unresolvedPattern = todo.red_flags.filter((f) => !f.resolved && f.source !== "ai").length;
        const allResolved = unresolvedCount === 0;
        const hasOnlyAi = unresolvedAi > 0 && unresolvedPattern === 0;
        const headerParts: string[] = [];
        if (unresolvedPattern > 0) headerParts.push(`${unresolvedPattern} red flag${unresolvedPattern > 1 ? "s" : ""}`);
        if (unresolvedAi > 0) headerParts.push(`${unresolvedAi} AI flag${unresolvedAi > 1 ? "s" : ""}`);
        return (
          <div
            className={`red-flags${allResolved ? " all-resolved" : hasOnlyAi ? " ai-only" : ""}`}
            draggable={false}
            onMouseDown={(e) => e.stopPropagation()}
            onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
          >
            <div className={`red-flags-header${allResolved ? " resolved" : hasOnlyAi ? " ai" : ""}`}>
              {allResolved
                ? `All ${resolvedCount} flag${resolvedCount > 1 ? "s" : ""} resolved ✓`
                : `Flags raised — ${headerParts.join(", ")}${resolvedCount > 0 ? ` (${resolvedCount} resolved)` : ""}`}
            </div>
            {todo.red_flags.map((flag, i) => (
              <div key={i} className={`red-flag-item${flag.resolved ? " resolved" : ""}${flag.source === "ai" ? " ai-flag" : ""}`}>
                <div className="red-flag-row">
                  <span className={`red-flag-label${flag.resolved ? " resolved" : ""}${flag.source === "ai" ? " ai" : ""}`}>
                    {flag.resolved ? "✓ " : ""}{flag.source === "ai" ? "🤖 " : ""}{flag.label}
                  </span>
                  <span className="red-flag-actions">
                    <button
                      className={`red-flag-resolve-btn${flag.resolved ? " resolved" : ""}${flag.source === "ai" ? " ai" : ""}`}
                      onClick={async () => {
                        try {
                          await api.resolveRedFlag(todo.id, i, !flag.resolved);
                          onRefresh();
                        } catch {
                          addToast("Failed to update flag", "error");
                        }
                      }}
                      title={flag.resolved ? "Mark as unresolved" : "Mark as resolved"}
                    >
                      {flag.resolved ? "reopen" : "resolve"}
                    </button>
                    <button
                      className="red-flag-dismiss-btn"
                      onClick={async () => {
                        try {
                          await api.dismissRedFlag(todo.id, i);
                          onRefresh();
                        } catch {
                          addToast("Failed to dismiss flag", "error");
                        }
                      }}
                      title="Dismiss — remove this flag (irrelevant)"
                    >
                      ×
                    </button>
                  </span>
                </div>
                <span className="red-flag-explanation">{flag.explanation}</span>
                {flag.excerpt && <span className="red-flag-excerpt">"{flag.excerpt}"</span>}
              </div>
            ))}
          </div>
        );
      })()}

      {/* Run output tab */}
      {(!showTabs || activeTab === "run") && todo.run_output && (
        <div
          className="run-output"
          draggable={false}
          onMouseDown={(e) => e.stopPropagation()}
          onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
        >
          <div className="output-toolbar">
            <button
              className="output-toolbar-btn"
              onClick={() => copyOutput(todo.run_output!)}
              title="Copy output"
            >
              {copied ? "\u2713" : "\u2398"}
            </button>
            <button
              className="output-toolbar-btn"
              onClick={() => setExpanded(e => !e)}
              title={expanded ? "Collapse output" : "Expand output"}
            >
              {expanded ? "⤡" : "⤢"}
            </button>
          </div>
          <pre ref={outputRef} className={expanded ? "expanded" : ""} onScroll={(e) => {
            const el = e.currentTarget;
            runPinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
          }}>{renderOutput(todo.run_output)}</pre>
        </div>
      )}

      {/* Edit bar for queued follow-ups (non-running state, e.g. queued behind another project todo) */}
      {(!showTabs || activeTab === "run") && isQueuedFollowup && !isRunning && (
        <div className="followup-edit-bar" draggable={false} onMouseDown={(e) => e.stopPropagation()} onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}>
          {editingFollowup ? (
            <div className="followup-edit-row">
              <textarea
                ref={editFollowupRef}
                className="followup-input"
                rows={1}
                value={editFollowupText}
                onChange={(e) => setEditFollowupText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveEditFollowup(); }
                  if (e.key === "Escape") { e.preventDefault(); cancelEditFollowup(); }
                }}
                placeholder="Edit queued follow-up..."
              />
              <button className="btn-icon btn-save" onClick={saveEditFollowup} title="Save edit">&#x2713;</button>
              <button className="btn-icon btn-cancel" onClick={cancelEditFollowup} title="Cancel edit">&#x2717;</button>
            </div>
          ) : (
            <div className="followup-edit-row">
              <span className="followup-queued-label">Queued follow-up</span>
              <button className="btn-icon btn-edit-followup" onClick={startEditFollowup} disabled={disabled} title="Edit queued follow-up">&#x270E;</button>
              <button className="btn-icon btn-cancel" onClick={deleteQueuedFollowup} disabled={disabled} title="Remove queued follow-up">&#x2717;</button>
            </div>
          )}
        </div>
      )}

      {/* BTW output tab */}
      {showTabs && activeTab === "btw" && todo.btw_output && (
        <div
          className="run-output btw-output"
          draggable={false}
          onMouseDown={(e) => e.stopPropagation()}
          onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
        >
          <div className="output-toolbar">
            <button
              className="output-toolbar-btn"
              onClick={() => copyOutput(todo.btw_output!)}
              title="Copy output"
            >
              {copied ? "\u2713" : "\u2398"}
            </button>
            <button
              className="output-toolbar-btn"
              onClick={() => setExpanded(e => !e)}
              title={expanded ? "Collapse output" : "Expand output"}
            >
              {expanded ? "⤡" : "⤢"}
            </button>
          </div>
          <pre ref={btwOutputRef} className={expanded ? "expanded" : ""} onScroll={(e) => {
            const el = e.currentTarget;
            btwPinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
          }}>{renderBtwOutput(todo.btw_output)}</pre>
        </div>
      )}

      {/* Edit bar for follow-up queued on a running todo (hidden on btw tab) */}
      {showBtw && isQueuedFollowup && activeTab !== "btw" && (
        <div className="followup-edit-bar" draggable={false} onMouseDown={(e) => e.stopPropagation()} onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}>
          {editingFollowup ? (
            <div className="followup-edit-row">
              <textarea
                ref={editFollowupRef}
                className="followup-input"
                rows={1}
                value={editFollowupText}
                onChange={(e) => setEditFollowupText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveEditFollowup(); }
                  if (e.key === "Escape") { e.preventDefault(); cancelEditFollowup(); }
                }}
                placeholder="Edit queued follow-up..."
              />
              <button className="btn-icon btn-save" onClick={saveEditFollowup} title="Save edit">&#x2713;</button>
              <button className="btn-icon btn-cancel" onClick={cancelEditFollowup} title="Cancel edit">&#x2717;</button>
            </div>
          ) : (
            <div className="followup-edit-row">
              <span className="followup-queued-label">Follow-up queued</span>
              <button className="btn-icon btn-edit-followup" onClick={startEditFollowup} disabled={disabled} title="Edit queued follow-up">&#x270E;</button>
              <button className="btn-icon btn-cancel" onClick={deleteQueuedFollowup} disabled={disabled} title="Remove queued follow-up">&#x2717;</button>
            </div>
          )}
        </div>
      )}

      {/* Message bar — shown when main run is active; on btw tab all messages go to btw, on run tab default queues follow-up */}
      {showBtw && (!hasQueuedFollowup || activeTab === "btw") && (
        <div className="followup-bar btw-bar followup-bar-with-images" draggable={false} onMouseDown={(e) => e.stopPropagation()} onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}>
          {pendingImages.length > 0 && (
            <div className="followup-image-previews">
              {pendingImages.map((img, idx) => (
                <div key={img.filename} className="followup-image-thumb">
                  <img src={img.previewUrl} alt={`Attached ${idx + 1}`} />
                  <button className="followup-image-remove" onClick={() => removeImage(idx)} title="Remove image">×</button>
                </div>
              ))}
              {uploading && <div className="followup-image-thumb uploading">…</div>}
            </div>
          )}
          <div className="followup-input-row">
            <button
              className="btn-icon btn-attach"
              onClick={() => imageInputRef.current?.click()}
              disabled={disabled || uploading}
              title="Attach image"
            >📎</button>
            <input
              type="file"
              ref={imageInputRef}
              accept="image/*"
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                if (e.target.files) handleImageUpload(Array.from(e.target.files));
                e.target.value = "";
              }}
            />
            <div className="followup-input-wrapper">
              <textarea
                ref={btwInputRef}
                className="followup-input"
                rows={1}
                placeholder={disabled ? "Server offline — changes disabled" : isBtwRunning ? "/btw running — wait for it to finish..." : activeTab === "btw" ? "Send /btw message (runs in parallel)..." : "Queue follow-up for when this finishes (or /btw for side-channel)..."}
                value={btwText}
                disabled={disabled}
                onChange={(e) => setBtwText(e.target.value)}
                onPaste={handleFollowupPaste}
                onKeyDown={(e) => {
                  if (handleCmdKeyDown(e, btwInputRef, setBtwText, btwText)) return;
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendRunningMessage(e.altKey);
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    (e.target as HTMLElement).blur();
                    api.stopTodo(todo.id).then(() => {
                      addToast(`Paused "${todo.text}" — use follow-up to continue`, "info");
                      onRefresh();
                    }).catch(() => {
                      addToast(`Failed to pause "${todo.text}"`, "error");
                    });
                  }
                }}
              />
              {!showFollowup && cmdSuggestions.length > 0 && (
                <div className="cmd-suggestions" ref={suggestionsRef}>
                  {cmdSuggestions.map((cmd, i) => (
                    <button
                      key={cmd.name}
                      className={`cmd-suggestion-item${i === selectedSuggestion ? " selected" : ""}`}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        applyCmdSuggestion(cmd.name, btwInputRef, setBtwText, btwText);
                      }}
                    >
                      <span className="cmd-suggestion-name">/{cmd.name}</span>
                      <span className={`cmd-suggestion-type cmd-type-${cmd.type}`}>{cmd.type}</span>
                      <span className="cmd-suggestion-desc">{cmd.description}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              className={`btn-icon ${altHeld && activeTab === "run" ? "btn-plan" : "btn-run"}`}
              onClick={() => sendRunningMessage(altHeld && activeTab === "run")}
              disabled={disabled}
              title={altHeld && activeTab === "run" ? "Queue plan-only follow-up (Alt+Enter)" : activeTab === "run" ? "Queue follow-up (Enter) · Hold ⌥ for plan-only" : "Send message (Enter)"}
            >{altHeld && activeTab === "run" ? "📋" : "↵"}</button>
          </div>
        </div>
      )}
      {/* Idle session warning — prompt cache likely expired after 1h */}
      {showFollowup && (() => {
        if (!todo.run_finished_at) return null;
        const finishedAt = new Date(todo.run_finished_at).getTime();
        const idleMs = Date.now() - finishedAt;
        const IDLE_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour
        if (idleMs < IDLE_THRESHOLD_MS) return null;
        const idleHours = Math.round(idleMs / (60 * 60 * 1000) * 10) / 10;
        const idleLabel = idleHours >= 24
          ? `${Math.round(idleHours / 24)}d`
          : idleHours >= 1 ? `${idleHours}h` : `${Math.round(idleMs / 60000)}m`;
        // True context size from last turn (not accumulated across follow-ups)
        const contextTokens = todo.run_context_tokens ?? 0;
        const contextLabel = contextTokens >= 1000
          ? `~${Math.round(contextTokens / 1000)}K tokens`
          : contextTokens > 0 ? `~${contextTokens} tokens` : null;
        const isLargeContext = contextTokens >= 200_000;
        const isMediumContext = contextTokens >= 50_000;
        return (
          <div className={`idle-session-warning${isLargeContext ? " large-context" : ""}`} draggable={false} onMouseDown={(e) => e.stopPropagation()}>
            {contextLabel
              ? `Idle for ${idleLabel} with ${contextLabel} of context — prompt cache has likely expired. Resuming will re-read the full context without cache${isLargeContext ? ", which could be expensive" : isMediumContext ? " at full price" : ""}. Consider starting a new task instead.`
              : `Idle for ${idleLabel} — prompt cache has likely expired. Resuming will re-read the full context, using more tokens. Consider starting a new task instead.`
            }
          </div>
        );
      })()}

      {/* Analyzer-suggested follow-up — prefill or auto-send via autopilot */}
      {showFollowup && todo.suggested_followup && !todo.pending_followup && (
        <div className={`suggested-followup-banner${todo.autopilot ? " autopilot-active" : ""}`} draggable={false} onMouseDown={(e) => e.stopPropagation()}>
          <span className="suggested-followup-label">
            {todo.autopilot
              ? (todo.suggested_followup_sent ? "🚁 Autopilot sent:" : "🚁 Autopilot will send:")
              : "💡 Analyzer suggests:"}
          </span>
          <span className="suggested-followup-text">{todo.suggested_followup}</span>
          <div className="suggested-followup-actions">
            <button
              className="btn-link suggested-followup-use"
              onClick={() => setFollowupText(todo.suggested_followup!)}
              title="Copy the suggestion into the follow-up input so you can edit before sending"
            >Use</button>
            <button
              className="btn-link suggested-followup-send"
              onClick={() => {
                const msg = todo.suggested_followup!;
                setFollowupText("");
                api.followupTodo(todo.id, msg, []).then(() => {
                  addToast("Follow-up sent", "success");
                  api.dismissSuggestedFollowup(todo.id).catch(() => {});
                  onRefresh();
                }).catch(() => addToast("Failed to send follow-up", "error"));
              }}
              title="Send the suggestion as a follow-up immediately"
            >Send</button>
            <button
              className="btn-link suggested-followup-dismiss"
              onClick={async () => {
                try {
                  await api.dismissSuggestedFollowup(todo.id);
                  onRefresh();
                } catch { /* silent */ }
              }}
              title="Dismiss this suggestion"
            >Dismiss</button>
          </div>
        </div>
      )}

      {/* Output limit warning — shown near follow-up bar */}
      {showFollowup && (isNearLimit || isTruncated) && (
        <div className="output-limit-warning" draggable={false} onMouseDown={(e) => e.stopPropagation()}>
          {isTruncated
            ? `⚠ Output was truncated at ${(OUTPUT_MAX_CHARS / 1000).toFixed(0)}K characters. Earlier content was removed to stay within the limit.`
            : `⚠ Output is at ${Math.round(outputPct * 100)}% of the ${(OUTPUT_MAX_CHARS / 1000).toFixed(0)}K character limit. Follow-ups may cause truncation of earlier output.`}
        </div>
      )}
      {showFollowup && (
        <div className="followup-bar followup-bar-with-images" draggable={false} onMouseDown={(e) => e.stopPropagation()} onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}>
          {pendingImages.length > 0 && (
            <div className="followup-image-previews">
              {pendingImages.map((img, idx) => (
                <div key={img.filename} className="followup-image-thumb">
                  <img src={img.previewUrl} alt={`Attached ${idx + 1}`} />
                  <button className="followup-image-remove" onClick={() => removeImage(idx)} title="Remove image">×</button>
                </div>
              ))}
              {uploading && <div className="followup-image-thumb uploading">…</div>}
            </div>
          )}
          <div className="followup-input-row">
            <button
              className="btn-icon btn-attach"
              onClick={() => imageInputRef.current?.click()}
              disabled={disabled || uploading}
              title="Attach image"
            >📎</button>
            <input
              type="file"
              ref={imageInputRef}
              accept="image/*"
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                if (e.target.files) handleImageUpload(Array.from(e.target.files));
                e.target.value = "";
              }}
            />
            <div className="followup-input-wrapper">
              <textarea
                ref={followupRef}
                className="followup-input"
                rows={1}
                placeholder={disabled ? "Server offline — changes disabled" : todo.run_status === "stopped" ? "Continue this session..." : "Send follow-up to this session..."}
                value={followupText}
                disabled={disabled}
                onChange={(e) => setFollowupText(e.target.value)}
                onPaste={handleFollowupPaste}
                onKeyDown={(e) => {
                  if (handleCmdKeyDown(e, followupRef, setFollowupText, followupText)) return;
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendFollowup(e.altKey);
                  }
                }}
              />
              {showFollowup && cmdSuggestions.length > 0 && (
                <div className="cmd-suggestions" ref={suggestionsRef}>
                  {cmdSuggestions.map((cmd, i) => (
                    <button
                      key={cmd.name}
                      className={`cmd-suggestion-item${i === selectedSuggestion ? " selected" : ""}`}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        applyCmdSuggestion(cmd.name, followupRef, setFollowupText, followupText);
                      }}
                    >
                      <span className="cmd-suggestion-name">/{cmd.name}</span>
                      <span className={`cmd-suggestion-type cmd-type-${cmd.type}`}>{cmd.type}</span>
                      <span className="cmd-suggestion-desc">{cmd.description}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              className={`btn-icon ${altHeld ? "btn-plan" : "btn-run"}`}
              onClick={() => sendFollowup(altHeld)}
              disabled={disabled}
              title={altHeld ? "Send plan-only follow-up (Alt+Enter)" : "Send follow-up (Enter) · Hold ⌥ for plan-only"}
            >{altHeld ? "📋" : "▶"}</button>
          </div>
        </div>
      )}
    </>
  );
}
