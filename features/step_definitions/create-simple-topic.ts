import { Given, IWorldOptions, Then, When } from "@cucumber/cucumber";
import {
  AccountBalanceQuery,
  AccountCreateTransaction,
  AccountId,
  Client,
  Key,
  KeyList,
  PrivateKey,
  TopicCreateTransaction,
  TopicId,
  TopicInfoQuery,
  TopicMessageQuery,
  TopicMessageSubmitTransaction,
} from "@hashgraph/sdk";
import { accounts } from "../../src/config";
import assert from "node:assert";

/* TODO:
   - Add cleanup logic.
   - Improve error handling.
   - Move functions to a separate helper.
*/

interface World extends IWorldOptions {
  topicId?: TopicId;
  privateKeys: (PrivateKey | undefined)[];
  thresholdKey?: KeyList;
}

const client = Client.forTestnet();
const account = accounts[0];
client.setOperator(
  AccountId.fromString(account.id),
  PrivateKey.fromStringED25519(account.privateKey)
);

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

//https://docs.hedera.com/hedera/sdks-and-apis/sdks/consensus-service/create-a-topic
async function createTestTopic(client: Client, memo: string, submitKey: Key) {
  const transaction = new TopicCreateTransaction()
    .setTopicMemo(memo)
    .setSubmitKey(submitKey);

  const txResponse = await transaction.execute(client);
  const receipt = await txResponse.getReceipt(client);

  if (!receipt.topicId) throw new Error("Topic creation failed");

  return receipt.topicId;
}

Given(
  /^a first account with more than (\d+) hbars$/,
  async function (expectedBalance: number) {
    const { accountId, privateKey } = await createTestAccount(
      client,
      expectedBalance * 2
    );
    this.privateKeys[1] = privateKey;
    const query = new AccountBalanceQuery().setAccountId(accountId);
    const balance = await query.execute(client);
    const actualBalance = balance.hbars.toBigNumber().toNumber();
    assert.ok(actualBalance > expectedBalance);
  }
);

When(
  /^A topic is created with the memo "([^"]*)" with the first account as the submit key$/,
  async function (memo: string) {
    const publicKey = this.privateKeys[1].publicKey;
    this.topicId = await createTestTopic(client, memo, publicKey);

    //https://docs.hedera.com/hedera/sdks-and-apis/sdks/consensus-service/get-topic-info
    const query = new TopicInfoQuery().setTopicId(this.topicId);
    const info = await query.execute(client);
    const actualMemo = info.topicMemo.toString();
    assert.strictEqual(actualMemo, memo);
  }
);

When(
  /^The message "([^"]*)" is published to the topic$/,
  async function (message: string) {
    //https://docs.hedera.com/hedera/sdks-and-apis/sdks/consensus-service/submit-a-message
    if (!this.topicId) {
      throw new Error("Topic ID is undefined, cannot publish message");
    }
    const msgTx = await new TopicMessageSubmitTransaction()
      .setTopicId(this.topicId)
      .setMessage(message);
    await msgTx.execute(client);
  }
);

Then(
  /^The message "([^"]*)" is received by the topic and can be printed to the console$/,
  async function (expectedMessage: string) {
    await new Promise((resolve) => setTimeout(resolve, 4000));
    if (!this.topicId) {
      throw new Error("Topic ID is undefined, cannot publish message");
    }
    //https://docs.hedera.com/hedera/sdks-and-apis/sdks/consensus-service/get-topic-message
    new TopicMessageQuery()
      .setTopicId(this.topicId)
      .subscribe(client, null, (res) => {
        const message = Buffer.from(res.contents).toString();
        console.log("Message: " + message);
        assert.strictEqual(message?.toString(), expectedMessage);
      });
  }
);

Given(
  /^A second account with more than (\d+) hbars$/,
  async function (expectedBalance: number) {
    const { accountId, privateKey } = await createTestAccount(
      client,
      expectedBalance * 2
    );
    this.privateKeys[2] = privateKey;
    const query = new AccountBalanceQuery().setAccountId(accountId);
    const balance = await query.execute(client);
    const actualBalance = balance.hbars.toBigNumber().toNumber();
    assert.ok(actualBalance > expectedBalance);
  }
);

Given(
  /^A (\d+) of (\d+) threshold key with the first and second account$/,
  async function (thresholdValue: number, totalKeys) {
    if (totalKeys !== 2) {
      throw new Error(`Test requires exactly 2 keys, got ${totalKeys}`);
    }
    //https://docs.hedera.com/hedera/sdks-and-apis/sdks/keys/create-a-threshold-key
    const keys = [this.privateKeys[1].publicKey, this.privateKeys[2].publicKey];
    this.thresholdKey = new KeyList(keys, thresholdValue);
  }
);

When(
  /^A topic is created with the memo "([^"]*)" with the threshold key as the submit key$/,
  async function (memo: string) {
    const publicKey = this.thresholdKey.publicKey;
    this.topicId = await createTestTopic(client, memo, publicKey);
    if (!this.topicId) {
      throw new Error("Topic ID is undefined, cannot publish message");
    }

    const query = new TopicInfoQuery().setTopicId(this.topicId);
    const info = await query.execute(client);
    const actualMemo = info.topicMemo.toString();
    assert.strictEqual(actualMemo, memo);
  }
);
