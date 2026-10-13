import 'dotenv/config';
import { downloadGistStorageState } from '../utils/storageState';

downloadGistStorageState().then(() => {
    console.log('✅ 已从 Gist 获取并校验 storageState');
}).catch(error => {
    console.error(`❌ 获取登录态失败: ${error}`);
    process.exitCode = 1;
});
