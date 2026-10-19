import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileUp, Link2, PackagePlus, Trash2 } from 'lucide-react';
import type { MusicFreeInstallResult, MusicFreePluginSummary } from '../../types/musicFreePlugin';
import { musicFreePluginHost } from '../../services/musicFreePlugins/pluginHost';
import { setStatusMessage } from '../../stores/useStatusMessageStore';
import { errorMessage } from '../../utils/errorText';
import { Button, Group, Row, TextArea, TextField } from '../modal/settings/kit';
import ConfirmDialog from '../shared/ConfirmDialog';
import { usePluginSources } from './usePluginSources';
import { PluginSourcesRow } from './PluginSourcesRow';
import {
    PLUGIN_INSTALLED_GROUP,
    PLUGIN_INSTALL_GROUP,
    PLUGIN_NOTES_GROUP,
    PLUGIN_SOURCE_ROWS,
    PLUGIN_SUBSCRIPTIONS_GROUP,
    describePluginResults,
} from './pluginSourcesSettings';

// src/components/pluginSources/PluginSourcesPanel.tsx
// 设置里「音乐源插件」的内容：安装（地址、粘贴的代码、本地文件）、已安装列表、订阅地址，以及一段
// 说明。装好的插件会登记成在线音源，在首页的平台列表里像内置平台一样选用。

const PLUGIN_FILE_ACCEPT = '.js,text/javascript,application/javascript';

const notifyResults = (results: MusicFreeInstallResult[], describe: (results: MusicFreeInstallResult[]) => string) => {
    const failed = results.filter(result => !result.ok);
    setStatusMessage({
        type: failed.length === 0 ? 'success' : (results.some(result => result.ok) ? 'info' : 'error'),
        text: describe(results),
    });
};

export const PluginSourcesPanel: React.FC = () => {
    const { t } = useTranslation();
    const plugins = usePluginSources();
    const [installUrl, setInstallUrl] = useState('');
    const [installCode, setInstallCode] = useState('');
    const [subscriptionsText, setSubscriptionsText] = useState('');
    const [busy, setBusy] = useState(false);
    const [pendingRemove, setPendingRemove] = useState<MusicFreePluginSummary | null>(null);
    const [removingAll, setRemovingAll] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const describe = useCallback((results: MusicFreeInstallResult[]) => describePluginResults(t, results), [t]);

    useEffect(() => {
        musicFreePluginHost.start();
        setSubscriptionsText(musicFreePluginHost.getSubscriptions().join('\n'));
    }, []);

    const run = async (task: () => Promise<void>) => {
        setBusy(true);
        try {
            await task();
        } catch (error) {
            setStatusMessage({ type: 'error', text: errorMessage(error) });
        } finally {
            setBusy(false);
        }
    };

    const installFromUrl = () => run(async () => {
        const url = installUrl.trim();
        if (!url) return;
        const results = await musicFreePluginHost.installFromUrl(url);
        notifyResults(results, describe);
        if (results.every(result => result.ok)) setInstallUrl('');
    });

    const installFromCode = () => run(async () => {
        const code = installCode.trim();
        if (!code) return;
        const result = await musicFreePluginHost.installFromCode(code);
        notifyResults([result], describe);
        if (result.ok) setInstallCode('');
    });

    const installFromFile = (file: File | null | undefined) => {
        if (!file) return;
        void run(async () => {
            const result = await musicFreePluginHost.installFromFile(file);
            notifyResults([result], describe);
        });
    };

    const updateAll = () => run(async () => {
        const results = await musicFreePluginHost.updateAll();
        if (results.length === 0) {
            setStatusMessage({ type: 'info', text: t('musicFreePlugins.noUpdateSources') });
            return;
        }
        setStatusMessage({
            type: results.every(result => result.ok) ? 'success' : 'info',
            text: t('musicFreePlugins.updateAllDone', {
                success: results.filter(result => result.ok).length,
                fail: results.filter(result => !result.ok).length,
            }),
        });
    });

    const saveSubscriptions = () => {
        const urls = subscriptionsText.split(/\s+/).map(url => url.trim()).filter(Boolean);
        const saved = musicFreePluginHost.setSubscriptions(urls);
        setStatusMessage({
            type: saved ? 'success' : 'error',
            text: saved ? t('musicFreePlugins.subscriptionsSaved') : t('musicFreePlugins.failureStorageFull'),
        });
    };

    const installSubscriptions = () => run(async () => {
        const results = await musicFreePluginHost.updateSubscriptions();
        if (results.length === 0) {
            setStatusMessage({ type: 'info', text: t('musicFreePlugins.subscriptionsEmpty') });
            return;
        }
        notifyResults(results, describe);
    });

    const remove = () => {
        const target = pendingRemove;
        setPendingRemove(null);
        if (!target) return;
        const removed = musicFreePluginHost.remove(target.hash);
        setStatusMessage({
            type: removed ? 'success' : 'error',
            text: removed ? t('musicFreePlugins.removed', { name: target.platform }) : t('musicFreePlugins.removeFailed'),
        });
    };

    const removeAll = () => {
        setRemovingAll(false);
        const removed = musicFreePluginHost.removeAll();
        setStatusMessage({
            type: removed > 0 ? 'success' : 'info',
            text: removed > 0
                ? t('musicFreePlugins.removedAll', { count: removed })
                : t('musicFreePlugins.empty'),
        });
    };

    return (
        <>
            <Group
                def={PLUGIN_INSTALL_GROUP}
                action={(
                    <Button icon={PackagePlus} variant="quiet" onClick={updateAll} disabled={busy}>
                        {t('musicFreePlugins.updateAll')}
                    </Button>
                )}
                foot={t('musicFreePlugins.installFoot')}
            >
                <Row option={PLUGIN_SOURCE_ROWS.installUrl} hint={t('musicFreePlugins.installFromUrlHint')}>
                    <TextField
                        value={installUrl}
                        onChange={setInstallUrl}
                        placeholder="https://example.com/plugin.js"
                    />
                    <Button variant="primary" onClick={installFromUrl} disabled={busy || !installUrl.trim()}>
                        {t('musicFreePlugins.install')}
                    </Button>
                </Row>

                <Row
                    option={PLUGIN_SOURCE_ROWS.installText}
                    hint={t('musicFreePlugins.installFromTextHint')}
                    below={(
                        <>
                            <TextArea
                                value={installCode}
                                onChange={setInstallCode}
                                placeholder={t('musicFreePlugins.installFromTextPlaceholder')}
                            />
                            <div className="mt-2">
                                <Button variant="primary" onClick={installFromCode} disabled={busy || !installCode.trim()}>
                                    {t('musicFreePlugins.install')}
                                </Button>
                            </div>
                        </>
                    )}
                />

                <Row option={PLUGIN_SOURCE_ROWS.installFile} hint={t('musicFreePlugins.installFileHint')}>
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept={PLUGIN_FILE_ACCEPT}
                        className="hidden"
                        onChange={event => {
                            installFromFile(event.target.files?.[0]);
                            event.target.value = '';
                        }}
                    />
                    <Button icon={FileUp} onClick={() => fileInputRef.current?.click()} disabled={busy}>
                        {t('musicFreePlugins.chooseFile')}
                    </Button>
                </Row>
            </Group>

            <Group
                def={PLUGIN_INSTALLED_GROUP}
                action={plugins.length > 0 ? (
                    <Button icon={Trash2} variant="quiet" onClick={() => setRemovingAll(true)}>
                        {t('musicFreePlugins.removeAll')}
                    </Button>
                ) : undefined}
                foot={t('musicFreePlugins.installedFoot')}
            >
                {plugins.length === 0 ? (
                    <Row notice={t('musicFreePlugins.empty')} />
                ) : plugins.map((plugin, index) => (
                    <PluginSourcesRow
                        key={plugin.hash}
                        plugin={plugin}
                        alternatives={plugins.filter(candidate => (
                            candidate.hash !== plugin.hash
                            && candidate.enabled
                            && candidate.ready
                            && candidate.methods.includes('getMediaSource')
                        ))}
                        isFirst={index === 0}
                        isLast={index === plugins.length - 1}
                        onRequestRemove={setPendingRemove}
                    />
                ))}
            </Group>

            <Group def={PLUGIN_SUBSCRIPTIONS_GROUP} foot={t('musicFreePlugins.subscriptionsFoot')}>
                <Row
                    option={PLUGIN_SOURCE_ROWS.subscriptionList}
                    hint={t('musicFreePlugins.subscriptionsHint')}
                    below={(
                        <>
                            <TextArea
                                value={subscriptionsText}
                                onChange={setSubscriptionsText}
                                placeholder={'https://example.com/plugins.json\nhttps://example.com/another.js'}
                            />
                            <div className="mt-2 flex flex-wrap gap-2">
                                <Button variant="primary" onClick={saveSubscriptions} disabled={busy}>
                                    {t('musicFreePlugins.saveSubscriptions')}
                                </Button>
                                <Button icon={Link2} onClick={installSubscriptions} disabled={busy}>
                                    {t('musicFreePlugins.updateSubscriptions')}
                                </Button>
                            </div>
                        </>
                    )}
                />
            </Group>

            <Group def={PLUGIN_NOTES_GROUP}>
                <Row notice={t('musicFreePlugins.securityNote')} />
            </Group>

            <ConfirmDialog
                isOpen={Boolean(pendingRemove)}
                title={t('musicFreePlugins.removeConfirmTitle', { name: pendingRemove?.platform ?? '' })}
                description={t('musicFreePlugins.removeConfirmBody')}
                confirmVariant="danger"
                onConfirm={remove}
                onClose={() => setPendingRemove(null)}
            />

            <ConfirmDialog
                isOpen={removingAll}
                title={t('musicFreePlugins.removeAllConfirmTitle')}
                description={t('musicFreePlugins.removeAllConfirmBody')}
                confirmVariant="danger"
                onConfirm={removeAll}
                onClose={() => setRemovingAll(false)}
            />
        </>
    );
};

export default PluginSourcesPanel;
