import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'

export type ThemeSkin = 'broadcast' | 'classic'
export type DisplayKey = 'poll' | 'qa' | 'raffle' | 'scramble' | 'selfie' | 'game'
export type DisplayTarget =
  | 'poll-vote'
  | 'poll-display'
  | 'qa-register'
  | 'qa-play'
  | 'qa-display'
  | 'raffle-register'
  | 'raffle-display'
  | 'scramble-register'
  | 'scramble-play'
  | 'scramble-display'
  | 'selfie-submission'
  | 'selfie-display'
  | 'game-join'
  | 'game-match'

export const DISPLAY_KEYS: DisplayKey[] = ['poll', 'qa', 'raffle', 'scramble', 'selfie', 'game']

export const THEME_SKINS: Array<{ id: ThemeSkin; name: string; description: string }> = [
  { id: 'broadcast', name: 'Live Broadcast', description: 'Navy and electric blue with neon frames and chrome buttons, matching the live results screen.' },
  { id: 'classic', name: 'Classic Dark', description: 'The original charcoal look with warm gold highlights.' },
]

export type ThemeFontAsset = {
  id: string
  url: string
  mimeType: string
  format: string
  name: string
}

export type ThemeColors = {
  primary: string
  secondary: string
  accent: string
  background: string
  text: string
}

export type ThemeBackgroundSettings = {
  position: string
  size: 'cover' | 'contain' | 'repeat'
  repeat: string
  opacity: number
  overlay: number
  borderRadius: number
  glow: number
}

export type DisplayOverride = {
  customized: boolean
  skin: 'inherit' | ThemeSkin
  colors: ThemeColors
  background: ThemeBackgroundSettings
}

export type ThemeConfig = {
  eventTitle: string
  skin: ThemeSkin
  assets: {
    logo: string | null
    banner: string | null
    background: string | null
    guestRegistrationBackground: string | null
    votingBackground: string | null
    resultsBackground: string | null
    qaDisplayBackground: string | null
    raffleDisplayBackground: string | null
    scrambleDisplayBackground: string | null
    selfieSubmissionBackground: string | null
    selfieDisplayBackground: string | null
    gameDisplayBackground: string | null
    adminBackground: string | null
  }
  fonts: {
    bodyFont: string | null
    headingFont: string | null
  }
  colors: ThemeColors
  background: ThemeBackgroundSettings
  displays: Record<DisplayKey, DisplayOverride>
}

const DEFAULT_COLORS: ThemeColors = { primary: '#f4cf51', secondary: '#ff657a', accent: '#68ceda', background: '#131317', text: '#f5f1ed' }
const DEFAULT_BACKGROUND: ThemeBackgroundSettings = { position: 'center', size: 'cover', repeat: 'no-repeat', opacity: 1, overlay: 0.35, borderRadius: 8, glow: 0.2 }

export function createDefaultDisplayOverride(): DisplayOverride {
  return {
    customized: false,
    skin: 'inherit',
    colors: { ...DEFAULT_COLORS },
    background: { ...DEFAULT_BACKGROUND },
  }
}

export const DEFAULT_THEME: ThemeConfig = {
  eventTitle: 'VOTE',
  skin: 'broadcast',
  assets: {
    logo: null,
    banner: null,
    background: null,
    guestRegistrationBackground: null,
    votingBackground: null,
    resultsBackground: null,
    qaDisplayBackground: null,
    raffleDisplayBackground: null,
    scrambleDisplayBackground: null,
    selfieSubmissionBackground: null,
    selfieDisplayBackground: null,
    gameDisplayBackground: null,
    adminBackground: null,
  },
  fonts: {
    bodyFont: null,
    headingFont: null,
  },
  colors: { ...DEFAULT_COLORS },
  background: { ...DEFAULT_BACKGROUND },
  displays: {
    poll: createDefaultDisplayOverride(),
    qa: createDefaultDisplayOverride(),
    raffle: createDefaultDisplayOverride(),
    scramble: createDefaultDisplayOverride(),
    selfie: createDefaultDisplayOverride(),
    game: createDefaultDisplayOverride(),
  },
}

export function normalizeThemeConfig(config?: Partial<ThemeConfig> | null): ThemeConfig {
  const source = config || {}
  const sourceDisplays = (source.displays || {}) as Partial<Record<DisplayKey, Partial<DisplayOverride>>>
  const displays = Object.fromEntries(
    DISPLAY_KEYS.map((key) => {
      const entry = sourceDisplays[key]
      const defaults = createDefaultDisplayOverride()
      return [
        key,
        {
          customized: Boolean(entry?.customized),
          skin: entry?.skin && ['inherit', 'broadcast', 'classic'].includes(entry.skin) ? entry.skin : 'inherit',
          colors: { ...defaults.colors, ...(entry?.colors || {}) },
          background: { ...defaults.background, ...(entry?.background || {}) },
        },
      ]
    }),
  ) as Record<DisplayKey, DisplayOverride>

  return {
    ...DEFAULT_THEME,
    ...source,
    skin: source.skin && THEME_SKINS.some((skin) => skin.id === source.skin) ? source.skin : DEFAULT_THEME.skin,
    assets: { ...DEFAULT_THEME.assets, ...(source.assets || {}) },
    fonts: { ...DEFAULT_THEME.fonts, ...(source.fonts || {}) },
    colors: { ...DEFAULT_THEME.colors, ...(source.colors || {}) },
    background: { ...DEFAULT_THEME.background, ...(source.background || {}) },
    displays,
  }
}

const DEFAULT_FONT_STACK = `'ITC Avant Garde Gothic', 'Avant Garde', AvantGarde, 'URW Gothic', 'TeX Gyre Adventor', 'Century Gothic', CenturyGothic, 'Questrial', sans-serif`
const ALLOWED_FONT_FORMATS = new Set(['woff2', 'woff', 'truetype', 'opentype', 'collection', 'embedded-opentype'])
const UUID_PATTERN = /^[0-9a-f-]{36}$/i

export function fontCssFormatFromMime(mimeType: string) {
  switch (mimeType) {
    case 'font/woff2': return 'woff2'
    case 'font/woff': return 'woff'
    case 'font/ttf': return 'truetype'
    case 'font/otf': return 'opentype'
    case 'font/collection': return 'collection'
    case 'application/vnd.ms-fontobject': return 'embedded-opentype'
    default: return ''
  }
}

export function buildFontFaceCss(rules: Array<{ familyName: string; id: string; url: string; format: string }>) {
  return rules
    .filter((rule) => UUID_PATTERN.test(rule.id) && /^\/api\/(?:admin\/|game-)?theme\/assets\/[0-9a-f-]{36}$/i.test(rule.url))
    .map((rule) => {
      const safeFamily = rule.familyName.replace(/[^A-Za-z0-9_-]/g, '')
      const formatSuffix = ALLOWED_FONT_FORMATS.has(rule.format) && rule.format !== 'collection'
        ? ` format("${rule.format}")`
        : ''
      return `@font-face { font-family: "${safeFamily}"; src: url("${rule.url}")${formatSuffix}; font-display: swap; }`
    })
    .join('\n')
}

type ThemeContextValue = {
  theme: ThemeConfig
  assetUrls: Record<string, string>
  fontAssets: Partial<Record<keyof ThemeConfig['fonts'], ThemeFontAsset>>
  refreshTheme: () => Promise<void>
  setLoginThemeActive: (active: boolean) => void
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: DEFAULT_THEME,
  assetUrls: {},
  fontAssets: {},
  refreshTheme: async () => {},
  setLoginThemeActive: () => {},
})

export function useTheme() {
  return useContext(ThemeContext)
}

export function backgroundValue(url: string | undefined, opacity: number, overlay: number) {
  return url
    ? `linear-gradient(rgba(0,0,0,${overlay}),rgba(0,0,0,${overlay})),linear-gradient(rgba(0,0,0,${1 - opacity}),rgba(0,0,0,${1 - opacity})),url("${url.replaceAll('"', '')}")`
    : 'none'
}

export function displayKeyForTarget(target: DisplayTarget): DisplayKey {
  if (target === 'poll-vote' || target === 'poll-display') return 'poll'
  if (target === 'qa-register' || target === 'qa-play' || target === 'qa-display') return 'qa'
  if (target === 'raffle-register' || target === 'raffle-display') return 'raffle'
  if (target === 'scramble-register' || target === 'scramble-play' || target === 'scramble-display') return 'scramble'
  if (target === 'selfie-submission' || target === 'selfie-display') return 'selfie'
  return 'game'
}

export function resolveDisplayBackgroundUrl(assetUrls: Record<string, string | undefined>, target: DisplayTarget): string | undefined {
  switch (target) {
    case 'poll-vote':
      return assetUrls.votingBackground || assetUrls.background
    case 'poll-display':
      return assetUrls.resultsBackground || assetUrls.background
    case 'qa-register':
      return assetUrls.guestRegistrationBackground || assetUrls.qaDisplayBackground || assetUrls.votingBackground || assetUrls.background
    case 'qa-play':
      return assetUrls.qaDisplayBackground || assetUrls.votingBackground || assetUrls.background
    case 'qa-display':
      return assetUrls.qaDisplayBackground || assetUrls.resultsBackground || assetUrls.background
    case 'raffle-register':
      return assetUrls.guestRegistrationBackground || assetUrls.raffleDisplayBackground || assetUrls.background
    case 'raffle-display':
      return assetUrls.raffleDisplayBackground || assetUrls.background
    case 'scramble-register':
      return assetUrls.guestRegistrationBackground || assetUrls.scrambleDisplayBackground || assetUrls.votingBackground || assetUrls.background
    case 'scramble-play':
      return assetUrls.scrambleDisplayBackground || assetUrls.votingBackground || assetUrls.background
    case 'scramble-display':
      return assetUrls.scrambleDisplayBackground || assetUrls.background
    case 'selfie-submission':
      return assetUrls.selfieSubmissionBackground || assetUrls.guestRegistrationBackground || assetUrls.background
    case 'selfie-display':
      return assetUrls.selfieDisplayBackground || assetUrls.resultsBackground || assetUrls.background
    case 'game-join':
      return assetUrls.gameDisplayBackground || assetUrls.guestRegistrationBackground || assetUrls.background
    case 'game-match':
      return assetUrls.gameDisplayBackground || assetUrls.background
  }
}

export function getDisplayPresentation(theme: ThemeConfig, assetUrls: Record<string, string | undefined>, target: DisplayTarget) {
  const key = displayKeyForTarget(target)
  const override = theme.displays?.[key]
  const customized = Boolean(override?.customized)
  const effectiveSkin: ThemeSkin = customized && override.skin !== 'inherit' ? override.skin : theme.skin
  const colors = customized ? override.colors : theme.colors
  const bg = customized ? override.background : theme.background
  const backgroundUrl = resolveDisplayBackgroundUrl(assetUrls, target)
  const displayBackgroundImage = backgroundValue(backgroundUrl, bg.opacity, bg.overlay)

  const style = {
    '--theme-primary': colors.primary,
    '--theme-secondary': colors.secondary,
    '--theme-accent': colors.accent,
    '--theme-background': colors.background,
    '--theme-text': colors.text,
    '--theme-radius': `${bg.borderRadius}px`,
    '--theme-glow': bg.glow,
    '--theme-overlay': bg.overlay,
    '--theme-background-opacity': bg.opacity,
    '--theme-background-size': bg.size === 'repeat' ? 'auto' : bg.size,
    '--theme-background-repeat': bg.size === 'repeat' ? 'repeat' : 'no-repeat',
    '--theme-background-position': bg.position,
    '--theme-display-background-image': displayBackgroundImage,
  } as CSSProperties

  const isRegistration = target === 'qa-register' || target === 'raffle-register' || target === 'scramble-register' || target === 'game-join'
  const className = [
    `display-scope-${key}`,
    `display-skin-${effectiveSkin}`,
    customized ? 'is-display-customized' : '',
    backgroundUrl ? 'has-display-bg' : '',
    isRegistration ? 'is-guest-registration' : '',
  ].filter(Boolean).join(' ')

  return {
    key,
    customized,
    skin: effectiveSkin,
    colors,
    background: bg,
    backgroundUrl,
    className,
    style,
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemeConfig>(() => {
    const cached = window.localStorage.getItem('theme-skin')
    return { ...DEFAULT_THEME, skin: THEME_SKINS.some((skin) => skin.id === cached) ? cached as ThemeSkin : DEFAULT_THEME.skin }
  })
  const [assetUrls, setAssetUrls] = useState<Record<string, string>>({})
  const [fontAssets, setFontAssets] = useState<Partial<Record<keyof ThemeConfig['fonts'], ThemeFontAsset>>>({})
  const loginThemeActive = useRef(false)
  const latestRequest = useRef(0)
  const setLoginThemeActive = useCallback((active: boolean) => {
    if (loginThemeActive.current === active) return
    loginThemeActive.current = active
    window.dispatchEvent(new Event('account-theme-refresh'))
  }, [])

  async function refreshTheme() {
    const requestId = ++latestRequest.current
    const path = window.location.pathname
    const activity = path.match(/^\/poll\/([^/]+)(?:\/(?:display|monitor))?\/?$/)
      || path.match(/^\/(raffle|scramble)\/join\/([^/]+)\/?$/)
      || path.match(/^\/(raffle|scramble)\/([^/]+)\/display\/?$/)
    const gameMatch = path.match(/^\/game\/([^/]+)\/?$/)
    const selfieJoin = path.match(/^\/selfie\/join\/([A-Za-z0-9_-]+)\/?$/)
    const selfieDisplay = path.match(/^\/selfie\/display\/([A-Za-z0-9_-]+)\/?$/)
    const params = new URLSearchParams()
    if (loginThemeActive.current) {
      params.set('kind', 'login')
    } else if (activity) {
      const kind = activity.length === 2 ? 'poll' : activity[1]
      params.set('kind', kind)
      params.set('id', decodeURIComponent(activity[activity.length - 1]))
    } else if (gameMatch) {
      params.set('kind', 'game')
      params.set('id', decodeURIComponent(gameMatch[1]))
    } else if (selfieJoin) {
      params.set('kind', 'selfie-join')
      params.set('id', selfieJoin[1])
    } else if (selfieDisplay) {
      params.set('kind', 'selfie-display')
      params.set('id', selfieDisplay[1])
    }
    const displayToken = selfieDisplay ? new URLSearchParams(window.location.hash.slice(1)).get('display') : null
    const response = await fetch(`/api/theme${params.size ? `?${params}` : ''}`, { cache: 'no-store', headers: displayToken ? { 'X-Selfie-Display-Token': displayToken } : undefined })
    if (!response.ok) throw new Error('The published theme could not be loaded.')
    const result: { config: ThemeConfig; assetUrls: Record<string, string>; fontAssets?: Partial<Record<keyof ThemeConfig['fonts'], ThemeFontAsset>> } = await response.json()
    if (requestId !== latestRequest.current) return
    const normalized = normalizeThemeConfig(result.config)
    setTheme(normalized)
    if (normalized.skin) window.localStorage.setItem('theme-skin', normalized.skin)
    setAssetUrls(result.assetUrls)
    setFontAssets(result.fontAssets || {})
  }

  useEffect(() => {
    void refreshTheme().catch((error: unknown) => console.error(error))
    const timer = window.setInterval(() => {
      void refreshTheme().catch((error: unknown) => console.error(error))
    }, 10000)
    const onFocus = () => { void refreshTheme().catch((error: unknown) => console.error(error)) }
    window.addEventListener('focus', onFocus)
    window.addEventListener('account-theme-refresh', onFocus)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('account-theme-refresh', onFocus)
    }
  }, [])

  const bodyFont = fontAssets.bodyFont
  const headingFont = fontAssets.headingFont
  const bodyFontFamily = bodyFont && UUID_PATTERN.test(bodyFont.id) ? `ThemeBodyFont-${bodyFont.id}` : null
  const headingFontFamily = headingFont && UUID_PATTERN.test(headingFont.id) ? `ThemeHeadingFont-${headingFont.id}` : null

  const fontFaceCss = useMemo(() => buildFontFaceCss([
    ...(bodyFont && bodyFontFamily ? [{ familyName: bodyFontFamily, id: bodyFont.id, url: bodyFont.url, format: bodyFont.format }] : []),
    ...(headingFont && headingFontFamily ? [{ familyName: headingFontFamily, id: headingFont.id, url: headingFont.url, format: headingFont.format }] : []),
  ]), [bodyFont, bodyFontFamily, headingFont, headingFontFamily])

  const style = useMemo(() => ({
    '--theme-primary': theme.colors.primary,
    '--theme-secondary': theme.colors.secondary,
    '--theme-accent': theme.colors.accent,
    '--theme-background': theme.colors.background,
    '--theme-text': theme.colors.text,
    '--theme-radius': `${theme.background.borderRadius}px`,
    '--theme-glow': theme.background.glow,
    '--theme-overlay': theme.background.overlay,
    '--theme-background-opacity': theme.background.opacity,
    '--theme-background-size': theme.background.size === 'repeat' ? 'auto' : theme.background.size,
    '--theme-background-repeat': theme.background.size === 'repeat' ? 'repeat' : 'no-repeat',
    '--theme-background-position': theme.background.position,
    '--theme-global-background-image': backgroundValue(assetUrls.background, theme.background.opacity, theme.background.overlay),
    '--theme-guest-registration-background-image': backgroundValue(assetUrls.guestRegistrationBackground || assetUrls.background, theme.background.opacity, theme.background.overlay),
    '--theme-voting-background-image': backgroundValue(assetUrls.votingBackground || assetUrls.background, theme.background.opacity, theme.background.overlay),
    '--theme-results-background-image': backgroundValue(assetUrls.resultsBackground || assetUrls.background, theme.background.opacity, theme.background.overlay),
    '--theme-qa-display-background-image': backgroundValue(assetUrls.qaDisplayBackground || assetUrls.resultsBackground || assetUrls.background, theme.background.opacity, theme.background.overlay),
    '--theme-raffle-display-background-image': backgroundValue(assetUrls.raffleDisplayBackground || assetUrls.background, theme.background.opacity, theme.background.overlay),
    '--theme-scramble-display-background-image': backgroundValue(assetUrls.scrambleDisplayBackground || assetUrls.background, theme.background.opacity, theme.background.overlay),
    '--theme-selfie-submission-background-image': backgroundValue(assetUrls.selfieSubmissionBackground || assetUrls.guestRegistrationBackground || assetUrls.background, theme.background.opacity, theme.background.overlay),
    '--theme-selfie-display-background-image': backgroundValue(assetUrls.selfieDisplayBackground || assetUrls.resultsBackground || assetUrls.background, theme.background.opacity, theme.background.overlay),
    '--theme-game-display-background-image': backgroundValue(assetUrls.gameDisplayBackground || assetUrls.background, theme.background.opacity, theme.background.overlay),
    '--theme-admin-background-image': backgroundValue(assetUrls.adminBackground || assetUrls.background, theme.background.opacity, theme.background.overlay),
    '--theme-banner-image': assetUrls.banner ? `url("${assetUrls.banner.replaceAll('"', '')}")` : 'none',
    ...(bodyFontFamily ? { '--theme-font-body': `"${bodyFontFamily}", ${DEFAULT_FONT_STACK}` } : {}),
    ...(headingFontFamily ? { '--theme-font-heading': `"${headingFontFamily}", ${DEFAULT_FONT_STACK}` } : {}),
  }) as CSSProperties, [theme, assetUrls, bodyFontFamily, headingFontFamily])

  const rootClasses = [
    'theme-root',
    `skin-${theme.skin || 'broadcast'}`,
    assetUrls.background ? 'bg-global' : '',
    assetUrls.guestRegistrationBackground || assetUrls.background ? 'bg-guest-registration' : '',
    assetUrls.votingBackground || assetUrls.background ? 'bg-voting' : '',
    assetUrls.resultsBackground || assetUrls.background ? 'bg-results' : '',
    assetUrls.qaDisplayBackground || assetUrls.resultsBackground || assetUrls.background ? 'bg-qa-display' : '',
    assetUrls.raffleDisplayBackground || assetUrls.background ? 'bg-raffle-display' : '',
    assetUrls.scrambleDisplayBackground || assetUrls.background ? 'bg-scramble-display' : '',
    assetUrls.selfieSubmissionBackground || assetUrls.guestRegistrationBackground || assetUrls.background ? 'bg-selfie-submission' : '',
    assetUrls.selfieDisplayBackground || assetUrls.resultsBackground || assetUrls.background ? 'bg-selfie-display' : '',
    assetUrls.gameDisplayBackground || assetUrls.background ? 'bg-game-display' : '',
    assetUrls.adminBackground || assetUrls.background ? 'bg-admin' : '',
    bodyFontFamily ? 'has-custom-body-font' : '',
    headingFontFamily ? 'has-custom-heading-font' : '',
  ].filter(Boolean).join(' ')

  return (
    <ThemeContext.Provider value={{ theme, assetUrls, fontAssets, refreshTheme, setLoginThemeActive }}>
      {fontFaceCss && <style>{fontFaceCss}</style>}
      <div className={rootClasses} style={style}>
        {children}
      </div>
    </ThemeContext.Provider>
  )
}

export function ThemeBrand({ className = 'brand' }: { className?: string }) {
  const { theme, assetUrls } = useTheme()
  return (
    <a className={className} href="/" aria-label={`${theme.eventTitle} home`}>
      {assetUrls.logo && <img className="theme-brand-logo" src={assetUrls.logo} alt="" />}
      <span>{theme.eventTitle}</span>
    </a>
  )
}
