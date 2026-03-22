import init, {
  create_identity_with_ipns,
  unlock_identity,
  set_bundle_locale,
  generate_bip39_phrase,
  normalize_bip39_phrase,
  connect_world,
  connect_world_with_relay,
  enter_world,
  poll_world_events,
  send_world_message,
  disconnect_world
} from './pkg/ma_home.js';

const STORAGE_PREFIX = 'ma.identity.v3';
const API_KEY = `${STORAGE_PREFIX}.kuboApi`;
const ALIAS_BOOK_KEY = `${STORAGE_PREFIX}.aliasBook`;
const LAST_ALIAS_KEY = `${STORAGE_PREFIX}.lastAlias`;
const TAB_ALIAS_KEY = `${STORAGE_PREFIX}.tabAlias`;
const DEBUG_KEY = `${STORAGE_PREFIX}.debug`;
const LEGACY_BUNDLE_KEY = 'ma.identity.v2.bundle';
const LEGACY_API_KEY = 'ma.identity.v2.kuboApi';
const LEGACY_ALIAS_KEY = 'ma.identity.v2.alias';
const LEGACY_PHRASE_KEY = 'ma.identity.v2.recoveryPhrase';
const DEFAULT_LOCALE = 'en';

const LOCALE_LABELS = {
  en: { label: 'English', here: 'here', me: 'me', say: 'say', who: 'who' },
  'nb-NO': { label: 'Norsk bokmal', here: 'her', me: 'meg', say: 'si', who: 'hvem' }
};
const ROOM_POLL_INTERVAL_MS = 1500;

const state = {
  identity: null,
  encryptedBundle: '',
  aliasName: '',
  locale: DEFAULT_LOCALE,
  debug: false,
  aliasBook: {},
  currentHome: null,
  roomPollTimer: null,
  roomPollInFlight: false,
  pollErrorShown: false,
  passphrase: '',
  commandHistory: [],
  historyIndex: -1,
  historyDraft: ''
};

function readStoredDebugFlag() {
  const raw = localStorage.getItem(DEBUG_KEY);
  if (!raw) return false;
  const value = raw.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'on';
}

function setDebugMode(enabled, announce = true) {
  state.debug = Boolean(enabled);
  localStorage.setItem(DEBUG_KEY, state.debug ? '1' : '0');
  if (announce) {
    appendMessage('system', `Debug mode: ${state.debug ? 'on' : 'off'}`);
  }
}

function byId(id) {
  return document.getElementById(id);
}

function setKuboStatus(message, kind = 'idle') {
  const el = byId('kubo-status');
  el.textContent = message;
  el.className = `status ${kind}`;
}

function setSetupStatus(message) {
  byId('setup-status').textContent = message;
}

function appendMessage(role, message) {
  const transcript = byId('transcript');
  const row = document.createElement('div');
  row.className = `msg ${role}`;

  const label = document.createElement('span');
  label.className = 'msg-role';
  label.textContent = role;

  const text = document.createElement('p');
  text.textContent = message;

  row.appendChild(label);
  row.appendChild(text);
  transcript.appendChild(row);
  transcript.scrollTop = transcript.scrollHeight;
}

// Logging system: logs are shown when debug mode is enabled
const logger = {
  log(scope, ...args) {
    if (!state.debug) return;
    const message = args
      .map(arg => {
        if (typeof arg === 'object') {
          try {
            return JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        }
        return String(arg);
      })
      .join(' ');
    appendMessage('system', `[${scope}] ${message}`);
  }
};

function stopHomeEventPolling() {
  if (state.roomPollTimer) {
    clearInterval(state.roomPollTimer);
    state.roomPollTimer = null;
  }
  state.roomPollInFlight = false;
  state.pollErrorShown = false;
}

function renderRoomEvent(event) {
  if (!event || !event.message) {
    return;
  }

  // Avoid showing local chat twice: once as "you" input and once from world fanout.
  if (event.kind === 'speech' && event.sender && state.aliasName && event.sender === state.aliasName) {
    return;
  }

  const role = event.kind === 'system' ? 'system' : 'world';
  appendMessage(role, event.message);
}

async function pollCurrentHomeEvents() {
  if (!state.currentHome || state.roomPollInFlight) {
    return;
  }

  state.roomPollInFlight = true;

  const home = state.currentHome;
  const pollStart = Date.now();
  
  try {
    logger.log('poll.events', `room=${home.room} since_seq=${home.lastEventSequence || 0} endpoint=${home.endpointId.slice(0, 8)}...`);
    
    const result = JSON.parse(
      await poll_world_events(
        home.endpointId,
        state.passphrase,
        state.encryptedBundle,
        state.aliasName,
        home.room,
        toSequenceBigInt(home.lastEventSequence || 0)
      )
    );
    const elapsed = Date.now() - pollStart;
    logger.log('poll.events', `response ok=${result.ok} events_count=${(result.events || []).length} latest_seq=${result.latest_event_sequence || 0} in ${elapsed}ms`);

    if (!state.currentHome || state.currentHome.endpointId !== home.endpointId || state.currentHome.room !== home.room) {
      logger.log('poll.events', `room context changed, discarding response`);
      return;
    }

    let nextSequence = toSequenceNumber(home.lastEventSequence || 0);
    for (const event of result.events || []) {
      const eventSequence = toSequenceNumber(event.sequence);
      if (eventSequence <= nextSequence) {
        logger.log('poll.events', `skipping duplicate event seq=${eventSequence}`);
        continue;
      }
      logger.log('poll.events', `rendering event seq=${eventSequence} kind=${event.kind} sender=${event.sender || '(system)'}:  ${event.message.slice(0, 40)}`);
      renderRoomEvent(event);
      nextSequence = eventSequence;
    }

    state.currentHome.lastEventSequence = Math.max(
      nextSequence,
      toSequenceNumber(result.latest_event_sequence || home.lastEventSequence || 0)
    );
    state.pollErrorShown = false;
  } catch (error) {
    const elapsed = Date.now() - pollStart;
    logger.log('poll.events', `failed after ${elapsed}ms: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  } finally {
    state.roomPollInFlight = false;
  }
}

function startHomeEventPolling() {
  stopHomeEventPolling();
  state.roomPollTimer = setInterval(() => {
    pollCurrentHomeEvents().catch((error) => {
      if (state.debug) {
        console.error('room event poll failed', error);
      }
      if (!state.pollErrorShown) {
        appendMessage('system', `Room sync failed: ${error instanceof Error ? error.message : String(error)}`);
        state.pollErrorShown = true;
      }
    });
  }, ROOM_POLL_INTERVAL_MS);
}

function updateIdentityLine() {
  if (!state.identity) {
    byId('identity-line').textContent = '';
    return;
  }
  const locale = state.locale ? ` | locale ${state.locale}` : '';
  const home = state.currentHome
    ? ` | world ${state.currentHome.alias} (${state.currentHome.room})`
    : '';
  byId('identity-line').textContent = `did ${state.identity.did} | ipns ${state.identity.ipns} | alias ${state.aliasName}${locale}${home}`;
}

function showChat() {
  byId('setup-view').classList.add('hidden');
  byId('chat-view').classList.remove('hidden');
  updateIdentityLine();

  const aliases = Object.keys(state.aliasBook).length;
  appendMessage('system', 'Ready to explore.');
  appendMessage('system', `Saved aliases: ${aliases}. Use /help for commands.`);
  if (state.debug) {
    logger.log('app', 'debug mode is on');
  }
  byId('command-input').focus();
}

async function runSmokeTest(targetAlias) {
  if (!state.identity) {
    throw new Error('Load or create an identity before running smoke test.');
  }

  const alias = String(targetAlias || state.currentHome?.alias || 'home').trim();
  if (!alias) {
    throw new Error('Usage: /smoke [alias]');
  }

  const marker = `smoke-${Date.now().toString(36)}`;
  appendMessage('system', `Smoke: enter ${alias} -> send marker -> poll`);

  await enterHome(alias);

  if (!state.currentHome) {
    throw new Error('Smoke failed: no active home after enter.');
  }

  const sendResult = JSON.parse(
    await withTimeout(
      send_world_message(
        state.currentHome.endpointId,
        state.passphrase,
        state.encryptedBundle,
        state.aliasName,
        state.currentHome.room,
        state.locale,
        marker
      ),
      12000,
      'smoke send timed out'
    )
  );

  if (!sendResult.ok) {
    throw new Error(`Smoke failed: send returned ok=false (${sendResult.message || 'no message'})`);
  }

  const beforeSeq = toSequenceNumber(state.currentHome.lastEventSequence || 0);
  await withTimeout(pollCurrentHomeEvents(), 12000, 'smoke poll timed out');
  const afterSeq = toSequenceNumber(state.currentHome.lastEventSequence || 0);

  appendMessage(
    'system',
    `Smoke PASS: enter ok, send ok (broadcasted=${Boolean(sendResult.broadcasted)}), sequence ${beforeSeq} -> ${afterSeq}, marker=${marker}`
  );
}

function showSetup() {
  stopHomeEventPolling();
  byId('chat-view').classList.add('hidden');
  byId('setup-view').classList.remove('hidden');
}

function saveAliasBook() {
  localStorage.setItem(ALIAS_BOOK_KEY, JSON.stringify(state.aliasBook));
}

function loadAliasBook() {
  try {
    const raw = localStorage.getItem(ALIAS_BOOK_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch {
    return {};
  }
}

function isValidAliasName(aliasName) {
  return /^[a-z0-9_-]{2,32}$/i.test(String(aliasName || '').trim());
}

function normalizeLocale(value) {
  const normalized = String(value || '').trim().replace(/_/g, '-').toLowerCase();
  if (['nb', 'nb-no', 'nb-no.utf8', 'nb-no.utf-8'].includes(normalized)) {
    return 'nb-NO';
  }
  return DEFAULT_LOCALE;
}

function localeLabels() {
  return LOCALE_LABELS[state.locale] || LOCALE_LABELS[DEFAULT_LOCALE];
}

function setLanguageSelection(value) {
  const locale = normalizeLocale(value);
  byId('actor-language').value = locale;
  state.locale = locale;
}

function toSequenceNumber(value) {
  if (typeof value === 'bigint') {
    return Number(value);
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function toSequenceBigInt(value) {
  if (typeof value === 'bigint') {
    return value;
  }

  const numeric = toSequenceNumber(value);
  return BigInt(Math.max(0, Math.floor(numeric)));
}

function identityRecordKey(aliasName) {
  return `${STORAGE_PREFIX}.identity.${String(aliasName || '').trim().toLowerCase()}`;
}

function readStoredJson(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function saveIdentityRecord(aliasName, encryptedBundle, recoveryPhrase) {
  if (!isValidAliasName(aliasName)) {
    return;
  }

  const locale = normalizeLocale(byId('actor-language').value);

  localStorage.setItem(
    identityRecordKey(aliasName),
    JSON.stringify({
      aliasName,
      encryptedBundle,
      recoveryPhrase,
      locale
    })
  );
}

function loadIdentityRecord(aliasName) {
  if (!isValidAliasName(aliasName)) {
    return null;
  }

  const parsed = readStoredJson(identityRecordKey(aliasName));
  if (!parsed) {
    return null;
  }

  return {
    aliasName: typeof parsed.aliasName === 'string' ? parsed.aliasName : aliasName,
    encryptedBundle: typeof parsed.encryptedBundle === 'string' ? parsed.encryptedBundle : '',
    recoveryPhrase: typeof parsed.recoveryPhrase === 'string' ? parsed.recoveryPhrase : '',
    locale: normalizeLocale(parsed.locale)
  };
}

function loadLegacyIdentityRecord(aliasName) {
  const legacyAlias = localStorage.getItem(LEGACY_ALIAS_KEY);
  if (!isValidAliasName(aliasName) || legacyAlias !== aliasName) {
    return null;
  }

  return {
    aliasName,
    encryptedBundle: localStorage.getItem(LEGACY_BUNDLE_KEY) || '',
    recoveryPhrase: localStorage.getItem(LEGACY_PHRASE_KEY) || '',
    locale: DEFAULT_LOCALE
  };
}

function resolveIdentityRecord(aliasName) {
  return loadIdentityRecord(aliasName) || loadLegacyIdentityRecord(aliasName);
}

function setActiveAlias(aliasName) {
  const normalized = String(aliasName || '').trim();
  if (!normalized) {
    sessionStorage.removeItem(TAB_ALIAS_KEY);
    return;
  }

  sessionStorage.setItem(TAB_ALIAS_KEY, normalized);
  localStorage.setItem(LAST_ALIAS_KEY, normalized);
}

function resolveInitialAlias() {
  const urlAlias = new URLSearchParams(window.location.search).get('alias');
  if (isValidAliasName(urlAlias)) {
    return urlAlias.trim();
  }

  const tabAlias = sessionStorage.getItem(TAB_ALIAS_KEY);
  if (isValidAliasName(tabAlias)) {
    return tabAlias.trim();
  }

  const lastAlias = localStorage.getItem(LAST_ALIAS_KEY);
  if (isValidAliasName(lastAlias)) {
    return lastAlias.trim();
  }

  const legacyAlias = localStorage.getItem(LEGACY_ALIAS_KEY);
  if (isValidAliasName(legacyAlias)) {
    return legacyAlias.trim();
  }

  return '';
}

function setRecoveryPhraseInput(value) {
  if (!value) {
    byId('recovery-phrase').value = '';
    return;
  }

  try {
    byId('recovery-phrase').value = normalizeRecoveryPhrase(value);
  } catch {
    byId('recovery-phrase').value = '';
  }
}

function loadAliasDraft(aliasName) {
  const normalized = String(aliasName || '').trim();
  if (!normalized) {
    byId('bundle-text').value = '';
    if (!byId('recovery-phrase').value.trim()) {
      onNewPhrase();
    }
    return;
  }

  setActiveAlias(normalized);
  const record = resolveIdentityRecord(normalized);
  byId('bundle-text').value = record?.encryptedBundle || '';
  setLanguageSelection(record?.locale || DEFAULT_LOCALE);

  if (record?.recoveryPhrase) {
    setRecoveryPhraseInput(record.recoveryPhrase);
  } else if (!byId('recovery-phrase').value.trim()) {
    onNewPhrase();
  }
}

function exportBundle() {
  if (!state.encryptedBundle) {
    appendMessage('system', 'No bundle loaded in memory to export.');
    return;
  }
  const blob = new Blob([state.encryptedBundle], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ma-identity-${state.aliasName || 'bundle'}.json`;
  a.click();
  URL.revokeObjectURL(url);
  appendMessage('system', `Bundle exported as ${a.download}`);
}

function getApiBase() {
  return (byId('kubo-api').value.trim() || 'http://127.0.0.1:5001').replace(/\/$/, '');
}

async function kuboPost(path, query = {}, body = null) {
  const base = getApiBase();
  const params = new URLSearchParams(query);
  const url = `${base}${path}${params.toString() ? `?${params.toString()}` : ''}`;
  let response;

  try {
    response = await fetch(url, {
      method: 'POST',
      body
    });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error('Unable to reach Kubo API from browser. Check API URL, ensure Kubo is running, and allow CORS for the app origin and headers.');
    }
    throw error;
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Kubo API ${response.status}: ${text || response.statusText}`);
  }

  try {
    return await response.json();
  } catch {
    const text = await response.text();
    throw new Error(`Kubo API returned non-JSON response: ${text || '(empty body)'}`);
  }
}

async function checkKubo() {
  setKuboStatus('checking...', 'working');
  try {
    const payload = await kuboPost('/api/v0/key/list', { l: 'true' });
    const keys = Array.isArray(payload?.Keys) ? payload.Keys : [];
    setKuboStatus(`connected (${keys.length} keys)`, 'ok');
    setSetupStatus('Kubo API reachable.');
    return keys;
  } catch (error) {
    setKuboStatus('not reachable from browser', 'error');
    setSetupStatus(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

async function ensureKuboAliasKey(aliasName) {
  const keys = await checkKubo();
  const found = keys.find((k) => k.Name === aliasName);
  if (found) {
    return found.Id;
  }

  const created = await kuboPost('/api/v0/key/gen', {
    arg: aliasName,
    type: 'ed25519'
  });

  return created.Id;
}

function validateSetupInputs(requireBundle) {
  const aliasName = byId('alias-name').value.trim();
  const passphrase = byId('passphrase').value;
  const bundle = byId('bundle-text').value.trim();

  if (!isValidAliasName(aliasName)) {
    throw new Error('Alias must be 2-32 chars using letters, numbers, underscore, or dash.');
  }
  if (passphrase.length < 8) {
    throw new Error('Passphrase must be at least 8 characters.');
  }
  if (requireBundle && !bundle) {
    throw new Error('Provide an encrypted bundle to unlock.');
  }

  return { aliasName, passphrase, bundle };
}

function generateRecoveryPhrase(wordCount = 12) {
  return generate_bip39_phrase(wordCount);
}

function normalizeRecoveryPhrase(input) {
  const value = String(input || '').trim();
  if (!value) {
    return '';
  }
  return normalize_bip39_phrase(value);
}

function resolveRecoveryPhraseFromInput() {
  const raw = byId('recovery-phrase').value;
  const trimmed = String(raw || '').trim();
  if (!trimmed) {
    return generateRecoveryPhrase(12);
  }
  return normalizeRecoveryPhrase(trimmed);
}

async function onCreateIdentity() {
  setSetupStatus('Creating identity...');
  try {
    const { aliasName, passphrase } = validateSetupInputs(false);
    const locale = normalizeLocale(byId('actor-language').value);
    localStorage.setItem(API_KEY, getApiBase());
    setActiveAlias(aliasName);

    const ipns = await ensureKuboAliasKey(aliasName);
    const created = JSON.parse(create_identity_with_ipns(passphrase, ipns));
    const result = JSON.parse(set_bundle_locale(passphrase, created.encrypted_bundle, locale));

    state.identity = result;
    state.encryptedBundle = result.encrypted_bundle;
    state.passphrase = passphrase;
    state.aliasName = aliasName;
    state.locale = locale;

    byId('bundle-text').value = result.encrypted_bundle;

    const phrase = resolveRecoveryPhraseFromInput();
    byId('recovery-phrase').value = phrase;
    saveIdentityRecord(aliasName, result.encrypted_bundle, phrase);

    setSetupStatus('Identity created and unlocked.');
    showChat();
  } catch (error) {
    setSetupStatus(error instanceof Error ? error.message : String(error));
  }
}

async function onUnlockIdentity() {
  setSetupStatus('Unlocking bundle...');
  try {
    const { aliasName, passphrase, bundle } = validateSetupInputs(true);
    const locale = normalizeLocale(byId('actor-language').value);
    localStorage.setItem(API_KEY, getApiBase());
    setActiveAlias(aliasName);

    const ipns = await ensureKuboAliasKey(aliasName);
    const unlocked = JSON.parse(unlock_identity(passphrase, bundle));

    if (unlocked.ipns !== ipns) {
      appendMessage('system', `Warning: bundle ipns (${unlocked.ipns}) does not match alias key ipns (${ipns}).`);
    }

    const updated = JSON.parse(set_bundle_locale(passphrase, bundle, locale));

    state.identity = updated;
    state.encryptedBundle = updated.encrypted_bundle;
    state.passphrase = passphrase;
    state.aliasName = aliasName;
    state.locale = locale;

    byId('bundle-text').value = updated.encrypted_bundle;

    const phrase = resolveRecoveryPhraseFromInput();
    byId('recovery-phrase').value = phrase;
    saveIdentityRecord(aliasName, updated.encrypted_bundle, phrase);

    setSetupStatus('Bundle unlocked.');
    showChat();
  } catch (error) {
    setSetupStatus(error instanceof Error ? error.message : String(error));
  }
}

function onNewPhrase() {
  const phrase = generateRecoveryPhrase(12);
  byId('recovery-phrase').value = phrase;

  const aliasName = byId('alias-name').value.trim();
  const bundle = byId('bundle-text').value.trim();
  if (isValidAliasName(aliasName)) {
    saveIdentityRecord(aliasName, bundle, phrase);
  }
}

function onLanguageChange() {
  const locale = normalizeLocale(byId('actor-language').value);
  applyLocaleChange(locale).catch((error) => {
    appendMessage('system', `Locale change failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

async function applyLocaleChange(localeValue) {
  const locale = normalizeLocale(localeValue);
  setLanguageSelection(locale);

  const aliasName = (state.aliasName || byId('alias-name').value || '').trim();
  const phrase = byId('recovery-phrase').value.trim();
  const passphrase = byId('passphrase').value;

  if (state.identity && state.encryptedBundle && passphrase.length >= 8) {
    const updated = JSON.parse(set_bundle_locale(passphrase, state.encryptedBundle, locale));
    state.identity = updated;
    state.encryptedBundle = updated.encrypted_bundle;
    byId('bundle-text').value = updated.encrypted_bundle;
  }

  if (isValidAliasName(aliasName)) {
    saveIdentityRecord(aliasName, byId('bundle-text').value.trim(), phrase);
  }

  updateIdentityLine();
  setSetupStatus(`Actor language set to ${locale}.`);
}

function lockSession() {
  stopHomeEventPolling();
  disconnect_world().catch(() => {});
  state.identity = null;
  state.encryptedBundle = '';
  state.passphrase = '';
  state.currentHome = null;
  byId('transcript').innerHTML = '';
  setSetupStatus('Session locked. Bundle remains stored unless removed manually.');
  showSetup();
}

async function publishDidDocument() {
  const blob = new Blob([state.identity.document_json], { type: 'application/json' });
  const formData = new FormData();
  formData.append('file', blob, 'did-document.json');

  appendMessage('system', 'Step 1/2: Adding DID document to IPFS...');
  const addResult = await kuboPost('/api/v0/add', { pin: 'true' }, formData);
  const cid = addResult.Hash;
  appendMessage('system', `DID document pinned as ${cid}`);

  appendMessage('system', `Step 2/2: Publishing ${cid} to IPNS key "${state.aliasName}"...`);
  const pubResult = await kuboPost('/api/v0/name/publish', {
    arg: `/ipfs/${cid}`,
    key: state.aliasName,
    lifetime: '24h'
  });

  const ipnsName = pubResult.Name;
  const ipfsValue = pubResult.Value;
  appendMessage('system', `Published: /ipns/${ipnsName} -> ${ipfsValue}`);
  appendMessage('system', `DID document at: https://ipfs.io/ipns/${ipnsName}`);
}

function normalizeIrohAddress(address) {
  const value = String(address || '').trim();
  if (!value) return '';
  if (value.startsWith('/iroh/')) {
    return value.slice('/iroh/'.length);
  }
  return value;
}

function isLikelyIrohAddress(address) {
  return /^[a-f0-9]{64}$/i.test(normalizeIrohAddress(address));
}

function normalizeRelayUrl(input) {
  let value = String(input || '').trim();
  // Remove all trailing dots and slashes
  while (value.endsWith('.') || value.endsWith('/')) {
    value = value.slice(0, -1);
  }
  // Ensure it ends with a single /
  return value + '/';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, message) {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

async function lookupWorldRelayHint(endpointId) {
  const lookupStart = Date.now();
  logger.log('relay.lookup', `fetching status for endpoint ${endpointId.slice(0, 8)}...`);
  
  try {
    const response = await withTimeout(fetch('http://127.0.0.1:5002/status.json'), 1500, 'status fetch timed out');
    const elapsed = Date.now() - lookupStart;
    
    if (!response.ok) {
      logger.log('relay.lookup', `status fetch returned ${response.status} in ${elapsed}ms`);
      return null;
    }
    
    const status = await response.json();
    const world = status && status.world ? status.world : null;
    
    if (!world || world.endpoint_id !== endpointId) {
      logger.log('relay.lookup', `endpoint mismatch in status (expected ${endpointId.slice(0, 8)}..., got ${world?.endpoint_id?.slice(0, 8)}...) in ${elapsed}ms`);
      return null;
    }
    
    const relayUrls = Array.isArray(world.relay_urls) ? world.relay_urls : [];
    if (relayUrls.length === 0) {
      logger.log('relay.lookup', `no relay urls in status in ${elapsed}ms`);
      return null;
    }
    
    const rawUrl = relayUrls[0];
    const normalizedUrl = normalizeRelayUrl(rawUrl);
    logger.log('relay.lookup', `found relay in ${elapsed}ms: raw="${rawUrl}" normalized="${normalizedUrl}"`);
    
    return normalizedUrl;
  } catch (error) {
    const elapsed = Date.now() - lookupStart;
    logger.log('relay.lookup', `failed after ${elapsed}ms: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function enterWorldWithRetry(endpointId, actorName, room) {
  const maxAttempts = 3;
  let lastError = null;
  logger.log('enter.world', `starting enter sequence for endpoint=${endpointId.slice(0, 8)}... actor=${actorName} room=${room}`);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptStart = Date.now();
    logger.log(`enter.attempt.${attempt}`, `starting attempt`);
    
    try {
      // Phase 1: Relay discovery and connection
      logger.log(`enter.attempt.${attempt}`, `phase 1/2: relay discovery and connect`);
      const relayHint = await lookupWorldRelayHint(endpointId);
      
      if (relayHint) {
        logger.log(`enter.attempt.${attempt}`, `using relay hint: ${relayHint}`);
      } else {
        logger.log(`enter.attempt.${attempt}`, `no relay hint found, falling back to discovery-only`);
      }

      const connectStart = Date.now();
      await withTimeout(
        relayHint
          ? connect_world_with_relay(endpointId, relayHint)
          : connect_world(endpointId),
        17000,
        'connect phase timed out'
      );
      const connectElapsed = Date.now() - connectStart;
      logger.log(`enter.attempt.${attempt}`, `connected in ${connectElapsed}ms`);

      // Phase 2: World enter request
      logger.log(`enter.attempt.${attempt}`, `phase 2/2: sending enter request`);
      const requestStart = Date.now();
      const response = await withTimeout(
        enter_world(endpointId, state.passphrase, state.encryptedBundle, actorName, room),
        12000,
        'enter request timed out'
      );
      const requestElapsed = Date.now() - requestStart;
      logger.log(`enter.attempt.${attempt}`, `enter request succeeded in ${requestElapsed}ms`);
      
      const result = JSON.parse(response);
      logger.log(`enter.attempt.${attempt}`, `response: ok=${result.ok} room=${result.room} latest_seq=${result.latest_event_sequence || 0} endpoint=${result.endpoint_id?.slice(0, 8)}...`);
      logger.log(`enter.world`, `success after ${Date.now() - attemptStart}ms total on attempt ${attempt}/${maxAttempts}`);
      
      return response;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const elapsedTotal = Date.now() - attemptStart;
      const isTimeout = message.includes('timed out');
      const isConnectionLost = message.includes('connection lost');
      const isRetryable = isTimeout || isConnectionLost;
      
      logger.log(`enter.attempt.${attempt}`, `failed after ${elapsedTotal}ms: ${message} (retryable=${isRetryable})`);

      if (!isRetryable || attempt === maxAttempts) {
        logger.log('enter.world', `giving up after attempt ${attempt}/${maxAttempts}: ${message}`);
        throw error;
      }

      const backoffMs = 1500 * attempt;
      appendMessage(
        'system',
        `iroh attempt ${attempt}/${maxAttempts} failed (${message}). Retrying...`
      );
      logger.log(`enter.attempt.${attempt}`, `waiting ${backoffMs}ms before attempt ${attempt + 1}`);
      await delay(backoffMs);
    }
  }

  logger.log('enter.world', `failed: all ${maxAttempts} attempts exhausted`);
  throw lastError || new Error('iroh connect failed');
}

async function enterHome(target) {
  if (!state.identity) {
    throw new Error('Load or create an identity before entering a home.');
  }

  const alias = String(target || '').trim();
  if (!alias) {
    throw new Error('Usage: /enter </iroh/...|alias>');
  }

  const aliasValue = state.aliasBook[alias] || alias;
  const endpointId = normalizeIrohAddress(aliasValue);
  logger.log('enter.home', `alias=${alias} resolved=${aliasValue} endpoint=${endpointId.slice(0, 8)}...`);
  
  if (!isLikelyIrohAddress(endpointId)) {
    throw new Error(
      `Alias ${alias} is not a valid endpoint id (expected 64 hex chars, got ${endpointId.length}).`
    );
  }

  appendMessage('system', `Connecting to ${alias}...`);
  const result = JSON.parse(
    await enterWorldWithRetry(endpointId, state.aliasName, 'lobby')
  );
  logger.log('enter.home', `result ok=${result.ok} room=${result.room} endpoint=${result.endpoint_id?.slice(0, 8)}... latest_seq=${result.latest_event_sequence || 0}`);

  state.currentHome = {
    alias,
    endpointId,
    room: result.room || 'lobby',
    lastEventSequence: toSequenceNumber(result.latest_event_sequence || 0)
  };
  updateIdentityLine();
  startHomeEventPolling();
  await pollCurrentHomeEvents();

  appendMessage('system', `Entered ${alias}.`);
  appendMessage('system', `Home endpoint: ${result.endpoint_id}`);
  appendMessage('system', `Current room: ${result.room}`);
  appendMessage('system', result.message || 'Connected to home.');
}

async function sendCurrentWorldMessage(text) {
  if (!state.identity || !state.currentHome) {
    appendMessage('system', 'Message captured. Networking commands will be added next.');
    return;
  }

  const sendStart = Date.now();
  logger.log('send.message', `room=${state.currentHome.room} to=${state.currentHome.alias} actor=${state.aliasName} msg_len=${text.length}`);
  
  const result = JSON.parse(
    await send_world_message(
      state.currentHome.endpointId,
      state.passphrase,
      state.encryptedBundle,
      state.aliasName,
      state.currentHome.room,
      state.locale,
      text
    )
  );
  const elapsed = Date.now() - sendStart;
  logger.log('send.message', `response ok=${result.ok} broadcasted=${result.broadcasted} latest_seq=${result.latest_event_sequence || 0} in ${elapsed}ms`);
  
  if (!result.broadcasted) {
    state.currentHome.lastEventSequence = toSequenceNumber(
      result.latest_event_sequence || state.currentHome.lastEventSequence || 0
    );
    appendMessage('world', result.message || '(no response)');
    return;
  }

  await pollCurrentHomeEvents();
}

function parseSlash(input) {
  const trimmed = input.trim();
  const [cmd, ...rest] = trimmed.split(/\s+/);

  if (cmd === 'alias') {
    return parseSlash(`/${trimmed}`);
  }

  if (cmd === '/help') {
    const labels = localeLabels();
    appendMessage('system', 'Commands:');
    appendMessage('system', '  /help                      - this message');
    appendMessage('system', '  /identity                  - show current identity details');
    appendMessage('system', '  /alias <name> <address>    - save an address alias');
    appendMessage('system', '  alias <name> <address>     - same as /alias');
    appendMessage('system', '  /unalias <name>            - remove a saved alias');
    appendMessage('system', '  /aliases                   - list saved aliases');
    appendMessage('system', '  /enter </iroh/...|alias>   - enter a home by endpoint id or alias');
    appendMessage('system', '  /smoke [alias]             - run enter + send + poll smoke test');
    appendMessage('system', '  /locale <en|nb-NO>         - change actor language for this alias');
    appendMessage('system', '  /publish                   - publish DID document to IPNS');
    appendMessage('system', '  /debug [on|off]            - toggle debug logs in transcript');
    appendMessage('system', 'Messaging:');
    appendMessage('system', '  Hello world                - room chatter');
    appendMessage('system', `  @${labels.here} ${labels.who}                  - room command: list actors in room`);
    appendMessage('system', `  @${labels.me} ${labels.say} "hello"            - self command: talk to yourself / test locale aliases`);
    appendMessage('system', `  @name ${labels.say} "hello"          - direct-style speech`);
    appendMessage('system', '  @radio turn on             - talk to radio actor');
    return true;
  }

  if (cmd === '/identity') {
    if (!state.identity) {
      appendMessage('system', 'No identity loaded. Create or unlock an identity first.');
      return true;
    }
    const { did, ipns } = state.identity;
    appendMessage('system', `DID:             ${did}`);
    appendMessage('system', `IPNS key:        ${ipns}`);
    appendMessage('system', `Alias:           ${state.aliasName || '(none)'}`);
    appendMessage('system', `Locale:          ${state.locale}`);
    appendMessage('system', `Published field: ma:locale = ${state.locale}`);
    appendMessage('system', `DID document at: https://ipfs.io/ipns/${ipns}`);
    appendMessage('system', `Current world:   ${state.currentHome ? `${state.currentHome.alias} (${state.currentHome.room})` : '(none)'}`);
    appendMessage('system', '(run /publish to update the IPNS record)');
    return true;
  }

  if (cmd === '/aliases') {
    const entries = Object.entries(state.aliasBook);
    if (entries.length === 0) {
      appendMessage('system', 'No aliases saved yet.');
      return true;
    }
    for (const [name, address] of entries) {
      appendMessage('system', `${name} => ${address}`);
    }
    return true;
  }

  if (cmd === '/locale' || cmd === '/lang' || cmd === '/language') {
    if (rest.length !== 1) {
      appendMessage('system', 'Usage: /locale <en|nb-NO>');
      return true;
    }

    applyLocaleChange(rest[0])
      .then(() => {
        appendMessage('system', `Locale is now ${state.locale}.`);
      })
      .catch((error) => {
        appendMessage('system', `Locale change failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    return true;
  }

  if (cmd === '/alias') {
    if (rest.length < 2) {
      appendMessage('system', 'Usage: /alias <name> <address>');
      return true;
    }
    const [name, ...addressParts] = rest;
    const address = addressParts.join(' ');

    if (!/^[a-z0-9_-]{1,24}$/i.test(name)) {
      appendMessage('system', 'Alias name must be 1-24 chars using letters, numbers, underscore, or dash.');
      return true;
    }

    state.aliasBook[name] = address;
    saveAliasBook();
    appendMessage('system', `Alias saved: ${name} => ${address}`);
    return true;
  }

  if (cmd === '/unalias') {
    if (rest.length !== 1) {
      appendMessage('system', 'Usage: /unalias <name>');
      return true;
    }

    const [name] = rest;
    if (!Object.prototype.hasOwnProperty.call(state.aliasBook, name)) {
      appendMessage('system', `Alias not found: ${name}`);
      return true;
    }

    delete state.aliasBook[name];
    saveAliasBook();
    appendMessage('system', `Alias removed: ${name}`);
    return true;
  }

  if (cmd === '/publish') {
    if (!state.identity) {
      appendMessage('system', 'No identity loaded. Create or unlock an identity first.');
      return true;
    }
    if (!state.identity.document_json) {
      appendMessage('system', 'DID document not available. Try unlocking the bundle again.');
      return true;
    }
    appendMessage('system', 'Publishing DID document to IPNS via Kubo...');
    publishDidDocument().catch((err) => {
      appendMessage('system', `Publish failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return true;
  }

  if (cmd === '/debug') {
    if (rest.length === 0) {
      setDebugMode(!state.debug);
    } else {
      const mode = String(rest[0] || '').trim().toLowerCase();
      if (mode === 'on' || mode === '1' || mode === 'true') {
        setDebugMode(true);
      } else if (mode === 'off' || mode === '0' || mode === 'false') {
        setDebugMode(false);
      } else {
        appendMessage('system', 'Usage: /debug [on|off]');
        return true;
      }
    }
    return true;
  }

  if (cmd === '/enter') {
    if (rest.length !== 1) {
      appendMessage('system', 'Usage: /enter </iroh/...|alias>');
      return true;
    }
    enterHome(rest[0]).catch((err) => {
      appendMessage('system', `Enter failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return true;
  }

  if (cmd === '/smoke') {
    if (rest.length > 1) {
      appendMessage('system', 'Usage: /smoke [alias]');
      return true;
    }
    runSmokeTest(rest[0]).catch((err) => {
      appendMessage('system', `Smoke failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return true;
  }

  return false;
}

function onCommandSubmit(event) {
  event.preventDefault();
  const inputEl = byId('command-input');
  const text = inputEl.value.trim();
  if (!text) return;

  // Readline-like history: keep unique latest entry and reset cursor.
  state.commandHistory.push(text);
  state.historyIndex = -1;
  state.historyDraft = '';

  appendMessage('you', text);

  if (text.startsWith('/')) {
    const handled = parseSlash(text);
    if (!handled) {
      appendMessage('system', 'Unknown command. Try /help.');
    }
  } else {
    sendCurrentWorldMessage(text).catch((err) => {
      appendMessage('system', `Send failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  inputEl.value = '';
}

function onCommandKeyDown(event) {
  const inputEl = byId('command-input');

  if (event.key === 'ArrowUp') {
    if (state.commandHistory.length === 0) {
      return;
    }
    event.preventDefault();
    if (state.historyIndex === -1) {
      state.historyDraft = inputEl.value;
      state.historyIndex = state.commandHistory.length - 1;
    } else if (state.historyIndex > 0) {
      state.historyIndex -= 1;
    }
    inputEl.value = state.commandHistory[state.historyIndex];
    inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
    return;
  }

  if (event.key === 'ArrowDown') {
    if (state.commandHistory.length === 0 || state.historyIndex === -1) {
      return;
    }
    event.preventDefault();
    if (state.historyIndex < state.commandHistory.length - 1) {
      state.historyIndex += 1;
      inputEl.value = state.commandHistory[state.historyIndex];
    } else {
      state.historyIndex = -1;
      inputEl.value = state.historyDraft;
    }
    inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
  }
}

function restoreSavedValues() {
  const savedApi = localStorage.getItem(API_KEY) || localStorage.getItem(LEGACY_API_KEY);
  const savedAlias = resolveInitialAlias();

  if (savedApi) byId('kubo-api').value = savedApi;

  if (savedAlias) {
    byId('alias-name').value = savedAlias;
    loadAliasDraft(savedAlias);
  } else {
    byId('bundle-text').value = '';
    setLanguageSelection(DEFAULT_LOCALE);
    onNewPhrase();
  }

  state.aliasBook = loadAliasBook();
  state.debug = readStoredDebugFlag();
}

async function main() {
  await init();
  restoreSavedValues();

  byId('btn-kubo-check').addEventListener('click', () => {
    checkKubo().catch(() => {});
  });
  byId('btn-create').addEventListener('click', onCreateIdentity);
  byId('btn-unlock').addEventListener('click', onUnlockIdentity);
  byId('btn-new-phrase').addEventListener('click', onNewPhrase);
  byId('btn-export').addEventListener('click', exportBundle);
  byId('btn-lock').addEventListener('click', lockSession);
  byId('actor-language').addEventListener('change', onLanguageChange);
  byId('alias-name').addEventListener('change', (event) => {
    loadAliasDraft(event.target.value);
  });
  byId('command-form').addEventListener('submit', onCommandSubmit);
  byId('command-input').addEventListener('keydown', onCommandKeyDown);

  byId('passphrase').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      const hasBundle = byId('bundle-text').value.trim().length > 0;
      if (hasBundle) {
        onUnlockIdentity();
      } else {
        onCreateIdentity();
      }
    }
  });

  showSetup();
}

main().catch((error) => {
  setSetupStatus(`Fatal error: ${error instanceof Error ? error.message : String(error)}`);
});
