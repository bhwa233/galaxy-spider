import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import axios from 'axios';
import sharp from 'sharp';
import { uploadToGallery } from '../../src/utils/upload';

let server: Server;
let origin: string;
let uploadCount: number;
let uploadStatus: () => number;
let onUpload: (() => void) | undefined;

beforeEach(async () => {
    uploadCount = 0;
    uploadStatus = () => 200;
    onUpload = undefined;
    const image = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'red' } }).png().toBuffer();
    server = createServer((req, res) => {
        req.resume();
        if (req.url === '/image.png') {
            res.writeHead(200, { 'Content-Type': 'image/png' }).end(image);
        } else {
            uploadCount++;
            if (onUpload) { onUpload(); return; }
            res.writeHead(uploadStatus(), { 'Content-Type': 'application/json' }).end(JSON.stringify([{ src: `${origin}/file` }]));
        }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server failed to bind');
    origin = `http://127.0.0.1:${address.port}`;
    const post = axios.post.bind(axios);
    // 只重定向目的地，实际使用 Axios、HTTP、FormData 和图片处理链路。
    vi.spyOn(axios, 'post').mockImplementation((_url, data, config) => post(`${origin}/upload`, data, config));
});

afterEach(async () => {
    vi.restoreAllMocks();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

const media = () => ({ originMediaUrl: `${origin}/image.png`, thumbnailUrl: null,
    originSrc: 'https://m.weibo.cn/detail/123', width: 1, height: 1, type: 'image' as const });

describe('gallery failure handling over HTTP', () => {
    // 线上 413 被重复重试，随后又被消费者误计为上传成功。
    it('does not retry rejected oversized uploads and reports a media failure', async () => {
        uploadStatus = () => 413;
        expect(await uploadToGallery(media())).toMatchObject({ galleryUrl: null, failureKind: 'media' });
        expect(uploadCount).toBe(1);
    });

    it('retries temporary gallery errors and returns only a valid uploaded URL', async () => {
        uploadStatus = () => uploadCount === 1 ? 503 : 200;
        expect(await uploadToGallery(media())).toMatchObject({ galleryUrl: `${origin}/file` });
        expect(uploadCount).toBe(2);
    });

    it('cancels a stalled upload when the batch signal aborts without retrying', async () => {
        const controller = new AbortController();
        onUpload = () => controller.abort();
        expect(await uploadToGallery(media(), {}, { signal: controller.signal })).toMatchObject({ galleryUrl: null });
        expect(uploadCount).toBe(1);
    });
});
