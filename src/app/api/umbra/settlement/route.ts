import { NextResponse } from 'next/server';
import {
    getUmbraSettlementStatus,
    registerUmbraSettlementSigner,
    shieldUmbraSettlement,
} from '@/lib/umbra-settlement';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
    try {
        return NextResponse.json(await getUmbraSettlementStatus());
    } catch (error: any) {
        return NextResponse.json({
            configured: true,
            error: error?.message || 'Unable to load Umbra settlement status.',
        }, { status: 400 });
    }
}

export async function POST(request: Request) {
    try {
        const body = await request.json().catch(() => ({}));
        const action = String(body.action || 'shield');

        if (action === 'register') {
            return NextResponse.json(await registerUmbraSettlementSigner());
        }

        if (action !== 'shield') {
            return NextResponse.json({ error: 'Unsupported Umbra settlement action.' }, { status: 400 });
        }

        return NextResponse.json(await shieldUmbraSettlement({
            destination: body.destination ? String(body.destination) : undefined,
            intent: body.intent ? String(body.intent) : undefined,
            amountBaseUnits: body.amountBaseUnits,
        }));
    } catch (error: any) {
        return NextResponse.json({ error: error?.message || 'Unable to execute Umbra settlement action.' }, { status: 400 });
    }
}
