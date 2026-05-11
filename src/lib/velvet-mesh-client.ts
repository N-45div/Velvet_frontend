import * as anchor from '@coral-xyz/anchor';
import { BN, Program } from '@coral-xyz/anchor';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, VersionedTransaction } from '@solana/web3.js';
import {
    awaitComputationFinalization,
    deserializeLE,
    getArciumProgramId,
    getClockAccAddress,
    getClusterAccAddress,
    getCompDefAccAddress,
    getCompDefAccOffset,
    getComputationAccAddress,
    getExecutingPoolAccAddress,
    getFeePoolAccAddress,
    getMempoolAccAddress,
    getMXEAccAddress,
    getMXEPublicKey,
    RescueCipher,
    x25519,
} from '@arcium-hq/client';
import { Buffer } from 'buffer';
import velvetMeshIdl from '@/idl/velvet_mesh.json';
import velvetMeshMatcherIdl from '@/idl/velvet_mesh_matcher.json';
import {
    DEVNET_TEST_USDC_MINT,
    DEVNET_WSOL_MINT,
    VELVET_MATCHER_PROGRAM_ID,
    VELVET_MESH_PROGRAM_ID,
} from '@/lib/solana/constants';

type BrowserWallet = {
    publicKey: PublicKey;
    signTransaction: <T extends Transaction | VersionedTransaction>(transaction: T) => Promise<T>;
    signAllTransactions?: <T extends Transaction | VersionedTransaction>(transactions: T[]) => Promise<T[]>;
};

type QuoteMakerWallet = BrowserWallet & {
    signer?: Keypair;
};

const DIRECT_SOLANA_P2P = 1 << 0;
const VELVETSWAP_FALLBACK = 1 << 1;
const DIRECT_SOLANA_P2P_ROUTE_INDEX = 0;
const MATCHER_FINALIZATION_TIMEOUT_MS = 180_000;

type PrivacyHandleEnvelope = {
    encryptedSize: number[];
    encryptedLimitPrice: number[];
    encryptedSlippageBps: number[];
    encryptedRiskPreference: number[];
    matchVerifier: string;
    settlementVerifier: string;
    provider: string;
};

type QuoteHandleEnvelope = {
    encryptedOutputAmount: number[];
    encryptedPriceBps: number[];
    encryptedMakerRisk: number[];
    quoteCommitment: number[];
    settlementHash: number[];
    provider: string;
};

export type ArciumMatcherQuoteInput = {
    quote: string;
    outputAmountAtoms: string;
    riskBps: number;
    route: number;
};

async function metadataHash(input: unknown) {
    const source = JSON.stringify(input);
    const bytes = new TextEncoder().encode(source);
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest));
}

async function fetchPrivacyHandles(input: {
    owner: string;
    amount: string;
    inputSymbol: string;
    outputSymbol: string;
}): Promise<PrivacyHandleEnvelope> {
    const response = await fetch('/api/velvetmesh/privacy-handles', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
        },
        body: JSON.stringify(input),
    });
    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(body?.action || body?.error || `Privacy handle provider failed: ${response.status}`);
    }

    return body as PrivacyHandleEnvelope;
}

async function fetchQuoteHandles(input: {
    intent: string;
    maker: string;
    outputAmount: string;
    outputSymbol: string;
}): Promise<QuoteHandleEnvelope> {
    const response = await fetch('/api/velvetmesh/quote-handles', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
        },
        body: JSON.stringify(input),
    });
    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(body?.error || `Quote handle provider failed: ${response.status}`);
    }

    return body as QuoteHandleEnvelope;
}

function outputAmountToAtoms(outputAmount: string, outputSymbol: string) {
    const parsed = Number(outputAmount);
    const decimals = outputSymbol === 'SOL' ? 9 : 6;
    return BigInt(Math.max(1, Math.floor(parsed * 10 ** decimals)));
}

function mintForSymbol(symbol: string) {
    if (symbol === 'USDC') return DEVNET_TEST_USDC_MINT;
    if (symbol === 'SOL') return DEVNET_WSOL_MINT;
    throw new Error(`Unsupported VelvetMesh token symbol: ${symbol}`);
}

function formatQuoteAmountForIndex(outputAmount: string, index: number) {
    const parsed = Number(outputAmount);
    if (!Number.isFinite(parsed) || parsed <= 0) return outputAmount;
    return (parsed * (1 + index * 0.0025)).toFixed(9).replace(/\.?0+$/, '');
}

async function ensureDevnetMakerFundsFromOwner(input: {
    connection: Connection;
    ownerWallet: BrowserWallet;
    maker: PublicKey;
}) {
    const { connection, ownerWallet, maker } = input;
    const balance = await connection.getBalance(maker, 'confirmed');
    if (balance >= 0.03 * LAMPORTS_PER_SOL) {
        return;
    }

    const transaction = new Transaction().add(
        SystemProgram.transfer({
            fromPubkey: ownerWallet.publicKey,
            toPubkey: maker,
            lamports: Math.ceil(0.04 * LAMPORTS_PER_SOL),
        })
    );
    const latestBlockhash = await connection.getLatestBlockhash('confirmed');
    transaction.feePayer = ownerWallet.publicKey;
    transaction.recentBlockhash = latestBlockhash.blockhash;

    const signed = await ownerWallet.signTransaction(transaction);
    const signature = await connection.sendRawTransaction((signed as Transaction).serialize());
    await connection.confirmTransaction({
        signature,
        ...latestBlockhash,
    }, 'confirmed');
}

async function submitQuoteWithMaker(input: {
    connection: Connection;
    makerWallet: QuoteMakerWallet;
    intent: string;
    outputAmount: string;
    outputSymbol: string;
}) {
    const provider = new anchor.AnchorProvider(input.connection, input.makerWallet as anchor.Wallet, {
        commitment: 'confirmed',
        preflightCommitment: 'confirmed',
    });
    const program = new Program(velvetMeshIdl as anchor.Idl, provider);
    const intent = new PublicKey(input.intent);
    const quoteHandles = await fetchQuoteHandles({
        intent: input.intent,
        maker: input.makerWallet.publicKey.toBase58(),
        outputAmount: input.outputAmount,
        outputSymbol: input.outputSymbol,
    });
    const [quotePda] = PublicKey.findProgramAddressSync(
        [
            Buffer.from('quote'),
            intent.toBuffer(),
            input.makerWallet.publicKey.toBuffer(),
        ],
        program.programId
    );
    const expiresAt = new BN(Math.floor(Date.now() / 1000) + 1800);

    const builder = program.methods
        .submitQuote({
            route: { directSolanaP2P: {} },
            encryptedOutputAmount: quoteHandles.encryptedOutputAmount,
            encryptedPriceBps: quoteHandles.encryptedPriceBps,
            encryptedMakerRisk: quoteHandles.encryptedMakerRisk,
            quoteCommitment: quoteHandles.quoteCommitment,
            settlementHash: quoteHandles.settlementHash,
            expiresAt,
        })
        .accounts({
            maker: input.makerWallet.publicKey,
            intent,
            quote: quotePda,
            systemProgram: SystemProgram.programId,
        });

    const signature = input.makerWallet.signer
        ? await builder.signers([input.makerWallet.signer]).rpc()
        : await builder.rpc();

    return {
        signature,
        quote: quotePda.toBase58(),
        maker: input.makerWallet.publicKey.toBase58(),
        provider: quoteHandles.provider,
        matcherInput: {
            quote: quotePda.toBase58(),
            outputAmountAtoms: outputAmountToAtoms(input.outputAmount, input.outputSymbol).toString(),
            riskBps: 20,
            route: DIRECT_SOLANA_P2P_ROUTE_INDEX,
        } satisfies ArciumMatcherQuoteInput,
    };
}

export async function createVelvetMeshIntent(input: {
    connection: Connection;
    wallet: BrowserWallet;
    amount: string;
    inputSymbol: string;
    outputSymbol: string;
}) {
    const provider = new anchor.AnchorProvider(input.connection, input.wallet as anchor.Wallet, {
        commitment: 'confirmed',
        preflightCommitment: 'confirmed',
    });
    const program = new Program(velvetMeshIdl as anchor.Idl, provider);
    const privacy = await fetchPrivacyHandles({
        owner: input.wallet.publicKey.toBase58(),
        amount: input.amount,
        inputSymbol: input.inputSymbol,
        outputSymbol: input.outputSymbol,
    });
    const intentNonce = new BN(Date.now());
    const expiresAt = new BN(Math.floor(Date.now() / 1000) + 3600);
    const [intentPda] = PublicKey.findProgramAddressSync(
        [
            Buffer.from('intent'),
            input.wallet.publicKey.toBuffer(),
            intentNonce.toArrayLike(Buffer, 'le', 8),
        ],
        program.programId
    );

    const signature = await program.methods
        .createIntent(intentNonce, {
            inputMint: mintForSymbol(input.inputSymbol),
            outputMint: mintForSymbol(input.outputSymbol),
            encryptedSize: privacy.encryptedSize,
            encryptedLimitPrice: privacy.encryptedLimitPrice,
            encryptedSlippageBps: privacy.encryptedSlippageBps,
            encryptedRiskPreference: privacy.encryptedRiskPreference,
            allowedRoutes: DIRECT_SOLANA_P2P | VELVETSWAP_FALLBACK,
            computeProvider: { arcium: {} },
            matchVerifier: new PublicKey(privacy.matchVerifier),
            settlementVerifier: new PublicKey(privacy.settlementVerifier),
            minQuoteCount: 3,
            metadataHash: await metadataHash({
                amount: input.amount,
                inputSymbol: input.inputSymbol,
                outputSymbol: input.outputSymbol,
                product: 'VelvetMesh private intent',
                privacyProvider: privacy.provider,
            }),
            expiresAt,
        })
        .accounts({
            owner: input.wallet.publicKey,
            intent: intentPda,
            systemProgram: SystemProgram.programId,
        })
        .rpc();

    return {
        signature,
        intent: intentPda.toBase58(),
        nonce: intentNonce.toString(),
        status: 'Open',
        privacyProvider: privacy.provider,
    };
}

export async function submitVelvetMeshQuote(input: {
    connection: Connection;
    wallet: BrowserWallet;
    intent: string;
    outputAmount: string;
    outputSymbol: string;
}) {
    return submitQuoteWithMaker({
        connection: input.connection,
        makerWallet: input.wallet,
        intent: input.intent,
        outputAmount: input.outputAmount,
        outputSymbol: input.outputSymbol,
    });
}

export async function submitDevnetMakerQuotes(input: {
    connection: Connection;
    ownerWallet: BrowserWallet;
    intent: string;
    outputAmount: string;
    outputSymbol: string;
    count: number;
}) {
    const results = [];

    for (let index = 0; index < input.count; index += 1) {
        const signer = Keypair.generate();
        const quoteOutputAmount = formatQuoteAmountForIndex(input.outputAmount, index);
        await ensureDevnetMakerFundsFromOwner({
            connection: input.connection,
            ownerWallet: input.ownerWallet,
            maker: signer.publicKey,
        });
        const makerWallet: QuoteMakerWallet = {
            publicKey: signer.publicKey,
            signer,
            signTransaction: async <T extends Transaction | VersionedTransaction>(transaction: T) => {
                if (transaction instanceof VersionedTransaction) {
                    transaction.sign([signer]);
                    return transaction;
                }

                transaction.partialSign(signer);
                return transaction;
            },
            signAllTransactions: async <T extends Transaction | VersionedTransaction>(transactions: T[]) => {
                return Promise.all(transactions.map(async (transaction) => {
                    if (transaction instanceof VersionedTransaction) {
                        transaction.sign([signer]);
                        return transaction;
                    }

                    transaction.partialSign(signer);
                    return transaction;
                }));
            },
        };

        results.push(await submitQuoteWithMaker({
            connection: input.connection,
            makerWallet,
            intent: input.intent,
            outputAmount: quoteOutputAmount,
            outputSymbol: input.outputSymbol,
        }));
    }

    return results;
}

export async function requestVelvetMeshPrivateMatch(input: {
    connection: Connection;
    wallet: BrowserWallet;
    intent: string;
    quotes: ArciumMatcherQuoteInput[];
}) {
    const provider = new anchor.AnchorProvider(input.connection, input.wallet as anchor.Wallet, {
        commitment: 'confirmed',
        preflightCommitment: 'confirmed',
    });
    const program = new Program(velvetMeshIdl as anchor.Idl, provider);
    const matcher = new Program(velvetMeshMatcherIdl as anchor.Idl, provider);
    const intent = new PublicKey(input.intent);

    if (input.quotes.length < 3) {
        throw new Error('Arcium matcher requires three quote accounts for this deployed circuit.');
    }

    const mxePublicKey = await getMXEPublicKey(provider, VELVET_MATCHER_PROGRAM_ID);
    if (!mxePublicKey) {
        throw new Error('Arcium MXE public key is unavailable for the matcher program.');
    }

    const mxeAccount = getMXEAccAddress(VELVET_MATCHER_PROGRAM_ID);
    const mxe = await (matcher.account as any).mxeAccount.fetch(mxeAccount);
    if (mxe.cluster === null || mxe.cluster === undefined) {
        throw new Error('Arcium MXE has no active cluster assigned.');
    }

    const clusterOffset = Number(mxe.cluster);
    const compDefOffset = Buffer.from(getCompDefAccOffset('select_private_quote')).readUInt32LE(0);
    const compDefAccount = getCompDefAccAddress(VELVET_MATCHER_PROGRAM_ID, compDefOffset);
    const compDefInfo = await input.connection.getAccountInfo(compDefAccount, 'confirmed');
    if (!compDefInfo) {
        throw new Error('Arcium matcher computation definition is not initialized on devnet.');
    }

    const computationOffset = new BN(Array.from(crypto.getRandomValues(new Uint8Array(8))), 'le');
    const computationAccount = getComputationAccAddress(clusterOffset, computationOffset);
    const arciumComputation = Array.from(computationAccount.toBytes());

    const signature = await program.methods
        .requestPrivateMatch(arciumComputation)
        .accounts({
            owner: input.wallet.publicKey,
            intent,
        })
        .rpc();

    const privateKey = x25519.utils.randomSecretKey();
    const publicKey = x25519.getPublicKey(privateKey);
    const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);
    const cipher = new RescueCipher(sharedSecret);
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const quoteInputs = input.quotes.slice(0, 3);
    const quoteAtoms = quoteInputs.map((quote) => BigInt(quote.outputAmountAtoms));
    const minOutputAmount = quoteAtoms.reduce((min, value) => value < min ? value : min, quoteAtoms[0]);
    const plaintext = [
        minOutputAmount,
        1_000n,
        BigInt(DIRECT_SOLANA_P2P_ROUTE_INDEX),
        ...quoteInputs.flatMap((quote) => [
            BigInt(quote.outputAmountAtoms),
            BigInt(quote.riskBps),
            BigInt(quote.route),
        ]),
    ];
    const ciphertexts = cipher.encrypt(plaintext, nonce);
    const [signPdaAccount] = PublicKey.findProgramAddressSync(
        [Buffer.from('ArciumSignerAccount')],
        VELVET_MATCHER_PROGRAM_ID
    );

    const matcherSignature = await matcher.methods
        .requestPrivateMatch(
            computationOffset,
            ciphertexts,
            Array.from(publicKey),
            new BN(deserializeLE(nonce).toString())
        )
        .accounts({
            payer: input.wallet.publicKey,
            signPdaAccount,
            mxeAccount,
            mempoolAccount: getMempoolAccAddress(clusterOffset),
            executingPool: getExecutingPoolAccAddress(clusterOffset),
            computationAccount,
            compDefAccount,
            clusterAccount: getClusterAccAddress(clusterOffset),
            poolAccount: getFeePoolAccAddress(),
            clockAccount: getClockAccAddress(),
            velvetMeshProgram: VELVET_MESH_PROGRAM_ID,
            velvetMeshIntent: intent,
            quote0: new PublicKey(quoteInputs[0].quote),
            quote1: new PublicKey(quoteInputs[1].quote),
            quote2: new PublicKey(quoteInputs[2].quote),
            systemProgram: SystemProgram.programId,
            arciumProgram: getArciumProgramId(),
        })
        .rpc({ skipPreflight: true });

    let finalizationSignature: string | null = null;
    let finalizationWarning: string | null = null;
    try {
        finalizationSignature = await awaitComputationFinalization(
            provider,
            computationOffset,
            VELVET_MATCHER_PROGRAM_ID,
            'confirmed',
            MATCHER_FINALIZATION_TIMEOUT_MS
        );
    } catch (error: any) {
        finalizationWarning = error?.message || 'Arcium computation was queued, but finalization did not complete before timeout.';
    }

    return {
        signature,
        matcherSignature,
        finalizationSignature,
        finalizationWarning,
        computationAccount: computationAccount.toBase58(),
        arciumComputation,
    };
}

export async function acceptVelvetMeshQuote(input: {
    connection: Connection;
    wallet: BrowserWallet;
    intent: string;
    quote: string;
}) {
    const provider = new anchor.AnchorProvider(input.connection, input.wallet as anchor.Wallet, {
        commitment: 'confirmed',
        preflightCommitment: 'confirmed',
    });
    const program = new Program(velvetMeshIdl as anchor.Idl, provider);
    const intent = new PublicKey(input.intent);
    const quote = new PublicKey(input.quote);
    const [acceptedMatch] = PublicKey.findProgramAddressSync(
        [Buffer.from('match'), intent.toBuffer()],
        program.programId
    );

    const signature = await program.methods
        .acceptQuote()
        .accounts({
            owner: input.wallet.publicKey,
            intent,
            quote,
            acceptedMatch,
            systemProgram: SystemProgram.programId,
        })
        .rpc();

    return {
        signature,
        acceptedMatch: acceptedMatch.toBase58(),
    };
}
