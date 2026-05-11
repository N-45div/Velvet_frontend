import { NextRequest, NextResponse } from 'next/server';

const COINGECKO_MARKET_CHART_URL = 'https://api.coingecko.com/api/v3/coins/solana/market_chart';

type CoinGeckoMarketChartResponse = {
    prices?: [number, number][];
};

function normalizeDays(value: string | null) {
    if (value === '90' || value === '180') {
        return value;
    }

    return '180';
}

export async function GET(request: NextRequest) {
    const days = normalizeDays(request.nextUrl.searchParams.get('days'));
    const params = new URLSearchParams({
        vs_currency: 'usd',
        days,
    });
    const headers: HeadersInit = {
        accept: 'application/json',
    };

    if (process.env.COINGECKO_DEMO_API_KEY) {
        headers['x-cg-demo-api-key'] = process.env.COINGECKO_DEMO_API_KEY;
    }

    const response = await fetch(`${COINGECKO_MARKET_CHART_URL}?${params}`, {
        headers,
        next: { revalidate: 60 * 30 },
    });
    const body = (await response.json()) as CoinGeckoMarketChartResponse & { error?: string };

    if (!response.ok || body.error || !Array.isArray(body.prices)) {
        return NextResponse.json(
            {
                error: body.error || `CoinGecko market chart failed: ${response.status}`,
                source: 'CoinGecko',
            },
            { status: response.ok ? 502 : response.status }
        );
    }

    const prices = body.prices.map(([timestamp, price]) => ({ timestamp, price }));
    const first = prices[0]?.price ?? 0;
    const last = prices[prices.length - 1]?.price ?? 0;
    const changePct = first > 0 ? ((last - first) / first) * 100 : 0;

    return NextResponse.json({
        source: 'CoinGecko',
        coinId: 'solana',
        pair: 'SOL/USD',
        days: Number(days),
        prices,
        currentPrice: last,
        changePct,
        lastUpdatedAt: Date.now(),
        note: 'CoinGecko historical market data; Jupiter remains the live quote source.',
    });
}
