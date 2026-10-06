# GitHub Actions

本目录保存可选工作流模板，默认不放入自动执行的 `.github/workflows`。应用和 Docker 部署可以独立使用；按需启用持续集成。

要启用，在具有相应仓库权限的账户中执行并提交：

```sh
mkdir -p .github/workflows
cp deploy/github-actions/ci.yml .github/workflows/ci.yml
```

通过 gh 的 OAuth 登录上传需先在浏览器授权 `gh auth refresh -h github.com -s workflow`；也可由仓库所有者在 GitHub 网页创建该工作流。完成后 main 分支 push、pull request 和手动 dispatch 会运行应用及 Docker 两个任务。

应用任务包含 Node 22、CI 宿主的当前 Codex CLI、单元/协议测试、生产构建和 Chromium 流程。Docker 任务先验证镜像未内置 CLI 时的健康检查和网页登录，再通过 `compose.host-codex.yaml` 只读挂载 CI 宿主安装，验证官方 app-server、鉴权、文件、PTY、Tmux、容器重建后的数据保留、Caddy 配置和 Secure Cookie。CLI 不进入镜像，模板没有固定版本；使用隔离目录与临时密码，不需要模型账户，不调用付费推理。

---

This directory contains an optional workflow template, stored outside the automatically executed `.github/workflows` directory by default. Application and Docker deployment files can be used independently; enable continuous integration when needed.

To enable it, copy the template using the commands above and commit with an authorized account. For a gh OAuth login, run `gh auth refresh -h github.com -s workflow` and complete the browser authorization first. The repository owner can also create the workflow through GitHub's web editor.

Once enabled, pushes to main, pull requests, and manual dispatch run application and Docker jobs. The application job checks Node 22, the current CLI installed on the CI host, unit/protocol tests, the production build, and Chromium workflows. The Docker job first checks web startup without a CLI, then mounts the host installation read-only with `compose.host-codex.yaml` to test app-server/auth/files/PTY/tmux and persistence. It also validates Caddy/Secure cookies. The image contains no CLI and the template does not pin a version. All runtime data and passwords are isolated; no model login or paid inference is required.
