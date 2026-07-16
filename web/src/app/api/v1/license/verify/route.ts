import { z } from "zod";
import { renewDesktopSession } from "@/lib/license-service";
import { apiError } from "@/lib/utils";

const bodySchema = z.object({
  token: z.string().min(20),
  app_version: z.string().max(64).optional(),
});

export async function POST(request: Request) {
  try {
    const body = bodySchema.parse(await request.json());
    const result = await renewDesktopSession(body.token, body.app_version);
    return Response.json({ valid: true, ...result });
  } catch (error) {
    return apiError(error);
  }
}
