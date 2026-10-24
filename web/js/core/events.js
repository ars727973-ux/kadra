// Минимальный эмиттер событий, используемый store, движком и панелями.
export class Emitter {
  constructor() {
    this._handlers = new Map();
  }

  /** Подписка на событие. Возвращает функцию отписки. */
  on(type, fn) {
    if (!this._handlers.has(type)) this._handlers.set(type, new Set());
    this._handlers.get(type).add(fn);
    return () => this.off(type, fn);
  }

  off(type, fn) {
    const set = this._handlers.get(type);
    if (set) set.delete(fn);
  }

  emit(type, payload) {
    const set = this._handlers.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[events] обработчик "${type}" упал`, err);
      }
    }
  }
}
