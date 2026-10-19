import {
    listOnlineMusicProviders,
    registerOnlineMusicProvider,
    setOnlineMusicProviderOrder,
    unregisterOnlineMusicProvider,
} from '../onlineMusic/providerRegistry';
import type { MusicFreeInstallResult, MusicFreePluginMeta, MusicFreePluginSummary, MusicFreeStoredPlugin } from '../../types/musicFreePlugin';
import { errorMessage } from '../../utils/errorText';
import { decodePluginText, requestPluginNetwork } from './pluginNetwork';
import {
    MUSICFREE_PROVIDER_PREFIX,
    createMusicFreeProvider,
    disposeMusicFreeProvider,
    isMusicFreeProviderId,
    musicFreeProviderIdFor,
    musicFreeSongsFromItems,
} from './pluginProvider';
import type { UnifiedSong } from '../../types';
import type { OnlineMusicProvider } from '../../types/onlineMusic';
import {
    MUSICFREE_HOST_APP_VERSION,
    callPluginMethod,
    hashPluginCode,
    mountMusicFreePlugin,
    type MountedMusicFreePlugin,
} from './pluginRuntime';
import {
    readPluginMeta,
    readPluginSubscriptions,
    readStoredPlugins,
    writePluginMeta,
    writePluginSubscriptions,
    writeStoredPlugins,
} from './pluginStore';

// src/services/musicFreePlugins/pluginHost.ts
// 插件管理器的全部动作：装、更新、卸、启用/停用、排序、用户变量、订阅地址，以及把装好的插件登记成
// Folia 的在线音源。界面对它只做两件事：读 `list()` 的快照（`subscribe` 之后变化会通知），和调用
// 这里的动作。装好的插件在应用起来之前（bootstrap）就挂好并登记，首屏的在线平台列表里就有它们。

/** 插件方法 → 在插件管理里显示的名字。没列出来的方法按原名显示。 */
const METHOD_ORDER = [
    'search',
    'getMediaSource',
    'getMusicInfo',
    'getLyric',
    'getMusicSheetInfo',
    'getTopListDetail',
    'getTopLists',
    'getRecommendSheetTags',
    'getRecommendSheetsByTag',
    'getAlbumInfo',
    'getArtistWorks',
    'importMusicItem',
    'importMusicSheet',
];

interface PluginEntry {
    record: MusicFreeStoredPlugin;
    mounted: MountedMusicFreePlugin | null;
    error: string | null;
}

let entries: PluginEntry[] = [];
let meta: MusicFreePluginMeta = { order: {}, disabled: [], variables: {}, alternative: {} };
let snapshot: MusicFreePluginSummary[] = [];
let started = false;
const listeners = new Set<() => void>();
interface RegisteredPluginProvider {
    provider: OnlineMusicProvider;
    /** 登记时挂的是哪一份插件代码；更新插件后它变了，要原位换掉。 */
    mounted: MountedMusicFreePlugin;
}

/** 当前登记在 providerRegistry 里的插件 provider，按 provider id 记。 */
const registeredProviders = new Map<string, RegisteredPluginProvider>();

const platformOf = (entry: PluginEntry): string => entry.mounted?.definition.platform ?? entry.record.platform;

const isEnabled = (platform: string): boolean => !meta.disabled.includes(platform);

const orderOf = (platform: string): number => {
    const order = meta.order[platform];
    return typeof order === 'number' && Number.isFinite(order) ? order : Number.POSITIVE_INFINITY;
};

const sortEntries = (list: PluginEntry[]): PluginEntry[] => (
    [...list].sort((left, right) => {
        const difference = orderOf(platformOf(left)) - orderOf(platformOf(right));
        if (difference !== 0) return difference;
        if (left.record.installedAt !== right.record.installedAt) return left.record.installedAt - right.record.installedAt;
        return platformOf(left).localeCompare(platformOf(right));
    })
);

const methodsOf = (entry: PluginEntry): string[] => {
    const mountedMethods = entry.mounted?.methods;
    if (!mountedMethods) return [];
    const known = METHOD_ORDER.filter(method => mountedMethods.has(method));
    const rest = Array.from(mountedMethods).filter(method => !METHOD_ORDER.includes(method)).sort();
    return [...known, ...rest];
};

const buildSnapshot = (): MusicFreePluginSummary[] => sortEntries(entries).map((entry, index) => {
    const platform = platformOf(entry);
    return {
        hash: entry.record.hash,
        platform,
        version: entry.mounted ? String(entry.mounted.definition.version ?? entry.record.version ?? '') : entry.record.version,
        author: entry.mounted ? String(entry.mounted.definition.author ?? entry.record.author ?? '') : entry.record.author,
        description: entry.mounted ? String(entry.mounted.definition.description ?? entry.record.description ?? '') : entry.record.description,
        srcUrl: entry.record.srcUrl,
        enabled: isEnabled(platform),
        ready: Boolean(entry.mounted),
        error: entry.error,
        methods: methodsOf(entry),
        userVariables: entry.mounted?.userVariables ?? [],
        variables: { ...(meta.variables[platform] ?? {}) },
        alternative: meta.alternative[platform] ?? '',
        order: index,
    };
});

const enabledEntryByPlatform = (platform: string): PluginEntry | null => (
    entries.find(entry => platformOf(entry) === platform && entry.mounted && isEnabled(platform)) ?? null
);

/** 这个平台配置的替代插件，只在它还在、还启用、还能取播放地址时算数。 */
const resolveAlternativeFor = (platform: string): MountedMusicFreePlugin | null => {
    const alternativePlatform = meta.alternative[platform];
    if (!alternativePlatform || alternativePlatform === platform) return null;
    const entry = enabledEntryByPlatform(alternativePlatform);
    return entry?.mounted?.definition.getMediaSource ? entry.mounted : null;
};

const syncRegistrations = (): void => {
    const desired = sortEntries(entries).filter(entry => Boolean(entry.mounted) && isEnabled(platformOf(entry)));
    const desiredProviderIds = new Set(desired.map(entry => musicFreeProviderIdFor(platformOf(entry))));

    // 先登记新的、换掉更新过的：替换或更新插件时 registry 不会出现空档，正在用的平台也不会因此回落到默认平台。
    desired.forEach(entry => {
        const platform = platformOf(entry);
        const providerId = musicFreeProviderIdFor(platform);
        const mounted = entry.mounted!;
        const existing = registeredProviders.get(providerId);
        if (existing?.mounted === mounted) return;
        const provider = createMusicFreeProvider(mounted, platform, {
            // 播放地址由替代插件解析：每次取地址都重问，换设置不用重新登记。
            resolveAlternative: () => resolveAlternativeFor(platform),
        });
        // 同一个 provider id 再登记一次是原位替换：顺序不变，读的人不会看到它暂时不在。
        registerOnlineMusicProvider(provider);
        registeredProviders.set(providerId, { provider, mounted });
    });

    // 再撤掉不该在的（停用、卸载、代码解析不了），并清掉它留在内存里的原始条目。
    Array.from(registeredProviders.keys()).forEach(providerId => {
        if (desiredProviderIds.has(providerId)) return;
        unregisterOnlineMusicProvider(providerId);
        registeredProviders.delete(providerId);
        disposeMusicFreeProvider(providerId.slice(MUSICFREE_PROVIDER_PREFIX.length));
    });

    // 顺序：内置平台保持原样，插件按用户的排序接在后面。整份重排一次、只通知一次。
    const currentIds = listOnlineMusicProviders().map(provider => provider.id);
    const builtInIds = currentIds.filter(providerId => !isMusicFreeProviderId(providerId));
    const desiredOrder = [...builtInIds, ...desired.map(entry => musicFreeProviderIdFor(platformOf(entry)))];
    const orderChanged = desiredOrder.length !== currentIds.length
        || desiredOrder.some((providerId, index) => currentIds[index] !== providerId);
    if (orderChanged) setOnlineMusicProviderOrder(desiredOrder);
};

const announce = (): void => {
    snapshot = buildSnapshot();
    listeners.forEach(listener => {
        try {
            listener();
        } catch (error) {
            console.warn('[MusicFreePlugins] A plugin manager listener failed', error);
        }
    });
};

const persistMeta = (): void => {
    if (!writePluginMeta(meta)) {
        console.warn('[MusicFreePlugins] Could not save the plugin manager choices');
    }
};

const persistPlugins = (): boolean => writeStoredPlugins(entries.map(entry => entry.record));

const mountEntry = (record: MusicFreeStoredPlugin): PluginEntry => {
    try {
        const mounted = mountMusicFreePlugin(record.code, {
            getVariables: () => ({ ...(meta.variables[record.platform] ?? {}) }),
            label: record.platform,
        });
        return { record: { ...record, platform: mounted.definition.platform }, mounted, error: null };
    } catch (error) {
        console.warn(`[MusicFreePlugins] ${record.platform}: could not load the plugin`, error);
        return { record, mounted: null, error: errorMessage(error) };
    }
};

const ensureStarted = (): void => {
    if (started) return;
    started = true;
    meta = readPluginMeta();
    entries = readStoredPlugins().map(record => mountEntry(record));
    syncRegistrations();
    announce();
};

const nextOrder = (): number => {
    const used = Object.values(meta.order).filter(value => Number.isFinite(value));
    return used.length > 0 ? Math.max(...used) + 1 : 0;
};

const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * Installs a plugin from its code. Installing the same code again is a no-op; installing another
 * version of the same platform replaces it and keeps the user's choices for that platform.
 */
const installCode = async (code: string, srcUrl: string): Promise<MusicFreeInstallResult> => {
    ensureStarted();
    const trimmed = code.trim();
    if (!trimmed) return { ok: false, code: 'empty-code' };
    let probe: MountedMusicFreePlugin;
    try {
        probe = mountMusicFreePlugin(trimmed, { getVariables: () => ({}), label: 'new plugin' });
    } catch (error) {
        return { ok: false, code: 'not-a-plugin', detail: errorMessage(error) };
    }
    const platform = probe.definition.platform;
    const hash = await hashPluginCode(trimmed);
    const existingByHash = entries.find(entry => entry.record.hash === hash);
    if (existingByHash) {
        return { ok: true, platform: platformOf(existingByHash) };
    }
    const record: MusicFreeStoredPlugin = {
        hash,
        platform,
        version: asText(probe.definition.version),
        author: asText(probe.definition.author),
        description: asText(probe.definition.description),
        srcUrl: srcUrl || asText(probe.definition.srcUrl),
        code: trimmed,
        installedAt: Date.now(),
    };
    const previousEntry = entries.find(entry => platformOf(entry) === platform);
    const previousPlace = previousEntry ? meta.order[platform] : undefined;
    entries = [...entries.filter(entry => platformOf(entry) !== platform), mountEntry(record)];
    if (previousPlace === undefined) {
        meta.order[platform] = nextOrder();
    } else {
        meta.order[platform] = previousPlace;
    }
    // 新代码重挂之后，旧平台名下的变量还按平台名留着：变量本来就是给同一个平台的。
    if (!persistPlugins()) {
        // 写不进去就当没装：内存里的记录也撤掉，免得界面显示装了、重启就没了。
        entries = [...entries.filter(entry => entry.record.hash !== hash),
            ...(previousEntry ? [previousEntry] : [])];
        return { ok: false, code: 'storage-full', platform };
    }
    persistMeta();
    syncRegistrations();
    announce();
    return { ok: true, platform };
};

const fetchPluginCode = async (url: string): Promise<{ code: string } | { failure: MusicFreeInstallResult }> => {
    try {
        const response = await requestPluginNetwork({ url });
        if (response.status < 200 || response.status >= 300) {
            return { failure: { ok: false, code: 'fetch-failed', detail: `HTTP ${response.status}`, url } };
        }
        return { code: decodePluginText(response.bytes, response.headers['content-type']) };
    } catch (error) {
        return { failure: { ok: false, code: 'fetch-failed', detail: errorMessage(error), url } };
    }
};

const parseManifestUrls = (text: string): string[] | null => {
    let manifest: unknown;
    try {
        manifest = JSON.parse(text);
    } catch {
        return null;
    }
    const listed = (manifest as { plugins?: Array<{ url?: unknown }> } | null)?.plugins;
    if (!Array.isArray(listed)) return null;
    return listed
        .map(item => (typeof item?.url === 'string' ? item.url.trim() : ''))
        .filter(url => /^https?:\/\//i.test(url));
};

/**
 * 一个地址：插件源码本身，或者 MusicFree 的插件清单（`{ plugins: [{ url }] }`）。
 * `.json` 直接按清单读；别的地址先按插件装，装不上再看它是不是一份清单。
 */
const installFromUrl = async (url: string, depth = 0): Promise<MusicFreeInstallResult[]> => {
    const fetched = await fetchPluginCode(url);
    if ('failure' in fetched) return [fetched.failure];
    const text = fetched.code.trim();
    const isJsonAddress = /\.json(?:[?#]|$)/i.test(url);
    if (!isJsonAddress) {
        const single = await installCode(fetched.code, url);
        if (single.ok || depth > 0) return [single];
        const manifestUrls = parseManifestUrls(text);
        if (manifestUrls === null) return [single];
        return await installManifestUrls(manifestUrls, url, depth);
    }
    if (depth > 0) {
        return [{ ok: false, code: 'not-a-plugin', detail: 'a plugin list cannot list another list', url }];
    }
    const manifestUrls = parseManifestUrls(text);
    if (manifestUrls === null) {
        return [{ ok: false, code: 'not-a-plugin', detail: 'the file has no "plugins" list', url }];
    }
    return await installManifestUrls(manifestUrls, url, depth);
};

const installManifestUrls = async (
    urls: string[],
    url: string,
    depth: number,
): Promise<MusicFreeInstallResult[]> => {
    if (urls.length === 0) {
        return [{ ok: false, code: 'not-a-plugin', detail: 'the plugin list is empty', url }];
    }
    const results: MusicFreeInstallResult[] = [];
    for (const pluginUrl of urls) {
        results.push(...await installFromUrl(pluginUrl, depth + 1));
    }
    return results;
};

const installFromUrlsText = async (text: string): Promise<MusicFreeInstallResult[]> => {
    const urls = text
        .split(/\s+/)
        .map(line => line.trim())
        .filter(line => /^https?:\/\//i.test(line));
    if (urls.length === 0) return [];
    const results: MusicFreeInstallResult[] = [];
    for (const url of urls) {
        results.push(...await installFromUrl(url));
    }
    return results;
};

const removeByHash = (hash: string): boolean => {
    ensureStarted();
    const target = entries.find(entry => entry.record.hash === hash);
    if (!target) return false;
    const platform = platformOf(target);
    entries = entries.filter(entry => entry.record.hash !== hash);
    delete meta.order[platform];
    delete meta.variables[platform];
    delete meta.alternative[platform];
    Object.keys(meta.alternative).forEach(key => {
        if (meta.alternative[key] === platform) delete meta.alternative[key];
    });
    meta.disabled = meta.disabled.filter(disabled => disabled !== platform);
    const saved = persistPlugins();
    persistMeta();
    syncRegistrations();
    announce();
    if (!saved) console.warn('[MusicFreePlugins] Could not save the plugin list after removing a plugin');
    return true;
};

/** 清空所有插件：代码、排序、变量、替代插件配置全部去掉，注册表里的插件源一并注销。 */
const removeAllPlugins = (): number => {
    ensureStarted();
    const removed = entries.length;
    entries = [];
    meta = { order: {}, disabled: [], variables: {}, alternative: {} };
    const saved = persistPlugins();
    persistMeta();
    syncRegistrations();
    announce();
    if (!saved) console.warn('[MusicFreePlugins] Could not save the empty plugin list');
    return removed;
};

const setEnabledByHash = (hash: string, enabled: boolean): void => {    ensureStarted();
    const target = entries.find(entry => entry.record.hash === hash);
    if (!target) return;
    const platform = platformOf(target);
    if (enabled) {
        meta.disabled = meta.disabled.filter(disabled => disabled !== platform);
    } else if (!meta.disabled.includes(platform)) {
        meta.disabled = [...meta.disabled, platform];
    }
    persistMeta();
    syncRegistrations();
    announce();
};

const moveByHash = (hash: string, delta: -1 | 1): void => {
    ensureStarted();
    const ordered = sortEntries(entries);
    const index = ordered.findIndex(entry => entry.record.hash === hash);
    const nextIndex = index + delta;
    if (index === -1 || nextIndex < 0 || nextIndex >= ordered.length) return;
    const next = [...ordered];
    const [moved] = next.splice(index, 1);
    next.splice(nextIndex, 0, moved);
    next.forEach((entry, position) => {
        meta.order[platformOf(entry)] = position;
    });
    persistMeta();
    syncRegistrations();
    announce();
};

const setVariablesByHash = (hash: string, variables: Record<string, string>): void => {
    ensureStarted();
    const target = entries.find(entry => entry.record.hash === hash);
    if (!target) return;
    const platform = platformOf(target);
    const allowed = new Set((target.mounted?.userVariables ?? []).map(variable => variable.key));
    const cleaned: Record<string, string> = {};
    Object.entries(variables).forEach(([key, value]) => {
        if (allowed.size === 0 || allowed.has(key)) cleaned[key] = String(value ?? '');
    });
    meta.variables[platform] = cleaned;
    persistMeta();
    announce();
};

const setAlternativeByHash = (hash: string, alternativePlatform: string): void => {
    ensureStarted();
    const target = entries.find(entry => entry.record.hash === hash);
    if (!target) return;
    const platform = platformOf(target);
    const next = alternativePlatform.trim();
    if (!next || next === platform) {
        delete meta.alternative[platform];
    } else {
        // 只接受还在、还启用、还能取播放地址的插件（和 MusicFree 的候选一致）。
        const alternative = enabledEntryByPlatform(next);
        if (!alternative?.mounted?.definition.getMediaSource) return;
        meta.alternative[platform] = next;
    }
    persistMeta();
    announce();
};

/** 导入单曲：插件给的条目 → Folia 的歌曲。 */
const importMusicItemFor = async (hash: string, urlLike: string): Promise<UnifiedSong | null> => {
    ensureStarted();
    const entry = entries.find(candidate => candidate.record.hash === hash);
    const definition = entry?.mounted?.definition;
    if (!entry?.mounted || !definition?.importMusicItem) return null;
    const platform = platformOf(entry);
    const item = await callPluginMethod(platform, 'importMusicItem', () => definition.importMusicItem!(urlLike));
    if (!item || item.id === undefined || item.id === null) return null;
    return musicFreeSongsFromItems(platform, [item])[0] ?? null;
};

/** 导入歌单：一段链接 → 一组歌曲。 */
const importMusicSheetFor = async (hash: string, urlLike: string): Promise<UnifiedSong[]> => {
    ensureStarted();
    const entry = entries.find(candidate => candidate.record.hash === hash);
    const definition = entry?.mounted?.definition;
    if (!entry?.mounted || !definition?.importMusicSheet) return [];
    const platform = platformOf(entry);
    const items = await callPluginMethod(platform, 'importMusicSheet', () => definition.importMusicSheet!(urlLike));
    if (!Array.isArray(items)) return [];
    return musicFreeSongsFromItems(platform, items);
};

const updateByHash = async (hash: string): Promise<MusicFreeInstallResult> => {
    ensureStarted();
    const target = entries.find(entry => entry.record.hash === hash);
    if (!target) return { ok: false, code: 'no-update-source' };
    const srcUrl = target.record.srcUrl || asText(target.mounted?.definition.srcUrl);
    if (!srcUrl) return { ok: false, code: 'no-update-source', platform: platformOf(target) };
    const results = await installFromUrl(srcUrl);
    return results[0] ?? { ok: false, code: 'fetch-failed', url: srcUrl };
};

const updateAll = async (): Promise<MusicFreeInstallResult[]> => {
    ensureStarted();
    const results: MusicFreeInstallResult[] = [];
    for (const entry of sortEntries(entries)) {
        const srcUrl = entry.record.srcUrl || asText(entry.mounted?.definition.srcUrl);
        if (!srcUrl) continue;
        results.push(...await installFromUrl(srcUrl));
    }
    return results;
};

const updateSubscriptions = async (): Promise<MusicFreeInstallResult[]> => {
    ensureStarted();
    const urls = readPluginSubscriptions();
    const results: MusicFreeInstallResult[] = [];
    for (const url of urls) {
        results.push(...await installFromUrl(url));
    }
    return results;
};

const setSubscriptions = (urls: string[]): boolean => {
    const cleaned = Array.from(new Set(
        urls.map(url => url.trim()).filter(url => /^https?:\/\//i.test(url)),
    ));
    return writePluginSubscriptions(cleaned);
};

export const musicFreePluginHost = {
    /** 应用起来时调用一次；之后每次动作都会自己确保已经初始化。 */
    start(): void {
        ensureStarted();
    },

    isStarted(): boolean {
        return started;
    },

    /** 宿主的版本号：插件在 env.appVersion 里读到的就是它。 */
    hostAppVersion: MUSICFREE_HOST_APP_VERSION,

    list(): MusicFreePluginSummary[] {
        ensureStarted();
        return snapshot;
    },

    subscribe(listener: () => void): () => void {
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    },

    async installFromCode(code: string, srcUrl = ''): Promise<MusicFreeInstallResult> {
        return await installCode(code, srcUrl.trim());
    },

    async installFromUrl(url: string): Promise<MusicFreeInstallResult[]> {
        ensureStarted();
        return await installFromUrl(url.trim());
    },

    async installFromUrlsText(text: string): Promise<MusicFreeInstallResult[]> {
        ensureStarted();
        return await installFromUrlsText(text);
    },

    async installFromFile(file: File): Promise<MusicFreeInstallResult> {
        ensureStarted();
        try {
            const code = await file.text();
            return await installCode(code, '');
        } catch (error) {
            return { ok: false, code: 'file-unreadable', detail: errorMessage(error) };
        }
    },

    remove(hash: string): boolean {
        return removeByHash(hash);
    },

    /** 卸载全部插件，返回卸掉了几个。订阅地址保留：那是「以后要装什么」，不是装好的东西。 */
    removeAll(): number {
        return removeAllPlugins();
    },

    setEnabled(hash: string, enabled: boolean): void {
        setEnabledByHash(hash, enabled);
    },

    move(hash: string, delta: -1 | 1): void {
        moveByHash(hash, delta);
    },

    setVariables(hash: string, variables: Record<string, string>): void {
        setVariablesByHash(hash, variables);
    },

    /** 让另一个插件解析这个平台的播放地址；空串恢复成自己解析。 */
    setAlternative(hash: string, alternativePlatform: string): void {
        setAlternativeByHash(hash, alternativePlatform);
    },

    async importMusicItem(hash: string, urlLike: string): Promise<UnifiedSong | null> {
        return await importMusicItemFor(hash, urlLike.trim());
    },

    async importMusicSheet(hash: string, urlLike: string): Promise<UnifiedSong[]> {
        return await importMusicSheetFor(hash, urlLike.trim());
    },

    async update(hash: string): Promise<MusicFreeInstallResult> {
        return await updateByHash(hash);
    },

    async updateAll(): Promise<MusicFreeInstallResult[]> {
        return await updateAll();
    },

    getSubscriptions(): string[] {
        return readPluginSubscriptions();
    },

    setSubscriptions(urls: string[]): boolean {
        return setSubscriptions(urls);
    },

    async updateSubscriptions(): Promise<MusicFreeInstallResult[]> {
        return await updateSubscriptions();
    },

    /** 当前登记成在线音源的插件 provider id；诊断用。 */
    registeredProviderIds(): string[] {
        return [...registeredProviders.keys()];
    },

    /** 一个平台是否已经登记；诊断用。 */
    isRegistered(platform: string): boolean {
        return registeredProviders.has(musicFreeProviderIdFor(platform));
    },
};

export type { MusicFreePluginSummary };
