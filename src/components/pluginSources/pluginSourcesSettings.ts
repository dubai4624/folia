import type { TFunction } from 'i18next';
import type { MusicFreeInstallResult } from '../../types/musicFreePlugin';
import { option, type SettingsGroupDef, type SettingsOptionDef } from '../modal/settings/kit';

// src/components/pluginSources/pluginSourcesSettings.ts
// 音乐源插件页的分组与行：分组标题、行名都在这里写一次，页面画的就是这一份，设置搜索读的也是它。

export const PLUGIN_INSTALL_GROUP: SettingsGroupDef = { id: 'pluginInstall', titleKey: 'musicFreePlugins.installGroup' };
export const PLUGIN_INSTALLED_GROUP: SettingsGroupDef = { id: 'pluginInstalled', titleKey: 'musicFreePlugins.installedGroup' };
export const PLUGIN_SUBSCRIPTIONS_GROUP: SettingsGroupDef = { id: 'pluginSubscriptions', titleKey: 'musicFreePlugins.subscriptionsGroup' };
export const PLUGIN_NOTES_GROUP: SettingsGroupDef = { id: 'pluginNotes', titleKey: 'musicFreePlugins.securityGroup' };

const OPTIONS = {
    installUrl: option(PLUGIN_INSTALL_GROUP, 'pluginInstallUrl', 'musicFreePlugins.installFromUrlLabel'),
    installText: option(PLUGIN_INSTALL_GROUP, 'pluginInstallText', 'musicFreePlugins.installFromTextLabel'),
    installFile: option(PLUGIN_INSTALL_GROUP, 'pluginInstallFile', 'musicFreePlugins.installFileLabel'),
    updateAll: option(PLUGIN_INSTALL_GROUP, 'pluginUpdateAll', 'musicFreePlugins.updateAll'),
    installedList: option(PLUGIN_INSTALLED_GROUP, 'pluginInstalledList', 'musicFreePlugins.installedListLabel'),
    subscriptionList: option(PLUGIN_SUBSCRIPTIONS_GROUP, 'pluginSubscriptionList', 'musicFreePlugins.subscriptionsLabel'),
    note: option(PLUGIN_NOTES_GROUP, 'pluginSecurityNote', 'musicFreePlugins.securityNoteLabel'),
};

export const PLUGIN_SOURCE_OPTIONS: SettingsOptionDef[] = Object.values(OPTIONS);
export const PLUGIN_SOURCE_ROWS = OPTIONS;

const METHOD_LABEL_KEYS: Record<string, string> = {
    search: 'musicFreePlugins.methodSearch',
    getMediaSource: 'musicFreePlugins.methodMediaSource',
    getMusicInfo: 'musicFreePlugins.methodMusicInfo',
    getLyric: 'musicFreePlugins.methodLyric',
    getMusicSheetInfo: 'musicFreePlugins.methodSheet',
    getAlbumInfo: 'musicFreePlugins.methodAlbum',
    getArtistWorks: 'musicFreePlugins.methodArtist',
    getTopLists: 'musicFreePlugins.methodTopList',
    getTopListDetail: 'musicFreePlugins.methodTopList',
    getRecommendSheetTags: 'musicFreePlugins.methodRecommend',
    getRecommendSheetsByTag: 'musicFreePlugins.methodRecommend',
    importMusicItem: 'musicFreePlugins.methodImport',
    importMusicSheet: 'musicFreePlugins.methodImport',
};

/** 插件方法的显示名；不认识的按原名。 */
export const pluginMethodLabel = (t: TFunction, method: string): string => {
    const key = METHOD_LABEL_KEYS[method];
    return key ? t(key) : method;
};

/** 一串插件方法的显示名，去重后连成一行。 */
export const pluginMethodLabels = (t: TFunction, methods: string[]): string => {
    const labels = Array.from(new Set(methods.map(method => pluginMethodLabel(t, method))));
    return labels.join(' · ');
};

/** 一次安装/更新没有完成时的那句话。 */
export const pluginInstallFailureText = (t: TFunction, result: MusicFreeInstallResult): string => {
    const keyByCode: Record<string, string> = {
        'empty-code': 'musicFreePlugins.failureEmptyCode',
        'not-a-plugin': 'musicFreePlugins.failureNotAPlugin',
        'unsupported-runtime': 'musicFreePlugins.failureUnsupportedRuntime',
        'fetch-failed': 'musicFreePlugins.failureFetch',
        'code-unreadable': 'musicFreePlugins.failureCodeUnreadable',
        'file-unreadable': 'musicFreePlugins.failureFileUnreadable',
        'storage-full': 'musicFreePlugins.failureStorageFull',
        'no-update-source': 'musicFreePlugins.failureNoUpdateSource',
        'already-installed': 'musicFreePlugins.failureAlreadyInstalled',
    };
    const key = result.code ? keyByCode[result.code] : undefined;
    const base = key ? t(key) : t('musicFreePlugins.installFailedGeneric');
    return result.detail ? `${base}（${result.detail}）` : base;
};

export interface PluginResultSummary {
    success: MusicFreeInstallResult[];
    failed: MusicFreeInstallResult[];
}

/** 一组安装结果里成功/失败各几个。 */
export const summarizePluginResults = (results: MusicFreeInstallResult[]): PluginResultSummary => ({
    success: results.filter(result => result.ok),
    failed: results.filter(result => !result.ok),
});

/** 一组安装结果的一句话：全成、全败、还是一部分成。 */
export const describePluginResults = (t: TFunction, results: MusicFreeInstallResult[]): string => {
    const { success, failed } = summarizePluginResults(results);
    if (failed.length === 0) {
        const names = success.map(result => result.platform).filter(Boolean) as string[];
        return names.length === 1
            ? t('musicFreePlugins.installSuccess', { name: names[0] })
            : t('musicFreePlugins.installSummary', { success: success.length, fail: 0 });
    }
    if (success.length === 0) {
        return pluginInstallFailureText(t, failed[0]);
    }
    return t('musicFreePlugins.installPartial', { success: success.length, fail: failed.length });
};
