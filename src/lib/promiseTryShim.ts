/**
 * Side-effect-only shim: install `Promise.try` if missing.
 *
 * `unpdf` bundles a pdf.js build that eagerly calls `Promise.try` during
 * top-level module evaluation. Node 20 (the deploy target) does not yet
 * ship `Promise.try` (added in Node 22.10), which crashes the module load.
 *
 * Import this module *before* `unpdf` so the polyfill is in place when
 * pdf.js evaluates. ES modules evaluate imports in declaration order, so
 * this works as long as the import for this file precedes the unpdf import.
 */
declare global {
  interface PromiseConstructor {
    try?: <T>(fn: (...args: unknown[]) => T | Promise<T>, ...args: unknown[]) => Promise<T>;
  }
}

if (typeof Promise.try !== 'function') {
  Promise.try = function <T>(
    fn: (...args: unknown[]) => T | Promise<T>,
    ...args: unknown[]
  ): Promise<T> {
    return new Promise<T>((resolve) => resolve(fn(...args)));
  };
}

export {};
