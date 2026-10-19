// src/services/musicFreePlugins/pluginNetwork.ts
// 插件发出的请求。桌面版经 preload 交给主进程（`electron/musicFreePlugins.cjs`）发出，因此不受页面
// 同源策略限制；网页版退回 `fetch`，跨源时需要对方给 CORS 头。音频地址还要登记一次，主进程才会给
// 它补上 CORS 头和插件要求的请求头（`allowPluginMedia`）。

export interface PluginNetworkRequest {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
}

/** 一个读完的回答：状态、头、原始字节。字符集由调用方按 content-type 解。 */
export interface PluginNetworkResponse {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    bytes: Uint8Array;
}

const MAX_BODY_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 60_000;
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);

/** 桌面版的主进程请求桥；网页版没有。 */
export const hasMainProcessPluginNetwork = (): boolean => (
    typeof window !== 'undefined' && typeof window.electron?.musicFreePluginFetch === 'function'
);

const toUint8Array = (buffer: ArrayBuffer | Uint8Array): Uint8Array => (
    buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
);

const base64ToBytes = (encoded: string): Uint8Array => {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
};

/** 只允许 http、https；别的协议（file、data、自定义协议）一律不发。 */
const assertHttpUrl = (value: string): URL => {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`unsupported protocol: ${url.protocol}`);
    }
    return url;
};

const normalizeHeaders = (headers: Record<string, string> | undefined): Record<string, string> => {
    const normalized: Record<string, string> = {};
    Object.entries(headers ?? {}).forEach(([key, value]) => {
        if (typeof value === 'string') normalized[key] = value;
    });
    return normalized;
};

/** 一段正文的编码：content-type 里有 charset 就用它，GBK 一类按 gb18030 解。 */
export const charsetOfContentType = (contentType: string | undefined): string => {
    const match = /charset\s*=\s*"?([^";\s]+)/i.exec(contentType ?? '');
    const charset = (match?.[1] ?? '').toLowerCase();
    if (!charset) return 'utf-8';
    if (charset === 'gbk' || charset === 'gb2312' || charset === 'gb_2312-80') return 'gb18030';
    return charset;
};

/** 把字节解成文本；不认识的字符集按 utf-8 解。 */
export const decodePluginText = (bytes: Uint8Array, contentType?: string): string => {
    const charset = charsetOfContentType(contentType);
    try {
        return new TextDecoder(charset).decode(bytes);
    } catch {
        return new TextDecoder('utf-8').decode(bytes);
    }
};

const fetchInPage = async (request: PluginNetworkRequest): Promise<PluginNetworkResponse> => {
    const method = (request.method ?? 'GET').toUpperCase();
    if (!ALLOWED_METHODS.has(method)) throw new Error(`unsupported method: ${method}`);
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1000, request.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(request.url, {
            method,
            headers: normalizeHeaders(request.headers),
            body: method === 'GET' || method === 'HEAD' ? undefined : request.body,
            signal: controller.signal,
            redirect: 'follow',
            credentials: 'omit',
        });
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > MAX_BODY_BYTES) throw new Error('response body is too large');
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
            headers[key] = value;
        });
        return {
            status: response.status,
            statusText: response.statusText,
            headers,
            bytes: toUint8Array(buffer),
        };
    } finally {
        globalThis.clearTimeout(timer);
    }
};

/**
 * 发一个插件请求。桌面版交给主进程，网页版在页面里发。
 * 抛错就是这一次没有拿到回答；状态码由调用方按 HTTP 语义处理。
 */
export const requestPluginNetwork = async (request: PluginNetworkRequest): Promise<PluginNetworkResponse> => {
    assertHttpUrl(request.url);
    const bridge = typeof window !== 'undefined' ? window.electron?.musicFreePluginFetch : undefined;
    if (typeof bridge === 'function') {
        const answer = await bridge({
            url: request.url,
            method: request.method,
            headers: normalizeHeaders(request.headers),
            body: request.body,
            timeoutMs: request.timeoutMs,
        });
        if (!answer.ok) {
            throw new Error(answer.error || 'request failed');
        }
        return {
            status: answer.status ?? 0,
            statusText: answer.statusText ?? '',
            headers: answer.headers ?? {},
            bytes: base64ToBytes(answer.bodyBase64 ?? ''),
        };
    }
    return fetchInPage(request);
};

/**
 * 把一个音频地址登记给主进程：它给这个地址补 CORS 头，按插件给的头（Referer、User-Agent）发请求。
 * 网页版没有可做的是，静默返回。返回是否登记上了（网页版恒为 false）。
 */
export const allowPluginMedia = async (url: string, headers?: Record<string, string>): Promise<boolean> => {
    const bridge = typeof window !== 'undefined' ? window.electron?.musicFreePluginAllowMedia : undefined;
    if (typeof bridge !== 'function') return false;
    // data:、blob: 这类地址音频元素自己就能放，主进程没有可登记的。
    if (!/^https?:\/\//i.test(url)) return false;
    try {
        assertHttpUrl(url);
        return await bridge(url, normalizeHeaders(headers));
    } catch (error) {
        console.warn('[MusicFreePlugins] Could not allow a plugin media URL:', error);
        return false;
    }
};
