// Écran « Filmer » : caméra guidée (continu, plan large, horizontale, sans zoom ni direct) et coffre
// d'originaux. Les vidéos restent sur l'appareil ; l'envoi passe par le partage du téléphone.
import { sha256 } from './observations.js'

const $ = (id) => document.getElementById(id)

// --- Coffre (IndexedDB, base séparée des observations) ---
//
// Une vidéo est une fiche (`clips`) et ses morceaux (`chunks`, dans l'ordre de `seq`). La caméra
// guidée écrit un morceau par seconde pendant qu'elle filme : si l'application est coupée, tout
// ce qui a été filmé jusque-là est déjà dans le coffre. `recording` reste vrai sur la fiche tant
// que l'enregistrement n'a pas été clos, ce qui permet de le récupérer au démarrage suivant.

const DB_NAME = 'rio-observer-clips'
const CLIPS = 'clips'
const CHUNKS = 'chunks'

let dbPromise
const open = () =>
  (dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(CLIPS)) db.createObjectStore(CLIPS, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(CHUNKS)) db.createObjectStore(CHUNKS, { keyPath: ['clipId', 'seq'] })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  }))

async function run(store, mode, action) {
  const db = await open()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode)
    const request = action(tx.objectStore(store))
    tx.oncomplete = () => resolve(request.result)
    tx.onerror = () => reject(tx.error)
    // Espace insuffisant : la transaction est annulée sans passer par onerror.
    tx.onabort = () => reject(tx.error)
  })
}

const chunkRange = (clipId) => IDBKeyRange.bound([clipId, 0], [clipId, Infinity])

const listClips = async () =>
  (await run(CLIPS, 'readonly', (s) => s.getAll())).sort((a, b) => b.date.localeCompare(a.date))
const putClip = (clip) => run(CLIPS, 'readwrite', (s) => s.put(clip))
const putChunk = (clipId, seq, blob) => run(CHUNKS, 'readwrite', (s) => s.put({ clipId, seq, blob }))
const chunksOf = async (clipId) =>
  (await run(CHUNKS, 'readonly', (s) => s.getAll(chunkRange(clipId)))).map((chunk) => chunk.blob)

async function deleteClip(id) {
  await run(CHUNKS, 'readwrite', (s) => s.delete(chunkRange(id)))
  await run(CLIPS, 'readwrite', (s) => s.delete(id))
}

async function clearClips() {
  await run(CHUNKS, 'readwrite', (s) => s.clear())
  await run(CLIPS, 'readwrite', (s) => s.clear())
}

const newClip = (type, date) => ({
  id: crypto.randomUUID(),
  date: date.toISOString(),
  type,
  size: 0,
  sha256: null,
  position: null,
  recording: true,
})

const extensionOf = (type) => (type.includes('mp4') ? 'mp4' : type.includes('webm') ? 'webm' : type.split('/')[1] || 'bin')

// Les morceaux sont assemblés sans être recopiés ni modifiés. `clip.blob` : fiche d'avant le
// stockage par morceaux, qui portait le fichier entier.
async function fileOf(clip, extra = []) {
  const parts = clip.blob ? [clip.blob] : await chunksOf(clip.id)
  const name = `${clip.date.replace(/[:.]/g, '-')}.${extensionOf(clip.type)}`
  return new File([...parts, ...extra], name, { type: clip.type })
}

function download(file) {
  const link = document.createElement('a')
  link.href = URL.createObjectURL(file)
  link.download = file.name
  link.click()
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000)
}

// La position est ajoutée à la fiche du fichier, jamais au fichier lui-même.
function currentPosition() {
  if (!$('film-geo').checked || !navigator.geolocation) return Promise.resolve(null)
  return new Promise((resolve) =>
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({ latitude: coords.latitude, longitude: coords.longitude }),
      () => resolve(null),
      { timeout: 5000 },
    ),
  )
}

// Clôt une vidéo dont les morceaux sont au coffre : taille, puis empreinte et position.
// `locate` : faux pour un enregistrement récupéré après coup, où la position actuelle n'est pas celle du tournage.
async function sealClip(clip, { locate = true, ...fields } = {}) {
  const file = await fileOf(clip)
  Object.assign(clip, { recording: false, size: file.size, ...fields })
  await putClip(clip)
  renderVault()

  // L'empreinte charge toute la vidéo en mémoire et peut échouer sur un long enregistrement :
  // elle vient après la mise au coffre, pour ne jamais faire perdre les images.
  try {
    clip.sha256 = await sha256(file)
  } catch (error) {
    console.error(error)
  }
  if (locate) clip.position = await currentPosition()
  await putClip(clip)
  renderVault()
}

// Fichier de la caméra du téléphone : stocké tel quel, avec ses métadonnées d'origine.
async function saveNative(file) {
  const clip = newClip(file.type || 'video/mp4', new Date(file.lastModified))
  try {
    await putClip(clip)
    await putChunk(clip.id, 0, file)
  } catch (error) {
    console.error(error)
    await deleteClip(clip.id).catch(() => {})
    alert('Coffre plein ou indisponible : le fichier va être proposé au téléchargement pour ne pas être perdu.')
    download(file)
    return
  }
  await sealClip(clip)
}

// Un enregistrement resté ouvert vient d'une session coupée (plantage, page fermée, batterie).
async function recoverInterrupted() {
  for (const clip of await listClips()) {
    if (!clip.recording) continue
    if ((await chunksOf(clip.id)).length) await sealClip(clip, { interrupted: true, locate: false })
    else await deleteClip(clip.id)
  }
}

let onAnalyse = () => {}
let vaultRender = 0

async function renderVault() {
  const render = ++vaultRender
  // L'enregistrement en cours n'apparaît qu'une fois clos.
  const clips = (await listClips()).filter((clip) => !clip.recording)
  // Fichiers préparés d'avance : le partage doit suivre le toucher sans attente.
  const files = await Promise.all(clips.map((clip) => fileOf(clip)))
  if (render !== vaultRender) return

  const box = $('film-vault')
  $('film-vault-empty').hidden = clips.length > 0
  $('film-wipe').hidden = clips.length === 0
  box.replaceChildren(
    ...clips.map((clip, index) => {
      const file = files[index]
      const item = document.createElement('li')
      const title = document.createElement('strong')
      title.textContent =
        `${new Date(clip.date).toLocaleString('fr-FR')} · ${(clip.size / 1048576).toFixed(1)} Mo` +
        (clip.interrupted ? ' · enregistrement interrompu, récupéré' : '')
      const detail = document.createElement('span')
      const position = clip.position ? ` · ${clip.position.latitude.toFixed(4)}, ${clip.position.longitude.toFixed(4)}` : ''
      detail.textContent = `SHA-256 : ${clip.sha256 ?? 'non calculée'}${position}`
      detail.className = 'mono'

      const actions = document.createElement('div')
      actions.className = 'actions'
      const button = (label, handler, className) => {
        const element = document.createElement('button')
        element.textContent = label
        if (className) element.className = className
        element.addEventListener('click', handler)
        return element
      }
      actions.append(
        button('Analyser les RIO', () => onAnalyse(file), 'primary'),
        button('Envoyer', async () => {
          if (navigator.canShare?.({ files: [file] })) {
            try {
              await navigator.share({ files: [file] })
            } catch {
              // Partage annulé.
            }
          } else download(file)
        }),
        button('Enregistrer', () => download(file)),
        button(
          'Supprimer',
          async () => {
            if (confirm('Supprimer ce fichier du coffre ?')) {
              await deleteClip(clip.id)
              renderVault()
            }
          },
          'danger',
        ),
      )
      item.append(title, detail, actions)
      return item
    }),
  )
}

// --- Caméra guidée ---

const HINTS = [
  'Plan large : personnes en entier, repère de lieu',
  'Restez à plusieurs mètres de la scène',
  'Pas de zoom, deux mains',
  'Évitez de couper avant la fin de l’action',
  'Si quelqu’un filme, filmez aussi d’un autre angle',
]
// Durée d'un morceau : ce qu'on peut perdre au pire si l'application est coupée.
const CHUNK_MS = 1000

let stream = null
let recorder = null
let startedAt = null
let timer = 0
let hintTimer = 0
let hintIndex = 0
let wakeLock = null

const updateOrientation = () => $('cam').classList.toggle('portrait', innerHeight > innerWidth)

const VIDEO_CONSTRAINTS = { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }
// Délai laissé au téléphone pour libérer la caméra que l'onglet Capture vient de quitter.
const CAMERA_RELEASE_MS = 700

const CAMERA_ERRORS = {
  NotAllowedError:
    'Accès à la caméra refusé. Ouvrez les réglages du site (cadenas à côté de l’adresse, ou « Paramètres du site »), autorisez Caméra et Micro, puis rechargez la page.',
  NotReadableError: 'Caméra occupée par une autre application ou un autre onglet. Fermez-les, puis réessayez.',
  NotFoundError: 'Aucune caméra trouvée sur cet appareil.',
}

async function acquireCamera(audio) {
  const constraints = { video: VIDEO_CONSTRAINTS, audio }
  try {
    return await navigator.mediaDevices.getUserMedia(constraints)
  } catch (error) {
    if (error.name !== 'NotReadableError' && error.name !== 'AbortError') throw error
    await new Promise((resolve) => setTimeout(resolve, CAMERA_RELEASE_MS))
    return navigator.mediaDevices.getUserMedia(constraints)
  }
}

async function openCamera() {
  let hints = HINTS
  try {
    stream = await acquireCamera(true)
  } catch (error) {
    console.error(error)
    // La demande groupée échoue sans dire si c'est la caméra ou le micro : on ouvre la caméra
    // seule, puis le micro à part, pour savoir lequel pose problème.
    try {
      stream = await acquireCamera(false)
    } catch {
      alert(CAMERA_ERRORS[error.name] ?? `Caméra indisponible (${error.name}).`)
      return
    }
    try {
      const microphone = await navigator.mediaDevices.getUserMedia({ audio: true })
      for (const track of microphone.getAudioTracks()) stream.addTrack(track)
    } catch (audioError) {
      console.error(audioError)
      // Mieux vaut une vidéo sans son que pas de vidéo. Le détail aide à régler le téléphone.
      hints = [`⚠ Micro indisponible, vidéo sans son (${audioError.name} : ${audioError.message})`, ...HINTS]
    }
  }
  $('cam-preview').srcObject = stream
  $('cam').hidden = false
  try {
    await document.documentElement.requestFullscreen()
    await screen.orientation.lock('landscape')
  } catch {
    // Verrouillage non disponible : l'écran « tournez le téléphone » prend le relais.
  }
  try {
    wakeLock = await navigator.wakeLock.request('screen')
  } catch {
    // Écran non maintenu allumé.
  }
  updateOrientation()
  $('cam-timer').textContent = '00:00'
  hintIndex = 0
  $('cam-hint').textContent = hints[0]
  hintTimer = setInterval(() => ($('cam-hint').textContent = hints[++hintIndex % hints.length]), 6000)
}

function closeCamera() {
  if (recorder?.state === 'recording') recorder.stop()
  clearInterval(hintTimer)
  clearInterval(timer)
  stream?.getTracks().forEach((track) => track.stop())
  stream = null
  wakeLock?.release().catch(() => {})
  try {
    screen.orientation.unlock()
    if (document.fullscreenElement) document.exitFullscreen()
  } catch {
    // Rien à déverrouiller.
  }
  $('cam').hidden = true
  $('cam').classList.remove('recording')
}

// Enregistre le flux de la caméra en écrivant chaque morceau au coffre dès qu'il est produit.
function startRecording() {
  // webm d'abord : il livre un morceau lisible chaque seconde. Mesuré sur Chromium, le mp4 ne livre
  // rien avant une dizaine de secondes, puis par blocs de cinq : une coupure y coûte bien plus.
  // Le mp4 reste le repli des navigateurs sans webm (Safari).
  const type = ['video/webm;codecs=vp9,opus', 'video/webm', 'video/mp4'].find((t) => MediaRecorder.isTypeSupported(t))
  const active = new MediaRecorder(stream, type ? { mimeType: type, videoBitsPerSecond: 8_000_000 } : undefined)
  recorder = active
  startedAt = new Date()
  const clip = newClip(active.mimeType || type || 'video/webm', startedAt)
  let seq = 0
  // Morceaux que le coffre a refusés (espace insuffisant), gardés en mémoire pour ne pas les perdre.
  const overflow = []
  // Les écritures s'enchaînent une à une, dans l'ordre des morceaux.
  let writes = putClip(clip).catch((error) => {
    console.error(error)
    overflow.failed = true
  })

  active.addEventListener('dataavailable', ({ data }) => {
    if (!data.size) return
    const index = seq++
    writes = writes.then(async () => {
      // Après un premier refus, tout le reste suit en mémoire pour garder l'ordre.
      if (overflow.failed) return void overflow.push(data)
      try {
        await putChunk(clip.id, index, data)
      } catch (error) {
        console.error(error)
        overflow.failed = true
        overflow.push(data)
      }
    })
  })

  active.addEventListener('stop', async () => {
    clearInterval(timer)
    $('cam').classList.remove('recording')
    await writes
    if (active.mimeType) clip.type = active.mimeType
    if (overflow.failed) {
      alert('Coffre plein : la vidéo complète va être proposée au téléchargement pour ne pas être perdue.')
      download(await fileOf(clip, overflow))
    }
    $('cam-timer').textContent = overflow.failed ? '⚠ Coffre plein' : '✔ Enregistré'
    // Le coffre garde ce qu'il a pu écrire, signalé comme incomplet.
    await sealClip(clip, overflow.failed ? { interrupted: true } : {})
  })

  active.start(CHUNK_MS)
  $('cam').classList.add('recording')
  timer = setInterval(() => {
    const seconds = Math.floor((Date.now() - startedAt) / 1000)
    $('cam-timer').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  }, 500)
}

function toggleRecording() {
  if (recorder?.state === 'recording') recorder.stop()
  else startRecording()
}

export function initFilm(callbacks) {
  onAnalyse = callbacks.onAnalyse
  addEventListener('resize', updateOrientation)
  $('film-start').addEventListener('click', openCamera)
  $('cam-close').addEventListener('click', closeCamera)
  $('cam-rec').addEventListener('click', toggleRecording)
  // Même traitement pour une vidéo filmée à l'instant et pour une vidéo déjà dans la galerie.
  for (const id of ['film-native', 'film-import']) {
    $(id).addEventListener('change', async (event) => {
      const files = [...event.target.files]
      event.target.value = ''
      for (const file of files) await saveNative(file)
    })
  }
  $('film-wipe').addEventListener('click', async () => {
    if (confirm('Effacer tous les fichiers du coffre ? Irréversible.')) {
      await clearClips()
      renderVault()
    }
  })
  recoverInterrupted().then(renderVault)
}

export const refreshVault = renderVault
