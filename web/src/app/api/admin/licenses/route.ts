import { z } from "zod";
import { db } from "@/db";
import { grantPlan } from "@/lib/license-service";
import { requireApiAdmin } from "@/lib/session-api";
import { apiError } from "@/lib/utils";

const bodySchema = z.object({
  user_id: z.string().min(1),
  plan: z.enum(["annual", "lifetime"]),
});

export async function POST(request: Request) {
  try {
    const session = await requireApiAdmin(request);
    const body = bodySchema.parse(await request.json());
    const result = await db.transaction((tx) =>
      grantPlan(tx, {
        userId: body.user_id,
        plan: body.plan,
        source: "admin",
        actor: `admin:${session.user.email.toLowerCase()}`,
      }),
    );
    return Response.json({
      ok: true,
      license_id: result.license.id,
      generated_key: result.createdKey,
    });
  } catch (error) {
    return apiError(error);
  }
}
