import { UploadStatus } from '@prisma/client';
import { browserManager } from '../../browser';
import { getUploadedMedias, saveMedias } from '../../db/media';
import { claimNextPost, recoverStalePosts, updatePostStatus } from '../../db/post';
import { uploadToGallery } from '../../utils/upload';
import { log } from '../../utils/log';
import type { MediaInfo, WeiboData } from './types';
import type { Page } from 'playwright';
import { WeiboRequestError } from '../../producers/weibo/response';
import { recordConsumerSummary, recordWeiboAccess } from '../../utils/collectorRun';

class WeiboPostUnavailableError extends Error {}

function extractMedias(data: WeiboData, postUrl: string): MediaInfo[] {
    const medias: MediaInfo[] = [];
    if (data.status?.pics && !Array.isArray(data.status.pics)) {
        throw new Error('微博图片列表格式异常，保留帖子等待重试');
    }

    // 处理视频信息
    if (data.status?.page_info?.type === 'video') {
        const video = data.status.page_info;
        data.status.pics = Array.isArray(data.status.pics) ? data.status.pics : [];
        data.status.pics.push({
            pid: video.page_pic?.pid || '',
            url: video.page_pic?.url || '',
            size: 'video',
            geo: {
                width: parseInt(video.page_pic?.width) || 0,
                height: parseInt(video.page_pic?.height) || 0,
                croped: false
            },
            large: {
                size: 'video',
                url: video.page_pic?.url || '',
                geo: {
                    width: parseInt(video.page_pic?.width) || 0,
                    height: parseInt(video.page_pic?.height) || 0,
                    croped: false
                }
            },
            type: 'video',
            videoSrc: video.media_info?.stream_url_hd || video.media_info?.stream_url || Object.values(video.urls || {})[0]
        });
    }

    if (Array.isArray(data.status?.pics)) {
        data.status.pics.forEach((pic) => {
            // 微博会返回字符串宽高；类型断言不会转换运行时数据。
            // 用原生 Number 在解析边界转换，只向 Prisma 的 Int 字段传有效尺寸或 null。
            const width = Number(pic.videoSrc ? pic.geo?.width : (pic.large?.geo?.width ?? pic.geo?.width));
            const height = Number(pic.videoSrc ? pic.geo?.height : (pic.large?.geo?.height ?? pic.geo?.height));
            const dimensions = {
                width: Number.isInteger(width) && width > 0 && width <= 2_147_483_647 ? width : null,
                height: Number.isInteger(height) && height > 0 && height <= 2_147_483_647 ? height : null,
            };
            if (pic.videoSrc) {
                medias.push({
                    ...dimensions,
                    originMediaUrl: pic.videoSrc,
                    thumbnailUrl: pic.url || null,
                    originSrc: postUrl,
                    type: 'video'
                });
            } else {
                const imageUrl = pic.large?.url || pic.url;
                medias.push({
                    ...dimensions,
                    originMediaUrl: imageUrl,
                    thumbnailUrl: imageUrl,
                    originSrc: postUrl,
                    type: 'image'
                });
            }
        });
    }

    return medias;
}

/**
 * 获取微博帖子的渲染数据
 * @param id 微博帖子ID
 * @returns 微博帖子的渲染数据，如果获取失败则返回 null
 */
export const getWeiboPost = async (id: string, page: Page) => {
    try {
        const postUrl = `https://m.weibo.cn/detail/${id}`;
        let response;
        try {
            response = await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        } catch (error) {
            throw new WeiboPostUnavailableError(`访问微博失败: ${error}`);
        }
        if (response?.status() === 401 ||
            /passport\.|\/login(?:\.php)?|\/signin/i.test(page.url())) {
            throw new WeiboRequestError('微博登录失效，请刷新登录态', 'weibo_login_required');
        }
        if ([403, 418, 429, 432].includes(response?.status() || 0)) throw new WeiboRequestError('微博请求被拦截，请检查运行环境', 'weibo_request_blocked');
        if (response && response.status() >= 500) throw new WeiboPostUnavailableError(`微博服务暂时不可用，HTTP ${response.status()}`);

        // 提取 $render_data
        const renderData = await page.evaluate(() => {
            const data = (window as any).$render_data as WeiboData;
            return data;
        });

        if (!renderData?.status) {
            const pageText = await page.evaluate(() => document.body?.innerText || '');
            if (/扫码登录|扫描二维码|请先登录|登录后查看|安全验证|账号异常|帐号异常/.test(pageText)) {
                throw new WeiboRequestError('微博登录失效或需要验证，请刷新登录态并检查运行环境', 'weibo_login_required');
            }
            log(`无效的数据格式: ${id}`, 'error');
            return null;
        }

        recordWeiboAccess();
        const medias = extractMedias(renderData, postUrl);
        return { medias, postUrl };
    } catch (error) {
        if (error instanceof WeiboRequestError || error instanceof WeiboPostUnavailableError) throw error;
        log(`数据获取失败: ${id}: ${error}`, 'error');
        return null;
    }
};

export const CONSUMER_RUNTIME_MS = 4 * 60 * 60 * 1000;
const SHUTDOWN_RESERVE_MS = 15 * 60 * 1000;
const MAX_POST_RUNTIME_MS = 15 * 60 * 1000;
const SYSTEM_FAILURE_LIMIT = 5;

export interface ConsumerBatchOptions {
    maxRuntimeMs?: number;
    shutdownReserveMs?: number;
    maxPostRuntimeMs?: number;
    signal?: AbortSignal;
}

// 视频签名每次抓取都会变化；以实际文件路径识别已完成的同一媒体。
// URL 和 URLSearchParams 已足够处理微博地址，无需新增解析依赖。
function mediaKey(source: string): string {
    const url = new URL(source);
    const livephoto = url.searchParams.get('livephoto');
    return livephoto ? mediaKey(livephoto) : `${url.origin}${url.pathname}`;
}

export const runWeiboPostConsumer = async (options: ConsumerBatchOptions = {}) => {
    const startedAt = new Date();
    const runtime = options.maxRuntimeMs ?? CONSUMER_RUNTIME_MS;
    const deadline = startedAt.getTime() + runtime;
    const claimDeadline = deadline - (options.shutdownReserveMs ?? SHUTDOWN_RESERVE_MS);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('本轮时间预算已用完')), runtime);
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    const summary = {
        completedPosts: 0, failedPosts: 0, deferredPosts: 0,
        uploadedMedia: 0, skippedMedia: 0, failedMedia: 0,
        stopReason: 'queue-empty' as 'queue-empty' | 'budget' | 'interrupted' | 'error',
    };
    let fetchFailures = 0;
    let galleryFailures = 0;
    let page: Page | undefined;
    log('🚀 微博帖子消费者启动：4 小时预算，最后 15 分钟收尾', 'info');

    try {
        // 保留额外 15 分钟，避免误回收仍在收尾的旧进程。
        const recovered = await recoverStalePosts(new Date(startedAt.getTime() - CONSUMER_RUNTIME_MS - SHUTDOWN_RESERVE_MS));
        log(`回收 ${recovered} 个中断任务`, 'info');

        while (!signal.aborted && Date.now() < claimDeadline) {
            let post: Awaited<ReturnType<typeof claimNextPost>>;
            try {
                post = await claimNextPost(startedAt, signal);
            } catch (error) {
                if (signal.aborted && (error === signal.reason ||
                    (error instanceof Error && error.name === 'AbortError' && error.cause === signal.reason))) break;
                throw error;
            }
            if (!post) break;
            if (signal.aborted || Date.now() >= claimDeadline) {
                await updatePostStatus(post.id, UploadStatus.FAILED);
                summary.deferredPosts++;
                break;
            }
            const postController = new AbortController();
            const postTimer = setTimeout(() => postController.abort(new Error('单帖处理超过时间限制')),
                Math.max(0, Math.min(options.maxPostRuntimeMs ?? MAX_POST_RUNTIME_MS, deadline - Date.now())));
            const postSignal = AbortSignal.any([signal, postController.signal]);
            let activePage: Page | undefined;
            const closePage = () => { void activePage?.close().catch(() => {}); };
            postSignal.addEventListener('abort', closePage, { once: true });
            log(`正在处理平台 ID: ${post.platformId}`, 'info');

            try {
                postSignal.throwIfAborted();
                if (!page || page.isClosed()) page = await browserManager.createPage();
                activePage = page;
                postSignal.throwIfAborted();
                const data = await getWeiboPost(post.platformId, page);
                postSignal.throwIfAborted();
                fetchFailures = 0;
                if (!data) {
                    await updatePostStatus(post.id, UploadStatus.FAILED);
                    summary.failedPosts++;
                    continue;
                }
                const uploaded = new Set((await getUploadedMedias(post.id))
                    .filter(media => media.originMediaUrl && media.galleryMediaUrl && URL.canParse(media.galleryMediaUrl) &&
                        /^https?:\/\//i.test(media.galleryMediaUrl))
                    .map(media => mediaKey(media.originMediaUrl!)));
                let failed = false;
                for (const media of data.medias) {
                    postSignal.throwIfAborted();
                    const key = mediaKey(media.originMediaUrl);
                    if (uploaded.has(key)) {
                        summary.skippedMedia++;
                        continue;
                    }
                    const result = await uploadToGallery(media, { Referer: 'https://weibo.com/' }, { signal: postSignal });
                    if (!result.galleryUrl || !URL.canParse(result.galleryUrl) || !/^https?:\/\//i.test(result.galleryUrl)) {
                        postSignal.throwIfAborted();
                        summary.failedMedia++;
                        failed = true;
                        if (result.failureKind === 'gallery') galleryFailures++;
                        if (galleryFailures >= SYSTEM_FAILURE_LIMIT) throw new Error('图库连续 5 次上传不可用，停止本轮消费');
                        log(`媒体上传失败，留待下轮重试: ${media.originMediaUrl}`, 'warn');
                        continue;
                    }
                    galleryFailures = 0;
                    // 每个媒体立即落库；超时、部分失败都保留已经完成的进度。
                    await saveMedias([{
                        galleryMediaUrl: result.galleryUrl, thumbnailUrl: result.thumbnailUrl,
                        originMediaUrl: media.originMediaUrl, originSrc: media.originSrc,
                        postId: post.id, userId: post.userId, producerId: post.producerId,
                        width: media.width, height: media.height, createTime: post.createTime,
                    }]);
                    uploaded.add(key);
                    summary.uploadedMedia++;
                }
                await updatePostStatus(post.id, failed ? UploadStatus.FAILED : UploadStatus.UPLOADED);
                if (failed) summary.failedPosts++;
                else summary.completedPosts++;
            } catch (error) {
                await updatePostStatus(post.id, UploadStatus.FAILED);
                if (postSignal.aborted && (error === postSignal.reason || error instanceof WeiboPostUnavailableError)) {
                    summary.deferredPosts++;
                    log(`帖子 ${post.platformId} 已保留进度，留待下轮继续`, 'info');
                } else if (error instanceof WeiboPostUnavailableError && ++fetchFailures < SYSTEM_FAILURE_LIMIT) {
                    summary.failedPosts++;
                    log(`微博暂时不可用，帖子 ${post.platformId} 留待下轮重试: ${error}`, 'warn');
                } else {
                    // 数据库错误、登录失效和持续图库故障必须让 CI 报红。
                    summary.failedPosts++;
                    throw error;
                }
            } finally {
                recordConsumerSummary(summary);
                clearTimeout(postTimer);
                postSignal.removeEventListener('abort', closePage);
                if (postSignal.aborted) await activePage?.close().catch(() => {});
            }
        }
        if (options.signal?.aborted) summary.stopReason = 'interrupted';
        else if (signal.aborted || Date.now() >= claimDeadline) summary.stopReason = 'budget';
        return summary;
    } catch (error) {
        summary.stopReason = 'error';
        throw error;
    } finally {
        recordConsumerSummary(summary);
        clearTimeout(timer);
        log(`本轮统计: ${JSON.stringify(summary)}`, 'info');
        await browserManager.cleanup();
    }
};
