import type { MusicFreePluginMeta, MusicFreeStoredPlugin } from '../../types/musicFreePlugin';

// src/services/musicFreePlugins/pluginStore.ts
// 插件装上以后留在浏览器存储里的三样东西：插件的代码（`folia_musicfree_plugins_v1`）、用户对每个
// 插件的选择（`folia_musicfree_plugin_meta_v1`：启用、排序、变量）、订阅地址
// （`folia_musicfree_plugin_subscriptions_v1`）。键归这个功能自己，不进 `src/stores` 的契约快照。
//
// 读一律容错：存的东西被手改坏、配额满了、localStorage 整个不可用，都只当没有，不让应用起不来。

export const PLUGIN_STORAGE_KEY = 'folia_musicfree_plugins_v1';
export const PLUGIN_META_STORAGE_KEY = 'folia_musicfree_plugin_meta_v1';
export const PLUGIN_SUBSCRIPTIONS_STORAGE_KEY = 'folia_musicfree_plugin_subscriptions_v1';

const getStorage = (): Storage | null => {
    try {
        if (typeof window === 'undefined' || !window.localStorage) return null;
        return window.localStorage;
    } catch {
        return null;
    }
};

const readJson = (key: string): unknown => {
    const storage = getStorage();
    if (!storage) return null;
    try {
        const raw = storage.getItem(key);
        if (!raw) return null;
        return JSON.parse(raw) as unknown;
    } catch (error) {
        console.warn(`[MusicFreePlugins] Could not read "${key}"`, error);
        return null;
    }
};

const writeJson = (key: string, value: unknown): boolean => {
    const storage = getStorage();
    if (!storage) return false;
    try {
        storage.setItem(key, JSON.stringify(value));
        return true;
    } catch (error) {
        console.warn(`[MusicFreePlugins] Could not write "${key}"`, error);
        return false;
    }
};

const isStoredPlugin = (value: unknown): value is MusicFreeStoredPlugin => {
    const plugin = value as MusicFreeStoredPlugin | null;
    return Boolean(plugin)
        && typeof plugin?.hash === 'string'
        && plugin.hash.length > 0
        && typeof plugin.platform === 'string'
        && plugin.platform.length > 0
        && typeof plugin.code === 'string'
        && plugin.code.length > 0;
};

/** Every installed plugin, newest read. A malformed entry is dropped, the rest still load. */
export const readStoredPlugins = (): MusicFreeStoredPlugin[] => {
    const raw = readJson(PLUGIN_STORAGE_KEY);
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    return raw.filter((entry): entry is MusicFreeStoredPlugin => {
        if (!isStoredPlugin(entry) || seen.has(entry.hash)) return false;
        seen.add(entry.hash);
        return true;
    }).map(entry => ({
        hash: entry.hash,
        platform: entry.platform,
        version: typeof entry.version === 'string' ? entry.version : '',
        author: typeof entry.author === 'string' ? entry.author : '',
        description: typeof entry.description === 'string' ? entry.description : '',
        srcUrl: typeof entry.srcUrl === 'string' ? entry.srcUrl : '',
        code: entry.code,
        installedAt: Number.isFinite(entry.installedAt) ? entry.installedAt : 0,
    }));
};

/** Saves the list; false means the storage refused it (full, or blocked). */
export const writeStoredPlugins = (plugins: MusicFreeStoredPlugin[]): boolean => writeJson(PLUGIN_STORAGE_KEY, plugins);

const isStringRecord = (value: unknown): value is Record<string, string> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return Object.values(value as Record<string, unknown>).every(item => typeof item === 'string');
};

export const readPluginMeta = (): MusicFreePluginMeta => {
    const raw = readJson(PLUGIN_META_STORAGE_KEY);
    const meta: MusicFreePluginMeta = { order: {}, disabled: [], variables: {}, alternative: {} };
    if (!raw || typeof raw !== 'object') return meta;
    const source = raw as Partial<MusicFreePluginMeta>;
    if (source.order && typeof source.order === 'object' && !Array.isArray(source.order)) {
        Object.entries(source.order).forEach(([platform, value]) => {
            if (typeof value === 'number' && Number.isFinite(value)) meta.order[platform] = value;
        });
    }
    if (Array.isArray(source.disabled)) {
        meta.disabled = source.disabled.filter((platform): platform is string => typeof platform === 'string');
    }
    if (source.variables && typeof source.variables === 'object' && !Array.isArray(source.variables)) {
        Object.entries(source.variables).forEach(([platform, values]) => {
            if (isStringRecord(values)) meta.variables[platform] = { ...values };
        });
    }
    if (source.alternative && typeof source.alternative === 'object' && !Array.isArray(source.alternative)) {
        Object.entries(source.alternative).forEach(([platform, value]) => {
            if (typeof value === 'string' && value) meta.alternative[platform] = value;
        });
    }
    return meta;
};

/** Saves the choices; false means the storage refused them. */
export const writePluginMeta = (meta: MusicFreePluginMeta): boolean => writeJson(PLUGIN_META_STORAGE_KEY, meta);

export const readPluginSubscriptions = (): string[] => {
    const raw = readJson(PLUGIN_SUBSCRIPTIONS_STORAGE_KEY);
    if (!Array.isArray(raw)) return [];
    return raw.filter((url): url is string => typeof url === 'string' && /^https?:\/\//i.test(url));
};

/** Saves the subscription list; false means the storage refused it. */
export const writePluginSubscriptions = (urls: string[]): boolean => writeJson(PLUGIN_SUBSCRIPTIONS_STORAGE_KEY, urls);
