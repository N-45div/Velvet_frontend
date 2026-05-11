import * as anchor from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { webcrypto } from 'crypto';
import { getMXEPublicKey, RescueCipher, x25519 } from '@arcium-hq/client';
import { NextResponse } from 'next/server';
import { getDevnetRpcUrl } from '@/lib/solana/rpc';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MATCHER_PROGRAM_ID = new PublicKey(
    process.env.VELVET_MATCHER_PROGRAM_ID || 'CEjM2iFeNzKwDtc8uGLAGVFDoaHvJmy9EunRUwAsJH8e'
);
const SIGN_PDA_SEED = Buffer.from('ArciumSignerAccount');

function parsePositiveAmount(value: unknown) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('amount must be a positive number.');
    }
    return parsed;
}

function toU64(value: number) {
    return BigInt(Math.max(1, Math.floor(value)));
}

function toU16(value: unknown, fallback: number) {
    const parsed = Number(value ?? fallback);
    return BigInt(Math.max(0, Math.min(65535, Math.floor(Number.isFinite(parsed) ? parsed : fallback))));
}

function toU8(value: unknown, fallback: number) {
    const parsed = Number(value ?? fallback);
    return BigInt(Math.max(0, Math.min(255, Math.floor(Number.isFinite(parsed) ? parsed : fallback))));
}

function readOnlyProvider() {
    const wallet = {
        publicKey: PublicKey.default,
        signTransaction: async () => {
            throw new Error('Privacy handle route is read-only.');
        },
        signAllTransactions: async () => {
            throw new Error('Privacy handle route is read-only.');
        },
    };
    const connection = new anchor.web3.Connection(getDevnetRpcUrl(), 'confirmed');
    return new anchor.AnchorProvider(connection, wallet as never, {
        commitment: 'confirmed',
        preflightCommitment: 'confirmed',
    });
}

export async function POST(request: Request) {
    try {
        const body = await request.json();
        if (!body?.owner) {
            throw new Error('owner is required.');
        }

        const owner = new PublicKey(body.owner);
        const amount = parsePositiveAmount(body.amount);
        const amountDecimals = body.inputSymbol === 'USDC' ? 6 : 9;
        const sizeAtoms = amount * 10 ** amountDecimals;

        const mxePublicKey = await getMXEPublicKey(readOnlyProvider(), MATCHER_PROGRAM_ID);
        if (!mxePublicKey) {
            throw new Error('Arcium MXE public key is unavailable for the matcher program.');
        }

        const privateKey = x25519.utils.randomSecretKey();
        const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);
        const cipher = new RescueCipher(sharedSecret);
        const nonce = Buffer.from(webcrypto.getRandomValues(new Uint8Array(16)));
        const ciphertexts = cipher.encrypt([
            toU64(sizeAtoms),
            toU16(body.limitPriceBps, 10_000),
            toU16(body.slippageBps, 50),
            toU8(body.riskPreference, 1),
        ], nonce);
        const [matchVerifier] = PublicKey.findProgramAddressSync([SIGN_PDA_SEED], MATCHER_PROGRAM_ID);

        return NextResponse.json({
            encryptedSize: ciphertexts[0],
            encryptedLimitPrice: ciphertexts[1],
            encryptedSlippageBps: ciphertexts[2],
            encryptedRiskPreference: ciphertexts[3],
            matchVerifier: matchVerifier.toBase58(),
            settlementVerifier: owner.toBase58(),
            provider: 'arcium-devnet-mxe',
            matcherProgramId: MATCHER_PROGRAM_ID.toBase58(),
        });
    } catch (error: any) {
        return NextResponse.json(
            {
                error: error?.message || 'Unable to create privacy handles.',
            },
            { status: 400 }
        );
    }
}
