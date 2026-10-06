# Docker deployment

[简体中文](docker.md) · **English**

The multi-stage image uses Node.js 22 on Debian Bookworm and runs as non-root `node` (`1000:1000`). It includes pinned Codex CLI `0.159.2`, Git, OpenSSH, tmux, Python 3, and ripgrep. Conversations and execution still use the official Codex app-server stdio protocol; its raw transport is not exposed.

## Files and persistent data

| File/location | Purpose |
| --- | --- |
| `Dockerfile`, `.dockerignore` | Build the production frontend/backend; exclude credentials and local workspaces |
| `compose.yaml` | Application base, with no published ports |
| `compose.local.yaml` | Publish only `127.0.0.1:8787` |
| `compose.public.yaml` | Caddy publishes 80/443; app remains on the Compose network |
| `deploy/docker/env.example` | Copy to the Git-ignored `.env.docker` |
| `deploy/docker/Caddyfile` | Automatic HTTPS and WebSocket reverse proxy |
| `webdata` volume → `/app/data` | Web hosts, projects, preferences, uploads, push keys, and device authorizations |
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
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml exec app codex --version
docker compose --env-file .env.docker -f compose.yaml -f compose.local.yaml exec app codex login --device-auth
```

Complete the Codex login using the CLI's browser/device instructions; your account must permit device login. You can also configure an existing account/provider in persistent `CODEX_HOME` using the supported CLI flow. The web password does not grant model access.

Open [http://127.0.0.1:8787](http://127.0.0.1:8787), sign in, and add a project under `/workspace`. If port 8787 is already used, stop one service or change the host port in the local overlay and update its `PUBLIC_ORIGIN` accordingly.

Local HTTP origins use cookies without Secure; the HTTPS origin enables Secure. Both modes keep HttpOnly, SameSite, CSRF, and Origin checks. `NODE_ENV` does not disable authentication.

## Public HTTPS

Point a domain at the server and allow TCP 80/443. UDP 443 is optional for HTTP/3. Set these values in `.env.docker`:

```dotenv
CODEX_WEB_PASSWORD=replace-with-your-generated-password
WORKSPACE_PATH=/srv/codex-workspace
CODEX_VERSION=0.159.2
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
docker compose --env-file .env.docker -f compose.yaml -f compose.public.yaml exec app codex login --device-auth
docker compose --env-file .env.docker -f compose.yaml -f compose.public.yaml logs --tail 100 caddy
```

Visit your HTTPS domain and sign in. Do not combine the local and public overlays: that would add an unnecessary backend port. With an existing reverse proxy, run the base Compose file and connect the trusted proxy to `app:8787` on a controlled network, overriding the HTTPS origin/trust settings for your setup. Do not expose the backend directly.

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

Prepare a dedicated directory containing only required SSH settings, identity files, and verified `known_hosts`. Ensure UID 1000 can read the keys; use directory mode `0700` and private-key mode `0600`. Verify server fingerprints in a trusted terminal first; do not disable strict host-key checking.

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

In Settings → Connections, enter a hostname or SSH alias and use container identity paths such as `/home/node/.ssh/...`. Leave the Codex path empty for remote interactive-login-shell discovery, or specify the remote executable. Test the connection before saving it. Remote projects use remote paths, not container `/workspace` paths. Keep private keys, populated SSH overrides, `.env.docker`, and Codex login data out of Git.

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

The pinned `CODEX_VERSION` can be changed explicitly before rebuilding. Check protocol compatibility and regenerate types when upgrading the CLI; avoid silently floating to `latest`.

## Validation and troubleshooting

| Symptom | Check |
| --- | --- |
| Missing password | `.env.docker` and `--env-file`; password must contain at least 12 characters |
| Missing mount/permission denied | Host `WORKSPACE_PATH` exists and UID 1000 has access |
| Login does not persist | Correct origin/domain, HTTPS for the public mode, proxy/Cookie configuration |
| Models unavailable | Run Codex login in the container and check account/provider access |
| SSH fails | Test the same alias inside the container; inspect mounts, key permissions, verified `known_hosts` |
| Desktop history absent | Default volume is independent; check shared data and exact working-directory paths |
| Sandbox/namespace errors | Codex sandbox depends on the kernel/container policy; the configuration never silently expands permissions |
| tmux gone after restart | File volumes do not preserve processes; SSH-host tmux can live independently of the web container |
| Caddy certificate failure | DNS, TCP 80/443, ACME contact, CAA/network, and Caddy logs |
| Phone cannot enable notifications | Trusted HTTPS/exact origin; launch the home-screen app on iOS 16.4+; change denied OS permission in notification settings |
| Test notification not delivered | Explicit opt-in, categories/30-day expiry, vendor network access, matching VAPID keys, and `webdata`; inspect force-stop/power-saving/Focus separately |

In the tested standard Docker deployment, read-only/workspace-write commands reported `bwrap: No permissions to create a new namespace`; container-bound Full access commands and PTYs worked. Fine-grained sandbox modes require suitable kernel/user-namespace/container-policy support and need separate environment verification. If a user explicitly selects Codex Full access, it applies to mounts/processes/SSH hosts accessible to the container and does not grant host Docker management. Do not automatically switch permissions or enable `--privileged` to work around an error.

The [optional CI template](../deploy/github-actions/README.md) checks the application suite/build and an isolated container: health, login/Cookie behavior, unauthorized rejection, real app-server handshake/files/PTY/tmux, persistence after recreation, HTTPS-origin Secure cookies, and Caddy configuration. Copy it to `.github/workflows/ci.yml` to enable it. It needs no model account or inference quota. Real domain certificates, SSH targets, and desktop active turns require deployment-specific verification. See the [validation checklist](validation.md).

On 2026-10-06, the image was built and the container checks above passed in an isolated Colima Linux/ARM64 environment, including forced-recreation persistence, public-origin Cookie behavior, and Caddy validation. An amd64 image and real ACME certificate issuance were not tested.

References: [Compose in production](https://docs.docker.com/compose/how-tos/production/), [Codex CLI](https://learn.chatgpt.com/docs/codex/cli), [app-server](https://learn.chatgpt.com/docs/app-server).
