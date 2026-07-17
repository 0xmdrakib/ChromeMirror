import { reconcilePayment } from "@/lib/payments";
import { requireApiUser } from "@/lib/session-api";
import { apiError } from "@/lib/utils";

export async function GET(
  request: Request,
  context: RouteContext<"/api/payments/[id]">,
) {
  try {
    const session = await requireApiUser(request);
    const { id } = await context.params;
    return Response.json({ ok: true, ...(await reconcilePayment(id, { userId: session.user.id })) });
  } catch (error) {
    return apiError(error);
  }
}
