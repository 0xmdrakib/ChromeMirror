import { revealPortalLicenseKey } from "@/lib/license-service";
import { requireApiUser } from "@/lib/session-api";
import { apiError } from "@/lib/utils";

export async function GET(request: Request) {
  try {
    const session = await requireApiUser(request);
    return Response.json({ key: await revealPortalLicenseKey(session.user.id) });
  } catch (error) {
    return apiError(error);
  }
}
