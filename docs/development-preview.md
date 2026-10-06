# 开发服务与持久终端

在工作区的开发服务预览中输入所选主机的端口和路径。先在交互终端启动 Vite 等服务；网页预览不会自动启动项目。

## 开发服务预览

- 支持 1024–65535 的 HTTP 开发端口，以及相同端口上的 WebSocket（包括 Vite HMR）。目标固定为所选主机的 `127.0.0.1`，不接受任意目标 URL。
- 本机直接代理；SSH 主机使用保存的 SSH 连接信息，通过 `ssh -N -L 127.0.0.1:本地临时端口:127.0.0.1:开发端口` 转发。沿用系统 SSH 密钥和 known_hosts，不自动接受未知主机。
- HTML/CSS/JavaScript 中的根资源路径及运行时 fetch、XHR、WebSocket、EventSource 会转入预览票据路径。相对路径保留原来的目录关系。
- 框架仅授予 `allow-scripts`，没有 `allow-same-origin`；开发页面无法访问 Codex 页面 DOM。Node 代理剥离网页登录 cookie 和 Authorization，也不把开发服务 Set-Cookie 写到 Codex 页面。
- 创建和关闭票据需要登录与 CSRF token；资源请求使用随机票据，以支持不发送 SameSite cookie 的隔离框架。票据最长 1 小时，退出登录、删除主机、关闭预览时失效；对应 WebSocket 与 SSH 转发同时关闭。

该模式适用于本地前端开发服务。依赖浏览器同源存储、第三方登录跳转、Service Worker、任意外部网络、非 UTF-8 资源或强制压缩脚本的应用，可能需要独立开发域名。预览当前不代理目标主机的 HTTPS/TLS 服务。

## 终端

普通终端继续通过官方 app-server `command/exec` PTY、`write`、`resize`、`terminate` 工作；网络断开后可重新连接仍运行的进程。Node 或其 app-server 服务重启会结束普通 PTY。

移动端提供 Ctrl 按住一次、Ctrl+C、Ctrl+D、Tab、Esc 和方向键。按一次 Ctrl 后输入下一个字符，会发送相应控制字符。

勾选“持久 Shell”会通过 app-server 检测目标主机已有的 `tmux`。没有检测到时显示具体提示，不安装软件，也不悄悄改成普通终端。检测到后，仍由 app-server 创建 PTY，并执行 `tmux new-session -A -s 项目会话名 -c 项目路径`。主机 ID 和项目路径决定固定会话名，重新连接或重启网页服务后可再次附着同一会话。终止网页 PTY 只断开附着；Shell 内执行 `exit` 会结束实际会话。主机重启或 tmux 服务退出仍会结束该会话。

## 验证

`npx tsx scripts/preview-smoke.ts` 创建并清理临时 Vite 项目和隔离 Codex 数据目录，不调用模型。它使用真实 Chromium 验证 390px 窗口、根 ES module/CSS/fetch、隔离父页面，以及通过 WebSocket 的真实文件 HMR；同时通过真实 app-server 检测 tmux 可用性。

当前开发机器已安装 tmux 3.7c。隔离实际 app-server 验证新建、读取、附着参数和删除；跨服务重启后重新附着的行为仍未实测。macOS 默认/只读沙箱可能拦截 tmux socket，需用户显式选择完全访问后重试，网页不会自动升级权限。工作区新增 `Tmux` 标签管理目标主机现有会话。SSH 服务需要有用户提供且可连接的目标主机后进行远端验证。
