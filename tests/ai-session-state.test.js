const test = require("node:test");
const assert = require("node:assert/strict");

const sessionState = require("../public/ai-session-state");

function snapshot(overrides = {}) {
  return {
    schemaVersion: 2,
    projectKey: "project-key",
    projectName: "Research paper",
    currentSessionId: "session-a",
    sessions: [
      {
        id: "session-a",
        title: "Opening draft",
        revision: 3,
        runStatus: "idle",
        unread: false,
        messageCount: 2
      },
      {
        id: "session-b",
        title: "Bibliography",
        revision: 1,
        runStatus: "idle",
        unread: true,
        messageCount: 1
      }
    ],
    activeSession: {
      id: "session-a",
      title: "Opening draft",
      revision: 3,
      messages: [
        { id: "user-1", role: "user", message: "Improve the opening." },
        { id: "assistant-1", role: "assistant", message: "Here is a tighter version." }
      ]
    },
    ...overrides
  };
}

test("creates client session state from a server snapshot", () => {
  const state = sessionState.createState(snapshot());

  assert.equal(state.schemaVersion, 2);
  assert.equal(state.projectKey, "project-key");
  assert.equal(state.projectName, "Research paper");
  assert.equal(state.currentSessionId, "session-a");
  assert.deepEqual(state.sessionOrder, ["session-a", "session-b"]);
  assert.equal(sessionState.sessionById(state, "session-b").unread, true);
  assert.deepEqual(sessionState.activeSession(state).messages, [
    { id: "user-1", role: "user", message: "Improve the opening." },
    { id: "assistant-1", role: "assistant", message: "Here is a tighter version." }
  ]);
  assert.equal("messages" in state.sessionsById["session-a"], false);
  assert.deepEqual(state.queue, []);
  assert.equal(state.activeRun, null);
});

test("activates a session detail without mutating the previous state", () => {
  const initial = sessionState.createState(snapshot());
  const next = sessionState.reduce(initial, {
    type: "SESSION_ACTIVATED",
    sessionId: "session-b",
    activeSession: {
      id: "session-b",
      title: "Bibliography",
      revision: 2,
      messages: [
        { id: "user-b", role: "user", message: "Check these citations." }
      ]
    }
  });

  assert.notEqual(next, initial);
  assert.equal(initial.currentSessionId, "session-a");
  assert.equal(sessionState.sessionById(initial, "session-b").unread, true);
  assert.equal(next.currentSessionId, "session-b");
  assert.equal(sessionState.sessionById(next, "session-b").unread, false);
  assert.deepEqual(sessionState.activeSession(next).messages, [
    { id: "user-b", role: "user", message: "Check these citations." }
  ]);
});

test("queues prompts with their origin metadata and dequeues them in FIFO order", () => {
  const initial = sessionState.createState(snapshot());
  const firstPrompt = {
    id: "queued-1",
    sessionId: "session-b",
    message: "Fix the citations",
    model: { providerId: "provider-1", modelId: "model-1" },
    permissions: { askBeforeEdit: true },
    path: "references.tex",
    selectedText: "\\cite{missing}"
  };
  const withFirst = sessionState.reduce(initial, { type: "PROMPT_QUEUED", item: firstPrompt });
  firstPrompt.model.modelId = "changed-outside-the-reducer";
  const withTwo = sessionState.reduce(withFirst, {
    type: "PROMPT_QUEUED",
    item: { id: "queued-2", sessionId: "session-a", message: "Tighten the abstract", custom: 17 }
  });

  assert.deepEqual(initial.queue, []);
  assert.deepEqual(withTwo.queue, [
    {
      id: "queued-1",
      sessionId: "session-b",
      message: "Fix the citations",
      model: { providerId: "provider-1", modelId: "model-1" },
      permissions: { askBeforeEdit: true },
      path: "references.tex",
      selectedText: "\\cite{missing}"
    },
    { id: "queued-2", sessionId: "session-a", message: "Tighten the abstract", custom: 17 }
  ]);
  assert.equal(sessionState.sessionById(withTwo, "session-b").queuedCount, 1);
  assert.equal(sessionState.sessionById(withTwo, "session-a").queuedCount, 1);

  const dequeued = sessionState.reduce(withTwo, { type: "PROMPT_DEQUEUED" });
  assert.deepEqual(dequeued.queue.map((item) => item.id), ["queued-2"]);
  assert.equal(sessionState.sessionById(dequeued, "session-b").queuedCount, 0);
  assert.equal(sessionState.sessionById(dequeued, "session-a").queuedCount, 1);
});

test("keeps a completed run with its origin session after the user switches sessions", () => {
  const initial = sessionState.createState(snapshot());
  const running = sessionState.reduce(initial, {
    type: "RUN_STARTED",
    runId: "run-a",
    sessionId: "session-a",
    clientMessageId: "client-a",
    model: { providerId: "provider-1", modelId: "model-1" },
    userMessage: { id: "client-a", role: "user", message: "Rewrite the introduction." }
  });

  assert.equal(running.activeRun.runId, "run-a");
  assert.equal(running.activeRun.sessionId, "session-a");
  assert.equal(sessionState.sessionById(running, "session-a").runStatus, "running");

  const switched = sessionState.reduce(running, {
    type: "SESSION_ACTIVATED",
    sessionId: "session-b",
    activeSession: {
      id: "session-b",
      title: "Bibliography",
      revision: 1,
      messages: [{ id: "user-b", role: "user", message: "Check these citations." }]
    }
  });
  const completed = sessionState.reduce(switched, {
    type: "RUN_COMPLETED",
    runId: "run-a",
    sessionId: "session-a",
    assistantMessage: {
      id: "assistant-a",
      role: "assistant",
      message: "I prepared a clearer introduction."
    },
    sessionRevision: 5,
    contextUsage: { version: 1, status: "complete", usage: { totalTokens: 420 } }
  });

  assert.equal(completed.activeRun, null);
  assert.equal(sessionState.sessionById(completed, "session-a").runStatus, "idle");
  assert.equal(sessionState.sessionById(completed, "session-a").unread, true);
  assert.equal(sessionState.sessionById(completed, "session-a").revision, 5);
  assert.equal(sessionState.sessionById(completed, "session-a").lastPreview, "I prepared a clearer introduction.");
  assert.deepEqual(sessionState.sessionById(completed, "session-a").lastContextUsage, {
    version: 1,
    status: "complete",
    usage: { totalTokens: 420 }
  });
  assert.deepEqual(sessionState.activeSession(completed).messages, [
    { id: "user-b", role: "user", message: "Check these citations." }
  ]);
  assert.equal(sessionState.reduce(completed, {
    type: "RUN_COMPLETED",
    runId: "run-a",
    assistantMessage: { id: "duplicate", role: "assistant", message: "Duplicate" }
  }), completed);
});

test("rejects mismatched completion detail and updates the captured origin only", () => {
  const initial = sessionState.createState(snapshot());
  const running = sessionState.reduce(initial, {
    type: "RUN_STARTED",
    runId: "run-origin",
    sessionId: "session-a",
    userMessage: { id: "client-origin", role: "user", message: "Improve this section." }
  });
  const completed = sessionState.reduce(running, {
    type: "RUN_COMPLETED",
    runId: "run-origin",
    sessionId: "session-b",
    activeSession: {
      id: "session-b",
      title: "Wrong detail",
      messages: [{ id: "wrong", role: "assistant", message: "Wrong session" }]
    },
    assistantMessage: {
      id: "assistant-origin",
      role: "assistant",
      message: "The origin response."
    }
  });

  assert.equal(sessionState.sessionById(completed, "session-a").id, "session-a");
  assert.equal(sessionState.sessionById(completed, "session-a").title, "Opening draft");
  assert.equal(sessionState.sessionById(completed, "session-b").title, "Bibliography");
  assert.equal(sessionState.activeSession(completed).id, "session-a");
  assert.deepEqual(sessionState.activeSession(completed).messages.map((message) => message.id), [
    "user-1",
    "assistant-1",
    "client-origin",
    "assistant-origin"
  ]);
});

test("applies authoritative summaries without losing local run and queue overlays", () => {
  const initial = sessionState.createState(snapshot());
  const queued = sessionState.reduce(initial, {
    type: "PROMPT_QUEUED",
    item: { id: "queued-b", sessionId: "session-b", message: "Check citations next" }
  });
  const running = sessionState.reduce(queued, {
    type: "RUN_STARTED",
    runId: "run-a",
    sessionId: "session-a",
    clientMessageId: "client-a"
  });
  const next = sessionState.reduce(running, {
    type: "SNAPSHOT_APPLIED",
    snapshot: snapshot({
      projectName: "Renamed paper",
      sessions: [
        { id: "session-b", title: "Sources", revision: 4, runStatus: "idle", unread: false },
        { id: "session-a", title: "Introduction", revision: 6, runStatus: "idle", unread: false }
      ],
      activeSession: null
    })
  });

  assert.equal(next.projectName, "Renamed paper");
  assert.deepEqual(next.sessionOrder, ["session-b", "session-a"]);
  assert.equal(sessionState.sessionById(next, "session-a").title, "Introduction");
  assert.equal(sessionState.sessionById(next, "session-a").runStatus, "running");
  assert.equal(sessionState.sessionById(next, "session-b").queuedCount, 1);
  assert.equal(sessionState.activeSession(next).title, "Introduction");
  assert.equal(next.activeRun.runId, "run-a");
  assert.deepEqual(next.queue, [
    { id: "queued-b", sessionId: "session-b", message: "Check citations next" }
  ]);
  assert.deepEqual(sessionState.activeSession(next).messages, sessionState.activeSession(running).messages);
});

test("ignores a late session snapshot from a different project", () => {
  const initial = sessionState.createState(snapshot());
  const late = sessionState.reduce(initial, {
    type: "SNAPSHOT_APPLIED",
    snapshot: snapshot({
      projectKey: "old-project-key",
      projectName: "Old project",
      currentSessionId: "old-session",
      sessions: [{ id: "old-session", title: "Old response" }],
      activeSession: { id: "old-session", title: "Old response", messages: [] }
    })
  });

  assert.equal(late, initial);
  assert.equal(late.projectKey, "project-key");
  assert.equal(late.currentSessionId, "session-a");
});

test("an authoritative project switch clears transient session work", () => {
  const initial = sessionState.createState(snapshot());
  const queued = sessionState.reduce(initial, {
    type: "PROMPT_QUEUED",
    item: { id: "queued-a", sessionId: "session-a", message: "Old project prompt" }
  });
  const running = sessionState.reduce(queued, {
    type: "RUN_STARTED",
    runId: "run-a",
    sessionId: "session-a"
  });
  const mutating = sessionState.reduce(running, {
    type: "MUTATION_STARTED",
    mutationId: "rename:session-a",
    action: "rename",
    sessionId: "session-a"
  });
  const switched = sessionState.reduce(mutating, {
    type: "SNAPSHOT_APPLIED",
    allowProjectChange: true,
    snapshot: snapshot({
      projectKey: "project-b-key",
      projectName: "Project B",
      currentSessionId: "session-b1",
      sessions: [{ id: "session-b1", title: "Project B session" }],
      activeSession: { id: "session-b1", title: "Project B session", messages: [] }
    })
  });

  assert.equal(switched.projectKey, "project-b-key");
  assert.equal(switched.currentSessionId, "session-b1");
  assert.equal(switched.activeRun, null);
  assert.deepEqual(switched.queue, []);
  assert.deepEqual(switched.mutations, {});
});

test("records failed runs as interrupted and cancelled runs as idle", () => {
  const initial = sessionState.createState(snapshot());
  const firstRun = sessionState.reduce(initial, {
    type: "RUN_STARTED",
    runId: "run-failed",
    sessionId: "session-a"
  });
  const ignored = sessionState.reduce(firstRun, {
    type: "RUN_FAILED",
    runId: "another-run",
    error: { code: "TIMEOUT" }
  });
  assert.equal(ignored, firstRun);

  const failed = sessionState.reduce(firstRun, {
    type: "RUN_FAILED",
    runId: "run-failed",
    error: { code: "TIMEOUT", message: "The model took too long." },
    contextUsage: { version: 1, status: "failed" }
  });
  assert.equal(failed.activeRun, null);
  assert.equal(sessionState.sessionById(failed, "session-a").runStatus, "interrupted");
  assert.deepEqual(sessionState.sessionById(failed, "session-a").lastRunError, {
    code: "TIMEOUT",
    message: "The model took too long."
  });
  assert.deepEqual(sessionState.sessionById(failed, "session-a").lastContextUsage, {
    version: 1,
    status: "failed"
  });

  const secondRun = sessionState.reduce(failed, {
    type: "RUN_STARTED",
    runId: "run-cancelled",
    sessionId: "session-a"
  });
  const cancelled = sessionState.reduce(secondRun, {
    type: "RUN_CANCELLED",
    runId: "run-cancelled"
  });
  assert.equal(cancelled.activeRun, null);
  assert.equal(sessionState.sessionById(cancelled, "session-a").runStatus, "idle");
  assert.equal(sessionState.sessionById(cancelled, "session-a").lastRunError, null);
});

test("tracks pending, successful, and failed session mutations", () => {
  const initial = sessionState.createState(snapshot());
  const renaming = sessionState.reduce(initial, {
    type: "MUTATION_STARTED",
    mutationId: "rename:session-a",
    action: "rename",
    sessionId: "session-a",
    title: "New introduction",
    startedAt: 100
  });

  assert.deepEqual(initial.mutations, {});
  assert.deepEqual(renaming.mutations["rename:session-a"], {
    mutationId: "rename:session-a",
    action: "rename",
    sessionId: "session-a",
    title: "New introduction",
    startedAt: 100,
    status: "pending"
  });

  const renamed = sessionState.reduce(renaming, {
    type: "MUTATION_FINISHED",
    mutationId: "rename:session-a",
    finishedAt: 120,
    result: { revision: 7 }
  });
  assert.deepEqual(renamed.mutations["rename:session-a"], {
    mutationId: "rename:session-a",
    action: "rename",
    sessionId: "session-a",
    title: "New introduction",
    startedAt: 100,
    status: "succeeded",
    finishedAt: 120,
    result: { revision: 7 }
  });

  const deleting = sessionState.reduce(renamed, {
    type: "MUTATION_STARTED",
    mutation: { id: "delete:session-b", action: "delete", sessionId: "session-b" }
  });
  const failed = sessionState.reduce(deleting, {
    type: "MUTATION_FINISHED",
    mutationId: "delete:session-b",
    error: { code: "AI_SESSION_BUSY" }
  });
  assert.equal(failed.mutations["delete:session-b"].status, "failed");
  assert.deepEqual(failed.mutations["delete:session-b"].error, { code: "AI_SESSION_BUSY" });
});
