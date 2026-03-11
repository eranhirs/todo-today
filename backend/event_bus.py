"""Centralized event/message bus for real-time event propagation.

Provides a typed pub/sub system that decouples event producers (hooks, analyzer,
run manager, scheduler) from consumers (SSE endpoint, notification logic).
Thread-safe: background threads (run workers) can emit events via emit_sync().
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, AsyncIterator, Callable, Coroutine, Dict, List, Optional

log = logging.getLogger(__name__)


class EventType(str, Enum):
    """All event types that flow through the bus."""

    # Hook events — fired when Claude Code hook script reports session state
    HOOK_SESSION_UPDATE = "hook.session_update"  # session waiting/ended/started

    # Analysis events
    ANALYSIS_QUEUED = "analysis.queued"  # session queued for analysis
    ANALYSIS_STARTED = "analysis.started"  # analysis lock acquired
    ANALYSIS_COMPLETED = "analysis.completed"  # analysis finished (with results)
    ANALYSIS_SKIPPED = "analysis.skipped"  # no changes found

    # Run events — todo execution lifecycle
    RUN_STARTED = "run.started"  # claude subprocess spawned
    RUN_PROGRESS = "run.progress"  # output flushed (periodic)
    RUN_COMPLETED = "run.completed"  # run finished successfully
    RUN_FAILED = "run.failed"  # run errored
    RUN_STOPPED = "run.stopped"  # user stopped the run
    RUN_QUEUED = "run.queued"  # todo added to per-project queue

    # Queue events
    QUEUE_DRAIN_STARTED = "queue.drain_started"  # queue processing began
    QUEUE_DRAIN_COMPLETED = "queue.drain_completed"  # queue fully drained

    # Autopilot events
    AUTOPILOT_STARTED = "autopilot.started"
    AUTOPILOT_COMPLETED = "autopilot.completed"

    # Data mutation events — fired after CRUD operations
    TODO_CREATED = "todo.created"
    TODO_UPDATED = "todo.updated"
    TODO_DELETED = "todo.deleted"
    PROJECT_CREATED = "project.created"
    PROJECT_UPDATED = "project.updated"
    PROJECT_DELETED = "project.deleted"

    # Generic state change (catch-all for SSE refresh hints)
    STATE_CHANGED = "state.changed"


@dataclass
class Event:
    """A single event on the bus."""

    type: EventType
    data: Dict[str, Any] = field(default_factory=dict)
    timestamp: float = field(default_factory=time.time)

    def to_sse(self) -> str:
        """Format as an SSE message: `event: <type>\ndata: <json>\n\n`."""
        payload = {"type": self.type.value, "data": self.data, "ts": self.timestamp}
        return f"event: {self.type.value}\ndata: {json.dumps(payload)}\n\n"

    def to_dict(self) -> dict:
        return {"type": self.type.value, "data": self.data, "ts": self.timestamp}


# Type alias for async subscribers
AsyncHandler = Callable[[Event], Coroutine[Any, Any, None]]


class EventBus:
    """In-process async event bus with SSE fan-out.

    - Async handlers are called for each event (fire-and-forget).
    - SSE subscribers get events pushed to their asyncio.Queue.
    - Thread-safe: emit_sync() schedules emission on the event loop.
    """

    def __init__(self) -> None:
        self._handlers: Dict[EventType, List[AsyncHandler]] = {}
        self._sse_queues: List[asyncio.Queue[Event]] = []
        self._event_loop: Optional[asyncio.AbstractEventLoop] = None
        # Ring buffer of recent events for debugging / late-joining SSE clients
        self._recent: List[Event] = []
        self._max_recent = 100

    def set_event_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """Store the main event loop reference for thread-safe emission."""
        self._event_loop = loop

    # ── Subscription ──────────────────────────────────────────────

    def on(self, event_type: EventType, handler: AsyncHandler) -> None:
        """Register an async handler for a specific event type."""
        self._handlers.setdefault(event_type, []).append(handler)

    def off(self, event_type: EventType, handler: AsyncHandler) -> None:
        """Unregister a handler."""
        handlers = self._handlers.get(event_type, [])
        if handler in handlers:
            handlers.remove(handler)

    # ── SSE subscriber management ─────────────────────────────────

    def subscribe_sse(self) -> asyncio.Queue[Event]:
        """Create a new SSE subscriber queue. Caller must call unsubscribe_sse when done."""
        q: asyncio.Queue[Event] = asyncio.Queue(maxsize=256)
        self._sse_queues.append(q)
        log.debug("SSE subscriber added (total: %d)", len(self._sse_queues))
        return q

    def unsubscribe_sse(self, q: asyncio.Queue[Event]) -> None:
        """Remove an SSE subscriber queue."""
        try:
            self._sse_queues.remove(q)
        except ValueError:
            pass
        log.debug("SSE subscriber removed (total: %d)", len(self._sse_queues))

    # ── Emission ──────────────────────────────────────────────────

    async def emit(self, event: Event) -> None:
        """Emit an event: notify all handlers and SSE subscribers."""
        # Store in recent buffer
        self._recent.append(event)
        if len(self._recent) > self._max_recent:
            self._recent = self._recent[-self._max_recent:]

        # Fan out to SSE queues
        dead_queues: List[asyncio.Queue] = []
        for q in self._sse_queues:
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                # Slow consumer — drop oldest events
                try:
                    q.get_nowait()
                    q.put_nowait(event)
                except (asyncio.QueueEmpty, asyncio.QueueFull):
                    dead_queues.append(q)

        for dq in dead_queues:
            self.unsubscribe_sse(dq)

        # Fire async handlers
        handlers = self._handlers.get(event.type, [])
        for handler in handlers:
            try:
                await handler(event)
            except Exception:
                log.exception("Event handler error for %s", event.type)

    def emit_sync(self, event: Event) -> None:
        """Thread-safe emission: schedule emit() on the main event loop.

        Use this from background threads (e.g., run_manager workers).
        """
        loop = self._event_loop
        if loop is not None and loop.is_running():
            loop.call_soon_threadsafe(lambda e=event: asyncio.ensure_future(self.emit(e)))
        else:
            # No event loop — just store in recent buffer
            self._recent.append(event)
            if len(self._recent) > self._max_recent:
                self._recent = self._recent[-self._max_recent:]

    async def emit_event(
        self,
        event_type: EventType,
        **data: Any,
    ) -> None:
        """Convenience: create and emit an event in one call."""
        await self.emit(Event(type=event_type, data=data))

    def emit_event_sync(
        self,
        event_type: EventType,
        **data: Any,
    ) -> None:
        """Convenience: thread-safe create-and-emit."""
        self.emit_sync(Event(type=event_type, data=data))

    # ── SSE stream helper ─────────────────────────────────────────

    async def sse_stream(self) -> AsyncIterator[str]:
        """Yield SSE-formatted strings for a single client connection.

        Sends a heartbeat comment every 15s to keep the connection alive.
        """
        q = self.subscribe_sse()
        try:
            # Send initial connection event
            yield f"event: connected\ndata: {json.dumps({'subscribers': len(self._sse_queues)})}\n\n"

            while True:
                try:
                    event = await asyncio.wait_for(q.get(), timeout=15.0)
                    yield event.to_sse()
                except asyncio.TimeoutError:
                    # Send keepalive comment
                    yield ": keepalive\n\n"
        finally:
            self.unsubscribe_sse(q)

    # ── Debug / introspection ─────────────────────────────────────

    def recent_events(self, limit: int = 50) -> List[dict]:
        """Return recent events for debugging."""
        return [e.to_dict() for e in self._recent[-limit:]]

    @property
    def subscriber_count(self) -> int:
        return len(self._sse_queues)


# ── Module-level singleton ────────────────────────────────────────

bus = EventBus()
