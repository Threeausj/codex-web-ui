# Docker 部署

**简体中文** · [English](docker.en.md)

镜像使用 Node.js 22 Debian Bookworm、多阶段构建及非 root 用户 `node`（UID/GID `1000:1000`），包含 Git、OpenSSH、Tmux、Python 3 和 ripgrep。Codex 使用本机或 SSH 远端已有的安装，镜像不安装、固定或自动更新 Codex。对话及执行仍经官方 Codex app-server stdio 协议；容器不发布原始 app-server transport。

## 文件与数据

| 文件/位置 | 用途 |
| --- | --- |
| `Dockerfile` / `.dockerignore` | 构建生产前端/服务端；排除凭据、工作区和本机数据 |
| `compose.yaml` | 应用基础配置，不发布端口 |
| `compose.local.yaml` | 只将 `127.0.0.1:8787` 发布给本机 |
| `compose.host-codex.yaml` | 可选：只读挂载 Linux 宿主已有 Codex 安装目录 |
| `compose.public.yaml` | Caddy 暴露 80/443；应用仅在 Compose 网络内可达 |
| `deploy/docker/env.example` | 环境模板，复制为被 Git 忽略的 `.env.docker` |
| `deploy/docker/Caddyfile` | 自动 HTTPS 与 WebSocket 反向代理 |
| `webdata` 卷 → `/app/data` | 网页访问密码散列、主机、项目、偏好、上传、推送密钥与设备授权 |
| `codexhome` 卷 → `/home/node/.codex` | Codex 登录、配置和持久化历史 |
| `WORKSPACE_PATH` → `/workspace` | 宿主机项目目录，读写挂载 |

Compose 实际卷名带项目名前缀。保留同一仓库目录/Compose 项目名，或在所有命令中固定 `-p codex-web-ui`，避免换目录后创建另一组卷。静态前端在 `/app/dist`，与工作目录独立，由 `STATIC_DIR` 指定。

## 本地部署

安装 Docker Engine 或 Docker Desktop，以及支持 `docker compose ... --wait` 的 Compose v2。然后在仓库根目录执行：

```sh
cp deploy/docker/env.example .env.docker
chmod 600 .env.docker
mkdir -p workspace
openssl rand -hex 32
```

将生成的密码填入 `.env.docker` 的 `CODEX_WEB_PASSWORD`；至少 12 位，建议使用生成的 64 位十六进制值。将 `WORKSPACE_PATH` 设置为现有目录的绝对路径，或保留 `./workspace`。目录必须事先存在。

Linux 下目录须由 UID/GID `1000:1000` 可读写。若使用专门的空工作目录，可先执行 `sudo install -d -o 1000 -g 1000 -m 0750 /srv/codex-workspace`，再设置该路径。已有项目按实际所有者配置权限；镜像不会递归修改项目所有权。

```sh
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml up -d --build --wait
```

纯 SSH 部署到这里即可：网页和健康检查无需容器内存在 Codex。进入“设置 → 连接”添加已安装 Codex 的远端，测试后选择该主机；SSH 配置见下文。本机未挂载安装时，选择“本机”会显示配置提示，不影响网页登录或设置远端。

打开 [http://127.0.0.1:8787](http://127.0.0.1:8787)，输入网页密码，选择已配置的主机和项目。若宿主机已有服务占用 8787，先停止其中一个服务，或修改本地 overlay 的宿主机端口，并同步本地 `PUBLIC_ORIGIN`。

本地 HTTP origin 不设置 Secure Cookie；公网 HTTPS origin 自动设置 Secure Cookie。两种方式均保留 HttpOnly、SameSite、CSRF 与 Origin 校验，`NODE_ENV` 不用于关闭鉴权。

使用 NAS IP 或自己的 HTTPS 反向代理时，将浏览器实际使用的 Origin（协议、主机、端口）加入 `PUBLIC_ORIGIN`；未配置的来源会收到 `403 Untrusted origin`，即使密码正确。多个 Origin 用逗号分隔。混合 HTTP/HTTPS 部署按登录请求的可信 Origin 设置 Secure Cookie，让局域网 HTTP 登录可用，同时保护 HTTPS 登录；只配置 HTTPS Origin 时始终要求 Secure Cookie。HTTP 页面使用 `crypto.getRandomValues` 生成兼容 UUID，不依赖仅安全上下文可用的 `crypto.randomUUID`。

## 直接使用宿主 Codex

Linux 宿主本机模式需要将已有安装目录只读挂载，CLI 架构须与容器一致。使用 npm 安装时，在安装 Codex 的账户环境中执行 `npm root -g`；将其下的整个 `@openai` 目录设为 `HOST_CODEX_DIRECTORY`，包含 `codex` 和其平台二进制依赖。仅挂载 `/usr/local/bin/codex` 符号链接或单个 JS 文件会缺少依赖。写入 `.env.docker`，实际路径按 npm/nvm 安装修改：

```dotenv
HOST_CODEX_DIRECTORY=/usr/local/lib/node_modules/@openai
CODEX_BIN=/opt/host-codex/codex/bin/codex.js
```

对这个部署的每条 Compose 命令增加 `-f compose.host-codex.yaml`：

```sh
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml -f compose.host-codex.yaml config --quiet
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml -f compose.host-codex.yaml up -d --build --wait
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml -f compose.host-codex.yaml exec app sh -c '"$CODEX_BIN" --version'
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml -f compose.host-codex.yaml exec app sh -c '"$CODEX_BIN" login --device-auth'
```

最后一条在容器的持久化 `CODEX_HOME` 登录，不会修改宿主账户。已有提供方也可在该目录配置；网页访问密码不提供模型权限。宿主 CLI 的安装目录和账户数据目录是两项配置：只挂载安装不会自动共享宿主历史，账户复用见“与桌面同步”。安装目录需允许 UID 1000 读取文件和执行程序；不要让网页账户写入安装目录。

独立 Linux 原生安装同样挂载**实际可执行文件所在目录**，并设 `CODEX_BIN=/opt/host-codex/实际文件名`；例如 `HOST_CODEX_DIRECTORY=/srv/codex-bin`、`CODEX_BIN=/opt/host-codex/codex`。保留安装依赖和符号链接指向的文件；避免只挂载版本文件，因为宿主升级的原子替换可能让容器保留旧 inode。pnpm/Bun 等跨目录符号链接布局需自行提供覆盖所有目标的受限目录挂载，或使用 SSH 连接宿主机。macOS/Windows 的二进制不能在 Linux 容器运行，请用 SSH 在对应主机执行。

更新 Codex 使用宿主或远端原有的升级方式；网页不会执行升级，也无需因此重建 Web 镜像。升级后先完成活动任务，再重启应用服务以重建 app-server；仍运行的 app-server 和普通浏览器重连继续使用旧进程。目录路径保持不变时，下一次启动直接使用已更新文件；若 nvm 切换 Node 版本或安装前缀变动，修改 `HOST_CODEX_DIRECTORY` 后重新创建容器。SSH 每次真正建立 app-server 连接都会重新解析远端登录 shell 的 PATH。

网页启动的 app-server 通过进程参数 `-c features.default_mode_request_user_input=true` 启用普通模式的结构化选择，不写入宿主 `config.toml`。连接既有 daemon 的 `proxy` 模式仍受该 daemon 与会话配置控制，proxy 命令本身不能修改已运行 daemon 的启动配置。

## 模型网关与客户端标识

`CODEX_CLIENT_NAME` 设置 app-server `initialize.clientInfo.name`，默认 `codex_web`。该值去除首尾空格后须为 1–64 个 ASCII 字符，以字母或数字开头，其余只允许字母、数字、`_`、`.`、`-`；控制字符始终拒绝。它适用于本机与 SSH 的 `spawn`/`proxy` 连接；应用标题和版本仍为 `Codex Web` / `0.1.0`。

sub2api 开启“仅允许 Codex 官方客户端”时，可能拒绝默认的 `codex_web`。通常应在网关对应账号启用“允许 Codex app-server 客户端”，保留本应用的标识。如果已配置的网关要求 CLI 兼容标识，可明确选择在 `.env.docker` 中设置：

```dotenv
CODEX_CLIENT_NAME=codex_cli_rs
```

完成活动任务后，使用原来的 Compose 参数重新创建应用容器，例如本地部署：

```sh
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml up -d --wait
```

此选项只调整客户端兼容标识，不表示本网页是官方客户端，也不更改模型提供方、API 凭据或账户权限。Codex 将该标识用于新 thread 的 `originator`；已有历史冷恢复时仍保留原标识，因此新建和继续对话可能出现不同的网关判定。`proxy` 的已有 daemon 和活动 thread 也可能保留原上下文，不能视为热更新；修改后用新建会话验证。[客户端标识说明](protocol.md#客户端标识与模型网关)。

## 访问密码与登录

网页登录会话有效期为 **30 天**，保存在服务进程内，重启服务后需重新登录。进入“设置 → 账户 → 网页访问 → 修改访问密码”，输入当前密码及两次新密码；新密码需 12–1024 个字符。保存后当前登录续期 30 天并保留已有连接，其他设备的登录和后台通知授权即时撤销。修改访问密码不修改 Codex 模型账户。

首次启动用 `CODEX_WEB_PASSWORD` 初始化凭证；之后 `/app/data/web-password.json` 中的 scrypt 散列优先于环境变量，文件权限为 `0600`。设置里保存的密码不会写入 `.env.docker`、明文初始密码文件或日志；保留 `webdata` 卷即可跨重启保留密码。初始 `.env.docker` 和 `bootstrap-password.txt` 中的值可能已不再是当前密码。

忘记密码时，先停止应用并备份 `webdata`，将 `.env.docker` 的 `CODEX_WEB_PASSWORD` 设置为新初始密码，再从该卷中仅移除 `web-password.json` 后启动服务。新凭证会从环境变量重新初始化，旧登录及旧设备授权不再有效。不要删除整个数据卷或 Codex 历史来重置密码；散列文件损坏时服务会拒绝启动，需要按相同步骤恢复。

## 公网 HTTPS

准备一个指向部署机器的域名，放行 TCP 80/443；UDP 443 用于 HTTP/3，可按环境选择。编辑 `.env.docker`：

```dotenv
CODEX_WEB_PASSWORD=replace-with-your-generated-password
WORKSPACE_PATH=/srv/codex-workspace
PUBLIC_HOST=codex.example.com
ACME_EMAIL=admin@example.com
# 可选，替换成维护者真实邮箱；留空使用 HTTPS 公网 Origin。
PUSH_SUBJECT=mailto:admin@example.com
```

`PUBLIC_HOST` 只填域名，不包含协议、路径或末尾斜杠。公网配置生成精确的 `https://PUBLIC_HOST` origin，设置 `TRUST_PROXY=1`，由 Caddy 处理 TLS 和 WebSocket。基础应用没有宿主机端口映射。

若已运行本地部署，先关闭其容器而保留卷，再使用公网 overlay：

```sh
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml down
docker compose --env-file .env.docker -f compose.yaml -f compose.public.yaml up -d --build --wait
docker compose --env-file .env.docker -f compose.yaml -f compose.public.yaml logs --tail 100 caddy
```

访问 `https://你的域名` 并登录，再设置 SSH 主机；需要宿主本机执行时在命令中继续添加 `-f compose.host-codex.yaml`。不要同时加载 `compose.local.yaml` 与 `compose.public.yaml`，否则会添加不必要的后端端口。若使用已有反向代理，可以仅运行基础 Compose，并由受控网络中的代理连接 `app:8787`；按实际 HTTPS origin 和可信代理配置覆盖环境，不将 8787 直接暴露到公网。

该产品是单用户工作站入口：登录者可以操作所挂载的文件和已经配置的 SSH 主机。它不提供多租户隔离或共享 SaaS 的权限体系。Docker 配置没有启用 `privileged`、Docker socket 挂载或关闭 seccomp。

## PWA 与手机后台推送

公网 HTTPS 部署后，在“设置 → 应用与通知”安装应用并主动启用通知。Android Chrome 使用安装提示或浏览器菜单；iOS/iPadOS 16.4+ 在 Safari 添加到主屏幕，从图标打开应用后启用。通知支持回复完成、需要审批/补充输入、运行失败；页面关闭和锁屏后无需维持前端连接，Node 服务及对应任务需要继续运行。具体安装、隐私、授权期限和真机验收见 [PWA 指南](pwa.md)。系统强退、省电和通知设置可能影响送达。

Compose 已转发三个可选环境变量：

| 变量 | 默认/用途 |
| --- | --- |
| `PUSH_VAPID_PUBLIC_KEY` / `PUSH_VAPID_PRIVATE_KEY` | 两项都留空时自动生成并保存到 `/app/data/push-vapid.json`；使用既有密钥时必须成对提供 |
| `PUSH_SUBJECT` | 第一个 HTTPS `PUBLIC_ORIGIN`，本地 HTTP 回退到项目 GitHub URL；公网推荐维护者真实 `mailto:` 联系地址 |

`webdata` 还保存 `push-subscriptions.json`，设备授权最长 30 天，网页登录自然过期/常规服务重启保留仍有效授权；明确退出撤销该登录关联的设备订阅。无需另外创建推送卷或手工生成密钥。备份、升级和迁移必须保留该卷及密钥；轮换密钥或更换域名后重新注册设备，私有密钥/endpoint 不进入镜像、日志截图或仓库。

服务器须能访问支持的浏览器厂商推送服务，手机须能访问应用的 HTTPS 地址。只接受官方推送 endpoint，无 `PUSH_ALLOWED_HOSTS` 覆盖项。PWA 只缓存公开静态界面，不缓存 API 或私人历史，不提供离线提交。重启容器仍会结束容器内任务，磁盘卷不会保存运行进程。

## SSH 工作站

远端用户需要可用的 Codex CLI 与账户配置；需要 Tmux 时也在远端安装。SSH 地址、别名、身份文件路径都由容器内的 OpenSSH 解析，宿主机的 `~/.ssh` 不会自动进入容器。

可以直接在网页添加新主机：“设置 → 连接”填写地址、端口和身份文件后，点击“获取服务器指纹”。页面显示目标地址、公钥类型和 SHA256 指纹；确认后点击“信任并测试连接”，无需先进入容器写 `known_hosts`。首次测试遇到未受信任的主机时，也会显示指纹确认区。

已记录的密钥发生变化时，页面同时显示新旧指纹，必须勾选密钥变更确认后点击“替换指纹并测试连接”。信任确认前会再次检查服务器公钥，指纹过期或地址修改后需重新获取。连接一直使用 `StrictHostKeyChecking=yes`；网页确认的记录保存在 Web 数据卷的 `/app/data/ssh/known_hosts`（`DATA_DIR/ssh/known_hosts`，文件权限 `0600`），备份与迁移时保留 `webdata` 即可。

也可挂载已有 SSH 配置与密钥。准备一个仅包含所需 SSH 配置、身份文件和已核验 `known_hosts` 的目录，保证容器 UID 1000 能读取私钥；SSH 目录权限 `0700`、私钥 `0600`。已有记录继续可用；指纹可与服务器管理员提供的值核对。[OpenSSH 文档](https://man.openbsd.org/ssh-keyscan)说明，获取公钥不要求登录，但获取到的公钥本身不能证明服务器身份。SSH 别名会按容器内配置解析地址、端口和 `HostKeyAlias`；配置了 `ProxyJump`、`ProxyCommand` 或 `KnownHostsCommand` 的主机暂不支持网页扫描，仍使用其原有 SSH 配置建立信任。

保存可选 override `compose.ssh.yaml`：

```yaml
services:
  app:
    volumes:
      - /srv/codex-ssh:/home/node/.ssh:ro
```

在原有本地或公网命令最后增加 `-f compose.ssh.yaml`，并先执行相同参数的 `config --quiet`。例如：

```sh
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml -f compose.ssh.yaml up -d --wait
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml -f compose.ssh.yaml exec app ssh your-alias
```

进入远端交互 shell 后执行 `codex --version`，确保 nvm/mise 等 PATH 初始化生效。

网页“连接”中填写主机或 SSH 别名。选择“身份文件 → 上传私钥”可上传或替换无口令的 OpenSSH / PEM 私钥，最大 64 KB，上传后自动填入容器路径。上传密钥保存于持久化 Web 数据卷的 `/app/data/ssh-keys`，目录权限 `0700`、文件权限 `0600`。取消编辑会清理未保存的上传文件；替换或移除连接会清理不再被引用的上传密钥。也可手动填写挂载的 `/home/node/.ssh/...` 路径，已有文件不会被自动删除。身份私钥用于登录账户，服务器指纹用于识别目标主机，两者分别设置。

Codex 路径留空通过远端交互式登录 shell 识别；也可指定远端可执行文件。先“测试连接”，成功后保存。远端目录使用远端路径，不使用容器 `/workspace` 路径。不要将私钥、实际 SSH override、`.env.docker` 或 Codex 登录数据提交到 Git。

## 与桌面同步

默认容器使用独立的 `codexhome` 卷。即使宿主机安装桌面 Codex，网页也不会自动读取它的账户和历史。应用使用同一个协议，但协议本身不提供跨机器云同步。

Linux 宿主机若要复用已有历史，可以在 override 中将原用户的 `CODEX_HOME` 挂载到 `/home/node/.codex`，并保证权限和存储格式兼容；原历史中的 cwd 必须在容器中以相同绝对路径可访问。备份后再使用，不将登录数据打包进镜像。macOS/Windows 的宿主机路径、二进制与 daemon socket 不能直接按 Linux 容器路径复用。

读取同一数据目录的历史与同步活动 turn 是两件事。实时共享活动 thread 需要 `CODEX_CONNECTION_MODE=proxy`，且客户端连接到同一兼容 daemon。Linux 可按实际权限挂载其 Unix control socket 所在目录并设置容器内 `CODEX_SOCKET_PATH`；本方案不自动启动或发现桌面私有 daemon，也不需要挂载 Docker socket。更多边界见 [README](../README.md#与桌面同步) 和 [协议说明](protocol.md)。

## 日常维护与备份

以下命令示例使用本地 overlay；公网实例将 `compose.local.yaml` 换成 `compose.public.yaml`，并始终保留自己的额外 override 与项目名。

```sh
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml ps
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml logs --tail 100 -f app
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml stop
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml start
```

升级前完成活动 turn 并备份。`down` 保留 named volumes；`down --volumes` 会删除登录、历史和网页数据，不用于常规升级。容器重启/重建会结束容器内的 PTY、Tmux server 与活动进程；卷只持久化磁盘数据，不能保存运行中的进程。浏览器断开连接则保留同一容器中仍运行的 Tmux 会话。

先停止应用，使用同一 Compose 参数备份两个卷，随后备份宿主机 `WORKSPACE_PATH` 和私有环境文件：

```sh
mkdir -p backups
chmod 700 backups
umask 077
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml stop app
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml run --rm -T --no-deps --entrypoint tar app -C /app/data -czf - . > backups/webdata.tar.gz
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml run --rm -T --no-deps --entrypoint tar app -C /home/node/.codex -czf - . > backups/codexhome.tar.gz
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml start app
```

恢复时先停止应用，在确认卷目标后用相同的 `run --rm -T --no-deps --entrypoint tar app` 参数执行 `-C /app/data -xzf -` 或 `-C /home/node/.codex -xzf -`，从对应备份文件重定向 stdin。恢复会覆盖同名文件，先备份当前内容。Caddy 公网卷包含证书和状态，也按同样原则私下备份。

```sh
git pull --ff-only
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml build --pull app
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml up -d --wait
```

Web 镜像升级与 Codex 升级相互独立。CLI 升级后核对协议兼容性；本机/远端升级不要求重建镜像，完成活动任务后重新启动 app-server 即可。

## 检查与排错

| 现象 | 检查 |
| --- | --- |
| Compose 提示密码未设置 | `--env-file .env.docker` 是否存在，密码是否至少 12 位 |
| Bind mount 不存在/Permission denied | `WORKSPACE_PATH` 是宿主机已有目录，UID 1000 具有访问权限 |
| 登录后仍显示未登录 | 域名与 `PUBLIC_ORIGIN` 一致；HTTPS 配置需 HTTPS 访问，检查代理与 Cookie |
| `.env.docker` 密码无法登录 | 已保存的 `web-password.json` 优先；使用设置里更新后的密码，忘记时按访问密码重置步骤恢复 |
| 本机提示未找到 Codex | 镜像不内置 CLI；添加宿主安装 overlay，核对 `HOST_CODEX_DIRECTORY` 和绝对 `CODEX_BIN`，或选择 SSH 主机 |
| 网页可登录但模型不可用 | 在执行 CLI 的远端或容器 `CODEX_HOME` 登录；确认账户模型权限/提供方配置 |
| SSH 主机密钥未受信任/已变更 | 在连接编辑页获取指纹并确认；变更时核对新旧指纹后显式替换，迁移时保留 `webdata` |
| 其他 SSH 错误 | 从容器测试同一别名，检查挂载路径、身份文件权限和地址/端口 |
| 没有桌面历史 | 默认卷独立；核对同数据目录和绝对项目路径，不假设自动云同步 |
| Linux sandbox/namespace 不可用 | 宿主机内核和容器策略会影响 Codex sandbox；先检查具体错误，配置不自动放宽 Docker 权限 |
| 重启后 Tmux 不在 | 磁盘卷不保存进程；使用容器外 SSH 主机可让其 Tmux 独立于 Web 容器 |
| Caddy 未获得证书 | 域名 DNS、80/443、ACME 联系人、CAA/网络，查看 Caddy 日志 |
| 手机不能启用通知 | 可信 HTTPS、正确 Origin；iOS 16.4+ 从主屏幕应用打开后主动启用；系统拒绝需到通知设置允许 |
| 测试通知未送达 | 用户主动授权、类别/30 天期限、推送服务网络、VAPID 配对与 `webdata`；强退/省电/专注模式另行排查 |

本次标准 Docker 实测中，只读/工作区写入命令均遇到 `bwrap: No permissions to create a new namespace`；容器内的“完全访问”命令和 PTY 可运行。细粒度 sandbox 需要相应内核/user namespace/容器策略支持，部署时另行确认。如用户明确选择 Codex“完全访问”，它作用于容器进程可访问的挂载和 SSH 工作站，不会授予宿主机 Docker 管理权限。不要为了启动而自动切换权限或增加 `--privileged`。

可启用的 [CI 示例](../deploy/github-actions/README.md) 验证应用测试/构建与隔离容器：无 CLI 时的健康检查/网页登录，再只读挂载 CI 宿主 CLI 检查真实 app-server 握手/文件/PTY/Tmux、重建后的数据保存，以及 HTTPS origin 的 Secure Cookie 和 Caddy 配置。复制到 `.github/workflows/ci.yml` 后启用。测试不需要模型账户或推理额度；真实域名证书、实际 SSH 和桌面活动 turn 仍由部署环境验收。[验证清单](validation.md)。

2026-10-06 曾在独立 Colima Linux/ARM64 环境验证内置 CLI 的旧版镜像及强制重建持久化；该结果不代表本次宿主 CLI 挂载方案已在所有平台验收。新的 CI 示例覆盖无 CLI 启动和宿主安装复用，真实 ACME 证书签发另行验收。

参考：[Docker Compose 生产部署](https://docs.docker.com/compose/how-tos/production/)、[Codex CLI](https://learn.chatgpt.com/docs/codex/cli)、[app-server](https://learn.chatgpt.com/docs/app-server)。
