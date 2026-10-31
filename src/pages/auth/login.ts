import type { APIRoute } from "astro";
import { beginLogin } from "../../server/auth";
import { config } from "../../server/config";
import { samlAuth } from "../../server/saml";
export const GET: APIRoute = async ({ cookies, redirect }) =>
  redirect(
    config().authMode === "okta"
      ? await beginLogin(cookies)
      : config().authMode === "saml"
        ? await (await samlAuth()).begin(cookies)
        : config().authMode === "demo"
          ? "/"
          : "/login",
  );
