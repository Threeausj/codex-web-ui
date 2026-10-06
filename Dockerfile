# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
LABEL org.opencontainers.image.title="Codex Web UI" \
      org.opencontainers.image.description="Vue web client for a host or SSH-installed Codex app-server"
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       bash ca-certificates git libgcc-s1 libstdc++6 openssh-client python3 ripgrep tini tmux \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o node -g node -m 0700 /app/data /home/node/.codex \
    && install -d -o node -g node -m 0755 /workspace
COPY --from=build /app/package.json /app/package-lock.json /app/
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/dist-server /app/dist-server
COPY --from=build /app/dist /app/dist
# Normalize permissions inherited from NAS ACLs for the non-root runtime user.
RUN chmod 0644 /app/package.json /app/package-lock.json \
    && find /app/dist -type d -exec chmod 0755 {} + \
    && find /app/dist -type f -exec chmod 0644 {} +
ENV NODE_ENV=production \
    LANG=C.UTF-8 \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/app/data \
    STATIC_DIR=/app/dist \
    CODEX_HOME=/home/node/.codex \
    CODEX_BIN=codex \
    CODEX_CONNECTION_MODE=spawn \
    PUBLIC_ORIGIN=http://127.0.0.1:8787,http://localhost:8787 \
    TRUST_PROXY=0
USER node
WORKDIR /workspace
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=6s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8787/api/health', { signal: AbortSignal.timeout(5000) }).then(async r => { if (!r.ok || !(await r.json()).ok) process.exit(1) }).catch(() => process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/dist-server/server/index.js"]
