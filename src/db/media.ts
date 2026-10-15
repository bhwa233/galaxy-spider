import { UploadStatus, type Media } from '@prisma/client';
import { log } from '../utils/log';
import { prisma } from '.';


export const updateMediaGalleryUrl = async (id:number,galleryMediaUrl:string,status:UploadStatus) => {
    try {
        await prisma.media.update({
            where: {
                id
            },
            data: {
                galleryMediaUrl,
                status
            }
        });
        return true
    }
    catch (error) {
        log(`保存失败: ${error}`, 'error');
        return false
    }
}

type MediaData = Omit<Media, 'id'|'status'|'updateTime'|'deletedAt'>;

export const getUploadedMedias = async (postId: string) => prisma.media.findMany({
    where: { postId, deletedAt: null, status: UploadStatus.UPLOADED, galleryMediaUrl: { not: null } },
    select: { originMediaUrl: true, galleryMediaUrl: true },
});

export const saveMedias = async (data: MediaData[]):Promise<number> => {
    let count = 0;
    for (const media of data) {
        if (!media.originMediaUrl || !media.galleryMediaUrl || !URL.canParse(media.galleryMediaUrl) ||
            !/^https?:\/\//i.test(media.galleryMediaUrl)) {
            throw new Error('不能把缺少源地址或图库地址的媒体保存为上传成功');
        }
        const existing = await prisma.media.findFirst({
            where: { postId: media.postId, originMediaUrl: media.originMediaUrl, deletedAt: null },
        });
        const record = { ...media, status: UploadStatus.UPLOADED };
        if (existing) {
            // 修复旧版本留下的空图库地址；有效记录无需重复写入。
            if (!existing.galleryMediaUrl || existing.status !== UploadStatus.UPLOADED) {
                await prisma.media.update({ where: { id: existing.id }, data: record });
            }
        } else {
            await prisma.media.create({ data: record });
        }
        count++;
    }
    // 数据库异常向上传播，不能吞掉后再把帖子标成成功。
    return count;
};

export async function getRemainingUploadCount(): Promise<number> {
    const result = await prisma.media.count({
        where: {
            galleryMediaUrl: null,
            originMediaUrl: {
                not: null
            }
        },
        orderBy: {
            createTime: 'desc'
        }
    });
    return result;
}

export async function getUploadMedias(limit: number = 100) {
    return await prisma.media.findMany({
        where: {
            galleryMediaUrl: null,
            status: UploadStatus.PENDING
        },
        take: limit,
        orderBy: {
            createTime: 'desc'
        }
    });
}
