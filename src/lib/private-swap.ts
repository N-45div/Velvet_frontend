import { AnchorProvider, BN, type Idl, Program } from '@coral-xyz/anchor';
import {
    Connection,
    Keypair,
    PublicKey,
    SystemProgram,
    Transaction,
    type TransactionInstruction,
} from '@solana/web3.js';
import { Buffer } from 'buffer';
import { encryptValue } from '@inco/solana-sdk/encryption';
import decrypt from '@inco/solana-sdk/attested-decrypt';
import { hexToBuffer, plaintextToBigInt } from '@inco/solana-sdk/utils';
import {
    ACCOUNT_SIGNATURES_FLAG,
    AUTHORITY_FLAG,
    TX_BALANCES_FLAG,
    TX_LOGS_FLAG,
    TX_MESSAGE_FLAG,
    createDelegatePermissionInstruction,
    permissionPdaFromAccount,
    type Member,
} from '@magicblock-labs/ephemeral-rollups-sdk';

import privateSwapIdl from '@/idl/private_swap_programs.json';
import incoTokenIdl from '@/idl/inco_token.json';
import {
    CONFIDENTIAL_DECIMALS,
    DEFAULT_POOL_FEE_BPS,
    DEFAULT_VALIDATOR,
    INCO_LIGHTNING_PROGRAM_ID,
    INCO_TOKEN_PROGRAM_ID,
    INPUT_TYPE,
    PERMISSION_PROGRAM_ID,
    POOL_SEED,
    PRIVATE_SWAP_PROGRAM_ID,
} from '@/lib/solana/constants';
import type { WalletSigner } from '@/lib/solana/types';

export type EncryptedSwapQuote = {
    amountInCiphertext: string;
    amountOutCiphertext: string;
    feeAmountCiphertext: string;
    aToB: boolean;
};

export type SwapAccounts = {
    poolPda: PublicKey;
    userTokenA: PublicKey;
    userTokenB: PublicKey;
    poolTokenA: PublicKey;
    poolTokenB: PublicKey;
};

export type TransactionPlan = {
    transaction: Transaction;
    signers: Keypair[];
};

export type PermissionConfig = {
    validator?: PublicKey;
    members?: Member[];
    programOverride?: PublicKey;
};

export type SwapPlan = {
    transaction: Transaction;
    accounts: SwapAccounts;
    quote: EncryptedSwapQuote;
};

const DEFAULT_PERMISSION_FLAGS =
    AUTHORITY_FLAG |
    TX_LOGS_FLAG |
    TX_BALANCES_FLAG |
    TX_MESSAGE_FLAG |
    ACCOUNT_SIGNATURES_FLAG;

const buildAnchorProvider = (connection: Connection, wallet: WalletSigner) => {
    if (!wallet.publicKey) {
        throw new Error('Wallet public key is required to build provider.');
    }

    const anchorWallet = {
        publicKey: wallet.publicKey,
        signTransaction: async (tx: Transaction) =>
            (await wallet.signTransaction(tx)) as Transaction,
        signAllTransactions: async (transactions: Transaction[]) =>
            Promise.all(
                transactions.map(async (tx) =>
                    (await wallet.signTransaction(tx)) as Transaction
                )
            ),
    };

    return new AnchorProvider(connection, anchorWallet, {
        commitment: 'confirmed',
        preflightCommitment: 'confirmed',
    });
};

const getPrograms = (connection: Connection, wallet: WalletSigner) => {
    const provider = buildAnchorProvider(connection, wallet);
    const swapProgram = new Program(privateSwapIdl as Idl, provider);
    const incoTokenProgram = new Program(incoTokenIdl as Idl, provider);

    return { provider, swapProgram, incoTokenProgram };
};

const toBigIntValue = (value: unknown): bigint => {
    if (typeof value === 'bigint') {
        return value;
    }
    if (typeof value === 'number') {
        return BigInt(value);
    }
    if (typeof value === 'string') {
        return BigInt(value);
    }
    if (value instanceof BN) {
        return BigInt(value.toString());
    }
    if (value && typeof value === 'object' && 'u128' in value) {
        return toBigIntValue((value as { u128: unknown }).u128);
    }
    throw new Error('Unsupported numeric value for conversion.');
};

const toHandleString = (value: unknown): string => {
    if (value === null || value === undefined) {
        throw new Error('Missing encrypted handle in account data.');
    }

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
        return value.toString();
    }

    if (value instanceof BN) {
        return value.toString();
    }

    if (value instanceof Uint8Array) {
        const buffer = Buffer.from(value);
        let result = 0n;
        for (let i = 0; i < buffer.length; i += 1) {
            result += BigInt(buffer[i]) << (BigInt(i) * 8n);
        }
        return result.toString();
    }

    if (typeof value === 'object' && value && 'u128' in value) {
        return toHandleString((value as { u128: unknown }).u128);
    }

    throw new Error('Unsupported encrypted handle format.');
};

const buildTransaction = async (
    connection: Connection,
    feePayer: PublicKey,
    instructions: TransactionInstruction[]
) => {
    const { blockhash } = await connection.getLatestBlockhash();
    const transaction = new Transaction().add(...instructions);
    transaction.feePayer = feePayer;
    transaction.recentBlockhash = blockhash;
    return transaction;
};

const ensureSignMessage = (wallet: WalletSigner) => {
    if (!wallet.signMessage) {
        throw new Error('Wallet signMessage is required for attested decrypt.');
    }
    return wallet.signMessage;
};

const computeConstantProductQuote = (
    amountIn: bigint,
    reserveIn: bigint,
    reserveOut: bigint,
    feeBps: bigint
) => {
    const feeAmount = (amountIn * feeBps) / 10_000n;
    const netIn = amountIn - feeAmount;

    if (netIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) {
        return { netIn: 0n, amountOut: 0n, feeAmount };
    }

    const amountOut = (netIn * reserveOut) / (reserveIn + netIn);
    return { netIn, amountOut, feeAmount };
};

// SECTION: CORE_DERIVERS
export const derivePoolPda = (mintA: PublicKey, mintB: PublicKey) =>
    PublicKey.findProgramAddressSync(
        [POOL_SEED, mintA.toBuffer(), mintB.toBuffer()],
        PRIVATE_SWAP_PROGRAM_ID
    )[0];

export const deriveIncoTokenPda = (owner: PublicKey, mint: PublicKey) =>
    PublicKey.findProgramAddressSync(
        [owner.toBuffer(), INCO_TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
        INCO_TOKEN_PROGRAM_ID
    )[0];

export const buildSwapAccounts = (
    owner: PublicKey,
    mintA: PublicKey,
    mintB: PublicKey
): SwapAccounts => {
    const poolPda = derivePoolPda(mintA, mintB);
    return {
        poolPda,
        userTokenA: deriveIncoTokenPda(owner, mintA),
        userTokenB: deriveIncoTokenPda(owner, mintB),
        poolTokenA: deriveIncoTokenPda(poolPda, mintA),
        poolTokenB: deriveIncoTokenPda(poolPda, mintB),
    };
};

export const buildPermissionMembers = (params: {
    authority: PublicKey;
    poolPda: PublicKey;
    validator?: PublicKey;
    programId?: PublicKey;
}): Member[] => {
    const validator = params.validator ?? DEFAULT_VALIDATOR;
    const programId = params.programId ?? PRIVATE_SWAP_PROGRAM_ID;

    return [
        { flags: DEFAULT_PERMISSION_FLAGS, pubkey: params.authority },
        { flags: DEFAULT_PERMISSION_FLAGS, pubkey: params.poolPda },
        { flags: DEFAULT_PERMISSION_FLAGS, pubkey: validator },
        { flags: DEFAULT_PERMISSION_FLAGS, pubkey: programId },
    ];
};

export const buildInitializeMintPlan = async (params: {
    connection: Connection;
    wallet: WalletSigner;
    mintKeypair: Keypair;
    mintAuthority: PublicKey;
    freezeAuthority?: PublicKey | null;
}) => {
    const { connection, wallet, mintKeypair, mintAuthority, freezeAuthority } = params;
    if (!wallet.publicKey) {
        throw new Error('Wallet public key is required to initialize mint.');
    }

    const { incoTokenProgram } = getPrograms(connection, wallet);
    const transaction = await incoTokenProgram.methods
        .initializeMint(
            CONFIDENTIAL_DECIMALS,
            mintAuthority,
            freezeAuthority ?? null
        )
        .accounts({
            mint: mintKeypair.publicKey,
            payer: wallet.publicKey,
            systemProgram: SystemProgram.programId,
            incoLightningProgram: INCO_LIGHTNING_PROGRAM_ID,
        })
        .transaction();

    transaction.feePayer = wallet.publicKey;
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    return { transaction, signers: [mintKeypair] } as TransactionPlan;
};

export const buildCreateIncoTokenAccountInstruction = async (params: {
    connection: Connection;
    wallet: WalletSigner;
    owner: PublicKey;
    mint: PublicKey;
    account?: PublicKey;
}) => {
    const { connection, wallet, owner, mint, account } = params;
    if (!wallet.publicKey) {
        throw new Error('Wallet public key is required to create token account.');
    }

    const { incoTokenProgram } = getPrograms(connection, wallet);
    const associatedToken = account ?? deriveIncoTokenPda(owner, mint);

    return incoTokenProgram.methods
        .createIdempotent()
        .accounts({
            payer: wallet.publicKey,
            associatedToken,
            mint,
            wallet: owner,
            systemProgram: SystemProgram.programId,
            incoLightningProgram: INCO_LIGHTNING_PROGRAM_ID,
        })
        .instruction();
};

export const buildCreateSwapAccountsPlan = async (params: {
    connection: Connection;
    wallet: WalletSigner;
    mintA: PublicKey;
    mintB: PublicKey;
}) => {
    const { connection, wallet, mintA, mintB } = params;
    if (!wallet.publicKey) {
        throw new Error('Wallet public key is required to create token accounts.');
    }

    const accounts = buildSwapAccounts(wallet.publicKey, mintA, mintB);
    const instructions = await Promise.all([
        buildCreateIncoTokenAccountInstruction({
            connection,
            wallet,
            owner: wallet.publicKey,
            mint: mintA,
            account: accounts.userTokenA,
        }),
        buildCreateIncoTokenAccountInstruction({
            connection,
            wallet,
            owner: wallet.publicKey,
            mint: mintB,
            account: accounts.userTokenB,
        }),
        buildCreateIncoTokenAccountInstruction({
            connection,
            wallet,
            owner: accounts.poolPda,
            mint: mintA,
            account: accounts.poolTokenA,
        }),
        buildCreateIncoTokenAccountInstruction({
            connection,
            wallet,
            owner: accounts.poolPda,
            mint: mintB,
            account: accounts.poolTokenB,
        }),
    ]);

    const transaction = await buildTransaction(
        connection,
        wallet.publicKey,
        instructions
    );

    return { transaction, signers: [] } as TransactionPlan;
};

export const buildConfidentialTransferPlan = async (params: {
    connection: Connection;
    wallet: WalletSigner;
    mint: PublicKey;
    recipient: PublicKey;
    amount: bigint;
}) => {
    const { connection, wallet, mint, recipient, amount } = params;
    if (!wallet.publicKey) {
        throw new Error('Wallet public key is required to transfer.');
    }

    const { incoTokenProgram } = getPrograms(connection, wallet);
    const senderAccount = deriveIncoTokenPda(wallet.publicKey, mint);
    const recipientAccount = deriveIncoTokenPda(recipient, mint);
    const amountCiphertext = await encryptAmountToBuffer(amount);

    const transferIx = await incoTokenProgram.methods
        .transfer(amountCiphertext, INPUT_TYPE)
        .accounts({
            source: senderAccount,
            destination: recipientAccount,
            authority: wallet.publicKey,
            incoLightningProgram: INCO_LIGHTNING_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
        })
        .instruction();

    const transaction = await buildTransaction(connection, wallet.publicKey, [transferIx]);

    return { transaction, signers: [] } as TransactionPlan;
};

export const buildMintToPlan = async (params: {
    connection: Connection;
    wallet: WalletSigner;
    mint: PublicKey;
    account: PublicKey;
    amount: bigint;
}) => {
    const { connection, wallet, mint, account, amount } = params;
    if (!wallet.publicKey) {
        throw new Error('Wallet public key is required to mint.');
    }

    const { incoTokenProgram } = getPrograms(connection, wallet);
    const amountCiphertext = await encryptAmountToBuffer(amount);

    const transaction = await incoTokenProgram.methods
        .mintTo(amountCiphertext, INPUT_TYPE)
        .accounts({
            mint,
            account,
            mintAuthority: wallet.publicKey,
            incoLightningProgram: INCO_LIGHTNING_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
        })
        .transaction();

    transaction.feePayer = wallet.publicKey;
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    return { transaction, signers: [] } as TransactionPlan;
};

export const buildInitializePoolPlan = async (params: {
    connection: Connection;
    wallet: WalletSigner;
    mintA: PublicKey;
    mintB: PublicKey;
    feeBps?: number;
}) => {
    const { connection, wallet, mintA, mintB, feeBps } = params;
    if (!wallet.publicKey) {
        throw new Error('Wallet public key is required to initialize pool.');
    }

    const { swapProgram } = getPrograms(connection, wallet);
    const poolPda = derivePoolPda(mintA, mintB);
    const transaction = await swapProgram.methods
        .initializePool(feeBps ?? DEFAULT_POOL_FEE_BPS)
        .accounts({
            authority: wallet.publicKey,
            mintA,
            mintB,
            pool: poolPda,
            systemProgram: SystemProgram.programId,
            incoLightningProgram: INCO_LIGHTNING_PROGRAM_ID,
        })
        .transaction();

    transaction.feePayer = wallet.publicKey;
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    return { transaction, signers: [] } as TransactionPlan;
};

export const buildPoolPermissionInstructions = async (params: {
    connection: Connection;
    wallet: WalletSigner;
    mintA: PublicKey;
    mintB: PublicKey;
    permissionConfig?: PermissionConfig;
}) => {
    const { connection, wallet, mintA, mintB, permissionConfig } = params;
    if (!wallet.publicKey) {
        throw new Error('Wallet public key is required to set pool permissions.');
    }

    const { swapProgram } = getPrograms(connection, wallet);
    const poolPda = derivePoolPda(mintA, mintB);
    const permission = permissionPdaFromAccount(poolPda);
    const validator = permissionConfig?.validator ?? DEFAULT_VALIDATOR;
    const members =
        permissionConfig?.members ??
        buildPermissionMembers({
            authority: wallet.publicKey,
            poolPda,
            validator,
            programId: permissionConfig?.programOverride ?? PRIVATE_SWAP_PROGRAM_ID,
        });

    const createPermissionIx = await swapProgram.methods
        .createPermission({ pool: { mintA, mintB } }, members)
        .accounts({
            permissionedAccount: poolPda,
            permission,
            payer: wallet.publicKey,
            permissionProgram: PERMISSION_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
        })
        .instruction();

    const delegatePermissionIx = createDelegatePermissionInstruction({
        payer: wallet.publicKey,
        validator,
        permissionedAccount: [poolPda, false],
        authority: [wallet.publicKey, true],
    });

    const delegatePoolIx = await swapProgram.methods
        .delegatePda({ pool: { mintA, mintB } })
        .accounts({
            payer: wallet.publicKey,
            validator,
            pda: poolPda,
        })
        .instruction();

    return [createPermissionIx, delegatePermissionIx, delegatePoolIx];
};

export const buildTokenAccountPermissionInstructions = async (params: {
    connection: Connection;
    wallet: WalletSigner;
    owner: PublicKey;
    poolPda: PublicKey;
    mint: PublicKey;
    account: PublicKey;
    permissionConfig?: PermissionConfig;
}) => {
    const { connection, wallet, owner, poolPda, mint, account, permissionConfig } = params;
    if (!wallet.publicKey) {
        throw new Error('Wallet public key is required to set token permissions.');
    }

    const { incoTokenProgram } = getPrograms(connection, wallet);
    const permission = permissionPdaFromAccount(account);
    const validator = permissionConfig?.validator ?? DEFAULT_VALIDATOR;
    const members =
        permissionConfig?.members ??
        buildPermissionMembers({
            authority: wallet.publicKey,
            poolPda,
            validator,
            programId: permissionConfig?.programOverride ?? PRIVATE_SWAP_PROGRAM_ID,
        });

    const createPermissionIx = await incoTokenProgram.methods
        .createPermissionForIncoAccount(members)
        .accounts({
            permissionedAccount: account,
            permission,
            payer: wallet.publicKey,
            wallet: owner,
            mint,
            permissionProgram: PERMISSION_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
        })
        .instruction();

    const delegatePermissionIx = createDelegatePermissionInstruction({
        payer: wallet.publicKey,
        validator,
        permissionedAccount: [account, false],
        authority: [wallet.publicKey, true],
    });

    const delegateAccountIx = await incoTokenProgram.methods
        .delegateIncoAccount()
        .accounts({
            payer: wallet.publicKey,
            wallet: owner,
            mint,
            pda: account,
            validator,
        })
        .instruction();

    return [createPermissionIx, delegatePermissionIx, delegateAccountIx];
};

export const encryptAmount = async (amount: bigint) => encryptValue(amount);

export const encryptAmountToBuffer = async (amount: bigint) =>
    hexToBuffer(await encryptAmount(amount));

export const fetchPoolState = async (params: {
    connection: Connection;
    wallet: WalletSigner;
    mintA: PublicKey;
    mintB: PublicKey;
}) => {
    const { connection, wallet, mintA, mintB } = params;
    const { swapProgram } = getPrograms(connection, wallet);
    const poolPda = derivePoolPda(mintA, mintB);
    const poolState = await swapProgram.account.pool.fetch(poolPda);
    return { poolPda, poolState };
};

export const decryptPoolReserves = async (params: {
    connection: Connection;
    wallet: WalletSigner;
    mintA: PublicKey;
    mintB: PublicKey;
}) => {
    const { connection, wallet, mintA, mintB } = params;
    if (!wallet.publicKey) {
        throw new Error('Wallet public key is required to decrypt reserves.');
    }

    const signMessage = ensureSignMessage(wallet);
    const { poolPda, poolState } = await fetchPoolState({
        connection,
        wallet,
        mintA,
        mintB,
    });

    const handles = [
        toHandleString((poolState as { reserveA: unknown }).reserveA),
        toHandleString((poolState as { reserveB: unknown }).reserveB),
    ];

    const decryptResult = await decrypt(handles, {
        address: wallet.publicKey,
        signMessage,
    });

    const [reserveAPlain, reserveBPlain] = decryptResult.plaintexts.map(plaintextToBigInt);

    return {
        poolPda,
        poolState,
        reserveA: reserveAPlain,
        reserveB: reserveBPlain,
    };
};

export const buildEncryptedSwapQuote = async (params: {
    connection: Connection;
    wallet: WalletSigner;
    mintA: PublicKey;
    mintB: PublicKey;
    amountIn: bigint;
    aToB: boolean;
}) => {
    const { connection, wallet, mintA, mintB, amountIn, aToB } = params;
    const { poolState, reserveA, reserveB } = await decryptPoolReserves({
        connection,
        wallet,
        mintA,
        mintB,
    });

    const feeBps = toBigIntValue((poolState as { feeBps: unknown }).feeBps);
    const reserveIn = aToB ? reserveA : reserveB;
    const reserveOut = aToB ? reserveB : reserveA;

    const { netIn, amountOut, feeAmount } = computeConstantProductQuote(
        amountIn,
        reserveIn,
        reserveOut,
        feeBps
    );

    const [amountInCiphertext, amountOutCiphertext, feeAmountCiphertext] =
        await Promise.all([
            encryptAmount(netIn),
            encryptAmount(amountOut),
            encryptAmount(feeAmount),
        ]);

    return {
        quote: {
            amountInCiphertext,
            amountOutCiphertext,
            feeAmountCiphertext,
            aToB,
        } satisfies EncryptedSwapQuote,
    };
};

export const buildAddLiquidityPlan = async (params: {
    connection: Connection;
    wallet: WalletSigner;
    mintA: PublicKey;
    mintB: PublicKey;
    amountA: bigint;
    amountB: bigint;
}) => {
    const { connection, wallet, mintA, mintB, amountA, amountB } = params;
    if (!wallet.publicKey) {
        throw new Error('Wallet public key is required to add liquidity.');
    }

    const { swapProgram } = getPrograms(connection, wallet);
    const accounts = buildSwapAccounts(wallet.publicKey, mintA, mintB);
    const [amountACiphertext, amountBCiphertext] = await Promise.all([
        encryptAmountToBuffer(amountA),
        encryptAmountToBuffer(amountB),
    ]);

    const transaction = await swapProgram.methods
        .addLiquidity(amountACiphertext, amountBCiphertext, INPUT_TYPE)
        .accounts({
            authority: wallet.publicKey,
            pool: accounts.poolPda,
            userTokenA: accounts.userTokenA,
            userTokenB: accounts.userTokenB,
            poolTokenA: accounts.poolTokenA,
            poolTokenB: accounts.poolTokenB,
            systemProgram: SystemProgram.programId,
            incoLightningProgram: INCO_LIGHTNING_PROGRAM_ID,
            incoTokenProgram: INCO_TOKEN_PROGRAM_ID,
        })
        .transaction();

    transaction.feePayer = wallet.publicKey;
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    return { transaction, signers: [], accounts };
};

export const buildRemoveLiquidityPlan = async (params: {
    connection: Connection;
    wallet: WalletSigner;
    mintA: PublicKey;
    mintB: PublicKey;
    amountA: bigint;
    amountB: bigint;
}) => {
    const { connection, wallet, mintA, mintB, amountA, amountB } = params;
    if (!wallet.publicKey) {
        throw new Error('Wallet public key is required to remove liquidity.');
    }

    const { swapProgram } = getPrograms(connection, wallet);
    const accounts = buildSwapAccounts(wallet.publicKey, mintA, mintB);
    const [amountACiphertext, amountBCiphertext] = await Promise.all([
        encryptAmountToBuffer(amountA),
        encryptAmountToBuffer(amountB),
    ]);

    const transaction = await swapProgram.methods
        .removeLiquidity(amountACiphertext, amountBCiphertext, INPUT_TYPE)
        .accounts({
            authority: wallet.publicKey,
            pool: accounts.poolPda,
            userTokenA: accounts.userTokenA,
            userTokenB: accounts.userTokenB,
            poolTokenA: accounts.poolTokenA,
            poolTokenB: accounts.poolTokenB,
            systemProgram: SystemProgram.programId,
            incoLightningProgram: INCO_LIGHTNING_PROGRAM_ID,
            incoTokenProgram: INCO_TOKEN_PROGRAM_ID,
        })
        .transaction();

    transaction.feePayer = wallet.publicKey;
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    return { transaction, signers: [], accounts };
};

export const buildSwapExactInPlan = async (params: {
    connection: Connection;
    wallet: WalletSigner;
    mintA: PublicKey;
    mintB: PublicKey;
    amountIn: bigint;
    aToB: boolean;
}) => {
    const { connection, wallet, mintA, mintB, amountIn, aToB } = params;
    if (!wallet.publicKey) {
        throw new Error('Wallet public key is required to swap.');
    }

    const { swapProgram } = getPrograms(connection, wallet);
    const accounts = buildSwapAccounts(wallet.publicKey, mintA, mintB);
    const { quote } = await buildEncryptedSwapQuote({
        connection,
        wallet,
        mintA,
        mintB,
        amountIn,
        aToB,
    });

    const transaction = await swapProgram.methods
        .swapExactIn(
            hexToBuffer(quote.amountInCiphertext),
            hexToBuffer(quote.amountOutCiphertext),
            hexToBuffer(quote.feeAmountCiphertext),
            INPUT_TYPE,
            quote.aToB
        )
        .accounts({
            authority: wallet.publicKey,
            pool: accounts.poolPda,
            userTokenA: accounts.userTokenA,
            userTokenB: accounts.userTokenB,
            poolTokenA: accounts.poolTokenA,
            poolTokenB: accounts.poolTokenB,
            systemProgram: SystemProgram.programId,
            incoLightningProgram: INCO_LIGHTNING_PROGRAM_ID,
            incoTokenProgram: INCO_TOKEN_PROGRAM_ID,
        })
        .transaction();

    transaction.feePayer = wallet.publicKey;
    transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

    return { transaction, accounts, quote } satisfies SwapPlan;
};
