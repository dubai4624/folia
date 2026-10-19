import type { PluginNetworkRequest, PluginNetworkResponse } from './pluginNetwork';
import { decodePluginText, requestPluginNetwork } from './pluginNetwork';

// src/services/musicFreePlugins/pluginShims.ts
// 插件在 `require(...)` 里拿到的几个库：`axios`（走插件请求桥，不受页面同源限制）、`qs`、`he`、
// `cheerio`（用浏览器的 DOMParser 和选择器实现 MusicFree 插件常用的那一部分）。它们都是同步的，
// 因为插件在模块顶层就 `require`。不认识的模块由 pluginRuntime 明确报出来。

// ─── 查询串 ─────────────────────────────────────────────────────────────

const encodeQueryPart = (value: string): string => encodeURIComponent(value)
    .replace(/%20/g, '+')
    .replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

/** 键里的方括号是结构，不是要转义的字符：`a[]`、`a[b]` 原样留着。 */
const encodeQueryKey = (key: string): string => encodeURIComponent(key)
    .replace(/%5B/g, '[')
    .replace(/%5D/g, ']');

type QueryValue = string | number | boolean | null | undefined | QueryValue[] | { [key: string]: QueryValue };
type QueryArrayFormat = 'brackets' | 'repeat' | 'comma';

const appendQuery = (out: string[], key: string, value: QueryValue, arrayFormat: QueryArrayFormat): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
        if (arrayFormat === 'comma') {
            out.push(`${encodeQueryKey(key)}=${encodeQueryPart(value.map(item => String(item ?? '')).join(','))}`);
            return;
        }
        value.forEach(item => {
            appendQuery(out, arrayFormat === 'repeat' ? key : `${key}[]`, item as QueryValue, arrayFormat);
        });
        return;
    }
    if (typeof value === 'object') {
        Object.entries(value).forEach(([childKey, childValue]) => {
            appendQuery(out, `${key}[${childKey}]`, childValue as QueryValue, arrayFormat);
        });
        return;
    }
    out.push(`${encodeQueryKey(key)}=${encodeQueryPart(String(value))}`);
};

/** `qs.stringify`；axios 的 params 用同一套规则（数组默认 `key[]=`）。 */
export const stringifyQuery = (
    value: unknown,
    options: { arrayFormat?: QueryArrayFormat; addQueryPrefix?: boolean } = {},
): string => {
    const out: string[] = [];
    const arrayFormat = options.arrayFormat ?? 'brackets';
    if (value && typeof value === 'object') {
        Object.entries(value as Record<string, QueryValue>).forEach(([key, child]) => {
            appendQuery(out, key, child, arrayFormat);
        });
    }
    const text = out.join('&');
    return options.addQueryPrefix && text ? `?${text}` : text;
};

const assignParsed = (target: Record<string, unknown>, key: string, value: string): void => {
    const match = /^([^[\]]+)((?:\[[^[\]]*\])*)$/.exec(key);
    if (!match) {
        target[key] = value;
        return;
    }
    const head = match[1];
    const bracketParts = match[2]
        ? Array.from(match[2].matchAll(/\[([^[\]]*)\]/g)).map(part => part[1])
        : [];
    if (bracketParts.length === 0) {
        const existing = target[head];
        if (existing === undefined) target[head] = value;
        else if (Array.isArray(existing)) existing.push(value);
        else target[head] = [existing, value];
        return;
    }
    const path = [head, ...bracketParts];
    let node: Record<string, unknown> | unknown[] = target;
    for (let index = 0; index < path.length; index += 1) {
        const part = path[index];
        const last = index === path.length - 1;
        const nextIsArray = !last && (path[index + 1] === '' || /^\d+$/.test(path[index + 1] ?? ''));
        if (Array.isArray(node)) {
            if (last) {
                node.push(value);
            } else if (nextIsArray) {
                const child: unknown[] = [];
                node.push(child);
                node = child;
            } else {
                const child: Record<string, unknown> = {};
                node.push(child);
                node = child;
            }
            continue;
        }
        if (last) {
            node[part] = value;
        } else if (nextIsArray) {
            const child: unknown[] = [];
            node[part] = child;
            node = child;
        } else {
            const child: Record<string, unknown> = {};
            node[part] = child;
            node = child;
        }
    }
};

/** `qs.parse`：同名键收成数组，`a[]`、`a[b]` 按浅层结构展开。 */
export const parseQuery = (text: string): Record<string, unknown> => {
    const result: Record<string, unknown> = {};
    const body = text.startsWith('?') ? text.slice(1) : text;
    if (!body) return result;
    body.split('&').forEach(pair => {
        if (!pair) return;
        const equals = pair.indexOf('=');
        const rawKey = equals === -1 ? pair : pair.slice(0, equals);
        const rawValue = equals === -1 ? '' : pair.slice(equals + 1);
        let key: string;
        let value: string;
        try {
            key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
            value = decodeURIComponent(rawValue.replace(/\+/g, ' '));
        } catch {
            key = rawKey;
            value = rawValue;
        }
        assignParsed(result, key, value);
    });
    return result;
};

export const qsShim = {
    stringify: stringifyQuery,
    parse: parseQuery,
};

// ─── HTML 实体 ──────────────────────────────────────────────────────────

let entityTextarea: HTMLTextAreaElement | null = null;

/** `he.decode`：借浏览器的实体解析。 */
export const decodeEntities = (text: string): string => {
    if (!text) return text;
    if (typeof document === 'undefined') {
        return text
            .replace(/&#(\d+);/g, (_whole, code: string) => String.fromCodePoint(Number(code)))
            .replace(/&#x([0-9a-f]+);/gi, (_whole, code: string) => String.fromCodePoint(parseInt(code, 16)))
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'");
    }
    entityTextarea ??= document.createElement('textarea');
    entityTextarea.innerHTML = text;
    return entityTextarea.value;
};

/** `he.encode`。 */
export const encodeEntities = (text: string): string => (
    text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
);

export const heShim = {
    decode: decodeEntities,
    encode: encodeEntities,
    decodeStrict: decodeEntities,
    escape: encodeEntities,
};

// ─── cheerio ────────────────────────────────────────────────────────────

type CheerioNode = Element | Document | DocumentFragment;

const asElements = (nodes: CheerioNode[]): Element[] => nodes.filter(node => node.nodeType === 1) as Element[];

const parseHtmlDocument = (html: string): Document => new DOMParser().parseFromString(String(html ?? ''), 'text/html');

const parseHtmlFragment = (html: string): Element[] => {
    const container = document.createElement('div');
    container.innerHTML = html;
    return Array.from(container.children);
};

interface SelectorParts {
    base: string;
    contains: string[];
    index: number | null;
    first: boolean;
    last: boolean;
}

/** 把 jQuery 的几个伪类从选择器里取出来；剩下的交给 querySelectorAll。 */
const parseSelector = (selector: string): SelectorParts => {
    const contains: string[] = [];
    let rest = selector.replace(/:contains\(\s*(?:'([^']*)'|"([^"]*)"|([^)]*))\s*\)/g, (_whole, single, double, bare) => {
        contains.push(single ?? double ?? bare ?? '');
        return '';
    });
    let index: number | null = null;
    rest = rest.replace(/:eq\((\d+)\)/g, (_whole, position: string) => {
        index = Number(position);
        return '';
    });
    let first = false;
    let last = false;
    rest = rest.replace(/:first(?![\w-])/g, () => {
        first = true;
        return '';
    });
    rest = rest.replace(/:last(?![\w-])/g, () => {
        last = true;
        return '';
    });
    return { base: rest.trim(), contains, index, first, last };
};

const matchesSelector = (element: Element, selector: string): boolean => {
    try {
        return element.matches(selector);
    } catch {
        return false;
    }
};

const queryWithin = (root: CheerioNode, selector: string): Element[] => {
    const parts = parseSelector(selector);
    const base = parts.base || '*';
    let found: Element[];
    try {
        found = Array.from((root as ParentNode).querySelectorAll(base));
    } catch {
        console.warn(`[MusicFreePlugins] cheerio: unsupported selector "${selector}"`);
        return [];
    }
    if (parts.contains.length > 0) {
        const needles = parts.contains.map(text => text.toLowerCase());
        found = found.filter(element => {
            const text = (element.textContent ?? '').toLowerCase();
            return needles.every(needle => text.includes(needle));
        });
    }
    if (parts.first) found = found.slice(0, 1);
    if (parts.last) found = found.slice(-1);
    if (parts.index !== null) {
        const index = parts.index;
        found = index >= 0
            ? found.slice(index, index + 1)
            : found.slice(found.length + index, found.length + index + 1);
    }
    return found;
};

/**
 * 插件常用的那部分 cheerio。查不到的选择器只警告，不打断这次解析；没实现的成员被调用时
 * 会抛 `not implemented`，落进插件自己的错误里。
 */
class CheerioCollection {
    constructor(public readonly nodes: Element[]) {}

    get length(): number {
        return this.nodes.length;
    }

    toArray(): Element[] {
        return [...this.nodes];
    }

    get(index?: number): Element | Element[] | undefined {
        if (index === undefined) return this.toArray();
        return this.nodes[index < 0 ? this.nodes.length + index : index];
    }

    eq(index: number): CheerioCollection {
        const element = this.get(index);
        return new CheerioCollection(element ? [element as Element] : []);
    }

    first(): CheerioCollection {
        return new CheerioCollection(this.nodes.slice(0, 1));
    }

    last(): CheerioCollection {
        return new CheerioCollection(this.nodes.slice(-1));
    }

    slice(start?: number, end?: number): CheerioCollection {
        return new CheerioCollection(this.nodes.slice(start, end));
    }

    find(selector: string): CheerioCollection {
        const out: Element[] = [];
        this.nodes.forEach(node => out.push(...queryWithin(node, selector)));
        return new CheerioCollection(out);
    }

    filter(selectorOrFn: string | ((index: number, element: Element) => boolean)): CheerioCollection {
        if (typeof selectorOrFn === 'function') {
            return new CheerioCollection(this.nodes.filter((element, index) => selectorOrFn(index, element)));
        }
        return new CheerioCollection(this.nodes.filter(element => matchesSelector(element, selectorOrFn)));
    }

    not(selectorOrFn: string | ((index: number, element: Element) => boolean)): CheerioCollection {
        if (typeof selectorOrFn === 'function') {
            return new CheerioCollection(this.nodes.filter((element, index) => !selectorOrFn(index, element)));
        }
        return new CheerioCollection(this.nodes.filter(element => !matchesSelector(element, selectorOrFn)));
    }

    has(selector: string): CheerioCollection {
        return new CheerioCollection(this.nodes.filter(element => queryWithin(element, selector).length > 0));
    }

    is(selector: string): boolean {
        return this.nodes.some(element => matchesSelector(element, selector));
    }

    text(): string;
    text(value: string): CheerioCollection;
    text(value?: string): string | CheerioCollection {
        if (value === undefined) return this.nodes.map(element => element.textContent ?? '').join('');
        this.nodes.forEach(element => {
            element.textContent = value;
        });
        return this;
    }

    html(): string | null;
    html(value: string): CheerioCollection;
    html(value?: string): string | null | CheerioCollection {
        if (value === undefined) return this.nodes[0]?.innerHTML ?? null;
        this.nodes.forEach(element => {
            element.innerHTML = value;
        });
        return this;
    }

    attr(name: string): string | undefined;
    attr(name: string, value: string): CheerioCollection;
    attr(name: string, value?: string): string | undefined | CheerioCollection {
        if (value === undefined) return this.nodes[0]?.getAttribute(name) ?? undefined;
        this.nodes.forEach(element => element.setAttribute(name, value));
        return this;
    }

    removeAttr(name: string): CheerioCollection {
        this.nodes.forEach(element => element.removeAttribute(name));
        return this;
    }

    hasClass(name: string): boolean {
        return this.nodes.some(element => element.classList.contains(name));
    }

    addClass(name: string): CheerioCollection {
        this.nodes.forEach(element => element.classList.add(name));
        return this;
    }

    removeClass(name: string): CheerioCollection {
        this.nodes.forEach(element => element.classList.remove(name));
        return this;
    }

    prop(name: string): unknown {
        return this.nodes[0] ? (this.nodes[0] as unknown as Record<string, unknown>)[name] : undefined;
    }

    val(): string | undefined {
        const element = this.nodes[0] as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | undefined;
        return element?.value;
    }

    css(name: string): string | undefined {
        const element = this.nodes[0] as HTMLElement | undefined;
        if (!element) return undefined;
        return element.style?.getPropertyValue(name) || element.getAttribute('style') || undefined;
    }

    data(name: string): string | undefined {
        const element = this.nodes[0];
        if (!element) return undefined;
        const key = name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
        return element.getAttribute(`data-${key}`) ?? undefined;
    }

    each(callback: (index: number, element: Element) => unknown): CheerioCollection {
        this.nodes.forEach((element, index) => callback.call(element, index, element));
        return this;
    }

    map<T>(callback: (index: number, element: Element) => T): { length: number; get(): T[]; toArray(): T[] } {
        const mapped = this.nodes.map((element, index) => callback.call(element, index, element));
        return {
            length: mapped.length,
            get: () => mapped,
            toArray: () => mapped,
        };
    }

    children(selector?: string): CheerioCollection {
        const out: Element[] = [];
        this.nodes.forEach(node => {
            Array.from(node.children).forEach(child => {
                if (!selector || matchesSelector(child, selector)) out.push(child);
            });
        });
        return new CheerioCollection(out);
    }

    parent(): CheerioCollection {
        const out: Element[] = [];
        this.nodes.forEach(node => {
            const parent = node.parentElement;
            if (parent && !out.includes(parent)) out.push(parent);
        });
        return new CheerioCollection(out);
    }

    parents(selector?: string): CheerioCollection {
        const out: Element[] = [];
        this.nodes.forEach(node => {
            let current = node.parentElement;
            while (current) {
                if (!selector || matchesSelector(current, selector)) out.push(current);
                current = current.parentElement;
            }
        });
        return new CheerioCollection(out);
    }

    closest(selector: string): CheerioCollection {
        const out: Element[] = [];
        this.nodes.forEach(node => {
            const match = node.closest(selector);
            if (match) out.push(match);
        });
        return new CheerioCollection(out);
    }

    siblings(selector?: string): CheerioCollection {
        const out: Element[] = [];
        this.nodes.forEach(node => {
            const parent = node.parentElement;
            if (!parent) return;
            Array.from(parent.children).forEach(child => {
                if (child !== node && (!selector || matchesSelector(child, selector))) out.push(child);
            });
        });
        return new CheerioCollection(out);
    }

    next(selector?: string): CheerioCollection {
        const out: Element[] = [];
        this.nodes.forEach(node => {
            const sibling = node.nextElementSibling;
            if (sibling && (!selector || matchesSelector(sibling, selector))) out.push(sibling);
        });
        return new CheerioCollection(out);
    }

    prev(selector?: string): CheerioCollection {
        const out: Element[] = [];
        this.nodes.forEach(node => {
            const sibling = node.previousElementSibling;
            if (sibling && (!selector || matchesSelector(sibling, selector))) out.push(sibling);
        });
        return new CheerioCollection(out);
    }

    index(): number {
        const element = this.nodes[0];
        const parent = element?.parentElement;
        return element && parent ? Array.from(parent.children).indexOf(element) : -1;
    }

    remove(): CheerioCollection {
        this.nodes.forEach(element => element.remove());
        return this;
    }

    empty(): CheerioCollection {
        this.nodes.forEach(element => {
            element.innerHTML = '';
        });
        return this;
    }

    append(html: string): CheerioCollection {
        this.nodes.forEach(element => element.insertAdjacentHTML('beforeend', html));
        return this;
    }

    prepend(html: string): CheerioCollection {
        this.nodes.forEach(element => element.insertAdjacentHTML('afterbegin', html));
        return this;
    }

    before(html: string): CheerioCollection {
        this.nodes.forEach(element => element.insertAdjacentHTML('beforebegin', html));
        return this;
    }

    after(html: string): CheerioCollection {
        this.nodes.forEach(element => element.insertAdjacentHTML('afterend', html));
        return this;
    }

    replaceWith(html: string): CheerioCollection {
        this.nodes.forEach(element => {
            element.insertAdjacentHTML('beforebegin', html);
            element.remove();
        });
        return this;
    }

    clone(): CheerioCollection {
        return new CheerioCollection(this.nodes.map(element => element.cloneNode(true) as Element));
    }
}

type CheerioLoadFn = {
    (selector: string | Element | CheerioCollection | Element[] | null | undefined, context?: CheerioNode): CheerioCollection;
    html(): string;
    root(): CheerioCollection;
    contains(container: Element, contained: Element): boolean;
    load(html: string, options?: Record<string, unknown>): CheerioLoadFn;
};

const makeLoadFunction = (rootDocument: Document | null): CheerioLoadFn => {
    const load: CheerioLoadFn = (selector, context) => {
        if (selector === null || selector === undefined) return new CheerioCollection([]);
        if (selector instanceof CheerioCollection) return selector;
        if (Array.isArray(selector)) return new CheerioCollection(asElements(selector as CheerioNode[]));
        if (typeof selector === 'object') return new CheerioCollection(asElements([selector as CheerioNode]));
        const text = String(selector).trim();
        if (text.startsWith('<')) return new CheerioCollection(parseHtmlFragment(text));
        const root = context ?? rootDocument ?? (typeof document !== 'undefined' ? document : null);
        if (!root) return new CheerioCollection([]);
        return new CheerioCollection(queryWithin(root, text));
    };
    load.html = () => rootDocument?.documentElement?.outerHTML ?? '';
    load.root = () => new CheerioCollection(asElements(rootDocument ? [rootDocument.documentElement] : []));
    load.contains = (container, contained) => container !== contained && container.contains(contained);
    load.load = (html: string) => makeLoadFunction(parseHtmlDocument(html));
    return load;
};

/** `cheerio`：`load(html)` 用 DOMParser 解析出一份文档，`$(...)` 在它里面查。 */
export const createCheerio = () => ({
    load: (html: string, _options?: Record<string, unknown>) => makeLoadFunction(parseHtmlDocument(html)),
    html: (html?: string) => (html === undefined ? '' : String(html)),
    root: () => new CheerioCollection([]),
    contains: (container: Element, contained: Element) => container !== contained && container.contains(contained),
    parseHTML: (html: string) => parseHtmlFragment(String(html)),
});

// ─── axios ──────────────────────────────────────────────────────────────

type AxiosHeaders = Record<string, string>;

interface AxiosRequestConfig {
    url?: string;
    baseURL?: string;
    method?: string;
    headers?: AxiosHeaders;
    params?: Record<string, unknown>;
    data?: unknown;
    timeout?: number;
    responseType?: 'json' | 'text' | 'arraybuffer' | 'blob';
    /** 覆盖按 content-type 推出来的字符集。 */
    responseEncoding?: string;
    validateStatus?: ((status: number) => boolean) | null;
}

interface AxiosResponse<T = unknown> {
    data: T;
    status: number;
    statusText: string;
    headers: AxiosHeaders;
    config: AxiosRequestConfig;
    request?: unknown;
}

interface AxiosErrorLike extends Error {
    isAxiosError?: boolean;
    config?: AxiosRequestConfig;
    response?: AxiosResponse;
    code?: string;
}

type InterceptorHandler<T> = (value: T) => T | Promise<T>;

const normalizeResponseHeaders = (headers: Record<string, string>): AxiosHeaders => {
    const out: AxiosHeaders = {};
    Object.entries(headers).forEach(([key, value]) => {
        out[key.toLowerCase()] = value;
    });
    const setCookie = headers['set-cookie'];
    if (setCookie) {
        out['set-cookie'] = setCookie;
        out['x-set-cookie'] = setCookie;
    }
    return out;
};

/**
 * axios 的头可以是平的，也可以分成 `common` / `get` / `post`（插件常写
 * `axios.defaults.headers.common['X'] = ...`）；发出去时都摊平成一层的字符串。
 */
const flattenHeaders = (headers: Record<string, unknown> | undefined): AxiosHeaders => {
    const out: AxiosHeaders = {};
    Object.entries(headers ?? {}).forEach(([key, value]) => {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            Object.entries(value as Record<string, unknown>).forEach(([childKey, childValue]) => {
                if (typeof childValue === 'string') out[childKey] = childValue;
            });
            return;
        }
        if (typeof value === 'string') out[key] = value;
    });
    return out;
};

const joinUrl = (config: AxiosRequestConfig): string => {
    let url = config.url ?? '';
    const baseURL = config.baseURL ?? '';
    if (baseURL && !/^https?:\/\//i.test(url)) {
        url = `${baseURL.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`;
    }
    if (config.params) {
        const query = stringifyQuery(config.params);
        if (query) url += (url.includes('?') ? '&' : '?') + query;
    }
    return url;
};

const axiosRequest = async (config: AxiosRequestConfig): Promise<AxiosResponse> => {
    const method = (config.method ?? 'get').toUpperCase();
    const headers: AxiosHeaders = { ...(config.headers ?? {}) };
    const hasContentType = Object.keys(headers).some(key => key.toLowerCase() === 'content-type');
    let body: string | undefined;
    const data = config.data;
    if (data !== undefined && method !== 'GET' && method !== 'HEAD') {
        if (typeof data === 'string') {
            body = data;
        } else if (data instanceof URLSearchParams) {
            body = data.toString();
            if (!hasContentType) headers['Content-Type'] = 'application/x-www-form-urlencoded';
        } else {
            body = JSON.stringify(data);
            if (!hasContentType) headers['Content-Type'] = 'application/json';
        }
    }
    const request: PluginNetworkRequest = {
        url: joinUrl(config),
        method,
        headers,
        body,
        timeoutMs: config.timeout && config.timeout > 0 ? config.timeout : undefined,
    };
    const answer: PluginNetworkResponse = await requestPluginNetwork(request);
    const responseHeaders = normalizeResponseHeaders(answer.headers);
    const contentType = responseHeaders['content-type'];
    const text = config.responseEncoding
        ? new TextDecoder(config.responseEncoding).decode(answer.bytes)
        : decodePluginText(answer.bytes, contentType);
    let responseData: unknown = text;
    if (config.responseType === 'arraybuffer') {
        responseData = answer.bytes.buffer.slice(
            answer.bytes.byteOffset,
            answer.bytes.byteOffset + answer.bytes.byteLength,
        );
    } else if (config.responseType === 'blob') {
        responseData = new Blob([answer.bytes as unknown as BlobPart], { type: contentType ?? 'application/octet-stream' });
    } else if (config.responseType !== 'text') {
        const trimmed = text.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
                responseData = JSON.parse(trimmed);
            } catch {
                responseData = text;
            }
        }
    }
    const response: AxiosResponse = {
        data: responseData,
        status: answer.status,
        statusText: answer.statusText,
        headers: responseHeaders,
        config,
        request: { url: request.url, method },
    };
    const validate = config.validateStatus === null
        ? () => true
        : (config.validateStatus ?? ((status: number) => status >= 200 && status < 300));
    if (!validate(answer.status)) {
        const error: AxiosErrorLike = new Error(`Request failed with status code ${answer.status}`);
        error.isAxiosError = true;
        error.config = config;
        error.response = response;
        error.code = String(answer.status);
        throw error;
    }
    return response;
};

/** 一个插件一份 axios：`defaults` 和拦截器是它自己的，不会串到别的插件。 */
export const createAxios = (baseDefaults: AxiosRequestConfig = {}) => {
    const defaults: AxiosRequestConfig = {
        ...baseDefaults,
        headers: (baseDefaults.headers ?? { common: {}, get: {}, post: {} }) as AxiosHeaders,
        timeout: baseDefaults.timeout ?? 15_000,
    };
    const requestInterceptors: Array<InterceptorHandler<AxiosRequestConfig>> = [];
    const responseInterceptors: Array<InterceptorHandler<AxiosResponse>> = [];

    const mergeConfig = (config: AxiosRequestConfig): AxiosRequestConfig => ({
        ...defaults,
        ...config,
        headers: {
            ...flattenHeaders(defaults.headers as unknown as Record<string, unknown>),
            ...flattenHeaders(config.headers as unknown as Record<string, unknown>),
        },
    });

    const dispatch = async (config: AxiosRequestConfig): Promise<AxiosResponse> => {
        let next = mergeConfig(config);
        for (const interceptor of requestInterceptors) {
            next = await interceptor(next);
        }
        let response = await axiosRequest(next);
        for (const interceptor of responseInterceptors) {
            response = await interceptor(response);
        }
        return response;
    };

    const instance = {
        request: (config: AxiosRequestConfig) => dispatch(config),
        get: (url: string, config: AxiosRequestConfig = {}) => dispatch({ ...config, url, method: 'get' }),
        delete: (url: string, config: AxiosRequestConfig = {}) => dispatch({ ...config, url, method: 'delete' }),
        head: (url: string, config: AxiosRequestConfig = {}) => dispatch({ ...config, url, method: 'head' }),
        post: (url: string, data?: unknown, config: AxiosRequestConfig = {}) => dispatch({ ...config, url, data, method: 'post' }),
        put: (url: string, data?: unknown, config: AxiosRequestConfig = {}) => dispatch({ ...config, url, data, method: 'put' }),
        patch: (url: string, data?: unknown, config: AxiosRequestConfig = {}) => dispatch({ ...config, url, data, method: 'patch' }),
        defaults,
        interceptors: {
            request: {
                use: (handler: InterceptorHandler<AxiosRequestConfig>) => {
                    requestInterceptors.push(handler);
                    return requestInterceptors.length - 1;
                },
                eject: (id: number) => {
                    if (id >= 0 && id < requestInterceptors.length) requestInterceptors[id] = config => config;
                },
            },
            response: {
                use: (handler: InterceptorHandler<AxiosResponse>) => {
                    responseInterceptors.push(handler);
                    return responseInterceptors.length - 1;
                },
                eject: (id: number) => {
                    if (id >= 0 && id < responseInterceptors.length) responseInterceptors[id] = response => response;
                },
            },
        },
        create: (config: AxiosRequestConfig = {}) => createAxios({
            ...defaults,
            ...config,
            headers: { ...(defaults.headers ?? {}), ...(config.headers ?? {}) },
        }),
        all: <T>(values: Array<T | Promise<T>>) => Promise.all(values),
        spread: <T, R>(callback: (...values: T[]) => R) => (values: T[]) => callback(...values),
        isAxiosError: (value: unknown) => Boolean((value as AxiosErrorLike | null)?.isAxiosError),
        isCancel: () => false,
        CancelToken: {
            source: () => ({ token: {}, cancel: () => {} }),
        },
    };
    return instance;
};

/** `_require` 的回答：模块对象本身，`default` 指向自己（和 MusicFree 的 require 一样）。 */
export const withDefault = <T extends object>(module: T): T => {
    Object.defineProperty(module, 'default', {
        value: module,
        enumerable: false,
        configurable: true,
    });
    return module;
};

export { CheerioCollection };
export type { AxiosRequestConfig, AxiosResponse };
