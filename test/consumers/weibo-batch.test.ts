import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UploadStatus } from '@prisma/client';

const mocks = vi.hoisted(() => ({
    createPage: vi.fn(), cleanup: vi.fn(), claimNextPost: vi.fn(),
    recoverStalePosts: vi.fn(), updatePostStatus: vi.fn(),
    getUploadedMedias: vi.fn(), saveMedias: vi.fn(), uploadToGallery: vi.fn(),
}));
vi.mock('../../src/browser', () => ({ browserManager: mocks }));
vi.mock('../../src/db/post', () => mocks);
vi.mock('../../src/db/media', () => mocks);
vi.mock('../../src/utils/upload', () => ({ uploadToGallery: mocks.uploadToGallery }));

import { runWeiboPostConsumer } from '../../src/consumer/Weibo/weiboPostConsumer';

const post = { id: 'post-1', platformId: '123', userId: 'user', producerId: 'producer', createTime: new Date(0) };
const image = (name: string) => ({ url: `https://wx1.sinaimg.cn/${name}.jpg` });

beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T00:00:00Z'));
    mocks.createPage.mockResolvedValue({
        goto: vi.fn().mockResolvedValue({ status: () => 200 }),
        url: () => 'https://m.weibo.cn/detail/123',
        evaluate: vi.fn().mockResolvedValue({ status: { pics: [image('first'), image('second')] } }),
        close: vi.fn().mockResolvedValue(undefined), isClosed: () => false,
    });
    mocks.claimNextPost.mockResolvedValueOnce(post).mockResolvedValue(null);
    mocks.getUploadedMedias.mockResolvedValue([]);
    mocks.recoverStalePosts.mockResolvedValue(0);
    mocks.saveMedias.mockResolvedValue(1);
});

afterEach(() => { vi.useRealTimers(); });

describe('consumer batch recovery', () => {
    // 线上曾将 { galleryUrl: null } 当作成功，并把部分失败帖子标为 UPLOADED。
    it('persists only successful media with the correct source and leaves partial failures retryable', async () => {
        mocks.uploadToGallery.mockResolvedValueOnce({ galleryUrl: null, thumbnailUrl: null })
            .mockResolvedValueOnce({ galleryUrl: 'https://gallery/second', thumbnailUrl: null });

        await runWeiboPostConsumer();

        expect(mocks.saveMedias.mock.calls.flatMap(([medias]) => medias)).toEqual([
            expect.objectContaining({ originMediaUrl: image('second').url, galleryMediaUrl: 'https://gallery/second' }),
        ]);
        expect(mocks.updatePostStatus).toHaveBeenLastCalledWith(post.id, UploadStatus.FAILED);
    });

    it('finishes the current post after the claim cutoff without claiming another', async () => {
        mocks.uploadToGallery.mockImplementation(async () => {
            await new Promise(resolve => setTimeout(resolve, 450));
            return { galleryUrl: 'https://gallery/file', thumbnailUrl: null };
        });
        const batch = runWeiboPostConsumer({ maxRuntimeMs: 1000, shutdownReserveMs: 200, maxPostRuntimeMs: 1000 });
        await vi.advanceTimersByTimeAsync(900);
        const summary = await batch;
        expect(summary).toMatchObject({ completedPosts: 1, stopReason: 'budget' });
        expect(mocks.claimNextPost).toHaveBeenCalledTimes(1);
        expect(mocks.updatePostStatus).toHaveBeenLastCalledWith(post.id, UploadStatus.UPLOADED);
    });

    it('cancels in-flight work at the hard deadline while preserving earlier media', async () => {
        mocks.uploadToGallery.mockResolvedValueOnce({ galleryUrl: 'https://gallery/first', thumbnailUrl: null })
            .mockImplementationOnce((_media, _headers, { signal }) => new Promise(resolve => {
                signal.addEventListener('abort', () => resolve({ galleryUrl: null, thumbnailUrl: null }), { once: true });
            }));
        const batch = runWeiboPostConsumer({ maxRuntimeMs: 1000, shutdownReserveMs: 200, maxPostRuntimeMs: 2000 });
        await vi.advanceTimersByTimeAsync(1000);
        expect(await batch).toMatchObject({ uploadedMedia: 1, deferredPosts: 1, stopReason: 'budget' });
        expect(mocks.saveMedias.mock.calls.flatMap(([medias]) => medias)).toEqual([
            expect.objectContaining({ originMediaUrl: image('first').url }),
        ]);
        expect(mocks.updatePostStatus).toHaveBeenLastCalledWith(post.id, UploadStatus.FAILED);
    });

    it('resumes using persisted progress despite changed CDN signatures and ignores invalid legacy records', async () => {
        mocks.getUploadedMedias.mockResolvedValue([
            { originMediaUrl: `${image('first').url}?Expires=old&ssig=old`, galleryMediaUrl: 'https://gallery/first' },
            { originMediaUrl: image('second').url, galleryMediaUrl: null },
        ]);
        mocks.uploadToGallery.mockResolvedValue({ galleryUrl: 'https://gallery/second', thumbnailUrl: null });
        expect(await runWeiboPostConsumer()).toMatchObject({ skippedMedia: 1, uploadedMedia: 1, completedPosts: 1 });
        expect(mocks.uploadToGallery).toHaveBeenCalledTimes(1);
        expect(mocks.uploadToGallery.mock.calls[0][0].originMediaUrl).toBe(image('second').url);
    });

    it('continues to the next post after an individual post times out', async () => {
        mocks.claimNextPost.mockReset().mockResolvedValueOnce(post)
            .mockResolvedValueOnce({ ...post, id: 'post-2', platformId: '456' }).mockResolvedValue(null);
        mocks.uploadToGallery.mockImplementationOnce((_media, _headers, { signal }) => new Promise(resolve => {
            signal.addEventListener('abort', () => resolve({ galleryUrl: null, thumbnailUrl: null }), { once: true });
        })).mockResolvedValue({ galleryUrl: 'https://gallery/file', thumbnailUrl: null });
        const batch = runWeiboPostConsumer({ maxRuntimeMs: 1000, shutdownReserveMs: 200, maxPostRuntimeMs: 100 });
        await vi.advanceTimersByTimeAsync(100);
        expect(await batch).toMatchObject({ completedPosts: 1, deferredPosts: 1, stopReason: 'queue-empty' });
        expect(mocks.updatePostStatus).toHaveBeenLastCalledWith('post-2', UploadStatus.UPLOADED);
    });

    it('propagates database failures instead of marking a post uploaded', async () => {
        const error = new Error('database connection lost');
        mocks.uploadToGallery.mockResolvedValue({ galleryUrl: 'https://gallery/file', thumbnailUrl: null });
        mocks.saveMedias.mockRejectedValue(error);
        await expect(runWeiboPostConsumer()).rejects.toBe(error);
        expect(mocks.updatePostStatus).not.toHaveBeenCalledWith(post.id, UploadStatus.UPLOADED);
        expect(mocks.cleanup).toHaveBeenCalled();
    });

    it('does not hide a database failure behind simultaneous batch cancellation', async () => {
        const controller = new AbortController();
        const error = new Error('database write failed');
        mocks.uploadToGallery.mockResolvedValue({ galleryUrl: 'https://gallery/file', thumbnailUrl: null });
        mocks.saveMedias.mockImplementation(async () => { controller.abort(); throw error; });
        await expect(runWeiboPostConsumer({ signal: controller.signal })).rejects.toBe(error);
    });

    it('detects a login page even when Weibo returns HTTP 200 at the original URL', async () => {
        const page = await mocks.createPage();
        page.evaluate.mockResolvedValueOnce(undefined).mockResolvedValueOnce('请先登录后查看微博');
        await expect(runWeiboPostConsumer()).rejects.toThrow('登录失效');
        expect(mocks.uploadToGallery).not.toHaveBeenCalled();
        expect(mocks.claimNextPost).toHaveBeenCalledTimes(1);
    });

    it('fails the batch when the gallery remains unavailable', async () => {
        const page = await mocks.createPage();
        page.evaluate.mockResolvedValue({ status: { pics: ['a', 'b', 'c', 'd', 'e', 'f'].map(image) } });
        mocks.uploadToGallery.mockResolvedValue({ galleryUrl: null, thumbnailUrl: null, failureKind: 'gallery' });
        await expect(runWeiboPostConsumer()).rejects.toThrow('图库连续');
        expect(mocks.updatePostStatus).toHaveBeenLastCalledWith(post.id, UploadStatus.FAILED);
        expect(mocks.saveMedias).not.toHaveBeenCalled();
    });
});
