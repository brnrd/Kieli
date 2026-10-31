import type { APIRoute } from "astro";
import { runSnapshotJob } from "../../server/maintenance";
import { HttpError } from "../../server/errors";
export const POST: APIRoute = async ({ request }) => {
  try {
    return Response.json(await runSnapshotJob(request));
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof HttpError ? error.message : "Snapshot job failed.",
      },
      { status: error instanceof HttpError ? error.status : 500 },
    );
  }
};
