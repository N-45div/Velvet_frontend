import * as anchor from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { createHash, webcrypto } from 'crypto';
import { getMXEPublicKey, RescueCipher, x25519 } from '@arcium-hq/client';
import { NextResponse } from 'next/server';
import { getDevnetRpcUrl } from '@/lib/solana/rpc';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MATCHER_PROGRAM_ID = new PublicKey(
    process.env.VELVET_MATCHER_PROGRAM_ID || 'CEjM2iFeNzKwDtc8uGLAGVFDoaHvJmy9EunRUwAsJH8e'
);

function parsePositiveAmount(value: unknown) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('outputAmount must be a positive number.');
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

function hash32(input: unknown) {
    return Array.from(createHash('sha256').update(JSON.stringify(input)).digest());
}

function readOnlyProvider() {
    const wallet = {
        publicKey: PublicKey.default,
        signTransaction: async () => {
            throw new Error('Quote handle route is read-only.');
        },
        signAllTransactions: async () => {
            throw new Error('Quote handle route is read-only.');
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
        const intent = new PublicKey(body.intent);
        const maker = new PublicKey(body.maker);
        const outputAmount = parsePositiveAmount(body.outputAmount);
        const outputDecimals = body.outputSymbol === 'SOL' ? 9 : 6;
        const outputAtoms = outputAmount * 10 ** outputDecimals;

        const mxePublicKey = await getMXEPublicKey(readOnlyProvider(), MATCHER_PROGRAM_ID);
        if (!mxePublicKey) {
            throw new Error('Arcium MXE public key is unavailable for the matcher program.');
        }

        const privateKey = x25519.utils.randomSecretKey();
        const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);
        const cipher = new RescueCipher(sharedSecret);
        const nonce = Buffer.from(webcrypto.getRandomValues(new Uint8Array(16)));
        const ciphertexts = cipher.encrypt([
            toU64(outputAtoms),
            toU16(body.priceBps, 10_000),
            toU16(body.makerRisk, 20),
        ], nonce);
        const commitmentPayload = {
            intent: intent.toBase58(),
            maker: maker.toBase58(),
            outputSymbol: body.outputSymbol,
            outputAmount,
            priceBps: body.priceBps ?? 10_000,
            makerRisk: body.makerRisk ?? 20,
            nonce: Array.from(nonce),
        };

        return NextResponse.json({
            encryptedOutputAmount: ciphertexts[0],
            encryptedPriceBps: ciphertexts[1],
            encryptedMakerRisk: ciphertexts[2],
            quoteCommitment: hash32({ ...commitmentPayload, type: 'quote' }),
            settlementHash: hash32({ ...commitmentPayload, type: 'settlement' }),
            provider: 'arcium-devnet-mxe',
            matcherProgramId: MATCHER_PROGRAM_ID.toBase58(),
        });
    } catch (error: any) {
        return NextResponse.json(
            {
                error: error?.message || 'Unable to create quote handles.',
            },
            { status: 400 }
        );
    }
}
