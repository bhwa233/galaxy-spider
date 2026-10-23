import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UploadStatus } from '@prisma/client';

const mocks = vi.hoisted(() => ({
    createPage: vi.fn(), cleanup: vi.fn(), claimNextPost: vi.fn(),
    recoverStalePosts: vi.fn(), updatePostStatus: vi.fn(), uploadToGallery: vi.fn(),
    callDataService: vi.fn(),
}));
vi.mock('../../src/browser', () => ({ browserManager: mocks }));
vi.mock('../../src/db/post', () => mocks);
vi.mock('../../src/db/client', () => ({ callDataService: mocks.callDataService }));
vi.mock('../../src/utils/upload', () => ({ uploadToGallery: mocks.uploadToGallery }));

// 保留真实 getWeiboPost → runWeiboPostConsumer → saveMedias，避免在保存边界前截断测试。
import { runWeiboPostConsumer } from '../../src/consumer/Weibo/weiboPostConsumer';

const post = { id: 'post-1', platformId: '5121970012426917', userId: 'user', producerId: 'producer', createTime: new Date(0) };

beforeEach(() => {
    vi.resetAllMocks();
    mocks.claimNextPost.mockResolvedValueOnce(post).mockResolvedValue(null);
    mocks.recoverStalePosts.mockResolvedValue(0);
    mocks.callDataService.mockImplementation(async operation => operation === 'spider/uploadedMedia' ? [] : 1);
    mocks.uploadToGallery.mockResolvedValue({ galleryUrl: 'https://gallery.example/file.webp', thumbnailUrl: null });
    mocks.createPage.mockResolvedValue({
        goto: vi.fn().mockResolvedValue({ status: () => 200 }),
        url: () => `https://m.weibo.cn/detail/${post.platformId}`,
        evaluate: vi.fn().mockResolvedValue({ status: { pics: [{
            url: 'https://wx3.sinaimg.cn/image.jpg',
            large: { geo: { width: '1080', height: '1610' } },
        }] } }),
        isClosed: () => false,
        close: vi.fn().mockResolvedValue(undefined),
    });
});

afterEach(() => { vi.restoreAllMocks(); });

describe('Weibo media persistence', () => {
    // 2026-10-15 CI：上传成功后把字符串宽高传给 Prisma，导致 Int 校验失败。
    it('normalizes string dimensions before sending an uploaded media to D1', async () => {
        const summary = await runWeiboPostConsumer();
        expect(mocks.callDataService).toHaveBeenCalledWith('spider/saveMedia', [expect.objectContaining({ width: 1080, height: 1610 })]);
        expect(summary).toMatchObject({ completedPosts: 1, uploadedMedia: 1 });
        expect(mocks.updatePostStatus).toHaveBeenLastCalledWith(post.id, UploadStatus.UPLOADED);
    });

    it('persists unknown or invalid dimensions as null instead of failing an uploaded media', async () => {
        const page = await mocks.createPage();
        for (const dimensions of [
            { width: '', height: 'unknown' },
            { width: -1, height: 1.5 },
            { width: Infinity, height: 2_147_483_648 },
            {},
        ]) {
            mocks.claimNextPost.mockReset().mockResolvedValueOnce(post).mockResolvedValue(null);
            mocks.callDataService.mockClear();
            page.evaluate.mockResolvedValue({ status: { pics: [{
                url: 'https://wx3.sinaimg.cn/image.jpg', large: { geo: dimensions },
            }] } });
            expect(await runWeiboPostConsumer()).toMatchObject({ completedPosts: 1, uploadedMedia: 1 });
            expect(mocks.callDataService).toHaveBeenCalledWith('spider/saveMedia', [expect.objectContaining({ width: null, height: null })]);
        }
    });
});
