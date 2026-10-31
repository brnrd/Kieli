import type { APIRoute } from "astro";
import { config } from "../../server/config";
import { sessions } from "../../server/sessions";
import { samlLogout } from "../../server/saml-logout";
export const POST: APIRoute = async ({ cookies, redirect, url }) => {
  const session = await (await sessions()).endForSamlLogout(cookies);
  // The local session is gone before reading provider configuration or calling SLO.
  if (url.searchParams.get("saml") === "1" && config().authMode === "saml") {
    try {
      return redirect(await (await samlLogout()).begin(session, cookies), 303);
    } catch {
      return redirect("/login?logout=incomplete", 303);
    }
  }
  return redirect("/login");
};
