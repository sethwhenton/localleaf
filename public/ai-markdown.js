(function exposeLocalLeafMarkdown(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LocalLeafMarkdown = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createLocalLeafMarkdown() {
  "use strict";

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;"
    })[character]);
  }

  function trustedMarkdownHref(value) {
    const raw = String(value || "").trim();
    if (!raw || raw.length > 2048 || !/^https:\/\//iu.test(raw)) return "";
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || !parsed.hostname) return "";
      return parsed.toString();
    } catch {
      return "";
    }
  }

  function renderInline(value) {
    const tokens = [];
    const token = (html) => {
      const marker = `\u0001LLM${tokens.length}\u0002`;
      tokens.push({ marker, html });
      return marker;
    };
    let source = String(value == null ? "" : value).replace(/[\u0000-\u0002]/gu, "\uFFFD");

    source = source.replace(/(`+)([^`\n]*?)\1/gu, (_match, _ticks, code) => (
      token(`<code>${escapeHtml(code)}</code>`)
    ));
    source = source.replace(/\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+?)\)/gu, (_match, label, hrefValue) => {
      const href = trustedMarkdownHref(hrefValue);
      if (!href) return token(`<span class="ai-markdown-untrusted-link">${escapeHtml(label)}</span>`);
      return token(`<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`);
    });
    source = source.replace(/\\([\\`*_{}\[\]()#+.!>-])/gu, (_match, character) => token(escapeHtml(character)));

    let output = escapeHtml(source);
    output = output
      .replace(/\*\*([^*\n]+)\*\*/gu, "<strong>$1</strong>")
      .replace(/__([^_\n]+)__/gu, "<strong>$1</strong>")
      .replace(/(^|[^\p{L}\p{N}])\*([^*\n]+)\*(?![\p{L}\p{N}])/gu, "$1<em>$2</em>")
      .replace(/(^|[^\p{L}\p{N}])_([^_\n]+)_(?![\p{L}\p{N}])/gu, "$1<em>$2</em>");

    tokens.forEach(({ marker, html }) => {
      output = output.split(marker).join(html);
    });
    return output;
  }

  function isBlockStart(line) {
    return /^\s*$/u.test(line)
      || /^ {0,3}```/u.test(line)
      || /^ {0,3}#{1,6}\s+/u.test(line)
      || /^ {0,3}>\s?/u.test(line)
      || /^\s*(?:[-+*]|\d+[.)])\s+/u.test(line);
  }

  function renderMarkdown(value) {
    const lines = String(value == null ? "" : value).replace(/\r\n?/gu, "\n").split("\n");
    const blocks = [];
    let index = 0;

    while (index < lines.length) {
      const line = lines[index];
      if (/^\s*$/u.test(line)) {
        index += 1;
        continue;
      }

      const fence = line.match(/^ {0,3}```([A-Za-z0-9_.+-]*)\s*$/u);
      if (fence) {
        const codeLines = [];
        index += 1;
        while (index < lines.length && !/^ {0,3}```\s*$/u.test(lines[index])) {
          codeLines.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) index += 1;
        const languageClass = fence[1] ? ` class="language-${escapeHtml(fence[1].toLowerCase())}"` : "";
        blocks.push(`<pre><code${languageClass}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        continue;
      }

      const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u);
      if (heading) {
        const level = heading[1].length;
        blocks.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
        index += 1;
        continue;
      }

      if (/^ {0,3}>\s?/u.test(line)) {
        const quoteLines = [];
        while (index < lines.length && /^ {0,3}>\s?/u.test(lines[index])) {
          quoteLines.push(lines[index].replace(/^ {0,3}>\s?/u, ""));
          index += 1;
        }
        const quote = renderInline(quoteLines.join("\n")).replace(/\n/gu, "<br>");
        blocks.push(`<blockquote><p>${quote}</p></blockquote>`);
        continue;
      }

      const listItem = line.match(/^\s*([-+*]|\d+[.)])\s+(.+)$/u);
      if (listItem) {
        const ordered = /^\d/u.test(listItem[1]);
        const items = [];
        while (index < lines.length) {
          const match = lines[index].match(/^\s*([-+*]|\d+[.)])\s+(.+)$/u);
          if (!match || /^\d/u.test(match[1]) !== ordered) break;
          items.push(`<li>${renderInline(match[2])}</li>`);
          index += 1;
        }
        const tag = ordered ? "ol" : "ul";
        blocks.push(`<${tag}>${items.join("")}</${tag}>`);
        continue;
      }

      const paragraphLines = [line];
      index += 1;
      while (index < lines.length && !isBlockStart(lines[index])) {
        paragraphLines.push(lines[index]);
        index += 1;
      }
      blocks.push(`<p>${renderInline(paragraphLines.join("\n")).replace(/\n/gu, "<br>")}</p>`);
    }

    return blocks.join("");
  }

  function clampSelection(value, position) {
    const number = Number.isFinite(Number(position)) ? Number(position) : 0;
    return Math.max(0, Math.min(value.length, Math.floor(number)));
  }

  function wrapSelection(value, start, end, opening, closing, placeholder) {
    const selected = value.slice(start, end);
    const content = selected || placeholder;
    return {
      value: `${value.slice(0, start)}${opening}${content}${closing}${value.slice(end)}`,
      selectionStart: start + opening.length,
      selectionEnd: start + opening.length + content.length
    };
  }

  function formatListSelection(value, start, end, ordered) {
    if (!value && start === end) {
      const prefix = ordered ? "1. " : "- ";
      return {
        value: `${prefix}list item`,
        selectionStart: prefix.length,
        selectionEnd: prefix.length + "list item".length
      };
    }
    const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    const followingBreak = value.indexOf("\n", end);
    const lineEnd = followingBreak === -1 ? value.length : followingBreak;
    const lines = value.slice(lineStart, lineEnd).split("\n");
    const allPrefixed = lines.every((line) => !line.trim() || (ordered ? /^\s*\d+[.)]\s+/u : /^\s*[-+*]\s+/u).test(line));
    const formatted = lines.map((line, lineIndex) => {
      if (!line.trim()) return line;
      if (allPrefixed) return line.replace(ordered ? /^\s*\d+[.)]\s+/u : /^\s*[-+*]\s+/u, "");
      return `${ordered ? `${lineIndex + 1}. ` : "- "}${line}`;
    }).join("\n");
    return {
      value: `${value.slice(0, lineStart)}${formatted}${value.slice(lineEnd)}`,
      selectionStart: lineStart,
      selectionEnd: lineStart + formatted.length
    };
  }

  function formatSelection(inputValue, inputStart, inputEnd, action) {
    const value = String(inputValue == null ? "" : inputValue);
    let start = clampSelection(value, inputStart);
    let end = clampSelection(value, inputEnd);
    if (end < start) [start, end] = [end, start];

    if (action === "bold") return wrapSelection(value, start, end, "**", "**", "bold text");
    if (action === "italic") return wrapSelection(value, start, end, "*", "*", "italic text");
    if (action === "inlineCode" || action === "code") {
      const content = value.slice(start, end);
      const ticks = content.includes("`") ? "``" : "`";
      return wrapSelection(value, start, end, ticks, ticks, "code");
    }
    if (action === "codeBlock") return wrapSelection(value, start, end, "```\n", "\n```", "code");
    if (action === "unorderedList") return formatListSelection(value, start, end, false);
    if (action === "orderedList") return formatListSelection(value, start, end, true);
    if (action === "link") {
      const selected = value.slice(start, end);
      const label = selected || "link text";
      const prefix = `[${label}](`;
      return {
        value: `${value.slice(0, start)}${prefix}https://${value.slice(end) ? `)${value.slice(end)}` : ")"}`,
        selectionStart: start + prefix.length,
        selectionEnd: start + prefix.length + "https://".length
      };
    }
    return { value, selectionStart: start, selectionEnd: end };
  }

  return {
    escapeHtml,
    formatSelection,
    renderInline,
    renderMarkdown,
    trustedMarkdownHref
  };
});
