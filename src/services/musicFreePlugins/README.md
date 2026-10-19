# src/services/musicFreePlugins

MusicFree 插件的宿主：把 MusicFree 插件装进 Folia，登记成在线音源。设置 →「音乐源插件」是它的界面
（`src/components/pluginSources/`），主进程那一半在 `electron/musicFreePlugins.cjs`。

## 为什么是这一套

MusicFree 的插件是一段 JS：`module.exports = { platform, search, getMediaSource, getLyric, ... }`。
Folia 的在线音源是一份 `OnlineMusicProvider`（`src/types/onlineMusic.ts`）。这里做的就是前者接成后者：

| MusicFree | Folia |
| --- | --- |
| `platform` | provider id `musicfree.<platform>`，歌曲的 `sourceRef.providerId` |
| `search(query, page, type)` | `provider.search.searchSongs` |
| `getMediaSource(item, quality)` | `provider.playback.getAudioSource`（`low/standard/high/super` 对应 Folia 的四档，取不到就往下一档退） |
| `getMusicInfo` | `provider.playback.getSongDetail` |
| `getLyric` | `provider.lyrics.getLyrics`（LRC / 增强 LRC 都按 Folia 的解析器解） |
| `getMusicSheetInfo`、`getTopListDetail` | `provider.catalog.getPlaylistTracks`、`getPlaylistDetail`（榜单 id 带 `toplist:` 前缀） |
| `getAlbumInfo` | `provider.catalog.getAlbumTracks`、`getAlbumDetail` |
| `getArtistWorks` | `provider.catalog.getArtistSongs`、`getArtistAlbums` |
| `getTopLists`、`getRecommendSheetTags`、`getRecommendSheetsByTag` | `provider.explore.getFeed` |

插件不按 Folia 的目录 id 说话，所以歌曲行里的歌手/专辑不做成可点的目录入口
（`catalog.canResolveSongCatalogRefs` 回 false）。

## 文件

- `pluginRuntime.ts`：执行插件源码（和 MusicFree 同一个函数签名），校验导出，算哈希，调用的时限。
- `pluginShims.ts`：`require` 能拿到的库。`axios` 走插件请求桥；`qs`、`he`、`cheerio` 是浏览器里能给的
  那一部分；`crypto-js`、`dayjs`、`big-integer` 用真正的包。
- `pluginNetwork.ts`：请求。桌面版经 IPC 交给主进程发（不受 CORS 限制，跟随系统代理）；网页版退回
  `fetch`。音频地址另外登记一次，主进程才给它补 CORS 头和插件要求的 Referer / User-Agent。
- `pluginStore.ts`：装好的代码、启用/排序/变量、订阅地址，各自的 localStorage 键与容错。
- `pluginProvider.ts`：一个挂好的插件 → `OnlineMusicProvider`。
- `pluginPaging.ts`：把插件的“第 N 页”拼成 Folia 的 limit/offset。
- `pluginHost.ts`：装、更新、卸、启停、排序、变量、订阅，以及和 `providerRegistry` 的登记/注销。

## 生命周期

`bootstrap.tsx` 在第一屏之前调 `musicFreePluginHost.start()`：读 localStorage、同步挂载（只执行插件顶层
代码，不发请求）、按用户的选择登记 provider。之后每次改动都经 `syncRegistrations()` 重新登记，界面经
`useSyncExternalStore` 订阅 `list()` 的快照；平台列表本身由 `omni.getProviderSummaries()` 跟着注册表
变。停用的插件不登记，卸载的插件注销并清掉它留在内存里的原始条目。

## 替代插件

每个插件可以指定另一个插件解析它的播放地址（MusicFree 的「替代插件」，设置里「播放由」那个列表）：
配了、且那个插件实现了 `getMediaSource`，就只由它取地址，不再回退到本插件——和 MusicFree 的
`pluginManager.getAlternativePlugin` 相同。候选只有已启用、还解析得了、能取播放地址的插件。解析时
每次取地址都重新问一遍，所以换设置不用重新登记 provider。

## 导入单曲 / 歌单

插件声明了 `importMusicItem` / `importMusicSheet` 时，它的行上会多一个「导入」：填分享链接或 ID，
插件交回的歌曲转成 Folia 的歌曲后**加到播放队列末尾**（`services/songQueueRequests.ts` 交给
App 的队列控制器，预取、去重、历史都和平时加歌一样）。MusicFree 是加进本地歌单；Folia 的本地歌单
只收本地文件，在线歌单要平台自己有写入能力，而插件源没有，所以这里落在队列上。

## 和搜索的关系

装好的插件会出现在**搜索浮层的来源列表**里（`components/app/search/useSearchOnlineSources.ts`）：搜索不再只查
当前平台，而是列出注册表里所有的在线音源，当前平台排第一。所以装了插件就能直接搜，不用先把它切成当前平台。

只声明了 `getMediaSource`（没实现 `search`）的插件仍会出现在列表里，选中时页面明说「这个音源只提供了播放
地址，不能搜索」，而不是给一个空结果页。插件被卸载或停用后，停在它上面的搜索页签会退回当前平台，上一次
结果一并清掉（结果属于提交那一刻的来源）。

## 登记与顺序

装好的插件在 `providerRegistry` 里按用户排序接在内置平台后面。同步登记是增量的：先登记新的、原位
换掉更新过的，再撤掉停用/卸载的，最后整份重排一次、只通知一次。这样替换或更新插件时注册表不会
出现空档，正在用的平台不会因为一时找不到而回落到默认平台。

## 已知边界

- 插件在渲染进程里执行（和 MusicFree 一样），能调用 preload 暴露的桥。界面上的安全提示就是要说这个。
- 插件给音频的请求头（Referer、User-Agent）只在桌面版生效；网页版拿不到，且要对方给 CORS 头。
- 插件依赖的库只提供上面那几个；要 `webdav`、`undici` 之类的插件会在挂载时报出少了哪个模块。
- 插件自己的登录（扫码、Cookie）没有移植：插件源都是不需要账户的。
