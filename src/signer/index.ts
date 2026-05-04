/**
 * Signer Module
 *
 * Exports for signing, publishing, and event building functionality.
 */

// Signer Manager
export {
  SignerManager,
  type Signer,
  type UnsignedEvent,
  type SignedEvent,
  type SignerSession,
  type PendingConnection,
  type InitConnectionResult,
  type ConnectionStatus,
} from './manager.js';

// Publish Service
export {
  PublishService,
  getPublishService,
  type PublishResult,
  type PublishOptions,
} from './publish.js';

// Event Builders
export {
  buildMetadataEvent,
  buildAMBResourceEvent,
  buildEvent,
  type ProfileMetadata,
  type AMBEntity,
  type AMBConcept,
  type AMBResourceInput,
} from './event-builder.js';

// Relay List Service (NIP-65)
export {
  RelayListService,
  getRelayListService,
  parseRelayListEvent,
  type RelayList,
} from './relay-list.js';
