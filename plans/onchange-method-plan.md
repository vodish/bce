# План: добавление метода `onChange(fn)` в класс Bce

## Изменения в файле `bce.js`

### 1. Конструктор — новое поле
Добавить после строки 25 (рядом с `this.ignoreNextInput`):
```js
this._onChangeCallback = null;
```

### 2. Новый метод `onChange(fn)`
Добавить после метода `setLines` (после строки 475):
```js
onChange(fn) {
  this._onChangeCallback = fn;
  if (typeof fn === 'function') {
    fn(this);
  }
}
```

### 3. Новый приватный метод `_fireOnChange()`
Добавить после метода `onChange`:
```js
_fireOnChange() {
  if (typeof this._onChangeCallback === 'function') {
    this._onChangeCallback(this);
  }
}
```

### 4. Точки вызова `_fireOnChange()`

| Метод | Строка | Когда вызывать |
|---|---|---|
| `commitChange()` | 415 | В конце метода, после `pushHistory()` |
| `setText()` | 458 | В конце метода, после `pushHistory()` |
| `setLines()` | 470 | В конце метода, после `pushHistory()` |
| `onInput()` | 1246 | В конце метода, после `pushHistory()` и `render()` |

## Схема потока вызовов

```mermaid
flowchart TD
    A[Пользовательский код] -->|new Bce| B[Конструктор]
    A -->|editor.onChange(fn)| C[onChange(fn)]
    C --> D[Сохранить fn в _onChangeCallback]
    C --> E[Вызвать fn(this) сразу]
    
    F[Изменение редактора] --> G{Тип изменения}
    G -->|Ввод текста| H[onInput]
    G -->|Программно| I[setText / setLines]
    G -->|Команды| J[commitChange]
    
    H --> K[_fireOnChange]
    I --> K
    J --> K
    K --> L{_onChangeCallback установлен?}
    L -->|Да| M[Вызвать _onChangeCallback(this)]
    L -->|Нет| N[Ничего не делать]