// Floutage des visages, calculé sur l'appareil (MediaPipe, servi depuis public/faces).
// L'original n'est jamais modifié : le floutage s'applique à l'affichage et à l'export.
import { FaceDetector, FilesetResolver } from '@mediapipe/tasks-vision'
import { saveObservation } from './db.js'

// Le modèle ne voit que les visages assez grands dans l'image qu'on lui donne :
// on le repasse sur des tuiles de plus en plus petites pour attraper les visages lointains,
// jusqu'à cette largeur de tuile (en pixels de la photo).
const MIN_TILE_WIDTH = 480
// Marge autour du visage détecté, pour couvrir cheveux, oreilles et menton.
const MARGIN = 0.35
const MOSAIC_CELLS = 6
// Mesuré sur des images de test : les vrais visages sortent entre 0,7 et 0,96, les faux
// (tissu d'uniforme, main, drapeau) à 0,62 au plus. Plus bas, l'uniforme est flouté à tort.
const MIN_FACE_SCORE = 0.7
// À incrémenter quand la détection change, pour refaire celle des images déjà enregistrées.
const DETECTION_VERSION = 2

let detectorPromise

function getDetector() {
  detectorPromise ??= (async () => {
    const base = new URL(`${import.meta.env.BASE_URL}faces/`, location.href).href
    const fileset = await FilesetResolver.forVisionTasks(`${base}wasm`)
    return FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: `${base}blaze_face_short_range.tflite` },
      runningMode: 'IMAGE',
      minDetectionConfidence: MIN_FACE_SCORE,
    })
  })()
  return detectorPromise
}

async function toCanvas(blob) {
  const bitmap = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  canvas.getContext('2d').drawImage(bitmap, 0, 0)
  bitmap.close()
  return canvas
}

function contains(box, other) {
  const centerX = other.x + other.w / 2
  const centerY = other.y + other.h / 2
  return centerX >= box.x && centerX <= box.x + box.w && centerY >= box.y && centerY <= box.y + box.h
}

async function detectFaces(canvas) {
  const detector = await getDetector()
  const tile = document.createElement('canvas')
  const ctx = tile.getContext('2d', { willReadFrequently: true })
  const faces = []

  for (let grid = 1; grid === 1 || canvas.width / grid >= MIN_TILE_WIDTH; grid *= 2) {
    const width = Math.ceil(canvas.width / grid)
    const height = Math.ceil(canvas.height / grid)
    tile.width = width
    tile.height = height
    // Demi-pas : les tuiles se chevauchent, un visage à cheval sur une bordure reste entier dans une autre.
    const steps = grid === 1 ? 1 : grid * 2 - 1
    for (let row = 0; row < steps; row++) {
      for (let column = 0; column < steps; column++) {
        const left = Math.round((column * width) / 2)
        const top = Math.round((row * height) / 2)
        ctx.drawImage(canvas, left, top, width, height, 0, 0, width, height)
        for (const { boundingBox: box } of detector.detect(tile).detections) {
          if (!box) continue
          const face = { x: left + box.originX, y: top + box.originY, w: box.width, h: box.height }
          // Les tuiles se chevauchent : un même visage ressort plusieurs fois.
          if (!faces.some((known) => contains(known, face))) faces.push(face)
        }
      }
    }
  }
  return faces
}

// Zone réellement floutée pour un visage : sa boîte élargie de la marge.
const blurredZone = ({ x, y, w, h }) => ({
  x: x - w * MARGIN,
  y: y - h * MARGIN,
  w: w * (1 + 2 * MARGIN),
  h: h * (1 + 2 * MARGIN),
})

function mosaic(ctx, canvas, face) {
  const zone = blurredZone(face)
  const left = Math.max(0, Math.floor(zone.x))
  const top = Math.max(0, Math.floor(zone.y))
  const width = Math.min(canvas.width - left, Math.ceil(zone.w))
  const height = Math.min(canvas.height - top, Math.ceil(zone.h))
  if (width <= 0 || height <= 0) return

  // Réduction à quelques pixels puis agrandissement : l'information du visage est détruite, pas masquée.
  const small = document.createElement('canvas')
  small.width = small.height = MOSAIC_CELLS
  small.getContext('2d').drawImage(canvas, left, top, width, height, 0, 0, MOSAIC_CELLS, MOSAIC_CELLS)
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(small, 0, 0, MOSAIC_CELLS, MOSAIC_CELLS, left, top, width, height)
}

// Renvoie la photo floutée d'une image de l'observation et le nombre de zones floutées.
// Les visages détectés sont mémorisés dans l'image pour ne pas refaire la détection.
export async function blurredPhoto(image, observation) {
  const canvas = await toCanvas(image.photo)
  if (image.facesVersion !== DETECTION_VERSION) {
    image.faces = await detectFaces(canvas)
    image.facesVersion = DETECTION_VERSION
    await saveObservation(observation)
  }
  const ctx = canvas.getContext('2d')
  for (const face of image.faces) mosaic(ctx, canvas, face)
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92))
  return { blob, count: image.faces.length }
}

// Retire les zones floutées qui couvrent le point (x, y) de la photo : sert à corriger un
// floutage posé à tort. Renvoie vrai si une zone a été retirée.
export async function unblurAt(image, observation, x, y) {
  const kept = (image.faces ?? []).filter((face) => {
    const zone = blurredZone(face)
    return x < zone.x || x > zone.x + zone.w || y < zone.y || y > zone.y + zone.h
  })
  if (kept.length === (image.faces ?? []).length) return false
  image.faces = kept
  await saveObservation(observation)
  return true
}
