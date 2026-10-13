import { type Producer, type Platform, ProducerType } from '@prisma/client';
import { type Page } from 'playwright';
import { sleep } from '../../utils';
import type { WeiboMblog } from './types';
import { log } from '../../utils/log';
import { createPost } from '../../db/post';
import type { PageResult } from './types';
import { getProducers, getProducerById, updateProducerLastPostTime } from '../../db/producer';
import { browserManager } from '../../browser';
import { config } from '../../config';
import { readWeiboResponse, WeiboRequestError } from './response';

// Constants
const API_CONFIG = {
    baseUrl: 'https://weibo.com/ajax/statuses/mymblog',
    delayMs: 3000,
    defaultMaxPages: 5,
    postedMaxPages: 5
} as const;

/**
 * 解析微博时间文本（中文格式）
 * 例如："今天 14:30"、"1小时前"、"01月12日 22:30"、"2023-12-25 10:00:00"、"2025-12-31 18:42:16 来自邱笛尔超话"
 */
function parseWeiboTime(timeText: string): Date {
    try {
        const now = new Date();
        
        // 移除多余空格
        timeText = timeText.trim();
        
        // 移除 "来自xxx" 后缀（微博来源信息）
        timeText = timeText.replace(/\s+来自.+$/, '');
        
        // 格式1: "X分钟前"
        const minutesMatch = timeText.match(/(\d+)分钟前/);
        if (minutesMatch) {
            const minutes = parseInt(minutesMatch[1]);
            return new Date(now.getTime() - minutes * 60 * 1000);
        }
        
        // 格式2: "X小时前"
        const hoursMatch = timeText.match(/(\d+)小时前/);
        if (hoursMatch) {
            const hours = parseInt(hoursMatch[1]);
            return new Date(now.getTime() - hours * 60 * 60 * 1000);
        }
        
        // 格式3: "今天 HH:MM"
        const todayMatch = timeText.match(/今天\s+(\d{1,2}):(\d{2})/);
        if (todayMatch) {
            const hour = parseInt(todayMatch[1]);
            const minute = parseInt(todayMatch[2]);
            const date = new Date(now);
            date.setHours(hour, minute, 0, 0);
            return date;
        }
        
        // 格式4: "MM月DD日 HH:MM" (今年)
        const thisYearMatch = timeText.match(/(\d{1,2})月(\d{1,2})日\s+(\d{1,2}):(\d{2})/);
        if (thisYearMatch) {
            const month = parseInt(thisYearMatch[1]) - 1; // 月份从0开始
            const day = parseInt(thisYearMatch[2]);
            const hour = parseInt(thisYearMatch[3]);
            const minute = parseInt(thisYearMatch[4]);
            const date = new Date(now.getFullYear(), month, day, hour, minute, 0, 0);
            return date;
        }
        
        // 格式5: 标准日期格式 "YYYY-MM-DD HH:MM:SS"
        const standardDate = new Date(timeText);
        if (!isNaN(standardDate.getTime())) {
            return standardDate;
        }
        
        // 无法解析，返回固定时间避免误更新
        log(`无法解析时间文本: "${timeText}"，使用时间 1970-01-01`, 'warn');
        return new Date(0);
        
    } catch (error) {
        log(`解析时间失败: ${error}，使用时间 1970-01-01`, 'error');
        return new Date(0);
    }
}

function hasMedia(mblog: WeiboMblog): boolean {
    // 检查是否有图片
    const hasImages = (mblog.pic_ids?.length > 0) || (mblog.pics && mblog.pics.length > 0);

    // 检查是否有视频
    const hasVideo =
        (mblog.page_info?.type === "video") ||
        (mblog?.pics?.some(pic => pic?.type === "video") ?? false);

    return hasImages || hasVideo;
}

function getRequestHeaders(userId: string) {
    return {
        accept: 'application/json, text/plain, */*',
        referer: `https://weibo.com/u/${userId}`,
        'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };
}

type WeiboMymblogResponse = {
    ok: number;
    data?: {
        list?: WeiboMblog[];
        total?: number;
    };
    error?: string;
};

const fetchPage = async (userId: string, pageNum: number, page: Page): Promise<PageResult> => {
    const url = `${API_CONFIG.baseUrl}?uid=${userId}&page=${pageNum}&feature=0`;
    log(`正在访问URL: ${url}`, 'info');

    const response = await page.request.get(url, {
        headers: getRequestHeaders(userId),
        timeout: 60000
    });

    const json = await readWeiboResponse<WeiboMymblogResponse>(response);
    if (json.ok !== 1 || !Array.isArray(json.data?.list)) {
        throw new WeiboRequestError('微博个人列表响应异常，未返回有效的 data.list');
    }

    const cards = json.data.list.map(item => ({
        ...item,
        pic_ids: item.pic_ids || [],
    })) as WeiboMblog[];

    const hasNextPage = cards.length > 0;
    return {
        cards,
        sinceId: hasNextPage ? String(pageNum + 1) : ''
    };
};

export const processPost = async (post: WeiboMblog, producer: Producer): Promise<number> => {
    try {
        if (!hasMedia(post) ){
            log(`帖子 ${post.id} 未包含媒体，跳过`, 'info');
            return 0;
        }
        
        if (!config.shouldWriteDB) {
            log(`${config.logPrefix} 发现有媒体的帖子: ${post.id}`, 'info');
            return 1;
        }
        
        // 使用 producer.producerId 作为 userId，因为从 HTML 解析的数据没有 user 信息
        const userId = post.user?.id?.toString() || producer.producerId || '';
        
        // 解析微博时间
        const createTime = parseWeiboTime(post.created_at);
        
        const createdPost = await createPost({
            platformId: String(post.id),
            platform: 'WEIBO' as Platform,
            userId: userId,
            producerId: producer.id,
            createTime: createTime
        });
        log(`创建帖子成功: ${post.id}`, 'info');
        return createdPost ? 1 : 0;
    } catch (error) {
        log(`处理微博帖子失败: ${error}`, 'error');
        return 0;
    }
};

export const processUserPost = async (producer: Producer, maxPages: number): Promise<number> => {
    if (!producer.producerId) {
        log(`Producer ${producer.id} missing producerId`, 'error');
        return 0;
    }

    const existingProducer = config.useTestData 
        ? producer 
        : await getProducerById(producer.id);
        
    if (!existingProducer) {
        log(`Producer ${producer.id} not found in database`, 'error');
        return 0;
    }

    // 如果有lastPostTime，则只爬取1页
    const actualMaxPages = existingProducer.lastPostTime ? Math.min(API_CONFIG.postedMaxPages, maxPages) : maxPages;
    if (existingProducer.lastPostTime) {
        log(`检测到lastPostTime，限制爬取页数为${actualMaxPages}页`, 'info');
    }

    // 创建 page 实例
    const page = await browserManager.createPage();
    
    try {
        let processedCount = 0;

        log(`开始获取用户 ${producer.name || producer.producerId} 的微博列表，计划获取 ${actualMaxPages} 页`, 'info');
        for (let pageNum = 1; pageNum <= actualMaxPages; pageNum++) {
            let pageRetryCount = 0;
            const maxPageRetry = 2;
            let pageSuccess = false;
            let currentPageCards: any[] = [];
            let currentPageHasNext = false;
            
            while (pageRetryCount < maxPageRetry && !pageSuccess) {
                try {
                    const retryInfo = pageRetryCount > 0 ? ` (重试 ${pageRetryCount}/${maxPageRetry - 1})` : '';
                    log(`[页面进度 ${pageNum}/${actualMaxPages}] 正在获取数据...${retryInfo}`, 'info');
                    const { cards, sinceId: hasNextPage } = await fetchPage(producer.producerId, pageNum, page);
                    log(`[页面进度 ${pageNum}/${actualMaxPages}] 获取成功，包含 ${cards.length} 条微博`, 'info');
                    
                    currentPageCards = cards;
                    currentPageHasNext = !!hasNextPage;
                    pageSuccess = true;
                    
                } catch (error) {
                    if (error instanceof WeiboRequestError) {
                        throw error;
                    } else {
                        log(`[页面进度 ${pageNum}/${actualMaxPages}] 获取失败 (非登录问题): ${error}`, 'error');
                        if (pageRetryCount === 0) {
                            log(`[页面进度 ${pageNum}/${actualMaxPages}] 等待 2 秒后重试...`, 'info');
                            await sleep(2000);
                        } else {
                            throw error;
                        }
                    }
                    
                    pageRetryCount++;
                }
            }
            
            // 处理成功获取的数据
            if (pageSuccess) {
                let pageProcessedCount = 0;
                for (let j = 0; j < currentPageCards.length; j++) {
                    const card = currentPageCards[j];
                    const result = await processPost(card, producer);
                    processedCount += result;
                    pageProcessedCount += result;
                    if (result) {
                        log(`[页面进度 ${pageNum}/${actualMaxPages}][微博进度 ${j + 1}/${currentPageCards.length}] 成功处理微博 ${card.id}`, 'info');
                    }
                }

                if (!currentPageHasNext) {
                    log(`没有更多数据，结束获取`, 'info');
                    break;
                }
                
                if (pageNum < actualMaxPages) {
                    await sleep(API_CONFIG.delayMs);
                }
            } else {
                log(`[页面进度 ${pageNum}/${actualMaxPages}] 该页面获取失败，继续处理下一页`, 'warn');
            }
        }

        log(`用户 ${producer.name || producer.producerId} 处理完成，共处理 ${processedCount} 条微博`, 'info');
        
        if (processedCount > 0 && !config.useTestData) {
            await updateProducerLastPostTime(producer.id);
            log(`已更新用户 ${producer.name || producer.producerId} 的lastPostTime`, 'info');
        }
        
        return processedCount;
    } finally {
        // 不需要在这里 cleanup，因为 browserManager 会复用 page
    }
};

export const processWeiboPerson = async (maxPages: number = API_CONFIG.defaultMaxPages): Promise<number> => {
    let totalProcessed = 0;
    
    const producers = config.useTestData 
        ? [
            {
                id: 'test-user-1',
                name: '测试用户',
                producerId: '5286960038',
                type: 'WEIBO_PERSONAL' as ProducerType,
                lastPostTime: null,
                createTime: new Date(),
                updateTime: new Date(),
                createdAt: new Date(),
                updatedAt: new Date(),
                deletedAt: null
            }
          ]
        : await getProducers(ProducerType.WEIBO_PERSONAL);
    
    log(`${config.logPrefix} 开始处理微博用户，共 ${producers.length} 个账号`, 'info');
    
    try {
        for (let i = 0; i < producers.length; i++) {
            const producer = producers[i];
            log(`[总进度 ${i + 1}/${producers.length}] 开始处理用户 ${producer.name || producer.producerId}`, 'info');
            const count = await processUserPost(producer, maxPages);
            totalProcessed += count;
            log(`[总进度 ${i + 1}/${producers.length}] 用户处理完成，成功处理 ${count} 条微博`, 'info');
            
            if (i < producers.length - 1) {
                log(`等待 ${API_CONFIG.delayMs}ms 后处理下一个用户...`, 'info');
                await sleep(API_CONFIG.delayMs);
            }
        }

        log(`所有用户处理完成，共处理 ${totalProcessed} 条微博`, 'info');
        return totalProcessed;
    } finally {
        // 清理浏览器资源
        await browserManager.cleanup();
    }
}; 
