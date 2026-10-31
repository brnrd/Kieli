// DynamoDB maps do not guarantee property order. Hash logical JSON consistently
// across storage round-trips and browser downloads; arrays retain their order.
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(value, (_, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}
