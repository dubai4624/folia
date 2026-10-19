import { describe, expect, it } from 'vitest';
import { readSearchOnlineSources } from '../../../src/components/app/search/useSearchOnlineSources';

// test/unit/search/searchOnlineSources.test.ts
// 搜索浮层的在线来源是注册表里所有音源（插件源也在内），当前平台排第一；这不依赖 store，
// 只按 provider id 与 omni 的查询回答，所以可以脱离浏览器测。

describe('readSearchOnlineSources', () => {
    it('puts the active provider first and keeps the rest in registry order', () => {
        const sources = readSearchOnlineSources(['netease', 'kugou', 'qq'], 'kugou');
        expect(sources.map(source => source.providerId)).toEqual(['kugou', 'netease', 'qq']);
    });

    it('keeps registry order when the active provider is not registered', () => {
        const sources = readSearchOnlineSources(['netease', 'kugou'], 'folium.gone');
        expect(sources.map(source => source.providerId)).toEqual(['netease', 'kugou']);
    });

    it('reports an unknown provider as not searchable instead of throwing', () => {
        const sources = readSearchOnlineSources(['not-registered'], 'not-registered');
        expect(sources).toHaveLength(1);
        expect(sources[0].canSearch).toBe(false);
    });
});
