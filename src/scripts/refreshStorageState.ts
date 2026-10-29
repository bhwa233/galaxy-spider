/**
 * StorageState 刷新脚本
 * 打开浏览器完成登录后导出 storageState，供 SparkHub 后台导入
 */

import 'dotenv/config';
import { chromium } from 'playwright';
import readline from 'node:readline';
import { readWeiboResponse } from '../producers/weibo/response';

const storageStatePath = process.env.STORAGE_STATE_PATH || 'weibo.storage.json';
const loginUrl = process.env.WEIBO_LOGIN_URL || 'https://weibo.com/';
const waitMs = Number(process.env.LOGIN_WAIT_MS || 180000);

async function waitForUserOrTimeout(): Promise<void> {
    if (process.stdin.isTTY) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        await new Promise<void>(resolve => {
            rl.question('请完成登录后按回车继续...\n', () => {
                rl.close();
                resolve();
            });
        });
        return;
    }

    await new Promise(resolve => setTimeout(resolve, waitMs));
}

async function main() {
    console.log('==========================================');
    console.log('🔄 StorageState 刷新任务');
    console.log('==========================================\n');

    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();

    try {
        const page = await context.newPage();
        await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        console.log(`已打开登录页面: ${loginUrl}`);
        await waitForUserOrTimeout();

        // 两个域名的登录态都需建立，不能只导出 weibo.com 的 Cookie。
        await page.goto('https://m.weibo.cn/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        console.log('请确认移动版微博也已登录；若出现登录页，请完成登录。');
        await waitForUserOrTimeout();

        const mobileConfig = await readWeiboResponse<{ data?: { login?: boolean } }>(
            await context.request.get('https://m.weibo.cn/api/config', { timeout: 60000 })
        );
        if (mobileConfig.data?.login !== true) {
            throw new Error('移动版微博尚未登录，未上传登录态');
        }
        const userId = process.env.WEIBO_CHECK_USER_ID || '5286960038';
        const personal = await readWeiboResponse<{ ok: number; data?: { list?: unknown[] } }>(
            await context.request.get(`https://weibo.com/ajax/statuses/mymblog?uid=${encodeURIComponent(userId)}&page=1&feature=0`, {
                headers: { referer: `https://weibo.com/u/${userId}` }, timeout: 60000
            })
        );
        if (personal.ok !== 1 || !Array.isArray(personal.data?.list)) {
            throw new Error('个人主页接口校验失败，未上传登录态');
        }

        await context.storageState({ path: storageStatePath });
        console.log(`✅ storageState 已保存到 ${storageStatePath}`);

        console.log('请将此 JSON 文件上传到 SparkHub 后台 → 采集管理 → 微博采集。');
    } finally {
        await context.close();
        await browser.close();
    }
}

main().catch(error => {
    console.error('❌ StorageState 刷新失败:', error);
    process.exit(1);
});
