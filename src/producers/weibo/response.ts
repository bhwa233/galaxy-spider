import type { APIResponse } from 'playwright';

export class WeiboRequestError extends Error {
    constructor(message: string, public readonly code = 'weibo_response_invalid') { super(message); }
}

// 复用 Playwright 的响应接口，合并 person/topic 原先重复的登录错误判断。
// HTTP 客户端无法识别微博在 HTTP 200 中返回的登录页和 ok=-100，故在这里处理。
export async function readWeiboResponse<T>(response: Pick<APIResponse, 'status' | 'url' | 'text'>): Promise<T> {
    const loginError = () => new WeiboRequestError('微博登录态失效，请运行 pnpm storage:refresh 重新登录并在后台导入', 'weibo_login_required');
    const status = response.status();
    if (status === 401 || /passport\.|\/login(?:\.php)?|\/signin/i.test(response.url())) {
        throw loginError();
    }
    if ([403, 418, 429, 432].includes(status)) {
        throw new WeiboRequestError(`微博拒绝请求，HTTP ${status}；停止重试。刷新登录态后若仍出现，请检查运行环境是否被拦截`, 'weibo_request_blocked');
    }
    if (status !== 200) {
        throw new Error(`微博请求失败，HTTP ${status}`);
    }

    const content = await response.text();
    let json;
    try {
        json = JSON.parse(content);
    } catch {
        if (/扫描二维码|扫码登录|请登录/.test(content)) {
            throw loginError();
        }
        // 不输出响应原文，以免登录跳转或错误页面中的凭据进入 CI 日志。
        throw new WeiboRequestError('微博返回了非 JSON 页面，可能需要登录或验证；停止爬取');
    }
    if (!json || typeof json !== 'object') {
        throw new WeiboRequestError('微博响应格式异常');
    }
    if (json.ok === -100 || /passport\.|\/login|\/signin/i.test(String(json.url || '')) ||
        /登录|login/i.test(String(json.msg || json.error || ''))) {
        throw loginError();
    }
    return json as T;
}
