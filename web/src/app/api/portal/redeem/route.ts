import { z } from "zod";
import { redeemCode } from "@/lib/redemption";
import { requireApiUser } from "@/lib/session-api";
import { apiError } from "@/lib/utils";

const bodySchema = z.object({ code: z.string().min(8).max(128) });

export async function POST(request: Request) {
  try {
    const session = await requireApiUser(request);
    const body = bodySchema.parse(await request.json());
    const license = await redeemCode(session.user.id, body.code);
    return Response.json({
      ok: true,
      plan: license.plan,
      expires_at: license.expiresAt?.toISOString() ?? null,
    });
  } catch (error) {
    return apiError(error);
  }
}
