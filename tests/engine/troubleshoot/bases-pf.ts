/**
 * Base saine des tests des pannes du pare-feu (v2.10, #248) : le départ du lab 59, c'est-à-dire un pfSense
 * complet (WAN derrière un fournisseur, LAN avec DHCP, DMZ isolée du LAN, alias, mises à jour HTTP, site publié
 * par redirection de port, NAT sortant automatique), construit par le départ déclaratif du lab fourni.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildLabStart, parseLabText, type LabState } from '@engine/index'

export function buildPfHealthy(): LabState {
  const parsed = parseLabText(
    readFileSync(join(__dirname, '../../../labs/lab-59-depannage-pare-feu.json'), 'utf8')
  )
  if (!parsed.ok) throw new Error(parsed.message)
  return buildLabStart(parsed.lab.start)
}
