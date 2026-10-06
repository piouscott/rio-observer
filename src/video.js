// Analyse d'une vidéo enregistrée : parcourt les images et relève tous les RIO lisibles.
import { findRiosInFrame } from './ocr.js'

// Une image analysée par seconde de vidéo : compromis entre durée d'analyse et chances de lecture.
const FRAME_INTERVAL_SECONDS = 1
// Au-delà, le coût d'analyse augmente sans rendre les petits numéros plus lisibles.
const MAX_FRAME_WIDTH = 1920
// Analyse approfondie : on garde toute la définition d'une vidéo 4K.
export const MAX_DEEP_FRAME_WIDTH = 3840
const SEEK_TIMEOUT_MS = 5000

function once(target, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Vidéo illisible (${event})`)), timeoutMs)
    target.addEventListener(
      event,
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

// Une vidéo enregistrée par le navigateur (webm de la caméra guidée) n'annonce pas sa durée.
// Demander une position très lointaine oblige le lecteur à la calculer ; on revient ensuite au début.
export async function ensureDuration(video) {
  if (Number.isFinite(video.duration)) return
  const known = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Durée de la vidéo inconnue')), SEEK_TIMEOUT_MS * 2)
    video.addEventListener('durationchange', function check() {
      if (!Number.isFinite(video.duration)) return
      video.removeEventListener('durationchange', check)
      clearTimeout(timer)
      resolve()
    })
  })
  video.currentTime = Number.MAX_SAFE_INTEGER
  await known
  const seeked = once(video, 'seeked', SEEK_TIMEOUT_MS)
  video.currentTime = 0
  await seeked
}

// Appelle `onSighting({ rio, reads, box, time, frame })` pour chaque numéro lu dans une image
// (`frame` est le canevas de l'image, réutilisé d'une image à l'autre : le copier pour le garder)
// et `onProgress(secondes analysées, durée)` après chaque image. S'arrête si `signal` est annulé.
// `deep` : analyse approfondie pour les agents éloignés (pleine définition, tuiles plus fines), bien plus lente.
export async function scanVideo(file, { onSighting, onProgress, signal, deep = false }) {
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  video.src = URL.createObjectURL(file)

  try {
    await once(video, 'loadeddata', SEEK_TIMEOUT_MS * 2)
    await ensureDuration(video)

    const scale = Math.min(1, (deep ? MAX_DEEP_FRAME_WIDTH : MAX_FRAME_WIDTH) / video.videoWidth)
    const frame = document.createElement('canvas')
    frame.width = Math.round(video.videoWidth * scale)
    frame.height = Math.round(video.videoHeight * scale)
    const ctx = frame.getContext('2d', { willReadFrequently: true })

    for (let time = 0; time < video.duration && !signal.aborted; time += FRAME_INTERVAL_SECONDS) {
      const seeked = once(video, 'seeked', SEEK_TIMEOUT_MS)
      video.currentTime = time
      await seeked
      ctx.drawImage(video, 0, 0, frame.width, frame.height)

      for (const sighting of await findRiosInFrame(frame, { deep })) {
        if (signal.aborted) break
        await onSighting({ ...sighting, time, frame })
      }
      onProgress(Math.min(time + FRAME_INTERVAL_SECONDS, video.duration), video.duration)
    }
  } finally {
    URL.revokeObjectURL(video.src)
    video.removeAttribute('src')
    video.load()
  }
}
