import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, Import as ImportIcon, RefreshCw, SlidersHorizontal, Trash2 } from 'lucide-react';
import type { MusicFreePluginSummary } from '../../types/musicFreePlugin';
import { musicFreePluginHost } from '../../services/musicFreePlugins/pluginHost';
import { requestSongQueueAppend } from '../../services/songQueueRequests';
import { setStatusMessage } from '../../stores/useStatusMessageStore';
import { errorMessage } from '../../utils/errorText';
import { Button, Row, Select, Status, TextField, Toggle } from '../modal/settings/kit';
import { pluginMethodLabels } from './pluginSourcesSettings';

// src/components/pluginSources/PluginSourcesRow.tsx
// 已安装插件的一行：名字、版本/作者、它支持的功能，以及启停、变量、替代插件、导入、更新、排序、卸载。
// 变量与导入的面板在行下面展开。

type PluginSourcesRowProps = {
    plugin: MusicFreePluginSummary;
    /** 可以给它当替代插件的其它插件（启用、已解析、能取播放地址）。 */
    alternatives: MusicFreePluginSummary[];
    isFirst: boolean;
    isLast: boolean;
    onRequestRemove: (plugin: MusicFreePluginSummary) => void;
};

const STATUS_TONE = {
    ready: 'ok',
    disabled: undefined,
    error: 'error',
} as const;

type ImportKind = 'item' | 'sheet';

export const PluginSourcesRow: React.FC<PluginSourcesRowProps> = ({
    plugin,
    alternatives,
    isFirst,
    isLast,
    onRequestRemove,
}) => {
    const { t } = useTranslation();
    const [variablesOpen, setVariablesOpen] = useState(false);
    const [draft, setDraft] = useState<Record<string, string>>(plugin.variables);
    const [busy, setBusy] = useState(false);
    const [importOpen, setImportOpen] = useState(false);
    const [importUrl, setImportUrl] = useState('');
    const [importBusy, setImportBusy] = useState(false);

    // 面板打开时把当前的变量值抄一份；关着的时候插件变了也不覆盖用户正在改的内容。
    useEffect(() => {
        if (variablesOpen) setDraft(plugin.variables);
    }, [variablesOpen, plugin.variables]);

    const status = !plugin.ready
        ? { tone: STATUS_TONE.error, text: t('musicFreePlugins.statusError') }
        : plugin.enabled
            ? { tone: STATUS_TONE.ready, text: t('musicFreePlugins.statusReady') }
            : { tone: STATUS_TONE.disabled, text: t('musicFreePlugins.statusDisabled') };

    const hintParts = [
        plugin.version ? t('musicFreePlugins.versionHint', { version: plugin.version }) : '',
        plugin.author ? t('musicFreePlugins.authorHint', { author: plugin.author }) : '',
        plugin.methods.length > 0 ? t('musicFreePlugins.supportsHint', { methods: pluginMethodLabels(t, plugin.methods) }) : '',
    ].filter(Boolean);

    const canImportItem = plugin.methods.includes('importMusicItem');
    const canImportSheet = plugin.methods.includes('importMusicSheet');
    const canImport = canImportItem || canImportSheet;
    const alternativeOptions = [
        { value: '', label: t('musicFreePlugins.alternativeNone') },
        ...alternatives.map(candidate => ({ value: candidate.platform, label: candidate.platform })),
    ];

    const update = async () => {
        setBusy(true);
        try {
            const result = await musicFreePluginHost.update(plugin.hash);
            setStatusMessage({
                type: result.ok ? 'success' : 'error',
                text: result.ok
                    ? t('musicFreePlugins.updateSuccess', { name: plugin.platform })
                    : t('musicFreePlugins.updateFailed', {
                        name: plugin.platform,
                        reason: result.code === 'no-update-source' ? t('musicFreePlugins.failureNoUpdateSource') : (result.detail ?? ''),
                    }),
            });
        } catch (error) {
            setStatusMessage({ type: 'error', text: errorMessage(error) });
        } finally {
            setBusy(false);
        }
    };

    const saveVariables = () => {
        musicFreePluginHost.setVariables(plugin.hash, draft);
        setStatusMessage({ type: 'success', text: t('musicFreePlugins.variablesSaved') });
    };

    const runImport = async (kind: ImportKind) => {
        const urlLike = importUrl.trim();
        if (!urlLike) return;
        setImportBusy(true);
        try {
            const songs = kind === 'item'
                ? [await musicFreePluginHost.importMusicItem(plugin.hash, urlLike)].filter(Boolean) as Parameters<typeof requestSongQueueAppend>[0]
                : await musicFreePluginHost.importMusicSheet(plugin.hash, urlLike);
            if (songs.length === 0) {
                setStatusMessage({ type: 'info', text: t('musicFreePlugins.importEmpty') });
                return;
            }
            const accepted = requestSongQueueAppend(songs);
            if (accepted === 0) {
                setStatusMessage({ type: 'error', text: t('musicFreePlugins.importQueueUnavailable') });
                return;
            }
            setStatusMessage({ type: 'success', text: t('musicFreePlugins.importDone', { count: songs.length }) });
            setImportUrl('');
        } catch (error) {
            setStatusMessage({ type: 'error', text: `${t('musicFreePlugins.importFailedGeneric')}（${errorMessage(error)}）` });
        } finally {
            setImportBusy(false);
        }
    };

    return (
        <Row
            label={plugin.platform}
            hint={hintParts.join(' · ')}
            note={plugin.description || undefined}
            below={(
                <div className="flex flex-col gap-2">
                    {plugin.error ? (
                        <p className="whitespace-pre-wrap text-xs leading-[18px] text-[color:var(--st-err)]">{plugin.error}</p>
                    ) : null}

                    {alternatives.length > 0 || plugin.alternative ? (
                        <div className="flex flex-wrap items-center gap-2 text-xs text-[color:var(--st-t2)]" data-plugin-alternative={plugin.hash}>
                            <span>{t('musicFreePlugins.alternativePlugin')}</span>
                            <Select
                                value={plugin.alternative}
                                options={alternativeOptions}
                                onChange={value => musicFreePluginHost.setAlternative(plugin.hash, value)}
                                name={t('musicFreePlugins.alternativePlugin')}
                            />
                            <span>{t('musicFreePlugins.alternativeHint')}</span>
                        </div>
                    ) : null}

                    {importOpen ? (
                        <div className="flex flex-col gap-2 rounded-lg bg-[var(--st-fill)] p-3" data-plugin-import={plugin.hash}>
                            <p className="text-xs text-[color:var(--st-t2)]">{t('musicFreePlugins.importHint')}</p>
                            <div className="flex flex-wrap items-center gap-2">
                                <TextField
                                    value={importUrl}
                                    onChange={setImportUrl}
                                    placeholder={t('musicFreePlugins.importPlaceholder')}
                                />
                                {canImportItem ? (
                                    <Button variant="primary" onClick={() => void runImport('item')} disabled={importBusy || !importUrl.trim()}>
                                        {t('musicFreePlugins.importItem')}
                                    </Button>
                                ) : null}
                                {canImportSheet ? (
                                    <Button onClick={() => void runImport('sheet')} disabled={importBusy || !importUrl.trim()}>
                                        {t('musicFreePlugins.importSheet')}
                                    </Button>
                                ) : null}
                            </div>
                        </div>
                    ) : null}

                    {variablesOpen ? (
                        <div className="flex flex-col gap-2 rounded-lg bg-[var(--st-fill)] p-3" data-plugin-variables={plugin.hash}>
                            {plugin.userVariables.length === 0 ? (
                                <p className="text-xs text-[color:var(--st-t2)]">{t('musicFreePlugins.variablesEmpty')}</p>
                            ) : plugin.userVariables.map(variable => (
                                <label key={variable.key} className="flex flex-col gap-1 text-xs text-[color:var(--st-t1)]">
                                    <span className="font-medium">{variable.name || variable.key}</span>
                                    {variable.hint ? <span className="text-[color:var(--st-t2)]">{variable.hint}</span> : null}
                                    <TextField
                                        value={draft[variable.key] ?? ''}
                                        onChange={value => setDraft(current => ({ ...current, [variable.key]: value }))}
                                        placeholder={variable.key}
                                    />
                                </label>
                            ))}
                            <div>
                                <Button variant="primary" onClick={saveVariables}>{t('musicFreePlugins.saveVariables')}</Button>
                            </div>
                        </div>
                    ) : null}
                </div>
            )}
        >
            <Status tone={status.tone}>{status.text}</Status>
            {canImport ? (
                <Button
                    icon={ImportIcon}
                    variant="quiet"
                    tip={t('musicFreePlugins.importAction')}
                    onClick={() => setImportOpen(open => !open)}
                />
            ) : null}
            {plugin.userVariables.length > 0 ? (
                <Button
                    icon={SlidersHorizontal}
                    variant="quiet"
                    tip={t('musicFreePlugins.variables')}
                    onClick={() => setVariablesOpen(open => !open)}
                />
            ) : null}
            {plugin.srcUrl ? (
                <Button
                    icon={RefreshCw}
                    variant="quiet"
                    tip={t('musicFreePlugins.update')}
                    onClick={update}
                    disabled={busy}
                />
            ) : null}
            <Button
                icon={ChevronUp}
                variant="quiet"
                tip={t('musicFreePlugins.moveUp')}
                onClick={() => musicFreePluginHost.move(plugin.hash, -1)}
                disabled={isFirst}
            />
            <Button
                icon={ChevronDown}
                variant="quiet"
                tip={t('musicFreePlugins.moveDown')}
                onClick={() => musicFreePluginHost.move(plugin.hash, 1)}
                disabled={isLast}
            />
            <Button
                icon={Trash2}
                variant="quiet"
                tip={t('musicFreePlugins.remove')}
                onClick={() => onRequestRemove(plugin)}
            />
            <Toggle
                checked={plugin.enabled}
                onChange={enabled => musicFreePluginHost.setEnabled(plugin.hash, enabled)}
                disabled={!plugin.ready}
            />
        </Row>
    );
};

export default PluginSourcesRow;
