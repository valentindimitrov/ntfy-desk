// The browser API types end with a callback overload returning void, which is the signature
// vi.spyOn infers. These helpers type the promise-returning form the code under test uses.

import { vi, type MockInstance } from 'vitest';

type AsyncFn = (...args: never[]) => Promise<unknown>;

/** Spy on an async browser API method and resolve it with value */
export function mockResolved<T extends object, K extends keyof T>(target: T, method: K, value: unknown): MockInstance<AsyncFn> {
  return (vi.spyOn(target, method as never) as unknown as MockInstance<AsyncFn>).mockResolvedValue(value);
}

/** Arguments of each call, typed for the assertions */
export function callsOf<A extends unknown[]>(spy: { mock: { calls: unknown[][] } }): A[] {
  return spy.mock.calls as A[];
}

/** Happy DOM has no Web Locks implementation. Preserve real per-name exclusivity in tests. */
export function mockWebLocks(): void {
  const queues = new Map<string, Promise<unknown>>();
  type Task<T> = (lock: Lock | null) => Promise<T>;
  const request = <T>(name: string, options: LockOptions | Task<T>, task?: Task<T>) => {
    const callback = typeof options === 'function' ? options : task!;
    const previous = queues.get(name);
    if (typeof options !== 'function' && options.ifAvailable && previous) return callback(null);
    const result = (previous ?? Promise.resolve()).then(() => callback({ name, mode: 'exclusive' }));
    const tail = result.catch(() => {});
    queues.set(name, tail);
    void tail.then(() => {
      if (queues.get(name) === tail) queues.delete(name);
    });
    return result;
  };
  vi.spyOn(navigator, 'locks', 'get').mockReturnValue({ request } as LockManager);
}
