import { setTimeout as delay } from 'node:timers/promises';

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const MAX_RETRY_ATTEMPTS = 3;
export async function retryRequest<T>(
    fn: () => Promise<T>,
    retryCount = MAX_RETRY_ATTEMPTS,
    options: { signal?: AbortSignal; shouldRetry?: (error: unknown) => boolean } = {},
): Promise<T> {
    for (let i = 0; i < retryCount; i++) {
        options.signal?.throwIfAborted();
        try {
            return await fn();
        } catch (error) {
            if (i === retryCount - 1 || options.signal?.aborted || options.shouldRetry?.(error) === false) throw error;
            await delay(1000 * (i + 1), undefined, { signal: options.signal });
        }
    }
    throw new Error('Retry failed');
}
