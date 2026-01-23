import type { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';

export interface WalletSigner {
    publicKey: PublicKey;
    signTransaction: (transaction: Transaction | VersionedTransaction) => Promise<Transaction | VersionedTransaction>;
    signAllTransactions?: (transactions: (Transaction | VersionedTransaction)[]) => Promise<(Transaction | VersionedTransaction)[]>;
    signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
}
