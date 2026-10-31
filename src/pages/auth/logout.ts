import type { APIRoute } from "astro";
import { logout } from "../../server/auth";
export const POST: APIRoute = async ({ cookies, redirect }) => {
  await logout(cookies);
  return redirect("/login");
};
