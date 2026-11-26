import { createContext, useContext, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'

export type ThemeSkin = 'broadcast' | 'classic'

export const THEME_SKINS: Array<{ id: ThemeSkin; name: string; description: string }> = [
  { id: 'broadcast', name: 'Live Broadcast', description: 'Navy and electric blue with neon frames and chrome buttons, matching the live results screen.' },
  { id: 'classic', name: 'Classic Dark', description: 'The original charcoal look with warm gold highlights.' },
]

export type ThemeConfig = {
  eventTitle: string
  skin: ThemeSkin
  assets: {
    logo: string | null
    banner: string | null
    background: string | null
    votingBackground: string | null
    resultsBackground: string | null
    adminBackground: string | null
  }
  colors: {
    primary: string
    secondary: string
    accent: string
    background: string
    text: string
  }
  background: {
    position: string
    size: 'cover' | 'contain' | 'repeat'
    repeat: string
    opacity: number
    overlay: number
    borderRadius: number
    glow: number
  }
}

export const DEFAULT_THEME: ThemeConfig = {
  eventTitle: 'VOTE',
  skin: 'broadcast',
  assets: { logo: null, banner: null, background: null, votingBackground: null, resultsBackground: null, adminBackground: null },
  colors: { primary: '#f4cf51', secondary: '#ff657a', accent: '#68ceda', background: '#131317', text: '#f5f1ed' },
  background: { position: 'center', size: 'cover', repeat: 'no-repeat', opacity: 1, overlay: 0.35, borderRadius: 8, glow: 0.2 },
}

type ThemeContextValue = {
  theme: ThemeConfig
  assetUrls: Record<string, string>
  refreshTheme: () => Promise<void>
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: DEFAULT_THEME,
  assetUrls: {},
  refreshTheme: async () => {},
})

export function useTheme() {
  return useContext(ThemeContext)
}

function backgroundValue(url: string | undefined, opacity: number, overlay: number) {
  return url
    ? `linear-gradient(rgba(0,0,0,${overlay}),rgba(0,0,0,${overlay})),linear-gradient(rgba(0,0,0,${1 - opacity}),rgba(0,0,0,${1 - opacity})),url("${url.replaceAll('"', '')}")`
    : 'none'
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemeConfig>(() => {
    const cached = window.localStorage.getItem('theme-skin')
    return { ...DEFAULT_THEME, skin: THEME_SKINS.some((skin) => skin.id === cached) ? cached as ThemeSkin : DEFAULT_THEME.skin }
  })
  const [assetUrls, setAssetUrls] = useState<Record<string, string>>({})

  async function refreshTheme() {
    const path = window.location.pathname
    const activity = path.match(/^\/poll\/([^/]+)(?:\/(?:display|monitor))?\/?$/)
      || path.match(/^\/(raffle|scramble)\/join\/([^/]+)\/?$/)
      || path.match(/^\/(raffle|scramble)\/([^/]+)\/display\/?$/)
    const selfieJoin = path.match(/^\/selfie\/join\/([A-Za-z0-9_-]+)\/?$/)
    const selfieDisplay = path.match(/^\/selfie\/display\/([A-Za-z0-9_-]+)\/?$/)
    const params = new URLSearchParams()
    if (activity) {
      const kind = activity.length === 2 ? 'poll' : activity[1]
      params.set('kind', kind)
      params.set('id', decodeURIComponent(activity[activity.length - 1]))
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
    const result: { config: ThemeConfig; assetUrls: Record<string, string> } = await response.json()
    setTheme(result.config)
    if (result.config.skin) window.localStorage.setItem('theme-skin', result.config.skin)
    setAssetUrls(result.assetUrls)
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
    '--theme-voting-background-image': backgroundValue(assetUrls.votingBackground || assetUrls.background, theme.background.opacity, theme.background.overlay),
    '--theme-results-background-image': backgroundValue(assetUrls.resultsBackground || assetUrls.background, theme.background.opacity, theme.background.overlay),
    '--theme-admin-background-image': backgroundValue(assetUrls.adminBackground || assetUrls.background, theme.background.opacity, theme.background.overlay),
    '--theme-banner-image': assetUrls.banner ? `url("${assetUrls.banner.replaceAll('"', '')}")` : 'none',
  }) as CSSProperties, [theme, assetUrls])

  const rootClasses = [
    'theme-root',
    `skin-${theme.skin || 'broadcast'}`,
    assetUrls.background ? 'bg-global' : '',
    assetUrls.votingBackground || assetUrls.background ? 'bg-voting' : '',
    assetUrls.resultsBackground || assetUrls.background ? 'bg-results' : '',
    assetUrls.adminBackground || assetUrls.background ? 'bg-admin' : '',
  ].filter(Boolean).join(' ')

  return (
    <ThemeContext.Provider value={{ theme, assetUrls, refreshTheme }}>
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
