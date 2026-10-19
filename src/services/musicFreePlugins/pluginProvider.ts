import type { SongResult, UnifiedSong } from '../../types';
import type {
    AudioQualityPreference,
    JsonValue,
    OnlineMusicProvider,
    ProviderAudioSource,
    ProviderCapabilities,
    ProviderCollection,
    ProviderExploreItem,
    ProviderExplorePage,
    ProviderExploreSection,
    ProviderLyricsResult,
    ProviderSongMetadata,
    ProviderPage,
} from '../../types/onlineMusic';
import type {
    MusicFreeAlbumItem,
    MusicFreeArtistItem,
    MusicFreeMusicItem,
    MusicFreeQualityKey,
    MusicFreeSheetItem,
} from '../../types/musicFreePlugin';
import { parseEnhancedLRC, parseLRC } from '../../utils/lyrics/parserCore';
import { allowPluginMedia, decodePluginText, requestPluginNetwork } from './pluginNetwork';
import type { MountedMusicFreePlugin } from './pluginRuntime';
import { callPluginMethod } from './pluginRuntime';
import { createPluginPageReader, type PluginPageReader } from './pluginPaging';

// src/services/musicFreePlugins/pluginProvider.ts
// 一个已挂载的 MusicFree 插件，接成 Folia 的在线音源：搜索、取播放地址、歌词、歌单/专辑/歌手，以及
// 插件自己的榜单和推荐歌单。歌曲带 `sourceRef`（`musicfree.<平台>`），集合带同一个 `providerId`，
// 和内置平台一样经 omni 走。
//
// MusicFree 的分页是一页一页要的，页面大小由插件自己定；这里把它的页拼成 Folia 的 limit/offset，
// 所以搜索和多选的分页不会因为两边页大小不同而重复或漏歌。

export const MUSICFREE_PROVIDER_PREFIX = 'musicfree.';

/** 插件平台名 → Folia 的 provider id。 */
export const musicFreeProviderIdFor = (platform: string): string => `${MUSICFREE_PROVIDER_PREFIX}${platform}`;

export const isMusicFreeProviderId = (providerId: string): boolean => providerId.startsWith(MUSICFREE_PROVIDER_PREFIX);

const TOPLIST_PREFIX = 'toplist:';

const toQualityKey = (quality: AudioQualityPreference): MusicFreeQualityKey => {
    switch (quality) {
        case 'high':
        case 'ultra':
            return 'high';
        case 'lossless':
        case 'hires':
            return 'super';
        default:
            return 'standard';
    }
};

/** 先要用户选的那一档，拿不到再往下退：免费账号常常只有 standard。 */
const qualityCandidates = (quality: AudioQualityPreference): MusicFreeQualityKey[] => {
    const first = toQualityKey(quality);
    const fallbacks: Record<MusicFreeQualityKey, MusicFreeQualityKey[]> = {
        super: ['super', 'high', 'standard'],
        high: ['high', 'standard'],
        standard: ['standard', 'high'],
        low: ['low', 'standard'],
    };
    return fallbacks[first];
};

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

const asNumber = (value: unknown): number => {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
};

/** 插件列表里的歌：把插件还认得的字段留一份，取播放地址、歌词时要原样交回给它。 */
const rawSongCache = new Map<string, MusicFreeMusicItem>();
const RAW_SONG_LIMIT = 4000;

const rememberRawSong = (providerId: string, item: MusicFreeMusicItem): void => {
    if (!item || item.id === undefined || item.id === null) return;
    const key = `${providerId}:${String(item.id)}`;
    if (rawSongCache.has(key)) rawSongCache.delete(key);
    rawSongCache.set(key, item);
    if (rawSongCache.size > RAW_SONG_LIMIT) {
        const oldest = rawSongCache.keys().next().value;
        if (oldest !== undefined) rawSongCache.delete(oldest);
    }
};

const forgetProviderSongs = (providerId: string): void => {
    const prefix = `${providerId}:`;
    Array.from(rawSongCache.keys()).forEach(key => {
        if (key.startsWith(prefix)) rawSongCache.delete(key);
    });
};

const splitArtists = (artist: string): string[] => (
    artist
        .split(/\s*\/\s*/)
        .map(name => name.trim())
        .filter(Boolean)
);

const toUnifiedSong = (providerId: string, item: MusicFreeMusicItem): UnifiedSong => {
    rememberRawSong(providerId, item);
    const artistNames = splitArtists(asString(item.artist));
    const durationMs = Math.round(asNumber(item.duration) * 1000);
    const coverUrl = asString(item.artwork);
    return {
        id: String(item.id),
        name: asString(item.title),
        artists: artistNames.map(name => ({ id: '', name })),
        album: {
            id: '',
            name: asString(item.album),
            ...(coverUrl ? { coverUrl } : {}),
        },
        durationMs,
        sourceRef: {
            kind: 'online',
            providerId,
            mediaId: String(item.id),
        },
    };
};

/** 插件交回来的歌曲条目（导入单曲/歌单）→ Folia 的歌曲。 */
export const musicFreeSongsFromItems = (platform: string, items: MusicFreeMusicItem[]): UnifiedSong[] => {
    const providerId = musicFreeProviderIdFor(platform);
    return items
        .filter(item => Boolean(item) && item.id !== undefined && item.id !== null)
        .map(item => toUnifiedSong(providerId, item));
};

const toPluginSong = (providerId: string, song: SongResult): MusicFreeMusicItem => {    const mediaId = song.sourceRef?.kind === 'online' ? song.sourceRef.mediaId : String(song.id);
    const remembered = rawSongCache.get(`${providerId}:${mediaId}`);
    if (remembered) return remembered;
    return {
        id: String(mediaId),
        platform: providerId.slice(MUSICFREE_PROVIDER_PREFIX.length),
        title: song.name,
        artist: song.artists.map(artist => artist.name).join('/'),
        album: song.album?.name ?? '',
        artwork: song.album?.coverUrl ?? '',
        duration: Math.round((song.durationMs ?? 0) / 1000),
    };
};

/** 集合里存得下、读得回来的字段：插件下一次调用要用的那些原始字段不能丢。 */
const sanitizePayload = (value: unknown, depth = 0): JsonValue | undefined => {
    if (depth > 6) return undefined;
    if (value === null) return null;
    if (typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (Array.isArray(value)) {
        return value
            .slice(0, 100)
            .map(item => sanitizePayload(item, depth + 1))
            .filter((item): item is JsonValue => item !== undefined);
    }
    if (typeof value === 'object') {
        const out: Record<string, JsonValue> = {};
        Object.entries(value as Record<string, unknown>).slice(0, 64).forEach(([key, child]) => {
            const sanitized = sanitizePayload(child, depth + 1);
            if (sanitized !== undefined) out[key] = sanitized;
        });
        return out;
    }
    return undefined;
};

const sheetPayloadOf = (collection: ProviderCollection): MusicFreeSheetItem | null => {
    const payload = collection.providerData?.pluginPayload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    return payload as unknown as MusicFreeSheetItem;
};

const toSheetCollection = (
    providerId: string,
    raw: MusicFreeSheetItem,
    kind: 'sheet' | 'toplist',
): ProviderCollection => {
    const artwork = asString(raw.artwork) || asString(raw.coverImg);
    const payload = sanitizePayload(raw);
    return {
        providerId,
        id: kind === 'toplist' ? `${TOPLIST_PREFIX}${String(raw.id)}` : String(raw.id),
        name: asString(raw.title) || String(raw.id),
        type: 'playlist',
        ...(artwork ? { coverUrl: artwork } : {}),
        ...(asString(raw.description) ? { description: asString(raw.description) } : {}),
        ...(raw.worksNum !== undefined ? { trackCount: asNumber(raw.worksNum) } : {}),
        ...(asString(raw.artist) ? { creator: { id: '', nickname: asString(raw.artist) } } : {}),
        ...(payload !== undefined ? { providerData: { pluginKind: kind, pluginPayload: payload } } : {}),
    };
};

const toAlbumCollection = (providerId: string, raw: MusicFreeAlbumItem): ProviderCollection => {
    const artwork = asString(raw.artwork);
    const payload = sanitizePayload(raw);
    return {
        providerId,
        id: String(raw.id),
        name: asString(raw.title) || String(raw.id),
        type: 'album',
        ...(artwork ? { coverUrl: artwork } : {}),
        ...(asString(raw.artist) ? { creator: { id: '', nickname: asString(raw.artist) } } : {}),
        ...(raw.worksNum !== undefined ? { trackCount: asNumber(raw.worksNum) } : {}),
        ...(payload !== undefined ? { providerData: { pluginKind: 'album', pluginPayload: payload } } : {}),
    };
};

const toArtistCollection = (providerId: string, raw: MusicFreeArtistItem): ProviderCollection => {
    const avatar = asString(raw.avatar);
    const payload = sanitizePayload(raw);
    return {
        providerId,
        id: String(raw.id),
        name: asString(raw.name) || String(raw.id),
        type: 'artist',
        ...(avatar ? { coverUrl: avatar } : {}),
        ...(payload !== undefined ? { providerData: { pluginKind: 'artist', pluginPayload: payload } } : {}),
    };
};

const sheetItemOf = (collection: ProviderCollection | undefined, rawId: string, providerId: string): MusicFreeSheetItem => {
    const payload = collection ? sheetPayloadOf(collection) : null;
    if (payload) return { ...payload, id: rawId, platform: providerId.slice(MUSICFREE_PROVIDER_PREFIX.length) };
    return {
        id: rawId,
        platform: providerId.slice(MUSICFREE_PROVIDER_PREFIX.length),
        ...(collection?.name ? { title: collection.name } : {}),
        ...(collection?.coverUrl ? { artwork: collection.coverUrl } : {}),
        ...(collection?.description ? { description: collection.description } : {}),
    };
};

const albumItemOf = (collection: ProviderCollection | undefined, rawId: string, providerId: string): MusicFreeAlbumItem => {
    const payload = collection?.providerData?.pluginPayload;
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        return { ...(payload as unknown as MusicFreeAlbumItem), id: rawId, platform: providerId.slice(MUSICFREE_PROVIDER_PREFIX.length) };
    }
    return {
        id: rawId,
        platform: providerId.slice(MUSICFREE_PROVIDER_PREFIX.length),
        title: collection?.name ?? rawId,
        ...(collection?.coverUrl ? { artwork: collection.coverUrl } : {}),
    };
};

const artistItemOf = (collection: ProviderCollection | undefined, rawId: string, providerId: string): MusicFreeArtistItem => {
    const payload = collection?.providerData?.pluginPayload;
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        return { ...(payload as unknown as MusicFreeArtistItem), id: rawId, platform: providerId.slice(MUSICFREE_PROVIDER_PREFIX.length) };
    }
    return {
        id: rawId,
        platform: providerId.slice(MUSICFREE_PROVIDER_PREFIX.length),
        name: collection?.name ?? rawId,
    };
};

const decodeSheetId = (id: string): { kind: 'sheet' | 'toplist'; rawId: string } => (
    id.startsWith(TOPLIST_PREFIX)
        ? { kind: 'toplist', rawId: id.slice(TOPLIST_PREFIX.length) }
        : { kind: 'sheet', rawId: id }
);

const EMPTY_LYRICS: ProviderLyricsResult = { lyrics: null, isPureMusic: false };

const isEnhancedLyricText = (text: string): boolean => /<[0-9]{1,3}:[0-9]{2}[.:][0-9]{1,3}>/.test(text);

const colorFor = (seed: string): string => {
    let hash = 0;
    for (let index = 0; index < seed.length; index += 1) {
        hash = Math.imul(hash ^ seed.charCodeAt(index), 0x01000193);
    }
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue} 62% 52%)`;
};

const firstLetter = (label: string): string => {
    const trimmed = label.trim();
    if (!trimmed) return 'P';
    return Array.from(trimmed)[0] ?? 'P';
};

const SESSION_TTL_MS = 5 * 60_000;
const SESSION_LIMIT = 32;

interface PageSession<T> {
    at: number;
    reader: PluginPageReader<T>;
}

const createPageCache = <T>() => {
    const sessions = new Map<string, PageSession<T>>();
    return (key: string, create: () => PluginPageReader<T>): PluginPageReader<T> => {
        const now = Date.now();
        const existing = sessions.get(key);
        if (existing && now - existing.at < SESSION_TTL_MS) return existing.reader;
        // 过期的、多于上限的会话先清掉，Map 的迭代顺序就是从旧到新。
        for (const [sessionKey, session] of sessions) {
            if (now - session.at < SESSION_TTL_MS && sessions.size < SESSION_LIMIT) break;
            if (sessionKey !== key) sessions.delete(sessionKey);
        }
        const reader = create();
        sessions.set(key, { at: now, reader });
        return reader;
    };
};

const emptyPage = <T>(offset: number): ProviderPage<T> => ({
    items: [],
    hasMore: false,
    nextOffset: offset,
});

export interface MusicFreeProviderOptions {
    /**
     * MusicFree 的「替代插件」：这个平台的播放地址由另一个插件解析时回它的挂载结果。
     * 每次取播放地址都重问一次，所以换了替代插件不用重新登记 provider。
     */
    resolveAlternative?: () => MountedMusicFreePlugin | null;
}

/**
 * 一个已挂载的插件 → 一个 `OnlineMusicProvider`。`platform` 是插件自己的平台名，出现在日志里。
 */
export const createMusicFreeProvider = (
    mounted: MountedMusicFreePlugin,
    platform: string,
    options: MusicFreeProviderOptions = {},
): OnlineMusicProvider => {
    const providerId = musicFreeProviderIdFor(platform);
    const definition = mounted.definition;
    const methods = mounted.methods;
    const has = (method: string) => methods.has(method);
    const call = <T>(method: string, run: () => Promise<T> | T): Promise<T> => (
        callPluginMethod(platform, method, run)
    );

    const musicPages = createPageCache<MusicFreeMusicItem>();

    const searchPageReader = (query: string): PluginPageReader<MusicFreeMusicItem> => musicPages(
        `search:${query}`,
        () => createPluginPageReader<MusicFreeMusicItem>(async page => {
            const answer = await call('search', () => definition.search!(query, page, 'music'));
            return {
                items: Array.isArray(answer?.data) ? answer.data.filter(Boolean) : [],
                isEnd: answer?.isEnd !== false,
            };
        }),
    );

    const sheetTracksReader = (collection: ProviderCollection, kind: 'sheet' | 'toplist', rawId: string): PluginPageReader<MusicFreeMusicItem> => musicPages(
        `sheet:${kind}:${rawId}`,
        () => createPluginPageReader<MusicFreeMusicItem>(async page => {
            if (kind === 'toplist') {
                if (!definition.getTopListDetail) return { items: [], isEnd: true };
                const answer = await call('getTopListDetail', () => definition.getTopListDetail!(sheetItemOf(collection, rawId, providerId), page));
                return {
                    items: Array.isArray(answer?.musicList) ? answer.musicList.filter(Boolean) : [],
                    isEnd: answer?.isEnd !== false,
                };
            }
            if (!definition.getMusicSheetInfo) return { items: [], isEnd: true };
            const answer = await call('getMusicSheetInfo', () => definition.getMusicSheetInfo!(sheetItemOf(collection, rawId, providerId), page));
            return {
                items: Array.isArray(answer?.musicList) ? answer.musicList.filter(Boolean) : [],
                isEnd: answer?.isEnd !== false,
            };
        }),
    );

    const albumTracksReader = (collection: ProviderCollection, rawId: string): PluginPageReader<MusicFreeMusicItem> => musicPages(
        `album:${rawId}`,
        () => createPluginPageReader<MusicFreeMusicItem>(async page => {
            if (!definition.getAlbumInfo) return { items: [], isEnd: true };
            const answer = await call('getAlbumInfo', () => definition.getAlbumInfo!(albumItemOf(collection, rawId, providerId), page));
            return {
                items: Array.isArray(answer?.musicList) ? answer.musicList.filter(Boolean) : [],
                isEnd: answer?.isEnd !== false,
            };
        }),
    );

    const artistWorksReader = (rawId: string, type: 'music' | 'album'): PluginPageReader<MusicFreeMusicItem | MusicFreeAlbumItem> => (
        // 歌手目录的原始条目没有地方存，只能按 id 重建；多数插件的 getArtistWorks 只用 id。
        musicPages(`artist:${rawId}:${type}`, () => createPluginPageReader(async page => {
            if (!definition.getArtistWorks) return { items: [], isEnd: true };
            const answer = await call('getArtistWorks', () => definition.getArtistWorks!(
                artistItemOf(undefined, rawId, providerId),
                page,
                type,
            ));
            return {
                items: Array.isArray(answer?.data) ? answer.data.filter(Boolean) : [],
                isEnd: answer?.isEnd !== false,
            };
        })) as PluginPageReader<MusicFreeMusicItem | MusicFreeAlbumItem>
    );

    const getAudioSourceFor = async (
        song: SongResult,
        quality: AudioQualityPreference,
    ): Promise<ProviderAudioSource | null> => {
        const item = toPluginSong(providerId, song);
        // MusicFree 的替代插件：配了、且那个插件能取播放地址，就只由它解析（和 MusicFree 一样不再回退到本插件）。
        const alternative = options.resolveAlternative?.() ?? null;
        const parser = alternative?.definition.getMediaSource ? alternative : mounted;
        const parserDefinition = parser.definition;
        const parserLabel = parser.definition.platform || platform;
        let lastError: unknown = null;
        for (const candidate of qualityCandidates(quality)) {
            let answer: { url?: string; headers?: Record<string, string>; userAgent?: string } | null = null;
            if (parserDefinition.getMediaSource) {
                try {
                    answer = await callPluginMethod(
                        parserLabel,
                        'getMediaSource',
                        () => parserDefinition.getMediaSource!(item, candidate),
                    );
                } catch (error) {
                    lastError = error;
                    continue;
                }
            }
            const qualities = (item as { qualities?: Partial<Record<MusicFreeQualityKey, { url?: string }>> }).qualities;
            const url = asString(answer?.url) || asString(qualities?.[candidate]?.url) || (candidate === 'standard' ? asString(item.url) : '');
            if (!url) continue;
            const headers = { ...(answer?.headers ?? {}) };
            if (answer?.userAgent) headers['User-Agent'] = answer.userAgent;
            // 主进程给这个地址补 CORS 头、带上插件要求的请求头：音频元素带 crossOrigin 载入时需要它。
            await allowPluginMedia(url, Object.keys(headers).length > 0 ? headers : undefined);
            return {
                url,
                fetchedAt: Date.now(),
                quality,
            };
        }
        if (lastError) throw lastError;
        return null;
    };

    const getLyricsFor = async (song: SongResult): Promise<ProviderLyricsResult> => {
        if (!definition.getLyric) return EMPTY_LYRICS;
        const answer = await call('getLyric', () => definition.getLyric!(toPluginSong(providerId, song)));
        if (!answer) return EMPTY_LYRICS;
        let rawLrc = asString(answer.rawLrc);
        const translation = asString(answer.translation);
        if (!rawLrc.trim() && /^https?:\/\//i.test(asString(answer.lrc))) {
            // MusicFree 的旧字段：给的是歌词文件的地址。
            const response = await requestPluginNetwork({ url: asString(answer.lrc) });
            rawLrc = decodePluginText(response.bytes, response.headers['content-type']);
        }
        if (!rawLrc.trim()) return EMPTY_LYRICS;
        const enhanced = isEnhancedLyricText(rawLrc);
        const lyrics = enhanced ? parseEnhancedLRC(rawLrc, translation) : parseLRC(rawLrc, translation);
        return {
            lyrics,
            mainText: enhanced ? null : rawLrc,
            wordByWordText: enhanced ? rawLrc : null,
            translationText: translation || null,
            isPureMusic: false,
        };
    };

    const sheetInfoOf = async (collection: ProviderCollection, kind: 'sheet' | 'toplist', rawId: string): Promise<ProviderCollection | null> => {
        const answer = kind === 'toplist'
            ? (definition.getTopListDetail
                ? await call('getTopListDetail', () => definition.getTopListDetail!(sheetItemOf(collection, rawId, providerId), 1))
                : null)
            : (definition.getMusicSheetInfo
                ? await call('getMusicSheetInfo', () => definition.getMusicSheetInfo!(sheetItemOf(collection, rawId, providerId), 1))
                : null);
        const item = kind === 'toplist'
            ? (answer as { topListItem?: MusicFreeSheetItem } | null)?.topListItem
            : (answer as { sheetItem?: MusicFreeSheetItem } | null)?.sheetItem;
        if (!item) return collection;
        const next = toSheetCollection(providerId, { ...item, id: rawId }, kind);
        return {
            ...collection,
            ...next,
            // 从商店读出来的原始条目继续带着，下一次翻页还要用。
            ...(collection.providerData ? { providerData: collection.providerData } : {}),
        };
    };

    const albumDetailOf = async (collection: ProviderCollection, rawId: string): Promise<ProviderCollection | null> => {
        if (!definition.getAlbumInfo) return collection;
        const answer = await call('getAlbumInfo', () => definition.getAlbumInfo!(albumItemOf(collection, rawId, providerId), 1));
        if (!answer?.albumItem) return collection;
        return { ...collection, ...toAlbumCollection(providerId, { ...answer.albumItem, id: rawId }) };
    };

    const exploreFeed = async (): Promise<ProviderExplorePage> => {
        const sections: ProviderExploreSection[] = [];
        if (definition.getTopLists) {
            try {
                const groups = await call('getTopLists', () => definition.getTopLists!());
                (Array.isArray(groups) ? groups : []).forEach((group, index) => {
                    const items = Array.isArray(group?.data) ? group.data.filter(Boolean) : [];
                    if (items.length === 0) return;
                    sections.push({
                        id: `toplist-${index}`,
                        title: asString(group?.title),
                        items: items.map((item): ProviderExploreItem => ({
                            kind: 'collection',
                            collection: toSheetCollection(providerId, item, 'toplist'),
                        })),
                    });
                });
            } catch (error) {
                console.warn(`[MusicFreePlugins] ${platform}: getTopLists failed`, error);
            }
        }
        if (definition.getRecommendSheetTags) {
            try {
                const tags = await call('getRecommendSheetTags', () => definition.getRecommendSheetTags!());
                const pinned = Array.isArray(tags?.pinned) ? tags.pinned.filter(Boolean) : [];
                if (pinned.length > 0) {
                    sections.push({
                        id: 'recommend-pinned',
                        title: '',
                        items: pinned.map((sheet): ProviderExploreItem => ({
                            kind: 'collection',
                            collection: toSheetCollection(providerId, sheet, 'sheet'),
                        })),
                    });
                } else if (definition.getRecommendSheetsByTag) {
                    const firstGroup = Array.isArray(tags?.data) ? tags!.data!.find(group => Array.isArray(group?.data) && group.data.length > 0) : undefined;
                    const firstTag = firstGroup?.data?.[0];
                    if (firstTag) {
                        const answer = await call('getRecommendSheetsByTag', () => definition.getRecommendSheetsByTag!(
                            { ...firstTag, id: firstTag.id },
                            1,
                        ));
                        const sheets = Array.isArray(answer?.data) ? answer.data.filter(Boolean) : [];
                        if (sheets.length > 0) {
                            sections.push({
                                id: 'recommend-sheets',
                                title: asString(firstGroup?.title),
                                items: sheets.map((sheet): ProviderExploreItem => ({
                                    kind: 'collection',
                                    collection: toSheetCollection(providerId, sheet, 'sheet'),
                                })),
                            });
                        }
                    }
                }
            } catch (error) {
                console.warn(`[MusicFreePlugins] ${platform}: recommend sheets failed`, error);
            }
        }
        return { sections };
    };

    const capabilities: ProviderCapabilities = {
        search: has('search'),
        playback: true,
        lyrics: has('getLyric'),
        auth: false,
        userLibrary: false,
        playlists: has('getMusicSheetInfo') || has('getTopListDetail'),
        albums: has('getAlbumInfo'),
        artists: has('getArtistWorks'),
        recommendations: false,
        mutations: false,
        wordByWordLyrics: false,
        explore: has('getTopLists') || has('getRecommendSheetTags'),
    };

    const provider: OnlineMusicProvider = {
        id: providerId,
        displayName: platform,
        shortName: platform,
        mark: { letter: firstLetter(platform), color: colorFor(providerId) },
        capabilities,
        // 插件不按 Folia 的目录 id 说话，歌曲行里的歌手/专辑也就不做成可点的目录入口。
        catalog: {
            canResolveSongCatalogRefs: () => false,
            ...(capabilities.playlists ? {
                getPlaylistTracks: async (id, limit, offset, collection) => {
                    const { kind, rawId } = decodeSheetId(String(id));
                    const reader = sheetTracksReader(collection ?? { providerId, id: String(id), name: '', type: 'playlist' }, kind, rawId);
                    const page = await reader.read(limit, offset);
                    return {
                        items: page.items.map(item => toUnifiedSong(providerId, item)),
                        hasMore: page.hasMore,
                        nextOffset: page.nextOffset,
                    };
                },
                getPlaylistDetail: async (id, collection) => {
                    const { kind, rawId } = decodeSheetId(String(id));
                    return await sheetInfoOf(collection ?? { providerId, id: String(id), name: '', type: 'playlist' }, kind, rawId);
                },
            } : {}),
            ...(capabilities.albums ? {
                getAlbumTracks: async (id, limit = 50, offset = 0, collection) => {
                    const reader = albumTracksReader(collection ?? { providerId, id: String(id), name: '', type: 'album' }, String(id));
                    const page = await reader.read(limit, offset);
                    return {
                        items: page.items.map(item => toUnifiedSong(providerId, item)),
                        hasMore: page.hasMore,
                        nextOffset: page.nextOffset,
                    };
                },
                getAlbumDetail: async (id, collection) => await albumDetailOf(
                    collection ?? { providerId, id: String(id), name: '', type: 'album' },
                    String(id),
                ),
            } : {}),
            ...(capabilities.artists ? {
                getArtistSongs: async (id, limit, offset) => {
                    const reader = artistWorksReader(String(id), 'music');
                    const page = await reader.read(limit, offset);
                    return {
                        items: page.items.map(item => toUnifiedSong(providerId, item as MusicFreeMusicItem)),
                        hasMore: page.hasMore,
                        nextOffset: page.nextOffset,
                    };
                },
                getArtistAlbums: async (id, limit, offset) => {
                    const reader = artistWorksReader(String(id), 'album');
                    const page = await reader.read(limit, offset);
                    return {
                        items: page.items.map(item => toAlbumCollection(providerId, item as MusicFreeAlbumItem)),
                        hasMore: page.hasMore,
                        nextOffset: page.nextOffset,
                    };
                },
            } : {}),
        },
        normalizeSong: (raw) => {
            const candidate = raw as UnifiedSong;
            if (candidate?.sourceRef?.kind === 'online' && candidate.sourceRef.providerId === providerId) return candidate;
            if (!raw || typeof raw !== 'object') throw new Error(`${providerId}: cannot normalize a song`);
            return toUnifiedSong(providerId, raw as MusicFreeMusicItem);
        },
        songMetadata: {
            getSongMetadata: (song): ProviderSongMetadata => ({
                artists: song.artists.map(artist => ({ id: artist.id, name: artist.name })),
                album: {
                    id: song.album?.id ?? '',
                    name: song.album?.name ?? '',
                    ...(song.album?.coverUrl ? { coverUrl: song.album.coverUrl } : {}),
                },
                durationMs: song.durationMs ?? 0,
                ...(song.album?.coverUrl ? { coverUrl: song.album.coverUrl } : {}),
                aliases: song.aliases ?? [],
                translatedNames: song.translatedNames ?? [],
            }),
        },
        playback: {
            getSongDetail: async (id) => {
                if (!definition.getMusicInfo) return null;
                const info = await call('getMusicInfo', () => definition.getMusicInfo!({
                    id: String(id),
                    platform,
                }));
                if (!info) return null;
                return toUnifiedSong(providerId, {
                    ...info,
                    id: String(info.id ?? id),
                    platform,
                });
            },
            getAudioSource: getAudioSourceFor,
        },
        ...(capabilities.search ? {
            search: {
                searchSongs: async (query, limit, offset) => {
                    if (!definition.search) return emptyPage(offset);
                    const page = await searchPageReader(query).read(limit, offset);
                    return {
                        items: page.items.map(item => toUnifiedSong(providerId, item)),
                        hasMore: page.hasMore,
                        nextOffset: page.nextOffset,
                    };
                },
            },
        } : {}),
        ...(capabilities.lyrics ? { lyrics: { getLyrics: getLyricsFor } } : {}),
        ...(capabilities.explore ? { explore: { getFeed: exploreFeed } } : {}),
    };

    return provider;
};

/** 插件被关掉或卸载时，把它留在缓存里的原始条目一并清掉。 */
export const disposeMusicFreeProvider = (platform: string): void => {
    forgetProviderSongs(musicFreeProviderIdFor(platform));
};
