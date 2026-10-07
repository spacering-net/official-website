import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The execution context of the request being handled, for code deep inside
 * Better Auth (its database hooks) that wants to finish work after the
 * response has gone.
 */
const scope = new AsyncLocalStorage<ExecutionContext>();

export const withRequest = <T>(ctx: ExecutionContext, fn: () => T): T => scope.run(ctx, fn);

/** Let `work` finish after the response is sent; failures are logged, not thrown. */
export function later(work: Promise<unknown>) {
  const guarded = work.catch((err) => console.error('[api] background task failed', err));
  scope.getStore()?.waitUntil(guarded);
}
