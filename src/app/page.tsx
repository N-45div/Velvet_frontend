'use client';

import React, { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { useWallet } from '@solana/wallet-adapter-react';
import { Shield, ArrowDownUp, Lock, ExternalLink, CheckCircle, AlertCircle, Loader2, EyeOff, Eye, Wallet, KeyRound, Radio, Search, Settings, MoreHorizontal, Activity } from 'lucide-react';
import { useConnection } from '@solana/wallet-adapter-react';
import { Connection, LAMPORTS_PER_SOL, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
// Range Protocol compliance is handled in range-compliance.ts
import { 
    DEVNET_WSOL_MINT,
    DEVNET_TEST_USDC_MINT,
} from '@/lib/solana/constants';
import {
    swapExactIn,
    encryptAmount,
    computeSwapQuote,
    fetchPoolState,
    DEVNET_INCO_MINT_A,
    DEVNET_INCO_MINT_B,
    DEVNET_POOL_VAULT_A,
    DEVNET_POOL_VAULT_B,
} from '@/lib/swap-client';
import {
    ensureUserIncoAccounts,
} from '@/lib/inco-account-manager';
import {
    checkAddressCompliance,
    formatComplianceStatus,
    ComplianceResult,
} from '@/lib/range-compliance';
import {
    fetchUserIncoAccounts,
    parseIncoAccountData,
    decryptBalances,
    formatBalance,
    type IncoAccountInfo,
} from '@/lib/inco-balance';
import {
    approvePoolAuthority,
    getPoolAuthorityPda,
} from '@/lib/inco-allowance';
import {
    ensureDecryptAccess,
} from '@/lib/inco-access';
import {
    fetchVelvetMeshLiveStatus,
    type VelvetMeshLiveStatus,
} from '@/lib/velvet-mesh-status';
import {
    type ArciumMatcherQuoteInput,
    acceptVelvetMeshQuote,
    createVelvetMeshIntent,
    requestVelvetMeshPrivateMatch,
    submitDevnetMakerQuotes,
    submitVelvetMeshQuote,
} from '@/lib/velvet-mesh-client';
import {
    fetchVelvetMeshIntentHistory,
    type VelvetMeshIntentHistoryItem,
} from '@/lib/velvet-mesh-history';
import { settleWithMagicBlockPrivatePayment } from '@/lib/magicblock-private-payments';
import { shieldSettlementWithUmbra } from '@/lib/umbra-settlement-client';

const WalletMultiButton = dynamic(
    () => import('@solana/wallet-adapter-react-ui').then(mod => mod.WalletMultiButton),
    { ssr: false, loading: () => <div className="h-10 w-32 bg-secondary rounded-lg animate-pulse" /> }
);

type SwapStep = 'idle' | 'authenticating' | 'intenting' | 'swapping' | 'pending' | 'complete' | 'error';

type JupiterQuote = {
    source: string;
    network: string;
    outAmountUi: string;
    priceImpactPct?: string | number;
    routeLabel?: string;
    inUsdValue?: number;
    outUsdValue?: number;
    totalTime?: number;
    note?: string;
};

type CoinGeckoChart = {
    source: string;
    pair: string;
    days: number;
    prices: Array<{ timestamp: number; price: number }>;
    currentPrice: number;
    changePct: number;
    note?: string;
};

type VelvetMeshIntentResult = {
    signature: string;
    intent: string;
    nonce: string;
    status: string;
    privacyProvider?: string;
};

type SettlementReceipt = {
    status: 'magicblock-confirmed' | 'umbra-confirmed' | 'complete' | 'failed';
    usdcBaseUnits?: number;
    wsolBaseUnits?: number;
    magicBlockSignature?: string;
    umbraWrapSignature?: string | null;
    umbraQueueSignature?: string;
    umbraCallbackSignature?: string | null;
    encryptedBalanceState?: string;
    updatedAt: number;
};

type SettlementPlan = {
    inputSymbol: string;
    outputSymbol: string;
    inputAmountUi: string;
    outputAmountUi: string;
    usdcBaseUnits: number;
    wsolBaseUnits: number;
    updatedAt: number;
};

const MIN_INTENT_SOL_BALANCE = 0.03;
const USDC_DECIMALS = 6;
const SOL_DECIMALS = 9;
const MATCHER_QUOTE_INPUTS_STORAGE_KEY = 'velvetmesh:matcherQuoteInputs:v1';
const SETTLEMENT_PLANS_STORAGE_KEY = 'velvetmesh:settlementPlans:v1';

interface TokenInfo {
    symbol: string;
    mint: PublicKey;
    decimals: number;
    icon: string;
}

const TOKENS: TokenInfo[] = [
    { symbol: 'SOL', mint: DEVNET_WSOL_MINT, decimals: 9, icon: '◎' },
    { symbol: 'USDC', mint: DEVNET_TEST_USDC_MINT, decimals: 6, icon: '$' },
];

export default function Home() {
    const [meshStatus, setMeshStatus] = useState<VelvetMeshLiveStatus | null>(null);
    const [meshStatusError, setMeshStatusError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;

        const loadMeshStatus = async () => {
            try {
                const status = await fetchVelvetMeshLiveStatus();
                if (!cancelled) {
                    setMeshStatus(status);
                    setMeshStatusError(null);
                }
            } catch (error: any) {
                if (!cancelled) {
                    setMeshStatusError(error?.message || 'VelvetMesh status unavailable');
                }
            }
        };

        loadMeshStatus();
        const interval = window.setInterval(loadMeshStatus, 30000);

        return () => {
            cancelled = true;
            window.clearInterval(interval);
        };
    }, []);

    return (
        <main className="min-h-screen privacy-stage relative overflow-hidden px-4 py-6 text-slate-950 sm:px-6">
            <div className="privacy-mesh" />
            <div className="privacy-noise" />
            <div className="privacy-orb privacy-orb-a" />
            <div className="privacy-orb privacy-orb-b" />

            <header className="relative z-20 mx-auto grid w-full max-w-[1280px] grid-cols-[1fr_auto_1fr] items-center gap-4">
                <div className="flex items-center gap-6">
                    <div className="flex items-center gap-2.5">
                        <div className="relative grid h-9 w-9 place-items-center rounded-xl border border-slate-200 bg-white shadow-sm">
                            <Shield className="h-5 w-5 text-slate-950" />
                            <div className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-emerald-400 shadow-[0_0_14px_rgba(52,211,153,0.7)]" />
                        </div>
                        <div className="text-lg font-semibold tracking-[-0.05em]">
                            Velvet<span className="text-emerald-600">Mesh</span>
                        </div>
                    </div>
                    <nav className="hidden items-center gap-6 text-sm font-medium text-slate-500 md:flex">
                        <span className="text-slate-950">Trade</span>
                        <span className="transition hover:text-slate-950">Explore</span>
                        <span className="transition hover:text-slate-950">Pool</span>
                        <span className="transition hover:text-slate-950">Portfolio</span>
                    </nav>
                </div>

                <div className="hidden h-11 w-[min(420px,32vw)] items-center gap-3 rounded-full border border-slate-200 bg-white px-4 shadow-sm lg:flex">
                    <Search className="h-4 w-4 text-slate-400" />
                    <span className="flex-1 text-sm font-medium text-slate-500">Search intents, pools, tokens</span>
                    <span className="rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 font-mono text-[10px] text-slate-400">/</span>
                </div>

                <div className="flex items-center justify-end gap-3">
                    <div className="hidden items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-3 py-2 font-mono text-xs text-amber-700 sm:flex">
                        <Radio className="h-3.5 w-3.5" />
                        <span>Devnet</span>
                    </div>
                    <button className="hidden h-10 w-10 place-items-center rounded-full border border-slate-200 bg-white text-slate-500 shadow-sm transition hover:bg-slate-50 sm:grid">
                        <MoreHorizontal className="h-5 w-5" />
                    </button>
                    <div className="wallet-shell">
                        <WalletMultiButton />
                    </div>
                </div>
            </header>

            <section className="relative z-10 mx-auto flex w-full max-w-[1280px] flex-col items-center pb-12 pt-8">
                <div className="mb-6 flex w-full items-center justify-between rounded-[1.25rem] border border-slate-200 bg-white px-5 py-3 shadow-sm">
                    <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.26em] text-slate-950">
                        <Activity className="h-4 w-4" />
                        Live privacy routing
                    </div>
                    <div className="hidden items-center gap-5 font-mono text-xs text-slate-500 md:flex">
                        <span>SOL/USDC <span className="text-slate-950">Jupiter</span></span>
                        <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-[10px] font-semibold text-emerald-700">LIVE</span>
                        <span>VelvetMesh <span className="text-slate-950">{meshStatus ? `${meshStatus.intentCount} intents` : 'loading'}</span></span>
                        <span>MagicBlock <span className="text-slate-950">{meshStatus?.magicBlockErHealthy ? 'ER live' : 'checking'}</span></span>
                        <span>Umbra <span className="text-slate-950">{meshStatus?.umbraRelayerReady ? 'relayer live' : 'checking'}</span></span>
                    </div>
                </div>

                <div className="mb-5 flex flex-wrap items-center justify-center gap-2">
                    {[
                        ['Backend', meshStatusError ? 'unavailable' : meshStatus ? 'live' : 'loading'],
                        ['Program', meshStatus ? shortAddress(meshStatus.programId) : 'loading'],
                        ['Live intents', meshStatus ? String(meshStatus.intentCount) : '--'],
                        ['Accepted matches', meshStatus ? String(meshStatus.acceptedMatchCount) : '--'],
                        ['MagicBlock ER', meshStatus?.magicBlockErHealthy ? `live ${meshStatus.magicBlockCoreVersion ?? ''}` : 'checking'],
                    ].map(([item, value], index) => (
                        <div
                            key={item}
                            className={`rounded-full border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.18em] ${
                                index === 0
                                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                                    : 'border-slate-200 bg-white text-slate-500'
                            }`}
                        >
                            {item}: <span className="text-slate-950">{value}</span>
                        </div>
                    ))}
                </div>

                <div className="relative w-full">
                    <PrivateSwapInterface meshStatus={meshStatus} meshStatusError={meshStatusError} />
                </div>

                <div className="mt-6 grid w-full grid-cols-1 gap-3 md:grid-cols-5">
                    {[
                        ['Encrypted intent', 'amounts stay private'],
                        ['Jupiter reference', 'live public quote'],
                        ['Arcium verify', 'private match boundary'],
                        ['MagicBlock route', meshStatus?.magicBlockRouterReady ? 'router ready' : 'checking'],
                        ['Umbra relayer', meshStatus?.umbraWsolSupported ? `${meshStatus.umbraSupportedMintCount} mints` : 'checking'],
                    ].map(([label, caption]) => (
                        <div key={label} className="rounded-2xl border border-slate-200 bg-white px-4 py-4 text-center shadow-sm">
                            <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">{label}</div>
                            <div className="mt-2 text-sm font-semibold text-slate-950">{caption}</div>
                        </div>
                    ))}
                </div>
            </section>
        </main>
    );
}

function shortAddress(address: string) {
    return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function uiAmountToBaseUnits(value: string | number | undefined, decimals: number, fallback: number) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }
    return Math.max(1, Math.floor(parsed * 10 ** decimals));
}

function buildUsdcToWsolSettlementPlan(input: {
    inputSymbol: string;
    outputSymbol: string;
    inputAmountUi: string;
    outputAmountUi?: string | null;
}): SettlementPlan | null {
    if (input.inputSymbol !== 'USDC' || input.outputSymbol !== 'SOL') {
        return null;
    }

    const outputAmountUi = input.outputAmountUi || '';
    const usdcBaseUnits = uiAmountToBaseUnits(input.inputAmountUi, USDC_DECIMALS, 0);
    const wsolBaseUnits = uiAmountToBaseUnits(outputAmountUi, SOL_DECIMALS, 0);

    if (usdcBaseUnits < 1 || wsolBaseUnits < 1) {
        return null;
    }

    return {
        inputSymbol: input.inputSymbol,
        outputSymbol: input.outputSymbol,
        inputAmountUi: input.inputAmountUi,
        outputAmountUi,
        usdcBaseUnits,
        wsolBaseUnits,
        updatedAt: Date.now(),
    };
}

function DevnetQuotePanel({
    amount,
    estimatedOutput,
    jupiterQuote,
    jupiterQuoteLoading,
    jupiterQuoteError,
    coinGeckoChart,
    coinGeckoLoading,
    coinGeckoError,
    chartDays,
    setChartDays,
    fromToken,
    toToken,
    meshStatus,
}: {
    amount: string;
    estimatedOutput: string | null;
    jupiterQuote: JupiterQuote | null;
    jupiterQuoteLoading: boolean;
    jupiterQuoteError: string | null;
    coinGeckoChart: CoinGeckoChart | null;
    coinGeckoLoading: boolean;
    coinGeckoError: string | null;
    chartDays: 90 | 180;
    setChartDays: (days: 90 | 180) => void;
    fromToken: TokenInfo;
    toToken: TokenInfo;
    meshStatus: VelvetMeshLiveStatus | null;
}) {
    const numericAmount = Number.parseFloat(amount || '0');
    const chartPrices = coinGeckoChart?.prices ?? [];
    const chartValues = chartPrices.map((point) => point.price);
    const min = chartValues.length ? Math.min(...chartValues) : 0;
    const max = chartValues.length ? Math.max(...chartValues) : 1;
    const range = max - min || 1;
    const width = 760;
    const height = 260;
    const paddingX = 18;
    const paddingY = 24;
    const chartWidth = width - paddingX * 2;
    const chartHeight = height - paddingY * 2;
    const points = chartPrices.map((point, index) => {
        const x = paddingX + (index / Math.max(chartPrices.length - 1, 1)) * chartWidth;
        const y = paddingY + (1 - (point.price - min) / range) * chartHeight;
        return { x, y, ...point };
    });
    const linePath = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ');
    const areaPath = points.length
        ? `${linePath} L ${points[points.length - 1].x.toFixed(2)} ${height - paddingY} L ${points[0].x.toFixed(2)} ${height - paddingY} Z`
        : '';
    const quoteValue = jupiterQuote?.outAmountUi
        ? `${Number(jupiterQuote.outAmountUi).toLocaleString(undefined, { maximumFractionDigits: toToken.decimals > 6 ? 6 : 4 })} ${toToken.symbol}`
        : estimatedOutput ? `${estimatedOutput} ${toToken.symbol}` : '--';
    const notional = jupiterQuote?.inUsdValue
        ? `$${jupiterQuote.inUsdValue.toFixed(2)}`
        : numericAmount > 0 ? `$${(numericAmount * (fromToken.symbol === 'SOL' ? 150 : 1)).toFixed(2)}` : '--';
    const routeLabel = jupiterQuote?.routeLabel ?? 'Jupiter reference';
    const priceImpact = jupiterQuote?.priceImpactPct !== undefined
        ? `${(Number(jupiterQuote.priceImpactPct) * (Math.abs(Number(jupiterQuote.priceImpactPct)) > 1 ? 1 : 100)).toFixed(4)}%`
        : '--';
    const currentPrice = coinGeckoChart?.currentPrice
        ? `$${coinGeckoChart.currentPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
        : '--';
    const chartChange = coinGeckoChart
        ? `${coinGeckoChart.changePct >= 0 ? '+' : ''}${coinGeckoChart.changePct.toFixed(2)}%`
        : '--';
    const yLabels = [max, min + range / 2, min];

    return (
        <div className="rounded-[1.5rem] border border-slate-200 bg-white p-6 shadow-sm">
            <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                    <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-slate-400">Market</div>
                    <div className="mt-1 text-xl font-semibold tracking-[-0.04em] text-slate-950">
                        SOL / USD · {chartDays === 180 ? '6M' : '3M'} · CoinGecko
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                        Historical market chart from CoinGecko. Jupiter remains the live route quote.
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    {[90, 180].map((days) => (
                        <button
                            key={days}
                            onClick={() => setChartDays(days as 90 | 180)}
                            className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                                chartDays === days
                                    ? 'bg-slate-950 text-white'
                                    : 'border border-slate-200 bg-white text-slate-500 hover:bg-slate-50'
                            }`}
                        >
                            {days === 90 ? '3M' : '6M'}
                        </button>
                    ))}
                </div>
            </div>

            <div className="rounded-2xl border border-dashed border-slate-200 bg-gradient-to-b from-slate-50 to-white p-5">
                <div className="mb-3 flex items-center justify-between">
                    <div className="text-xs font-medium text-slate-500">Price chart</div>
                    <div className="flex items-center gap-3 font-mono text-xs">
                        <span className="text-slate-950">{currentPrice}</span>
                        <span className={coinGeckoChart?.changePct && coinGeckoChart.changePct < 0 ? 'text-red-500' : 'text-emerald-600'}>
                            {chartChange}
                        </span>
                        <span className="text-slate-400">{coinGeckoLoading ? 'Loading...' : '30m cache'}</span>
                    </div>
                </div>

                <div className="relative overflow-hidden rounded-xl bg-white">
                    <svg viewBox={`0 0 ${width} ${height}`} className="h-[300px] w-full">
                        <defs>
                            <linearGradient id="cgArea" x1="0" x2="0" y1="0" y2="1">
                                <stop offset="0%" stopColor="#10b981" stopOpacity="0.22" />
                                <stop offset="100%" stopColor="#10b981" stopOpacity="0" />
                            </linearGradient>
                        </defs>
                        {[0, 1, 2, 3].map((line) => {
                            const y = paddingY + (line / 3) * chartHeight;
                            return <line key={`h-${line}`} x1={paddingX} x2={width - paddingX} y1={y} y2={y} stroke="#e2e8f0" strokeWidth="1" />;
                        })}
                        {[0, 1, 2, 3, 4, 5].map((line) => {
                            const x = paddingX + (line / 5) * chartWidth;
                            return <line key={`v-${line}`} x1={x} x2={x} y1={paddingY} y2={height - paddingY} stroke="#e2e8f0" strokeWidth="1" />;
                        })}
                        {areaPath && <path d={areaPath} fill="url(#cgArea)" />}
                        {linePath && <path d={linePath} fill="none" stroke="#0f172a" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />}
                        {points.length > 0 && (
                            <g>
                                <line
                                    x1={paddingX}
                                    x2={width - paddingX}
                                    y1={points[points.length - 1].y}
                                    y2={points[points.length - 1].y}
                                    stroke="#0f172a"
                                    strokeDasharray="2 4"
                                    strokeWidth="1"
                                />
                                <rect
                                    x={width - paddingX - 58}
                                    y={points[points.length - 1].y - 13}
                                    width="58"
                                    height="26"
                                    rx="7"
                                    fill="#0f172a"
                                />
                                <text
                                    x={width - paddingX - 29}
                                    y={points[points.length - 1].y + 4}
                                    textAnchor="middle"
                                    fontSize="12"
                                    fontWeight="700"
                                    fill="#ffffff"
                                >
                                    {points[points.length - 1].price.toFixed(2)}
                                </text>
                            </g>
                        )}
                        {yLabels.map((label, index) => (
                            <text
                                key={index}
                                x={width - paddingX - 4}
                                y={paddingY + (index / 2) * chartHeight + 4}
                                textAnchor="end"
                                fontSize="11"
                                fill="#64748b"
                            >
                                {label.toFixed(2)}
                            </text>
                        ))}
                    </svg>
                    {coinGeckoError && (
                        <div className="absolute inset-0 grid place-items-center bg-white/80 text-sm font-medium text-amber-700">
                            {coinGeckoError}
                        </div>
                    )}
                </div>
            </div>

            <div className="mt-4 grid grid-cols-3 gap-2 text-[11px]">
                <div className="rounded-xl bg-slate-50 px-3 py-3 text-slate-500">
                    Quote <span className="block truncate font-mono text-slate-950">{quoteValue}</span>
                </div>
                <div className="rounded-xl bg-slate-50 px-3 py-3 text-slate-500">
                    Route <span className="block truncate font-mono text-slate-950">{routeLabel}</span>
                </div>
                <div className="rounded-xl bg-slate-50 px-3 py-3 text-slate-500">
                    Impact <span className="block font-mono text-slate-950">{priceImpact}</span>
                </div>
            </div>

            <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
                <div className="rounded-xl bg-slate-50 px-3 py-2 text-slate-500">
                    Ref value <span className="font-mono text-slate-950">{notional}</span>
                </div>
                <div className="rounded-xl bg-slate-50 px-3 py-2 text-slate-500">
                    Backend <span className="font-mono text-slate-950">{meshStatus ? `${meshStatus.intentCount} intents` : '--'}</span>
                </div>
            </div>

            {(coinGeckoChart?.note || jupiterQuote?.note || jupiterQuoteError) && (
                <div className={`mt-2 rounded-xl border px-2.5 py-2 text-[11px] leading-5 ${
                    jupiterQuoteError
                        ? 'border-amber-200 bg-amber-50 text-amber-700'
                        : 'border-slate-200 bg-slate-50 text-slate-500'
                }`}>
                    {jupiterQuoteError || coinGeckoChart?.note || jupiterQuote?.note}
                </div>
            )}
        </div>
    );
}

function PrivateLifecyclePanel({ meshStatus }: { meshStatus: VelvetMeshLiveStatus | null }) {
    const steps = [
        ['Intent encrypted', 'User amount and limits are represented as private handles.'],
        ['Quote matched', `${meshStatus?.acceptedMatchCount ?? '--'} accepted matches recorded on devnet.`],
        ['Arcium verified', 'Verifier-gated match result before acceptance.'],
        ['Protected settlement', `${meshStatus?.settlementRouteCount ?? '--'} settlement routes prepared.`],
        ['Private payout', 'Settlement rail confirms only after the protected route is ready.'],
    ];

    return (
        <div className="rounded-[1.5rem] border border-slate-200 bg-white p-6 shadow-sm">
            <div className="mb-4">
                <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-slate-400">Private lifecycle</div>
                <h3 className="mt-1 text-xl font-semibold tracking-[-0.04em] text-slate-950">
                    From quote to protected settlement
                </h3>
            </div>
            <div className="grid gap-3 md:grid-cols-5">
                {steps.map(([title, body], index) => (
                    <div key={title} className="relative rounded-2xl border border-slate-200 bg-slate-50 p-4">
                        <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-full bg-slate-950 font-mono text-xs font-semibold text-white">
                            {index + 1}
                        </div>
                        <div className="text-sm font-semibold text-slate-950">{title}</div>
                        <p className="mt-2 text-xs leading-5 text-slate-500">{body}</p>
                    </div>
                ))}
            </div>
        </div>
    );
}

function TradeProgressPanel({
    step,
    statusMessage,
    isProcessing,
    txSignature,
    intentResult,
    onReset,
}: {
    step: SwapStep;
    statusMessage: string | null;
    isProcessing: boolean;
    txSignature: string | null;
    intentResult: VelvetMeshIntentResult | null;
    onReset: () => void;
}) {
    if (!statusMessage && !txSignature && !intentResult) {
        return null;
    }

    const tone = step === 'error'
        ? 'border-red-200 bg-red-50 text-red-800'
        : step === 'complete'
            ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
            : 'border-slate-200 bg-slate-50 text-slate-700';

    return (
        <div className={`rounded-[1.5rem] border p-5 shadow-sm ${tone}`}>
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                    <div className="font-mono text-[11px] uppercase tracking-[0.24em] opacity-70">Trade progress</div>
                    <h3 className="mt-1 text-xl font-semibold tracking-[-0.04em] text-slate-950">
                        {step === 'complete' ? 'Settlement complete' : step === 'pending' ? 'Match pending' : step === 'error' ? 'Action needs attention' : 'Execution in progress'}
                    </h3>
                </div>
                {(step === 'complete' || step === 'error') && (
                    <button
                        onClick={onReset}
                        className="rounded-full border border-white/70 bg-white/70 px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-white"
                    >
                        Reset
                    </button>
                )}
            </div>

            {statusMessage && (
                <div className="mt-4 flex items-start gap-3 rounded-2xl bg-white/70 p-4 text-sm text-slate-700">
                    {isProcessing && <Loader2 className="mt-0.5 h-5 w-5 animate-spin text-slate-500" />}
                    {step === 'complete' && <CheckCircle className="mt-0.5 h-5 w-5 text-emerald-500" />}
                    {step === 'error' && <AlertCircle className="mt-0.5 h-5 w-5 text-red-500" />}
                    <span className="font-medium leading-relaxed">{statusMessage}</span>
                </div>
            )}

            {intentResult && (
                <div className="mt-4 grid gap-2 text-[11px] sm:grid-cols-3">
                    <div className="rounded-xl bg-white/70 px-3 py-2 text-slate-500">
                        Intent <span className="block font-mono text-slate-950">{shortAddress(intentResult.intent)}</span>
                    </div>
                    <div className="rounded-xl bg-white/70 px-3 py-2 text-slate-500">
                        Status <span className="block font-mono text-slate-950">{intentResult.status}</span>
                    </div>
                    <div className="rounded-xl bg-white/70 px-3 py-2 text-slate-500">
                        Privacy <span className="block font-mono text-slate-950">{intentResult.privacyProvider ?? 'VelvetMesh'}</span>
                    </div>
                </div>
            )}

            {txSignature && (
                <a
                    href={`https://explorer.solana.com/tx/${txSignature}?cluster=devnet`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-4 inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-semibold text-emerald-700 shadow-sm transition hover:text-emerald-900"
                >
                    <ExternalLink className="h-4 w-4" />
                    View latest transaction
                </a>
            )}
        </div>
    );
}

function IntentHistoryPanel({
    connected,
    intents,
    loading,
    error,
    onReload,
    onSubmitQuote,
    onSeedQuotes,
    onRequestMatch,
    onAcceptQuote,
    onMagicBlockSettle,
    onUmbraShield,
    onTwoRailSettle,
    quoteSubmittingIntent,
    matchingIntent,
    acceptingIntent,
    magicBlockSettlingIntent,
    umbraShieldingIntent,
    settlementReceipts,
    settlementPlans,
}: {
    connected: boolean;
    intents: VelvetMeshIntentHistoryItem[];
    loading: boolean;
    error: string | null;
    onReload: () => void;
    onSubmitQuote: (intent: VelvetMeshIntentHistoryItem) => void;
    onSeedQuotes: (intent: VelvetMeshIntentHistoryItem) => void;
    onRequestMatch: (intent: VelvetMeshIntentHistoryItem) => void;
    onAcceptQuote: (intent: VelvetMeshIntentHistoryItem) => void;
    onMagicBlockSettle: (intent: VelvetMeshIntentHistoryItem) => void;
    onUmbraShield: (intent: VelvetMeshIntentHistoryItem) => void;
    onTwoRailSettle: (intent: VelvetMeshIntentHistoryItem) => void;
    quoteSubmittingIntent: string | null;
    matchingIntent: string | null;
    acceptingIntent: string | null;
    magicBlockSettlingIntent: string | null;
    umbraShieldingIntent: string | null;
    settlementReceipts: Record<string, SettlementReceipt>;
    settlementPlans: Record<string, SettlementPlan>;
}) {
    const hasTwoRailPlan = (intent: VelvetMeshIntentHistoryItem) => {
        const plan = settlementPlans[intent.address];
        return (intent.inputSymbol === 'USDC' && intent.outputSymbol === 'SOL')
            || (plan?.inputSymbol === 'USDC' && plan.outputSymbol === 'SOL');
    };

    return (
        <div className="rounded-[1.5rem] border border-slate-200 bg-white p-6 shadow-sm">
            <div className="mb-4 flex items-start justify-between gap-4">
                <div>
                    <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-slate-400">Intents</div>
                    <h3 className="mt-1 text-xl font-semibold tracking-[-0.04em] text-slate-950">Your private intent history</h3>
                    <p className="mt-1 text-xs text-slate-500">Live devnet accounts owned by the connected wallet.</p>
                </div>
                <button
                    onClick={onReload}
                    disabled={!connected || loading}
                    className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300"
                >
                    {loading ? 'Loading' : 'Reload'}
                </button>
            </div>

            {!connected ? (
                <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-500">
                    Connect a devnet wallet to load intent history.
                </div>
            ) : error ? (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700">{error}</div>
            ) : intents.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-500">
                    No VelvetMesh intents found for this wallet yet.
                </div>
            ) : (
                <div className="space-y-3">
                    {intents.slice(0, 6).map((intent) => (
                        <div key={intent.address} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                            <div className="flex flex-wrap items-center justify-between gap-3">
                                <div>
                                    <div className="text-sm font-semibold text-slate-950">
                                        {settlementPlans[intent.address]?.inputSymbol ?? intent.inputSymbol} / {settlementPlans[intent.address]?.outputSymbol ?? intent.outputSymbol}
                                    </div>
                                    <div className="mt-1 font-mono text-[11px] text-slate-500">
                                        {shortAddress(intent.address)} · nonce {intent.nonce}
                                    </div>
                                </div>
                                <div className="flex items-center gap-2">
                                    <span className="rounded-full bg-white px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-slate-600">
                                        {intent.computeProvider}
                                    </span>
                                    <span className={`rounded-full px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] ${
                                        intent.settlementReady
                                            ? 'bg-emerald-100 text-emerald-700'
                                            : 'bg-amber-100 text-amber-700'
                                    }`}>
                                        {intent.settlementReady ? 'Route ready' : intent.status}
                                    </span>
                                </div>
                            </div>
                            <div className="mt-3 grid gap-2 text-[11px] sm:grid-cols-4">
                                <div className="rounded-xl bg-white px-3 py-2 text-slate-500">
                                    Quotes <span className="block font-mono text-slate-950">{intent.quoteCount}/{intent.minQuoteCount}</span>
                                </div>
                                <div className="rounded-xl bg-white px-3 py-2 text-slate-500">
                                    Created <span className="block font-mono text-slate-950">{intent.createdAt ? new Date(intent.createdAt * 1000).toLocaleDateString() : '--'}</span>
                                </div>
                                <div className="rounded-xl bg-white px-3 py-2 text-slate-500">
                                    Expires <span className="block font-mono text-slate-950">{intent.expiresAt ? new Date(intent.expiresAt * 1000).toLocaleDateString() : '--'}</span>
                                </div>
                                <div className="rounded-xl bg-white px-3 py-2 text-slate-500">
                                    Match <span className="block font-mono text-slate-950">{intent.acceptedMatch ? shortAddress(intent.acceptedMatch) : intent.selectedQuote ? shortAddress(intent.selectedQuote) : intent.status === 'Computation Requested' ? 'Computing' : 'Pending'}</span>
                                </div>
                            </div>
                            {intent.quotes.length > 0 && (
                                <div className="mt-3 rounded-xl border border-slate-200 bg-white px-3 py-2 text-[11px] text-slate-500">
                                    Quotes attached
                                    <span className="ml-2 font-mono text-slate-950">
                                        {intent.quotes.map((quote) => shortAddress(quote.address)).join(', ')}
                                    </span>
                                </div>
                            )}
                            {settlementReceipts[intent.address] && (() => {
                                const receipt = settlementReceipts[intent.address];
                                return (
                                <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] text-emerald-800">
                                    <div className="font-semibold text-emerald-950">Private settlement receipt</div>
                                    <div className="mt-1 grid gap-1 font-mono sm:grid-cols-2">
                                        <span>Status {receipt.status}</span>
                                        <span>
                                            Size {(receipt.usdcBaseUnits ?? 0) / 10 ** USDC_DECIMALS} USDC - {(receipt.wsolBaseUnits ?? 0) / 10 ** SOL_DECIMALS} wSOL
                                        </span>
                                        {receipt.magicBlockSignature && (
                                            <span>MagicBlock {shortAddress(receipt.magicBlockSignature)}</span>
                                        )}
                                        {receipt.umbraQueueSignature && (
                                            <span>Umbra queue {shortAddress(receipt.umbraQueueSignature)}</span>
                                        )}
                                        {receipt.umbraCallbackSignature && (
                                            <span>Umbra callback {shortAddress(receipt.umbraCallbackSignature)}</span>
                                        )}
                                        {receipt.encryptedBalanceState && (
                                            <span>Encrypted balance {receipt.encryptedBalanceState}</span>
                                        )}
                                    </div>
                                </div>
                            )})()}
                            <div className="mt-3 flex flex-wrap gap-2 text-xs">
                                {intent.status === 'Open' && intent.quoteCount < intent.minQuoteCount && (
                                    <button
                                        onClick={() => onSubmitQuote(intent)}
                                        disabled={quoteSubmittingIntent === intent.address}
                                        className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-white px-3 py-1.5 font-semibold text-emerald-700 transition hover:bg-emerald-50 disabled:cursor-not-allowed disabled:text-slate-300"
                                    >
                                        {quoteSubmittingIntent === intent.address ? 'Submitting quote...' : 'Submit maker quote'}
                                    </button>
                                )}
                                {intent.status === 'Open' && intent.quoteCount < intent.minQuoteCount && (
                                    <button
                                        onClick={() => onSeedQuotes(intent)}
                                        disabled={quoteSubmittingIntent === intent.address}
                                        className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 font-semibold text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:text-slate-300"
                                    >
                                        {quoteSubmittingIntent === intent.address ? 'Adding quotes...' : `Add ${intent.minQuoteCount - intent.quoteCount} devnet maker quote${intent.minQuoteCount - intent.quoteCount === 1 ? '' : 's'}`}
                                    </button>
                                )}
                                {intent.status === 'Open' && intent.quoteCount >= intent.minQuoteCount && (
                                    <button
                                        onClick={() => onRequestMatch(intent)}
                                        disabled={matchingIntent === intent.address || intent.quotes.length < intent.minQuoteCount}
                                        className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 font-semibold text-emerald-700 transition hover:bg-emerald-100 disabled:cursor-not-allowed disabled:text-slate-300"
                                    >
                                        {matchingIntent === intent.address ? 'Running Arcium match...' : 'Run Arcium private match'}
                                    </button>
                                )}
                                {intent.status === 'Computation Requested' && (
                                    <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5 font-semibold text-amber-700">
                                        Arcium computation requested
                                    </span>
                                )}
                                {intent.status === 'Match Ready' && intent.selectedQuote && !intent.acceptedMatch && (
                                    <button
                                        onClick={() => onAcceptQuote(intent)}
                                        disabled={acceptingIntent === intent.address}
                                        className="inline-flex items-center gap-1.5 rounded-full border border-slate-950 bg-slate-950 px-3 py-1.5 font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
                                    >
                                        {acceptingIntent === intent.address ? 'Accepting quote...' : 'Accept selected quote'}
                                    </button>
                                )}
                                {intent.status === 'Accepted' && intent.selectedQuote && hasTwoRailPlan(intent) && (
                                    <button
                                        onClick={() => onTwoRailSettle(intent)}
                                        disabled={magicBlockSettlingIntent === intent.address || umbraShieldingIntent === intent.address}
                                        className="inline-flex items-center gap-1.5 rounded-full border border-slate-950 bg-slate-950 px-3 py-1.5 font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
                                    >
                                        {magicBlockSettlingIntent === intent.address || umbraShieldingIntent === intent.address
                                            ? 'Settling both rails...'
                                            : 'Settle USDC + shield wSOL'}
                                    </button>
                                )}
                                {intent.status === 'Accepted' && intent.selectedQuote && hasTwoRailPlan(intent) && (
                                    <button
                                        onClick={() => onMagicBlockSettle(intent)}
                                        disabled={magicBlockSettlingIntent === intent.address}
                                        className="inline-flex items-center gap-1.5 rounded-full border border-sky-200 bg-sky-50 px-3 py-1.5 font-semibold text-sky-700 transition hover:bg-sky-100 disabled:cursor-not-allowed disabled:text-slate-300"
                                    >
                                        {magicBlockSettlingIntent === intent.address ? 'Paying USDC...' : 'MagicBlock USDC leg'}
                                    </button>
                                )}
                                {intent.status === 'Accepted' && intent.selectedQuote && hasTwoRailPlan(intent) && (
                                    <button
                                        onClick={() => onUmbraShield(intent)}
                                        disabled={umbraShieldingIntent === intent.address}
                                        className="inline-flex items-center gap-1.5 rounded-full border border-teal-200 bg-teal-50 px-3 py-1.5 font-semibold text-teal-700 transition hover:bg-teal-100 disabled:cursor-not-allowed disabled:text-slate-300"
                                    >
                                        {umbraShieldingIntent === intent.address ? 'Shielding wSOL...' : 'Umbra wSOL payout'}
                                    </button>
                                )}
                                {intent.status === 'Accepted' && intent.selectedQuote && !hasTwoRailPlan(intent) && (
                                    <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 font-semibold text-slate-500">
                                        Two-rail settlement needs USDC to SOL
                                    </span>
                                )}
                                <a
                                    href={`https://explorer.solana.com/address/${intent.address}?cluster=devnet`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1.5 font-semibold text-slate-600 transition hover:text-slate-950"
                                >
                                    <ExternalLink className="h-3.5 w-3.5" />
                                    Intent account
                                </a>
                                {intent.signature && (
                                    <a
                                        href={`https://explorer.solana.com/tx/${intent.signature}?cluster=devnet`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1.5 font-semibold text-emerald-700 transition hover:text-emerald-900"
                                    >
                                        <ExternalLink className="h-3.5 w-3.5" />
                                        Latest tx
                                    </a>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

function PrivateSwapInterface({
    meshStatus,
    meshStatusError,
}: {
    meshStatus: VelvetMeshLiveStatus | null;
    meshStatusError: string | null;
}) {
    const { publicKey, connected, signTransaction, signMessage } = useWallet();
    const { connection } = useConnection();

    const [fromToken, setFromToken] = useState<TokenInfo>(TOKENS[1]);
    const [toToken, setToToken] = useState<TokenInfo>(TOKENS[0]);
    const [amount, setAmount] = useState('');
    const [estimatedOutput, setEstimatedOutput] = useState<string | null>(null);
    const [jupiterQuote, setJupiterQuote] = useState<JupiterQuote | null>(null);
    const [jupiterQuoteLoading, setJupiterQuoteLoading] = useState(false);
    const [jupiterQuoteError, setJupiterQuoteError] = useState<string | null>(null);
    const [chartDays, setChartDays] = useState<90 | 180>(180);
    const [coinGeckoChart, setCoinGeckoChart] = useState<CoinGeckoChart | null>(null);
    const [coinGeckoLoading, setCoinGeckoLoading] = useState(false);
    const [coinGeckoError, setCoinGeckoError] = useState<string | null>(null);

    const [step, setStep] = useState<SwapStep>('idle');
    const [statusMessage, setStatusMessage] = useState<string | null>(null);
    const [txSignature, setTxSignature] = useState<string | null>(null);
    const [intentResult, setIntentResult] = useState<VelvetMeshIntentResult | null>(null);
    const [intentHistory, setIntentHistory] = useState<VelvetMeshIntentHistoryItem[]>([]);
    const [intentHistoryLoading, setIntentHistoryLoading] = useState(false);
    const [intentHistoryError, setIntentHistoryError] = useState<string | null>(null);
    const [intentHistoryRefreshKey, setIntentHistoryRefreshKey] = useState(0);
    const [quoteSubmittingIntent, setQuoteSubmittingIntent] = useState<string | null>(null);
    const [matchingIntent, setMatchingIntent] = useState<string | null>(null);
    const [acceptingIntent, setAcceptingIntent] = useState<string | null>(null);
    const [magicBlockSettlingIntent, setMagicBlockSettlingIntent] = useState<string | null>(null);
    const [umbraShieldingIntent, setUmbraShieldingIntent] = useState<string | null>(null);
    const [settlementReceipts, setSettlementReceipts] = useState<Record<string, SettlementReceipt>>({});
    const [settlementPlans, setSettlementPlans] = useState<Record<string, SettlementPlan>>({});
    const [matcherQuoteInputs, setMatcherQuoteInputs] = useState<Record<string, ArciumMatcherQuoteInput>>({});
    const [privacyMode, setPrivacyMode] = useState(true);
    const [poolStatus, setPoolStatus] = useState<'checking' | 'ready' | 'not_found'>('checking');
    const [complianceResult, setComplianceResult] = useState<ComplianceResult | null>(null);
    const [complianceChecking, setComplianceChecking] = useState(false);
    const [solBalance, setSolBalance] = useState<number | null>(null);
    const [solBalanceLoading, setSolBalanceLoading] = useState(false);
    const [airdropLoading, setAirdropLoading] = useState(false);
    const [balances, setBalances] = useState<{ tokenA: string | null; tokenB: string | null }>({ tokenA: null, tokenB: null });
    const [balanceLoading, setBalanceLoading] = useState(false);
    const [userAccounts, setUserAccounts] = useState<{ tokenA: PublicKey | null; tokenB: PublicKey | null }>({ tokenA: null, tokenB: null });

    // Decrypted balance state
    const [decryptedBalances, setDecryptedBalances] = useState<{ tokenA: string | null; tokenB: string | null }>({ tokenA: null, tokenB: null });
    const [decryptLoading, setDecryptLoading] = useState(false);
    const [incoAccounts, setIncoAccounts] = useState<{ tokenA: IncoAccountInfo | null; tokenB: IncoAccountInfo | null }>({ tokenA: null, tokenB: null });

    // Allowance state
    const [approveLoading, setApproveLoading] = useState(false);
    const [approveStatus, setApproveStatus] = useState<string | null>(null);
    const [approveTx, setApproveTx] = useState<string | null>(null);

    // Check pool status on mount
    useEffect(() => {
        const checkPool = async () => {
            try {
                const pool = await fetchPoolState(DEVNET_WSOL_MINT, DEVNET_TEST_USDC_MINT);
                setPoolStatus(pool ? 'ready' : 'not_found');
            } catch (e) {
                console.warn('Pool check failed, assuming ready:', e);
                setPoolStatus('ready');
            }
        };
        checkPool();
    }, []);

    useEffect(() => {
        try {
            const savedQuoteInputs = window.localStorage.getItem(MATCHER_QUOTE_INPUTS_STORAGE_KEY);
            if (savedQuoteInputs) {
                setMatcherQuoteInputs(JSON.parse(savedQuoteInputs));
            }

            const savedPlans = window.localStorage.getItem(SETTLEMENT_PLANS_STORAGE_KEY);
            if (savedPlans) {
                setSettlementPlans(JSON.parse(savedPlans));
            }
        } catch (error) {
            console.warn('Failed to load local VelvetMesh settlement state:', error);
        }
    }, []);

    useEffect(() => {
        try {
            window.localStorage.setItem(MATCHER_QUOTE_INPUTS_STORAGE_KEY, JSON.stringify(matcherQuoteInputs));
        } catch (error) {
            console.warn('Failed to persist matcher quote inputs:', error);
        }
    }, [matcherQuoteInputs]);

    useEffect(() => {
        try {
            window.localStorage.setItem(SETTLEMENT_PLANS_STORAGE_KEY, JSON.stringify(settlementPlans));
        } catch (error) {
            console.warn('Failed to persist settlement plans:', error);
        }
    }, [settlementPlans]);

    // Check compliance when wallet connects
    useEffect(() => {
        const checkCompliance = async () => {
            if (!publicKey) {
                setComplianceResult(null);
                return;
            }
            setComplianceChecking(true);
            try {
                const result = await checkAddressCompliance(publicKey.toBase58());
                setComplianceResult(result);
            } catch (e) {
                console.warn('Compliance check failed:', e);
            } finally {
                setComplianceChecking(false);
            }
        };
        checkCompliance();
    }, [publicKey]);

    const refreshSolBalance = async () => {
        if (!publicKey || !connection) {
            setSolBalance(null);
            return null;
        }

        setSolBalanceLoading(true);
        try {
            const lamports = await connection.getBalance(publicKey, 'confirmed');
            const balance = lamports / LAMPORTS_PER_SOL;
            setSolBalance(balance);
            return balance;
        } finally {
            setSolBalanceLoading(false);
        }
    };

    useEffect(() => {
        refreshSolBalance().catch((error) => {
            console.warn('SOL balance check failed:', error);
            setSolBalance(null);
        });
    }, [publicKey, connection]);

    const handleAirdropSol = async () => {
        if (!publicKey || !connection) {
            setStatusMessage('Connect a devnet wallet first.');
            return;
        }

        setAirdropLoading(true);
        setStatusMessage('Requesting 1 devnet SOL...');
        try {
            const signature = await connection.requestAirdrop(publicKey, LAMPORTS_PER_SOL);
            await connection.confirmTransaction(signature, 'confirmed');
            await refreshSolBalance();
            setStatusMessage('Devnet SOL airdrop confirmed.');
        } catch (error: any) {
            setStep('error');
            setStatusMessage(`Airdrop failed: ${error?.message || 'Devnet faucet unavailable or rate limited.'}`);
        } finally {
            setAirdropLoading(false);
        }
    };

    useEffect(() => {
        let cancelled = false;

        const loadIntentHistory = async () => {
            if (!publicKey) {
                setIntentHistory([]);
                setIntentHistoryError(null);
                return;
            }

            setIntentHistoryLoading(true);
            setIntentHistoryError(null);
            try {
                const history = await fetchVelvetMeshIntentHistory(publicKey.toBase58());
                if (!cancelled) {
                    setIntentHistory(history.intents);
                }
            } catch (error: any) {
                if (!cancelled) {
                    setIntentHistory([]);
                    setIntentHistoryError(error?.message || 'Intent history unavailable');
                }
            } finally {
                if (!cancelled) {
                    setIntentHistoryLoading(false);
                }
            }
        };

        loadIntentHistory();

        return () => {
            cancelled = true;
        };
    }, [publicKey, intentHistoryRefreshKey]);

    // Fetch Inco token balances - check if accounts exist
    useEffect(() => {
        const fetchBalances = async () => {
            if (!publicKey || !connection) {
                setBalances({ tokenA: null, tokenB: null });
                setUserAccounts({ tokenA: null, tokenB: null });
                return;
            }

            // If we already have accounts from swap, just verify they exist
            if (userAccounts.tokenA && userAccounts.tokenB) {
                setBalances({ tokenA: '✓ Active', tokenB: '✓ Active' });
                return;
            }

            setBalanceLoading(true);
            try {
                const { findUserIncoAccounts } = await import('@/lib/inco-account-manager');
                console.log('Fetching balances for:', publicKey.toBase58());
                const accounts = await findUserIncoAccounts(connection, publicKey);
                console.log('Found accounts:', accounts);

                setUserAccounts(accounts);
                const balA = accounts.tokenA ? '✓ Active' : 'No account';
                const balB = accounts.tokenB ? '✓ Active' : 'No account';
                setBalances({ tokenA: balA, tokenB: balB });
            } catch (e) {
                console.warn('Failed to fetch balances:', e);
                setBalances({ tokenA: 'Error', tokenB: 'Error' });
            } finally {
                setBalanceLoading(false);
            }
        };
        fetchBalances();
    }, [publicKey, connection]);


    // Swap tokens
    const handleSwapTokens = () => {
        const temp = fromToken;
        setFromToken(toToken);
        setToToken(temp);
        setEstimatedOutput(null);
    };

    // Calculate estimated output
    useEffect(() => {
        if (!amount || parseFloat(amount) <= 0) {
            setEstimatedOutput(null);
            return;
        }

        const inputAmount = parseFloat(amount);
        const feeRate = 0.003;
        const rate = fromToken.symbol === 'SOL' ? 150 : 1/150;
        const outputAmount = inputAmount * rate * (1 - feeRate);
        setEstimatedOutput(outputAmount.toFixed(toToken.decimals > 6 ? 6 : toToken.decimals));
    }, [amount, fromToken, toToken]);

    useEffect(() => {
        if (!amount || parseFloat(amount) <= 0) {
            setJupiterQuote(null);
            setJupiterQuoteError(null);
            return;
        }

        let cancelled = false;
        const timeout = window.setTimeout(async () => {
            setJupiterQuoteLoading(true);
            setJupiterQuoteError(null);

            try {
                const params = new URLSearchParams({
                    inputSymbol: fromToken.symbol,
                    outputSymbol: toToken.symbol,
                    amount,
                });
                const response = await fetch(`/api/quotes/jupiter?${params}`, {
                    cache: 'no-store',
                });
                const body = await response.json();

                if (!response.ok) {
                    throw new Error(body?.error || `Jupiter quote failed: ${response.status}`);
                }

                if (!cancelled) {
                    setJupiterQuote(body as JupiterQuote);
                }
            } catch (error: any) {
                if (!cancelled) {
                    setJupiterQuote(null);
                    setJupiterQuoteError(error?.message || 'Jupiter quote unavailable');
                }
            } finally {
                if (!cancelled) {
                    setJupiterQuoteLoading(false);
                }
            }
        }, 350);

        return () => {
            cancelled = true;
            window.clearTimeout(timeout);
        };
    }, [amount, fromToken.symbol, toToken.symbol]);

    useEffect(() => {
        let cancelled = false;

        const loadChart = async () => {
            setCoinGeckoLoading(true);
            setCoinGeckoError(null);

            try {
                const response = await fetch(`/api/market/coingecko?days=${chartDays}`, {
                    cache: 'no-store',
                });
                const body = await response.json();

                if (!response.ok) {
                    throw new Error(body?.error || `CoinGecko chart failed: ${response.status}`);
                }

                if (!cancelled) {
                    setCoinGeckoChart(body as CoinGeckoChart);
                }
            } catch (error: any) {
                if (!cancelled) {
                    setCoinGeckoError(error?.message || 'CoinGecko chart unavailable');
                }
            } finally {
                if (!cancelled) {
                    setCoinGeckoLoading(false);
                }
            }
        };

        loadChart();

        return () => {
            cancelled = true;
        };
    }, [chartDays]);

    // Toggle privacy mode
    const togglePrivacy = () => setPrivacyMode(!privacyMode);

    // Sign and send transaction (supports both legacy and V0 versioned transactions)
    const signAndSend = async (tx: Transaction | VersionedTransaction, conn: Connection = connection): Promise<string> => {
        if (!signTransaction || !publicKey) throw new Error('Wallet not connected');

        if (tx instanceof VersionedTransaction) {
            // V0 transaction — already has blockhash from swap-client
            const signed = await signTransaction(tx) as VersionedTransaction;
            const signature = await conn.sendRawTransaction(signed.serialize());
            await conn.confirmTransaction(signature, 'confirmed');
            return signature;
        }

        // Legacy transaction
        tx.feePayer = publicKey;
        const { blockhash } = await conn.getLatestBlockhash();
        tx.recentBlockhash = blockhash;

        const signed = await signTransaction(tx);
        const signature = await conn.sendRawTransaction((signed as Transaction).serialize());
        await conn.confirmTransaction(signature, 'confirmed');
        return signature;
    };

    const handleCreatePrivateIntent = async () => {
        if (!publicKey || !signTransaction || !connection) {
            setStatusMessage('Please connect your wallet');
            return;
        }

        if (!amount || parseFloat(amount) <= 0) {
            setStatusMessage('Please enter a valid amount');
            return;
        }

        try {
            setStep('authenticating');
            setIntentResult(null);
            setTxSignature(null);
            setStatusMessage('Checking devnet SOL balance...');

            const currentBalance = await refreshSolBalance();
            if (currentBalance === null || currentBalance < MIN_INTENT_SOL_BALANCE) {
                throw new Error(`Wallet needs devnet SOL for rent and fees. Current balance: ${(currentBalance ?? 0).toFixed(4)} SOL. Request an airdrop or fund this wallet on devnet.`);
            }

            setStatusMessage('Checking wallet risk before creating intent...');

            const result = complianceResult ?? await checkAddressCompliance(publicKey.toBase58());
            setComplianceResult(result);
            if (!result.isCompliant) {
                throw new Error(`Compliance check failed: ${result.reasoning}`);
            }

            setStep('intenting');
            setStatusMessage('Creating VelvetMesh private intent on devnet...');

            const createdIntent = await createVelvetMeshIntent({
                connection,
                wallet: { publicKey, signTransaction },
                amount,
                inputSymbol: fromToken.symbol,
                outputSymbol: toToken.symbol,
            });
            const settlementPlan = buildUsdcToWsolSettlementPlan({
                inputSymbol: fromToken.symbol,
                outputSymbol: toToken.symbol,
                inputAmountUi: amount,
                outputAmountUi: jupiterQuote?.outAmountUi || estimatedOutput,
            });

            setIntentResult(createdIntent);
            if (settlementPlan) {
                setSettlementPlans((current) => ({
                    ...current,
                    [createdIntent.intent]: settlementPlan,
                }));
            }
            setTxSignature(createdIntent.signature);
            setIntentHistoryRefreshKey((key) => key + 1);
            setStep('complete');
            setStatusMessage('Private intent created on VelvetMesh devnet.');
        } catch (e: any) {
            console.error('Create private intent failed:', e);
            setStep('error');
            const message = e?.message || 'Unknown error';
            const fundedAccountMessage = message.includes('Attempt to debit an account but found no record of a prior credit')
                ? 'Wallet has no devnet SOL account yet. Request devnet SOL, wait for confirmation, then retry.'
                : message;
            setStatusMessage(`Intent failed: ${fundedAccountMessage}`);
        }
    };

    const handleSubmitMakerQuote = async (intent: VelvetMeshIntentHistoryItem) => {
        if (!publicKey || !signTransaction || !connection) {
            setStatusMessage('Connect a devnet wallet to submit a maker quote.');
            return;
        }

        try {
            setQuoteSubmittingIntent(intent.address);
            setStep('intenting');
            setStatusMessage(`Submitting maker quote for ${shortAddress(intent.address)}...`);

            const currentBalance = await refreshSolBalance();
            if (currentBalance === null || currentBalance < MIN_INTENT_SOL_BALANCE) {
                throw new Error(`Maker wallet needs devnet SOL for quote rent and fees. Current balance: ${(currentBalance ?? 0).toFixed(4)} SOL.`);
            }

            const quoteAmount = jupiterQuote?.outAmountUi
                || estimatedOutput
                || (intent.outputSymbol === 'USDC' ? '1' : '0.01');
            const result = await submitVelvetMeshQuote({
                connection,
                wallet: { publicKey, signTransaction },
                intent: intent.address,
                outputAmount: quoteAmount,
                outputSymbol: intent.outputSymbol,
            });

            setTxSignature(result.signature);
            setMatcherQuoteInputs((current) => ({
                ...current,
                [result.matcherInput.quote]: result.matcherInput,
            }));
            if (intent.inputSymbol === 'USDC' && intent.outputSymbol === 'SOL') {
                setSettlementPlans((current) => ({
                    ...current,
                    [intent.address]: {
                        ...(current[intent.address] ?? {
                            inputSymbol: intent.inputSymbol,
                            outputSymbol: intent.outputSymbol,
                            inputAmountUi: amount,
                            outputAmountUi: quoteAmount,
                            usdcBaseUnits: uiAmountToBaseUnits(amount, USDC_DECIMALS, 0),
                            wsolBaseUnits: Number(result.matcherInput.outputAmountAtoms),
                            updatedAt: Date.now(),
                        }),
                        outputAmountUi: quoteAmount,
                        wsolBaseUnits: Number(result.matcherInput.outputAmountAtoms),
                        updatedAt: Date.now(),
                    },
                }));
            }
            setIntentHistoryRefreshKey((key) => key + 1);
            setStep('complete');
            setStatusMessage(`Maker quote submitted: ${shortAddress(result.quote)}.`);
        } catch (e: any) {
            console.error('Submit maker quote failed:', e);
            setStep('error');
            const message = e?.message || 'Unknown error';
            const duplicateMessage = message.includes('already in use')
                ? 'This maker wallet already submitted a quote for that intent. Use another maker wallet or another intent.'
                : message;
            setStatusMessage(`Quote failed: ${duplicateMessage}`);
        } finally {
            setQuoteSubmittingIntent(null);
        }
    };

    const handleSeedDevnetMakerQuotes = async (intent: VelvetMeshIntentHistoryItem) => {
        if (!publicKey || !signTransaction || !connection) {
            setStatusMessage('Connect the intent owner wallet to fund devnet maker quote accounts.');
            return;
        }

        const missingQuotes = Math.max(0, intent.minQuoteCount - intent.quoteCount);
        if (missingQuotes === 0) {
            setStatusMessage('This intent already has enough quote accounts for matching.');
            return;
        }

        try {
            setQuoteSubmittingIntent(intent.address);
            setStep('intenting');
            setStatusMessage(`Funding and adding ${missingQuotes} live devnet maker quote${missingQuotes === 1 ? '' : 's'} for ${shortAddress(intent.address)}...`);

            const currentBalance = await refreshSolBalance();
            const requiredSol = missingQuotes * 0.045 + 0.02;
            if (currentBalance === null || currentBalance < requiredSol) {
                throw new Error(`Wallet needs about ${requiredSol.toFixed(3)} SOL to fund maker quote accounts. Current balance: ${(currentBalance ?? 0).toFixed(4)} SOL.`);
            }

            const quoteAmount = jupiterQuote?.outAmountUi
                || estimatedOutput
                || (intent.outputSymbol === 'USDC' ? '1' : '0.01');
            const results = await submitDevnetMakerQuotes({
                connection,
                ownerWallet: { publicKey, signTransaction },
                intent: intent.address,
                outputAmount: quoteAmount,
                outputSymbol: intent.outputSymbol,
                count: missingQuotes,
            });

            setTxSignature(results.at(-1)?.signature ?? null);
            setMatcherQuoteInputs((current) => ({
                ...current,
                ...Object.fromEntries(results.map((result) => [result.matcherInput.quote, result.matcherInput])),
            }));
            const firstQuote = results[0]?.matcherInput;
            if (firstQuote && intent.inputSymbol === 'USDC' && intent.outputSymbol === 'SOL') {
                setSettlementPlans((current) => ({
                    ...current,
                    [intent.address]: {
                        ...(current[intent.address] ?? {
                            inputSymbol: intent.inputSymbol,
                            outputSymbol: intent.outputSymbol,
                            inputAmountUi: amount,
                            outputAmountUi: quoteAmount,
                            usdcBaseUnits: uiAmountToBaseUnits(amount, USDC_DECIMALS, 0),
                            wsolBaseUnits: Number(firstQuote.outputAmountAtoms),
                            updatedAt: Date.now(),
                        }),
                        outputAmountUi: quoteAmount,
                        wsolBaseUnits: Number(firstQuote.outputAmountAtoms),
                        updatedAt: Date.now(),
                    },
                }));
            }
            setIntentHistoryRefreshKey((key) => key + 1);
            setStep('complete');
            setStatusMessage(`Added ${results.length} real devnet maker quote${results.length === 1 ? '' : 's'}; intent is ready when history shows ${intent.minQuoteCount}/${intent.minQuoteCount}.`);
        } catch (e: any) {
            console.error('Add devnet maker quotes failed:', e);
            setStep('error');
            setStatusMessage(`Devnet maker quotes failed: ${e?.message || 'Unknown error'}`);
        } finally {
            setQuoteSubmittingIntent(null);
        }
    };

    const getMatcherQuoteInputsForIntent = (intent: VelvetMeshIntentHistoryItem): ArciumMatcherQuoteInput[] => {
        const quoteAmount = jupiterQuote?.outAmountUi
            || estimatedOutput
            || (intent.outputSymbol === 'USDC' ? '1' : '0.01');
        const parsed = Number(quoteAmount);
        const decimals = intent.outputSymbol === 'SOL' ? 9 : 6;

        return intent.quotes.slice(0, 3).map((quote, index) => {
            const cached = matcherQuoteInputs[quote.address];
            if (cached) return cached;

            const outputAmountAtoms = Math.max(1, Math.floor((Number.isFinite(parsed) && parsed > 0 ? parsed : 1) * (1 + index * 0.0025) * 10 ** decimals));
            return {
                quote: quote.address,
                outputAmountAtoms: String(outputAmountAtoms),
                riskBps: 20,
                route: 0,
            };
        });
    };

    const handleRequestPrivateMatch = async (intent: VelvetMeshIntentHistoryItem) => {
        if (!publicKey || !signTransaction || !connection) {
            setStatusMessage('Connect the owner wallet to request private matching.');
            return;
        }

        if (intent.quoteCount < intent.minQuoteCount || intent.quotes.length < intent.minQuoteCount) {
            setStatusMessage('This intent needs enough on-chain quotes before private matching can be requested.');
            return;
        }

        try {
            setMatchingIntent(intent.address);
            setStep('intenting');
            setStatusMessage(`Requesting private match computation for ${shortAddress(intent.address)}...`);

            const currentBalance = await refreshSolBalance();
            if (currentBalance === null || currentBalance < MIN_INTENT_SOL_BALANCE) {
                throw new Error(`Owner wallet needs devnet SOL for fees. Current balance: ${(currentBalance ?? 0).toFixed(4)} SOL.`);
            }

            const result = await requestVelvetMeshPrivateMatch({
                connection,
                wallet: { publicKey, signTransaction },
                intent: intent.address,
                quotes: getMatcherQuoteInputsForIntent(intent),
            });

            setTxSignature(result.finalizationSignature ?? result.matcherSignature ?? result.signature);
            setIntentHistoryRefreshKey((key) => key + 1);
            setStep(result.finalizationWarning ? 'pending' : 'complete');
            setStatusMessage(result.finalizationWarning
                ? `Arcium matcher queued for ${shortAddress(intent.address)}; finalization is still pending.`
                : `Arcium private match finalized for ${shortAddress(intent.address)}.`);
        } catch (e: any) {
            console.error('Request private match failed:', e);
            setStep('error');
            setStatusMessage(`Match request failed: ${e?.message || 'Unknown error'}`);
        } finally {
            setMatchingIntent(null);
        }
    };

    const handleAcceptSelectedQuote = async (intent: VelvetMeshIntentHistoryItem) => {
        if (!publicKey || !signTransaction || !connection) {
            setStatusMessage('Connect the owner wallet to accept the selected quote.');
            return;
        }

        if (!intent.selectedQuote) {
            setStatusMessage('Arcium has not selected a quote for this intent yet.');
            return;
        }

        try {
            setAcceptingIntent(intent.address);
            setStep('intenting');
            setStatusMessage(`Accepting selected quote ${shortAddress(intent.selectedQuote)}...`);

            const currentBalance = await refreshSolBalance();
            if (currentBalance === null || currentBalance < MIN_INTENT_SOL_BALANCE) {
                throw new Error(`Owner wallet needs devnet SOL for accepted match rent and fees. Current balance: ${(currentBalance ?? 0).toFixed(4)} SOL.`);
            }

            const result = await acceptVelvetMeshQuote({
                connection,
                wallet: { publicKey, signTransaction },
                intent: intent.address,
                quote: intent.selectedQuote,
            });

            setTxSignature(result.signature);
            setIntentHistoryRefreshKey((key) => key + 1);
            setStep('complete');
            setStatusMessage(`Selected quote accepted. Match ${shortAddress(result.acceptedMatch)} is recorded on devnet.`);
        } catch (e: any) {
            console.error('Accept selected quote failed:', e);
            setStep('error');
            setStatusMessage(`Accept quote failed: ${e?.message || 'Unknown error'}`);
        } finally {
            setAcceptingIntent(null);
        }
    };

    const getTwoRailSettlementAmounts = (intent: VelvetMeshIntentHistoryItem) => {
        const currentPlan = settlementPlans[intent.address]
            ?? buildUsdcToWsolSettlementPlan({
                inputSymbol: intent.inputSymbol,
                outputSymbol: intent.outputSymbol,
                inputAmountUi: amount,
                outputAmountUi: jupiterQuote?.outAmountUi || estimatedOutput,
            });

        if (currentPlan?.inputSymbol !== 'USDC' || currentPlan.outputSymbol !== 'SOL') {
            return null;
        }

        const selectedQuoteInput = intent.selectedQuote ? matcherQuoteInputs[intent.selectedQuote] : null;
        const usdcBaseUnits = currentPlan.usdcBaseUnits;
        const wsolBaseUnits = selectedQuoteInput?.outputAmountAtoms
            ? Math.max(1, Number(selectedQuoteInput.outputAmountAtoms))
            : currentPlan.wsolBaseUnits;

        if (usdcBaseUnits < 1 || wsolBaseUnits < 1) {
            return null;
        }

        return { usdcBaseUnits, wsolBaseUnits };
    };

    const updateSettlementReceipt = (intentAddress: string, receipt: Partial<SettlementReceipt>) => {
        setSettlementReceipts((current) => ({
            ...current,
            [intentAddress]: {
                ...current[intentAddress],
                ...receipt,
                status: receipt.status ?? current[intentAddress]?.status ?? 'magicblock-confirmed',
                updatedAt: Date.now(),
            },
        }));
    };

    const handleMagicBlockPrivateSettlement = async (intent: VelvetMeshIntentHistoryItem) => {
        if (!publicKey || !signTransaction || !connection) {
            setStatusMessage('Connect the owner wallet to sign the MagicBlock private payment.');
            return;
        }

        const selectedQuote = intent.quotes.find((quote) => quote.address === intent.selectedQuote);
        if (!selectedQuote) {
            setStatusMessage('Selected maker quote is missing from local history. Reload and retry.');
            return;
        }

        const settlementAmounts = getTwoRailSettlementAmounts(intent);
        if (!settlementAmounts) {
            setStatusMessage('No valid USDC to SOL settlement plan found for this intent. Create a fresh USDC -> SOL intent and wait for the Jupiter quote before settling.');
            return;
        }
        const { usdcBaseUnits, wsolBaseUnits } = settlementAmounts;

        try {
            setMagicBlockSettlingIntent(intent.address);
            setStep('intenting');
            setStatusMessage(`Preparing MagicBlock private payment for ${shortAddress(intent.address)}...`);

            const result = await settleWithMagicBlockPrivatePayment({
                connection,
                wallet: { publicKey, signTransaction },
                recipient: selectedQuote.maker,
                clientRefId: intent.nonce,
                amount: usdcBaseUnits,
            });

            updateSettlementReceipt(intent.address, {
                status: 'magicblock-confirmed',
                usdcBaseUnits,
                wsolBaseUnits,
                magicBlockSignature: result.signature,
            });
            setTxSignature(result.signature);
            setStep('complete');
            setStatusMessage(`MagicBlock private payment sent via ${result.provider}.`);
        } catch (e: any) {
            console.error('MagicBlock private settlement failed:', e);
            setStep('error');
            setStatusMessage(`MagicBlock settlement failed: ${e?.message || 'Unknown error'}. Make sure this wallet has devnet USDC.`);
        } finally {
            setMagicBlockSettlingIntent(null);
        }
    };

    const handleUmbraShieldedSettlement = async (intent: VelvetMeshIntentHistoryItem) => {
        if (!publicKey) {
            setStatusMessage('Connect the owner wallet so the wSOL payout can be shielded to your wallet.');
            return;
        }

        const selectedQuote = intent.quotes.find((quote) => quote.address === intent.selectedQuote);
        if (!selectedQuote) {
            setStatusMessage('Selected maker quote is missing from local history. Reload and retry.');
            return;
        }

        const settlementAmounts = getTwoRailSettlementAmounts(intent);
        if (!settlementAmounts) {
            setStatusMessage('No valid USDC to SOL settlement plan found for this intent. Create a fresh USDC -> SOL intent and wait for the Jupiter quote before settling.');
            return;
        }
        const { usdcBaseUnits, wsolBaseUnits } = settlementAmounts;

        try {
            setUmbraShieldingIntent(intent.address);
            setStep('intenting');
            setStatusMessage(`Shielding settlement value in Umbra for ${shortAddress(intent.address)}...`);

            const result = await shieldSettlementWithUmbra({
                destination: publicKey.toBase58(),
                intent: intent.address,
                amountBaseUnits: wsolBaseUnits,
            });

            updateSettlementReceipt(intent.address, {
                status: 'umbra-confirmed',
                usdcBaseUnits,
                wsolBaseUnits,
                umbraWrapSignature: result.wrapSignature,
                umbraQueueSignature: result.queueSignature,
                umbraCallbackSignature: result.callbackSignature,
                encryptedBalanceState: result.encryptedBalance?.state,
            });
            setTxSignature(result.callbackSignature || result.queueSignature);
            setStep('complete');
            setStatusMessage(`Umbra encrypted-balance deposit queued via ${result.provider}.`);
        } catch (e: any) {
            console.error('Umbra shielded settlement failed:', e);
            setStep('error');
            setStatusMessage(`Umbra settlement failed: ${e?.message || 'Unknown error'}`);
        } finally {
            setUmbraShieldingIntent(null);
        }
    };

    const handleTwoRailPrivateSettlement = async (intent: VelvetMeshIntentHistoryItem) => {
        if (!publicKey || !signTransaction || !connection) {
            setStatusMessage('Connect the owner wallet to settle both private rails.');
            return;
        }

        const selectedQuote = intent.quotes.find((quote) => quote.address === intent.selectedQuote);
        if (!selectedQuote) {
            setStatusMessage('Selected maker quote is missing from local history. Reload and retry.');
            return;
        }

        const settlementAmounts = getTwoRailSettlementAmounts(intent);
        if (!settlementAmounts) {
            setStatusMessage('No valid USDC to SOL settlement plan found for this intent. Create a fresh USDC -> SOL intent and wait for the Jupiter quote before settling.');
            return;
        }
        const { usdcBaseUnits, wsolBaseUnits } = settlementAmounts;

        try {
            setMagicBlockSettlingIntent(intent.address);
            setUmbraShieldingIntent(intent.address);
            setStep('intenting');
            setStatusMessage(`Settling ${usdcBaseUnits / 10 ** USDC_DECIMALS} USDC privately, then shielding ${wsolBaseUnits / 10 ** SOL_DECIMALS} wSOL payout...`);

            const magicBlockResult = await settleWithMagicBlockPrivatePayment({
                connection,
                wallet: { publicKey, signTransaction },
                recipient: selectedQuote.maker,
                clientRefId: intent.nonce,
                amount: usdcBaseUnits,
            });

            updateSettlementReceipt(intent.address, {
                status: 'magicblock-confirmed',
                usdcBaseUnits,
                wsolBaseUnits,
                magicBlockSignature: magicBlockResult.signature,
            });
            setTxSignature(magicBlockResult.signature);
            setStatusMessage(`USDC leg confirmed via ${magicBlockResult.provider}. Shielding wSOL payout in Umbra...`);

            const umbraResult = await shieldSettlementWithUmbra({
                destination: publicKey.toBase58(),
                intent: intent.address,
                amountBaseUnits: wsolBaseUnits,
            });

            updateSettlementReceipt(intent.address, {
                status: 'complete',
                usdcBaseUnits,
                wsolBaseUnits,
                magicBlockSignature: magicBlockResult.signature,
                umbraWrapSignature: umbraResult.wrapSignature,
                umbraQueueSignature: umbraResult.queueSignature,
                umbraCallbackSignature: umbraResult.callbackSignature,
                encryptedBalanceState: umbraResult.encryptedBalance?.state,
            });
            setTxSignature(umbraResult.callbackSignature || umbraResult.queueSignature || magicBlockResult.signature);
            setStep('complete');
            setStatusMessage(`Two-rail settlement complete: MagicBlock USDC payment + Umbra wSOL payout (${umbraResult.encryptedBalance?.state ?? 'queued'}).`);
        } catch (e: any) {
            console.error('Two-rail private settlement failed:', e);
            updateSettlementReceipt(intent.address, {
                status: 'failed',
                usdcBaseUnits,
                wsolBaseUnits,
            });
            setStep('error');
            setStatusMessage(`Two-rail settlement failed: ${e?.message || 'Unknown error'}`);
        } finally {
            setMagicBlockSettlingIntent(null);
            setUmbraShieldingIntent(null);
        }
    };

    // Private swap flow with Inco Token transfers
    const handlePrivateSwap = async () => {
        if (!publicKey || !signMessage || !signTransaction) {
            setStatusMessage('Please connect your wallet');
            return;
        }

        if (!amount || parseFloat(amount) <= 0) {
            setStatusMessage('Please enter a valid amount');
            return;
        }

        const inputAmount = Math.floor(parseFloat(amount) * Math.pow(10, fromToken.decimals));

        try {
            // Step 0: Check compliance with Range Protocol
            setStep('authenticating');
            setStatusMessage('Checking compliance with Range Protocol...');
            
            if (!complianceResult) {
                const result = await checkAddressCompliance(publicKey.toBase58());
                setComplianceResult(result);
                if (!result.isCompliant) {
                    throw new Error(`Compliance check failed: ${result.reasoning}`);
                }
            } else if (!complianceResult.isCompliant) {
                throw new Error(`Compliance check failed: ${complianceResult.reasoning}`);
            }

            // Step 1: Ensure user has Inco Token accounts
            setStatusMessage('Setting up confidential token accounts...');
            
            const { tokenA: userTokenA, tokenB: userTokenB, created } = await ensureUserIncoAccounts(
                connection,
                { publicKey, signTransaction },
                (msg) => setStatusMessage(msg)
            );

            // Store account addresses for balance display
            setUserAccounts({ tokenA: userTokenA, tokenB: userTokenB });
            setBalances({ tokenA: '✓ Active', tokenB: '✓ Active' });

            if (created) {
                setStatusMessage('Token accounts created! Preparing swap...');
            }

            // Step 2: Compute swap quote
            setStatusMessage('Computing confidential swap quote...');
            
            const { amountOut, feeAmount } = computeSwapQuote(
                BigInt(inputAmount),
                BigInt(1_000_000_000_000), // Reserve A - in production fetch from pool
                BigInt(100_000_000_000),   // Reserve B
                30n // 0.3% fee
            );
            
            // Encrypt amounts using Inco SDK ECIES encryption
            const amountInCiphertext = await encryptAmount(BigInt(inputAmount));
            const amountOutCiphertext = await encryptAmount(amountOut);
            const feeAmountCiphertext = await encryptAmount(feeAmount);

            // Step 3: Execute swap with Inco Token transfers
            setStep('swapping');
            setStatusMessage('Executing confidential swap with token transfers...');

            const swapTx = await swapExactIn({
                connection,
                wallet: { publicKey, signTransaction },
                mintA: DEVNET_INCO_MINT_A,
                mintB: DEVNET_INCO_MINT_B,
                amountInCiphertext,
                amountOutCiphertext,
                feeAmountCiphertext,
                aToB: fromToken.symbol === 'SOL',
                userTokenA,
                userTokenB,
                poolVaultA: DEVNET_POOL_VAULT_A,
                poolVaultB: DEVNET_POOL_VAULT_B,
            });
            
            const sig = await signAndSend(swapTx, connection);
            setTxSignature(sig);

            setStep('complete');
            setStatusMessage('Private swap completed! Tokens transferred.');
        } catch (e: any) {
            console.error('Private swap failed:', e);
            setStep('error');
            setStatusMessage(`Swap failed: ${e?.message || 'Unknown error'}`);
        }
    };

    // Reset
    const handleReset = () => {
        setStep('idle');
        setStatusMessage(null);
        setTxSignature(null);
        setIntentResult(null);
        setIntentHistoryRefreshKey((key) => key + 1);
        setAmount('');
        setEstimatedOutput(null);
    };

    // Decrypt balances using Inco SDK attested reveal
    // Automatically grants decrypt access if needed (simulate → derive PDA → execute)
    const handleDecryptBalances = async () => {
        if (!publicKey || !signMessage || !signTransaction || !connection) return;
        
        setDecryptLoading(true);
        setDecryptedBalances({ tokenA: null, tokenB: null });
        try {
            // Fetch accounts with encrypted handles
            const accounts = await fetchUserIncoAccounts(connection, publicKey);
            setIncoAccounts(accounts);
            
            if (!accounts.tokenA && !accounts.tokenB) {
                setDecryptedBalances({ tokenA: 'No account', tokenB: 'No account' });
                return;
            }

            // Auto-grant decrypt access if needed (transparent to user)
            // This does simulate → derive PDA → mint_to with allowance remaining_accounts
            // Only works if connected wallet is the mint authority; otherwise falls back gracefully
            const walletForAccess = { publicKey, signTransaction };
            let accessA = true;
            let accessB = true;
            if (accounts.tokenA && accounts.tokenA.amountHandle !== '0') {
                accessA = await ensureDecryptAccess(
                    connection, walletForAccess,
                    accounts.tokenA.pubkey, accounts.tokenA.mint,
                    (msg) => console.log('[access-A]', msg)
                );
            }
            if (accounts.tokenB && accounts.tokenB.amountHandle !== '0') {
                accessB = await ensureDecryptAccess(
                    connection, walletForAccess,
                    accounts.tokenB.pubkey, accounts.tokenB.mint,
                    (msg) => console.log('[access-B]', msg)
                );
            }

            // Re-fetch handles directly with confirmed commitment
            // (getProgramAccounts can return stale data after burn(0) changes the handle)
            const handles: string[] = [];
            const mapping: ('a' | 'b')[] = [];

            if (accessA && accounts.tokenA && accounts.tokenA.amountHandle !== '0') {
                const fresh = await connection.getAccountInfo(accounts.tokenA.pubkey, 'confirmed');
                if (fresh) {
                    const parsed = parseIncoAccountData(fresh.data as Buffer);
                    if (parsed.amountHandle !== '0') {
                        handles.push(parsed.amountHandle);
                        mapping.push('a');
                        console.log('[decrypt] Token A handle:', parsed.amountHandle);
                    }
                }
            }
            if (accessB && accounts.tokenB && accounts.tokenB.amountHandle !== '0') {
                const fresh = await connection.getAccountInfo(accounts.tokenB.pubkey, 'confirmed');
                if (fresh) {
                    const parsed = parseIncoAccountData(fresh.data as Buffer);
                    if (parsed.amountHandle !== '0') {
                        handles.push(parsed.amountHandle);
                        mapping.push('b');
                        console.log('[decrypt] Token B handle:', parsed.amountHandle);
                    }
                }
            }

            const result: { tokenA: string | null; tokenB: string | null } = {
                tokenA: !accounts.tokenA ? 'No account'
                    : accounts.tokenA.amountHandle === '0' ? '0'
                    : !accessA ? 'Access pending (run grant-balance-access script)'
                    : null,
                tokenB: !accounts.tokenB ? 'No account'
                    : accounts.tokenB.amountHandle === '0' ? '0'
                    : !accessB ? 'Access pending (run grant-balance-access script)'
                    : null,
            };

            if (handles.length === 0) {
                setDecryptedBalances({
                    tokenA: result.tokenA || '0',
                    tokenB: result.tokenB || '0',
                });
                return;
            }

            // Call attested decrypt - requires wallet signature
            const plaintexts = await decryptBalances(handles, publicKey, signMessage);
            
            plaintexts.forEach((pt, i) => {
                if (mapping[i] === 'a') result.tokenA = formatBalance(pt, 9);
                if (mapping[i] === 'b') result.tokenB = formatBalance(pt, 6);
            });
            
            setDecryptedBalances({
                tokenA: result.tokenA || '0',
                tokenB: result.tokenB || '0',
            });
        } catch (e: any) {
            console.error('Decrypt failed:', e);
            setDecryptedBalances({ tokenA: 'Error', tokenB: 'Error' });
        } finally {
            setDecryptLoading(false);
        }
    };

    // Approve pool authority to spend tokens
    const handleApprove = async (tokenType: 'a' | 'b') => {
        if (!publicKey || !signTransaction || !connection) return;
        
        const account = tokenType === 'a' ? (incoAccounts.tokenA || userAccounts.tokenA) : (incoAccounts.tokenB || userAccounts.tokenB);
        const accountPubkey = account && 'pubkey' in account ? (account as IncoAccountInfo).pubkey : account as PublicKey | null;
        
        if (!accountPubkey) {
            setApproveStatus('No token account found. Create one first by initiating a swap.');
            return;
        }

        setApproveLoading(true);
        setApproveStatus(null);
        setApproveTx(null);
        try {
            // Approve max amount (u128 max / 2 for safety)
            const maxAmount = BigInt('170141183460469231731687303715884105727'); // ~u128 max / 2
            const sig = await approvePoolAuthority(
                connection,
                { publicKey, signTransaction },
                accountPubkey,
                maxAmount,
                (msg) => setApproveStatus(msg),
            );
            setApproveTx(sig);
            setApproveStatus(`Approved ${tokenType === 'a' ? 'SOL' : 'USDC'} allowance!`);
        } catch (e: any) {
            console.error('Approve failed:', e);
            setApproveStatus(`Approve failed: ${e.message}`);
        } finally {
            setApproveLoading(false);
        }
    };

    const isProcessing = !['idle', 'pending', 'complete', 'error'].includes(step);
    const canSwap = connected && amount && parseFloat(amount) > 0 && !isProcessing;

    return (
        <div className="grid w-full gap-6 rounded-[2rem] border border-slate-200 bg-white/80 p-5 shadow-[0_24px_80px_rgba(15,23,42,0.08)] backdrop-blur-xl lg:grid-cols-[320px_1fr]">
            <div className="rounded-[1.5rem] border border-slate-200 bg-white p-5 shadow-sm">
            {/* Header */}
            <div className="mb-3 flex items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                    {['Swap', 'Limit', 'Buy', 'Sell'].map((tab, index) => (
                        <button
                            key={tab}
                            className={`rounded-full px-3 py-1.5 text-sm font-semibold transition ${
                                index === 0
                                    ? 'bg-slate-950 text-white'
                                    : 'text-slate-500 hover:bg-slate-100 hover:text-slate-950'
                            }`}
                        >
                            {tab}
                        </button>
                    ))}
                </div>
                <button className="grid h-9 w-9 place-items-center rounded-full text-slate-400 transition hover:bg-slate-100 hover:text-slate-950">
                    <Settings className="h-5 w-5" />
                </button>
            </div>

            <div className="mb-4 rounded-2xl border border-emerald-200 bg-emerald-50 px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-emerald-700">
                        <Shield className="h-3.5 w-3.5" />
                        {meshStatusError ? 'Backend unavailable' : meshStatus ? 'VelvetMesh live' : 'Checking backend'}
                    </div>
                    <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-slate-500">
                        {meshStatus?.magicBlockRouterReady ? 'MagicBlock router ready' : meshStatus ? 'Arcium matcher ready' : 'VelvetMesh'}
                    </span>
                </div>
            </div>

            <div className="space-y-2">
                <button
                    onClick={togglePrivacy}
                    className="hidden"
                >
                    {privacyMode ? (
                        <>
                            <EyeOff className="w-3.5 h-3.5 text-primary" />
                            <span className="text-primary">Hidden</span>
                        </>
                    ) : (
                        <>
                            <Eye className="w-3.5 h-3.5 text-muted-foreground" />
                            <span className="text-muted-foreground">Visible</span>
                        </>
                    )}
                </button>

            {/* From Token */}
            <div className="token-input overflow-hidden">
                <div className="flex items-center justify-between text-sm text-muted-foreground mb-3">
                    <span>Sell</span>
                    <span className="text-xs">
                        {balanceLoading ? '...' : (fromToken.symbol === 'SOL' ? (balances.tokenA || '--') : (balances.tokenB || '--'))}
                    </span>
                </div>
                <div className="flex items-center gap-3">
                    <input
                        type="number"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        placeholder="0.0"
                        className="flex-1 min-w-0 bg-transparent text-3xl font-semibold tracking-[-0.04em] outline-none placeholder:text-muted-foreground/30"
                        disabled={isProcessing}
                    />
                    <button className="flex-shrink-0 flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2.5 font-medium text-slate-950 shadow-sm transition-colors hover:bg-slate-50">
                        <span className="text-lg">{fromToken.icon}</span>
                        <span>{fromToken.symbol}</span>
                    </button>
                </div>
            </div>

            {/* Swap Arrow */}
            <div className="flex justify-center -my-1 relative z-10">
                <button
                    onClick={handleSwapTokens}
                    className="swap-arrow"
                    disabled={isProcessing}
                >
                    <ArrowDownUp className="w-4 h-4" />
                </button>
            </div>

            {/* To Token */}
            <div className="token-input overflow-hidden">
                <div className="flex items-center justify-between text-sm text-muted-foreground mb-3">
                    <span>Buy</span>
                    <span className="text-xs">
                        {balanceLoading ? '...' : (toToken.symbol === 'SOL' ? (balances.tokenA || '--') : (balances.tokenB || '--'))}
                    </span>
                </div>
                <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0 text-3xl font-semibold tracking-[-0.04em]">
                        {estimatedOutput ? (
                            <span className="flex items-center gap-2">
                                <span className="text-slate-950">~{jupiterQuote?.outAmountUi ?? estimatedOutput}</span>
                                {privacyMode && <EyeOff className="w-4 h-4 text-muted-foreground" />}
                            </span>
                        ) : (
                            <span className="text-muted-foreground/30">0.0</span>
                        )}
                    </div>
                    <button className="flex-shrink-0 flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2.5 font-medium text-slate-950 shadow-sm transition-colors hover:bg-slate-50">
                        <span className="text-lg">{toToken.icon}</span>
                        <span>{toToken.symbol}</span>
                    </button>
                </div>
            </div>
            </div>

            {/* Compact Status Row */}
            <div className="flex items-center justify-between px-1 pt-3 text-xs">
                <div className="flex items-center gap-1.5">
                    {poolStatus === 'checking' ? (
                        <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
                    ) : poolStatus === 'ready' ? (
                        <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                    ) : (
                        <div className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                    )}
                    <span className="text-muted-foreground">
                        {poolStatus === 'ready' ? 'Pool active' : poolStatus === 'checking' ? 'Checking...' : 'Initializing'}
                    </span>
                </div>
                {connected && (
                    <div className="flex items-center gap-1.5">
                        {complianceChecking ? (
                            <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
                        ) : complianceResult?.isCompliant ? (
                            <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                        ) : complianceResult ? (
                            <div className="w-1.5 h-1.5 rounded-full bg-red-500" />
                        ) : (
                            <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50" />
                        )}
                        <span className="text-muted-foreground">
                            {complianceChecking ? 'Checking...' : 
                             complianceResult?.isCompliant ? `Compliant` : 
                             complianceResult ? 'Blocked' : 'No API key'}
                        </span>
                    </div>
                )}
            </div>

            {connected && (
                <div className="mt-3 flex items-center justify-between rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
                    <div className="text-slate-500">
                        Devnet SOL
                        <span className="ml-2 font-mono text-slate-950">
                            {solBalanceLoading ? 'checking...' : solBalance === null ? '--' : `${solBalance.toFixed(4)} SOL`}
                        </span>
                    </div>
                    <button
                        onClick={handleAirdropSol}
                        disabled={airdropLoading}
                        className="rounded-full border border-emerald-200 bg-white px-3 py-1.5 font-semibold text-emerald-700 transition hover:bg-emerald-50 disabled:cursor-not-allowed disabled:text-slate-300"
                    >
                        {airdropLoading ? 'Airdropping...' : 'Get devnet SOL'}
                    </button>
                </div>
            )}

            {/* Intent Button */}
            <button
                onClick={handleCreatePrivateIntent}
                disabled={!canSwap}
                className={`w-full rounded-2xl py-4 text-base font-semibold tracking-[-0.02em] transition-all duration-300 ${
                    canSwap
                        ? 'bg-emerald-500 text-white hover:bg-emerald-600 btn-glow'
                        : 'bg-slate-100 text-slate-400 cursor-not-allowed'
                }`}
            >
                {!connected ? (
                    <span className="flex items-center justify-center gap-2">
                        Connect Wallet
                    </span>
                ) : isProcessing ? (
                    <span className="flex items-center justify-center gap-2">
                        <Loader2 className="w-5 h-5 animate-spin" />
                        {step === 'authenticating' && 'Checking compliance...'}
                        {step === 'intenting' && 'Creating intent...'}
                        {step === 'swapping' && 'Executing fallback swap...'}
                    </span>
                ) : (
                    <span className="flex items-center justify-center gap-2">
                        <Lock className="w-5 h-5" />
                        Create Private Intent
                    </span>
                )}
            </button>

            <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-3">
                <button
                    onClick={togglePrivacy}
                    className="flex w-full items-center justify-between text-sm"
                >
                    <span className="flex items-center gap-2 text-slate-500">
                        {privacyMode ? <EyeOff className="h-4 w-4 text-emerald-600" /> : <Eye className="h-4 w-4 text-slate-500" />}
                        Quote visibility
                    </span>
                    <span className="font-mono text-xs uppercase tracking-[0.18em] text-emerald-700">
                        {privacyMode ? 'Hidden' : 'Visible'}
                    </span>
                </button>
                <div className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
                    <div className="rounded-xl bg-white px-2 py-2 text-slate-500">
                        Fee <span className="block font-mono text-slate-950">0.30%</span>
                    </div>
                    <div className="rounded-xl bg-white px-2 py-2 text-slate-500">
                        Route <span className="block font-mono text-slate-950">Private</span>
                    </div>
                    <div className="rounded-xl bg-white px-2 py-2 text-slate-500">
                        Leak <span className="block font-mono text-slate-950">None</span>
                    </div>
                </div>
            </div>
            </div>

            <div className="space-y-6">
            <DevnetQuotePanel
                amount={amount}
                estimatedOutput={estimatedOutput}
                jupiterQuote={jupiterQuote}
                jupiterQuoteLoading={jupiterQuoteLoading}
                jupiterQuoteError={jupiterQuoteError}
                coinGeckoChart={coinGeckoChart}
                coinGeckoLoading={coinGeckoLoading}
                coinGeckoError={coinGeckoError}
                chartDays={chartDays}
                setChartDays={setChartDays}
                fromToken={fromToken}
                toToken={toToken}
                meshStatus={meshStatus}
            />

            <TradeProgressPanel
                step={step}
                statusMessage={statusMessage}
                isProcessing={isProcessing}
                txSignature={txSignature}
                intentResult={intentResult}
                onReset={handleReset}
            />

            </div>

            <div className="lg:col-span-2">
                <IntentHistoryPanel
                    connected={connected}
                    intents={intentHistory}
                    loading={intentHistoryLoading}
                    error={intentHistoryError}
                    onReload={() => setIntentHistoryRefreshKey((key) => key + 1)}
                    onSubmitQuote={handleSubmitMakerQuote}
                    onSeedQuotes={handleSeedDevnetMakerQuotes}
                    onRequestMatch={handleRequestPrivateMatch}
                    onAcceptQuote={handleAcceptSelectedQuote}
                    onMagicBlockSettle={handleMagicBlockPrivateSettlement}
                    onUmbraShield={handleUmbraShieldedSettlement}
                    onTwoRailSettle={handleTwoRailPrivateSettlement}
                    quoteSubmittingIntent={quoteSubmittingIntent}
                    matchingIntent={matchingIntent}
                    acceptingIntent={acceptingIntent}
                    magicBlockSettlingIntent={magicBlockSettlingIntent}
                    umbraShieldingIntent={umbraShieldingIntent}
                    settlementReceipts={settlementReceipts}
                    settlementPlans={settlementPlans}
                />
            </div>
        </div>
    );
}
