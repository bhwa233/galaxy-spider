import { Platform, UploadStatus, type Post } from '@prisma/client';
import { prisma } from '.';

export const createPost = async (data: {
    platform: Platform;
    userId: string;
    platformId: string | number;
    producerId: string;
    createTime: Date;
}): Promise<Post> => {
    const platformId = String(data.platformId);
    const postData = {
        userId: data.userId,
        platform: data.platform,
        platformId,
        producerId: data.producerId,
        status: UploadStatus.PENDING,
        createTime: data.createTime
    };
    // 重复抓到同一帖子不刷新任务时间，尤其不能延长中断任务的恢复期限。
    // 只有元数据确实变化且没有 Consumer 正在处理时，才更新已有记录。
    await prisma.post.updateMany({
        where: {
            platform: data.platform,
            platformId,
            status: { not: UploadStatus.PROCESSING },
            OR: [
                { userId: { not: data.userId } },
                { producerId: { not: data.producerId } },
                { createTime: { not: data.createTime } },
            ],
        },
        data: { userId: data.userId, producerId: data.producerId, createTime: data.createTime },
    });
    return await prisma.post.upsert({
        where: {
            platform_platformId: {
                platform: data.platform,
                platformId
            }
        },
        update: {},
        create: postData
    });
};

export const updatePostStatus = async (id: string, status: UploadStatus) => {
    return await prisma.post.update({
        where: { id },
        data: { status }
    });
};
// 使用已有状态和 updateTime 作为领取凭据；失败任务本轮不再领取。
export const claimNextPost = async (runStartedAt: Date) => {
    const eligible = {
        platform: Platform.WEIBO,
        deletedAt: null,
        OR: [
            { status: UploadStatus.PENDING },
            { status: UploadStatus.FAILED, updateTime: { lt: runStartedAt } },
        ],
    };
    while (true) {
        const post = await prisma.post.findFirst({
            where: eligible,
            orderBy: [{ updateTime: 'asc' }, { id: 'asc' }],
        });
        if (!post) return null;
        const claimed = await prisma.post.updateMany({
            where: { ...eligible, id: post.id, status: post.status, updateTime: post.updateTime },
            data: { status: UploadStatus.PROCESSING },
        });
        if (claimed.count === 1) return post;
    }
};

export const recoverStalePosts = async (staleBefore: Date) => {
    const result = await prisma.post.updateMany({
        where: { platform: Platform.WEIBO, deletedAt: null, status: UploadStatus.PROCESSING, updateTime: { lt: staleBefore } },
        data: { status: UploadStatus.PENDING },
    });
    return result.count;
};
export const countPendingPost = async () => {
    return await prisma.post.count({
        where: { status: UploadStatus.PENDING }
    });
};

