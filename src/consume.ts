import 'dotenv/config';
import { runWeiboPostConsumer } from './consumer/Weibo/weiboPostConsumer';
import { log } from './utils/log';
import { prisma } from './db';

const MAX_RUNTIME_MS = 5 * 60 * 60 * 1000; // 5小时的毫秒数

async function main() {
    // 设置最大运行时间定时器
    const timer = setTimeout(() => {
        log('达到最大运行时间 5 小时，程序退出', 'info');
        process.exit(1);
    }, MAX_RUNTIME_MS);

    try {
        await runWeiboPostConsumer();
    } catch (error) {
        log('主函数出错:' + error, 'error');
        process.exitCode = 1;
    } finally {
        // 清除定时器
        clearTimeout(timer);
        await prisma.$disconnect();
    }
}

main().catch(error => {
    log('清理任务失败:' + error, 'error');
    process.exitCode = 1;
});
