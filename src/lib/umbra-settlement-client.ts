export type UmbraSettlementResult = {
    provider: string;
    signer: string;
    destination: string;
    mint: string;
    amountBaseUnits: string;
    wrapSignature?: string | null;
    wrappedSolTokenAccount?: string;
    registrationSignatures: string[];
    queueSignature: string;
    callbackStatus: string | null;
    callbackSignature: string | null;
    encryptedBalance?: {
        state: string;
        balance?: string;
    };
};

export async function shieldSettlementWithUmbra(input: {
    destination?: string;
    intent: string;
    amountBaseUnits?: string | number;
}) {
    const response = await fetch('/api/umbra/settlement', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            action: 'shield',
            destination: input.destination,
            intent: input.intent,
            amountBaseUnits: input.amountBaseUnits ?? 1,
        }),
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(payload?.error || `Umbra settlement failed: ${response.status}`);
    }

    return payload as UmbraSettlementResult;
}
