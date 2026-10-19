import { getFromCacheWithMigration, saveToCache } from '../services/db';
import { getSongResourceCacheKey } from '../services/onlineMusic/resourceKeys';
import type { OnlineLyricsState, SongResult } from '../types';
import type { MigrationResult } from './lyrics/renderHints';
import { migrateLyricDataRenderHints as migrateLyrics } from './lyrics/renderHints';
import { isPureMusicLyricText } from './lyrics/pureMusic';

// src/utils/onlineLyricsState.ts

const ONLINE_LYRICS_STATE_SUFFIX = '_state';

const migrateOnlineLyricsState = (value: OnlineLyricsState): MigrationResult<OnlineLyricsState> => {
    const importedMigration = migrateLyrics(value.importedLyrics);
    const overrideMigration = migrateLyrics(value.onlineOverrideLyrics);

    return {
        value: {
            ...value,
            importedLyrics: importedMigration.value,
            onlineOverrideLyrics: overrideMigration.value,
        },
        changed: importedMigration.changed || overrideMigration.changed,
    };
};

export const getOnlineLyricsStateCacheKey = (song: SongResult) =>
    `${getSongResourceCacheKey('lyric', song)}${ONLINE_LYRICS_STATE_SUFFIX}`;

export const loadOnlineLyricsState = async (song: SongResult): Promise<OnlineLyricsState | null> => {
    const key = getOnlineLyricsStateCacheKey(song);
    return getFromCacheWithMigration<OnlineLyricsState>(key, migrateOnlineLyricsState);
};

export const saveOnlineLyricsState = async (song: SongResult, state: OnlineLyricsState): Promise<void> => {
    const key = getOnlineLyricsStateCacheKey(song);
    await saveToCache(key, migrateOnlineLyricsState(state).value);
};

export const resolveOnlineLyrics = (
    state: OnlineLyricsState | null | undefined,
    fallbackLyrics: OnlineLyricsState['onlineOverrideLyrics']
) => {
    if (!state) {
        return fallbackLyrics ?? null;
    }

    if (state.lyricsSource === 'imported' && state.importedLyrics) {
        return state.importedLyrics;
    }

    if (state.hasOnlineOverride) {
        return state.onlineOverrideLyrics ?? null;
    }

    return fallbackLyrics ?? null;
};

/**
 * 这个覆盖状态是不是真的「锁定了歌词」：要么带着歌词、要么明确标记成纯音乐。历史数据里可能
 * 留下 `hasOnlineOverride: true` 却两者皆空的半截状态（某次保存中断、旧版逻辑），它会让
 * `shouldAutoMatch` 的 `!hasOnlineOverride` 第一道闸把自动匹配永远挡在门外，同时 `resolveOnlineLyrics`
 * 又返回 null——结果就是「怎么都不出歌词」。这种覆盖不算覆盖，应当允许重新匹配。
 */
export const hasUsableOnlineOverride = (state: OnlineLyricsState | null | undefined): boolean => (
    Boolean(state?.hasOnlineOverride)
    && (Boolean(state?.onlineOverrideLyrics) || state?.matchedIsPureMusic === true)
);

/**
 * Whether the stored lyrics mean "instrumental", decided the way cached playback decides it:
 * an online match that recorded a verdict is trusted as-is; anything else (an imported file, or a
 * match from before the verdict was stored) falls back to reading the lyric text.
 */
export const resolveOnlineLyricsPureMusic = (
    state: OnlineLyricsState | null | undefined,
    lyricsText: string,
): boolean => (
    state?.lyricsSource === 'online' && typeof state.matchedIsPureMusic === 'boolean'
        ? state.matchedIsPureMusic
        : isPureMusicLyricText(lyricsText)
);

export const getOnlineLyricsSourceLabel = (state: OnlineLyricsState | null | undefined): 'online' | 'imported' =>
    state?.lyricsSource === 'imported' ? 'imported' : 'online';

/**
 * The state to store once auto-match has concluded a track simply has no lyrics.
 *
 * "Every source agrees this one is instrumental" is an ANSWER and has to be persisted like any
 * other match. Storing nothing leaves `hasOnlineOverride` false, which is the flag that decides
 * whether to auto-match at all - so the full multi-provider search runs again on every prefetch
 * pass and every play, forever, for every instrumental in the library.
 *
 * Merged onto whatever was already there rather than replacing it: an imported selection stays
 * imported, and `resolveOnlineLyrics` keeps preferring it, so a background auto-match can never
 * take the listener's own choice away.
 */
export const markOnlineLyricsPureMusic = (
    previous: OnlineLyricsState | null | undefined,
): OnlineLyricsState => ({
    ...previous,
    lyricsSource: previous?.lyricsSource ?? 'online',
    hasOnlineOverride: true,
    // The override IS "there are none". Spelled out rather than left undefined so the stored state
    // reads the same way `resolveOnlineLyrics` will read it.
    onlineOverrideLyrics: null,
    matchedIsPureMusic: true,
});
