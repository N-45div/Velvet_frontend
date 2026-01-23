import { PublicKey } from '@solana/web3.js';
import { Buffer } from 'buffer';

export const PRIVATE_SWAP_PROGRAM_ID = new PublicKey('6L8awnTc179Atp7sMharQ8uuBjiKjWxzfEns6qW4fkyF');
export const INCO_TOKEN_PROGRAM_ID = new PublicKey('HmBw1FN2fXbgqyGpjB268vggBEEymNx98cuPpZQPYDZc');
export const INCO_LIGHTNING_PROGRAM_ID = new PublicKey('5sjEbPiqgZrYwR31ahR6Uk9wf5awoX61YGg7jExQSwaj');
export const PERMISSION_PROGRAM_ID = new PublicKey('ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1');
export const DELEGATION_PROGRAM_ID = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
export const DEFAULT_VALIDATOR = new PublicKey('FnE6VJT5QNZdedZPnCoLsARgBwoE6DeJNjBs2H1gySXA');
export const DEVNET_USDC_MINT = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

export const INPUT_TYPE = 0;
export const CONFIDENTIAL_DECIMALS = 9;
export const DEFAULT_POOL_FEE_BPS = 30;

export const POOL_SEED = Buffer.from('pool');
