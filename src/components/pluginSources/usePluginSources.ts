import { useSyncExternalStore } from 'react';
import type { MusicFreePluginSummary } from '../../types/musicFreePlugin';
import { musicFreePluginHost } from '../../services/musicFreePlugins/pluginHost';

// src/components/pluginSources/usePluginSources.ts
// 插件管理器快照的 React 绑定。`musicFreePluginHost.list()` 在没有变化时回同一个数组，
// 可以直接交给 useSyncExternalStore。

const subscribePluginSources = (listener: () => void): (() => void) => musicFreePluginHost.subscribe(listener);

const getPluginSourcesSnapshot = (): MusicFreePluginSummary[] => musicFreePluginHost.list();

export const usePluginSources = (): MusicFreePluginSummary[] => useSyncExternalStore(
    subscribePluginSources,
    getPluginSourcesSnapshot,
    getPluginSourcesSnapshot,
);
