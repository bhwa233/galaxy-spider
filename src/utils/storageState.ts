import fs from 'fs';
import path from 'path';

const DEFAULT_STORAGE_STATE_PATH = 'weibo.storage.json';
const DEFAULT_GIST_FILENAME = 'weibo.storage.json';

async function fetchGistStorageState(): Promise<string | undefined> {
    const gistId = process.env.GIST_ID;
    const token = process.env.GIST_TOKEN || process.env.GITHUB_TOKEN;
    if (!gistId || !token) {
        throw new Error('缺少 GIST_ID 或 GIST_TOKEN/GITHUB_TOKEN，无法获取最新登录态');
    }

    const response = await fetch(`https://api.github.com/gists/${gistId}`, {
        signal: AbortSignal.timeout(30000),
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
        }
    });

    if (!response.ok) {
        throw new Error(`GitHub Gist 请求失败: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as any;
    const files = data.files || {};
    const preferredName = process.env.GIST_STORAGE_STATE_FILENAME || DEFAULT_GIST_FILENAME;
    const file = files[preferredName];
    if (!file) {
        throw new Error(`Gist 中未找到 ${preferredName}`);
    }

    if (file.truncated && file.raw_url) {
        const rawResponse = await fetch(file.raw_url, {
            signal: AbortSignal.timeout(30000),
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/vnd.github+json'
            }
        });
        if (!rawResponse.ok) {
            throw new Error(`Gist raw 文件拉取失败: ${rawResponse.status} ${rawResponse.statusText}`);
        }
        return await rawResponse.text();
    }

    return file.content as string | undefined;
}

function validateStorageState(content: string): void {
    let parsed;
    try {
        parsed = JSON.parse(content);
    } catch {
        throw new Error('storageState 文件不是有效的 JSON');
    }
    if (!parsed || !Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins)) {
        throw new Error('storageState 文件格式不正确（缺少 cookies/origins）');
    }
    for (const domain of ['weibo.com', 'weibo.cn']) {
        const hasLoginCookie = parsed.cookies.some((cookie: any) =>
            cookie.name === 'SUB' && typeof cookie.value === 'string' && cookie.value.length > 0 &&
            [domain, `.${domain}`].includes(cookie.domain) && cookie.path === '/' &&
            (cookie.expires === -1 || cookie.expires > Date.now() / 1000)
        );
        if (!hasLoginCookie) {
            throw new Error(`缺少 ${domain} 的有效登录 Cookie，请运行 pnpm storage:refresh 重新登录`);
        }
    }
}

export async function downloadGistStorageState(): Promise<string> {
    const content = await fetchGistStorageState();
    if (!content) {
        throw new Error('Gist storageState 内容为空');
    }
    validateStorageState(content);
    const resolvedPath = path.resolve(process.env.STORAGE_STATE_PATH || DEFAULT_STORAGE_STATE_PATH);
    fs.writeFileSync(resolvedPath, content, 'utf8');
    return resolvedPath;
}

export async function resolveStorageStatePath(): Promise<string> {
    const envPath = process.env.STORAGE_STATE_PATH || DEFAULT_STORAGE_STATE_PATH;
    const resolvedPath = path.resolve(envPath);

    if (fs.existsSync(resolvedPath)) {
        validateStorageState(fs.readFileSync(resolvedPath, 'utf8'));
        return resolvedPath;
    }

    return await downloadGistStorageState();
}

export async function updateStorageStateToGist(storageStatePath?: string): Promise<void> {
    const gistId = process.env.GIST_ID;
    const token = process.env.GIST_TOKEN || process.env.GITHUB_TOKEN;
    if (!gistId || !token) {
        throw new Error('缺少必要的环境变量: GIST_ID 与 GIST_TOKEN/GITHUB_TOKEN');
    }

    const resolvedPath = path.resolve(storageStatePath || DEFAULT_STORAGE_STATE_PATH);
    if (!fs.existsSync(resolvedPath)) {
        throw new Error(`storageState 文件不存在: ${resolvedPath}`);
    }

    const content = fs.readFileSync(resolvedPath, 'utf8');
    validateStorageState(content);

    const filename = process.env.GIST_STORAGE_STATE_FILENAME || DEFAULT_GIST_FILENAME;
    const response = await fetch(`https://api.github.com/gists/${gistId}`, {
        method: 'PATCH',
        signal: AbortSignal.timeout(30000),
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            files: {
                [filename]: {
                    content
                }
            }
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gist 更新失败: ${response.status} ${errorText}`);
    }
}
