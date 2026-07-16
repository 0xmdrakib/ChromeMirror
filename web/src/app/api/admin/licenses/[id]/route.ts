import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { forceReleaseLicense, grantPlan } from "@/lib/license-service";
import { requireApiAdmin } from "@/lib/session-api";
import { ApiError, apiError } from "@/lib/utils";

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("suspend") }),
  z.object({ action: z.literal("cancel") }),
  z.object({ action: z.literal("activate") }),
  z.object({ action: z.literal("upgrade_lifetime") }),
  z.object({ action: z.literal("extend"), days: z.number().int().min(1).max(3650) }),
  z.object({ action: z.literal("release_device") }),
]);

export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/licenses/[id]">,
) {
  try {
    const session = await requireApiAdmin(request);
    const { id } = await context.params;
    const body = bodySchema.parse(await request.json());
    const actor = `admin:${session.user.email.toLowerCase()}`;
    const [license] = await db
      .select()
      .from(schema.licenses)
      .where(eq(schema.licenses.id, id))
      .limit(1);
    if (!license) throw new ApiError("NOT_FOUND", "License was not found.", 404);

    if (body.action === "release_device") {
      await forceReleaseLicense(id, actor, license.userId);
      return Response.json({ ok: true });
    }
    if (body.action === "upgrade_lifetime") {
      await db.transaction((tx) =>
        grantPlan(tx, {
          userId: license.userId,
          plan: "lifetime",
          source: "admin",
          actor,
        }),
      );
      return Response.json({ ok: true });
    }

    await db.transaction(async (tx) => {
      await tx.execute(sql`select id from licenses where id = ${id} for update`);
      const now = new Date();
      if (body.action === "extend") {
        const base = license.expiresAt && license.expiresAt > now ? license.expiresAt : now;
        await tx
          .update(schema.licenses)
          .set({
            plan: license.plan === "lifetime" ? "lifetime" : "annual",
            expiresAt:
              license.plan === "lifetime"
                ? null
                : new Date(base.getTime() + body.days * 24 * 60 * 60 * 1000),
            status: license.status === "suspended" ? "suspended" : "active",
            updatedAt: now,
          })
          .where(eq(schema.licenses.id, id));
      } else {
        const status =
          body.action === "suspend"
            ? "suspended"
            : body.action === "cancel"
              ? "cancelled"
              : "active";
        await tx
          .update(schema.licenses)
          .set({
            status,
            tokenVersion:
              status === "active"
                ? schema.licenses.tokenVersion
                : sql`${schema.licenses.tokenVersion} + 1`,
            updatedAt: now,
          })
          .where(eq(schema.licenses.id, id));
        if (status !== "active") {
          await tx.delete(schema.deviceLeases).where(eq(schema.deviceLeases.licenseId, id));
        }
      }
      await tx.insert(schema.licenseEvents).values({
        licenseId: id,
        userId: license.userId,
        event: `license.${body.action}`,
        actor,
        detail: body.action === "extend" ? { days: body.days } : null,
      });
    });
    return Response.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
