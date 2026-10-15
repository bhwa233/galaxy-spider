import type { Producer } from "@prisma/client";

export interface WeiboMediaContent {
    userId: number;
    weiboImgUrl: string;
    width: number;
    height: number;
    videoSrc?: string;
    weiboUrl: string;
    galleryUrl: string;
    galleryVideoSrc?: string;
    createdAt: string;
}


export type UpdateProducer = Omit<Producer, 'createTime' | 'updateTime' | 'deletedAt'>;

export type NewProducer = Pick<Producer, 'name' | 'type' | 'producerId'>;
