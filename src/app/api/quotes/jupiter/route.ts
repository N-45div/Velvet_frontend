import { NextRequest, NextResponse } from 'next/server';

const JUPITER_ULTRA_ORDER_URL = 'https://lite-api.jup.ag/ultra/v1/order';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const MAINNET_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const TOKENS = {
    SOL: { mint: WSOL_MINT, decimals: 9 },
    USDC: { mint: MAINNET_USDC_MINT, decimals: 6 },
} as const;

type TokenSymbol = keyof typeof TOKENS;

function isTokenSymbol(value: string | null): value is TokenSymbol {
    return value === 'SOL' || value === 'USDC';
}

function toRawAmount(amountUi: string, decimals: number) {
    const [wholePart, fractionalPart = ''] = amountUi.split('.');
    const whole = wholePart || '0';
    const fractional = fractionalPart.padEnd(decimals, '0').slice(0, decimals);
    return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fractional || '0');
}

function toUiAmount(rawAmount: string, decimals: number) {
    const value = BigInt(rawAmount);
    const divisor = 10n ** BigInt(decimals);
    const whole = value / divisor;
    const fractional = (value % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');
    return fractional ? `${whole}.${fractional}` : whole.toString();
}

export async function GET(request: NextRequest) {
    const params = request.nextUrl.searchParams;
    const inputSymbol = params.get('inputSymbol');
    const outputSymbol = params.get('outputSymbol');
    const amountUi = params.get('amount');

    if (!isTokenSymbol(inputSymbol) || !isTokenSymbol(outputSymbol)) {
        return NextResponse.json({ error: 'Only SOL and USDC quotes are supported' }, { status: 400 });
    }

    if (!amountUi || Number(amountUi) <= 0) {
        return NextResponse.json({ error: 'amount must be greater than zero' }, { status: 400 });
    }

    const input = TOKENS[inputSymbol];
    const output = TOKENS[outputSymbol];
    const amount = toRawAmount(amountUi, input.decimals).toString();

    const quoteParams = new URLSearchParams({
        inputMint: input.mint,
        outputMint: output.mint,
        amount,
    });

    const response = await fetch(`${JUPITER_ULTRA_ORDER_URL}?${quoteParams}`, {
        cache: 'no-store',
    });
    const quote = await response.json();

    if (!response.ok || quote.error) {
        return NextResponse.json(
            {
                error: quote.error || `Jupiter quote failed: ${response.status}`,
                source: 'Jupiter Ultra',
                network: 'mainnet-reference',
            },
            { status: response.ok ? 502 : response.status }
        );
    }

    return NextResponse.json({
        source: 'Jupiter Ultra',
        network: 'mainnet-reference',
        inputSymbol,
        outputSymbol,
        inAmount: quote.inAmount,
        outAmount: quote.outAmount,
        outAmountUi: toUiAmount(quote.outAmount, output.decimals),
        priceImpactPct: quote.priceImpactPct ?? quote.priceImpact,
        routeLabel: quote.routePlan?.[0]?.swapInfo?.label ?? quote.router ?? 'Jupiter',
        requestId: quote.requestId,
        inUsdValue: quote.inUsdValue,
        outUsdValue: quote.outUsdValue,
        totalTime: quote.totalTime,
        note: 'Jupiter public liquidity is mainnet-only here; VelvetMesh execution remains devnet.',
    });
}
