// @ts-nocheck
"use strict";

/**
 * @typedef {Object} BceLine
 * @property {number} id    — уникальный идентификатор строки
 * @property {string} row   — текстовое содержимое строки
 */

/**
 * @typedef {Object} BceCursor
 * @property {number} startLine    — индекс начальной строки
 * @property {number} startOffset  — смещение в начальной строке
 * @property {number} endLine      — индекс конечной строки
 * @property {number} endOffset    — смещение в конечной строке
 */

/**
 * @typedef {Object} BceHistorySnapshot
 * @property {BceLine[]}      lines  — снимок всех строк
 * @property {BceCursor|null} cursor — снимок позиции курсора
 */

/**
 * @typedef {Object} BceKeyBinding
 * @property {string}  [code]  — значение `KeyboardEvent.code`
 * @property {string}  [key]   — значение `KeyboardEvent.key`
 * @property {boolean} [ctrl]  — требуется ли Ctrl / Cmd
 * @property {boolean} [shift] — требуется ли Shift
 * @property {boolean} [alt]   — требуется ли Alt
 * @property {string}  action  — имя действия
 */

/**
 * @typedef {Object} BceOptions
 * @property {number}  [tabSize=4]            — размер табуляции в пробелах
 * @property {string}  [initialText=""]       — начальный текст редактора
 * @property {boolean} [showLineNumbers=false] — показывать номера строк
 * @property {boolean} [enableEmmet=false]    — включить Emmet-сокращения
 */

/**
 * @typedef {Object} BceAnchor
 * @property {number} line   — строка якоря выделения
 * @property {number} offset — смещение якоря
 */

/**
 * @typedef {Object} BceNodePoint
 * @property {Node}   node   — DOM-узел
 * @property {number} offset — смещение внутри узла
 */

/**
 * @typedef {(editor: Bce) => void} BceOnChangeCallback
 */

class Bce {
  /**
   * @param {string | HTMLElement} container  — селектор или DOM-элемент контейнера
   * @param {BceOptions}           [options]  — настройки редактора
   */
  constructor(container, options = {}) {
    /** @type {HTMLElement} */
    this.container =
      typeof container === "string"
        ? document.querySelector(container)
        : container;

    if (!this.container) throw new Error("Bce: контейнер не найден");

    /** @type {Required<BceOptions>} */
    this.options = {
      tabSize: 4,
      initialText: "",
      showLineNumbers: false,
      enableEmmet: false,
      ...options,
    };

    /** @type {number} */
    this.lineIdCounter = 0;

    /** @type {BceLine[]} */
    this.lines = [];

    /** @type {BceHistorySnapshot[]} */
    this.history = [];

    /** @type {number} */
    this.historyIndex = -1;

    /** @type {number} */
    this.maxHistory = 200;

    /** @type {boolean} */
    this.ignoreNextInput = false;

    /** @type {BceOnChangeCallback | null} */
    this._onChangeCallback = null;

    /** @type {BceKeyBinding[]} */
    this.keyBindings = [
      { code: "KeyC", ctrl: true, shift: false, action: "copy" },
      { code: "KeyZ", ctrl: true, shift: false, action: "undo" },
      { code: "KeyZ", ctrl: true, shift: true, action: "redo" },
      { code: "ArrowDown", alt: true, shift: true, action: "duplicateDown" },
      { code: "ArrowUp", alt: true, shift: true, action: "duplicateUp" },
      { code: "ArrowDown", alt: true, shift: false, action: "moveDown" },
      { code: "ArrowUp", alt: true, shift: false, action: "moveUp" },
    ];

    /** @type {Record<string, string>} */
    this.emmet = {
      aa: '<a href="|" target="_blank"></a>',
      a: '<a href="|"></a>',
      pre: "<pre>|</pre>",
      code: "<code>|</code>",
      h1: "<h1>|</h1>",
      h2: "<h2>|</h2>",
      h3: "<h3>|</h3>",
    };

    /** @type {string[]} */
    this.emmetTriggers = ["Tab", ","];

    /** @type {HTMLDivElement} */
    this.wrapper = null;

    /** @type {HTMLDivElement} */
    this.gutter = null;

    /** @type {HTMLDivElement} */
    this.content = null;

    /** @type {BceAnchor | null} */
    this._selAnchor = null;

    /** @type {number | undefined} */
    this._selDesiredCol = undefined;

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

  /* ================================================================
   *  Публичные методы: получение / установка текста
   * ================================================================ */

  /**
   * Возвращает весь текст редактора.
   * @returns {string}
   */
  getText() {
    return this.lines.map((l) => l.row).join("\n");
  }

  /**
   * Заменяет всё содержимое редактора.
   * @param {string} text
   * @returns {void}
   */
  setText(text) {
    this.lines = [];
    this.lineIdCounter = 0;
    const parts = text.split("\n");
    parts.forEach((p) => this.addLine(p));
    this.render();
    this.pushHistory();
    this._fireOnChange();
  }

  /**
   * Устанавливает строки из массива объектов.
   * @param {Array<{ id: number, row: string }>} lines
   * @returns {void}
   */
  setLines(lines = []) {
    this.lines = lines.map(({ id, row }) => ({ id, row }));
    this.lineIdCounter = lines.reduce((max, l) => Math.max(max, l.id || 0), 0);
    this.render();
    this.pushHistory();
    this._fireOnChange();
  }

  /* ================================================================
   *  Построение DOM
   * ================================================================ */

  /**
   * Создаёт внутреннюю разметку редактора (обёртка, гуттер, контент).
   * @returns {void}
   */
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

  /**
   * Включает / выключает нумерацию строк.
   * @param {boolean} show
   * @returns {void}
   */
  setShowLineNumbers(show) {
    this.options.showLineNumbers = show;
    if (show) {
      this.container.classList.remove("bce-no-gutter");
    } else {
      this.container.classList.add("bce-no-gutter");
    }
    this.render();
  }

  /**
   * Включает / выключает Emmet-сокращения.
   * @param {boolean} enable
   * @returns {void}
   */
  setEnableEmmet(enable) {
    this.options.enableEmmet = enable;
  }

  /* ================================================================
   *  Привязка событий
   * ================================================================ */

  /**
   * Навешивает все обработчики событий на редактируемую область.
   * @returns {void}
   */
  bindEvents() {
    this.content.addEventListener("keydown", (e) => this.onKeyDown(e));
    this.content.addEventListener("input", (e) => this.onInput(e));
    this.content.addEventListener("paste", (e) => this.onPaste(e));

    this.content.addEventListener("beforeinput", (e) => {
      const inputEvent = /** @type {InputEvent} */ (e);

      if (inputEvent.inputType === "historyUndo") {
        inputEvent.preventDefault();
        this.undo();
      } else if (inputEvent.inputType === "historyRedo") {
        inputEvent.preventDefault();
        this.redo();
      }

      if (
        this.options.enableEmmet &&
        inputEvent.inputType === "insertText" &&
        inputEvent.data === ","
      ) {
        if (this.tryEmmet()) {
          inputEvent.preventDefault();
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

  /* ================================================================
   *  Утилиты строк / курсора
   * ================================================================ */

  /**
   * Генерирует новый уникальный id строки.
   * @returns {number}
   */
  newId() {
    return ++this.lineIdCounter;
  }

  /**
   * Сбрасывает состояние якоря выделения.
   * @returns {void}
   */
  resetSelectionAnchor() {
    this._selAnchor = null;
    this._selDesiredCol = undefined;
  }

  /**
   * Добавляет строку в модель.
   * @param {string} text     — содержимое строки
   * @param {number} [index]  — позиция вставки (по умолчанию — конец)
   * @returns {BceLine}
   */
  addLine(text, index = this.lines.length) {
    /** @type {BceLine} */
    const line = { id: this.newId(), row: text };
    this.lines.splice(index, 0, line);
    return line;
  }

  /* ================================================================
   *  Рендеринг
   * ================================================================ */

  /**
   * Полный перерендер редактора (гуттер + контент) из модели `lines`.
   * @returns {void}
   */
  render() {
    if (this.lines.length === 0) {
      this.lines.push({ id: this.newId(), row: "" });
    }

    const cursor = this.getCursor();

    this.content.innerHTML = "";
    this.gutter.innerHTML = "";

    this.lines.forEach((line, idx) => {
      const gLine = document.createElement("div");
      gLine.className = "bce-gutter-line";
      gLine.textContent = String(idx + 1);
      this.gutter.appendChild(gLine);

      const div = document.createElement("div");
      div.className = "bce-line";
      div.dataset.lineId = String(line.id);
      div.dataset.lineIndex = String(idx);
      div.innerHTML = line.row === "" ? "<br>" : this.highlight(line.row);
      this.content.appendChild(div);
    });

    if (cursor) this.setCursor(cursor);
    this.updateActiveLine();
  }

  /**
   * Подсвечивает активную строку в контенте и гуттере.
   * @returns {void}
   */
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
      const activeLineEl = /** @type {HTMLElement} */ (
        this.content.children[cursor.startLine]
      );
      if (activeLineEl) activeLineEl.classList.add("bce-active");

      const activeGutterEl = /** @type {HTMLElement} */ (
        this.gutter.children[cursor.startLine]
      );
      if (activeGutterEl) activeGutterEl.classList.add("bce-active");
    }
  }

  /**
   * Ограничивает смещение допустимыми пределами строки.
   * @param {number} lineIdx — индекс строки
   * @param {number} off     — исходное смещение
   * @returns {number}
   */
  _clampOffset(lineIdx, off) {
    const line = this.lines[lineIdx];
    if (!line) return 0;
    return Math.max(0, Math.min(off, line.row.length));
  }

  /**
   * Определяет «движущийся» конец выделения относительно якоря.
   * @param {BceAnchor} anchor
   * @returns {{ line: number, offset: number }}
   */
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

  /* ================================================================
   *  Подсветка синтаксиса
   * ================================================================ */

  /**
   * Экранирует текст и оборачивает HTML-теги / атрибуты / комментарии
   * в `<span>` с соответствующими CSS-классами.
   * @param {string} text — сырой текст строки
   * @returns {string} — HTML-строка
   */
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
      (_m, open, name, attrs, close) => {
        /** @type {string} */
        const ha = attrs.replace(
          /([a-zA-Z_:][a-zA-Z0-9_.:-]*)(\s*=\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s"'&gt;]+)/g,
          (_mm, an, eq, av) =>
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

  /* ================================================================
   *  Курсор: чтение / запись
   * ================================================================ */

  /**
   * Считывает текущую позицию курсора из `window.getSelection()`.
   * @returns {BceCursor | null}
   */
  getCursor() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;

    const range = sel.getRangeAt(0);

    /**
     * Определяет индекс строки и символьное смещение для узла.
     * @param {Node}   node
     * @param {number} offset
     * @returns {{ lineIndex: number, offset: number }}
     */
    const getNodeInfo = (node, offset) => {
      /** @type {Node | null} */
      let lineEl = node;

      while (
        lineEl &&
        lineEl !== this.content &&
        !(
          lineEl instanceof HTMLElement && lineEl.classList.contains("bce-line")
        )
      ) {
        lineEl = lineEl.parentNode;
      }

      if (!lineEl || lineEl === this.content) {
        lineEl = this.content.lastElementChild;
        if (
          !lineEl ||
          !(
            lineEl instanceof HTMLElement &&
            lineEl.classList.contains("bce-line")
          )
        ) {
          return { lineIndex: 0, offset: 0 };
        }
        const htmlLine = /** @type {HTMLElement} */ (lineEl);
        return {
          lineIndex: parseInt(htmlLine.dataset.lineIndex ?? "0", 10),
          offset: htmlLine.textContent.length,
        };
      }

      const htmlLineEl = /** @type {HTMLElement} */ (lineEl);
      const lineIndex = parseInt(htmlLineEl.dataset.lineIndex ?? "0", 10);
      let charOffset = 0;
      let found = false;

      const walker = document.createTreeWalker(
        lineEl,
        NodeFilter.SHOW_TEXT,
        null,
        false,
      );

      /** @type {Node | null} */
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
        charOffset = htmlLineEl.textContent.length;
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

  /**
   * Устанавливает курсор / выделение в DOM по данным модели.
   * @param {BceCursor} cursor
   * @returns {void}
   */
  setCursor(cursor) {
    /**
     * Возвращает позицию в конце строки.
     * @param {HTMLElement} lineEl
     * @returns {BceNodePoint}
     */
    const getEndOfLine = (lineEl) => {
      /** @type {Node} */
      let last = lineEl;
      while (last.lastChild) last = last.lastChild;

      if (last.nodeType === Node.TEXT_NODE) {
        const textNode = /** @type {Text} */ (last);
        return { node: textNode, offset: textNode.textContent.length };
      }
      return { node: lineEl, offset: lineEl.childNodes.length };
    };

    /**
     * Находит DOM-узел и смещение по координатам модели.
     * @param {number} lineIndex
     * @param {number} offset
     * @returns {BceNodePoint}
     */
    const setPoint = (lineIndex, offset) => {
      const lineEl = /** @type {HTMLElement} */ (
        this.content.children[lineIndex]
      );
      if (!lineEl) return { node: this.content, offset: 0 };

      if (
        lineEl.childNodes.length === 0 ||
        (lineEl.childNodes.length === 1 &&
          lineEl.childNodes[0].nodeName === "BR")
      ) {
        return { node: lineEl, offset: 0 };
      }

      /** @type {number} */
      let remaining = offset;

      /**
       * Рекурсивный обход дерева узлов.
       * @param {Node} n
       * @returns {{ node: Node, offset: number, found: boolean } | null}
       */
      const walk = (n) => {
        if (n.nodeType === Node.TEXT_NODE) {
          const textNode = /** @type {Text} */ (n);
          if (remaining <= textNode.textContent.length) {
            return { node: textNode, offset: remaining, found: true };
          }
          remaining -= textNode.textContent.length;
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

    let startLine = cursor.startLine;
    let startOffset = cursor.startOffset;
    let endLine = cursor.endLine;
    let endOffset = cursor.endOffset;

    if (
      startLine > endLine ||
      (startLine === endLine && startOffset > endOffset)
    ) {
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
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } catch (_e) {
      /* ignore */
    }
  }

  /* ================================================================
   *  История изменений (undo / redo)
   * ================================================================ */

  /**
   * Применяет изменение: рендер, установка курсора, снимок в историю.
   * @param {BceCursor} [cursor]
   * @returns {void}
   */
  commitChange(cursor) {
    this.render();
    if (cursor) this.setCursor(cursor);
    this.pushHistory();
    this._fireOnChange();
  }

  /**
   * Сохраняет текущее состояние в стек истории.
   * @returns {void}
   */
  pushHistory() {
    this.history = this.history.slice(0, this.historyIndex + 1);

    /** @type {BceHistorySnapshot} */
    const snapshot = {
      lines: this.lines.map((l) => ({ id: l.id, row: l.row })),
      cursor: this.getCursor(),
    };

    this.history.push(snapshot);

    if (this.history.length > this.maxHistory) this.history.shift();
    this.historyIndex = this.history.length - 1;
  }

  /**
   * Восстанавливает снимок из истории.
   * @param {BceHistorySnapshot} snap
   * @returns {void}
   */
  restoreSnapshot(snap) {
    this.lines = snap.lines.map((l) => ({ id: l.id, row: l.row }));
    this.render();

    if (snap.cursor) {
      const cursorToRestore = snap.cursor;
      requestAnimationFrame(() => this.setCursor(cursorToRestore));
    }

    this._fireOnChange();
  }

  /**
   * Откат на один шаг.
   * @returns {void}
   */
  undo() {
    if (this.historyIndex > 0) {
      this.historyIndex--;
      this.restoreSnapshot(this.history[this.historyIndex]);
    }
  }

  /**
   * Повтор на один шаг.
   * @returns {void}
   */
  redo() {
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      this.restoreSnapshot(this.history[this.historyIndex]);
    }
  }

  /* ================================================================
   *  Подписка на изменения
   * ================================================================ */

  /**
   * Регистрирует callback, вызываемый при каждом изменении.
   * @param {BceOnChangeCallback} fn
   * @returns {void}
   */
  onChange(fn) {
    if (typeof fn === "function") {
      this._onChangeCallback = fn;
      fn(this);
    }
  }

  /**
   * Внутренний вызов зарегистрированного callback.
   * @private
   * @returns {void}
   */
  _fireOnChange() {
    if (typeof this._onChangeCallback === "function") {
      this._onChangeCallback(this);
    }
  }

  /* ================================================================
   *  Работа с выделением и текстом
   * ================================================================ */

  /**
   * Возвращает ведущие пробельные символы строки.
   * @param {string} text
   * @returns {string}
   */
  getLeadingSpaces(text) {
    return text.match(/^[ \t]*/)?.[0] ?? "";
  }

  /**
   * Возвращает текст, попавший в выделение.
   * @param {BceCursor} cursor
   * @returns {string}
   */
  getSelectedText(cursor) {
    if (
      cursor.startLine === cursor.endLine &&
      cursor.startOffset === cursor.endOffset
    ) {
      return "";
    }

    if (cursor.startLine === cursor.endLine) {
      return this.lines[cursor.startLine].row.substring(
        cursor.startOffset,
        cursor.endOffset,
      );
    }

    let result = this.lines[cursor.startLine].row.substring(cursor.startOffset);

    for (let i = cursor.startLine + 1; i < cursor.endLine; i++) {
      result += "\n" + this.lines[i].row;
    }

    result +=
      "\n" + this.lines[cursor.endLine].row.substring(0, cursor.endOffset);

    return result;
  }

  /**
   * Удаляет выделенный текст из модели.
   * @param {BceCursor} cursor
   * @returns {void}
   */
  deleteSelection(cursor) {
    if (!cursor) return;

    if (
      cursor.startLine === cursor.endLine &&
      cursor.startOffset === cursor.endOffset
    ) {
      return;
    }

    if (cursor.startLine === cursor.endLine) {
      const line = this.lines[cursor.startLine];
      line.row =
        line.row.substring(0, cursor.startOffset) +
        line.row.substring(cursor.endOffset);
    } else {
      const first = this.lines[cursor.startLine];
      const last = this.lines[cursor.endLine];

      first.row =
        first.row.substring(0, cursor.startOffset) +
        last.row.substring(cursor.endOffset);

      this.lines.splice(
        cursor.startLine + 1,
        cursor.endLine - cursor.startLine,
      );
    }

    if (this.lines.length === 1 && this.lines[0].row === "") {
      this.lines[0].id = this.newId();
    }

    this.commitChange({
      startLine: cursor.startLine,
      startOffset: cursor.startOffset,
      endLine: cursor.startLine,
      endOffset: cursor.startOffset,
    });
  }

  /**
   * Вставляет текст в текущую позицию курсора (с поддержкой многострочности).
   * @param {string} text
   * @returns {void}
   */
  insertText(text) {
    const cursor = this.getCursor();
    if (!cursor) return;

    this.deleteSelection(cursor);

    const c = this.getCursor() || cursor;
    const parts = text.split("\n");
    const currentLine = this.lines[c.startLine];
    const before = currentLine.row.substring(0, c.startOffset);
    const after = currentLine.row.substring(c.endOffset);

    if (parts.length === 1) {
      currentLine.row = before + parts[0] + after;
      this.commitChange({
        startLine: c.startLine,
        startOffset: before.length + parts[0].length,
        endLine: c.startLine,
        endOffset: before.length + parts[0].length,
      });
    } else {
      currentLine.row = before + parts[0];

      for (let i = 1; i < parts.length - 1; i++) {
        this.addLine(parts[i], c.startLine + i);
      }

      /** @type {BceLine} */
      const lastLine = {
        id: this.newId(),
        row: parts[parts.length - 1] + after,
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

  /* ================================================================
   *  Действия по горячим клавишам
   * ================================================================ */

  /**
   * Диспетчер действий по имени.
   * @param {string} action — имя действия из `keyBindings`
   * @returns {void}
   */
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

  /**
   * Копирует выделенный текст в буфер обмена.
   * @returns {void}
   */
  actionCopy() {
    const cursor = this.getCursor();
    if (!cursor) return;

    const text = this.getSelectedText(cursor);
    if (text) navigator.clipboard.writeText(text).catch(() => {});
  }

  /**
   * Дублирует текущую строку вверх или вниз.
   * @param {number} dir — `1` (вниз) или `-1` (вверх)
   * @returns {void}
   */
  actionDuplicate(dir) {
    const cursor = this.getCursor();
    if (!cursor) return;

    const idx = cursor.startLine;
    const original = this.lines[idx];

    /** @type {BceLine} */
    const copy = { id: this.newId(), row: original.row };

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

  /**
   * Перемещает текущую строку вверх или вниз.
   * @param {number} dir — `1` (вниз) или `-1` (вверх)
   * @returns {void}
   */
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

  /* ================================================================
   *  Emmet
   * ================================================================ */

  /**
   * Пытается развернуть Emmet-сокращение перед курсором.
   * @returns {boolean} — `true`, если сокращение было раскрыто
   */
  tryEmmet() {
    const cursor = this.getCursor();
    if (!cursor) return false;

    if (
      cursor.startLine !== cursor.endLine ||
      cursor.startOffset !== cursor.endOffset
    ) {
      return false;
    }

    const line = this.lines[cursor.startLine];
    const before = line.row.substring(0, cursor.startOffset);

    const abbr = Object.keys(this.emmet).find((k) => before.endsWith(k));
    if (!abbr) return false;

    const expansion = this.emmet[abbr];
    const cursorPos = expansion.indexOf("|");
    const clean = expansion.replace("|", "");
    const startReplace = cursor.startOffset - abbr.length;

    line.row =
      line.row.substring(0, startReplace) +
      clean +
      line.row.substring(cursor.startOffset);

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

  /* ================================================================
   *  Обработка клавиатуры
   * ================================================================ */

  /**
   * Проверяет событие клавиатуры на соответствие привязкам.
   * @param {KeyboardEvent} e
   * @returns {string | null} — имя действия или `null`
   */
  matchBinding(e) {
    for (const b of this.keyBindings) {
      const ctrlOk = b.ctrl
        ? e.ctrlKey || e.metaKey
        : !(e.ctrlKey || e.metaKey);
      const shiftOk = b.shift ? e.shiftKey : !e.shiftKey;
      const altOk = b.alt ? e.altKey : !e.altKey;

      const keyMatch = b.code
        ? e.code === b.code
        : b.key
          ? e.key.toLowerCase() === b.key.toLowerCase()
          : false;

      if (keyMatch && ctrlOk && shiftOk && altOk) {
        return b.action;
      }
    }
    return null;
  }

  /**
   * Главный обработчик `keydown`.
   * @param {KeyboardEvent} e
   * @returns {void}
   */
  onKeyDown(e) {
    if (!e.shiftKey) this.resetSelectionAnchor();

    const action = this.matchBinding(e);
    if (action) {
      e.preventDefault();
      this.doAction(action);
      return;
    }

    // --- Emmet-триггеры ---
    if (this.options.enableEmmet && this.emmetTriggers.includes(e.key)) {
      if (this.tryEmmet()) {
        e.preventDefault();
        return;
      }
    }

    // --- Tab ---
    if (e.key === "Tab" || e.key === "tab") {
      e.preventDefault();
      this.ignoreNextInput = true;
      this.handleTab(e.shiftKey);
      return;
    }

    // --- Backspace / Delete ---
    if (e.key === "Backspace" || e.key === "Delete") {
      const cursor = this.getCursor();
      if (!cursor) return;

      const isSelection =
        cursor.startLine !== cursor.endLine ||
        cursor.startOffset !== cursor.endOffset;

      if (isSelection && cursor.startOffset === 0) {
        if (
          cursor.startLine === cursor.endLine &&
          cursor.endOffset === this.lines[cursor.startLine].row.length
        ) {
          e.preventDefault();
          this.ignoreNextInput = true;

          if (this.lines.length === 1) {
            this.lines[0] = { id: this.newId(), row: "" };
          } else {
            this.lines[cursor.startLine].row = "";
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
            this.lines = [{ id: this.newId(), row: "" }];
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

      if (currentLine.row === "" && this.lines.length > 1) {
        e.preventDefault();
        this.ignoreNextInput = true;

        this.lines.splice(currentLineIdx, 1);

        let newLineIdx = currentLineIdx;
        let newOffset = 0;

        if (currentLineIdx > 0) {
          newLineIdx = currentLineIdx - 1;
          newOffset = this.lines[newLineIdx].row.length;
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
          const prevLen = prevLine.row.length;

          prevLine.row += currLine.row;
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
          cursor.startOffset === currentLine.row.length &&
          cursor.startLine < this.lines.length - 1
        ) {
          e.preventDefault();
          this.ignoreNextInput = true;

          const currLine = this.lines[cursor.startLine];
          const nextLine = this.lines[cursor.startLine + 1];
          const currLen = currLine.row.length;

          currLine.row += nextLine.row;
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

    // --- Shift + стрелки: выделение ---
    if (e.shiftKey && !e.altKey && !(e.ctrlKey || e.metaKey)) {
      this._handleShiftArrows(e);
      return;
    }

    // --- Shift + Ctrl/Cmd + стрелки: выделение по словам ---
    if (e.shiftKey && (e.ctrlKey || e.metaKey) && !e.altKey) {
      this._handleShiftCtrlArrows(e);
      return;
    }

    // --- Enter ---
    if (e.key === "Enter") {
      e.preventDefault();
      this.ignoreNextInput = true;
      this.handleEnter();
      return;
    }
  }

  /**
   * Обработка Shift + Arrow / Home / End (выделение).
   * @param {KeyboardEvent} e
   * @returns {void}
   * @private
   */
  _handleShiftArrows(e) {
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
          endOffset: this.lines[lastLine].row.length,
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
        this.lines[nextLine].row.length,
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
        this.lines[prevLine].row.length,
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
          endOffset: this.lines[prevLine].row.length,
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
      const lineLen = this.lines[mLine].row.length;

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
        endOffset: this.lines[lineIdx].row.length,
      });
      this._selDesiredCol = undefined;
      this.updateActiveLine();
      return;
    }
  }

  /**
   * Обработка Shift + Ctrl/Cmd + ArrowLeft / ArrowRight (выделение по словам).
   * @param {KeyboardEvent} e
   * @returns {void}
   * @private
   */
  _handleShiftCtrlArrows(e) {
    const cursor = this.getCursor();
    if (!cursor) return;

    if (!this._selAnchor) {
      this._selAnchor = {
        line: cursor.startLine,
        offset: cursor.startOffset,
      };
    }

    const anchor = this._selAnchor;

    /**
     * Ищет границу слова в тексте.
     * @param {string} text      — текст строки
     * @param {number} pos       — текущая позиция
     * @param {number} direction — `1` (вперёд) или `-1` (назад)
     * @returns {number}
     */
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
        const newOffset = findWordBoundary(this.lines[mLine].row, mOffset, -1);
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
          endOffset: this.lines[prevLine].row.length,
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
      const lineLen = this.lines[mLine].row.length;

      if (mOffset < lineLen) {
        const newOffset = findWordBoundary(this.lines[mLine].row, mOffset, 1);
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

  /* ================================================================
   *  Tab / Enter
   * ================================================================ */

  /**
   * Обрабатывает нажатие Tab (отступ) и Shift+Tab (сдвиг).
   * @param {boolean} shift — был ли зажат Shift
   * @returns {void}
   */
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

      /** @type {number[]} */
      const deltas = [];

      if (shift) {
        for (let i = start; i <= end; i++) {
          const leading = this.getLeadingSpaces(this.lines[i].row);
          const removeCount =
            leading.length > 0
              ? Math.min(leading.length, leading.length % tabSize || tabSize)
              : 0;
          this.lines[i].row = this.lines[i].row.substring(removeCount);
          deltas.push(-removeCount);
        }
      } else {
        for (let i = start; i <= end; i++) {
          const leading = this.getLeadingSpaces(this.lines[i].row);
          const currentLen = leading.length;
          const target = Math.ceil((currentLen + 1) / tabSize) * tabSize;
          const add = " ".repeat(target - currentLen);
          this.lines[i].row = add + this.lines[i].row;
          deltas.push(add.length);
        }
      }

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
        const beforeCursor = line.row.substring(0, cursor.startOffset);

        let spaceCount = 0;
        for (let i = beforeCursor.length - 1; i >= 0; i--) {
          if (beforeCursor[i] === " ") spaceCount++;
          else break;
        }

        if (spaceCount === 0) return;

        const prevTabStop =
          Math.floor((cursor.startOffset - 1) / tabSize) * tabSize;
        const spacesToRemove = cursor.startOffset - prevTabStop;
        const removeCount = Math.min(spaceCount, spacesToRemove);

        if (removeCount > 0) {
          line.row =
            beforeCursor.substring(0, beforeCursor.length - removeCount) +
            line.row.substring(cursor.startOffset);

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

        line.row =
          line.row.substring(0, cursor.startOffset) +
          add +
          line.row.substring(cursor.startOffset);

        this.commitChange({
          startLine: cursor.startLine,
          startOffset: cursor.startOffset + add.length,
          endLine: cursor.startLine,
          endOffset: cursor.startOffset + add.length,
        });
      }
    }
  }

  /**
   * Обрабатывает нажатие Enter: разбивает строку или вставляет пустую.
   * @returns {void}
   */
  handleEnter() {
    /** @type {BceCursor} */
    let cursor = this.getCursor();

    if (!cursor || cursor.startLine >= this.lines.length) {
      const lastIdx = Math.max(0, this.lines.length - 1);
      cursor = {
        startLine: lastIdx,
        startOffset: lastIdx >= 0 ? this.lines[lastIdx].row.length : 0,
        endLine: lastIdx,
        endOffset: lastIdx >= 0 ? this.lines[lastIdx].row.length : 0,
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
    const before = line.row.substring(0, cursor.startOffset);
    const after = line.row.substring(cursor.startOffset);
    const indent = this.getLeadingSpaces(before);

    if (cursor.startOffset === 0 && line.row !== "") {
      /** @type {BceLine} */
      const newLine = { id: this.newId(), row: "" };
      this.lines.splice(cursor.startLine, 0, newLine);

      this.commitChange({
        startLine: cursor.startLine + 1,
        startOffset: 0,
        endLine: cursor.startLine + 1,
        endOffset: 0,
      });
    } else {
      line.row = before;

      /** @type {BceLine} */
      const newLine = { id: this.newId(), row: indent + after };
      this.lines.splice(cursor.startLine + 1, 0, newLine);

      this.commitChange({
        startLine: cursor.startLine + 1,
        startOffset: indent.length,
        endLine: cursor.startLine + 1,
        endOffset: indent.length,
      });
    }
  }

  /* ================================================================
   *  Ввод / Вставка
   * ================================================================ */

  /**
   * Обрабатывает событие `input`: синхронизирует модель с DOM.
   * @param {InputEvent} _e
   * @returns {void}
   */
  onInput(_e) {
    if (this.ignoreNextInput) {
      this.ignoreNextInput = false;

      const lineEls = this.content.querySelectorAll(".bce-line");

      /** @type {BceLine[]} */
      const newLines = [];

      if (lineEls.length === this.lines.length) {
        lineEls.forEach((el, idx) => {
          newLines.push({
            id: this.lines[idx].id,
            row: el.textContent || "",
          });
        });
      } else {
        const oldLinesMap = new Map(this.lines.map((l) => [l.id, l]));

        lineEls.forEach((el) => {
          const text = el.textContent || "";
          const lineId = parseInt(
            /** @type {HTMLElement} */ (el).dataset.lineId ?? "0",
            10,
          );

          if (lineId && oldLinesMap.has(lineId)) {
            newLines.push({ id: lineId, row: text });
          } else {
            newLines.push({ id: this.newId(), row: text });
          }
        });
      }

      if (newLines.length === 1 && newLines[0].row === "") {
        newLines[0].id = this.newId();
      }

      this.lines = newLines;
      this._fireOnChange();
      return;
    }

    const lineEls = this.content.querySelectorAll(".bce-line");

    /** @type {BceLine[]} */
    const newLines = [];

    if (lineEls.length === this.lines.length) {
      lineEls.forEach((el, idx) => {
        newLines.push({
          id: this.lines[idx].id,
          row: el.textContent || "",
        });
      });
    } else {
      const oldLinesMap = new Map(this.lines.map((l) => [l.id, l]));

      lineEls.forEach((el) => {
        const text = el.textContent || "";
        const lineId = parseInt(
          /** @type {HTMLElement} */ (el).dataset.lineId ?? "0",
          10,
        );

        if (lineId && oldLinesMap.has(lineId)) {
          newLines.push({ id: lineId, row: text });
        } else {
          newLines.push({ id: this.newId(), row: text });
        }
      });
    }

    if (newLines.length === 1 && newLines[0].row === "") {
      newLines[0].id = this.newId();
    }

    this.lines = newLines;

    const cursor = this.getCursor();
    this.render();
    if (cursor) {
      const cursorToRestore = cursor;
      requestAnimationFrame(() => this.setCursor(cursorToRestore));
    }

    this.pushHistory();
    this._fireOnChange();
  }

  /**
   * Обрабатывает вставку из буфера обмена.
   * @param {ClipboardEvent} e
   * @returns {void}
   */
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
