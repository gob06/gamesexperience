import { useEffect, useState, type ChangeEvent, type CSSProperties, type DragEvent } from 'react'
import { ArrowLeft, Check, ImagePlus, Monitor, RotateCcw, Smartphone, Trash2, Upload } from 'lucide-react'
import { DEFAULT_THEME, useTheme, type ThemeConfig } from './theme'

type ThemeAsset = { id: string; mimeType: string; sizeBytes: number; width: number; height: number; uploadedAt: string }
type AuditEntry = { administrator: string; action: string; details: Record<string, string>; createdAt: string }
type ThemeResponse = { draft: ThemeConfig; published: ThemeConfig; draftAssets: ThemeAsset[]; maxUploadBytes: number; updatedAt: string | null; publishedAt: string | null }

const imageFields: Array<{ key: keyof ThemeConfig['assets']; label: string }> = [
  { key: 'logo', label: 'Event or sponsor logo' },
  { key: 'banner', label: 'Header banner or poster' },
  { key: 'background', label: 'Global background image' },
  { key: 'votingBackground', label: 'Voting page background' },
  { key: 'resultsBackground', label: 'Live results background' },
  { key: 'adminBackground', label: 'Admin and sign-in background' },
]

const colorFields: Array<{ key: keyof ThemeConfig['colors']; label: string }> = [
  { key: 'primary', label: 'Primary' },
  { key: 'secondary', label: 'Secondary' },
  { key: 'accent', label: 'Accent' },
  { key: 'background', label: 'Background' },
  { key: 'text', label: 'Text' },
]

function formatSize(size: number) {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  if (size >= 1024) return `${Math.ceil(size / 1024)} KB`
  return `${size} B`
}

export default function ThemeSettings({ onBack, scope = 'site' }: { onBack: () => void; scope?: 'site' | 'game' }) {
  const apiBase = scope === 'game' ? '/api/admin/game-theme' : '/api/admin/theme'
  const initialTheme = scope === 'game' ? { ...DEFAULT_THEME, eventTitle: 'Vanishing Tic-Tac-Toe' } : DEFAULT_THEME
  const gameImageLabels: Partial<Record<keyof ThemeConfig['assets'], string>> = {
    logo: 'Game logo',
    banner: 'Game banner',
    background: 'Game background',
    votingBackground: 'Alternate game background',
    resultsBackground: 'Second alternate background',
    adminBackground: 'Third alternate background',
  }
  const [draft, setDraft] = useState<ThemeConfig>(initialTheme)
  const [published, setPublished] = useState<ThemeConfig>(initialTheme)
  const [assets, setAssets] = useState<ThemeAsset[]>([])
  const [maxUploadBytes, setMaxUploadBytes] = useState(50 * 1024 * 1024)
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [previewMode, setPreviewMode] = useState<'desktop' | 'mobile'>('desktop')
  const { refreshTheme } = useTheme()

  async function loadSettings() {
    const [themeResponse, auditResponse] = await Promise.all([fetch(apiBase), fetch(`${apiBase}/audit`)])
    const themeResult = await themeResponse.json()
    if (!themeResponse.ok) throw new Error(themeResult.error || 'Could not load theme settings.')
    const auditResult = await auditResponse.json()
    if (!auditResponse.ok) throw new Error(auditResult.error || 'Could not load theme activity.')
    const data: ThemeResponse = themeResult
    setDraft(data.draft)
    setPublished(data.published)
    setAssets(data.draftAssets)
    setMaxUploadBytes(data.maxUploadBytes)
    setAudit(auditResult)
  }

  useEffect(() => {
    void loadSettings().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : 'Could not load theme settings.'))
  }, [])

  function updateDraft(update: (current: ThemeConfig) => ThemeConfig) {
    setDraft(update)
    setNotice('')
  }

  async function uploadAsset(key: keyof ThemeConfig['assets'], file: File) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Choose a JPG, PNG, or WebP image. SVG files are not supported.')
      if (file.size > maxUploadBytes) throw new Error(`Images must be ${formatSize(maxUploadBytes)} or smaller.`)
      const image = await createImageBitmap(file)
      const { width, height } = image
      image.close()
      if (width < 1 || height < 1 || width > 12000 || height > 12000 || width * height > 40000000) {
        throw new Error('Images must be no larger than 12,000 pixels per side or 40 megapixels.')
      }
      const data = new FormData()
      data.append('image', file)
      const response = await fetch('/api/admin/theme/assets', { method: 'POST', body: data })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Image upload failed.')
      setAssets((current) => [result.asset, ...current.filter((asset) => asset.id !== result.asset.id)])
      updateDraft((current) => ({ ...current, assets: { ...current.assets, [key]: result.asset.id } }))
      setNotice(`${file.name} uploaded. Save the draft to keep this selection.`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Image upload failed.')
    } finally {
      setBusy(false)
    }
  }

  async function handleFile(key: keyof ThemeConfig['assets'], event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (file) await uploadAsset(key, file)
  }

  async function handleDrop(key: keyof ThemeConfig['assets'], event: DragEvent<HTMLLabelElement>) {
    event.preventDefault()
    const file = event.dataTransfer.files[0]
    if (file) await uploadAsset(key, file)
  }

  async function saveDraft() {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch(`${apiBase}/draft`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not save the draft.')
      setDraft(result.draft)
      setNotice(scope === 'game' ? 'Game theme draft saved. It is not visible until published.' : 'Draft saved. It is not visible to poll participants.')
      await loadSettings()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the draft.')
    } finally {
      setBusy(false)
    }
  }

  async function publishTheme() {
    if (!window.confirm(scope === 'game' ? 'Publish this theme to Vanishing Tic-Tac-Toe only?' : 'Publish this theme to all live voting and results pages?')) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const saveResponse = await fetch(`${apiBase}/draft`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      })
      const saveResult = await saveResponse.json()
      if (!saveResponse.ok) throw new Error(saveResult.error || 'Could not save the draft.')
      const response = await fetch(`${apiBase}/publish`, { method: 'POST' })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not publish the theme.')
      setPublished(result.published)
      if (scope === 'site') await refreshTheme()
      await loadSettings()
      setNotice(scope === 'game' ? 'Game theme published to Vanishing Tic-Tac-Toe.' : 'Theme published to the live application.')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not publish the theme.')
    } finally {
      setBusy(false)
    }
  }

  async function resetTheme() {
    if (!window.confirm(scope === 'game'
      ? 'Restore and publish the default Vanishing Tic-Tac-Toe theme? This does not change the main site theme.'
      : 'Restore and publish the default theme? This removes unreferenced theme assets but keeps all polls and votes.')) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch(`${apiBase}/reset`, { method: 'POST' })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not reset the theme.')
      setDraft(DEFAULT_THEME)
      setPublished(DEFAULT_THEME)
      setAssets([])
      if (scope === 'site') await refreshTheme()
      await loadSettings()
      setNotice(scope === 'game' ? 'Default game theme restored. The main site theme was not changed.' : 'Default theme restored. Polls and votes were not changed.')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not reset the theme.')
    } finally {
      setBusy(false)
    }
  }

  async function deleteAsset(assetId: string) {
    if (!window.confirm('Permanently delete this uploaded image?')) return
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/admin/theme/assets/${encodeURIComponent(assetId)}`, { method: 'DELETE' })
      const result = response.status === 204 ? null : await response.json()
      if (!response.ok) throw new Error(result?.error || 'Could not delete this image.')
      setAssets((current) => current.filter((asset) => asset.id !== assetId))
      setNotice('Uploaded image deleted.')
      await loadSettings()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not delete this image.')
    } finally {
      setBusy(false)
    }
  }

  const previewBackground = draft.assets.background || (scope === 'game'
    ? draft.assets.adminBackground || draft.assets.resultsBackground || draft.assets.votingBackground
    : null)
  const previewStyle = {
    '--theme-primary': draft.colors.primary,
    '--theme-secondary': draft.colors.secondary,
    '--theme-accent': draft.colors.accent,
    '--theme-background': draft.colors.background,
    '--theme-text': draft.colors.text,
    '--theme-radius': `${draft.background.borderRadius}px`,
    '--theme-glow': draft.background.glow,
    backgroundImage: previewBackground
      ? `linear-gradient(rgba(0,0,0,${draft.background.overlay}),rgba(0,0,0,${draft.background.overlay})),linear-gradient(rgba(0,0,0,${1 - draft.background.opacity}),rgba(0,0,0,${1 - draft.background.opacity})),url("/api/admin/theme/assets/${previewBackground}")`
      : undefined,
    backgroundSize: draft.background.size === 'repeat' ? 'auto' : draft.background.size,
    backgroundRepeat: draft.background.size === 'repeat' ? 'repeat' : 'no-repeat',
    backgroundPosition: draft.background.position,
  } as CSSProperties

  return (
    <main className="admin-shell theme-editor-shell">
      <header className="admin-topbar">
        <a className="brand" href="/"><span>{scope === 'game' ? 'VANISHING TIC-TAC-TOE' : 'GAMES EXPERIENCE'}</span></a>
        <a className="admin-back" href={scope === 'game' ? '/game' : '/'} onClick={(event) => { event.preventDefault(); onBack() }}><ArrowLeft size={15} /> {scope === 'game' ? 'Game rooms' : 'Dashboard'}</a>
      </header>
      <div className="theme-editor-content">
        <div className="theme-editor-heading"><span className="auth-eyebrow">ADMINISTRATOR CONTROL</span><h1>{scope === 'game' ? 'Vanishing Tic-Tac-Toe Appearance' : 'Appearance &amp; Theme Settings'}</h1><p>{scope === 'game' ? 'Customize the game experience independently. Draft edits stay private until published and do not affect voting or the main site.' : 'Customize your event branding without changing the source code. Draft edits stay private until published.'}</p></div>
        <div className="theme-editor-grid">
          <section className="theme-editor-panel">
            <label className="auth-field-label" htmlFor="theme-event-title">{scope === 'game' ? 'Game title' : 'Event title'}</label>
            <input id="theme-event-title" maxLength={80} value={draft.eventTitle} onChange={(event) => updateDraft((current) => ({ ...current, eventTitle: event.target.value }))} />
            <h2 className="theme-section-title">{scope === 'game' ? 'Game branding &amp; backgrounds' : 'Branding &amp; backgrounds'}</h2>
            <div className="theme-image-grid">
              {imageFields.map(({ key, label: defaultLabel }) => {
                const label = scope === 'game' ? gameImageLabels[key] || defaultLabel : defaultLabel
                const assetId = draft.assets[key]
                const asset = assets.find((item) => item.id === assetId)
                return (
                  <div className="theme-image-field" key={key}>
                    <strong>{label}</strong>
                    <label className="theme-dropzone" onDragOver={(event) => event.preventDefault()} onDrop={(event) => void handleDrop(key, event)}>
                      <input type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" onChange={(event) => void handleFile(key, event)} />
                      {assetId ? <img src={`/api/admin/theme/assets/${encodeURIComponent(assetId)}`} alt={`Preview: ${label}`} /> : <ImagePlus size={20} />}
                      <span>{assetId ? 'Replace image' : 'Drop an image here or browse'}</span>
                    </label>
                    {asset && <small>{asset.width} × {asset.height} · {formatSize(asset.sizeBytes)}</small>}
                    {assetId && <button type="button" className="theme-remove-image" onClick={() => updateDraft((current) => ({ ...current, assets: { ...current.assets, [key]: null } }))}>Remove from draft</button>}
                  </div>
                )
              })}
            </div>
            <p className="theme-upload-help">JPG, PNG, or WebP · maximum {formatSize(maxUploadBytes)} per image · 12,000 pixels per side · SVG and executable files are not accepted.</p>

            <h2 className="theme-section-title">Colors</h2>
            <div className="theme-color-grid">
              {colorFields.map(({ key, label }) => <label className="theme-color-field" key={key}><span>{label}</span><input type="color" value={draft.colors[key]} onChange={(event) => updateDraft((current) => ({ ...current, colors: { ...current.colors, [key]: event.target.value } }))} /><code>{draft.colors[key]}</code></label>)}
            </div>

            <h2 className="theme-section-title">Background &amp; effects</h2>
            <div className="theme-settings-grid">
              <label>Image display<select value={draft.background.size} onChange={(event) => updateDraft((current) => ({ ...current, background: { ...current.background, size: event.target.value as ThemeConfig['background']['size'] } }))}><option value="cover">Cover</option><option value="contain">Contain</option><option value="repeat">Repeat</option></select></label>
              <label>Image position<select value={draft.background.position} onChange={(event) => updateDraft((current) => ({ ...current, background: { ...current.background, position: event.target.value } }))}><option value="center">Center</option><option value="top">Top</option><option value="bottom">Bottom</option><option value="left">Left</option><option value="right">Right</option></select></label>
              <label>Image opacity <input type="range" min="0" max="1" step="0.05" value={draft.background.opacity} onChange={(event) => updateDraft((current) => ({ ...current, background: { ...current.background, opacity: Number(event.target.value) } }))} /></label>
              <label>Overlay darkness <input type="range" min="0" max="0.9" step="0.05" value={draft.background.overlay} onChange={(event) => updateDraft((current) => ({ ...current, background: { ...current.background, overlay: Number(event.target.value) } }))} /></label>
              <label>Card corner radius <input type="range" min="0" max="32" step="1" value={draft.background.borderRadius} onChange={(event) => updateDraft((current) => ({ ...current, background: { ...current.background, borderRadius: Number(event.target.value) } }))} /></label>
              <label>Glow intensity <input type="range" min="0" max="1" step="0.05" value={draft.background.glow} onChange={(event) => updateDraft((current) => ({ ...current, background: { ...current.background, glow: Number(event.target.value) } }))} /></label>
            </div>
          </section>

          <aside className="theme-preview-column">
            <section className="theme-preview-panel">
              <div className="theme-preview-heading"><h2>Live preview</h2><div><button type="button" className={previewMode === 'desktop' ? 'is-active' : ''} onClick={() => setPreviewMode('desktop')} aria-label="Desktop preview"><Monitor size={16} /></button><button type="button" className={previewMode === 'mobile' ? 'is-active' : ''} onClick={() => setPreviewMode('mobile')} aria-label="Mobile preview"><Smartphone size={16} /></button></div></div>
              <div className={`theme-preview-canvas ${previewMode}`} style={previewStyle}>
                <header>{draft.assets.logo && <img src={`/api/admin/theme/assets/${encodeURIComponent(draft.assets.logo)}`} alt="" />}<strong>{draft.eventTitle || (scope === 'game' ? 'Game title' : 'Event title')}</strong></header>
                {draft.assets.banner && <img className="theme-preview-banner" src={`/api/admin/theme/assets/${encodeURIComponent(draft.assets.banner)}`} alt={scope === 'game' ? 'Game banner' : 'Event banner'} />}
                {scope === 'game' ? (
                  <>
                    <small>QUICK MATCH · 2 PLAYERS</small><h3>Vanishing Tic-Tac-Toe</h3>
                    <div className="game-theme-preview-board"><span>X</span><span /><span>O</span><span /><span>X</span><span /><span>O</span><span /><span /></div>
                    <button type="button">Your turn</button>
                  </>
                ) : (
                  <>
                    <small>LIVE POLL / 128 VOTES</small><h3>What should we choose?</h3>
                    <div className="theme-preview-option">A&nbsp;&nbsp; First answer</div><div className="theme-preview-option">B&nbsp;&nbsp; Second answer</div>
                    <button type="button">Cast my vote</button>
                  </>
                )}
              </div>
              <div className="theme-publish-actions"><button className="button button-secondary" disabled={busy} onClick={() => void saveDraft()}><Check size={16} /> Save draft</button><button className="button button-primary" disabled={busy} onClick={() => void publishTheme()}>{busy ? 'Saving…' : scope === 'game' ? 'Publish game theme' : 'Publish theme'}</button><button className="theme-reset-button" disabled={busy} onClick={() => void resetTheme()}><RotateCcw size={15} /> Restore defaults</button></div>
              <p className="theme-publish-state">Published title: <strong>{published.eventTitle}</strong></p>
            </section>
            <section className="theme-preview-panel theme-assets-panel"><h2>Uploaded assets</h2>{assets.length ? assets.map((asset) => <div className="theme-asset-row" key={asset.id}><span>{asset.mimeType.replace('image/', '').toUpperCase()} · {formatSize(asset.sizeBytes)}</span><button type="button" disabled={busy} onClick={() => void deleteAsset(asset.id)} aria-label="Delete uploaded image"><Trash2 size={15} /></button></div>) : <p>No uploaded theme images.</p>}</section>
            <section className="theme-preview-panel theme-assets-panel"><h2>Recent theme activity</h2>{audit.slice(0, 8).map((entry, index) => <div className="theme-audit-row" key={`${entry.createdAt}-${index}`}><strong>{entry.action.replace(scope === 'game' ? 'game-theme.' : '', '').replace('.', ' ')}</strong><span>{entry.administrator} · {new Date(entry.createdAt).toLocaleString()}</span></div>)}</section>
          </aside>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        {notice && <p className="theme-success" role="status">{notice}</p>}
        {busy && <p className="theme-busy" role="status"><Upload size={15} /> Uploading or saving changes…</p>}
      </div>
    </main>
  )
}
