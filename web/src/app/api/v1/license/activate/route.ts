import { z } from "zod";
import { activateLicense } from "@/lib/license-service";
import { apiError } from "@/lib/utils";

const bodySchema = z.object({
  license_key: z.string().min(8).max(128),
  device_id: z.string().min(8).max(256),
  machine_info: z.record(z.string(), z.unknown()).optional(),
  app_version: z.string().max(64).optional(),
});

export async function POST(request: Request) {
  try {
    const body = bodySchema.parse(await request.json());
    const result = await activateLicense({
      licenseKey: body.license_key,
      deviceId: body.device_id,
      machineInfo: body.machine_info,
      appVersion: body.app_version,
    });
    return Response.json({ ok: true, ...result });
  } catch (error) {
    return apiError(error);
  }
}
