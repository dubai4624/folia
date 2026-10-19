import { describe, expect, it } from 'vitest';
import { createPluginPageReader } from '../../../src/services/musicFreePlugins/pluginPaging';

// test/unit/musicFreePlugins/pluginPaging.test.ts
// 插件的页大小由插件自己定；Folia 要的 limit/offset 不能直接换算成页码。

const pagesOf = (pages: number[][]) => {
    const requested: number[] = [];
    const reader = createPluginPageReader<number>(async page => {
        requested.push(page);
        const items = pages[page - 1] ?? [];
        return { items, isEnd: page >= pages.length };
    });
    return { reader, requested };
};

describe('createPluginPageReader', () => {
    it('joins plugin pages into the requested window', async () => {
        const { reader } = pagesOf([[1, 2], [3, 4], [5, 6]]);
        const page = await reader.read(3, 0);
        expect(page.items).toEqual([1, 2, 3]);
        expect(page.hasMore).toBe(true);
        expect(page.nextOffset).toBe(3);
    });

    it('slices across page boundaries instead of skipping songs', async () => {
        const { reader } = pagesOf([[1, 2], [3, 4], [5]]);
        const page = await reader.read(4, 2);
        expect(page.items).toEqual([3, 4, 5]);
        expect(page.hasMore).toBe(false);
        expect(page.nextOffset).toBe(5);
    });

    it('stops at the page the plugin marks as the end', async () => {
        const { reader, requested } = pagesOf([[1, 2]]);
        await reader.read(10, 0);
        await reader.read(10, 10);
        expect(requested).toEqual([1]);
    });

    it('stops reading when a page comes back empty', async () => {
        const { reader, requested } = pagesOf([[1], []]);
        const page = await reader.read(10, 0);
        expect(page.items).toEqual([1]);
        expect(page.hasMore).toBe(false);
        expect(requested).toEqual([1, 2]);
    });

    it('reads each plugin page once even when two callers ask together', async () => {
        const { reader, requested } = pagesOf([[1, 2], [3, 4], [5, 6]]);
        const [first, second] = await Promise.all([reader.read(2, 0), reader.read(2, 2)]);
        expect(first.items).toEqual([1, 2]);
        expect(second.items).toEqual([3, 4]);
        expect(requested).toEqual([1, 2]);
    });

    it('returns nothing for an offset past the end', async () => {
        const { reader } = pagesOf([[1, 2]]);
        const page = await reader.read(5, 10);
        expect(page.items).toEqual([]);
        expect(page.hasMore).toBe(false);
        expect(page.nextOffset).toBe(10);
    });
});
