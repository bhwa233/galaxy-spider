import type { WeiboUser } from "../../consumer/Weibo/types";

// 基础页面信息接口
interface BasePageInfo {
    containerid: string;
    page_url: string;
    page_title?: string;
}

// 微博页面信息接口
export interface WeiboPageInfo extends BasePageInfo {
    type: string;
    object_type: number;
    page_pic: {
        url: string;
        width?: string;
        height?: string;
        pid?: string;
        source?: string;
    };
    content1?: string;
    content2?: string;
    video_orientation?: string;
    play_count?: string;
    media_info?: {
        stream_url: string;
        stream_url_hd: string;
        duration: number;
    };
    urls?: {
        mp4_720p_mp4: string;
        mp4_hd_mp4: string;
        mp4_ld_mp4: string;
    };
    object_id?: string;
    title?: string;
}

// 页面详细信息
export interface PageInfo extends BasePageInfo {
    v_p: string;
    show_style: number;
    total: number;
    since_id: number;
    page_type_name: string;
    title_top: string;
    nick: string;
    desc: string;
    page_size: number;
    background_scheme: string;
    cardlist_head_cards: CardlistHeadCard[];
    containerid_bak: string;
}

// 通用几何信息接口
interface GeoInfo {
    width: string | number;
    height: string | number;
    croped?: boolean;
}

// 微博图片信息接口
export interface WeiboPic {
    pid: string;
    url: string;
    size: string;
    geo: GeoInfo;
    large: {
        size: string;
        url: string;
        geo: GeoInfo;
    };
    videoSrc?: string;
    type?: string;
}

// 微博内容接口
export interface WeiboMblog {
    visible: {
        type?: number;
        list_id: number;
    };
    created_at: string;
    id: string | number;
    mid: string;
    can_edit: boolean;
    text: string;
    textLength: number;
    source: string;
    favorited: boolean;
    pic_ids: string[];
    pics?: WeiboPic[];
    page_info?: WeiboPageInfo;
    live_photo?: string[]; 
    bid: string;
    is_paid?: boolean;
    mblog_vip_type?: number;
    reposts_count?: number;
    comments_count?: number;
    attitudes_count?: number;
    pending_approval_count?: number;
    isLongText?: boolean;
    user:WeiboUser
}

// 卡片基础接口
interface BaseCard {
    card_type: string | number;
    itemid?: string;
    scheme?: string;
}

// 微博卡片接口
export interface WeiboCard extends BaseCard {
    profile_type_id: string;
    mblog: WeiboMblog;
}

// 通用卡片接口
export interface Card extends BaseCard {
    card_type_name?: string;
    mblog: WeiboMblog;
    card_group?: Card[];
    display_arrow?: string;
    show_type?: number;
    group_style?: {
        margin: number[];
    };
    [key: string]: any;
}

// 卡片列表信息接口
export interface WeiboCardlistInfo {
    containerid: string;
    v_p: number;
    show_style: number;
    total: number;
    autoLoadMoreIndex: number;
    since_id: number;
}

// API响应数据接口
export interface WeiboResponse {
    ok: number;
    data: {
        cardlistInfo: WeiboCardlistInfo;
        cards: WeiboCard[];
        scheme: string;
        showAppTips: number;
    };
}

// 媒体内容接口
export interface MediaContent {
    imgId: string;
    userId: number;
    weiboImgUrl: string;
    width: number;
    height: number;
    videoSrc?: string;
    weiboUrl: string;
    galleryUrl: string;
    createdAt: string;
}

// 分页结果接口
export interface PageResult {
    cards: WeiboMblog[];
    sinceId: string;
}

// 图片项接口
export interface PicItem {
    videoSrc?: string;
    large: {
        url: string;
        geo: GeoInfo;
    };
}

// Add this interface
export interface WeiboTopicResponse {
    ok: number;
    data: {
        pageInfo: PageInfo;
        cardlistInfo?: WeiboCardlistInfo;
        cards: Card[];
        scheme: string;
        showAppTips: number;
    };
}

