/**
 * @flow
 */

import assert from 'assert';
import BN from 'bn.js';
import * as BufferLayout from 'buffer-layout';
import {
  Account,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import type {Connection, TransactionSignature} from '@solana/web3.js';

import {newAccountWithLamports} from '../client/util/new-account-with-lamports';
import * as Layout from './layout';
import {sendAndConfirmTransaction} from './util/send-and-confirm-transaction';

/**
 * Some amount of tokens
 */
export class TokenAmount extends BN {
  /**
   * Convert to Buffer representation
   */
  toBuffer(): Buffer {
    const a = super.toArray().reverse();
    const b = Buffer.from(a);
    if (b.length === 8) {
      return b;
    }
    assert(b.length < 8, 'TokenAmount too large');

    const zeroPad = Buffer.alloc(8);
    b.copy(zeroPad);
    return zeroPad;
  }

  /**
   * Construct a TokenAmount from Buffer representation
   */
  static fromBuffer(buffer: Buffer): TokenAmount {
    assert(buffer.length === 8, `Invalid buffer length: ${buffer.length}`);
    return new BN(
      [...buffer]
        .reverse()
        .map(i => `00${i.toString(16)}`.slice(-2))
        .join(''),
      16,
    );
  }
}

/**
 * Information about the mint
 */
type MintInfo = {|
  /**
   * Total supply of tokens
   */
  supply: TokenAmount,

  /**
   * Number of base 10 digits to the right of the decimal place
   */
  decimals: number,
  /**
   * Owner of the mint, given authority to mint new tokens
   */
  owner: null | PublicKey,
|};

const MintLayout = BufferLayout.struct([
  BufferLayout.u8('state'),
  Layout.uint64('supply'),
  BufferLayout.nu64('decimals'),
  BufferLayout.u32('option'),
  Layout.publicKey('owner'),
  BufferLayout.nu64('padding'),
]);

/**
 * Information about an account
 */
type AccountInfo = {|
  /**
   * The mint associated with this account
   */
  mint: PublicKey,

  /**
   * Owner of this account
   */
  owner: PublicKey,

  /**
   * Amount of tokens this account holds
   */
  amount: TokenAmount,

  /**
   * The delegate for this account
   */
  delegate: null | PublicKey,

  /**
   * The amount of tokens the delegate authorized to the delegate
   */
  delegatedAmount: TokenAmount,
|};

/**
 * @private
 */
const AccountLayout = BufferLayout.struct([
  BufferLayout.u8('state'),
  Layout.publicKey('mint'),
  Layout.publicKey('owner'),
  Layout.uint64('amount'),
  BufferLayout.u32('option'),
  Layout.publicKey('delegate'),
  BufferLayout.u32('padding'),
  Layout.uint64('delegatedAmount'),
]);

type TokenAndPublicKey = [Token, PublicKey]; // This type exists to workaround an esdoc parse error

/**
 * An ERC20-like Token
 */
export class Token {
  /**
   * @private
   */
  connection: Connection;

  /**
   * The public key identifying this mint
   */
  publicKey: PublicKey;

  /**
   * Program Identifier for the Token program
   */
  programId: PublicKey;

  /**
   * Fee payer
   */
  payer: Account;

  /**
   * Create a Token object attached to the specific mint
   *
   * @param connection The connection to use
   * @param token Public key of the mint
   * @param programId token programId
   * @param payer Payer of fees
   */
  constructor(connection: Connection, publicKey: PublicKey, programId: PublicKey, payer: Account) {
    Object.assign(this, {connection, publicKey, programId, payer});
  }

  /**
   * Get the minimum balance for the mint to be rent exempt
   *
   * @return Number of lamports required
   */
  static async getMinBalanceRentForExemptMint(
    connection: Connection,
  ): Promise<number> {
    return await connection.getMinimumBalanceForRentExemption(
      MintLayout.span,
    );
  }

  /**
   * Get the minimum balance for the account to be rent exempt
   *
   * @return Number of lamports required
   */
  static async getMinBalanceRentForExemptAccount(
    connection: Connection,
  ): Promise<number> {
    return await connection.getMinimumBalanceForRentExemption(
      AccountLayout.span,
    );
  }

  /**
   * Creates and initializes a token.
   *
   * @param connection The connection to use
   * @param owner User account that will own the returned account
   * @param supply Total supply of the new mint
   * @param decimals Location of the decimal place
   * @param programId Optional token programId, uses the system programId by default
   * @return Token object for the newly minted token, Public key of the account holding the total supply of new tokens
   */
  static async createMint(
    connection: Connection,
    payer: Account,
    mintOwner: PublicKey,
    accountOwner: PublicKey,
    supply: TokenAmount,
    decimals: number,
    programId: PublicKey,
    is_owned: boolean = false,
  ): Promise<TokenAndPublicKey> {
    let transaction;
    const mintAccount = new Account();
    const token = new Token(connection, mintAccount.publicKey, programId, payer);
    const initialAccountPublicKey = await token.createAccount(accountOwner);

    // Allocate memory for the account
    const balanceNeeded = await Token.getMinBalanceRentForExemptMint(
      connection,
    );
    transaction = SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mintAccount.publicKey,
      lamports: balanceNeeded,
      space: MintLayout.span,
      programId,
    });
    await sendAndConfirmTransaction(
      'createAccount',
      connection,
      transaction,
      payer,
      mintAccount,
    );

    // Create the mint
    let keys = [
      {pubkey: mintAccount.publicKey, isSigner: true, isWritable: false},
    ];
    if (supply.toNumber() != 0) {
      keys.push({pubkey: initialAccountPublicKey, isSigner: false, isWritable: true});
    }
    if (is_owned) {
      keys.push({pubkey: mintOwner, isSigner: false, isWritable: false});
    }
    const commandDataLayout = BufferLayout.struct([
      BufferLayout.u8('instruction'),
      Layout.uint64('supply'),
      BufferLayout.nu64('decimals'),
    ]);
    let data = Buffer.alloc(1024);
    {
      const encodeLength = commandDataLayout.encode(
        {
          instruction: 0, // InitializeMint instruction
          supply: supply.toBuffer(),
          decimals,
        },
        data,
      );
      data = data.slice(0, encodeLength);
    }

    transaction = new Transaction().add({
      keys,
      programId,
      data,
    });
    await sendAndConfirmTransaction(
      'InitializeMint',
      connection,
      transaction,
      payer,
      mintAccount,
    );

    return [token, initialAccountPublicKey];
  }

  // Create payer here to avoid cross-node_modules issues with `instanceof`
  static async getAccount(connection: Connection): Promise<Account> {
    return await newAccountWithLamports(connection, 100000000000 /* wag */);
  }

  /**
   * Create and initializes a new account.
   *
   * This account may then be used as a `transfer()` or `approve()` destination
   *
   * @param owner User account that will own the new account
   * @return Public key of the new empty account
   */
  async createAccount(
    owner: PublicKey,
  ): Promise<PublicKey> {
    const mintAccount = new Account();
    let transaction;

    // Allocate memory for the account
    const balanceNeeded = await Token.getMinBalanceRentForExemptAccount(
      this.connection,
    );
    transaction = SystemProgram.createAccount({
      fromPubkey: this.payer.publicKey,
      newAccountPubkey: mintAccount.publicKey,
      lamports: balanceNeeded,
      space: AccountLayout.span,
      programId: this.programId,
    });
    await sendAndConfirmTransaction(
      'createAccount',
      this.connection,
      transaction,
      this.payer,
      mintAccount,
    );

    // create the new account
    const keys = [
      {pubkey: mintAccount.publicKey, isSigner: true, isWritable: true},
      {pubkey: this.publicKey, isSigner: false, isWritable: false},
      {pubkey: owner, isSigner: false, isWritable: false},
    ];

    const dataLayout = BufferLayout.struct([BufferLayout.u8('instruction')]);
    const data = Buffer.alloc(dataLayout.span);
    dataLayout.encode(
      {
        instruction: 1, // InitializeAccount instruction
      },
      data,
    );
    transaction = new Transaction().add({
      keys,
      programId: this.programId,
      data,
    });
    await sendAndConfirmTransaction(
      'InitializeAccount',
      this.connection,
      transaction,
      this.payer,
      mintAccount,
    );

    return mintAccount.publicKey;
  }

  /**
   * Retrieve mint information
   */
  async getMintInfo(): Promise<MintInfo> {
    const info = await this.connection.getAccountInfo(this.publicKey);
    if (info === null) {
      throw new Error('Failed to find mint account');
    }
    if (!info.owner.equals(this.programId)) {
      throw new Error(
        `Invalid mint owner: ${JSON.stringify(info.owner)}`,
      );
    }

    const data = Buffer.from(info.data);

    const mintInfo = MintLayout.decode(data);
    if (mintInfo.state !== 1) {
      throw new Error(`Invalid account data`);
    }
    mintInfo.supply = TokenAmount.fromBuffer(mintInfo.supply);
    if (mintInfo.option === 0) {
      mintInfo.owner = null;
    } else {
      mintInfo.owner = new PublicKey(mintInfo.owner);
    }
    return mintInfo;
  }

  /**
   * Retrieve account information
   *
   * @param account Public key of the account
   */
  async getAccountInfo(account: PublicKey): Promise<AccountInfo> {
    const info = await this.connection.getAccountInfo(account);
    if (info === null) {
      throw new Error('Failed to find account');
    }
    if (!info.owner.equals(this.programId)) {
      throw new Error(`Invalid account owner`);
    }

    const data = Buffer.from(info.data);
    const accountInfo = AccountLayout.decode(data);

    if (accountInfo.state !== 2) {
      throw new Error(`Invalid account data`);
    }
    accountInfo.mint = new PublicKey(accountInfo.mint);
    accountInfo.owner = new PublicKey(accountInfo.owner);
    accountInfo.amount = TokenAmount.fromBuffer(accountInfo.amount);
    if (accountInfo.option === 0) {
      accountInfo.delegate = null;
      accountInfo.delegatedAmount = new TokenAmount();
    } else {
      accountInfo.delegate = new PublicKey(accountInfo.delegate);
      accountInfo.delegatedAmount = TokenAmount.fromBuffer(
        accountInfo.delegatedAmount,
      );
    }

    if (!accountInfo.mint.equals(this.publicKey)) {
      throw new Error(
        `Invalid account mint: ${JSON.stringify(
          accountInfo.mint,
        )} !== ${JSON.stringify(this.publicKey)}`,
      );
    }
    return accountInfo;
  }

  /**
   * Transfer tokens to another account
   *
   * @param source Source account
   * @param destination Destination account
   * @param authority Owner of the source account
   * @param amount Number of tokens to transfer
   */
  async transfer(
    source: PublicKey,
    destination: PublicKey,
    authority: Account,
    amount: number | TokenAmount,
  ): Promise<?TransactionSignature> {
    return await sendAndConfirmTransaction(
      'transfer',
      this.connection,
      new Transaction().add(
        this.transferInstruction(
          source,
          destination,
          authority.publicKey,
          amount,
        ),
      ),
      this.payer,
      authority,
    );
  }

  /**
   * Grant a third-party permission to transfer up the specified number of tokens from an account
   *
   * @param account Public key of the account
   * @param delegate Account authorized to perform a transfer tokens from the source account
   * @param owner Owner of the source account
   * @param amount Maximum number of tokens the delegate may transfer
   */
  async approve(
    account: PublicKey,
    delegate: PublicKey,
    owner: Account,
    amount: number | TokenAmount,
  ): Promise<void> {
    await sendAndConfirmTransaction(
      'approve',
      this.connection,
      new Transaction().add(
        this.approveInstruction(account, delegate, owner.publicKey, amount),
      ),
      this.payer,
      owner,
    );
  }

  /**
   * Remove approval for the transfer of any remaining tokens
   *
   * @param account Public key of the account
   * @param delegate Account to revoke authorization from
   * @param owner Owner of the source account
   */
  revoke(
    account: PublicKey,
    delegate: PublicKey,
    owner: Account,
  ): Promise<void> {
    return this.approve(account, delegate, owner, 0);
  }

  /**
   * Assign a new owner to the account
   *
   * @param account Public key of the account
   * @param newOwner New owner of the account
   * @param owner Owner of the account
   */
  async setOwner(
    owned: PublicKey,
    newOwner: PublicKey,
    owner: Account,
  ): Promise<void> {
    await sendAndConfirmTransaction(
      'setOwneer',
      this.connection,
      new Transaction().add(
        this.setOwnerInstruction(owned, newOwner,owner.publicKey),
      ),
      this.payer,
      owner,
    );
  }

  /**
   * Mint new tokens
   *
   * @param mint Public key of the mint
   * @param dest Public key of the account to mint to
   * @param authority Owner of the mint
   * @param amount ammount to mint
   */
  async mintTo(
    dest: PublicKey,
    authority: Account,
    amount: number,
  ): Promise<void> {
    await sendAndConfirmTransaction(
      'mintTo',
      this.connection,
      new Transaction().add(this.mintToInstruction(dest, authority.publicKey,amount)),
      this.payer,
      authority,
    );
  }

  /**
   * Burn tokens
   *
   * @param account Account to burn tokens from
   * @param authority Public key account owner
   * @param amount ammount to burn
   */
  async burn(
    account: PublicKey,
    authority: Account,
    amount: number,
  ): Promise<void> {
    await sendAndConfirmTransaction(
      'burn',
      this.connection,
      new Transaction().add(this.burnInstruction(account, authority.publicKey, amount)),
      this.payer,
      authority,
    );
  }

  /**
   * Construct a Transfer instruction
   *
   * @param source Source account
   * @param destination Destination account
   * @param authority Owner of the source account
   * @param amount Number of tokens to transfer
   */
  transferInstruction(
    source: PublicKey,
    destination: PublicKey,
    authority: PublicKey,
    amount: number | TokenAmount,
  ): TransactionInstruction {
    const dataLayout = BufferLayout.struct([
      BufferLayout.u8('instruction'),
      Layout.uint64('amount'),
    ]);

    const data = Buffer.alloc(dataLayout.span);
    dataLayout.encode(
      {
        instruction: 2, // Transfer instruction
        amount: new TokenAmount(amount).toBuffer(),
      },
      data,
    );

    const keys = [
      {pubkey: source, isSigner: false, isWritable: true},
      {pubkey: destination, isSigner: false, isWritable: true},
      {pubkey: authority, isSigner: true, isWritable: false},
    ];
    return new TransactionInstruction({
      keys,
      programId: this.programId,
      data,
    });
  }

  /**
   * Construct an Approve instruction
   *
   * @param owner Owner of the source account
   * @param account Public key of the account
   * @param delegate Account authorized to perform a transfer of tokens from the source account
   * @param amount Maximum number of tokens the delegate may transfer
   */
  approveInstruction(
    account: PublicKey,
    delegate: PublicKey,
    owner: PublicKey,
    amount: number | TokenAmount,
  ): TransactionInstruction {
    const dataLayout = BufferLayout.struct([
      BufferLayout.u8('instruction'),
      Layout.uint64('amount'),
    ]);

    const data = Buffer.alloc(dataLayout.span);
    dataLayout.encode(
      {
        instruction: 3, // Approve instruction
        amount: new TokenAmount(amount).toBuffer(),
      },
      data,
    );

    const keys = [{pubkey: account, isSigner: false, isWritable: true}];
    if (new TokenAmount(amount).toNumber() > 0) {
      keys.push({pubkey: delegate, isSigner: false, isWritable: false});
    }
    keys.push({pubkey: owner, isSigner: true, isWritable: false});

    return new TransactionInstruction({
      keys,
      programId: this.programId,
      data,
    });
  }

  /**
   * Construct a SetOwner instruction
   *
   * @param account Public key of the account
   * @param newOwner New owner of the account
   * @param owner Owner of the account
   */
  setOwnerInstruction(
    owned: PublicKey,
    newOwner: PublicKey,
    owner: PublicKey,
  ): TransactionInstruction {
    const dataLayout = BufferLayout.struct([BufferLayout.u8('instruction')]);

    const data = Buffer.alloc(dataLayout.span);
    dataLayout.encode(
      {
        instruction: 4, // SetOwner instruction
      },
      data,
    );

    return new TransactionInstruction({
      keys: [
        {pubkey: owned, isSigner: false, isWritable: true},
        {pubkey: newOwner, isSigner: false, isWritable: false},
        {pubkey: owner, isSigner: true, isWritable: false},
      ],
      programId: this.programId,
      data,
    });
  }

  /**
   * Construct a MintTo instruction
   *
   * @param dest Public key of the account to mint to
   * @param authority Owner of the mint
   * @param amount amount to mint
   */
  mintToInstruction(
    dest: PublicKey,
    authority: PublicKey,
    amount: number,
  ): TransactionInstruction {
    const dataLayout = BufferLayout.struct([
      BufferLayout.u8('instruction'),
      Layout.uint64('amount'),
    ]);

    const data = Buffer.alloc(dataLayout.span);
    dataLayout.encode(
      {
        instruction: 5, // MintTo instruction
        amount: new TokenAmount(amount).toBuffer(),
      },
      data,
    );

    return new TransactionInstruction({
      keys: [
        {pubkey: this.publicKey, isSigner: false, isWritable: true},
        {pubkey: dest, isSigner: false, isWritable: true},
        {pubkey: authority, isSigner: true, isWritable: false},
      ],
      programId: this.programId,
      data,
    });
  }

  /**
   * Construct a Burn instruction
   *
   * @param account Account to burn tokens from
   * @param amount ammount to burn
   * @param authority Public key account owner
   */
  burnInstruction(
    account: PublicKey,
    authority: PublicKey,
    amount: number,
  ): TransactionInstruction {
    const dataLayout = BufferLayout.struct([
      BufferLayout.u8('instruction'),
      Layout.uint64('amount'),
    ]);

    const data = Buffer.alloc(dataLayout.span);
    dataLayout.encode(
      {
        instruction: 6, // Burn instruction
        amount: new TokenAmount(amount).toBuffer(),
      },
      data,
    );

    const keys = [
      {pubkey: account, isSigner: false, isWritable: true},
      {pubkey: this.publicKey, isSigner: false, isWritable: true},
      {pubkey: authority, isSigner: true, isWritable: false},
    ];

    return new TransactionInstruction({
      keys,
      programId: this.programId,
      data,
    });
  }
}
