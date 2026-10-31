import type { APIRoute } from "astro";
import { finishLogin } from "../../server/auth";
export const GET: APIRoute = async ({ cookies, request, redirect }) => {
  try {
    await finishLogin(request, cookies);
    return redirect("/");
  } catch (error) {
    console.error(
      "Okta callback failed:",
      error instanceof Error ? error.name : "Unknown error",
    );
    return redirect("/login?error=signin");
  }
};
