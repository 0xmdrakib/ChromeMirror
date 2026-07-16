import { verifyNowPaymentsSignature } from "@/lib/crypto";
import { processPaymentUpdate } from "@/lib/payments";
import { ApiError, apiError } from "@/lib/utils";

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as Record<string, unknown>;
    if (!verifyNowPaymentsSignature(payload, request.headers.get("x-nowpayments-sig"))) {
      throw new ApiError("INVALID_SIGNATURE", "Payment signature is invalid.", 401);
    }
    const result = await processPaymentUpdate(payload);
    return Response.json({ ok: true, ...result });
  } catch (error) {
    return apiError(error);
  }
}
