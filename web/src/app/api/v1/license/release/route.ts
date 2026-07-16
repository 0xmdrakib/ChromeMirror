import { z } from "zod";
import { releaseDesktopSession } from "@/lib/license-service";
import { apiError } from "@/lib/utils";

const bodySchema = z.object({ token: z.string().min(20) });

export async function POST(request: Request) {
  try {
    const body = bodySchema.parse(await request.json());
    const released = await releaseDesktopSession(body.token);
    return Response.json({ ok: true, released });
  } catch (error) {
    return apiError(error);
  }
}
