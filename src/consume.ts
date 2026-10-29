import 'dotenv/config';
import { CONSUMER_RUNTIME_MS, runWeiboPostConsumer } from './consumer/Weibo/weiboPostConsumer';
import { log } from './utils/log';
import { prisma } from './db';
import { appendFile } from 'node:fs/promises';
import { startCollectorRun, prepareRunCredentials, type CollectorRun } from './utils/collectorRun';

async function main() {
    let run: CollectorRun | undefined;
    let failure: unknown;
    let status: 'completed' | 'partial' | 'bounded' | 'failed' | 'interrupted' = 'failed';
    const controller = new AbortController();
    const onInterrupt = () => {
        process.exitCode = 1;
        controller.abort(new Error('收到退出信号'));
    };
    process.once('SIGTERM', onInterrupt);
    process.once('SIGINT', onInterrupt);
    // 正常预算由消费者取消网络请求并保存进度；这里只处理清理本身卡死。
    const watchdog = setTimeout(() => {
        log('消费预算结束后清理仍未完成，异常退出；中断任务将由后续轮次回收', 'error');
        process.exit(1);
    }, CONSUMER_RUNTIME_MS + 60_000);

    try {
        run = await startCollectorRun('consumer');
        await prepareRunCredentials(run);
        const summary = await runWeiboPostConsumer({ signal: controller.signal });
        status = summary.stopReason === 'interrupted' ? 'interrupted' : summary.stopReason === 'budget' ? 'bounded'
            : summary.failedPosts || summary.deferredPosts || summary.failedMedia ? 'partial' : 'completed';
        if (process.env.GITHUB_STEP_SUMMARY) {
            await appendFile(process.env.GITHUB_STEP_SUMMARY,
                `### 微博消费结果\n\n结束原因：${summary.stopReason}\n\n` +
                `| 项目 | 数量 |\n| --- | ---: |\n` +
                `| 完成帖子 | ${summary.completedPosts} |\n| 失败帖子（下轮重试） | ${summary.failedPosts} |\n` +
                `| 中断帖子（已保留进度） | ${summary.deferredPosts} |\n| 新上传媒体 | ${summary.uploadedMedia} |\n` +
                `| 跳过已上传媒体 | ${summary.skippedMedia} |\n| 失败媒体 | ${summary.failedMedia} |\n`);
        }
    } catch (error) {
        failure = error;
        status = controller.signal.aborted ? 'interrupted' : 'failed';
        log('主函数出错:' + error, 'error');
        process.exitCode = 1;
    } finally {
        try {
            try { await run?.finish(status, failure); }
            finally { await prisma.$disconnect(); }
        } finally {
            clearTimeout(watchdog);
            process.removeListener('SIGTERM', onInterrupt);
            process.removeListener('SIGINT', onInterrupt);
        }
    }
}

main().catch(error => {
    log('清理任务失败:' + error, 'error');
    process.exitCode = 1;
});
