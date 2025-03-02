import type { EventStream } from '../../src/types/subscriptions.js';
import type { DataStore, EventLog, MessageStore, RecordsWriteMessage } from '../../src/index.js';
import type { RecordEvent, RecordsFilter, RecordSubscriptionHandler } from '../../src/types/records-types.js';

import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import chai, { expect } from 'chai';

import friendRoleProtocolDefinition from '../vectors/protocol-definitions/friend-role.json' assert { type: 'json' };
import threadRoleProtocolDefinition from '../vectors/protocol-definitions/thread-role.json' assert { type: 'json' };

import { Jws } from '../../src/utils/jws.js';
import { Message } from '../../src/core/message.js';
import { RecordsSubscribe } from '../../src/interfaces/records-subscribe.js';
import { RecordsSubscribeHandler } from '../../src/handlers/records-subscribe.js';
import { stubInterface } from 'ts-sinon';
import { TestDataGenerator } from '../utils/test-data-generator.js';
import { TestEventStream } from '../test-event-stream.js';
import { TestStores } from '../test-stores.js';
import { TestStubGenerator } from '../utils/test-stub-generator.js';
import { DidKey, DidResolver } from '@web5/dids';
import { Dwn, Time } from '../../src/index.js';
import { DwnErrorCode, DwnInterfaceName, DwnMethodName } from '../../src/index.js';

chai.use(chaiAsPromised);

export function testRecordsSubscribeHandler(): void {
  describe('RecordsSubscribeHandler.handle()', () => {
    describe('EventStream disabled',() => {
      let didResolver: DidResolver;
      let messageStore: MessageStore;
      let dataStore: DataStore;
      let eventLog: EventLog;
      let dwn: Dwn;

      // important to follow the `before` and `after` pattern to initialize and clean the stores in tests
      // so that different test suites can reuse the same backend store for testing
      before(async () => {
        didResolver = new DidResolver({ didResolvers: [DidKey] });

        const stores = TestStores.get();
        messageStore = stores.messageStore;
        dataStore = stores.dataStore;
        eventLog = stores.eventLog;

        dwn = await Dwn.create({
          didResolver,
          messageStore,
          dataStore,
          eventLog,
        });

      });


      beforeEach(async () => {
        sinon.restore(); // wipe all previous stubs/spies/mocks/fakes

        // clean up before each test rather than after so that a test does not depend on other tests to do the clean up
        await messageStore.clear();
        await dataStore.clear();
        await eventLog.clear();
      });

      after(async () => {
        await dwn.close();
      });

      it('should respond with a 501 if subscriptions are not supported', async () => {
        await dwn.close(); // close the original dwn instance
        dwn = await Dwn.create({ didResolver, messageStore, dataStore, eventLog }); // leave out eventStream

        const alice = await TestDataGenerator.generateDidKeyPersona();
        // attempt to subscribe
        const { message } = await TestDataGenerator.generateRecordsSubscribe({
          author: alice,
        });
        const subscriptionMessageReply = await dwn.processMessage(alice.did, message, { subscriptionHandler: (_) => {} });
        expect(subscriptionMessageReply.status.code).to.equal(501, subscriptionMessageReply.status.detail);
        expect(subscriptionMessageReply.status.detail).to.include(DwnErrorCode.RecordsSubscribeEventStreamUnimplemented);
      });
    });

    describe('functional tests', () => {
      let didResolver: DidResolver;
      let messageStore: MessageStore;
      let dataStore: DataStore;
      let eventLog: EventLog;
      let eventStream: EventStream;
      let dwn: Dwn;

      // important to follow the `before` and `after` pattern to initialize and clean the stores in tests
      // so that different test suites can reuse the same backend store for testing
      before(async () => {
        didResolver = new DidResolver({ didResolvers: [DidKey] });

        const stores = TestStores.get();
        messageStore = stores.messageStore;
        dataStore = stores.dataStore;
        eventLog = stores.eventLog;
        eventStream = TestEventStream.get();

        dwn = await Dwn.create({ didResolver, messageStore, dataStore, eventLog, eventStream });
      });

      beforeEach(async () => {
        sinon.restore(); // wipe all previous stubs/spies/mocks/fakes

        // clean up before each test rather than after so that a test does not depend on other tests to do the clean up
        await messageStore.clear();
        await dataStore.clear();
        await eventLog.clear();
      });

      after(async () => {
        await dwn.close();
      });

      it('should return a subscription object', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        const recordsSubscribe = await TestDataGenerator.generateRecordsSubscribe({
          author : alice,
          filter : { schema: 'some-schema' },
        });

        // Send records subscribe message
        const reply = await dwn.processMessage(alice.did, recordsSubscribe.message, { subscriptionHandler: () => {} });
        expect(reply.status.code).to.equal(200);
        expect(reply.subscription).to.exist;
      });

      it('should return 400 if protocol is not normalized', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // subscribe for non-normalized protocol
        const recordsSubscribe = await TestDataGenerator.generateRecordsSubscribe({
          author : alice,
          filter : { protocol: 'example.com/' },
        });

        // overwrite protocol because #create auto-normalizes protocol
        recordsSubscribe.message.descriptor.filter.protocol = 'example.com/';

        // Re-create auth because we altered the descriptor after signing
        recordsSubscribe.message.authorization = await Message.createAuthorization({
          descriptor : recordsSubscribe.message.descriptor,
          signer     : Jws.createSigner(alice)
        });

        // Send records subscribe message
        const reply = await dwn.processMessage(alice.did, recordsSubscribe.message);
        expect(reply.status.code).to.equal(400);
        expect(reply.status.detail).to.contain(DwnErrorCode.UrlProtocolNotNormalized);
      });

      it('should return 400 if schema is not normalized', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // subscribe for non-normalized schema
        const recordsSubscribe = await TestDataGenerator.generateRecordsSubscribe({
          author : alice,
          filter : { schema: 'example.com/' },
        });

        // overwrite schema because #create auto-normalizes schema
        recordsSubscribe.message.descriptor.filter.schema = 'example.com/';

        // Re-create auth because we altered the descriptor after signing
        recordsSubscribe.message.authorization = await Message.createAuthorization({
          descriptor : recordsSubscribe.message.descriptor,
          signer     : Jws.createSigner(alice)
        });

        // Send records subscribe message
        const reply = await dwn.processMessage(alice.did, recordsSubscribe.message);
        expect(reply.status.code).to.equal(400);
        expect(reply.status.detail).to.contain(DwnErrorCode.UrlSchemaNotNormalized);
      });

      it('should return 400 if published is set to false and a datePublished range is provided', async () => {
        const fromDatePublished = Time.getCurrentTimestamp();
        const alice = await TestDataGenerator.generateDidKeyPersona();
        // set to true so create does not fail
        const recordSubscribe = await TestDataGenerator.generateRecordsSubscribe({
          author : alice,
          filter : { datePublished: { from: fromDatePublished }, published: true }
        });

        // set to false
        recordSubscribe.message.descriptor.filter.published = false;
        const subscribeResponse = await dwn.processMessage(alice.did, recordSubscribe.message);
        expect(subscribeResponse.status.code).to.equal(400);
        expect(subscribeResponse.status.detail).to.contain('descriptor/filter/published: must be equal to one of the allowed values');
      });

      it('should return 401 for anonymous subscriptions that filter explicitly for unpublished records', async () => {
        const alice = await TestDataGenerator.generateDidKeyPersona();

        // create an unpublished record
        const draftWrite = await TestDataGenerator.generateRecordsWrite({ author: alice, schema: 'post' });
        const draftWriteReply = await dwn.processMessage(alice.did, draftWrite.message, { dataStream: draftWrite.dataStream });
        expect(draftWriteReply.status.code).to.equal(202);

        // validate that alice can subscribe
        const unpublishedPostSubscribe = await TestDataGenerator.generateRecordsSubscribe({ author: alice, filter: { schema: 'post', published: false } });
        const unpublishedPostReply = await dwn.processMessage(alice.did, unpublishedPostSubscribe.message, { subscriptionHandler: () => {} });
        expect(unpublishedPostReply.status.code).to.equal(200);
        expect(unpublishedPostReply.subscription).to.exist;

        // anonymous subscribe for unpublished records
        const unpublishedAnonymous = await RecordsSubscribe.create({ filter: { schema: 'post', published: false } });
        const anonymousPostReply = await dwn.processMessage(alice.did, unpublishedAnonymous.message);
        expect(anonymousPostReply.status.code).to.equal(401);
        expect(anonymousPostReply.status.detail).contains('Missing JWS');
        expect(anonymousPostReply.subscription).to.not.exist;
      });

      it('should return 401 if signature check fails', async () => {
        const { author, message } = await TestDataGenerator.generateRecordsSubscribe();
        const tenant = author!.did;

        // setting up a stub did resolver & message store
        // intentionally not supplying the public key so a different public key is generated to simulate invalid signature
        const mismatchingPersona = await TestDataGenerator.generatePersona({ did: author!.did, keyId: author!.keyId });
        const didResolver = TestStubGenerator.createDidResolverStub(mismatchingPersona);
        const messageStore = stubInterface<MessageStore>();
        const eventStream = stubInterface<EventStream>();

        const recordsSubscribeHandler = new RecordsSubscribeHandler(didResolver, messageStore, eventStream);
        const reply = await recordsSubscribeHandler.handle({ tenant, message, subscriptionHandler: () => {} });

        expect(reply.status.code).to.equal(401);
      });

      it('should return 400 if fail parsing the message', async () => {
        const { author, message } = await TestDataGenerator.generateRecordsSubscribe();
        const tenant = author!.did;

        // setting up a stub method resolver & message store
        const didResolver = TestStubGenerator.createDidResolverStub(author!);
        const messageStore = stubInterface<MessageStore>();
        const eventStream = stubInterface<EventStream>();
        const recordsSubscribeHandler = new RecordsSubscribeHandler(didResolver, messageStore, eventStream);

        // stub the `parse()` function to throw an error
        sinon.stub(RecordsSubscribe, 'parse').throws('anyError');
        const reply = await recordsSubscribeHandler.handle({ tenant, message, subscriptionHandler: () => {} });

        expect(reply.status.code).to.equal(400);
      });

      describe('protocol based subscriptions', () => {
        it('does not try protocol authorization if protocolRole is not invoked', async () => {
          // scenario: Alice creates a thread and writes some chat messages. Alice addresses
          //           only one chat message to Bob. Bob subscribes by protocol URI without invoking a protocolRole,
          //           and he is able to receive the message addressed to him.

          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          const protocolDefinition = threadRoleProtocolDefinition;

          const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
            author: alice,
            protocolDefinition
          });
          const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
          expect(protocolsConfigureReply.status.code).to.equal(202);

          const messageCids: string[] = [];
          const addCid = async (event: RecordEvent): Promise<void> => {
            const { message } = event;
            const messageCid = await Message.getCid(message);
            messageCids.push(messageCid);
          };

          const bobSubscription = await TestDataGenerator.generateRecordsSubscribe({
            author : bob,
            filter : {
              published : false,
              protocol  : protocolDefinition.protocol,
            }
          });
          const subscriptionReply = await dwn.processMessage(alice.did, bobSubscription.message, { subscriptionHandler: addCid });
          expect(subscriptionReply.status.code).to.equal(200);
          expect(subscriptionReply.subscription).to.exist;

          // Alice writes a 'thread' record
          const threadRecord = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            protocol     : protocolDefinition.protocol,
            protocolPath : 'thread',
          });
          const threadRoleReply = await dwn.processMessage(alice.did, threadRecord.message, { dataStream: threadRecord.dataStream });
          expect(threadRoleReply.status.code).to.equal(202);

          // Alice writes one 'chat' record addressed to Bob
          const chatRecordForBob = await TestDataGenerator.generateRecordsWrite({
            author          : alice,
            recipient       : bob.did,
            protocol        : protocolDefinition.protocol,
            protocolPath    : 'thread/chat',
            published       : false,
            parentContextId : threadRecord.message.contextId,
            data            : new TextEncoder().encode('Bob can read this cuz he is my friend'),
          });
          const chatRecordForBobReply = await dwn.processMessage(alice.did, chatRecordForBob.message, { dataStream: chatRecordForBob.dataStream });
          expect(chatRecordForBobReply.status.code).to.equal(202);

          // Alice writes two 'chat' records NOT addressed to Bob
          for (let i = 0; i < 2; i++) {
            const chatRecord = await TestDataGenerator.generateRecordsWrite({
              author          : alice,
              recipient       : alice.did,
              protocol        : protocolDefinition.protocol,
              protocolPath    : 'thread/chat',
              published       : false,
              parentContextId : threadRecord.message.contextId,
              data            : new TextEncoder().encode('Bob cannot read this'),
            });
            const chatReply = await dwn.processMessage(alice.did, chatRecord.message, { dataStream: chatRecord.dataStream });
            expect(chatReply.status.code).to.equal(202);
          }

          expect(messageCids.length).to.equal(1, 'before delete');
          expect(messageCids[0]).to.equal(await Message.getCid(chatRecordForBob.message));
        });

        it('should allows role authorized subscriptions', async () => {
          // scenario: Alice creates a thread and writes some chat messages writes a chat message. Bob invokes his
          //           thread member role in order to subscribe to the chat messages.

          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          const protocolDefinition = friendRoleProtocolDefinition;

          const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
            author: alice,
            protocolDefinition
          });
          const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
          expect(protocolsConfigureReply.status.code).to.equal(202);

          const filter: RecordsFilter = {
            published    : false,
            protocol     : protocolDefinition.protocol,
            protocolPath : 'chat'
          };

          const noRoleRecords: string[] = [];
          const addNoRole = async (event: RecordEvent): Promise<void> => {
            const { message } = event;
            if (message.descriptor.method === DwnMethodName.Write) {
              const recordsWriteMessage = message as RecordsWriteMessage;
              noRoleRecords.push(recordsWriteMessage.recordId);
            }
          };

          // subscribe without role, expect no messages
          const noRoleSubscription = await TestDataGenerator.generateRecordsSubscribe({
            author: bob,
            filter
          });

          const subscriptionReply = await dwn.processMessage(alice.did, noRoleSubscription.message, { subscriptionHandler: addNoRole });
          expect(subscriptionReply.status.code).to.equal(200);
          expect(subscriptionReply.subscription).to.exist;


          // Alice writes a 'friend' root-level role record with Bob as recipient
          const friendRoleRecord = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            recipient    : bob.did,
            protocol     : protocolDefinition.protocol,
            protocolPath : 'friend',
            data         : new TextEncoder().encode('Bob is my friend'),
          });
          const friendRoleReply = await dwn.processMessage(alice.did, friendRoleRecord.message, { dataStream: friendRoleRecord.dataStream });
          expect(friendRoleReply.status.code).to.equal(202);

          const recordIds: string[] = [];
          const addRecord:RecordSubscriptionHandler = async (event) => {
            const { message } = event;
            if (message.descriptor.method === DwnMethodName.Write) {
              const recordsWriteMessage = message as RecordsWriteMessage;
              recordIds.push(recordsWriteMessage.recordId);
            }
          };

          // subscribe with friend role
          const bobSubscriptionWithRole = await TestDataGenerator.generateRecordsSubscribe({
            filter,
            author       : bob,
            protocolRole : 'friend',
          });

          const subscriptionWithRoleReply = await dwn.processMessage(alice.did, bobSubscriptionWithRole.message, { subscriptionHandler: addRecord });
          expect(subscriptionWithRoleReply.status.code).to.equal(200);
          expect(subscriptionWithRoleReply.subscription).to.exist;


          // Alice writes three 'chat' records
          const chatRecordIds = [];
          for (let i = 0; i < 3; i++) {
            const chatRecord = await TestDataGenerator.generateRecordsWrite({
              author       : alice,
              recipient    : alice.did,
              protocol     : protocolDefinition.protocol,
              protocolPath : 'chat',
              published    : false,
              data         : new TextEncoder().encode('Bob can read this cuz he is my friend'),
            });
            const chatReply = await dwn.processMessage(alice.did, chatRecord.message, { dataStream: chatRecord.dataStream });
            expect(chatReply.status.code).to.equal(202);
            chatRecordIds.push(chatRecord.message.recordId);
          }

          // there should not be any messages in the subscription without a friend role.
          expect(noRoleRecords.length).to.equal(0);

          // should have all chat messages
          expect(recordIds).to.have.members(chatRecordIds);
        });

        it('allows protocol authorized subscriptions', async () => {
          // scenario: Alice writes some chat messages.
          //           Bob, having a thread/participant record, can subscribe to the chat.

          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          const protocolDefinition = threadRoleProtocolDefinition;

          const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
            author: alice,
            protocolDefinition
          });
          const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
          expect(protocolsConfigureReply.status.code).to.equal(202);


          // Alice writes a 'thread' record
          const threadRecord = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            protocol     : protocolDefinition.protocol,
            protocolPath : 'thread',
          });
          const threadRoleReply = await dwn.processMessage(alice.did, threadRecord.message, { dataStream: threadRecord.dataStream });
          expect(threadRoleReply.status.code).to.equal(202);

          const filter: RecordsFilter = {
            protocol     : protocolDefinition.protocol,
            protocolPath : 'thread/chat',
            contextId    : threadRecord.message.contextId,
          };

          const noRoleRecords: string[] = [];
          const addNoRole = async (event: RecordEvent): Promise<void> => {
            const { message } = event;
            if (message.descriptor.interface === DwnInterfaceName.Records && message.descriptor.method === DwnMethodName.Write) {
              const recordsWriteMessage = message as RecordsWriteMessage;
              noRoleRecords.push(recordsWriteMessage.recordId);
            }
          };

          // subscribe without role, expect no messages
          const noRoleSubscription = await TestDataGenerator.generateRecordsSubscribe({
            author: bob,
            filter
          });

          const subscriptionReply = await dwn.processMessage(alice.did, noRoleSubscription.message, { subscriptionHandler: addNoRole });
          expect(subscriptionReply.status.code).to.equal(200);
          expect(subscriptionReply.subscription).to.exist;

          // Alice writes a 'participant' role record with Bob as recipient
          const participantRoleRecord = await TestDataGenerator.generateRecordsWrite({
            author          : alice,
            recipient       : bob.did,
            protocol        : protocolDefinition.protocol,
            protocolPath    : 'thread/participant',
            parentContextId : threadRecord.message.contextId,
            data            : new TextEncoder().encode('Bob is my friend'),
          });
          const participantRoleReply =
            await dwn.processMessage(alice.did, participantRoleRecord.message, { dataStream: participantRoleRecord.dataStream });
          expect(participantRoleReply.status.code).to.equal(202);

          const recordIds: string[] = [];
          const addRecord:RecordSubscriptionHandler = async (event) => {
            const { message } = event;
            if (message.descriptor.method === DwnMethodName.Write) {
              const recordsWriteMessage = message as RecordsWriteMessage;
              recordIds.push(recordsWriteMessage.recordId);
            }
          };

          // subscribe with the participant role
          const bobSubscriptionWithRole = await TestDataGenerator.generateRecordsSubscribe({
            filter,
            author       : bob,
            protocolRole : 'thread/participant',
          });

          const subscriptionWithRoleReply = await dwn.processMessage(alice.did, bobSubscriptionWithRole.message, { subscriptionHandler: addRecord });
          expect(subscriptionWithRoleReply.status.code).to.equal(200);
          expect(subscriptionWithRoleReply.subscription).to.exist;


          // Alice writes three 'chat' records
          const chatRecordIds = [];
          for (let i = 0; i < 3; i++) {
            const chatRecord = await TestDataGenerator.generateRecordsWrite({
              author          : alice,
              recipient       : alice.did,
              protocol        : protocolDefinition.protocol,
              protocolPath    : 'thread/chat',
              published       : false,
              parentContextId : threadRecord.message.contextId,
              data            : new TextEncoder().encode('Bob can read this cuz he is my friend'),
            });
            const chatReply = await dwn.processMessage(alice.did, chatRecord.message, { dataStream: chatRecord.dataStream });
            expect(chatReply.status.code).to.equal(202);
            chatRecordIds.push(chatRecord.message.recordId);
          }

          // there should not be any messages in the subscription without a participant role.
          expect(noRoleRecords.length).to.equal(0);

          // should have all chat messages.
          expect(recordIds).to.have.members(chatRecordIds);
        });

        it('does not execute protocol subscriptions where protocolPath is missing from the filter', async () => {
          // scenario: Alice assigns Bob a friend role and writes some chat messages. Bob invokes his role to subscribe those messages,
          //           but his subscription filter does not include protocolPath.

          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          const protocolDefinition = friendRoleProtocolDefinition;

          const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
            author: alice,
            protocolDefinition
          });
          const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
          expect(protocolsConfigureReply.status.code).to.equal(202);

          // Alice writes a 'friend' root-level role record with Bob as recipient
          const friendRoleRecord = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            recipient    : bob.did,
            protocol     : protocolDefinition.protocol,
            protocolPath : 'friend',
            data         : new TextEncoder().encode('Bob is my friend'),
          });
          const friendRoleReply = await dwn.processMessage(alice.did, friendRoleRecord.message, { dataStream: friendRoleRecord.dataStream });
          expect(friendRoleReply.status.code).to.equal(202);

          // Bob invokes his friendRole to subscribe but does not have `protocolPath` in the filter
          const chatSubscribe = await TestDataGenerator.generateRecordsSubscribe({
            author : bob,
            filter : {
              protocol: protocolDefinition.protocol,
              // protocolPath deliberately omitted
            },
            protocolRole: 'friend',
          });
          const chatSubscribeReply = await dwn.processMessage(alice.did, chatSubscribe.message);
          expect(chatSubscribeReply.status.code).to.equal(400);
          expect(chatSubscribeReply.status.detail).to.contain(DwnErrorCode.RecordsSubscribeFilterMissingRequiredProperties);
          expect(chatSubscribeReply.subscription).to.not.exist;
        });

        it('does not execute context role authorized subscriptions where contextId is missing from the filter', async () => {
          // scenario: Alice gives Bob a role allowing him to access a particular chat thread.
          //           But Bob's filter does not contain a contextId so the subscription fails.
          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          const protocolDefinition = threadRoleProtocolDefinition;

          const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
            author: alice,
            protocolDefinition
          });
          const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
          expect(protocolsConfigureReply.status.code).to.equal(202);

          // Alice writes a 'thread' record
          const threadRecord = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            protocol     : protocolDefinition.protocol,
            protocolPath : 'thread',
          });
          const threadRoleReply = await dwn.processMessage(alice.did, threadRecord.message, { dataStream: threadRecord.dataStream });
          expect(threadRoleReply.status.code).to.equal(202);

          // Alice writes a 'friend' root-level role record with Bob as recipient
          const participantRoleRecord = await TestDataGenerator.generateRecordsWrite({
            author          : alice,
            recipient       : bob.did,
            protocol        : protocolDefinition.protocol,
            protocolPath    : 'thread/participant',
            parentContextId : threadRecord.message.contextId,
            data            : new TextEncoder().encode('Bob is my friend'),
          });
          const participantRoleReply =
            await dwn.processMessage(alice.did, participantRoleRecord.message, { dataStream: participantRoleRecord.dataStream });
          expect(participantRoleReply.status.code).to.equal(202);

          // Bob invokes his thread participant role to subscribe but omits the contextId
          const chatSubscribe = await TestDataGenerator.generateRecordsSubscribe({
            author : bob,
            filter : {
              protocol     : protocolDefinition.protocol,
              protocolPath : 'thread/chat',
              // contextId deliberately omitted
            },
            protocolRole: 'thread/participant',
          });
          const chatSubscribeReply = await dwn.processMessage(alice.did, chatSubscribe.message);
          expect(chatSubscribeReply.status.code).to.eq(401);
          expect(chatSubscribeReply.status.detail).to.contain(DwnErrorCode.ProtocolAuthorizationMissingContextId);
          expect(chatSubscribeReply.subscription).to.not.exist;
        });

        it('rejects role authorized subscriptions if the request author does not have a matching root-level role', async () => {
          // scenario: Alice installs a chat protocol.
          // Bob invokes a root-level role within that protocol to subscribe but fails because he does not actually have a role.

          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          const protocolDefinition = friendRoleProtocolDefinition;

          const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
            author: alice,
            protocolDefinition
          });
          const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
          expect(protocolsConfigureReply.status.code).to.equal(202);

          // Bob invokes a friendRole he does not have to subscribe to the records
          const chatSubscribe = await TestDataGenerator.generateRecordsSubscribe({
            author : bob,
            filter : {
              protocol     : protocolDefinition.protocol,
              protocolPath : 'chat',
            },
            protocolRole: 'friend',
          });
          const chatSubscribeReply = await dwn.processMessage(alice.did, chatSubscribe.message);
          expect(chatSubscribeReply.status.code).to.eq(401);
          expect(chatSubscribeReply.status.detail).to.contain(DwnErrorCode.ProtocolAuthorizationMatchingRoleRecordNotFound);
          expect(chatSubscribeReply.subscription).to.not.exist;
        });

        it('rejects role authorized subscriptions where the subscription author does not have a matching context role', async () => {

          const alice = await TestDataGenerator.generateDidKeyPersona();
          const bob = await TestDataGenerator.generateDidKeyPersona();

          const protocolDefinition = threadRoleProtocolDefinition;

          const protocolsConfig = await TestDataGenerator.generateProtocolsConfigure({
            author: alice,
            protocolDefinition
          });
          const protocolsConfigureReply = await dwn.processMessage(alice.did, protocolsConfig.message);
          expect(protocolsConfigureReply.status.code).to.equal(202);

          // Alice writes a 'thread' record
          const threadRecord = await TestDataGenerator.generateRecordsWrite({
            author       : alice,
            protocol     : protocolDefinition.protocol,
            protocolPath : 'thread',
          });
          const threadRoleReply = await dwn.processMessage(alice.did, threadRecord.message, { dataStream: threadRecord.dataStream });
          expect(threadRoleReply.status.code).to.equal(202);

          // Bob invokes his a `thread/participant` role which he does not have to subscribe to the records
          const chatSubscribe = await TestDataGenerator.generateRecordsSubscribe({
            author : bob,
            filter : {
              protocol     : protocolDefinition.protocol,
              protocolPath : 'thread/chat',
              contextId    : threadRecord.message.contextId,
            },
            protocolRole: 'thread/participant',
          });
          const chatSubscribeReply = await dwn.processMessage(alice.did, chatSubscribe.message);
          expect(chatSubscribeReply.status.code).to.eq(401);
          expect(chatSubscribeReply.status.detail).to.contain(DwnErrorCode.ProtocolAuthorizationMatchingRoleRecordNotFound);
          expect(chatSubscribeReply.subscription).to.not.exist;
        });
      });
    });
  });
}