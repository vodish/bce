// @ts-nocheck
"use strict";

/**
 * @typedef {Object} BceLine
 * @property {number} id    — уникальный идентификатор строки
 * @property {string} val   — текстовое содержимое строки
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
   * Статическая проверка НЕ-равенства двух массивов строго заданной структуры.
   * @param {Array<{ id: number, val: string }>} arr1
   * @param {Array<{ id: number, val: string }>} arr2
   * @returns {boolean}
   */
  static Ne(arr1, arr2) {
    if (arr1.length !== arr2.length) return true;

    for (let i = 0; i < arr1.length; i++) {
      const a = arr1[i],
        b = arr2[i];

      // Если это один и тот же объект в памяти — пропускаем
      if (a === b) continue;

      // Если один из них null/undefined или не совпадают значения полей
      if (!a || !b || a.id !== b.id || a.val !== b.val) {
        return true;
      }
    }
    return false;
  }

  /**
   * @param {string | HTMLElement} container  — селектор или DOM-элемент контейнера
   * @param {BceOptions}           [options]  — настройки редактора
   */
  constructor(container, options = {}) {
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
  Публичные методы: получение / установка текста
  ================================================================= */

  /**
   * Возвращает весь текст редактора.
   * @returns {string}
   */
  getText() {
    return this.lines.map((l) => l.val).join("\n");
  }

  /**
   * Заменяет всё содержимое редактора.
   * @param {string} text
   * @returns {void}
   */
  setText(text) {
    this.lines = [];
    this.lineIdCounter = 0;
    text.split("\n").forEach((p) => this.addLine(p));
    this.render();
    this.pushHistory();
    this._fireOnChange();
  }

  /**
   * Устанавливает строки из массива объектов.
   * @param {Array<{ id: number, val: string }>} lines
   * @returns {void}
   */
  setLines(lines = []) {
    this.lines = lines.map(({ id, val }) => ({ id, val }));
    this.lineIdCounter = lines.reduce((max, l) => Math.max(max, l.id || 0), 0);
    this.render();
    this.pushHistory();
    this._fireOnChange();
  }

  /**
   * Сравнивает переданный массив строк с текущим содержимым редактора.
   * @param {BceLine[]} lines — массив строк для сравнения
   * @returns {boolean}
   */
  areNotEqual(lines = []) {
    return Bce.Ne(this.lines, lines);
  }

  /* ================================================================
  Построение DOM
  ================================================================= */

  /**
   * Создаёт внутреннюю разметку редактора (обёртка, гуттер, контент).
   * @returns {void}
   */
  build() {
    this.container.classList.add("bce-editor");
    if (!this.options.showLineNumbers)
      this.container.classList.add("bce-no-gutter");
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

    this.wrapper.append(this.gutter, this.content);
    this.container.appendChild(this.wrapper);
  }

  /**
   * Включает / выключает нумерацию строк.
   * @param {boolean} show
   * @returns {void}
   */
  setShowLineNumbers(show) {
    this.options.showLineNumbers = show;
    this.container.classList.toggle("bce-no-gutter", !show);
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

  /**
   * Устанавливает счетчик id в ручную
   * @param {number} num
   * @returns {void}
   */
  setLineIdCounter(num) {
    if (num > this.lineIdCounter) {
      this.lineIdCounter = num;
    }
  }

  /* ================================================================
  Привязка событий
  ================================================================= */

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
      } else if (
        this.options.enableEmmet &&
        inputEvent.inputType === "insertText" &&
        inputEvent.data === "," &&
        this.tryEmmet()
      ) {
        inputEvent.preventDefault();
      }
    });

    const resetHandlers = () => {
      this.updateActiveLine();
      this.resetSelectionAnchor();
    };
    this.content.addEventListener("keyup", (e) => {
      this.updateActiveLine();
      if (!e.shiftKey) this.resetSelectionAnchor();
    });
    this.content.addEventListener("mouseup", resetHandlers);
    this.content.addEventListener("click", resetHandlers);
  }

  /* ================================================================
  Утилиты строк / курсора
  ================================================================= */

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
   * @param {string} val      — содержимое строки
   * @param {number} [index]  — позиция вставки (по умолчанию — конец)
   * @returns {BceLine}
   */
  addLine(val, index = this.lines.length) {
    const line = { id: this.newId(), val };
    this.lines.splice(index, 0, line);
    return line;
  }

  /* ================================================================
  Рендеринг
  ================================================================= */

  /**
   * Полный перерендер редактора (гуттер + контент) из модели `lines`.
   * @returns {void}
   */
  render() {
    if (this.lines.length === 0) {
      this.lines.push({ id: this.newId(), val: "" });
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
      div.innerHTML = line.val === "" ? "<br>" : this.highlight(line.val);
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
    const toggleClass = (el, cls) => el?.classList.toggle(cls, false);
    this.content
      .querySelectorAll(".bce-line")
      .forEach((l) => toggleClass(l, "bce-active"));
    this.gutter
      .querySelectorAll(".bce-gutter-line")
      .forEach((l) => toggleClass(l, "bce-active"));

    const cursor = this.getCursor();
    if (
      cursor &&
      cursor.startLine >= 0 &&
      cursor.startLine < this.lines.length
    ) {
      this.content.children[cursor.startLine]?.classList.add("bce-active");
      this.gutter.children[cursor.startLine]?.classList.add("bce-active");
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
    return line ? Math.max(0, Math.min(off, line.val.length)) : 0;
  }

  /**
   * Определяет «движущийся» конец выделения относительно якоря.
   * @param {BceAnchor} anchor
   * @returns {{ line: number, offset: number }}
   */
  _getMovingEnd(anchor) {
    const cur = this.getCursor();
    if (!cur) return { line: anchor.line, offset: anchor.offset };
    return anchor.line < cur.startLine ||
      (anchor.line === cur.startLine && anchor.offset <= cur.startOffset)
      ? { line: cur.endLine, offset: cur.endOffset }
      : { line: cur.startLine, offset: cur.startOffset };
  }

  /* ================================================================
  Подсветка синтаксиса
  ================================================================= */

  /**
   * Экранирует текст и оборачивает HTML-теги / атрибуты / комментарии
   * в `<span>` с соответствующими CSS-классами.
   * @param {string} val — сырой текст строки
   * @returns {string} — HTML-строка
   */
  highlight(val) {
    if (!val) return "";
    let safe = val
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
        const ha = attrs.replace(
          /([a-zA-Z_:][a-zA-Z0-9_.:-]*)(\s*=\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s"'&gt;]+)/g,
          (_mm, an, eq, av) =>
            `<span class="bce-attr-name">${an}</span>` +
            `<span class="bce-attr-eq">${eq}</span>` +
            `<span class="bce-attr-value">${av}</span>`,
        );
        return (
          `<span class="bce-bracket">${open}</span>` +
          `<span class="bce-tag">${name}</span>` +
          ha +
          `<span class="bce-bracket">${close}</span>`
        );
      },
    );
    return safe;
  }

  /* ================================================================
  Курсор: чтение / запись
  ================================================================= */

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
        return {
          lineIndex: parseInt(lineEl.dataset.lineIndex ?? "0", 10),
          offset: lineEl.textContent.length,
        };
      }

      const lineIndex = parseInt(lineEl.dataset.lineIndex ?? "0", 10);
      let charOffset = 0;
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
          return { lineIndex, offset: charOffset };
        }
        charOffset += currentNode.textContent.length;
        currentNode = walker.nextNode();
      }
      return { lineIndex, offset: lineEl.textContent.length };
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
      let last = lineEl;
      while (last.lastChild) last = last.lastChild;
      return last.nodeType === Node.TEXT_NODE
        ? { node: last, offset: last.textContent.length }
        : { node: lineEl, offset: lineEl.childNodes.length };
    };

    /**
     * Находит DOM-узел и смещение по координатам модели.
     * @param {number} lineIndex
     * @param {number} offset
     * @returns {BceNodePoint}
     */
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
          if (r?.found) return r;
        }
        return null;
      };

      const result = walk(lineEl);
      return result
        ? { node: result.node, offset: result.offset }
        : getEndOfLine(lineEl);
    };

    let { startLine, startOffset, endLine, endOffset } = cursor;
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
  История изменений (undo / redo)
  ================================================================= */

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
    this.history.push({
      lines: this.lines.map((l) => ({ id: l.id, val: l.val })),
      cursor: this.getCursor(),
    });
    if (this.history.length > this.maxHistory) this.history.shift();
    this.historyIndex = this.history.length - 1;
  }

  /**
   * Восстанавливает снимок из истории.
   * @param {BceHistorySnapshot} snap
   * @returns {void}
   */
  restoreSnapshot(snap) {
    this.lines = snap.lines.map((l) => ({ id: l.id, val: l.val }));
    this.render();
    if (snap.cursor) {
      requestAnimationFrame(() => this.setCursor(snap.cursor));
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
  Подписка на изменения
  ================================================================= */

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
    this._onChangeCallback?.(this);
  }

  /* ================================================================
  Работа с выделением и текстом
  ================================================================= */

  /**
   * Возвращает ведущие пробельные символы строки.
   * @param {string} val
   * @returns {string}
   */
  getLeadingSpaces(val) {
    return val.match(/^[ \t]+/)?.[0] ?? "";
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
    )
      return "";
    if (cursor.startLine === cursor.endLine) {
      return this.lines[cursor.startLine].val.substring(
        cursor.startOffset,
        cursor.endOffset,
      );
    }
    let result = this.lines[cursor.startLine].val.substring(cursor.startOffset);
    for (let i = cursor.startLine + 1; i < cursor.endLine; i++) {
      result += "\n" + this.lines[i].val;
    }
    return (
      result +
      "\n" +
      this.lines[cursor.endLine].val.substring(0, cursor.endOffset)
    );
  }

  /**
   * Удаляет выделенный текст из модели.
   * @param {BceCursor} cursor
   * @returns {void}
   */
  deleteSelection(cursor) {
    if (
      !cursor ||
      (cursor.startLine === cursor.endLine &&
        cursor.startOffset === cursor.endOffset)
    )
      return;

    if (cursor.startLine === cursor.endLine) {
      const line = this.lines[cursor.startLine];
      line.val =
        line.val.substring(0, cursor.startOffset) +
        line.val.substring(cursor.endOffset);
    } else {
      const first = this.lines[cursor.startLine];
      const last = this.lines[cursor.endLine];
      first.val =
        first.val.substring(0, cursor.startOffset) +
        last.val.substring(cursor.endOffset);
      this.lines.splice(
        cursor.startLine + 1,
        cursor.endLine - cursor.startLine,
      );
    }

    if (this.lines.length === 1 && this.lines[0].val === "") {
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
    const before = currentLine.val.substring(0, c.startOffset);
    const after = currentLine.val.substring(c.endOffset);

    if (parts.length === 1) {
      currentLine.val = before + parts[0] + after;
      this.commitChange({
        startLine: c.startLine,
        startOffset: before.length + parts[0].length,
        endLine: c.startLine,
        endOffset: before.length + parts[0].length,
      });
    } else {
      currentLine.val = before + parts[0];
      for (let i = 1; i < parts.length - 1; i++) {
        this.addLine(parts[i], c.startLine + i);
      }
      const lastLine = {
        id: this.newId(),
        val: parts[parts.length - 1] + after,
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
  Действия по горячим клавишам
  ================================================================= */

  /**
   * Диспетчер действий по имени.
   * @param {string} action — имя действия из `keyBindings`
   * @returns {void}
   */
  doAction(action) {
    const actions = {
      copy: () => this.actionCopy(),
      undo: () => this.undo(),
      redo: () => this.redo(),
      duplicateDown: () => this.actionDuplicate(1),
      duplicateUp: () => this.actionDuplicate(-1),
      moveDown: () => this.actionMove(1),
      moveUp: () => this.actionMove(-1),
    };
    actions[action]?.();
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
    const copy = { id: this.newId(), val: this.lines[idx].val };
    const newIdx = dir > 0 ? idx + 1 : idx;
    this.lines.splice(newIdx, 0, copy);
    this.commitChange({
      startLine: newIdx,
      startOffset: cursor.startOffset,
      endLine: newIdx,
      endOffset: cursor.endOffset,
    });
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
    [this.lines[idx], this.lines[target]] = [
      this.lines[target],
      this.lines[idx],
    ];
    this.commitChange({
      startLine: target,
      startOffset: cursor.startOffset,
      endLine: target,
      endOffset: cursor.endOffset,
    });
  }

  /* ================================================================
  Emmet
  ================================================================= */

  /**
   * Пытается развернуть Emmet-сокращение перед курсором.
   * @returns {boolean} — `true`, если сокращение было раскрыто
   */
  tryEmmet() {
    const cursor = this.getCursor();
    if (
      !cursor ||
      cursor.startLine !== cursor.endLine ||
      cursor.startOffset !== cursor.endOffset
    ) {
      return false;
    }
    const line = this.lines[cursor.startLine];
    const before = line.val.substring(0, cursor.startOffset);
    const abbr = Object.keys(this.emmet).find((k) => before.endsWith(k));
    if (!abbr) return false;

    const expansion = this.emmet[abbr];
    const cursorPos = expansion.indexOf("|");
    const clean = expansion.replace("|", "");
    const startReplace = cursor.startOffset - abbr.length;
    line.val =
      line.val.substring(0, startReplace) +
      clean +
      line.val.substring(cursor.startOffset);
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
  Обработка клавиатуры
  ================================================================= */

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
        : b.key?.toLowerCase() === e.key.toLowerCase();
      if (keyMatch && ctrlOk && shiftOk && altOk) return b.action;
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

    if (
      this.options.enableEmmet &&
      this.emmetTriggers.includes(e.key) &&
      this.tryEmmet()
    ) {
      e.preventDefault();
      return;
    }

    if (e.key === "Tab" || e.key === "tab") {
      e.preventDefault();
      this.ignoreNextInput = true;
      this.handleTab(e.shiftKey);
      return;
    }

    if (e.key === "Backspace" || e.key === "Delete") {
      this._handleBackspaceDelete(e);
      return;
    }

    if (e.shiftKey && !e.altKey && !(e.ctrlKey || e.metaKey)) {
      this._handleShiftArrows(e);
      return;
    }

    if (e.shiftKey && (e.ctrlKey || e.metaKey) && !e.altKey) {
      this._handleShiftCtrlArrows(e);
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      this.ignoreNextInput = true;
      this.handleEnter();
    }
  }

  /**
   * Обработка Backspace / Delete.
   * @param {KeyboardEvent} e
   * @returns {void}
   * @private
   */
  _handleBackspaceDelete(e) {
    const cursor = this.getCursor();
    if (!cursor) return;
    const isSelection =
      cursor.startLine !== cursor.endLine ||
      cursor.startOffset !== cursor.endOffset;

    if (isSelection && cursor.startOffset === 0) {
      if (
        cursor.startLine === cursor.endLine &&
        cursor.endOffset === this.lines[cursor.startLine].val.length
      ) {
        e.preventDefault();
        this.ignoreNextInput = true;
        if (this.lines.length === 1) {
          this.lines[0] = { id: this.newId(), val: "" };
        } else {
          this.lines[cursor.startLine].val = "";
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
          this.lines = [{ id: this.newId(), val: "" }];
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

    if (currentLine.val === "" && this.lines.length > 1) {
      e.preventDefault();
      this.ignoreNextInput = true;
      this.lines.splice(currentLineIdx, 1);
      let newLineIdx = currentLineIdx;
      let newOffset = 0;
      if (currentLineIdx > 0) {
        newLineIdx = currentLineIdx - 1;
        newOffset = this.lines[newLineIdx].val.length;
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
        const prevLen = prevLine.val.length;
        prevLine.val += currLine.val;
        this.lines.splice(cursor.startLine, 1);
        this.commitChange({
          startLine: cursor.startLine - 1,
          startOffset: prevLen,
          endLine: cursor.startLine - 1,
          endOffset: prevLen,
        });
      }
    } else if (e.key === "Delete") {
      if (
        cursor.startOffset === currentLine.val.length &&
        cursor.startLine < this.lines.length - 1
      ) {
        e.preventDefault();
        this.ignoreNextInput = true;
        const currLine = this.lines[cursor.startLine];
        const nextLine = this.lines[cursor.startLine + 1];
        const currLen = currLine.val.length;
        currLine.val += nextLine.val;
        this.lines.splice(cursor.startLine + 1, 1);
        this.commitChange({
          startLine: cursor.startLine,
          startOffset: currLen,
          endLine: cursor.startLine,
          endOffset: currLen,
        });
      }
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
      this._selAnchor = { line: cursor.startLine, offset: cursor.startOffset };
    }

    const anchor = this._selAnchor;
    const moving = this._getMovingEnd(anchor);

    const setCursorAndReturn = (startLine, startOffset, endLine, endOffset) => {
      e.preventDefault();
      this.setCursor({
        startLine: anchor.line,
        startOffset: this._clampOffset(anchor.line, anchor.offset),
        endLine,
        endOffset,
      });
      this.updateActiveLine();
    };

    if (e.key === "ArrowDown") {
      if (moving.line >= this.lines.length - 1) {
        const lastLine = this.lines.length - 1;
        setCursorAndReturn(
          anchor.line,
          anchor.offset,
          lastLine,
          this.lines[lastLine].val.length,
        );
        return;
      }
      const nextLine = moving.line + 1;
      if (this._selDesiredCol === undefined)
        this._selDesiredCol = moving.offset;
      const targetOffset = Math.min(
        this._selDesiredCol,
        this.lines[nextLine].val.length,
      );
      setCursorAndReturn(anchor.line, anchor.offset, nextLine, targetOffset);
      return;
    }

    if (e.key === "ArrowUp") {
      if (moving.line === 0) {
        setCursorAndReturn(anchor.line, anchor.offset, 0, 0);
        return;
      }
      const prevLine = moving.line - 1;
      if (this._selDesiredCol === undefined)
        this._selDesiredCol = moving.offset;
      const targetOffset = Math.min(
        this._selDesiredCol,
        this.lines[prevLine].val.length,
      );
      setCursorAndReturn(anchor.line, anchor.offset, prevLine, targetOffset);
      return;
    }

    if (e.key === "ArrowLeft") {
      const { line: mLine, offset: mOffset } = moving;
      if (mOffset > 0) {
        setCursorAndReturn(anchor.line, anchor.offset, mLine, mOffset - 1);
      } else if (mLine > 0) {
        const prevLine = mLine - 1;
        setCursorAndReturn(
          anchor.line,
          anchor.offset,
          prevLine,
          this.lines[prevLine].val.length,
        );
      }
      this._selDesiredCol = undefined;
      return;
    }

    if (e.key === "ArrowRight") {
      const { line: mLine, offset: mOffset } = moving;
      const lineLen = this.lines[mLine].val.length;
      if (mOffset < lineLen) {
        setCursorAndReturn(anchor.line, anchor.offset, mLine, mOffset + 1);
      } else if (mLine < this.lines.length - 1) {
        setCursorAndReturn(anchor.line, anchor.offset, mLine + 1, 0);
      }
      this._selDesiredCol = undefined;
      return;
    }

    if (e.key === "Home") {
      setCursorAndReturn(anchor.line, anchor.offset, moving.line, 0);
      this._selDesiredCol = undefined;
      return;
    }

    if (e.key === "End") {
      const lineIdx = moving.line;
      setCursorAndReturn(
        anchor.line,
        anchor.offset,
        lineIdx,
        this.lines[lineIdx].val.length,
      );
      this._selDesiredCol = undefined;
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
      this._selAnchor = { line: cursor.startLine, offset: cursor.startOffset };
    }

    const anchor = this._selAnchor;

    /**
     * Ищет границу слова в тексте.
     * @param {string} val       — текст строки
     * @param {number} pos       — текущая позиция
     * @param {number} direction — `1` (вперёд) или `-1` (назад)
     * @returns {number}
     */
    const findWordBoundary = (val, pos, direction) => {
      const len = val.length;
      if (direction > 0) {
        let i = pos;
        while (i < len && /\s/.test(val[i])) i++;
        while (i < len && !/\s/.test(val[i])) i++;
        return i;
      } else {
        let i = pos;
        if (i > 0) i--;
        while (i > 0 && /\s/.test(val[i])) i--;
        while (i > 0 && !/\s/.test(val[i])) i--;
        if (i === 0 && !/\s/.test(val[0])) return 0;
        return i > 0 ? i + 1 : 0;
      }
    };

    const moving = this._getMovingEnd(anchor);
    const setCursorAndReturn = (endLine, endOffset) => {
      e.preventDefault();
      this.setCursor({
        startLine: anchor.line,
        startOffset: this._clampOffset(anchor.line, anchor.offset),
        endLine,
        endOffset,
      });
      this.updateActiveLine();
    };

    if (e.key === "ArrowLeft") {
      const { line: mLine, offset: mOffset } = moving;
      if (mOffset > 0) {
        setCursorAndReturn(
          mLine,
          findWordBoundary(this.lines[mLine].val, mOffset, -1),
        );
      } else if (mLine > 0) {
        const prevLine = mLine - 1;
        setCursorAndReturn(prevLine, this.lines[prevLine].val.length);
      }
      this._selDesiredCol = undefined;
      return;
    }

    if (e.key === "ArrowRight") {
      const { line: mLine, offset: mOffset } = moving;
      const lineLen = this.lines[mLine].val.length;
      if (mOffset < lineLen) {
        setCursorAndReturn(
          mLine,
          findWordBoundary(this.lines[mLine].val, mOffset, 1),
        );
      } else if (mLine < this.lines.length - 1) {
        setCursorAndReturn(mLine + 1, 0);
      }
      this._selDesiredCol = undefined;
    }
  }

  /* ================================================================
  Tab / Enter
  ================================================================= */

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
      const { startLine: start, endLine: end } = cursor;
      const deltas = [];

      if (shift) {
        for (let i = start; i <= end; i++) {
          const leading = this.getLeadingSpaces(this.lines[i].val);
          const removeCount =
            leading.length > 0
              ? Math.min(leading.length, leading.length % tabSize || tabSize)
              : 0;
          this.lines[i].val = this.lines[i].val.substring(removeCount);
          deltas.push(-removeCount);
        }
      } else {
        for (let i = start; i <= end; i++) {
          const leading = this.getLeadingSpaces(this.lines[i].val);
          const currentLen = leading.length;
          const target = Math.ceil((currentLen + 1) / tabSize) * tabSize;
          const add = " ".repeat(target - currentLen);
          this.lines[i].val = add + this.lines[i].val;
          deltas.push(add.length);
        }
      }

      this.commitChange({
        startLine: start,
        startOffset: Math.max(0, cursor.startOffset + deltas[0]),
        endLine: end,
        endOffset: Math.max(0, cursor.endOffset + deltas[deltas.length - 1]),
      });
    } else {
      const line = this.lines[cursor.startLine];
      if (shift) {
        const beforeCursor = line.val.substring(0, cursor.startOffset);
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
          line.val =
            beforeCursor.substring(0, beforeCursor.length - removeCount) +
            line.val.substring(cursor.startOffset);
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
        line.val =
          line.val.substring(0, cursor.startOffset) +
          add +
          line.val.substring(cursor.startOffset);
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
    let cursor = this.getCursor();
    if (!cursor || cursor.startLine >= this.lines.length) {
      const lastIdx = Math.max(0, this.lines.length - 1);
      cursor = {
        startLine: lastIdx,
        startOffset: lastIdx >= 0 ? this.lines[lastIdx].val.length : 0,
        endLine: lastIdx,
        endOffset: lastIdx >= 0 ? this.lines[lastIdx].val.length : 0,
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
    const before = line.val.substring(0, cursor.startOffset);
    const after = line.val.substring(cursor.startOffset);
    const indent = this.getLeadingSpaces(before);

    if (cursor.startOffset === 0 && line.val !== "") {
      const newLine = { id: this.newId(), val: "" };
      this.lines.splice(cursor.startLine, 0, newLine);
      this.commitChange({
        startLine: cursor.startLine + 1,
        startOffset: 0,
        endLine: cursor.startLine + 1,
        endOffset: 0,
      });
    } else {
      line.val = before;
      const newLine = { id: this.newId(), val: indent + after };
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
  Ввод / Вставка
  ================================================================= */

  /**
   * Обрабатывает событие `input`: синхронизирует модель с DOM.
   * @param {InputEvent} _e
   * @returns {void}
   */
  onInput(_e) {
    const lineEls = this.content.querySelectorAll(".bce-line");
    const oldLinesMap = new Map(this.lines.map((l) => [l.id, l]));
    const newLines = [];

    if (lineEls.length === this.lines.length) {
      lineEls.forEach((el, idx) => {
        newLines.push({ id: this.lines[idx].id, val: el.textContent || "" });
      });
    } else {
      lineEls.forEach((el) => {
        const lineId = parseInt(el.dataset.lineId ?? "0", 10);
        newLines.push(
          lineId && oldLinesMap.has(lineId)
            ? { id: lineId, val: el.textContent || "" }
            : { id: this.newId(), val: el.textContent || "" },
        );
      });
    }

    if (newLines.length === 1 && newLines[0].val === "") {
      newLines[0].id = this.newId();
    }

    this.lines = newLines;

    if (this.ignoreNextInput) {
      this.ignoreNextInput = false;
      this._fireOnChange();
      return;
    }

    const cursor = this.getCursor();
    this.render();
    if (cursor) {
      requestAnimationFrame(() => this.setCursor(cursor));
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
