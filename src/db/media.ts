import type { UploadStatus, Media } from '@prisma/client';
import { callDataService } from './client';
import { log } from '../utils/log';

type MediaData = Omit<Media, 'id' | 'status' | 'updateTime' | 'deletedAt'>;
export const updateMediaGalleryUrl = async (id: number, galleryMediaUrl: string, status: UploadStatus) => {
    try { return await callDataService<boolean>('spider/mediaGalleryUrl', { id, galleryMediaUrl, status }); }
    catch (error) { log(`保存失败: ${error}`, 'error'); return false; }
};
export const getUploadedMedias = (postId: string) => callDataService<Pick<Media, 'originMediaUrl' | 'galleryMediaUrl'>[]>('spider/uploadedMedia', { postId });
export const saveMedias = async (data: MediaData[]): Promise<number> => {
    let saved = 0;
    // Keep individual progress durable. HTTP mutation requests are not retried
    // blindly; the Worker's media operation performs atomic deduplication.
    for (const row of data) saved += await callDataService<number>('spider/saveMedia', [row]);
    return saved;
};
export const getRemainingUploadCount = () => callDataService<number>('spider/remainingUploadCount', {});
export const getUploadMedias = (limit = 100) => callDataService<Media[]>('spider/uploadMedia', { limit });
