/**
 * Aide > Signaler un bug : issue GitHub préremplie (environnement, étapes à compléter) et liste
 * blanche des adresses externes.
 */
import { describe, expect, it } from 'vitest'
import {
  BUG_REPORT_URL,
  bugReportBody,
  bugReportUrl,
  isAllowedExternalUrl,
  osName,
  type BugReportEnvironment
} from '../../src/shared/bugReport'

const env: BugReportEnvironment = {
  appVersion: '1.1.0',
  os: 'Windows',
  osRelease: '10.0.22631',
  arch: 'x64',
  electron: '44.0.0',
  chrome: '144.0.7559.60'
}

describe('rapport de bug prérempli', () => {
  it('adresse de création d’issue avec titre, étiquette et corps', () => {
    const url = new URL(bugReportUrl(env))
    expect(`${url.origin}${url.pathname}`).toBe(BUG_REPORT_URL)
    expect(url.searchParams.get('title')).toBe('[Bug] ')
    expect(url.searchParams.get('labels')).toBe('bug')
    expect(url.searchParams.get('body')).toBe(bugReportBody(env))
  })

  it('version, système et Electron ; étapes laissées à compléter', () => {
    const body = bugReportBody(env)
    expect(body).toContain('- ServerLab : 1.1.0')
    expect(body).toContain('- Système : Windows 10.0.22631 (x64)')
    expect(body).toContain('- Electron : 44.0.0 (Chromium 144.0.7559.60)')
    expect(body).toContain('## Étapes pour reproduire\n\n1. \n2. \n3. ')
  })

  it('caractères spéciaux encodés (aucune injection dans l’adresse)', () => {
    const url = bugReportUrl({ ...env, appVersion: '1.1.0&title=x#frag' })
    expect(isAllowedExternalUrl(url)).toBe(true)
    expect(new URL(url).searchParams.get('title')).toBe('[Bug] ')
    expect(new URL(url).searchParams.get('body')).toContain('ServerLab : 1.1.0&title=x#frag')
  })

  it('nom du système', () => {
    expect(osName('win32')).toBe('Windows')
    expect(osName('linux')).toBe('Linux')
    expect(osName('darwin')).toBe('macOS')
    expect(osName('freebsd')).toBe('freebsd')
  })
})

describe('liste blanche des adresses externes', () => {
  it('seule la création d’issue du dépôt est autorisée', () => {
    expect(isAllowedExternalUrl(BUG_REPORT_URL)).toBe(true)
    expect(isAllowedExternalUrl(bugReportUrl(env))).toBe(true)
  })

  it('tout le reste est refusé', () => {
    for (const url of [
      'http://github.com/tamalou25/ServerLab/issues/new',
      'https://github.com/tamalou25/ServerLab/issues',
      'https://github.com/tamalou25/ServerLab/issues/new/choose',
      'https://github.com/autre/depot/issues/new',
      'https://github.com.evil.example/tamalou25/ServerLab/issues/new',
      'https://evil.example/tamalou25/ServerLab/issues/new',
      'https://user:pass@github.com/tamalou25/ServerLab/issues/new',
      'https://github.com:8443/tamalou25/ServerLab/issues/new',
      'https://github.com/tamalou25/ServerLab/issues/new#x',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'pas une adresse',
      ''
    ]) {
      expect(isAllowedExternalUrl(url), url).toBe(false)
    }
  })
})
