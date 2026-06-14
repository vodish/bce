"use strict";

class Bce {
  constructor(container, options = {}) {
    this.container =
      typeof container === "string"
        ? document.querySelector(container)
        : container;

    if (!this.container) throw new Error("Bce: контейнер не найден");

    this.options = Object.assign(
      {
        tabSize: 4,
        initialText: "",
        showLineNumbers: false,
      },
      options,
    );

    this.lineIdCounter = 0;
    this.lines = [];
    this.history = [];
    this.historyIndex = -1;
    this.maxHistory = 200;
    this.ignoreNextInput = false;

    this.keyBindings = [
      { key: "c", ctrl: true, shift: false, action: "copy" },
      { key: "v", ctrl: true, shift: false, action: "paste" },
      { key: "z", ctrl: true, shift: false, action: "undo" },
      { key: "z", ctrl: true, shift: true, action: "redo" },
      { key: "ArrowDown", alt: true, shift: true, action: "duplicateDown" },
      { key: "ArrowUp", alt: true, shift: true, action: "duplicateUp" },
      { key: "ArrowDown", alt: true, shift: false, action: "moveDown" },
      { key: "ArrowUp", alt: true, shift: false, action: "moveUp" },
    ];

    this.emmet = {
      a: '<a href="|"></a>',
      aa: '<a href="|" target="_blank"></a>',
      pre: "<pre>|</pre>",
      code: "<code>|</code>",
      h1: "<h1>|</h1>",
      h2: "<h2>|</h2>",
      h3: "<h3>|</h3>",
    };
    this.emmetTriggers = ["Tab", "%"];

    this.build();
    this.bindEvents();

    if (this.options.initialText) {
      this.setText(this.options.initialText);
    } else {
      this.addLine("");
      this.render();
      this.pushHistory();
    }
  }

  build() {
    this.container.classList.add("bce-editor");
    if (!this.options.showLineNumbers) {
      this.container.classList.add("bce-no-gutter");
    }

    this.container.innerHTML = "";

    this.wrapper = document.createElement("div");
    this.wrapper.className = "bce-container";

    this.gutter = document.createElement("div");
    this.gutter.className = "bce-gutter";

    this.content = document.createElement("div");
    this.content.className = "bce-content";
    this.content.setAttribute("contenteditable", "true");
    this.content.setAttribute("spellcheck", "false");
    this.content.setAttribute("autocorrect", "off");
    this.content.setAttribute("autocapitalize", "off");

    this.wrapper.appendChild(this.gutter);
    this.wrapper.appendChild(this.content);
    this.container.appendChild(this.wrapper);
  }

  setShowLineNumbers(show) {
    this.options.showLineNumbers = show;
    if (show) {
      this.container.classList.remove("bce-no-gutter");
    } else {
      this.container.classList.add("bce-no-gutter");
    }
    this.render();
  }

  bindEvents() {
    this.content.addEventListener("keydown", (e) => this.onKeyDown(e));
    this.content.addEventListener("input", (e) => this.onInput(e));
    this.content.addEventListener("paste", (e) => this.onPaste(e));

    this.content.addEventListener("keyup", () => this.updateActiveLine());
    this.content.addEventListener("mouseup", () => this.updateActiveLine());
    this.content.addEventListener("click", () => this.updateActiveLine());
  }

  newId() {
    return ++this.lineIdCounter;
  }

  addLine(text, index = this.lines.length) {
    const line = { id: this.newId(), text: text };
    this.lines.splice(index, 0, line);
    return line;
  }

  render() {
    const cursor = this.getCursor();

    this.content.innerHTML = "";
    this.gutter.innerHTML = "";

    this.lines.forEach((line, idx) => {
      const gLine = document.createElement("div");
      gLine.className = "bce-gutter-line";
      gLine.textContent = idx + 1;
      this.gutter.appendChild(gLine);

      const div = document.createElement("div");
      div.className = "bce-line";
      div.dataset.lineId = line.id;
      div.dataset.lineIndex = idx;

      // ИСПРАВЛЕНИЕ: используем только <br> для пустых строк, чтобы избежать двойной высоты
      div.innerHTML = line.text === "" ? "<br>" : this.highlight(line.text);

      this.content.appendChild(div);
    });

    if (cursor) this.setCursor(cursor);
    this.updateActiveLine();
    this.resize();
  }

  resize() {}

  updateActiveLine() {
    const lines = this.content.querySelectorAll(".bce-line");
    lines.forEach((line) => line.classList.remove("bce-active"));

    const gutterLines = this.gutter.querySelectorAll(".bce-gutter-line");
    gutterLines.forEach((gl) => gl.classList.remove("bce-active"));

    const cursor = this.getCursor();
    if (
      cursor &&
      cursor.startLine >= 0 &&
      cursor.startLine < this.lines.length
    ) {
      const activeLineEl = this.content.children[cursor.startLine];
      if (activeLineEl) activeLineEl.classList.add("bce-active");

      const activeGutterEl = this.gutter.children[cursor.startLine];
      if (activeGutterEl) activeGutterEl.classList.add("bce-active");
    }
  }

  highlight(text) {
    if (!text) return "";
    let safe = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    safe = safe.replace(
      /(&lt;!--[\s\S]*?--&gt;)/g,
      '<span class="bce-comment">$1</span>',
    );

    safe = safe.replace(
      /(&lt;\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[a-zA-Z_:][a-zA-Z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'&gt;]+))?)*)\s*(\/?&gt;)/g,
      (m, open, name, attrs, close) => {
        const ha = attrs.replace(
          /([a-zA-Z_:][a-zA-Z0-9_.:-]*)(\s*=\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s"'&gt;]+)/g,
          (mm, an, eq, av) =>
            '<span class="bce-attr-name">' +
            an +
            "</span>" +
            eq +
            '<span class="bce-attr-value">' +
            av +
            "</span>",
        );
        return (
          '<span class="bce-bracket">' +
          open +
          "</span>" +
          '<span class="bce-tag">' +
          name +
          "</span>" +
          ha +
          '<span class="bce-bracket">' +
          close +
          "</span>"
        );
      },
    );
    return safe;
  }

  getCursor() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);

    const getNodeInfo = (node, offset) => {
      let lineEl = node;
      while (
        lineEl &&
        lineEl !== this.content &&
        !lineEl.classList?.contains("bce-line")
      ) {
        lineEl = lineEl.parentNode;
      }

      if (!lineEl || lineEl === this.content) {
        lineEl = this.content.lastElementChild;
        if (!lineEl || !lineEl.classList.contains("bce-line")) {
          return { lineIndex: 0, offset: 0 };
        }
        return {
          lineIndex: parseInt(lineEl.dataset.lineIndex, 10),
          offset: lineEl.textContent.length,
        };
      }

      const lineIndex = parseInt(lineEl.dataset.lineIndex, 10);
      let charOffset = 0;
      let found = false;

      const walker = document.createTreeWalker(
        lineEl,
        NodeFilter.SHOW_TEXT,
        null,
        false,
      );
      let currentNode = walker.nextNode();

      while (currentNode) {
        if (currentNode === node) {
          charOffset += offset;
          found = true;
          break;
        }
        charOffset += currentNode.textContent.length;
        currentNode = walker.nextNode();
      }

      if (!found) {
        charOffset = lineEl.textContent.length;
      }

      return { lineIndex, offset: charOffset };
    };

    const start = getNodeInfo(range.startContainer, range.startOffset);
    const end = getNodeInfo(range.endContainer, range.endOffset);

    return {
      startLine: start.lineIndex,
      startOffset: start.offset,
      endLine: end.lineIndex,
      endOffset: end.offset,
    };
  }

  textLength(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent.length;
    let len = 0;
    for (const c of node.childNodes) len += this.textLength(c);
    return len;
  }

  setCursor(cursor) {
    const getEndOfLine = (lineEl) => {
      let last = lineEl;
      while (last.lastChild) last = last.lastChild;
      if (last.nodeType === Node.TEXT_NODE) {
        return { node: last, offset: last.textContent.length };
      }
      return { node: lineEl, offset: lineEl.childNodes.length };
    };

    const setPoint = (lineIndex, offset) => {
      const lineEl = this.content.children[lineIndex];
      if (!lineEl) return { node: this.content, offset: 0 };

      if (
        lineEl.childNodes.length === 0 ||
        (lineEl.childNodes.length === 1 &&
          lineEl.childNodes[0].nodeName === "BR")
      ) {
        return { node: lineEl, offset: 0 };
      }

      let remaining = offset;
      const walk = (n) => {
        if (n.nodeType === Node.TEXT_NODE) {
          if (remaining <= n.textContent.length) {
            return { node: n, offset: remaining, found: true };
          }
          remaining -= n.textContent.length;
          return null;
        }
        for (const c of n.childNodes) {
          const r = walk(c);
          if (r && r.found) return r;
        }
        return null;
      };
      const result = walk(lineEl);
      if (result) return { node: result.node, offset: result.offset };
      return getEndOfLine(lineEl);
    };

    const start = setPoint(cursor.startLine, cursor.startOffset);
    const end =
      cursor.endLine === cursor.startLine &&
      cursor.endOffset === cursor.startOffset
        ? start
        : setPoint(cursor.endLine, cursor.endOffset);

    try {
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) {
      /* ignore */
    }
  }

  pushHistory() {
    this.history = this.history.slice(0, this.historyIndex + 1);
    const snapshot = {
      lines: this.lines.map((l) => ({ id: l.id, text: l.text })),
      cursor: this.getCursor(),
    };
    this.history.push(snapshot);
    if (this.history.length > this.maxHistory) this.history.shift();
    this.historyIndex = this.history.length - 1;
  }

  restoreSnapshot(snap) {
    this.lines = snap.lines.map((l) => ({ id: l.id, text: l.text }));
    this.render();
    if (snap.cursor) {
      requestAnimationFrame(() => this.setCursor(snap.cursor));
    }
  }

  undo() {
    if (this.historyIndex > 0) {
      this.historyIndex--;
      this.restoreSnapshot(this.history[this.historyIndex]);
    }
  }

  redo() {
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      this.restoreSnapshot(this.history[this.historyIndex]);
    }
  }

  getText() {
    return this.lines.map((l) => l.text).join("\n");
  }

  setText(text) {
    this.lines = [];
    const parts = text.split("\n");
    parts.forEach((p) => this.addLine(p));
    this.render();
    this.pushHistory();
  }

  getLines() {
    return this.lines.map((line) => ({ id: line.id, text: line.text }));
  }

  getLeadingSpaces(text) {
    const m = text.match(/^[ \t]*/);
    return m ? m[0] : "";
  }

  getSelectedText(cursor) {
    if (
      cursor.startLine === cursor.endLine &&
      cursor.startOffset === cursor.endOffset
    ) {
      return "";
    }
    if (cursor.startLine === cursor.endLine) {
      return this.lines[cursor.startLine].text.substring(
        cursor.startOffset,
        cursor.endOffset,
      );
    }
    let result = this.lines[cursor.startLine].text.substring(
      cursor.startOffset,
    );
    for (let i = cursor.startLine + 1; i < cursor.endLine; i++) {
      result += "\n" + this.lines[i].text;
    }
    result +=
      "\n" + this.lines[cursor.endLine].text.substring(0, cursor.endOffset);
    return result;
  }

  deleteSelection(cursor) {
    if (!cursor) return;
    if (
      cursor.startLine === cursor.endLine &&
      cursor.startOffset === cursor.endOffset
    )
      return;

    if (cursor.startLine === cursor.endLine) {
      const line = this.lines[cursor.startLine];
      line.text =
        line.text.substring(0, cursor.startOffset) +
        line.text.substring(cursor.endOffset);
    } else {
      const first = this.lines[cursor.startLine];
      const last = this.lines[cursor.endLine];
      first.text =
        first.text.substring(0, cursor.startOffset) +
        last.text.substring(cursor.endOffset);
      this.lines.splice(
        cursor.startLine + 1,
        cursor.endLine - cursor.startLine,
      );
    }
    this.render();
    this.setCursor({
      startLine: cursor.startLine,
      startOffset: cursor.startOffset,
      endLine: cursor.startLine,
      endOffset: cursor.startOffset,
    });
  }

  insertText(text) {
    const cursor = this.getCursor();
    if (!cursor) return;

    this.deleteSelection(cursor);
    const c = this.getCursor() || cursor;

    const parts = text.split("\n");
    const currentLine = this.lines[c.startLine];
    const before = currentLine.text.substring(0, c.startOffset);
    const after = currentLine.text.substring(c.endOffset);

    if (parts.length === 1) {
      currentLine.text = before + parts[0] + after;
      this.render();
      this.setCursor({
        startLine: c.startLine,
        startOffset: before.length + parts[0].length,
        endLine: c.startLine,
        endOffset: before.length + parts[0].length,
      });
    } else {
      currentLine.text = before + parts[0];
      for (let i = 1; i < parts.length - 1; i++) {
        this.addLine(parts[i], c.startLine + i);
      }
      const lastLine = {
        id: this.newId(),
        text: parts[parts.length - 1] + after,
      };
      this.lines.splice(c.startLine + parts.length - 1, 0, lastLine);

      this.render();
      const finalLine = c.startLine + parts.length - 1;
      const finalOffset = parts[parts.length - 1].length;
      this.setCursor({
        startLine: finalLine,
        startOffset: finalOffset,
        endLine: finalLine,
        endOffset: finalOffset,
      });
    }
    this.pushHistory();
  }

  doAction(action) {
    switch (action) {
      case "copy":
        return this.actionCopy();
      case "paste":
        return this.actionPaste();
      case "undo":
        return this.undo();
      case "redo":
        return this.redo();
      case "duplicateDown":
        return this.actionDuplicate(1);
      case "duplicateUp":
        return this.actionDuplicate(-1);
      case "moveDown":
        return this.actionMove(1);
      case "moveUp":
        return this.actionMove(-1);
    }
  }

  actionCopy() {
    const cursor = this.getCursor();
    if (!cursor) return;
    const text = this.getSelectedText(cursor);
    if (text) navigator.clipboard.writeText(text).catch(() => {});
  }

  actionPaste() {
    navigator.clipboard
      .readText()
      .then((text) => {
        if (text) this.insertText(text.replace(/\r\n?/g, "\n"));
      })
      .catch(() => {});
  }

  actionDuplicate(dir) {
    const cursor = this.getCursor();
    if (!cursor) return;
    const idx = cursor.startLine;
    const original = this.lines[idx];
    const copy = { id: this.newId(), text: original.text };
    if (dir > 0) {
      this.lines.splice(idx + 1, 0, copy);
      this.render();
      this.setCursor({
        startLine: idx + 1,
        startOffset: cursor.startOffset,
        endLine: idx + 1,
        endOffset: cursor.endOffset,
      });
    } else {
      this.lines.splice(idx, 0, copy);
      this.render();
      this.setCursor({
        startLine: idx,
        startOffset: cursor.startOffset,
        endLine: idx,
        endOffset: cursor.endOffset,
      });
    }
    this.pushHistory();
  }

  actionMove(dir) {
    const cursor = this.getCursor();
    if (!cursor) return;
    const idx = cursor.startLine;
    const target = idx + dir;
    if (target < 0 || target >= this.lines.length) return;
    const tmp = this.lines[idx];
    this.lines[idx] = this.lines[target];
    this.lines[target] = tmp;
    this.render();
    this.setCursor({
      startLine: target,
      startOffset: cursor.startOffset,
      endLine: target,
      endOffset: cursor.endOffset,
    });
    this.pushHistory();
  }

  tryEmmet() {
    const cursor = this.getCursor();
    if (!cursor) return false;
    if (
      cursor.startLine !== cursor.endLine ||
      cursor.startOffset !== cursor.endOffset
    )
      return false;

    const line = this.lines[cursor.startLine];
    const before = line.text.substring(0, cursor.startOffset);

    const m = before.match(/([a-zA-Z0-9:]+)$/);
    if (!m) return false;
    const abbr = m[1];
    if (!this.emmet[abbr]) return false;

    const expansion = this.emmet[abbr];
    const cursorPos = expansion.indexOf("|");
    const clean = expansion.replace("|", "");

    const startReplace = cursor.startOffset - abbr.length;
    line.text =
      line.text.substring(0, startReplace) +
      clean +
      line.text.substring(cursor.startOffset);

    this.render();
    const newOffset =
      startReplace + (cursorPos >= 0 ? cursorPos : clean.length);
    this.setCursor({
      startLine: cursor.startLine,
      startOffset: newOffset,
      endLine: cursor.startLine,
      endOffset: newOffset,
    });
    this.pushHistory();
    return true;
  }

  matchBinding(e) {
    for (const b of this.keyBindings) {
      const ctrlOk = b.ctrl
        ? e.ctrlKey || e.metaKey
        : !(e.ctrlKey || e.metaKey);
      const shiftOk = b.shift ? e.shiftKey : !e.shiftKey;
      const altOk = b.alt ? e.altKey : !e.altKey;

      if (
        e.key.toLowerCase() === b.key.toLowerCase() &&
        ctrlOk &&
        shiftOk &&
        altOk
      ) {
        return b.action;
      }
    }
    return null;
  }

  onKeyDown(e) {
    const action = this.matchBinding(e);
    if (action) {
      e.preventDefault();
      this.doAction(action);
      return;
    }

    if (this.emmetTriggers.includes(e.key)) {
      if (this.tryEmmet()) {
        e.preventDefault();
        return;
      }
      if (e.key === "Tab" || e.key === "tab") {
        e.preventDefault();
        this.ignoreNextInput = true;
        this.handleTab(e.shiftKey);
        return;
      }
    }

    if (e.key === "Enter") {
      e.preventDefault();
      this.ignoreNextInput = true;
      this.handleEnter();
      return;
    }
  }

  handleTab(shift) {
    const cursor = this.getCursor();
    if (!cursor) return;

    const hasSelection = !(
      cursor.startLine === cursor.endLine &&
      cursor.startOffset === cursor.endOffset
    );
    const indent = " ".repeat(this.options.tabSize);

    if (hasSelection) {
      const start = cursor.startLine;
      const end = cursor.endLine;
      if (shift) {
        for (let i = start; i <= end; i++) {
          if (this.lines[i].text.startsWith(indent)) {
            this.lines[i].text = this.lines[i].text.substring(indent.length);
          } else if (this.lines[i].text.startsWith("\t")) {
            this.lines[i].text = this.lines[i].text.substring(1);
          }
        }
      } else {
        for (let i = start; i <= end; i++) {
          this.lines[i].text = indent + this.lines[i].text;
        }
      }
      this.render();
      const delta = shift ? -indent.length : indent.length;
      this.setCursor({
        startLine: start,
        startOffset: Math.max(0, cursor.startOffset + delta),
        endLine: end,
        endOffset: Math.max(0, cursor.endOffset + delta),
      });
      this.pushHistory();
    } else {
      const line = this.lines[cursor.startLine];
      const leading = this.getLeadingSpaces(line.text);
      const currentLen = leading.length;
      const target =
        Math.ceil((currentLen + 1) / this.options.tabSize) *
        this.options.tabSize;
      const add = " ".repeat(target - currentLen);

      line.text =
        line.text.substring(0, cursor.startOffset) +
        add +
        line.text.substring(cursor.startOffset);
      this.render();
      this.setCursor({
        startLine: cursor.startLine,
        startOffset: cursor.startOffset + add.length,
        endLine: cursor.startLine,
        endOffset: cursor.startOffset + add.length,
      });
      this.pushHistory();
    }
  }

  handleEnter() {
    let cursor = this.getCursor();

    if (!cursor || cursor.startLine >= this.lines.length) {
      const lastIdx = Math.max(0, this.lines.length - 1);
      cursor = {
        startLine: lastIdx,
        startOffset: lastIdx >= 0 ? this.lines[lastIdx].text.length : 0,
        endLine: lastIdx,
        endOffset: lastIdx >= 0 ? this.lines[lastIdx].text.length : 0,
      };
    }

    if (
      cursor.startLine !== cursor.endLine ||
      cursor.startOffset !== cursor.endOffset
    ) {
      this.deleteSelection(cursor);
      cursor = this.getCursor() || cursor;
    }

    const line = this.lines[cursor.startLine];
    const before = line.text.substring(0, cursor.startOffset);
    const after = line.text.substring(cursor.startOffset);
    const indent = this.getLeadingSpaces(before);

    line.text = before;
    const newLine = { id: this.newId(), text: indent + after };

    this.lines.splice(cursor.startLine + 1, 0, newLine);

    this.render();

    const newOffset = indent.length;
    this.setCursor({
      startLine: cursor.startLine + 1,
      startOffset: newOffset,
      endLine: cursor.startLine + 1,
      endOffset: newOffset,
    });

    this.pushHistory();
  }

  onInput(e) {
    if (this.ignoreNextInput) {
      this.ignoreNextInput = false;
      return;
    }

    const lineEls = this.content.querySelectorAll(".bce-line");
    const newLines = [];
    const oldLinesMap = new Map(this.lines.map((l) => [l.id, l]));

    lineEls.forEach((el) => {
      const text = el.textContent || "";
      const lineId = parseInt(el.dataset.lineId, 10);

      if (lineId && oldLinesMap.has(lineId)) {
        newLines.push({ id: lineId, text });
      } else {
        newLines.push({ id: this.newId(), text });
      }
    });

    this.lines = newLines;

    const cursor = this.getCursor();
    this.render();
    if (cursor) {
      requestAnimationFrame(() => this.setCursor(cursor));
    }

    this.pushHistory();
  }

  onPaste(e) {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData("text");
    if (text) this.insertText(text.replace(/\r\n?/g, "\n"));
  }
}

window.Bce = Bce;
