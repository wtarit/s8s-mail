import { cookieFrom, request, type Json, type Reply } from "./index";

const ORIGIN = "http://localhost:8787";
const RP_ID = "localhost";

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
const fromB64url = (s: string) =>
  Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const u32 = (n: number) => new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const sha256 = async (data: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource));

type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;
const head = (major: number, n: number) =>
  n < 24 ? new Uint8Array([(major << 5) | n]) : new Uint8Array([(major << 5) | 24, n]);
function cbor(value: Cbor): Uint8Array {
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    return concat(head(3, bytes.length), bytes);
  }
  if (value instanceof Uint8Array) {
    const len = value.length < 24 ? head(2, value.length) : new Uint8Array([0x58, value.length]);
    return concat(len, value);
  }
  return concat(head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)]));
}

/** ECDSA P1363 (r||s) to the DER form WebAuthn assertions carry. */
function derSignature(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const body = b[i]! & 0x80 ? concat(new Uint8Array([0]), b.slice(i)) : b.slice(i);
    return concat(new Uint8Array([2, body.length]), body);
  };
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

/** A software authenticator: real WebAuthn registration and assertion responses (ES256, "none" attestation). */
export class VirtualPasskey {
  private counter = 0;
  private constructor(
    readonly credentialId: Uint8Array,
    private readonly keys: CryptoKeyPair,
  ) {}

  static async create() {
    const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    return new VirtualPasskey(crypto.getRandomValues(new Uint8Array(32)), keys);
  }

  private async clientData(type: string, challenge: string) {
    return new TextEncoder().encode(JSON.stringify({ type, challenge, origin: ORIGIN }));
  }

  /** Registers this passkey for the session; returns the verify-registration reply. */
  async register(cookie: string, name = "Virtual key"): Promise<Reply<Json>> {
    const options = await request<Json>("/api/auth/passkey/generate-register-options", { cookie });
    if (options.status !== 200) return options;
    const jwk = (await crypto.subtle.exportKey("jwk", this.keys.publicKey)) as JsonWebKey;
    const coseKey = new Map<Cbor, Cbor>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, fromB64url(jwk.x!)],
      [-3, fromB64url(jwk.y!)],
    ]);
    const authData = concat(
      await sha256(new TextEncoder().encode(RP_ID)),
      new Uint8Array([0x45]),
      u32(0),
      new Uint8Array(16),
      new Uint8Array([0, this.credentialId.length]),
      this.credentialId,
      cbor(coseKey),
    );
    const attestation = cbor(
      new Map<Cbor, Cbor>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );
    const id = b64url(this.credentialId);
    return request("/api/auth/passkey/verify-registration", {
      cookie: [cookie, cookieFrom(options.headers)].filter(Boolean).join("; "),
      json: {
        name,
        response: {
          id,
          rawId: id,
          type: "public-key",
          clientExtensionResults: {},
          response: {
            clientDataJSON: b64url(
              await this.clientData("webauthn.create", options.body.challenge),
            ),
            attestationObject: b64url(attestation),
            transports: ["internal"],
          },
        },
      },
    });
  }

  /**
   * A WebAuthn sign-in (or step-up when `cookie` holds a session). `cookie` is sent with both
   * calls, e.g. a session or pending-sign-in cookie.
   */
  async authenticate(cookie = "", extra: Record<string, unknown> = {}): Promise<Reply<Json>> {
    const options = await request<Json>("/api/auth/passkey/generate-authenticate-options", {
      cookie: cookie || undefined,
    });
    const authData = concat(
      await sha256(new TextEncoder().encode(RP_ID)),
      new Uint8Array([0x05]),
      u32(++this.counter),
    );
    const clientData = await this.clientData("webauthn.get", options.body.challenge);
    const signed = concat(authData, await sha256(clientData));
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        this.keys.privateKey,
        signed as BufferSource,
      ),
    );
    const id = b64url(this.credentialId);
    return request("/api/auth/passkey/verify-authentication", {
      cookie: [cookie, cookieFrom(options.headers)].filter(Boolean).join("; "),
      json: {
        ...extra,
        response: {
          id,
          rawId: id,
          type: "public-key",
          clientExtensionResults: {},
          response: {
            authenticatorData: b64url(authData),
            clientDataJSON: b64url(clientData),
            signature: b64url(derSignature(signature)),
          },
        },
      },
    });
  }
}
