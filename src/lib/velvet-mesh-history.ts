export type VelvetMeshIntentHistoryItem = {
    address: string;
    signature: string | null;
    quotes: Array<{
        address: string;
        signature: string | null;
        maker: string;
        route: string;
        quoteCommitment: number[];
        createdAt: number;
        expiresAt: number;
        accepted: boolean;
    }>;
    nonce: string;
    inputSymbol: string;
    outputSymbol: string;
    status: string;
    computeProvider: string;
    minQuoteCount: number;
    quoteCount: number;
    selectedQuote: string | null;
    acceptedMatch: string | null;
    settlementReady: boolean;
    arciumComputation: number[];
    createdAt: number;
    expiresAt: number;
};

export type VelvetMeshIntentHistory = {
    owner: string;
    intents: VelvetMeshIntentHistoryItem[];
    lastUpdatedAt: number;
};

export async function fetchVelvetMeshIntentHistory(owner: string): Promise<VelvetMeshIntentHistory> {
    const response = await fetch(`/api/velvetmesh/intents?owner=${owner}`, {
        cache: 'no-store',
    });
    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(body?.error || `VelvetMesh intent history failed: ${response.status}`);
    }

    return body as VelvetMeshIntentHistory;
}
