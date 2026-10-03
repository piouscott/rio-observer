// Publie le dossier dist sur la branche gh-pages du dépôt (GitHub Pages).
// La branche ne garde pas d'historique : chaque publication remplace la précédente.
import { execFileSync, execSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const run = (cwd, ...args) => execFileSync(args[0], args.slice(1), { cwd, stdio: 'inherit' })
const read = (cwd, ...args) => execFileSync(args[0], args.slice(1), { cwd, encoding: 'utf8' }).trim()

const remote = read(root, 'git', 'remote', 'get-url', 'origin')

// Par le shell : sous Windows, npm est un script .cmd qu'execFileSync ne sait pas lancer.
execSync('npm run build', { cwd: root, stdio: 'inherit' })
// Sans ce fichier, GitHub Pages passe le site dans Jekyll.
writeFileSync(join(dist, '.nojekyll'), '')

rmSync(join(dist, '.git'), { recursive: true, force: true })
run(dist, 'git', 'init', '--quiet', '-b', 'gh-pages')
run(dist, 'git', 'add', '-A')
run(dist, 'git', 'commit', '--quiet', '-m', `Publication du ${new Date().toISOString()}`)
run(dist, 'git', 'push', '--force', remote, 'gh-pages')
rmSync(join(dist, '.git'), { recursive: true, force: true })

console.log('Publié sur la branche gh-pages.')
