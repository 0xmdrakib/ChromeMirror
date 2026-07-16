import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { forceReleaseLicense } from "@/lib/license-service";
import { requireApiUser } from "@/lib/session-api";
import { ApiError, apiError } from "@/lib/utils";

export async function POST(request: Request) {
  try {
    const session = await requireApiUser(request);
    const [license] = await db
      .select({ id: schema.licenses.id })
      .from(schema.licenses)
      .where(eq(schema.licenses.userId, session.user.id))
      .limit(1);
    if (!license) throw new ApiError("NOT_FOUND", "No license is assigned.", 404);
    await forceReleaseLicense(license.id, `user:${session.user.id}`, session.user.id);
    return Response.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
