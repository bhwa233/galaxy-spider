import 'dotenv/config';
import superjson from 'superjson';
import { log } from '../utils/log';

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

export async function callDataService<T>(operation: string, input: unknown): Promise<T> {
    const base = process.env.DATA_SERVICE_URL;
    const token = process.env.DATA_SERVICE_TOKEN;
    if (!base || !token) throw new Error('DATA_SERVICE_URL and DATA_SERVICE_TOKEN are required');
    const url = new URL(base);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Data service requires HTTPS or loopback HTTP');
    url.pathname = `${url.pathname.replace(/\/$/, '')}/v1/${operation}`;
    const startedAt = Date.now();
    let response: Response | undefined;
    let phase = 'request';
    try {
        response = await fetch(url, {
            method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: superjson.stringify(input), redirect: 'error', signal: AbortSignal.timeout(30_000),
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
        try {
            let diagnostic = JSON.stringify({
                operation, method: 'POST', serviceHost: url.host, phase,
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
            log(`数据服务请求失败:\n${diagnostic}`, 'error');
        } catch {
            log('数据服务请求失败（诊断信息生成失败）', 'error');
        }
        throw error;
    }
}
