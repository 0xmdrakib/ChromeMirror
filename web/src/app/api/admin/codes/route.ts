import { z } from "zod";
import { generateRedeemCodes } from "@/lib/redemption";
import { requireApiAdmin } from "@/lib/session-api";
import { apiError } from "@/lib/utils";

const bodySchema = z.object({
  plan: z.enum(["annual", "lifetime"]),
  count: z.number().int().min(1).max(100),
  expires_at: z.string().datetime().nullable().optional(),
});

export async function POST(request: Request) {
  try {
    const session = await requireApiAdmin(request);
    const body = bodySchema.parse(await request.json());
    const codes = await generateRedeemCodes({
      plan: body.plan,
      count: body.count,
      createdBy: session.user.id,
      expiresAt: body.expires_at ? new Date(body.expires_at) : null,
    });
    return Response.json({ ok: true, codes });
  } catch (error) {
    return apiError(error);
  }
}
