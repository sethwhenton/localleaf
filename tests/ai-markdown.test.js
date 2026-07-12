const test = require("node:test");
const assert = require("node:assert/strict");

const markdown = require("../public/ai-markdown");

test("renders the supported AI Markdown blocks and inline formatting", () => {
  const output = markdown.renderMarkdown([
    "## Suggested fix",
    "",
    "Use **bold**, *emphasis*, and `inline code`.",
    "",
    "> Check the compile log first.",
    "",
    "- Open `main.tex`",
    "- Apply the change",
    "",
    "1. Save",
    "2. Compile",
    "",
    "[Read the guide](https://example.com/guide)",
    "",
    "```tex",
    "\\section{Safe output}",
    "```"
  ].join("\n"));

  assert.match(output, /<h2>Suggested fix<\/h2>/);
  assert.match(output, /<strong>bold<\/strong>/);
  assert.match(output, /<em>emphasis<\/em>/);
  assert.match(output, /<code>inline code<\/code>/);
  assert.match(output, /<blockquote>/);
  assert.match(output, /<ul><li>Open <code>main\.tex<\/code><\/li><li>Apply the change<\/li><\/ul>/);
  assert.match(output, /<ol><li>Save<\/li><li>Compile<\/li><\/ol>/);
  assert.match(output, /href="https:\/\/example\.com\/guide"/);
  assert.match(output, /target="_blank" rel="noopener noreferrer"/);
  assert.match(output, /<pre><code class="language-tex">\\section\{Safe output\}<\/code><\/pre>/);
});

test("escapes raw HTML and refuses untrusted Markdown links", () => {
  const output = markdown.renderMarkdown([
    "<img src=x onerror=alert(1)>",
    "",
    "[unsafe](javascript:alert(1))",
    "",
    "[also unsafe](http://example.com)",
    "",
    "`<script>alert(1)</script>`"
  ].join("\n"));

  assert.doesNotMatch(output, /<img|<script|href="javascript:|href="http:/i);
  assert.match(output, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(output, /<span class="ai-markdown-untrusted-link">unsafe<\/span>/);
  assert.match(output, /<code>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/code>/);
});

test("renders repeated quote markers without recursive parser exhaustion", () => {
  assert.doesNotThrow(() => markdown.renderMarkdown(`${">".repeat(5000)} safe`));
});

test("normalizes trusted links without credentials", () => {
  assert.equal(markdown.trustedMarkdownHref("https://docs.example.com/a?q=1"), "https://docs.example.com/a?q=1");
  assert.equal(markdown.trustedMarkdownHref("https://user:secret@example.com/a"), "");
  assert.equal(markdown.trustedMarkdownHref("//example.com/a"), "");
  assert.equal(markdown.trustedMarkdownHref("data:text/html,hello"), "");
});

test("formats selected composer text while preserving plain Markdown", () => {
  const bold = markdown.formatSelection("Make this clearer", 5, 9, "bold");
  assert.deepEqual(bold, {
    value: "Make **this** clearer",
    selectionStart: 7,
    selectionEnd: 11
  });

  const bullets = markdown.formatSelection("first\nsecond", 0, 12, "unorderedList");
  assert.equal(bullets.value, "- first\n- second");

  const link = markdown.formatSelection("documentation", 0, 13, "link");
  assert.equal(link.value, "[documentation](https://)");
  assert.equal(link.value.slice(link.selectionStart, link.selectionEnd), "https://");
});

test("inserts accessible placeholders when the composer has no selection", () => {
  const codeBlock = markdown.formatSelection("", 0, 0, "codeBlock");
  assert.equal(codeBlock.value, "```\ncode\n```");
  assert.equal(codeBlock.value.slice(codeBlock.selectionStart, codeBlock.selectionEnd), "code");

  const ordered = markdown.formatSelection("", 0, 0, "orderedList");
  assert.equal(ordered.value, "1. list item");
  assert.equal(ordered.value.slice(ordered.selectionStart, ordered.selectionEnd), "list item");
});
