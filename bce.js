"use strict";

/**
 * @typedef {Object} Rec
 * @property {number} id    - уникальный идентификатор строки
 * @property {string} val   - текстовое содержимое строки
 */

/**
 * @typedef {Object} BceCursor
 * @property {number}  begLn            - индекс начальной строки (нормализовано: всегда не позже endLn)
 * @property {number}  begCol           - смещение в начальной строке
 * @property {number}  endLn            - индекс конечной строки
 * @property {number}  endCol           - смещение в конечной строке
 * @property {boolean} [backward=false] - true, если выделение выполнялось справа-налево
 *                                       (курсор/фокус находится в точке beg)
 */

/**
 * @typedef {Object} BceHistorySnapshot
 * @property {Rec[]}          lines  - полный снимок всех строк (база истории)
 * @property {BceCursor|null} cursor - курсор состояния базы
 */

/**
 * Элементарные операции над массивом строк модели.
 * Разные варианты операции имеют разные обязательные поля, поэтому
 * BcePatchOp - размеченное объединение (discriminated union по `type`):
 * это даёт точный контроль полей после проверки `op.type === ...`.
 *
 * @typedef {Object} BceInsertOp
 * @property {"insert"} type - вставка строк
 * @property {number} index  - индекс вставки
 * @property {Rec[]} lines   - вставляемые строки
 */

/**
 * @typedef {Object} BceDeleteOp
 * @property {"delete"} type - удаление строк
 * @property {number} index  - индекс первой удаляемой строки
 * @property {number} count  - число удаляемых строк
 */

/**
 * @typedef {Object} BceReplaceOp
 * @property {"replace"} type  - замена строк
 * @property {number} index    - индекс первой заменяемой строки
 * @property {Rec|Rec[]} lines - заменяющие строки
 */

/**
 * @typedef {Object} BceSetLinesOp
 * @property {"setLines"} type - полная замена документа
 * @property {Rec[]} lines     - весь документ
 */

/**
 * @typedef {BceInsertOp|BceDeleteOp|BceReplaceOp|BceSetLinesOp} BcePatchOp
 */

/**
 * Запись истории: пара «вперёд/назад» + курсоры «до/после».
 * forward и inverse применяются как обычные списки операций:
 * inverse построен в порядке, обратном forward.
 *
 * @typedef {Object} BcePatchEntry
 * @property {BcePatchOp[]}   forward      - операции «вперёд» (redo)
 * @property {BcePatchOp[]}   inverse      - обратные операции (undo),
 *                                           содержат удалённые/заменённые строки
 * @property {BceCursor|null} cursorBefore - курсор до применения forward
 * @property {BceCursor|null} cursorAfter  - курсор после применения forward
 */

/**
 * @typedef {Object} BceKeyBinding
 * @property {string}  [code] - значение `KeyboardEvent.code`
 * @property {string}  [key] - значение `KeyboardEvent.key`
 * @property {boolean} [ctrl] - требуется ли Ctrl / Cmd
 * @property {boolean} [shift] - требуется ли Shift
 * @property {boolean} [alt] - требуется ли Alt
 * @property {string}  action  - имя действия
 */

/**
 * @typedef {Object} BceOptions
 * @property {number}  [tabSize=4] - размер табуляции в пробелах
 * @property {string}  [initialText=""] - начальный текст редактора
 * @property {boolean} [showLineNumbers=false] - показывать номера строк
 * @property {boolean} [showRecId=false] - показывать ID строк
 * @property {boolean} [enableEmmet=false] - включить Emmet-сокращения
 */

/**
 * @typedef {Object} BceNodePoint
 * @property {Node}   node   - DOM-узел
 * @property {number} offset - смещение внутри узла
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

      if (a === b) continue;

      if (!a || !b || a.id !== b.id || a.val !== b.val) {
        return true;
      }
    }
    return false;
  }

  /**
   * Ищет границу слова в тексте (используется Shift+Ctrl+Arrows).
   * Не использует состояние экземпляра - можно вызывать как
   * Bce.prototype.findWordBoundary.call(null, val, pos, dir).
   * @param {string} val       текст строки
   * @param {number} pos       текущая позиция
   * @param {number} direction 1 (вперёд) или -1 (назад)
   * @returns {number}
   */
  findWordBoundary(val, pos, direction) {
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
  }

  /**
   * @param {string | HTMLElement} container - селектор или DOM-элемент контейнера
   * @param {BceOptions}           [options] - настройки редактора
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
    /**
     * База истории («якорь»): полный снимок, поверх которого живёт стек
     * патчей. Периодически «схлопывается» в _compactHistory(), чтобы память
     * не росла линейно на больших документах.
     * @type {BceHistorySnapshot | null}
     */
    this._baseSnapshot = null;
    /** @type {BcePatchEntry[]} - стек патчей поверх базы */
    this.history = [];
    /**
     * Указатель в стеке патчей: состояние = база + history[0..historyIndex].
     * `-1` - текущее состояние совпадает с базой.
     * @type {number}
     */
    this.historyIndex = -1;
    /** @type {number} - максимальная глубина «прошлого» до компакции базы */
    this.maxHistory = 200;
    /**
     * «Пропустить следующее событие input»: правка уже закоммичена в модель
     * обработчиком клавиши, и повторная обработка того же input не нужна.
     * Ставится только через _ignoreNextInputOnce() - он же снимает флаг в
     * конце текущей задачи (см. ниже).
     * @type {boolean}
     */
    this.ignoreNextInput = false;
    /** @type {ReturnType<typeof setTimeout> | 0} - таймер снятия ignoreNextInput */
    this._ignoreNextInputTimer = 0;
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
      h4: "<h4>|</h4>",
      h5: "<h5>|</h5>",
      h6: "<h6>|</h6>",
    };

    /** @type {string[]} */
    this.emmetTriggers = ["Tab", ","];
    /** @type {HTMLDivElement} */
    this.wrapper = /** @type {any} */ (null);
    /** @type {HTMLDivElement} */
    this.gutter = /** @type {any} */ (null);
    /** @type {HTMLDivElement} */
    this.content = /** @type {any} */ (null);
    /** @type {BceCursor | null} */
    this.cursor = null;
    /**
     * Выделение (курсор) в состоянии ДО текущей правки. Снимается в
     * событиях, которые предшествуют изменению DOM (keydown, beforeinput,
     * paste/cut/drop, keyup/mouseup/click), и при программном setCursor().
     *
     * Нужен истории: onInput видит DOM уже изменённым, поэтому позицию «до»
     * оттуда не прочитать - без снимка undo не знал бы, куда возвращать
     * каретку (в частности, после замены выделения курсор уезжал в начало
     * документа вместо начала выделения).
     * @type {BceCursor | null}
     */
    this._selectionBefore = null;
    /** @type {number | undefined} */
    this._selDesiredCol = undefined;
    /** @type {boolean} - идёт ли активная IME-композиция (ввод КРЯ/КПЯ, мобильные клавиатуры) */
    this._composing = false;
    /** @type {boolean} - идёт ли асинхронная порционная вставка */
    this._inserting = false;
    /**
     * Опциональный колбэк прогресса порционной вставки: вызывается после
     * каждой порции insertTextChunked().
     * @type {((p: { inserted: number, total: number }) => void) | null}
     */
    this.onProgress = null;
    /** @type {AbortController} - прерывает все слушатели в destroy() */
    this._abort = new AbortController();
    /** @type {Map<string, string>} - кэш результата highlight() по тексту строки */
    this._highlightCache = new Map();
    /** @type {number} - максимум записей в кэше подсветки (FIFO-вытеснение) */
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
    /** @type {boolean} - true, если _nodeMap устарел (см. onInput) */
    this._nodeMapDirty = false;
    /** @type {number} - кэш индекса активной строки (O(1) updateActiveLine) */
    this._activeLine = -1;
    /** @type {string[] | null} - кэш Object.keys(this.emmet) (сбрасывается в add/removeEmmet) */
    this._emmetKeys = null;

    this.build();
    this.bindEvents();

    if (this.options.initialText) {
      this.setText(this.options.initialText);
    } else {
      this.addLine("");
      this.render();
      this._resetHistoryBase();
    }

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
    delete (/** @type {any} */ (this.container).__bce);
    this.lines = [];
    this._baseSnapshot = null;
    this.history = [];
    this.historyIndex = -1;
    this._activeLine = -1;
    this.cursor = null;
    this._selectionBefore = null;
    if (this._ignoreNextInputTimer) clearTimeout(this._ignoreNextInputTimer);
    this._ignoreNextInputTimer = 0;
    this.ignoreNextInput = false;
    this._onChangeCallback = null;
    this._highlightCache?.clear();
    this._emmetKeys = null;
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
   * Замена документа целиком - спец-операция истории (`setLines`): в патч
   * пишутся полные копии «до/после». Операция редкая, O(N) допустим.
   *
   * @param {string} text
   * @param {Object}   [opts]
   * @param {boolean}  [opts.resetHistory=false] - очистить историю undo/redo
   *   (по умолчанию сохранена для обратной совместимости: старый документ
   *   остаётся доступен через Ctrl+Z).
   * @returns {void}
   */
  setText(text, { resetHistory = false } = {}) {
    // Выделение до замены документа: после render() DOM-выделение указывает
    // на старые узлы, и undo должен вернуть каретку в прежнюю позицию.
    this._captureSelection();
    const cursorBefore = this._selectionBefore
      ? { ...this._selectionBefore }
      : null;
    const oldLines = this.lines.map((l) => ({ id: l.id, val: l.val }));
    this.lines = [];
    this.seq = 0;
    text.split("\n").forEach((p) => this.addLine(p));
    const setOp = /** @type {BceSetLinesOp} */ ({
      type: "setLines",
      lines: this.lines.map((l) => ({ id: l.id, val: l.val })),
    });
    this.render();
    const startCursor = { begLn: 0, begCol: 0, endLn: 0, endCol: 0 };
    this.setCursor(startCursor);
    this.cursor = startCursor;
    this._selDesiredCol = undefined;
    if (resetHistory) {
      this._resetHistoryBase();
    } else {
      this._pushEntry(
        [setOp],
        startCursor,
        [{ type: "setLines", lines: oldLines }],
        cursorBefore,
      );
    }
    this._fireOnChange();
  }

  /**
   * Устанавливает строки из массива объектов.
   *
   * После замены курсор устанавливается в начало документа (DOM-выделение
   * после `render()` указывало на старые узлы).
   *
   * Замена документа целиком - спец-операция истории (`setLines`): в патч
   * пишутся полные копии «до/после». Операция редкая, O(N) допустим.
   *
   * @param {Array<{ id: number, val: string }>} lines
   * @param {Object}   [opts]
   * @param {boolean}  [opts.resetHistory=false] - очистить историю undo/redo
   * @returns {void}
   */
  setLines(lines = [], { resetHistory = false } = {}) {
    // См. setText(): снимок выделения «до» нужен для корректного undo
    this._captureSelection();
    const cursorBefore = this._selectionBefore
      ? { ...this._selectionBefore }
      : null;
    const oldLines = this.lines.map((l) => ({ id: l.id, val: l.val }));
    this.lines = lines.map(({ id, val }) => ({ id, val }));
    let maxId = lines.reduce((max, l) => Math.max(max, l.id || 0), 0);
    this.seq = Math.max(this.seq, maxId);
    const setOp = /** @type {BceSetLinesOp} */ ({
      type: "setLines",
      lines: this.lines.map((l) => ({ id: l.id, val: l.val })),
    });
    this.render();
    const startCursor = { begLn: 0, begCol: 0, endLn: 0, endCol: 0 };
    this.setCursor(startCursor);
    this.cursor = startCursor;
    this._selDesiredCol = undefined;
    if (resetHistory) {
      this._resetHistoryBase();
    } else {
      this._pushEntry(
        [setOp],
        startCursor,
        [{ type: "setLines", lines: oldLines }],
        cursorBefore,
      );
    }
    this._fireOnChange();
  }

  /**
   * Сравнивает переданный массив строк с текущим содержимым редактора.
   * @param {Rec[]} lines - массив строк для сравнения
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
   * Возвращает копию строк редактора (без внутреннего массива).
   * Мутация результата не влияет на редактор.
   * @returns {Array<{ id: number, val: string }>}
   */
  getLines() {
    return this.checkEmpty()
      ? []
      : this.lines.map((l) => ({ id: l.id, val: l.val }));
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
   * Добавляет / переопределяет Emmet-сокращение.
   * Шаблон: HTML с `|` в позиции курсора после разворота.
   * @param {string} key      - сокращение (например, `"div"`)
   * @param {string} template - шаблон разворота (например, `"<div>|</div>"`)
   * @returns {void}
   */
  addEmmet(key, template) {
    this.emmet[key] = template;
    this._emmetKeys = null;
  }

  /**
   * Удаляет Emmet-сокращение.
   * @param {string} key
   * @returns {void}
   */
  removeEmmet(key) {
    delete this.emmet[key];
    this._emmetKeys = null;
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
    this.content.addEventListener("copy", (e) => this.onCopy(e), signal);
    this.content.addEventListener("cut", (e) => this.onCut(e), signal);

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
        // Выделение «до» - до перемещения каретки в точку drop
        this._captureSelection();
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
        this.insertTextChunked(text.replace(/\r\n?/g, "\n"));
      },
      signal,
    );

    // IME-композиция (китайский / японский / корейский ввод, мобильные
    // клавиатуры): во время композиции события input приходят с промежуточным
    // текстом - рендер в этот момент ломает композицию. Обрабатываем ввод
    // один раз - в compositionend.
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
        this.onInput(e, { deferCursor: true });
      },
      signal,
    );

    this.content.addEventListener(
      "beforeinput",
      (e) => {
        const inputEvent = /** @type {InputEvent} */ (e);
        // beforeinput приходит ДО изменения DOM - это последняя точка, где
        // ещё можно прочитать выделение, которое правка заменит. Для
        // undo/redo не нужно: они сами восстанавливают позицию каретки.
        if (
          inputEvent.inputType !== "historyUndo" &&
          inputEvent.inputType !== "historyRedo"
        ) {
          this._captureSelection();
        }
        if (inputEvent.inputType === "historyUndo") {
          inputEvent.preventDefault();
          this.undo();
        } else if (inputEvent.inputType === "historyRedo") {
          inputEvent.preventDefault();
          this.redo();
        } else if (inputEvent.inputType === "insertCompositionText") {
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
      // Пользователь мог переместить каретку/выделение мышью или клавишами -
      // запоминаем позицию для истории (см. _selectionBefore)
      this._captureSelection();
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
   * @param {string} val      - содержимое строки
   * @param {number} [index] - позиция вставки (по умолчанию - конец)
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
      gLine.textContent = String(this.options.showRecId ? line.id : idx + 1);
      this.gutter.appendChild(gLine);

      const div = document.createElement("div");
      div.className = "bce-line";
      div.dataset.lineId = String(line.id);
      div.innerHTML = line.val === "" ? "<br>" : this.highlight(line.val);
      this.content.appendChild(div);
      this._indexLineNodes(div, idx);
    });

    if (cursor) this.setCursor(cursor);
    this._activeLine = -1;
    this.updateActiveLine();
    this._nodeMapDirty = false;

    this.content.scrollTop = scrollTop;
    this.content.scrollLeft = scrollLeft;
    if (wrapperTop !== undefined && this.wrapper) {
      this.wrapper.scrollTop = wrapperTop;
    }
  }

  /**
   * Индексирует текстовые узлы строки в `_nodeMap` для быстрого `getCursor()`.
   * Старые узлы собираются GC (WeakMap): render() пересоздаёт DOM,
   * а при перезаписи записи узла в renderLine() - заменяются.
   * @param {HTMLElement} div - элемент строки `.bce-line`
   * @param {number} idx - индекс строки в модели
   * @returns {void}
   * @private
   */
  _indexLineNodes(div, idx) {
    let base = 0;
    const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT, null);
    let tn = walker.nextNode();
    while (tn) {
      this._nodeMap.set(tn, { lineIdx: idx, baseOffset: base });
      base += (tn.textContent || "").length;
      tn = walker.nextNode();
    }
  }

  /**
   * Перерисовывает одну строку без полного render() (инкрементальный рендер).
   * Обновляет HTML, dataset (lineId), гуттер и переиндексирует
   * текстовые узлы строки в _nodeMap.
   * @param {number} idx - индекс строки в модели
   * @returns {void}
   */
  renderLine(idx) {
    const div = /** @type {HTMLElement | undefined} */ (
      this.content.children[idx]
    );
    const line = this.lines[idx];
    if (!div || !line) return;
    this._fillLineNode(div, idx);
    const g = /** @type {HTMLElement | undefined} */ (
      this.gutter.children[idx]
    );
    if (g) this._fillGutterNode(g, idx);
    this._indexLineNodes(div, idx);
  }

  /**
   * Заполняет узел строки `.bce-line` данными строки модели: класс, dataset
   * (lineId), подсвеченный HTML. Общая логика для renderLine() и
   * батч-вставки в _renderPatch() - узел наполняется ДО вставки в документ,
   * чтобы вся порция попадала в DOM одним insertBefore (один reflow).
   * @param {HTMLElement} div - элемент строки (в документе или во фрагменте)
   * @param {number} idx - индекс строки в модели
   * @returns {void}
   * @private
   */
  _fillLineNode(div, idx) {
    const line = this.lines[idx];
    const wasActive = div.classList.contains("bce-active");
    div.className = "bce-line";
    if (wasActive) div.classList.add("bce-active");
    if (!line) return;
    div.dataset.lineId = String(line.id);
    div.innerHTML = line.val === "" ? "<br>" : this.highlight(line.val);
  }

  /**
   * Заполняет узел гуттера: класс и номер строки (или ID при showRecId).
   * @param {HTMLElement} gi - элемент гуттера (в документе или во фрагменте)
   * @param {number} idx - индекс строки в модели
   * @returns {void}
   * @private
   */
  _fillGutterNode(gi, idx) {
    const line = this.lines[idx];
    const wasActive = gi.classList.contains("bce-active");
    gi.className = "bce-gutter-line";
    if (wasActive) gi.classList.add("bce-active");
    if (!line) return;
    gi.textContent = String(this.options.showRecId ? line.id : idx + 1);
  }

  /**
   * Точечный рендер патча: обновляет DOM только для затронутых строк,
   * вместо пересоздания content.innerHTML (критично для undo/redo на
   * документах в десятки тысяч строк).
   *
   * replace → renderLine(); insert/delete → точечная вставка/удаление
   * DOM-узлов; setLines → полный render().
   *
   * @param {BcePatchOp[]} ops
   * @param {Object}   [opts]
   * @param {boolean}  [opts.domSynced=false] - DOM уже содержит результат
   *   правки (её применил браузер, см. onInput). Структурные операции тогда
   *   НЕ применяются к DOM повторно: индексы патча относятся к модели ДО
   *   правки, а DOM уже соответствует модели ПОСЛЕ неё - повторный
   *   delete/insert удалил бы не те узлы. Строки insert/replace
   *   перерисовываются на месте, гуттер досинхронизируется по количеству.
   * @returns {void}
   * @private
   */
  _renderPatch(ops, { domSynced = false } = {}) {
    // Без DOM (юнит-тесты модели) - рендер пропускается
    if (!this.content || !this.gutter) return;
    // При domSynced число строк DOM могло разойтись с моделью (например,
    // браузер удалил все строки) - точечный рендер невозможен, нужен полный.
    if (domSynced && this.content.children.length !== this.lines.length) {
      this.render();
      return;
    }
    let structuralFrom = -1;

    // Активная строка: запоминаем узлы по ссылке (индексы после
    // insert/delete сместятся) и сбрасываем кэш
    let prevActiveContent = /** @type {Element | null} */ (null);
    let prevActiveGutter = /** @type {Element | null} */ (null);
    if (this._activeLine >= 0) {
      prevActiveContent = this.content.children[this._activeLine] ?? null;
      prevActiveGutter = this.gutter.children[this._activeLine] ?? null;
      this._activeLine = -1;
    }

    for (const op of ops) {
      if (op.type === "replace") {
        const n = Array.isArray(op.lines) ? op.lines.length : 1;
        for (let i = 0; i < n; i++) this.renderLine(op.index + i);
      } else if (op.type === "insert") {
        const lines = Array.isArray(op.lines) ? op.lines : [op.lines];
        if (domSynced) {
          // Узлы уже вставлены браузером - обновляем их на месте
          for (let i = 0; i < lines.length; i++) {
            this.renderLine(op.index + i);
          }
        } else {
          const refLine = /** @type {Element | null} */ (
            this.content.children[op.index] ?? null
          );
          const refGutter = /** @type {Element | null} */ (
            this.gutter.children[op.index] ?? null
          );
          // Батч-вставка: узлы создаются и заполняются ДО вставки в документ
          // (_fillLineNode/_fillGutterNode), затем каждая порция попадает
          // в DOM одним insertBefore через DocumentFragment - один reflow
          // на всю порцию вместо N.
          const contentFrag = document.createDocumentFragment();
          const gutterFrag = document.createDocumentFragment();
          for (let i = 0; i < lines.length; i++) {
            const div = document.createElement("div");
            const gi = document.createElement("div");
            this._fillLineNode(div, op.index + i);
            this._fillGutterNode(gi, op.index + i);
            contentFrag.appendChild(div);
            gutterFrag.appendChild(gi);
          }
          this.content.insertBefore(contentFrag, refLine);
          this.gutter.insertBefore(gutterFrag, refGutter);
        }
        structuralFrom =
          structuralFrom < 0 ? op.index : Math.min(structuralFrom, op.index);
      } else if (op.type === "delete") {
        // При domSynced узлы уже удалены браузером - фиксируем только точку
        // переиндексации
        if (!domSynced) {
          for (let i = 0; i < op.count; i++) {
            this.content.children[op.index]?.remove();
            this.gutter.children[op.index]?.remove();
          }
        }
        structuralFrom =
          structuralFrom < 0 ? op.index : Math.min(structuralFrom, op.index);
      } else {
        this.render();
        return;
      }
    }

    if (structuralFrom >= 0) {
      // _reindexTail сам решает, помечать ли _nodeMap устаревшим
      this._reindexTail(structuralFrom);
    } else if (domSynced) {
      // Только replace: индексы строк не менялись, изменённые строки
      // переиндексированы в renderLine() - кэш узлов актуален
      this._nodeMapDirty = false;
    }
    prevActiveContent?.classList.remove("bce-active");
    prevActiveGutter?.classList.remove("bce-active");
    this.updateActiveLine();
  }

  /**
   * Обновляет номера в гуттере и (для небольшого хвоста) индекс текстовых
   * узлов после структурного изменения (insert/delete строк).
   *
   * Заодно приводит число узлов гуттера к числу строк модели: браузер правит
   * только `content`, поэтому после его структурной правки (onInput) в
   * гуттере остаётся старое количество строк. Лишние узлы удаляются с конца,
   * недостающие добавляются в конец (их номера заполнит цикл ниже).
   *
   * Для большого хвоста переиндексация дорога - помечаем _nodeMap устаревшим:
   * getCursor() пойдёт резервным путём через TreeWalker (корректно, но
   * медленнее) до ближайшего полного render().
   * @param {number} from - индекс первой затронутой строки
   * @returns {void}
   * @private
   */
  _reindexTail(from) {
    const total = this.lines.length;
    this._activeLine = -1;

    // Количество узлов гуттера = количеству строк модели. Их индексы не
    // меньше from (from - индекс операции в СТАРОЙ модели, а старый гуттер
    // не короче старой модели), поэтому добавленные узлы попадут под цикл
    // нумерации ниже.
    const gutter = this.gutter;
    let gc = gutter.children.length;
    while (gc > total) {
      gutter.lastElementChild?.remove();
      gc--;
    }
    while (gc < total) {
      const gi = document.createElement("div");
      gi.className = "bce-gutter-line";
      gutter.appendChild(gi);
      gc++;
    }

    for (let i = from; i < total; i++) {
      const g = /** @type {HTMLElement | undefined} */ (gutter.children[i]);
      if (g && this.lines[i]) {
        g.textContent = String(
          this.options.showRecId ? this.lines[i].id : i + 1,
        );
      }
    }

    if (total - from <= 2000) {
      for (let i = from; i < total; i++) {
        const div = /** @type {HTMLElement | undefined} */ (
          this.content.children[i]
        );
        if (div instanceof HTMLElement) this._indexLineNodes(div, i);
      }
      // Префикс до `from` не менялся, хвост переиндексирован - карта узлов
      // снова полностью актуальна
      this._nodeMapDirty = false;
    } else {
      this._nodeMapDirty = true;
    }
  }

  /**
   * Подсвечивает активную строку (O(1) через кэш _activeLine).
   * @returns {void}
   */
  updateActiveLine() {
    // Без DOM (юнит-тесты модели) - подсветка пропускается
    if (!this.content || !this.gutter) return;
    const cursor = this.getCursor();
    const ln = cursor ? this.getFocus(cursor).ln : -1;
    this._setActiveLine(ln);
  }

  /**
   * Переносит класс `bce-active` на строку `ln` (гуттер + контент).
   * Используется и после пользовательских выделений (getCursor),
   * и после программного setCursor() - подсветка следует за курсором.
   * @param {number} ln - индекс строки; невалидный индекс снимает подсветку
   * @returns {void}
   * @private
   */
  _setActiveLine(ln) {
    if (!this.content || !this.gutter) return;
    if (ln < 0 || ln >= this.lines.length) ln = -1;
    if (ln === this._activeLine) return;

    if (this._activeLine >= 0) {
      this.content.children[this._activeLine]?.classList.remove("bce-active");
      this.gutter.children[this._activeLine]?.classList.remove("bce-active");
    }
    this._activeLine = ln;
    if (ln >= 0) {
      this.content.children[ln]?.classList.add("bce-active");
      this.gutter.children[ln]?.classList.add("bce-active");
    }
  }

  /**
   * Ограничивает смещение допустимыми пределами строки.
   * @param {number} lineIdx - индекс строки
   * @param {number} off     - исходное смещение
   * @returns {number}
   */
  _clampOffset(lineIdx, off) {
    const line = this.lines[lineIdx];
    return line ? Math.max(0, Math.min(off, line.val.length)) : 0;
  }

  /**
   * Колонка первого непробельного символа строки - цель «умного» Home.
   * Для строки из одних пробельных символов возвращает длину строки.
   * @param {number} lineIdx - индекс строки
   * @returns {number}
   * @private
   */
  _firstNonWsCol(lineIdx) {
    const line = this.lines[lineIdx];
    if (!line) return 0;
    const m = /\S/.exec(line.val);
    return m ? m.index : line.val.length;
  }

  /**
   * Возвращает позицию курсора (фокус выделения) - точку, куда «движется» выделение.
   * @param {BceCursor} cursor
   * @returns {{ ln: number, col: number }}
   */
  getFocus(cursor) {
    return cursor.backward
      ? { ln: cursor.begLn, col: cursor.begCol }
      : { ln: cursor.endLn, col: cursor.endCol };
  }

  /**
   * Возвращает якорь выделения - точку, откуда началось выделение.
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
   * @param {string} val - сырой текст строки
   * @returns {string} - HTML-строка
   */
  highlight(val) {
    if (!val) return "";

    // Кэш: большинство строк не меняются при каждом рендере, а регэкспы
    // подсветки - самая дорогая часть render(). Ключ - текст строки.
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
          /** @type {(_: string, an: string, eq: string, av: string) => string} */
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
    if (this._highlightCache.size >= this._highlightCacheMax) {
      const firstKey = this._highlightCache.keys().next().value;
      if (firstKey !== undefined) this._highlightCache.delete(firstKey);
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
    if (!sel || sel.rangeCount === 0) return this.cursor;

    if (
      (sel.anchorNode && !this.content.contains(sel.anchorNode)) ||
      (sel.focusNode && !this.content.contains(sel.focusNode))
    ) {
      return this.cursor;
    }

    const range = sel.getRangeAt(0);

    /**
     * Определяет индекс строки и символьное смещение для узла.
     * @param {Node}   node
     * @param {number} offset
     * @returns {{ lineIndex: number, offset: number }}
     */
    const getNodeInfo = (node, offset) => {
      // Быстрый путь: узел проиндексирован при последнем render() - O(1)
      // вместо TreeWalker по строке на каждый вызов.
      if (node.nodeType === Node.TEXT_NODE && !this._nodeMapDirty) {
        const info = this._nodeMap.get(node);
        if (info) {
          return { lineIndex: info.lineIdx, offset: info.baseOffset + offset };
        }
      }
      // Резервный путь: поднимаемся до .bce-line и считаем TreeWalker'ом.
      // Также сюда попадаем, если _nodeMap устарел (_nodeMapDirty - см. onInput).
      let lineEl = /** @type {any} */ (node);
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
          lineIndex: Array.prototype.indexOf.call(
            this.content.children,
            lineEl,
          ),
          offset: (lineEl.textContent ?? "").length,
        };
      }

      // Индекс строки = позиция .bce-line среди детей content (порядок DOM
      // всегда совпадает с порядком строк модели).
      const lineIndex = Array.prototype.indexOf.call(
        this.content.children,
        lineEl,
      );
      let charOffset = 0;
      const walker = document.createTreeWalker(
        lineEl,
        NodeFilter.SHOW_TEXT,
        null,
      );
      let currentNode = walker.nextNode();

      while (currentNode) {
        if (currentNode === node) {
          charOffset += offset;
          return { lineIndex, offset: charOffset };
        }
        charOffset += (currentNode.textContent || "").length;
        currentNode = walker.nextNode();
      }
      return { lineIndex, offset: (lineEl.textContent || "").length };
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
    this.cursor = {
      begLn: beg.lineIndex,
      begCol: beg.offset,
      endLn: end.lineIndex,
      endCol: end.offset,
      backward: !anchorFirst,
    };
    return this.cursor;
  }

  /**
   * Запоминает текущее выделение как состояние «до правки».
   *
   * Вызывается из событий, которые предшествуют изменению DOM
   * (`keydown`, `beforeinput`, `paste`/`cut`/`drop`, `keyup`/`mouseup`/`click`),
   * и из `setCursor()`. `onInput` видит DOM уже изменённым, поэтому снимок
   * «до» - единственный способ узнать, что было выделено: иначе undo
   * возвращал каретку в конец предыдущей правки или в начало документа
   * вместо начала заменённого выделения.
   *
   * Без DOM (юнит-тесты модели) - no-op.
   * @returns {void}
   * @private
   */
  _captureSelection() {
    if (!this.content || typeof window === "undefined") return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    if (!sel.anchorNode || !this.content.contains(sel.anchorNode)) return;
    const c = this.getCursor();
    if (!c) return;
    this._selectionBefore = {
      begLn: c.begLn,
      begCol: c.begCol,
      endLn: c.endLn,
      endCol: c.endCol,
      backward: !!c.backward,
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
      let last = /** @type {any} */ (lineEl);
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

      let remaining = offset;
      /**
       * @param {any} n
       * @returns {any}
       */
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
    if (begLn > endLn || (begLn === endLn && begCol > endCol)) {
      [begLn, endLn] = [endLn, begLn];
      [begCol, endCol] = [endCol, begCol];
    }

    // Клампинг: невалидные индексы (например, begLn=999 после удаления строк)
    // иначе приводят к {node: content, offset: 0} - курсор прыгает в начало.
    /**
     * @param {number} ln
     * @returns {number}
     */
    const clampLn = (ln) => Math.max(0, Math.min(ln, this.lines.length - 1));
    begLn = clampLn(begLn);
    endLn = clampLn(endLn);
    begCol = this._clampOffset(begLn, begCol);
    endCol = this._clampOffset(endLn, endCol);

    this.cursor = { begLn, begCol, endLn, endCol, backward: !!cursor.backward };

    const beg = setPoint(begLn, begCol);
    const end =
      begLn === endLn && begCol === endCol ? beg : setPoint(endLn, endCol);

    try {
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        // setBaseAndExtent сохраняет направление выделения:
        // base - точка старта (якорь), extent - точка курсора (фокус).
        const base = cursor.backward ? end : beg;
        const extent = cursor.backward ? beg : end;
        sel.setBaseAndExtent(
          base.node,
          base.offset,
          extent.node,
          extent.offset,
        );
      }
    } catch (_e) {
      /* ignore */
    }

    // Подсветка активной строки должна следовать и за программно
    // установленным курсором, а не только за выделением через мышь/клавиши.
    // Считаем позицию из модели (this.cursor), а не из DOM: если DOM-выделение
    // не применилось (редактор вне фокуса/скрыт), getCursor() вернул бы
    // устаревшую позицию.
    this._setActiveLine(this.getFocus(this.cursor).ln);

    // Программно установленный курсор - это и есть выделение «до» следующей
    // правки. Перезапись безопасна: onInput/commitChange передают снимок «до»
    // в _pushEntry явно, ДО вызова setCursor().
    this._selectionBefore = {
      begLn,
      begCol,
      endLn,
      endCol,
      backward: !!cursor.backward,
    };
  }

  /**
   * Схлопывает выделение в его якорь - точку, из которой выделение началось
   * (при выделении «снизу вверх» это конец диапазона).
   *
   * Используется undo: после отката замены выделения каретка должна встать
   * в начало выделения, а не остаться в начале документа.
   * @param {BceCursor} cursor
   * @returns {BceCursor}
   * @private
   */
  _collapseToAnchor(cursor) {
    const anchor = this.getAnchor(cursor);
    return {
      begLn: anchor.ln,
      begCol: anchor.col,
      endLn: anchor.ln,
      endCol: anchor.col,
    };
  }

  /* ================================================================
  История изменений (undo / redo) - патчи вместо полных снимков
  ================================================================= */

  /**
   * Сбрасывает историю и фиксирует текущее состояние модели как базовый
   * снимок («якорь»). Стек патчей поверх базы становится пустым.
   * @returns {void}
   * @private
   */
  _resetHistoryBase() {
    this._baseSnapshot = {
      lines: this.lines.map((l) => ({ id: l.id, val: l.val })),
      // Курсор базы: если он ещё не известен (инициализация) - начало
      // документа, иначе undo первого действия оставил бы каретку где попало.
      cursor: this.cursor
        ? { ...this.cursor }
        : { begLn: 0, begCol: 0, endLn: 0, endCol: 0 },
    };
    this.history = [];
    this.historyIndex = -1;
  }

  /**
   * Строит обратные операции для набора forward-операций.
   *
   * Вызывается ДО применения forward: удаляемые/заменяемые строки копируются
   * в inverse (delete сам по себе необратим). Инверсии возвращаются в
   * порядке, обратном forward, и применяются как обычный список операций.
   *
   * @param {BcePatchOp[]} ops - forward-операции (ещё не применённые)
   * @returns {BcePatchOp[]} - обратные операции
   * @private
   */
  _invertOps(ops) {
    /** @type {BcePatchOp[]} */
    const inv = [];
    for (const op of ops) {
      switch (op.type) {
        case "insert": {
          const n = Array.isArray(op.lines) ? op.lines.length : 1;
          inv.push({ type: "delete", index: op.index, count: n });
          break;
        }
        case "delete": {
          const removed = this.lines
            .slice(op.index, op.index + op.count)
            .map((l) => ({ id: l.id, val: l.val }));
          inv.push({ type: "insert", index: op.index, lines: removed });
          break;
        }
        case "replace": {
          const n = Array.isArray(op.lines) ? op.lines.length : 1;
          inv.push({
            type: "replace",
            index: op.index,
            lines: this.lines
              .slice(op.index, op.index + n)
              .map((l) => ({ id: l.id, val: l.val })),
          });
          break;
        }
        default: {
          inv.push({
            type: "setLines",
            lines: this.lines.map((l) => ({ id: l.id, val: l.val })),
          });
          break;
        }
      }
    }
    // Инверсия последней операции применяется первой
    return inv.reverse();
  }

  /**
   * Применяет операции к переданному массиву строк (мутирует его).
   * Строки из операций клонируются: модель никогда не делит объекты Rec
   * с патчами - иначе поздние правки испортили бы сохранённые операции.
   * @param {Rec[]} lines
   * @param {BcePatchOp[]} ops
   * @returns {Rec[]} - тот же массив (для записи `this.lines = ...`)
   * @private
   */
  _applyOpsTo(lines, ops) {
    // Индексы клампятся: патч, не совпавший с моделью (например, история
    // рассинхронизировалась), не должен оставлять «дыры» в массиве строк -
    // undefined-строка ломает getText(), рендер и последующие патчи.
    /**
     * @param {number} index
     * @returns {number}
     */
    const at = (index) => Math.max(0, Math.min(index, lines.length));
    for (const op of ops) {
      switch (op.type) {
        case "insert": {
          const arr = (Array.isArray(op.lines) ? op.lines : [op.lines])
            .filter((l) => !!l)
            .map((l) => ({ id: l.id, val: l.val }));
          lines.splice(at(op.index), 0, ...arr);
          break;
        }
        case "delete": {
          lines.splice(at(op.index), Math.max(0, op.count));
          break;
        }
        case "replace": {
          const arr = Array.isArray(op.lines) ? op.lines : [op.lines];
          arr.forEach((l, i) => {
            const idx = op.index + i;
            if (!l || idx < 0 || idx >= lines.length) return;
            lines[idx] = { id: l.id, val: l.val };
          });
          break;
        }
        default: {
          lines.length = 0;
          for (const l of op.lines ?? []) {
            lines.push({ id: l.id, val: l.val });
          }
          break;
        }
      }
    }
    return lines;
  }

  /**
   * Сравнивает два массива строк и возвращает операции, переводящие
   * oldLines в newLines. Используется в onInput, где DOM уже изменён
   * браузером и модель нужно синхронизировать через патч.
   * @param {Rec[]} oldLines
   * @param {Rec[]} newLines
   * @returns {BcePatchOp[]}
   */
  diffLines(oldLines, newLines) {
    /** @type {BcePatchOp[]} */
    const ops = [];
    const n = oldLines.length;
    const m = newLines.length;

    // Общий префикс и суффикс (по id и тексту) не участвуют в диффе
    let pre = 0;
    while (
      pre < n &&
      pre < m &&
      oldLines[pre].id === newLines[pre].id &&
      oldLines[pre].val === newLines[pre].val
    ) {
      pre++;
    }
    let suf = 0;
    while (
      suf < n - pre &&
      suf < m - pre &&
      oldLines[n - 1 - suf].id === newLines[m - 1 - suf].id &&
      oldLines[n - 1 - suf].val === newLines[m - 1 - suf].val
    ) {
      suf++;
    }

    const oldMid = n - pre - suf;
    const newMid = m - pre - suf;
    const overlap = Math.min(oldMid, newMid);

    if (overlap > 0) {
      /** @type {Rec[]} */
      const repl = [];
      let changed = false;
      for (let i = 0; i < overlap; i++) {
        const o = oldLines[pre + i];
        const w = newLines[pre + i];
        if (o.id !== w.id || o.val !== w.val) changed = true;
        repl.push({ id: w.id, val: w.val });
      }
      if (changed) {
        ops.push({ type: "replace", index: pre, lines: repl });
      }
    }

    if (newMid > oldMid) {
      ops.push({
        type: "insert",
        index: pre + oldMid,
        lines: newLines
          .slice(pre + oldMid, pre + newMid)
          .map((l) => ({ id: l.id, val: l.val })),
      });
    } else if (oldMid > newMid) {
      ops.push({
        type: "delete",
        index: pre + newMid,
        count: oldMid - newMid,
      });
    }

    return ops;
  }

  /**
   * Добавляет патч в историю: обрезает «хвост redo» (новые изменения его
   * отменяют), пишет пару forward/inverse с курсорами «до/после» и при
   * необходимости уплотняет базу (компакция).
   *
   * Курсор «до» берётся из снимка выделения, снятого ДО правки
   * (_selectionBefore), - только он знает про выделение, которое правка
   * заменила. Фолбэки: явно переданный cursorBefore → предыдущая запись
   * стека → курсор базы.
   *
   * @param {BcePatchOp[]} forwardOps
   * @param {BceCursor | null} cursorAfter - курсор после применения forward
   * @param {BcePatchOp[]} [inverse] - заранее построенный inverse
   *                                   (по умолчанию строится автоматически)
   * @param {BceCursor | null} [cursorBefore] - курсор/выделение до правки
   * @returns {void}
   * @private
   */
  _pushEntry(forwardOps, cursorAfter, inverse, cursorBefore) {
    inverse ??= this._invertOps(forwardOps);
    if (!cursorBefore) {
      cursorBefore = this._selectionBefore
        ? { ...this._selectionBefore }
        : this.historyIndex >= 0
          ? this.history[this.historyIndex].cursorAfter
          : this._baseSnapshot
            ? this._baseSnapshot.cursor
            : null;
    }

    if (this.historyIndex < this.history.length - 1) {
      this.history = this.history.slice(0, this.historyIndex + 1);
    }
    this.history.push({
      forward: forwardOps,
      inverse,
      cursorBefore,
      cursorAfter: cursorAfter ?? null,
    });
    this.historyIndex = this.history.length - 1;

    // После правки актуальное выделение - cursorAfter: оно станет
    // «состоянием до» для следующей записи, если пользователь не сдвинет
    // каретку (тогда снимок обновят события мыши/клавиатуры).
    if (cursorAfter) this._selectionBefore = { ...cursorAfter };

    if (this.historyIndex >= this.maxHistory) this._compactHistory();
  }

  /**
   * Компакция: применяет все патчи «прошлого» к базовому снимку и делает
   * результат новой базой. «Хвост redo» сохраняется - его патчи остаются
   * валидны поверх новой базы. Держит глубину прошлого в пределах maxHistory,
   * чтобы память не росла линейно (25 000 строк × 200 патчей).
   * @returns {void}
   * @private
   */
  _compactHistory() {
    if (!this._baseSnapshot || this.historyIndex < 0) return;
    const lines = this._baseSnapshot.lines.slice();
    let cursor = this._baseSnapshot.cursor;
    for (let i = 0; i <= this.historyIndex; i++) {
      this._applyOpsTo(lines, this.history[i].forward);
      cursor = this.history[i].cursorAfter ?? cursor;
    }
    this._baseSnapshot = { lines, cursor };
    this.history = this.history.slice(this.historyIndex + 1);
    this.historyIndex = -1;
  }

  /**
   * Применяет набор forward-операций: строит inverse-патч, применяет
   * операции к модели, точечно рендерит изменения, пишет патч в историю.
   *
   * Все мутации модели должны идти через этот метод (вместо прямой правки
   * `this.lines[i].val = ...`) - иначе undo/redo не смогут восстановить
   * состояние (в т.ч. id строк, критичные для `dataset.lineId` в `onInput`).
   *
   * @param {BcePatchOp[]} forwardOps - операции «вперёд»
   * @param {BceCursor | null} [cursor] - курсор после изменения (null - не трогать)
   * @returns {void}
   */
  commitChange(forwardOps, cursor = null) {
    if (!forwardOps.length) return;
    // Выделение «до»: DOM ещё не тронут, getCursor() вернёт актуальную
    // позицию (в т.ч. выделение, которое сейчас будет заменено)
    this._captureSelection();
    const cursorBefore = this._selectionBefore
      ? { ...this._selectionBefore }
      : null;
    const inverse = this._invertOps(forwardOps);
    this.lines = this._applyOpsTo(this.lines, forwardOps);
    this._renderPatch(forwardOps);
    if (cursor) this.setCursor(cursor);
    this.updateActiveLine();
    this._pushEntry(forwardOps, cursor, inverse, cursorBefore);
    this._fireOnChange();
  }

  /**
   * Откат на один шаг: применение inverse-патча (курсор - cursorBefore).
   *
   * Если правка заменила выделение, cursorBefore - это само выделение;
   * каретка встаёт в его начало (якорь), а выделение сбрасывается.
   * @returns {void}
   */
  undo() {
    if (this.historyIndex < 0) return;
    const entry = this.history[this.historyIndex];
    this.historyIndex--;
    this.lines = this._applyOpsTo(this.lines, entry.inverse);
    this._renderPatch(entry.inverse);
    const cursor = entry.cursorBefore;
    if (cursor) this.setCursor(this._collapseToAnchor(cursor));
    this.updateActiveLine();
    this._fireOnChange();
  }

  /**
   * Повтор на один шаг: повторное применение forward-патча (курсор - cursorAfter).
   * @returns {void}
   */
  redo() {
    if (this.historyIndex >= this.history.length - 1) return;
    this.historyIndex++;
    const entry = this.history[this.historyIndex];
    this.lines = this._applyOpsTo(this.lines, entry.forward);
    this._renderPatch(entry.forward);
    const cursor = entry.cursorAfter;
    if (cursor) this.setCursor(cursor);
    this.updateActiveLine();
    this._fireOnChange();
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
   * @param {boolean}  [opts.immediate=false] - вызвать `fn(this)` сразу при подписке
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
    if (cursor.begLn === cursor.endLn && cursor.begCol === cursor.endCol)
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
    // Выделение до НАЧАЛА конечной строки (endCol === 0) - хвостовой \n
    // и пустой хвост не нужны (иначе "line1\nline2\n" вместо "line1\nline2").
    const tail = this.lines[cursor.endLn].val.substring(0, cursor.endCol);
    return cursor.endCol === 0 ? result : result + "\n" + tail;
  }

  /**
   * Удаляет выделенный текст из модели.
   * @param {BceCursor} cursor
   * @returns {void}
   */
  deleteSelection(cursor) {
    if (
      !cursor ||
      (cursor.begLn === cursor.endLn && cursor.begCol === cursor.endCol)
    )
      return;

    /** @type {BcePatchOp[]} */
    const ops = [];
    /** @type {string} */
    let newVal;

    if (cursor.begLn === cursor.endLn) {
      const line = this.lines[cursor.begLn];
      newVal =
        line.val.substring(0, cursor.begCol) +
        line.val.substring(cursor.endCol);
      ops.push({
        type: "replace",
        index: cursor.begLn,
        lines: [{ id: line.id, val: newVal }],
      });
    } else {
      const first = this.lines[cursor.begLn];
      const last = this.lines[cursor.endLn];
      newVal =
        first.val.substring(0, cursor.begCol) +
        last.val.substring(cursor.endCol);
      ops.push({
        type: "replace",
        index: cursor.begLn,
        lines: [{ id: first.id, val: newVal }],
      });
      ops.push({
        type: "delete",
        index: cursor.begLn + 1,
        count: cursor.endLn - cursor.begLn,
      });
    }

    // Каноническая форма пустого документа: единственная пустая строка
    // получает новый id
    const deletedCount =
      cursor.begLn === cursor.endLn ? 0 : cursor.endLn - cursor.begLn;
    if (
      this.lines.length - deletedCount === 1 &&
      cursor.begLn === 0 &&
      newVal === ""
    ) {
      ops.push({
        type: "replace",
        index: 0,
        lines: [{ id: this.newId(), val: "" }],
      });
    }

    this.commitChange(ops, {
      begLn: cursor.begLn,
      begCol: cursor.begCol,
      endLn: cursor.begLn,
      endCol: cursor.begCol,
    });
  }

  /**
   * Вставляет текст в текущую позицию курсора (с поддержкой многострочности).
   *
   * При активном выделении выделенный текст УДАЛЯЕТСЯ перед вставкой
   * (замена выделения): вставка выполняется в начало выделения, всё
   * выделенное уходит. Удаление и вставка попадают в историю ОДНОЙ
   * записью - один Ctrl+Z отменяет их целиком.
   * Курсор устанавливается в конец вставленного текста.
   * @param {string} text
   * @returns {void}
   */
  insertText(text) {
    const cursor = this.getCursor();
    if (!cursor) return;
    const hasSel =
      cursor.begLn !== cursor.endLn || cursor.begCol !== cursor.endCol;
    const parts = text.split("\n");
    // Вставка в НАЧАЛО выделения (cursor.beg нормализован - это начало
    // диапазона независимо от направления выделения)
    const ln = Math.max(0, Math.min(cursor.begLn, this.lines.length - 1));
    const col = this._clampOffset(ln, cursor.begCol);
    const currentLine = this.lines[ln];
    const before = currentLine.val.substring(0, col);
    // Хвост после вставки: при выделении - остаток последней выделенной строки
    const endCol = hasSel ? cursor.endCol : col;
    const after =
      cursor.endLn === ln
        ? currentLine.val.substring(endCol)
        : this.lines[cursor.endLn].val.substring(endCol);

    /** @type {BcePatchOp[]} */
    const ops = [];

    // Удаление выделения: промежуточные строки (хвост последней строки
    // уже учтён в `after`, первая строка будет заменена ниже)
    if (hasSel && cursor.endLn !== ln) {
      ops.push({
        type: "delete",
        index: ln + 1,
        count: cursor.endLn - ln,
      });
    }

    if (parts.length === 1) {
      ops.push({
        type: "replace",
        index: ln,
        lines: [{ id: currentLine.id, val: before + parts[0] + after }],
      });
      const ncol = before.length + parts[0].length;
      this.commitChange(ops, {
        begLn: ln,
        begCol: ncol,
        endLn: ln,
        endCol: ncol,
      });
    } else {
      ops.push({
        type: "replace",
        index: ln,
        lines: [{ id: currentLine.id, val: before + parts[0] }],
      });
      /** @type {Rec[]} */
      const inserted = [];
      for (let i = 1; i < parts.length - 1; i++) {
        inserted.push({ id: this.newId(), val: parts[i] });
      }
      inserted.push({
        id: this.newId(),
        val: parts[parts.length - 1] + after,
      });
      ops.push({ type: "insert", index: ln + 1, lines: inserted });
      const finalLine = ln + parts.length - 1;
      const finalOffset = parts[parts.length - 1].length;
      this.commitChange(ops, {
        begLn: finalLine,
        begCol: finalOffset,
        endLn: finalLine,
        endCol: finalOffset,
      });
    }
  }

  /**
   * Порционная вставка больших текстов: разбивает на куски по chunkSize
   * строк и вставляет их по кадрам (requestAnimationFrame), не блокируя UI.
   *
   * Отличия от insertText():
   * - вся вставка попадает в историю ОДНОЙ записью (один Ctrl+Z отменяет всё);
   * - onChange вызывается один раз в конце;
   * - каждая порция рендерится через _renderPatch() (батч-вставка фрагментом).
   *
   * Семантика выделения единая с insertText(): при активном выделении
   * выделенный текст УДАЛЯЕТСЯ перед вставкой (замена выделения) -
   * в той же записи истории.
   *
   * Во время вставки установлен флаг `_inserting`: onKeyDown/onInput
   * игнорируются, чтобы правки пользователя не попали в недоконченный документ.
   *
   * @param {string} text
   * @param {Object}   [opts]
   * @param {number}   [opts.chunkSize=5000] - строк на порцию
   * @returns {void}
   */
  insertTextChunked(text, { chunkSize = 5000 } = {}) {
    const cursor = this.getCursor();
    if (!cursor) return;
    // Снимок выделения «до»: вставка идёт по кадрам, и к моменту finalize()
    // setCursor() уже перезапишет _selectionBefore - история запомнила бы
    // неверную позицию «до» (undo вернул бы каретку не туда).
    const cursorBefore = {
      begLn: cursor.begLn,
      begCol: cursor.begCol,
      endLn: cursor.endLn,
      endCol: cursor.endCol,
      backward: !!cursor.backward,
    };
    const hasSel =
      cursor.begLn !== cursor.endLn || cursor.begCol !== cursor.endCol;
    // Вставка в НАЧАЛО выделения (cursor.beg нормализован) - семантика
    // единая с insertText(): выделение удаляется перед вставкой
    const ln = Math.max(0, Math.min(cursor.begLn, this.lines.length - 1));
    const col = this._clampOffset(ln, cursor.begCol);
    const c = { begLn: ln, begCol: col, endLn: ln, endCol: col };
    const parts = text.split("\n");

    if (parts.length <= chunkSize) {
      this.insertText(text);
      return;
    }

    const currentLine = this.lines[c.begLn];
    const before = currentLine.val.substring(0, c.begCol);
    // Хвост после вставки: при выделении - остаток последней выделенной строки
    const endCol = hasSel ? cursor.endCol : c.begCol;
    const after =
      cursor.endLn === c.begLn
        ? currentLine.val.substring(endCol)
        : this.lines[cursor.endLn].val.substring(endCol);

    this._inserting = true;

    /** @type {BcePatchOp[]} */
    const allForward = [];
    /** @type {BcePatchOp[]} */
    const allInverse = [];
    // Позиция вставки следующей порции: сразу за последней вставленной
    // строкой (перед «хвостом» документа, если курсор был не в конце).
    // this.lines.length здесь не подходит: он корректен только для вставки
    // в конец документа.
    let insertPos = c.begLn + 1;
    let pos = 0;
    let chunk = 0;
    const totalChunks = Math.ceil(parts.length / chunkSize);

    /**
     * Финализация: курсор в конец вставленного, одна запись истории,
     * один onChange.
     * @returns {void}
     */
    const finalize = () => {
      // Курсор в конец вставленного текста (последняя вставленная строка),
      // а не в конец документа: при вставке в середине ниже остаются
      // нетронутые строки
      const finalLn = Math.max(
        0,
        Math.min(insertPos - 1, this.lines.length - 1),
      );
      const finalCol = this.lines[finalLn].val.length;
      const finalCursor = {
        begLn: finalLn,
        begCol: finalCol,
        endLn: finalLn,
        endCol: finalCol,
      };
      this.setCursor(finalCursor);
      this.updateActiveLine();
      this._pushEntry(allForward, finalCursor, allInverse, cursorBefore);
      this._inserting = false;
      this._fireOnChange();
    };

    /**
     * Вставляет одну порцию строк и планирует следующий кадр.
     * @returns {void}
     */
    const step = () => {
      const count = Math.min(chunkSize, parts.length - pos);
      const slice = parts.slice(pos, pos + count);
      const isFirst = chunk === 0;
      const isLast = chunk === totalChunks - 1;

      /** @type {BcePatchOp[]} */
      const ops = [];
      if (isFirst) {
        // Замена выделения: промежуточные строки удаляются первой же порцией
        // (хвост последней строки уже учтён в `after`, первая строка будет
        // заменена ниже). Вся операция - одна запись истории.
        if (hasSel && cursor.endLn !== c.begLn) {
          ops.push({
            type: "delete",
            index: c.begLn + 1,
            count: cursor.endLn - c.begLn,
          });
        }
        // Первая строка порции приклеивается к строке курсора (id сохраняется
        // - критично для матчинга dataset.lineId в onInput)
        ops.push({
          type: "replace",
          index: c.begLn,
          lines: [{ id: currentLine.id, val: before + slice[0] }],
        });
        if (slice.length > 1) {
          /** @type {Rec[]} */
          const inserted = [];
          for (let i = 1; i < slice.length; i++) {
            inserted.push({ id: this.newId(), val: slice[i] });
          }
          if (isLast) inserted[inserted.length - 1].val += after;
          ops.push({ type: "insert", index: c.begLn + 1, lines: inserted });
        } else if (isLast) {
          // Единственная строка в единственной порции: хвост в ту же строку
          /** @type {Rec} */ (/** @type {BceReplaceOp} */ (ops[0]).lines).val +=
            after;
        }
      } else {
        /** @type {Rec[]} */
        const inserted = slice.map((v) => ({ id: this.newId(), val: v }));
        if (isLast) inserted[inserted.length - 1].val += after;
        ops.push({ type: "insert", index: insertPos, lines: inserted });
      }

      // _invertOps для insert не читает this.lines, для replace читает -
      // вызов ДО _applyOpsTo корректен
      const inverse = this._invertOps(ops);
      this.lines = this._applyOpsTo(this.lines, ops);
      this._renderPatch(ops);

      allForward.push(...ops);
      // Инверсии последующих порций должны применяться ПЕРЕД инверсиями
      // предыдущих (F1,F2 -> I2,I1), поэтому unshift, а не push
      allInverse.unshift(...inverse);

      const lastOp = ops[ops.length - 1];
      if (lastOp.type === "insert") {
        insertPos =
          lastOp.index +
          (Array.isArray(lastOp.lines) ? lastOp.lines.length : 1);
      }

      if (this.onProgress)
        this.onProgress({ inserted: pos + count, total: parts.length });

      pos += count;
      chunk++;
      if (chunk < totalChunks) {
        requestAnimationFrame(step);
      } else {
        finalize();
      }
    };

    requestAnimationFrame(step);
  }

  /* ================================================================
  Действия по горячим клавишам
  ================================================================= */

  /**
   * Диспетчер действий по имени.
   * @param {string} action - имя действия из `keyBindings`
   * @returns {void}
   */
  doAction(action) {
    /** @type {Record<string, () => void>} */
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
   * Возвращает текст выделения в «нативном» виде: если выделение
   * заканчивается в НАЧАЛЕ следующей строки (endCol === 0), к тексту
   * добавляется хвостовой перевод строки - как при нативном копировании
   * браузера. Благодаря `\n` вставка после копирования целых строк
   * воспроизводит их построчную структуру.
   * @param {BceCursor} cursor
   * @returns {string}
   * @private
   */
  _nativeSelectionText(cursor) {
    let text = this.getSelectedText(cursor);
    if (cursor.endLn > cursor.begLn && cursor.endCol === 0) text += "\n";
    return text;
  }

  /**
   * Копирует выделенный текст в буфер обмена.
   *
   * Выделение НЕ сбрасывается: курсор остаётся там, где остановился,
   * а само выделение сбросит последующая вставка - она заменяет
   * выделение (см. insertText()).
   * @returns {void}
   */
  actionCopy() {
    const cursor = this.getCursor();
    if (!cursor) return;
    const text = this._nativeSelectionText(cursor);
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
   * @param {number} dir - `1` (вниз) или `-1` (вверх)
   * @returns {void}
   */
  actionDuplicate(dir) {
    const cursor = this.getCursor();
    if (!cursor) return;
    const idx = cursor.begLn;
    const newIdx = dir > 0 ? idx + 1 : idx;
    const copy = { id: this.newId(), val: this.lines[idx].val };
    this.commitChange([{ type: "insert", index: newIdx, lines: [copy] }], {
      begLn: newIdx,
      begCol: cursor.begCol,
      endLn: newIdx,
      endCol: cursor.endCol,
    });
  }

  /**
   * Перемещает строки вверх или вниз.
   * При многострочном выделении перемещается весь выделенный блок
   * как единое целое (обмен с соседней строкой), выделение сохраняется.
   * Перестановка выражается одним replace - унифицировано с патч-моделью.
   * @param {number} dir - `1` (вниз) или `-1` (вверх)
   * @returns {void}
   */
  actionMove(dir) {
    const cursor = this.getCursor();
    if (!cursor) return;
    const first = Math.min(cursor.begLn, cursor.endLn);
    const last = Math.max(cursor.begLn, cursor.endLn);
    const neighbor = dir > 0 ? last + 1 : first - 1;
    if (neighbor < 0 || neighbor >= this.lines.length) return;
    const from = Math.min(first, neighbor);
    const to = Math.max(last, neighbor);
    // Соседняя строка перемещается на противоположный край блока
    const reordered =
      dir > 0
        ? [this.lines[to], ...this.lines.slice(from, to)]
        : [...this.lines.slice(from + 1, to + 1), this.lines[from]];
    this.commitChange(
      [
        {
          type: "replace",
          index: from,
          lines: reordered.map((l) => ({ id: l.id, val: l.val })),
        },
      ],
      {
        begLn: cursor.begLn + dir,
        begCol: cursor.begCol,
        endLn: cursor.endLn + dir,
        endCol: cursor.endCol,
      },
    );
  }

  /* ================================================================
  Emmet
  ================================================================= */

  /**
   * Пытается развернуть Emmet-сокращение перед курсором.
   * @returns {boolean} - `true`, если сокращение было раскрыто
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
    // Кэш ключей: пересоздаётся только после addEmmet / removeEmmet
    if (!this._emmetKeys) this._emmetKeys = Object.keys(this.emmet);
    const abbr = this._emmetKeys.find((k) => before.endsWith(k));
    if (!abbr) return false;

    const expansion = this.emmet[abbr];
    const cursorPos = expansion.indexOf("|");
    const clean = expansion.replace("|", "");
    const startReplace = cursor.begCol - abbr.length;
    const newVal =
      line.val.substring(0, startReplace) +
      clean +
      line.val.substring(cursor.begCol);
    const newOffset =
      startReplace + (cursorPos >= 0 ? cursorPos : clean.length);

    this.commitChange(
      [
        {
          type: "replace",
          index: cursor.begLn,
          lines: [{ id: line.id, val: newVal }],
        },
      ],
      {
        begLn: cursor.begLn,
        begCol: newOffset,
        endLn: cursor.begLn,
        endCol: newOffset,
      },
    );
    return true;
  }

  /* ================================================================
  Обработка клавиатуры
  ================================================================= */

  /**
   * Проверяет событие клавиатуры на соответствие привязкам.
   * @param {KeyboardEvent} e
   * @returns {string | null} - имя действия или `null`
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
   * Главный обработчик `keydown` - оркестратор.
   * Логика разбита на подметоды, каждый возвращает `true`, если событие
   * обработано: `_handleActionKeys` → `_handleSpecialKeys` → `_handleNavigation`.
   * @param {KeyboardEvent} e
   * @returns {void}
   */
  onKeyDown(e) {
    if (this._inserting) {
      e.preventDefault();
      return;
    }
    // Снимок выделения «до» правки: keydown приходит раньше input, когда
    // DOM ещё не изменён (в т.ч. для замены выделения символом)
    this._captureSelection();
    if (!e.shiftKey) this.resetSelectionAnchor();

    if (this._handleActionKeys(e)) return;
    if (this._handleSpecialKeys(e)) return;
    this._handleNavigation(e);
  }

  /**
   * Действия по привязкам (`keyBindings`), сочетания `,>` / `,<` и Emmet.
   * @param {KeyboardEvent} e
   * @returns {boolean} - `true`, если событие обработано
   * @private
   */
  _handleActionKeys(e) {
    const action = this.matchBinding(e);
    if (action) {
      e.preventDefault();
      this.doAction(action);
      return true;
    }

    if (e.key === ">" || e.key === "<") {
      if (this._tryMoveShortcut(e.key)) {
        e.preventDefault();
        return true;
      }
    }

    if (
      this.options.enableEmmet &&
      this.emmetTriggers.includes(e.key) &&
      this.tryEmmet()
    ) {
      e.preventDefault();
      return true;
    }

    return false;
  }

  /**
   * Tab / Backspace / Delete / Enter.
   * @param {KeyboardEvent} e
   * @returns {boolean} - `true`, если событие обработано
   * @private
   */
  _handleSpecialKeys(e) {
    if (e.key === "Tab" || e.key === "tab") {
      e.preventDefault();
      this._ignoreNextInputOnce();
      this.handleTab(e.shiftKey);
      return true;
    }

    if (e.key === "Backspace" || e.key === "Delete") {
      this._handleBackspaceDelete(e);
      return true;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      this._ignoreNextInputOnce();
      this.handleEnter();
      return true;
    }

    return false;
  }

  /**
   * Навигация стрелками: схлопывание выделения, Shift+Arrows/Home/End,
   * Shift+Ctrl+Arrows (выделение по словам).
   * @param {KeyboardEvent} e
   * @returns {boolean} - `true`, если событие обработано
   * @private
   */
  _handleNavigation(e) {
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
      return true;
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
      return true;
    }

    if (
      e.shiftKey &&
      (e.ctrlKey || e.metaKey) &&
      !e.altKey &&
      ["ArrowLeft", "ArrowRight"].includes(e.key)
    ) {
      this._handleShiftCtrlArrows(e);
      return true;
    }

    if (
      !e.shiftKey &&
      !e.altKey &&
      !(e.ctrlKey || e.metaKey) &&
      e.key === "Home"
    ) {
      this._handleHome(e);
      return true;
    }

    return false;
  }

  /**
   * «Умный» Home: первое нажатие ставит курсор на первый непробельный
   * символ строки, второе - в колонку 0 (поведение VS Code).
   * При активном выделении выделение схлопывается в точке фокуса.
   * @param {KeyboardEvent} e
   * @returns {void}
   * @private
   */
  _handleHome(e) {
    const cursor = this.getCursor();
    if (!cursor) return;
    const focus = this.getFocus(cursor);
    const smartCol = this._firstNonWsCol(focus.ln);
    const targetCol = focus.col === smartCol && focus.col !== 0 ? 0 : smartCol;
    e.preventDefault();
    this.setCursor({
      begLn: focus.ln,
      begCol: targetCol,
      endLn: focus.ln,
      endCol: targetCol,
      backward: false,
    });
    this.updateActiveLine();
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
   * @param {string} key - нажатый символ: `">"` или `"<"`
   * @returns {boolean} - `true`, если сочетание обработано
   * @private
   */
  _tryMoveShortcut(key) {
    const dir = key === ">" ? 1 : -1;
    const cursor = this.getCursor();
    if (!cursor) return false;
    if (cursor.begLn !== cursor.endLn || cursor.begCol !== cursor.endCol) {
      return false;
    }
    if (cursor.begCol === 0) return false;

    const line = this.lines[cursor.begLn];
    if (line.val[cursor.begCol - 1] !== ",") return false;

    const idx = cursor.begLn;
    const target = idx + dir;
    if (target < 0 || target >= this.lines.length) return true;

    this.commitChange(
      [
        {
          type: "replace",
          index: idx,
          lines: [{ id: this.lines[target].id, val: this.lines[target].val }],
        },
        {
          type: "replace",
          index: target,
          lines: [{ id: this.lines[idx].id, val: this.lines[idx].val }],
        },
      ],
      {
        begLn: target,
        begCol: cursor.begCol,
        endLn: target,
        endCol: cursor.endCol,
      },
    );
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
      cursor.begLn !== cursor.endLn || cursor.begCol !== cursor.endCol;

    // Ветка 1: выделение начинается с колонки 0.
    // 1а - выделена вся строка целиком (begCol=0, endCol=len, одна строка):
    //      очищаем строку, курсор остаётся в {begLn, 0}.
    // 1б - endCol=0 и endLn>begLn: выделены целые строки begLn..endLn-1
    //      (например, пустые строки 2–3): удаляем их, курсор в (begLn, 0);
    //      если удалены все строки - оставляем одну пустую.
    //      Частичное выделение последней строки сюда не попадает - см. ветку 2.
    if (isSelection && cursor.begCol === 0) {
      if (
        cursor.begLn === cursor.endLn &&
        cursor.endCol === this.lines[cursor.begLn].val.length
      ) {
        e.preventDefault();
        this._ignoreNextInputOnce();
        const line = this.lines[cursor.begLn];
        // Каноническая форма пустого документа: новый id единственной строки
        const id = this.lines.length === 1 ? this.newId() : line.id;
        this.commitChange(
          [
            {
              type: "replace",
              index: cursor.begLn,
              lines: [{ id, val: "" }],
            },
          ],
          {
            begLn: cursor.begLn,
            begCol: 0,
            endLn: cursor.begLn,
            endCol: 0,
          },
        );
        return;
      }
      if (cursor.endCol === 0 && cursor.endLn > cursor.begLn) {
        e.preventDefault();
        this._ignoreNextInputOnce();
        const deleteCount = cursor.endLn - cursor.begLn;
        /** @type {BcePatchOp[]} */
        const ops = [];
        if (this.lines.length - deleteCount === 0) {
          ops.push({
            type: "delete",
            index: 0,
            count: this.lines.length,
          });
          ops.push({
            type: "insert",
            index: 0,
            lines: [{ id: this.newId(), val: "" }],
          });
        } else {
          ops.push({
            type: "delete",
            index: cursor.begLn,
            count: deleteCount,
          });
        }
        const targetLine = Math.min(
          cursor.begLn,
          this.lines.length - deleteCount - 1,
        );
        this.commitChange(ops, {
          begLn: targetLine,
          begCol: 0,
          endLn: targetLine,
          endCol: 0,
        });
        return;
      }
    }

    // Ветка 2: любое другое выделение (частичное внутри строки или через
    // несколько строк, включая выделение строки целиком) - универсальное
    // удаление выделения через deleteSelection().
    if (isSelection) {
      e.preventDefault();
      this._ignoreNextInputOnce();
      this.deleteSelection(cursor);
      return;
    }

    const currentLineIdx = cursor.begLn;
    const currentLine = this.lines[currentLineIdx];

    // Ветка 3: Backspace на ПУСТОЙ строке (не единственной) - удаляем её;
    // курсор уходит в конец предыдущей строки (или остаётся в (0, 0)).
    if (currentLine.val === "" && this.lines.length > 1) {
      e.preventDefault();
      this._ignoreNextInputOnce();
      let newLineIdx = currentLineIdx;
      let newOffset = 0;
      if (currentLineIdx > 0) {
        newLineIdx = currentLineIdx - 1;
        newOffset = this.lines[newLineIdx].val.length;
      }
      this.commitChange([{ type: "delete", index: currentLineIdx, count: 1 }], {
        begLn: newLineIdx,
        begCol: newOffset,
        endLn: newLineIdx,
        endCol: newOffset,
      });
      return;
    }

    // Ветка 4: Backspace в колонке 0 непустой строки (не первой) —
    // приклеиваем текущую строку к предыдущей; курсор в точку склейки.
    if (e.key === "Backspace") {
      if (cursor.begCol === 0 && cursor.begLn > 0) {
        e.preventDefault();
        this._ignoreNextInputOnce();
        const prevLine = this.lines[cursor.begLn - 1];
        const currLine = this.lines[cursor.begLn];
        const prevLen = prevLine.val.length;
        this.commitChange(
          [
            {
              type: "replace",
              index: cursor.begLn - 1,
              lines: [{ id: prevLine.id, val: prevLine.val + currLine.val }],
            },
            { type: "delete", index: cursor.begLn, count: 1 },
          ],
          {
            begLn: cursor.begLn - 1,
            begCol: prevLen,
            endLn: cursor.begLn - 1,
            endCol: prevLen,
          },
        );
      }
      // Ветка 5: Delete в конце строки (не последней) - приклеиваем следующую
      // строку к текущей; курсор в точку склейки.
    } else if (e.key === "Delete") {
      if (
        cursor.begCol === currentLine.val.length &&
        cursor.begLn < this.lines.length - 1
      ) {
        e.preventDefault();
        this._ignoreNextInputOnce();
        const currLine = this.lines[cursor.begLn];
        const nextLine = this.lines[cursor.begLn + 1];
        const currLen = currLine.val.length;
        this.commitChange(
          [
            {
              type: "replace",
              index: cursor.begLn,
              lines: [{ id: currLine.id, val: currLine.val + nextLine.val }],
            },
            { type: "delete", index: cursor.begLn + 1, count: 1 },
          ],
          {
            begLn: cursor.begLn,
            begCol: currLen,
            endLn: cursor.begLn,
            endCol: currLen,
          },
        );
      }
    }
  }

  /**
   * Схлопывает выделение на позиции курсора (фокуса) и сдвигает его на один
   * символ влево / вправо.
   *
   * Браузер по умолчанию схлопывает выделение по левому краю диапазона,
   * из-за чего после выделения слева-направо нажатие ArrowLeft «прыгало»
   * в начало выделения. Здесь курсор двигается от точки фокуса - как в
   * обычных редакторах кода.
   * @param {KeyboardEvent} e
   * @returns {boolean} - `true`, если событие обработано (было выделение)
   * @private
   */
  _handleArrowCollapse(e) {
    const cursor = this.getCursor();
    if (
      !cursor ||
      (cursor.begLn === cursor.endLn && cursor.begCol === cursor.endCol)
    ) {
      return false; // выделения нет - пусть браузер двигает курсор сам
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

    /**
     * @param {number} mLn
     * @param {number} mCol
     * @returns {void}
     */
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
      if (this._selDesiredCol === undefined) this._selDesiredCol = moving.col;
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
      if (this._selDesiredCol === undefined) this._selDesiredCol = moving.col;
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
      // «Умный» Home: первое нажатие - первый непробельный символ,
      // второе (если курсор уже на нём) - колонка 0.
      const smartCol = this._firstNonWsCol(moving.ln);
      const targetCol =
        moving.col === smartCol && moving.col !== 0 ? 0 : smartCol;
      setCursorAndReturn(moving.ln, targetCol);
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

    const moving = this.getFocus(cursor);
    /**
     * @param {number} mLn
     * @param {number} mCol
     * @returns {void}
     */
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
          this.findWordBoundary(this.lines[mLine].val, mOffset, -1),
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
          this.findWordBoundary(this.lines[mLine].val, mOffset, 1),
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
   * @param {boolean} shift - был ли зажат Shift
   * @returns {void}
   */
  handleTab(shift) {
    const cursor = this.getCursor();
    if (!cursor) return;

    const hasSelection = !(
      cursor.begLn === cursor.endLn && cursor.begCol === cursor.endCol
    );
    const tabSize = this.options.tabSize;

    if (hasSelection && cursor.begLn === cursor.endLn && !shift) {
      const line = this.lines[cursor.begLn];
      const cut =
        line.val.substring(0, cursor.begCol) +
        line.val.substring(cursor.endCol);
      const col = cursor.begCol;
      const target = Math.ceil((col + 1) / tabSize) * tabSize;
      const add = " ".repeat(target - col);
      const newVal = cut.substring(0, col) + add + cut.substring(col);

      this.commitChange(
        [
          {
            type: "replace",
            index: cursor.begLn,
            lines: [{ id: line.id, val: newVal }],
          },
        ],
        {
          begLn: cursor.begLn,
          begCol: cursor.begCol + add.length,
          endLn: cursor.begLn,
          endCol: cursor.begCol + add.length,
        },
      );
      return;
    }

    if (hasSelection) {
      const { begLn: beg, endLn: end } = cursor;
      /** @type {number[]} */
      const deltas = [];
      /** @type {Rec[]} */
      const repl = [];

      if (shift) {
        for (let i = beg; i <= end; i++) {
          const leading = this.getLeadingSpaces(this.lines[i].val);
          const removeCount =
            leading.length > 0
              ? Math.min(leading.length, leading.length % tabSize || tabSize)
              : 0;
          repl.push({
            id: this.lines[i].id,
            val: this.lines[i].val.substring(removeCount),
          });
          deltas.push(-removeCount);
        }
      } else {
        for (let i = beg; i <= end; i++) {
          const leading = this.getLeadingSpaces(this.lines[i].val);
          const currentLen = leading.length;
          const target = Math.ceil((currentLen + 1) / tabSize) * tabSize;
          const add = " ".repeat(target - currentLen);
          repl.push({ id: this.lines[i].id, val: add + this.lines[i].val });
          deltas.push(add.length);
        }
      }

      this.commitChange([{ type: "replace", index: beg, lines: repl }], {
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
        const prevTabStop = Math.floor((cursor.begCol - 1) / tabSize) * tabSize;
        const spacesToRemove = cursor.begCol - prevTabStop;
        const removeCount = Math.min(spaceCount, spacesToRemove);
        if (removeCount > 0) {
          const newVal =
            beforeCursor.substring(0, beforeCursor.length - removeCount) +
            line.val.substring(cursor.begCol);
          this.commitChange(
            [
              {
                type: "replace",
                index: cursor.begLn,
                lines: [{ id: line.id, val: newVal }],
              },
            ],
            {
              begLn: cursor.begLn,
              begCol: cursor.begCol - removeCount,
              endLn: cursor.begLn,
              endCol: cursor.begCol - removeCount,
            },
          );
        }
      } else {
        const col = cursor.begCol;
        const target = Math.ceil((col + 1) / tabSize) * tabSize;
        const add = " ".repeat(target - col);
        const newVal =
          line.val.substring(0, cursor.begCol) +
          add +
          line.val.substring(cursor.begCol);
        this.commitChange(
          [
            {
              type: "replace",
              index: cursor.begLn,
              lines: [{ id: line.id, val: newVal }],
            },
          ],
          {
            begLn: cursor.begLn,
            begCol: cursor.begCol + add.length,
            endLn: cursor.begLn,
            endCol: cursor.begCol + add.length,
          },
        );
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

    if (cursor.begLn !== cursor.endLn || cursor.begCol !== cursor.endCol) {
      this.deleteSelection(cursor);
      cursor = this.getCursor() || cursor;
    }

    const line = this.lines[cursor.begLn];
    const before = line.val.substring(0, cursor.begCol);
    const after = line.val.substring(cursor.begCol);
    const indent = this.getLeadingSpaces(before);

    if (cursor.begCol === 0 && line.val !== "") {
      // Пустая строка сверху; существующая строка сохраняет id
      this.commitChange(
        [
          {
            type: "insert",
            index: cursor.begLn,
            lines: [{ id: this.newId(), val: "" }],
          },
        ],
        {
          begLn: cursor.begLn + 1,
          begCol: 0,
          endLn: cursor.begLn + 1,
          endCol: 0,
        },
      );
    } else {
      // Разбивка: replace текущей строки + insert новой (с сохранением
      // id текущей строки - важно для матчинга dataset.lineId в onInput)
      this.commitChange(
        [
          {
            type: "replace",
            index: cursor.begLn,
            lines: [{ id: line.id, val: before }],
          },
          {
            type: "insert",
            index: cursor.begLn + 1,
            lines: [{ id: this.newId(), val: indent + after }],
          },
        ],
        {
          begLn: cursor.begLn + 1,
          begCol: indent.length,
          endLn: cursor.begLn + 1,
          endCol: indent.length,
        },
      );
    }
  }

  /* ================================================================
  Ввод / Вставка
  ================================================================= */

  /**
   * Включает флаг «пропустить следующее событие input» ровно на одну задачу.
   *
   * Флаг ставят обработчики клавиш, которые сами правят модель и вызывают
   * `preventDefault()` (Enter, Tab, Backspace/Delete по выделению). Браузер
   * после такого `keydown` обычно НЕ присылает `input` - и флаг оставался бы
   * висеть до следующей реальной правки, из-за чего та не попадала бы в
   * историю (а Ctrl+Z откатывал бы предыдущее действие).
   *
   * Поэтому флаг автоматически снимается в конце текущей задачи: если input
   * придёт (некоторые браузеры присылают его синхронно), он ещё успеет
   * увидеть флаг; если нет - флаг не «протечёт» на следующий ввод.
   * @returns {void}
   * @private
   */
  _ignoreNextInputOnce() {
    this.ignoreNextInput = true;
    if (this._ignoreNextInputTimer) clearTimeout(this._ignoreNextInputTimer);
    this._ignoreNextInputTimer = setTimeout(() => {
      this._ignoreNextInputTimer = 0;
      this.ignoreNextInput = false;
    }, 0);
  }

  /**
   * Обрабатывает событие `input`: синхронизирует модель с DOM.
   * Также вызывается из `compositionend` (там приходит CompositionEvent).
   * @param {Event} _e - событие input или compositionend (внутри приводится
   *   к InputEvent)
   * @param {Object}   [opts]
   * @param {boolean}  [opts.deferCursor=false] - восстановить курсор в
   *   следующем кадре (для IME: во время финализации композиции синхронная
   *   установка выделения конфликтует с браузером)
   * @returns {void}
   */
  onInput(_e, { deferCursor = false } = {}) {
    const ie = /** @type {InputEvent} */ (_e);
    if (ie?.isComposing || this._composing) return;
    if (this._inserting) return;

    // Выделение ДО правки: beforeinput/keydown уже сохранили его в
    // _selectionBefore. Читаем в локальную переменную сразу - ниже
    // setCursor() перезапишет _selectionBefore позицией ПОСЛЕ правки.
    const cursorBefore = this._selectionBefore
      ? { ...this._selectionBefore }
      : null;

    // DOM уже изменён браузером до этого события - индекс текстовых узлов
    // (_nodeMap) мог устареть. До ближайшего render() getCursor() обязан
    // идти резервным путём через TreeWalker.
    this._nodeMapDirty = true;

    const lineEls = /** @type {NodeListOf<HTMLElement>} */ (
      this.content.querySelectorAll(".bce-line")
    );
    const oldLines = this.lines;
    /** @type {Rec[]} */
    const newLines = [];
    /**
     * Индексы DOM-строк, которым выдан новый id (узел создан/клонирован
     * браузером). renderLine() проставляет dataset.lineId только строкам из
     * replace/insert-операций, поэтому такие узлы синхронизируем точечно -
     * вместо O(tail) прохода по всему хвосту документа.
     * @type {number[]}
     */
    const freshIdIdx = [];

    if (lineEls.length === oldLines.length) {
      // Число строк не изменилось - id берём по позиции, Map не нужен
      lineEls.forEach((el, idx) => {
        newLines.push({ id: oldLines[idx].id, val: el.textContent || "" });
      });
    } else {
      // id строки берём из dataset.lineId. Браузер может клонировать узел
      // вместе с атрибутом (например, при разбиении строки) - дубликат id
      // сломал бы дифф и undo/redo, поэтому повторно использованный id
      // заменяем новым.
      const oldLinesMap = new Map(oldLines.map((l) => [l.id, l]));
      const usedIds = new Set();
      lineEls.forEach((el, idx) => {
        const lineId = parseInt(el.dataset.lineId ?? "0", 10);
        let id;
        if (lineId && oldLinesMap.has(lineId) && !usedIds.has(lineId)) {
          id = lineId;
        } else {
          id = this.newId();
          freshIdIdx.push(idx);
        }
        usedIds.add(id);
        newLines.push({ id, val: el.textContent || "" });
      });
    }

    if (newLines.length === 1 && newLines[0].val === "") {
      newLines[0].id = this.newId();
      if (!freshIdIdx.includes(0)) freshIdIdx.push(0);
    }
    if (newLines.length === 0) {
      // Браузер убрал все .bce-line - восстанавливаем каноническую форму
      newLines.push({ id: this.newId(), val: "" });
    }

    const ops = this.diffLines(oldLines, newLines);

    if (this.ignoreNextInput) {
      this.ignoreNextInput = false;
      if (this._ignoreNextInputTimer) clearTimeout(this._ignoreNextInputTimer);
      this._ignoreNextInputTimer = 0;
      if (ops.length) {
        // DOM разошёлся с моделью (нестандартный сценарий) - синхронизируем
        // модель; в норме дифф пуст: правка уже была закоммичена в модель
        this.lines = this._applyOpsTo(this.lines, ops);
      }
      this._nodeMapDirty = false;
      this._fireOnChange();
      return;
    }

    // Курсор читаем ДО изменения DOM (резервный путь через TreeWalker,
    // т.к. _nodeMapDirty === true)
    const cursor = this.getCursor();

    if (!ops.length) {
      // Содержимое не изменилось - историю не пополняем
      this._nodeMapDirty = false;
      this._fireOnChange();
      return;
    }

    const inverse = this._invertOps(ops);
    this.lines = this._applyOpsTo(this.lines, ops);
    // ВАЖНО: domSynced - DOM уже изменён браузером. Повторное применение
    // структурных операций удалило бы не те узлы: индексы патча относятся
    // к модели ДО правки.
    this._renderPatch(ops, { domSynced: true });

    // Точечно проставляем dataset.lineId строкам с новым id: renderLine()
    // делает это только для строк из replace/insert-операций, а строка с
    // новым id могла в них не попасть (например, при совпадении текста).
    if (this.content) {
      for (const idx of freshIdIdx) {
        const el = /** @type {HTMLElement | undefined} */ (
          this.content.children[idx]
        );
        const line = this.lines[idx];
        if (el && line) {
          const id = String(line.id);
          if (el.dataset.lineId !== id) el.dataset.lineId = id;
        }
      }
    }

    if (cursor) {
      if (deferCursor) {
        requestAnimationFrame(() => this.setCursor(cursor));
      } else {
        // Синхронно: caret должен быть восстановлен до выхода из
        // обработчика, иначе следующий ключ при быстром наборе
        // попадёт в сброшенную renderLine позицию
        this.setCursor(cursor);
      }
    }
    this._pushEntry(ops, cursor, inverse, cursorBefore);
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
    // Выделение «до»: вставка заменит его - undo должен вернуть каретку
    // в начало выделения
    this._captureSelection();
    const text = (
      e.clipboardData || /** @type {any} */ (window).clipboardData
    ).getData("text");
    if (text) {
      this.insertTextChunked(text.replace(/\r\n?/g, "\n"));
    }
  }

  /**
   * Обрабатывает нативное копирование (контекстное меню и т.п.).
   *
   * Текст в буфер кладётся «как есть» из модели: если выделение
   * заканчивается в начале следующей строки (endCol === 0), в буфере
   * остаётся хвостовой перевод строки - как у нативного copy. Это
   * устраняет браузерные причуды преобразования DOM-выделения в текст.
   *
   * Выделение НЕ сбрасывается: курсор остаётся там, где остановился,
   * а само выделение сбросит последующая вставка (замена выделения).
   * @param {ClipboardEvent} e
   * @returns {void}
   */
  onCopy(e) {
    if (this._inserting) {
      e.preventDefault();
      return;
    }
    const cursor = this.getCursor();
    if (!cursor) return;
    if (cursor.begLn === cursor.endLn && cursor.begCol === cursor.endCol)
      return; // пустое выделение - копировать нечего
    const text = this._nativeSelectionText(cursor);
    e.preventDefault();
    if (e.clipboardData) {
      e.clipboardData.setData("text/plain", text);
    } else {
      this._fallbackCopy(text);
    }
  }

  /**
   * Обрабатывает Ctrl+X (событие `cut`).
   *
   * Cut выполняется вручную, по координатам модели: и текст буфера, и
   * удаление строятся из ОДНОГО курсора (getCursor()), поэтому браузерные
   * причуды преобразования DOM-диапазона в текст (лишний перевод строки на
   * границе строк) не влияют ни на буфер, ни на документ.
   *
   * Текст в буфер кладётся «как есть»: если выделение заканчивается в начале
   * следующей строки (endCol === 0, т.е. захватывает перевод строки), в буфере
   * остаётся хвостовая пустая строка - как у нативного cut. Удаление из модели
   * выполняет deleteSelection().
   * @param {ClipboardEvent} e
   * @returns {void}
   */
  onCut(e) {
    if (this._inserting) {
      e.preventDefault();
      return;
    }
    const cursor = this.getCursor();
    if (!cursor) return;
    // Выделение «до»: cut удалит его - undo должен вернуть каретку в начало
    this._selectionBefore = {
      begLn: cursor.begLn,
      begCol: cursor.begCol,
      endLn: cursor.endLn,
      endCol: cursor.endCol,
      backward: !!cursor.backward,
    };
    if (cursor.begLn === cursor.endLn && cursor.begCol === cursor.endCol)
      return; // пустое выделение - нативно вырезать нечего

    let text;
    if (cursor.begLn === cursor.endLn) {
      text = this.lines[cursor.begLn].val.substring(
        cursor.begCol,
        cursor.endCol,
      );
    } else {
      text = this.lines[cursor.begLn].val.substring(cursor.begCol);
      for (let i = cursor.begLn + 1; i <= cursor.endLn; i++) {
        const tail =
          i === cursor.endLn
            ? this.lines[i].val.substring(0, cursor.endCol)
            : this.lines[i].val;
        text += "\n" + tail;
      }
    }

    e.preventDefault();
    if (e.clipboardData) {
      e.clipboardData.setData("text/plain", text);
    } else {
      this._fallbackCopy(text);
    }
    this.deleteSelection(cursor);
  }
}

//export default Bce;
