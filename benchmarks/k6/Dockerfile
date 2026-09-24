# fauxqs built from this checkout, plus the Pyroscope profiler. Build from the
# repository root: docker build -f benchmarks/k6/Dockerfile .
FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.2.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src/ src/
RUN pnpm run build

FROM node:24-alpine
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.2.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY --from=build /app/dist/ dist/

# The profiler lives outside /app so that fauxqs' own dependency tree stays
# exactly what the published image ships. @datadog/pprof ships a musl prebuild,
# so no install scripts are needed.
WORKDIR /profiler
COPY benchmarks/k6/profiler/package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund
COPY benchmarks/k6/profiler/server.ts ./

RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 4566
HEALTHCHECK --interval=1s --timeout=3s --retries=30 \
  CMD wget -q -O /dev/null http://127.0.0.1:4566/health || exit 1
ENTRYPOINT ["node", "/profiler/server.ts"]
