import { basicSetup } from "codemirror";
import { autocompletion, snippetCompletion, startCompletion } from "@codemirror/autocomplete";
import {
  defaultKeymap,
  historyKeymap,
  indentLess,
  indentMore,
  indentWithTab,
  redo,
  toggleLineComment,
  undo
} from "@codemirror/commands";
import { StreamLanguage, HighlightStyle, bracketMatching, syntaxHighlighting } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { searchKeymap } from "@codemirror/search";
import { EditorSelection, EditorState, Prec, Transaction } from "@codemirror/state";
import { Decoration, EditorView, MatchDecorator, ViewPlugin, keymap } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

const COMMON_PACKAGES = [
  "amsmath",
  "amssymb",
  "amsfonts",
  "babel",
  "biblatex",
  "booktabs",
  "caption",
  "csquotes",
  "fontenc",
  "geometry",
  "graphicx",
  "hyperref",
  "inputenc",
  "listings",
  "microtype",
  "natbib",
  "polyglossia",
  "setspace",
  "subcaption",
  "tikz",
  "xcolor"
];

const COMMON_ENVIRONMENTS = [
  "abstract",
  "align",
  "center",
  "description",
  "document",
  "enumerate",
  "equation",
  "figure",
  "flushleft",
  "flushright",
  "itemize",
  "quote",
  "table",
  "tabular",
  "thebibliography",
  "verbatim"
];

const CORE_COMMANDS = [
  ["\\documentclass", "\\documentclass{${class}}", "cls", "Set the document class"],
  ["\\usepackage", "\\usepackage{${package}}", "pkg", "Load a LaTeX package"],
  ["\\begin", "\\begin{${environment}}\n\t${content}\n\\end{${environment}}", "env", "Start an environment"],
  ["\\end", "\\end{${environment}}", "env", "End an environment"],
  ["\\part", "\\part{${title}}", "cmd", "Part heading"],
  ["\\chapter", "\\chapter{${title}}", "cmd", "Chapter heading"],
  ["\\section", "\\section{${title}}", "cmd", "Section heading"],
  ["\\subsection", "\\subsection{${title}}", "cmd", "Subsection heading"],
  ["\\subsubsection", "\\subsubsection{${title}}", "cmd", "Subsubsection heading"],
  ["\\paragraph", "\\paragraph{${title}}", "cmd", "Paragraph heading"],
  ["\\label", "\\label{${key}}", "ref", "Create a cross-reference label"],
  ["\\ref", "\\ref{${label}}", "ref", "Reference a label"],
  ["\\eqref", "\\eqref{${label}}", "ref", "Reference an equation"],
  ["\\autoref", "\\autoref{${label}}", "ref", "Automatic reference"],
  ["\\pageref", "\\pageref{${label}}", "ref", "Reference a page"],
  ["\\cite", "\\cite{${key}}", "cite", "Cite a bibliography entry"],
  ["\\citep", "\\citep{${key}}", "cite", "Parenthetical citation"],
  ["\\citet", "\\citet{${key}}", "cite", "Textual citation"],
  ["\\parencite", "\\parencite{${key}}", "cite", "Parenthetical biblatex citation"],
  ["\\textcite", "\\textcite{${key}}", "cite", "Textual biblatex citation"],
  ["\\textbf", "\\textbf{${text}}", "cmd", "Bold text"],
  ["\\textit", "\\textit{${text}}", "cmd", "Italic text"],
  ["\\emph", "\\emph{${text}}", "cmd", "Emphasized text"],
  ["\\underline", "\\underline{${text}}", "cmd", "Underlined text"],
  ["\\texttt", "\\texttt{${text}}", "cmd", "Monospace text"],
  ["\\url", "\\url{${url}}", "cmd", "URL"],
  ["\\href", "\\href{${url}}{${text}}", "cmd", "Hyperlink"],
  ["\\footnote", "\\footnote{${note}}", "cmd", "Footnote"],
  ["\\item", "\\item ${text}", "cmd", "List item"],
  ["\\includegraphics", "\\includegraphics[width=${width}\\linewidth]{${path}}", "img", "Insert an image"],
  ["\\caption", "\\caption{${caption}}", "cmd", "Caption"],
  ["\\centering", "\\centering", "cmd", "Center following content"],
  ["\\newcommand", "\\newcommand{\\${name}}[${args}]{${definition}}", "cmd", "Define a command"],
  ["\\renewcommand", "\\renewcommand{\\${name}}[${args}]{${definition}}", "cmd", "Redefine a command"],
  ["\\frac", "\\frac{${numerator}}{${denominator}}", "math", "Fraction"],
  ["\\sqrt", "\\sqrt{${value}}", "math", "Square root"],
  ["\\sum", "\\sum_{${from}}^{${to}}", "math", "Summation"],
  ["\\int", "\\int_{${from}}^{${to}}", "math", "Integral"],
  ["\\left", "\\left${delimiter} ${content} \\right${delimiter}", "math", "Auto-sized delimiters"],
  ["\\alpha", "\\alpha", "math", "Greek alpha"],
  ["\\beta", "\\beta", "math", "Greek beta"],
  ["\\gamma", "\\gamma", "math", "Greek gamma"],
  ["\\delta", "\\delta", "math", "Greek delta"],
  ["\\epsilon", "\\epsilon", "math", "Greek epsilon"],
  ["\\lambda", "\\lambda", "math", "Greek lambda"],
  ["\\mu", "\\mu", "math", "Greek mu"],
  ["\\pi", "\\pi", "math", "Greek pi"],
  ["\\sigma", "\\sigma", "math", "Greek sigma"],
  ["\\theta", "\\theta", "math", "Greek theta"],
  ["\\omega", "\\omega", "math", "Greek omega"],
  ["\\leq", "\\leq", "math", "Less than or equal"],
  ["\\geq", "\\geq", "math", "Greater than or equal"],
  ["\\neq", "\\neq", "math", "Not equal"],
  ["\\times", "\\times", "math", "Multiplication symbol"],
  ["\\infty", "\\infty", "math", "Infinity"],
  ["\\bibliography", "\\bibliography{${file}}", "bib", "BibTeX bibliography"],
  ["\\bibliographystyle", "\\bibliographystyle{${style}}", "bib", "BibTeX bibliography style"],
  ["\\printbibliography", "\\printbibliography", "bib", "Print biblatex bibliography"],
  ["\\tableofcontents", "\\tableofcontents", "cmd", "Table of contents"],
  ["\\maketitle", "\\maketitle", "cmd", "Render title block"],
  ["\\title", "\\title{${title}}", "cmd", "Document title"],
  ["\\author", "\\author{${author}}", "cmd", "Document author"],
  ["\\date", "\\date{${date}}", "cmd", "Document date"]
];

function uniqueSorted(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function normalizeSuggestions(suggestions = {}) {
  return {
    labels: uniqueSorted(suggestions.labels),
    citations: uniqueSorted(suggestions.citations),
    macros: uniqueSorted(suggestions.macros),
    environments: uniqueSorted([...COMMON_ENVIRONMENTS, ...(suggestions.environments || [])]),
    packages: uniqueSorted([...COMMON_PACKAGES, ...(suggestions.packages || [])])
  };
}

function completionOption(label, apply, detail, info, type = "keyword", boost = 0) {
  return snippetCompletion(apply, {
    label,
    type,
    detail,
    info,
    boost
  });
}

function buildCommandOptions(dynamicSuggestions) {
  const dynamic = normalizeSuggestions(dynamicSuggestions);
  const core = CORE_COMMANDS.map(([label, apply, detail, info]) =>
    completionOption(label, apply, detail, info, detail === "math" ? "constant" : "keyword", 20)
  );

  const environments = dynamic.environments.map((name) =>
    completionOption(`\\begin{${name}}`, `\\begin{${name}}\n\t${"${content}"}\n\\end{${name}}`, "env", `Insert ${name} environment`, "class", 12)
  );

  const packages = dynamic.packages.map((name) =>
    completionOption(`\\usepackage{${name}}`, `\\usepackage{${name}}`, "pkg", `Load ${name}`, "module", 8)
  );

  const macros = dynamic.macros.map((name) => ({
    label: `\\${name}`,
    apply: `\\${name}`,
    type: "function",
    detail: "macro",
    info: "Project macro",
    boost: 30
  }));

  return [...macros, ...core, ...environments, ...packages];
}

function valueOptions(values, detail, info, type = "variable") {
  return uniqueSorted(values).map((value) => ({
    label: value,
    type,
    detail,
    info
  }));
}

function createLatexCompletionSource(getSuggestions) {
  return (context) => {
    const suggestions = normalizeSuggestions(getSuggestions());
    const pos = context.pos;
    const before = context.state.sliceDoc(Math.max(0, pos - 120), pos);

    const labelMatch = before.match(/\\(?:ref|eqref|autoref|pageref|label)\{([^{}]*)$/);
    if (labelMatch) {
      return {
        from: pos - labelMatch[1].length,
        options: valueOptions(suggestions.labels, "label", "Project label", "variable"),
        validFor: /^[^{}]*$/
      };
    }

    const citationMatch = before.match(/\\(?:cite|citep|citet|parencite|textcite)\{([^{}]*)$/);
    if (citationMatch) {
      return {
        from: pos - citationMatch[1].length,
        options: valueOptions(suggestions.citations, "cite", "Bibliography key", "variable"),
        validFor: /^[^{}]*$/
      };
    }

    const environmentMatch = before.match(/\\(?:begin|end)\{([^{}]*)$/);
    if (environmentMatch) {
      return {
        from: pos - environmentMatch[1].length,
        options: valueOptions(suggestions.environments, "env", "Environment", "class"),
        validFor: /^[^{}]*$/
      };
    }

    const packageMatch = before.match(/\\usepackage(?:\[[^\]]*])?\{([^{}]*)$/);
    if (packageMatch) {
      return {
        from: pos - packageMatch[1].length,
        options: valueOptions(suggestions.packages, "pkg", "Common package", "module"),
        validFor: /^[^{}]*$/
      };
    }

    const command = context.matchBefore(/\\[A-Za-z@]*/);
    if (!command || (command.from === command.to && !context.explicit)) {
      return null;
    }

    return {
      from: command.from,
      options: buildCommandOptions(suggestions),
      validFor: /^\\?[A-Za-z@]*$/
    };
  };
}

const latexCommandMatcher = new MatchDecorator({
  regexp: /\\(?:[A-Za-z@]+|.)/g,
  decoration: Decoration.mark({ class: "cm-latex-command" })
});

const latexCommandHighlighter = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = latexCommandMatcher.createDeco(view);
    }

    update(update) {
      this.decorations = latexCommandMatcher.updateDeco(update, this.decorations);
    }
  },
  {
    decorations: (plugin) => plugin.decorations
  }
);

const localLeafTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      minHeight: "0",
      background: "#ffffff",
      color: "#241b15",
      fontSize: "13px"
    },
    ".cm-scroller": {
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      lineHeight: "1.65",
      overflow: "auto"
    },
    ".cm-content": {
      padding: "14px 18px",
      minHeight: "100%",
      caretColor: "#ff6700"
    },
    ".cm-line": {
      padding: "0 8px"
    },
    ".cm-gutters": {
      background: "#fbfaf8",
      borderRight: "1px solid #eee7df",
      color: "#9f958d"
    },
    ".cm-activeLineGutter": {
      background: "#fff2e8",
      color: "#ff6700"
    },
    ".cm-activeLine": {
      background: "rgba(255, 103, 0, 0.055)"
    },
    ".cm-selectionBackground, .cm-content ::selection": {
      background: "rgba(255, 103, 0, 0.18) !important"
    },
    ".cm-cursor": {
      borderLeftColor: "#ff6700"
    },
    ".cm-latex-command": {
      color: "#ff6700",
      fontWeight: "700"
    },
    ".cm-tooltip": {
      border: "1px solid #ded7d0",
      borderRadius: "8px",
      boxShadow: "0 18px 46px rgba(23, 17, 13, 0.16)",
      overflow: "hidden"
    },
    ".cm-tooltip-autocomplete": {
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace'
    },
    ".cm-tooltip-autocomplete ul": {
      maxHeight: "260px"
    },
    ".cm-tooltip-autocomplete ul li": {
      minHeight: "25px",
      padding: "2px 10px"
    },
    ".cm-tooltip-autocomplete ul li[aria-selected]": {
      background: "#fff0e5",
      color: "#19120d"
    },
    ".cm-completionDetail": {
      color: "#ff6700",
      marginLeft: "18px",
      fontFamily: 'Inter, "Segoe UI", sans-serif',
      fontSize: "11px",
      fontWeight: "700"
    },
    ".cm-completionInfo": {
      padding: "8px 10px",
      maxWidth: "260px",
      color: "#5d554e"
    }
  },
  { dark: false }
);

const latexHighlightStyle = HighlightStyle.define([
  { tag: t.keyword, color: "#ff6700", fontWeight: "700" },
  { tag: t.atom, color: "#0b7c43" },
  { tag: t.string, color: "#1269a8" },
  { tag: t.bracket, color: "#806f63" },
  { tag: t.comment, color: "#8a8179", fontStyle: "italic" },
  { tag: t.number, color: "#8b4ab8" },
  { tag: t.variableName, color: "#245f9f" }
]);

function createEditor(parent, options = {}) {
  let view;
  let suppressChange = false;
  let suggestions = normalizeSuggestions(options.suggestions);

  const getText = () => view.state.doc.toString();

  function notifyChange() {
    if (suppressChange) return;
    options.onChange?.(getText());
  }

  function runAndFocus(command) {
    const result = command(view);
    view.focus();
    return result;
  }

  function replaceSelection(createText, selectStart, selectEnd) {
    const transaction = view.state.changeByRange((range) => {
      const selected = view.state.sliceDoc(range.from, range.to);
      const text = createText(selected);
      const startOffset = selectStart(text, selected);
      const endOffset = selectEnd(text, selected, startOffset);
      return {
        changes: { from: range.from, to: range.to, insert: text },
        range: EditorSelection.range(range.from + startOffset, range.from + endOffset)
      };
    });
    view.dispatch(view.state.update(transaction, { scrollIntoView: true, userEvent: "input" }));
    view.focus();
    return true;
  }

  function wrapSelection(prefix, suffix, placeholder = "text") {
    return replaceSelection(
      (selected) => `${prefix}${selected || placeholder}${suffix}`,
      () => prefix.length,
      (_text, selected, start) => start + (selected || placeholder).length
    );
  }

  function insertTemplate(template) {
    return replaceSelection(
      (selected) => template.replace("{{selection}}", selected || "").replace("{{cursor}}", ""),
      (text) => Math.max(0, text.indexOf("{{cursor}}")),
      (_text, _selected, start) => start
    );
  }

  function insertRaw(text, cursorOffset = text.length) {
    return replaceSelection(
      () => text,
      () => cursorOffset,
      (_text, _selected, start) => start
    );
  }

  function lineAllowsVisibleBreak(lineText) {
    const trimmed = String(lineText || "").trim();
    if (!trimmed) return false;
    if (trimmed.endsWith("\\\\") || trimmed.endsWith("\\newline") || trimmed.endsWith("\\par")) return false;
    if (trimmed.startsWith("%")) return false;
    if (/^\\(?:chapter|section|subsection|subsubsection|paragraph|begin|end|item|documentclass|usepackage|input|include|title|author|date|label|caption|centering|frontmatter|mainmatter|backmatter|tableofcontents|listoffigures|listoftables|newpage|clearpage|cleardoublepage|maketitle|pagestyle|thispagestyle|graphicspath|set|let|makeat|newcommand|renewcommand)\b/.test(trimmed)) {
      return false;
    }
    if (/\\(?:begin|end)\{/.test(trimmed)) return false;
    return true;
  }

  function insertVisibleLineBreak() {
    const selection = view.state.selection.main;
    if (!selection.empty) return false;
    const line = view.state.doc.lineAt(selection.from);
    const beforeCursor = line.text.slice(0, selection.from - line.from);
    if (!lineAllowsVisibleBreak(beforeCursor)) return false;
    view.dispatch({
      changes: { from: selection.from, insert: "\\\\\n" },
      selection: { anchor: selection.from + 3 },
      scrollIntoView: true,
      userEvent: "input"
    });
    return true;
  }

  function applyStyle(style) {
    if (!style || style === "normal") return true;
    const command = `\\${style}{`;
    return wrapSelection(command, "}", "title");
  }

  function createSearchRegex(query, options = {}) {
    if (!query) return null;
    const source = options.regex
      ? query
      : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const wrapped = options.wholeWord ? `\\b(?:${source})\\b` : source;
    try {
      return new RegExp(wrapped, options.matchCase ? "g" : "gi");
    } catch {
      return null;
    }
  }

  function searchMatches(query, options = {}) {
    const regex = createSearchRegex(query, options);
    if (!regex) return [];
    const text = getText();
    const matches = [];
    let match;
    while ((match = regex.exec(text))) {
      const value = match[0];
      if (!value) {
        regex.lastIndex += 1;
        continue;
      }
      matches.push({ from: match.index, to: match.index + value.length, text: value });
    }
    return matches;
  }

  function selectMatch(match) {
    if (!match) return false;
    view.dispatch({
      selection: EditorSelection.range(match.from, match.to),
      scrollIntoView: true
    });
    view.focus();
    return true;
  }

  function findSearch(query, options = {}) {
    const matches = searchMatches(query, options);
    if (!matches.length) return { found: false, total: 0 };
    const direction = options.direction === "prev" ? "prev" : "next";
    const selection = view.state.selection.main;
    const current = direction === "prev" ? selection.from : selection.to;
    const match = direction === "prev"
      ? [...matches].reverse().find((item) => item.to < current) || matches[matches.length - 1]
      : matches.find((item) => item.from >= current) || matches[0];
    selectMatch(match);
    return { found: true, total: matches.length, index: matches.indexOf(match) + 1 };
  }

  function replaceSearch(query, replacement, options = {}) {
    const matches = searchMatches(query, options);
    if (!matches.length) return { found: false, total: 0 };
    const selection = view.state.selection.main;
    const selectedMatch = matches.find((item) => item.from === selection.from && item.to === selection.to);
    const match = selectedMatch || matches.find((item) => item.from >= selection.to) || matches[0];
    view.dispatch({
      changes: { from: match.from, to: match.to, insert: replacement },
      selection: EditorSelection.cursor(match.from + String(replacement).length),
      scrollIntoView: true,
      userEvent: "input"
    });
    view.focus();
    return { found: true, total: matches.length };
  }

  function replaceAllSearch(query, replacement, options = {}) {
    const matches = searchMatches(query, options);
    if (!matches.length) return { count: 0 };
    view.dispatch({
      changes: matches.map((match) => ({ from: match.from, to: match.to, insert: replacement })),
      scrollIntoView: true,
      userEvent: "input"
    });
    view.focus();
    return { count: matches.length };
  }

  function exec(command, value) {
    const commands = {
      undo: () => runAndFocus(undo),
      redo: () => runAndFocus(redo),
      bold: () => wrapSelection("\\textbf{", "}"),
      italic: () => wrapSelection("\\textit{", "}"),
      monospace: () => wrapSelection("\\texttt{", "}"),
      link: () => insertRaw("\\href{}{text}", 6),
      ref: () => insertRaw("\\ref{}", 5),
      cite: () => insertRaw("\\cite{}", 6),
      comment: () => runAndFocus(toggleLineComment),
      figure: () =>
        insertRaw("\\begin{figure}[h]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{}\n  \\caption{}\n  \\label{fig:}\n\\end{figure}", 73),
      table: () =>
        insertRaw("\\begin{table}[h]\n  \\centering\n  \\begin{tabular}{ll}\n    \\hline\n    Column & Value \\\\\n    \\hline\n  \\end{tabular}\n  \\caption{}\n  \\label{tab:}\n\\end{table}", 58),
      bulletList: () => insertRaw("\\begin{itemize}\n  \\item \n\\end{itemize}", 24),
      numberedList: () => insertRaw("\\begin{enumerate}\n  \\item \n\\end{enumerate}", 26),
      symbol: () => insertRaw("\\alpha", 6),
      indent: () => runAndFocus(indentMore),
      outdent: () => runAndFocus(indentLess),
      complete: () => runAndFocus(startCompletion),
      style: () => applyStyle(value)
    };
    return commands[command]?.() || false;
  }

  function textChangeBetween(oldText, newText) {
    let from = 0;
    const oldLength = oldText.length;
    const newLength = newText.length;
    while (from < oldLength && from < newLength && oldText.charCodeAt(from) === newText.charCodeAt(from)) {
      from += 1;
    }

    let oldTo = oldLength;
    let newTo = newLength;
    while (
      oldTo > from &&
      newTo > from &&
      oldText.charCodeAt(oldTo - 1) === newText.charCodeAt(newTo - 1)
    ) {
      oldTo -= 1;
      newTo -= 1;
    }

    return { from, to: oldTo, insert: newText.slice(from, newTo) };
  }

  function setText(text, options = {}) {
    const nextText = String(text ?? "");
    const currentText = getText();
    if (nextText === currentText) return;
    const selection = view.state.selection.main;
    const anchor = Math.min(selection.anchor, nextText.length);
    const head = Math.min(selection.head, nextText.length);
    const annotations = options.remote
      ? [Transaction.addToHistory.of(false), Transaction.remote.of(true)]
      : undefined;
    const changes = options.remote
      ? textChangeBetween(currentText, nextText)
      : { from: 0, to: view.state.doc.length, insert: nextText };
    suppressChange = true;
    const transaction = {
      changes,
      scrollIntoView: false,
      annotations
    };
    if (!options.remote) {
      transaction.selection = EditorSelection.create([EditorSelection.range(anchor, head)]);
    }
    view.dispatch(transaction);
    suppressChange = false;
  }

  const extensions = [
    basicSetup,
    StreamLanguage.define(stex),
    localLeafTheme,
    syntaxHighlighting(latexHighlightStyle),
    latexCommandHighlighter,
    bracketMatching(),
    EditorView.lineWrapping,
    EditorState.tabSize.of(2),
    EditorState.readOnly.of(Boolean(options.readOnly)),
    autocompletion({
      override: [createLatexCompletionSource(() => suggestions)],
      activateOnTyping: true,
      icons: false
    }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) notifyChange();
      if (update.focusChanged) {
        if (update.view.hasFocus) options.onFocus?.();
        else options.onBlur?.();
      }
    }),
    Prec.highest(
      keymap.of([
        { key: "Mod-s", run: () => (options.onSave?.(), true) },
        { key: "Mod-Enter", run: () => (options.onCompile?.(), true) },
        { key: "Enter", run: insertVisibleLineBreak },
        { key: "Mod-z", run: () => exec("undo") },
        { key: "Mod-y", run: () => exec("redo") },
        { key: "Shift-Mod-z", run: () => exec("redo") },
        { key: "Mod-b", run: () => exec("bold") },
        { key: "Mod-i", run: () => exec("italic") },
        { key: "Mod-/", run: () => exec("comment") },
        { key: "Ctrl-Space", run: () => exec("complete") },
        { key: "Alt-/", run: () => exec("complete") },
        indentWithTab
      ])
    ),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap])
  ];

  view = new EditorView({
    state: EditorState.create({
      doc: String(options.value ?? ""),
      extensions
    }),
    parent
  });

  const api = {
    host: parent,
    destroy() {
      if (parent.__localLeafEditor === api) delete parent.__localLeafEditor;
      view.destroy();
    },
    focus() {
      view.focus();
    },
    getText,
    setText,
    applyRemoteText(text) {
      setText(text, { remote: true });
    },
    setSuggestions(nextSuggestions) {
      suggestions = normalizeSuggestions(nextSuggestions);
    },
    find(query, options) {
      return findSearch(query, options);
    },
    replace(query, replacement, options) {
      return replaceSearch(query, replacement, options);
    },
    replaceAll(query, replacement, options) {
      return replaceAllSearch(query, replacement, options);
    },
    exec
  };
  parent.__localLeafEditor = api;
  return api;
}

window.LocalLeafEditor = {
  mount(options) {
    return createEditor(options.parent, options);
  }
};
