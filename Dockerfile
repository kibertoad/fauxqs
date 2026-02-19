FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM node:24-alpine

RUN apk add --no-cache tini dnsmasq

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist/ dist/
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV FAUXQS_HOST=localhost

EXPOSE 4566

HEALTHCHECK --interval=2s --timeout=5s --retries=10 \
  CMD wget -q -O /dev/null http://127.0.0.1:4566/health || exit 1

ENTRYPOINT ["/entrypoint.sh"]
