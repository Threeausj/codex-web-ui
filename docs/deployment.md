# 公网部署与 SSH

容器部署见 [Docker 部署指南](docker.md) / [English](docker.en.md)，包含本地 HTTP、公网 Caddy HTTPS、持久化与 SSH。本文说明直接运行 Node + systemd 的部署方式。

这是一个单用户远程开发工作站入口。登录用户可以使用运行服务的系统账户读取文件、运行终端、驱动本机和已配置 SSH 机器上的 Codex。当前没有不同用户之间的工作区隔离、组织权限或配额；不要把同一个实例当作多人共享 SaaS。

## Linux + Node + Caddy

需要 Node.js 22+，以及能访问工作目录的系统账户。本机执行使用该账户已有的 Codex CLI 和配置；仅连接 SSH 远端时，Web 主机无需安装 Codex。使用本机时先以该账户完成 `codex login`，然后在项目目录执行：

```sh
npm ci
npm run build
```

将下列示例保存为 `/etc/codex-web-ui.env`，把域名、路径和密码改成实际值，文件权限设为 `0600`：

```dotenv
NODE_ENV=production
HOST=127.0.0.1
PORT=8787
CODEX_BIN=/usr/local/bin/codex
CODEX_CONNECTION_MODE=spawn
CODEX_HOME=/home/codexweb/.codex
DATA_DIR=/var/lib/codex-web-ui
CODEX_WEB_PASSWORD=replace-with-a-long-random-password
PUBLIC_ORIGIN=https://codex.example.com
TRUST_PROXY=1
```

`CODEX_BIN` 是服务实际可执行的路径；应用不会安装或固定 CLI 版本。纯 SSH 部署可不设置，本机连接缺少 CLI 时会显示配置提示，Web 服务仍正常启动。用已有桌面历史时，服务应以相同系统账户运行并使用相同 `CODEX_HOME`。另建 `codexweb` 用户不会自动拥有原用户的桌面历史。

编辑 `deploy/codex-web.service` 的用户、工作目录和 Node 路径，创建由该用户拥有的 `DATA_DIR`，再将 service 安装到 systemd。示例命令需要管理员身份：

```sh
install -d -m 0700 -o codexweb -g codexweb /var/lib/codex-web-ui
install -m 0644 deploy/codex-web.service /etc/systemd/system/codex-web.service
systemctl daemon-reload
systemctl enable --now codex-web
journalctl -u codex-web -f
```

编辑 `deploy/Caddyfile` 的域名，将它部署到 Caddy 配置目录，并确保 DNS 指向服务器、80/443 端口可达。后端 8787 保持只监听回环地址。Caddy 的 `reverse_proxy` 支持 WebSocket 升级；有效域名满足证书申请条件时，Caddy 会管理 HTTPS。[Caddy 反向代理文档](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)，[自动 HTTPS 文档](https://caddyserver.com/docs/automatic-https)。

```sh
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

浏览器访问 `https://codex.example.com`，首次使用 `CODEX_WEB_PASSWORD` 登录。会话保存在 Node 进程内，有效期 30 天，重启后需要重新登录。在“设置 → 账户 → 网页访问”使用当前密码修改访问密码，保存后当前登录续期，其他设备的登录及后台通知授权撤销；无需重启服务。

首次启动将访问密码散列保存到 `DATA_DIR/web-password.json`，权限 `0600`；该文件优先于环境变量和初始密码。设置里修改后，原 `CODEX_WEB_PASSWORD` 不再是当前密码，重启也不会覆盖修改。忘记密码时停止服务、备份 `DATA_DIR`，设置新的初始 `CODEX_WEB_PASSWORD`，仅移除 `web-password.json` 后重新启动。不要删除主机、项目、推送密钥或 Codex 历史。

## 鉴权边界

工作站 HTTP API、上传、预览入口及 WebSocket 需要登录。浏览器使用 HttpOnly、SameSite=Strict Cookie；生产环境使用 Secure Cookie，修改类 HTTP 请求另带 CSRF token，WebSocket 校验浏览器 Origin。密码在服务内通过 scrypt 校验，登录有频率限制。登录/会话查询和不含敏感数据的 health 端点可公开访问。

静态预览的子资源使用登录会话签发的短期随机票据，以支持 opaque sandbox 中不携带 Cookie 的资源请求；票据绑定所选目录和主机，登出或会话失效后不能继续读取。

`PUBLIC_ORIGIN` 只填真实前端 Origin，例如 `https://codex.example.com`，不要填路径、末尾斜杠或通配符。只有可信代理位于后端前面且外部无法直连后端时，才设置 `TRUST_PROXY=1`。

这些机制保护入口，不限制已登录用户主动打开的文件或运行的命令。Codex 对话的审批和 sandbox 配置与 Web 登录鉴权是两层不同权限。使用 HTTPS 反向代理后访问 Web bridge；不要将原始 app-server TCP WebSocket 监听器直接暴露到公网。OpenAI 将 app-server 原生 WebSocket transport 标为实验性，当前默认方案使用本地 stdio。[官方 app-server 文档](https://learn.chatgpt.com/docs/app-server)。

## SSH 工作站

Web 后端调用本机 OpenSSH，不保存 SSH 密码。可以在网页上传无口令私钥，也可以使用服务端已有密钥或 ssh-agent。先以运行 Node 服务的账户，在终端确认目标机器可通过密钥或 ssh-agent 登录，并核对主机指纹：

```sh
ssh -p 22 developer@your-host.example
codex --version
codex login
```

后两条在远程机器中运行。远程机器必须安装兼容的 Codex CLI。Codex 路径默认留空：后端启动远端用户的交互式登录 shell，继承初始化后的 PATH，再识别 `codex`，支持通常在 shell 配置中初始化的 nvm、mise 等安装方式。Shell 的启动提示会转到 stderr，不混入 app-server 协议。也可以填写可执行文件路径覆盖自动识别。UI 的私钥路径指后端机器上的私钥路径。

添加主机后选择远程工作目录。桥接使用 SSH 的加密通道承载 `codex app-server` stdio，并启用 `BatchMode=yes` 和严格主机密钥校验。缺少 known_hosts 条目或密钥不可用时会报错，网页不会替你接受未知主机。

在设置“连接”中添加或编辑主机。主机名可填 `host`、`user@host` 或现有 SSH 别名；端口留空不覆盖 SSH 配置。选择“无身份验证”表示使用已有 SSH 配置或 ssh-agent，不传显式身份文件。

选择“身份文件 → 上传私钥”可上传或替换无口令的 OpenSSH / PEM 私钥，最大 64 KB，上传后自动填写服务端路径；公钥、损坏文件和带口令的私钥会被拒绝。密钥保存在 `DATA_DIR/ssh-keys`，目录权限 `0700`、文件权限 `0600`，与 Web 数据一同持久化和备份。接口只返回文件标识和路径，不返回私钥内容。取消编辑或替换未保存的上传文件时会清理草稿密钥；修改、移除连接时，只删除不再被其他连接引用的上传密钥，手动填写的文件路径不受清理影响。

“测试连接”可检查尚未保存的草稿：临时连接完成 app-server 握手与只读配置检查后释放，最长等待 12 秒；不会保存主机或重建当前聊天连接。失败会区分身份文件、主机密钥、身份验证、网络、Codex 和协议问题。该检查不启动模型推理，成功不表示已验证模型额度。

编辑保存后保持原主机 ID、项目与对话关联。只修改名称不会中断连接；修改地址、用户、端口、密钥、Codex 路径或工作目录时，旧 app-server 连接和开发预览转发会关闭，下一次连接采用新配置。清空可选字段会删除原值，清空 Codex 路径恢复自动识别。

每台远程主机使用该远程用户自己的 Codex 登录、配置和会话存储。远程 `CODEX_HOME` 不会与本机桌面版自动合并。跨主机查看和切换工作站由 Web UI 完成，历史仍保存在各自工作站。

工作区的 Tmux 页管理所选主机的默认 tmux server；每台目标主机需在该用户 PATH 中安装 tmux，网页不会自动安装远端依赖。会话切换只断开网页的 tmux 客户端；删除操作有明确确认，结束对应会话的进程。macOS 的 app-server Seatbelt 在只读/工作区权限下可能拒绝 Unix socket，遇到权限提示时由用户选择完全访问再刷新。普通 PTY 不会因此获得额外权限。

## 升级与备份

升级前完成正在运行的 turn，备份 `DATA_DIR` 与目标用户的 `CODEX_HOME`。CLI 使用本机或远端原有的升级方式，升级后重启 Web 服务或真正重建对应 app-server 连接；仅刷新网页会复用仍在运行的旧 app-server。CLI 升级不需要重建 Web 镜像，协议不兼容时再更新应用与协议类型。备份包含敏感配置，应按本地私有文件管理。桌面软件升级可能改变其项目元数据格式；遇到项目未显示时可从 UI 手动添加绝对路径。

本项目尚未替你配置域名、证书、防火墙、systemd 或 SSH 凭据；这里的文件是可审阅的部署示例。正式上线前执行 [验证清单](validation.md) 的鉴权与移动端部分。
