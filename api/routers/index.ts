import { Elysia } from "elysia";
import { authRoutes } from "./auth";
import { usersRoutes } from "./users";

export const routers = new Elysia()
    .use(authRoutes)
    .use(usersRoutes);
