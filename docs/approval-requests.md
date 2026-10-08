# 审批请求与手机提醒

“完全访问”向 Codex 发送 `danger-full-access` 和 `approvalPolicy: "never"`。它不会把所有服务器 RPC 都变成人工审批；服务器也会请求当前时间、调用客户端工具或刷新凭据。

前端审批卡片、重连恢复和服务端推送共用 `shared/server-requests.ts` 的分类规则。命令、文件、额外权限、选择题和已支持的 MCP 输入请求等待用户操作。`currentTime/read` 由后台返回整秒 Unix 时间；没有实现的客户端工具返回原生工具失败结果，其他未支持的回调返回 RPC `-32601`，避免出现空白的“批准命令执行”卡片或无限等待。

真正的审批可能不含 `command`、`cwd` 或 `reason`。网页通过相同 `threadId + turnId + itemId` 的操作记录补齐详情，网络审批显示目标，终端输入与文件修改分别显示操作类型和文件路径。后台最多缓存 256 条、合计 1 MiB 的操作预览，每条最多 64 KiB，不缓存命令输出或文件差异；浏览器重连后仍能查看待审批操作。没有可用详情时明确提示同步核对。真实审批仍需用户选择，并遵守 Codex 给出的可用决策。

只有真实的交互请求会触发“等待确认／选择”提醒，服务回调不会推送。通知投递由后台执行，不依赖浏览器保持打开。服务端成功投递给推送提供方不代表手机已显示通知；诊断仍需区分订阅状态、投递失败或重试，以及 Android 的通知显示情况。

本次问题对应的 NAS 运行记录确认使用了 `danger-full-access + never`，但截图中的旧请求已被清除，无法恢复其具体方法名。已复现并修复“非审批请求被显示为空审批卡片、推送端却不通知”的分类错误，不据此推断某个未知请求应自动允许。

参考：[Codex app-server 的审批与客户端工具协议](https://learn.chatgpt.com/docs/app-server)、[Codex 沙箱与审批设置](https://learn.chatgpt.com/docs/sandboxing)。当前时间回调字段参见仓库生成的 `shared/protocol/v2/CurrentTimeReadResponse.ts`。
