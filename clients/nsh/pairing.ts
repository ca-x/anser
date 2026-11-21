import { t } from "nsh/i18n";
import { ApiError, validateOrigin } from "./api";

export type Pairing = { origin: string; code?: string };

export function parsePairing(value: string): Pairing {
  let url: URL;
  try {
    if (value.length > 4096) throw new Error("length");
    url = new URL(value.trim());
  } catch {
    throw new ApiError("invalid_qr", t("pairing.this_link_could_not_be_read"));
  }
  if (
    url.protocol !== "anser:" ||
    url.hostname !== "connect" ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.searchParams.getAll("server").length !== 1 ||
    url.searchParams.getAll("code").length > 1
  ) {
    throw new ApiError("invalid_qr", t("pairing.this_is_not_a_valid_anser"));
  }
  const origin = validateOrigin(url.searchParams.get("server") ?? "");
  const code = url.searchParams.get("code") || undefined;
  if (
    code &&
    (!origin.startsWith("https:") || !/^[A-Za-z0-9_-]{43}$/.test(code))
  ) {
    throw new ApiError(
      "invalid_qr",
      t("pairing.the_pairing_code_is_invalid_or"),
    );
  }
  return { origin, code };
}
