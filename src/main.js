import './style.css'
import { saveObservation, getObservation, deleteObservation, listObservations } from './db.js'
import { readRio } from './ocr.js'
import { exportObservations } from './export.js'
import { blurredPhoto, unblurAt } from './faces.js'
import { STATUS_LABELS, FORM_FIELDS, createObservation, makeImage, imagesOf, toJpeg, formatTime } from './observations.js'
import { initVideoView, openVideo, closeVideo } from './video-view.js'
import { initFilm, refreshVault } from './film.js'

// Zone de lecture du RIO, en fractions de l'image vidéo.
const CROP = { x: 0.2, y: 0.4, w: 0.6, h: 0.2 }
const IMPORT_MAX_SIDE = 4000

// La date enregistrée n'est celle des faits que pour une photo prise avec l'application.
const DATE_CAVEATS = {
  import: ' (date d’import de la photo)',
  video: ' (date d’analyse de la vidéo)',
}

const $ = (id) => document.getElementById(id)
const views = ['capture', 'film', 'guide', 'journal', 'detail', 'video']

let stream = null
let currentView = null
let lastPosition = null
let current = null
let photoUrls = []
let photoRun = 0

// --- Navigation ---

function show(view) {
  currentView = view
  for (const name of views) $(`view-${name}`).hidden = name !== view
  for (const button of document.querySelectorAll('nav button')) {
    button.classList.toggle('active', button.dataset.view === view)
  }
  if (view === 'capture') startCamera()
  else stopCamera()
  if (view === 'journal') renderJournal()
  if (view === 'film') refreshVault()
  if (view !== 'detail') closeDetail()
  if (view !== 'video') closeVideo()
}

for (const button of document.querySelectorAll('nav button')) {
  button.addEventListener('click', () => show(button.dataset.view))
}

// --- Caméra ---

async function startCamera() {
  if (stream) return
  $('camera-error').hidden = true
  let acquired
  try {
    acquired = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
      audio: false,
    })
  } catch (error) {
    if (currentView !== 'capture') return
    $('camera-error').textContent =
      `Caméra indisponible (${error.name}). Vous pouvez importer une photo prise avec l'appareil photo.`
    $('camera-error').hidden = false
    $('shutter').disabled = true
    return
  }
  // L'onglet a changé pendant l'ouverture : la caméra doit être rendue, sinon elle reste
  // occupée et la caméra guidée de l'onglet Filmer ne peut plus l'ouvrir.
  if (currentView !== 'capture' || stream) {
    for (const track of acquired.getTracks()) track.stop()
    return
  }
  stream = acquired
  $('video').srcObject = stream
  $('shutter').disabled = false
  setupZoom(stream.getVideoTracks()[0])
}

function stopCamera() {
  if (!stream) return
  for (const track of stream.getTracks()) track.stop()
  stream = null
  $('video').srcObject = null
}

function setupZoom(track) {
  const zoom = track.getCapabilities?.().zoom
  $('zoom-row').hidden = !zoom
  if (!zoom) return
  const slider = $('zoom')
  slider.min = zoom.min
  slider.max = zoom.max
  slider.step = zoom.step || 0.1
  slider.value = track.getSettings().zoom ?? zoom.min
  slider.oninput = () => track.applyConstraints({ advanced: [{ zoom: Number(slider.value) }] })
}

Object.assign($('frame').style, {
  left: `${CROP.x * 100}%`,
  top: `${CROP.y * 100}%`,
  width: `${CROP.w * 100}%`,
  height: `${CROP.h * 100}%`,
})

// --- Position ---

if ('geolocation' in navigator) {
  navigator.geolocation.watchPosition(
    ({ coords, timestamp }) => {
      lastPosition = {
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracyMeters: Math.round(coords.accuracy),
        fixedAt: new Date(timestamp).toISOString(),
      }
    },
    () => {},
    { enableHighAccuracy: true, maximumAge: 30_000 },
  )
}

// --- Capture ---

function drawRegion(source, sx, sy, sw, sh) {
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(sw)
  canvas.height = Math.round(sh)
  canvas.getContext('2d').drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
  return canvas
}

// `ocr` : { source, tiles } — l'image où lire le RIO, et s'il faut l'y chercher par tuiles.
async function createFromPhoto(photoCanvas, ocr, source, fields) {
  const image = await makeImage(await toJpeg(photoCanvas))
  const observation = await createObservation([image], source, fields)
  await openDetail(observation.id)
  runOcr(observation.id, ocr)
}

$('shutter').addEventListener('click', async () => {
  const video = $('video')
  const { videoWidth: width, videoHeight: height } = video
  if (!width) return
  const full = drawRegion(video, 0, 0, width, height)
  const crop = drawRegion(full, CROP.x * width, CROP.y * height, CROP.w * width, CROP.h * height)
  // La position de l'appareil n'a de sens que pour une photo prise sur le moment.
  await createFromPhoto(full, { source: crop, tiles: false }, 'capture', { position: lastPosition })
})

$('import').addEventListener('change', async (event) => {
  const [file] = event.target.files
  event.target.value = ''
  if (!file) return
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, IMPORT_MAX_SIDE / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  // Photo entière : le numéro peut y être petit, on le cherche aussi par tuiles.
  await createFromPhoto(canvas, { source: canvas, tiles: true }, 'import')
})

$('video-import').addEventListener('change', (event) => {
  const [file] = event.target.files
  event.target.value = ''
  if (!file) return
  show('video')
  openVideo(file)
})

// --- OCR ---

async function runOcr(id, { source, tiles }) {
  $('ocr-status').textContent = 'Lecture du RIO en cours…'
  $('ocr-candidates').replaceChildren()
  let candidates
  try {
    candidates = await readRio(source, { tiles })
  } catch (error) {
    console.error(error)
    if (current?.id === id) $('ocr-status').textContent = 'Lecture automatique indisponible. Saisissez le numéro à la main.'
    return
  }
  if (current?.id !== id) return

  $('ocr-status').textContent = candidates.length
    ? 'Numéros détectés — vérifiez sur la photo avant de valider :'
    : 'Aucun numéro à 7 chiffres détecté. Saisissez-le à la main ou indiquez qu’il est absent.'
  for (const candidate of candidates) {
    const chip = document.createElement('button')
    chip.textContent = candidate
    chip.className = 'chip'
    chip.addEventListener('click', () => {
      $('detail-rio').value = candidate
      setStatus('lu')
      persistDetail()
    })
    $('ocr-candidates').append(chip)
  }
}

// --- Détail ---

function formatDate(iso) {
  return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'medium' })
}

function formatPosition(position) {
  if (!position) return 'Non disponible'
  return `${position.latitude.toFixed(5)}, ${position.longitude.toFixed(5)} (± ${position.accuracyMeters} m)`
}

function setStatus(status) {
  for (const radio of document.querySelectorAll('input[name="status"]')) radio.checked = radio.value === status
}

const fieldInput = (field) => document.querySelector(`[data-field="${field}"]`)

async function openDetail(id) {
  const observation = await getObservation(id)
  if (!observation) return
  show('detail')
  current = observation
  $('detail-show-original').checked = false
  $('detail-export-original').checked = false
  showPhotos()
  $('detail-date').textContent = formatDate(observation.createdAt) + (DATE_CAVEATS[observation.source] ?? '')
  $('detail-position').textContent = formatPosition(observation.position)
  $('detail-rio').value = observation.rio
  for (const field of FORM_FIELDS) fieldInput(field).value = observation[field] ?? ''
  $('ocr-status').textContent = ''
  $('ocr-candidates').replaceChildren()
  setStatus(observation.status)
}

function clearPhotos() {
  // Invalide un affichage en cours : ses images ne doivent plus être ajoutées.
  photoRun++
  for (const url of photoUrls) URL.revokeObjectURL(url)
  photoUrls = []
  $('detail-photos').replaceChildren()
}

// Images floutées par défaut ; les originaux ne s'affichent que sur demande.
async function showPhotos() {
  const observation = current
  const original = $('detail-show-original').checked
  clearPhotos()
  const run = photoRun
  $('blur-status').textContent = original ? 'Originaux affichés, visages non floutés.' : 'Floutage des visages en cours…'

  let blurredFaces = 0
  for (const image of imagesOf(observation)) {
    let blob = image.photo
    if (!original) {
      try {
        const result = await blurredPhoto(image, observation)
        blob = result.blob
        blurredFaces += result.count
      } catch (error) {
        console.error(error)
        if (run === photoRun) $('blur-status').textContent = 'Floutage indisponible sur cet appareil.'
        return
      }
    }
    if (run !== photoRun) return

    const figure = document.createElement('figure')
    const picture = document.createElement('img')
    const url = URL.createObjectURL(blob)
    photoUrls.push(url)
    picture.src = url
    picture.alt = image.label ?? 'Photo de l’observation'
    if (!original) {
      picture.addEventListener('click', async (event) => {
        const bounds = picture.getBoundingClientRect()
        const x = ((event.clientX - bounds.left) / bounds.width) * picture.naturalWidth
        const y = ((event.clientY - bounds.top) / bounds.height) * picture.naturalHeight
        if (await unblurAt(image, observation, x, y)) showPhotos()
      })
    }
    const caption = document.createElement('figcaption')
    const title = [image.label, image.videoTime != null ? `vidéo à ${formatTime(image.videoTime)}` : '']
      .filter(Boolean)
      .join(' — ')
    const hash = document.createElement('span')
    hash.className = 'mono'
    hash.textContent = `SHA-256 : ${image.sha256}`
    caption.append(title, hash)
    figure.append(picture, caption)
    $('detail-photos').append(figure)
  }
  if (!original) {
    $('blur-status').textContent =
      `${blurredFaces} visage(s) flouté(s). La détection automatique peut en manquer : vérifiez avant de partager. ` +
      'Touchez une zone floutée à tort pour la retirer.'
  }
}

$('detail-show-original').addEventListener('change', () => current && showPhotos())

function closeDetail() {
  clearPhotos()
  current = null
}

async function runExport(button, observations, exportOriginal) {
  button.disabled = true
  try {
    await exportObservations(observations, { blur: !exportOriginal })
  } catch (error) {
    console.error(error)
    alert('Export impossible : le floutage des visages a échoué. Rien n’a été exporté.')
  } finally {
    button.disabled = false
  }
}

async function persistDetail() {
  if (!current) return
  current.rio = $('detail-rio').value
  for (const field of FORM_FIELDS) current[field] = fieldInput(field).value
  current.status = document.querySelector('input[name="status"]:checked')?.value ?? 'illisible'
  await saveObservation(current)
}

$('detail-rio').addEventListener('input', (event) => {
  event.target.value = event.target.value.replace(/\D/g, '')
  if (event.target.value.length === 7) setStatus('lu')
  persistDetail()
})
for (const field of FORM_FIELDS) fieldInput(field).addEventListener('input', persistDetail)
for (const radio of document.querySelectorAll('input[name="status"]')) radio.addEventListener('change', persistDetail)

$('detail-export').addEventListener('click', (event) => {
  if (current) runExport(event.currentTarget, [current], $('detail-export-original').checked)
})

$('detail-delete').addEventListener('click', async () => {
  if (!current || !confirm('Supprimer définitivement cette observation et ses images ?')) return
  await deleteObservation(current.id)
  show('journal')
})

// --- Journal ---

async function renderJournal() {
  const observations = await listObservations()
  $('journal-empty').hidden = observations.length > 0
  $('export-all').hidden = observations.length === 0
  $('journal-export-option').hidden = observations.length === 0
  $('journal-export-original').checked = false
  $('journal-list').replaceChildren(
    ...observations.map((observation) => {
      const item = document.createElement('li')
      const button = document.createElement('button')
      const title = document.createElement('strong')
      title.textContent = observation.status === 'lu' ? `RIO ${observation.rio}` : STATUS_LABELS[observation.status]
      const date = document.createElement('span')
      date.textContent = formatDate(observation.createdAt)
      button.append(title, date)
      button.addEventListener('click', () => openDetail(observation.id))
      item.append(button)
      return item
    }),
  )
}

$('export-all').addEventListener('click', async (event) => {
  const button = event.currentTarget
  runExport(button, await listObservations(), $('journal-export-original').checked)
})

// --- Démarrage ---

initVideoView({ onObservationCreated: openDetail })
initFilm({
  onAnalyse: (file) => {
    show('video')
    openVideo(file)
  },
})

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`)
}

// Évite que le navigateur purge les observations en cas de manque d'espace.
navigator.storage?.persist?.()

show('capture')
