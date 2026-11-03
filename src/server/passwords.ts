import { hash, verify, type Options } from "@node-rs/argon2";
import { ZxcvbnFactory } from "@zxcvbn-ts/core";
import * as common from "@zxcvbn-ts/language-common";
import { HttpError } from "./errors";

const strength = new ZxcvbnFactory({
  dictionary: common.dictionary,
  graphs: common.adjacencyGraphs,
});
// Algorithm value 2 is Argon2id. Avoid the package's ambient const enum with isolated module compilation.
const options: Options = {
  algorithm: 2,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
};
const normalize = (password: string) => password.normalize("NFC");
export async function hashPassword(password: string, context: string[] = []) {
  const text = normalize(password);
  const length = Array.from(text).length;
  if (length < 15 || length > 128)
    throw new HttpError(
      400,
      "Use a password between 15 and 128 characters. A unique passphrase works well.",
    );
  if (strength.check(text, ["kieli", ...context]).score < 3)
    throw new HttpError(
      400,
      "Choose a less predictable password. Try several unrelated words or a password manager.",
    );
  return hash(text, options);
}
export async function verifyPassword(encoded: string, password: string) {
  if (Array.from(password).length > 128) return false;
  try {
    return await verify(encoded, normalize(password));
  } catch {
    return false;
  }
}
// Unknown, invited, and disabled accounts do equivalent password work.
let dummy: Promise<string> | undefined;
export function dummyPasswordHash() {
  return (dummy ??= hash(
    "Internal timing comparison only; never a login credential.",
    options,
  ));
}
