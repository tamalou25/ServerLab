/**
 * Noms des paramètres de smb.conf connus de Samba 4.17.12 (Debian bookworm), sans espaces ni casse :
 * un fichier `docs-xml/smbdotconf/<catégorie>/<nom>.xml` par paramètre dans les sources du paquet
 * (https://sources.debian.org/src/samba/2:4.17.12+dfsg-0+deb12u4/docs-xml/smbdotconf/), relevés le
 * 2026-10-20. Servent à distinguer un paramètre inconnu (« Unknown parameter encountered ») d'un
 * paramètre valide mais non modélisé par ServerLab (docs/fidelite.md, L-84).
 */
export const KNOWN_PARAMETERS: ReadonlySet<string> = new Set(
  (
    'abortshutdownscript accessbasedshareenum aclallowexecutealways aclcheckpermissions ' +
    'aclflaginheritedcanonicalization aclgroupcontrol aclmapfullcontrol addgroupscript ' +
    'additionaldnshostnames addmachinescript addportcommand addprintercommand addsharecommand ' +
    'adduserscript addusertogroupscript administrative_share adminusers afsshare afstokenlifetime ' +
    'afsusernamemap aiomaxthreads aioreadsize aiowritebehind aiowritesize algorithmicridbase ' +
    'allocationroundupsize allowdcerpcauthlevelconnect allowdnsupdates allowinsecurewidelinks ' +
    'allownt4crypto allowtrusteddomains allowunsafeclusterupgrade applygrouppolicies asyncdnstimeout ' +
    'asyncsmbechohandler autheventnotification auto_services available binddnsdir bindinterfacesonly ' +
    'blockinglocks blocksize browseable browselist cachedirectory casesensitive changenotify ' +
    'changesharecommand checkparentdirectorydeleteonclose checkpasswordscript cldapport ' +
    'clientipcmaxprotocol clientipcminprotocol clientipcsigning clientlanmanauth ' +
    'clientldapsaslwrapping clientmaxprotocol clientminprotocol clientntlmv2auth clientplaintextauth ' +
    'clientprotection clientschannel clientsigning clientsmbencrypt clientsmbencryptionalgos ' +
    'clientsmbsigningalgos clientusekerberos clientusepsnegoprincipal clientusespnego ' +
    'clusteraddresses clustering comment configbackend configfile copy createkrb5conf createmask ' +
    'cscpolicy ctdbdsocket ctdblocktimewarnthreshold ctdbtimeout cupsconnectiontimeout cupsencrypt ' +
    'cupsoptions cupsserver dcerpcendpointservers deadtime debugclass debugencryption ' +
    'debughirestimestamp debugpid debugprefixtimestamp debugsyslogformat debugtraceid debuguid ' +
    'dedicatedkeytabfile defaultcase defaultdevmode defaultservice defersharingviolations ' +
    'deletegroupscript deleteprintercommand deletereadonly deletesharecommand ' +
    'deleteuserfromgroupscript deleteuserscript deletevetofiles dfreecachetime dfreecommand dgramport ' +
    'directorymask directorynamecachesize directorysecuritymask disablenetbios disablespoolss ' +
    'dmapisupport dnsforwarder dnsport dnsproxy dnsupdatecommand dnszonescavenging ' +
    'dnszonetransferclientsallow dnszonetransferclientsdeny domainlogons domainmaster dontdescend ' +
    'doscharset dosfilemode dosfiletimeresolution dosfiletimes dsdbeventnotification ' +
    'dsdbgroupchangenotification dsdbpasswordeventnotification durablehandles easupport ' +
    'elasticsearchaddress elasticsearchignoreunknownattribute elasticsearchignoreunknowntype ' +
    'elasticsearchindex elasticsearchmappings elasticsearchmaxresults elasticsearchport ' +
    'elasticsearchusetls enableasusupport enablecorefiles enableprivileges enablespoolss ' +
    'encryptpasswords enhancedbrowsing enumportscommand eventloglist fakedirectorycreatetimes ' +
    'fakeoplocks followsymlinks force_process_locks forcecreatemode forcedirectorymode ' +
    'forcedirectorysecuritymode forcegroup forceprintername forcesecuritymode forceunknownacluser ' +
    'forceuser fssprunestale fsssequencetimeout fstype getquotacommand getwdcache gpoupdatecommand ' +
    'guestaccount guestok guestonly hidedotfiles hidefiles hidenewfilestimeout hidespecialfiles ' +
    'hideunreadable hideunwriteablefiles honorchangenotifyprivilege hostmsdfs hostnamelookups ' +
    'hostsallow hostsdeny idmapbackend idmapcachetime idmapconfig idmapgid idmapnegativecachetime ' +
    'idmapuid include includesystemkrb5conf inheritacls inheritowner inheritpermissions ' +
    'initlogondelay initlogondelayedhosts interfaces invalidusers iprintserver ' +
    'kdcdefaultdomainsupportedenctypes kdcenablefast kdcforceenablerc4weaksessionkeys ' +
    'kdcsupportedenctypes keepalive kerberosencryptiontypes kerberosmethod kernelchangenotify ' +
    'kerneloplocks kernelsharemodes kpasswdport krb5port lanmanauth largereadwrite ldapadmindn ' +
    'ldapconnectiontimeout ldapdebuglevel ldapdebugthreshold ldapdeletedn ldapderef ' +
    'ldapfollowreferral ldapgroupsuffix ldapidmapsuffix ldapmachinesuffix ldapmaxanonrequest ' +
    'ldapmaxauthrequest ldapmaxsearchrequest ldappagesize ldappasswdsync ldapreplicationsleep ' +
    'ldapsameditposix ldapsamtrusted ldapserverrequirestrongauth ldapssl ldapsuffix ldaptimeout ' +
    'ldapusersuffix level2oplocks lmannounce lminterval loadprinters localmaster lockdirectory ' +
    'locking lockspintime logfile logging loglevel lognttokencommand logondrive logonhome logonpath ' +
    'logonscript logwriteablefilesonexit lppausecommand lpqcachetime lpqcommand lpresumecommand ' +
    'lprmcommand lsaovernetlogon machinepasswordtimeout magicoutput magicscript manglednames ' +
    'mangleprefix manglingchar manglingmethod mapaclinherit maparchive maphidden mapreadonly ' +
    'mapsystem maptoguest maxconnections maxdisksize maxlogsize maxmux maxopenfiles maxprintjobs ' +
    'maxreportedprintjobs maxsmbdprocesses maxstatcachesize maxttl maxwinsttl maxxmit mdnsname ' +
    'messagecommand mindomainuid minprintspace minreceivefilesize minwinsttl mitkdccommand msdfsproxy ' +
    'msdfsroot msdfsshufflereferrals multicastdnsregister namecachetimeout nameresolveorder ' +
    'nbtclientsocketaddress nbtd-wins_prepend1bto1cqueries nbtd-wins_randomize1clist ' +
    'nbtd-wins_randomize1clist_mask nbtport ncalrpcdir netbiosaliases netbiosname netbiosscope ' +
    'netutralizent4emulation nmbdbindexplicitbroadcast nsupdatecommand nt_hash_store ntaclsupport ' +
    'ntlmauth ntpipesupport ntpsigndsocketdirectory ntstatussupport ntvfshandler nullpasswords ' +
    'obeypamrestrictions oldpasswordallowedperiod oplockbreakwaittime oplocks os2drivermap oslevel ' +
    'pampasswordchange panicaction passdbbackend passdbexpandexplicit passwdchat passwdchatdebug ' +
    'passwdchattimeout passwdprogram passwordhashgpgkeyids passwordhashuserpasswordschemes ' +
    'passwordserver path perfcountmodule piddirectory posixlocking postexec preexec preexecclose ' +
    'preferredmaster preforkbackoffincrement preforkchildren preforkmaximumbackoff preloadmodules ' +
    'preservecase printable printcapcachetime printcapname printcommand printername printing ' +
    'printjobusername printnotifybackchannel privatedir queuepausecommand queueresumecommand ' +
    'rawntlmv2auth readlist readonly readraw realm registryshares rejectmd5clients rejectmd5servers ' +
    'remoteannounce remotebrowsesync renameuserscript requirestrongkey resetonzerovc ' +
    'restrictanonymous rootdirectory rootpostexec rootpreexec rootpreexecclose rpcbigendian ' +
    'rpcserverdynamicportrange rpcserverport rpcstartondemandhelpers sambakcccommand security ' +
    'securitymask servermaxprotocol serverminprotocol servermultichannelsupport serverrole ' +
    'serverschannel serverschannelrequireseal serverservices serversigning serversmbencrypt ' +
    'serversmbencryptionalgos serversmbsigningalgos serverstring setprimarygroupscript ' +
    'setquotacommand sharefakefscaps shortpreservecase showaddprinterwizard shutdownscript ' +
    'smb1unixextensions smb2_disable_lock_sequence_checking smb2_disable_oplock_break_retry ' +
    'smb2leases smb2maxcredits smb2maxread smb2maxtrans smb2maxwrite smbdasyncdosmode ' +
    'smbdgetinfoasksharemode smbdmaxasyncdosmode smbdmaxxattrsize smbdprofilinglevel ' +
    'smbdsearchasksharemode smbencrypt smbpasswdfile smbports socketoptions spnupdatecommand ' +
    'spoolssarchitecture spoolssosversion spotlight spotlight_backend statcache statedirectory ' +
    'storedosattributes strictallocate strictlocking strictrename strictsync svcctllist syncalways ' +
    'syslog syslogonly templatehomedir templateshell timeserver timestamplogs tlscafile tlscertfile ' +
    'tlscrlfile tlsdhparamsfile tlsenabled tlskeyfile tlspriority tlsverifypeer unicode unixcharset ' +
    'unixpasswordsync useclientdriver usemmap usernamelevel usernamemap usernamemapcachetime ' +
    'usernamemapscript usershareallowguests usersharemaxshares usershareowneronly usersharepath ' +
    'usershareprefixallowlist usershareprefixdenylist usersharetemplateshare usesendfile utmp ' +
    'utmpdirectory valid validusers vetofiles vetooplockfiles vfsobjects volume volumeserialnumber ' +
    'widelinks winbindcachetime winbinddsocketdirectory winbindenumgroups winbindenumusers ' +
    'winbindexpandgroups winbindignoredomains winbindmaxclients winbindmaxdomainconnections ' +
    'winbindnestedgroups winbindnormalizenames winbindnssinfo winbindofflinelogon ' +
    'winbindreconnectdelay winbindrefreshtickets winbindrequesttimeout winbindrpconly ' +
    'winbindscantrusteddomains winbindsealedpipes winbindseparator winbindusedefaultdomain ' +
    'winbindusekrb5enterpriseprincipals winsdb-localowner winsdb-nosync winshook winsproxy winsserver ' +
    'winssupport workgroup wreplsrv-periodic_interval wreplsrv-propagate_name_releases ' +
    'wreplsrv-scavenging_interval wreplsrv-tombstone_extra_timeout wreplsrv-tombstone_interval ' +
    'wreplsrv-tombstone_timeout wreplsrv-verify_interval writeable writelist writeraw wtmpdirectory'
  ).split(' ')
)
