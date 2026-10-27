/**
 * Onglet Audit : score de sécurité du lab (sur 100) et recommandations classées par gravité,
 * avec les objets concernés et la correction suggérée. L'analyse suit l'état du lab en direct ;
 * comparaison avec l'état au chargement (départ du lab) et export du rapport en PDF. Section
 * Détection : alertes de corrélation des journaux Sécurité du lab.
 */
import { useMemo } from 'react'
import { FileDown, Radar, ShieldAlert, ShieldCheck } from 'lucide-react'
import {
  AUDIT_REFERENCES,
  auditLab,
  compareAudits,
  detectAlerts,
  referenceLabel,
  type AuditSeverity
} from '@engine/index'
import { exportAuditReport } from '../../lib/auditReport'
import { useLabStore } from '../../store/lab'
import { Button } from '../common/ui'
import { t } from '../../lib/i18n'

const SEVERITY_CLASS: Record<AuditSeverity, string> = {
  critique: 'bg-danger text-on-danger',
  élevée: 'bg-danger-soft text-danger-text',
  moyenne: 'bg-warn-soft text-warn-text',
  faible: 'bg-info-soft text-info-text'
}

const scoreClass = (score: number) => (score >= 80 ? 'text-ok-text' : score >= 50 ? 'text-warn-text' : 'text-danger-text')

export function AuditPanel() {
  const lab = useLabStore((s) => s.lab)
  const loadedLab = useLabStore((s) => s.loadedLab)
  const report = useMemo(() => auditLab(lab), [lab])
  const alerts = useMemo(() => detectAlerts(lab), [lab])
  const baseline = useMemo(() => auditLab(loadedLab), [loadedLab])
  const corrected = useMemo(
    () => compareAudits(baseline, report).filter((c) => c.corrected).length,
    [baseline, report]
  )
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="audit-panel">
      <div className="flex items-center gap-3 border-b border-line px-4 py-3">
        {report.recommendations.length === 0 ? (
          <ShieldCheck size={28} className="text-ok-text" />
        ) : (
          <ShieldAlert size={28} className={scoreClass(report.score)} />
        )}
        <div>
          <div className="text-meta font-semibold tracking-wider text-fg-subtle uppercase">
            {t('audit.scoreDeSecurite')}
          </div>
          <div className={`text-2xl font-semibold ${scoreClass(report.score)}`} data-testid="audit-score">
            {report.score}
            <span className="text-ui text-fg-subtle"> / 100</span>
          </div>
          <div className="text-meta text-fg-muted" data-testid="audit-baseline">
            Au chargement : {baseline.score} / 100 · {corrected} recommandation(s) corrigée(s)
          </div>
        </div>
        <Button
          onClick={() => void exportAuditReport()}
          className="ml-auto"
          title={t('audit.exporterLeRapportDaudit')}
          data-testid="audit-export"
        >
          <FileDown size={14} /> PDF
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {report.recommendations.length === 0 ? (
          <p className="text-xs text-fg-muted">{t('audit.aucuneRecommandationToutesLes')}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {report.recommendations.map((r) => (
              <li
                key={r.rule}
                className="rounded-md border border-line bg-surface p-3"
                data-testid={`audit-${r.rule}`}
              >
                <div className="mb-1 flex items-center gap-2">
                  <span
                    className={`rounded-sm px-1.5 py-0.5 text-meta font-semibold ${SEVERITY_CLASS[r.severity]}`}
                  >
                    {r.severity}
                  </span>
                  <span className="text-xs font-semibold text-fg">{r.title}</span>
                </div>
                <ul className="mb-2 flex flex-col gap-0.5">
                  {r.findings.map((f) => (
                    <li key={f.object} className="text-meta text-fg-muted">
                      <span className="font-mono text-fg">{f.object}</span> — {f.detail}
                    </li>
                  ))}
                </ul>
                <p className="text-meta text-fg-muted">
                  <span className="font-semibold text-fg">{t('audit.correction')} </span>
                  {r.fix}
                </p>
                {r.refs.length > 0 && (
                  <p className="mt-1 flex flex-wrap items-center gap-1 text-meta text-fg-muted">
                    <span className="font-semibold text-fg">{t('audit.references')}</span>
                    {r.refs.map((key) => {
                      const ref = AUDIT_REFERENCES[key]
                      return (
                        <span
                          key={key}
                          className="rounded-sm border border-line px-1 font-mono"
                          title={`${ref.title}${ref.verified ? '' : ` (${t('audit.unverified')})`}`}
                          data-testid={`audit-ref-${key}`}
                        >
                          {referenceLabel(ref)}
                          {ref.verified ? '' : '*'}
                        </span>
                      )
                    })}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
        <section className="mt-4 border-t border-line pt-3" data-testid="detection-panel">
          <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-fg">
            <Radar size={14} className="text-accent" /> {t('detection.title')}
          </h3>
          {alerts.length === 0 ? (
            <p className="text-xs text-fg-muted">{t('detection.none')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {alerts.map((a) => (
                <li
                  key={`${a.rule}-${a.events[a.events.length - 1]?.id ?? 0}`}
                  className="rounded-md border border-line bg-surface p-2"
                  data-testid={`detection-${a.rule}`}
                >
                  <div className="text-xs font-semibold text-warn-text">{t(`detection.rule.${a.rule}`)}</div>
                  <p className="text-meta text-fg-muted">{a.detail}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
        <p className="mt-4 text-meta text-fg-subtle">
          {report.passed.length} règle(s) respectée(s). Chaque règle enfreinte retire des points selon sa
          gravité (critique 25, élevée 15, moyenne 10, faible 5).
        </p>
      </div>
    </div>
  )
}
