import { Elysia } from "elysia";
import { decrypt } from "paseto-ts/v4";
import { getPasetoKey } from "../routers/auth";

export const authDerive = (app: Elysia) =>
  app
    .derive(async ({ cookie: { session }, headers }) => {
      let token = session?.value;

      if (!token && headers.authorization?.startsWith("Bearer ")) {
        token = headers.authorization.slice(7);
      }

      if (!token) {
        return { user: null };
      }

      try {
        const key = getPasetoKey();
        const { payload } = await decrypt<{
          userId: string;
          username: string;
          name: string;
          doctorcode: string;
          groupId: any;
          depcode: any;
          role?: string;
        }>(key, token as string);

        return {
          user: {
            id: payload.userId,
            username: payload.username,
            name: payload.name,
            doctorcode: payload.doctorcode,
            groupId: payload.groupId,
            depcode: payload.depcode,
            role: payload.role || "user",
          },
        };
      } catch (err) {
        return { user: null };
      }
    })
    .onBeforeHandle(({ user, set }) => {
      if (!user) {
        set.status = 401;
        return { error: "Unauthorized" };
      }
    });