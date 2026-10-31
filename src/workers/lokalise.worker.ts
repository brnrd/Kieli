import { parseLokalise } from "../lokalise";
import { parseTranslationFiles } from "../formats/import";
self.onmessage = (
  event: MessageEvent<{
    bytes: ArrayBuffer;
    filename: string;
    platform: string;
    kind?: "files" | "lokalise";
    language?: string;
  }>,
) => {
  try {
    self.postMessage({
      preview:
        event.data.kind === "files"
          ? parseTranslationFiles(
              new Uint8Array(event.data.bytes),
              event.data.filename,
              event.data.language,
            )
          : parseLokalise(
              new Uint8Array(event.data.bytes),
              event.data.filename,
              event.data.platform,
            ),
    });
  } catch (error) {
    self.postMessage({ error: (error as Error).message });
  }
};
