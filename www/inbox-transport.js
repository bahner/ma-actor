import { contentTypeToRouteKey } from './inbox-dispatcher.js';

export function createInboxTransport({
  state,
  logger,
  startInboxListener,
  pollInboxMessages,
  inspectSignedMessage,
  dispatchInboundEvent
}) {
  async function ensureInboxListener() {
    if (state.inboxEndpointId) {
      return state.inboxEndpointId;
    }
    const endpointId = await startInboxListener();
    state.inboxEndpointId = endpointId;
    logger.log('inbox.listener', `listening on ${endpointId}`);
    return endpointId;
  }

  async function pollDirectInbox() {
    if (!state.identity || state.inboxPollInFlight) {
      return;
    }
    await ensureInboxListener();
    state.inboxPollInFlight = true;

    try {
      const result = JSON.parse(await pollInboxMessages());
      if (!result || !Array.isArray(result.messages) || result.messages.length === 0) {
        return;
      }

      for (const item of result.messages) {
        const meta = JSON.parse(inspectSignedMessage(item.message_cbor_b64));
        const routeKey = contentTypeToRouteKey(meta.content_type);
        if (!routeKey) {
          logger.log('inbox.dispatch', `ignoring unsupported inbound content_type=${meta.content_type}`);
          continue;
        }

        await dispatchInboundEvent({
          kind: routeKey === 'application/x-ma-whisper' ? 'whisper' : 'chat',
          mime_type: routeKey,
          sender: '',
          sender_did: meta.from,
          sender_endpoint: item.from_endpoint || '',
          message: '',
          message_cbor_b64: item.message_cbor_b64,
          sequence: 0,
          occurred_at: ''
        });
      }
    } finally {
      state.inboxPollInFlight = false;
    }
  }

  return {
    ensureInboxListener,
    pollDirectInbox
  };
}
