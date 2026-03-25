# Related Projects

Analysis of projects from [awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code) and GitHub search that overlap with Claude Todos.

**Last updated**: 2026-03-25

---

## Feature Comparison Matrix

| Project | Stars | Auto-discover | Autopilot | Web UI | Parallel | Cost | Hooks | Multi-model | Pricing |
|---|---|---|---|---|---|---|---|---|---|
| **Claude Todos** | — | **Yes** | **Yes** | **Yes** | No | **Yes** | **Yes** | No | Free (MIT) |
| Claude Task Master | ~14.9k | No | No | No | No | No | No | **Yes** | Free† ([MIT + Commons Clause](https://github.com/eyaltoledano/claude-task-master)) |
| Claude Squad | ~7.6k | No | Partial | No | **Yes** | No | No | **Yes** | Free ([AGPL-3.0](https://github.com/smtg-ai/claude-squad)) |
| Pilot Shell | ~1.6k | Partial | **Yes** | **Yes** | No | **Yes** | **Yes** | **Yes** | Paid ([proprietary](https://github.com/maxritter/pilot-shell); [7-day trial](https://pilot-shell.com/)) |
| Aperant (Auto-Claude) | ~2.4k | No | **Yes** | Desktop | **Yes** | No | No | No | Free ([AGPL-3.0](https://github.com/AndyMik90/Auto-Claude)) |
| CCPM | ~900 | No | No | No | **Yes** | No | No | **Yes** | Free ([MIT](https://github.com/automazeio/ccpm)) |
| OctoAlly | ~57 | No | No | **Yes** | **Yes** | No | No | No | Free† ([Apache 2.0 + Commons Clause](https://github.com/ai-genius-automations/octoally)) |
| Simone | ~550 | No | No | No | No | No | No | **Yes** | Free ([MIT](https://github.com/Helmi/claude-simone)) |
| Ralph Orchestrator | ~500 | No | **Yes** | Alpha | No | No | No | **Yes** | Free ([MIT](https://github.com/mikeyobrien/ralph-orchestrator)) |
| Scopecraft Command | ~300 | No | Partial | No | Partial | No | No | **Yes** | Free ([MIT](https://github.com/scopecraft/command)) |
| Omnara | ~300 | No | No | **Yes** | No | No | No | Partial | Freemium ([Apache 2.0](https://github.com/omnara-ai/omnara); [paid tiers](https://www.omnara.com/)) |
| Happy Coder | ~200 | No | No | **Yes** | No | No | No | **Yes** | Free ([MIT](https://github.com/slopus/happy)) |
| TSK | ~200 | No | **Yes** | No | **Yes** | No | No | **Yes** | Free ([MIT](https://github.com/dtormoen/tsk)) |
| Claude Task Runner | ~100 | No | **Yes** | No | Partial | No | No | No | Free ([MIT](https://github.com/grahama1970/claude-task-runner)) |
| Sudocode | ~? | No | **Yes** | **Yes** | **Yes** | No | No | **Yes** | Free ([Apache 2.0](https://github.com/sudocode-ai/sudocode)) |
| CC Orchestrator | ~8 | Partial | Partial | **Yes** | **Yes** | **Yes** | No | No | Free ([MIT](https://github.com/trillion-labs/claude-code-orchestrator)) |
| Swarm | ~3 | No | **Yes** | **Yes** | **Yes** | No | **Yes** | **Yes** | Free ([MIT](https://github.com/bschleifer/swarm)) |
| Claudit | ~3 | No | No | **Yes** | No | No | No | No | Free ([Apache 2.0](https://github.com/HarmonicSecurity/claudit-sec)) |
| ClawWarden | ~4 | No | Partial | **Yes** | **Yes** | No | No | No | Free ([MIT](https://github.com/johnzfitch/claude-warden)) |

**Legend**: Bold **Yes** = full support. "Partial" = limited or experimental. †Commons Clause restricts commercial resale but is free to use.

---

## What Makes Claude Todos Unique

Claude Todos occupies a distinctive niche: it **automatically discovers tasks from Claude Code sessions** via hooks, presents them in a **web dashboard**, and **closes the loop with autopilot execution**. No other project combines all three. Most alternatives require manual task creation, lack a web UI, or don't auto-execute.

---

## Detailed Comparisons

Each section contains a feature table with verdicts and verbatim README quotes as evidence. "—" means the feature is not mentioned in the project's README.

### Claude Task Master — [repo](https://github.com/eyaltoledano/claude-task-master) (~14.9k stars)

The dominant project in this space, but fundamentally different: it's an **MCP-based task manager** that lives inside your editor. Users explicitly parse PRDs into tasks and ask "what's next?" — there's no session awareness, no web dashboard, and no autopilot.

| Feature | Status | Evidence |
|---|---|---|
| **Description** | MCP-based task manager | *"A task management system for AI-driven development with Claude, designed to work seamlessly with Cursor AI."* |
| **Interface** | Editor (MCP) | *"Claude Code users, you can set the mode during installation"* — lives inside the editor, no standalone UI |
| **Auto-discovers tasks** | No | — |
| **Autopilot** | No | — |
| **Hooks integration** | No | — |
| **Parallel agents** | No | — |
| **Cost tracking** | No | — |
| **Multi-model** | Yes | Supports *"claude-code/opus"* and *"claude-code/sonnet"*; also OpenAI, Gemini, Perplexity, xAI |
| **Pricing** | Free (restricted) | MIT + Commons Clause — free to use, but commercial resale is prohibited |

**Overlap**: Low. Different paradigm (editor-integrated vs. standalone dashboard). Complementary.

---

### Claude Squad — [repo](https://github.com/smtg-ai/claude-squad) (~7.6k stars)

Polished Go TUI for running multiple Claude instances in parallel via tmux + worktrees. It's a **session runner**, not a task discoverer — you tell it what to work on.

| Feature | Status | Evidence |
|---|---|---|
| **Description** | Multi-agent terminal manager | *"a terminal app that manages multiple Claude Code, Codex, Gemini (and other local agents including Aider) in separate workspaces"* |
| **Interface** | TUI (terminal) | Uses tmux: *"tmux to create isolated terminal sessions for each agent"* |
| **Auto-discovers tasks** | No | — |
| **Autopilot** | Partial | *"Complete tasks in the background (including yolo / auto-accept mode!)"* |
| **Parallel agents** | Yes | *"allowing you to work on multiple tasks simultaneously"* + *"Each task gets its own isolated git workspace, so no conflicts"* |
| **Multi-model** | Yes | *"manages multiple Claude Code, Codex, Gemini (and other local agents including Aider)"* |
| **Pricing** | Free | AGPL-3.0 (copyleft) |

**Overlap**: Low-Medium. Complementary — Claude Todos discovers *what*; Squad manages *how many*.

---

### Pilot Shell — [repo](https://github.com/maxritter/pilot-shell) (~1.6k stars)

A commercial wrapper around Claude Code that enforces structured spec-driven workflows (plan → approve → implement with TDD → verify). Includes a web console, quality hooks pipeline, persistent memory, and smart model routing. The closest overlap with Claude Todos is the web dashboard and cost tracking, but it takes a fundamentally different approach: it structures *how* you work with Claude Code, rather than discovering *what* you're working on.

| Feature | Status | Evidence |
|---|---|---|
| **Description** | Production-grade Claude Code wrapper | *"Claude Code is powerful. Pilot Shell makes it reliable."* |
| **Interface** | CLI + Web console | *"Real-time web dashboard with spec tracking, extensions management, git changes, persistent memories, sessions, usage analytics, settings"* |
| **Auto-discovers tasks** | Partial | `/setup-rules` explores codebase across 11 phases to discover conventions and generate rules, but doesn't discover tasks from session transcripts |
| **Autopilot** | Yes (spec mode) | *"The /spec command replaces Claude Code's built-in plan mode and provides a complete planning workflow with TDD, verification, and code review."* |
| **Hooks integration** | Yes | Quality hooks pipeline: *"Auto-runs ruff, ESLint, go vet on every edit; enforces TDD; optimizes tokens; captures memories"* |
| **Cost tracking** | Yes | Status line shows session cost; usage analytics in the console |
| **Multi-model** | Yes | Smart model routing: *"Opus for planning, Sonnet for implementation/verification; configurable per-phase"* |
| **Pricing** | Paid | Proprietary license with 7-day free trial; Solo and Team tiers. *"This availability does not constitute an open-source license."* |

**Overlap**: Medium. Overlaps on web dashboard, hooks, and cost tracking, but is a workflow enforcer rather than a task discoverer. Also the only paid product in this space.

---

### Aperant (Auto-Claude) — [repo](https://github.com/AndyMik90/Auto-Claude) (~2.4k stars)

An Electron desktop app with up to 12 parallel agents and self-validating QA loops. Closest in *ambition* to Claude Todos, but takes a very different approach: heavy desktop app focused on autonomous multi-agent coordination rather than session-aware task discovery.

| Feature | Status | Evidence |
|---|---|---|
| **Description** | Autonomous multi-agent framework | *"Autonomous multi-agent coding framework that plans, builds, and validates software for you."* |
| **Interface** | Desktop app (Electron) | *"Native desktop apps for Windows, macOS, and Linux"* |
| **Autopilot** | Yes | *"Describe your goal; agents handle planning, implementation, and validation"* |
| **Parallel agents** | Yes | *"Run multiple builds simultaneously with up to 12 agent terminals"* |
| **Bonus** | Memory layer | *"Memory Layer - Agents retain insights across sessions for smarter builds"* |
| **Pricing** | Free | AGPL-3.0 (commercial license available for closed-source use) |

**Overlap**: Medium. Overlaps on autopilot and task visualization, but lacks session discovery and is desktop-only.

---

### CCPM — [repo](https://github.com/automazeio/ccpm) (~900+ stars)

| Feature | Status | Evidence |
|---|---|---|
| **Description** | Spec-driven PM workflow | *"Spec-driven development for AI agents – ship ~~faster~~ _better_ using PRDs, GitHub issues, and multiple agents running in parallel."* |
| **Interface** | CLI + GitHub Issues | *"requires: `git` and `gh` CLI (authenticated: `gh auth login`)"* |
| **Parallel agents** | Yes | *"Parallel agents on independent streams"* |
| **Multi-model** | Yes (agent-agnostic) | *"It works with any Agent Skills–compatible harness that supports skills: Claude Code, Codex, OpenCode, Factory, Amp, Cursor, and more."* |
| **Pricing** | Free | MIT |

---

### Simone — [repo](https://github.com/Helmi/claude-simone) (~550 stars)

| Feature | Status | Evidence |
|---|---|---|
| **Description** | Project/task management | *"provides structured prompts and tools to help AI assistants understand and work with your projects effectively"* |
| **Interface** | CLI + MCP | Legacy directory-based system + newer MCP server |
| **Multi-model** | Yes (agent-agnostic) | Universal installer works with any MCP-compatible client |
| **Pricing** | Free | MIT |

---

### Ralph Orchestrator — [repo](https://github.com/mikeyobrien/ralph-orchestrator) (~500 stars)

Implements autonomous loops that keep running until tests pass. The "loop until done" pattern is similar to Claude Todos' autopilot, but Ralph focuses on a single task loop rather than discovering and queuing many tasks.

| Feature | Status | Evidence |
|---|---|---|
| **Description** | Autonomous loop orchestrator | *"A hat-based orchestration framework that keeps AI agents in a loop until the task is done."* |
| **Interface** | CLI + alpha Web | *"Ralph includes a web dashboard for monitoring and managing orchestration loops."* |
| **Autopilot** | Yes (loop) | *"Ralph iterates until it outputs `LOOP_COMPLETE` or hits the iteration limit."* |
| **Multi-model** | Yes | *"ralph init --backend claude"* — also supports Kiro, Gemini, Codex, Amp |
| **Notifications** | Telegram | Human-in-the-loop via Telegram |
| **Pricing** | Free | MIT |

**Overlap**: Low-Medium. Loop pattern overlaps, but lacks session-aware task discovery.

---

### Scopecraft Command — [repo](https://github.com/scopecraft/command) (~300 stars)

| Feature | Status | Evidence |
|---|---|---|
| **Description** | Markdown-driven task manager | *"A powerful command-line tool and MCP server for managing Markdown-Driven Task Management (MDTM) files."* |
| **Autopilot** | Partial | *"Autonomous execution in Docker"* via dispatch command |
| **Parallel agents** | Partial | *"Supports...parallel execution"* for subtasks |
| **Pricing** | Free | MIT |

---

### TSK — [repo](https://github.com/dtormoen/tsk) (~200 stars)

| Feature | Status | Evidence |
|---|---|---|
| **Description** | Sandboxed agent task runner | *"Delegate development `tsk` tasks to YOLO mode AI agents running in sandbox containers."* |
| **Autopilot** | Yes (async queue) | *"Agents work asynchronously and in parallel so you can review their work on your own schedule"* |
| **Parallel agents** | Yes | *"Adding `--agent codex,claude` will have `codex` and `claude` do the task in parallel"* |
| **Bonus** | Docker isolation | *"Agents work in YOLO mode in parallel filesystem and network isolated containers"* |
| **Pricing** | Free | MIT |

---

### Swarm — [repo](https://github.com/bschleifer/swarm) (~3 stars)

Despite low stars, this is the **closest architectural match**: web dashboard, Claude Code hooks, auto-approve, parallel agents, and a "Queen conductor" that detects when work is done. The key difference: no auto-discovery of tasks from session transcripts.

| Feature | Status | Evidence |
|---|---|---|
| **Description** | Web control center for agents | *"A web-based control center for AI coding agents — Claude Code, Gemini CLI, and Codex CLI."* |
| **Interface** | Web UI | *"The web dashboard gives you real-time visibility into all of them"* |
| **Autopilot** | Yes | *"Drones auto-approve safe prompts, revive crashed agents, and escalate decisions they can't handle."* |
| **Hooks integration** | Yes | *"Installs Claude Code hooks — auto-approves safe tools (Read, Edit, Write, Glob, Grep)"* |
| **Parallel agents** | Yes | *"Manage one agent or ten from a single browser tab."* |
| **Multi-model** | Yes | *"Claude Code, Gemini CLI, and Codex CLI"* |
| **Bonus** | Queen conductor | *"The Queen conductor watches the hive, proposes task assignments, detects when work is done."* |
| **Pricing** | Free | MIT |

**Overlap**: High.

---

### CC Orchestrator — [repo](https://github.com/trillion-labs/claude-code-orchestrator) (~8 stars)

The only other project that tracks session costs, and it can scan for existing sessions. However, it doesn't analyze sessions to discover tasks — it just resumes them.

| Feature | Status | Evidence |
|---|---|---|
| **Description** | Multi-machine session manager | *"A web-based command center for managing multiple Claude Code sessions across local and remote machines."* |
| **Auto-discovers tasks** | Partial | *"Scan for existing Claude sessions on any machine and resume them with full chat history restoration."* |
| **Autopilot** | Partial | *"Auto-approves file edits & safe commands"* (Accept Edits mode only) |
| **Parallel agents** | Yes | *"Run dozens of Claude Code agents in parallel. One dashboard to rule them all."* |
| **Cost tracking** | Yes | *"Track status, cost, and progress per session — all at a glance."* |
| **Pricing** | Free | MIT |

**Overlap**: Medium. The cost + session scanning combo is close, but the task discovery loop is missing.

---

## Summary

| Feature | Claude Todos status | Existing projects addressing it |
|---|---|---|
| Auto-discover tasks from sessions | **Unique advantage** | CC Orchestrator (session scanning only, no analysis) |
| Real-time hook integration | **Shared with Swarm, Pilot Shell** | Swarm (hooks for auto-approve, not analysis), Pilot Shell (quality hooks) |
| Parallel agent execution | Not supported | Squad, Aperant, TSK, Swarm, Sudocode, CC Orchestrator |
| Mobile access | Not supported | Happy Coder, Omnara |
| Multi-model support | Claude only | Task Master, Squad, Ralph, CCPM, Swarm, Pilot Shell |
| Docker/container isolation | Not supported | TSK, Squad (worktrees), Scopecraft (dispatch) |
| GitHub Issues integration | Not supported | CCPM, Aperant |
| Cost tracking | **Shared with CC Orchestrator, Pilot Shell** | CC Orchestrator (per-session cost), Pilot Shell (session cost + analytics) |
| Kanban/visual board | Not supported | Aperant, ClawWarden |

---

## Key Takeaway

Claude Todos' core differentiator — the **session-awareness → task-discovery → autopilot loop** — remains unmatched. **Swarm** is the closest architectural sibling (web UI + hooks + autopilot) but lacks the analysis-to-task-discovery pipeline. **CC Orchestrator** is the only other project with cost tracking + session scanning, but doesn't analyze transcripts. The main gaps to close are parallel execution and mobile access.
