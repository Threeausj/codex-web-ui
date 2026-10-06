# app-server 协议与同步约束

本项目的 Codex 对话、模型、配置、文件和终端操作使用 Codex app-server RPC。Node 层提供浏览器鉴权、WebSocket 桥接、上传和项目/SSH 元数据；不直接调用模型 API，不建立第二套聊天历史数据库。

官方协议为双向 JSON-RPC，线上省略 `jsonrpc` 字段。请求带 `id/method/params`，响应使用相同 `id`，通知没有 `id`。stdio 每行一个 JSON；每个连接先完成 `initialize`，再发 `initialized`，然后才能使用其他 RPC。[OpenAI app-server 文档](https://learn.chatgpt.com/docs/app-server)。

## 本地协议基线

开发时核对的 CLI 为 `codex-cli 0.159.2`。`shared/protocol/` 是 CLI 生成的 TypeScript 类型，文件注释本身是各字段约束的直接依据；升级 CLI 后应重新生成并检查差异：

```sh
codex --version
npm run protocol:generate
npm run typecheck
npm test
```

`npm run protocol:generate` 使用生成器的 `--experimental`，连接初始化另设 `capabilities.experimentalApi=true`；这两项是不同配置。`codex app-server generate-ts --help` 可确认当前生成器支持的参数。生成的类型不代表任意较旧 CLI 都支持。

只读集成测试 `tests/protocol.test.ts` 使用独立临时 `CODEX_HOME`，实际验证 stdio 握手、配置读取、模型列表、空历史列表、文件与目录读取。它不启动推理 turn，也不修改真实桌面会话。CLI 缺失时该测试跳过。

## 客户端标识与模型网关

Bridge 在每次 `initialize` 中发送 `clientInfo`；`name` 来自服务端 `CODEX_CLIENT_NAME`，默认 `codex_web`，`title:Codex Web` 与 `version:0.1.0` 保持本应用信息。本机与 SSH 的 `spawn`/`proxy` 都使用同一配置。标识去除首尾空格后须为 1–64 个 ASCII 字符，以字母或数字开头，其余只允许字母、数字、`_`、`.`、`-`；控制字符始终拒绝，无效值在服务启动时拒绝。

Codex 将 `clientInfo.name` 用于模型请求的 `originator`。[官方客户端初始化说明](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)。CLI 0.159.2 的隔离本地模型服务验证表明，新 thread 使用本次初始化标识，跨进程冷恢复已有 thread 时保留历史中的 `originator`。因此继续旧对话成功并不保证新建对话会通过相同的网关客户端限制。

接入 sub2api 时，通常在对应账号启用“允许 Codex app-server 客户端”并保留 `codex_web`。如已配置的网关要求 CLI 兼容标识，可显式设置 `CODEX_CLIENT_NAME=codex_cli_rs`，重新创建服务容器后用新会话验证；已有 daemon 或活动 thread 可能保留原上下文。此设置不宣称官方客户端身份，不更改模型提供方、API 凭据或权限，也不重写历史。Docker 操作见[部署指南](docker.md#模型网关与客户端标识)。

## 对话与历史

| 场景 | app-server 方法/事件 | 约束 |
| --- | --- | --- |
| 新建对话 | `thread/start` | 保存服务返回的 thread id |
| 恢复 | `thread/resume` | 恢复已有 thread，也用于重新加入同进程活动 thread |
| Fork | `thread/fork` | 返回新 thread id；`lastTurnId` 可选择截止 turn，但该 turn 不能正在运行 |
| 会话列表 | `thread/list` | 使用 `nextCursor` 翻页；默认仅交互来源、未归档历史 |
| 历史 turn | `thread/turns/list` | 默认时间倒序，`itemsView` 默认 `summary`，完整消息需要 `full` |
| 历史 item | `thread/items/list` | 使用不透明 `nextCursor`；默认时间正序 |
| 发送/停止 | `turn/start`、`turn/interrupt` | 持续读取通知；以 `turn/completed` 的 status 判断成功 |
| 手动压缩 | `thread/compact/start` | 压缩由 Codex 执行，客户端不伪造历史摘要 |
| 自动压缩 | Codex 自身机制、`thread/compacted` | 生效阈值由模型/配置决定；可写 `model_auto_compact_token_limit` |
| 审批 | 带 id 的 server request | 用相同 id 回答，不能误当作 notification |

当前生成类型提示：`thread/read` 的 `includeTurns:true` 和 `thread/resume`/`thread/fork` 全历史返回已不推荐。对长历史应使用 metadata-only read、`excludeTurns:true` 与分页方法，按 id 合并已到达的实时事件，避免大历史截断、重复 item 或乱序。列表的 cursor 必须原样回传，不能自行计算时间偏移。

会话排序和侧栏时间使用 `recencyAt`，列表/搜索请求 `sortKey:recency_at`。`updatedAt` 会因 resume 或配置写入改变，不能代表新消息。旧版本不支持此排序或不返回内容时间时，兼容读取最新 turn 的 `startedAt/completedAt`（`limit:1,itemsView:notLoaded`），按主机缓存并限制并发；读取失败保留已知时间，空对话使用创建时间。

输出按 turn 组织：`agentMessage.phase:final_answer` 在主输出显示，`commentary`、公开思考摘要和工具记录在当前轮运行时自动展开，完成、失败或中断后折叠；旧提供方未报告 phase 时保留最后一条回复。运行期间手动收起不被后续 delta 重开，历史手动展开不受新轮影响。`busy` 回落可在完成元数据尚未到达时收起，并避免旧轮被后续运行状态重新展开。时间来自 `durationMs` 或 turn 的起止时间，不推算缺失的用时。审批卡与失败原因始终可见；这只是显示方式，原协议 items 和完整导出内容不删减。

命令、文件改动、工具请求输入、权限、MCP elicitation 是不同的 server request，回答结构不同。桥接保留原始 request id 并记录待审批状态，同主机的已登录浏览器共享待审批；第一个有效答复生效，重复/未知 request id 不转发。`serverRequest/resolved` 与 bridge status 用于移除旧提示。普通 RPC 响应仍只返回发起请求的浏览器标签页。

## 同步含义

1. **共享持久化历史**：默认 `spawn` 运行当前用户的 app-server，沿用相同 `CODEX_HOME`、登录与配置。网页创建的非 ephemeral thread 写入 Codex 存储，桌面版可以从同一存储读取；桌面列表可能需要刷新或重新打开。
2. **共享活动进程**：`CODEX_CONNECTION_MODE=proxy` 通过 `codex app-server proxy` 接入已有控制 socket。如果网页和桌面连接到同一 app-server，resume 可以加入该进程里的活动 thread。此模式要求已有 daemon/socket；不同 socket 或不同进程不能承诺实时互通。SSH 在此模式下连接远端默认 daemon，`CODEX_SOCKET_PATH` 仅用于本机连接。
3. **不同机器**：公网访问的是 Node 服务所在工作站；SSH 工作站的历史保存在远程机器，不存在由这个项目提供的跨机器云同步。

`proxy` 的标准输入输出是**原始字节透传**，不能直接写入 JSONL。daemon 控制 socket 使用 WebSocket 握手和文本帧，`server/proxy-transport.ts` 在本机或 SSH 代理的 pipes 上完成握手/framing，再向 Bridge 提供 JSONL。`createWebSocketStream` 必须保留字符串写入，避免把 JSON 发送为服务器不处理的二进制帧。依据为官方 [stdio-to-uds 实现](https://github.com/openai/codex/blob/main/codex-rs/stdio-to-uds/src/lib.rs) 与 [控制 socket 实现](https://github.com/openai/codex/blob/main/codex-rs/app-server-transport/src/transport/unix_socket.rs)。浏览器到 Node 的 WebSocket 与这层 daemon transport 是两个独立连接。Bridge 按握手返回的未分片帧限制在发送前拒绝过大请求，避免服务器因此关闭整条连接；CLI 0.159.2 实测该限制为 16 MiB，Base64 内容也计入 JSON 消息大小。

`npx tsx scripts/daemon-doctor.ts` 在临时 `CODEX_HOME` 启动独立 CLI daemon，验证两个真实 proxy 客户端初始化、加入同一 thread、双向重命名通知，以及断开一个 proxy 后由实际 Bridge proxy 重连读取同一 history。空 thread 尚无 rollout，测试先用固定 `printf` 和两秒等待的 `thread/shellCommand` 建立手动 shell turn；第二客户端加入运行中的 shell turn，两端接收 `turn/completed`。另实际验证配置层与 requirements/profile/provider 读取、乐观配置写入冲突和过大帧拒绝后连接仍可用。配置写入仅发生在临时 home。这项测试不调用模型、不复制登录文件、不管理现有桌面 daemon，结束时停止并清理自己的 daemon。已验证 CLI 0.159.2；模型 turn 期间的审批归属和具体桌面版本的同 socket 接入仍需目标环境验证。

此前另已通过一条真实模型 turn 验证推理，再启动第二个 app-server 从同一 `CODEX_HOME` 读取该会话，验证跨进程持久化历史；诊断会话随后归档。实际桌面同进程验收见 [验证清单](validation.md)。

桌面项目元数据目前从 `CODEX_HOME/.codex-global-state.json` 中已知项目字段只读加载。它不是公开 app-server 项目管理接口，属于兼容性适配；Web 自增项目保存到自己的 `DATA_DIR/projects.json`，不写桌面状态文件。项目有效配置通过 `config/read` 的 `cwd` 获取，而不是解析配置文件复制到浏览器。

添加项目的目录选择器调用鉴权保护的 `GET /api/hosts/:hostId/directories`，可传绝对 `path`。Node 仅转发该主机 Bridge 的 `fs/getMetadata` 与 `fs/readDirectory`，不直接读取远端文件系统、不执行 Shell、也不替换活动聊天连接。省略路径时使用主机配置的 cwd、本机服务 cwd 或远端根目录；严格拒绝相对路径、控制字符和额外参数，响应仅包含目录。

新对话的位置栏选择已配置主机及其项目，`thread/start` 和 `turn/start` 使用最终选定 cwd，并等待主机/配置加载与附件迁移完成才允许发送。文字草稿随主动选择保留；同主机项目间保留附件，跨主机使用浏览器内暂存的原始 File 再上传到目标主机，不将旧主机路径交给新主机。无法迁移时保留文字、明确提示重新上传；导航已改变时丢弃迟到的响应与错误。已有对话隐藏位置栏，继续使用原 thread 的主机和工作目录。

侧栏同时显示所有已配置主机的项目与会话。活动聊天保持自己的 WebSocket；其他主机的列表、搜索、导出和归档通过鉴权/CSRF 保护的 `/api/navigation/:hostId` 转交各自 Bridge，限定为公开 thread 方法的必要子集。所有会话仍来自 app-server，不读取或复制远端 rollout 文件。导航按 `(hostId,threadId)` 和 `(hostId,projectPath)` 隔离；主机切换完成配置加载前禁止发送，后台主机不可用不覆盖活动聊天的错误状态。页面可见时每 15 秒刷新首屏，手动刷新重建导航分页及项目首屏。

置顶项目和普通项目各默认显示 4 个，每个项目内聊天默认显示 4 条；已加载的更多内容可展开，当前项目/聊天在有限显示项内优先保留。此项是显示限制，不修改折叠偏好、不减少协议分页或删除历史。项目的分页加载等待本机连接就绪，加载旧对话后保留新增内容可见。

## 配置来源与权限预设

设置页通过 `config/read(includeLayers:true,cwd)` 显示有效配置、逐项 `origins` 和每层的来源、版本及 `disabledReason`。`configRequirements/read` 返回受管限制或 null，当前 schema 没有 params。管理来源与禁止的权限选项显示为只读，配置写入由 app-server 再次验证。用户配置写入附带相应层的 `filePath/expectedVersion`，版本冲突时需要重新读取，避免覆盖其他客户端的修改；`reloadUserConfig:true` 不会热替换正在运行线程的模型、推理强度等静态默认值。

`permissionProfile/list(cwd)` 读取主机原生权限预设与 allowed 状态。本阶段不编辑或伪造这些原生 id。Web 命名权限预设保存到 Web 偏好，由 `configuration.ts` 校验并转换成公开的 `sandbox`、`approvalPolicy` 和 `sandboxPolicy` 字段，发送请求时固定这次选择。它们可以跨浏览器使用，但不会写入桌面的命名权限配置。当前字符串审批策略仅支持 `untrusted/on-request/never`，不接受已移除的 `on-failure`。

模型目录显示 inputModalities 与 supportedReasoningEfforts；`modelProvider/capabilities/read` 补充 webSearch、imageGeneration 和 namespaceTools 的提供方声明。自定义 provider 可不报告全部能力；目录与能力标志不能视为模型访问授权，真实 turn 的完成状态才验证该次模型请求是否成功。[官方模型目录与授权说明](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)。

插件市场不属于本阶段范围；已有 Skills、Apps、MCP 的使用入口继续保留。

## 文件、输入与终端

`fs/readFile`、`fs/writeFile`、`fs/readDirectory` 操作 app-server 所在机器上的绝对路径。文件内容使用 `dataBase64`；这是字节编码，应明确解码 UTF-8 后再做文本预览。

`UserInput` 文本包含 `text_elements`。图片可用 `localImage` + 服务端路径或受支持的 image 输入；`mention` 带 `name/path`。浏览器上传应先存到目标工作站，再将路径交给 app-server；浏览器本机路径不能直接当作远程路径。普通文件由文字引用和路径交给 Codex，并不等同于调用 OpenAI Files API。

终端使用 `command/exec`，`command` 是 argv 数组。PTY、标准输入、标准输出流和后续 write/resize/terminate 需要客户端生成的 `processId`。流输出通知的 `deltaBase64` 与 stdin write 的 `deltaBase64` 都是原始字节；最终 `command/exec` 响应在进程退出且流通知发完后才返回。进程作用域属于 app-server 连接，原始连接关闭时服务器会终止该进程。

文件预览属于 Web 功能，经过鉴权与路径验证，HTML 在 sandbox iframe 中显示。开发服务预览由独立模块提供本机或 SSH loopback 的 HTTP/WebSocket 代理，支持资源加载和 Vite HMR，详见 [开发预览与终端](development-preview.md)。桌面原生应用操作属于另行接入的宿主能力。

项目菜单使用 Web 项目元数据进行编辑和隐藏，桌面导入项的原始配置保持只读；归档使用各主机 `thread/list` 的 cwd 分页与 `thread/archive`，覆盖项目的全部根目录。显示文件先通过 `fs/getMetadata` 区分目录和文件。下载通过 `fs/readFile` 返回的原始 Base64 字节生成浏览器文件，不经过文本解码，当前上限为 8 MB。

Tmux 管理 API `/api/tmux/*` 在相同鉴权/CSRF 后调用目标 Bridge 的 `command/exec`，不直接启动本机或 SSH 的另一套终端。读取与管理使用 tmux 的 canonical session/pane ID，输出有上限；新建为 detached 会话，切换通过 app-server PTY 的 `attach-session`，删除仅执行目标 `kill-session`。选中的 Codex sandbox 继续生效，未安装、已结束和 socket 权限拒绝分别提示；不会自动提升到完全访问。
