// Forme d'une observation et libellés partagés entre l'interface et l'export.
import { saveObservation } from './db.js'

export const STATUS_LABELS = {
  lu: 'RIO lu',
  illisible: 'RIO illisible',
  absent: 'RIO non porté ou masqué',
}

export const RIO_REQUEST_LABELS = {
  '': 'Non renseigné',
  'non-demande': 'Numéro non demandé à l’agent',
  donne: 'Numéro demandé, communiqué oralement',
  refuse: 'Numéro demandé, refus de le communiquer',
}

// Champs de la fiche saisis à la main, dans l'ordre du formulaire.
export const FORM_FIELDS = ['factsAt', 'place', 'unitType', 'markings', 'plate', 'rioRequest', 'notes', 'witnesses']

export const toJpeg = (canvas) => new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92))

export async function sha256(blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export const formatTime = (seconds) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`

// Image d'une observation : la photo, son empreinte, et pour une image tirée d'une vidéo
// ce qu'elle montre (`label`) et son instant (`videoTime`, en secondes).
export async function makeImage(photo, fields = {}) {
  return { photo, sha256: await sha256(photo), ...fields }
}

// L'observation porte elle-même l'image principale ; `extras` contient les suivantes.
export const imagesOf = (observation) => [observation, ...(observation.extras ?? [])]

export async function createObservation(images, source, fields = {}) {
  const [main, ...extras] = images
  const observation = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    source,
    position: null,
    rio: '',
    status: 'illisible',
    ...Object.fromEntries(FORM_FIELDS.map((field) => [field, ''])),
    ...main,
    extras,
    ...fields,
  }
  await saveObservation(observation)
  return observation
}
