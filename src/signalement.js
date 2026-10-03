// Texte de signalement pré-rempli à partir d'une observation, joint à l'export.
import { STATUS_LABELS, RIO_REQUEST_LABELS, formatTime } from './observations.js'

const BLANK = '[à compléter]'

function formatFactsDate(observation) {
  // Sans date saisie, seule une photo prise avec l'application est datée du moment des faits.
  const value = observation.factsAt || (observation.source === 'capture' ? observation.createdAt : '')
  return value ? new Date(value).toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'short' }) : BLANK
}

function formatPlace(observation) {
  const { position } = observation
  const coordinates = position
    ? `coordonnées ${position.latitude.toFixed(5)}, ${position.longitude.toFixed(5)} (± ${position.accuracyMeters} m)`
    : ''
  return [observation.place, coordinates].filter(Boolean).join(' — ') || BLANK
}

// `files` : pour chaque image exportée, { file, sha256, label, videoTime }.
export function buildSignalement(observation, files, { blurred }) {
  const absent = observation.status === 'absent'
  const fromVideo = observation.source === 'video'

  const identification =
    observation.status === 'lu' && observation.rio
      ? observation.rio
      : STATUS_LABELS[observation.status].replace('RIO ', '')

  const attachments = files.map(({ file, sha256, label, videoTime }) => {
    const caption = [label, videoTime != null ? `vidéo à ${formatTime(videoTime)}` : ''].filter(Boolean).join(', ')
    return `- ${file}${caption ? ` (${caption})` : ''} — SHA-256 de l'original : ${sha256}`
  })

  return [
    'SIGNALEMENT — brouillon à compléter et à relire avant envoi',
    '',
    'Destinataires possibles : IGPN (police nationale), IGGN (gendarmerie nationale), Défenseur des droits.',
    '',
    `Auteur du signalement : ${BLANK} (nom, prénom, coordonnées)`,
    '',
    'FAITS',
    `Date et heure : ${formatFactsDate(observation)}`,
    `Lieu : ${formatPlace(observation)}`,
    `Description : ${observation.notes || BLANK}`,
    '',
    'AGENT CONCERNÉ',
    `Unité ou service : ${observation.unitType || BLANK}`,
    `Numéro d'identification individuel (RIO) : ${identification}`,
    ...(absent
      ? [
          "L'agent ne portait pas de numéro d'identification visible. Le respect des règles d'identification",
          'individuelle est une obligation (article R. 434-15 du code de la sécurité intérieure) ; je signale',
          'également ce manquement.',
        ]
      : []),
    `Demande orale du numéro : ${RIO_REQUEST_LABELS[observation.rioRequest ?? '']}`,
    `Marquages (casque, dos, écusson, grade) : ${observation.markings || BLANK}`,
    `Véhicule (plaque, marquage) : ${observation.plate || BLANK}`,
    '',
    'TÉMOINS',
    observation.witnesses || BLANK,
    '',
    'PIÈCES JOINTES',
    ...attachments,
    ...(blurred
      ? ['Les visages ont été floutés sur ces copies ; je conserve les originaux et les tiens à disposition.']
      : []),
    ...(fromVideo
      ? [
          `Ces images sont extraites d'une vidéo${observation.videoName ? ` (« ${observation.videoName} »)` : ''} que je conserve et tiens à disposition.`,
        ]
      : []),
    '',
    'DEMANDE DE CONSERVATION',
    'Je demande que soient conservés sans délai les enregistrements susceptibles d’éclairer les faits :',
    'vidéoprotection du lieu, caméras-piétons des agents présents, enregistrements radio. Leur durée de',
    'conservation est limitée.',
    '',
  ].join('\n')
}
