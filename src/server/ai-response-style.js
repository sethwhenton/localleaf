const SUMMARY_ACTIONS = new Map([
  ["replace", "replacing"],
  ["rewrite", "rewriting"],
  ["update", "updating"],
  ["change", "changing"],
  ["append", "adding"],
  ["add", "adding"],
  ["insert", "inserting"],
  ["fix", "fixing"],
  ["remove", "removing"],
  ["delete", "removing"]
]);

const SAFE_RICH_RESPONSE_GUIDANCE = [
  "Write reply for LocalLeaf safe Markdown. Supported formatting is paragraphs, sentence-case headings, bullet or numbered lists, blockquotes, bold, italic, inline code, fenced code, and credential-free HTTPS links.",
  "Do not emit raw HTML, Markdown images, or links that are not credential-free HTTPS URLs.",
  "Use formatting only when it makes the answer easier to scan. Do not decorate routine replies with extra headings, bold labels, emojis, or repetitive lists.",
  "LocalLeaf adds a validated outcome-first lead after a file proposal is created. Do not write your own 'I prepared' or 'I proposed' lead for review. In reply, briefly explain the result or relevant tradeoff. Keep summary to one plain-text sentence for the proposal card, and never claim a proposed change was applied."
].join("\n");

const NATURAL_PROSE_GUIDANCE = [
  "For article, essay, and prose writing, preserve the requested voice, facts, quotations, citations, and meaning. Match a supplied writing sample instead of replacing it with a generic assistant voice.",
  "Prefer specific, direct sentences with natural variation. Avoid stock chatbot openings and closings, praise, sales language, vague claims or attributions, invented facts or sources, fake quotations, forced three-part lists, excessive headings or bold text, and repetitive cadence.",
  "Preserve concrete details and deliberate quirks in the author's prose. Do not add opinions or personality to technical, academic, legal, or reference text unless the user asks for them."
].join("\n");

const STRICT_JSON_WRITING_BOUNDARY = "The transport remains strict JSON. Apply this writing guidance only inside reply, summary, and replacement prose; never add commentary outside the JSON object. Keep summary plain text. Preserve the target file format in replacements and newText, using Markdown there only when the target document or user request calls for it.";

function aiResponsePromptGuidance(options = {}) {
  return [
    "Response and writing guidance:",
    SAFE_RICH_RESPONSE_GUIDANCE,
    NATURAL_PROSE_GUIDANCE,
    options.jsonTransport === false ? "" : STRICT_JSON_WRITING_BOUNDARY
  ].filter(Boolean).join("\n");
}

function cleanInlinePath(value) {
  return String(value || "the current file")
    .replace(/`+/gu, "'")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 260) || "the current file";
}

function boundedPlainText(value, maxLength = 180) {
  let text = String(value || "").slice(0, 4096).replace(/[\u0000-\u001F\u007F]/gu, " ");
  text = text
    .replace(/<[^>]{0,500}>/gu, " ")
    .replace(/!?\[([^\]\n]{0,500})\]\((?:[^()\s]|\([^()\s]*\))*\)/gu, "$1")
    .replace(/`+([^`\n]+)`+/gu, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gmu, "")
    .replace(/[*_~]+/gu, "")
    .replace(/\[([^\]\n]+)\]/gu, "$1")
    .replace(/\((?:https?:\/\/|javascript:|data:)[^)]*\)/giu, "")
    .replace(/[<>]/gu, " ")
    .replace(/\s+(?=["'”’](?:\s|[.,!?;:]|$))/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (text.length <= maxLength) return text;
  const clipped = text.slice(0, maxLength + 1);
  const boundary = clipped.lastIndexOf(" ");
  return clipped.slice(0, boundary >= Math.round(maxLength * 0.6) ? boundary : maxLength).trimEnd();
}

function proposalSummaryDetail(value) {
  const summary = boundedPlainText(value).replace(/[.!?]+$/u, "");
  const match = summary.match(/^([A-Za-z]+)\b(.*)$/u);
  if (!match) return "";
  const action = SUMMARY_ACTIONS.get(match[1].toLowerCase());
  return action ? `${action}${match[2]}` : "";
}

function proposalOutcomeLead(proposals = []) {
  const items = Array.isArray(proposals) ? proposals.filter(Boolean) : [];
  if (!items.length) return "";
  const paths = [...new Set(items.map((proposal) => cleanInlinePath(proposal.path)).filter(Boolean))];
  const created = items.filter((proposal) => proposal.operation === "create");
  if (items.length === 1) {
    const path = paths[0] || "the current file";
    if (created.length === 1) return `I prepared a new file at \`${path}\` for review.`;
    const detail = proposalSummaryDetail(items[0]?.summary);
    const punctuation = detail && /[.!?]["']?$/u.test(detail) ? "" : ".";
    return `I prepared an edit to \`${path}\` for review${detail ? `, ${detail}` : ""}${punctuation}`;
  }
  if (created.length === items.length) {
    return `I prepared ${items.length} new files for review.`;
  }
  if (created.length) {
    return `I prepared ${items.length} changes across ${paths.length || items.length} files for review, including ${created.length} new file${created.length === 1 ? "" : "s"}.`;
  }
  if (paths.length === 1) {
    return `I prepared ${items.length} edits to \`${paths[0]}\` for review.`;
  }
  return `I prepared ${items.length} edits across ${paths.length || items.length} files for review.`;
}

function withoutExistingProposalLead(value) {
  const message = String(value || "").trim();
  if (!message) return "";
  const paragraphBreak = message.search(/\n[ \t]*\n/u);
  const firstBlock = paragraphBreak >= 0 ? message.slice(0, paragraphBreak) : message;
  if (!/^I\s+(?:prepared|proposed)\b/iu.test(firstBlock) || !/\bfor review\b/iu.test(firstBlock.slice(0, 600))) {
    return message;
  }
  if (paragraphBreak >= 0) return message.slice(paragraphBreak).trim();
  const reviewMatch = /\bfor review\b/iu.exec(message);
  if (!reviewMatch) return message;
  const remainder = message.slice(reviewMatch.index + reviewMatch[0].length);
  const sentenceEnd = remainder.match(/^[\s\S]{0,320}?[.!?](?=\s|$)/u);
  return sentenceEnd ? remainder.slice(sentenceEnd[0].length).trim() : "";
}

function formatAgentReply(reply, proposals = []) {
  const lead = proposalOutcomeLead(proposals);
  const message = lead ? withoutExistingProposalLead(reply) : String(reply || "").trim();
  if (!lead) return message || "I prepared a response.";
  if (!message) return lead;
  const generic = /^(?:I prepared a response\.|The provider responded\.|I found the exact text and prepared the change\.|Cursor SDK prepared a file-change proposal\.)$/iu;
  if (generic.test(message) || message === lead) return lead;
  return `${lead}\n\n${message}`;
}

module.exports = {
  NATURAL_PROSE_GUIDANCE,
  SAFE_RICH_RESPONSE_GUIDANCE,
  STRICT_JSON_WRITING_BOUNDARY,
  aiResponsePromptGuidance,
  boundedPlainText,
  formatAgentReply,
  proposalOutcomeLead
};
