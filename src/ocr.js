// Lecture du RIO par OCR embarqué (Tesseract en WebAssembly, servi depuis public/ocr).
import { createScheduler, createWorker, PSM } from 'tesseract.js'

// Aucun réglage ne lit toutes les photos : les niveaux de gris marchent sur une scène réelle,
// le noir et blanc sur un numéro peu contrasté avec son entourage. On cumule les passes
// et on classe les numéros par nombre de lectures concordantes.
const PASSES = [
  { width: 1000, mode: 'grey' },
  { width: 1400, mode: 'grey' },
  { width: 2000, mode: 'grey' },
  { width: 1400, mode: 'binary' },
  { width: 1400, mode: 'binary-inverted' },
]
const RIO_LENGTH = 7
const MAX_CANDIDATES = 5

// Image vidéo : le RIO y est petit, Tesseract ne le trouve que dans une tuile agrandie.
// Trois niveaux, du plan serré (image entière) au plan large (16 tuiles agrandies deux fois).
const DEEP_LEVEL = { grid: 8, width: 1000 }
const FRAME_LEVELS = [
  { grid: 1, width: 1400 },
  { grid: 2, width: 1400 },
  { grid: 4, width: 1000 },
]
// Écart-type des gris sous lequel une tuile est unie (ciel, mur) et ne peut pas contenir de texte.
const MIN_TILE_SPREAD = 12
const MAX_WORKERS = 4
// Tesseract ne lit plus un numéro penché de quelques degrés. Sur une photo, chaque tuile est donc
// relue redressée dans les deux sens, ce qui couvre environ ±15°. Pas sur une vidéo : trois fois
// plus long, et le numéro y est revu sous d'autres angles au fil des images.
const TILT_ANGLES = [0, 10, -10]

let schedulerPromise

async function createRioWorker() {
  const base = new URL(`${import.meta.env.BASE_URL}ocr/`, location.href).href
  const worker = await createWorker('eng', 1, {
    workerPath: `${base}worker.min.js`,
    corePath: base,
    langPath: base,
  })
  await worker.setParameters({
    tessedit_char_whitelist: '0123456789',
    tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
  })
  return worker
}

// Plusieurs moteurs en parallèle : indispensable pour analyser une vidéo en un temps raisonnable.
function getScheduler() {
  schedulerPromise ??= (async () => {
    const scheduler = createScheduler()
    const count = Math.min(MAX_WORKERS, Math.max(1, (navigator.hardwareConcurrency ?? 2) - 1))
    const workers = await Promise.all(Array.from({ length: count }, createRioWorker))
    for (const worker of workers) scheduler.addWorker(worker)
    return scheduler
  })()
  return schedulerPromise
}

// Seuil d'Otsu : sépare au mieux les pixels clairs des pixels sombres.
function otsuThreshold(histogram, total) {
  let sumAll = 0
  for (let level = 0; level < 256; level++) sumAll += level * histogram[level]

  let best = 0
  let bestVariance = -1
  let countBelow = 0
  let sumBelow = 0
  for (let level = 0; level < 256; level++) {
    countBelow += histogram[level]
    if (countBelow === 0) continue
    const countAbove = total - countBelow
    if (countAbove === 0) break
    sumBelow += level * histogram[level]
    const gap = sumBelow / countBelow - (sumAll - sumBelow) / countAbove
    const variance = countBelow * countAbove * gap * gap
    if (variance > bestVariance) {
      bestVariance = variance
      best = level
    }
  }
  return best
}

// Image à largeur fixe, en niveaux de gris ou en noir et blanc, de toute la source ou d'une région.
// 'binary-inverted' sert au format blanc sur fond noir, ramené à du noir sur blanc.
// Renvoie aussi l'écart-type des gris (`spread`).
// `angle` (degrés) redresse un numéro penché ; les coins découverts sont remplis de gris.
function prepare(source, { width, mode, angle = 0 }, region = { x: 0, y: 0, w: source.width, h: source.height }) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = Math.round((region.h * width) / region.w)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.imageSmoothingQuality = 'high'
  if (angle) {
    ctx.fillStyle = '#808080'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.translate(canvas.width / 2, canvas.height / 2)
    ctx.rotate((angle * Math.PI) / 180)
    ctx.translate(-canvas.width / 2, -canvas.height / 2)
  }
  ctx.drawImage(source, region.x, region.y, region.w, region.h, 0, 0, canvas.width, canvas.height)

  const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const { data } = image
  const greys = new Uint8Array(data.length / 4)
  const histogram = new Uint32Array(256)
  let sum = 0
  let sumOfSquares = 0
  for (let i = 0; i < greys.length; i++) {
    greys[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]
    histogram[greys[i]]++
    sum += greys[i]
    sumOfSquares += greys[i] * greys[i]
  }
  const mean = sum / greys.length
  const spread = Math.sqrt(sumOfSquares / greys.length - mean * mean)

  const threshold = mode === 'grey' ? null : otsuThreshold(histogram, greys.length)
  const invert = mode === 'binary-inverted'
  for (let i = 0; i < greys.length; i++) {
    const value = threshold === null ? greys[i] : greys[i] > threshold !== invert ? 255 : 0
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = value
  }
  ctx.putImageData(image, 0, 0)
  return { canvas, spread }
}

// Ajoute à `scores` les numéros à 7 chiffres lus dans `text`.
// Une suite de 7 chiffres exactement compte double ; une suite plus longue (bord de
// l'étiquette lu comme un chiffre) donne chacune de ses fenêtres de 7 chiffres.
export function scoreRioCandidates(text, scores) {
  for (const run of text.match(/\d+/g) ?? []) {
    if (run.length === RIO_LENGTH) {
      scores.set(run, (scores.get(run) ?? 0) + 2)
    } else if (run.length > RIO_LENGTH && run.length <= RIO_LENGTH + 2) {
      for (let start = 0; start + RIO_LENGTH <= run.length; start++) {
        const candidate = run.slice(start, start + RIO_LENGTH)
        scores.set(candidate, (scores.get(candidate) ?? 0) + 1)
      }
    }
  }
}

// Lance la lecture de `source` découpée en tuiles qui se chevauchent, sur chaque niveau de `levels`.
// Renvoie une promesse par tuile : { data, region, scale } (résultat Tesseract, zone de la tuile
// dans la source, facteur pour ramener ses coordonnées à celles de la source).
// Chaque tuile est lue une fois par angle de `angles`.
function recognizeTiles(scheduler, source, levels, angles = [0]) {
  const jobs = []
  for (const { grid, width } of levels) {
    const w = source.width / grid
    const h = source.height / grid
    // Demi-pas : un numéro coupé par le bord d'une tuile est entier dans la voisine.
    const steps = grid * 2 - 1
    for (let row = 0; row < steps; row++) {
      for (let column = 0; column < steps; column++) {
        const region = { x: (column * w) / 2, y: (row * h) / 2, w, h }
        for (const angle of angles) {
          const { canvas, spread } = prepare(source, { width, mode: 'grey', angle }, region)
          if (spread < MIN_TILE_SPREAD) break
          jobs.push(scheduler.addJob('recognize', canvas).then(({ data }) => ({ data, region, scale: w / width })))
        }
      }
    }
  }
  return jobs
}

// Renvoie les numéros possibles, du plus probable au moins probable.
// `tiles` : cherche aussi le numéro dans des tuiles agrandies, pour une photo entière où il est
// petit ; inutile quand la source est déjà cadrée sur le numéro.
export async function readRio(source, { tiles = false } = {}) {
  const scheduler = await getScheduler()
  const scores = new Map()
  const results = await Promise.all([
    ...PASSES.map((pass) => scheduler.addJob('recognize', prepare(source, pass).canvas)),
    ...(tiles ? recognizeTiles(scheduler, source, FRAME_LEVELS, TILT_ANGLES) : []),
  ])
  for (const { data } of results) scoreRioCandidates(data.text, scores)
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_CANDIDATES)
    .map(([candidate]) => candidate)
}

// Cherche les RIO dans une image de vidéo. Renvoie une entrée par numéro lu :
// { rio, reads, box } où `reads` est le nombre de tuiles qui l'ont lu et `box` son emplacement
// dans l'image. Plus strict que readRio : seuls les mots de 7 chiffres exactement comptent,
// car une scène chargée produit beaucoup de faux chiffres. Tesseract ne donne pas d'indice de
// confiance exploitable quand on le restreint aux chiffres : c'est la répétition des lectures
// (entre tuiles, puis entre images) qui distingue un vrai numéro d'un faux.
// `deep` ajoute un niveau de tuiles deux fois plus petites, pour les agents éloignés : quatre fois plus long.
export async function findRiosInFrame(frame, { deep = false } = {}) {
  const scheduler = await getScheduler()
  const jobs = recognizeTiles(scheduler, frame, deep ? [...FRAME_LEVELS, DEEP_LEVEL] : FRAME_LEVELS)

  const sightings = new Map()
  for (const { data, region, scale } of await Promise.all(jobs)) {
    for (const word of data.words ?? []) {
      const rio = word.text.trim()
      if (rio.length !== RIO_LENGTH || !/^\d+$/.test(rio)) continue
      const known = sightings.get(rio)
      if (known) {
        known.reads++
        continue
      }
      sightings.set(rio, {
        rio,
        reads: 1,
        box: {
          x: region.x + word.bbox.x0 * scale,
          y: region.y + word.bbox.y0 * scale,
          w: (word.bbox.x1 - word.bbox.x0) * scale,
          h: (word.bbox.y1 - word.bbox.y0) * scale,
        },
      })
    }
  }
  return [...sightings.values()]
}
