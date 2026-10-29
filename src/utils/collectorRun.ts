import { randomUUID } from 'node:crypto';
import { callDataService, DataServiceError } from '../db/client';
import { config } from '../config';
import { WeiboRequestError } from '../producers/weibo/response';
import { downloadStorageState, resolveStorageStatePath } from './storageState';
import { log } from './log';

type Summary = {
    processedSources: number; processedPosts: number; completedPosts: number; failedPosts: number;
    deferredPosts: number; uploadedMedia: number; skippedMedia: number; failedMedia: number;
};
type Status = 'completed' | 'partial' | 'bounded' | 'failed' | 'interrupted';
class CredentialUnavailableError extends Error {}
let active: CollectorRun | undefined;

export class CollectorRun {
    readonly id = randomUUID();
    summary: Summary = { processedSources: 0, processedPosts: 0, completedPosts: 0, failedPosts: 0, deferredPosts: 0, uploadedMedia: 0, skippedMedia: 0, failedMedia: 0 };
    credentialVersion: string | null = null;
    loginStatus: 'pending' | 'verified' | 'rejected' = 'pending';
    interrupted = false;
    private timer?: ReturnType<typeof setInterval>;
    private pending: Promise<unknown> = Promise.resolve();

    async start(kind: 'producer' | 'consumer') {
        await callDataService('spider/runStart', {
            id: this.id, kind, githubRunId: process.env.GITHUB_RUN_ID ?? null,
            githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT ? Number(process.env.GITHUB_RUN_ATTEMPT) : null,
        });
        active = this;
        this.timer = setInterval(() => {
            void this.flush().catch(() => log('任务心跳保存失败，下次心跳将重试', 'warn'));
        }, 60_000);
        this.timer.unref();
    }
    flush(status: 'running' | Status = 'running', errorCode: string | null = null) {
        const snapshot = { id: this.id, status, credentialVersion: this.credentialVersion, loginStatus: this.loginStatus, summary: { ...this.summary }, errorCode };
        this.pending = this.pending.catch(() => {}).then(() => callDataService('spider/runUpdate', snapshot));
        return this.pending;
    }
    async finish(status: Status, error?: unknown) {
        clearInterval(this.timer);
        active = undefined;
        const code = error instanceof WeiboRequestError ? error.code
            : error instanceof CredentialUnavailableError ? 'credential_unavailable'
            : error instanceof DataServiceError ? 'data_service_error'
            : status === 'interrupted' ? 'interrupted' : error ? 'runtime_error' : null;
        if (code === 'weibo_login_required' || code === 'weibo_request_blocked') this.loginStatus = 'rejected';
        await this.flush(status, code);
    }
}

export async function startCollectorRun(kind: 'producer' | 'consumer') {
    if (!config.shouldWriteDB) return undefined;
    const run = new CollectorRun();
    await run.start(kind);
    return run;
}
export async function prepareRunCredentials(run?: CollectorRun) {
    let version: string | undefined;
    try {
        // CI must fetch the current version even when checkout contains an old file.
        if (process.env.GITHUB_ACTIONS === 'true' || process.env.WEIBO_CREDENTIALS_URL) {
            version = (await downloadStorageState()).version;
        } else if (!config.useTestData) await resolveStorageStatePath();
    } catch { throw new CredentialUnavailableError('登录态读取失败，请检查后台登录态与读取配置'); }
    if (run && version) { run.credentialVersion = version; await run.flush(); }
}
export function assertCollectorRunning() { if (active?.interrupted) throw new Error('采集已中断'); }
export function recordProcessedPost() { if (active) active.summary.processedPosts++; }
export function recordFailedPost() { if (active) active.summary.failedPosts++; }
export function recordProcessedSource() { if (active) active.summary.processedSources++; }
export function recordConsumerSummary(summary: Omit<Summary, 'processedSources' | 'processedPosts'>) {
    if (active) {
        for (const key of ['completedPosts', 'failedPosts', 'deferredPosts', 'uploadedMedia', 'skippedMedia', 'failedMedia'] as const) active.summary[key] = summary[key];
        active.summary.processedPosts = summary.completedPosts + summary.failedPosts + summary.deferredPosts;
    }
}
export function recordWeiboAccess() { if (active) active.loginStatus = 'verified'; }
