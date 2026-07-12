const test = require("node:test");
const assert = require("node:assert/strict");

const { formatAgentReply, proposalOutcomeLead } = require("../src/server/ai-response-style");

test("builds a bounded plain-text outcome lead from an untrusted proposal summary", () => {
  const lead = proposalOutcomeLead([{
    path: "main.tex",
    summary: `<b>Replace</b> **old wording** with [clear prose](https://user:secret@example.com/a) ${"extra ".repeat(80)}`
  }]);

  assert.match(lead, /^I prepared an edit to `main\.tex` for review, replacing old wording with clear prose/u);
  assert.doesNotMatch(lead, /<|>|\*|\[|\]|https?:|secret@example/u);
  assert.ok(lead.length <= 260, `lead was too long: ${lead.length}`);
});

test("replaces a provider-written proposal lead instead of duplicating it", () => {
  const reply = formatAgentReply(
    "I proposed an edit to **main.tex** for review.\n\n## Details\n\nThe title is clearer and the rest of the file is unchanged.",
    [{ path: "main.tex", summary: "Update the document title." }]
  );

  assert.match(reply, /^I prepared an edit to `main\.tex` for review, updating the document title\./u);
  assert.equal((reply.match(/for review/giu) || []).length, 1);
  assert.match(reply, /## Details\n\nThe title is clearer/u);
  assert.doesNotMatch(reply, /I proposed an edit/u);
});

test("describes a proposed project file as new rather than already written", () => {
  const reply = formatAgentReply(
    "The chapter contains a valid section scaffold.",
    [{ operation: "create", path: "chapters/introduction.tex", summary: "Create the introduction chapter." }]
  );

  assert.match(reply, /^I prepared a new file at `chapters\/introduction\.tex` for review\./u);
  assert.doesNotMatch(reply, /applied|created on disk|prepared an edit/iu);
});
