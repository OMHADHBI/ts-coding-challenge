import {
  Before,
  Given,
  IWorldOptions,
  Then,
  When,
  setDefaultTimeout,
} from "@cucumber/cucumber";
import { accounts } from "../../src/config";
import {
  AccountBalanceQuery,
  AccountCreateTransaction,
  AccountId,
  Client,
  PrivateKey,
  PublicKey,
  TokenAssociateTransaction,
  TokenCreateTransaction,
  TokenId,
  TokenInfoQuery,
  TokenMintTransaction,
  TransactionId,
  TransferTransaction,
} from "@hashgraph/sdk";
import assert from "node:assert";

setDefaultTimeout(60 * 1000);

/* TODO:
   - Add cleanup logic.
   - Improve error handling.
   - Move functions to a separate helper.
   - Move test constants to a separate mocks file.
   - Refactor global token variables into the World object.
*/

let tokens: (TokenId | any)[] = [];

interface World extends IWorldOptions {
  accounts: (AccountId | undefined)[];
  privateKeys: (PrivateKey | undefined)[];
}

Before(function (this: World) {
  this.accounts = [];
  this.privateKeys = [];
});

const client = Client.forTestnet();
const account = accounts[0];
const mainAccount = AccountId.fromString(account.id);
const mainAccountPrivateKey = PrivateKey.fromStringED25519(account.privateKey);
client.setOperator(mainAccount, mainAccountPrivateKey);

async function createTestAccount(client: Client, initialBalance: number) {
  const privateKey = PrivateKey.generate();
  const transaction = await new AccountCreateTransaction()
    .setInitialBalance(initialBalance)
    .setKey(privateKey)
    .execute(client);

  const receipt = await transaction.getReceipt(client);
  if (!receipt.accountId) throw new Error("Account creation failed");

  return {
    accountId: receipt.accountId,
    privateKey,
  };
}

//https://docs.hedera.com/hedera/sdks-and-apis/sdks/token-service/define-a-token
async function createToken(
  client: Client,
  config: {
    name: string;
    symbol: string;
    decimals?: number;
    supply: number;
    treasury: AccountId;
    treasuryPrivateKey: PrivateKey;
    adminPrivateKey: PrivateKey;
    fixedSupply: Boolean;
  }
) {
  const adminPublicKey: PublicKey = config.adminPrivateKey.publicKey;
  const tx = new TokenCreateTransaction()
    .setTokenName(config.name)
    .setTokenSymbol(config.symbol)
    .setInitialSupply(config.supply)
    .setAdminKey(adminPublicKey)
    .setTreasuryAccountId(config.treasury);

  if (config.decimals) {
    tx.setDecimals(config.decimals);
  }
  if (!config.fixedSupply) {
    tx.setSupplyKey(adminPublicKey);
  }

  tx.freezeWith(client);

  const signTx = await (
    await tx.sign(config.adminPrivateKey)
  ).sign(config.treasuryPrivateKey);

  const txResponse = await signTx.execute(client);
  const receipt = await txResponse.getReceipt(client);

  return receipt.tokenId;
}

//https://docs.hedera.com/hedera/sdks-and-apis/sdks/token-service/associate-tokens-to-an-account
async function associateTokens(
  client: Client,
  accountId: AccountId,
  privateKey: PrivateKey,
  tokenIds: TokenId[]
) {
  const tx = await new TokenAssociateTransaction()
    .setAccountId(accountId)
    .setTokenIds(tokenIds)
    .freezeWith(client);

  const signedTx = await tx.sign(privateKey);
  const txResponse = await signedTx.execute(client);
  const receipt = await txResponse.getReceipt(client);
  return receipt;
}

async function safeAssociateAccount(
  client: Client,
  accountId: AccountId,
  privateKey: PrivateKey,
  tokenId: TokenId
) {
  const balance = await new AccountBalanceQuery()
    .setAccountId(accountId)
    .execute(client);

  if (!balance.tokens?.get(tokenId)) {
    await associateTokens(client, accountId, privateKey, [tokenId]);
  }
}

async function getHbarBalance(client: Client, accountId: AccountId) {
  const balance = await new AccountBalanceQuery()
    .setAccountId(accountId)
    .execute(client);

  return balance.hbars.toBigNumber().toNumber();
}

//https://docs.hedera.com/hedera/sdks-and-apis/sdks/token-service/transfer-tokens
async function getTokenBalance(
  client: Client,
  accountId: AccountId,
  tokenId: TokenId
) {
  const balance = await new AccountBalanceQuery()
    .setAccountId(accountId)
    .execute(client);

  return balance.tokens?.get(tokenId)?.toNumber() || 0;
}

async function transferTokens(
  client: Client,
  tokenId: TokenId,
  from: { accountId: AccountId; privateKey: PrivateKey },
  to: AccountId,
  amount: number
) {
  const tx = await new TransferTransaction()
    .addTokenTransfer(tokenId, from.accountId, -amount)
    .addTokenTransfer(tokenId, to, amount)
    .freezeWith(client);

  const signedTx = await tx.sign(from.privateKey);
  const txResponse = await signedTx.execute(client);
  const receipt = await txResponse.getReceipt(client);
  return receipt;
}

Given(
  /^A Hedera account with more than (\d+) hbar$/,
  async function (initialBalanceHbar: number) {
    const { accountId, privateKey } = await createTestAccount(
      client,
      initialBalanceHbar * 2
    );
    this.accounts[1] = accountId;
    this.privateKeys[1] = privateKey;
    const actualBalance = await getHbarBalance(client, this.accounts[1]);
    assert.ok(actualBalance > initialBalanceHbar);
  }
);

When(/^I create a token named Test Token \(HTT\)$/, async function () {
  tokens[1] = await createToken(client, {
    name: "Test Token",
    symbol: "HTT",
    supply: 1000,
    decimals: 2,
    treasury: mainAccount,
    treasuryPrivateKey: this.privateKeys[1],
    adminPrivateKey: this.privateKeys[1],
    fixedSupply: false,
  });
});

Then(
  /^The token has the name "([^"]*)"$/,
  async function (expectedName: string) {
    //https://docs.hedera.com/hedera/sdks-and-apis/sdks/token-service/get-token-info
    const tokenInfo = await new TokenInfoQuery()
      .setTokenId(tokens[1])
      .execute(client);
    const actualName = tokenInfo.name;

    assert.strictEqual(actualName, expectedName);
  }
);

Then(
  /^The token has the symbol "([^"]*)"$/,
  async function (expectedSymbol: string) {
    const tokenInfo = await new TokenInfoQuery()
      .setTokenId(tokens[1])
      .execute(client);
    const actualSymbol = tokenInfo.symbol;

    assert.strictEqual(actualSymbol, expectedSymbol);
  }
);

Then(
  /^The token has (\d+) decimals$/,
  async function (expectedDecimals: number) {
    const tokenInfo = await new TokenInfoQuery()
      .setTokenId(tokens[1])
      .execute(client);
    const actualDecimals = tokenInfo.decimals;

    assert.strictEqual(actualDecimals, expectedDecimals);
  }
);

Then(/^The token is owned by the account$/, async function () {
  const tokenInfo = await new TokenInfoQuery()
    .setTokenId(tokens[1])
    .execute(client);
  const actualOwner = tokenInfo.treasuryAccountId;

  assert.strictEqual(actualOwner?.toString(), mainAccount?.toString());
});

Then(
  /^An attempt to mint (\d+) additional tokens succeeds$/,
  async function (amount: number) {
    //https://docs.hedera.com/hedera/sdks-and-apis/sdks/token-service/mint-a-token
    const mintTx = new TokenMintTransaction()
      .setTokenId(tokens[1])
      .setAmount(amount)
      .freezeWith(client);

    const signTx = await mintTx.sign(this.privateKeys[1]);
    const txResponse = await signTx.execute(client);
    const receipt = await txResponse.getReceipt(client);
    const transactionStatus = receipt.status;

    assert.ok(transactionStatus.toString() === "SUCCESS");
  }
);

When(
  /^I create a fixed supply token named Test Token \(HTT\) with (\d+) tokens$/,
  async function (supply: number) {
    tokens[2] = await createToken(client, {
      name: "Test Token",
      symbol: "HTT",
      supply: supply,
      treasury: this.accounts[1],
      treasuryPrivateKey: this.privateKeys[1],
      adminPrivateKey: this.privateKeys[1],
      fixedSupply: true,
    });
  }
);

Then(
  /^The total supply of the token is (\d+)$/,
  async function (expectedTotalSupply: number) {
    const tokenInfo = await new TokenInfoQuery()
      .setTokenId(tokens[2])
      .execute(client);
    const totalSupply = tokenInfo.totalSupply;
    const actualTotalSupply = totalSupply.toNumber();
    assert.strictEqual(actualTotalSupply, expectedTotalSupply);
  }
);

Then(/^An attempt to mint tokens fails$/, async function () {
  try {
    const mintTx = new TokenMintTransaction()
      .setTokenId(tokens[2])
      .setAmount(1000)
      .freezeWith(client);

    const signTx = await mintTx.sign(this.privateKeys[1]);
    await signTx.execute(client);
  } catch (error) {
    assert.ok(error);
  }
});

Given(
  /^A first hedera account with more than (\d+) hbar$/,
  async function (initialBalanceHbar: number) {
    const { accountId, privateKey } = await createTestAccount(
      client,
      initialBalanceHbar
    );
    this.accounts[1] = accountId;
    this.privateKeys[1] = privateKey;
    const actualBalance = await getHbarBalance(client, this.accounts[1]);
    assert.strictEqual(actualBalance, initialBalanceHbar);
  }
);

Given(/^A second Hedera account$/, async function () {
  const { accountId, privateKey } = await createTestAccount(client, 100);
  this.accounts[2] = accountId;
  this.privateKeys[2] = privateKey;
});

Given(
  /^A token named Test Token \(HTT\) with (\d+) tokens$/,
  async function (supply: number) {
    tokens[3] = await createToken(client, {
      name: "Test Token",
      symbol: "HTT",
      supply: supply,
      treasury: mainAccount,
      treasuryPrivateKey: mainAccountPrivateKey,
      adminPrivateKey: mainAccountPrivateKey,
      fixedSupply: false,
    });
  }
);

Given(
  /^The first account holds (\d+) HTT tokens$/,
  async function (initialBalanceHtt: number) {
    await safeAssociateAccount(
      client,
      this.accounts[1],
      this.privateKeys[1],
      tokens[3]
    );
    const currentBalance = await getTokenBalance(
      client,
      this.accounts[1],
      tokens[3]
    );
    if (currentBalance === 0) {
      await transferTokens(
        client,
        tokens[3],
        { accountId: mainAccount, privateKey: mainAccountPrivateKey },
        this.accounts[1],
        initialBalanceHtt
      );
    }
    const balance = await getTokenBalance(client, this.accounts[1], tokens[3]);
    assert.strictEqual(balance, initialBalanceHtt);
  }
);

Given(
  /^The second account holds (\d+) HTT tokens$/,
  async function (initialBalanceHtt) {
    await safeAssociateAccount(
      client,
      this.accounts[2],
      this.privateKeys[2],
      tokens[3]
    );
    const currentBalance = await getTokenBalance(
      client,
      this.accounts[2],
      tokens[3]
    );
    if (currentBalance === 0) {
      await transferTokens(
        client,
        tokens[3],
        { accountId: mainAccount, privateKey: mainAccountPrivateKey },
        this.accounts[2],
        initialBalanceHtt
      );
    }
    const balance = await getTokenBalance(client, this.accounts[2], tokens[3]);
    assert.strictEqual(balance, initialBalanceHtt);
  }
);

When(
  /^The first account creates a transaction to transfer (\d+) HTT tokens to the second account$/,
  async function (amountHtt: number) {
    const transferTx = await new TransferTransaction()
      .addTokenTransfer(tokens[3], this.accounts[1], -amountHtt)
      .addTokenTransfer(tokens[3], this.accounts[2], amountHtt)
      .freezeWith(client);
    this.signTransferTx = await transferTx.sign(this.privateKeys[1]);
  }
);

When(/^The first account submits the transaction$/, async function () {
  const signTransferTx = await this.signTransferTx.sign(this.privateKeys[1]);
  const transferTxResponse = await signTransferTx.execute(client);
  await transferTxResponse.getReceipt(client);
});

When(
  /^The second account creates a transaction to transfer (\d+) HTT tokens to the first account$/,
  async function (amountHtt) {
    const txId = TransactionId.generate(this.accounts[1]);
    const transferTx = await new TransferTransaction()
      .setTransactionId(txId)
      .addTokenTransfer(tokens[3], this.accounts[2], -amountHtt)
      .addTokenTransfer(tokens[3], this.accounts[1], amountHtt)
      .freezeWith(client);
    this.signTransferTx = await transferTx.sign(this.privateKeys[2]);
    this.balanceBeforeTransfer = await getHbarBalance(client, this.accounts[1]);
  }
);

Then(/^The first account has paid for the transaction fee$/, async function () {
  const balanceAfterTransfer = await getHbarBalance(client, this.accounts[1]);
  assert.ok(balanceAfterTransfer < this.balanceBeforeTransfer);
});

Given(
  /^A first hedera account with more than (\d+) hbar and (\d+) HTT tokens$/,
  async function (initialBalanceHbar, initialBalanceHtt) {
    tokens[4] = await createToken(client, {
      name: "Test Token",
      symbol: "HTT",
      supply: 1000,
      decimals: 2,
      treasury: mainAccount,
      treasuryPrivateKey: mainAccountPrivateKey,
      adminPrivateKey: mainAccountPrivateKey,
      fixedSupply: false,
    });

    const { accountId, privateKey } = await createTestAccount(
      client,
      initialBalanceHbar * 2
    );
    this.accounts[1] = accountId;
    this.privateKeys[1] = privateKey;

    await associateTokens(client, this.accounts[1], this.privateKeys[1], [
      tokens[4],
    ]);

    await transferTokens(
      client,
      tokens[4],
      { accountId: mainAccount, privateKey: mainAccountPrivateKey },
      this.accounts[1],
      initialBalanceHtt
    );

    const actualHbarBalance = await getHbarBalance(client, this.accounts[1]);
    const actualHttBalance = await getTokenBalance(
      client,
      this.accounts[1],
      tokens[4]
    );

    assert.ok(actualHbarBalance >= initialBalanceHbar);
    assert.strictEqual(actualHttBalance, initialBalanceHtt);
  }
);

Given(
  /^A second Hedera account with (\d+) hbar and (\d+) HTT tokens$/,
  async function (initialBalanceHbar, initialBalanceHtt) {
    const { accountId, privateKey } = await createTestAccount(
      client,
      initialBalanceHbar
    );
    this.accounts[2] = accountId;
    this.privateKeys[2] = privateKey;

    await associateTokens(client, this.accounts[2], this.privateKeys[2], [
      tokens[4],
    ]);

    await transferTokens(
      client,
      tokens[4],
      { accountId: mainAccount, privateKey: mainAccountPrivateKey },
      this.accounts[2],
      initialBalanceHtt
    );

    const actualHbarBalance = await getHbarBalance(client, this.accounts[2]);
    const actualHttBalance = await getTokenBalance(
      client,
      this.accounts[2],
      tokens[4]
    );

    assert.strictEqual(actualHbarBalance, initialBalanceHbar);
    assert.strictEqual(actualHttBalance, initialBalanceHtt);
  }
);

Given(
  /^A third Hedera account with (\d+) hbar and (\d+) HTT tokens$/,
  async function (initialBalanceHbar: number, initialBalanceHtt: number) {
    const { accountId, privateKey } = await createTestAccount(
      client,
      initialBalanceHbar
    );
    this.accounts[3] = accountId;
    this.privateKeys[3] = privateKey;

    await associateTokens(client, this.accounts[3], this.privateKeys[3], [
      tokens[4],
    ]);

    await transferTokens(
      client,
      tokens[4],
      { accountId: mainAccount, privateKey: mainAccountPrivateKey },
      this.accounts[3],
      initialBalanceHtt
    );

    const actualHbarBalance = await getHbarBalance(client, this.accounts[3]);
    const actualHttBalance = await getTokenBalance(
      client,
      this.accounts[3],
      tokens[4]
    );

    assert.strictEqual(actualHbarBalance, initialBalanceHbar);
    assert.strictEqual(actualHttBalance, initialBalanceHtt);
  }
);
Given(
  /^A fourth Hedera account with (\d+) hbar and (\d+) HTT tokens$/,
  async function (initialBalanceHbar: number, initialBalanceHtt: number) {
    const { accountId, privateKey } = await createTestAccount(
      client,
      initialBalanceHbar
    );
    this.accounts[4] = accountId;
    this.privateKeys[4] = privateKey;

    await associateTokens(client, this.accounts[4], this.privateKeys[4], [
      tokens[4],
    ]);

    await transferTokens(
      client,
      tokens[4],
      { accountId: mainAccount, privateKey: mainAccountPrivateKey },
      this.accounts[4],
      initialBalanceHtt
    );

    const actualHbarBalance = await getHbarBalance(client, this.accounts[4]);
    const actualHttBalance = await getTokenBalance(
      client,
      this.accounts[4],
      tokens[4]
    );

    assert.strictEqual(actualHbarBalance, initialBalanceHbar);
    assert.strictEqual(actualHttBalance, initialBalanceHtt);
  }
);
When(
  /^A transaction is created to transfer (\d+) HTT tokens out of the first and second account and (\d+) HTT tokens into the third account and (\d+) HTT tokens into the fourth account$/,
  async function (amountHtt1, amountHtt2, amountHtt3) {
    const transferTx = await new TransferTransaction()
      .addTokenTransfer(tokens[4], this.accounts[1], -amountHtt1)
      .addTokenTransfer(tokens[4], this.accounts[2], -amountHtt1)
      .addTokenTransfer(tokens[4], this.accounts[3], amountHtt2)
      .addTokenTransfer(tokens[4], this.accounts[4], amountHtt3)
      .freezeWith(client);

    this.signTransferTx = await (
      await transferTx.sign(this.privateKeys[1])
    ).sign(this.privateKeys[2]);
  }
);
Then(
  /^The third account holds (\d+) HTT tokens$/,
  async function (expectedHttBalance) {
    const actualBalance = await getTokenBalance(
      client,
      this.accounts[3],
      tokens[4]
    );
    assert.strictEqual(actualBalance, expectedHttBalance);
  }
);
Then(
  /^The fourth account holds (\d+) HTT tokens$/,
  async function (expectedHttBalance) {
    const actualBalance = await getTokenBalance(
      client,
      this.accounts[4],
      tokens[4]
    );
    assert.strictEqual(actualBalance, expectedHttBalance);
  }
);
