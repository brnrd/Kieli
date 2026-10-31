import type { APIRoute } from "astro";
import { ProjectHistory } from "../../../server/project-history";
import { getStore } from "../../../server/store";
import { HttpError } from "../../../server/errors";
export const GET: APIRoute = async ({ request, params, url }) => {
  try {
    const token =
      /^Bearer ([A-Za-z0-9_.-]{20,200})$/.exec(
        request.headers.get("authorization") ?? "",
      )?.[1] ?? "";
    return await new ProjectHistory(await getStore()).deliver(
      params.project ?? "",
      params.locale ?? "",
      url.searchParams.get("channel") ?? "production",
      token,
      request.headers.get("if-none-match"),
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof HttpError
            ? error.message
            : "Unable to deliver translations.",
      },
      {
        status:
          error instanceof HttpError
            ? error.status
            : error instanceof RangeError
              ? 400
              : 500,
      },
    );
  }
};
