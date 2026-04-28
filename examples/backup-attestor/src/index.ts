declare const process: {
  env: Record<string, string | undefined>;
};

export {};

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${canonicalStringify(val)}`).join(",")}}`;
}

async function signPayload(timestamp: string, payload: Record<string, unknown>, secret: string) {
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
    new TextEncoder().encode(`${timestamp}.${canonicalStringify(payload)}`)
  );
  return Array.from(new Uint8Array(signature)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const apiBaseUrl = process.env.OPERATORBOARD_API_URL ?? "http://127.0.0.1:4100";
const apiKey = process.env.OPERATORBOARD_API_KEY;
const provider = process.env.OPERATORBOARD_BACKUP_PROVIDER ?? "aws_rds";
const secret = process.env.OPERATORBOARD_BACKUP_PROVIDER_SECRET;

if (!secret) {
  throw new Error("OPERATORBOARD_BACKUP_PROVIDER_SECRET is required");
}

const system = process.env.OPERATORBOARD_BACKUP_SYSTEM ?? "aws-rds-prod";
const scope = process.env.OPERATORBOARD_BACKUP_SCOPE ?? "primary";
const reference = process.env.OPERATORBOARD_BACKUP_REFERENCE ?? `snapshot_${new Date().toISOString()}`;
const verifiedAt = process.env.OPERATORBOARD_BACKUP_VERIFIED_AT ?? new Date().toISOString();

const payload = {
  system,
  scope,
  reference,
  verifiedAt,
  source: "integration" as const,
  metadata: {}
};
const timestamp = String(Date.now());
const signature = await signPayload(timestamp, payload, secret);

const response = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/backup-attestations/integrations/${provider}`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...(apiKey ? { "x-operatorboard-key": apiKey } : {}),
    "x-operatorboard-timestamp": timestamp,
    "x-operatorboard-signature": signature
  },
  body: JSON.stringify(payload)
});

if (!response.ok) {
  const body = await response.text();
  throw new Error(`Attestation failed: ${response.status} ${body}`);
}

console.log(await response.text());
