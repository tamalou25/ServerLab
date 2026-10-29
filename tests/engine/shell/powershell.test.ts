import { describe, expect, it } from 'vitest'
import { complete, createShellSession, effectiveIpv4 } from '@engine/index'
import { build, cable, setIp } from '../helpers'
import { run } from './helpers'

function lab() {
  const { state, ids } = build([
    ['server', 'SRV1'],
    ['client', 'PC1'],
    ['switch', 'SW1']
  ])
  let s = cable(state, ids.SRV1!, 0, ids.SW1!, 0)
  s = cable(s, ids.PC1!, 0, ids.SW1!, 1)
  return { s, ids }
}

describe('PowerShell : erreurs réalistes', () => {
  it('applet de commande réelle non simulée : signalée comme telle (audit F-01)', () => {
    const { s, ids } = lab()
    const r = run(s, ids.SRV1!, 'Get-Process lsass')
    expect(r.errors).toContain(
      '« Get-Process » est une commande réelle qui n’est pas simulée dans ServerLab.'
    )
    expect(r.errors).toContain('CommandNotSimulated')
    expect(r.errors).not.toContain("n'est pas reconnu")
  })

  it('commande inconnue', () => {
    const { s, ids } = lab()
    const r = run(s, ids.SRV1!, 'Get-Truc')
    expect(r.errors).toContain(
      "Get-Truc : Le terme «Get-Truc» n'est pas reconnu comme nom d'applet de commande"
    )
    expect(r.errors).toContain('Au caractère Ligne:1 : 1')
    expect(r.errors).toContain('+ ~~~~~~~~')
    expect(r.errors).toContain('FullyQualifiedErrorId : CommandNotFoundException')
  })

  it('paramètre introuvable, ambigu, argument manquant', () => {
    const { s, ids } = lab()
    expect(run(s, ids.SRV1!, 'Get-NetAdapter -Nme x').errors).toContain(
      'Impossible de trouver un paramètre correspondant au nom « Nme ».'
    )
    expect(run(s, ids.SRV1!, 'New-NetIPAddress -Interface Ethernet0 -IPAddress 10.0.0.1').errors).toContain(
      'est ambigu'
    )
    expect(run(s, ids.SRV1!, 'New-NetIPAddress -IPAddress').errors).toContain(
      'Argument manquant pour le paramètre « IPAddress »'
    )
  })

  it('conversion de type et ValidateSet', () => {
    const { s, ids } = lab()
    expect(
      run(s, ids.SRV1!, 'New-NetIPAddress -InterfaceAlias Ethernet0 -IPAddress 10.0.0.1 -PrefixLength abc')
        .errors
    ).toContain('Impossible de convertir la valeur « abc » en type « System.Int32 »')
    expect(run(s, ids.SRV1!, 'Get-NetIPAddress -AddressFamily IPv5').errors).toContain(
      'n’appartient pas au jeu « IPv4,IPv6 »'
    )
  })

  it('erreur de syntaxe', () => {
    const { s, ids } = lab()
    expect(run(s, ids.SRV1!, 'Write-Host "bonjour').errors).toContain(
      'Le terminateur " est manquant dans la chaîne.'
    )
  })

  it('-in, -notin, -contains, -notcontains avec une liste séparée par des virgules', () => {
    const { s, ids } = lab()
    const where = (filter: string) => {
      const r = run(s, ids.SRV1!, `Get-NetAdapter | Where-Object { ${filter} } | Select-Object Name`)
      expect(r.errors).toBe('')
      return r.text.includes('Ethernet0')
    }
    expect(where("$_.Name -in 'Ethernet0','Ethernet1'")).toBe(true)
    expect(where("$_.Name -in 'Ethernet1','Ethernet2'")).toBe(false)
    expect(where("$_.Name -notin 'Ethernet1','Ethernet2'")).toBe(true)
    expect(where("$_.Name -notin 'ethernet0','Ethernet2'")).toBe(false)
    expect(where("'Wi-Fi','Ethernet0' -contains $_.Name")).toBe(true)
    expect(where("'Wi-Fi','Ethernet9' -notcontains $_.Name -and $_.Name -like 'Eth*'")).toBe(true)
  })

  it('-Name de Get-Command et Get-WindowsFeature : jokers * et ?, autres caractères littéraux', () => {
    const { s, ids } = lab()
    const cmd = (line: string) => run(s, ids.SRV1!, line)
    expect(cmd('Get-Command -Name Get-NetAdapte?').text).toContain('Get-NetAdapter')
    expect(cmd("Get-Command -Name 'Get-Net('").errors).toContain("n'est pas reconnu")
    expect(cmd('Get-WindowsFeature -Name DH?P').text).toContain('DHCP')
    expect(cmd("Get-WindowsFeature -Name 'D.CP'").text).not.toContain('DHCP')
    expect(cmd("Get-WindowsFeature -Name 'DHCP('").text.trim()).toBe('')
  })

  it('expression régulière invalide (-match, -notmatch) : erreur PowerShell, pas de plantage', () => {
    const { s, ids } = lab()
    for (const op of ['-match', '-notmatch']) {
      const r = run(s, ids.SRV1!, `Get-NetAdapter | Where-Object { $_.Name ${op} '(' }`)
      expect(r.errors).toContain('Le modèle d’expression régulière ( n’est pas valide.')
      expect(r.errors).toContain('FullyQualifiedErrorId : InvalidRegularExpression')
      expect(r.state).toBe(s)
    }
    // Une expression valide fonctionne toujours
    expect(run(s, ids.SRV1!, "Get-NetAdapter | Where-Object { $_.Name -match '^eth' }").text).toContain(
      'Ethernet0'
    )
  })

  it('demande les paramètres obligatoires manquants', () => {
    const { s, ids } = lab()
    const r = run(s, ids.SRV1!, 'Rename-Computer', { answers: ['SRV-AD'] })
    expect(r.prompts).toEqual(['NewName: '])
    expect(r.text).toContain('Fournissez des valeurs pour les paramètres suivants :')
    const srv = r.state.devices[ids.SRV1!]
    expect(srv?.kind === 'server' && srv.host.pendingName).toBe('SRV-AD')
  })
})

describe('PowerShell : configuration réseau (même état que l’interface)', () => {
  it('New-NetIPAddress + Set-DnsClientServerAddress', () => {
    const { s, ids } = lab()
    let r = run(
      s,
      ids.SRV1!,
      'New-NetIPAddress -InterfaceAlias "Ethernet0" -IPAddress 192.168.1.1 -PrefixLength 24 -DefaultGateway 192.168.1.254'
    )
    expect(r.errors).toBe('')
    expect(r.text).toContain('PrefixOrigin      : Manual')
    r = run(
      r.state,
      ids.SRV1!,
      'Set-DnsClientServerAddress -InterfaceAlias Ethernet0 -ServerAddresses 127.0.0.1,8.8.8.8'
    )
    const iface = r.state.devices[ids.SRV1!]!.interfaces[0]!
    expect(effectiveIpv4(iface)).toMatchObject({
      address: '192.168.1.1',
      prefixLength: 24,
      gateway: '192.168.1.254',
      dnsServers: ['127.0.0.1', '8.8.8.8']
    })
    // Deuxième passerelle : erreur classique
    const again = run(
      r.state,
      ids.SRV1!,
      'New-NetIPAddress -InterfaceAlias Ethernet0 -IPAddress 192.168.1.1 -PrefixLength 24'
    )
    expect(again.errors).toContain('L’objet existe déjà.')
  })

  it('Remove-NetIPAddress demande confirmation', () => {
    const { s, ids } = lab()
    const base = setIp(s, ids.SRV1!, 0, '192.168.1.1/24')
    const refused = run(base, ids.SRV1!, 'Remove-NetIPAddress -IPAddress 192.168.1.1', { answers: ['n'] })
    expect(refused.state.devices[ids.SRV1!]!.interfaces[0]!.address).toBe('192.168.1.1')
    const removed = run(base, ids.SRV1!, 'Remove-NetIPAddress -IPAddress 192.168.1.1 -Confirm:$false')
    expect(removed.state.devices[ids.SRV1!]!.interfaces[0]!.address).toBeNull()
  })

  it('pipeline : Where-Object, Select-Object, Format-Table, variables', () => {
    const { s, ids } = lab()
    const base = setIp(s, ids.SRV1!, 0, '192.168.1.1/24')
    const r = run(
      base,
      ids.SRV1!,
      'Get-NetIPAddress | Where-Object { $_.InterfaceAlias -like "Eth*" } | Select-Object IPAddress,PrefixLength'
    )
    expect(r.text).toContain('192.168.1.1')
    expect(r.text).not.toContain('127.0.0.1')
    const v = run(base, ids.SRV1!, '$ip = "10.0.0.5"', {
      session: createShellSession(base, ids.SRV1!, 'powershell')
    })
    const w = run(base, ids.SRV1!, 'Write-Host "IP : $ip"', { session: v.session })
    expect(w.text).toBe('IP : 10.0.0.5')
  })

  it('ConvertTo-SecureString exige -AsPlainText -Force', () => {
    const { s, ids } = lab()
    expect(run(s, ids.SRV1!, '$p = ConvertTo-SecureString "P@ssw0rd" -AsPlainText').errors).toContain('Force')
    expect(run(s, ids.SRV1!, '$p = ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force').errors).toBe('')
  })

  it('les commandes serveur n’existent pas sur un poste client', () => {
    const { s, ids } = lab()
    expect(run(s, ids.PC1!, 'Install-WindowsFeature DHCP').errors).toContain("n'est pas reconnu")
  })
})

describe('Rôles et fonctionnalités', () => {
  it('Install-WindowsFeature avec dépendances et outils', () => {
    const { s, ids } = lab()
    const r = run(s, ids.SRV1!, 'Install-WindowsFeature AD-Domain-Services -IncludeManagementTools')
    expect(r.text).toContain('Success')
    const srv = r.state.devices[ids.SRV1!]
    expect(srv?.kind === 'server' && srv.host.features).toEqual(
      expect.arrayContaining(['AD-Domain-Services', 'GPMC', 'RSAT-AD-PowerShell', 'RSAT-ADDS'])
    )
    const list = run(r.state, ids.SRV1!, 'Get-WindowsFeature AD-Domain-Services')
    expect(list.text).toMatch(/\[X\] Services AD DS\s+AD-Domain-Services\s+Installed/)
    expect(run(s, ids.SRV1!, 'Install-WindowsFeature Truc').errors).toContain('est introuvable')
  })
})

describe('Get-WindowsFeature émet des objets', () => {
  // Source : https://learn.microsoft.com/en-us/powershell/module/servermanager/get-windowsfeature (exemple 4 : `| Where Installed`)
  it('Where Installed et Where-Object {$_.Installed -eq $true} listent seulement les rôles installés', () => {
    const { s, ids } = lab()
    const r = run(s, ids.SRV1!, 'Install-WindowsFeature DHCP')
    const names = (line: string) =>
      run(r.state, ids.SRV1!, line)
        .text.split('\n')
        .filter((l) => /^\s*\[[ X]\]/.test(l))
    for (const line of [
      'Get-WindowsFeature | Where Installed',
      'Get-WindowsFeature | Where-Object Installed',
      'Get-WindowsFeature | Where-Object {$_.Installed -eq $true}'
    ]) {
      const rows = names(line)
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every((l) => l.includes('[X]') && l.includes('Installed'))).toBe(true)
      expect(rows.some((l) => /\bDHCP\b/.test(l))).toBe(true)
    }
    expect(names('Get-WindowsFeature').some((l) => l.includes('[ ]'))).toBe(true)
    expect(run(r.state, ids.SRV1!, '(Get-WindowsFeature DHCP).InstallState').text.trim()).toBe('Installed')
  })

  it('sortie par défaut inchangée (colonnes Display Name, Name, Install State)', () => {
    const { s, ids } = lab()
    const out = run(s, ids.SRV1!, 'Get-WindowsFeature DHCP').text
    expect(out).toMatch(/Display Name\s+Name\s+Install State/)
    expect(out).toMatch(/\[ \] .*DHCP\s+Available/)
  })
})

describe('Complétion Tab', () => {
  it('complète commandes, paramètres et valeurs', () => {
    const { s, ids } = lab()
    const session = createShellSession(s, ids.SRV1!, 'powershell')
    expect(complete(s, session, 'Get-NetIPA', 10).candidates).toEqual(['Get-NetIPAddress'])
    expect(complete(s, session, 'New-NetIPAddress -Pre', 21).candidates).toEqual(['-PrefixLength'])
    expect(complete(s, session, 'Install-WindowsFeature -Name DH', 31).candidates).toEqual(['DHCP'])
    expect(complete(s, session, 'Get-NetIPAddress -InterfaceAlias Eth', 36).candidates).toEqual(['Ethernet0'])
    const cmd = createShellSession(s, ids.SRV1!, 'cmd')
    expect(complete(s, cmd, 'ipconfig /re', 12).candidates).toEqual(['/registerdns', '/release', '/renew'])
  })
})
