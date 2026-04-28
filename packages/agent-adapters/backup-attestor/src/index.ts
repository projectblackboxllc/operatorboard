export type BackupAttestationCreate = {
  system: string;
  scope: string;
  reference: string;
  verifiedAt: string;
  source: "manual" | "integration";
  metadata: Record<string, unknown>;
};

export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${canonicalStringify(val)}`).join(",")}}`;
}

// provider is bound into the canonical string so a signed request cannot be replayed
// across provider endpoints even when two providers share a secret.
export async function signBackupAttestation(provider: string, timestamp: string, payload: BackupAttestationCreate, secret: string): Promise<string> {
  const canonicalPayload = canonicalStringify({
    system: payload.system,
    scope: payload.scope,
    reference: payload.reference,
    verifiedAt: payload.verifiedAt,
    source: "integration",
    metadata: payload.metadata
  });
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${provider}.${timestamp}.${canonicalPayload}`)
  );
  return Array.from(new Uint8Array(signature)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createSignedAttestationRequest(payload: BackupAttestationCreate, provider: string, secret: string) {
  if (!payload.system || !payload.scope || !payload.reference || !payload.verifiedAt) {
    throw new Error("system, scope, reference, and verifiedAt are required");
  }
  const normalized: BackupAttestationCreate = { ...payload, source: "integration" };
  const timestamp = String(Date.now());
  const signature = await signBackupAttestation(provider, timestamp, normalized, secret);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-operatorboard-timestamp": timestamp,
    "x-operatorboard-signature": signature
  };
  return {
    payload: normalized,
    headers
  };
}

export async function postSignedAttestation(input: {
  apiBaseUrl: string;
  provider: string;
  apiKey?: string;
  secret: string;
  payload: BackupAttestationCreate;
}): Promise<Response> {
  const { payload, headers } = await createSignedAttestationRequest(input.payload, input.provider, input.secret);
  if (input.apiKey) headers["x-operatorboard-key"] = input.apiKey;
  return fetch(`${input.apiBaseUrl.replace(/\/$/, "")}/backup-attestations/integrations/${input.provider}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });
}
