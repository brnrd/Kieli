import type { APIRoute } from "astro";
import { samlLogout } from "../../../server/saml-logout";
import { sessions } from "../../../server/sessions";
import { HttpError } from "../../../server/errors";
const receive: APIRoute = async ({ request, cookies, redirect }) => {
  try {
    const result = await (await samlLogout()).receive(request, cookies);
    // Clear a supplied browser cookie only if its session was actually revoked.
    await (await sessions()).resolve(cookies);
    return redirect(result.location, 303);
  } catch (error) {
    // Never reflect or log provider messages, NameIDs, RelayState or assertions.
    if (error instanceof HttpError && error.status === 404)
      return Response.json({ error: error.message }, { status: 404 });
    return redirect("/login?logout=incomplete", 303);
  }
};
export const GET = receive;
export const POST = receive;
