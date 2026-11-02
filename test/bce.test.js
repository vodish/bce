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
  ed.pushHistory(null);
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
