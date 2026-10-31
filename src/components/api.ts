export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    ...options,
    headers: {
      ...(options?.body ? { "Content-Type": "application/json" } : {}),
      ...options?.headers,
    },
  });
  if (response.status === 401) {
    window.location.assign("/login");
    throw new Error("Your session expired. Sign in again.");
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(
      data.error ?? "Unable to complete the request.",
      response.status,
    );
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
