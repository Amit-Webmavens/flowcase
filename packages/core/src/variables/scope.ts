import type { JsonValue } from '../model/common.js';

/**
 * A chained variable store.
 *
 * Layers exist so a repeat iteration or a snippet can shadow a name without
 * leaking it: `child()` creates a scope that reads through to its parent but
 * writes locally. Values a test wants to hand to the tests that depend on it are
 * written with `setRunScoped`, which always lands in the root layer.
 */
export class VariableScope {
  private readonly values = new Map<string, JsonValue>();

  constructor(private readonly parent?: VariableScope) {}

  static fromObject(values: Record<string, JsonValue>, parent?: VariableScope): VariableScope {
    const scope = new VariableScope(parent);

    for (const [name, value] of Object.entries(values)) {
      scope.set(name, value);
    }

    return scope;
  }

  child(): VariableScope {
    return new VariableScope(this);
  }

  get root(): VariableScope {
    return this.parent ? this.parent.root : this;
  }

  set(name: string, value: JsonValue): void {
    this.values.set(name, value);
  }

  /** Writes to the outermost scope, making the value visible to dependent tests. */
  setRunScoped(name: string, value: JsonValue): void {
    this.root.set(name, value);
  }

  get(name: string): JsonValue | undefined {
    if (this.values.has(name)) {
      return this.values.get(name);
    }

    return this.parent?.get(name);
  }

  has(name: string): boolean {
    return this.values.has(name) || (this.parent?.has(name) ?? false);
  }

  delete(name: string): void {
    this.values.delete(name);
  }

  /** All visible names, nearest layer winning. */
  names(): string[] {
    const seen = new Set<string>(this.values.keys());

    for (const name of this.parent?.names() ?? []) {
      seen.add(name);
    }

    return [...seen].sort();
  }

  /** Flattens the chain into a plain object, nearest layer winning. */
  toObject(): Record<string, JsonValue> {
    const base = this.parent?.toObject() ?? {};

    for (const [name, value] of this.values) {
      base[name] = value;
    }

    return base;
  }
}
