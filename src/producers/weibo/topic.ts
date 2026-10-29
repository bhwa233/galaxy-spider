import { ProducerType, type Producer } from '@prisma/client';
import { sleep } from '../../utils';
import { log } from '../../utils/log';
import { getProducers, updateProducerLastPostTime } from '../../db/producer';
import { processPost } from './person';
import type { Card, WeiboTopicResponse } from './types';
import { browserManager } from '../../browser';
import { config } from '../../config';
import { readWeiboResponse, WeiboRequestError } from './response';
import { recordProcessedSource, recordWeiboAccess, assertCollectorRunning } from '../../utils/collectorRun';

//Constants
const API_CONFIG = {
    baseUrl: 'https://m.weibo.cn/api/container/getIndex',
    headers: {
        "accept": "application/json, text/plain, */*",
    },
    delayMs: 3000,
    defaultMaxPages: 20,
    postedMaxPages: 5
} as const;

// 递归提取所有 card_type 为 9 的卡片
function extractType9Cards(data: Card[]): Card[] {
    const type9Cards: Card[] = [];

    // Start processing directly with the input array
    function processCards(cards: Card[]) {
        cards.forEach(card => {
            if (String(card.card_type) === '9') {
                type9Cards.push(card);
            }

            if (card.card_group && Array.isArray(card.card_group)) {
                processCards(card.card_group);
            }
        });
    }

    // Process the input array directly
    processCards(data);

    return type9Cards;
}
export const processTopicPost = async (producer: Producer, maxPages: number): Promise<number> => {
    if (!producer.producerId) {
        log(`生产者 ${producer.name} 未找到话题ID，跳过`, 'warn');
        return 0;
    }

    // 如果有lastPostTime，则只爬取5页
    const actualMaxPages = producer.lastPostTime ? Math.min(API_CONFIG.postedMaxPages, maxPages) : maxPages;
    if (producer.lastPostTime) {
        log(`检测到lastPostTime，限制爬取页数为${API_CONFIG.postedMaxPages}页`, 'info');
    }

    // 创建 page 实例
    const page = await browserManager.createPage();
    
    try {
        log(`开始处理话题 ${producer.name || producer.producerId}，计划获取 ${actualMaxPages} 页`, 'info');
        let totalProcessed = 0;
        let sinceId: number | undefined;

        for (let pageNum = 0; pageNum < actualMaxPages; pageNum++) {
            assertCollectorRunning();
            let pageRetryCount = 0;
            const maxPageRetry = 2; // 每个页面最多重试 2 次
            let pageSuccess = false;
            
            while (pageRetryCount < maxPageRetry && !pageSuccess) {
                try {
                    const retryInfo = pageRetryCount > 0 ? ` (重试 ${pageRetryCount}/${maxPageRetry - 1})` : '';
                    log(`[页面进度 ${pageNum + 1}/${actualMaxPages}] 正在获取数据...${retryInfo}`, 'info');
                    
                    const params = new URLSearchParams({
                        containerid: producer.producerId,
                        ...(sinceId && { since_id: sinceId.toString() })
                    });

                    const url = `${API_CONFIG.baseUrl}?${params.toString()}`;
                    log(`正在访问URL: ${url}`, 'info');
                    const httpResponse = await page.goto(url, {
                        waitUntil: 'domcontentloaded',
                        timeout: 60000 
                    });
                    if (!httpResponse) {
                        throw new Error('微博话题请求没有返回响应');
                    }

                    const response = await readWeiboResponse<WeiboTopicResponse>(httpResponse);
                    if (response.ok !== 1 || !Array.isArray(response.data?.cards)) {
                        throw new WeiboRequestError('微博话题响应异常，未返回有效的 data.cards');
                    }
                    recordWeiboAccess();
                    if (!response.data.cards.length) {
                        log(`[页面进度 ${pageNum + 1}/${actualMaxPages}] 没有更多数据，结束获取`, 'info');
                        pageSuccess = true;
                        sinceId = undefined;
                        break;
                    }

                    sinceId = response.data.pageInfo?.since_id ?? response.data.cardlistInfo?.since_id;
                    const validCards = extractType9Cards(response.data.cards);

                    if (!validCards.length) {
                        log(`[页面进度 ${pageNum + 1}/${actualMaxPages}] 未找到有效帖子，继续下一页`, 'info');
                        pageSuccess = true;
                        break;
                    }

                    log(`[页面进度 ${pageNum + 1}/${actualMaxPages}] 获取成功，找到 ${validCards.length} 条帖子`, 'info');

                    for (let i = 0; i < validCards.length; i++) {
                        const card = validCards[i];
                        const count = await processPost(card.mblog, producer);
                        if (count > 0) {
                            log(`[页面进度 ${pageNum + 1}/${actualMaxPages}][帖子进度 ${i + 1}/${validCards.length}] 成功处理帖子 ${card.mblog.id}`, 'info');
                        }
                        totalProcessed += count;
                    }

                    if (!sinceId) {
                        log(`[页面进度 ${pageNum + 1}/${actualMaxPages}] 没有更多数据，结束获取`, 'info');
                    }
                    
                    pageSuccess = true;

                } catch (error) {
                    if (error instanceof WeiboRequestError) {
                        throw error;
                    } else {
                        log(`[页面进度 ${pageNum + 1}/${actualMaxPages}] 获取失败 (非登录问题): ${error}`, 'error');
                        // 非登录问题，简单重试一次
                        if (pageRetryCount === 0) {
                            log(`[页面进度 ${pageNum + 1}/${actualMaxPages}] 等待 2 秒后重试...`, 'info');
                            await sleep(2000);
                        } else {
                            throw error;
                        }
                    }
                    
                    pageRetryCount++;
                }
            }
            
            // 如果页面获取失败，继续下一页而不是终止整个话题
            if (!pageSuccess && pageRetryCount >= maxPageRetry) {
                log(`[页面进度 ${pageNum + 1}/${actualMaxPages}] 该页面获取失败，继续处理下一页`, 'warn');
            }
            
            // 如果成功获取且没有更多数据，则退出循环
            if (pageSuccess && !sinceId) {
                break;
            }
            
            if (pageNum < actualMaxPages - 1) {
                log(`等待 ${API_CONFIG.delayMs}ms 后获取下一页...`, 'info');
                await sleep(API_CONFIG.delayMs);
            }
        }

        log(`话题 ${producer.name || producer.producerId} 处理完成，共处理 ${totalProcessed} 条帖子`, 'info');
        
        if (totalProcessed > 0 && !config.useTestData) {
            await updateProducerLastPostTime(producer.id);
            log(`已更新话题 ${producer.name || producer.producerId} 的lastPostTime`, 'info');
        }
        
        return totalProcessed;
    } finally {
        // 不需要在这里 cleanup，因为 browserManager 会复用 page
    }
};

export const processWeiboTopic = async (maxPages: number = API_CONFIG.defaultMaxPages): Promise<number> => {
    const producers = config.useTestData
        ? [
            {
                id: 'test-topic-1',
                name: '八三夭超话',
                producerId: '100808dfa9a8980d720caae9bacf4af9da90fc',
                type: 'WEIBO_SUPER_TOPIC' as ProducerType,
                lastPostTime: null,
                createTime: new Date(),
                updateTime: new Date(),
                createdAt: new Date(),
                updatedAt: new Date(),
                deletedAt: null
            }
          ]
        : await getProducers(ProducerType.WEIBO_SUPER_TOPIC);
    
    log(`${config.logPrefix} 开始处理微博超话，共 ${producers.length} 个话题`, 'info');
    
    try {
        let totalCount = 0;
        
        for (let i = 0; i < producers.length; i++) {
            assertCollectorRunning();
            const producer = producers[i];
            log(`[总进度 ${i + 1}/${producers.length}] 开始处理话题 ${producer.name || producer.producerId}`, 'info');
            
            const count = await processTopicPost(producer, maxPages);
            recordProcessedSource();
            totalCount += count;
            
            log(`[总进度 ${i + 1}/${producers.length}] 话题处理完成，成功处理 ${count} 条帖子`, 'info');
            
            if (i < producers.length - 1) {
                log(`等待 ${API_CONFIG.delayMs}ms 后处理下一个话题...`, 'info');
                await sleep(API_CONFIG.delayMs);
            }
        }

        log(`所有话题处理完成，共处理 ${totalCount} 条帖子`, 'success');
        return totalCount;
    } catch (error) {
        log('微博话题处理失败: ' + error, 'error');
        throw error;
    } finally {
        // 清理浏览器资源
        await browserManager.cleanup();
    }
};
