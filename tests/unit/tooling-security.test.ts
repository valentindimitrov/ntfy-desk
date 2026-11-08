import { createRequire } from 'node:module';
import { expect, it } from 'vitest';

it('blocks prototype poisoning in the deepmerge instance used by the Firefox linter', () => {
  const requireFromWebExt = createRequire(import.meta.resolve('web-ext'));
  const requireFromLinter = createRequire(requireFromWebExt.resolve('addons-linter'));
  const merge = requireFromLinter('deepmerge') as (target: object, source: object) => object;
  const payload = Object.defineProperty({ safe: true }, '__proto__', { enumerable: true, value: { poisoned: true } });
  const nullPrototypeTarget: object = Object.create(null) as object;

  for (const output of [merge(payload, {}), merge(nullPrototypeTarget, payload)]) {
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
    expect(output).toEqual({ safe: true });
    expect(output).not.toHaveProperty('poisoned');
  }
});
