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

test("insertText: заменяет выделение", () => {
  const ed = makeEditor(["hello world"]);
  ed._cursor = cursor(0, 6, 0, 11);
  ed.insertText("there");
  assert.deepEqual(vals(ed), ["hello there"]);
  assert.deepEqual(ed._cursor, cursor(0, 11));
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
