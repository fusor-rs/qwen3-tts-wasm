// The voices saved on this device: IndexedDB `qwen3-tts`, store `voices`, one record per voice,
// `{ id, name, transcript, samples }` (`samples` a Float32Array at the model's rate). Nothing
// leaves the page.

const DATABASE = 'qwen3-tts';
const STORE = 'voices';

function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Runs `action` on the voices store in a transaction and resolves with the request's result. */
async function transact(mode, action) {
  const database = await open();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE, mode);
      const request = action(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    database.close();
  }
}

export const allVoices = () => transact('readonly', (store) => store.getAll());
export const getVoice = (id) => transact('readonly', (store) => store.get(id));
export const saveVoice = (voice) => transact('readwrite', (store) => store.put(voice));
export const deleteVoice = (id) => transact('readwrite', (store) => store.delete(id));
