FROM node:24-alpine AS build

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.2.1 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ src/
RUN pnpm run build

FROM node:24-alpine

# su-exec: drop privileges in the entrypoint after the root-only setup
# libcap:  give dnsmasq the capability to bind port 53 without being root,
#          so the image also works when started with --user / runAsUser
RUN apk add --no-cache tini dnsmasq su-exec \
  && apk add --no-cache --virtual .caps libcap \
  && setcap cap_net_bind_service+ep /usr/sbin/dnsmasq \
  && apk del .caps

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.2.1 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY --from=build /app/dist/ dist/
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Pre-create the data directory owned by the unprivileged user so that empty
# named volumes mounted here inherit that ownership from the image.
RUN mkdir -p /data && chown node:node /data

# No USER directive on purpose: the entrypoint needs root to bind dnsmasq to
# port 53 and to take ownership of bind-mounted volumes, and drops to the
# unprivileged `node` user before exec'ing the server. Start the container
# with --user/runAsUser if you want no root phase at all.

ENV FAUXQS_HOST=localhost
ENV FAUXQS_DATA_DIR=/data

EXPOSE 4566

HEALTHCHECK --interval=2s --timeout=5s --retries=10 \
  CMD wget -q -O /dev/null http://127.0.0.1:4566/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
