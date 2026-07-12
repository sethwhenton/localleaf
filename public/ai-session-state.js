(function exposeLocalLeafAiSessionState(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LocalLeafAiSessionState = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createLocalLeafAiSessionState() {
  "use strict";

  function cloneValue(value) {
    if (Array.isArray(value)) return value.map(cloneValue);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)]));
  }

  function summaryFromSession(session) {
    const summary = cloneValue(session && typeof session === "object" ? session : {});
    delete summary.messages;
    return summary;
  }

  function overlayFromSession(session) {
    return {
      runStatus: ["idle", "running", "interrupted"].includes(session?.runStatus)
        ? session.runStatus
        : "idle",
      queuedCount: 0,
      unread: Boolean(session?.unread)
    };
  }

  function createState(snapshot = {}) {
    const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
    const sessionOrder = [];
    const sessionsById = {};
    const sessionOverlays = {};

    sessions.forEach((session) => {
      const id = String(session?.id || "");
      if (!id || sessionsById[id]) return;
      sessionOrder.push(id);
      sessionsById[id] = summaryFromSession({ ...session, id });
      sessionOverlays[id] = overlayFromSession(session);
    });

    const requestedId = String(snapshot.currentSessionId || snapshot.activeSession?.id || "");
    const currentSessionId = sessionsById[requestedId] ? requestedId : sessionOrder[0] || "";
    const detail = snapshot.activeSession && String(snapshot.activeSession.id || "") === currentSessionId
      ? cloneValue(snapshot.activeSession)
      : null;

    return {
      schemaVersion: Number(snapshot.schemaVersion || 2),
      projectKey: String(snapshot.projectKey || ""),
      projectName: String(snapshot.projectName || ""),
      currentSessionId,
      sessionOrder,
      sessionsById,
      activeDetail: detail,
      activeRun: null,
      queue: [],
      sessionOverlays,
      mutations: {}
    };
  }

  function sessionById(state, id) {
    const sessionId = String(id || "");
    const summary = state?.sessionsById?.[sessionId];
    if (!summary) return null;
    return {
      ...summary,
      ...(state.sessionOverlays?.[sessionId] || overlayFromSession(summary))
    };
  }

  function activeSession(state) {
    const summary = sessionById(state, state?.currentSessionId);
    if (!summary) return null;
    return state?.activeDetail
      ? {
        ...state.activeDetail,
        ...summary,
        ...(Array.isArray(state.activeDetail.messages) ? { messages: state.activeDetail.messages } : {})
      }
      : summary;
  }

  function activateSession(state, event) {
    const detail = event.activeSession || event.session || null;
    const sessionId = String(event.sessionId || detail?.id || "");
    if (!sessionId || (!state.sessionsById[sessionId] && !detail)) return state;

    const sessionsById = { ...state.sessionsById };
    const sessionOrder = state.sessionOrder.includes(sessionId)
      ? state.sessionOrder
      : [...state.sessionOrder, sessionId];
    if (detail) {
      sessionsById[sessionId] = {
        ...(sessionsById[sessionId] || {}),
        ...summaryFromSession({ ...detail, id: sessionId })
      };
    }
    const previousOverlay = state.sessionOverlays[sessionId]
      || overlayFromSession(sessionsById[sessionId]);

    return {
      ...state,
      currentSessionId: sessionId,
      sessionOrder,
      sessionsById,
      activeDetail: detail ? cloneValue({ ...detail, id: sessionId }) : null,
      sessionOverlays: {
        ...state.sessionOverlays,
        [sessionId]: { ...previousOverlay, unread: false }
      }
    };
  }

  function overlaysForQueue(state, queue) {
    const overlays = {};
    Object.entries(state.sessionOverlays).forEach(([id, overlay]) => {
      overlays[id] = { ...overlay, queuedCount: 0 };
    });
    queue.forEach((item) => {
      const sessionId = String(item?.sessionId || "");
      if (!sessionId) return;
      const overlay = overlays[sessionId]
        || overlayFromSession(state.sessionsById[sessionId]);
      overlays[sessionId] = { ...overlay, queuedCount: Number(overlay.queuedCount || 0) + 1 };
    });
    return overlays;
  }

  function queuePrompt(state, event) {
    let item = event.item || event.prompt;
    if (!item || typeof item !== "object") {
      item = Object.fromEntries(Object.entries(event).filter(([key]) => key !== "type"));
    }
    const queued = cloneValue(item);
    if (!queued.sessionId) queued.sessionId = state.currentSessionId;
    const queue = [...state.queue, queued];
    return {
      ...state,
      queue,
      sessionOverlays: overlaysForQueue(state, queue)
    };
  }

  function dequeuePrompt(state, event) {
    if (!state.queue.length) return state;
    const requestedId = String(event.id || event.queueId || event.promptId || "");
    const index = requestedId
      ? state.queue.findIndex((item) => String(item?.id || item?.queueId || "") === requestedId)
      : 0;
    if (index < 0) return state;
    const queue = [...state.queue.slice(0, index), ...state.queue.slice(index + 1)];
    return {
      ...state,
      queue,
      sessionOverlays: overlaysForQueue(state, queue)
    };
  }

  function appendUniqueMessage(detail, message) {
    if (!detail || !message || typeof message !== "object") return detail;
    const messages = Array.isArray(detail.messages) ? detail.messages : [];
    const messageId = String(message.id || "");
    if (messageId && messages.some((item) => String(item?.id || "") === messageId)) return detail;
    return { ...detail, messages: [...messages, cloneValue(message)] };
  }

  function startRun(state, event) {
    const supplied = event.run && typeof event.run === "object"
      ? { ...event.run }
      : Object.fromEntries(Object.entries(event).filter(([key]) => key !== "type"));
    const runId = String(supplied.runId || event.runId || "");
    const sessionId = String(supplied.sessionId || event.sessionId || state.currentSessionId || "");
    if (!runId || !sessionId || !state.sessionsById[sessionId]) return state;
    if (state.activeRun) return state;

    const activeRun = cloneValue({ ...supplied, runId, sessionId });
    const userMessage = event.userMessage || supplied.userMessage;
    const sessionsById = { ...state.sessionsById };
    if (userMessage) {
      const summary = sessionsById[sessionId];
      sessionsById[sessionId] = {
        ...summary,
        messageCount: Number(summary.messageCount || 0) + 1,
        lastPreview: String(userMessage.message || summary.lastPreview || ""),
        ...(event.sessionRevision != null ? { revision: event.sessionRevision } : {})
      };
    }
    const overlay = state.sessionOverlays[sessionId] || overlayFromSession(sessionsById[sessionId]);
    const activeDetail = sessionId === state.currentSessionId
      ? appendUniqueMessage(state.activeDetail, userMessage)
      : state.activeDetail;

    return {
      ...state,
      activeRun,
      activeDetail,
      sessionsById,
      sessionOverlays: {
        ...state.sessionOverlays,
        [sessionId]: { ...overlay, runStatus: "running", lastRunError: null }
      }
    };
  }

  function completeRun(state, event) {
    if (!state.activeRun) return state;
    const activeRunId = String(state.activeRun.runId || "");
    const completedRunId = String(event.runId || event.run?.runId || activeRunId);
    if (activeRunId && completedRunId !== activeRunId) return state;

    const sessionId = String(state.activeRun.sessionId || "");
    const currentSummary = state.sessionsById[sessionId];
    if (!sessionId || !currentSummary) return { ...state, activeRun: null };

    const detailCandidate = event.activeSession || event.sessionDetail || event.session || null;
    const suppliedDetail = detailCandidate
      && (!detailCandidate.id || String(detailCandidate.id) === sessionId)
      ? detailCandidate
      : null;
    const summaryCandidate = event.sessionSummary || event.summary
      || (suppliedDetail ? summaryFromSession(suppliedDetail) : null);
    const suppliedSummary = summaryCandidate
      && (!summaryCandidate.id || String(summaryCandidate.id) === sessionId)
      ? summaryCandidate
      : null;
    const assistantMessage = event.assistantMessage || null;
    const nextSummary = {
      ...currentSummary,
      ...(suppliedSummary ? cloneValue(suppliedSummary) : {}),
      id: sessionId,
      ...(event.sessionRevision != null ? { revision: event.sessionRevision } : {}),
      ...(event.contextUsage ? { lastContextUsage: cloneValue(event.contextUsage) } : {})
    };
    if (assistantMessage) {
      if (!suppliedSummary || !Object.prototype.hasOwnProperty.call(suppliedSummary, "messageCount")) {
        nextSummary.messageCount = Number(currentSummary.messageCount || 0) + 1;
      }
      if (!suppliedSummary || !Object.prototype.hasOwnProperty.call(suppliedSummary, "lastPreview")) {
        nextSummary.lastPreview = String(assistantMessage.message || currentSummary.lastPreview || "");
      }
    }

    const isActive = state.currentSessionId === sessionId;
    let activeDetail = state.activeDetail;
    if (isActive) {
      activeDetail = suppliedDetail
        ? cloneValue({ ...suppliedDetail, id: sessionId })
        : appendUniqueMessage(activeDetail, assistantMessage);
    }
    const overlay = state.sessionOverlays[sessionId] || overlayFromSession(nextSummary);

    return {
      ...state,
      activeRun: null,
      activeDetail,
      sessionsById: { ...state.sessionsById, [sessionId]: nextSummary },
      sessionOverlays: {
        ...state.sessionOverlays,
        [sessionId]: { ...overlay, runStatus: "idle", unread: !isActive, lastRunError: null }
      }
    };
  }

  function settleRun(state, event, runStatus) {
    if (!state.activeRun) return state;
    const activeRunId = String(state.activeRun.runId || "");
    const eventRunId = String(event.runId || event.run?.runId || activeRunId);
    if (activeRunId && eventRunId !== activeRunId) return state;

    const sessionId = String(state.activeRun.sessionId || "");
    const summary = state.sessionsById[sessionId];
    if (!sessionId || !summary) return { ...state, activeRun: null };
    const nextSummary = event.contextUsage
      ? { ...summary, lastContextUsage: cloneValue(event.contextUsage) }
      : summary;
    const overlay = state.sessionOverlays[sessionId] || overlayFromSession(summary);
    const lastRunError = runStatus === "interrupted"
      ? cloneValue(event.error || (event.message ? { message: event.message } : {}))
      : null;

    return {
      ...state,
      activeRun: null,
      sessionsById: nextSummary === summary
        ? state.sessionsById
        : { ...state.sessionsById, [sessionId]: nextSummary },
      sessionOverlays: {
        ...state.sessionOverlays,
        [sessionId]: { ...overlay, runStatus, lastRunError }
      }
    };
  }

  function applySnapshot(state, event) {
    const snapshot = event.snapshot || event.state;
    if (!snapshot || typeof snapshot !== "object") return state;
    const fresh = createState(snapshot);
    const currentProjectKey = String(state.projectKey || "");
    const nextProjectKey = String(fresh.projectKey || "");
    const projectChanged = currentProjectKey !== nextProjectKey;
    if (projectChanged) {
      return event.allowProjectChange ? fresh : state;
    }
    const activeDetail = fresh.activeDetail
      || (fresh.currentSessionId === state.currentSessionId ? state.activeDetail : null);
    let sessionOverlays = overlaysForQueue(fresh, state.queue);
    const runSessionId = String(state.activeRun?.sessionId || "");
    if (runSessionId) {
      const overlay = sessionOverlays[runSessionId]
        || overlayFromSession(fresh.sessionsById[runSessionId]);
      sessionOverlays = {
        ...sessionOverlays,
        [runSessionId]: { ...overlay, runStatus: "running" }
      };
    }

    return {
      ...fresh,
      activeDetail,
      activeRun: state.activeRun,
      queue: state.queue,
      sessionOverlays,
      mutations: state.mutations
    };
  }

  function mutationKey(event) {
    if (event.mutationId || event.key) return String(event.mutationId || event.key);
    if (event.mutation && typeof event.mutation === "object" && event.mutation.id) {
      return String(event.mutation.id);
    }
    if (typeof event.mutation === "string" && event.mutation) return event.mutation;
    if (event.action) return `${event.action}:${event.sessionId || "global"}`;
    return "";
  }

  function mutationPayload(event) {
    const nested = event.mutation && typeof event.mutation === "object" ? event.mutation : {};
    const topLevel = Object.fromEntries(
      Object.entries(event).filter(([key]) => key !== "type" && key !== "mutation")
    );
    return cloneValue({ ...nested, ...topLevel });
  }

  function startMutation(state, event) {
    const key = mutationKey(event);
    if (!key) return state;
    return {
      ...state,
      mutations: {
        ...state.mutations,
        [key]: { ...mutationPayload(event), status: "pending" }
      }
    };
  }

  function finishMutation(state, event) {
    const key = mutationKey(event);
    if (!key) return state;
    let status = event.status;
    if (!status || status === "pending") {
      status = event.success === false || event.error ? "failed" : "succeeded";
    } else if (status === "success") {
      status = "succeeded";
    } else if (status === "error") {
      status = "failed";
    }
    return {
      ...state,
      mutations: {
        ...state.mutations,
        [key]: {
          ...(state.mutations[key] || {}),
          ...mutationPayload(event),
          status
        }
      }
    };
  }

  function reduce(state, event) {
    if (!state || !event || typeof event !== "object") return state;
    if (event.type === "SNAPSHOT_APPLIED") return applySnapshot(state, event);
    if (event.type === "SESSION_ACTIVATED") return activateSession(state, event);
    if (event.type === "PROMPT_QUEUED") return queuePrompt(state, event);
    if (event.type === "PROMPT_DEQUEUED") return dequeuePrompt(state, event);
    if (event.type === "RUN_STARTED") return startRun(state, event);
    if (event.type === "RUN_COMPLETED") return completeRun(state, event);
    if (event.type === "RUN_FAILED") return settleRun(state, event, "interrupted");
    if (event.type === "RUN_CANCELLED") return settleRun(state, event, "idle");
    if (event.type === "MUTATION_STARTED") return startMutation(state, event);
    if (event.type === "MUTATION_FINISHED") return finishMutation(state, event);
    return state;
  }

  return {
    activeSession,
    createState,
    reduce,
    sessionById
  };
});
