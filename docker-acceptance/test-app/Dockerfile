FROM node:24-alpine

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.2.1 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY test-app.ts ./

CMD ["node", "--experimental-strip-types", "test-app.ts"]
