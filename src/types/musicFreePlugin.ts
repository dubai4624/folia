// src/types/musicFreePlugin.ts
// The contract of a MusicFree plugin, as far as this host reads it: the members a plugin's
// `module.exports` may carry (ported from MusicFree's types/plugin.d.ts) and the shapes its methods
// answer with. Everything outside these declarations is the plugin's own business and is kept only
// so a song can be handed back to the method that made it.

/** The quality keys a MusicFree plugin is asked for; Folia's five levels are mapped onto these. */
export type MusicFreeQualityKey = 'low' | 'standard' | 'high' | 'super';

/** A music item, as a plugin answers with it. */
export interface MusicFreeMusicItem {
    id: string;
    platform: string;
    title?: string;
    artist?: string;
    album?: string;
    artwork?: string;
    /** Seconds. */
    duration?: number;
    url?: string;
    /** Field `primaryKey` of the item; a part of its identity. */
    [key: string]: unknown;
}

/** A playlist or toplist entry, as a plugin answers with it. */
export interface MusicFreeSheetItem {
    id: string;
    platform: string;
    title?: string;
    artist?: string;
    artwork?: string;
    coverImg?: string;
    description?: string;
    /** How many works the sheet holds. */
    worksNum?: number;
    [key: string]: unknown;
}

/** An album entry, as a plugin answers with it. */
export interface MusicFreeAlbumItem {
    id: string;
    platform: string;
    title: string;
    artist?: string;
    artwork?: string;
    description?: string;
    worksNum?: number;
    [key: string]: unknown;
}

/** An artist entry, as a plugin answers with it. */
export interface MusicFreeArtistItem {
    id: string;
    platform: string;
    name: string;
    avatar?: string;
    description?: string;
    worksNum?: number;
    [key: string]: unknown;
}

export interface MusicFreeMediaSource {
    url?: string;
    headers?: Record<string, string>;
    userAgent?: string;
    quality?: MusicFreeQualityKey;
}

export interface MusicFreeLyricSource {
    /** Raw lyric text, LRC or enhanced LRC. */
    rawLrc?: string;
    /** Translation lyric text. */
    translation?: string;
    /** Deprecated in MusicFree: a URL to the lyric file. */
    lrc?: string;
}

/** A user setting a plugin declares; the values are kept by this host and handed to the plugin. */
export interface MusicFreeUserVariable {
    key: string;
    name?: string;
    hint?: string;
}

export interface MusicFreePage<T> {
    isEnd?: boolean;
    data?: T[];
}

export interface MusicFreeSheetGroup {
    title?: string;
    data?: MusicFreeSheetItem[];
}

export interface MusicFreeTopListResult {
    isEnd?: boolean;
    topListItem?: MusicFreeSheetItem;
    musicList?: MusicFreeMusicItem[];
}

export interface MusicFreeSheetInfoResult {
    isEnd?: boolean;
    sheetItem?: MusicFreeSheetItem;
    musicList?: MusicFreeMusicItem[];
}

export interface MusicFreeAlbumInfoResult {
    isEnd?: boolean;
    albumItem?: MusicFreeAlbumItem;
    musicList?: MusicFreeMusicItem[];
}

export interface MusicFreeRecommendTagsResult {
    pinned?: MusicFreeSheetItem[];
    data?: MusicFreeSheetGroup[];
}

/**
 * What a plugin exports. Only the members this host calls are typed; the rest stays unknown on
 * purpose, since plugins are free to publish more.
 */
export interface MusicFreePluginDefinition {
    /** The plugin's name: its platform, and how every song it answers with says where it came from. */
    platform: string;
    version?: string;
    author?: string;
    description?: string;
    srcUrl?: string;
    cacheControl?: 'cache' | 'no-cache' | 'no-store';
    defaultSearchType?: string;
    supportedSearchType?: string[];
    userVariables?: MusicFreeUserVariable[];
    search?: (query: string, page: number, type: string) => Promise<MusicFreePage<MusicFreeMusicItem>>;
    getMediaSource?: (musicItem: MusicFreeMusicItem, quality: MusicFreeQualityKey) => Promise<MusicFreeMediaSource | null>;
    getMusicInfo?: (musicBase: { id: string; platform: string }) => Promise<Partial<MusicFreeMusicItem> | null>;
    getLyric?: (musicItem: MusicFreeMusicItem) => Promise<MusicFreeLyricSource | null>;
    getAlbumInfo?: (albumItem: MusicFreeAlbumItem, page: number) => Promise<MusicFreeAlbumInfoResult | null>;
    getMusicSheetInfo?: (sheetItem: MusicFreeSheetItem, page: number) => Promise<MusicFreeSheetInfoResult | null>;
    getArtistWorks?: (
        artistItem: MusicFreeArtistItem,
        page: number,
        type: string,
    ) => Promise<MusicFreePage<MusicFreeMusicItem | MusicFreeAlbumItem>>;
    getTopLists?: () => Promise<MusicFreeSheetGroup[]>;
    getTopListDetail?: (topListItem: MusicFreeSheetItem, page: number) => Promise<MusicFreeTopListResult>;
    getRecommendSheetTags?: () => Promise<MusicFreeRecommendTagsResult>;
    getRecommendSheetsByTag?: (
        tag: { id: string; [key: string]: unknown },
        page?: number,
    ) => Promise<MusicFreePage<MusicFreeSheetItem>>;
    importMusicItem?: (urlLike: string) => Promise<MusicFreeMusicItem | null>;
    importMusicSheet?: (urlLike: string) => Promise<MusicFreeMusicItem[] | null>;
    [key: string]: unknown;
}

/** One installed plugin, as it is kept on disk. */
export interface MusicFreeStoredPlugin {
    /** SHA-256 of the code: the plugin's identity in the store. */
    hash: string;
    /** The plugin's platform, read off its code. */
    platform: string;
    version: string;
    author: string;
    description: string;
    /** Where the code was installed from; empty for a pasted code or a picked file. */
    srcUrl: string;
    code: string;
    installedAt: number;
}

/** The state kept beside the code: what the user chose about each plugin. */
export interface MusicFreePluginMeta {
    /** Platform → its place among the plugin sources. */
    order: Record<string, number>;
    /** Platforms turned off. */
    disabled: string[];
    /** Platform → the values of the variables it declares. */
    variables: Record<string, Record<string, string>>;
    /** Platform → the plugin that resolves its playback instead (MusicFree's alternative plugin). */
    alternative: Record<string, string>;
}

/** Why an install or an update did not finish. The UI words each one. */
export type MusicFreePluginFailureCode =
    | 'empty-code'
    | 'not-a-plugin'
    | 'unsupported-runtime'
    | 'fetch-failed'
    | 'code-unreadable'
    | 'file-unreadable'
    | 'storage-full'
    | 'no-update-source'
    | 'already-installed';

export interface MusicFreeInstallResult {
    ok: boolean;
    /** Failure code; absent when `ok`. */
    code?: MusicFreePluginFailureCode;
    /** Raw text from outside the app: a network error, a plugin's own message. */
    detail?: string;
    platform?: string;
    /** The address the code came from, for the failure line of a URL install. */
    url?: string;
}

/** One row of the plugin manager. */
export interface MusicFreePluginSummary {
    hash: string;
    platform: string;
    version: string;
    author: string;
    description: string;
    srcUrl: string;
    /** Turned on by the user. */
    enabled: boolean;
    /** The code parsed and its source is registered. */
    ready: boolean;
    /** Why the code could not be used; null when it could. */
    error: string | null;
    /** The methods the plugin publishes, in the order this host knows them. */
    methods: string[];
    /** The variables the plugin declares. */
    userVariables: MusicFreeUserVariable[];
    /** Their values. */
    variables: Record<string, string>;
    /** The platform whose plugin resolves playback for this one; empty when it resolves its own. */
    alternative: string;
    /** Where it stands among the plugin sources. */
    order: number;
}
