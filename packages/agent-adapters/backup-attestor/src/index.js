export function canonicalStringify(value) {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map((item) => canonicalStringify(item)).join(",")}]`;
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${canonicalStringify(val)}`).join(",")}}`;
}
export async function signBackupAttestation(timestamp, payload, secret) {
    const canonicalPayload = canonicalStringify({
        system: payload.system,
        scope: payload.scope,
        reference: payload.reference,
        verifiedAt: payload.verifiedAt,
        source: "integration",
        metadata: payload.metadata
    });
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${canonicalPayload}`));
    return Array.from(new Uint8Array(signature)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function createSignedAttestationRequest(payload, secret) {
    if (!payload.system || !payload.scope || !payload.reference || !payload.verifiedAt) {
        throw new Error("system, scope, reference, and verifiedAt are required");
    }
    const normalized = { ...payload, source: "integration" };
    const timestamp = String(Date.now());
    const signature = await signBackupAttestation(timestamp, normalized, secret);
    const headers = {
        "content-type": "application/json",
        "x-operatorboard-timestamp": timestamp,
        "x-operatorboard-signature": signature
    };
    return {
        payload: normalized,
        headers
    };
}
export async function postSignedAttestation(input) {
    const { payload, headers } = await createSignedAttestationRequest(input.payload, input.secret);
    if (input.apiKey)
        headers["x-operatorboard-key"] = input.apiKey;
    return fetch(`${input.apiBaseUrl.replace(/\/$/, "")}/backup-attestations/integrations/${input.provider}`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
    });
}
