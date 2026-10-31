import type { APIRoute } from "astro";
import { getStore } from "../../server/store";
import { handleScim } from "../../server/scim";
export const ALL: APIRoute = async ({ request }) =>
  handleScim(request, await getStore());
