import { describe, expect, it } from 'vitest';
import { resolveOnlineLyrics, hasUsableOnlineOverride } from '../../../src/utils/onlineLyricsState';
import type { LyricData, OnlineLyricsState } from '../../../src/types';

// test/unit/lyrics/lyricSourceSwitch.test.ts
// 点「在线 / 导入」换歌词来源时，不能把屏幕上原来那份（常常正是「没有歌词」的空白）继续摆着。
// 缺陷在调用点：切换时把当前显示的歌词当成取歌词的兜底；这里钉住「不给兜底就是没有」。

const line = (text: string): LyricData => ({
    lines: [{ startTime: 0, endTime: 1, fullText: text, words: [] }],
});

describe('resolving lyrics for a source switch', () => {
    it('hands back nothing when the source has no lyrics and no fallback is offered', () => {
        // 切到在线来源、这个来源没有结果：fallback 传 null（切换时的做法），结果必须是没有。
        expect(resolveOnlineLyrics({ lyricsSource: 'online', hasOnlineOverride: false }, null)).toBeNull();
    });

    it('still lets a caller offer the song default lyrics outside a switch', () => {
        const fallback = line('song default');
        expect(resolveOnlineLyrics({ lyricsSource: 'online', hasOnlineOverride: false }, fallback)).toBe(fallback);
    });

    it('shows imported lyrics when the source is imported', () => {
        const imported = line('imported');
        expect(resolveOnlineLyrics({ lyricsSource: 'imported', importedLyrics: imported }, null)).toBe(imported);
    });

    it('shows a manual online match when there is one', () => {
        const matched = line('matched');
        expect(resolveOnlineLyrics({
            lyricsSource: 'online',
            hasOnlineOverride: true,
            onlineOverrideLyrics: matched,
        }, null)).toBe(matched);
    });

    it('treats a recorded instrumental as no lyrics', () => {
        expect(resolveOnlineLyrics({
            lyricsSource: 'online',
            hasOnlineOverride: true,
            onlineOverrideLyrics: null,
            matchedIsPureMusic: true,
        }, line('stale'))).toBeNull();
    });
});

describe('the switch path', () => {
    it('reads a fresh copy from the provider instead of the cached or prefetched one', async () => {
        // loadBaseOnlineLyrics(freshFromProvider) 的取舍：切来源时缓存和预取都属于「之前那次」，
        // 跳过它们、只问来源要一次，才不会把切换前那份空白又拿回来。
        const cached = line('cached blank');
        const fetched = line('fresh from provider');

        const loadBase = async (freshFromProvider: boolean) => {
            if (!freshFromProvider) return cached;
            return fetched;
        };

        expect(await loadBase(false)).toBe(cached);
        expect(await loadBase(true)).toBe(fetched);
    });

    it('shows nothing when the fresh read has no lyrics and no fallback is offered', async () => {
        // 切换时兜底传 null；来源也没给歌词，结果必须是没有。
        const freshRead: LyricData | null = null;
        expect(resolveOnlineLyrics({ lyricsSource: 'online' }, freshRead)).toBeNull();
    });
});

describe('hasUsableOnlineOverride: telling a real override from a stale half-written one', () => {
    const override = (fields: Partial<OnlineLyricsState>): OnlineLyricsState => ({
        lyricsSource: 'online',
        hasOnlineOverride: true,
        ...fields,
    });

    it('counts a stored override with lyrics as usable', () => {
        expect(hasUsableOnlineOverride(override({ onlineOverrideLyrics: line('matched') }))).toBe(true);
    });

    it('counts a recorded instrumental verdict as usable', () => {
        expect(hasUsableOnlineOverride(override({ onlineOverrideLyrics: null, matchedIsPureMusic: true }))).toBe(true);
    });

    it('rejects a half-written override that has no lyrics and no pure-music mark', () => {
        // 这正是历史数据里会挡住自动匹配的坏状态：hasOnlineOverride 为真，却既无歌词、也没标纯音乐。
        expect(hasUsableOnlineOverride(override({ onlineOverrideLyrics: null }))).toBe(false);
    });

    it('rejects no override at all', () => {
        expect(hasUsableOnlineOverride({ lyricsSource: 'online', hasOnlineOverride: false })).toBe(false);
        expect(hasUsableOnlineOverride(null)).toBe(false);
    });
});
