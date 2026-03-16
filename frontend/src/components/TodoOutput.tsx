import { useState, useRef, useEffect, useCallback } from "react";
import type { Todo } from "../types";
import { api } from "../api";
import { apiErrorMessage } from "../errors";

interface Props {
  todo: Todo;
  showOutput: boolean;
  onRefresh: () => void;
  addToast: (text: string, type?: "info" | "warning" | "success" | "error") => void;
  disabled?: boolean;
}

/** Must match backend OUTPUT_MAX_CHARS in run_manager.py */
const OUTPUT_MAX_CHARS = 500_000;
const OUTPUT_WARNING_THRESHOLD = 0.9; // warn at 90%

const FOLLOWUP_RE = /\n\n--- (?:Follow-up(?: \(queued\))?|BTW) ---\n\*\*You:\*\* /;

function renderOutput(text: string) {
  const parts = text.split(FOLLOWUP_RE);
  if (parts.length === 1) return text;

  const elements: (string | React.ReactElement)[] = [parts[0]];
  // After each split point, we have the user's message + rest of output
  let matchIndex = 0;
  let searchFrom = 0;
  for (let i = 1; i < parts.length; i++) {
    // Find which variant matched so we can reconstruct the header
    const queuedMatch = text.indexOf("\n\n--- Follow-up (queued) ---\n**You:** ", searchFrom);
    const normalMatch = text.indexOf("\n\n--- Follow-up ---\n**You:** ", searchFrom);
    const btwMatch = text.indexOf("\n\n--- BTW ---\n**You:** ", searchFrom);

    // Find the earliest match among all variants
    const candidates = [
      { pos: queuedMatch, header: "Follow-up (queued)", full: "\n\n--- Follow-up (queued) ---\n**You:** " },
      { pos: normalMatch, header: "Follow-up", full: "\n\n--- Follow-up ---\n**You:** " },
      { pos: btwMatch, header: "BTW", full: "\n\n--- BTW ---\n**You:** " },
    ].filter(c => c.pos !== -1);
    candidates.sort((a, b) => a.pos - b.pos);
    const match = candidates[0];

    const headerText = match.header;
    searchFrom = match.pos + match.full.length;

    // Split the part into the user message (first line) and rest
    const newlineIdx = parts[i].indexOf("\n");
    const userMsg = newlineIdx === -1 ? parts[i] : parts[i].slice(0, newlineIdx);
    const rest = newlineIdx === -1 ? "" : parts[i].slice(newlineIdx);

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
  return <>{elements}</>;
}

function renderBtwOutput(text: string) {
  const match = text.match(/^\*\*You:\*\* (.+)\n/);
  if (!match) return text;
  const userMsg = match[1];
  const rest = text.slice(match[0].length);
  return (
    <>
      <span className="followup-marker">
        <span className="followup-header">{"── BTW ──"}</span>
        {"\n"}
        <span className="followup-user-msg">{"▶ You: " + userMsg}</span>
      </span>
      {rest ? "\n" + rest : ""}
    </>
  );
}

type OutputTab = "run" | "btw";

export function TodoOutput({ todo, showOutput, onRefresh, addToast, disabled = false }: Props) {
  const [followupText, setFollowupText] = useState("");
  const [btwText, setBtwText] = useState("");
  const [activeTab, setActiveTab] = useState<OutputTab>("run");
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pendingImages, setPendingImages] = useState<{ filename: string; previewUrl: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const outputRef = useRef<HTMLPreElement>(null);
  const btwOutputRef = useRef<HTMLPreElement>(null);
  const followupRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  const isRunning = todo.run_status === "running";
  const showFollowup = todo.session_id && !isRunning &&
    (todo.run_status === "done" || todo.run_status === "error" || todo.run_status === "stopped");
  const showBtw = isRunning;
  const hasBtwOutput = !!todo.btw_output;
  const isBtwRunning = todo.btw_status === "running";

  // Auto-switch to btw tab when a new btw starts
  useEffect(() => {
    if (isBtwRunning && showOutput) {
      setActiveTab("btw");
    }
  }, [isBtwRunning, showOutput]);

  // Auto-scroll output to bottom as it streams
  useEffect(() => {
    if (showOutput && activeTab === "run" && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [showOutput, activeTab, todo.run_output]);

  // Auto-scroll btw output
  useEffect(() => {
    if (showOutput && activeTab === "btw" && btwOutputRef.current) {
      btwOutputRef.current.scrollTop = btwOutputRef.current.scrollHeight;
    }
  }, [showOutput, activeTab, todo.btw_output]);

  // Auto-focus follow-up input when output is opened and follow-up bar is visible
  useEffect(() => {
    if (showOutput && showFollowup && followupRef.current) {
      followupRef.current.focus();
    }
  }, [showOutput, showFollowup]);

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

  const sendFollowup = async () => {
    if (disabled) {
      addToast("You're offline — follow-ups aren't available right now", "warning");
      return;
    }
    const msg = followupText.trim();
    if (!msg && pendingImages.length === 0) return;
    try {
      const imageFilenames = pendingImages.map((img) => img.filename);
      const result = await api.followupTodo(todo.id, msg, imageFilenames);
      setFollowupText("");
      // Revoke preview URLs
      pendingImages.forEach((img) => URL.revokeObjectURL(img.previewUrl));
      setPendingImages([]);
      if (result.status === "queued") {
        addToast("Follow-up queued — will run when the current task finishes", "info");
      } else {
        addToast("Follow-up sent", "info");
      }
      onRefresh();
    } catch {
      addToast("Failed to send follow-up", "error");
    }
  };

  const sendBtw = async () => {
    if (disabled) {
      addToast("You're offline — btw messages aren't available right now", "warning");
      return;
    }
    const msg = btwText.trim();
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

      {/* Red flags — coping phrase warnings */}
      {(!showTabs || activeTab === "run") && todo.red_flags && todo.red_flags.length > 0 && (
        <div
          className="red-flags"
          draggable={false}
          onMouseDown={(e) => e.stopPropagation()}
          onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
        >
          <div className="red-flags-header">Coping detected — {todo.red_flags.length} red flag{todo.red_flags.length > 1 ? "s" : ""}</div>
          {todo.red_flags.map((flag, i) => (
            <div key={i} className="red-flag-item">
              <span className="red-flag-label">{flag.label}</span>
              <span className="red-flag-explanation">{flag.explanation}</span>
              <span className="red-flag-excerpt">"{flag.excerpt}"</span>
            </div>
          ))}
        </div>
      )}

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
              {copied ? "Copied!" : "Copy"}
            </button>
            <button
              className="output-toolbar-btn"
              onClick={() => setExpanded(e => !e)}
              title={expanded ? "Collapse output" : "Expand output"}
            >
              {expanded ? "⤡" : "⤢"}
            </button>
          </div>
          <pre ref={outputRef} className={expanded ? "expanded" : ""}>{renderOutput(todo.run_output)}</pre>
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
              {copied ? "Copied!" : "Copy"}
            </button>
            <button
              className="output-toolbar-btn"
              onClick={() => setExpanded(e => !e)}
              title={expanded ? "Collapse output" : "Expand output"}
            >
              {expanded ? "⤡" : "⤢"}
            </button>
          </div>
          <pre ref={btwOutputRef} className={expanded ? "expanded" : ""}>{renderBtwOutput(todo.btw_output)}</pre>
        </div>
      )}

      {/* BTW input bar — shown when main run is active */}
      {showBtw && (
        <div className="followup-bar btw-bar" draggable={false} onMouseDown={(e) => e.stopPropagation()} onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}>
          <input
            className="followup-input"
            placeholder={disabled ? "Server offline — changes disabled" : isBtwRunning ? "/btw running — wait for it to finish..." : "/btw — side-channel request (runs in parallel)..."}
            value={btwText}
            disabled={disabled || isBtwRunning}
            onChange={(e) => setBtwText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                sendBtw();
              }
            }}
          />
          <button className="btn-icon btn-run" onClick={sendBtw} disabled={disabled || isBtwRunning} title="Send /btw">↵</button>
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
            <input
              ref={followupRef}
              className="followup-input"
              placeholder={disabled ? "Server offline — changes disabled" : todo.run_status === "stopped" ? "Continue this session..." : "Send follow-up to this session..."}
              value={followupText}
              disabled={disabled}
              onChange={(e) => setFollowupText(e.target.value)}
              onPaste={handleFollowupPaste}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  sendFollowup();
                }
              }}
            />
            <button className="btn-icon btn-run" onClick={sendFollowup} disabled={disabled} title="Send follow-up">↵</button>
          </div>
        </div>
      )}
    </>
  );
}
