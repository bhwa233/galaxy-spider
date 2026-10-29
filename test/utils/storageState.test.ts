import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { downloadStorageState, resolveStorageStatePath } from '../../src/utils/storageState';
import { prepareRunCredentials } from '../../src/utils/collectorRun';

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
    vi.stubEnv('WEIBO_CREDENTIALS_URL', 'https://collector.example/api/collector/weibo/credentials');
    vi.stubEnv('WEIBO_CREDENTIAL_READ_TOKEN', 'test-token');
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    fs.rmSync(directory, { recursive: true, force: true });
});

describe('CI 登录态加载', () => {
    // 旧文件可能随 checkout 存在；CI 必须拒绝沿用读取失败前的旧登录态。
    it('后台读取失败会拒绝继续爬取，即使本地有旧文件', async () => {
        fs.writeFileSync(statePath, JSON.stringify(state));
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })));
        await expect(prepareRunCredentials()).rejects.toThrow(/登录态读取失败/);
        expect(fs.readFileSync(statePath, 'utf8')).toBe(JSON.stringify(state));
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
            success: true, data: { version: '00000000-0000-4000-8000-000000000001', storageState: { cookies: [], origins: [] } }
        })));
        await expect(downloadStorageState()).rejects.toThrow(/weibo.com/);
        expect(fs.readFileSync(statePath, 'utf8')).toBe('old-state');
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
            success: true, data: { version: '00000000-0000-4000-8000-000000000001', storageState: state }
        })));
        expect((await downloadStorageState()).version).toBe('00000000-0000-4000-8000-000000000001');
        await expect(resolveStorageStatePath()).resolves.toBe(statePath);
    });
});
