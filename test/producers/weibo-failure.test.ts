import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProducerType, type Producer } from '@prisma/client';

const { page } = vi.hoisted(() => ({
    page: {
        request: { get: vi.fn() },
        goto: vi.fn(),
        waitForTimeout: vi.fn(),
        textContent: vi.fn()
    }
}));

vi.mock('../../src/browser', () => ({
    browserManager: { createPage: async () => page, cleanup: vi.fn() }
}));
vi.mock('../../src/config', () => ({ config: { useTestData: true, shouldWriteDB: false } }));
vi.mock('../../src/db/producer', () => ({
    getProducers: vi.fn(), getProducerById: vi.fn(), updateProducerLastPostTime: vi.fn()
}));
vi.mock('../../src/db/post', () => ({ createPost: vi.fn() }));
vi.mock('../../src/utils', () => ({ sleep: async () => {} }));

import { processUserPost } from '../../src/producers/weibo/person';
import { processTopicPost, processWeiboTopic } from '../../src/producers/weibo/topic';

const producer = {
    id: 'test', producerId: '5286960038', name: '测试用户',
    type: ProducerType.WEIBO_PERSONAL, lastPostTime: null
} as Producer;

function respond(status: number, body: string, url = 'https://weibo.com/ajax/statuses/mymblog') {
    const response = {
        status: () => status, url: () => url,
        text: async () => body, json: async () => JSON.parse(body)
    };
    page.request.get.mockResolvedValue(response);
    page.goto.mockResolvedValue(response);
    page.textContent.mockResolvedValue(body);
}

beforeEach(() => vi.clearAllMocks());

describe('微博线上爬取失败', () => {
    // 2026-10：CI 持续收到 418/登录页，爬取 0 条，却被当成成功。
    it('个人接口被拦截时向入口传播错误并停止后续分页', async () => {
        respond(418, '<html>blocked</html>');
        await expect(processUserPost(producer, 5)).rejects.toThrow(/418/);
        expect(page.request.get).toHaveBeenCalledTimes(1);
    });

    it('超话登录页失败不会被汇总函数吞掉', async () => {
        respond(200, '扫描二维码登录', 'https://passport.weibo.com/signin');
        await expect(processWeiboTopic(5)).rejects.toThrow(/登录/);
        expect(page.goto).toHaveBeenCalledTimes(1);
    });

    it('超话返回缺少 data 的登录响应时不会误认为没有更多帖子', async () => {
        respond(200, JSON.stringify({ ok: -100, url: 'https://weibo.com/login.php' }));
        await expect(processTopicPost(producer, 5)).rejects.toThrow(/登录/);
    });

    it('暂时性故障重试耗尽后也会报错', async () => {
        respond(503, 'unavailable');
        await expect(processUserPost(producer, 5)).rejects.toThrow(/503/);
        expect(page.request.get).toHaveBeenCalledTimes(2);
    });

    it('正常空列表仍可成功完成，不把没有新帖子当作故障', async () => {
        respond(200, JSON.stringify({ ok: 1, data: { list: [] } }));
        await expect(processUserPost(producer, 5)).resolves.toBe(0);
        respond(200, JSON.stringify({ ok: 1, data: { cards: [] } }));
        await expect(processTopicPost(producer, 5)).resolves.toBe(0);
    });

    it('帖子内容中的登录提示不会被误判为登录失效', async () => {
        respond(200, JSON.stringify({
            ok: 1, data: { list: [{ id: '1', pic_ids: ['image'], text: '请登录后扫码登录参与活动' }] }
        }));
        await expect(processUserPost(producer, 1)).resolves.toBe(1);
    });

    // 线上全量验证有一条微博的 pics 是对象，some() 异常导致有图片的帖子被跳过。
    it('pics 返回对象时仍能识别 pic_ids 中的图片', async () => {
        respond(200, JSON.stringify({
            ok: 1, data: { list: [{ id: '2', pic_ids: ['image'], pics: {} }] }
        }));
        await expect(processUserPost(producer, 1)).resolves.toBe(1);
    });
});
