import { z } from "zod";
import { createEmbeddedPayment } from "@/lib/payments";
import { requireApiUser } from "@/lib/session-api";
import { apiError } from "@/lib/utils";

const bodySchema = z.object({
  plan: z.enum(["annual", "lifetime"]),
  payCurrency: z.string().trim().toLowerCase().regex(/^(usdt|usdc)/),
});

export async function POST(request: Request) {
  try {
    const session = await requireApiUser(request);
    const body = bodySchema.parse(await request.json());
    return Response.json({
      payment: await createEmbeddedPayment(session.user.id, body.plan, body.payCurrency),
    });
  } catch (error) {
    return apiError(error);
  }
}
