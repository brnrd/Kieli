import type { APIRoute } from "astro";
import { config } from "../../../server/config";
import { samlAuth } from "../../../server/saml";
export const GET: APIRoute = async () => {
  if (config().authMode !== "saml")
    return new Response("Not found", { status: 404 });
  return new Response((await samlAuth()).metadata(), {
    headers: { "Content-Type": "application/samlmetadata+xml; charset=utf-8" },
  });
};
