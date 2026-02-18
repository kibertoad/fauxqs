import { buildApp } from "./app.js";

const app = buildApp();

const start = async () => {
  await app.listen({ port: 3000, host: "0.0.0.0" });
};

start();
