import { describe, expect, it } from 'vitest';
import { useSearchNavigationStore } from '../../../src/stores/useSearchNavigationStore';

// test/unit/search/searchSourceFallback.test.ts
// 选中的音源被卸载（清空插件、停用插件）后，页签要退回一个还在的来源，并且不能把上一个来源的
// 结果留在这个来源名下。

describe('search source fallback', () => {
    it('clears the previous results when the source is replaced', () => {
        useSearchNavigationStore.setState({
            searchSourceTab: 'musicfree.Gone',
            searchResults: [{ id: '1', name: 'Old', artists: [], album: { id: '', name: '' }, durationMs: 0 }] as never,
            hasMore: true,
            offset: 30,
            searchError: 'previous failure',
        });

        useSearchNavigationStore.getState().setSearchSourceTab('netease');

        const state = useSearchNavigationStore.getState();
        expect(state.searchSourceTab).toBe('netease');
        expect(state.searchResults).toBeNull();
        expect(state.hasMore).toBe(false);
        expect(state.offset).toBe(0);
        expect(state.searchError).toBeNull();
    });
});
