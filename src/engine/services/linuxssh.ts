/**
 * Clés SSH simulées (v2.9, #237) : paire de clés d'un utilisateur (`ssh-keygen`), clé d'hôte d'un
 * serveur, empreinte SHA256 et « randomart ». Le FORMAT est celui d'OpenSSH (lignes `ssh-ed25519 AAAA…`,
 * empreinte `SHA256:…`, dessin de `sshkey.c`) ; le contenu est DÉRIVÉ de l'état du lab, sans aucune
 * cryptographie : une clé ne protège rien, elle sert à vérifier qu'elle est bien dans `authorized_keys`.
 * Aucun nombre aléatoire : la même graine donne la même clé (moteur déterministe).
 */
import type { Draft } from 'immer'
import { transact, type EngineResult } from '../core/result'
import type { HostDevice, LabState } from '../model/schema'

// --- Outils d'encodage ------------------------------------------------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Base64 standard (avec ou sans `=` de bourrage). */
export function base64(bytes: number[], pad = true): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64[(n >> 18) & 63] as string
    out += B64[(n >> 12) & 63] as string
    out += i + 1 < bytes.length ? (B64[(n >> 6) & 63] as string) : pad ? '=' : ''
    out += i + 2 < bytes.length ? (B64[n & 63] as string) : pad ? '=' : ''
  }
  return out
}

/** Décodage Base64 (octets) ; null si le texte n'en est pas. */
export function fromBase64(text: string): number[] | null {
  const clean = text.replace(/=+$/, '')
  if (!/^[A-Za-z0-9+/]*$/.test(clean)) return null
  const out: number[] = []
  let bits = 0
  let acc = 0
  for (const ch of clean) {
    acc = (acc << 6) | B64.indexOf(ch)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((acc >> bits) & 255)
    }
  }
  return out
}

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2
]

/** SHA-256 (FIPS 180-4) : sert à afficher l'empreinte d'une clé, pas à protéger quoi que ce soit. */
export function sha256(data: number[]): number[] {
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const bytes = [...data, 0x80]
  while (bytes.length % 64 !== 56) bytes.push(0)
  const bitLen = data.length * 8
  for (let i = 7; i >= 0; i--) bytes.push(i >= 4 ? 0 : (bitLen >>> (i * 8)) & 255)
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))
  for (let off = 0; off < bytes.length; off += 64) {
    const w: number[] = []
    for (let i = 0; i < 16; i++)
      w[i] =
        (((bytes[off + i * 4] as number) << 24) |
          ((bytes[off + i * 4 + 1] as number) << 16) |
          ((bytes[off + i * 4 + 2] as number) << 8) |
          (bytes[off + i * 4 + 3] as number)) >>>
        0
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15] as number
      const b = w[i - 2] as number
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10)
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, hh] = h as [number, number, number, number, number, number, number, number]
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + S1 + ch + (K[i] as number) + (w[i] as number)) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    ;[a, b, c, d, e, f, g, hh].forEach((v, i) => (h[i] = ((h[i] as number) + v) >>> 0))
  }
  return h.flatMap((v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255])
}

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0) & 255)
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]

/** `n` octets dérivés d'une graine (SHA-256 en chaîne) : mêmes entrées, mêmes octets. */
export function derivedBytes(seed: string, n: number): number[] {
  const out: number[] = []
  let block = sha256(ascii(seed))
  while (out.length < n) {
    out.push(...block)
    block = sha256([...block, ...ascii(seed)])
  }
  return out.slice(0, n)
}

// --- Clés ---------------------------------------------------------------------------------------------

export type KeyType = 'rsa' | 'ed25519'

export interface SimKey {
  type: KeyType
  bits: number
  /** Nom du type dans les fichiers : `ssh-rsa`, `ssh-ed25519`. */
  name: string
  /** Partie Base64 de la ligne publique. */
  blob: string
}

/** Clé publique de graine donnée (RSA : module dérivé de `bits` bits ; ED25519 : 32 octets). */
export function makeKey(seed: string, type: KeyType, bits = type === 'rsa' ? 3072 : 256): SimKey {
  const name = type === 'rsa' ? 'ssh-rsa' : 'ssh-ed25519'
  const wire = [...u32(name.length), ...ascii(name)]
  if (type === 'ed25519') wire.push(...u32(32), ...derivedBytes(seed, 32))
  else {
    const modulus = derivedBytes(seed, bits / 8)
    modulus[0] = (modulus[0] as number) | 0x80 // bit de poids fort à 1, donc un octet 0 devant (mpint)
    wire.push(...u32(3), 1, 0, 1, ...u32(modulus.length + 1), 0, ...modulus)
  }
  return { type, bits: type === 'rsa' ? bits : 256, name, blob: base64(wire) }
}

/** Ligne d'un fichier .pub ou authorized_keys. */
export const publicLine = (key: SimKey, comment: string) => `${key.name} ${key.blob} ${comment}`

/** Clé lue dans une ligne publique (type, blob et taille déduite) ; null si la ligne n'en est pas une. */
export function parsePublicLine(line: string): SimKey | null {
  const [name, blob] = line.trim().split(/\s+/)
  if ((name !== 'ssh-rsa' && name !== 'ssh-ed25519') || !blob) return null
  const bytes = fromBase64(blob)
  if (!bytes) return null
  if (name === 'ssh-ed25519') return { type: 'ed25519', bits: 256, name, blob }
  // ssh-rsa : 4 + 7 (type) + 4 + 3 (exposant) + 4 + module (avec l'octet 0 de tête)
  const modulusLength = bytes.length - (4 + 7 + 4 + 3 + 4) - 1
  return { type: 'rsa', bits: modulusLength * 8, name, blob }
}

/** Empreinte `SHA256:…` (Base64 sans bourrage) du blob d'une clé. */
export const fingerprintBytes = (key: SimKey) => sha256(fromBase64(key.blob) ?? [])
export const fingerprint = (key: SimKey) => `SHA256:${base64(fingerprintBytes(key), false)}`

/** Dessin « randomart » de `sshkey.c` (fingerprint_randomart), empreinte SHA256. */
export function randomart(key: SimKey): string[] {
  const X = 17
  const Y = 9
  const chars = ' .o+=*BOX@%&#/^SE'
  const len = chars.length - 1
  const field = Array.from({ length: X }, () => new Array<number>(Y).fill(0))
  let x = Math.floor(X / 2)
  let y = Math.floor(Y / 2)
  for (const byte of fingerprintBytes(key)) {
    let input = byte
    for (let b = 0; b < 4; b++) {
      x += input & 1 ? 1 : -1
      y += input & 2 ? 1 : -1
      x = Math.min(Math.max(x, 0), X - 1)
      y = Math.min(Math.max(y, 0), Y - 1)
      if ((field[x] as number[])[y]! < len - 2) (field[x] as number[])[y]!++
      input >>= 2
    }
  }
  ;(field[Math.floor(X / 2)] as number[])[Math.floor(Y / 2)] = len - 1
  ;(field[x] as number[])[y] = len
  const border = (label: string) => {
    const left = Math.floor((X - label.length) / 2)
    return `+${'-'.repeat(left)}${label}${'-'.repeat(X - left - label.length)}+`
  }
  const title = `[${key.type === 'rsa' ? 'RSA' : 'ED25519'} ${key.bits}]`
  const rows: string[] = []
  for (let r = 0; r < Y; r++) {
    let row = '|'
    for (let c = 0; c < X; c++) row += chars[Math.min((field[c] as number[])[r] as number, len)] as string
    rows.push(`${row}|`)
  }
  return [border(title), ...rows, border('[SHA256]')]
}

/** Clé d'hôte ED25519 d'un serveur, dérivée de l'identifiant de l'ordinateur. */
export const hostKeyOf = (deviceId: string): SimKey => makeKey(`hostkey:${deviceId}`, 'ed25519')

/**
 * Corps (Base64) des fichiers de clé privée de ServerLab : texte constant qui dit en clair que la clé
 * est simulée (« ServerLab simulated private key - not a real key »).
 */
export const PRIVATE_KEY_BODY = base64(ascii('ServerLab simulated private key - not a real key'))

// --- Serveurs connus ------------------------------------------------------------------------------------

/** Enregistre la clé d'un serveur (nom ou adresse tapés) comme acceptée par cet ordinateur. */
export function addKnownHost(state: LabState, deviceId: string, name: string): EngineResult<void> {
  return transact(state, (draft) => {
    const d = draft.devices[deviceId] as Draft<HostDevice> | undefined
    if (!d || (d.kind !== 'server' && d.kind !== 'client')) return
    const known = d.host.linux?.knownHosts ?? []
    if (known.includes(name)) return
    d.host.linux = {
      ...d.host.linux,
      distro: d.host.linux?.distro ?? 'debian12',
      knownHosts: [...known, name]
    }
  })
}
