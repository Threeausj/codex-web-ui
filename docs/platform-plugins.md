# 插件选择与 macOS / Windows 工作站

## 使用安装在主机上的插件

在消息输入框输入 `@`，或点击 `@` 按钮，选择当前主机已安装的插件或已连接的应用。列表同时保留模式切换和项目文件引用；输入名称可以筛选，支持键盘和触控。已停用的插件和不可访问的应用不能选中。

插件选择插入 Codex 官方引用，例如 `[@Documents](plugin://documents@openai-primary-runtime)`；发送时附带原生 `mention` 输入，引用也随文字草稿保存。应用使用 `app://` 引用。`/` 仍用于技能和提示词预设。切换主机、目录或会话后重新读取对应清单，迟到的结果不会覆盖新上下文。

已安装插件通过 `codex plugin list --json` 和受限的插件清单读取；不依赖尚未建议生产使用的 `plugin/list` RPC。旧 CLI 不能提供安装清单时，仍可列出 `skills/list` 中带有 `pluginId` 的插件技能。该菜单不安装插件，也不转移另一台主机的账户或授权。

激活插件不等于获得所有桌面宿主能力。桌面应用专有的依赖加载、图形界面操控和动态工具仍需相应宿主提供；当前独立 Web 后台不会伪造这些能力。模型能否调用应用还取决于目标主机账户、插件授权和提供方。

## Windows 连接

在连接的高级选项中将 **主机系统** 设为 **Windows**。工作目录可以使用 `C:/Users/name/project` 或 `C:\Users\name\project`；文件导航、上传下载、预览、项目匹配及 Git/worktree 保留 Windows 盘符和中文路径。

Windows OpenSSH 的持续标准输入需要 `cmd.exe` 入口。本次实机上的默认 PowerShell 会截留后续 RPC 输入；网页终端仍使用 PowerShell，支持多个 PTY 和 Tab 补全。若需修改 SSH 入口，在 Windows 管理员 PowerShell 中执行：

```powershell
New-ItemProperty -Path HKLM:\SOFTWARE\OpenSSH -Name DefaultShell `
  -Value "$env:WINDIR\System32\cmd.exe" -PropertyType String -Force
```

新 SSH 连接生效；已有连接需重新连接。此操作不会将网页终端改成 cmd。企业策略可能限制设置，请遵循该主机的管理要求。

服务可以发现官方独立 CLI、已安装桌面应用中的原生 `codex.exe`、以及桌面运行时的 Python、Node 和 Git。远端辅助功能需要可执行的 Python 3。仅有桌面随附的精简 CLI 时，独立 daemon 可能缺少完整安装包；需安装官方完整 CLI。Windows 首次启动 daemon 要在该用户的**普通、非管理员终端**运行：

```powershell
codex app-server daemon start
```

之后网页优先查询并连接已经运行的 daemon，避免管理员 SSH 再次触发启动限制。不要通过关闭 UAC、删除会话锁或结束桌面进程来处理连接问题。安装在不同位置时可在连接中指定完整 `codex.exe` 路径。

Windows 上传目录及中转站密钥使用受保护的 NTFS DACL，仅授予当前账户访问权限；不能以 `chmod 700/600` 代替 Windows 权限设置。原生 Windows 不提供 tmux，长任务需要合适的后台管理工具；WSL 应作为独立 Linux SSH 工作站配置。

## “同时控制”与“共享历史”的区别

同一用户、同一 `CODEX_HOME` 可以共享磁盘历史。**同一正在运行的会话，还要求客户端连接同一个 App Server。** 两个不同进程读取同一数据目录时，仍会遇到会话写入锁。

本次 Mac 和 Windows 桌面端的“此电脑”入口启动了独立 stdio App Server；网页连接的是另一后台。Linux 服务器通过桌面端的远程入口连接同一 daemon 时，可以和网页共同操作并实时更新。这是连接入口的区别，不是 Linux 独有的同步能力。

Windows 实机已验证两个独立原生 proxy 客户端加入同一 daemon、交替发送消息、双方接收实时输出，并在断开一个客户端后继续读取会话。该验证不代表原生桌面应用“此电脑”入口已经改接该 daemon；当前没有将桌面的私有 stdio 进程变成可附加 socket，也不会强制接管用户的正在运行会话。

## 实机验证范围

2026-11-12 使用 macOS 和 Windows 工作站验证，完整 CLI 均为 0.167.1：

| 功能 | macOS | Windows |
| --- | --- | --- |
| 插件清单 | 12 个可见插件 | 11 个可见插件 |
| 中文文件创建、读取、保存、重命名、删除及冲突保护 | 通过 | 通过 |
| 私有目录上传、禁止覆盖、清理 | 通过 | 通过，NTFS 权限 |
| 两个同时运行的 PTY、Tab 补全 | 通过，Zsh | 通过，PowerShell |
| CPU / 内存 | 通过 | 通过 |
| NVIDIA GPU | 无此硬件 | 通过 |
| 插件实际调用 | Documents 技能加载及 Word 生成、ZIP/XML 核验通过 | 已验证清单，未宣称所有插件工具均可调用 |
| 原生 schema、更新前版本读取、Git 暂存/提交/worktree、writer 锁检测 | 使用现有功能 | 通过，测试仓库已清理 |
| 两个独立客户端共享同一 daemon 的模型轮次 | 未替代原生桌面入口验证 | 通过，测试聊天归档 |

相关说明：[独立后台服务](independent-daemon.md)、[主机设置](host-settings.md)、[验证清单](validation.md)。官方参考：[插件](https://learn.chatgpt.com/docs/plugins)、[App Server](https://learn.chatgpt.com/docs/app-server)、[远程连接](https://learn.chatgpt.com/docs/remote-connections)、[Windows OpenSSH 配置](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh-server-configuration)。
