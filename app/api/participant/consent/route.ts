// @ts-expect-error TS5097: native TypeScript tests require the extension.
import { participantService } from "../../../participant-service.ts";

export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> { return participantService(request, "consent" ); }
export async function POST(request: Request): Promise<Response> { return participantService(request, "consent" ); }
