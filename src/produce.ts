import 'dotenv/config';
import { processWeiboPerson } from './producers/weibo/person';
import { processWeiboTopic } from './producers/weibo/topic';
import { log } from './utils/log';
import { formatDuration } from './utils/format';
import { config } from './config';
import { prisma } from './db';
import { startCollectorRun, prepareRunCredentials, type CollectorRun } from './utils/collectorRun';
import { browserManager } from './browser';


async function main() {
    const startTime = Date.now();
    let run: CollectorRun | undefined;
    let failure: unknown;
    let interrupted = false;
    const onInterrupt = () => {
        interrupted = true; process.exitCode = 1;
        if (run) run.interrupted = true;
        void browserManager.cleanup().catch(() => {});
    };
    process.once('SIGTERM', onInterrupt);
    process.once('SIGINT', onInterrupt);
    try {
        run = await startCollectorRun('producer');
        if (interrupted) { if (run) run.interrupted = true; throw new Error('采集已中断'); }
        await prepareRunCredentials(run);
        if (interrupted) throw new Error('采集已中断');
        log(`${config.logPrefix} 🚀 开始执行爬虫任务... (模式: ${config.runMode})`, 'info');
        
        if (config.isTest) {
            log('📌 测试模式：只爬取个人主页，最多 2 页...', 'info');
            await processWeiboPerson(2).then(() => {
                log(`微博用户处理完成`, 'success');
            });
        } else {
            log('📌 开始串行处理微博用户和话题...', 'info');
            
            // 先处理微博用户
            await processWeiboPerson().then(() => {
                log(`微博用户处理完成`, 'success');
            });
            
            // 再处理微博话题
            await processWeiboTopic().then(() => {
                log(`微博话题处理完成`, 'success');
            });
        }
        
        const processEndTime = Date.now();
        log(`🎉 所有任务执行完毕! 总耗时: ${formatDuration(processEndTime - startTime)}`, 'success');
    } catch (error) {
        failure = error;
        log(`❌ 执行出错 (运行时长: ${formatDuration(Date.now() - startTime)}): ${error}`, 'error');
        process.exitCode = 1;
    } finally {
        process.removeListener('SIGTERM', onInterrupt);
        process.removeListener('SIGINT', onInterrupt);
        try {
            await run?.finish(interrupted ? 'interrupted' : failure ? 'failed' : run.summary.failedPosts ? 'partial' : 'completed', failure);
        } finally {
            await browserManager.cleanup();
            await prisma.$disconnect();
        }
    }
}
main().catch(error => {
    log(`❌ 清理任务失败: ${error}`, 'error');
    process.exitCode = 1;
});
