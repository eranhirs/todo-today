import { useCallback, useEffect, useRef } from "react";
import { isStaticDemo } from "../api";

/** Event types matching backend EventType enum values */
export type BusEventType =
  | "hook.session_update"
  | "analysis.queued"
  | "analysis.started"
  | "analysis.completed"
  | "analysis.skipped"
  | "run.started"
  | "run.progress"
  | "run.completed"
  | "run.failed"
  | "run.stopped"
  | "run.queued"
  | "queue.drain_started"
  | "queue.drain_completed"
  | "autopilot.started"
  | "autopilot.completed"
  | "todo.created"
  | "todo.updated"
  | "todo.deleted"
  | "project.created"
  | "project.updated"
  | "project.deleted"
  | "state.changed";

export interface BusEvent {
  type: BusEventType;
  data: Record<string, unknown>;
  ts: number;
}

/** Event types that indicate the frontend should refresh its state */
const REFRESH_EVENTS = new Set<BusEventType>([
  "analysis.completed",
  "run.started",
  "run.completed",
  "run.failed",
  "run.stopped",
  "run.progress",
  "run.queued",
  "queue.drain_started",
  "queue.drain_completed",
  "autopilot.completed",
  "todo.created",
  "todo.updated",
  "todo.deleted",
  "project.created",
  "project.updated",
  "project.deleted",
  "state.changed",
  "hook.session_update",
]);

type EventHandler = (event: BusEvent) => void;

interface UseEventBusOptions {
  /** Called when an event indicates the frontend state should be refreshed */
  onRefreshNeeded?: () => void;
  /** Called for every event received */
  onEvent?: EventHandler;
  /** Minimum ms between refresh triggers (debounce) */
  refreshDebounceMs?: number;
}

interface UseEventBusResult {
  /** Whether the SSE connection is currently open */
  connected: boolean;
  /** Number of events received this session */
  eventCount: number;
  /** The most recent event */
  lastEvent: BusEvent | null;
  /** Subscribe to a specific event type */
  subscribe: (eventType: BusEventType, handler: EventHandler) => () => void;
}

export function useEventBus({
  onRefreshNeeded,
  onEvent,
  refreshDebounceMs = 500,
}: UseEventBusOptions = {}): UseEventBusResult {
  // Use refs instead of state — these values are returned but never consumed
  // for rendering, so useState would cause unnecessary re-renders on every
  // SSE event (which freezes the UI when a backgrounded tab flushes updates).
  const connectedRef = useRef(false);
  const eventCountRef = useRef(0);
  const lastEventRef = useRef<BusEvent | null>(null);

  // Refs for stable callback access
  const onRefreshRef = useRef(onRefreshNeeded);
  onRefreshRef.current = onRefreshNeeded;
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  // Per-event-type subscriber registry
  const subscribersRef = useRef<Map<BusEventType, Set<EventHandler>>>(new Map());

  // Debounce timer for refresh
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track whether a refresh was requested while the tab was hidden
  const pendingRefreshRef = useRef(false);

  const triggerRefresh = useCallback(() => {
    // While the tab is hidden, don't fire refreshes — just note that one is needed.
    // The visibility handler in useAppState will do a single refresh on return,
    // and we flush any SSE-deferred refresh there too.
    if (document.hidden) {
      pendingRefreshRef.current = true;
      return;
    }
    if (refreshTimerRef.current) return; // already scheduled
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      onRefreshRef.current?.();
    }, refreshDebounceMs);
  }, [refreshDebounceMs]);

  const subscribe = useCallback(
    (eventType: BusEventType, handler: EventHandler): (() => void) => {
      const map = subscribersRef.current;
      if (!map.has(eventType)) map.set(eventType, new Set());
      map.get(eventType)!.add(handler);
      return () => {
        map.get(eventType)?.delete(handler);
      };
    },
    []
  );

  // Flush deferred SSE refresh when the tab becomes visible again
  useEffect(() => {
    const handleVisibility = () => {
      if (!document.hidden && pendingRefreshRef.current) {
        pendingRefreshRef.current = false;
        triggerRefresh();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [triggerRefresh]);

  useEffect(() => {
    if (isStaticDemo) return; // No SSE in static demo mode

    let eventSource: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    function connect() {
      if (closed) return;

      const apiBase = import.meta.env.VITE_API_URL || `${import.meta.env.BASE_URL}api`.replace(/\/\/+/g, "/");
      eventSource = new EventSource(`${apiBase}/events`);

      eventSource.addEventListener("connected", () => {
        connectedRef.current = true;
      });

      // Listen for all named event types
      const allTypes: BusEventType[] = [
        "hook.session_update",
        "analysis.queued",
        "analysis.started",
        "analysis.completed",
        "analysis.skipped",
        "run.started",
        "run.progress",
        "run.completed",
        "run.failed",
        "run.stopped",
        "run.queued",
        "queue.drain_started",
        "queue.drain_completed",
        "autopilot.started",
        "autopilot.completed",
        "todo.created",
        "todo.updated",
        "todo.deleted",
        "project.created",
        "project.updated",
        "project.deleted",
        "state.changed",
      ];

      for (const eventType of allTypes) {
        eventSource.addEventListener(eventType, (e: MessageEvent) => {
          try {
            const parsed: BusEvent = JSON.parse(e.data);
            eventCountRef.current += 1;
            lastEventRef.current = parsed;

            // Call global handler
            onEventRef.current?.(parsed);

            // Call per-type subscribers
            const handlers = subscribersRef.current.get(eventType);
            if (handlers) {
              for (const handler of handlers) {
                try {
                  handler(parsed);
                } catch {
                  // ignore handler errors
                }
              }
            }

            // Trigger refresh if this is a state-changing event
            if (REFRESH_EVENTS.has(eventType)) {
              triggerRefresh();
            }
          } catch {
            // ignore parse errors
          }
        });
      }

      eventSource.onerror = () => {
        connectedRef.current = false;
        eventSource?.close();
        eventSource = null;
        // Reconnect with backoff
        if (!closed) {
          reconnectTimer = setTimeout(connect, 3000);
        }
      };
    }

    connect();

    return () => {
      closed = true;
      eventSource?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [triggerRefresh]);

  return { connected: connectedRef.current, eventCount: eventCountRef.current, lastEvent: lastEventRef.current, subscribe };
}
