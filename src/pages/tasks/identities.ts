import type { APIRoute } from "astro";
import { runIdentityJob } from "../../server/maintenance";
import { HttpError } from "../../server/errors";
export const POST: APIRoute = async ({ request }) => {
  try {
    return Response.json(await runIdentityJob(request));
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof HttpError
            ? error.message
            : "Identity reconciliation failed.",
      },
      { status: error instanceof HttpError ? error.status : 500 },
    );
  }
};
