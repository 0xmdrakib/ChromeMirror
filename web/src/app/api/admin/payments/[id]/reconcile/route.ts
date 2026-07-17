import { reconcilePayment } from "@/lib/payments";
import { requireApiAdmin } from "@/lib/session-api";
import { apiError } from "@/lib/utils";

export async function POST(
  request: Request,
  context: RouteContext<"/api/admin/payments/[id]/reconcile">,
) {
  try {
    await requireApiAdmin(request);
    const { id } = await context.params;
    return Response.json({ ok: true, ...(await reconcilePayment(id, { force: true })) });
  } catch (error) {
    return apiError(error);
  }
}
