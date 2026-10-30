import type { Platform, UploadStatus, Post } from '@prisma/client';
import { callDataService } from './client';
import { randomUUID } from 'node:crypto';
export const createPost = (data: { platform: Platform; userId: string; platformId: string | number; producerId: string; createTime: Date }) => callDataService<Post>('spider/upsertPost', data);
export const updatePostStatus = (id: string, status: UploadStatus) => callDataService<Post>('spider/postStatus', { id, status });
export const claimNextPost = (runStartedAt: Date, signal?: AbortSignal) =>
    callDataService<Post | null>('spider/claimPostOnce', { runStartedAt, requestId: randomUUID() }, { signal });
export const recoverStalePosts = (staleBefore: Date) => callDataService<number>('spider/recoverPosts', { staleBefore });
export const countPendingPost = () => callDataService<number>('spider/pendingCount', {});
