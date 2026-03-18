import init, {
  create_identity_with_ipns,
  unlock_identity,
  generate_bip39_phrase,
  normalize_bip39_phrase
} from './pkg/ma_actor.js';

const BUNDLE_KEY = 'ma.identity.v2.bundle';
const API_KEY = 'ma.identity.v2.kuboApi';
const ALIAS_KEY = 'ma.identity.v2.alias';
const PHRASE_KEY = 'ma.identity.v2.recoveryPhrase';
const ALIAS_BOOK_KEY = 'ma.identity.v2.aliasBook';

const state = {
  identity: null,
  encryptedBundle: '',
  aliasName: '',
  aliasBook: {},
  commandHistory: [],
  historyIndex: -1,
  historyDraft: ''
};

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

function updateIdentityLine() {
  if (!state.identity) {
    byId('identity-line').textContent = '';
    return;
  }
  byId('identity-line').textContent = `did ${state.identity.did} | ipns ${state.identity.ipns} | alias ${state.aliasName}`;
}

function showChat() {
  byId('setup-view').classList.add('hidden');
  byId('chat-view').classList.remove('hidden');
  updateIdentityLine();

  const aliases = Object.keys(state.aliasBook).length;
  appendMessage('system', 'Ready to explore.');
  appendMessage('system', `Saved aliases: ${aliases}. Use /help for commands.`);
  byId('command-input').focus();
}

function showSetup() {
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

function exportBundle() {
  if (!state.encryptedBundle) {
    appendMessage('system', 'No bundle loaded in memory to export.');
    return;
  }
  const blob = new Blob([state.encryptedBundle], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'ma-identity-bundle.json';
  a.click();
  URL.revokeObjectURL(url);
  appendMessage('system', 'Bundle exported as ma-identity-bundle.json');
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

  if (!aliasName || !/^[a-z0-9_-]{2,32}$/i.test(aliasName)) {
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
    localStorage.setItem(API_KEY, getApiBase());
    localStorage.setItem(ALIAS_KEY, aliasName);

    const ipns = await ensureKuboAliasKey(aliasName);
    const result = JSON.parse(create_identity_with_ipns(passphrase, ipns));

    state.identity = result;
    state.encryptedBundle = result.encrypted_bundle;
    state.aliasName = aliasName;

    localStorage.setItem(BUNDLE_KEY, result.encrypted_bundle);
    byId('bundle-text').value = result.encrypted_bundle;

    const phrase = resolveRecoveryPhraseFromInput();
    byId('recovery-phrase').value = phrase;
    localStorage.setItem(PHRASE_KEY, phrase);

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
    localStorage.setItem(API_KEY, getApiBase());
    localStorage.setItem(ALIAS_KEY, aliasName);

    const ipns = await ensureKuboAliasKey(aliasName);
    const unlocked = JSON.parse(unlock_identity(passphrase, bundle));

    if (unlocked.ipns !== ipns) {
      appendMessage('system', `Warning: bundle ipns (${unlocked.ipns}) does not match alias key ipns (${ipns}).`);
    }

    state.identity = unlocked;
    state.encryptedBundle = bundle;
    state.aliasName = aliasName;

    localStorage.setItem(BUNDLE_KEY, bundle);

    const phrase = resolveRecoveryPhraseFromInput();
    byId('recovery-phrase').value = phrase;
    localStorage.setItem(PHRASE_KEY, phrase);

    setSetupStatus('Bundle unlocked.');
    showChat();
  } catch (error) {
    setSetupStatus(error instanceof Error ? error.message : String(error));
  }
}

function onNewPhrase() {
  const phrase = generateRecoveryPhrase(12);
  byId('recovery-phrase').value = phrase;
  localStorage.setItem(PHRASE_KEY, phrase);
}

function lockSession() {
  state.identity = null;
  state.encryptedBundle = '';
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

function parseSlash(input) {
  const trimmed = input.trim();
  const [cmd, ...rest] = trimmed.split(/\s+/);

  if (cmd === '/help') {
    appendMessage('system', 'Commands:');
    appendMessage('system', '  /help                      - this message');
    appendMessage('system', '  /identity                  - show current identity details');
    appendMessage('system', '  /alias <name> <address>    - save an address alias');
    appendMessage('system', '  /unalias <name>            - remove a saved alias');
    appendMessage('system', '  /aliases                   - list saved aliases');
    appendMessage('system', '  /publish                   - publish DID document to IPNS');
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
    appendMessage('system', `DID document at: https://ipfs.io/ipns/${ipns}`);
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
    appendMessage('system', 'Message captured. Networking commands will be added next.');
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
  const savedApi = localStorage.getItem(API_KEY);
  const savedAlias = localStorage.getItem(ALIAS_KEY);
  const savedBundle = localStorage.getItem(BUNDLE_KEY);
  const savedPhrase = localStorage.getItem(PHRASE_KEY);

  if (savedApi) byId('kubo-api').value = savedApi;
  if (savedAlias) byId('alias-name').value = savedAlias;
  if (savedBundle) byId('bundle-text').value = savedBundle;
  if (savedPhrase) {
    try {
      byId('recovery-phrase').value = normalizeRecoveryPhrase(savedPhrase);
    } catch {
      byId('recovery-phrase').value = '';
    }
  } else {
    onNewPhrase();
  }

  state.aliasBook = loadAliasBook();
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
