export type BackupAttestationCreate = {
    system: string;
    scope: string;
    reference: string;
    verifiedAt: string;
    source: "manual" | "integration";
    metadata: Record<string, unknown>;
};
export declare function canonicalStringify(value: unknown): string;
export declare function signBackupAttestation(timestamp: string, payload: BackupAttestationCreate, secret: string): Promise<string>;
export declare function createSignedAttestationRequest(payload: BackupAttestationCreate, secret: string): Promise<{
    payload: BackupAttestationCreate;
    headers: Record<string, string>;
}>;
export declare function postSignedAttestation(input: {
    apiBaseUrl: string;
    provider: string;
    apiKey?: string;
    secret: string;
    payload: BackupAttestationCreate;
}): Promise<Response>;
