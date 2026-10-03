// Export des observations en ZIP : photos originales + métadonnées + notice.
import { zipSync, strToU8 } from 'fflate'
import { blurredPhoto } from './faces.js'
import { imagesOf } from './observations.js'
import { buildSignalement } from './signalement.js'

const README = `RIO Observer — export d'observations

Contenu :
- observations.json : date, position, RIO relevé, statut, fiche et empreinte de chaque image.
- photos/<id>.jpg, <id>-2.jpg… : les images de l'observation. Si "visagesFloutes" vaut true
  dans observations.json, les visages détectés automatiquement ont été floutés ; sinon ce
  sont les originaux. La détection automatique peut manquer des visages : vérifiez avant
  de transmettre.
- signalements/<id>.txt : brouillon de signalement pré-rempli à partir de la fiche, à
  compléter et à relire avant envoi.

L'empreinte SHA-256 a été calculée au moment de la capture, sur la photo ORIGINALE.
Elle permet de vérifier que l'original n'a pas été modifié depuis ; elle ne correspond
donc pas au fichier d'une photo floutée. Pour lui donner une date certaine, transmettez
l'empreinte à un tiers (courriel, messagerie) le plus tôt possible après les faits.
L'original reste dans l'application et peut être exporté sans floutage pour les autorités
ou un avocat.

Usage prévu : pièce à joindre à un signalement (IGPN, IGGN, Défenseur des droits),
à une plainte, ou à remettre à un avocat.

Ne publiez pas ces éléments : la diffusion d'informations permettant d'identifier un agent
dans le but de l'exposer à un risque est un délit (article 223-1-1 du code pénal), et les
visages de tiers sont protégés par le droit à l'image.
`

export async function buildZip(observations, { blur }) {
  const files = { 'LISEZMOI.txt': strToU8(README) }
  const metadata = []
  for (const observation of observations) {
    const images = []
    for (const [index, image] of imagesOf(observation).entries()) {
      const exported = blur ? (await blurredPhoto(image, observation)).blob : image.photo
      const file = `photos/${observation.id}${index ? `-${index + 1}` : ''}.jpg`
      // level 0 : un JPEG est déjà compressé
      files[file] = [new Uint8Array(await exported.arrayBuffer()), { level: 0 }]
      images.push({ file, sha256: image.sha256, label: image.label, videoTime: image.videoTime })
    }
    const { photo, faces, facesVersion, extras, sha256, label, videoTime, ...fields } = observation
    metadata.push({ ...fields, images, visagesFloutes: blur })
    files[`signalements/${observation.id}.txt`] = strToU8(buildSignalement(observation, images, { blurred: blur }))
  }
  files['observations.json'] = strToU8(JSON.stringify(metadata, null, 2))
  return new Blob([zipSync(files)], { type: 'application/zip' })
}

// `blur` : visages floutés (défaut de l'interface) ou photos originales.
export async function exportObservations(observations, { blur }) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const file = new File([await buildZip(observations, { blur })], `rio-observer-${stamp}.zip`, {
    type: 'application/zip',
  })

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] })
      return
    } catch (error) {
      if (error.name === 'AbortError') return
    }
  }

  const link = document.createElement('a')
  link.href = URL.createObjectURL(file)
  link.download = file.name
  link.click()
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000)
}
