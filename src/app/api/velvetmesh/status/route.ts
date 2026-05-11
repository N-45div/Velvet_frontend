import { NextResponse } from 'next/server';
import { Connection } from '@solana/web3.js';
import {
    DEVNET_WSOL_MINT,
    MAGICBLOCK_ER_DEVNET_RPC_URL,
    MAGICBLOCK_ROUTER_DEVNET_RPC_URL,
    UMBRA_DEVNET_RELAYER_INFO_URL,
    VELVET_MESH_PROGRAM_ID,
} from '@/lib/solana/constants';
import { getDevnetRpcUrl } from '@/lib/solana/rpc';

export const dynamic = 'force-dynamic';

const ACCOUNT_DISCRIMINATORS = {
    acceptedMatch: [20, 92, 254, 60, 113, 66, 37, 14],
    intent: [247, 162, 35, 165, 254, 111, 129, 109],
    protectedSettlement: [162, 155, 35, 7, 227, 1, 47, 65],
};

type UmbraRelayerInfo = {
    supported_mints?: string[];
};

async function countVelvetMeshAccounts(connection: Connection) {
    const accounts = await connection.getProgramAccounts(VELVET_MESH_PROGRAM_ID, {
        commitment: 'confirmed',
        dataSlice: {
            offset: 0,
            length: 8,
        },
    });

    const counts = {
        intentCount: 0,
        acceptedMatchCount: 0,
        settlementRouteCount: 0,
    };

    for (const { account } of accounts) {
        const data = account.data;
        if (matchesDiscriminator(data, ACCOUNT_DISCRIMINATORS.intent)) {
            counts.intentCount += 1;
        } else if (matchesDiscriminator(data, ACCOUNT_DISCRIMINATORS.acceptedMatch)) {
            counts.acceptedMatchCount += 1;
        } else if (matchesDiscriminator(data, ACCOUNT_DISCRIMINATORS.protectedSettlement)) {
            counts.settlementRouteCount += 1;
        }
    }

    return counts;
}

function matchesDiscriminator(data: Buffer, discriminator: number[]) {
    return discriminator.every((byte, index) => data[index] === byte);
}

async function fetchUmbraSupport() {
    const response = await fetch(UMBRA_DEVNET_RELAYER_INFO_URL, {
        cache: 'no-store',
    });

    if (!response.ok) {
        throw new Error(`Umbra relayer status failed: ${response.status}`);
    }

    const info = (await response.json()) as UmbraRelayerInfo;
    const supportedMints = info.supported_mints ?? [];

    return {
        umbraWsolSupported: supportedMints.includes(DEVNET_WSOL_MINT.toBase58()),
        umbraSupportedMintCount: supportedMints.length,
    };
}

async function fetchMagicBlockStatus() {
    const router = new Connection(MAGICBLOCK_ROUTER_DEVNET_RPC_URL, 'confirmed');
    const er = new Connection(MAGICBLOCK_ER_DEVNET_RPC_URL, 'confirmed');
    const [routerBlockhash, erHealth, erVersion, erSlot] = await Promise.all([
        router.getLatestBlockhash('confirmed'),
        fetchRpc(MAGICBLOCK_ER_DEVNET_RPC_URL, 'getHealth'),
        er.getVersion(),
        er.getSlot('confirmed'),
    ]);

    return {
        magicBlockRouterReady: Boolean(routerBlockhash.blockhash),
        magicBlockRouterSlot: routerBlockhash.lastValidBlockHeight,
        magicBlockErHealthy: erHealth === 'ok',
        magicBlockErSlot: erSlot,
        magicBlockCoreVersion: String((erVersion as Record<string, unknown>)['magicblock-core'] ?? 'unknown'),
    };
}

async function fetchRpc(url: string, method: string) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }),
        cache: 'no-store',
    });
    const body = await response.json();
    if (body.error) {
        throw new Error(body.error.message || `${method} failed`);
    }
    return body.result;
}

const FALLBACK_UMBRA_STATUS = {
    umbraWsolSupported: false,
    umbraSupportedMintCount: 0,
    umbraRelayerReady: false,
};

const FALLBACK_MAGICBLOCK_STATUS = {
    magicBlockRouterReady: false,
    magicBlockRouterSlot: null,
    magicBlockErHealthy: false,
    magicBlockErSlot: null,
    magicBlockCoreVersion: null,
};

export async function GET() {
    const connection = new Connection(getDevnetRpcUrl(), 'confirmed');

    const [counts, umbra, magicBlock] = await Promise.all([
        countVelvetMeshAccounts(connection),
        fetchUmbraSupport().then((status) => ({ ...status, umbraRelayerReady: true })).catch(() => FALLBACK_UMBRA_STATUS),
        fetchMagicBlockStatus().catch(() => FALLBACK_MAGICBLOCK_STATUS),
    ]);

    return NextResponse.json({
        programId: VELVET_MESH_PROGRAM_ID.toBase58(),
        ...counts,
        ...umbra,
        ...magicBlock,
        lastUpdatedAt: Date.now(),
    });
}
