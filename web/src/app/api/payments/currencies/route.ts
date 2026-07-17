import { getStablecoinOptions } from "@/lib/payments";
import { requireApiUser } from "@/lib/session-api";
import { apiError } from "@/lib/utils";

export async function GET(request: Request) {
  try {
    await requireApiUser(request);
    return Response.json({ currencies: await getStablecoinOptions() });
  } catch (error) {
    return apiError(error);
  }
}
