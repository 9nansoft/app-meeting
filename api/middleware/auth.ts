import { Elysia } from "elysia";
import { decrypt } from "paseto-ts/v4";
import { getPasetoKey } from "../routers/auth";
import { getClientIp, writeSecurityLog } from "../services/logger";

export const authDerive = (app: Elysia) =>
  app
    .derive(async ({ cookie: { session }, headers, request }) => {
      let token = session?.value;

      if (!token && headers.authorization?.startsWith("Bearer ")) {
        token = headers.authorization.slice(7);
      }

      if (!token) {
        return { user: null, authFailReason: "no_token" as const };
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
          authFailReason: null,
        };
      } catch (err) {
        // session/token ไม่ถูกต้อง — บันทึกตาม พ.ร.บ. คอมพิวเตอร์ (ใช้ token ไม่ได้ อาจเป็นการปลอม)
        void writeSecurityLog({
          eventType: "auth.invalid_token",
          severity: "warning",
          ip: getClientIp(request.headers),
          userAgent: request.headers.get("user-agent"),
          method: request.method,
          path: new URL(request.url).pathname,
          detail: { reason: err instanceof Error ? err.message : "token_expired_or_invalid" },
        });
        return { user: null, authFailReason: "invalid_token" as const };
      }
    })
    .onBeforeHandle(({ user, authFailReason, set, request }) => {
      if (!user) {
        // เรียก API ที่ต้อง login โดยไม่มี session เลย
        // (กรณี token ไม่ถูกต้อง log เป็น auth.invalid_token ไปแล้วใน derive)
        if (authFailReason === "no_token") {
          void writeSecurityLog({
            eventType: "access.unauthorized",
            severity: "warning",
            ip: getClientIp(request.headers),
            userAgent: request.headers.get("user-agent"),
            method: request.method,
            path: new URL(request.url).pathname,
            statusCode: 401,
          });
        }
        set.status = 401;
        return { error: "Unauthorized" };
      }
    });
