import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_STORAGE_STATE_PATH = 'weibo.storage.json';

export function validateStorageState(content: string): void {
    let parsed;
    try { parsed = JSON.parse(content); }
    catch { throw new Error('storageState 文件不是有效的 JSON'); }
    if (!parsed || !Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins)) {
        throw new Error('storageState 文件格式不正确（缺少 cookies/origins）');
    }
    for (const domain of ['weibo.com', 'weibo.cn']) {
        if (!parsed.cookies.some((cookie: any) => cookie && cookie.name === 'SUB' && typeof cookie.value === 'string' && cookie.value.length > 0 &&
            [domain, `.${domain}`].includes(cookie.domain) && cookie.path === '/' &&
            (cookie.expires === -1 || cookie.expires > Date.now() / 1000))) {
            throw new Error(`缺少 ${domain} 的有效登录 Cookie，请运行 pnpm storage:refresh 重新登录`);
        }
    }
}

export async function downloadStorageState(): Promise<{ path: string; version: string }> {
    const endpoint = process.env.WEIBO_CREDENTIALS_URL;
    const token = process.env.WEIBO_CREDENTIAL_READ_TOKEN;
    if (!endpoint || !token) throw new Error('缺少 WEIBO_CREDENTIALS_URL 或 WEIBO_CREDENTIAL_READ_TOKEN');
    const url = new URL(endpoint);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) || url.username || url.password || url.search || url.hash) {
        throw new Error('登录态接口必须使用 HTTPS 或本机 HTTP，且不能在 URL 中携带凭证');
    }
    const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        redirect: 'error', signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`登录态读取失败，HTTP ${response.status}`);
    const text = await response.text();
    if (Buffer.byteLength(text) > 300 * 1024) throw new Error('登录态接口响应过大');
    let payload;
    try { payload = JSON.parse(text); }
    catch { throw new Error('登录态接口未返回有效 JSON'); }
    const { storageState, version } = payload?.data ?? {};
    if (payload?.success !== true || typeof version !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(version)) {
        throw new Error('登录态接口响应格式错误');
    }
    const content = JSON.stringify(storageState);
    validateStorageState(content);
    const resolvedPath = path.resolve(process.env.STORAGE_STATE_PATH || DEFAULT_STORAGE_STATE_PATH);
    const temporary = `${resolvedPath}.${randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(temporary, resolvedPath);
    } finally { fs.rmSync(temporary, { force: true }); }
    return { path: resolvedPath, version };
}

export async function resolveStorageStatePath(): Promise<string> {
    const resolvedPath = path.resolve(process.env.STORAGE_STATE_PATH || DEFAULT_STORAGE_STATE_PATH);
    if (fs.existsSync(resolvedPath)) {
        validateStorageState(fs.readFileSync(resolvedPath, 'utf8'));
        return resolvedPath;
    }
    return (await downloadStorageState()).path;
}
