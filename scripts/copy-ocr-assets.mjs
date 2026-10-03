// Copie le moteur OCR dans public/ocr pour qu'il soit servi en local :
// aucune image ni requête ne doit partir vers un CDN.
import { cpSync, mkdirSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const modules = join(root, 'node_modules')
const out = join(root, 'public', 'ocr')

if (!existsSync(join(modules, 'tesseract.js'))) process.exit(0)

mkdirSync(out, { recursive: true })

cpSync(join(modules, 'tesseract.js', 'dist', 'worker.min.js'), join(out, 'worker.min.js'))

const core = join(modules, 'tesseract.js-core')
for (const file of readdirSync(core)) {
  if (/^tesseract-core.*\.(js|wasm)$/.test(file)) cpSync(join(core, file), join(out, file))
}

cpSync(
  join(modules, '@tesseract.js-data', 'eng', '4.0.0_best_int', 'eng.traineddata.gz'),
  join(out, 'eng.traineddata.gz'),
)

console.log('Moteur OCR copié dans public/ocr')

// Détection de visages (floutage) : même principe, tout est servi en local.
const FACE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite'
const faces = join(root, 'public', 'faces')
const faceModel = join(faces, 'blaze_face_short_range.tflite')

cpSync(join(modules, '@mediapipe', 'tasks-vision', 'wasm'), join(faces, 'wasm'), { recursive: true })

if (!existsSync(faceModel)) {
  const response = await fetch(FACE_MODEL_URL)
  if (!response.ok) throw new Error(`Téléchargement du modèle de visages impossible (${response.status})`)
  writeFileSync(faceModel, Buffer.from(await response.arrayBuffer()))
}

console.log('Détection de visages copiée dans public/faces')
