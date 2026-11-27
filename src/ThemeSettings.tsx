import { useEffect, useMemo, useState, type ChangeEvent, type CSSProperties, type DragEvent } from 'react'
import { ArrowLeft, Check, ImagePlus, Monitor, RotateCcw, Smartphone, Trash2, Type, Upload, X } from 'lucide-react'
import {
  buildFontFaceCss,
  createDefaultDisplayOverride,
  DEFAULT_THEME,
  DISPLAY_KEYS,
  fontCssFormatFromMime,
  getDisplayPresentation,
  normalizeThemeConfig,
  THEME_SKINS,
  useTheme,
  type DisplayKey,
  type DisplayOverride,
  type DisplayTarget,
  type ThemeConfig,
  type ThemeSkin,
} from './theme'

type ThemeAsset = {
  id: string
  mimeType: string
  sizeBytes: number
  width: number
  height: number
  assetKind?: 'image' | 'font'
  originalName?: string | null
  uploadedAt: string
}
type PendingConfirmation = {
  kind: 'publish' | 'reset' | 'delete-asset'
  assetId?: string
  kicker: string
  title: string
  message: string
  confirmLabel: string
}
type AuditEntry = { administrator: string; action: string; details: Record<string, string>; createdAt: string }
type ThemeResponse = {
  draft: ThemeConfig
  published: ThemeConfig
  draftAssets: ThemeAsset[]
  maxUploadBytes: number
  maxFontUploadBytes?: number
  updatedAt: string | null
  publishedAt: string | null
}
type PreviewSelection = 'guest-registration' | DisplayKey

const FONT_ACCEPT = '.ttf,.otf,.woff,.woff2,.eot,.ttc,.otc,.sfnt,font/ttf,font/otf,font/woff,font/woff2,font/collection,application/font-woff,application/font-woff2,application/x-font-ttf,application/x-font-otf,application/vnd.ms-fontobject'
const FONT_EXTENSIONS = ['.ttf', '.otf', '.woff', '.woff2', '.eot', '.ttc', '.otc', '.sfnt']
const FONT_MIME_TYPES = new Set([
  'font/ttf',
  'font/otf',
  'font/woff',
  'font/woff2',
  'font/collection',
  'font/sfnt',
  'application/font-woff',
  'application/font-woff2',
  'application/x-font-ttf',
  'application/x-font-truetype',
  'application/x-font-otf',
  'application/x-font-opentype',
  'application/vnd.ms-fontobject',
])

const fontFields: Array<{ key: keyof ThemeConfig['fonts']; label: string; description: string }> = [
  { key: 'bodyFont', label: 'Primary & body font', description: 'Applies to pages, forms, buttons, guest screens, and open displays.' },
  { key: 'headingFont', label: 'Heading & display font', description: 'Optional override for event titles, headings, and big-screen winners.' },
]

const globalImageFields: Array<{ key: keyof ThemeConfig['assets']; label: string }> = [
  { key: 'logo', label: 'Event or sponsor logo' },
  { key: 'banner', label: 'Header banner or poster' },
  { key: 'background', label: 'Global background image' },
  { key: 'guestRegistrationBackground', label: 'Guest registration background (QR Raffle, Word Scramble & Q&A)' },
  { key: 'adminBackground', label: 'Admin & sign-in background' },
]

const gameScopeImageFields: Array<{ key: keyof ThemeConfig['assets']; label: string }> = [
  { key: 'logo', label: 'Game logo' },
  { key: 'banner', label: 'Game banner' },
  { key: 'background', label: 'Game background' },
  { key: 'gameDisplayBackground', label: 'Game match background' },
  { key: 'guestRegistrationBackground', label: 'Player join background' },
  { key: 'votingBackground', label: 'Alternate game background' },
  { key: 'resultsBackground', label: 'Second alternate background' },
  { key: 'adminBackground', label: 'Third alternate background' },
]

const DISPLAY_META: Record<DisplayKey, {
  label: string
  description: string
  previewViews: Array<{ target: DisplayTarget; label: string }>
  backgroundFields: Array<{ key: keyof ThemeConfig['assets']; label: string }>
}> = {
  poll: {
    label: 'Poll',
    description: 'Customize the Poll voting screen and live open results display independently from the rest of your event.',
    previewViews: [
      { target: 'poll-display', label: 'Open display' },
      { target: 'poll-vote', label: 'Voting page' },
    ],
    backgroundFields: [
      { key: 'votingBackground', label: 'Poll voting page background' },
      { key: 'resultsBackground', label: 'Poll open display background' },
    ],
  },
  qa: {
    label: 'Q&A',
    description: 'Customize Q&A live questions and big-screen results. Unregistered guests use the Guest registration background above.',
    previewViews: [
      { target: 'qa-display', label: 'Open display' },
      { target: 'qa-play', label: 'Question screen' },
    ],
    backgroundFields: [
      { key: 'qaDisplayBackground', label: 'Q&A question & open display background' },
    ],
  },
  raffle: {
    label: 'QR Raffle',
    description: 'Customize the QR Raffle draw open display and registration experience.',
    previewViews: [
      { target: 'raffle-display', label: 'Open display' },
      { target: 'raffle-register', label: 'Registration' },
    ],
    backgroundFields: [
      { key: 'raffleDisplayBackground', label: 'QR Raffle open display background' },
    ],
  },
  scramble: {
    label: 'Word Scramble',
    description: 'Customize the Word Scramble big-screen puzzle display and player participation view.',
    previewViews: [
      { target: 'scramble-display', label: 'Open display' },
      { target: 'scramble-play', label: 'Play screen' },
    ],
    backgroundFields: [
      { key: 'scrambleDisplayBackground', label: 'Word Scramble open display background' },
    ],
  },
  selfie: {
    label: 'Selfie',
    description: 'Customize both the guest Selfie submission page and the live photo wall display.',
    previewViews: [
      { target: 'selfie-display', label: 'Live wall' },
      { target: 'selfie-submission', label: 'Submission page' },
    ],
    backgroundFields: [
      { key: 'selfieSubmissionBackground', label: 'Selfie submission page background' },
      { key: 'selfieDisplayBackground', label: 'Selfie live photo screen background' },
    ],
  },
  game: {
    label: 'Game Match',
    description: 'Customize the Vanishing Tic-Tac-Toe player join screen and live match board.',
    previewViews: [
      { target: 'game-match', label: 'Match board' },
      { target: 'game-join', label: 'Player join' },
    ],
    backgroundFields: [
      { key: 'gameDisplayBackground', label: 'Game match background' },
    ],
  },
}

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

function formatFontType(mimeType: string) {
  switch (mimeType) {
    case 'font/woff2': return 'WOFF2'
    case 'font/woff': return 'WOFF'
    case 'font/ttf': return 'TTF'
    case 'font/otf': return 'OTF'
    case 'font/collection': return 'TTC'
    case 'application/vnd.ms-fontobject': return 'EOT'
    default: return mimeType.replace('font/', '').toUpperCase()
  }
}

function isSupportedFontFile(file: File) {
  const name = file.name.toLowerCase()
  return FONT_EXTENSIONS.some((ext) => name.endsWith(ext)) || FONT_MIME_TYPES.has(file.type.toLowerCase())
}

export default function ThemeSettings({ onBack, scope = 'site' }: { onBack: () => void; scope?: 'site' | 'game' }) {
  const apiBase = scope === 'game' ? '/api/admin/game-theme' : '/api/admin/theme'
  const initialTheme = scope === 'game'
    ? normalizeThemeConfig({ ...DEFAULT_THEME, eventTitle: 'Vanishing Tic-Tac-Toe' })
    : DEFAULT_THEME

  const [draft, setDraft] = useState<ThemeConfig>(initialTheme)
  const [published, setPublished] = useState<ThemeConfig>(initialTheme)
  const [assets, setAssets] = useState<ThemeAsset[]>([])
  const [maxUploadBytes, setMaxUploadBytes] = useState(50 * 1024 * 1024)
  const [maxFontUploadBytes, setMaxFontUploadBytes] = useState(20 * 1024 * 1024)
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [confirmBusy, setConfirmBusy] = useState(false)
  const [pendingConfirmation, setPendingConfirmation] = useState<PendingConfirmation | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [previewMode, setPreviewMode] = useState<'desktop' | 'mobile'>('desktop')
  const [activeDisplay, setActiveDisplay] = useState<DisplayKey>('poll')
  const [previewSelection, setPreviewSelection] = useState<PreviewSelection>(scope === 'game' ? 'game' : 'poll')
  const [previewSubView, setPreviewSubView] = useState<0 | 1>(0)
  const { refreshTheme } = useTheme()

  async function loadSettings() {
    const [themeResponse, auditResponse] = await Promise.all([fetch(apiBase), fetch(`${apiBase}/audit`)])
    const themeResult = await themeResponse.json()
    if (!themeResponse.ok) throw new Error(themeResult.error || 'Could not load theme settings.')
    const auditResult = await auditResponse.json()
    if (!auditResponse.ok) throw new Error(auditResult.error || 'Could not load theme activity.')
    const data: ThemeResponse = themeResult
    setDraft(normalizeThemeConfig(data.draft))
    setPublished(normalizeThemeConfig(data.published))
    setAssets(data.draftAssets)
    setMaxUploadBytes(data.maxUploadBytes)
    if (data.maxFontUploadBytes) setMaxFontUploadBytes(data.maxFontUploadBytes)
    setAudit(auditResult)
  }

  useEffect(() => {
    void loadSettings().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : 'Could not load theme settings.'))
  }, [])

  useEffect(() => {
    if (!pendingConfirmation) return
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !confirmBusy) setPendingConfirmation(null)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [pendingConfirmation, confirmBusy])

  function updateDraft(update: (current: ThemeConfig) => ThemeConfig) {
    setDraft((current) => normalizeThemeConfig(update(current)))
    setNotice('')
  }

  function updateDisplayOverride(key: DisplayKey, update: (current: DisplayOverride, effective: { colors: ThemeConfig['colors']; background: ThemeConfig['background'] }) => DisplayOverride) {
    updateDraft((current) => {
      const existing = current.displays[key] || createDefaultDisplayOverride()
      const effective = {
        colors: existing.customized ? existing.colors : current.colors,
        background: existing.customized ? existing.background : current.background,
      }
      return {
        ...current,
        displays: {
          ...current.displays,
          [key]: update(existing, effective),
        },
      }
    })
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
      if (key === 'guestRegistrationBackground') {
        setPreviewSelection('guest-registration')
      }
      setNotice(`${file.name} uploaded. Save the draft or publish the theme to keep this selection.`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Image upload failed.')
    } finally {
      setBusy(false)
    }
  }

  async function uploadFont(key: keyof ThemeConfig['fonts'], file: File) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      if (!isSupportedFontFile(file)) {
        throw new Error('Choose a TTF, OTF, WOFF, WOFF2, EOT, TTC, OTC, or SFNT font file.')
      }
      if (file.size < 1 || file.size > maxFontUploadBytes) {
        throw new Error(`Fonts must be ${formatSize(maxFontUploadBytes)} or smaller.`)
      }
      const data = new FormData()
      data.append('font', file)
      const response = await fetch('/api/admin/theme/fonts', { method: 'POST', body: data })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Font import failed.')
      setAssets((current) => [result.asset, ...current.filter((asset) => asset.id !== result.asset.id)])
      updateDraft((current) => ({ ...current, fonts: { ...current.fonts, [key]: result.asset.id } }))
      setNotice(`${file.name} imported. Save the draft or publish the theme to apply it to your account.`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Font import failed.')
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

  async function handleFontFile(key: keyof ThemeConfig['fonts'], event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (file) await uploadFont(key, file)
  }

  async function handleFontDrop(key: keyof ThemeConfig['fonts'], event: DragEvent<HTMLLabelElement>) {
    event.preventDefault()
    const file = event.dataTransfer.files[0]
    if (file) await uploadFont(key, file)
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
      setDraft(normalizeThemeConfig(result.draft))
      setNotice(scope === 'game' ? 'Game theme draft saved. It is not visible until published.' : 'Draft saved. It is not visible to participants until published.')
      await loadSettings()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save the draft.')
    } finally {
      setBusy(false)
    }
  }

  async function publishTheme() {
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
      setPublished(normalizeThemeConfig(result.published))
      if (scope === 'site') await refreshTheme()
      await loadSettings()
      setNotice(scope === 'game' ? 'Game theme published to Vanishing Tic-Tac-Toe.' : 'Theme published to your activities.')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not publish the theme.')
    } finally {
      setBusy(false)
    }
  }

  async function resetTheme() {
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
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/admin/theme/assets/${encodeURIComponent(assetId)}`, { method: 'DELETE' })
      const result = response.status === 204 ? null : await response.json()
      if (!response.ok) throw new Error(result?.error || 'Could not delete this asset.')
      setAssets((current) => current.filter((asset) => asset.id !== assetId))
      setNotice('Uploaded asset deleted.')
      await loadSettings()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not delete this asset.')
    } finally {
      setBusy(false)
    }
  }

  function requestPublishTheme() {
    setPendingConfirmation({
      kind: 'publish',
      kicker: scope === 'game' ? 'GAME APPEARANCE' : 'APPEARANCE & THEME',
      title: scope === 'game' ? 'Publish game theme?' : 'Publish theme?',
      message: scope === 'game'
        ? 'Publish this theme to Vanishing Tic-Tac-Toe only?'
        : 'Publish this theme to your activities and their public pages?',
      confirmLabel: scope === 'game' ? 'Publish game theme' : 'Publish theme',
    })
  }

  function requestResetTheme() {
    setPendingConfirmation({
      kind: 'reset',
      kicker: scope === 'game' ? 'GAME APPEARANCE' : 'APPEARANCE & THEME',
      title: 'Restore default theme?',
      message: scope === 'game'
        ? 'Restore and publish the default Vanishing Tic-Tac-Toe theme? This does not change the main site theme.'
        : 'Restore and publish the default theme for your account? Your uploaded assets, polls and votes will be kept.',
      confirmLabel: 'Restore defaults',
    })
  }

  function requestDeleteAsset(asset: ThemeAsset) {
    const isFont = asset.assetKind === 'font'
    setPendingConfirmation({
      kind: 'delete-asset',
      assetId: asset.id,
      kicker: 'THEME LIBRARY',
      title: isFont ? 'Delete uploaded font?' : 'Delete uploaded image?',
      message: isFont
        ? 'Remove this imported font from your theme library?'
        : 'Remove this uploaded image from your theme library?',
      confirmLabel: isFont ? 'Delete font' : 'Delete image',
    })
  }

  function renderImageField(key: keyof ThemeConfig['assets'], label: string) {
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
  }

  const importedFonts = useMemo(
    () => assets.filter((asset) => asset.assetKind === 'font'),
    [assets],
  )

  const previewBodyFont = importedFonts.find((item) => item.id === draft.fonts.bodyFont)
  const previewHeadingFont = importedFonts.find((item) => item.id === draft.fonts.headingFont)
  const previewBodyFamily = previewBodyFont ? `ThemePreviewBody-${previewBodyFont.id}` : null
  const previewHeadingFamily = previewHeadingFont ? `ThemePreviewHeading-${previewHeadingFont.id}` : null

  const previewFontCss = useMemo(() => buildFontFaceCss([
    ...(previewBodyFont && previewBodyFamily ? [{
      familyName: previewBodyFamily,
      id: previewBodyFont.id,
      url: `/api/admin/theme/assets/${encodeURIComponent(previewBodyFont.id)}`,
      format: fontCssFormatFromMime(previewBodyFont.mimeType),
    }] : []),
    ...(previewHeadingFont && previewHeadingFamily ? [{
      familyName: previewHeadingFamily,
      id: previewHeadingFont.id,
      url: `/api/admin/theme/assets/${encodeURIComponent(previewHeadingFont.id)}`,
      format: fontCssFormatFromMime(previewHeadingFont.mimeType),
    }] : []),
  ]), [previewBodyFont, previewBodyFamily, previewHeadingFont, previewHeadingFamily])

  const draftPreviewAssetUrls = useMemo(() => {
    const map: Record<string, string> = {}
    for (const [key, id] of Object.entries(draft.assets)) {
      if (id) map[key] = `/api/admin/theme/assets/${encodeURIComponent(id)}`
    }
    return map
  }, [draft.assets])

  const activePreviewTarget: DisplayTarget = useMemo(() => {
    if (scope === 'game') return 'game-match'
    if (previewSelection === 'guest-registration') return 'raffle-register'
    const views = DISPLAY_META[previewSelection].previewViews
    return (views[previewSubView] || views[0]).target
  }, [scope, previewSelection, previewSubView])

  const previewPresentation = useMemo(
    () => getDisplayPresentation(draft, draftPreviewAssetUrls, activePreviewTarget),
    [draft, draftPreviewAssetUrls, activePreviewTarget],
  )

  const previewStyle = {
    ...previewPresentation.style,
    backgroundColor: previewPresentation.colors.background,
    backgroundImage: previewPresentation.backgroundUrl
      ? (previewPresentation.style as Record<string, string>)['--theme-display-background-image']
      : undefined,
    backgroundSize: previewPresentation.background.size === 'repeat' ? 'auto' : previewPresentation.background.size,
    backgroundRepeat: previewPresentation.background.size === 'repeat' ? 'repeat' : 'no-repeat',
    backgroundPosition: previewPresentation.background.position,
    ...(previewBodyFamily ? { '--theme-preview-font-body': `"${previewBodyFamily}", sans-serif` } : {}),
    ...(previewHeadingFamily ? { '--theme-preview-font-heading': `"${previewHeadingFamily}", sans-serif` } : {}),
  } as CSSProperties

  const activeDisplayMeta = DISPLAY_META[activeDisplay]
  const activeOverride = draft.displays[activeDisplay] || createDefaultDisplayOverride()
  const activeColors = activeOverride.customized ? activeOverride.colors : draft.colors
  const activeBackground = activeOverride.customized ? activeOverride.background : draft.background

  return (
    <main className="admin-shell theme-editor-shell">
      {previewFontCss && <style>{previewFontCss}</style>}
      <header className="admin-topbar">
        <a className="brand" href="/"><span>{scope === 'game' ? 'VANISHING TIC-TAC-TOE' : 'GAMES EXPERIENCE'}</span></a>
        <a className="admin-back" href={scope === 'game' ? '/game' : '/'} onClick={(event) => { event.preventDefault(); onBack() }}><ArrowLeft size={15} /> {scope === 'game' ? 'Game rooms' : 'Dashboard'}</a>
      </header>
      <div className="theme-editor-content">
        <div className="theme-editor-heading">
          <span className="auth-eyebrow">ADMINISTRATOR CONTROL</span>
          <h1>{scope === 'game' ? 'Vanishing Tic-Tac-Toe Appearance' : 'Appearance & Theme Settings'}</h1>
          <p>{scope === 'game' ? 'Customize the game experience independently. Draft edits stay private until published and do not affect voting or the main site.' : 'Customize your global event branding, guest registration screen, and each individual experience display. Draft edits stay private until published.'}</p>
        </div>

        <div className="theme-editor-grid">
          <section className="theme-editor-panel">
            <label className="auth-field-label" htmlFor="theme-event-title">{scope === 'game' ? 'Game title' : 'Event title'}</label>
            <input id="theme-event-title" maxLength={80} value={draft.eventTitle} onChange={(event) => updateDraft((current) => ({ ...current, eventTitle: event.target.value }))} />

            {scope === 'site' && (
              <>
                <h2 className="theme-section-title">Website theme</h2>
                <div className="theme-skin-grid" role="radiogroup" aria-label="Website theme">
                  {THEME_SKINS.map((skin) => (
                    <button key={skin.id} type="button" role="radio" aria-checked={draft.skin === skin.id} className={`theme-skin-card theme-skin-${skin.id} ${draft.skin === skin.id ? 'is-selected' : ''}`} onClick={() => updateDraft((current) => ({ ...current, skin: skin.id }))}>
                      <span className="theme-skin-swatch" aria-hidden="true"><i /><i /><i /></span>
                      <strong>{skin.name}{published.skin === skin.id ? ' · Live' : ''}</strong>
                      <small>{skin.description}</small>
                    </button>
                  ))}
                </div>
                <p className="theme-upload-help">Sets the global skin across your event. You can override individual experience displays below.</p>

                <h2 className="theme-section-title">Typography &amp; custom fonts</h2>
                <div className="theme-image-grid">
                  {fontFields.map(({ key, label, description }) => {
                    const fontId = draft.fonts[key]
                    const fontAsset = importedFonts.find((item) => item.id === fontId)
                    const publishedFontId = published.fonts[key]
                    return (
                      <div className="theme-image-field" key={key}>
                        <strong>{label}</strong>
                        <label
                          className="theme-dropzone theme-font-dropzone"
                          onDragOver={(event) => event.preventDefault()}
                          onDrop={(event) => void handleFontDrop(key, event)}
                        >
                          <input type="file" accept={FONT_ACCEPT} onChange={(event) => void handleFontFile(key, event)} />
                          <Type size={20} />
                          <span className="theme-font-filename">
                            {fontAsset ? (fontAsset.originalName || `Font (${formatFontType(fontAsset.mimeType)})`) : 'Drop a font file here or browse'}
                          </span>
                          <small>{fontAsset ? `${formatFontType(fontAsset.mimeType)} · ${formatSize(fontAsset.sizeBytes)}${publishedFontId === fontAsset.id ? ' · Published' : ' · Draft'}` : description}</small>
                        </label>
                        {importedFonts.length > 0 && (
                          <select
                            aria-label={`Select imported font for ${label}`}
                            value={fontId || ''}
                            onChange={(event) => {
                              const nextId = event.currentTarget.value || null
                              updateDraft((current) => ({ ...current, fonts: { ...current.fonts, [key]: nextId } }))
                            }}
                          >
                            <option value="">Default site font</option>
                            {importedFonts.map((font) => (
                              <option key={font.id} value={font.id}>
                                {(font.originalName || 'Custom font')} ({formatFontType(font.mimeType)})
                              </option>
                            ))}
                          </select>
                        )}
                        {fontId && (
                          <button
                            type="button"
                            className="theme-remove-image"
                            onClick={() => updateDraft((current) => ({ ...current, fonts: { ...current.fonts, [key]: null } }))}
                          >
                            Remove from draft
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
                <p className="theme-upload-help">Supports TTF, OTF, WOFF, WOFF2, EOT, TTC, OTC, and SFNT font files · maximum {formatSize(maxFontUploadBytes)} per font · published per account.</p>
              </>
            )}

            <h2 className="theme-section-title">{scope === 'game' ? 'Game branding & backgrounds' : 'Branding & global backgrounds'}</h2>
            <div className="theme-image-grid">
              {(scope === 'game' ? gameScopeImageFields : globalImageFields).map(({ key, label }) => renderImageField(key, label))}
            </div>
            <p className="theme-upload-help">JPG, PNG, or WebP · maximum {formatSize(maxUploadBytes)} per image · 12,000 pixels per side · SVG and executable files are not accepted.</p>

            <h2 className="theme-section-title">Global colors</h2>
            <div className="theme-color-grid">
              {colorFields.map(({ key, label }) => <label className="theme-color-field" key={key}><span>{label}</span><input type="color" value={draft.colors[key]} onChange={(event) => updateDraft((current) => ({ ...current, colors: { ...current.colors, [key]: event.target.value } }))} /><code>{draft.colors[key]}</code></label>)}
            </div>

            <h2 className="theme-section-title">Global background &amp; effects</h2>
            <div className="theme-settings-grid">
              <label>Image display<select value={draft.background.size} onChange={(event) => updateDraft((current) => ({ ...current, background: { ...current.background, size: event.target.value as ThemeConfig['background']['size'] } }))}><option value="cover">Cover</option><option value="contain">Contain</option><option value="repeat">Repeat</option></select></label>
              <label>Image position<select value={draft.background.position} onChange={(event) => updateDraft((current) => ({ ...current, background: { ...current.background, position: event.target.value } }))}><option value="center">Center</option><option value="top">Top</option><option value="bottom">Bottom</option><option value="left">Left</option><option value="right">Right</option></select></label>
              <label>Image opacity <input type="range" min="0" max="1" step="0.05" value={draft.background.opacity} onChange={(event) => updateDraft((current) => ({ ...current, background: { ...current.background, opacity: Number(event.target.value) } }))} /></label>
              <label>Overlay darkness <input type="range" min="0" max="0.9" step="0.05" value={draft.background.overlay} onChange={(event) => updateDraft((current) => ({ ...current, background: { ...current.background, overlay: Number(event.target.value) } }))} /></label>
              <label>Card corner radius <input type="range" min="0" max="32" step="1" value={draft.background.borderRadius} onChange={(event) => updateDraft((current) => ({ ...current, background: { ...current.background, borderRadius: Number(event.target.value) } }))} /></label>
              <label>Glow intensity <input type="range" min="0" max="1" step="0.05" value={draft.background.glow} onChange={(event) => updateDraft((current) => ({ ...current, background: { ...current.background, glow: Number(event.target.value) } }))} /></label>
            </div>

            {scope === 'site' && (
              <>
                <h2 className="theme-section-title">Customize experience displays</h2>
                <p className="theme-upload-help">Choose an activity display to upload dedicated background images or override its skin, colors, and card styling.</p>
                <div className="theme-display-tabs" role="tablist" aria-label="Experience displays">
                  {DISPLAY_KEYS.map((key) => {
                    const meta = DISPLAY_META[key]
                    const isCustom = Boolean(draft.displays[key]?.customized)
                    const hasBg = meta.backgroundFields.some((field) => Boolean(draft.assets[field.key]))
                    return (
                      <button
                        key={key}
                        type="button"
                        role="tab"
                        aria-selected={activeDisplay === key}
                        className={`theme-display-tab ${activeDisplay === key ? 'is-active' : ''}`}
                        onClick={() => {
                          setActiveDisplay(key)
                          setPreviewSelection(key)
                          setPreviewSubView(0)
                        }}
                      >
                        <span>{meta.label}</span>
                        {(isCustom || hasBg) && <i className="theme-display-dot" aria-hidden="true" />}
                      </button>
                    )
                  })}
                </div>

                <div className="theme-display-card" role="tabpanel" aria-label={`${activeDisplayMeta.label} display settings`}>
                  <div className="theme-display-header">
                    <div>
                      <strong>{activeDisplayMeta.label} display</strong>
                      <p>{activeDisplayMeta.description}</p>
                    </div>
                    <div className="theme-display-actions">
                      {activeOverride.customized ? (
                        <button
                          type="button"
                          className="button button-quiet"
                          onClick={() => updateDisplayOverride(activeDisplay, () => createDefaultDisplayOverride())}
                        >
                          Use global theme
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="button button-secondary"
                          onClick={() => updateDisplayOverride(activeDisplay, (_existing, effective) => ({
                            customized: true,
                            skin: 'inherit',
                            colors: { ...effective.colors },
                            background: { ...effective.background },
                          }))}
                        >
                          Customize appearance
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="theme-image-grid">
                    {activeDisplayMeta.backgroundFields.map(({ key, label }) => renderImageField(key, label))}
                  </div>

                  <div className="theme-display-override-grid">
                    <label>
                      Display skin
                      <select
                        value={activeOverride.customized ? activeOverride.skin : 'inherit'}
                        onChange={(event) => {
                          const nextSkin = event.currentTarget.value as 'inherit' | ThemeSkin
                          updateDisplayOverride(activeDisplay, (existing, effective) => ({
                            customized: nextSkin !== 'inherit' ? true : existing.customized,
                            skin: nextSkin,
                            colors: { ...effective.colors },
                            background: { ...effective.background },
                          }))
                        }}
                      >
                        <option value="inherit">Inherit global ({draft.skin === 'broadcast' ? 'Live Broadcast' : 'Classic Dark'})</option>
                        <option value="broadcast">Live Broadcast</option>
                        <option value="classic">Classic Dark</option>
                      </select>
                    </label>
                    <span className="theme-display-mode-note">
                      {activeOverride.customized ? 'Custom display colors & layout active' : 'Inheriting global colors & layout (edit any control to override)'}
                    </span>
                  </div>

                  <div className="theme-color-grid">
                    {colorFields.map(({ key, label }) => (
                      <label className="theme-color-field" key={`${activeDisplay}-${key}`}>
                        <span>{label}</span>
                        <input
                          type="color"
                          value={activeColors[key]}
                          onChange={(event) => {
                            const nextColor = event.currentTarget.value
                            updateDisplayOverride(activeDisplay, (existing, effective) => ({
                              customized: true,
                              skin: existing.skin,
                              colors: { ...effective.colors, [key]: nextColor },
                              background: { ...effective.background },
                            }))
                          }}
                        />
                        <code>{activeColors[key]}</code>
                      </label>
                    ))}
                  </div>

                  <div className="theme-settings-grid">
                    <label>
                      Image display
                      <select
                        value={activeBackground.size}
                        onChange={(event) => {
                          const nextSize = event.currentTarget.value as ThemeConfig['background']['size']
                          updateDisplayOverride(activeDisplay, (existing, effective) => ({
                            customized: true,
                            skin: existing.skin,
                            colors: { ...effective.colors },
                            background: { ...effective.background, size: nextSize },
                          }))
                        }}
                      >
                        <option value="cover">Cover</option>
                        <option value="contain">Contain</option>
                        <option value="repeat">Repeat</option>
                      </select>
                    </label>
                    <label>
                      Image position
                      <select
                        value={activeBackground.position}
                        onChange={(event) => {
                          const nextPos = event.currentTarget.value
                          updateDisplayOverride(activeDisplay, (existing, effective) => ({
                            customized: true,
                            skin: existing.skin,
                            colors: { ...effective.colors },
                            background: { ...effective.background, position: nextPos },
                          }))
                        }}
                      >
                        <option value="center">Center</option>
                        <option value="top">Top</option>
                        <option value="bottom">Bottom</option>
                        <option value="left">Left</option>
                        <option value="right">Right</option>
                      </select>
                    </label>
                    <label>
                      Image opacity
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.05"
                        value={activeBackground.opacity}
                        onChange={(event) => {
                          const nextOpacity = Number(event.currentTarget.value)
                          updateDisplayOverride(activeDisplay, (existing, effective) => ({
                            customized: true,
                            skin: existing.skin,
                            colors: { ...effective.colors },
                            background: { ...effective.background, opacity: nextOpacity },
                          }))
                        }}
                      />
                    </label>
                    <label>
                      Overlay darkness
                      <input
                        type="range"
                        min="0"
                        max="0.9"
                        step="0.05"
                        value={activeBackground.overlay}
                        onChange={(event) => {
                          const nextOverlay = Number(event.currentTarget.value)
                          updateDisplayOverride(activeDisplay, (existing, effective) => ({
                            customized: true,
                            skin: existing.skin,
                            colors: { ...effective.colors },
                            background: { ...effective.background, overlay: nextOverlay },
                          }))
                        }}
                      />
                    </label>
                    <label>
                      Card corner radius
                      <input
                        type="range"
                        min="0"
                        max="32"
                        step="1"
                        value={activeBackground.borderRadius}
                        onChange={(event) => {
                          const nextRadius = Number(event.currentTarget.value)
                          updateDisplayOverride(activeDisplay, (existing, effective) => ({
                            customized: true,
                            skin: existing.skin,
                            colors: { ...effective.colors },
                            background: { ...effective.background, borderRadius: nextRadius },
                          }))
                        }}
                      />
                    </label>
                    <label>
                      Glow intensity
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.05"
                        value={activeBackground.glow}
                        onChange={(event) => {
                          const nextGlow = Number(event.currentTarget.value)
                          updateDisplayOverride(activeDisplay, (existing, effective) => ({
                            customized: true,
                            skin: existing.skin,
                            colors: { ...effective.colors },
                            background: { ...effective.background, glow: nextGlow },
                          }))
                        }}
                      />
                    </label>
                  </div>
                </div>
              </>
            )}
          </section>

          <aside className="theme-preview-column">
            <section className="theme-preview-panel">
              <div className="theme-preview-heading">
                <h2>Live preview</h2>
                <div>
                  <button type="button" className={previewMode === 'desktop' ? 'is-active' : ''} onClick={() => setPreviewMode('desktop')} aria-label="Desktop preview"><Monitor size={16} /></button>
                  <button type="button" className={previewMode === 'mobile' ? 'is-active' : ''} onClick={() => setPreviewMode('mobile')} aria-label="Mobile preview"><Smartphone size={16} /></button>
                </div>
              </div>

              {scope === 'site' && (
                <div className="theme-preview-controls">
                  <div className="theme-preview-switcher" role="group" aria-label="Preview experience">
                    <button
                      type="button"
                      className={previewSelection === 'guest-registration' ? 'is-active' : ''}
                      onClick={() => setPreviewSelection('guest-registration')}
                    >
                      Guest Reg
                    </button>
                    {DISPLAY_KEYS.map((key) => (
                      <button
                        key={key}
                        type="button"
                        className={previewSelection === key ? 'is-active' : ''}
                        onClick={() => {
                          setPreviewSelection(key)
                          setPreviewSubView(0)
                          setActiveDisplay(key)
                        }}
                      >
                        {DISPLAY_META[key].label}
                      </button>
                    ))}
                  </div>
                  {previewSelection !== 'guest-registration' && (
                    <div className="theme-preview-subtoggle" role="group" aria-label="Preview screen type">
                      {DISPLAY_META[previewSelection].previewViews.map((view, idx) => (
                        <button
                          key={view.target}
                          type="button"
                          className={previewSubView === idx ? 'is-active' : ''}
                          onClick={() => setPreviewSubView(idx as 0 | 1)}
                        >
                          {view.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div
                className={`theme-preview-canvas ${previewMode} skin-${previewPresentation.skin} ${previewPresentation.className}`}
                style={previewStyle}
              >
                <header>
                  {draft.assets.logo && <img src={`/api/admin/theme/assets/${encodeURIComponent(draft.assets.logo)}`} alt="" />}
                  <strong>{draft.eventTitle || (scope === 'game' ? 'Game title' : 'Event title')}</strong>
                </header>
                {draft.assets.banner && <img className="theme-preview-banner" src={`/api/admin/theme/assets/${encodeURIComponent(draft.assets.banner)}`} alt={scope === 'game' ? 'Game banner' : 'Event banner'} />}

                {activePreviewTarget === 'game-match' || activePreviewTarget === 'game-join' ? (
                  activePreviewTarget === 'game-join' ? (
                    <>
                      <small>QUICK MATCH · PLAYER JOIN</small>
                      <h3>Join the game</h3>
                      <div className="theme-preview-input">Your player name</div>
                      <button type="button">Join game</button>
                    </>
                  ) : (
                    <>
                      <small>QUICK MATCH · 2 PLAYERS</small>
                      <h3>Vanishing Tic-Tac-Toe</h3>
                      <div className="game-theme-preview-board"><span>X</span><span /><span>O</span><span /><span>X</span><span /><span>O</span><span /><span /></div>
                      <button type="button">Your turn</button>
                    </>
                  )
                ) : activePreviewTarget === 'raffle-register' ? (
                  <>
                    <small>GUEST REGISTRATION</small>
                    <h3>Enter your details</h3>
                    <div className="theme-preview-input">Ticket holder name</div>
                    <div className="theme-preview-input">Ticket number</div>
                    <button type="button">Register ticket</button>
                  </>
                ) : activePreviewTarget === 'raffle-display' ? (
                  <>
                    <small>QR RAFFLE OPEN DISPLAY</small>
                    <h3>Latest Draw Winner</h3>
                    <div className="theme-preview-winner-box">
                      <strong>Jordan Reyes</strong>
                      <span>TICKET #A-1042</span>
                    </div>
                  </>
                ) : activePreviewTarget === 'qa-display' || activePreviewTarget === 'qa-play' ? (
                  activePreviewTarget === 'qa-play' ? (
                    <>
                      <small>LIVE Q&amp;A</small>
                      <h3>Which year did we launch?</h3>
                      <div className="theme-preview-option">A&nbsp;&nbsp; 2021</div>
                      <div className="theme-preview-option">B&nbsp;&nbsp; 2023</div>
                      <button type="button">ENTER</button>
                    </>
                  ) : (
                    <>
                      <small>Q&amp;A OPEN DISPLAY</small>
                      <h3>First Correct Answer</h3>
                      <div className="theme-preview-winner-box">
                        <strong>Alex Rivera</strong>
                        <span>Ticket #088 · Choice B</span>
                      </div>
                    </>
                  )
                ) : activePreviewTarget === 'scramble-display' || activePreviewTarget === 'scramble-play' ? (
                  <>
                    <small>{activePreviewTarget === 'scramble-display' ? 'WORD SCRAMBLE DISPLAY' : 'WORD SCRAMBLE'}</small>
                    <h3>Unscramble the word</h3>
                    <div className="theme-preview-tiles">
                      <span>E</span><span>V</span><span>N</span><span>E</span><span>T</span>
                    </div>
                    {activePreviewTarget === 'scramble-play' && (
                      <>
                        <div className="theme-preview-input">Type your answer</div>
                        <button type="button">Submit answer</button>
                      </>
                    )}
                  </>
                ) : activePreviewTarget === 'selfie-submission' ? (
                  <>
                    <small>SELFIE CAM</small>
                    <h3>Share your moment.</h3>
                    <div className="theme-preview-option">Take a photo or choose an image</div>
                    <button type="button">Open camera</button>
                  </>
                ) : activePreviewTarget === 'selfie-display' ? (
                  <>
                    <small>LIVE SELFIE WALL</small>
                    <h3>Approved Guest Photos</h3>
                    <div className="theme-preview-selfie-grid">
                      <div className="theme-preview-photo-card">Photo Wall</div>
                      <div className="theme-preview-qr-box">QR</div>
                    </div>
                  </>
                ) : (
                  <>
                    <small>{activePreviewTarget === 'poll-display' ? 'POLL OPEN DISPLAY / 128 VOTES' : 'LIVE POLL / 128 VOTES'}</small>
                    <h3>What should we choose?</h3>
                    <div className="theme-preview-option">A&nbsp;&nbsp; First answer · 62%</div>
                    <div className="theme-preview-option">B&nbsp;&nbsp; Second answer · 38%</div>
                    {activePreviewTarget === 'poll-vote' && <button type="button">Cast my vote</button>}
                  </>
                )}
              </div>

              <div className="theme-publish-actions"><button type="button" className="button button-secondary" disabled={busy} onClick={() => void saveDraft()}><Check size={16} /> Save draft</button><button type="button" className="button button-primary" disabled={busy} onClick={requestPublishTheme}>{busy ? 'Saving…' : scope === 'game' ? 'Publish game theme' : 'Publish theme'}</button><button type="button" className="theme-reset-button" disabled={busy} onClick={requestResetTheme}><RotateCcw size={15} /> Restore defaults</button></div>
              <p className="theme-publish-state">Published title: <strong>{published.eventTitle}</strong></p>
            </section>
            <section className="theme-preview-panel theme-assets-panel">
              <h2>Uploaded assets</h2>
              {assets.length ? assets.map((asset) => {
                const isFont = asset.assetKind === 'font'
                const label = isFont
                  ? `FONT · ${asset.originalName || 'Custom font'} · ${formatFontType(asset.mimeType)} · ${formatSize(asset.sizeBytes)}`
                  : `${asset.mimeType.replace('image/', '').toUpperCase()} · ${formatSize(asset.sizeBytes)}`
                return (
                  <div className="theme-asset-row" key={asset.id}>
                    <span>{label}</span>
                    <button type="button" disabled={busy} onClick={() => requestDeleteAsset(asset)} aria-label={isFont ? 'Delete uploaded font' : 'Delete uploaded image'}>
                      <Trash2 size={15} />
                    </button>
                  </div>
                )
              }) : <p>No uploaded theme assets.</p>}
            </section>
            <section className="theme-preview-panel theme-assets-panel"><h2>Recent theme activity</h2>{audit.slice(0, 8).map((entry, index) => <div className="theme-audit-row" key={`${entry.createdAt}-${index}`}><strong>{entry.action.replace(scope === 'game' ? 'game-theme.' : '', '').replace('.', ' ')}</strong><span>{entry.administrator} · {new Date(entry.createdAt).toLocaleString()}</span></div>)}</section>
          </aside>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        {notice && <p className="theme-success" role="status">{notice}</p>}
        {busy && <p className="theme-busy" role="status"><Upload size={15} /> Uploading or saving changes…</p>}
      </div>
      {pendingConfirmation && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !confirmBusy) setPendingConfirmation(null)
          }}
        >
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="theme-confirm-title">
            <button
              className="icon-button modal-close"
              type="button"
              onClick={() => setPendingConfirmation(null)}
              aria-label="Close"
              disabled={confirmBusy}
            >
              <X size={19} />
            </button>
            <div className="modal-kicker">{pendingConfirmation.kicker}</div>
            <h2 id="theme-confirm-title">{pendingConfirmation.title}</h2>
            <p className="share-question">{pendingConfirmation.message}</p>
            <div className="create-game-actions">
              <button
                className="button button-quiet"
                type="button"
                onClick={() => setPendingConfirmation(null)}
                disabled={confirmBusy}
              >
                Cancel
              </button>
              <button
                className="button button-primary"
                type="button"
                autoFocus
                disabled={confirmBusy}
                onClick={async () => {
                  const confirmation = pendingConfirmation
                  setConfirmBusy(true)
                  try {
                    if (confirmation.kind === 'publish') await publishTheme()
                    else if (confirmation.kind === 'reset') await resetTheme()
                    else if (confirmation.kind === 'delete-asset' && confirmation.assetId) await deleteAsset(confirmation.assetId)
                  } finally {
                    setConfirmBusy(false)
                    setPendingConfirmation(null)
                  }
                }}
              >
                {confirmBusy ? 'Working…' : pendingConfirmation.confirmLabel}
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  )
}
