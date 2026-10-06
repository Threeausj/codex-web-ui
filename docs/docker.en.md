# Docker deployment

[简体中文](docker.md) · **English**

The multi-stage image uses Node.js 22 on Debian Bookworm and runs as non-root `node` (`1000:1000`). It includes Git, OpenSSH, tmux, Python 3, and ripgrep. Codex comes from an existing host or SSH installation; the image neither bundles, pins, nor updates the CLI. Conversations and execution use the official Codex app-server stdio protocol; its raw transport is not exposed.

## Files and persistent data

| File/location | Purpose |
| --- | --- |
| `Dockerfile`, `.dockerignore` | Build the production frontend/backend; exclude credentials and local workspaces |
| `compose.yaml` | Application base, with no published ports |
| `compose.local.yaml` | Publish only `127.0.0.1:8787` |
| `compose.host-codex.yaml` | Optional read-only mount of an existing Linux host Codex installation |
| `compose.public.yaml` | Caddy publishes 80/443; app remains on the Compose network |
| `deploy/docker/env.example` | Copy to the Git-ignored `.env.docker` |
| `deploy/docker/Caddyfile` | Automatic HTTPS and WebSocket reverse proxy |
| `webdata` volume → `/app/data` | Web password hash, hosts, projects, preferences, uploads, push keys, and device authorizations |
| `codexhome` volume → `/home/node/.codex` | Codex login, configuration, and durable history |
| `WORKSPACE_PATH` → `/workspace` | Writable bind mount of your host project directory |

Compose prefixes volume names with the project name. Keep the same project directory/name, or consistently add `-p codex-web-ui` to every command, to reuse the same volumes. `STATIC_DIR=/app/dist` separates packaged frontend assets from the mounted working directory.

## Local setup

Install Docker Engine or Docker Desktop and Compose v2 supporting `--wait`. From the repository root:

```sh
cp deploy/docker/env.example .env.docker
chmod 600 .env.docker
mkdir -p workspace
openssl rand -hex 32
```

Put the generated password in `.env.docker` as `CODEX_WEB_PASSWORD` (at least 12 characters). Set `WORKSPACE_PATH` to an existing host directory, preferably an absolute path, or keep `./workspace`.

On Linux, UID/GID `1000:1000` must be able to read/write the directory. For a dedicated empty directory, use `sudo install -d -o 1000 -g 1000 -m 0750 /srv/codex-workspace` and select that path. Configure existing project permissions according to their actual ownership; the image does not recursively change mounted directory ownership.

```sh
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml up -d --build --wait
```

This is sufficient for an SSH-only deployment: health checks, login, and connection settings work without a local CLI. Add a remote machine with Codex installed under Settings → Connections, test it, and select that host. See the SSH section below. Selecting Local without a mounted installation shows a configuration message without preventing web login or remote-host setup.

Open [http://127.0.0.1:8787](http://127.0.0.1:8787), sign in, and choose the configured host and project. If port 8787 is already used, stop one service or change the host port in the local overlay and update its `PUBLIC_ORIGIN` accordingly.

Local HTTP origins use cookies without Secure; the HTTPS origin enables Secure. Both modes keep HttpOnly, SameSite, CSRF, and Origin checks. `NODE_ENV` does not disable authentication.

When using a NAS IP or your own HTTPS reverse proxy, add the browser's exact origin (scheme, hostname and port) to `PUBLIC_ORIGIN`. Unlisted origins receive `403 Untrusted origin` even with the correct password. Separate multiple origins with commas. Mixed HTTP/HTTPS deployments set Secure cookies according to the trusted login origin, so LAN HTTP logins remain usable and HTTPS logins remain protected; HTTPS-only deployments always require Secure cookies. HTTP pages generate compatible UUIDs with `crypto.getRandomValues` instead of requiring the secure-context-only `crypto.randomUUID` API.

## Reuse the host Codex installation

Local execution on Linux requires a read-only installation mount with the same architecture as the container. For npm, run `npm root -g` in the environment that installed Codex. Set `HOST_CODEX_DIRECTORY` to the complete `@openai` scope beneath that directory, including Codex and its platform binary dependencies. Mounting only a `/usr/local/bin/codex` symlink or JavaScript entrypoint misses those dependencies. Add these values to `.env.docker`, adjusting for your npm/nvm prefix:

```dotenv
HOST_CODEX_DIRECTORY=/usr/local/lib/node_modules/@openai
CODEX_BIN=/opt/host-codex/codex/bin/codex.js
```

Retain `-f compose.host-codex.yaml` in every command for this deployment:

```sh
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml -f compose.host-codex.yaml config --quiet
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml -f compose.host-codex.yaml up -d --build --wait
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml -f compose.host-codex.yaml exec app sh -c '"$CODEX_BIN" --version'
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml -f compose.host-codex.yaml exec app sh -c '"$CODEX_BIN" login --device-auth'
```

The last command authenticates the container's durable `CODEX_HOME`; it does not change the host's account. You can instead configure an existing provider in that home. Installation mounts and account/history mounts are separate: sharing the executable does not automatically share host history. See desktop synchronization below. UID 1000 needs read/execute access to the installation; keep that mount read-only.

For a standalone native Linux installation, mount the directory containing the actual executable and set `CODEX_BIN=/opt/host-codex/actual-filename`; for example, `HOST_CODEX_DIRECTORY=/srv/codex-bin` with `CODEX_BIN=/opt/host-codex/codex`. Include runtime dependencies and symlink targets. Avoid mounting only the versioned executable, because atomic replacement during an upgrade can leave a file mount on the old inode. pnpm/Bun layouts with cross-directory symlinks require explicit limited mounts covering their targets, or an SSH connection to the host. macOS/Windows binaries cannot run inside a Linux container; execute them on their original host through SSH.

Update Codex through the host or remote machine's usual mechanism. The application does not update it and the web image needs no rebuild for a CLI upgrade. Finish active tasks, then restart the web service to spawn a fresh app-server: a running app-server and ordinary browser reconnection keep the existing process. Unchanged directory paths expose updated files on the next spawn. If nvm changes the Node version or installation prefix, update `HOST_CODEX_DIRECTORY` and recreate the container. Each new SSH app-server connection resolves the remote login-shell PATH again.

App-servers launched by the web application receive `-c features.default_mode_request_user_input=true` to allow structured questions in regular conversations, without writing host `config.toml`. Proxy connections to existing daemons depend on the daemon and session configuration; the proxy command cannot replace an existing daemon's startup configuration.

## Model gateways and client identity

`CODEX_CLIENT_NAME` sets app-server `initialize.clientInfo.name`, defaulting to `codex_web`. After trimming surrounding spaces, it must contain 1–64 ASCII characters, start with a letter or digit, and use only letters, digits, `_`, `.`, or `-`; control characters are always rejected. It applies to local and SSH `spawn`/`proxy` connections. The application title and version remain `Codex Web` / `0.1.0`.

sub2api's “Codex official clients only” restriction may reject the default `codex_web` identity. Normally, enable “Allow Codex app-server clients” for the gateway account to keep this application's identity. If your configured gateway requires the CLI compatibility identifier, explicitly opt in by setting this in `.env.docker`:

```dotenv
CODEX_CLIENT_NAME=codex_cli_rs
```

Finish active tasks, then recreate the application container using your original Compose arguments. For a local deployment:

```sh
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml up -d --wait
```

This changes only the client compatibility identifier. It does not make this web application an official client or change the model provider, API credentials, or account permissions. Codex uses the identifier as the `originator` for new threads; a cold resume preserves the identity stored in existing history, so new and continued conversations can receive different gateway decisions. Existing daemons and active threads in `proxy` mode may retain their context. This is not a hot update: verify with a new conversation. See the [protocol notes](protocol.md#客户端标识与模型网关).

## Access password and login

Web login lasts **30 days**. Sessions live in the server process, so restarting it requires login again. Under Settings → Account → Web access → Change access password (Chinese UI: “设置 → 账户 → 网页访问 → 修改访问密码”), enter the current password and confirm a new password of 12–1024 characters. Saving renews the current login for 30 days and preserves its connections, while immediately revoking other devices' logins and push authorizations. This does not change the Codex model account.

The first start initializes credentials from `CODEX_WEB_PASSWORD`; afterward, the scrypt hash in `/app/data/web-password.json` takes precedence over environment variables. The file uses mode `0600`. Changes in settings are not written to `.env.docker`, the plaintext bootstrap file, or logs. Preserve `webdata` to retain the password across restarts. The initial values in `.env.docker` and `bootstrap-password.txt` may no longer be the current password.

To recover a forgotten password, stop the app and back up `webdata`, set a new initial `CODEX_WEB_PASSWORD` in `.env.docker`, remove only `web-password.json` from that volume, and restart. Credentials initialize from the environment again, and previous logins and device grants become invalid. Do not delete the data volume or Codex history to reset access. A corrupt hash file prevents startup; use the same recovery procedure.

## Public HTTPS

Point a domain at the server and allow TCP 80/443. UDP 443 is optional for HTTP/3. Set these values in `.env.docker`:

```dotenv
CODEX_WEB_PASSWORD=replace-with-your-generated-password
WORKSPACE_PATH=/srv/codex-workspace
PUBLIC_HOST=codex.example.com
ACME_EMAIL=admin@example.com
# Optional: replace with a real maintainer contact; empty uses the HTTPS origin.
PUSH_SUBJECT=mailto:admin@example.com
```

`PUBLIC_HOST` must be a hostname without scheme, path, or trailing slash. The public overlay sets the exact HTTPS origin and `TRUST_PROXY=1`. Caddy handles TLS and WebSocket upgrades; the app has no host port mapping.

If a local deployment is running, stop/remove its containers while retaining the volumes before switching:

```sh
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml down
docker compose --env-file .env.docker -f compose.yaml -f compose.public.yaml up -d --build --wait
docker compose --env-file .env.docker -f compose.yaml -f compose.public.yaml logs --tail 100 caddy
```

Visit your HTTPS domain, sign in, and configure an SSH host; add `-f compose.host-codex.yaml` to use the host installation locally. Do not combine the local and public overlays: that would add an unnecessary backend port. With an existing reverse proxy, run the base Compose file and connect the trusted proxy to `app:8787` on a controlled network, overriding the HTTPS origin/trust settings for your setup. Do not expose the backend directly.

This is a single-user workstation gateway. Signed-in users can operate mounted files and configured SSH hosts; it does not provide tenant isolation. The deployment does not enable privileged mode, mount the Docker socket, or disable seccomp.

## PWA and mobile background push

After deploying public HTTPS, open **Settings → App and notifications** to install and explicitly enable notifications. Android Chrome offers an install prompt/browser menu; on iOS/iPadOS 16.4+, add the app to the home screen in Safari and enable notifications from the installed app. Completion, approval/additional input, and failures can arrive without the page remaining open, provided Node and the relevant task keep running. See the [PWA guide](pwa.en.md) for installation, privacy, authorization, and actual-device acceptance. Force-stop, power-saving, and OS notification policies can affect delivery.

Compose forwards three optional variables:

| Variable | Default/purpose |
| --- | --- |
| `PUSH_VAPID_PUBLIC_KEY` / `PUSH_VAPID_PRIVATE_KEY` | Leave both empty to generate `/app/data/push-vapid.json`; supply both when managing an existing key pair |
| `PUSH_SUBJECT` | First HTTPS `PUBLIC_ORIGIN`, or the project GitHub URL for local HTTP; a real maintainer `mailto:` contact is recommended publicly |

`webdata` also stores `push-subscriptions.json`. Device authorization lasts up to 30 days; natural login expiry/routine server restarts retain valid authorizations, while explicit logout revokes subscriptions associated with that login. No extra push volume or manual key generation is needed. Preserve this volume and keys during backups/upgrades/migrations; re-register devices after key/domain changes. Keep private keys/endpoints out of images, published logs, and Git.

The server needs access to supported browser-vendor push services, and the phone needs access to the app's HTTPS origin. Only official endpoints are accepted; there is no `PUSH_ALLOWED_HOSTS` override. PWA caching includes public static assets only, never APIs/private history, and provides no offline submissions. Container restarts still end container tasks; volumes cannot preserve running processes.

## SSH workstations

Remote users need a compatible Codex CLI and account configuration; install tmux remotely if needed. Hostnames, SSH aliases, identity paths, and `known_hosts` are resolved inside the container. The host's `~/.ssh` is not mounted automatically.

Add a new server directly in **Settings → Connections**: enter its address, port, and identity file, then select **Retrieve server fingerprints**. The dialog displays the resolved destination, key types, and SHA256 fingerprints. Confirm **Trust and test connection** to connect without editing `known_hosts` in a terminal. A connection test against an unknown host also opens this confirmation area.

Changed keys display both saved and current fingerprints and require a separate checkbox before **Replace fingerprints and test connection**. Confirmation checks the server keys again; expired confirmations or edited addresses require another scan. Connections retain `StrictHostKeyChecking=yes`. Web-confirmed keys persist at `/app/data/ssh/known_hosts` (`DATA_DIR/ssh/known_hosts`, mode `0600`) in `webdata`; preserve this volume for backups and migrations.

You can also mount existing SSH configuration and keys. Prepare a dedicated directory containing only required settings, identity files, and verified `known_hosts`. Ensure UID 1000 can read the keys; use directory mode `0700` and private-key mode `0600`. Existing records remain usable, and fingerprints can be checked against the server administrator's values. The [OpenSSH documentation](https://man.openbsd.org/ssh-keyscan) explains that scanning requires no login, but a retrieved key alone cannot prove server identity. SSH aliases resolve through the container's configuration, including address, port, and `HostKeyAlias`. Web scanning currently does not support `ProxyJump`, `ProxyCommand`, or `KnownHostsCommand`; use the existing SSH configuration to establish trust for those hosts.

Create optional `compose.ssh.yaml`:

```yaml
services:
  app:
    volumes:
      - /srv/codex-ssh:/home/node/.ssh:ro
```

Add this override to every command for that deployment. Validate the complete configuration with `config --quiet` first. For example:

```sh
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml -f compose.ssh.yaml up -d --wait
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml -f compose.ssh.yaml exec app ssh your-alias
```

Run `codex --version` inside that remote interactive shell so that PATH initialization through nvm/mise or similar tools takes effect.

In Settings → Connections, enter a hostname or SSH alias. Select Identity file → Upload private key to upload or replace an unencrypted OpenSSH / PEM private key, up to 64 KB. The server validates the key and fills in its container path. Keys persist under `/app/data/ssh-keys` in the web-data volume, with directory mode `0700` and file mode `0600`. Cancelling an edit removes unsaved uploads; replacing or deleting a connection removes uploaded keys only when no connection references them. You can also enter mounted paths such as `/home/node/.ssh/...`; these existing files are never deleted automatically. Identity keys authenticate the account, while server fingerprints identify the destination; configure them separately.

Leave the Codex path empty for remote interactive-login-shell discovery, or specify the remote executable. Test the connection before saving it. Remote projects use remote paths, not container `/workspace` paths. Keep private keys, populated SSH overrides, `.env.docker`, and Codex login data out of Git.

## Desktop history and live sharing

By default, `codexhome` is independent of the host desktop account. Using the same protocol does not provide cross-machine cloud synchronization.

On Linux, an override may bind the intended user's existing `CODEX_HOME` at `/home/node/.codex`, with compatible permissions and storage format. Existing conversation working directories must also be accessible at their original absolute paths. Back up the data first; do not bake credentials into the image. macOS/Windows desktop paths, executables, and private daemon sockets cannot simply be reused as Linux container paths.

Shared disk history is different from sharing active turns. Live sharing requires `CODEX_CONNECTION_MODE=proxy` and clients attached to the same compatible daemon. A Linux setup may mount the control socket's directory with suitable permissions and set the container `CODEX_SOCKET_PATH`. This deployment does not automatically find/start a desktop daemon, and never needs the Docker socket. See [desktop synchronization](../README.en.md#desktop-synchronization) and [protocol notes](protocol.md).

## Operations, backups, and upgrades

These examples use the local overlay. For public deployments replace it with `compose.public.yaml`, retaining your own overrides/project name.

```sh
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml ps
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml logs --tail 100 -f app
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml stop
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml start
```

Finish active turns before upgrading. `down` retains named volumes; `down --volumes` deletes web data, Codex login, and history and is not a routine upgrade command. Restarting/recreating a container ends its PTYs, tmux server, and active processes. Volumes preserve files, not running processes. Browser disconnection alone preserves tmux sessions within the still-running container.

Stop the app before backing up both volumes; separately back up your host workspace and private environment configuration:

```sh
mkdir -p backups
chmod 700 backups
umask 077
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml stop app
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml run --rm -T --no-deps --entrypoint tar app -C /app/data -czf - . > backups/webdata.tar.gz
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml run --rm -T --no-deps --entrypoint tar app -C /home/node/.codex -czf - . > backups/codexhome.tar.gz
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml start app
```

To restore, stop the app, confirm the target volumes, and use the same `run --rm -T --no-deps --entrypoint tar app` command with `-C /app/data -xzf -` or `-C /home/node/.codex -xzf -`, redirecting stdin from the corresponding archive. Restoration overwrites matching files: back up current data first. Back up public Caddy volumes privately as well, since they contain certificate/state data.

```sh
git pull --ff-only
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml build --pull app
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml up -d --wait
```

Web image and Codex upgrades are independent. Check protocol compatibility after a CLI upgrade and restart app-server after finishing active tasks; upgrading the host or remote CLI does not require rebuilding the image.

## Validation and troubleshooting

| Symptom | Check |
| --- | --- |
| Missing password | `.env.docker` and `--env-file`; password must contain at least 12 characters |
| Environment password no longer works | A saved `web-password.json` takes precedence; use the current password or follow the recovery steps above |
| Missing mount/permission denied | Host `WORKSPACE_PATH` exists and UID 1000 has access |
| Login does not persist | Correct origin/domain, HTTPS for the public mode, proxy/Cookie configuration |
| Local Codex missing | Mount the host installation with the optional overlay and check `HOST_CODEX_DIRECTORY`/absolute `CODEX_BIN`, or select an SSH host |
| Models unavailable | Authenticate in the remote user's or container's `CODEX_HOME`; check account/provider access |
| Unknown or changed SSH host key | Retrieve and confirm fingerprints in the connection dialog; compare old/new keys before explicit replacement and preserve `webdata` during migration |
| Other SSH failure | Test the same alias inside the container; inspect mounts, identity permissions, and address/port |
| Desktop history absent | Default volume is independent; check shared data and exact working-directory paths |
| Sandbox/namespace errors | Codex sandbox depends on the kernel/container policy; the configuration never silently expands permissions |
| tmux gone after restart | File volumes do not preserve processes; SSH-host tmux can live independently of the web container |
| Caddy certificate failure | DNS, TCP 80/443, ACME contact, CAA/network, and Caddy logs |
| Phone cannot enable notifications | Trusted HTTPS/exact origin; launch the home-screen app on iOS 16.4+; change denied OS permission in notification settings |
| Test notification not delivered | Explicit opt-in, categories/30-day expiry, vendor network access, matching VAPID keys, and `webdata`; inspect force-stop/power-saving/Focus separately |

In the tested standard Docker deployment, read-only/workspace-write commands reported `bwrap: No permissions to create a new namespace`; container-bound Full access commands and PTYs worked. Fine-grained sandbox modes require suitable kernel/user-namespace/container-policy support and need separate environment verification. If a user explicitly selects Codex Full access, it applies to mounts/processes/SSH hosts accessible to the container and does not grant host Docker management. Do not automatically switch permissions or enable `--privileged` to work around an error.

The [optional CI template](../deploy/github-actions/README.md) checks the application suite/build and an isolated container: health/login without a local CLI, then a read-only CI host installation for real app-server handshake/files/PTY/tmux and persistence, plus HTTPS-origin Secure cookies and Caddy configuration. Copy it to `.github/workflows/ci.yml` to enable it. It needs no model account or inference quota. Real domain certificates, SSH targets, and desktop active turns require deployment-specific verification. See the [validation checklist](validation.md).

On 2026-10-06, the previous image with a bundled CLI passed isolated Colima Linux/ARM64 checks, including forced-recreation persistence. That evidence does not cover every platform for the new host-installation mount. The updated CI template covers startup without Codex and host installation reuse; real ACME issuance still requires separate verification.

References: [Compose in production](https://docs.docker.com/compose/how-tos/production/), [Codex CLI](https://learn.chatgpt.com/docs/codex/cli), [app-server](https://learn.chatgpt.com/docs/app-server).
