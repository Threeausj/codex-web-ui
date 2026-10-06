# GitHub Actions

本目录保存可选工作流模板。当前 GitHub 登录没有 `workflow` 权限，因此模板未放入自动执行的 `.github/workflows`，完整源码与 Docker 部署不受影响。

要启用，在具有相应仓库权限的账户中执行并提交：

```sh
mkdir -p .github/workflows
cp deploy/github-actions/ci.yml .github/workflows/ci.yml
```

通过 gh 的 OAuth 登录上传需先在浏览器授权 `gh auth refresh -h github.com -s workflow`；也可由仓库所有者在 GitHub 网页创建该工作流。完成后 main 分支 push、pull request 和手动 dispatch 会运行应用及 Docker 两个任务。

应用任务包含 Node 22、固定 Codex CLI、单元/协议测试、生产构建和 Chromium 流程。Docker 任务验证本地/公网 Compose、镜像构建、官方 app-server、鉴权、文件、PTY、Tmux、容器重建后的数据保留、Caddy 配置和 Secure Cookie。使用隔离目录与临时密码，不需要模型账户，不调用付费推理。

---

This directory contains an optional workflow template. The current GitHub login lacks the `workflow` scope, so it is stored outside the automatically executed `.github/workflows` directory. All application sources and Docker deployment files are included.

To enable it, copy the template using the commands above and commit with an authorized account. For a gh OAuth login, run `gh auth refresh -h github.com -s workflow` and complete the browser authorization first. The repository owner can also create the workflow through GitHub's web editor.

Once enabled, pushes to main, pull requests, and manual dispatch run application and Docker jobs. The application job checks Node 22, pinned Codex CLI, unit/protocol tests, the production build, and Chromium workflows. The Docker job validates both Compose modes, builds/runs the image, tests app-server/auth/files/PTY/tmux, checks persistence after recreation, and validates Caddy/Secure cookies. All runtime data and passwords are isolated; no model login or paid inference is required.
