import 'dotenv/config';
import superjson from 'superjson';
import { log } from '../utils/log';
import { retryRequest } from '../utils';

// Only operations verified to be read-only or replay-safe may be repeated.
// claimPostOnce is a distinct endpoint: an old Worker must fail closed instead
// of ignoring a request ID and silently allocating a different post on retry.
const RETRY_SAFE_OPERATIONS = new Set([
    'spider/producers', 'spider/producer', 'spider/uploadedMedia',
    'spider/pendingCount', 'spider/remainingUploadCount', 'spider/uploadMedia',
    'spider/claimPostOnce', 'spider/saveMedia',
]);
const TRANSIENT_NETWORK_CODES = new Set([
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
]);

function transientNetworkError(error: unknown, depth = 0): boolean {
    if (!(error instanceof Error) || depth >= 5) return false;
    const code = (error as Error & { code?: string }).code;
    return error.name === 'TimeoutError' || (code !== undefined && TRANSIENT_NETWORK_CODES.has(code)) ||
        transientNetworkError(error.cause, depth + 1) ||
        (error instanceof AggregateError && error.errors.some(cause => transientNetworkError(cause, depth + 1)));
}

// Reuse the existing logger and native Error fields. Do not inspect arbitrary error
// properties: request headers, payloads and response bodies may contain credentials.
function dataServiceErrorDetails(error: unknown, depth = 0): unknown {
    if (depth >= 5) return '[error chain truncated]';
    if (!(error instanceof Error)) return typeof error === 'string' ? error : '[non-Error rejection]';
    const networkError = error as Error & {
        code?: string; errno?: string | number; syscall?: string;
        hostname?: string; address?: string; port?: number;
    };
    return {
        name: error.name, message: error.message, stack: error.stack,
        code: networkError.code, errno: networkError.errno, syscall: networkError.syscall,
        hostname: networkError.hostname, address: networkError.address, port: networkError.port,
        cause: error.cause === undefined ? undefined : dataServiceErrorDetails(error.cause, depth + 1),
        errors: error instanceof AggregateError
            ? error.errors.slice(0, 5).map(cause => dataServiceErrorDetails(cause, depth + 1)) : undefined,
    };
}

export class DataServiceError extends Error {
    constructor(public readonly code: string, message: string) {
        super(message);
        this.name = `DataServiceError(${code})`;
    }
}

export async function callDataService<T>(operation: string, input: unknown, options: { signal?: AbortSignal } = {}): Promise<T> {
    const base = process.env.DATA_SERVICE_URL;
    const token = process.env.DATA_SERVICE_TOKEN;
    if (!base || !token) throw new Error('DATA_SERVICE_URL and DATA_SERVICE_TOKEN are required');
    const url = new URL(base);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Data service requires HTTPS or loopback HTTP');
    url.pathname = `${url.pathname.replace(/\/$/, '')}/v1/${operation}`;
    const requestBody = superjson.stringify(input);
    let attempt = 0;
    let willRetry = false;
    return retryRequest(async () => {
        attempt++;
        willRetry = false;
        const startedAt = Date.now();
        const timeout = AbortSignal.timeout(30_000);
        let response: Response | undefined;
        let phase = 'request';
        try {
            response = await fetch(url, {
                method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                body: requestBody, redirect: 'error',
                signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
            });
            phase = 'response';
            if (!response.headers.get('content-type')?.includes('application/json')) throw new DataServiceError('SERVICE_UNAVAILABLE', `Data service HTTP ${response.status}`);
            phase = 'read-body';
            const body = await response.text();
            phase = 'parse-body';
            const result = superjson.parse<{ result: T } | { error: { code: string; message: string } }>(body);
            phase = 'service-result';
            if ('error' in result) throw new DataServiceError(result.error.code, result.error.message);
            if (!response.ok) throw new DataServiceError('SERVICE_UNAVAILABLE', `Data service HTTP ${response.status}`);
            return result.result;
        } catch (error) {
            const transientHttp = response && [429, 500, 502, 503, 504, 520, 521, 522, 523, 524].includes(response.status) &&
                !(error instanceof DataServiceError && error.code === 'READ_ONLY');
            willRetry = RETRY_SAFE_OPERATIONS.has(operation) && attempt < 3 && !options.signal?.aborted &&
                Boolean(transientHttp || transientNetworkError(error) || timeout.aborted);
            try {
                let diagnostic = JSON.stringify({
                    operation, method: 'POST', serviceHost: url.host, phase,
                    attempt, maxAttempts: RETRY_SAFE_OPERATIONS.has(operation) ? 3 : 1,
                    willRetry, retryDelayMs: willRetry ? attempt * 1000 : null,
                    elapsedMs: Date.now() - startedAt,
                    status: response?.status ?? null,
                    contentType: response?.headers.get('content-type'),
                    requestId: response?.headers.get('x-request-id'),
                    cfRay: response?.headers.get('cf-ray'),
                    // JSON parse errors can quote part of the response body in their message.
                    error: phase === 'parse-body' && error instanceof SyntaxError
                        ? { name: error.name, message: 'Invalid data service JSON response' }
                        : dataServiceErrorDetails(error),
                }, null, 2);
                // Never emit configured secrets or full URLs, including signed query strings.
                const secrets = [base, token, ...Object.entries(process.env)
                    .filter(([key]) => /TOKEN|SECRET|PASSWORD|COOKIE|AUTHORIZATION|API_KEY/i.test(key))
                    .map(([, value]) => value)].filter((value): value is string => Boolean(value));
                for (const secret of secrets.sort((a, b) => b.length - a.length)) {
                    diagnostic = diagnostic.split(secret).join('[redacted]');
                    const escaped = JSON.stringify(secret).slice(1, -1);
                    diagnostic = diagnostic.split(escaped).join('[redacted]');
                }
                diagnostic = diagnostic.replace(/https?:\/\/[^\s"<>]+/gi, '[redacted-url]')
                    .replace(/Bearer\s+[^\s"<>]+/gi, 'Bearer [redacted]');
                log(`数据服务请求失败:\n${diagnostic}`, willRetry ? 'warn' : 'error');
            } catch {
                log('数据服务请求失败（诊断信息生成失败）', 'error');
            }
            throw error;
        }
    }, 3, { signal: options.signal, shouldRetry: () => willRetry });
}
