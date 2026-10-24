// Undo/Redo через командную модель.
//
// Каждое изменение проекта выполняется как Command с методами do()/undo().
// Базовая реализация — SnapshotCommand: перед выполнением мутации снимается
// «слепок» (memento) проекта, после — второй слепок. Проект хранит только
// лёгкие данные (тяжёлые превью/пики лежат отдельно в IndexedDB), поэтому
// слепок занимает килобайты, а глубина истории — 200 шагов (минимум по ТЗ — 50).

export class Command {
  constructor(label) {
    this.label = label;
    this.time = Date.now();
  }
  do() {}
  undo() {}
}

/** Команда-слепок: универсальна для любых операций над проектом. */
export class SnapshotCommand extends Command {
  constructor(label, before, after, mergeKey = null) {
    super(label);
    this.before = before;
    this.after = after;
    this.mergeKey = mergeKey;
  }
  do(target) {
    target.restoreSnapshot(this.after);
  }
  undo(target) {
    target.restoreSnapshot(this.before);
  }
}

export class History {
  /**
   * @param target объект с методами takeSnapshot() и restoreSnapshot(snap)
   */
  constructor(target, limit = 200) {
    this.target = target;
    this.limit = limit;
    this.undoStack = [];
    this.redoStack = [];
    this.listeners = new Set();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _notify() {
    for (const fn of this.listeners) fn(this);
  }

  /**
   * Выполнить мутацию как отменяемую команду.
   * mergeKey — склейка непрерывных правок (перетаскивание слайдера) в один шаг.
   * Если fn вернул false — изменения не было, команда не записывается.
   */
  run(label, fn, { mergeKey = null } = {}) {
    const before = this.target.takeSnapshot();
    let result;
    try {
      result = fn();
    } catch (err) {
      // Откатываем частично выполненную операцию
      this.target.restoreSnapshot(before);
      throw err;
    }
    if (result === false) return result;
    const after = this.target.takeSnapshot();
    if (after === before || JSON.stringify(after) === JSON.stringify(before)) return result;
    const last = this.undoStack[this.undoStack.length - 1];
    if (mergeKey && last && last.mergeKey === mergeKey && Date.now() - last.time < 1500) {
      last.after = after;
      last.time = Date.now();
    } else {
      this.undoStack.push(new SnapshotCommand(label, before, after, mergeKey));
      if (this.undoStack.length > this.limit) this.undoStack.shift();
    }
    this.redoStack.length = 0;
    this._notify();
    return result;
  }

  /** Добавить готовую команду (для расширений этапа 2). */
  push(command) {
    command.do(this.target);
    this.undoStack.push(command);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
    this._notify();
  }

  canUndo() {
    return this.undoStack.length > 0;
  }
  canRedo() {
    return this.redoStack.length > 0;
  }

  undo() {
    const cmd = this.undoStack.pop();
    if (!cmd) return null;
    cmd.undo(this.target);
    this.redoStack.push(cmd);
    this._notify();
    return cmd;
  }

  redo() {
    const cmd = this.redoStack.pop();
    if (!cmd) return null;
    cmd.do(this.target);
    this.undoStack.push(cmd);
    this._notify();
    return cmd;
  }

  /** Перейти к состоянию после команды с индексом index (панель «История»). */
  jumpTo(index) {
    while (this.undoStack.length - 1 > index && this.undoStack.length) this.undo();
    while (this.undoStack.length - 1 < index && this.redoStack.length) this.redo();
  }

  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this._notify();
  }
}
