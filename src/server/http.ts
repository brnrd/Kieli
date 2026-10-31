import { HttpError } from "./errors";
export async function readBody(request: Request, limit = 262144) {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > limit)
    throw new HttpError(413, "Request is too large.");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "A request body is required.");
  let length = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new HttpError(413, "Request is too large.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
export async function readJSON(request: Request, limit = 262144) {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new HttpError(415, "Send an application/json body.");
  const body = await readBody(request, limit);
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "Invalid JSON.");
  }
}
