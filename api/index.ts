import { Elysia } from "elysia";
import { routers } from "./routers";
import { ensureSchema } from "./db";

// Kick off schema initialization in background
ensureSchema().catch((err) => {
  console.error("[Knex] Initial schema error:", err);
});

export const app = new Elysia()
  .use(routers);

export type App = typeof app;
export default () => app;
