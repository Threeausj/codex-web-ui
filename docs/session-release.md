# 按会话释放 Web 连接

资源管理列出当前由 Web 持有的会话名称、状态和 Codex PID。一个主机上的会话共享 app-server PID；“关闭会话”仅停止选中的会话及其子智能体，“关闭 Web Codex”则关闭整个主机的 Web 连接与交互终端。关闭会话保留历史、文件修改和各网页自己的输入草稿。

关闭状态写入私有 `runtime-state.json`，会广播到所有已连接的网页，并在重新打开页面时恢复。历史和图片仍可读取，但恢复、发送和其他会话写操作会被后端拒绝，直到用户点击“重新连接会话”。如果桌面端已接管会话，重新连接会按正常写锁冲突流程处理。

Codex 的 `thread/unsubscribe` 会让无订阅会话保留 30 分钟，并不能立即交出写锁。按会话释放使用原生 `thread/archive` 停止会话，再使用 `thread/unarchive` 将会话历史恢复到原位置；这个恢复接口不会重新取得写锁，也不会终止共享 app-server 或其他会话。关闭前记录未归档的子会话，关闭过程中收集实际归档事件，随后逐一恢复；原本已经归档的子会话保持归档。恢复计划先持久化，失败时保留计划，服务器重新启动后首次使用该主机或显式重新连接会恢复未完成的历史。

共享桌面 daemon 的 proxy 模式仅支持关闭整个 Web 连接，避免按会话停止共享的桌面任务。

官方接口说明：[Codex App Server](https://developers.openai.com/codex/app-server#unsubscribe-from-a-loaded-thread)。验证使用临时 `CODEX_HOME` 和离线 provider，在本机与 NAS SSH 上确认一个会话释放后另一个会话及 PID 保持、第二个客户端能接管，整个过程不调用模型。
