// Смоук-тест порционной вставки insertTextChunked (модельный уровень, без DOM).
// Запуск: node test/smoke_chunked.js
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const code = fs.readFileSync(path.join(__dirname, "..", "bce.js"), "utf8");
const Bce = new Function(`${code}\n;return Bce;`)();

if (typeof globalThis.requestAnimationFrame !== "function") {
  globalThis.requestAnimationFrame = (fn) => fn();
}

function makeEditor(initial, cursor) {
  const ed = Object.create(Bce.prototype);
  ed.options = {
    tabSize: 4,
    showLineNumbers: true,
    showRecId: false,
    enableEmmet: false,
  };
  ed.seq = 0;
  ed.lines = initial.map((v) => ({ id: ++ed.seq, val: v }));
  ed._baseSnapshot = null;
  ed.history = [];
  ed.historyIndex = -1;
  ed.maxHistory = 200;
  ed.ignoreNextInput = false;
  ed._onChangeCallback = null;
  ed._highlightCache = new Map();
  ed._highlightCacheMax = 500;
  ed._nodeMap = new WeakMap();
  ed._nodeMapDirty = false;
  ed._activeLine = -1;
  ed._inserting = false;
  ed.onProgress = null;

  // DOM-стабы
  ed._cursor = cursor ?? null;
  ed.getCursor = function () {
    return this._cursor;
  };
  ed.setCursor = function (c) {
    this._cursor = c;
  };
  ed._renderPatchCalls = [];
  ed._renderPatch = function (ops) {
    this._renderPatchCalls.push(ops);
  };
  return ed;
}

// --- Тест 1: вставка 12000 строк в середину документа ---
{
  const ed = makeEditor(["head", "tail"], {
    begLn: 0,
    begCol: 2,
    endLn: 0,
    endCol: 2,
  });
  const headId = ed.lines[0].id;
  let onChangeCount = 0;
  ed._onChangeCallback = () => onChangeCount++;

  // 12000 элементов join("\n") -> 12000 строк после split, 3 порции
  const text = Array.from({ length: 12000 }, (_, i) => `L${i + 1}`).join("\n");
  ed.insertTextChunked(text, { chunkSize: 5000 });

  // Модель: 2 - 1 (head склеен) + 12000 = 12001 строк
  assert.equal(ed.lines.length, 12001, "число строк");
  assert.equal(ed.lines[0].val, "heL1", "before + slice[0]");
  assert.equal(ed.lines[0].id, headId, "id строки курсора сохранён");
  assert.equal(ed.lines[5999].val, "L6000", "середина");
  assert.equal(ed.lines[11999].val, "L12000ad", "after приклеен");
  assert.equal(ed.lines[12000].val, "tail", "последняя строка");

  // История: ровно одна запись
  assert.equal(ed.history.length, 1, "одна запись истории");
  // Курсор: конец вставленного
  assert.deepEqual(ed._cursor, {
    begLn: 11999,
    begCol: ed.lines[11999].val.length,
    endLn: 11999,
    endCol: ed.lines[11999].val.length,
  });
  // onChange один раз
  assert.equal(onChangeCount, 1, "onChange один раз");
  // _renderPatch: 3 порции
  assert.equal(ed._renderPatchCalls.length, 3, "три порции рендера");
  // Флаг сброшен
  assert.equal(ed._inserting, false, "_inserting сброшен");

  // Undo одним шагом возвращает исходное состояние
  ed.undo();
  assert.equal(ed.lines.length, 2);
  assert.equal(ed.lines[0].val, "head");
  assert.equal(ed.lines[1].val, "tail");
  // Redo восстанавливает
  ed.redo();
  assert.equal(ed.lines.length, 12001);
  assert.equal(ed.lines[11999].val, "L12000ad");

  console.log("Тест 1 (12000 строк, вставка в середину): OK");
}

// --- Тест 2: инверсии нескольких порций идут в обратном порядке ---
{
  const ed = makeEditor(
    ["a", "b"],
    { begLn: 1, begCol: 0, endLn: 1, endCol: 0 },
  );
  const text = Array.from({ length: 10001 }, (_, i) => `x${i + 1}`).join("\n");
  ed.insertTextChunked(text, { chunkSize: 5000 });
  assert.equal(ed.lines.length, 10002);
  const snapshot = ed.lines.map((l) => ({ id: l.id, val: l.val }));
  ed.undo();
  assert.equal(ed.lines.length, 2);
  assert.equal(ed.lines[0].val, "a");
  assert.equal(ed.lines[1].val, "b");
  ed.redo();
  assert.ok(!Bce.Ne(ed.lines, snapshot), "redo воспроизводит состояние");
  console.log("Тест 2 (порядок инверсий, undo/redo): OK");
}

// --- Тест 3: быстрый путь — мелкая вставка идёт через insertText ---
{
  const ed = makeEditor(
    ["ab", "cd"],
    { begLn: 0, begCol: 1, endLn: 0, endCol: 1 },
  );
  let onChangeCount = 0;
  ed._onChangeCallback = () => onChangeCount++;
  ed.insertTextChunked("X\nY", { chunkSize: 5000 });
  assert.equal(ed.lines.length, 3);
  assert.equal(ed.lines[0].val, "aX");
  assert.equal(ed.lines[1].val, "Yb");
  assert.equal(ed.lines[2].val, "cd");
  // insertText -> commitChange -> одна запись истории + onChange
  assert.equal(ed.history.length, 1);
  assert.equal(onChangeCount, 1);
  assert.equal(ed._inserting, false);
  console.log("Тест 3 (быстрый путь через insertText): OK");
}

// --- Тест 4: вставка с заменой выделения ---
{
  const ed = makeEditor(
    ["one", "two", "three"],
    { begLn: 0, begCol: 0, endLn: 2, endCol: 5 },
  );
  const text = Array.from({ length: 6001 }, (_, i) => `n${i + 1}`).join("\n");
  ed.insertTextChunked(text, { chunkSize: 5000 });
  // выделение (весь документ) удалено, вставлено 6001 строк
  assert.equal(ed.lines.length, 6001);
  assert.equal(ed.lines[0].val, "n1");
  assert.equal(ed.lines[6000].val, "n6001");
  // удаление + вставка - ОДНА запись истории: один undo отменяет всё
  assert.equal(ed.history.length, 1);
  ed.undo();
  assert.deepEqual(ed.lines.map((l) => l.val), ["one", "two", "three"]);
  console.log("Тест 4 (замена выделения, единый undo): OK");
}

// --- Тест 5: onProgress вызывается на каждой порции ---
{
  const ed = makeEditor(["a"], { begLn: 0, begCol: 1, endLn: 0, endCol: 1 });
  /** @type {Array<{inserted: number, total: number}>} */
  const progress = [];
  ed.onProgress = (p) => progress.push(p);
  const text = Array.from({ length: 11000 }, (_, i) => `p${i}`).join("\n");
  ed.insertTextChunked(text, { chunkSize: 5000 });
  assert.equal(progress.length, 3);
  assert.deepEqual(progress, [
    { inserted: 5000, total: 11000 },
    { inserted: 10000, total: 11000 },
    { inserted: 11000, total: 11000 },
  ]);
  console.log("Тест 5 (onProgress): OK");
}

console.log("\nВсе смоук-тесты insertTextChunked пройдены.");
