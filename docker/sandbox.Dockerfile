# Image contract: coreutils `timeout`, `sleep`; uid/gid 65534; nothing writable outside the tmpfs mounts.
FROM node:22-bookworm-slim
RUN npm install -g typescript@5.6.3 && npm cache clean --force
USER 65534:65534
WORKDIR /workspace
