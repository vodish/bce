// Минимальные тесты редактора Bce (node:test, без DOM).
// Модельные методы тестируются через mock-экземпляр: Object.create(Bce.prototype)
// с DOM-стабами (render/setCursor/getCursor), логика модели остаётся настоящей.
//
// Запуск: node --test test/
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const assert = require("node:assert/strict");

// Загружаем класс из bce.js (файл не экспортирует модуль)
const code = fs.readFileSync(path.join(__dirname, "..", "bce.js"), "utf8");
const Bce = new Function(`${code}\n;return Bce;`)();

// restoreSnapshot использует requestAnimationFrame - стаб для Node
if (typeof globalThis.requestAnimationFrame !== "function") {
  globalThis.requestAnimationFrame = (fn) => fn();
}

/**
 * Создаёт «модельный» экземпляр Bce без DOM.
 * @param {string[] | undefined} initial - начальные строки
 * @param {{ line?: BceCursor }} [stubs] - стартовый курсор
 */
function makeEditor(initial, stubs = {}) {
  const ed = Object.create(Bce.prototype);
  ed.options = {
    tabSize: 4,
    initialText: "",
    showLineNumbers: false,
    showRecId: false,
    enableEmmet: false,
  };
  ed.seq = 0;
  ed.lines = [];
  ed._baseSnapshot = null;
  ed.history = [];
  ed.historyIndex = -1;
  ed.maxHistory = 200;
  ed.ignoreNextInput = false;
  ed._onChangeCallback = null;
  ed._selDesiredCol = undefined;
  ed._composing = false;
  ed._highlightCache = new Map();
  ed._highlightCacheMax = 500;
  ed._nodeMap = new WeakMap();
  ed._nodeMapDirty = false;
  ed._activeLine = -1;
  ed.keyBindings = [];
  ed.emmet = {};
  ed.emmetTriggers = ["Tab", ","];

  // --- DOM-стабы ---
  ed._cursor = stubs.line ?? null;
  ed.getCursor = function () {
    return this._cursor;
  };
  ed.render = function () {};
  ed.setCursor = function (c) {
    this._cursor = c;
  };
  ed.updateActiveLine = function () {};

  (initial ?? [""]).forEach((v) => ed.addLine(v));
  // Патч-история: текущее состояние становится базой (якорем)
  ed._resetHistoryBase();
  ed._baseSnapshot.cursor = ed.getCursor();
  return ed;
}

const cursor = (begLn, begCol, endLn = begLn, endCol = begCol) => ({
  begLn,
  begCol,
  endLn,
  endCol,
});
const vals = (ed) => ed.lines.map((l) => l.val);

/* ============================== Bce.Ne ============================== */

test("Ne: разные длины → true", () => {
  assert.equal(Bce.Ne([{ id: 1, val: "a" }], []), true);
});

test("Ne: идентичные массивы → false", () => {
  assert.equal(
    Bce.Ne(
      [
        { id: 1, val: "a" },
        { id: 2, val: "b" },
      ],
      [
        { id: 1, val: "a" },
        { id: 2, val: "b" },
      ],
    ),
    false,
  );
});

test("Ne: разные id → true", () => {
  assert.equal(Bce.Ne([{ id: 1, val: "a" }], [{ id: 2, val: "a" }]), true);
});

test("Ne: разные val → true", () => {
  assert.equal(Bce.Ne([{ id: 1, val: "a" }], [{ id: 1, val: "b" }]), true);
});

test("Ne: один и тот же объект в памяти → false", () => {
  const line = { id: 1, val: "a" };
  assert.equal(Bce.Ne([line], [line]), false);
});

/* ========================== getLeadingSpaces ========================= */

test("getLeadingSpaces: пробелы и табы", () => {
  assert.equal(Bce.prototype.getLeadingSpaces.call(null, " \tab"), " \t");
});

test("getLeadingSpaces: без ведущих пробелов → пусто", () => {
  assert.equal(Bce.prototype.getLeadingSpaces.call(null, "abc"), "");
});

/* ========================= findWordBoundary ========================= */

test("findWordBoundary: вперёд от начала слова", () => {
  assert.equal(
    Bce.prototype.findWordBoundary.call(null, "foo bar baz", 4, 1),
    7,
  );
});

test("findWordBoundary: назад от начала слова", () => {
  assert.equal(
    Bce.prototype.findWordBoundary.call(null, "foo bar baz", 4, -1),
    0,
  );
});

test("findWordBoundary: вперёд до конца строки", () => {
  assert.equal(Bce.prototype.findWordBoundary.call(null, "foo bar", 4, 1), 7);
});

/* =========================== deleteSelection ========================= */

test("deleteSelection: внутри одной строки", () => {
  const ed = makeEditor(["hello world"]);
  ed._cursor = cursor(0, 5, 0, 11);
  ed.deleteSelection(ed._cursor);
  assert.deepEqual(vals(ed), ["hello"]);
  assert.deepEqual(ed._cursor, cursor(0, 5));
});

test("deleteSelection: через несколько строк", () => {
  const ed = makeEditor(["one", "two", "three"]);
  ed._cursor = cursor(0, 1, 2, 2);
  ed.deleteSelection(ed._cursor);
  assert.deepEqual(vals(ed), ["oree"]);
  assert.deepEqual(ed._cursor, cursor(0, 1));
});

test("deleteSelection: всё содержимое → одна пустая строка", () => {
  const ed = makeEditor(["a", "b"]);
  ed._cursor = cursor(0, 0, 1, 1);
  ed.deleteSelection(ed._cursor);
  assert.deepEqual(vals(ed), [""]);
});

/* ============================= insertText ============================ */

test("insertText: однострочный", () => {
  const ed = makeEditor(["hello"]);
  ed._cursor = cursor(0, 5);
  ed.insertText(" world");
  assert.deepEqual(vals(ed), ["hello world"]);
  assert.deepEqual(ed._cursor, cursor(0, 11));
});

test("insertText: многострочный", () => {
  const ed = makeEditor(["ab"]);
  ed._cursor = cursor(0, 2);
  ed.insertText("cd\nef");
  assert.deepEqual(vals(ed), ["abcd", "ef"]);
  assert.deepEqual(ed._cursor, cursor(1, 2));
});

test("insertText: выделение удаляется перед вставкой (замена выделения)", () => {
  const ed = makeEditor(["hello world"]);
  ed._cursor = cursor(0, 6, 0, 11); // выделено "world", курсор в конце
  ed.insertText("there");
  assert.deepEqual(vals(ed), ["hello there"]);
  assert.deepEqual(ed._cursor, cursor(0, 11));
});

test("insertText: многострочное выделение удаляется перед вставкой", () => {
  const ed = makeEditor(["aaa", "bbb", "ccc"]);
  ed._cursor = cursor(0, 1, 2, 1); // выделено "aa\nbbb\ncc"
  ed.insertText("X\nY");
  assert.deepEqual(vals(ed), ["aX", "Ycc"]); // хвост "cc" последней строки остаётся
  // один Ctrl+Z отменяет и удаление, и вставку
  ed.undo();
  assert.deepEqual(vals(ed), ["aaa", "bbb", "ccc"]);
});

/* ============================== handleTab ============================ */

test("handleTab: без выделения - вставляет пробелы до таб-стопа", () => {
  const ed = makeEditor(["foo"]);
  ed._cursor = cursor(0, 0);
  ed.handleTab(false);
  assert.deepEqual(vals(ed), ["    foo"]);
  assert.deepEqual(ed._cursor, cursor(0, 4));
});

test("handleTab: выделение в одной строке - замена на пробелы", () => {
  const ed = makeEditor(["ab"]);
  ed._cursor = cursor(0, 0, 0, 2);
  ed.handleTab(false);
  assert.deepEqual(vals(ed), ["    "]);
  assert.deepEqual(ed._cursor, cursor(0, 4));
});

test("handleTab: многострочное выделение - отступ каждой строке", () => {
  const ed = makeEditor(["a", "b"]);
  ed._cursor = cursor(0, 0, 1, 1);
  ed.handleTab(false);
  assert.deepEqual(vals(ed), ["    a", "    b"]);
  assert.deepEqual(ed._cursor, cursor(0, 4, 1, 5));
});

test("handleTab: Shift+Tab - убирает отступ", () => {
  const ed = makeEditor(["    abc"]);
  ed._cursor = cursor(0, 4);
  ed.handleTab(true);
  assert.deepEqual(vals(ed), ["abc"]);
  assert.deepEqual(ed._cursor, cursor(0, 0));
});

/* ============================= handleEnter =========================== */

test("handleEnter: середина строки - перенос (курсор в начале новой строки)", () => {
  const ed = makeEditor(["hello world"]);
  ed._cursor = cursor(0, 5);
  ed.handleEnter();
  assert.deepEqual(vals(ed), ["hello", " world"]);
  // Курсор в начале новой строки (ведущий отступ пуст)
  assert.deepEqual(ed._cursor, cursor(1, 0));
});

test("handleEnter: в начале непустой строки - пустая строка сверху", () => {
  const ed = makeEditor(["abc"]);
  ed._cursor = cursor(0, 0);
  ed.handleEnter();
  assert.deepEqual(vals(ed), ["", "abc"]);
  assert.deepEqual(ed._cursor, cursor(1, 0));
});

test("handleEnter: с выделением - сначала удаление, затем разбивка", () => {
  const ed = makeEditor(["abcdef"]);
  ed._cursor = cursor(0, 1, 0, 4);
  ed.handleEnter();
  assert.deepEqual(vals(ed), ["a", "ef"]);
  assert.deepEqual(ed._cursor, cursor(1, 0));
});

/* ============================== undo / redo ========================== */

test("undo/redo: последовательность правок", () => {
  const ed = makeEditor(["a"]);
  ed._cursor = cursor(0, 1);
  ed.insertText("b"); // "ab"
  ed.insertText("c"); // "abc"
  assert.deepEqual(vals(ed), ["abc"]);

  ed.undo();
  assert.deepEqual(vals(ed), ["ab"]);
  ed.undo();
  assert.deepEqual(vals(ed), ["a"]);
  ed.redo();
  assert.deepEqual(vals(ed), ["ab"]);
  ed.redo();
  assert.deepEqual(vals(ed), ["abc"]);
});

test("undo: не выходит за начальное состояние", () => {
  const ed = makeEditor(["a"]);
  ed._cursor = cursor(0, 1);
  ed.undo();
  assert.deepEqual(vals(ed), ["a"]);
});

test("redo: не выходит за последнее состояние", () => {
  const ed = makeEditor(["a"]);
  ed._cursor = cursor(0, 1);
  ed.insertText("b");
  ed.undo();
  ed.redo();
  ed.redo(); // лишний redo
  assert.deepEqual(vals(ed), ["ab"]);
});

/* ================================ onCut ============================== */

function fakeCutEvent() {
  const ev = {
    prevented: false,
    text: null,
    clipboardData: {
      setData(fmt, text) {
        if (fmt === "text/plain") ev.text = text;
      },
    },
    preventDefault() {
      ev.prevented = true;
    },
  };
  return ev;
}

test("onCut: выделение до начала следующей строки - в буфере остаётся \\n", () => {
  const ed = makeEditor(["aaa", "bbb", "ccc"]);
  // Выделение «aa\n» (до начала строки 2): браузер отдаёт конец (1, 0)
  ed._cursor = cursor(0, 1, 1, 0);
  const ev = fakeCutEvent();
  ed.onCut(ev);
  assert.equal(ev.prevented, true);
  assert.equal(ev.text, "aa\n"); // перевод строки захвачен выделением - сохраняется
  assert.deepEqual(vals(ed), ["abbb", "ccc"]);
});

test("onCut: выделение полных строк (1,0)-(2,0) - строка уходит целиком", () => {
  const ed = makeEditor(["раз", "два", "три"]);
  ed._cursor = cursor(1, 0, 2, 0);
  const ev = fakeCutEvent();
  ed.onCut(ev);
  assert.equal(ev.text, "два\n"); // пустая строка в буфере сохраняется
  assert.deepEqual(vals(ed), ["раз", "три"]);
});

test("onCut: многострочное выделение - без перевода строки в конце буфера", () => {
  const ed = makeEditor(["aaa", "bbb", "ccc"]);
  ed._cursor = cursor(0, 1, 2, 3);
  const ev = fakeCutEvent();
  ed.onCut(ev);
  assert.equal(ev.text, "aa\nbbb\nccc");
  assert.deepEqual(vals(ed), ["a"]);
});

test("onCut: пустое выделение - ничего не делает", () => {
  const ed = makeEditor(["aaa"]);
  ed._cursor = cursor(0, 1);
  const ev = fakeCutEvent();
  ed.onCut(ev);
  assert.equal(ev.prevented, false);
  assert.equal(ev.text, null);
  assert.deepEqual(vals(ed), ["aaa"]);
});

/* =========================== _tryMoveShortcut ======================== */

test("_tryMoveShortcut: ',>' в середине - перемещает строку вниз", () => {
  const ed = makeEditor(["a,", "b"]);
  ed._cursor = cursor(0, 2);
  assert.equal(ed._tryMoveShortcut(">"), true);
  assert.deepEqual(vals(ed), ["b", "a,"]);
  assert.deepEqual(ed._cursor, cursor(1, 2));
});

test("_tryMoveShortcut: ',<' в середине - перемещает строку вверх", () => {
  const ed = makeEditor(["b", "a,"]);
  ed._cursor = cursor(1, 2);
  assert.equal(ed._tryMoveShortcut("<"), true);
  assert.deepEqual(vals(ed), ["a,", "b"]);
});

test("_tryMoveShortcut: без запятой перед курсором → false", () => {
  const ed = makeEditor(["ab"]);
  ed._cursor = cursor(0, 1);
  assert.equal(ed._tryMoveShortcut(">"), false);
  assert.deepEqual(vals(ed), ["ab"]);
});

test("_tryMoveShortcut: курсор в начале строки → false", () => {
  const ed = makeEditor(["a,", "b"]);
  ed._cursor = cursor(1, 0);
  assert.equal(ed._tryMoveShortcut(">"), false);
});

test("_tryMoveShortcut: запятая на последней строке - true без изменений", () => {
  const ed = makeEditor(["b", "a,"]);
  ed._cursor = cursor(1, 2);
  assert.equal(ed._tryMoveShortcut(">"), true);
  assert.deepEqual(vals(ed), ["b", "a,"]);
});

/* =========================== getSelectedText ========================= */

test("getSelectedText: endCol=0 - без хвостового \\n", () => {
  const ed = makeEditor(["line1", "line2", "line3"]);
  assert.equal(ed.getSelectedText(cursor(0, 0, 2, 0)), "line1\nline2");
});

test("getSelectedText: частичный конец строки", () => {
  const ed = makeEditor(["line1", "line2"]);
  assert.equal(ed.getSelectedText(cursor(0, 0, 1, 2)), "line1\nli");
});

test("getSelectedText: вся строка целиком - без \\n", () => {
  const ed = makeEditor(["line1", "line2"]);
  assert.equal(ed.getSelectedText(cursor(0, 0, 0, 5)), "line1");
});

/* ======================= copy: выделение и буфер ====================== */

test("_nativeSelectionText: endCol=0 - с хвостовым \\n (как нативный copy)", () => {
  const ed = makeEditor(["line1", "line2", "line3"]);
  assert.equal(ed._nativeSelectionText(cursor(0, 0, 2, 0)), "line1\nline2\n");
});

test("_nativeSelectionText: частичный конец строки - без хвостового \\n", () => {
  const ed = makeEditor(["line1", "line2"]);
  assert.equal(ed._nativeSelectionText(cursor(0, 0, 1, 2)), "line1\nli");
});

test("copy → paste: вставка заменяет выделение", () => {
  const ed = makeEditor(["раз", "два", "три"]);
  // выделено "два\n" (от начала "два" до начала "три"), сверху вниз
  ed._cursor = cursor(1, 0, 2, 0);
  const text = ed._nativeSelectionText(ed._cursor); // в буфере обмена
  // Ctrl+C выделение не сбрасывает - сбрасывает только вставка
  ed.insertText(text); // вставка заменяет выделение ("два\n" -> "два\n")
  assert.deepEqual(vals(ed), ["раз", "два", "три"]);
  // курсор - в конец вставленного, выделение сброшено
  assert.deepEqual(ed._cursor, cursor(2, 0));
});

test("insertText: при выделении снизу вверх выделение удаляется перед вставкой", () => {
  const ed = makeEditor(["ab"]);
  ed._cursor = { ...cursor(0, 1, 0, 2), backward: true }; // курсор в (0,1)
  ed.insertText("X");
  assert.deepEqual(vals(ed), ["aX"]);
  assert.deepEqual(ed._cursor, cursor(0, 2));
});

/* ============================= getLines ============================== */

test("getLines: возвращает копию - мутация не влияет на редактор", () => {
  const ed = makeEditor(["a", "b"]);
  const copy = ed.getLines();
  copy.push({ id: 999, val: "x" });
  copy[0].val = "MUTATED";
  assert.deepEqual(vals(ed), ["a", "b"]);
});

test("getLines: пустой редактор → пустой массив", () => {
  const ed = makeEditor([""]);
  assert.deepEqual(ed.getLines(), []);
});

/* ======================== addEmmet / tryEmmet ======================== */

test("tryEmmet: разворачивает базовое сокращение", () => {
  const ed = makeEditor(["a"]);
  ed._cursor = cursor(0, 1);
  ed.emmet = { a: '<a href="|"></a>' };
  assert.equal(ed.tryEmmet(), true);
  assert.deepEqual(vals(ed), ['<a href=""></a>']);
  assert.deepEqual(ed._cursor, cursor(0, 9));
});

test("addEmmet: новое сокращение разворачивается", () => {
  const ed = makeEditor(["div"]);
  ed._cursor = cursor(0, 3);
  ed.addEmmet("div", "<div>|</div>");
  assert.equal(ed.tryEmmet(), true);
  assert.deepEqual(vals(ed), ["<div></div>"]);
  assert.deepEqual(ed._cursor, cursor(0, 5));
});

test("removeEmmet: сокращение больше не разворачивается", () => {
  const ed = makeEditor(["div"]);
  ed._cursor = cursor(0, 3);
  ed.addEmmet("div", "<div>|</div>");
  ed.removeEmmet("div");
  assert.equal(ed.tryEmmet(), false);
  assert.deepEqual(vals(ed), ["div"]);
});

/* ==================== патчи: round-trip операций ==================== */

test("round-trip: replace - forward затем inverse восстанавливает строки и id", () => {
  const ed = makeEditor(["aaa", "bbb", "ccc"]);
  const before = ed.lines.map((l) => ({ ...l }));
  const ops = [{ type: "replace", index: 1, lines: [{ id: 99, val: "XXX" }] }];
  const inv = ed._invertOps(ops);
  ed.lines = ed._applyOpsTo(ed.lines, ops);
  assert.deepEqual(vals(ed), ["aaa", "XXX", "ccc"]);
  ed.lines = ed._applyOpsTo(ed.lines, inv);
  assert.deepEqual(ed.lines, before);
});

test("round-trip: delete - inverse восстанавливает удалённые строки с их id", () => {
  const ed = makeEditor(["aaa", "bbb", "ccc"]);
  const before = ed.lines.map((l) => ({ ...l }));
  const ops = [{ type: "delete", index: 0, count: 2 }];
  const inv = ed._invertOps(ops);
  ed.lines = ed._applyOpsTo(ed.lines, ops);
  assert.deepEqual(vals(ed), ["ccc"]);
  ed.lines = ed._applyOpsTo(ed.lines, inv);
  assert.deepEqual(ed.lines, before);
});

test("round-trip: insert - inverse удаляет вставленное", () => {
  const ed = makeEditor(["aaa"]);
  const before = ed.lines.map((l) => ({ ...l }));
  const ops = [
    { type: "insert", index: 1, lines: [{ id: 77, val: "n1" }, { id: 78, val: "n2" }] },
  ];
  const inv = ed._invertOps(ops);
  ed.lines = ed._applyOpsTo(ed.lines, ops);
  assert.deepEqual(vals(ed), ["aaa", "n1", "n2"]);
  ed.lines = ed._applyOpsTo(ed.lines, inv);
  assert.deepEqual(ed.lines, before);
});

test("round-trip: набор операций (replace + delete + insert)", () => {
  const ed = makeEditor(["l0", "l1", "l2", "l3"]);
  const before = ed.lines.map((l) => ({ ...l }));
  const ops = [
    { type: "replace", index: 0, lines: [{ id: 1, val: "L0" }] },
    { type: "delete", index: 2, count: 1 },
    { type: "insert", index: 2, lines: [{ id: 90, val: "new" }] },
  ];
  const inv = ed._invertOps(ops);
  ed.lines = ed._applyOpsTo(ed.lines, ops);
  ed.lines = ed._applyOpsTo(ed.lines, inv);
  assert.deepEqual(ed.lines, before);
});

test("round-trip: setLines (замена документа целиком)", () => {
  const ed = makeEditor(["old1", "old2"]);
  const before = ed.lines.map((l) => ({ ...l }));
  const ops = [{ type: "setLines", lines: [{ id: 50, val: "fresh" }] }];
  const inv = ed._invertOps(ops);
  ed.lines = ed._applyOpsTo(ed.lines, ops);
  assert.deepEqual(vals(ed), ["fresh"]);
  ed.lines = ed._applyOpsTo(ed.lines, inv);
  assert.deepEqual(ed.lines, before);
});

/* ================== патчи: серия случайных операций ================== */

test("серия из 100 случайных операций → undo ×100 → redo ×100 → состояние совпадает", () => {
  const ed = makeEditor(["l0", "l1", "l2"]);
  const rnd = () => Math.floor(Math.random() * 1e9);
  for (let i = 0; i < 100; i++) {
    const len = ed.lines.length;
    const idx = rnd() % len;
    const kind = rnd() % 3;
    if (kind === 0) {
      // replace текущей строки
      ed.commitChange(
        [
          {
            type: "replace",
            index: idx,
            lines: [{ id: ed.lines[idx].id, val: "v" + rnd() }],
          },
        ],
        cursor(idx, 0),
      );
    } else if (kind === 1) {
      // insert новой строки
      ed.commitChange(
        [
          {
            type: "insert",
            index: idx,
            lines: [{ id: ed.newId(), val: "i" + rnd() }],
          },
        ],
        cursor(idx, 0),
      );
    } else if (len > 1) {
      // delete строки (не последней)
      ed.commitChange([{ type: "delete", index: idx, count: 1 }],
        cursor(Math.max(0, idx - 1), 0));
    } else {
      ed.commitChange(
        [
          {
            type: "replace",
            index: idx,
            lines: [{ id: ed.lines[idx].id, val: "s" + rnd() }],
          },
        ],
        cursor(idx, 0),
      );
    }
  }
  const finalState = ed.lines.map((l) => ({ ...l }));

  let undos = 0;
  while (ed.historyIndex >= 0) {
    ed.undo();
    undos++;
  }
  assert.ok(undos > 0);
  assert.deepEqual(vals(ed), ["l0", "l1", "l2"]);

  let redos = 0;
  while (ed.historyIndex < ed.history.length - 1) {
    ed.redo();
    redos++;
  }
  assert.equal(redos, undos);
  assert.deepEqual(ed.lines, finalState);
});

/* ======================= компакция базы ======================= */

test("компакция: после > maxHistory патчей глубина прошлого ограничена", () => {
  const ed = makeEditor(["base"]);
  ed.maxHistory = 10;
  for (let i = 0; i < 25; i++) {
    ed.commitChange(
      [
        {
          type: "replace",
          index: 0,
          lines: [{ id: ed.lines[0].id, val: "v" + i }],
        },
      ],
      cursor(0, 0),
    );
  }
  // Глубина прошлого ограничена, но redo-хвост сохранён
  assert.ok(ed.history.length <= 11, `history.length=${ed.history.length}`);

  // Полное undo останавливается на базе (аналог старого history.shift():
  // самый старый «хвост» истории уходит при компакции).
  // 25 патчей, компакции на 11-м и 22-м push → остаются 3 патча,
  // база = состояние после 22-го push ("v21").
  let steps = 0;
  while (ed.historyIndex >= 0) {
    ed.undo();
    steps++;
  }
  assert.ok(steps > 0 && steps <= 11, `steps=${steps}`);
  assert.deepEqual(vals(ed), ["v21"]);

  // Полный redo восстанавливает финальное состояние
  while (ed.historyIndex < ed.history.length - 1) ed.redo();
  assert.deepEqual(vals(ed), ["v24"]);
});

test("компакция: undo до базы восстанавливает состояние базы (vals и id)", () => {
  const ed = makeEditor(["a", "b"]);
  ed.maxHistory = 3;
  for (let i = 0; i < 10; i++) {
    ed.commitChange(
      [
        {
          type: "insert",
          index: 0,
          lines: [{ id: ed.newId(), val: "x" + i }],
        },
      ],
      cursor(0, 0),
    );
  }
  while (ed.historyIndex >= 0) ed.undo();
  // Модель ровно совпадает с базой - и по vals, и по id
  assert.deepEqual(ed.lines, ed._baseSnapshot.lines);
  assert.deepEqual(vals(ed), ["x7", "x6", "x5", "x4", "x3", "x2", "x1", "x0", "a", "b"]);

  // Полный redo восстанавливает финальное состояние
  const finalState = "x9 x8 x7 x6 x5 x4 x3 x2 x1 x0 a b".split(" ");
  while (ed.historyIndex < ed.history.length - 1) ed.redo();
  assert.deepEqual(vals(ed), finalState);
});

/* ================== стабильность id и курсоров ================== */

test("id строк стабильны после undo/redo (мэппинг dataset.lineId в onInput)", () => {
  const ed = makeEditor(["one", "two"]);
  const idsBefore = ed.lines.map((l) => l.id);
  ed.commitChange([{ type: "delete", index: 0, count: 1 }], cursor(0, 0));
  ed.undo();
  assert.deepEqual(ed.lines.map((l) => l.id), idsBefore);
  ed.redo();
  ed.undo();
  assert.deepEqual(ed.lines.map((l) => l.id), idsBefore);
});

test("insertText: undo восстанавливает исходные id, redo воспроизводит новые", () => {
  const ed = makeEditor(["ab"]);
  ed._cursor = cursor(0, 2);
  const idsBefore = ed.lines.map((l) => l.id);
  ed.insertText("cd\nef");
  const after = ed.lines.map((l) => ({ ...l }));
  ed.undo();
  assert.deepEqual(ed.lines.map((l) => l.id), idsBefore);
  ed.redo();
  assert.deepEqual(ed.lines, after);
});

test("курсоры: cursorBefore/cursorAfter восстанавливаются на каждом шаге", () => {
  // Стартовый курсор передаётся через стаб, чтобы он попал и в базу истории
  const ed = makeEditor(["a"], { line: cursor(0, 1) });
  ed.insertText("b"); // cursorAfter (0,2)
  ed.insertText("c"); // cursorAfter (0,3)
  ed.undo();
  assert.deepEqual(ed._cursor, cursor(0, 2));
  ed.undo();
  assert.deepEqual(ed._cursor, cursor(0, 1));
  ed.redo();
  assert.deepEqual(ed._cursor, cursor(0, 2));
  ed.redo();
  assert.deepEqual(ed._cursor, cursor(0, 3));
});

test("undo: после замены выделения каретка встаёт в якорь выделения", () => {
  // Регрессия: раньше cursorBefore брался из предыдущей записи истории
  // (или из null у базы), и Ctrl+Z после замены выделения уводил каретку
  // в начало документа.
  const ed = makeEditor(["раз", "    два", "три"], { line: cursor(2, 0) });
  const lineId = ed.lines[1].id;
  // Выделение сделано снизу вверх: якорь (2,0), фокус (1,0)
  ed._selectionBefore = {
    begLn: 1,
    begCol: 0,
    endLn: 2,
    endCol: 0,
    backward: true,
  };
  // Ввод "q" вместо выделения: "раз\nqтри"
  ed.commitChange(
    [
      { type: "replace", index: 1, lines: [{ id: lineId, val: "qтри" }] },
      { type: "delete", index: 2, count: 1 },
    ],
    cursor(1, 1),
  );
  assert.deepEqual(vals(ed), ["раз", "qтри"]);

  ed.undo();
  assert.deepEqual(vals(ed), ["раз", "    два", "три"]);
  // Начало выделения (якорь), выделение сброшено
  assert.deepEqual(ed._cursor, cursor(2, 0));
});

test("undo: выделение «вперёд» - каретка в начало диапазона", () => {
  const ed = makeEditor(["a", "b", "c"], { line: cursor(0, 0) });
  ed._selectionBefore = { begLn: 0, begCol: 1, endLn: 2, endCol: 1 };
  ed.commitChange(
    [
      { type: "replace", index: 0, lines: [{ id: ed.lines[0].id, val: "aXc" }] },
      { type: "delete", index: 1, count: 2 },
    ],
    cursor(0, 2),
  );
  assert.deepEqual(vals(ed), ["aXc"]);

  ed.undo();
  assert.deepEqual(vals(ed), ["a", "b", "c"]);
  assert.deepEqual(ed._cursor, cursor(0, 1));
});

test("история: курсор «до» берётся из снимка выделения, а не из прошлой правки", () => {
  const ed = makeEditor(["abc"], { line: cursor(0, 3) });
  ed.commitChange(
    [{ type: "replace", index: 0, lines: [{ id: ed.lines[0].id, val: "abcd" }] }],
    cursor(0, 4),
  );
  // Пользователь кликнул в начало строки: снимок обновили события мыши
  ed._selectionBefore = { begLn: 0, begCol: 0, endLn: 0, endCol: 0 };
  ed.commitChange(
    [{ type: "replace", index: 0, lines: [{ id: ed.lines[0].id, val: "Xabcd" }] }],
    cursor(0, 1),
  );

  ed.undo();
  // (0,0) - где была каретка перед вводом, а не (0,4) от предыдущей правки
  assert.deepEqual(ed._cursor, cursor(0, 0));
});

/* ============================ diffLines ============================ */

test("diffLines: замена текста в одной строке", () => {
  const ed = makeEditor(["a", "b", "c"]);
  const oldL = ed.lines;
  const newL = [
    { id: oldL[0].id, val: "a" },
    { id: oldL[1].id, val: "B" },
    { id: oldL[2].id, val: "c" },
  ];
  assert.deepEqual(ed.diffLines(oldL, newL), [
    { type: "replace", index: 1, lines: [{ id: oldL[1].id, val: "B" }] },
  ]);
});

test("diffLines: вставка строки в середину", () => {
  const ed = makeEditor(["a", "c"]);
  const oldL = ed.lines;
  const newL = [
    { id: oldL[0].id, val: "a" },
    { id: 42, val: "b" },
    { id: oldL[1].id, val: "c" },
  ];
  assert.deepEqual(ed.diffLines(oldL, newL), [
    { type: "insert", index: 1, lines: [{ id: 42, val: "b" }] },
  ]);
});

test("diffLines: удаление строки", () => {
  const ed = makeEditor(["a", "b", "c"]);
  const oldL = ed.lines;
  const newL = [
    { id: oldL[0].id, val: "a" },
    { id: oldL[2].id, val: "c" },
  ];
  assert.deepEqual(ed.diffLines(oldL, newL), [
    { type: "delete", index: 1, count: 1 },
  ]);
});

test("diffLines: без изменений → пустой список операций", () => {
  const ed = makeEditor(["a", "b"]);
  const oldL = ed.lines;
  const newL = oldL.map((l) => ({ id: l.id, val: l.val }));
  assert.deepEqual(ed.diffLines(oldL, newL), []);
});

test("diffLines: round-trip через _applyOpsTo", () => {
  const ed = makeEditor(["a", "b", "c"]);
  const oldL = ed.lines.map((l) => ({ ...l }));
  const newL = [
    { id: oldL[0].id, val: "A" },
    { id: 70, val: "x" },
    { id: 71, val: "y" },
    { id: oldL[2].id, val: "c!" },
  ];
  const ops = ed.diffLines(oldL, newL);
  ed.lines = ed._applyOpsTo(ed.lines.map((l) => ({ ...l })), ops);
  assert.deepEqual(ed.lines, newL);
});

/* ======================= setText / setLines ======================= */

test("setText: без resetHistory - старый документ доступен через undo", () => {
  const ed = makeEditor(["old"]);
  ed.setText("new\ndoc");
  assert.deepEqual(vals(ed), ["new", "doc"]);
  ed.undo();
  assert.deepEqual(vals(ed), ["old"]);
  ed.redo();
  assert.deepEqual(vals(ed), ["new", "doc"]);
});

test("setText: c resetHistory - история очищена", () => {
  const ed = makeEditor(["old"]);
  ed._cursor = cursor(0, 1);
  ed.insertText("X");
  ed.setText("new", { resetHistory: true });
  ed.undo(); // не должен откатывать
  assert.deepEqual(vals(ed), ["new"]);
});

test("setLines: без resetHistory - undo возвращает прежний документ с id", () => {
  const ed = makeEditor(["old"]);
  ed.setLines([
    { id: 42, val: "a" },
    { id: 43, val: "b" },
  ]);
  assert.deepEqual(vals(ed), ["a", "b"]);
  ed.undo();
  assert.deepEqual(vals(ed), ["old"]);
  ed.redo();
  assert.deepEqual(vals(ed), ["a", "b"]);
  assert.deepEqual(
    ed.lines.map((l) => l.id),
    [42, 43],
  );
});

/* ======================= «Умный» Home ======================= */

/** Фейковое событие клавиатуры для обработчиков навигации */
const keyEvent = (key, opts = {}) => ({
  key,
  shiftKey: Boolean(opts.shiftKey),
  altKey: Boolean(opts.altKey),
  ctrlKey: Boolean(opts.ctrlKey),
  metaKey: Boolean(opts.metaKey),
  preventDefault() {
    this.defaultPrevented = true;
  },
});

test("_firstNonWsCol: ведущие пробелы, табы, пустая строка, одни пробелы", () => {
  const ed = makeEditor(["    раз два", "\tabc", "", "   ", "x"]);
  assert.equal(ed._firstNonWsCol(0), 4);
  assert.equal(ed._firstNonWsCol(1), 1);
  assert.equal(ed._firstNonWsCol(2), 0);
  assert.equal(ed._firstNonWsCol(3), 3); // одни пробелы → конец строки
  assert.equal(ed._firstNonWsCol(4), 0);
});

test("_handleHome: из середины строки - на первый непробельный символ", () => {
  const ed = makeEditor(["    раз два"], { line: cursor(0, 9) });
  const e = keyEvent("Home");
  ed._handleHome(e);
  assert.equal(e.defaultPrevented, true);
  assert.deepEqual(ed.getCursor(), { ...cursor(0, 4), backward: false });
});

test("_handleHome: повторное нажатие с первой непробельной - в колонку 0", () => {
  const ed = makeEditor(["    раз два"], { line: cursor(0, 4) });
  const e = keyEvent("Home");
  ed._handleHome(e);
  assert.deepEqual(ed.getCursor(), { ...cursor(0, 0), backward: false });
});

test("_handleHome: из колонки 0 - обратно на первый непробельный символ", () => {
  const ed = makeEditor(["    раз два"], { line: cursor(0, 0) });
  const e = keyEvent("Home");
  ed._handleHome(e);
  assert.deepEqual(ed.getCursor(), { ...cursor(0, 4), backward: false });
});

test("_handleHome: строка без отступа - всегда колонка 0", () => {
  const ed = makeEditor(["раз два"], { line: cursor(0, 3) });
  const e = keyEvent("Home");
  ed._handleHome(e);
  assert.deepEqual(ed.getCursor(), { ...cursor(0, 0), backward: false });
  const e2 = keyEvent("Home");
  ed._handleHome(e2);
  assert.deepEqual(ed.getCursor(), { ...cursor(0, 0), backward: false });
});

test("_handleHome: выделение схлопывается в точке фокуса", () => {
  const ed = makeEditor(["    раз два"], { line: cursor(0, 0, 0, 9) });
  const e = keyEvent("Home");
  ed._handleHome(e);
  assert.deepEqual(ed.getCursor(), { ...cursor(0, 4), backward: false });
});

test("_handleShiftArrows: Shift+Home - тот же «умный» тоггл", () => {
  const ed = makeEditor(["    раз два"], { line: cursor(0, 9) });
  // Локальный стаб, повторяющий нормализацию настоящего setCursor
  // (сортировка beg/end + сохранение backward).
  ed.setCursor = function (c) {
    let { begLn, begCol, endLn, endCol } = c;
    if (begLn > endLn || (begLn === endLn && begCol > endCol)) {
      [begLn, endLn] = [endLn, begLn];
      [begCol, endCol] = [endCol, begCol];
    }
    this._cursor = { begLn, begCol, endLn, endCol, backward: !!c.backward };
  };
  const e = keyEvent("Home", { shiftKey: true });
  ed._handleShiftArrows(e);
  // якорь остаётся в (0,9), фокус - на первом непробельном (0,4)
  assert.deepEqual(ed.getCursor(), {
    begLn: 0,
    begCol: 4,
    endLn: 0,
    endCol: 9,
    backward: true,
  });
  const e2 = keyEvent("Home", { shiftKey: true });
  ed._handleShiftArrows(e2);
  // фокус уже на «умной» позиции - расширяется до колонки 0
  assert.deepEqual(ed.getCursor(), {
    begLn: 0,
    begCol: 0,
    endLn: 0,
    endCol: 9,
    backward: true,
  });
});

test("_handleNavigation: обычный Home перехватывается («умный» тоггл)", () => {
  const ed = makeEditor(["    раз два"], { line: cursor(0, 9) });
  const e = keyEvent("Home");
  const handled = ed._handleNavigation(e);
  assert.equal(handled, true);
  assert.deepEqual(ed.getCursor(), { ...cursor(0, 4), backward: false });
  const e2 = keyEvent("Home");
  ed._handleNavigation(e2);
  assert.deepEqual(ed.getCursor(), { ...cursor(0, 0), backward: false });
});

/* ============================== actionMove ============================== */

test("actionMove: многострочное выделение перемещается блоком вниз", () => {
  const ed = makeEditor(["раз", "два", "    три"], {
    line: cursor(0, 0, 1, 1),
  });
  ed.actionMove(1);
  assert.deepEqual(vals(ed), ["    три", "раз", "два"]);
  // Выделение сохраняется, обе границы сдвинулись на одну строку
  assert.deepEqual(ed.getCursor(), cursor(1, 0, 2, 1));
});

test("actionMove: многострочное выделение перемещается блоком вверх", () => {
  const ed = makeEditor(["раз", "два", "    три"], {
    line: cursor(1, 0, 2, 2),
  });
  ed.actionMove(-1);
  assert.deepEqual(vals(ed), ["два", "    три", "раз"]);
  assert.deepEqual(ed.getCursor(), cursor(0, 0, 1, 2));
});

test("actionMove: выделение снизу вверх перемещается блоком", () => {
  const ed = makeEditor(["раз", "два", "    три"], {
    line: cursor(1, 2, 0, 0),
  });
  ed.actionMove(1);
  assert.deepEqual(vals(ed), ["    три", "раз", "два"]);
  assert.deepEqual(ed.getCursor(), cursor(2, 2, 1, 0));
});

test("actionMove: блок на границе документа - без изменений", () => {
  const edDown = makeEditor(["раз", "два"], { line: cursor(0, 0, 1, 1) });
  edDown.actionMove(1);
  assert.deepEqual(vals(edDown), ["раз", "два"]);

  const edUp = makeEditor(["раз", "два"], { line: cursor(0, 0, 1, 1) });
  edUp.actionMove(-1);
  assert.deepEqual(vals(edUp), ["раз", "два"]);
});

test("actionMove: одна строка - прежнее поведение (обмен, курсор следует)", () => {
  const ed = makeEditor(["раз", "два", "    три"], { line: cursor(0, 2) });
  ed.actionMove(1);
  assert.deepEqual(vals(ed), ["два", "раз", "    три"]);
  assert.deepEqual(ed.getCursor(), cursor(1, 2));
});

test("actionMove: id строк сохраняются при перемещении блока", () => {
  const ed = makeEditor(["раз", "два", "    три"], {
    line: cursor(0, 0, 1, 1),
  });
  const ids = ed.lines.map((l) => l.id);
  ed.actionMove(1);
  assert.deepEqual(
    ed.lines.map((l) => l.id),
    [ids[2], ids[0], ids[1]],
  );
});
