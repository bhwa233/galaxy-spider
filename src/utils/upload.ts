import axios from 'axios';
import sharp from 'sharp';
import { log } from './log';
import { retryRequest } from './index';
import type { MediaInfo } from '../consumer/Weibo/types';

const GALLERY_URL = 'https://gallery233.pages.dev';
const SUPPORTED_EXTENSIONS = {
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'mov': 'video/quicktime',
    'mp4': 'video/mp4'
} as const;

type SupportedExtension = keyof typeof SUPPORTED_EXTENSIONS;

export interface MediaUploadResult {
    galleryUrl: string | null;
    thumbnailUrl: string | null;
    failureKind?: 'gallery' | 'media';
}

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;

function requestSignal(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function downloadMedia(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<Buffer> {
    const response = await axios({
        method: 'GET',
        url,
        responseType: 'arraybuffer',
        headers: {
            'Host': new URL(url).hostname,
            ...headers,
        },
        timeout: REQUEST_TIMEOUT_MS,
        signal: requestSignal(signal),
        maxContentLength: MAX_MEDIA_BYTES,
        maxBodyLength: MAX_MEDIA_BYTES,
    });
    return Buffer.from(response.data);
}

export interface GalleryUploadResponse {
    /** 原始文件URL */
    src: string;
    /** 缩略图信息 */
    thumbnail?: {
        /** 缩略图URL */
        src: string;
        /** 缩略图宽度 */
        width: number;
        /** 缩略图高度 */
        height: number;
    };
}


async function uploadToGalleryServer(
    buffer: Buffer,
    mimeType: string,
    fileName: string,
    signal?: AbortSignal,
): Promise<GalleryUploadResponse> {
    const formData = new FormData();
    formData.append('file', new Blob([new Uint8Array(buffer)], { type: mimeType }), fileName);

    const response = await retryRequest(async () => {
        return await axios.post<GalleryUploadResponse[]>(`${GALLERY_URL}/upload`, formData, {
            headers: { 'Content-Type': 'multipart/form-data' },
            timeout: REQUEST_TIMEOUT_MS,
            signal: requestSignal(signal),
            maxBodyLength: MAX_MEDIA_BYTES + 1024 * 1024,
        });
    }, 3, {
        signal,
        shouldRetry: error => axios.isAxiosError(error) &&
            (!error.response || error.response.status === 429 || error.response.status >= 500),
    });
    const uploaded = response.data?.[0];
    if (!uploaded?.src || !URL.canParse(uploaded.src) || !/^https?:\/\//i.test(uploaded.src)) {
        throw new Error('图库未返回有效文件地址');
    }
    return uploaded;
}

export function getFileExtension(url: string): string {
    try {
        // Try to parse as URL first
        const urlObj = new URL(url);

        // Check if there's a livephoto parameter (specific to weibo URLs)
        const livephoto = urlObj.searchParams.get('livephoto');
        if (livephoto) {
            // If livephoto parameter exists, extract extension from it
            return getFileExtension(decodeURIComponent(livephoto));
        }

        // Get the last segment of the path
        const filename = urlObj.pathname.split('/').pop() || '';

        // Extract extension
        const extension = filename.split('.').pop() || '';
        return extension;
    } catch {
        // If URL parsing fails, treat as filename
        const parts = url.split('.');
        return parts.length > 1 ? parts.pop() || '' : '';
    }
}

const isImage = (ext: string): ext is SupportedExtension => 
    ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext);

const isVideo = (ext: string): ext is SupportedExtension => 
    ['mov', 'mp4'].includes(ext);

const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
};

interface ProcessedMedia {
    buffer: Buffer;
    mimeType: string;
    fileName: string;
    size: number;
}

async function processImage(buffer: Buffer, quality: number): Promise<ProcessedMedia> {
    const fileName = `${Date.now()}`;
    const webpImage = await sharp(buffer).timeout({ seconds: 60 }).webp({ quality }).toBuffer();
    return {
        buffer: webpImage,
        mimeType:  SUPPORTED_EXTENSIONS['webp'],
        fileName: `${fileName}.webp`,
        size: webpImage.length
    };
}


async function processThumb(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<string|null> {
    const ext = getFileExtension(url).toLowerCase();
    if (!isImage(ext)) return null;
    const thumbBuffer = await downloadMedia(url, headers, signal);
    const processed = await processImage(thumbBuffer, 40);
    signal?.throwIfAborted();
    const uploadRes = await uploadToGalleryServer(processed.buffer, processed.mimeType, processed.fileName, signal);
    return uploadRes?.src || null;
}

 function logUploadStats(
    originalUrl: string, 
    originalSize: number, 
    processedSize: number, 
    galleryUrl: string | null,
    thumbnailUrl: string | null,
) {
    const sizeChangeRate = processedSize > 0
        ? ((processedSize / originalSize) * 100).toFixed(2)
        : "0";
    
    log(
        `处理成功 [${originalUrl}]\n` +
        `  尺寸变化比: ${sizeChangeRate}%\n` +
        `  原本大小: ${formatFileSize(originalSize)}, 主图大小: ${formatFileSize(processedSize)}\n` +
        `  主图: ${galleryUrl}\n` +
        `  缩略图: ${thumbnailUrl || '无'}`,
        'success'
    );
}


export async function uploadToGallery(
    media: MediaInfo, 
    headers: Record<string, string> = {},
    options: { signal?: AbortSignal } = {},
): Promise<MediaUploadResult> {
    let failureKind: 'gallery' | 'media' = 'media';
    try {
        options.signal?.throwIfAborted();
        const extension = getFileExtension(media.originMediaUrl).toLowerCase();
        if (!isImage(extension) && !isVideo(extension)) {
            log(`不支持的文件类型: ${extension} (${media.originMediaUrl})`, 'warn');
            return { galleryUrl: null, thumbnailUrl: null, failureKind };
        }

        const mediaBuffer = await downloadMedia(media.originMediaUrl, headers, options.signal);

        const originalSize = mediaBuffer.length;
        const fileName = `${Date.now()}.${extension}`;

        let processedMedia: ProcessedMedia;
        try {
            processedMedia = isImage(extension)
                ? await processImage(mediaBuffer,100)
                : {
                    buffer: mediaBuffer,
                    mimeType: SUPPORTED_EXTENSIONS[extension as SupportedExtension],
                    fileName,
                    size: mediaBuffer.length
                };
        } catch (error) {
            throw new Error('处理失败');
        }

        if (processedMedia.size > MAX_MEDIA_BYTES) throw new Error('媒体超过 50 MB，需调整文件大小或上传方式');
        options.signal?.throwIfAborted();
        failureKind = 'gallery';
        const gallery = await uploadToGalleryServer(
            processedMedia.buffer,
            processedMedia.mimeType,
            processedMedia.fileName,
            options.signal,
        );

        if (!gallery?.src) {
            throw new Error('上传失败');
        }

        // 处理缩略图
        // 主文件成功即保留进度，缩略图失败不能导致下轮重复上传主文件。
        let thumb = gallery.thumbnail?.src || null;
        if (!thumb && media.thumbnailUrl && !options.signal?.aborted) {
            try {
                thumb = await processThumb(media.thumbnailUrl, headers, options.signal);
            } catch {
                log(`缩略图生成失败，保留已上传的主文件: ${media.originMediaUrl}`, 'warn');
            }
        }

        logUploadStats(
            media.originMediaUrl,
            originalSize,
            processedMedia.size,
            gallery.src,
            thumb
        );

        return {
            galleryUrl: gallery.src,
            thumbnailUrl: thumb
        };
    } catch (error) {
        if (axios.isAxiosError(error) && error.response && error.response.status >= 400 &&
            error.response.status < 500 && ![401, 403, 429].includes(error.response.status)) {
            failureKind = 'media'; // 例如 413：下一轮再处理，当前请求不盲目重试。
        }
        log(`处理失败: ${media.originMediaUrl}, ${error}`, 'error');
        return { galleryUrl: null, thumbnailUrl: null, failureKind };
    }
}
