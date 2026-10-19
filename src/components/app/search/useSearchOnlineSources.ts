import { useSyncExternalStore } from 'react';
import { omni } from '../../../services/onlineMusic/omni';

// src/components/app/search/useSearchOnlineSources.ts
// 搜索浮层的在线来源：注册表里所有的在线音源，而不再只是当前平台。装进来的 MusicFree 插件源也在
// 里面，所以「装了插件就能搜到」成立，不用先把它切成当前平台。
//
// useSyncExternalStore 要求快照在同一次版本内是同一个引用：这里按注册表版本缓存数组，
// 注册表一变（装、卸、换插件）才换新的。

let cachedVersion = -1;
let cachedIds: string[] = [];

const getProviderIdsSnapshot = (): string[] => {
    const version = omni.getProviderRegistryVersion();
    if (version !== cachedVersion) {
        cachedIds = omni.listOnlineProviderIds();
        cachedVersion = version;
    }
    return cachedIds;
};

const subscribeProviderIds = (listener: () => void): (() => void) => omni.subscribeProviders(listener);

/** 所有在线音源的 provider id，按注册表顺序；注册表变时跟着变。 */
export const useSearchOnlineSourceIds = (): string[] => useSyncExternalStore(
    subscribeProviderIds,
    getProviderIdsSnapshot,
    getProviderIdsSnapshot,
);

export type SearchOnlineSource = {
    providerId: string;
    label: string;
    /** 这个音源能不能搜；不能搜时界面要说出来，而不是给一个空列表。 */
    canSearch: boolean;
};

/** 每个在线音源的标签与搜索能力：当前平台排第一，其余按注册表顺序。 */
export const readSearchOnlineSources = (
    providerIds: readonly string[],
    activeProviderId: string,
): SearchOnlineSource[] => {
    const ordered = providerIds.includes(activeProviderId)
        ? [activeProviderId, ...providerIds.filter(providerId => providerId !== activeProviderId)]
        : [...providerIds];
    return ordered.map(providerId => ({
        providerId,
        label: omni.getProviderLabel(providerId),
        canSearch: omni.canSearchProvider(providerId),
    }));
};
