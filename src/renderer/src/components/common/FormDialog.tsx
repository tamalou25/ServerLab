/**
 * Boîte de dialogue de saisie générique (assistants simplifiés des consoles).
 */
import { useState } from 'react'
import { Button, inputClass } from './ui'

export type FormField =
  | { key: string; label: string; type?: 'text' | 'password'; placeholder?: string; initial?: string }
  | { key: string; label: string; type: 'checkbox'; initial?: boolean }
  | {
      key: string
      label: string
      type: 'select'
      options: { value: string; label: string }[]
      initial?: string
    }

export type FormValues = Record<string, string | boolean>

interface FormDialogProps {
  title: string
  description?: string
  fields: FormField[]
  submitLabel?: string
  /** Renvoie vrai si la saisie est acceptée (la boîte se ferme). */
  onSubmit: (values: FormValues) => boolean
  onClose: () => void
  testId?: string
}

export function FormDialog({
  title,
  description,
  fields,
  submitLabel = 'OK',
  onSubmit,
  onClose,
  testId
}: FormDialogProps) {
  const [values, setValues] = useState<FormValues>(() =>
    Object.fromEntries(
      fields.map((f) => [
        f.key,
        f.type === 'checkbox'
          ? (f.initial ?? false)
          : (f.initial ?? (f.type === 'select' ? (f.options[0]?.value ?? '') : ''))
      ])
    )
  )
  const submit = () => {
    if (onSubmit(values)) onClose()
  }
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-scrim">
      <div
        className="w-[440px] rounded-md border border-line bg-overlay p-5 text-fg shadow-lg"
        data-testid={testId}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
          if (e.key === 'Escape') onClose()
        }}
      >
        <h3 className="mb-1 text-title font-semibold">{title}</h3>
        {description && <p className="mb-3 text-xs text-fg-muted">{description}</p>}
        <div className="flex flex-col gap-2">
          {fields.map((f) =>
            f.type === 'checkbox' ? (
              <label key={f.key} className="flex items-center gap-2 text-ui">
                <input
                  type="checkbox"
                  checked={values[f.key] === true}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.checked })}
                  data-testid={`field-${f.key}`}
                />
                {f.label}
              </label>
            ) : f.type === 'select' ? (
              <label key={f.key} className="flex flex-col gap-1 text-xs text-fg-muted">
                {f.label}
                <select
                  className={inputClass}
                  value={String(values[f.key])}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                  data-testid={`field-${f.key}`}
                >
                  {f.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label key={f.key} className="flex flex-col gap-1 text-xs text-fg-muted">
                {f.label}
                <input
                  className={inputClass}
                  type={f.type ?? 'text'}
                  placeholder={f.placeholder}
                  value={String(values[f.key] ?? '')}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                  data-testid={`field-${f.key}`}
                />
              </label>
            )
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onClose}>Annuler</Button>
          <Button variant="primary" onClick={submit} data-testid="form-submit">
            {submitLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
