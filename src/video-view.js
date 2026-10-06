// Écran vidéo : lecteur avec zoom, relevé des RIO, et marquage d'instants pour un agent sans RIO.
import { readRio } from './ocr.js'
import { scanVideo, ensureDuration, MAX_DEEP_FRAME_WIDTH } from './video.js'
import { createObservation, makeImage, toJpeg, formatTime } from './observations.js'

// Un numéro lu une seule fois dans toute la vidéo est presque toujours un faux.
const MIN_VIDEO_READS = 2
const THUMBNAIL_WIDTH = 320

const $ = (id) => document.getElementById(id)

// Tout l'état de l'écran pour la vidéo ouverte ; remplacé à chaque ouverture, ce qui permet
// aux traitements en cours de voir qu'ils ne sont plus d'actualité (`session !== mine`).
let session = null
let onObservationCreated = () => {}

// --- Images ---

function drawRegion(source, { x, y, w, h }, width = Math.round(w)) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = Math.round((h * width) / w)
  canvas.getContext('2d').drawImage(source, x, y, w, h, 0, 0, canvas.width, canvas.height)
  return canvas
}

const thumbnailOf = (source, region) =>
  drawRegion(source, region, Math.min(THUMBNAIL_WIDTH, Math.round(region.w))).toDataURL('image/jpeg', 0.85)

const wholeOf = (canvas) => ({ x: 0, y: 0, w: canvas.width, h: canvas.height })

// Image affichée par le lecteur, en pleine définition.
function currentFrame() {
  const player = $('player')
  const scale = Math.min(1, MAX_DEEP_FRAME_WIDTH / player.videoWidth)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(player.videoWidth * scale)
  canvas.height = Math.round(player.videoHeight * scale)
  canvas.getContext('2d').drawImage(player, 0, 0, canvas.width, canvas.height)
  return canvas
}

// Partie de l'image visible dans le lecteur compte tenu du zoom et du défilement, en pixels de `frame`.
function visibleRegion(frame) {
  const player = $('player')
  const viewport = $('player-viewport')
  const scale = frame.width / player.clientWidth
  return {
    x: viewport.scrollLeft * scale,
    y: viewport.scrollTop * scale,
    w: Math.min(viewport.clientWidth, player.clientWidth) * scale,
    h: Math.min(viewport.clientHeight, player.clientHeight) * scale,
  }
}

const isZoomed = (frame, region) => region.w < frame.width * 0.99 || region.h < frame.height * 0.99

// --- Lecteur ---

function setZoom(zoom) {
  const player = $('player')
  const viewport = $('player-viewport')
  // Le zoom garde le centre de l'image affichée.
  const centerX = (viewport.scrollLeft + viewport.clientWidth / 2) / player.clientWidth
  const centerY = (viewport.scrollTop + viewport.clientHeight / 2) / player.clientHeight
  player.style.width = `${zoom * 100}%`
  viewport.scrollLeft = centerX * player.clientWidth - viewport.clientWidth / 2
  viewport.scrollTop = centerY * player.clientHeight - viewport.clientHeight / 2
}

function updateTime() {
  const player = $('player')
  $('player-seek').value = player.currentTime
  $('player-time').textContent = `${formatTime(player.currentTime)} / ${formatTime(player.duration || 0)}`
}

// --- Numéros relevés ---

const differsByOneDigit = (a, b) => [...a].filter((digit, index) => digit !== b[index]).length === 1

function renderResults() {
  const mine = session
  const shown = [...mine.found.values()]
    .filter((entry) => entry.manual || entry.reads >= MIN_VIDEO_READS)
    .sort((a, b) => b.manual - a.manual || b.frames - a.frames || b.reads - a.reads)

  $('video-results').replaceChildren(
    ...shown.map((entry) => {
      const item = document.createElement('li')
      const image = document.createElement('img')
      image.src = entry.thumbnail
      image.alt = `Extrait de la vidéo à ${formatTime(entry.time)}`
      const title = document.createElement('strong')
      title.textContent = entry.rio
      const details = document.createElement('span')
      details.textContent = entry.manual
        ? `Lu dans la zone affichée, à ${formatTime(entry.time)}.`
        : `Lu dans ${entry.frames} image(s), dont à ${formatTime(entry.time)}.`
      const stronger = shown.find(
        (other) => !entry.manual && other.frames > entry.frames && differsByOneDigit(other.rio, entry.rio),
      )
      if (stronger) details.textContent += ` Proche de ${stronger.rio} : probablement le même numéro mal lu.`

      const save = document.createElement('button')
      save.textContent = entry.saved ? 'Enregistré' : 'Enregistrer'
      save.disabled = entry.saved
      save.addEventListener('click', async () => {
        save.disabled = true
        const frame = await makeImage(entry.photo, { label: 'Numéro RIO', videoTime: entry.time })
        await createObservation([frame], 'video', { rio: entry.rio, status: 'lu', videoName: mine.file.name })
        entry.saved = true
        save.textContent = 'Enregistré'
      })
      item.append(image, title, details, save)
      return item
    }),
  )
}

async function readZone() {
  const mine = session
  const player = $('player')
  player.pause()
  const frame = currentFrame()
  const region = visibleRegion(frame)
  const time = player.currentTime
  $('video-status').textContent = 'Lecture du RIO dans la zone affichée…'

  let candidates
  try {
    candidates = await readRio(drawRegion(frame, region), { tiles: true })
  } catch (error) {
    console.error(error)
    if (session === mine) $('video-status').textContent = 'Lecture automatique indisponible.'
    return
  }
  if (session !== mine) return

  if (!candidates.length) {
    $('video-status').textContent =
      'Aucun numéro à 7 chiffres lu dans la zone affichée. Zoomez davantage ou choisissez une image plus nette.'
    return
  }
  const photo = await toJpeg(frame)
  for (const rio of candidates) {
    mine.found.set(rio, {
      rio,
      manual: true,
      frames: 0,
      reads: 0,
      time,
      photo,
      thumbnail: thumbnailOf(frame, region),
      saved: false,
    })
  }
  $('video-status').textContent = 'Comparez chaque numéro à son extrait avant de l’enregistrer.'
  renderResults()
}

// Extrait de l'image autour du numéro, pour le vérifier d'un coup d'œil.
function sightingRegion(frame, box) {
  const w = Math.min(frame.width, box.w * 3)
  const h = Math.min(frame.height, box.h * 4)
  return {
    x: Math.max(0, Math.min(frame.width - w, box.x + box.w / 2 - w / 2)),
    y: Math.max(0, Math.min(frame.height - h, box.y + box.h / 2 - h / 2)),
    w,
    h,
  }
}

async function scanWholeVideo() {
  const mine = session
  const scan = new AbortController()
  mine.scan = scan
  let framePhoto = null
  let framePhotoTime = null
  // Une nouvelle recherche repart de zéro ; les numéros lus à la main dans une zone sont gardés.
  for (const [rio, entry] of mine.found) if (!entry.manual) mine.found.delete(rio)
  renderResults()
  setScanning(true)
  $('video-progress').value = 0
  $('video-status').textContent = 'Chargement du moteur de lecture…'

  try {
    await scanVideo(mine.file, {
      signal: scan.signal,
      deep: $('video-deep').checked,
      onProgress: (done, duration) => {
        if (session !== mine) return
        $('video-progress').value = done / duration
        $('video-status').textContent = `Recherche des RIO : ${formatTime(done)} sur ${formatTime(duration)}.`
      },
      onSighting: async ({ rio, reads, box, time, frame }) => {
        if (session !== mine) return
        const entry = mine.found.get(rio)
        if (entry) {
          entry.frames++
          entry.reads += reads
        } else {
          // Une seule copie JPEG par image, partagée entre les numéros qui y sont lus.
          if (framePhotoTime !== time) {
            framePhoto = await toJpeg(frame)
            framePhotoTime = time
          }
          mine.found.set(rio, {
            rio,
            manual: false,
            frames: 1,
            reads,
            time,
            photo: framePhoto,
            thumbnail: thumbnailOf(frame, sightingRegion(frame, box)),
            saved: false,
          })
        }
        renderResults()
      },
    })
  } catch (error) {
    console.error(error)
    if (session !== mine) return
    setScanning(false)
    $('video-status').textContent = `Analyse impossible : ${error.message}`
    return
  }

  if (session !== mine) return
  setScanning(false)
  $('video-status').textContent =
    (scan.signal.aborted ? 'Recherche interrompue. ' : 'Recherche terminée. ') +
    ($('video-results').children.length
      ? 'Comparez chaque numéro à son extrait avant de l’enregistrer.'
      : 'Aucun numéro lisible trouvé. Essayez l’analyse approfondie, ou zoomez sur un agent et lisez la zone affichée.')
}

function setScanning(scanning) {
  $('video-scan').hidden = scanning
  $('video-stop').hidden = !scanning
  $('video-progress').hidden = !scanning
  $('video-deep').disabled = scanning
}

// --- Instants marqués (agent sans RIO) ---

function renderMarks() {
  const mine = session
  $('video-marks').replaceChildren(
    ...mine.marks.map((mark) => {
      const item = document.createElement('li')
      const image = document.createElement('img')
      image.src = mark.thumbnail
      image.alt = `${mark.label}, à ${formatTime(mark.time)}`
      const title = document.createElement('span')
      title.textContent = `${mark.label} — ${formatTime(mark.time)}${mark.images.length > 1 ? ' (image entière + détail agrandi)' : ''}`
      const remove = document.createElement('button')
      remove.textContent = 'Retirer'
      remove.addEventListener('click', () => {
        mine.marks.splice(mine.marks.indexOf(mark), 1)
        renderMarks()
      })
      item.append(image, title, remove)
      return item
    }),
  )
  const count = mine.marks.reduce((total, mark) => total + mark.images.length, 0)
  $('video-create').hidden = count === 0
  $('video-create').textContent = `Créer l’observation (${count} image${count > 1 ? 's' : ''})`
}

async function markInstant() {
  const mine = session
  const player = $('player')
  player.pause()
  const frame = currentFrame()
  const region = visibleRegion(frame)
  const time = player.currentTime
  const label = $('mark-label').value
  const zoomed = isZoomed(frame, region)

  // L'image entière donne le contexte ; si le lecteur est zoomé, la zone affichée est gardée en plus.
  const images = [await makeImage(await toJpeg(frame), { label, videoTime: time })]
  if (zoomed) {
    const detail = await toJpeg(drawRegion(frame, region))
    images.push(await makeImage(detail, { label: `${label} (détail agrandi)`, videoTime: time }))
  }
  if (session !== mine) return
  mine.marks.push({ label, time, images, thumbnail: thumbnailOf(frame, zoomed ? region : wholeOf(frame)) })
  renderMarks()
}

async function createFromMarks() {
  const mine = session
  $('video-create').disabled = true
  try {
    const images = mine.marks.flatMap((mark) => mark.images)
    const observation = await createObservation(images, 'video', { status: 'absent', videoName: mine.file.name })
    onObservationCreated(observation.id)
  } finally {
    $('video-create').disabled = false
  }
}

// --- Ouverture, fermeture ---

export function openVideo(file) {
  closeVideo()
  session = { file, url: URL.createObjectURL(file), found: new Map(), marks: [], scan: null }
  const player = $('player')
  player.src = session.url
  $('player-zoom').value = 1
  player.style.width = '100%'
  $('video-name').textContent = file.name
  $('video-status').textContent = ''
  $('video-deep').checked = false
  setScanning(false)
  renderResults()
  renderMarks()
}

export function closeVideo() {
  if (!session) return
  session.scan?.abort()
  const player = $('player')
  player.pause()
  player.removeAttribute('src')
  player.load()
  URL.revokeObjectURL(session.url)
  session = null
}

export function initVideoView(callbacks) {
  onObservationCreated = callbacks.onObservationCreated
  const player = $('player')

  player.addEventListener('loadedmetadata', async () => {
    $('player-viewport').style.aspectRatio = `${player.videoWidth} / ${player.videoHeight}`
    try {
      await ensureDuration(player)
    } catch (error) {
      console.error(error)
      return
    }
    $('player-seek').max = player.duration
    updateTime()
  })
  player.addEventListener('timeupdate', updateTime)
  player.addEventListener('play', () => ($('player-toggle').textContent = 'Pause'))
  player.addEventListener('pause', () => ($('player-toggle').textContent = 'Lecture'))

  $('player-toggle').addEventListener('click', () => (player.paused ? player.play() : player.pause()))
  $('player-seek').addEventListener('input', (event) => (player.currentTime = Number(event.target.value)))
  $('player-zoom').addEventListener('input', (event) => setZoom(Number(event.target.value)))

  $('video-read-zone').addEventListener('click', readZone)
  $('video-scan').addEventListener('click', scanWholeVideo)
  $('video-stop').addEventListener('click', () => session?.scan?.abort())
  $('video-mark').addEventListener('click', markInstant)
  $('video-create').addEventListener('click', createFromMarks)
}
