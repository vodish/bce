"use strict";

class Bce {
  constructor(container, options = {}) {
    this.container =
      typeof container === "string"
        ? document.querySelector(container)
        : container;

    if (!this.container) throw new Error("Bce: контейнер не найден");

    this.options = {
      tabSize: 4,
      initialText: "",
      showLineNumbers: false,
      enableEmmet: false,
      ...options,
    };

    this.lineIdCounter = 0;
    this.lines = [];
    this.history = [];
    this.historyIndex = -1;
    this.maxHistory = 200;
    this.ignoreNextInput = false;
    this._onChangeCallback = null;

    this.keyBindings = [
      { code: "KeyC", ctrl: true, shift: false, action: "copy" },
      { code: "KeyZ", ctrl: true, shift: false, action: "undo" },
      { code: "KeyZ", ctrl: true, shift: true, action: "redo" },
      { code: "ArrowDown", alt: true, shift: true, action: "duplicateDown" },
      { code: "ArrowUp", alt: true, shift: true, action: "duplicateUp" },
      { code: "ArrowDown", alt: true, shift: false, action: "moveDown" },
      { code: "ArrowUp", alt: true, shift: false, action: "moveUp" },
    ];

    this.emmet = {
      aa: '<a href="|" target="_blank"></a>',
      a: '<a href="|"></a>',
      pre: "<pre>|</pre>",
      code: "<code>|</code>",
      h1: "<h1>|</h1>",
      h2: "<h2>|</h2>",
      h3: "<h3>|</h3>",
    };

    this.emmetTriggers = ["Tab", ","];

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
    this.content.setAttribute("enterkeyhint", "enter");

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

  setEnableEmmet(enable) {
    this.options.enableEmmet = enable;
  }

  bindEvents() {
    this.content.addEventListener("keydown", (e) => this.onKeyDown(e));
    this.content.addEventListener("input", (e) => this.onInput(e));
    this.content.addEventListener("paste", (e) => this.onPaste(e));

    this.content.addEventListener("beforeinput", (e) => {
      if (e.inputType === "historyUndo") {
        e.preventDefault();
        this.undo();
      } else if (e.inputType === "historyRedo") {
        e.preventDefault();
        this.redo();
      }

      // Fallback для мобильных устройств: beforeinput с "," ловится
      // даже когда keydown не срабатывает (IME, голосовой ввод, Swype)
      if (
        this.options.enableEmmet &&
        e.inputType === "insertText" &&
        e.data === ","
      ) {
        if (this.tryEmmet()) {
          e.preventDefault();
        }
      }
    });

    this.content.addEventListener("keyup", (e) => {
      this.updateActiveLine();
      if (!e.shiftKey) this.resetSelectionAnchor();
    });

    this.content.addEventListener("mouseup", () => {
      this.updateActiveLine();
      this.resetSelectionAnchor();
    });

    this.content.addEventListener("click", () => {
      this.updateActiveLine();
      this.resetSelectionAnchor();
    });
  }

  newId() {
    return ++this.lineIdCounter;
  }

  resetSelectionAnchor() {
    this._selAnchor = null;
    this._selDesiredCol = undefined;
  }

  addLine(text, index = this.lines.length) {
    const line = { id: this.newId(), text: text };
    this.lines.splice(index, 0, line);
    return line;
  }

  render() {
    if (this.lines.length === 0) {
      this.lines.push({ id: this.newId(), text: "" });
    }

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

      div.innerHTML = line.text === "" ? "<br>" : this.highlight(line.text);

      this.content.appendChild(div);
    });

    if (cursor) this.setCursor(cursor);
    this.updateActiveLine();
  }

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

  _clampOffset(lineIdx, off) {
    const line = this.lines[lineIdx];
    if (!line) return 0;
    return Math.max(0, Math.min(off, line.text.length));
  }

  _getMovingEnd(anchor) {
    const cur = this.getCursor();
    if (!cur) return { line: anchor.line, offset: anchor.offset };
    if (
      anchor.line < cur.startLine ||
      (anchor.line === cur.startLine && anchor.offset <= cur.startOffset)
    ) {
      return { line: cur.endLine, offset: cur.endOffset };
    }
    return { line: cur.startLine, offset: cur.startOffset };
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
            '<span class="bce-attr-eq">' +
            eq +
            "</span>" +
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

    // Нормализуем cursor: если end "меньше" start, меняем их местами
    let startLine = cursor.startLine;
    let startOffset = cursor.startOffset;
    let endLine = cursor.endLine;
    let endOffset = cursor.endOffset;

    if (
      startLine > endLine ||
      (startLine === endLine && startOffset > endOffset)
    ) {
      // Меняем местами
      [startLine, endLine] = [endLine, startLine];
      [startOffset, endOffset] = [endOffset, startOffset];
    }

    const start = setPoint(startLine, startOffset);
    const end =
      startLine === endLine && startOffset === endOffset
        ? start
        : setPoint(endLine, endOffset);

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

  commitChange(cursor) {
    this.render();
    if (cursor) this.setCursor(cursor);
    this.pushHistory();
    this._fireOnChange();
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
    this._fireOnChange();
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
    this.lineIdCounter = 0;
    const parts = text.split("\n");
    parts.forEach((p) => this.addLine(p));
    this.render();
    this.pushHistory();
    this._fireOnChange();
  }

  setLines(lines = []) {
    this.lines = [];
    this.lineIdCounter = 0;
    lines.forEach(({ text }) => this.addLine(text));
    this.render();
    this.pushHistory();
    this._fireOnChange();
  }

  onChange(fn) {
    if (typeof fn === "function") {
      this._onChangeCallback = fn;
      fn(this);
    }
  }

  _fireOnChange() {
    if (typeof this._onChangeCallback === "function") {
      this._onChangeCallback(this);
    }
  }

  getLeadingSpaces(text) {
    return text.match(/^[ \t]*/)?.[0] ?? "";
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

    if (this.lines.length === 1 && this.lines[0].text === "") {
      this.lines[0].id = this.newId();
    }

    this.commitChange({
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
      this.commitChange({
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

      const finalLine = c.startLine + parts.length - 1;
      const finalOffset = parts[parts.length - 1].length;
      this.commitChange({
        startLine: finalLine,
        startOffset: finalOffset,
        endLine: finalLine,
        endOffset: finalOffset,
      });
    }
  }

  doAction(action) {
    switch (action) {
      case "copy":
        return this.actionCopy();
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

  actionDuplicate(dir) {
    const cursor = this.getCursor();
    if (!cursor) return;
    const idx = cursor.startLine;
    const original = this.lines[idx];
    const copy = { id: this.newId(), text: original.text };
    if (dir > 0) {
      this.lines.splice(idx + 1, 0, copy);
      this.commitChange({
        startLine: idx + 1,
        startOffset: cursor.startOffset,
        endLine: idx + 1,
        endOffset: cursor.endOffset,
      });
    } else {
      this.lines.splice(idx, 0, copy);
      this.commitChange({
        startLine: idx,
        startOffset: cursor.startOffset,
        endLine: idx,
        endOffset: cursor.endOffset,
      });
    }
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
    this.commitChange({
      startLine: target,
      startOffset: cursor.startOffset,
      endLine: target,
      endOffset: cursor.endOffset,
    });
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

    const abbr = Object.keys(this.emmet).find((k) => before.endsWith(k));
    if (!abbr) return false;

    const expansion = this.emmet[abbr];
    const cursorPos = expansion.indexOf("|");
    const clean = expansion.replace("|", "");

    const startReplace = cursor.startOffset - abbr.length;
    line.text =
      line.text.substring(0, startReplace) +
      clean +
      line.text.substring(cursor.startOffset);

    const newOffset =
      startReplace + (cursorPos >= 0 ? cursorPos : clean.length);
    this.commitChange({
      startLine: cursor.startLine,
      startOffset: newOffset,
      endLine: cursor.startLine,
      endOffset: newOffset,
    });
    return true;
  }

  matchBinding(e) {
    for (const b of this.keyBindings) {
      const ctrlOk = b.ctrl
        ? e.ctrlKey || e.metaKey
        : !(e.ctrlKey || e.metaKey);
      const shiftOk = b.shift ? e.shiftKey : !e.shiftKey;
      const altOk = b.alt ? e.altKey : !e.altKey;

      const keyMatch = b.code
        ? e.code === b.code
        : e.key.toLowerCase() === b.key.toLowerCase();

      if (keyMatch && ctrlOk && shiftOk && altOk) {
        return b.action;
      }
    }
    return null;
  }

  onKeyDown(e) {
    if (!e.shiftKey) this.resetSelectionAnchor();

    const action = this.matchBinding(e);
    if (action) {
      e.preventDefault();
      this.doAction(action);
      return;
    }

    // Проверка триггеров Emmet
    if (this.options.enableEmmet && this.emmetTriggers.includes(e.key)) {
      if (this.tryEmmet()) {
        e.preventDefault();
        return;
      }
    }

    if (e.key === "Tab" || e.key === "tab") {
      e.preventDefault();
      this.ignoreNextInput = true;
      this.handleTab(e.shiftKey);
      return;
    }

    if (e.key === "Backspace" || e.key === "Delete") {
      const cursor = this.getCursor();
      if (!cursor) return;

      const isSelection =
        cursor.startLine !== cursor.endLine ||
        cursor.startOffset !== cursor.endOffset;

      if (isSelection && cursor.startOffset === 0) {
        if (
          cursor.startLine === cursor.endLine &&
          cursor.endOffset === this.lines[cursor.startLine].text.length
        ) {
          e.preventDefault();
          this.ignoreNextInput = true;
          if (this.lines.length === 1) {
            this.lines[0] = { id: this.newId(), text: "" };
          } else {
            this.lines[cursor.startLine].text = "";
          }
          this.commitChange({
            startLine: cursor.startLine,
            startOffset: 0,
            endLine: cursor.startLine,
            endOffset: 0,
          });
          return;
        }

        if (cursor.endOffset === 0 && cursor.endLine > cursor.startLine) {
          e.preventDefault();
          this.ignoreNextInput = true;
          const deleteCount = cursor.endLine - cursor.startLine;
          if (this.lines.length - deleteCount === 0) {
            this.lines = [{ id: this.newId(), text: "" }];
          } else {
            this.lines.splice(cursor.startLine, deleteCount);
          }
          const targetLine = Math.min(cursor.startLine, this.lines.length - 1);
          this.commitChange({
            startLine: targetLine,
            startOffset: 0,
            endLine: targetLine,
            endOffset: 0,
          });
          return;
        }
      }

      if (isSelection) {
        e.preventDefault();
        this.ignoreNextInput = true;
        this.deleteSelection(cursor);
        return;
      }

      const currentLineIdx = cursor.startLine;
      const currentLine = this.lines[currentLineIdx];

      if (currentLine.text === "" && this.lines.length > 1) {
        e.preventDefault();
        this.ignoreNextInput = true;
        this.lines.splice(currentLineIdx, 1);
        let newLineIdx = currentLineIdx;
        let newOffset = 0;
        if (currentLineIdx > 0) {
          newLineIdx = currentLineIdx - 1;
          newOffset = this.lines[newLineIdx].text.length;
        }
        this.commitChange({
          startLine: newLineIdx,
          startOffset: newOffset,
          endLine: newLineIdx,
          endOffset: newOffset,
        });
        return;
      }

      if (e.key === "Backspace") {
        if (cursor.startOffset === 0 && cursor.startLine > 0) {
          e.preventDefault();
          this.ignoreNextInput = true;
          const prevLine = this.lines[cursor.startLine - 1];
          const currLine = this.lines[cursor.startLine];
          const prevLen = prevLine.text.length;
          prevLine.text += currLine.text;
          this.lines.splice(cursor.startLine, 1);
          this.commitChange({
            startLine: cursor.startLine - 1,
            startOffset: prevLen,
            endLine: cursor.startLine - 1,
            endOffset: prevLen,
          });
          return;
        }
      } else if (e.key === "Delete") {
        if (
          cursor.startOffset === currentLine.text.length &&
          cursor.startLine < this.lines.length - 1
        ) {
          e.preventDefault();
          this.ignoreNextInput = true;
          const currLine = this.lines[cursor.startLine];
          const nextLine = this.lines[cursor.startLine + 1];
          const currLen = currLine.text.length;
          currLine.text += nextLine.text;
          this.lines.splice(cursor.startLine + 1, 1);
          this.commitChange({
            startLine: cursor.startLine,
            startOffset: currLen,
            endLine: cursor.startLine,
            endOffset: currLen,
          });
          return;
        }
      }
    }

    // === Shift + стрелки: выделение ===
    if (e.shiftKey && !e.altKey && !(e.ctrlKey || e.metaKey)) {
      const cursor = this.getCursor();
      if (!cursor) return;

      if (!this._selAnchor) {
        this._selAnchor = {
          line: cursor.startLine,
          offset: cursor.startOffset,
        };
      }

      const anchor = this._selAnchor;
      const moving = this._getMovingEnd(anchor);

      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (moving.line >= this.lines.length - 1) {
          const lastLine = this.lines.length - 1;
          this.setCursor({
            startLine: anchor.line,
            startOffset: this._clampOffset(anchor.line, anchor.offset),
            endLine: lastLine,
            endOffset: this.lines[lastLine].text.length,
          });
          this.updateActiveLine();
          return;
        }
        const nextLine = moving.line + 1;
        if (this._selDesiredCol === undefined) {
          this._selDesiredCol = moving.offset;
        }
        const targetOffset = Math.min(
          this._selDesiredCol,
          this.lines[nextLine].text.length,
        );
        this.setCursor({
          startLine: anchor.line,
          startOffset: this._clampOffset(anchor.line, anchor.offset),
          endLine: nextLine,
          endOffset: targetOffset,
        });
        this.updateActiveLine();
        return;
      }

      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (moving.line === 0) {
          this.setCursor({
            startLine: anchor.line,
            startOffset: this._clampOffset(anchor.line, anchor.offset),
            endLine: 0,
            endOffset: 0,
          });
          this.updateActiveLine();
          return;
        }
        const prevLine = moving.line - 1;
        if (this._selDesiredCol === undefined) {
          this._selDesiredCol = moving.offset;
        }
        const targetOffset = Math.min(
          this._selDesiredCol,
          this.lines[prevLine].text.length,
        );
        this.setCursor({
          startLine: anchor.line,
          startOffset: this._clampOffset(anchor.line, anchor.offset),
          endLine: prevLine,
          endOffset: targetOffset,
        });
        this.updateActiveLine();
        return;
      }

      if (e.key === "ArrowLeft") {
        e.preventDefault();
        const mLine = moving.line;
        const mOffset = moving.offset;
        if (mOffset > 0) {
          this.setCursor({
            startLine: anchor.line,
            startOffset: this._clampOffset(anchor.line, anchor.offset),
            endLine: mLine,
            endOffset: mOffset - 1,
          });
        } else if (mLine > 0) {
          const prevLine = mLine - 1;
          this.setCursor({
            startLine: anchor.line,
            startOffset: this._clampOffset(anchor.line, anchor.offset),
            endLine: prevLine,
            endOffset: this.lines[prevLine].text.length,
          });
        }
        this._selDesiredCol = undefined;
        this.updateActiveLine();
        return;
      }

      if (e.key === "ArrowRight") {
        e.preventDefault();
        const mLine = moving.line;
        const mOffset = moving.offset;
        const lineLen = this.lines[mLine].text.length;
        if (mOffset < lineLen) {
          this.setCursor({
            startLine: anchor.line,
            startOffset: this._clampOffset(anchor.line, anchor.offset),
            endLine: mLine,
            endOffset: mOffset + 1,
          });
        } else if (mLine < this.lines.length - 1) {
          this.setCursor({
            startLine: anchor.line,
            startOffset: this._clampOffset(anchor.line, anchor.offset),
            endLine: mLine + 1,
            endOffset: 0,
          });
        }
        this._selDesiredCol = undefined;
        this.updateActiveLine();
        return;
      }

      if (e.key === "Home") {
        e.preventDefault();
        this.setCursor({
          startLine: anchor.line,
          startOffset: this._clampOffset(anchor.line, anchor.offset),
          endLine: moving.line,
          endOffset: 0,
        });
        this._selDesiredCol = undefined;
        this.updateActiveLine();
        return;
      }

      if (e.key === "End") {
        e.preventDefault();
        const lineIdx = moving.line;
        this.setCursor({
          startLine: anchor.line,
          startOffset: this._clampOffset(anchor.line, anchor.offset),
          endLine: lineIdx,
          endOffset: this.lines[lineIdx].text.length,
        });
        this._selDesiredCol = undefined;
        this.updateActiveLine();
        return;
      }
    }

    // === Shift + Ctrl + стрелки: выделение по словам ===
    if (e.shiftKey && (e.ctrlKey || e.metaKey) && !e.altKey) {
      const cursor = this.getCursor();
      if (!cursor) return;

      if (!this._selAnchor) {
        this._selAnchor = {
          line: cursor.startLine,
          offset: cursor.startOffset,
        };
      }

      const anchor = this._selAnchor;

      const findWordBoundary = (text, pos, direction) => {
        const len = text.length;
        if (direction > 0) {
          let i = pos;
          while (i < len && /\s/.test(text[i])) i++;
          while (i < len && !/\s/.test(text[i])) i++;
          return i;
        } else {
          let i = pos;
          if (i > 0) i--;
          while (i > 0 && /\s/.test(text[i])) i--;
          while (i > 0 && !/\s/.test(text[i])) i--;
          if (i === 0 && !/\s/.test(text[0])) return 0;
          return i > 0 ? i + 1 : 0;
        }
      };

      const moving = this._getMovingEnd(anchor);

      if (e.key === "ArrowLeft") {
        e.preventDefault();
        const mLine = moving.line;
        const mOffset = moving.offset;
        if (mOffset > 0) {
          const newOffset = findWordBoundary(
            this.lines[mLine].text,
            mOffset,
            -1,
          );
          this.setCursor({
            startLine: anchor.line,
            startOffset: this._clampOffset(anchor.line, anchor.offset),
            endLine: mLine,
            endOffset: newOffset,
          });
        } else if (mLine > 0) {
          const prevLine = mLine - 1;
          this.setCursor({
            startLine: anchor.line,
            startOffset: this._clampOffset(anchor.line, anchor.offset),
            endLine: prevLine,
            endOffset: this.lines[prevLine].text.length,
          });
        }
        this._selDesiredCol = undefined;
        this.updateActiveLine();
        return;
      }

      if (e.key === "ArrowRight") {
        e.preventDefault();
        const mLine = moving.line;
        const mOffset = moving.offset;
        const lineLen = this.lines[mLine].text.length;
        if (mOffset < lineLen) {
          const newOffset = findWordBoundary(
            this.lines[mLine].text,
            mOffset,
            1,
          );
          this.setCursor({
            startLine: anchor.line,
            startOffset: this._clampOffset(anchor.line, anchor.offset),
            endLine: mLine,
            endOffset: newOffset,
          });
        } else if (mLine < this.lines.length - 1) {
          this.setCursor({
            startLine: anchor.line,
            startOffset: this._clampOffset(anchor.line, anchor.offset),
            endLine: mLine + 1,
            endOffset: 0,
          });
        }
        this._selDesiredCol = undefined;
        this.updateActiveLine();
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
    const tabSize = this.options.tabSize;

    if (hasSelection) {
      const start = cursor.startLine;
      const end = cursor.endLine;
      const deltas = [];
      if (shift) {
        for (let i = start; i <= end; i++) {
          const leading = this.getLeadingSpaces(this.lines[i].text);
          const removeCount =
            leading.length > 0
              ? Math.min(leading.length, leading.length % tabSize || tabSize)
              : 0;
          this.lines[i].text = this.lines[i].text.substring(removeCount);
          deltas.push(-removeCount);
        }
      } else {
        for (let i = start; i <= end; i++) {
          const leading = this.getLeadingSpaces(this.lines[i].text);
          const currentLen = leading.length;
          const target = Math.ceil((currentLen + 1) / tabSize) * tabSize;
          const add = " ".repeat(target - currentLen);
          this.lines[i].text = add + this.lines[i].text;
          deltas.push(add.length);
        }
      }
      // Смещаем offset'ы с учётом дельт на строках start и end
      const newStartOffset = Math.max(0, cursor.startOffset + deltas[0]);
      const newEndOffset = Math.max(
        0,
        cursor.endOffset + deltas[deltas.length - 1],
      );
      this.commitChange({
        startLine: start,
        startOffset: newStartOffset,
        endLine: end,
        endOffset: newEndOffset,
      });
    } else {
      const line = this.lines[cursor.startLine];
      if (shift) {
        const beforeCursor = line.text.substring(0, cursor.startOffset);
        // Считаем пробелы непосредственно перед курсором
        let spaceCount = 0;
        for (let i = beforeCursor.length - 1; i >= 0; i--) {
          if (beforeCursor[i] === " ") spaceCount++;
          else break;
        }
        if (spaceCount === 0) return;
        // Предыдущий таб-стоп от позиции курсора
        const prevTabStop =
          Math.floor((cursor.startOffset - 1) / tabSize) * tabSize;
        const spacesToRemove = cursor.startOffset - prevTabStop;
        const removeCount = Math.min(spaceCount, spacesToRemove);
        if (removeCount > 0) {
          line.text =
            beforeCursor.substring(0, beforeCursor.length - removeCount) +
            line.text.substring(cursor.startOffset);
          this.commitChange({
            startLine: cursor.startLine,
            startOffset: cursor.startOffset - removeCount,
            endLine: cursor.startLine,
            endOffset: cursor.startOffset - removeCount,
          });
        }
      } else {
        const col = cursor.startOffset;
        const target = Math.ceil((col + 1) / tabSize) * tabSize;
        const add = " ".repeat(target - col);
        line.text =
          line.text.substring(0, cursor.startOffset) +
          add +
          line.text.substring(cursor.startOffset);
        this.commitChange({
          startLine: cursor.startLine,
          startOffset: cursor.startOffset + add.length,
          endLine: cursor.startLine,
          endOffset: cursor.startOffset + add.length,
        });
      }
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

    // Если курсор в начале строки и строка не пуста — вставляем пустую строку ПЕРЕД текущей
    if (cursor.startOffset === 0 && line.text !== "") {
      const newLine = { id: this.newId(), text: "" };
      this.lines.splice(cursor.startLine, 0, newLine);
      // Курсор остаётся на той же строке (она сдвинулась на +1)
      this.commitChange({
        startLine: cursor.startLine + 1,
        startOffset: 0,
        endLine: cursor.startLine + 1,
        endOffset: 0,
      });
    } else {
      line.text = before;
      const newLine = { id: this.newId(), text: indent + after };
      this.lines.splice(cursor.startLine + 1, 0, newLine);
      this.commitChange({
        startLine: cursor.startLine + 1,
        startOffset: indent.length,
        endLine: cursor.startLine + 1,
        endOffset: indent.length,
      });
    }
  }

  onInput(e) {
    if (this.ignoreNextInput) {
      this.ignoreNextInput = false;
      // Синхронизируем lines из DOM, но без render() и pushHistory
      const lineEls = this.content.querySelectorAll(".bce-line");
      const newLines = [];
      if (lineEls.length === this.lines.length) {
        lineEls.forEach((el, idx) => {
          newLines.push({ id: this.lines[idx].id, text: el.textContent || "" });
        });
      } else {
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
      }
      if (newLines.length === 1 && newLines[0].text === "") {
        newLines[0].id = this.newId();
      }
      this.lines = newLines;
      this._fireOnChange();
      return;
    }

    const lineEls = this.content.querySelectorAll(".bce-line");
    const newLines = [];

    if (lineEls.length === this.lines.length) {
      lineEls.forEach((el, idx) => {
        newLines.push({ id: this.lines[idx].id, text: el.textContent || "" });
      });
    } else {
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
    }

    if (newLines.length === 1 && newLines[0].text === "") {
      newLines[0].id = this.newId();
    }

    this.lines = newLines;
    const cursor = this.getCursor();
    this.render();
    if (cursor) requestAnimationFrame(() => this.setCursor(cursor));
    this.pushHistory();
    this._fireOnChange();
  }

  onPaste(e) {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData("text");
    if (text) {
      this.ignoreNextInput = true;
      this.insertText(text.replace(/\r\n?/g, "\n"));
    }
  }
}

window.Bce = Bce;
