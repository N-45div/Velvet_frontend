import { clusterApiUrl } from '@solana/web3.js';

export function getDevnetRpcUrl() {
    return process.env.NEXT_PUBLIC_HELIUS_RPC_URL
        || process.env.NEXT_PUBLIC_SOLANA_RPC_URL
        || process.env.SOLANA_RPC_URL
        || clusterApiUrl('devnet');
}
