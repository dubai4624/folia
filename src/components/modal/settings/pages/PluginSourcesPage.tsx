import React from 'react';
import { PluginSourcesPanel } from '../../../../components/pluginSources/PluginSourcesPanel';
import { PLUGIN_SOURCE_OPTIONS } from '../../../../components/pluginSources/pluginSourcesSettings';

// src/components/modal/settings/pages/PluginSourcesPage.tsx
// 设置里的「音乐源插件」页：MusicFree 插件形式的在线音源。内容在 components/pluginSources 里，
// 这里只把它接进设置页并声明这一页有哪些行（设置搜索读的是这些）。

export const OPTIONS = PLUGIN_SOURCE_OPTIONS;

const PluginSourcesPage: React.FC = () => <PluginSourcesPanel />;

export default PluginSourcesPage;
