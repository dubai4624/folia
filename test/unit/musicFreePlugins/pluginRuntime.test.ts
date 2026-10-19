import { describe, expect, it } from 'vitest';
import { hashPluginCode, mountMusicFreePlugin, MusicFreePluginMountError } from '../../../src/services/musicFreePlugins/pluginRuntime';

// test/unit/musicFreePlugins/pluginRuntime.test.ts
// 插件源码按 MusicFree 的方式执行：module.exports（或它的 default）就是插件的定义。

const mount = (code: string, variables: Record<string, string> = {}) => mountMusicFreePlugin(code, {
    getVariables: () => variables,
    label: 'test',
});

describe('mountMusicFreePlugin', () => {
    it('mounts a plugin that exports its definition on module.exports', () => {
        const plugin = mount(`
            module.exports = {
                platform: 'Example',
                version: '1.0.0',
                author: 'someone',
                async search() { return { isEnd: true, data: [] }; },
                async getMediaSource() { return { url: 'https://example.com/a.mp3' }; },
                async getLyric() { return null; },
                getTopLists() { return Promise.resolve([]); },
                helper: 42,
            };
        `);
        expect(plugin.definition.platform).toBe('Example');
        expect(plugin.definition.version).toBe('1.0.0');
        expect([...plugin.methods].sort()).toEqual(['getLyric', 'getMediaSource', 'getTopLists', 'search']);
    });

    it('uses the default export when the plugin gives one', () => {
        const plugin = mount(`
            module.exports = { default: { platform: 'Defaulted', getMusicInfo() {} } };
        `);
        expect(plugin.definition.platform).toBe('Defaulted');
        expect([...plugin.methods]).toEqual(['getMusicInfo']);
    });

    it('keeps the variables the plugin declares, dropping entries without a key', () => {
        const plugin = mount(`
            module.exports = {
                platform: 'Vars',
                userVariables: [{ key: 'token', name: 'Token' }, { name: 'no key' }, null],
            };
        `);
        expect(plugin.userVariables).toEqual([{ key: 'token', name: 'Token' }]);
    });

    it('hands the plugin its user variables through env', () => {
        const plugin = mount(`
            module.exports = {
                platform: 'Env',
                token: env.getUserVariables().token,
                versionSeen: process.version,
                osSeen: env.os,
            };
        `, { token: 'abc' });
        expect(plugin.definition.token).toBe('abc');
        expect(plugin.definition.osSeen).toBe('android');
        expect(typeof plugin.definition.versionSeen).toBe('string');
    });

    it('rejects code without a definition or a platform', () => {
        expect(() => mount('module.exports = {};')).toThrow(MusicFreePluginMountError);
        expect(() => mount('module.exports = { platform: "" };')).toThrow(MusicFreePluginMountError);
        expect(() => mount('this is not javascript')).toThrow(MusicFreePluginMountError);
        expect(() => mount('   ')).toThrow(MusicFreePluginMountError);
    });

    it('names the module a plugin asked for that this host does not provide', () => {
        expect(() => mount(`
            const webdav = require('webdav');
            module.exports = { platform: 'WebDAV' };
        `)).toThrow(/webdav/);
    });

    it('provides the libraries MusicFree plugins expect', () => {
        const plugin = mount(`
            const CryptoJs = require('crypto-js');
            const dayjs = require('dayjs');
            const bigInt = require('big-integer');
            const qs = require('qs');
            const he = require('he');
            module.exports = {
                platform: 'Libs',
                md5: CryptoJs.MD5('a').toString(),
                year: dayjs('2020-01-01').year(),
                big: bigInt(2).pow(10).toString(),
                query: qs.stringify({ a: [1, 2] }),
                entity: he.decode('a&amp;b'),
            };
        `);
        expect(plugin.definition.md5).toBe('0cc175b9c0f1b6a831c399e269772661');
        expect(plugin.definition.year).toBe(2020);
        expect(plugin.definition.big).toBe('1024');
        expect(plugin.definition.query).toBe('a[]=1&a[]=2');
        expect(plugin.definition.entity).toBe('a&b');
    });
});

describe('hashPluginCode', () => {
    it('gives the same code the same hash and different code another', async () => {
        const first = await hashPluginCode('module.exports = { platform: "A" };');
        const same = await hashPluginCode('module.exports = { platform: "A" };');
        const other = await hashPluginCode('module.exports = { platform: "B" };');
        expect(first).toBe(same);
        expect(other).not.toBe(first);
    });
});
