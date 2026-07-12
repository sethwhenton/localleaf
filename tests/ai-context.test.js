const test = require("node:test");
const assert = require("node:assert/strict");

const {
  estimateTokens,
  normalizeProviderUsage,
  buildContextUsage
} = require("../src/server/ai-context");

test("estimates tokens from UTF-8 byte length", () => {
  assert.deepEqual(
    [estimateTokens("abcdef"), estimateTokens("é")],
    [2, 1]
  );
});

test("normalizes OpenAI usage from a provider payload", () => {
  assert.deepEqual(
    normalizeProviderUsage({
      usage: {
        prompt_tokens: 12,
        completion_tokens: 3,
        total_tokens: 15
      }
    }),
    {
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
      source: "provider_reported"
    }
  );
});

test("accepts already-normalized provider usage at the adapter boundary", () => {
  assert.deepEqual(
    normalizeProviderUsage({ inputTokens: 21, outputTokens: 4, totalTokens: 25 }),
    { inputTokens: 21, outputTokens: 4, totalTokens: 25, source: "provider_reported" }
  );
});

test("normalizes input and output token aliases from a raw usage object", () => {
  assert.deepEqual(
    normalizeProviderUsage({
      input_tokens: 9,
      output_tokens: 4,
      total_tokens: 13
    }),
    {
      inputTokens: 9,
      outputTokens: 4,
      totalTokens: 13,
      source: "provider_reported"
    }
  );
});

test("marks provider usage mixed when the total is derived", () => {
  assert.deepEqual(
    normalizeProviderUsage({ prompt_tokens: 8, completion_tokens: 5 }),
    {
      inputTokens: 8,
      outputTokens: 5,
      totalTokens: 13,
      source: "mixed"
    }
  );
});

test("reports unavailable usage when a provider supplies no token counts", () => {
  assert.deepEqual(normalizeProviderUsage(), {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    source: "unavailable"
  });
});

test("builds complete last-request context telemetry from provider usage", () => {
  assert.deepEqual(buildContextUsage({
    runId: "run-1",
    sessionId: "session-1",
    status: "complete",
    runtime: "openai-compatible",
    messages: [{ role: "user", content: "Hello" }],
    providerUsage: {
      prompt_tokens: 500,
      completion_tokens: 101,
      total_tokens: 601
    },
    contextWindowTokens: 1000,
    windowSource: "provider_model_config",
    maxOutputTokens: 200,
    history: {
      availableTurns: 4,
      includedTurns: 3,
      droppedTurns: 1
    },
    truncation: {
      occurred: true,
      reasons: ["history_limit"]
    },
    components: [
      { key: "history", originalChars: 1200, includedChars: 800, truncated: true }
    ],
    measuredAt: "2026-07-11T10:00:00.000Z"
  }), {
    version: 1,
    runId: "run-1",
    sessionId: "session-1",
    scope: "last_request",
    status: "complete",
    runtime: "openai-compatible",
    usage: {
      inputTokens: 500,
      outputTokens: 101,
      totalTokens: 601,
      source: "provider_reported"
    },
    window: {
      contextWindowTokens: 1000,
      maxOutputTokens: 200,
      percentUsed: 60.1,
      source: "provider_model_config"
    },
    history: {
      availableTurns: 4,
      includedTurns: 3,
      droppedTurns: 1,
      summarized: false
    },
    truncation: {
      occurred: true,
      reasons: ["history_limit"]
    },
    components: [
      { key: "history", originalChars: 1200, includedChars: 800, truncated: true }
    ],
    measuredAt: "2026-07-11T10:00:00.000Z"
  });
});

test("estimates serialized request usage when provider telemetry is absent", () => {
  const contextUsage = buildContextUsage({
    runId: "run-estimated",
    sessionId: "session-1",
    status: "complete",
    runtime: "openai-compatible",
    messages: "abcdef",
    measuredAt: "2026-07-11T10:00:00.000Z"
  });

  assert.deepEqual(contextUsage.usage, {
    inputTokens: 2,
    outputTokens: 0,
    totalTokens: 2,
    source: "server_estimate"
  });
});

test("combines partial provider usage with a server input estimate", () => {
  const contextUsage = buildContextUsage({
    status: "complete",
    runtime: "openai-compatible",
    messages: "abcdef",
    providerUsage: { completion_tokens: 5 },
    measuredAt: "2026-07-11T10:00:00.000Z"
  });

  assert.deepEqual(contextUsage.usage, {
    inputTokens: 2,
    outputTokens: 5,
    totalTokens: 7,
    source: "mixed"
  });
});

test("reports Cursor SDK context telemetry as unavailable", () => {
  const contextUsage = buildContextUsage({
    status: "complete",
    runtime: "cursor-sdk",
    messages: "provider-private request",
    contextWindowTokens: 100000,
    measuredAt: "2026-07-11T10:00:00.000Z"
  });

  assert.deepEqual({
    status: contextUsage.status,
    usage: contextUsage.usage,
    percentUsed: contextUsage.window.percentUsed
  }, {
    status: "unavailable",
    usage: {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      source: "unavailable"
    },
    percentUsed: null
  });
});

test("reports deterministic fallback context telemetry as not applicable", () => {
  const contextUsage = buildContextUsage({
    status: "complete",
    runtime: "deterministic-fallback",
    messages: "local rule-based reply",
    contextWindowTokens: 4096,
    measuredAt: "2026-07-11T10:00:00.000Z"
  });

  assert.deepEqual({
    status: contextUsage.status,
    usage: contextUsage.usage,
    percentUsed: contextUsage.window.percentUsed
  }, {
    status: "not_applicable",
    usage: {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      source: "unavailable"
    },
    percentUsed: null
  });
});

test("removes prompt and source text from telemetry metadata", () => {
  const secretText = "SECRET prompt and source excerpt";
  const contextUsage = buildContextUsage({
    status: "prepared",
    runtime: "openai-compatible",
    messages: secretText,
    history: {
      availableTurns: 1,
      prompt: secretText
    },
    truncation: {
      occurred: true,
      reasons: [secretText, "history_limit"],
      sourceText: secretText
    },
    components: [{
      key: secretText,
      originalChars: 32,
      includedChars: 16,
      truncated: true,
      content: secretText
    }],
    measuredAt: "2026-07-11T10:00:00.000Z"
  });

  assert.equal(JSON.stringify(contextUsage).includes(secretText), false);
});

test("normalizes unsupported context status and window source enums", () => {
  const contextUsage = buildContextUsage({
    status: "provider-specific status",
    runtime: "openai-compatible",
    messages: "hello",
    windowSource: "provider-specific source",
    measuredAt: "2026-07-11T10:00:00.000Z"
  });

  assert.deepEqual({
    status: contextUsage.status,
    windowSource: contextUsage.window.source
  }, {
    status: "unavailable",
    windowSource: "unknown"
  });
});

test("rejects null, malformed, and negative provider token counts", () => {
  assert.deepEqual(normalizeProviderUsage({
    prompt_tokens: null,
    completion_tokens: "not-a-number",
    total_tokens: -1
  }), {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    source: "unavailable"
  });
});

test("derives a missing provider component from the reported total", () => {
  assert.deepEqual(normalizeProviderUsage({
    input_tokens: 10,
    total_tokens: 14
  }), {
    inputTokens: 10,
    outputTokens: 4,
    totalTokens: 14,
    source: "mixed"
  });
});

test("keeps unknown context capacity null", () => {
  const contextUsage = buildContextUsage({
    status: "complete",
    runtime: "openai-compatible",
    providerUsage: {
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12
    },
    contextWindowTokens: null,
    windowSource: "provider_model_config",
    measuredAt: "2026-07-11T10:00:00.000Z"
  });

  assert.deepEqual({
    contextWindowTokens: contextUsage.window.contextWindowTokens,
    percentUsed: contextUsage.window.percentUsed,
    source: contextUsage.window.source
  }, {
    contextWindowTokens: null,
    percentUsed: null,
    source: "unknown"
  });
});

test("combines a reported total with an estimated request split", () => {
  const contextUsage = buildContextUsage({
    status: "complete",
    runtime: "openai-compatible",
    messages: "abcdef",
    providerUsage: { total_tokens: 10 },
    measuredAt: "2026-07-11T10:00:00.000Z"
  });

  assert.deepEqual(contextUsage.usage, {
    inputTokens: 2,
    outputTokens: 8,
    totalTokens: 10,
    source: "mixed"
  });
});

test("canonicalizes a numeric measurement time to ISO", () => {
  const contextUsage = buildContextUsage({
    status: "prepared",
    runtime: "openai-compatible",
    messages: "hello",
    measuredAt: Date.UTC(2026, 6, 11, 10, 0, 0)
  });

  assert.equal(contextUsage.measuredAt, "2026-07-11T10:00:00.000Z");
});

test("uses the current ISO time for invalid or missing measurement times", () => {
  const before = Date.now();
  const invalidTime = buildContextUsage({
    runtime: "openai-compatible",
    measuredAt: "not-a-date"
  }).measuredAt;
  const missingTime = buildContextUsage({
    runtime: "openai-compatible"
  }).measuredAt;
  const after = Date.now();

  assert.equal(
    [invalidTime, missingTime].every((value) => {
      const timestamp = Date.parse(value);
      return Number.isFinite(timestamp) && timestamp >= before && timestamp <= after;
    }),
    true
  );
});

test("uses input tokens for prepared context occupancy", () => {
  const contextUsage = buildContextUsage({
    runtime: "openai-compatible",
    providerUsage: {
      input_tokens: 50,
      output_tokens: 50,
      total_tokens: 100
    },
    contextWindowTokens: 1000,
    windowSource: "provider_model_config",
    measuredAt: "2026-07-11T10:00:00.000Z"
  });

  assert.equal(contextUsage.window.percentUsed, 5);
});
