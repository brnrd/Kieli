import type { APIRoute } from "astro";
import { handleSync } from "../../server/sync";
export const ALL: APIRoute = ({ request }) => handleSync(request);
