import type { APIRoute } from "astro";
import { handleMcp } from "../server/mcp";

export const ALL: APIRoute = ({ request }) => handleMcp(request);
