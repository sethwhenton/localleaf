function estimateTokens(text) {
  return Math.ceil(Buffer.byteLength(String(text ?? ""), "utf8") / 3);
}

function tokenCount(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

const SAFE_TRUNCATION_REASONS = new Set([
  "annotation_limit",
  "component_limit",
  "context_window",
  "current_file_limit",
  "file_limit",
  "history_limit",
  "message_limit",
  "project_context_limit",
  "prompt_budget",
  "request_limit",
  "selection_limit",
  "source_block_limit",
  "tool_limit"
]);

const SAFE_COMPONENT_KEYS = new Set([
  "annotation",
  "current_file",
  "history",
  "instructions",
  "project_context",
  "request",
  "selection",
  "source_block",
  "system",
  "tools",
  "user_message"
]);

function metadataKey(value) {
  return typeof value === "string"
    ? value.trim().toLowerCase().replace(/[\s-]+/g, "_")
    : "";
}

function measurementIso(value) {
  const hasValue = value instanceof Date
    || (typeof value === "number" && Number.isFinite(value))
    || (typeof value === "string" && value.trim() !== "");
  const date = hasValue ? new Date(value) : new Date();
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function normalizeProviderUsage(payloadOrUsage) {
  const usage = payloadOrUsage?.usage || payloadOrUsage || {};
  let inputTokens = tokenCount(usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens);
  let outputTokens = tokenCount(usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens);
  const reportedTotal = tokenCount(usage.total_tokens ?? usage.totalTokens);
  if (inputTokens == null && outputTokens == null && reportedTotal == null) {
    return {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      source: "unavailable"
    };
  }
  const allCountsReported = reportedTotal != null && inputTokens != null && outputTokens != null;
  if (reportedTotal != null && inputTokens != null && outputTokens == null && reportedTotal >= inputTokens) {
    outputTokens = reportedTotal - inputTokens;
  } else if (reportedTotal != null && outputTokens != null && inputTokens == null && reportedTotal >= outputTokens) {
    inputTokens = reportedTotal - outputTokens;
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens: reportedTotal ?? (inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null),
    source: allCountsReported ? "provider_reported" : "mixed"
  };
}

function buildContextUsage(options = {}) {
  const runtime = String(options.runtime || "");
  const requestedStatus = String(options.status || "prepared");
  let status = ["prepared", "complete", "failed", "unavailable", "not_applicable"].includes(requestedStatus)
    ? requestedStatus
    : "unavailable";
  const serializedMessages = typeof options.messages === "string"
    ? options.messages
    : JSON.stringify(options.messages ?? []);
  const estimatedInputTokens = tokenCount(options.estimatedInputTokens) ?? estimateTokens(serializedMessages);
  let usage = normalizeProviderUsage(options.providerUsage);
  const unavailableStatus = runtime === "cursor-sdk"
    ? "unavailable"
    : runtime === "deterministic-fallback"
      ? "not_applicable"
      : null;
  if (unavailableStatus) {
    status = unavailableStatus;
    usage = {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      source: "unavailable"
    };
  } else if (usage.source === "unavailable") {
    usage = {
      inputTokens: estimatedInputTokens,
      outputTokens: 0,
      totalTokens: estimatedInputTokens,
      source: "server_estimate"
    };
  } else if (usage.source === "mixed") {
    let inputTokens = usage.inputTokens ?? estimatedInputTokens;
    let outputTokens = usage.outputTokens;
    if (outputTokens == null && usage.totalTokens != null) {
      inputTokens = Math.min(inputTokens, usage.totalTokens);
      outputTokens = usage.totalTokens - inputTokens;
    } else if (outputTokens == null) {
      outputTokens = 0;
    }
    usage = {
      ...usage,
      inputTokens,
      outputTokens,
      totalTokens: usage.totalTokens ?? inputTokens + outputTokens
    };
  }
  const contextWindowTokens = tokenCount(options.contextWindowTokens);
  const maxOutputTokens = tokenCount(options.maxOutputTokens);
  const percentTokens = status === "prepared" ? usage.inputTokens : usage.totalTokens;
  const percentUsed = contextWindowTokens > 0 && percentTokens != null
    ? Math.round((percentTokens / contextWindowTokens) * 1000) / 10
    : null;
  const history = options.history || {};
  const truncation = options.truncation || {};
  const configuredWindowSource = ["local_runtime", "provider_model_config", "unknown"].includes(options.windowSource)
    ? options.windowSource
    : "unknown";
  const windowSource = contextWindowTokens > 0 ? configuredWindowSource : "unknown";

  return {
    version: 1,
    runId: String(options.runId || ""),
    sessionId: String(options.sessionId || ""),
    scope: "last_request",
    status,
    runtime,
    usage,
    window: {
      contextWindowTokens,
      maxOutputTokens,
      percentUsed,
      source: windowSource
    },
    history: {
      availableTurns: tokenCount(history.availableTurns) || 0,
      includedTurns: tokenCount(history.includedTurns) || 0,
      droppedTurns: tokenCount(history.droppedTurns) || 0,
      summarized: false
    },
    truncation: {
      occurred: truncation.occurred === true,
      reasons: Array.isArray(truncation.reasons)
        ? [...new Set(truncation.reasons
          .map(metadataKey)
          .filter((reason) => SAFE_TRUNCATION_REASONS.has(reason)))]
          .slice(0, 20)
        : []
    },
    components: Array.isArray(options.components)
      ? options.components.slice(0, 20).map((component) => ({
        key: SAFE_COMPONENT_KEYS.has(metadataKey(component?.key)) ? metadataKey(component.key) : "other",
        originalChars: tokenCount(component?.originalChars) || 0,
        includedChars: tokenCount(component?.includedChars) || 0,
        truncated: component?.truncated === true
      }))
      : [],
    measuredAt: measurementIso(options.measuredAt)
  };
}

module.exports = {
  estimateTokens,
  normalizeProviderUsage,
  buildContextUsage
};
