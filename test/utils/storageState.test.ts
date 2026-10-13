import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { downloadGistStorageState, resolveStorageStatePath } from '../../src/utils/storageState';

let directory: string;
let statePath: string;
const state = {
    cookies: ['.weibo.com', '.weibo.cn'].map(domain => ({
        name: 'SUB', value: 'test-login-cookie', domain, path: '/', expires: -1
    })),
    origins: []
};

beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'galaxy-storage-'));
    statePath = path.join(directory, 'state.json');
    vi.stubEnv('STORAGE_STATE_PATH', statePath);
    vi.stubEnv('GIST_ID', 'test-gist');
    vi.stubEnv('GIST_TOKEN', 'test-token');
    vi.stubEnv('GIST_STORAGE_STATE_FILENAME', 'weibo.storage.json');
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    fs.rmSync(directory, { recursive: true, force: true });
});

describe('CI 登录态加载', () => {
    // 原 CI 忽略 Gist 下载失败，继续使用旧文件并报告成功。
    it('Gist 失败会拒绝继续爬取，即使本地有旧文件', async () => {
        fs.writeFileSync(statePath, JSON.stringify(state));
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })));
        await expect(downloadGistStorageState()).rejects.toThrow(/401/);
    });

    it('过期或只登录一个域名的文件不能用于爬取', async () => {
        fs.writeFileSync(statePath, JSON.stringify({ ...state, cookies: [state.cookies[0]] }));
        await expect(resolveStorageStatePath()).rejects.toThrow(/weibo.cn/);
        fs.writeFileSync(statePath, JSON.stringify({
            ...state, cookies: state.cookies.map(cookie => ({ ...cookie, expires: 1 }))
        }));
        await expect(resolveStorageStatePath()).rejects.toThrow(/weibo.com/);
    });

    it('下载内容校验通过才覆盖旧登录态', async () => {
        fs.writeFileSync(statePath, 'old-state');
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
            files: { 'weibo.storage.json': { content: '{bad-json' } }
        })));
        await expect(downloadGistStorageState()).rejects.toThrow(/JSON/);
        expect(fs.readFileSync(statePath, 'utf8')).toBe('old-state');
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
            files: { 'weibo.storage.json': { content: JSON.stringify(state) } }
        })));
        await downloadGistStorageState();
        await expect(resolveStorageStatePath()).resolves.toBe(statePath);
    });
});
