// @ts-nocheck
"use strict";

/**
 * @typedef {Object} Rec
 * @property {number} id    — уникальный идентификатор строки
 * @property {string} val   — текстовое содержимое строки
 */

/**
 * @typedef {Object} BceCursor
 * @property {number}  begLn            — индекс начальной строки (нормализовано: всегда не позже endLn)
 * @property {number}  begCol           — смещение в начальной строке
 * @property {number}  endLn            — индекс конечной строки
 * @property {number}  endCol           — смещение в конечной строке
 * @property {boolean} [backward=false] — true, если выделение выполнялось справа-налево
 *                                       (курсор/фокус находится в точке beg)
 */

/**
 * @typedef {Object} BceHistorySnapshot
 * @property {Rec[]}          lines  — снимок всех строк
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
 * @property {boolean} [showRecId=false]       — показывать ID строк
 * @property {boolean} [enableEmmet=false]    — включить Emmet-сокращения
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

    // Защита от двойной инициализации: уничтожаем предыдущий экземпляр,
    // иначе останутся «висящие» обработчики и DOM от старого редактора.
    if (/** @type {any} */ (this.container).__bce) {
      console.warn(
        "Bce: контейнер уже инициализирован, предыдущий экземпляр уничтожается",
      );
      /** @type {any} */ (this.container).__bce.destroy();
    }

    /** @type {Required<BceOptions>} */
    this.options = {
      tabSize: 4,
      initialText: "",
      showLineNumbers: false,
      showRecId: false,
      enableEmmet: false,
      ...options,
    };

    /** @type {number} */
    this.seq = 0;
    /** @type {Rec[]} */
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

    /** @type {Rec<string, string>} */
    this.emmet = {
      aa: '<a href="|" target="_blank"></a>',
      a: '<a href="|"></a>',
      pre: "<pre>|</pre>",
      code: "<code>|</code>",
      h1: "<h1>|</h1>",
      h2: "<h2>|</h2>",
      h3: "<h3>|</h3>",
      h4: "<h4>|</h4>",
      h5: "<h5>|</h5>",
      h6: "<h6>|</h6>",
    };

    /** @type {string[]} */
    this.emmetTriggers = ["Tab", ","];
    /** @type {HTMLDivElement} */
    this.wrapper = null;
    /** @type {HTMLDivElement} */
    this.gutter = null;
    /** @type {HTMLDivElement} */
    this.content = null;
    /** @type {number | undefined} */
    this._selDesiredCol = undefined;
    /** @type {boolean} — идёт ли активная IME-композиция (ввод КРЯ/КПЯ, мобильные клавиатуры) */
    this._composing = false;
    /** @type {AbortController} — прерывает все слушатели в destroy() */
    this._abort = new AbortController();
    /** @type {Map<string, string>} — кэш результата highlight() по тексту строки */
    this._highlightCache = new Map();
    /** @type {number} — максимум записей в кэше подсветки (FIFO-вытеснение) */
    this._highlightCacheMax = 500;
    /**
     * Индекс текстовых узлов → позиция в модели. Заполняется в render()
     * через _indexLineNodes(); WeakMap, чтобы старые узлы собирались GC.
     * Инвалидация: DOM, изменённый браузером до onInput, не индексирован —
     * в этом случае включается флаг _nodeMapDirty и getCursor() идёт
     * резервным путём через TreeWalker.
     * @type {WeakMap<Node, { lineIdx: number, baseOffset: number }>}
     */
    this._nodeMap = new WeakMap();
    /** @type {boolean} — true, если _nodeMap устарел (см. onInput) */
    this._nodeMapDirty = false;

    this.build();
    this.bindEvents();

    if (this.options.initialText) {
      this.setText(this.options.initialText);
    } else {
      this.addLine("");
      this.render();
      this.pushHistory(null);
    }

    // Маркер «контейнер занят» для защиты от двойной инициализации
    /** @type {any} */ (this.container).__bce = this;
  }

  /**
   * Полностью уничтожает редактор: снимает все обработчики (через
   * AbortController), очищает контейнер и внутреннее состояние.
   * Для SPA-навигации: вызывайте перед тем, как выбросить экземпляр.
   * @returns {void}
   */
  destroy() {
    this._abort.abort();
    this.container.innerHTML = "";
    this.container.classList.remove(
      "bce-editor",
      "bce-no-gutter",
      "bce-show-id",
    );
    // Снимаем маркер занятости контейнера
    delete /** @type {any} */ (this.container).__bce;
    this.lines = [];
    this.history = [];
    this.historyIndex = -1;
    this._onChangeCallback = null;
    this._highlightCache?.clear();
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
   *
   * После замены курсор устанавливается в начало документа (DOM-выделение
   * после `render()` указывало на старые узлы).
   *
   * @param {string} text
   * @param {Object}   [opts]
   * @param {boolean}  [opts.resetHistory=false] — очистить историю undo/redo
   *   (по умолчанию сохранена для обратной совместимости: старый документ
   *   остаётся доступен через Ctrl+Z).
   * @returns {void}
   */
  setText(text, { resetHistory = false } = {}) {
    this.lines = [];
    this.seq = 0;
    text.split("\n").forEach((p) => this.addLine(p));
    this.render();
    this.setCursor({ begLn: 0, begCol: 0, endLn: 0, endCol: 0 });
    this._selDesiredCol = undefined;
    if (resetHistory) {
      this.history = [];
      this.historyIndex = -1;
    }
    // Курсор ещё не «прижился» к новому содержимому — снимок без курсора
    this.pushHistory(null);
    this._fireOnChange();
  }

  /**
   * Устанавливает строки из массива объектов.
   *
   * После замены курсор устанавливается в начало документа (DOM-выделение
   * после `render()` указывало на старые узлы).
   *
   * @param {Array<{ id: number, val: string }>} lines
   * @param {Object}   [opts]
   * @param {boolean}  [opts.resetHistory=false] — очистить историю undo/redo
   * @returns {void}
   */
  setLines(lines = [], { resetHistory = false } = {}) {
    this.lines = lines.map(({ id, val }) => ({ id, val }));
    let maxId = lines.reduce((max, l) => Math.max(max, l.id || 0), 0);
    this.seq = Math.max(this.seq, maxId);
    this.render();
    this.setCursor({ begLn: 0, begCol: 0, endLn: 0, endCol: 0 });
    this._selDesiredCol = undefined;
    if (resetHistory) {
      this.history = [];
      this.historyIndex = -1;
    }
    // Курсор ещё не «прижился» к новому содержимому — снимок без курсора
    this.pushHistory(null);
    this._fireOnChange();
  }

  /**
   * Сравнивает переданный массив строк с текущим содержимым редактора.
   * @param {Rec[]} lines — массив строк для сравнения
   * @returns {boolean}
   */
  notEqual(lines = []) {
    return Bce.Ne(this.lines, lines);
  }

  /**
   * Проверяет пустой ли редактор
   * @returns {boolean}
   */
  checkEmpty() {
    return this.lines.length === 1 && this.lines[0].val === "";
  }

  /**
   * Возвращает пустой массив для одной пустой строки
   * @returns {Rec[]}
   */
  /**
   * Возвращает копию строк редактора (без внутреннего массива).
   * Мутация результата не влияет на редактор.
   * @returns {Array<{ id: number, val: string }>}
   */
  getLines() {
    return this.checkEmpty() ? [] : this.lines.map((l) => ({ id: l.id, val: l.val }));
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
    this._updateGutterVisibility();
    if (this.options.showRecId) this.container.classList.add("bce-show-id");
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
    this._updateGutterVisibility();
    this.render();
  }

  /**
   * Показывает гуттер, если включены номера строк или ID строк.
   * @returns {void}
   * @private
   */
  _updateGutterVisibility() {
    const hide = !this.options.showLineNumbers && !this.options.showRecId;
    this.container.classList.toggle("bce-no-gutter", hide);
  }

  /**
   * Включает / выключает отображение ID строк в гуттере.
   * @param {boolean} show
   * @returns {void}
   */
  setShowRecId(show) {
    this.options.showRecId = show;
    this.container.classList.toggle("bce-show-id", show);
    this._updateGutterVisibility();
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
  setSequencer(num) {
    if (num > this.seq) {
      this.seq = num;
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
    const signal = { signal: this._abort.signal };
    this.content.addEventListener("keydown", (e) => this.onKeyDown(e), signal);
    this.content.addEventListener("input", (e) => this.onInput(e), signal);
    this.content.addEventListener("paste", (e) => this.onPaste(e), signal);

    // Drag & drop: браузер по умолчанию вставляет HTML и ломает модель
    // (onInput читает textContent). Перехватываем drop и вставляем
    // только plain text через insertText().
    this.content.addEventListener(
      "dragover",
      (e) => {
        e.preventDefault(); // без этого drop не сработает
      },
      signal,
    );
    this.content.addEventListener(
      "drop",
      (e) => {
        e.preventDefault();
        const dte = /** @type {DragEvent} */ (e);
        const text = dte.dataTransfer?.getData("text/plain");
        if (!text) return;
        // Устанавливаем курсор в точку drop
        const range =
          /** @type {any} */ (document).caretRangeFromPoint?.(
            dte.clientX,
            dte.clientY,
          ) ?? null;
        if (range) {
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
        }
        this.insertText(text.replace(/\r\n?/g, "\n"));
      },
      signal,
    );

    // IME-композиция (китайский / японский / корейский ввод, мобильные
    // клавиатуры): во время композиции события input приходят с промежуточным
    // текстом — рендер в этот момент ломает композицию. Обрабатываем ввод
    // один раз — в compositionend.
    this.content.addEventListener(
      "compositionstart",
      () => {
        this._composing = true;
      },
      signal,
    );
    this.content.addEventListener(
      "compositionend",
      (e) => {
        this._composing = false;
        this.onInput(e); // обработать финальный текст один раз
      },
      signal,
    );

    this.content.addEventListener(
      "beforeinput",
      (e) => {
        const inputEvent = /** @type {InputEvent} */ (e);
        if (inputEvent.inputType === "historyUndo") {
          inputEvent.preventDefault();
          this.undo();
        } else if (inputEvent.inputType === "historyRedo") {
          inputEvent.preventDefault();
          this.redo();
        } else if (inputEvent.inputType === "insertCompositionText") {
          // Промежуточный текст IME — не вмешиваемся в композицию.
          return;
        } else if (
          inputEvent.inputType === "insertText" &&
          (inputEvent.data === ">" || inputEvent.data === "<") &&
          this._tryMoveShortcut(inputEvent.data)
        ) {
          inputEvent.preventDefault();
        } else if (
          this.options.enableEmmet &&
          inputEvent.inputType === "insertText" &&
          inputEvent.data === "," &&
          this.tryEmmet()
        ) {
          inputEvent.preventDefault();
        }
      },
      signal,
    );

    const resetHandlers = () => {
      this.updateActiveLine();
      this.resetSelectionAnchor();
    };
    this.content.addEventListener(
      "keyup",
      (e) => {
        this.updateActiveLine();
        if (!e.shiftKey) this.resetSelectionAnchor();
      },
      signal,
    );
    this.content.addEventListener("mouseup", resetHandlers, signal);
    this.content.addEventListener("click", resetHandlers, signal);
  }

  /* ================================================================
  Утилиты строк / курсора
  ================================================================= */

  /**
   * Генерирует новый уникальный id строки.
   * @returns {number}
   */
  newId() {
    return ++this.seq;
  }

  /**
   * Сбрасывает состояние выделения (желаемый столбец для вертикального движения).
   * @returns {void}
   */
  resetSelectionAnchor() {
    this._selDesiredCol = undefined;
  }

  /**
   * Добавляет строку в модель.
   * @param {string} val      — содержимое строки
   * @param {number} [index]  — позиция вставки (по умолчанию — конец)
   * @returns {Rec}
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
    // Сохраняем скролл: innerHTML = "" сбрасывает его в начало,
    // а полный render() вызывается и при точечных правках (undo, redo).
    const scrollTop = this.content.scrollTop;
    const scrollLeft = this.content.scrollLeft;
    const wrapperTop = this.wrapper?.scrollTop;

    if (this.lines.length === 0) {
      this.lines.push({ id: this.newId(), val: "" });
    }
    const cursor = this.getCursor();
    this.content.innerHTML = "";
    this.gutter.innerHTML = "";

    this.lines.forEach((line, idx) => {
      const gLine = document.createElement("div");
      gLine.className = "bce-gutter-line";
      gLine.textContent = this.options.showRecId ? line.id : String(idx + 1);
      this.gutter.appendChild(gLine);

      const div = document.createElement("div");
      div.className = "bce-line";
      div.dataset.lineId = String(line.id);
      div.dataset.lineIndex = String(idx);
      div.innerHTML = line.val === "" ? "<br>" : this.highlight(line.val);
      this.content.appendChild(div);
      this._indexLineNodes(div, idx);
    });

    if (cursor) this.setCursor(cursor);
    this.updateActiveLine();
    // DOM пересоздан — индекс текстовых узлов снова актуален
    this._nodeMapDirty = false;

    // Восстанавливаем скролл, чтобы вьюпорт не прыгал
    this.content.scrollTop = scrollTop;
    this.content.scrollLeft = scrollLeft;
    if (wrapperTop !== undefined && this.wrapper) {
      this.wrapper.scrollTop = wrapperTop;
    }
  }

  /**
   * Индексирует текстовые узлы строки в `_nodeMap` для быстрого `getCursor()`.
   * Старые узлы собираются GC (WeakMap): render() пересоздаёт DOM,
   * а при перезаписи записи узла в renderLine() — заменяются.
   * @param {HTMLElement} div — элемент строки `.bce-line`
   * @param {number} idx — индекс строки в модели
   * @returns {void}
   * @private
   */
  _indexLineNodes(div, idx) {
    let base = 0;
    const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT, null);
    let tn = walker.nextNode();
    while (tn) {
      this._nodeMap.set(tn, { lineIdx: idx, baseOffset: base });
      base += tn.textContent.length;
      tn = walker.nextNode();
    }
  }

  /**
   * Перерисовывает одну строку без полного render() (инкрементальный рендер).
   * Обновляет HTML и переиндексирует текстовые узлы строки в _nodeMap.
   * @param {number} idx — индекс строки в модели
   * @returns {void}
   */
  renderLine(idx) {
    const line = this.lines[idx];
    const div = /** @type {HTMLElement | undefined} */ (
      this.content.children[idx]
    );
    if (!div || !line) return;
    div.innerHTML = line.val === "" ? "<br>" : this.highlight(line.val);
    this._indexLineNodes(div, idx);
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
    if (!cursor) return;
    // Активной подсвечивается строка курсора (фокуса), а не начало выделения
    const { ln } = this.getFocus(cursor);
    if (ln >= 0 && ln < this.lines.length) {
      this.content.children[ln]?.classList.add("bce-active");
      this.gutter.children[ln]?.classList.add("bce-active");
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
   * Возвращает позицию курсора (фокус выделения) — точку, куда «движется» выделение.
   * @param {BceCursor} cursor
   * @returns {{ ln: number, col: number }}
   */
  getFocus(cursor) {
    return cursor.backward
      ? { ln: cursor.begLn, col: cursor.begCol }
      : { ln: cursor.endLn, col: cursor.endCol };
  }

  /**
   * Возвращает якорь выделения — точку, откуда началось выделение.
   * @param {BceCursor} cursor
   * @returns {{ ln: number, col: number }}
   */
  getAnchor(cursor) {
    return cursor.backward
      ? { ln: cursor.endLn, col: cursor.endCol }
      : { ln: cursor.begLn, col: cursor.begCol };
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

    // Кэш: большинство строк не меняются при каждом рендере, а регэкспы
    // подсветки — самая дорогая часть render(). Ключ — текст строки.
    const cached = this._highlightCache.get(val);
    if (cached !== undefined) return cached;

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
    // Сохраняем в кэш с FIFO-вытеснением при переполнении
    if (this._highlightCache.size >= this._highlightCacheMax) {
      const firstKey = this._highlightCache.keys().next().value;
      this._highlightCache.delete(firstKey);
    }
    this._highlightCache.set(val, safe);
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
      // Быстрый путь: узел проиндексирован при последнем render() — O(1)
      // вместо TreeWalker по строке на каждый вызов.
      if (node.nodeType === Node.TEXT_NODE && !this._nodeMapDirty) {
        const info = this._nodeMap.get(node);
        if (info) {
          return { lineIndex: info.lineIdx, offset: info.baseOffset + offset };
        }
      }
      // Резервный путь: поднимаемся до .bce-line и считаем TreeWalker'ом.
      // Также сюда попадаем, если _nodeMap устарел (_nodeMapDirty — см. onInput).
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

    // Читаем anchor/focus напрямую из Selection: только они хранят направление
    // выделения. Range всегда нормализован (start ≤ end) и направление теряет.
    const anchor = getNodeInfo(
      sel.anchorNode ?? range.startContainer,
      sel.anchorOffset ?? range.startOffset,
    );
    const focus = getNodeInfo(
      sel.focusNode ?? range.endContainer,
      sel.focusOffset ?? range.endOffset,
    );

    const anchorFirst =
      anchor.lineIndex < focus.lineIndex ||
      (anchor.lineIndex === focus.lineIndex && anchor.offset <= focus.offset);

    const beg = anchorFirst ? anchor : focus;
    const end = anchorFirst ? focus : anchor;
    return {
      begLn: beg.lineIndex,
      begCol: beg.offset,
      endLn: end.lineIndex,
      endCol: end.offset,
      backward: !anchorFirst,
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

    let { begLn, begCol, endLn, endCol } = cursor;
    if (
      begLn > endLn ||
      (begLn === endLn && begCol > endCol)
    ) {
      [begLn, endLn] = [endLn, begLn];
      [begCol, endCol] = [endCol, begCol];
    }

    // Клампинг: невалидные индексы (например, begLn=999 после удаления строк)
    // иначе приводят к {node: content, offset: 0} — курсор прыгает в начало.
    const clampLn = (ln) => Math.max(0, Math.min(ln, this.lines.length - 1));
    begLn = clampLn(begLn);
    endLn = clampLn(endLn);
    begCol = this._clampOffset(begLn, begCol);
    endCol = this._clampOffset(endLn, endCol);

    const beg = setPoint(begLn, begCol);
    const end =
      begLn === endLn && begCol === endCol
        ? beg
        : setPoint(endLn, endCol);

    try {
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        // setBaseAndExtent сохраняет направление выделения:
        // base — точка старта (якорь), extent — точка курсора (фокус).
        const base = cursor.backward ? end : beg;
        const extent = cursor.backward ? beg : end;
        sel.setBaseAndExtent(base.node, base.offset, extent.node, extent.offset);
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
   * Курсор передаётся явно, чтобы снимок истории содержал позицию,
   * актуальную для данного изменения (а не случайное DOM-выделение).
   * @param {BceCursor} [cursor]
   * @returns {void}
   */
  commitChange(cursor) {
    this.render();
    if (cursor) this.setCursor(cursor);
    this.pushHistory(cursor);
    this._fireOnChange();
  }

  /**
   * Сохраняет текущее состояние в стек истории.
   *
   * Курсор нужно передавать явно, когда он известен (например, из
   * `commitChange`): после `render()` DOM-выделение может быть невалидным
   * и `getCursor()` вернёт чужую позицию.
   *
   * `cursor = null` — снимок без курсора (содержимое заменено целиком,
   * позиция ещё не установлена, например в `setText` / `setLines`).
   * `cursor = undefined` — курсор читается из DOM (`getCursor()`), это
   * корректно после `restoreSnapshot`, где `setCursor` уже применён.
   *
   * @param {BceCursor | null} [cursor] — снимок курсора (`undefined` — читать из DOM, `null` — без курсора)
   * @returns {void}
   */
  pushHistory(cursor = undefined) {
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push({
      lines: this.lines.map((l) => ({ id: l.id, val: l.val })),
      cursor: cursor ?? this.getCursor(),
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
   *
   * BREAKING CHANGE: по умолчанию колбэк НЕ вызывается в момент подписки
   * (раньше вызывался немедленно). Немедленный вызов приводил к рекурсии,
   * если подписчик в колбэке вызывал `setText`. Чтобы сохранить старое
   * поведение, передайте `{ immediate: true }`.
   *
   * @param {BceOnChangeCallback} fn
   * @param {Object}   [opts]
   * @param {boolean}  [opts.immediate=false] — вызвать `fn(this)` сразу при подписке
   * @returns {void}
   */
  onChange(fn, { immediate = false } = {}) {
    if (typeof fn === "function") {
      this._onChangeCallback = fn;
      if (immediate) fn(this);
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
      cursor.begLn === cursor.endLn &&
      cursor.begCol === cursor.endCol
    )
      return "";
    if (cursor.begLn === cursor.endLn) {
      return this.lines[cursor.begLn].val.substring(
        cursor.begCol,
        cursor.endCol,
      );
    }
    let result = this.lines[cursor.begLn].val.substring(cursor.begCol);
    for (let i = cursor.begLn + 1; i < cursor.endLn; i++) {
      result += "\n" + this.lines[i].val;
    }
    return (
      result +
      "\n" +
      this.lines[cursor.endLn].val.substring(0, cursor.endCol)
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
      (cursor.begLn === cursor.endLn &&
        cursor.begCol === cursor.endCol)
    )
      return;

    if (cursor.begLn === cursor.endLn) {
      const line = this.lines[cursor.begLn];
      line.val =
        line.val.substring(0, cursor.begCol) +
        line.val.substring(cursor.endCol);
    } else {
      const first = this.lines[cursor.begLn];
      const last = this.lines[cursor.endLn];
      first.val =
        first.val.substring(0, cursor.begCol) +
        last.val.substring(cursor.endCol);
      this.lines.splice(
        cursor.begLn + 1,
        cursor.endLn - cursor.begLn,
      );
    }

    if (this.lines.length === 1 && this.lines[0].val === "") {
      this.lines[0].id = this.newId();
    }

    this.commitChange({
      begLn: cursor.begLn,
      begCol: cursor.begCol,
      endLn: cursor.begLn,
      endCol: cursor.begCol,
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
    const currentLine = this.lines[c.begLn];
    const before = currentLine.val.substring(0, c.begCol);
    const after = currentLine.val.substring(c.endCol);

    if (parts.length === 1) {
      currentLine.val = before + parts[0] + after;
      this.commitChange({
        begLn: c.begLn,
        begCol: before.length + parts[0].length,
        endLn: c.begLn,
        endCol: before.length + parts[0].length,
      });
    } else {
      currentLine.val = before + parts[0];
      for (let i = 1; i < parts.length - 1; i++) {
        this.addLine(parts[i], c.begLn + i);
      }
      const lastLine = {
        id: this.newId(),
        val: parts[parts.length - 1] + after,
      };
      this.lines.splice(c.begLn + parts.length - 1, 0, lastLine);
      const finalLine = c.begLn + parts.length - 1;
      const finalOffset = parts[parts.length - 1].length;
      this.commitChange({
        begLn: finalLine,
        begCol: finalOffset,
        endLn: finalLine,
        endCol: finalOffset,
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
    if (!text) return;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => this._fallbackCopy(text));
    } else {
      this._fallbackCopy(text);
    }
  }

  /**
   * Резервное копирование в буфер обмена (например, в iframe без
   * clipboard-permissions): скрытая textarea + document.execCommand("copy").
   * @param {string} text
   * @returns {void}
   * @private
   */
  _fallbackCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch (_e) {
      /* ignore */
    }
    document.body.removeChild(ta);
  }

  /**
   * Дублирует текущую строку вверх или вниз.
   * @param {number} dir — `1` (вниз) или `-1` (вверх)
   * @returns {void}
   */
  actionDuplicate(dir) {
    const cursor = this.getCursor();
    if (!cursor) return;
    const idx = cursor.begLn;
    const copy = { id: this.newId(), val: this.lines[idx].val };
    const newIdx = dir > 0 ? idx + 1 : idx;
    this.lines.splice(newIdx, 0, copy);
    this.commitChange({
      begLn: newIdx,
      begCol: cursor.begCol,
      endLn: newIdx,
      endCol: cursor.endCol,
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
    const idx = cursor.begLn;
    const target = idx + dir;
    if (target < 0 || target >= this.lines.length) return;
    [this.lines[idx], this.lines[target]] = [
      this.lines[target],
      this.lines[idx],
    ];
    this.commitChange({
      begLn: target,
      begCol: cursor.begCol,
      endLn: target,
      endCol: cursor.endCol,
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
      cursor.begLn !== cursor.endLn ||
      cursor.begCol !== cursor.endCol
    ) {
      return false;
    }
    const line = this.lines[cursor.begLn];
    const before = line.val.substring(0, cursor.begCol);
    const abbr = Object.keys(this.emmet).find((k) => before.endsWith(k));
    if (!abbr) return false;

    const expansion = this.emmet[abbr];
    const cursorPos = expansion.indexOf("|");
    const clean = expansion.replace("|", "");
    const startReplace = cursor.begCol - abbr.length;
    line.val =
      line.val.substring(0, startReplace) +
      clean +
      line.val.substring(cursor.begCol);
    const newOffset =
      startReplace + (cursorPos >= 0 ? cursorPos : clean.length);

    this.commitChange({
      begLn: cursor.begLn,
      begCol: newOffset,
      endLn: cursor.begLn,
      endCol: newOffset,
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

    if (e.key === ">" || e.key === "<") {
      if (this._tryMoveShortcut(e.key)) {
        e.preventDefault();
        return;
      }
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

    // Без Shift: при активном выделении стрелка схлопывает его в точке
    // курсора (фокуса) и сдвигает от неё, а не по левому краю диапазона,
    // как делает браузер по умолчанию.
    if (
      !e.shiftKey &&
      !e.altKey &&
      !(e.ctrlKey || e.metaKey) &&
      ["ArrowLeft", "ArrowRight"].includes(e.key) &&
      this._handleArrowCollapse(e)
    ) {
      return;
    }

    if (
      e.shiftKey &&
      !e.altKey &&
      !(e.ctrlKey || e.metaKey) &&
      [
        "ArrowDown",
        "ArrowUp",
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
      ].includes(e.key)
    ) {
      this._handleShiftArrows(e);
      return;
    }

    if (
      e.shiftKey &&
      (e.ctrlKey || e.metaKey) &&
      !e.altKey &&
      ["ArrowLeft", "ArrowRight"].includes(e.key)
    ) {
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
   * Перемещение строки по сочетаниям `,>` (вниз) и `,<` (вверх).
   * Срабатывает, если непосредственно перед курсором стоит запятая:
   * строка перемещается, а сам символ `>` / `<` в текст не вставляется
   * (запятая остаётся на месте).
   *
   * Вызывается из двух мест: `keydown` (десктоп) и `beforeinput`
   * (мобильные браузеры, где `keydown` для `>` / `<` может не срабатывать
   * и символ приходит через `insertText`).
   * @param {string} key — нажатый символ: `">"` или `"<"`
   * @returns {boolean} — `true`, если сочетание обработано
   * @private
   */
  _tryMoveShortcut(key) {
    const dir = key === ">" ? 1 : -1;
    const cursor = this.getCursor();
    if (!cursor) return false;
    if (
      cursor.begLn !== cursor.endLn ||
      cursor.begCol !== cursor.endCol
    ) {
      return false;
    }
    if (cursor.begCol === 0) return false;

    const line = this.lines[cursor.begLn];
    if (line.val[cursor.begCol - 1] !== ",") return false;

    const idx = cursor.begLn;
    const target = idx + dir;
    if (target < 0 || target >= this.lines.length) return true;

    [this.lines[idx], this.lines[target]] = [
      this.lines[target],
      this.lines[idx],
    ];
    this.commitChange({
      begLn: target,
      begCol: cursor.begCol,
      endLn: target,
      endCol: cursor.endCol,
    });
    return true;
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
      cursor.begLn !== cursor.endLn ||
      cursor.begCol !== cursor.endCol;

    if (isSelection && cursor.begCol === 0) {
      if (
        cursor.begLn === cursor.endLn &&
        cursor.endCol === this.lines[cursor.begLn].val.length
      ) {
        e.preventDefault();
        this.ignoreNextInput = true;
        if (this.lines.length === 1) {
          this.lines[0] = { id: this.newId(), val: "" };
        } else {
          this.lines[cursor.begLn].val = "";
        }
        this.commitChange({
          begLn: cursor.begLn,
          begCol: 0,
          endLn: cursor.begLn,
          endCol: 0,
        });
        return;
      }
      if (cursor.endCol === 0 && cursor.endLn > cursor.begLn) {
        e.preventDefault();
        this.ignoreNextInput = true;
        const deleteCount = cursor.endLn - cursor.begLn;
        if (this.lines.length - deleteCount === 0) {
          this.lines = [{ id: this.newId(), val: "" }];
        } else {
          this.lines.splice(cursor.begLn, deleteCount);
        }
        const targetLine = Math.min(cursor.begLn, this.lines.length - 1);
        this.commitChange({
          begLn: targetLine,
          begCol: 0,
          endLn: targetLine,
          endCol: 0,
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

    const currentLineIdx = cursor.begLn;
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
        begLn: newLineIdx,
        begCol: newOffset,
        endLn: newLineIdx,
        endCol: newOffset,
      });
      return;
    }

    if (e.key === "Backspace") {
      if (cursor.begCol === 0 && cursor.begLn > 0) {
        e.preventDefault();
        this.ignoreNextInput = true;
        const prevLine = this.lines[cursor.begLn - 1];
        const currLine = this.lines[cursor.begLn];
        const prevLen = prevLine.val.length;
        prevLine.val += currLine.val;
        this.lines.splice(cursor.begLn, 1);
        this.commitChange({
          begLn: cursor.begLn - 1,
          begCol: prevLen,
          endLn: cursor.begLn - 1,
          endCol: prevLen,
        });
      }
    } else if (e.key === "Delete") {
      if (
        cursor.begCol === currentLine.val.length &&
        cursor.begLn < this.lines.length - 1
      ) {
        e.preventDefault();
        this.ignoreNextInput = true;
        const currLine = this.lines[cursor.begLn];
        const nextLine = this.lines[cursor.begLn + 1];
        const currLen = currLine.val.length;
        currLine.val += nextLine.val;
        this.lines.splice(cursor.begLn + 1, 1);
        this.commitChange({
          begLn: cursor.begLn,
          begCol: currLen,
          endLn: cursor.begLn,
          endCol: currLen,
        });
      }
    }
  }

  /**
   * Схлопывает выделение на позиции курсора (фокуса) и сдвигает его на один
   * символ влево / вправо.
   *
   * Браузер по умолчанию схлопывает выделение по левому краю диапазона,
   * из-за чего после выделения слева-направо нажатие ArrowLeft «прыгало»
   * в начало выделения. Здесь курсор двигается от точки фокуса — как в
   * обычных редакторах кода.
   * @param {KeyboardEvent} e
   * @returns {boolean} — `true`, если событие обработано (было выделение)
   * @private
   */
  _handleArrowCollapse(e) {
    const cursor = this.getCursor();
    if (
      !cursor ||
      (cursor.begLn === cursor.endLn && cursor.begCol === cursor.endCol)
    ) {
      return false; // выделения нет — пусть браузер двигает курсор сам
    }

    e.preventDefault();
    const { ln, col } = this.getFocus(cursor);

    let newLn = ln;
    let newCol = col;
    if (e.key === "ArrowLeft") {
      if (col > 0) {
        newCol = col - 1;
      } else if (ln > 0) {
        newLn = ln - 1;
        newCol = this.lines[newLn].val.length;
      }
    } else {
      const lineLen = this.lines[ln].val.length;
      if (col < lineLen) {
        newCol = col + 1;
      } else if (ln < this.lines.length - 1) {
        newLn = ln + 1;
        newCol = 0;
      }
    }

    this.setCursor({
      begLn: newLn,
      begCol: newCol,
      endLn: newLn,
      endCol: newCol,
    });
    this.updateActiveLine();
    this._selDesiredCol = undefined;
    return true;
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

    // Якорь и фокус берутся напрямую из курсора: направление выделения
    // (backward) уже хранится в модели, отдельный _selAnchor не нужен.
    const anchor = this.getAnchor(cursor);
    const moving = this.getFocus(cursor);

    const setCursorAndReturn = (mLn, mCol) => {
      e.preventDefault();
      this.setCursor({
        begLn: anchor.ln,
        begCol: this._clampOffset(anchor.ln, anchor.col),
        endLn: mLn,
        endCol: this._clampOffset(mLn, mCol),
        backward: mLn < anchor.ln || (mLn === anchor.ln && mCol < anchor.col),
      });
      this.updateActiveLine();
    };

    if (e.key === "ArrowDown") {
      if (moving.ln >= this.lines.length - 1) {
        const lastLine = this.lines.length - 1;
        setCursorAndReturn(lastLine, this.lines[lastLine].val.length);
        return;
      }
      const nextLine = moving.ln + 1;
      if (this._selDesiredCol === undefined)
        this._selDesiredCol = moving.col;
      const targetOffset = Math.min(
        this._selDesiredCol,
        this.lines[nextLine].val.length,
      );
      setCursorAndReturn(nextLine, targetOffset);
      return;
    }

    if (e.key === "ArrowUp") {
      if (moving.ln === 0) {
        setCursorAndReturn(0, 0);
        return;
      }
      const prevLine = moving.ln - 1;
      if (this._selDesiredCol === undefined)
        this._selDesiredCol = moving.col;
      const targetOffset = Math.min(
        this._selDesiredCol,
        this.lines[prevLine].val.length,
      );
      setCursorAndReturn(prevLine, targetOffset);
      return;
    }

    if (e.key === "ArrowLeft") {
      const { ln: mLine, col: mOffset } = moving;
      if (mOffset > 0) {
        setCursorAndReturn(mLine, mOffset - 1);
      } else if (mLine > 0) {
        const prevLine = mLine - 1;
        setCursorAndReturn(prevLine, this.lines[prevLine].val.length);
      }
      this._selDesiredCol = undefined;
      return;
    }

    if (e.key === "ArrowRight") {
      const { ln: mLine, col: mOffset } = moving;
      const lineLen = this.lines[mLine].val.length;
      if (mOffset < lineLen) {
        setCursorAndReturn(mLine, mOffset + 1);
      } else if (mLine < this.lines.length - 1) {
        setCursorAndReturn(mLine + 1, 0);
      }
      this._selDesiredCol = undefined;
      return;
    }

    if (e.key === "Home") {
      setCursorAndReturn(moving.ln, 0);
      this._selDesiredCol = undefined;
      return;
    }

    if (e.key === "End") {
      const lineIdx = moving.ln;
      setCursorAndReturn(lineIdx, this.lines[lineIdx].val.length);
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

    const anchor = this.getAnchor(cursor);

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

    const moving = this.getFocus(cursor);
    const setCursorAndReturn = (mLn, mCol) => {
      e.preventDefault();
      this.setCursor({
        begLn: anchor.ln,
        begCol: this._clampOffset(anchor.ln, anchor.col),
        endLn: mLn,
        endCol: this._clampOffset(mLn, mCol),
        backward: mLn < anchor.ln || (mLn === anchor.ln && mCol < anchor.col),
      });
      this.updateActiveLine();
    };

    if (e.key === "ArrowLeft") {
      const { ln: mLine, col: mOffset } = moving;
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
      const { ln: mLine, col: mOffset } = moving;
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
      cursor.begLn === cursor.endLn &&
      cursor.begCol === cursor.endCol
    );
    const tabSize = this.options.tabSize;

    // 1. Модификация: Если выделен текст только на ОДНОЙ строке (при обычном Tab без Shift)
    if (hasSelection && cursor.begLn === cursor.endLn && !shift) {
      const line = this.lines[cursor.begLn];

      // Вырезаем выделенный кусок прямо в модели (без вызова commitChange)
      line.val =
        line.val.substring(0, cursor.begCol) +
        line.val.substring(cursor.endCol);

      // Теперь курсор логически "схлопнулся" в точку begCol
      const col = cursor.begCol;
      const target = Math.ceil((col + 1) / tabSize) * tabSize;
      const add = " ".repeat(target - col);

      // Вставляем пробелы в ту же позицию
      line.val =
        line.val.substring(0, cursor.begCol) +
        add +
        line.val.substring(cursor.begCol);

      // Делаем ОДИН коммит для всей операции
      this.commitChange({
        begLn: cursor.begLn,
        begCol: cursor.begCol + add.length,
        endLn: cursor.begLn,
        endCol: cursor.begCol + add.length,
      });
      return;
    }

    // ОСТАЛЬНАЯ СТАНДАРТНАЯ ЛОГИКА РЕДАКТОРА (Многострочное выделение или Shift+Tab)
    if (hasSelection) {
      const { begLn: beg, endLn: end } = cursor;
      const deltas = [];

      if (shift) {
        for (let i = beg; i <= end; i++) {
          const leading = this.getLeadingSpaces(this.lines[i].val);
          const removeCount =
            leading.length > 0
              ? Math.min(leading.length, leading.length % tabSize || tabSize)
              : 0;
          this.lines[i].val = this.lines[i].val.substring(removeCount);
          deltas.push(-removeCount);
        }
      } else {
        for (let i = beg; i <= end; i++) {
          const leading = this.getLeadingSpaces(this.lines[i].val);
          const currentLen = leading.length;
          const target = Math.ceil((currentLen + 1) / tabSize) * tabSize;
          const add = " ".repeat(target - currentLen);
          this.lines[i].val = add + this.lines[i].val;
          deltas.push(add.length);
        }
      }

      this.commitChange({
        begLn: beg,
        begCol: Math.max(0, cursor.begCol + deltas[0]),
        endLn: end,
        endCol: Math.max(0, cursor.endCol + deltas[deltas.length - 1]),
      });
    } else {
      const line = this.lines[cursor.begLn];
      if (shift) {
        const beforeCursor = line.val.substring(0, cursor.begCol);
        let spaceCount = 0;
        for (let i = beforeCursor.length - 1; i >= 0; i--) {
          if (beforeCursor[i] === " ") spaceCount++;
          else break;
        }
        if (spaceCount === 0) return;
        const prevTabStop =
          Math.floor((cursor.begCol - 1) / tabSize) * tabSize;
        const spacesToRemove = cursor.begCol - prevTabStop;
        const removeCount = Math.min(spaceCount, spacesToRemove);
        if (removeCount > 0) {
          line.val =
            beforeCursor.substring(0, beforeCursor.length - removeCount) +
            line.val.substring(cursor.begCol);
          this.commitChange({
            begLn: cursor.begLn,
            begCol: cursor.begCol - removeCount,
            endLn: cursor.begLn,
            endCol: cursor.begCol - removeCount,
          });
        }
      } else {
        const col = cursor.begCol;
        const target = Math.ceil((col + 1) / tabSize) * tabSize;
        const add = " ".repeat(target - col);
        line.val =
          line.val.substring(0, cursor.begCol) +
          add +
          line.val.substring(cursor.begCol);
        this.commitChange({
          begLn: cursor.begLn,
          begCol: cursor.begCol + add.length,
          endLn: cursor.begLn,
          endCol: cursor.begCol + add.length,
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
    if (!cursor || cursor.begLn >= this.lines.length) {
      const lastIdx = Math.max(0, this.lines.length - 1);
      cursor = {
        begLn: lastIdx,
        begCol: lastIdx >= 0 ? this.lines[lastIdx].val.length : 0,
        endLn: lastIdx,
        endCol: lastIdx >= 0 ? this.lines[lastIdx].val.length : 0,
      };
    }

    if (
      cursor.begLn !== cursor.endLn ||
      cursor.begCol !== cursor.endCol
    ) {
      this.deleteSelection(cursor);
      cursor = this.getCursor() || cursor;
    }

    const line = this.lines[cursor.begLn];
    const before = line.val.substring(0, cursor.begCol);
    const after = line.val.substring(cursor.begCol);
    const indent = this.getLeadingSpaces(before);

    if (cursor.begCol === 0 && line.val !== "") {
      const newLine = { id: this.newId(), val: "" };
      this.lines.splice(cursor.begLn, 0, newLine);
      this.commitChange({
        begLn: cursor.begLn + 1,
        begCol: 0,
        endLn: cursor.begLn + 1,
        endCol: 0,
      });
    } else {
      line.val = before;
      const newLine = { id: this.newId(), val: indent + after };
      this.lines.splice(cursor.begLn + 1, 0, newLine);
      this.commitChange({
        begLn: cursor.begLn + 1,
        begCol: indent.length,
        endLn: cursor.begLn + 1,
        endCol: indent.length,
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
    const ie = /** @type {InputEvent} */ (_e);
    if (ie?.isComposing || this._composing) return;

    // DOM уже изменён браузером до этого события — индекс текстовых узлов
    // (_nodeMap) мог устареть. До ближайшего render() getCursor() обязан
    // идти резервным путём через TreeWalker.
    this._nodeMapDirty = true;

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

    const oldLines = this.lines;
    this.lines = newLines;

    if (this.ignoreNextInput) {
      this.ignoreNextInput = false;
      this._fireOnChange();
      return;
    }

    // Курсор читаем ДО изменения DOM (резервный путь через TreeWalker,
    // т.к. _nodeMapDirty === true)
    const cursor = this.getCursor();

    if (oldLines.length === newLines.length && oldLines.length > 0) {
      // Инкрементальный рендер: число строк не изменилось, позиции совпадают
      // (см. построение newLines выше). Перерисовываем только изменённые
      // строки — без пересоздания всего DOM.
      for (let i = 0; i < newLines.length; i++) {
        if (oldLines[i].val !== newLines[i].val) this.renderLine(i);
      }
      // Изменённые строки переиндексированы в renderLine(), неизменённые
      // браузер не трогал — индекс снова актуален.
      this._nodeMapDirty = false;
      this.updateActiveLine();
    } else {
      // Структурное изменение (добавление/удаление строк) — редкий случай:
      // полный render().
      this.render();
    }

    if (cursor) {
      requestAnimationFrame(() => this.setCursor(cursor));
    }
    this.pushHistory(cursor);
    this._fireOnChange();
  }

  /**
   * Обрабатывает вставку из буфера обмена.
   *
   * Флаг `ignoreNextInput` здесь НЕ ставится: `insertText` → `commitChange`
   * → `render()` полностью пересоздаёт DOM, поэтому событие `input` после
   * вставки не приходит вовсе, а «висящий» флаг заглушил бы следующее
   * реальное изменение (набор с клавиатуры).
   * @param {ClipboardEvent} e
   * @returns {void}
   */
  onPaste(e) {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData("text");
    if (text) {
      this.insertText(text.replace(/\r\n?/g, "\n"));
    }
  }
}
