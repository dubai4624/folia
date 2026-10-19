import { describe, expect, it } from 'vitest';
import { omni } from '../../../src/services/onlineMusic/omni';
import { registerOnlineMusicProvider, unregisterOnlineMusicProvider } from '../../../src/services/onlineMusic/providerRegistry';
import type { OnlineMusicProvider } from '../../../src/types/onlineMusic';

// test/unit/musicFreePlugins/pluginSourceLyricMatch.test.ts
// 插件源没有 getLyric（capabilities.lyrics=false）时，取歌词不能再抛错打断自动匹配：
// omni.getLyrics 要返回空结果，让调用方继续走 autoMatchBestLyric（在线匹配）。

const NO_LYRIC_PROVIDER_ID = 'musicfree.NoLyric';

const noLyricProvider: OnlineMusicProvider = {
    id: NO_LYRIC_PROVIDER_ID,
    displayName: 'NoLyric',
    capabilities: {
        search: true,
        playback: true,
        lyrics: false,
        auth: false,
        userLibrary: false,
        playlists: false,
        albums: false,
        artists: false,
        recommendations: false,
        mutations: false,
        wordByWordLyrics: false,
    },
    normalizeSong: raw => raw as never,
};

const song = {
    id: '1',
    name: 'Song',
    artists: [],
    album: { id: '', name: '' },
    durationMs: 1000,
    sourceRef: { kind: 'online', providerId: NO_LYRIC_PROVIDER_ID, mediaId: '1' },
} as never;

describe('plugin source without getLyric still allows online lyric matching', () => {
    it('returns an empty result instead of throwing, so auto-match can proceed', async () => {
        registerOnlineMusicProvider(noLyricProvider);
        try {
            const result = await omni.getLyrics(song);
            expect(result.lyrics).toBeNull();
            expect(result.isPureMusic).toBe(false);
        } finally {
            unregisterOnlineMusicProvider(NO_LYRIC_PROVIDER_ID);
        }
    });
});
