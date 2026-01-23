'use client';

import React, { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { useWallet } from '@solana/wallet-adapter-react';
import { Shield, ArrowRightLeft, Lock, ExternalLink, CheckCircle, XCircle, Loader2 } from 'lucide-react';
import { useConnection } from '@solana/wallet-adapter-react';
import {
    Connection,
    Keypair,
    PublicKey,
    SendTransactionError,
    Transaction,
    TransactionInstruction,
    LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
    buildAddLiquidityPlan,
    buildCreateSwapAccountsPlan,
    buildEncryptedSwapQuote,
    buildInitializeMintPlan,
    buildInitializePoolPlan,
    buildMintToPlan,
    buildPoolPermissionInstructions,
    buildSwapExactInPlan,
    buildSwapAccounts,
    buildTokenAccountPermissionInstructions,
} from '@/lib/private-swap';
import { getAuthToken } from '@magicblock-labs/ephemeral-rollups-sdk';
import { DEFAULT_POOL_FEE_BPS } from '@/lib/solana/constants';

const WalletMultiButton = dynamic(
    () => import('@solana/wallet-adapter-react-ui').then(mod => mod.WalletMultiButton),
    { ssr: false, loading: () => <div className="h-10 w-32 bg-secondary rounded-lg animate-pulse" /> }
);

export default function Home() {
    const { connected } = useWallet();

    return (
        <main className="min-h-screen flex flex-col items-center justify-center p-4 relative overflow-hidden">
            {/* Header */}
            <div className="absolute top-0 w-full p-6 flex justify-between items-center z-10">
                <div className="flex items-center gap-2">
                    <Shield className="w-8 h-8 text-primary" />
                    <h1 className="text-2xl font-bold tracking-tighter">
                        Velvet<span className="text-primary">Rope</span>
                    </h1>
                    <span className="text-xs bg-primary/20 text-primary px-2 py-0.5 rounded-full ml-2">
                        Double Cloak
                    </span>
                </div>
                <WalletMultiButton />
            </div>

            {/* Main Card */}
            <div className="relative z-10 w-full max-w-md">
                <div className="glass rounded-3xl p-1 border border-white/10 velvet-glow">
                    <PrivacyInterface />
                </div>

                {/* Status Footer */}
                <div className="mt-8 text-center text-sm text-muted-foreground flex items-center justify-center gap-4">
                    <div className="flex items-center gap-1">
                        <Lock className="w-3 h-3" /> MagicBlock PER
                    </div>
                    <div className="flex items-center gap-1">
                        <Shield className="w-3 h-3" /> Inco Confidential SPL
                    </div>
                    <div className="flex items-center gap-1">
                        <ArrowRightLeft className="w-3 h-3" /> Confidential Swap
                    </div>
                </div>
            </div>
        </main>
    );
}

function PrivacyInterface() {
    const { publicKey, connected, signTransaction, signMessage } = useWallet();
    const { connection } = useConnection();

    const [amount, setAmount] = useState('');
    const [swapDirection, setSwapDirection] = useState<'AtoB' | 'BtoA'>('AtoB');
    const [estimatedOutput, setEstimatedOutput] = useState<string | null>(null);
    const [isLoadingQuote, setIsLoadingQuote] = useState(false);
    const [status, setStatus] = useState<string | null>(null);
    const [isProcessing, setIsProcessing] = useState(false);
    const [lastTxSignature, setLastTxSignature] = useState<string | null>(null);
    const [poolReady, setPoolReady] = useState(false);
    const [perActive, setPerActive] = useState(
        Boolean(process.env.NEXT_PUBLIC_EPHEMERAL_RPC_URL)
    );
    const [perAuthStatus, setPerAuthStatus] = useState<'idle' | 'loading' | 'error'>(
        'idle'
    );
    const [perRpcUrl, setPerRpcUrl] = useState<string | null>(
        process.env.NEXT_PUBLIC_EPHEMERAL_RPC_URL ?? null
    );
    const [mintConfig, setMintConfig] = useState<{
        mintA: PublicKey;
        mintB: PublicKey;
        source: 'env' | 'stored';
        canMint: boolean;
    } | null>(null);

    const MINT_STORAGE_KEY_A = 'velvet.confidentialMintA';
    const MINT_STORAGE_KEY_B = 'velvet.confidentialMintB';

    const clearStatus = () => setStatus(null);

    const isAToB = swapDirection === 'AtoB';
    const liquiditySeedA = BigInt(1_000_000_000);
    const liquiditySeedB = BigInt(2_000_000_000);
    const ephemeralRpcUrl = process.env.NEXT_PUBLIC_EPHEMERAL_RPC_URL;
    const perBaseUrl = useMemo(
        () => (ephemeralRpcUrl ? ephemeralRpcUrl.replace(/\/$/, '') : null),
        [ephemeralRpcUrl]
    );
    const perConfigured = Boolean(perRpcUrl && perRpcUrl.includes('token='));
    const perConnection = useMemo(
        () => (perConfigured && perRpcUrl ? new Connection(perRpcUrl, 'confirmed') : null),
        [perConfigured, perRpcUrl]
    );
    const swapConnection = useMemo(
        () => (perActive && perConnection ? perConnection : connection),
        [perActive, perConnection, connection]
    );

    const walletSigner = useMemo(
        () =>
            publicKey && signTransaction
                ? { publicKey, signTransaction, signMessage }
                : null,
        [publicKey, signTransaction, signMessage]
    );

    useEffect(() => {
        if (!perActive || perConfigured || !perBaseUrl || !walletSigner?.publicKey) {
            return;
        }
        if (!walletSigner.signMessage) {
            setPerAuthStatus('error');
            return;
        }

        let cancelled = false;
        const fetchToken = async () => {
            try {
                setPerAuthStatus('loading');
                const auth = await getAuthToken(
                    perBaseUrl,
                    walletSigner.publicKey,
                    walletSigner.signMessage
                );
                if (cancelled) return;
                setPerRpcUrl(`${perBaseUrl}?token=${auth.token}`);
                setPerAuthStatus('idle');
            } catch (error) {
                if (cancelled) return;
                console.error('PER token fetch failed:', error);
                setPerAuthStatus('error');
            }
        };

        fetchToken();
        return () => {
            cancelled = true;
        };
    }, [perActive, perBaseUrl, perConfigured, walletSigner]);

    useEffect(() => {
        const mintAEnv = process.env.NEXT_PUBLIC_CONFIDENTIAL_MINT_A;
        const mintBEnv = process.env.NEXT_PUBLIC_CONFIDENTIAL_MINT_B;
        if (mintAEnv && mintBEnv) {
            try {
                setMintConfig({
                    mintA: new PublicKey(mintAEnv),
                    mintB: new PublicKey(mintBEnv),
                    source: 'env',
                    canMint: false,
                });
                return;
            } catch (error) {
                console.warn('Invalid confidential mint envs, ignoring.', error);
            }
        }

        if (typeof window !== 'undefined') {
            const storedA = window.localStorage.getItem(MINT_STORAGE_KEY_A);
            const storedB = window.localStorage.getItem(MINT_STORAGE_KEY_B);
            if (storedA && storedB) {
                try {
                    setMintConfig({
                        mintA: new PublicKey(storedA),
                        mintB: new PublicKey(storedB),
                        source: 'stored',
                        canMint: true,
                    });
                } catch (error) {
                    console.warn('Invalid stored mint addresses, clearing.', error);
                    window.localStorage.removeItem(MINT_STORAGE_KEY_A);
                    window.localStorage.removeItem(MINT_STORAGE_KEY_B);
                }
            }
        }
    }, []);
    const poolAccounts = useMemo(
        () =>
            walletSigner && mintConfig
                ? buildSwapAccounts(
                      walletSigner.publicKey,
                      mintConfig.mintA,
                      mintConfig.mintB
                  )
                : null,
        [walletSigner, mintConfig]
    );

    const handleSetupMints = async () => {
        if (!walletSigner) return;
        setIsProcessing(true);
        setStatus('Creating confidential mints...');
        try {
            const mintAKeypair = Keypair.generate();
            const mintBKeypair = Keypair.generate();

            const mintPlanA = await buildInitializeMintPlan({
                connection,
                wallet: walletSigner,
                mintKeypair: mintAKeypair,
                mintAuthority: walletSigner.publicKey,
            });
            await signAndSend(mintPlanA.transaction, '✅ Mint A initialized.', mintPlanA.signers);

            const mintPlanB = await buildInitializeMintPlan({
                connection,
                wallet: walletSigner,
                mintKeypair: mintBKeypair,
                mintAuthority: walletSigner.publicKey,
            });
            await signAndSend(mintPlanB.transaction, '✅ Mint B initialized.', mintPlanB.signers);

            if (typeof window !== 'undefined') {
                window.localStorage.setItem(MINT_STORAGE_KEY_A, mintAKeypair.publicKey.toBase58());
                window.localStorage.setItem(MINT_STORAGE_KEY_B, mintBKeypair.publicKey.toBase58());
            }

            setMintConfig({
                mintA: mintAKeypair.publicKey,
                mintB: mintBKeypair.publicKey,
                source: 'stored',
                canMint: true,
            });
            setStatus('✅ Confidential mints created and stored.');
        } catch (e: any) {
            console.error('Mint setup error:', e);
            setStatus(`❌ Mint setup failed: ${e?.message ?? 'unknown error'}`);
        } finally {
            setIsProcessing(false);
        }
    };

    const handleClearMints = () => {
        if (typeof window !== 'undefined') {
            window.localStorage.removeItem(MINT_STORAGE_KEY_A);
            window.localStorage.removeItem(MINT_STORAGE_KEY_B);
        }
        setMintConfig(null);
        setPoolReady(false);
        setStatus('ℹ️ Stored mints cleared.');
    };

    const logSendTransactionError = async (
        error: unknown,
        logConnection: Connection,
        label: string,
        signedTx?: Transaction | null
    ) => {
        if (error instanceof SendTransactionError) {
            const preflightLogs = error.transactionError?.logs;
            if (preflightLogs?.length) {
                console.error(`❌ ${label} preflight logs:`, preflightLogs);
            }

            try {
                const logs = await error.getLogs(logConnection);
                console.error(`❌ ${label} logs:`, logs);
            } catch (logError) {
                console.error(`❌ ${label} failed to fetch logs:`, logError);
                if (signedTx) {
                    try {
                        const simulated = await logConnection.simulateTransaction(signedTx);
                        if (simulated.value.logs?.length) {
                            console.error(`❌ ${label} simulated logs:`, simulated.value.logs);
                        }
                    } catch (simulateError) {
                        console.error(`❌ ${label} simulation fallback failed:`, simulateError);
                    }
                }
                console.error(`❌ ${label} error message:`, error.message);
            }
            return;
        }
        console.error(`❌ ${label} error:`, error);
    };

    const signAndSend = async (
        tx: Transaction,
        label: string,
        signers: Keypair[] = [],
        sendConnection: Connection = connection
    ) => {
        if (!walletSigner) {
            throw new Error('Wallet signer not available.');
        }

        if (signers.length > 0) {
            tx.partialSign(...signers);
        }

        let signed: Transaction | null = null;
        try {
            signed = await walletSigner.signTransaction(tx);
            const signature = await sendConnection.sendRawTransaction(signed.serialize(), {
                skipPreflight: false,
            });
            await sendConnection.confirmTransaction(signature, 'confirmed');
            setLastTxSignature(signature);
            setStatus(label);
            return signature;
        } catch (error) {
            await logSendTransactionError(error, sendConnection, label, signed);
            throw error;
        }
    };

    const signAndSendInstructions = async (
        instructions: TransactionInstruction[],
        label: string,
        sendConnection: Connection = connection
    ) => {
        if (!walletSigner) {
            throw new Error('Wallet signer not available.');
        }
        const { blockhash } = await sendConnection.getLatestBlockhash();
        const tx = new Transaction().add(...instructions);
        tx.feePayer = walletSigner.publicKey;
        tx.recentBlockhash = blockhash;
        await signAndSend(tx, label, [], sendConnection);
    };

    const handleInitializePool = async () => {
        if (!walletSigner || !poolAccounts || !mintConfig) {
            setStatus('❌ Please create confidential mints first.');
            return;
        }

        if (perActive && !perConfigured) {
            if (perAuthStatus === 'loading') {
                setStatus('ℹ️ PER authorization in progress. Please retry in a moment.');
                return;
            }
            if (perAuthStatus === 'error') {
                setStatus('❌ PER authorization failed. Disable PER or reconnect wallet.');
                return;
            }
        }

        setIsProcessing(true);
        setStatus('Initializing confidential pool...');
        try {
            setStatus('ℹ️ Using configured confidential mints.');

            const createAccountsPlan = await buildCreateSwapAccountsPlan({
                connection,
                wallet: walletSigner,
                mintA: mintConfig.mintA,
                mintB: mintConfig.mintB,
            });
            await signAndSend(createAccountsPlan.transaction, '✅ Token accounts created.');

            const initPoolPlan = await buildInitializePoolPlan({
                connection,
                wallet: walletSigner,
                mintA: mintConfig.mintA,
                mintB: mintConfig.mintB,
                feeBps: DEFAULT_POOL_FEE_BPS,
            });
            await signAndSend(initPoolPlan.transaction, '✅ Pool initialized.');

            if (mintConfig.canMint) {
                try {
                    const mintToA = await buildMintToPlan({
                        connection,
                        wallet: walletSigner,
                        mint: mintConfig.mintA,
                        account: poolAccounts.userTokenA,
                        amount: liquiditySeedA,
                    });
                    await signAndSend(mintToA.transaction, '✅ Seeded token A.');

                    const mintToB = await buildMintToPlan({
                        connection,
                        wallet: walletSigner,
                        mint: mintConfig.mintB,
                        account: poolAccounts.userTokenB,
                        amount: liquiditySeedB,
                    });
                    await signAndSend(mintToB.transaction, '✅ Seeded token B.');
                } catch (seedError) {
                    console.warn('Seed minting skipped:', seedError);
                    setStatus('ℹ️ Seed minting skipped. Ensure your wallet has confidential balances.');
                }
            } else {
                setStatus('ℹ️ Seed minting disabled for env mints. Ensure your wallet has confidential balances.');
            }

            if (perActive) {
                const poolPermissionIxs = await buildPoolPermissionInstructions({
                    connection,
                    wallet: walletSigner,
                    mintA: mintConfig.mintA,
                    mintB: mintConfig.mintB,
                });
                await signAndSendInstructions(poolPermissionIxs, '✅ Pool permissions active.');

                const tokenPermissionIxs = await Promise.all([
                    buildTokenAccountPermissionInstructions({
                        connection,
                        wallet: walletSigner,
                        owner: walletSigner.publicKey,
                        poolPda: poolAccounts.poolPda,
                        mint: mintConfig.mintA,
                        account: poolAccounts.userTokenA,
                    }),
                    buildTokenAccountPermissionInstructions({
                        connection,
                        wallet: walletSigner,
                        owner: walletSigner.publicKey,
                        poolPda: poolAccounts.poolPda,
                        mint: mintConfig.mintB,
                        account: poolAccounts.userTokenB,
                    }),
                    buildTokenAccountPermissionInstructions({
                        connection,
                        wallet: walletSigner,
                        owner: poolAccounts.poolPda,
                        poolPda: poolAccounts.poolPda,
                        mint: mintConfig.mintA,
                        account: poolAccounts.poolTokenA,
                    }),
                    buildTokenAccountPermissionInstructions({
                        connection,
                        wallet: walletSigner,
                        owner: poolAccounts.poolPda,
                        poolPda: poolAccounts.poolPda,
                        mint: mintConfig.mintB,
                        account: poolAccounts.poolTokenB,
                    }),
                ]);

                for (const ixs of tokenPermissionIxs) {
                    await signAndSendInstructions(ixs, '✅ Token permissions active.');
                }
            } else {
                setStatus('ℹ️ PER disabled. Skipping delegation/permissions.');
            }

            const addLiquidityPlan = await buildAddLiquidityPlan({
                connection: swapConnection,
                wallet: walletSigner,
                mintA: mintConfig.mintA,
                mintB: mintConfig.mintB,
                amountA: liquiditySeedA,
                amountB: liquiditySeedB,
            });
            await signAndSend(
                addLiquidityPlan.transaction,
                '✅ Liquidity added.',
                addLiquidityPlan.signers,
                swapConnection
            );

            setPoolReady(true);
            setStatus('✅ Pool ready for confidential swaps.');
        } catch (e: any) {
            console.error('Pool init error:', e);
            setStatus(`❌ Pool setup failed: ${e?.message ?? 'unknown error'}`);
        } finally {
            setIsProcessing(false);
        }
    };

    useEffect(() => {
        const checkPool = async () => {
            if (!poolAccounts) {
                setPoolReady(false);
                return;
            }
            const info = await connection.getAccountInfo(poolAccounts.poolPda);
            setPoolReady(Boolean(info));
        };
        checkPool();
    }, [connection, poolAccounts]);

    // Fetch encrypted swap quote when amount changes (debounced)
    useEffect(() => {
        if (
            !amount ||
            parseFloat(amount) <= 0 ||
            !walletSigner ||
            !walletSigner.signMessage ||
            !mintConfig ||
            !poolReady
        ) {
            setEstimatedOutput(null);
            return;
        }

        const timer = setTimeout(async () => {
            setIsLoadingQuote(true);
            try {
                const amountLamports = BigInt(Math.floor(parseFloat(amount) * LAMPORTS_PER_SOL));
                const { quote } = await buildEncryptedSwapQuote({
                    connection: swapConnection,
                    wallet: walletSigner,
                    mintA: mintConfig.mintA,
                    mintB: mintConfig.mintB,
                    amountIn: amountLamports,
                    aToB: isAToB,
                });

                setEstimatedOutput(quote.amountOutCiphertext);
            } catch (e) {
                console.error('Quote error:', e);
                setEstimatedOutput(null);
            } finally {
                setIsLoadingQuote(false);
            }
        }, 500); // 500ms debounce

        return () => clearTimeout(timer);
    }, [amount, connection, isAToB, mintConfig, walletSigner, poolReady, swapConnection]);

    const handlePrivateSwap = async () => {
        if (!walletSigner || !walletSigner.signMessage || !amount || !mintConfig) return;

        setIsProcessing(true);
        setStatus('Preparing confidential swap...');
        try {
            const amountLamports = BigInt(Math.floor(parseFloat(amount) * LAMPORTS_PER_SOL));
            const { transaction, quote } = await buildSwapExactInPlan({
                connection: swapConnection,
                wallet: walletSigner,
                mintA: mintConfig.mintA,
                mintB: mintConfig.mintB,
                amountIn: amountLamports,
                aToB: isAToB,
            });

            await signAndSend(
                transaction,
                `✅ Swap submitted. Ciphertext out: ${quote.amountOutCiphertext.slice(0, 14)}…`,
                [],
                swapConnection
            );
        } catch (e: any) {
            console.error('Private swap error:', e);
            setStatus(`❌ Swap failed: ${e?.message ?? 'unknown error'}`);
        } finally {
            setIsProcessing(false);
        }
    };

    const handleAction = () => {
        if (!mintConfig) {
            handleSetupMints();
            return;
        }
        if (!poolReady) {
            handleInitializePool();
            return;
        }
        handlePrivateSwap();
    };

    const isValidAmount = amount && parseFloat(amount) > 0;
    const canExecute = connected &&
        (mintConfig
            ? poolReady
                ? isValidAmount
                : true
            : true);

    return (
        <div className="bg-card rounded-2xl p-6 space-y-6">
            {/* Content */}
            <div className="space-y-4">
                {/* Amount Input */}
                <div className="space-y-2">
                    <div className="flex justify-between items-center">
                        <label className="text-xs font-medium text-muted-foreground ml-1">
                            You Pay
                        </label>
                    </div>
                    <div className="relative">
                        <input
                            type="number"
                            step="0.001"
                            min="0"
                            placeholder="0.00"
                            value={amount}
                            onChange={(e) => setAmount(e.target.value)}
                            className="w-full bg-secondary/50 border border-transparent focus:border-primary rounded-xl p-4 text-2xl font-bold placeholder:text-muted-foreground/30 focus:outline-none transition-all"
                        />
                        <div className="absolute right-4 top-1/2 -translate-y-1/2">
                            <span className="font-medium text-sm bg-background/50 px-2 py-1 rounded">
                                Mint {isAToB ? 'A' : 'B'}
                            </span>
                        </div>
                    </div>
                    <p className="text-[11px] text-muted-foreground/80 ml-1">
                        {`Enter amount for Mint ${isAToB ? 'A' : 'B'}. We encrypt it client-side and submit a confidential swap.`}
                    </p>
                </div>
                {ephemeralRpcUrl && (
                    <div className="flex items-center justify-between bg-secondary/40 border border-border rounded-xl p-3">
                        <div className="text-xs text-muted-foreground">
                            MagicBlock PER
                        </div>
                        <button
                            onClick={() => setPerActive(prev => !prev)}
                            disabled={perAuthStatus === 'loading'}
                            className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${
                                perAuthStatus === 'loading'
                                    ? 'bg-secondary/70 text-muted-foreground/60 cursor-not-allowed'
                                    : perActive
                                        ? 'bg-primary text-primary-foreground'
                                        : 'bg-secondary text-muted-foreground hover:text-foreground'
                            }`}
                        >
                            {perAuthStatus === 'loading'
                                ? 'Authorizing…'
                                : perActive
                                    ? 'PER Enabled'
                                    : 'PER Disabled'}
                        </button>
                    </div>
                )}
                <div className="bg-secondary/40 border border-border rounded-xl p-4 space-y-2">
                    <div className="flex items-start justify-between gap-3">
                        <div>
                            <p className="text-sm font-semibold">Confidential Mint Setup</p>
                            {mintConfig ? (
                                <div className="text-xs text-muted-foreground mt-1 space-y-1">
                                    <div>Mint A: <span className="font-mono break-all">{mintConfig.mintA.toBase58()}</span></div>
                                    <div>Mint B: <span className="font-mono break-all">{mintConfig.mintB.toBase58()}</span></div>
                                    <div>
                                        Source: {mintConfig.source === 'env' ? 'Env config' : 'Stored in browser'}
                                    </div>
                                </div>
                            ) : (
                                <p className="text-xs text-muted-foreground mt-1">
                                    No confidential mints found. Create them once for this wallet.
                                </p>
                            )}
                        </div>
                        <div className="flex flex-col gap-2">
                            {!mintConfig ? (
                                <button
                                    onClick={handleSetupMints}
                                    className="text-xs px-3 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90"
                                >
                                    Create Mints
                                </button>
                            ) : mintConfig.source === 'stored' ? (
                                <button
                                    onClick={handleClearMints}
                                    className="text-xs px-3 py-2 rounded-lg bg-secondary text-muted-foreground hover:text-foreground"
                                >
                                    Reset
                                </button>
                            ) : null}
                        </div>
                    </div>
                </div>
                <div className="flex justify-center -my-2 relative z-10">
                    <div
                        className="bg-card border border-border p-2 rounded-full cursor-pointer hover:rotate-180 transition-transform duration-500"
                        onClick={() =>
                            setSwapDirection(prev => (prev === 'AtoB' ? 'BtoA' : 'AtoB'))
                        }
                    >
                        <ArrowRightLeft className="w-4 h-4 text-muted-foreground" />
                    </div>
                </div>
                <div className="space-y-2">
                    <div className="flex justify-between items-center">
                        <label className="text-xs font-medium text-muted-foreground ml-1">Encrypted Output</label>
                        {isLoadingQuote && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
                    </div>
                    <div className="relative">
                        <input
                            type="text"
                            value={estimatedOutput || ''}
                            readOnly
                            placeholder="0.00"
                            className="w-full bg-secondary/50 border border-transparent rounded-xl p-4 text-2xl font-bold placeholder:text-muted-foreground/30 focus:outline-none text-muted-foreground"
                        />
                        <span className="absolute right-4 top-1/2 -translate-y-1/2 bg-background/80 px-2 py-1 rounded text-sm font-medium border border-border">
                            Ciphertext
                        </span>
                    </div>
                </div>


                {/* Info Box */}
                <div className="bg-primary/5 border border-primary/10 rounded-xl p-3 flex gap-3 items-start">
                    <Shield className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                    <div className="text-xs">
                        <p className="font-semibold text-primary">Double Cloak Protection Active</p>
                        <p className="text-muted-foreground mt-0.5">
                            Swap executed with confidential SPL + MagicBlock PER. All values stay encrypted.
                        </p>
                    </div>
                </div>

                {/* Status Display */}
                {status && (
                    <div className={`flex items-center gap-2 p-3 rounded-lg text-sm ${
                        status.includes('✅') 
                            ? 'bg-green-500/10 text-green-400' 
                            : status.includes('❌')
                                ? 'bg-red-500/10 text-red-400'
                                : 'bg-blue-500/10 text-blue-400'
                    }`}>
                        {status.includes('✅') && <CheckCircle className="w-4 h-4" />}
                        {status.includes('❌') && <XCircle className="w-4 h-4" />}
                        {!status.includes('✅') && !status.includes('❌') && <Loader2 className="w-4 h-4 animate-spin" />}
                        <span className="flex-1">{status}</span>
                        {status && (
                            <button onClick={clearStatus} className="text-xs opacity-60 hover:opacity-100">
                                ✕
                            </button>
                        )}
                    </div>
                )}

                {/* Explorer Links */}
                {lastTxSignature && (
                    <div className="flex gap-2 text-xs">
                        <a
                            href={`https://solscan.io/tx/${lastTxSignature}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1 text-muted-foreground hover:text-primary transition-colors"
                        >
                            <ExternalLink className="w-3 h-3" /> View on Solscan
                        </a>
                    </div>
                )}

                {/* Action Button */}
                <button
                    onClick={handleAction}
                    disabled={isProcessing || !canExecute}
                    className="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-bold py-4 rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-primary/25 flex items-center justify-center gap-2"
                >
                    {isProcessing ? (
                        <>
                            <Loader2 className="w-5 h-5 animate-spin" />
                            Processing...
                        </>
                    ) : !connected ? (
                        'Connect Wallet'
                    ) : !mintConfig ? (
                        <>
                            <Lock className="w-5 h-5" />
                            Create Confidential Mints
                        </>
                    ) : (
                        <>
                            <Lock className="w-5 h-5" />
                            {poolReady ? 'Swap with Confidential Pool' : 'Initialize Confidential Pool'}
                        </>
                    )}
                </button>
            </div>
        </div>
    );
}
