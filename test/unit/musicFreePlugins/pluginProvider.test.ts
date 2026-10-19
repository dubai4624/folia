import { describe, expect, it, vi } from 'vitest';
import type { UnifiedSong } from '../../../src/types';
import type { MusicFreePluginDefinition } from '../../../src/types/musicFreePlugin';
import {
    createMusicFreeProvider,
    musicFreeProviderIdFor,
    musicFreeSongsFromItems,
} from '../../../src/services/musicFreePlugins/pluginProvider';
import type { MountedMusicFreePlugin } from '../../../src/services/musicFreePlugins/pluginRuntime';

// test/unit/musicFreePlugins/pluginProvider.test.ts
// 插件 → OnlineMusicProvider 的接线：歌曲归一化、分页、播放地址、替代插件、榜单 id。

const mount = (definition: Record<string, unknown>): MountedMusicFreePlugin => ({
    definition: definition as unknown as MusicFreePluginDefinition,
    methods: new Set(Object.keys(definition).filter(key => typeof definition[key] === 'function')),
    userVariables: [],
});

const songOf = (id: string, platform = 'Example'): UnifiedSong => ({
    id,
    name: 'song',
    artists: [],
    album: { id: '', name: '' },
    durationMs: 0,
    sourceRef: { kind: 'online', providerId: musicFreeProviderIdFor(platform), mediaId: id },
});

describe('createMusicFreeProvider', () => {
    it('turns plugin songs into Folia songs that name their source', async () => {
        const provider = createMusicFreeProvider(mount({
            platform: 'Example',
            async search() {
                return {
                    isEnd: true,
                    data: [
                        { id: 'a', platform: 'Example', title: 'A', artist: 'X/Y', album: 'Alb', artwork: 'https://img/a.jpg', duration: 61 },
                    ],
                };
            },
        }), 'Example');
        const page = await provider.search!.searchSongs('q', 30, 0);
        expect(page.items).toHaveLength(1);
        expect(page.items[0].name).toBe('A');
        expect(page.items[0].artists.map(artist => artist.name)).toEqual(['X', 'Y']);
        expect(page.items[0].album).toMatchObject({ name: 'Alb', coverUrl: 'https://img/a.jpg' });
        expect(page.items[0].durationMs).toBe(61000);
        expect(page.items[0].sourceRef).toEqual({
            kind: 'online',
            providerId: 'musicfree.Example',
            mediaId: 'a',
        });
    });

    it('joins the plugin pages into the window Folia asks for', async () => {
        const provider = createMusicFreeProvider(mount({
            platform: 'Paged',
            async search(_query: string, page: number) {
                if (page === 1) return { isEnd: false, data: [{ id: '1' }, { id: '2' }] };
                return { isEnd: true, data: [{ id: '3' }] };
            },
        }), 'Paged');
        const page = await provider.search!.searchSongs('q', 3, 0);
        expect(page.items.map(item => item.id)).toEqual(['1', '2', '3']);
        expect(page.hasMore).toBe(false);
        expect(page.nextOffset).toBe(3);
    });

    it('asks the plugin for the audio URL at the quality Folia resolved', async () => {
        const getMediaSource = vi.fn(async () => ({ url: 'https://audio/1.mp3' }));
        const provider = createMusicFreeProvider(mount({
            platform: 'Audio',
            getMediaSource,
        }), 'Audio');
        const source = await provider.playback!.getAudioSource(songOf('1', 'Audio'), 'high');
        expect(source?.url).toBe('https://audio/1.mp3');
        expect(getMediaSource).toHaveBeenCalledWith(expect.objectContaining({ id: '1' }), 'high');
    });

    it('resolves playback through the alternative plugin when one is configured', async () => {
        const own = vi.fn(async () => ({ url: 'https://own/1.mp3' }));
        const alternative = vi.fn(async () => ({ url: 'https://alternative/1.mp3' }));
        const provider = createMusicFreeProvider(
            mount({ platform: 'Forwarded', getMediaSource: own }),
            'Forwarded',
            { resolveAlternative: () => mount({ platform: 'Parser', getMediaSource: alternative }) },
        );
        const source = await provider.playback!.getAudioSource(songOf('1', 'Forwarded'), 'standard');
        expect(source?.url).toBe('https://alternative/1.mp3');
        expect(own).not.toHaveBeenCalled();
        expect(alternative).toHaveBeenCalled();
    });

    it('reads a toplist by its prefixed collection id', async () => {
        const getTopListDetail = vi.fn(async () => ({ isEnd: true, musicList: [{ id: 'x', title: 'X' }] }));
        const provider = createMusicFreeProvider(mount({
            platform: 'Top',
            getTopLists: async () => [],
            getTopListDetail,
        }), 'Top');
        const page = await provider.catalog!.getPlaylistTracks?.('toplist:42', 10, 0, {
            providerId: 'musicfree.Top',
            id: 'toplist:42',
            name: '榜单',
            type: 'playlist',
        });
        expect(page?.items.map(item => item.id)).toEqual(['x']);
        expect(getTopListDetail).toHaveBeenCalledWith(expect.objectContaining({ id: '42' }), 1);
    });

    it('parses the LRC a plugin answers with', async () => {
        const provider = createMusicFreeProvider(mount({
            platform: 'Lyric',
            async getLyric() {
                return { rawLrc: '[00:01.00]line one\n[00:03.00]line two', translation: '[00:01.00]译一\n[00:03.00]译二' };
            },
        }), 'Lyric');
        const result = await provider.lyrics!.getLyrics(songOf('1', 'Lyric'));
        expect(result.lyrics?.lines.map(line => line.fullText)).toEqual(['line one', 'line two']);
        expect(result.lyrics?.lines[0].translation).toBe('译一');
        expect(result.mainText).toContain('line one');
    });

    it('converts imported items with the same rules as search results', () => {
        const songs = musicFreeSongsFromItems('Imported', [{ id: 'i1', platform: 'Imported', title: 'Imported song', duration: 2 }]);
        expect(songs).toHaveLength(1);
        expect(songs[0].sourceRef.kind === 'online' && songs[0].sourceRef.providerId).toBe('musicfree.Imported');
        expect(songs[0].durationMs).toBe(2000);
    });
});
