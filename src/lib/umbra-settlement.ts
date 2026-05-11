import {
    createSignerFromPrivateKeyBytes,
    getEncryptedBalanceQuerierFunction,
    getPublicBalanceToEncryptedBalanceDirectDepositorFunction,
    getUmbraClient,
    getUserRegistrationFunction,
} from '@umbra-privacy/sdk';
import { createOptionalData32, createU64 } from '@umbra-privacy/sdk/utils';
import { address, type Address } from '@solana/kit';
import {
    createAssociatedTokenAccountInstruction,
    createSyncNativeInstruction,
    getAssociatedTokenAddress,
    NATIVE_MINT,
} from '@solana/spl-token';
import {
    Connection,
    Keypair,
    PublicKey,
    sendAndConfirmTransaction,
    SystemProgram,
    Transaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { DEVNET_WSOL_MINT, UMBRA_DEVNET_RELAYER_INFO_URL } from '@/lib/solana/constants';
import { getDevnetRpcUrl } from '@/lib/solana/rpc';

const SETTLEMENT_KEY_ENV = 'UMBRA_SETTLEMENT_PRIVATE_KEY';
const DEFAULT_DEPOSIT_BASE_UNITS = 1n;

type UmbraBalanceState = {
    state: string;
    balance?: string;
};

type SettlementKeyMaterial = {
    bytes: Uint8Array;
    keypair: Keypair;
};

function getWsUrl(rpcUrl: string) {
    if (process.env.UMBRA_SOLANA_WS_URL) {
        return process.env.UMBRA_SOLANA_WS_URL;
    }
    if (rpcUrl.startsWith('https://')) {
        return `wss://${rpcUrl.slice('https://'.length)}`;
    }
    if (rpcUrl.startsWith('http://')) {
        return `ws://${rpcUrl.slice('http://'.length)}`;
    }
    return rpcUrl;
}

function parseSecretKey(raw: string | undefined): SettlementKeyMaterial {
    if (!raw?.trim()) {
        throw new Error(`${SETTLEMENT_KEY_ENV} is not configured. Add a devnet Solana keypair JSON array to .env.local or Vercel env.`);
    }

    const trimmed = raw.trim();
    if (!trimmed.startsWith('[') && !trimmed.includes(',')) {
        const decoded = bs58.decode(trimmed);
        if (decoded.length !== 32 && decoded.length !== 64) {
            throw new Error(`${SETTLEMENT_KEY_ENV} base58 value must decode to 32 seed bytes or 64 Solana keypair bytes.`);
        }
        return {
            bytes: decoded,
            keypair: decoded.length === 32 ? Keypair.fromSeed(decoded) : Keypair.fromSecretKey(decoded),
        };
    }

    const parsed = trimmed.startsWith('[')
        ? JSON.parse(trimmed)
        : trimmed.split(',').map((part) => Number(part.trim()));

    if (!Array.isArray(parsed)) {
        throw new Error(`${SETTLEMENT_KEY_ENV} must be a Solana keypair byte array.`);
    }

    const bytes = parsed.map((value) => Number(value));
    if (!bytes.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
        throw new Error(`${SETTLEMENT_KEY_ENV} contains invalid keypair bytes.`);
    }
    if (bytes.length !== 32 && bytes.length !== 64) {
        throw new Error(`${SETTLEMENT_KEY_ENV} must contain 32 seed bytes or 64 Solana keypair bytes.`);
    }

    const secretKey = new Uint8Array(bytes);
    return {
        bytes: secretKey,
        keypair: secretKey.length === 32 ? Keypair.fromSeed(secretKey) : Keypair.fromSecretKey(secretKey),
    };
}

function makeOptionalData(intent?: string) {
    const optionalData = new Uint8Array(32);
    const encoded = new TextEncoder().encode(`velvet:${intent ?? 'settlement'}`);
    optionalData.set(encoded.slice(0, 32));
    return createOptionalData32(optionalData, 'velvetSettlementOptionalData');
}

async function createClient() {
    const rpcUrl = getDevnetRpcUrl();
    const keyMaterial = parseSecretKey(process.env[SETTLEMENT_KEY_ENV]);
    const signer = await createSignerFromPrivateKeyBytes(keyMaterial.bytes);
    const client = await getUmbraClient({
        signer,
        network: 'devnet',
        rpcUrl,
        rpcSubscriptionsUrl: getWsUrl(rpcUrl),
        deferMasterSeedSignature: false,
    });

    return { client, keypair: keyMaterial.keypair, signer, rpcUrl };
}

async function assertUmbraMintSupported(mint: PublicKey) {
    const response = await fetch(UMBRA_DEVNET_RELAYER_INFO_URL, { cache: 'no-store' });
    if (!response.ok) {
        throw new Error(`Umbra relayer mint check failed: ${response.status}`);
    }

    const payload = await response.json();
    const supportedMints = Array.isArray(payload?.supported_mints) ? payload.supported_mints : [];
    if (!supportedMints.includes(mint.toBase58())) {
        throw new Error(`Umbra devnet does not support mint ${mint.toBase58()}. Supported mints: ${supportedMints.join(', ')}`);
    }
}

async function ensureWrappedSolBalance(input: {
    connection: Connection;
    keypair: Keypair;
    amount: bigint;
}) {
    const owner = input.keypair.publicKey;
    const ata = await getAssociatedTokenAddress(NATIVE_MINT, owner);
    const instructions = [];

    const account = await input.connection.getAccountInfo(ata, 'confirmed');
    if (!account) {
        instructions.push(createAssociatedTokenAccountInstruction(owner, ata, owner, NATIVE_MINT));
    }

    const balance = account
        ? BigInt((await input.connection.getTokenAccountBalance(ata, 'confirmed')).value.amount)
        : 0n;
    const deficit = input.amount > balance ? input.amount - balance : 0n;

    if (deficit > 0n) {
        instructions.push(SystemProgram.transfer({
            fromPubkey: owner,
            toPubkey: ata,
            lamports: Number(deficit),
        }));
        instructions.push(createSyncNativeInstruction(ata));
    }

    if (instructions.length === 0) {
        return { ata: ata.toBase58(), signature: null };
    }

    const transaction = new Transaction().add(...instructions);
    const signature = await sendAndConfirmTransaction(input.connection, transaction, [input.keypair], {
        commitment: 'confirmed',
    });

    return { ata: ata.toBase58(), signature };
}

function normalizeBalance(result: unknown): UmbraBalanceState {
    if (!result || typeof result !== 'object') {
        return { state: 'unknown' };
    }

    const balance = result as { state?: string; balance?: bigint | number | string };
    return {
        state: balance.state ?? 'unknown',
        balance: balance.balance === undefined ? undefined : balance.balance.toString(),
    };
}

export async function getUmbraSettlementStatus() {
    const configured = Boolean(process.env[SETTLEMENT_KEY_ENV]?.trim());
    if (!configured) {
        return {
            configured,
            signer: null,
            mint: DEVNET_WSOL_MINT.toBase58(),
            encryptedBalance: null,
        };
    }

    const { client, signer } = await createClient();
    const queryBalance = getEncryptedBalanceQuerierFunction({ client });
    const mint = address(DEVNET_WSOL_MINT.toBase58());
    const balances = await queryBalance([mint]);

    return {
        configured,
        signer: signer.address.toString(),
        mint: mint.toString(),
        encryptedBalance: normalizeBalance(balances.get(mint)),
    };
}

export async function registerUmbraSettlementSigner() {
    const { client, keypair, rpcUrl, signer } = await createClient();
    const register = getUserRegistrationFunction({ client });
    const signatures = await register({
        confidential: true,
        anonymous: false,
        optionalData: {
            accountInitialisation: makeOptionalData('register-account'),
            registerX25519PublicKey: makeOptionalData('register-x25519'),
        },
    });

    return {
        signer: signer.address.toString(),
        signatures: signatures.map((signature) => signature.toString()),
    };
}

export async function shieldUmbraSettlement(input: {
    destination?: string;
    intent?: string;
    amountBaseUnits?: string | number;
}) {
    const { client, keypair, rpcUrl, signer } = await createClient();
    const register = getUserRegistrationFunction({ client });
    const registrationSignatures = await register({
        confidential: true,
        anonymous: false,
        optionalData: {
            accountInitialisation: makeOptionalData('register-account'),
            registerX25519PublicKey: makeOptionalData('register-x25519'),
        },
    });

    const amount = input.amountBaseUnits === undefined
        ? DEFAULT_DEPOSIT_BASE_UNITS
        : BigInt(input.amountBaseUnits);
    if (amount < 1n) {
        throw new Error('Umbra shield amount must be at least 1 base unit.');
    }

    await assertUmbraMintSupported(DEVNET_WSOL_MINT);

    const connection = new Connection(rpcUrl, 'confirmed');
    const wrapResult = await ensureWrappedSolBalance({ connection, keypair, amount });
    const deposit = getPublicBalanceToEncryptedBalanceDirectDepositorFunction({ client });
    const destination = address(input.destination || signer.address.toString()) as Address;
    const mint = address(DEVNET_WSOL_MINT.toBase58());
    const result = await deposit(destination, mint, createU64(amount, 'settlementAmount'), {
        optionalData: makeOptionalData(input.intent),
        accountInfoCommitment: 'confirmed',
        epochInfoCommitment: 'confirmed',
    });

    const queryBalance = getEncryptedBalanceQuerierFunction({ client });
    const balances = await queryBalance([mint]);

    return {
        provider: 'umbra-sdk-direct-encrypted-balance',
        signer: signer.address.toString(),
        destination: destination.toString(),
        mint: mint.toString(),
        amountBaseUnits: amount.toString(),
        wrapSignature: wrapResult.signature,
        wrappedSolTokenAccount: wrapResult.ata,
        registrationSignatures: registrationSignatures.map((signature) => signature.toString()),
        queueSignature: result.queueSignature.toString(),
        callbackStatus: result.callbackStatus ?? null,
        callbackSignature: result.callbackSignature?.toString() ?? null,
        callbackElapsedMs: result.callbackElapsedMs ?? null,
        rentClaimSignature: result.rentClaimSignature?.toString() ?? null,
        rentClaimError: result.rentClaimError ?? null,
        encryptedBalance: normalizeBalance(balances.get(mint)),
    };
}
