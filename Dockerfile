FROM node:24-alpine AS build

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.2.1 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ src/
RUN pnpm run build

FROM node:24-alpine

RUN apk add --no-cache tini dnsmasq

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.2.1 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY --from=build /app/dist/ dist/
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV FAUXQS_HOST=localhost
ENV FAUXQS_DATA_DIR=/data

EXPOSE 4566

HEALTHCHECK --interval=2s --timeout=5s --retries=10 \
  CMD wget -q -O /dev/null http://127.0.0.1:4566/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
