FROM node:24-alpine

WORKDIR /app

COPY package.json ./
RUN npm install

COPY test-app.ts ./

CMD ["node", "--experimental-strip-types", "test-app.ts"]
