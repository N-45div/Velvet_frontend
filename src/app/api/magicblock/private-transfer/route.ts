import { NextResponse } from 'next/server';
import { DEVNET_TEST_USDC_MINT } from '@/lib/solana/constants';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAGICBLOCK_PRIVATE_PAYMENTS_URL = 'https://payments.magicblock.app/v1/spl/transfer';

function parseAmount(value: unknown) {
    const parsed = Number(value ?? 1);
    if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error('amount must be at least 1 base unit.');
    }
    return Math.floor(parsed);
}

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const from = String(body.from || '');
        const to = String(body.to || '');
        const amount = parseAmount(body.amount);
        const clientRefId = String(body.clientRefId || Date.now());

        if (!from || !to) {
            return NextResponse.json({ error: 'from and to wallet addresses are required.' }, { status: 400 });
        }

        const response = await fetch(MAGICBLOCK_PRIVATE_PAYMENTS_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                from,
                to,
                mint: DEVNET_TEST_USDC_MINT.toBase58(),
                amount,
                visibility: 'private',
                fromBalance: 'base',
                toBalance: 'base',
                cluster: 'devnet',
                initIfMissing: true,
                initAtasIfMissing: true,
                initVaultIfMissing: false,
                memo: `VelvetMesh settlement ${clientRefId}`,
                minDelayMs: '0',
                maxDelayMs: '0',
                clientRefId,
                split: 1,
                gasless: false,
                legacy: true,
            }),
        });
        const payload = await response.json().catch(async () => ({ error: await response.text() }));

        if (!response.ok) {
            return NextResponse.json({
                error: payload?.error || payload?.message || `MagicBlock Private Payments API failed: ${response.status}`,
                details: payload,
            }, { status: response.status });
        }

        return NextResponse.json({
            ...payload,
            provider: 'magicblock-private-payments-api',
            mint: DEVNET_TEST_USDC_MINT.toBase58(),
            amount,
        });
    } catch (error: any) {
        return NextResponse.json({ error: error?.message || 'Unable to prepare MagicBlock private transfer.' }, { status: 400 });
    }
}
