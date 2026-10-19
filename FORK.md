# 本分叉的改动

本仓库是 [chthollyphile/folia-major](https://github.com/chthollyphile/folia-major) 的分叉，
基于上游 **0.7.21**。许可证为 AGPL-3.0（见 [LICENSE](LICENSE)），版权归上游作者与各贡献者所有；
本分叉保留原许可证与全部版权声明。

## 新增：MusicFree 插件音源

把 [MusicFree](https://github.com/maotoumao/MusicFree) 的插件（一段导出 `platform` / `search` /
`getMediaSource` / `getLyric` 等的 JS）装进 Folia，登记成在线音源，经现有的 `providerRegistry` 和
omni 与内置平台一样参与搜索、播放、歌词、歌单/榜单/专辑和推荐页。

入口：**设置 → 音乐源插件**，或命令面板搜索 `musicfree`。

主要能力：

- **安装**：地址（`.js` 插件或含 `plugins` 列表的 `.json` 清单）、粘贴代码、本地文件。
- **管理**：启停、排序、更新单个/全部、编辑插件声明的用户变量、卸载单个/**清空全部**、订阅地址。
- **替代插件**：可以让另一个插件解析某个平台的播放地址（对应 MusicFree 的「替代插件」）。
- **导入**：插件声明了 `importMusicItem` / `importMusicSheet` 时，可导入单曲/歌单到播放队列。
- **搜索**：装好的插件直接出现在搜索浮层的来源列表里，无需先切成当前平台；只提供播放地址、
  没有实现 `search` 的插件被选中时会明确提示「没有提供搜索」，而不是给一个空结果页。

代码位置：

| 路径 | 作用 |
| --- | --- |
| `src/services/musicFreePlugins/` | 宿主本体（运行时、网络、provider 适配、分页、持久化、管理器）；见该目录的 README |
| `src/components/pluginSources/` | 设置页界面与插件行 |
| `src/components/app/search/useSearchOnlineSources.ts` | 搜索来源列表改为读取注册表 |
| `electron/musicFreePlugins.cjs` | 主进程请求桥与插件音频的 CORS/请求头注入 |
| `test/unit/musicFreePlugins/`、`test/unit/search/` | 对应单测 |

同时改了搜索的行为：搜索浮层的在线来源从「只有当前平台」改成「注册表里所有在线音源」，
当前平台排第一；选中的音源被卸载或停用后自动退回。

## 新增依赖

`crypto-js@4.2.0`、`dayjs@1.11.13`、`big-integer@1.6.52`（以及 `@types/crypto-js@4.2.2`），
用于向插件提供它们在 MusicFree 里能 `require` 到的库。版本钉死，与本仓库其它音乐平台依赖的约定一致。

## 构建说明

本分叉在无法访问 `github.com` 的环境里打过包，因此**跳过了**上游 `beforePack` / `afterPack`
需要的原生资源，产物缺少：

- FFmpeg 转码回退（本地/Navidrome 中 Chromium 解不了的格式）
- 音频分析用的 MNN 运行库与 beat_this / htdemucs 模型（智能过渡）
- Windows 壁纸辅助程序

要打完整包，按上游的方式（能访问 GitHub、装有 CMake/MSVC，壁纸助手另需 Rust）执行
`npm run build:electron`。

## 上游文档

项目结构、开发规范与各模块说明仍以上游文档为准：先读 [AGENTS.md](AGENTS.md)，再看
`src/services/onlineMusic/README.md`、`src/mods/README.md` 等。
