import type { SongResult } from '../types';

// src/services/songQueueRequests.ts
// 「把这几首歌排进队列」的请求通道。插件的导入单曲/歌单在设置页里，拿不到播放控制器的加歌动作；
// 它只在这里发一个请求，由 App 交给控制器自己的加歌路径去做（预取、去重、历史、状态提示都一样），
// 而不是让设置页直接改播放 store。

export type SongQueueAppendListener = (songs: SongResult[]) => void;

const listeners = new Set<SongQueueAppendListener>();

/** 订阅加歌请求；返回退订函数。 */
export const onSongQueueAppendRequested = (listener: SongQueueAppendListener): (() => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};

/** 请应用把这几首歌加到队列末尾。返回接了这个请求的订阅者数量；0 表示应用还没起来。 */
export const requestSongQueueAppend = (songs: SongResult[]): number => {
    const playable = (Array.isArray(songs) ? songs : []).filter(Boolean);
    if (playable.length === 0) return 0;
    listeners.forEach(listener => {
        try {
            listener(playable);
        } catch (error) {
            console.warn('[SongQueue] A queue append listener failed:', error);
        }
    });
    return listeners.size;
};
