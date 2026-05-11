import { Connection, Transaction, VersionedTransaction } from '@solana/web3.js';

type BrowserWallet = {
    publicKey: { toBase58: () => string };
    signTransaction: <T extends Transaction | VersionedTransaction>(transaction: T) => Promise<T>;
};

type MagicBlockPrivateTransferResponse = {
    transactionBase64: string;
    version: 'legacy' | 'v0';
    sendTo: 'base' | 'ephemeral';
    lastValidBlockHeight: number;
    provider: string;
    validator?: string;
};

export async function settleWithMagicBlockPrivatePayment(input: {
    connection: Connection;
    wallet: BrowserWallet;
    recipient: string;
    clientRefId: string;
    amount?: number;
}) {
    const response = await fetch('/api/magicblock/private-transfer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            from: input.wallet.publicKey.toBase58(),
            to: input.recipient,
            amount: input.amount ?? 1,
            clientRefId: input.clientRefId,
        }),
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(payload?.error || `MagicBlock private transfer failed: ${response.status}`);
    }

    const prepared = payload as MagicBlockPrivateTransferResponse;
    const raw = Buffer.from(prepared.transactionBase64, 'base64');
    const transaction = prepared.version === 'v0'
        ? VersionedTransaction.deserialize(raw)
        : Transaction.from(raw);
    const signed = await input.wallet.signTransaction(transaction);
    const signature = await input.connection.sendRawTransaction(signed.serialize(), {
        skipPreflight: false,
    });
    const latestBlockhash = await input.connection.getLatestBlockhash('confirmed');
    await input.connection.confirmTransaction({
        signature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: prepared.lastValidBlockHeight || latestBlockhash.lastValidBlockHeight,
    }, 'confirmed');

    return {
        signature,
        provider: prepared.provider,
        sendTo: prepared.sendTo,
        validator: prepared.validator,
    };
}
