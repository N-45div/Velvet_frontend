import { Connection, PublicKey } from '@solana/web3.js';
import { NextResponse } from 'next/server';
import {
    DEVNET_TEST_USDC_MINT,
    DEVNET_WSOL_MINT,
    VELVET_MESH_PROGRAM_ID,
} from '@/lib/solana/constants';
import { getDevnetRpcUrl } from '@/lib/solana/rpc';

export const dynamic = 'force-dynamic';

const INTENT_DISCRIMINATOR = Buffer.from([247, 162, 35, 165, 254, 111, 129, 109]);
const QUOTE_DISCRIMINATOR = Buffer.from([167, 202, 20, 198, 228, 66, 105, 208]);
const STATUS_LABELS = ['Open', 'Computation Requested', 'Match Ready', 'Accepted', 'Cancelled', 'Expired'];
const COMPUTE_PROVIDER_LABELS = ['None', 'Arcium', 'Encrypt'];

function tokenSymbol(mint: PublicKey) {
    const value = mint.toBase58();
    if (value === DEVNET_WSOL_MINT.toBase58()) return 'SOL';
    if (value === DEVNET_TEST_USDC_MINT.toBase58()) return 'USDC';
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

async function latestSignature(connection: Connection, address: PublicKey) {
    const signatures = await connection.getSignaturesForAddress(address, { limit: 1 }, 'confirmed');
    return signatures[0]?.signature ?? null;
}

function readPublicKey(data: Buffer, offset: number) {
    return new PublicKey(data.subarray(offset, offset + 32));
}

function decodeIntent(data: Buffer) {
    const offsets = data.length >= 454
        ? {
            allowedRoutes: 240,
            computeProvider: 241,
            matchVerifier: 242,
            settlementVerifier: 274,
            status: 306,
            minQuoteCount: 307,
            quoteCount: 308,
            selectedQuote: 309,
            acceptedMatch: 341,
            createdAt: 437,
            expiresAt: 445,
        }
        : {
            allowedRoutes: 208,
            computeProvider: 209,
            matchVerifier: 210,
            settlementVerifier: 242,
            status: 274,
            minQuoteCount: 275,
            quoteCount: 276,
            selectedQuote: 277,
            acceptedMatch: 309,
            createdAt: 405,
            expiresAt: 413,
        };
    const inputMint = readPublicKey(data, 48);
    const outputMint = readPublicKey(data, 80);
    const computeProviderIndex = data[offsets.computeProvider] ?? 255;
    const statusIndex = data[offsets.status] ?? 255;
    const selectedQuote = readPublicKey(data, offsets.selectedQuote).toBase58();
    const acceptedMatch = readPublicKey(data, offsets.acceptedMatch).toBase58();
    const defaultKey = PublicKey.default.toBase58();

    return {
        nonce: data.readBigUInt64LE(40).toString(),
        inputSymbol: tokenSymbol(inputMint),
        outputSymbol: tokenSymbol(outputMint),
        status: STATUS_LABELS[statusIndex] ?? 'Unknown',
        computeProvider: COMPUTE_PROVIDER_LABELS[computeProviderIndex] ?? 'Unknown',
        minQuoteCount: data[offsets.minQuoteCount] ?? 0,
        quoteCount: data[offsets.quoteCount] ?? 0,
        selectedQuote: selectedQuote === defaultKey ? null : selectedQuote,
        acceptedMatch: acceptedMatch === defaultKey ? null : acceptedMatch,
        settlementReady: acceptedMatch !== defaultKey,
        arciumComputation: Array.from(data.subarray(offsets.acceptedMatch + 32, offsets.acceptedMatch + 64)),
        createdAt: Number(data.readBigInt64LE(offsets.createdAt)),
        expiresAt: Number(data.readBigInt64LE(offsets.expiresAt)),
    };
}

function decodeQuote(data: Buffer) {
    return {
        maker: readPublicKey(data, 40).toBase58(),
        route: data[72] === 0 ? 'Direct Solana P2P' : 'Route',
        quoteCommitment: Array.from(data.subarray(169, 201)),
        createdAt: Number(data.readBigInt64LE(233)),
        expiresAt: Number(data.readBigInt64LE(241)),
        accepted: data[249] === 1,
    };
}

async function fetchQuotesForIntent(connection: Connection, intent: PublicKey) {
    const accounts = await connection.getProgramAccounts(VELVET_MESH_PROGRAM_ID, {
        commitment: 'confirmed',
        filters: [
            { memcmp: { offset: 8, bytes: intent.toBase58() } },
        ],
    });

    const quoteAccounts = accounts.filter(({ account }) => account.data.subarray(0, 8).equals(QUOTE_DISCRIMINATOR));
    const decoded = await Promise.all(quoteAccounts.map(async ({ pubkey, account }) => ({
        address: pubkey.toBase58(),
        signature: await latestSignature(connection, pubkey),
        ...decodeQuote(account.data),
    })));

    decoded.sort((a, b) => b.createdAt - a.createdAt);
    return decoded;
}

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const ownerParam = searchParams.get('owner');

    if (!ownerParam) {
        return NextResponse.json({ error: 'Missing owner query param.' }, { status: 400 });
    }

    let owner: PublicKey;
    try {
        owner = new PublicKey(ownerParam);
    } catch {
        return NextResponse.json({ error: 'Invalid owner public key.' }, { status: 400 });
    }

    const connection = new Connection(getDevnetRpcUrl(), 'confirmed');

    const accounts = await connection.getProgramAccounts(VELVET_MESH_PROGRAM_ID, {
        commitment: 'confirmed',
        filters: [
            { memcmp: { offset: 8, bytes: owner.toBase58() } },
        ],
    });

    const intentAccounts = accounts.filter(({ account }) => account.data.subarray(0, 8).equals(INTENT_DISCRIMINATOR));
    const decoded = await Promise.all(intentAccounts.map(async ({ pubkey, account }) => {
        const intent = decodeIntent(account.data);
        const [signature, quotes] = await Promise.all([
            latestSignature(connection, pubkey),
            fetchQuotesForIntent(connection, pubkey),
        ]);

        return {
            address: pubkey.toBase58(),
            signature,
            quotes,
            ...intent,
        };
    }));

    decoded.sort((a, b) => b.createdAt - a.createdAt);

    return NextResponse.json({
        owner: owner.toBase58(),
        intents: decoded,
        lastUpdatedAt: Date.now(),
    });
}
