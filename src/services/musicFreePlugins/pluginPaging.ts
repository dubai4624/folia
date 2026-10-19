// src/services/musicFreePlugins/pluginPaging.ts
// 把 MusicFree 插件的“第 1 页、第 2 页……”拼成 Folia 的 limit/offset。插件一页给几首由它自己定
// （常见 20、30），Folia 一次要 30；两边不一致时直接拿页码换算会重复或漏歌，所以这里按需把插件
// 的页读进来、摊平，再切出调用方要的那一段。

export interface PluginPageReader<T> {
    read(limit: number, offset: number): Promise<{ items: T[]; hasMore: boolean; nextOffset: number }>;
}

export interface PluginPageSource<T> {
    items: T[];
    /** The plugin said this was the last page. */
    isEnd: boolean;
}

/** 一次 read 最多往下读几页：插件说“还有”却一直给同一页时，不会转不出来。 */
const MAX_PAGES_PER_READ = 40;

/**
 * `fetchPage(page)` 从第 1 页开始。同一个 reader 的读取按顺序排队，两个调用方同时要下一页时
 * 不会把同一页读两遍，也不会交叉着写 `pages`。
 */
export const createPluginPageReader = <T>(
    fetchPage: (page: number) => Promise<PluginPageSource<T>>,
): PluginPageReader<T> => {
    const pages: T[][] = [];
    let ended = false;
    let queue: Promise<unknown> = Promise.resolve();

    const fetchedCount = (): number => pages.reduce((total, page) => total + page.length, 0);

    const read = async (limit: number, offset: number) => {
        const safeLimit = Math.max(0, Math.floor(limit));
        const safeOffset = Math.max(0, Math.floor(offset));
        let guard = 0;
        while (!ended && fetchedCount() < safeOffset + safeLimit && guard < MAX_PAGES_PER_READ) {
            guard += 1;
            const page = await fetchPage(pages.length + 1);
            const items = Array.isArray(page.items) ? page.items : [];
            pages.push(items);
            if (page.isEnd || items.length === 0) ended = true;
        }
        const flat = pages.flat();
        const items = flat.slice(safeOffset, safeOffset + safeLimit);
        return {
            items,
            hasMore: flat.length > safeOffset + safeLimit || !ended,
            nextOffset: safeOffset + items.length,
        };
    };

    return {
        read: (limit, offset) => {
            const answer = queue.then(() => read(limit, offset), () => read(limit, offset));
            queue = answer.catch(() => undefined);
            return answer;
        },
    };
};
