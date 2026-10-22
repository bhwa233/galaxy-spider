import 'dotenv/config';
import superjson from 'superjson';

export class DataServiceError extends Error {
    constructor(public readonly code: string, message: string) {
        super(message);
        this.name = `DataServiceError(${code})`;
    }
}

export async function callDataService<T>(operation: string, input: unknown): Promise<T> {
    const base = process.env.DATA_SERVICE_URL;
    const token = process.env.DATA_SERVICE_TOKEN;
    if (!base || !token) throw new Error('DATA_SERVICE_URL and DATA_SERVICE_TOKEN are required');
    const url = new URL(base);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Data service requires HTTPS or loopback HTTP');
    url.pathname = `${url.pathname.replace(/\/$/, '')}/v1/${operation}`;
    const response = await fetch(url, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: superjson.stringify(input), redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    if (!response.headers.get('content-type')?.includes('application/json')) throw new DataServiceError('SERVICE_UNAVAILABLE', `Data service HTTP ${response.status}`);
    const result = superjson.parse<{ result: T } | { error: { code: string; message: string } }>(await response.text());
    if ('error' in result) throw new DataServiceError(result.error.code, result.error.message);
    if (!response.ok) throw new DataServiceError('SERVICE_UNAVAILABLE', `Data service HTTP ${response.status}`);
    return result.result;
}
