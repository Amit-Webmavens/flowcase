import { describe, expect, it } from 'vitest';
import {
  MissingVariableError,
  collectVariableNames,
  interpolate,
  readPath,
  resolveTyped,
  splitPath,
} from '../src/variables/interpolate.js';
import { VariableScope } from '../src/variables/scope.js';

const scopeWith = (values: Record<string, unknown>): VariableScope =>
  VariableScope.fromObject(values as Parameters<typeof VariableScope.fromObject>[0]);

describe('interpolate', () => {
  it('replaces simple variables', () => {
    const scope = scopeWith({ name: 'Ada' });
    expect(interpolate('Hello {{name}}!', scope)).toBe('Hello Ada!');
  });

  it('reads nested paths and array indexes', () => {
    const scope = scopeWith({ row: { user: { email: 'a@b.c' } }, items: ['x', 'y'] });

    expect(interpolate('{{row.user.email}}', scope)).toBe('a@b.c');
    expect(interpolate('{{items[1]}}', scope)).toBe('y');
  });

  it('applies filters in order', () => {
    const scope = scopeWith({ name: '  Ada Lovelace  ' });

    expect(interpolate('{{name | trim | upper}}', scope)).toBe('ADA LOVELACE');
    expect(interpolate('{{name | trim | slice(0,3)}}', scope)).toBe('Ada');
  });

  it('falls back with the default filter', () => {
    const scope = scopeWith({});
    expect(interpolate('{{missing | default("n/a")}}', scope)).toBe('n/a');
  });

  it('throws on an unknown variable by default', () => {
    const scope = scopeWith({});
    expect(() => interpolate('{{nope}}', scope)).toThrow(MissingVariableError);
  });

  it('can keep or blank unknown variables instead', () => {
    const scope = scopeWith({});

    expect(interpolate('{{nope}}', scope, { onMissing: 'keep' })).toBe('{{nope}}');
    expect(interpolate('{{nope}}', scope, { onMissing: 'empty' })).toBe('');
  });

  it('reads environment variables through the env: prefix', () => {
    process.env.FLOWCASE_TEST_SECRET = 'shh';
    expect(interpolate('{{env:FLOWCASE_TEST_SECRET}}', scopeWith({}))).toBe('shh');
    delete process.env.FLOWCASE_TEST_SECRET;
  });

  it('generates values', () => {
    const scope = scopeWith({});

    expect(interpolate('{{$uuid}}', scope)).toMatch(/^[0-9a-f-]{36}$/);
    expect(interpolate('{{$date}}', scope)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(interpolate('{{$randomString(6)}}', scope)).toHaveLength(6);
    expect(interpolate('{{$randomEmail}}', scope)).toContain('@');

    const number = Number(interpolate('{{$randomInt(5,7)}}', scope));
    expect(number).toBeGreaterThanOrEqual(5);
    expect(number).toBeLessThanOrEqual(7);
  });

  it('keeps the real type when the template is exactly one placeholder', () => {
    const scope = scopeWith({ count: 3, row: { a: 1 } });

    expect(resolveTyped('{{count}}', scope)).toBe(3);
    expect(resolveTyped('{{row}}', scope)).toEqual({ a: 1 });
    expect(resolveTyped('n={{count}}', scope)).toBe('n=3');
  });

  it('lists the variables a template depends on', () => {
    expect(collectVariableNames('{{a}} and {{b.c}} and {{$uuid}} and {{env:X}}')).toEqual(['a', 'b']);
  });

  it('leaves text without placeholders untouched', () => {
    expect(interpolate('plain text', scopeWith({}))).toBe('plain text');
  });
});

describe('path helpers', () => {
  it('splits dotted and bracketed paths', () => {
    expect(splitPath('a.b[0].c')).toEqual(['a', 'b', '0', 'c']);
  });

  it('reads a value at a path', () => {
    expect(readPath({ a: { b: [{ c: 42 }] } }, ['a', 'b', '0', 'c'])).toBe(42);
    expect(readPath({ a: 1 }, ['missing'])).toBeUndefined();
  });
});

describe('VariableScope', () => {
  it('reads through to the parent but writes locally', () => {
    const parent = VariableScope.fromObject({ shared: 'yes' });
    const child = parent.child();

    child.set('local', 'only-here');

    expect(child.get('shared')).toBe('yes');
    expect(child.get('local')).toBe('only-here');
    expect(parent.get('local')).toBeUndefined();
  });

  it('shadows a parent value without changing it', () => {
    const parent = VariableScope.fromObject({ name: 'parent' });
    const child = parent.child();

    child.set('name', 'child');

    expect(child.get('name')).toBe('child');
    expect(parent.get('name')).toBe('parent');
  });

  it('writes run-scoped values to the outermost scope', () => {
    const root = VariableScope.fromObject({});
    const nested = root.child().child();

    nested.setRunScoped('orderId', '42');

    expect(root.get('orderId')).toBe('42');
  });

  it('flattens the chain nearest-layer-first', () => {
    const parent = VariableScope.fromObject({ a: 1, b: 2 });
    const child = parent.child();
    child.set('b', 3);

    expect(child.toObject()).toEqual({ a: 1, b: 3 });
  });
});
