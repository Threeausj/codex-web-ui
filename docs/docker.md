# Docker 部署

**简体中文** · [English](docker.en.md)

镜像使用 Node.js 22 Debian Bookworm、多阶段构建及非 root 用户 `node`（UID/GID `1000:1000`）。内置 Codex CLI `0.159.2`、Git、OpenSSH、Tmux、Python 3 和 ripgrep。对话及执行仍经官方 Codex app-server stdio 协议；容器不发布原始 app-server transport。

## 文件与数据

| 文件/位置 | 用途 |
| --- | --- |
| `Dockerfile` / `.dockerignore` | 构建生产前端/服务端；排除凭据、工作区和本机数据 |
| `compose.yaml` | 应用基础配置，不发布端口 |
| `compose.local.yaml` | 只将 `127.0.0.1:8787` 发布给本机 |
| `compose.public.yaml` | Caddy 暴露 80/443；应用仅在 Compose 网络内可达 |
| `deploy/docker/env.example` | 环境模板，复制为被 Git 忽略的 `.env.docker` |
| `deploy/docker/Caddyfile` | 自动 HTTPS 与 WebSocket 反向代理 |
| `webdata` 卷 → `/app/data` | 网页主机、项目、偏好、上传与元数据 |
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
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml exec app codex --version
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml exec app codex login --device-auth
```

第三条在容器内完成 Codex 账户登录，按照终端提示在浏览器授权；账户需允许设备登录。已有账户或提供方配置也可按官方 CLI 方式设置到持久化 `CODEX_HOME`。网页访问密码不提供模型权限。

打开 [http://127.0.0.1:8787](http://127.0.0.1:8787)，输入网页密码，然后浏览 `/workspace` 并添加项目。若宿主机已有服务占用 8787，先停止其中一个服务，或修改本地 overlay 的宿主机端口，并同步本地 `PUBLIC_ORIGIN`。

本地 HTTP origin 不设置 Secure Cookie；公网 HTTPS origin 自动设置 Secure Cookie。两种方式均保留 HttpOnly、SameSite、CSRF 与 Origin 校验，`NODE_ENV` 不用于关闭鉴权。

## 公网 HTTPS

准备一个指向部署机器的域名，放行 TCP 80/443；UDP 443 用于 HTTP/3，可按环境选择。编辑 `.env.docker`：

```dotenv
CODEX_WEB_PASSWORD=replace-with-your-generated-password
WORKSPACE_PATH=/srv/codex-workspace
CODEX_VERSION=0.159.2
PUBLIC_HOST=codex.example.com
ACME_EMAIL=admin@example.com
```

`PUBLIC_HOST` 只填域名，不包含协议、路径或末尾斜杠。公网配置生成精确的 `https://PUBLIC_HOST` origin，设置 `TRUST_PROXY=1`，由 Caddy 处理 TLS 和 WebSocket。基础应用没有宿主机端口映射。

若已运行本地部署，先关闭其容器而保留卷，再使用公网 overlay：

```sh
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml down
docker compose --env-file .env.docker -f compose.yaml -f compose.public.yaml up -d --build --wait
docker compose --env-file .env.docker -f compose.yaml -f compose.public.yaml exec app codex login --device-auth
docker compose --env-file .env.docker -f compose.yaml -f compose.public.yaml logs --tail 100 caddy
```

访问 `https://你的域名` 并登录。不要同时加载 `compose.local.yaml` 与 `compose.public.yaml`，否则会添加不必要的后端端口。若使用已有反向代理，可以仅运行基础 Compose，并由受控网络中的代理连接 `app:8787`；按实际 HTTPS origin 和可信代理配置覆盖环境，不将 8787 直接暴露到公网。

该产品是单用户工作站入口：登录者可以操作所挂载的文件和已经配置的 SSH 主机。它不提供多租户隔离或共享 SaaS 的权限体系。Docker 配置没有启用 `privileged`、Docker socket 挂载或关闭 seccomp。

## SSH 工作站

远端用户需要可用的 Codex CLI 与账户配置；需要 Tmux 时也在远端安装。SSH 地址、别名、身份文件路径都由容器内的 OpenSSH 解析，宿主机的 `~/.ssh` 不会自动进入容器。

准备一个仅包含所需 SSH 配置、身份文件和已核验 `known_hosts` 的目录，保证容器 UID 1000 能读取私钥；SSH 目录权限 `0700`、私钥 `0600`。先在可信终端核对服务器指纹，再写入 `known_hosts`；不使用 `StrictHostKeyChecking=no`。

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

网页“连接”中填写主机或 SSH 别名，私钥路径使用 `/home/node/.ssh/...`。Codex 路径留空通过远端交互式登录 shell 识别；也可指定远端可执行文件。先“测试连接”，成功后保存。远端目录使用远端路径，不使用容器 `/workspace` 路径。不要将私钥、实际 SSH override、`.env.docker` 或 Codex 登录数据提交到 Git。

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

`CODEX_VERSION` 固定兼容基线，可显式更改后重建。升级 CLI 时同时核对协议类型和运行验证，避免浮动 `latest` 改变行为。

## 检查与排错

| 现象 | 检查 |
| --- | --- |
| Compose 提示密码未设置 | `--env-file .env.docker` 是否存在，密码是否至少 12 位 |
| Bind mount 不存在/Permission denied | `WORKSPACE_PATH` 是宿主机已有目录，UID 1000 具有访问权限 |
| 登录后仍显示未登录 | 域名与 `PUBLIC_ORIGIN` 一致；HTTPS 配置需 HTTPS 访问，检查代理与 Cookie |
| 网页可登录但模型不可用 | 容器中执行 `codex login --device-auth`；确认账户模型权限/提供方配置 |
| SSH 错误 | 从容器测试同一别名，检查挂载路径、身份文件权限及已核验的 `known_hosts` |
| 没有桌面历史 | 默认卷独立；核对同数据目录和绝对项目路径，不假设自动云同步 |
| Linux sandbox/namespace 不可用 | 宿主机内核和容器策略会影响 Codex sandbox；先检查具体错误，配置不自动放宽 Docker 权限 |
| 重启后 Tmux 不在 | 磁盘卷不保存进程；使用容器外 SSH 主机可让其 Tmux 独立于 Web 容器 |
| Caddy 未获得证书 | 域名 DNS、80/443、ACME 联系人、CAA/网络，查看 Caddy 日志 |

本次标准 Docker 实测中，只读/工作区写入命令均遇到 `bwrap: No permissions to create a new namespace`；容器内的“完全访问”命令和 PTY 可运行。细粒度 sandbox 需要相应内核/user namespace/容器策略支持，部署时另行确认。如用户明确选择 Codex“完全访问”，它作用于容器进程可访问的挂载和 SSH 工作站，不会授予宿主机 Docker 管理权限。不要为了启动而自动切换权限或增加 `--privileged`。

可启用的 [CI 示例](../deploy/github-actions/README.md) 验证应用测试/构建与隔离容器：健康检查、登录/Cookie、未登录拒绝、真实 app-server 握手/文件/PTY/Tmux、重建后的数据保存，以及 HTTPS origin 的 Secure Cookie 和 Caddy 配置。复制到 `.github/workflows/ci.yml` 后启用。测试不需要模型账户或推理额度；真实域名证书、实际 SSH 和桌面活动 turn 仍由部署环境验收。[验证清单](validation.md)。

2026-10-06 已在独立 Colima 的 Linux/ARM64 环境实际完成镜像构建、上述容器检查及强制重建持久化验证；公网 origin/Cookie 和 Caddy 配置验证通过。未测试 amd64 镜像或真实 ACME 证书签发。

参考：[Docker Compose 生产部署](https://docs.docker.com/compose/how-tos/production/)、[Codex CLI](https://learn.chatgpt.com/docs/codex/cli)、[app-server](https://learn.chatgpt.com/docs/app-server)。
