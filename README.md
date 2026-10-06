# Codex Web UI

**简体中文** · [English](README.en.md)

Vue 3 + TypeScript + Node.js 22 构建的 Codex 网页客户端，支持桌面和手机布局。对话、历史、Fork、压缩、模型、配置、审批、文件与终端使用官方 **Codex app-server** 协议；Node 服务负责浏览器鉴权与连接桥接。

这是完整桌面工作流的开发基线。当前功能与仍待完成的桌面能力列在下面，不将协议中存在的 API 等同于已完成的产品功能。[官方 app-server 文档](https://learn.chatgpt.com/docs/app-server)。

## Docker 快速部署

安装 Docker Engine/Desktop 和 Docker Compose v2，在仓库目录执行：

```sh
cp deploy/docker/env.example .env.docker
chmod 600 .env.docker
mkdir -p workspace
```

编辑 `.env.docker`，填写至少 12 位的独立 `CODEX_WEB_PASSWORD`，并将 `WORKSPACE_PATH` 指向要使用的项目目录；可用 `openssl rand -hex 32` 生成密码。Linux 下，该目录须允许容器用户 `1000:1000` 读写。

```sh
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml up -d --build
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml exec app codex login --device-auth
```

打开 [http://127.0.0.1:8787](http://127.0.0.1:8787)，用网页密码登录，在 UI 中添加 `/workspace` 下的项目。Codex 模型账户登录与网页密码分别管理。

标准 Docker 隔离策略可能阻止 Codex 的 Linux sandbox 创建 namespace；本次实测只读/工作区命令遇到该限制。需要终端、Tmux 或模型命令工具时，可由用户明确选择 Codex“完全访问”，其范围包含容器可访问的挂载及 SSH 主机。部署配置不会自动切换权限，也不使用 privileged 模式。[权限说明](docs/docker.md#检查与排错)。

镜像包含固定版本 Codex CLI `0.159.2`、Git、SSH、Tmux，使用非 root 用户；网页数据和 Codex 配置/历史分别保存在持久化卷中。本地方案只发布回环端口，公网方案使用 Caddy HTTPS。Docker 中的“本机”指容器；不会自动使用 macOS/Windows 桌面账户或连接桌面 daemon。

完整公网部署、SSH、桌面同步边界、升级备份和排错见 [Docker 部署指南](docs/docker.md) / [English guide](docs/docker.en.md)。本地和公网 Compose 配置分别使用，勿同时加载两个 overlay。

## 手机安装与后台通知

使用公网 HTTPS 部署后，打开“设置 → 应用与通知”安装 PWA，并主动点击“启用通知”。Android Chrome 可使用“安装应用”或浏览器安装菜单；iOS/iPadOS 16.4+ 请在 Safari 中“分享 → 添加到主屏幕”，从主屏幕打开应用后再启用通知。

标准 Web Push 支持回复完成、需要审批/补充输入和运行出错提醒，关闭页面或锁屏后仍可接收；服务器和对应 Codex 任务必须继续运行。设备授权与网页登录会话均最长 30 天，分别管理；明确退出登录会撤销当前登录关联的设备订阅，修改访问密码会撤销其他设备的订阅。通知标题显示对话名，正文显示事件，不包含回复正文、命令或文件路径。系统强退、省电、专注模式和通知设置可能影响送达，真实 Android/iPhone 验收仍需在目标设备完成。

VAPID 密钥默认自动生成并持久化到 `DATA_DIR`，Docker 的 `webdata` 卷已经覆盖，无须手动生成。安装、更新、部署参数和手机验收步骤见 [PWA 与通知指南](docs/pwa.md) / [English guide](docs/pwa.en.md)。

## Node.js 启动

需要 Node.js 22+ 和可执行的 Codex CLI。开发基线核对版本为 `codex-cli 0.159.2`。先以运行 Web 服务的系统账户配置 Codex：

```sh
codex --version
codex login
npm install
cp .env.example .env
npm run dev
```

打开 [http://127.0.0.1:5173](http://127.0.0.1:5173)。后端监听 `127.0.0.1:8787`。第一次启动未设置 `CODEX_WEB_PASSWORD` 时会创建随机密码，显示在后端终端，并保存到 `.data/bootstrap-password.txt`，文件权限为 `0600`。也可以在 `.env` 设置至少 12 位的访问密码。

网页登录有效期为 30 天，服务重启后仍需重新登录。在“设置 → 账户 → 网页访问 → 修改访问密码”填写当前密码和两次新密码即可保存。新密码至少 12 个字符；保存后当前设备继续登录并续期，其他设备的登录及后台通知授权被撤销。访问密码散列保存到 `DATA_DIR/web-password.json`（`0600`），优先于 `.env` 和初始密码；之后修改环境变量不会覆盖已保存密码。Docker 保留 `webdata` 卷即可保留修改，忘记密码的重置方式见 [部署指南](docs/docker.md#访问密码与登录)。

网页访问密码与 Codex 模型账户分别管理。默认继承当前用户的 Codex 登录和配置；不要为了启动网页复制账户 token 到前端。

构建后由 Node 提供前端：

```sh
npm run build
npm start
```

此时访问 [http://127.0.0.1:8787](http://127.0.0.1:8787)。公网使用 HTTPS 反向代理并设置密码和 `PUBLIC_ORIGIN`，具体见 [部署文档](docs/deployment.md)、[Caddyfile](deploy/Caddyfile) 与 [systemd 示例](deploy/codex-web.service)。仓库只提供部署文件，尚未在公网发布。

## 功能状态

“已接入”表示包含真实协议调用与 UI；模型账户、SSH 和桌面实时互通的环境验证见 [验证清单](docs/validation.md)。

| 功能 | 当前实现 | 限制/说明 |
| --- | --- | --- |
| 自动/手动上下文压缩 | 已接入 `thread/compact/start`，显示 token 使用比例，网页可设置自动触发阈值 | 网页自动触发依赖 tokenUsage 事件，在 turn 完成后执行；Codex 自身自动压缩继续由模型/配置管理 |
| 对话 Fork | 已接入 `thread/fork`，支持当前会话与已完成 turn 的分支 | 分支使用新 thread id；无法从正在执行的 turn 截止分支 |
| 配置与项目加载 | 按 cwd 读取配置来源/版本和受管要求，版本校验保存；加载本机桌面项目、按主机浏览选择项目及额外工作目录；新对话直接选择项目与本机/远端 | 桌面项目元数据为只读兼容适配，网页自增项目不反写桌面状态；更改新对话位置保留文字，同主机保留附件，跨主机重新上传原文件 |
| SSH 主机 | 添加/编辑弹窗、私钥上传与替换、未保存配置的连接测试；通过远端交互登录 shell 自动识别 Codex，也可指定路径 | 支持最大 64 KB 的无口令 OpenSSH / PEM 私钥；测试不保存主机、不打断聊天；需预先配置 known_hosts、远端 CLI 和登录 |
| 审批 | 命令/文件改动、额外权限、工具提问与基础 MCP 输入面板；同主机登录设备共享待审批请求 | 首个有效答复生效；依赖当前 Codex sandbox/审批策略，高级 MCP schema 与桌面宿主请求尚未完全覆盖 |
| 文件与变更 | 目录浏览、UTF-8 文件读写、图片查看、原始文件下载、Codex 文件变更 diff | 单文件查看/下载最多 8 MB；二进制文件可下载，禁止文本编辑；未保存编辑不影响下载的磁盘内容 |
| 终端与 Tmux | 交互式 Shell、PTY、stdin、resize、重连恢复、手机控制键；tmux 会话列表、窗格输出快照、新建、切换、确认删除 | 目标主机需安装 tmux；切换只断开 tmux 客户端，普通终端保留；macOS 沙箱拦截 socket 时需用户选择完全访问 |
| 预览 | 静态 HTML、URL、本机/SSH 开发端口代理、HTTP/WebSocket、Vite HMR、桌面/手机预览宽度 | 开发服务限 loopback，iframe 使用独立 opaque origin；真实 SSH 目标环境待验证，外部网站可能禁止 iframe |
| 公网鉴权 | 密码、30 天 Cookie 会话、设置内修改密码、CSRF、Origin 校验、登录限流 | 修改后当前设备保持登录，其他设备重新登录；服务重启需重新登录；单用户工作站，不包含多租户隔离和 SSO |
| `/`、`@`、快捷键 | Slash 指令菜单、项目文件搜索引用、页面内命令面板 | 快捷键需要网页获得焦点；不支持系统级全局唤醒 |
| 模型与权限选择 | 模型/推理强度、基础权限、命名 Web 权限预设、受管策略与提供方能力展示 | 列表不保证账户具备所有模型权限；以实际 turn 结果为准 |
| 文件/图片上传 | 每次最多 8 个文件、每文件 20 MB（proxy 的 base64 消息还受 16 MiB 传输上限限制），上传到所选工作站；图片以 `localImage` 发送 | 普通文件通过路径交给 Codex；上传不等同于模型原生解析任意文件格式 |
| 会话与事件 | 新建、恢复、停止、追加指令、Fork、重命名、归档恢复、全文搜索、完整导出、历史分页、草稿/阅读位置；运行时过程展开，结束后折叠，最终回复直接显示 | 内容时间使用 `recencyAt`，打开对话不改变排序；过程可手动展开/收起，审批与失败原因保持可见；跨桌面活动进程同步需连接同 daemon |
| 手机 UI / PWA | 会话抽屉、全屏工作区、统一字号/触控间距、主题切换、安装到主屏幕、用户主动更新 | Service Worker 只缓存公开界面资源；不缓存 API 或私人对话，不支持离线发送/审批/执行 |
| 后台通知 | 用户主动启用标准 Web Push；回复完成、审批/补充输入、运行失败分类与测试通知，点击回到对应主机/对话 | 设备授权最长 30 天，明确退出撤销当前登录关联的订阅；要求服务器与任务继续运行，手机系统送达及真实设备验收见 [PWA 指南](docs/pwa.md) |
| Skills/Apps/MCP | 查看和使用当前主机已有集成 | 插件市场不在范围内；复杂 OAuth、automations 与桌面宿主能力另行实现 |
| 侧栏拓扑 | 本机与所有远端同页显示置顶/项目/最近；置顶项目和普通项目各默认显示 4 个，项目内对话默认显示 4 条，可展开/收起；项目菜单提供编辑、文件定位、归档和移除 | 当前选中项目/对话保留在 4 个显示项内；完整历史仍可分页加载。编辑/移除只改变 Web 元数据，不改桌面配置或删除磁盘文件；归档可恢复 |
| 工作区布局 | 桌面工作区左侧拖动调整宽度、键盘调节、双击恢复默认，宽度在当前浏览器保存 | 窗口和侧栏变化时限制宽度，保留聊天区；手机工作区使用全屏布局，终端随面板调宽自动适配 |
| Git/worktree | 分支、状态、逐行 diff、暂存/取消暂存、明确文件提交、worktree 创建/导入/切换 | 操作在所选主机运行，提交仅包含选择的文件，其他暂存文件保留 |

## 与桌面同步

默认 `CODEX_CONNECTION_MODE=spawn` 启动当前系统用户的 `codex app-server --listen stdio://`，继承 `CODEX_HOME`（默认 `~/.codex`）。非 ephemeral 会话由 Codex 自己持久化；同机器、同用户、同数据目录的桌面版可以加载这些历史。桌面列表可能需要刷新。

需要共享正在运行的 thread 时，设置：

```dotenv
CODEX_CONNECTION_MODE=proxy
# 仅当使用非默认控制 socket 时填写：
# CODEX_SOCKET_PATH=/absolute/path/app-server-control.sock
```

`proxy` 调用 `codex app-server proxy`，要求对应 daemon 已运行。它不会自动启动桌面程序或寻找任意桌面私有 socket。只有两个客户端连接到同一 app-server 进程才具备加入同一活动 thread 的条件。当前开发机的默认 daemon 控制 socket未发现，原桌面活动模型 turn/审批互通仍需目标桌面环境验证；隔离真实 daemon 的双客户端事件、活动 shell turn 和 Bridge 重连已经通过。proxy 采用 WebSocket-over-pipes，未分片消息受 daemon 的 16 MiB 通告限制。

Web bridge 不提供跨机器云同步。把 Node 服务部署到另一台服务器，会使用那台服务器的历史；SSH 工作站也使用远端用户自己的配置和存储。协议版本、分页、输入与同步边界详见 [协议说明](docs/protocol.md)。

## 常用操作

- `Cmd/Ctrl + K`：页面内命令面板；`Cmd/Ctrl + Shift + O`：新会话；`Cmd/Ctrl + J`：终端。
- `Enter`：发送；`Shift + Enter`：换行；`Esc`：关闭面板。
- 输入 `/` 打开指令菜单，输入 `@` 搜索项目文件，附件按钮上传文件/图片。
- 侧栏 `…` 置顶项目或对话，区标题/项目箭头折叠；最近标题的归档按钮恢复历史。
- 超过 4 个项目或项目内对话时，点击“显示另外…”展开，点击“收起…”恢复前 4 个显示项；当前选中项保留可见。
- 工作区 `Git` 操作分支、提交与 worktree；`预览 → 开发服务` 连接本机/SSH 端口。
- 拖动工作区左侧边界调整宽度，双击恢复默认；边界获得焦点后用左右键调节，Shift 加快，Home/End 调到最小/最大宽度。
- 项目行右键或“…”打开菜单，“在工作区文件中显示”定位所选主机的项目目录；文件行和查看页的下载按钮保存原始文件。
- 添加项目时先选择本机或远端，再点击“浏览”选择目录；地址栏可手输绝对路径并按 Enter，支持上级和额外工作目录。浏览另一台主机不会切换当前聊天。
- 新对话输入框上方选择项目和主机；切换位置期间禁止发送，草稿会保留，附件切换主机后重新上传。已有对话继续使用原主机和目录。
- 工作区 `Tmux` 查看会话与窗格快照，新建会话、切换到交互终端，或确认删除某个会话。删除会结束该会话中的进程，断开网页终端会保留会话。
- 设置中的“连接”添加或编辑远端，填写 `host`、`user@host` 或 SSH 别名，在“身份文件”中上传私钥或填写服务端路径，可先“测试连接”；端口留空使用已有 SSH 配置，Codex 路径留空自动识别。“项目”添加目录，“配置”读取和保存当前主机配置。
- 聊天运行时展示公开思考摘要、进展和工具记录，结束后折叠在“用时”下，可再次展开；时长未由协议提供时显示“工作过程”。运行期间手动收起不会被新进展打断，最终回复直接显示。
- “设置 → 应用与通知”安装应用、启用/关闭通知、选择通知类别并发送测试通知；有新版本时主动“更新应用”，运行中的任务结束后再更新。
- 侧栏始终显示所有主机；底部主机选择只决定新对话和工作区的执行位置。主机名旁显示独立连接状态，未连接时可点击重试；刷新对话会重建列表以核对其他客户端的归档变更。

## 开发与验证

```sh
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run doctor
npm run doctor:daemon
npm run doctor:preview
```

首次运行浏览器测试前执行 `npx playwright install chromium`。浏览器测试使用真实 Vue 页面与测试专用 HTTP/WebSocket 协议 fixtures，不调用模型；真实协议 smoke test 使用独立临时 `CODEX_HOME`，验证握手、配置、模型列表、历史和文件读取，不发推理 turn。CLI 未安装时协议 smoke test 跳过。

`npm run doctor` 对当前配置做只读连接诊断。需要主动验证真实推理和同数据目录跨进程历史读取时，执行 `npm run doctor -- --turn`；它会创建一条小型诊断会话并在结束后归档，会使用当前模型账户额度。开发时已通过这项验证，但它不等于桌面同 daemon 的实时同步验证。

更新 CLI 后运行 `npm run protocol:generate`，检查 `shared/protocol/` 差异，再运行类型、单元和浏览器检查。

目录说明：`src/` 为 Vue UI，`server/` 为鉴权/桥接/工作站服务，`shared/protocol/` 为 CLI 生成类型，`tests/` 为验证，`docs/` 和 `deploy/` 为协议与部署说明。`DATA_DIR` 保存网页主机、项目、上传元数据以及私有推送密钥和设备订阅，对话历史保存在 Codex 中。

2026-10-06 已验证真实模型推理、跨进程历史、PTY、隔离 daemon 协作、实际 Git/worktree、Vite HMR、隔离 tmux 生命周期与目录浏览；本阶段通过 127 项单元/协议测试、112 项浏览器流程测试和生产构建，包含真实 Service Worker 的离线启动、更新及通知订阅恢复。Docker 已在 Linux/ARM64 隔离环境实际构建启动并验证协议、终端、中文 Tmux 与卷持久化，详见 [验证清单](docs/validation.md)。桌面和手机尺寸页面已在本机验收；真实手机后台推送送达尚待验收。原验证截图含本机项目信息，保留在本地，不随仓库发布。

本阶段工作流及环境验收边界见 [工作流完整度](docs/roadmap.md)。插件市场不在当前范围内。

可启用的 [GitHub Actions 示例](deploy/github-actions/README.md) 覆盖应用与容器集成验证；复制到 `.github/workflows/ci.yml` 即可启用。通过 gh 上传工作流需要 GitHub 登录具有 `workflow` 权限，普通源码上传不需要该附加权限。
