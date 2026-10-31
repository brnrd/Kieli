import type { APIRoute } from "astro";
import { samlAuth } from "../../../server/saml";
import { sessions } from "../../../server/sessions";
import { HttpError } from "../../../server/errors";
export const POST: APIRoute = async ({ request, cookies, redirect }) => {
  try {
    const identity = await (await samlAuth()).finish(request, cookies);
    await (await sessions()).create(cookies, identity);
    return redirect("/", 303);
  } catch (error) {
    // Never log assertions, profile attributes, cookies, or IdP-provided error text.
    console.error(
      "SAML callback failed:",
      error instanceof Error ? error.name : "Unknown error",
    );
    if (error instanceof HttpError && [400, 413, 415].includes(error.status))
      return Response.json({ error: error.message }, { status: error.status });
    return redirect("/login?error=signin", 303);
  }
};
