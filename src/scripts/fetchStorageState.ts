import 'dotenv/config';
import { downloadStorageState } from '../utils/storageState';

downloadStorageState().then(() => {
    console.log('✅ 已从 SparkHub 获取并校验 storageState');
}).catch(error => {
    console.error(`❌ 获取登录态失败: ${error}`);
    process.exitCode = 1;
});
