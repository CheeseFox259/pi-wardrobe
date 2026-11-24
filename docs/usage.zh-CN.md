# Pi Wardrobe 使用指南

日常入口是原生 `pi`。从仓库检出代码并安装扩展后，在输入框输入 `/wardrobe`。

## 首次使用

按原生 Pi 的方式安装扩展，然后重载或启动 Pi：

```sh
pi install /path/to/pi-wardrobe/packages/wardrobe
pi
```

首次打开 `/wardrobe`，确认将全局资源和偏好保存为“我的原始配置”。它与其他预设一样，可以编辑、复制、维护和导出。原始恢复备份独立保留；项目配置继续按 Pi 的规则生效。

模型、认证、提供商和模型选择始终使用原生 Pi，无需重新登录。

## 选预设

列表中每个预设只显示一次，标记当前、全局默认与项目默认。直接输入名称搜索。

| 按键 | 操作 |
| --- | --- |
| Enter | 使用选中的预设，进入新对话 |
| → | 管理选中的预设 |
| Ctrl+n | 创建预设 |
| Ctrl+o | 导入预设 |
| Ctrl+d | 草稿 |
| Ctrl+r | 恢复对话 |
| Esc | 关闭 |

当前预设名称默认显示在输入框上方，也可由预设移入自定义页脚。切换当前预设后，启动默认仍由单独的设置控制。旧对话可通过原生 `/resume` 恢复。

## 创建与编辑

**创建**支持从当前全局环境、已有预设或空白开始，也可以让 Pi 创建。

草稿中可以修改名称、勾选资源、从其他预设添加资源、选择偏好和声明设备需求。修改会保存在草稿中，退出后可从 **草稿** 继续。选择 **审阅并保存** 后才生成已安装版本；随后在列表选择使用。

选中预设后按 →，使用 **编辑** 或 **复制**。编辑本地预设保存为新版本；编辑上游预设生成有来源记录的本地派生。复制产生独立身份。版本历史放在 **更多 → 版本**，不挤占主列表。

**让 Pi 创建/编辑**会开始新对话，让当前原生 Pi 模型处理独立草稿。Pi 产物仍需回到草稿页面审阅并保存，不自动启用。

## 导入与导出

**导入 → 本地**接受标准预设目录、`preset.json`、有声明索引的预设集合仓库，或普通 Pi 配置目录。公共资源保存为独立快照，不持续依赖导入时的目录。普通 Pi 目录仅纳入该目录及其明确配置的资源，不混入当前机器其他个人资源。

**导入 → GitHub / Git**接受仓库地址；**npm**接受 Pi 预设包。集合仓库会列出可选预设。检查资源摘要后确认保存，再选择使用。

Perfect Pi 使用相同导入入口，没有专用迁移菜单。旧安装若需要整理，可选择对应 Pi 配置目录；预设源码仓库按标准仓库导入。

**预设管理 → 导出**生成新目录，其中含 `preset.json`、`package.json`、公共资源与依赖声明。将此目录放到另一设备或 GitHub 标准仓库后即可导入；导出不自动发布。

凭据文件、模型配置和已识别的嵌入凭据或本机用户路径会被排除或阻止导出。分享前仍应审阅自定义资源内容。

## 设备绑定

私密扩展配置、本机工具及无法打包的环境资源通过设备需求声明。预设只分享需求，本机路径和值保存在各设备自己的 Wardrobe 存储。

- 创建/编辑草稿时，在 **设备需求** 中新增、改名、调整必需/可选或移除需求。
- 导入后，到 **预设管理 → 更多 → 设备绑定** 选择本机文件或工具。
- 必需绑定缺失时可以保存和编辑，但不能启用；可选绑定缺失会跳过。
- 配置文件绑定目前支持 `mcp.json`、`sol-pi.json`、`web-search.json`；资源绑定支持 skill、extension、prompt、theme；工具绑定以 `WARDROBE_DEVICE_<ID>` 环境变量供扩展使用。

模型与认证不属于设备绑定，继续由 Pi 管理。

## 默认、维护与恢复

**预设管理 → 启动默认**设置全局或项目默认，也可让项目跟随全局。项目默认优先；恢复旧对话时使用其原来的预设版本。

**预设管理 → 更新**检查 Pi 和上游变化，自动保留本地改造，将新增能力及冲突交给当前模型判断。无变化时直接结束，不调用模型。**维护**只处理你指定的问题或增强，不扫描无关更新。验证受影响部分后保存新版本，旧版和当前会话保留。

更新交接的 `releaseNotes` 提供 Pi 旧版到新版的日志、上游 Git 的精确提交区间和变更路径，以及目标 npm 包发布的 CHANGELOG/README。缺少日志或下载超时时会标明原因与可用来源，模型只需读取本次变更相关材料。

新增能力附带代码差异；更换资源时，模型可通过工具查询 npm 候选及精确版本文档，再决定选择与适配。

Pi、Wardrobe 和其他 extension 的更新仍使用原生 `pi update`。普通启动不联网检查预设更新，也不运行维护扫描。

**更多**中可查看详情、版本，修复或移除无引用版本。默认、运行实例和旧对话仍引用的版本会保留，避免破坏恢复。

## 命令入口

日常使用选单即可；脚本或熟练用户可以使用：

```text
/wardrobe create --blank --name "My Preset"
/wardrobe create --from "已有预设" --name "副本"
/wardrobe edit "我的预设"
/wardrobe draft <draft-id>
/wardrobe save <draft-id>
/wardrobe import "/path/to/preset"
/wardrobe import owner/repository --preset presets/work/preset.json
/wardrobe import owner/repository --ref main
/wardrobe export "我的预设" "/path/to/new-directory"
/wardrobe use "我的预设"
/wardrobe default "我的预设" --project
/wardrobe default --project --clear
/wardrobe update "我的预设"
/wardrobe maintain "我的预设" --request "修复的问题或增加的能力"
/wardrobe maintain "我的预设" --verify
/wardrobe maintain "我的预设" --apply
/wardrobe verify "我的预设"
/wardrobe repair "我的预设"
```

创建或编辑命令返回可继续编辑的草稿；`--prepare` 维护不发起模型请求。`--yes` 仅用于有意跳过确认的自动化。旧版 `bind --mode` 会话绑定语义继续兼容，设备绑定命令为 `/wardrobe bind <preset> <requirement-id> <local-path>`。

运行 `/wardrobe update "我的预设"` 后，Pi 会展示更新方案。每项说明能看到什么变化、要保留什么行为，以及如何验收。批准后本轮结束。再次运行同一个命令开始实施。退出确认会保留方案，之后可重新打开。想调整待确认或已批准的方案时，先告诉 Pi 要改什么，或用 `/wardrobe update "我的预设" --revise` 重新拟定。安装仍以验证结果和安装授权为准。

仓库格式见 [Preset 仓库标准](preset-repository-standard.md)。macOS arm64、Node 26.5.0 上有 Pi 1.3.0 的测试覆盖，也用 Pi 1.6.0 完成了实机部署。自动进程交接需要 macOS/Linux 和 Node 22.19+。[实机交接记录](handoffs/pi-wardrobe-native-2026-11-24.zh-CN.md)

预设声明最低 Pi 版本，较旧预设可在较新 Pi 中加载。Pi 升级后，资源配置和代码未变时自动刷新启动记录；扩展的实际 API 错误由原生加载过程指出。
