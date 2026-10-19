import CryptoJs from 'crypto-js';
import dayjs from 'dayjs';
import bigInt from 'big-integer';
import type { MusicFreePluginDefinition, MusicFreeUserVariable } from '../../types/musicFreePlugin';
import { errorMessage } from '../../utils/errorText';
import { createAxios, createCheerio, heShim, qsShim, withDefault } from './pluginShims';

// src/services/musicFreePlugins/pluginRuntime.ts
// 把一段 MusicFree 插件的源码挂起来：用和 MusicFree 相同的函数签名执行它，给它一份 `require`（几个
// 库）、`console`、`env`、`process`，然后校验它交出来的定义。这里只负责“能不能用”，插件的调用由
// pluginProvider 经 `callPluginMethod` 发出去。

/** 插件调用一次最多等多久；超时当这一次失败，免得一次请求挂住整个界面。 */
export const PLUGIN_CALL_TIMEOUT_MS = 25_000;

/**
 * 插件在 `env.appVersion` / `process.version` 里看到的版本号。它和 MusicFree 当前版本保持一致：
 * 插件常把这个值拼进 User-Agent 或拿它做版本判断，报 Folia 的版本会让它们走不认识的路径。
 */
export const MUSICFREE_HOST_APP_VERSION = '0.6.2';

const KNOWN_PACKAGES = ['axios', 'cheerio', 'crypto-js', 'dayjs', 'big-integer', 'qs', 'he'] as const;

export class MusicFreePluginMountError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'MusicFreePluginMountError';
    }
}

export interface MountedMusicFreePlugin {
    definition: MusicFreePluginDefinition;
    /** The names of the members that are functions: what this source can do. */
    methods: Set<string>;
    userVariables: MusicFreeUserVariable[];
}

/** 安装、更新时用的哈希：同一段代码永远得到同一个值。 */
export const hashPluginCode = async (code: string): Promise<string> => {
    try {
        if (globalThis.crypto?.subtle) {
            const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
            return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
        }
    } catch {
        // 没有 subtle（不是安全上下文）就退回下面的整数哈希。
    }
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let index = 0; index < code.length; index += 1) {
        const unit = code.charCodeAt(index);
        h1 = Math.imul(h1 ^ unit, 0x01000193);
        h2 = Math.imul(h2 ^ unit, 0x85ebca6b);
    }
    const part = (value: number) => (value >>> 0).toString(16).padStart(8, '0');
    return `fnv-${part(h1)}${part(h2)}${part(Math.imul(h1, h2))}${part(h1 ^ h2)}`;
};

const createConsoleShim = (label: string) => {
    const bind = (method: 'log' | 'info' | 'warn' | 'error') => (...args: unknown[]) => {
        console[method](`[MusicFreePlugins:${label}]`, ...args);
    };
    return {
        log: bind('log'),
        info: bind('info'),
        warn: bind('warn'),
        error: bind('error'),
        debug: bind('log'),
    };
};

const resolvePackage = (name: string): unknown => {
    switch (name) {
        case 'axios':
            return withDefault(createAxios() as unknown as Record<string, unknown>);
        case 'cheerio':
            return withDefault(createCheerio() as unknown as Record<string, unknown>);
        case 'crypto-js':
            return withDefault(CryptoJs as unknown as Record<string, unknown>);
        case 'dayjs':
            return withDefault(dayjs as unknown as Record<string, unknown>);
        case 'big-integer':
            return withDefault(bigInt as unknown as Record<string, unknown>);
        case 'qs':
            return withDefault(qsShim as unknown as Record<string, unknown>);
        case 'he':
            return withDefault(heShim as unknown as Record<string, unknown>);
        default:
            throw new MusicFreePluginMountError(
                `this plugin needs the module "${name}", which the plugin host does not provide (supported: ${KNOWN_PACKAGES.join(', ')})`,
            );
    }
};

const isPluginDefinition = (value: unknown): value is MusicFreePluginDefinition => (
    Boolean(value)
    && typeof value === 'object'
    && typeof (value as MusicFreePluginDefinition).platform === 'string'
    && (value as MusicFreePluginDefinition).platform.trim().length > 0
);

/**
 * 执行插件源码并拿到它交出来的定义。抛错时消息会显示在插件列表里：插件自己抛的错原样带出，
 * 语法错误、缺平台名也都能看出是哪一种。
 */
export const mountMusicFreePlugin = (
    code: string,
    options: {
        /** 插件读取的用户变量；每次调用都现读，改过变量不必重挂。 */
        getVariables: () => Record<string, string>;
        /** 显示在日志里的名字。 */
        label: string;
    },
): MountedMusicFreePlugin => {
    if (typeof code !== 'string' || !code.trim()) {
        throw new MusicFreePluginMountError('the plugin code is empty');
    }
    const label = options.label || 'plugin';
    const moduleLike: { exports: Record<string, unknown> } = { exports: {} };
    type PluginEnv = {
        getUserVariables(): Record<string, string>;
        readonly userVariables: Record<string, string>;
        readonly appVersion: string;
        os: string;
        lang: string;
    };
    const env: PluginEnv = {
        getUserVariables: () => options.getVariables() ?? {},
        get userVariables() {
            return this.getUserVariables();
        },
        get appVersion() {
            return MUSICFREE_HOST_APP_VERSION;
        },
        os: 'android',
        lang: 'zh-CN',
    };
    const processShim: { platform: string; readonly version: string; env: PluginEnv } = {
        platform: 'android',
        get version() {
            return MUSICFREE_HOST_APP_VERSION;
        },
        env,
    };
    const consoleShim = createConsoleShim(label);

    let instance: unknown;
    try {
        // 和 MusicFree 的挂载方式相同：源码变成一个函数的函数体，参数就是它可用的东西。
        // eslint-disable-next-line no-new-func
        const factory = new Function(`
            'use strict';
            return function(require, __musicfree_require, module, exports, console, env, URL, process) {
                ${code}
            };
        `) as () => (
            requireFn: (name: string) => unknown,
            requireFn2: (name: string) => unknown,
            module: typeof moduleLike,
            exports: Record<string, unknown>,
            consoleShim: ReturnType<typeof createConsoleShim>,
            env: PluginEnv,
            url: typeof URL,
            processShim: { platform: string; readonly version: string; env: PluginEnv },
        ) => unknown;
        instance = factory()(
            resolvePackage,
            resolvePackage,
            moduleLike,
            moduleLike.exports,
            consoleShim,
            env,
            URL,
            processShim,
        );
    } catch (error) {
        throw new MusicFreePluginMountError(`the plugin code failed to run: ${errorMessage(error)}`);
    }

    const exported = (moduleLike.exports as { default?: unknown }).default ?? moduleLike.exports;
    if (!isPluginDefinition(exported)) {
        throw new MusicFreePluginMountError('the plugin code did not export a definition with a platform name');
    }

    const definition = exported as MusicFreePluginDefinition;
    const methods = new Set(
        Object.keys(definition).filter(key => typeof (definition as Record<string, unknown>)[key] === 'function'),
    );
    const userVariables = Array.isArray(definition.userVariables)
        ? definition.userVariables.filter(variable => Boolean(variable) && typeof variable.key === 'string' && variable.key)
        : [];

    return { definition, methods, userVariables };
};

/**
 * 调一个插件方法，带上时限。插件自己抛的错原样往外传（它的 `failure` 交给调用方），
 * 超时和抛出都记一行日志：插件里的错在别处看不到。
 */
export const callPluginMethod = async <T>(
    label: string,
    method: string,
    run: () => Promise<T> | T,
    timeoutMs: number = PLUGIN_CALL_TIMEOUT_MS,
): Promise<T> => {
    let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
    try {
        const answer = await Promise.race([
            Promise.resolve().then(run),
            new Promise<never>((_resolve, reject) => {
                timer = globalThis.setTimeout(() => {
                    reject(new Error(`"${method}" did not answer within ${Math.round(timeoutMs / 1000)}s`));
                }, timeoutMs);
            }),
        ]);
        return answer;
    } catch (error) {
        console.warn(`[MusicFreePlugins] ${label}: "${method}" failed`, error);
        throw error;
    } finally {
        if (timer !== null) globalThis.clearTimeout(timer);
    }
};
