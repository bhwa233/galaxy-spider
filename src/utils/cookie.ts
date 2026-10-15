/**
 * Cookie 管理工具
 * 支持从 GitHub Gist 获取或使用硬编码的 Cookie
 */

import { config } from '../config';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GIST_ID = process.env.GIST_ID;

// 硬编码的微博 Cookie（备用方案）
const HARDCODED_WEIBO_COOKIE = 'WEIBOCN_FROM=1110006030; SUB=_2AkMe1h3tf8NxqwFRmvsXxG7ia4h2wwrEieKoiuw2JRM3HRl-yT9kqnc9tRB6NVYzAmxCM1izZSWe9-xcPQmmL_NGEnIl; SUBP=0033WrSXqPxfM72-Ws9jqgMF55529P9D9WhR9EPgz3BDPWy-YHwFuiIb; MLOGIN=0; _T_WM=38152265571; XSRF-TOKEN=86baeb; M_WEIBOCN_PARAMS=luicode%3D10000011%26lfid%3D102803%26launchid%3D10000360-page_H5%26fid%3D106003type%253D25%2526t%253D3%2526disable_hot%253D1%2526filter_type%253Drealtimehot%26uicode%3D10000011';

// 全局 Cookie 缓存
let cookieCache: PlaywrightCookie[] | null = null;

export interface CookieItem {
    name: string;
    value: string;
    domain?: string;
    path?: string;
    expires?: number;
    expirationDate?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: string;
}

export interface PlaywrightCookie {
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'Strict' | 'Lax' | 'None';
}

/**
 * 从 GitHub Gist 获取 Cookie 数据
 */
export async function fetchCookiesFromGist(sourceDomain: string = 'weibo.com'): Promise<CookieItem[]> {
    try {
        const apiUrl = `https://api.github.com/gists/${GIST_ID}`;
        
        const response = await fetch(apiUrl, {
            headers: {
                'Authorization': `Bearer ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28'
            }
        });
        
        if (!response.ok) {
            throw new Error(`GitHub API 请求失败: ${response.status} ${response.statusText}`);
        }
        
        const data = await response.json();
        const files = data.files as Record<string, { content?: string }>;
        
        // 查找 cookie 文件
        for (const [filename, fileInfo] of Object.entries(files)) {
            if (filename.toLowerCase().includes('cookie') || filename.toLowerCase().includes('sync-your-cookie')) {
                const content = fileInfo.content;
                if (content) {
                    const cookieData = JSON.parse(content);
                    const domainCookieMap = cookieData.domainCookieMap || {};
                    
                    // 查找指定域名的 cookie
                    if (domainCookieMap[sourceDomain]) {
                        const cookies = domainCookieMap[sourceDomain].cookies || [];
                        console.log(`✅ 从 Gist 获取到 ${cookies.length} 个 ${sourceDomain} cookie`);
                        return cookies;
                    }
                }
            }
        }
        
        throw new Error(`未在 Gist 中找到 ${sourceDomain} 的 Cookie`);
    } catch (error) {
        console.error('❌ 从 Gist 获取 Cookie 失败:', error);
        throw error;
    }
}

/**
 * 将 Cookie 转换为 Playwright 格式，并修改域名
 */
export function convertToPlaywrightCookies(
    cookies: CookieItem[],
    targetDomain: string
): PlaywrightCookie[] {
    return cookies.map(c => {
        // 处理 sameSite 值
        let sameSite: 'Strict' | 'Lax' | 'None' = 'Lax';
        if (c.sameSite === 'strict') sameSite = 'Strict';
        else if (c.sameSite === 'none' || c.sameSite === 'no_restriction') sameSite = 'None';
        
        return {
            name: c.name,
            value: c.value,
            domain: targetDomain,
            path: c.path || '/',
            expires: c.expirationDate || c.expires || -1,
            httpOnly: c.httpOnly || false,
            secure: c.secure || false,
            sameSite
        };
    });
}

/**
 * 获取 weibo 通用 Cookie（支持多个子域名）
 * 优先使用硬编码的 Cookie，如果配置了 Gist 且未强制使用硬编码则从 Gist 获取
 */
export async function getWeiboCnCookies(): Promise<PlaywrightCookie[]> {
    // 如果配置强制使用硬编码 Cookie
    if (config.useHardcodedCookie) {
        return getHardcodedWeiboCookies();
    }
    
    // 检查是否配置了 Gist
    const useGist = GITHUB_TOKEN && GIST_ID;
    
    if (useGist) {
        try {
            // 从 Gist 获取 weibo.com 的 cookie
            const cookies = await fetchCookiesFromGist('weibo.com');
            
            // 同时转换为 .weibo.cn 和 .weibo.com 域名，覆盖所有子域名
            return [
                ...convertToPlaywrightCookies(cookies, '.weibo.cn'),
                ...convertToPlaywrightCookies(cookies, '.weibo.com')
            ];
        } catch (error) {
            console.warn('⚠️ 从 Gist 获取 Cookie 失败，使用硬编码的 Cookie', error);
            return getHardcodedWeiboCookies();
        }
    } else {
        // 使用硬编码的 Cookie
        return getHardcodedWeiboCookies();
    }
}

/**
 * 获取缓存的 Cookie，如果没有则从 Gist 或硬编码获取
 */
export async function getCachedCookies(): Promise<PlaywrightCookie[]> {
    if (!cookieCache) {
        console.log('📥 获取 Cookie...');
        cookieCache = await getWeiboCnCookies();
        console.log(`✅ 成功获取 ${cookieCache.length} 个 Cookie`);
    }
    return cookieCache;
}

/**
 * 获取 Cookie 字符串（用于 API 请求）
 */
export async function getWeiboCookieString(): Promise<string> {
    const cookies = await getCachedCookies();
    // 只使用 .weibo.cn 的 Cookie（避免重复）
    const weiboCnCookies = cookies.filter(c => c.domain === '.weibo.cn');
    return weiboCnCookies.map(c => `${c.name}=${c.value}`).join('; ');
}

/**
 * 获取硬编码的 Cookie 字符串
 */
export function getHardcodedCookieString(): string {
    return HARDCODED_WEIBO_COOKIE;
}

/**
 * 清除 Cookie 缓存（刷新时使用）
 */
export function clearCookieCache(): void {
    cookieCache = null;
    console.log('🗑️ Cookie 缓存已清除');
}

/**
 * 将 Cookie 数组转换为字符串格式（用于 HTTP headers）
 */
export function cookiesToString(cookies: CookieItem[]): string {
    return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

/**
 * 解析 Cookie 字符串为 CookieItem 数组
 */
export function parseCookieString(cookieString: string): CookieItem[] {
    return cookieString.split(';').map(item => {
        const [name, value] = item.trim().split('=');
        return {
            name: name.trim(),
            value: value?.trim() || '',
            domain: '.weibo.cn',
            path: '/',
            expires: -1,
            httpOnly: false,
            secure: false,
            sameSite: 'Lax'
        };
    }).filter(c => c.name); // 过滤空名称
}

/**
 * 获取硬编码的微博 Cookie
 */
export function getHardcodedWeiboCookies(): PlaywrightCookie[] {
    console.log('📝 使用硬编码的微博 Cookie');
    const cookies = parseCookieString(HARDCODED_WEIBO_COOKIE);
    
    // 同时转换为 .weibo.cn 和 .weibo.com 域名，覆盖所有子域名
    return [
        ...convertToPlaywrightCookies(cookies, '.weibo.cn'),
        ...convertToPlaywrightCookies(cookies, '.weibo.com')
    ];
}

/**
 * 验证 Cookie 是否有效
 * 通过访问微博并检查是否被重定向到登录页来判断
 */
export async function validateCookies(): Promise<boolean> {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    
    try {
        // 获取并添加 Cookie
        const cookies = await getWeiboCnCookies();
        await context.addCookies(cookies);
        
        const page = await context.newPage();
        
        // 访问微博首页
        const response = await page.goto('https://weibo.cn/', {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });
        
        const finalUrl = page.url();
        
        // 检查是否被重定向到登录页
        const isRedirectedToLogin = finalUrl.includes('login') || 
                                    finalUrl.includes('passport') ||
                                    finalUrl.includes('signin');
        
        if (isRedirectedToLogin) {
            console.log('❌ Cookie 已失效（被重定向到登录页）');
            await browser.close();
            return false;
        }
        
        // 检查页面内容是否包含登录相关元素
        const pageContent = await page.content();
        const hasLoginKeywords = pageContent.includes('登录') && 
                                 !pageContent.includes('退出') &&
                                 !pageContent.includes('首页');
        
        if (hasLoginKeywords) {
            console.log('❌ Cookie 已失效（页面显示需要登录）');
            await browser.close();
            return false;
        }
        
        console.log('✅ Cookie 验证通过，当前已登录');
        await browser.close();
        return true;
        
    } catch (error) {
        console.error('❌ Cookie 验证过程出错:', error);
        await browser.close();
        return false;
    }
}

/**
 * 更新 Cookie 到 GitHub Gist
 */
export async function updateCookiesToGist(cookies: PlaywrightCookie[]): Promise<void> {
    try {
        // 转换为 CookieItem 格式
        const cookieItems: CookieItem[] = cookies
            .filter(c => c.domain.includes('weibo'))
            .map(c => ({
                name: c.name,
                value: c.value,
                domain: c.domain,
                path: c.path,
                expirationDate: c.expires,
                httpOnly: c.httpOnly,
                secure: c.secure,
                sameSite: c.sameSite === 'Strict' ? 'strict' : 
                         c.sameSite === 'None' ? 'no_restriction' : 'lax'
            }));
        
        // 构造 Gist 数据格式
        const gistData = {
            domainCookieMap: {
                'weibo.com': {
                    cookies: cookieItems
                }
            }
        };
        
        const apiUrl = `https://api.github.com/gists/${GIST_ID}`;
        
        const response = await fetch(apiUrl, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                files: {
                    'sync-your-cookie.json': {
                        content: JSON.stringify(gistData, null, 2)
                    }
                }
            })
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`GitHub API 更新失败: ${response.status} ${errorText}`);
        }
        
        console.log(`✅ 成功更新 ${cookieItems.length} 个 Cookie 到 Gist`);
        
    } catch (error) {
        console.error('❌ 更新 Cookie 到 Gist 失败:', error);
        throw error;
    }
}
