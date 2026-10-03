// Stockage local des observations (IndexedDB). Rien ne quitte l'appareil.
const DB_NAME = 'rio-observer'
const STORE = 'observations'

let dbPromise

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  return dbPromise
}

async function run(mode, action) {
  const db = await open()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode)
    const request = action(tx.objectStore(STORE))
    tx.oncomplete = () => resolve(request.result)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

export const saveObservation = (observation) => run('readwrite', (store) => store.put(observation))
export const getObservation = (id) => run('readonly', (store) => store.get(id))
export const deleteObservation = (id) => run('readwrite', (store) => store.delete(id))

export async function listObservations() {
  const all = await run('readonly', (store) => store.getAll())
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
