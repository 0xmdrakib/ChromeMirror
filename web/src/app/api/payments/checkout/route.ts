import { z } from "zod";
import { createHostedInvoice } from "@/lib/payments";
import { requireApiUser } from "@/lib/session-api";
import { apiError } from "@/lib/utils";

const bodySchema = z.object({ plan: z.enum(["annual", "lifetime"]) });

export async function POST(request: Request) {
  try {
    const session = await requireApiUser(request);
    const body = bodySchema.parse(await request.json());
    return Response.json(await createHostedInvoice(session.user.id, body.plan));
  } catch (error) {
    return apiError(error);
  }
}
