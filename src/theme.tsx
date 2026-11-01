import { createContext, useContext, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'

export type ThemeConfig = {
  eventTitle: string
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
  const [theme, setTheme] = useState(DEFAULT_THEME)
  const [assetUrls, setAssetUrls] = useState<Record<string, string>>({})

  async function refreshTheme() {
    const response = await fetch('/api/theme', { cache: 'no-store' })
    if (!response.ok) throw new Error('The published theme could not be loaded.')
    const result: { config: ThemeConfig; assetUrls: Record<string, string> } = await response.json()
    setTheme(result.config)
    setAssetUrls(result.assetUrls)
  }

  useEffect(() => {
    void refreshTheme().catch((error: unknown) => console.error(error))
    const timer = window.setInterval(() => {
      void refreshTheme().catch((error: unknown) => console.error(error))
    }, 10000)
    const onFocus = () => { void refreshTheme().catch((error: unknown) => console.error(error)) }
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
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

  return (
    <ThemeContext.Provider value={{ theme, assetUrls, refreshTheme }}>
      <div className="theme-root" style={style}>
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
